//go:build linux

package cmd

// Tests for the two-role flock spawn-lock protocol (P1-API-002). Linux-only:
// every scenario asserts flock(2) exclusion or /proc fd semantics that the
// non-Linux degenerate guard (opencode_lock_other.go) cannot provide, and the
// fake-`opencode` wrapper is a #!/bin/sh script.

// The subprocess scenarios re-exec this test binary in two helper modes:
//
//   - VH_OC_LOCK_HELPER=starter — runs the REAL EnsureDetachedOpenCode +
//     ApplyDetachedOCStart against a fake `opencode` wrapper, reports the
//     outcome as JSON, and optionally lingers as the keeps-serving loser.
//   - VH_OC_LOCK_HELPER=fake (indirectly, via the wrapper script) — the fake
//     `opencode serve`: writes a pid file, optionally listens on its port,
//     optionally spawns a grandchild that inherits fd 3.
//
// The fake wrapper is a #!/bin/sh script NAMED `opencode` that execs this
// test binary with `-test.run=^TestOCLockHelperProcess$ -- opencode "$@"`, so
// the child's /proc cmdline reads `… opencode serve --port N …` exactly like
// the real thing and ocCmdlineMatches sees through it.

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

	"github.com/vhqtvn/vh-solara/pkg/oclife"
)

// --- helper-process entry ---

// TestOCLockHelperProcess is never a real test: it dispatches on
// VH_OC_LOCK_HELPER and blocks forever (fake mode) or exits after reporting
// (starter mode). The sleep loops mirror the existing
// TestFakeOpenCodeHelperProcess pattern (select{} would trip the runtime
// deadlock detector).
func TestOCLockHelperProcess(t *testing.T) {
	switch os.Getenv("VH_OC_LOCK_HELPER") {
	case "":
		return // normal test run
	case "starter":
		ocLockStarterHelper(t)
	case "fake":
		ocLockFakeOCHelper(t)
	default:
		t.Fatalf("unknown VH_OC_LOCK_HELPER mode %q", os.Getenv("VH_OC_LOCK_HELPER"))
	}
}

// ocStarterReport is the starter helper's JSON outcome.
type ocStarterReport struct {
	Verdict   string `json:"verdict"`
	PID       int    `json:"pid"`
	Port      int    `json:"port"`
	URL       string `json:"url"`
	LifeState string `json:"life_state"`
	Summary   string `json:"summary"`
	HasCmd    bool   `json:"has_cmd"`
}

func ocLockStarterHelper(t *testing.T) {
	wd, _ := os.Getwd()
	res := EnsureDetachedOpenCode(os.Getenv("VH_OC_BIN"), wd)
	life := oclife.New(oclife.TopologyDetached)
	port, url, cmd := ApplyDetachedOCStart(res, life, "starter-helper")
	snap := life.Snapshot()
	rep := ocStarterReport{
		Verdict:   res.Verdict.String(),
		PID:       res.PID,
		Port:      port,
		URL:       url,
		LifeState: string(snap.State),
		Summary:   snap.FailureSummary,
		HasCmd:    cmd != nil,
	}
	b, _ := json.Marshal(rep)
	if err := os.WriteFile(os.Getenv("VH_OC_RESULT"), b, 0o644); err != nil {
		t.Fatalf("write result: %v", err)
	}
	if os.Getenv("VH_OC_STAY_ALIVE") == "1" {
		// The keeps-serving loser: p1-oc-001 shape — failure recorded, the
		// vh process itself stays alive for the operator.
		for {
			time.Sleep(time.Hour)
		}
	}
	os.Exit(0)
}

