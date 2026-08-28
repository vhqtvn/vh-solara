//go:build linux

package cmd

// Boot-seam wiring tests (DEFER 1 payoff) and serialized-restart tests (DEFER
// 2 payoff) for the shared detached-start transaction. Linux-only: the
// scenarios assert flock/owner-lock and /proc semantics through the
// ocLockScenario scaffolding (opencode_lock_test.go, also linux-only). The
// portable verdict→wiring matrix (TestApplyDetachedOCStartMatrix) lives in
// opencode_start_apply_test.go so it keeps running on every platform.
//
// The boot seam is proven at one level here:
//
//   - TestClientDaemonBootSeam* — clientDaemonRuntime.startDetachedOpenCode,
//     the EXACT code the client-daemon --web=vh cobra arm runs (the arm is a
//     one-line call to it). local-server's arm is the same Ensure + Apply
//     pair, covered by the platform-independent matrix test.
//
// The restart tests prove the restart path participates in the same
// per-project serialization, revalidates the recorded pid immediately before
// signaling (never signals a recycled pid), re-derives the port when handed
// none (D2), waits out a live owner-lock holder even when nothing of ours was
// signaled (A1), and never respawns beside an owner-lock holder.

import (
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

// withOwnerReleaseWait shrinks the restart's owner-release wait budget so
// holder-refuses-to-die tests fail in milliseconds instead of the full 15s.
func withOwnerReleaseWait(t *testing.T, d time.Duration) {
	t.Helper()
	old := ocOwnerReleaseWait
	ocOwnerReleaseWait = d
	t.Cleanup(func() { ocOwnerReleaseWait = old })
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
	withOwnerReleaseWait(t, 300*time.Millisecond) // holder never releases; fail fast

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

// --- D2 payoff: port<=0 restart re-derivation ---

// pickLowPort returns a free loopback port BELOW the Linux ephemeral port
// range (ip_local_port_range, 32768+ by default) — a port freePort() can
// never hand out — so the re-derived-from-state assertion below is a
// deterministic discriminator, not a coincidence test.
func pickLowPort(t *testing.T) int {
	t.Helper()
	for p := 24000; p < 24020; p++ {
		if portFree(p) {
			return p
		}
	}
	t.Fatal("no free port in the low probe range")
	return 0
}

// TestRestartDetachedReDerivesRecordedPort — D2: a restart handed port<=0
// (a Contended/OrphanedOwner boot left port 0 wired on the runtime) with
// VALID recorded state re-derives the RECORDED port and restarts on it —
// instead of spawning `opencode serve --port 0`, whose readiness wait can
// never succeed (30s hang, child stranded on an OS-assigned port).
func TestRestartDetachedReDerivesRecordedPort(t *testing.T) {
	sc := newOCLockScenario(t)
	port := pickLowPort(t) // below the ephemeral range: freePort() cannot return it

	// Valid recorded state naming a live but FOREIGN pid (the kill phase
	// must skip and never signal it).
	sacrifice := exec.Command("sleep", "300")
	if err := sacrifice.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = sacrifice.Process.Kill()
		_ = sacrifice.Wait()
	})
	writeOCState(ocState{PID: sacrifice.Process.Pid, Port: port})

	c, err := restartDetachedOpenCode(sc.bin, 0, sc.dir, 0)
	if err != nil {
		t.Fatalf("restart at port<=0 must re-derive the recorded port and succeed: %v", err)
	}
	st, ok := readOCState()
	if !ok || st.PID != c.Process.Pid || st.Port != port {
		t.Fatalf("state=%+v ok=%v want pid=%d on the RECORDED port %d", st, ok, c.Process.Pid, port)
	}
	if !ocProcessAlive(sacrifice.Process.Pid) {
		t.Fatal("the foreign recorded pid must stay untouched")
	}
	sc.waitAliveCount(".fake", 1, 5*time.Second)
}

// TestRestartDetachedFreshPortWhenNoState — D2: port<=0 with NO valid
// recorded state (the boot verdict never read/published state) picks a fresh
// free port: the restart SUCCEEDS and publishes state. The old behavior
// (`--port 0`) could never pass readiness, wedging the directed recovery.
func TestRestartDetachedFreshPortWhenNoState(t *testing.T) {
	sc := newOCLockScenario(t)

	if _, err := os.Stat(ocStatePath()); err == nil {
		t.Fatal("precondition: a fresh scenario has no state file")
	}
	c, err := restartDetachedOpenCode(sc.bin, 0, sc.dir, 0)
	if err != nil {
		t.Fatalf("restart at port<=0 with no state must pick a fresh port and succeed: %v", err)
	}
	st, ok := readOCState()
	if !ok || st.PID != c.Process.Pid || st.Port <= 0 {
		t.Fatalf("state=%+v ok=%v want the respawned pid %d on a fresh port>0", st, ok, c.Process.Pid)
	}
	sc.waitAliveCount(".fake", 1, 5*time.Second)
}

