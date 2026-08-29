// Package integration — cross-process proof for P1-API-002 (detached
// OpenCode spawn serialization). Unlike the cmd-package lock tests (which
// exercise the transaction in-process and via same-package helpers), this
// file drives REAL INDEPENDENT COMPETING PROCESSES through the EXPORTED
// transaction surface (cmd.EnsureDetachedOpenCode + cmd.ApplyDetachedOCStart)
// — the exact entry points the two cobra arms call.
//
// The behavioral crux (the 2026-08-28 incident, restaged):
//
//	starter A is SIGKILLed after child Start but before state publication;
//	exactly one fake OpenCode child exists;
//	starter B (a separate process) stays HEALTHY with a failed OpenCode
//	lifecycle and spawns nothing;
//	after the owner chain exits, starter C spawns.
package integration

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/cmd"
	"github.com/vhqtvn/vh-solara/pkg/oclife"
)

// TestOCSpawnLockHelperProcess is never a real test: the scenario re-execs
// this test binary in helper modes (see ocSpawnScenario).
func TestOCSpawnLockHelperProcess(t *testing.T) {
	switch os.Getenv("VH_INTEG_OC_MODE") {
	case "":
		return // normal test run
	case "starter":
		integOCStarterHelper(t)
	case "fake":
		integOCFakeHelper(t)
	default:
		t.Fatalf("unknown VH_INTEG_OC_MODE %q", os.Getenv("VH_INTEG_OC_MODE"))
	}
}

// ocSpawnReport is the starter helper's JSON outcome.
type ocSpawnReport struct {
	Verdict   string `json:"verdict"`
	PID       int    `json:"pid"`
	Port      int    `json:"port"`
	URL       string `json:"url"`
	LifeState string `json:"life_state"`
	Summary   string `json:"summary"`
}

// integOCStarterHelper runs the REAL daemon-side sequence for one starter
// process: the shared transaction plus the verdict→lifecycle wiring both
// cobra arms use. With VH_OC_STAY_ALIVE=1 it then lingers — the p1-oc-001
// "keeps serving with a failed OpenCode" shape the loser-health assertion
// observes.
func integOCStarterHelper(t *testing.T) {
	wd, _ := os.Getwd()
	res := cmd.EnsureDetachedOpenCode(os.Getenv("VH_OC_BIN"), wd)
	life := oclife.New(oclife.TopologyDetached)
	port, url, _ := cmd.ApplyDetachedOCStart(res, life, "integ-starter")
	snap := life.Snapshot()
	rep := ocSpawnReport{
		Verdict:   res.Verdict.String(),
		PID:       res.PID,
		Port:      port,
		URL:       url,
		LifeState: string(snap.State),
		Summary:   snap.FailureSummary,
	}
	b, _ := json.Marshal(rep)
	if err := os.WriteFile(os.Getenv("VH_OC_RESULT"), b, 0o644); err != nil {
		t.Fatalf("write result: %v", err)
	}
	if os.Getenv("VH_OC_STAY_ALIVE") == "1" {
		for {
			time.Sleep(time.Hour)
		}
	}
	os.Exit(0)
}

// integOCFakeHelper is the fake `opencode serve` (argv after --:
// [opencode serve --port N --hostname 127.0.0.1]).
func integOCFakeHelper(t *testing.T) {
	port := 0
	for i, a := range os.Args {
		if a == "--port" && i+1 < len(os.Args) {
			port, _ = strconv.Atoi(os.Args[i+1])
		}
	}
	dir := os.Getenv("VH_FAKE_OC_PIDS_DIR")
	fd3, _ := os.Readlink("/proc/self/fd/3")
	_ = os.WriteFile(filepath.Join(dir, fmt.Sprintf("%d.fake", os.Getpid())), []byte(fd3), 0o644)
	if os.Getenv("VH_FAKE_OC_NOLISTEN") != "1" && port > 0 {
		ln, err := listenLoopback(port)
		if err == nil {
			go serveMinimalHTTP(ln)
		}
	}
	for {
		time.Sleep(time.Hour)
	}
}

func listenLoopback(port int) (net.Listener, error) {
	return net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
}

// serveMinimalHTTP answers every connection with a tiny valid HTTP 200 —
// enough for the classify probe (any non-5xx response proves the listener
// answers).
func serveMinimalHTTP(ln net.Listener) {
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		go func(c net.Conn) {
			defer c.Close()
			_ = c.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
			_, _ = io.Copy(io.Discard, c)
			_, _ = c.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"))
		}(c)
	}
}

// --- scenario scaffolding (self-contained; mirrors the cmd-package helpers
// but drives the exported surface from separate processes) ---

type ocSpawnScenario struct {
	t        *testing.T
	dir      string // shared cwd = the project key
	stateDir string
	pidsDir  string
	bin      string // fake `opencode` wrapper
}