// ocLockFakeOCHelper is the fake `opencode serve`. argv (after --) is
// [opencode serve --port N --hostname 127.0.0.1]. Knobs (inherited env):
//
//	VH_FAKE_OC_PIDS_DIR    — where to write <pid>.fake (+ <pid>.gchild)
//	VH_FAKE_OC_NOLISTEN=1  — never listen (holds the starter's readiness
//	                         window open; the crash barrier's wide window)
//	VH_FAKE_OC_GRANDCHILD=1 — spawn `sleep 3000` inheriting fd 3 (the
//	                         orphaned-owner holder)
func ocLockFakeOCHelper(t *testing.T) {
	port := 0
	for i, a := range os.Args {
		if a == "--port" && i+1 < len(os.Args) {
			port, _ = strconv.Atoi(os.Args[i+1])
		}
	}
	dir := os.Getenv("VH_FAKE_OC_PIDS_DIR")
	fd3, _ := os.Readlink("/proc/self/fd/3")
	_ = os.WriteFile(filepath.Join(dir, fmt.Sprintf("%d.fake", os.Getpid())), []byte(fd3), 0o644)
	// P1-API-005 knobs — model a replacement child that dies BEFORE
	// readiness (a lost bind race in real opencode exits with EADDRINUSE; a
	// crash exits too). The restart contract attributes readiness via the
	// child's EXIT, never by parsing its output, so the fake simply exits(1)
	// without listening. Both default off (existing scenarios unchanged).
	if os.Getenv("VH_FAKE_OC_DIE_FAST") == "1" {
		os.Exit(1)
	}
	if diePort, err := strconv.Atoi(os.Getenv("VH_FAKE_OC_DIE_ON_PORT")); err == nil && diePort > 0 && diePort == port {
		os.Exit(1)
	}
	if os.Getenv("VH_FAKE_OC_GRANDCHILD") == "1" {
		c := exec.Command("sleep", "3000") // inherits the non-CLOEXEC fd 3
		if err := c.Start(); err == nil {
			_ = os.WriteFile(filepath.Join(dir, fmt.Sprintf("%d.gchild", c.Process.Pid)), []byte("grandchild"), 0o644)
			go func() { _ = c.Wait() }()
		}
	}
	if os.Getenv("VH_FAKE_OC_NOLISTEN") != "1" && port > 0 {
		if ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port)); err == nil {
			go func() {
				for {
					c, err := ln.Accept()
					if err != nil {
						return
					}
					go func(c net.Conn) {
						defer c.Close()
						// Drain the request briefly, then answer with a
						// minimal valid HTTP 200 — the classify probe only
						// needs the listener to speak HTTP.
						_ = c.SetReadDeadline(time.Now().Add(200 * time.Millisecond))
						_, _ = io.Copy(io.Discard, c)
						_, _ = c.Write([]byte("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok"))
					}(c)
				}
			}()
		}
	}
	for {
		time.Sleep(time.Hour)
	}
}

// --- scenario scaffolding ---

// ocLockScenario scopes one project key: a workspace dir (the cwd every
// starter and the in-process transaction share), a VH_STATE_DIR, a fake-pids
// dir, and the fake `opencode` wrapper script.
type ocLockScenario struct {
	t        *testing.T
	dir      string // shared cwd = the project key
	stateDir string
	pidsDir  string
	bin      string // fake `opencode` wrapper
}