// --- A1 payoff: the owner-release wait ---

// TestRestartDetachedWaitsOutUnsignaledHolder — A1's residual gap: NOTHING of
// ours was signaled (curPID 0, no valid state) yet the owner lock is held by
// a live holder that releases shortly after the restart began. The restart
// must enter the bounded release wait and proceed once the slot frees — not
// fail instantly on EWOULDBLOCK from takeOwnerForChild. (Pre-fix, this test
// fails: the wait was gated on the `signaled` flag.)
func TestRestartDetachedWaitsOutUnsignaledHolder(t *testing.T) {
	sc := newOCLockScenario(t)

	// The test process itself becomes the transient holder: a second open
	// file description on the owner lock, which flock denies to the
	// transaction exactly like a foreign process would (flock excludes per
	// description, not per process — see TestOCSpawnGuardStarterLockMutualExclusion).
	fd, err := syscall.Open(ocOwnerLockPath(), syscall.O_RDWR|syscall.O_CREAT, 0o600)
	if err != nil {
		t.Fatalf("open owner lock: %v", err)
	}
	if err := syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatalf("flock owner lock: %v", err)
	}
	released := make(chan time.Time, 1)
	go func() {
		time.Sleep(700 * time.Millisecond)
		released <- time.Now()
		_ = syscall.Close(fd)
	}()
	t.Cleanup(func() { _ = syscall.Close(fd) }) // no-op once the goroutine closed it

	start := time.Now()
	c, errRestart := restartDetachedOpenCode(sc.bin, freePort(), sc.dir, 0)
	if errRestart != nil {
		t.Fatalf("restart must wait out the un-signaled holder and proceed: %v", errRestart)
	}
	// The restart can only have acquired the slot after the holder released:
	// it demonstrably WAITED rather than failed fast (or got lucky spawning
	// beside a live holder — the split-brain invariant forbids that).
	if elapsed := time.Since(start); elapsed < 500*time.Millisecond {
		t.Fatalf("restart finished in %v — it did not wait out the 700ms holder", elapsed)
	}
	st, ok := readOCState()
	if !ok || st.PID != c.Process.Pid {
		t.Fatalf("state=%+v ok=%v want the respawned pid %d", st, ok, c.Process.Pid)
	}
	sc.waitAliveCount(".fake", 1, 5*time.Second)
}

// TestRestartDetachedCurPIDHolderWait — A1's literal shape from the card: the
// caller's retained child (curPID) is the live owner-lock holder while the
// recorded state names a different, foreign pid. The restart kills curPID,
// ENTERS the bounded owner-release wait (SIGTERM alone does not free the slot
// until the process actually exits), and respawns only after the release.
func TestRestartDetachedCurPIDHolderWait(t *testing.T) {
	sc := newOCLockScenario(t)

	// Spawn the real instance (owns the slot, publishes state)…
	res := EnsureDetachedOpenCode(sc.bin, sc.dir)
	if res.Verdict != DetachedStartSpawned {
		t.Fatalf("boot: %v (%s)", res.Verdict, res.Reason)
	}
	oldPID := res.Cmd.Process.Pid

	// …then make the state stale: it names a live foreign pid, so the kill
	// phase skips st.PID and only curPID (the real holder) is signaled.
	sacrifice := exec.Command("sleep", "300")
	if err := sacrifice.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = sacrifice.Process.Kill()
		_ = sacrifice.Wait()
	})
	writeOCState(ocState{PID: sacrifice.Process.Pid, Port: 1})

	port := freePort()
	c, err := restartDetachedOpenCode(sc.bin, port, sc.dir, oldPID)
	if err != nil {
		t.Fatalf("restart: %v", err)
	}
	if !ocProcessAlive(sacrifice.Process.Pid) {
		t.Fatal("the foreign recorded pid must stay untouched")
	}
	go func() { _ = res.Cmd.Wait() }() // reap ours so liveness assertions are honest
	if !waitPidDead(oldPID, 5*time.Second) {
		t.Fatal("the old holder must be dead after the restart")
	}
	st, ok := readOCState()
	if !ok || st.PID != c.Process.Pid || st.Port != port {
		t.Fatalf("state=%+v ok=%v want pid=%d port=%d", st, ok, c.Process.Pid, port)
	}
	sc.waitAliveCount(".fake", 1, 5*time.Second) // exactly one live child
}
