package cmd

// Boot-seam wiring tests (DEFER 1 payoff) and serialized-restart tests (DEFER
// 2 payoff) for the shared detached-start transaction. The boot seam is
// proven at two levels:
//
//  1. TestApplyDetachedOCStartMatrix — the verdict→wiring mapping both cobra
//     arms consume (lifecycle transitions, ring seeding, port/URL/cmd).
//  2. TestClientDaemonBootSeam* — clientDaemonRuntime.startDetachedOpenCode,
//     the EXACT code the client-daemon --web=vh cobra arm runs (the arm is a
//     one-line call to it). local-server's arm is the same Ensure + Apply
//     pair, covered by level 1.
//
// The restart tests prove the restart path participates in the same
// per-project serialization, revalidates the recorded pid immediately before
// signaling (never signals a recycled pid), and never respawns beside an
// owner-lock holder.

import (
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/oclife"
)

func TestApplyDetachedOCStartMatrix(t *testing.T) {
	sc := newOCLockScenario(t)
	_ = sc // state-dir/cwd scoping only

	// A disk log to observe ring seeding (reattach/occupied seed it; the
	// fresh-ring reconnect is exactly what the tail exists for).
	if err := os.WriteFile(ocLogPath(), []byte("detached-log-tail\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	dummy := &exec.Cmd{}

	cases := []struct {
		name           string
		res            DetachedStartResult
		wantLife       oclife.State
		wantPort       int
		wantURL        string
		wantCmd        *exec.Cmd
		wantRingSeeded bool
	}{
		{
			name:           "spawned",
			res:            DetachedStartResult{Verdict: DetachedStartSpawned, PID: 11, Port: 4100, Cmd: dummy},
			wantLife:       oclife.StateReady,
			wantPort:       4100,
			wantURL:        "http://127.0.0.1:4100",
			wantCmd:        dummy,
			wantRingSeeded: false,
		},
		{
			name:           "reattached",
			res:            DetachedStartResult{Verdict: DetachedStartReattached, PID: 12, Port: 4101},
			wantLife:       oclife.StateReady,
			wantPort:       4101,
			wantURL:        "http://127.0.0.1:4101",
			wantRingSeeded: true,
		},
		{
			name:           "occupied",
			res:            DetachedStartResult{Verdict: DetachedStartOccupied, PID: 13, Port: 4102, Reason: "probe refused"},
			wantLife:       oclife.StateFailed,
			wantPort:       4102,
			wantURL:        "http://127.0.0.1:4102",
			wantRingSeeded: true,
		},
		{
			name:     "contended without known port",
			res:      DetachedStartResult{Verdict: DetachedStartContended, Reason: "starter lock held"},
			wantLife: oclife.StateFailed,
			wantPort: 0,
			wantURL:  "", // caller's dead-loopback fallback applies
		},
		{
			name:     "contended with recorded port hint",
			res:      DetachedStartResult{Verdict: DetachedStartContended, Port: 4103, Reason: "starter lock held"},
			wantLife: oclife.StateFailed,
			wantPort: 4103,
			wantURL:  "http://127.0.0.1:4103",
		},
		{
			name:     "orphaned owner",
			res:      DetachedStartResult{Verdict: DetachedStartOrphanedOwner, Reason: "holders: pid 1 (sleep)", Holders: []string{"pid 1 (sleep)"}},
			wantLife: oclife.StateFailed,
			wantPort: 0,
			wantURL:  "",
		},
		{
			name:     "failed with targeted port",
			res:      DetachedStartResult{Verdict: DetachedStartFailed, Port: 4104, Reason: "readiness timeout"},
			wantLife: oclife.StateFailed,
			wantPort: 4104,
			wantURL:  "http://127.0.0.1:4104",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			life := oclife.New(oclife.TopologyDetached)
			port, url, cmd := ApplyDetachedOCStart(tc.res, life, "test")
			snap := life.Snapshot()
			if snap.State != tc.wantLife {
				t.Fatalf("life state=%s want=%s", snap.State, tc.wantLife)
			}
			if port != tc.wantPort || url != tc.wantURL {
				t.Fatalf("port/url=%d/%q want %d/%q", port, url, tc.wantPort, tc.wantURL)
			}
			if cmd != tc.wantCmd {
				t.Fatalf("cmd passthrough mismatch")
			}
			switch tc.res.Verdict {
			case DetachedStartOccupied, DetachedStartContended, DetachedStartOrphanedOwner, DetachedStartFailed:
				if snap.FailureSummary != tc.res.Reason {
					t.Fatalf("failure summary=%q want the transaction reason %q", snap.FailureSummary, tc.res.Reason)
				}
			}
			seeded := len(life.Ring().Tail(0)) > 0
			if seeded != tc.wantRingSeeded {
				t.Fatalf("ring seeded=%v want %v", seeded, tc.wantRingSeeded)
			}
		})
	}
}

// bootSeamRuntime builds the runtime the cobra arm uses, with only the fields
// startDetachedOpenCode touches.
func bootSeamRuntime(sc *ocLockScenario) (*clientDaemonRuntime, *oclife.Lifecycle) {
	rt := &clientDaemonRuntime{cwd: sc.dir}
	rt.ocLife = oclife.New(oclife.TopologyDetached)
	return rt, rt.ocLife
}

// withDaemonOpenCodeBin swaps the client-daemon --opencode-bin global for a
// test (the boot seam reads it; tests restore it).
func withDaemonOpenCodeBin(t *testing.T, bin string) {
	t.Helper()
	old := daemonOpenCodeBin
	daemonOpenCodeBin = bin
	t.Cleanup(func() { daemonOpenCodeBin = old })
}

// spawnFakeDirect runs the fake `opencode serve` as a direct child of the
// test process (no starter transaction) — the recorded instance the boot seam
// must classify. Returns the pid.
func (sc *ocLockScenario) spawnFakeDirect(t *testing.T, port int, knobs map[string]string) int {
	t.Helper()
	env := append(os.Environ(), "VH_OC_LOCK_HELPER=fake")
	for k, v := range knobs {
		env = append(env, k+"="+v)
	}
	cmd := exec.Command(os.Args[0],
		"-test.run=^TestOCLockHelperProcess$", "--",
		"opencode", "serve", "--port", strconv.Itoa(port), "--hostname", "127.0.0.1")
	cmd.Env = env
	cmd.Dir = sc.dir
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})
	// Wait for the fake to record itself.
	deadline := time.Now().Add(5 * time.Second)
	for {
		if ocProcessAlive(cmd.Process.Pid) {
			if _, err := os.Stat(sc.fakePidFile(cmd.Process.Pid)); err == nil {
				return cmd.Process.Pid
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("direct fake pid %d never started", cmd.Process.Pid)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (sc *ocLockScenario) fakePidFile(pid int) string {
	return sc.pidsDir + "/" + strconv.Itoa(pid) + ".fake"
}

// TestClientDaemonBootSeamContended — the cobra arm's exact code under a held
// starter lock: the worker records a failed lifecycle, stays up (the test
// process is trivially alive — nothing may os.Exit), and spawns nothing.
func TestClientDaemonBootSeamContended(t *testing.T) {
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, sc.bin)

	g, verdict, _ := acquireOCSpawnGuard()
	if verdict != ocLockAcquired {
		t.Fatalf("acquire: %v", verdict)
	}
	defer g.Release()

	rt, life := bootSeamRuntime(sc)
	rt.startDetachedOpenCode() // must NOT kill the worker

	snap := life.Snapshot()
	if snap.State != oclife.StateFailed {
		t.Fatalf("life state=%s want failed", snap.State)
	}
	if !strings.Contains(snap.FailureSummary, "mid-flight") {
		t.Fatalf("failure summary should name the mid-flight starter: %q", snap.FailureSummary)
	}
	if got := len(sc.alivePids(".fake")); got != 0 {
		t.Fatalf("contended loser spawned %d children", got)
	}
	if rt.opencodeServeCmd != nil {
		t.Fatal("contended loser must not retain a child cmd")
	}
}

// TestClientDaemonBootSeamOccupied — recorded live instance + refused port:
// failed lifecycle, URL pointed at the recorded port, state file UNTOUCHED
// (the UI restart action contract), ring seeded, no spawn, no worker exit.
func TestClientDaemonBootSeamOccupied(t *testing.T) {
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, sc.bin)
	withFastProbeKnobs(t)

	port := freePort()
	pid := sc.spawnFakeDirect(t, port, map[string]string{"VH_FAKE_OC_NOLISTEN": "1"})
	writeOCState(ocState{PID: pid, Port: port})
	before, _ := os.ReadFile(ocStatePath())
	if err := os.WriteFile(ocLogPath(), []byte("wedged-instance-log\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	rt, life := bootSeamRuntime(sc)
	rt.startDetachedOpenCode()

	snap := life.Snapshot()
	if snap.State != oclife.StateFailed {
		t.Fatalf("life state=%s want failed", snap.State)
	}
	if !strings.Contains(snap.FailureSummary, "NOT spawning a second instance beside it") {
		t.Fatalf("occupied reason regression: %q", snap.FailureSummary)
	}
	if rt.opencodePort != port || rt.opencodeURL != "http://127.0.0.1:"+strconv.Itoa(port) {
		t.Fatalf("port/url=%d/%q want the recorded %d", rt.opencodePort, rt.opencodeURL, port)
	}
	after, _ := os.ReadFile(ocStatePath())
	if string(before) != string(after) {
		t.Fatalf("occupied branch touched the state file: %q → %q", before, after)
	}
	if len(life.Ring().Tail(0)) == 0 {
		t.Fatal("occupied branch should seed the ring from the disk log")
	}
	if got := len(sc.alivePids(".fake")); got != 1 {
		t.Fatalf("occupied must not spawn or kill; fakes=%d want 1", got)
	}
}

// TestClientDaemonBootSeamSpawnFailure — unstartable binary: failed lifecycle
// with a parseable dead-loopback URL, worker stays up, no state published.
func TestClientDaemonBootSeamSpawnFailure(t *testing.T) {
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, filepath.Join(sc.dir, "no-such-opencode-bin"))

	rt, life := bootSeamRuntime(sc)
	rt.startDetachedOpenCode()

	snap := life.Snapshot()
	if snap.State != oclife.StateFailed {
		t.Fatalf("life state=%s want failed", snap.State)
	}
	if !strings.Contains(snap.FailureSummary, "failed to start detached opencode serve") {
		t.Fatalf("failure summary=%q", snap.FailureSummary)
	}
	if rt.opencodeURL == "" {
		t.Fatal("failure should still leave a parseable (dead) loopback target")
	}
	if _, err := os.Stat(ocStatePath()); err == nil {
		t.Fatal("state must not be published for a failed spawn")
	}
	if got := len(sc.alivePids(".fake")); got != 0 {
		t.Fatalf("failed spawn left %d children", got)
	}
}

// TestClientDaemonBootSeamSpawned — the happy arm: ready lifecycle, retained
// child, published state.
func TestClientDaemonBootSeamSpawned(t *testing.T) {
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, sc.bin)

	rt, life := bootSeamRuntime(sc)
	rt.startDetachedOpenCode()

	if got := life.Snapshot().State; got != oclife.StateReady {
		t.Fatalf("life state=%s want ready", got)
	}
	if rt.opencodeServeCmd == nil || rt.opencodeServeCmd.Process == nil {
		t.Fatal("spawned arm must retain the child cmd")
	}
	if rt.opencodePort <= 0 || rt.opencodeURL != "http://127.0.0.1:"+strconv.Itoa(rt.opencodePort) {
		t.Fatalf("port/url=%d/%q", rt.opencodePort, rt.opencodeURL)
	}
	st, ok := readOCState()
	if !ok || st.PID != rt.opencodeServeCmd.Process.Pid || st.Port != rt.opencodePort {
		t.Fatalf("state=%+v ok=%v want the spawned child", st, ok)
	}
	sc.waitAliveCount(".fake", 1, 5*time.Second)
}

// --- serialized restart (DEFER 2 payoff) ---

// TestRestartDetachedOpenCodeSerial — happy path: under the lock the old
// instance is stopped, its owner lock release is awaited, the respawn goes
// through the same owner handoff on the STABLE port, and state is
// republished with the new pid.
func TestRestartDetachedOpenCodeSerial(t *testing.T) {
	sc := newOCLockScenario(t)

	res := EnsureDetachedOpenCode(sc.bin, sc.dir)
	if res.Verdict != DetachedStartSpawned {
		t.Fatalf("boot: %v (%s)", res.Verdict, res.Reason)
	}
	oldPID := res.Cmd.Process.Pid

	c2, err := restartDetachedOpenCode(sc.bin, res.Port, sc.dir, oldPID)
	if err != nil {
		t.Fatalf("restart: %v", err)
	}
	if c2 == nil || c2.Process == nil || c2.Process.Pid == oldPID {
		t.Fatalf("restart must return a fresh child (old=%d)", oldPID)
	}
	// The old child was ours: reap it so pid-liveness assertions are honest.
	go func() { _ = res.Cmd.Wait() }()
	if !waitPidDead(oldPID, 5*time.Second) {
		t.Fatalf("old instance pid %d still alive after restart", oldPID)
	}
	st, ok := readOCState()
	if !ok || st.PID != c2.Process.Pid || st.Port != res.Port {
		t.Fatalf("state=%+v ok=%v want pid=%d port=%d (stable port)", st, ok, c2.Process.Pid, res.Port)
	}
	sc.waitAliveCount(".fake", 1, 5*time.Second) // exactly one live child
}

// TestRestartDetachedSkipsForeignPID — the recorded pid died and was recycled
// into an unrelated process (a `sleep`): the restart must NOT signal it, and
// (owner lock free) may proceed to respawn.
func TestRestartDetachedSkipsForeignPID(t *testing.T) {
	sc := newOCLockScenario(t)

	sacrifice := exec.Command("sleep", "300")
	if err := sacrifice.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = sacrifice.Process.Kill()
		_ = sacrifice.Wait()
	})

	// Recorded state points at the sacrificial pid with a foreign cmdline.
	writeOCState(ocState{PID: sacrifice.Process.Pid, Port: 1})

	c, err := restartDetachedOpenCode(sc.bin, freePort(), sc.dir, 0)
	if err != nil {
		t.Fatalf("restart: %v", err)
	}
	if !ocProcessAlive(sacrifice.Process.Pid) {
		t.Fatal("RECYCLED-PID REGRESSION: the restart signaled a pid that is not our OpenCode")
	}
	st, ok := readOCState()
	if !ok || st.PID != c.Process.Pid {
		t.Fatalf("state=%+v ok=%v want the respawned pid %d", st, ok, c.Process.Pid)
	}
	sc.waitAliveCount(".fake", 1, 5*time.Second)
}