func newOCLockScenario(t *testing.T) *ocLockScenario {
	t.Helper()
	base := t.TempDir()
	sc := &ocLockScenario{
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
	script := "#!/bin/sh\nexport VH_OC_LOCK_HELPER=fake\nexec \"$VH_OC_TESTBIN\" -test.run='^TestOCLockHelperProcess$' -- opencode \"$@\"\n"
	if err := os.WriteFile(sc.bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	// Scope the in-process transaction to the same state dir + project key
	// the subprocess starters use. VH_FAKE_OC_PIDS_DIR must be ambient so
	// EVERY spawn chain (test → starter → fake, or test → fake directly)
	// inherits it.
	t.Setenv("VH_STATE_DIR", sc.stateDir)
	t.Setenv("VH_OC_TESTBIN", os.Args[0])
	t.Setenv("VH_FAKE_OC_PIDS_DIR", sc.pidsDir)
	t.Chdir(sc.dir)

	// Scenario-level fake sweep: the fake opencodes sleep-loop FOREVER, and
	// the per-starter/per-spawn cleanups kill only the STARTER (parent)
	// processes — fakes they spawned, in-process transaction children, and
	// fd-3-holding grandchildren can outlive the test and leak across runs
	// (squatting ports and holding owner locks). Registered here — FIRST —
	// so LIFO cleanup order runs it AFTER every assertion and every other
	// cleanup: tests stay free to END by asserting a live fake; the sweep
	// only reaps what is still alive once the test is over.
	//
	// Identity revalidation (P2-API-009): a recorded pid may have died and
	// been recycled into an innocent process within the test-run window, so
	// the sweep re-reads /proc/<pid>/cmdline IMMEDIATELY before each
	// SIGKILL and signals only pids that still carry this scenario's fake
	// signature (the same ocCmdlineMatches-style shape the production gate
	// trusts). Unreadable (dead/zombie) or foreign cmdline → skip, never
	// signal.
	t.Cleanup(func() {
		for _, kind := range []struct {
			suffix    string
			stillOurs func(int) bool
		}{
			{".fake", ocSweepIsFakeOC},
			{".gchild", ocSweepIsGrandchild},
		} {
			for _, pid := range sc.alivePids(kind.suffix) {
				if !kind.stillOurs(pid) {
					t.Logf("scenario sweep: pid %d (%s) failed /proc cmdline identity revalidation — recycled or gone; NOT signaling", pid, kind.suffix)
					continue
				}
				t.Logf("scenario sweep: SIGKILLing leftover %q pid %d", kind.suffix, pid)
				killPid9(pid)
			}
		}
	})
	return sc
}

// startStarter spawns a starter subprocess running the real transaction.
func (sc *ocLockScenario) startStarter(name string, knobs map[string]string, stayAlive bool) *exec.Cmd {
	sc.t.Helper()
	env := append(os.Environ(),
		"VH_OC_LOCK_HELPER=starter",
		"VH_OC_BIN="+sc.bin,
		"VH_OC_RESULT="+filepath.Join(sc.dir, name+".json"),
	)
	for k, v := range knobs {
		env = append(env, k+"="+v)
	}
	if stayAlive {
		env = append(env, "VH_OC_STAY_ALIVE=1")
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestOCLockHelperProcess$")
	cmd.Env = env
	cmd.Dir = sc.dir
	if err := cmd.Start(); err != nil {
		sc.t.Fatalf("start starter %s: %v", name, err)
	}
	sc.t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	return cmd
}

func (sc *ocLockScenario) resultPath(name string) string {
	return filepath.Join(sc.dir, name+".json")
}

// waitReport polls for a starter's JSON outcome.
func (sc *ocLockScenario) waitReport(name string, d time.Duration) ocStarterReport {
	sc.t.Helper()
	deadline := time.Now().Add(d)
	var last error
	for {
		b, err := os.ReadFile(sc.resultPath(name))
		if err == nil {
			var rep ocStarterReport
			if json.Unmarshal(b, &rep) == nil {
				return rep
			}
			last = fmt.Errorf("bad json: %s", b)
		} else {
			last = err
		}
		if time.Now().After(deadline) {
			sc.t.Fatalf("starter %s never reported: %v", name, last)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// alivePids returns the alive pids recorded with the given suffix
// (".fake" for fake opencodes, ".gchild" for fd-retaining grandchildren).
func (sc *ocLockScenario) alivePids(suffix string) []int {
	ents, _ := os.ReadDir(sc.pidsDir)
	var pids []int
	for _, e := range ents {
		if !strings.HasSuffix(e.Name(), suffix) {
			continue
		}
		if pid, err := strconv.Atoi(strings.TrimSuffix(e.Name(), suffix)); err == nil && ocProcessAlive(pid) {
			pids = append(pids, pid)
		}
	}
	return pids
}

// waitAliveCount waits until exactly n alive pids exist for the suffix.
func (sc *ocLockScenario) waitAliveCount(suffix string, n int, d time.Duration) []int {
	sc.t.Helper()
	deadline := time.Now().Add(d)
	for {
		pids := sc.alivePids(suffix)
		if len(pids) == n {
			return pids
		}
		if time.Now().After(deadline) {
			sc.t.Fatalf("wanted %d alive %q processes, got %d (%v)", n, suffix, len(pids), pids)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// waitOwnerFree polls until the owner lock is acquirable again.
func (sc *ocLockScenario) waitOwnerFree(d time.Duration) {
	sc.t.Helper()
	deadline := time.Now().Add(d)
	for ocOwnerLockHeldByOthers() {
		if time.Now().After(deadline) {
			sc.t.Fatal("owner lock still held after deadline")
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func killPid9(pid int) {
	if p, err := os.FindProcess(pid); err == nil {
		_ = p.Signal(syscall.SIGKILL)
	}
}

// ocProcCmdlineArgs reads /proc/<pid>/cmdline as one space-separated
// argument string ("" on any read failure — the same degradation
// ocCmdlineMatches documents: a dying or zombie pid reads back empty).
func ocProcCmdlineArgs(pid int) string {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		return ""
	}
	return strings.ReplaceAll(string(b), "\x00", " ")
}

// ocSweepIsFakeOC is the sweep's pre-SIGKILL identity check for recorded
// fake-opencode pids: the fake wrapper execs THIS test binary
// (VH_OC_TESTBIN = os.Args[0]) with `-- opencode serve --port N …` argv, so
// a pid that is still ours carries both markers in its cmdline — the same
// ocCmdlineMatches-style signature the production gate trusts. A recycled
// innocent pid does not.
func ocSweepIsFakeOC(pid int) bool {
	args := ocProcCmdlineArgs(pid)
	return strings.Contains(args, os.Args[0]) && strings.Contains(args, "opencode")
}

// ocSweepIsGrandchild is the sweep's pre-SIGKILL identity check for recorded
// grandchild pids: ocLockFakeOCHelper spawns them as exactly `sleep 3000`
// (the fd-3-retaining holder).
func ocSweepIsGrandchild(pid int) bool {
	return strings.TrimSpace(ocProcCmdlineArgs(pid)) == "sleep 3000"
}

func waitPidDead(pid int, d time.Duration) bool {
	deadline := time.Now().Add(d)
	for ocProcessAlive(pid) {
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
	return true
}

// --- primitive tests (in-process) ---

func TestOCSpawnGuardStarterLockMutualExclusion(t *testing.T) {
	newOCLockScenario(t) // scope state dir + project key

	g1, verdict, reason := acquireOCSpawnGuard()
	if verdict != ocLockAcquired {
		t.Fatalf("first acquire: verdict=%v reason=%q", verdict, reason)
	}
	// A second description in the SAME process is denied too (flock is
	// per-description, not per-process) — the in-process contended check.
	g2, verdict2, reason2 := acquireOCSpawnGuard()
	if verdict2 != ocLockContended {
		t.Fatalf("second acquire: want contended, got verdict=%v reason=%q", verdict2, reason2)
	}
	if g2 != nil {
		t.Fatal("contended acquire must not return a guard")
	}
	if ocOwnerLockHeldByOthers() {
		t.Fatal("owner lock should be free before any spawn")
	}
	g1.Release()
	g1.Release() // idempotent

	g3, verdict3, _ := acquireOCSpawnGuard()
	if verdict3 != ocLockAcquired {
		t.Fatalf("acquire after release: verdict=%v", verdict3)
	}
	g3.Release()
}

// TestOCSpawnHandoffRetentionAndRelease proves the core handoff properties
// in-process: the spawned child holds fd 3 → the owner lock file for its whole
// life, the parent's copy is gone (the lock survives everything the parent
// does), and the lock frees exactly when the child dies.
func TestOCSpawnHandoffRetentionAndRelease(t *testing.T) {
	sc := newOCLockScenario(t)

	res := EnsureDetachedOpenCode(sc.bin, sc.dir)
	if res.Verdict != DetachedStartSpawned {
		t.Fatalf("want spawned, got %v (%s)", res.Verdict, res.Reason)
	}
	fakes := sc.waitAliveCount(".fake", 1, 5*time.Second)
	if fakes[0] != res.PID {
		t.Fatalf("recorded pid %d != fake pid %v", res.PID, fakes)
	}
	// Kernel-level retention: the child's fd 3 IS the owner lock file.
	link, err := os.Readlink(fmt.Sprintf("/proc/%d/fd/3", res.PID))
	if err != nil {
		t.Fatalf("readlink child fd3: %v", err)
	}
	if link != ocOwnerLockPath() {
		t.Fatalf("child fd3 → %q, want owner lock %q", link, ocOwnerLockPath())
	}
	if !ocOwnerLockHeldByOthers() {
		t.Fatal("owner lock must be held while the child lives")
	}
	// State published with the child's identity.
	st, ok := readOCState()
	if !ok || st.PID != res.PID || st.Port != res.Port {
		t.Fatalf("state after spawn: %+v ok=%v, want pid=%d port=%d", st, ok, res.PID, res.Port)
	}

	// Kill the child: the lock frees exactly with it.
	killPid9(res.PID)
	sc.waitOwnerFree(5 * time.Second)
}

// --- crash-barrier tests (the experiment matrix, ported to the real code) ---

// TestOCSpawnCrashPostStartPrePublication — THE incident window: starter A is
// SIGKILLed after the child Start but before state publication. The child
// still owns the slot (owner lock via fd 3), so starter B NEVER spawns and
// reports orphaned-owner; after the child dies, starter C can spawn.
func TestOCSpawnCrashPostStartPrePublication(t *testing.T) {
	sc := newOCLockScenario(t)

	// Starter A, fake never listens: A blocks in waitForPort (a ~30s window
	// between Start and publication).
	a := sc.startStarter("A", map[string]string{"VH_FAKE_OC_NOLISTEN": "1"}, false)
	fakes := sc.waitAliveCount(".fake", 1, 10*time.Second)

	// A is provably past Start (the fake exec'd ⇒ fd 3 was dup'd). Crash it.
	_ = a.Process.Kill()
	_ = a.Wait()

	if _, err := os.Stat(ocStatePath()); err == nil {
		t.Fatal("state must not be published in the pre-publication window")
	}

	// Starter B (in-process, real transaction): must refuse to spawn.
	b := EnsureDetachedOpenCode(sc.bin, sc.dir)
	if b.Verdict != DetachedStartOrphanedOwner {
		t.Fatalf("SPLIT-BRAIN REGRESSION: B verdict=%v (%s), want orphaned-owner", b.Verdict, b.Reason)
	}
	if len(b.Holders) == 0 || !strings.Contains(strings.Join(b.Holders, " "), strconv.Itoa(fakes[0])) {
		t.Fatalf("B should report the live fake pid %d as holder; holders=%v", fakes[0], b.Holders)
	}
	if got := len(sc.alivePids(".fake")); got != 1 {
		t.Fatalf("exactly one child expected after B, got %d", got)
	}
	if _, err := os.Stat(ocStatePath()); err == nil {
		t.Fatal("B must not publish state")
	}

	// Owner chain exits → starter C spawns.
	killPid9(fakes[0])
	sc.waitOwnerFree(5 * time.Second)
	c := EnsureDetachedOpenCode(sc.bin, sc.dir)
	if c.Verdict != DetachedStartSpawned {
		t.Fatalf("C verdict=%v (%s), want spawned after owner chain exit", c.Verdict, c.Reason)
	}
	sc.waitAliveCount(".fake", 1, 5*time.Second) // C's child, the only one
	st, ok := readOCState()
	if !ok || st.PID != c.PID {
		t.Fatalf("state after C: %+v ok=%v, want pid=%d", st, ok, c.PID)
	}
}

// TestOCSpawnCrashPostState — A completed the whole transaction (state
// published), then died. B must reattach (never respawn) beside the live,
// answering child.
func TestOCSpawnCrashPostState(t *testing.T) {
	sc := newOCLockScenario(t)

	sc.startStarter("A", nil, false)
	rep := sc.waitReport("A", 30*time.Second)
	if rep.Verdict != "spawned" {
		t.Fatalf("A verdict=%+v, want spawned", rep)
	}
	fakes := sc.waitAliveCount(".fake", 1, 5*time.Second)

	b := EnsureDetachedOpenCode(sc.bin, sc.dir)
	if b.Verdict != DetachedStartReattached {
		t.Fatalf("B verdict=%v (%s), want reattached beside live published instance", b.Verdict, b.Reason)
	}
	if got := sc.alivePids(".fake"); len(got) != 1 || got[0] != fakes[0] {
		t.Fatalf("B must not respawn; fakes=%v want [%d]", got, fakes[0])
	}
	if b.PID != fakes[0] {
		t.Fatalf("B reattached pid=%d, want %d", b.PID, fakes[0])
	}
}

// TestOCSpawnStateWriteFails — the statefile path is unwritable (a directory):
// the spawn still succeeds but nothing is recorded, and B then sees the
// orphaned owner (never spawn). This is the experiment's statefail-alive
// barrier with writeOCState's documented discard semantics.
func TestOCSpawnStateWriteFails(t *testing.T) {
	sc := newOCLockScenario(t)

	// The state path exists as a directory: temp-write succeeds, rename onto
	// it fails, writeOCState discards the error (unchanged semantics).
	if err := os.MkdirAll(ocStatePath(), 0o755); err != nil {
		t.Fatal(err)
	}
	res := EnsureDetachedOpenCode(sc.bin, sc.dir)
	if res.Verdict != DetachedStartSpawned {
		t.Fatalf("want spawned (state-write failure is discarded), got %v (%s)", res.Verdict, res.Reason)
	}
	sc.waitAliveCount(".fake", 1, 5*time.Second)

	b := EnsureDetachedOpenCode(sc.bin, sc.dir)
	if b.Verdict != DetachedStartOrphanedOwner {
		t.Fatalf("B verdict=%v (%s), want orphaned-owner with unpublished state", b.Verdict, b.Reason)
	}
	if got := len(sc.alivePids(".fake")); got != 1 {
		t.Fatalf("B must not spawn beside the unrecorded live child; fakes=%d", got)
	}
}

// TestOCSpawnGrandchildRetainsOwner — opencode dies but a descendant (the
// fake's `sleep` grandchild) inherited fd 3: exclusion persists (B never
// spawns, holder = the grandchild) and C spawns only after the LAST holder
// exits.
func TestOCSpawnGrandchildRetainsOwner(t *testing.T) {
	sc := newOCLockScenario(t)

	a := sc.startStarter("A", map[string]string{
		"VH_FAKE_OC_NOLISTEN":   "1",
		"VH_FAKE_OC_GRANDCHILD": "1",
	}, false)
	fakes := sc.waitAliveCount(".fake", 1, 10*time.Second)
	gchilds := sc.waitAliveCount(".gchild", 1, 10*time.Second)

	_ = a.Process.Kill()
	_ = a.Wait()

	// The opencode stand-in dies; the grandchild keeps the owner lock.
	killPid9(fakes[0])
	if !waitPidDead(fakes[0], 5*time.Second) {
		t.Fatal("fake stand-in did not die")
	}
	if ocOwnerLockHeldByOthers() != true {
		t.Fatal("grandchild must keep the owner lock after the stand-in dies")
	}

	b := EnsureDetachedOpenCode(sc.bin, sc.dir)
	if b.Verdict != DetachedStartOrphanedOwner {
		t.Fatalf("B verdict=%v (%s), want orphaned-owner held by grandchild", b.Verdict, b.Reason)
	}
	if len(b.Holders) == 0 || !strings.Contains(strings.Join(b.Holders, " "), strconv.Itoa(gchilds[0])) {
		t.Fatalf("B should report grandchild pid %d as holder; holders=%v", gchilds[0], b.Holders)
	}

	// Last holder exits → C spawns.
	killPid9(gchilds[0])
	sc.waitOwnerFree(5 * time.Second)
	c := EnsureDetachedOpenCode(sc.bin, sc.dir)
	if c.Verdict != DetachedStartSpawned {
		t.Fatalf("C verdict=%v (%s), want spawned after last holder exit", c.Verdict, c.Reason)
	}
}

// TestOCSpawnRacehammer — repeated post-start crashes with an immediate
// competitor: B must never spawn beside the live child (the invariant the
// 2026-08-28 incident broke).
func TestOCSpawnRacehammer(t *testing.T) {
	sc := newOCLockScenario(t)
	const reps = 10
	for i := 0; i < reps; i++ {
		a := sc.startStarter(fmt.Sprintf("A%d", i), map[string]string{"VH_FAKE_OC_NOLISTEN": "1"}, false)
		fakes := sc.waitAliveCount(".fake", 1, 10*time.Second)
		_ = a.Process.Kill() // crash mid-window
		_ = a.Wait()
		b := EnsureDetachedOpenCode(sc.bin, sc.dir)
		if b.Verdict != DetachedStartOrphanedOwner {
			t.Fatalf("rep %d: B verdict=%v (%s), want orphaned-owner", i, b.Verdict, b.Reason)
		}
		if got := len(sc.alivePids(".fake")); got != 1 {
			t.Fatalf("rep %d: DOUBLE-SPAWN — %d children alive after B", i, got)
		}
		killPid9(fakes[0])
		sc.waitOwnerFree(5 * time.Second)
		if got := len(sc.alivePids(".fake")); got != 0 {
			t.Fatalf("rep %d: cleanup left %d children", i, got)
		}
	}
}

// TestOCSpawnLoserLatency — a contended starter decides in milliseconds, not
// the winner's classify+readiness budget. We hold the starter lock
// in-process and measure the loser's transaction.
func TestOCSpawnLoserLatency(t *testing.T) {
	sc := newOCLockScenario(t)
	g, verdict, _ := acquireOCSpawnGuard()
	if verdict != ocLockAcquired {
		t.Fatalf("acquire: %v", verdict)
	}
	defer g.Release()

	start := time.Now()
	b := EnsureDetachedOpenCode(sc.bin, sc.dir)
	elapsed := time.Since(start)
	if b.Verdict != DetachedStartContended {
		t.Fatalf("verdict=%v (%s), want contended", b.Verdict, b.Reason)
	}
	if got := len(sc.alivePids(".fake")); got != 0 {
		t.Fatalf("contended loser spawned; %d children alive", got)
	}
	// Generous CI bound: the classified contended path reads state once and
	// returns; anything near the ~13s probe budget alone would be a defect.
	if elapsed > 2*time.Second {
		t.Fatalf("contended loser took %v — did it wait out a probe?", elapsed)
	}
}