func newOCSpawnScenario(t *testing.T) *ocSpawnScenario {
	t.Helper()
	base := t.TempDir()
	sc := &ocSpawnScenario{
		t:        t,
		dir:      filepath.Join(base, "ws"),
		stateDir: filepath.Join(base, "state"),
		pidsDir:  filepath.Join(base, "pids"),
		bin:      filepath.Join(base, "bin", "opencode"),
	}
	for _, d := range []string{sc.dir, sc.stateDir, sc.pidsDir, filepath.Dir(sc.bin)} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	script := "#!/bin/sh\nexport VH_INTEG_OC_MODE=fake\nexec \"$VH_OC_TESTBIN\" -test.run='^TestOCSpawnLockHelperProcess$' -- opencode \"$@\"\n"
	if err := os.WriteFile(sc.bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("VH_STATE_DIR", sc.stateDir)
	t.Setenv("VH_OC_TESTBIN", os.Args[0])
	t.Setenv("VH_FAKE_OC_PIDS_DIR", sc.pidsDir)

	// Scenario-level fake sweep: the fake opencodes sleep-loop forever, and
	// only the STARTER subprocesses get per-spawn cleanups — fakes whose
	// starter exited on its own (starter C) currently get NO cleanup at all
	// and leak past the run. Registered here — FIRST — so LIFO cleanup order
	// runs it AFTER every assertion and every starter cleanup: the crux test
	// ENDS by asserting a LIVE fake (starter C's child), so the sweep must
	// never fire before the test body completes.
	t.Cleanup(func() {
		for _, suffix := range []string{".fake", ".gchild"} {
			ents, _ := os.ReadDir(sc.pidsDir)
			for _, e := range ents {
				if !strings.HasSuffix(e.Name(), suffix) {
					continue
				}
				if pid, err := strconv.Atoi(strings.TrimSuffix(e.Name(), suffix)); err == nil && pidAlive(pid) {
					t.Logf("scenario sweep: SIGKILLing leftover %q pid %d", suffix, pid)
					killPid9(pid)
				}
			}
		}
	})
	return sc
}

func (sc *ocSpawnScenario) startStarter(name string, knobs map[string]string, stayAlive bool) *exec.Cmd {
	sc.t.Helper()
	env := append(os.Environ(),
		"VH_INTEG_OC_MODE=starter",
		"VH_OC_BIN="+sc.bin,
		"VH_OC_RESULT="+filepath.Join(sc.dir, name+".json"),
	)
	for k, v := range knobs {
		env = append(env, k+"="+v)
	}
	if stayAlive {
		env = append(env, "VH_OC_STAY_ALIVE=1")
	}
	c := exec.Command(os.Args[0], "-test.run=^TestOCSpawnLockHelperProcess$")
	c.Env = env
	c.Dir = sc.dir
	if err := c.Start(); err != nil {
		sc.t.Fatalf("start starter %s: %v", name, err)
	}
	sc.t.Cleanup(func() {
		_ = c.Process.Kill()
		_ = c.Wait()
	})
	return c
}

func (sc *ocSpawnScenario) waitReport(name string, d time.Duration) ocSpawnReport {
	sc.t.Helper()
	path := filepath.Join(sc.dir, name+".json")
	deadline := time.Now().Add(d)
	var last error
	for {
		if b, err := os.ReadFile(path); err == nil {
			var rep ocSpawnReport
			if json.Unmarshal(b, &rep) == nil {
				return rep
			}
		} else {
			last = err
		}
		if time.Now().After(deadline) {
			sc.t.Fatalf("starter %s never reported: %v", name, last)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// aliveFakes returns the alive fake-opencode pids recorded in the pids dir.
func (sc *ocSpawnScenario) aliveFakes() []int {
	ents, _ := os.ReadDir(sc.pidsDir)
	var pids []int
	for _, e := range ents {
		if !strings.HasSuffix(e.Name(), ".fake") {
			continue
		}
		if pid, err := strconv.Atoi(strings.TrimSuffix(e.Name(), ".fake")); err == nil && pidAlive(pid) {
			pids = append(pids, pid)
		}
	}
	return pids
}

func (sc *ocSpawnScenario) waitFakes(n int, d time.Duration) []int {
	sc.t.Helper()
	deadline := time.Now().Add(d)
	for {
		pids := sc.aliveFakes()
		if len(pids) == n {
			return pids
		}
		if time.Now().After(deadline) {
			sc.t.Fatalf("wanted %d alive fakes, got %v", n, pids)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// ownerLockPath derives the per-project owner lock path the binaries use
// (<state>/opencode/<sha1(cwd)>.owner.lock) — for INDEPENDENT kernel-level
// holder verification via /proc. The project key comes from the exported
// cmd.OCProjectKey (the exact derivation the binaries use) so this cannot
// drift from it.
func (sc *ocSpawnScenario) ownerLockPath() string {
	return filepath.Join(sc.stateDir, "opencode", cmd.OCProjectKey(sc.dir)+".owner.lock")
}

// procFD3Holders scans /proc for live processes whose fd 3 resolves to the
// owner lock file. This is the kernel's own view of "who owns the spawn
// slot" — independent of every pid file and verdict the helpers report.
func procFD3Holders(ownerPath string) []int {
	ents, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}
	var pids []int
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if link, err := os.Readlink(fmt.Sprintf("/proc/%d/fd/3", pid)); err == nil && link == ownerPath {
			pids = append(pids, pid)
		}
	}
	return pids
}

func pidAlive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || err == syscall.EPERM
}

func killPid9(pid int) {
	_ = syscall.Kill(pid, syscall.SIGKILL)
}

func waitPidDead(pid int, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for pidAlive(pid) {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
	return true
}

// TestDetachedSpawnSerializationCrux — the full cross-process behavioral
// closure: mid-window starter crash, exactly-one-child, healthy loser, and
// recovery after the owner chain exits.
func TestDetachedSpawnSerializationCrux(t *testing.T) {
	sc := newOCSpawnScenario(t)
	ownerPath := sc.ownerLockPath()

	// --- Starter A: crash after child Start, before state publication.
	// The fake never listens, so A sits in the readiness wait — a wide,
	// deterministic window between Start and publication. ---
	a := sc.startStarter("A", map[string]string{"VH_FAKE_OC_NOLISTEN": "1"}, false)
	fakes := sc.waitFakes(1, 15*time.Second)

	// The fake's exec proves A is past Start; the kernel view must show the
	// child as the sole owner-lock holder BEFORE the crash too.
	if holders := procFD3Holders(ownerPath); len(holders) != 1 || holders[0] != fakes[0] {
		t.Fatalf("pre-crash owner holders = %v, want exactly the fake pid %d", holders, fakes[0])
	}

	_ = a.Process.Kill() // the incident: hard crash mid-transaction
	_ = a.Wait()

	// No state was published (A died inside the window).
	statePath := strings.TrimSuffix(ownerPath, ".owner.lock") + ".json"
	if _, err := os.Stat(statePath); err == nil {
		t.Fatal("state must not exist — A was killed before publication")
	}

	// --- Starter B: a separate, real process. Must come back HEALTHY with a
	// failed OpenCode lifecycle and must NOT have spawned. ---
	b := sc.startStarter("B", nil, true) // STAY_ALIVE: the keeps-serving loser
	repB := sc.waitReport("B", 15*time.Second)
	if repB.Verdict != "orphaned-owner" {
		t.Fatalf("B verdict=%q (%s), want orphaned-owner", repB.Verdict, repB.Summary)
	}
	if repB.LifeState != string(oclife.StateFailed) {
		t.Fatalf("B lifecycle=%q, want failed (ocLife.SetFailed + keep serving)", repB.LifeState)
	}
	if !strings.Contains(repB.Summary, strconv.Itoa(fakes[0])) {
		t.Fatalf("B failure summary should surface the holder pid %d: %q", fakes[0], repB.Summary)
	}
	if got := len(sc.aliveFakes()); got != 1 {
		t.Fatalf("DOUBLE-SPAWN: %d children alive after B (want exactly 1)", got)
	}
	if holders := procFD3Holders(ownerPath); len(holders) != 1 || holders[0] != fakes[0] {
		t.Fatalf("post-B owner holders = %v, want exactly the fake pid %d", holders, fakes[0])
	}
	if !pidAlive(b.Process.Pid) {
		t.Fatal("loser B must stay alive (p1-oc-001: a contended OpenCode never takes the worker down)")
	}

	// --- The owner chain exits; starter C can spawn. ---
	killPid9(fakes[0])
	if !waitPidDead(fakes[0], 5*time.Second) {
		t.Fatal("fake child did not die")
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(procFD3Holders(ownerPath)) > 0 && time.Now().Before(deadline) {
		time.Sleep(20 * time.Millisecond)
	}

	c := sc.startStarter("C", nil, false)
	repC := sc.waitReport("C", 30*time.Second)
	if repC.Verdict != "spawned" {
		t.Fatalf("C verdict=%q (%s), want spawned after the owner chain exited", repC.Verdict, repC.Summary)
	}
	_ = c // C exits on its own after reporting; its child is tracked via pids dir
	fakesC := sc.waitFakes(1, 5*time.Second)
	if fakesC[0] == fakes[0] {
		t.Fatal("C must have spawned a NEW child")
	}
	if holders := procFD3Holders(ownerPath); len(holders) != 1 || holders[0] != fakesC[0] {
		t.Fatalf("post-C owner holders = %v, want exactly the new fake pid %d", holders, fakesC[0])
	}
	// State published with C's child.
	bState, err := os.ReadFile(statePath)
	if err != nil {
		t.Fatalf("C should have published state: %v", err)
	}
	if !strings.Contains(string(bState), strconv.Itoa(fakesC[0])) {
		t.Fatalf("published state %s should record the new pid %d", bState, fakesC[0])
	}
}