// TestRestartDetachedContended — another starter holds the lock: the restart
// errors out without touching anything.
func TestRestartDetachedContended(t *testing.T) {
	sc := newOCLockScenario(t)

	g, verdict, _ := acquireOCSpawnGuard()
	if verdict != ocLockAcquired {
		t.Fatalf("acquire: %v", verdict)
	}
	defer g.Release()

	c, err := restartDetachedOpenCode(sc.bin, freePort(), sc.dir, 0)
	if err == nil || c != nil {
		t.Fatalf("restart under contention must fail; got cmd=%v err=%v", c, err)
	}
	if !strings.Contains(err.Error(), "serialized out") {
		t.Fatalf("error should name the serialization: %v", err)
	}
	if got := len(sc.alivePids(".fake")); got != 0 {
		t.Fatalf("contended restart spawned %d children", got)
	}
}

// TestRestartDetachedOrphanedHolder — a descendant retains the owner lock
// after the recorded instance died: the restart must refuse to respawn beside
// it and surface the holder.
func TestRestartDetachedOrphanedHolder(t *testing.T) {
	sc := newOCLockScenario(t)

	a := sc.startStarter("A", map[string]string{
		"VH_FAKE_OC_NOLISTEN":   "1",
		"VH_FAKE_OC_GRANDCHILD": "1",
	}, false)
	fakes := sc.waitAliveCount(".fake", 1, 10*time.Second)
	gchilds := sc.waitAliveCount(".gchild", 1, 10*time.Second)
	_ = a.Process.Kill()
	_ = a.Wait()
	killPid9(fakes[0]) // the "opencode" dies; the grandchild keeps fd 3
	if !waitPidDead(fakes[0], 5*time.Second) {
		t.Fatal("fake stand-in did not die")
	}
	writeOCState(ocState{PID: fakes[0], Port: 1}) // dead recorded pid

	c, err := restartDetachedOpenCode(sc.bin, freePort(), sc.dir, 0)
	if err == nil || c != nil {
		t.Fatalf("restart beside an orphaned owner must fail; got cmd=%v err=%v", c, err)
	}
	if !strings.Contains(err.Error(), "owner lock") {
		t.Fatalf("error should name the owner lock: %v", err)
	}
	if !strings.Contains(err.Error(), strconv.Itoa(gchilds[0])) {
		t.Fatalf("error should surface the holder pid %d: %v", gchilds[0], err)
	}
	if !ocProcessAlive(gchilds[0]) {
		t.Fatal("restart must not kill the holder")
	}
	if got := len(sc.alivePids(".fake")); got != 0 {
		t.Fatalf("restart spawned %d children beside the holder", got)
	}
}
