//go:build linux

package cmd

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/oclife"
)

// withWatchKnobs shrinks the death-watch timing knobs for a test and
// restores them (t.Cleanup) so serially-run neighbours see the defaults.
func withWatchKnobs(t *testing.T, tick, base, max, healthy, window time.Duration, crashMax int) {
	t.Helper()
	oTick, oBase, oMax, oHealthy, oWindow, oMaxN := ocWatchTick, ocWatchBackoffBase, ocWatchBackoffMax, ocWatchHealthyReset, ocWatchCrashWindow, ocWatchCrashMax
	ocWatchTick, ocWatchBackoffBase, ocWatchBackoffMax, ocWatchHealthyReset, ocWatchCrashWindow, ocWatchCrashMax = tick, base, max, healthy, window, crashMax
	t.Cleanup(func() {
		ocWatchTick, ocWatchBackoffBase, ocWatchBackoffMax, ocWatchHealthyReset, ocWatchCrashWindow, ocWatchCrashMax = oTick, oBase, oMax, oHealthy, oWindow, oMaxN
	})
}

// watchRuntime extends bootSeamRuntime with the daemon-lifetime context the
// watcher binds to (mirrors what setupVHMode now does before arming).
func watchRuntime(sc *ocLockScenario) (*clientDaemonRuntime, *oclife.Lifecycle) {
	rt, life := bootSeamRuntime(sc)
	ctx, cancel := context.WithCancel(context.Background())
	rt.vhCtx, rt.vhCancel = ctx, cancel
	sc.t.Cleanup(cancel)
	return rt, life
}

// watchWaitFor polls cond every ~10ms until true or the deadline; fatals
// with msg on timeout.
func watchWaitFor(t *testing.T, d time.Duration, cond func() bool, msg string) {
	t.Helper()
	deadline := time.Now().Add(d)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timeout waiting for: %s", msg)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// fakeTotal counts spawn-marker files (<pid>.fake) in the scenario pids dir
// — the fake opencode binary writes one per spawn, so this is the spawn
// count across the whole scenario.
func fakeTotal(sc *ocLockScenario) int {
	ents, err := os.ReadDir(sc.pidsDir)
	if err != nil {
		return 0
	}
	n := 0
	for _, e := range ents {
		if strings.HasSuffix(e.Name(), ".fake") {
			n++
		}
	}
	return n
}

// rtChildPID reads rt.opencodeServeCmd under opencodeMu — the watcher
// goroutine mutates it, so bare reads race.
func rtChildPID(rt *clientDaemonRuntime) int {
	rt.opencodeMu.Lock()
	defer rt.opencodeMu.Unlock()
	if c := rt.opencodeServeCmd; c != nil && c.Process != nil {
		return c.Process.Pid
	}
	return 0
}

// rtChildCmd snapshots the current *exec.Cmd under opencodeMu so the test
// can Wait() the exact child it killed.
func rtChildCmd(rt *clientDaemonRuntime) *exec.Cmd {
	rt.opencodeMu.Lock()
	defer rt.opencodeMu.Unlock()
	return rt.opencodeServeCmd
}

// Test 1 (mission): a signal-killed detached child is detected WITHOUT
// being reaped — the corpse stays a zombie (PID-reuse invariant) while the
// watcher reports the signal and self-heals through the serialized restart.
func TestOCWatchSignalKillDetectedNotReaped(t *testing.T) {
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, sc.bin)
	withWatchKnobs(t, 5*time.Millisecond, 700*time.Millisecond, 1*time.Second, time.Hour, time.Hour, 5)
	rt, life := watchRuntime(sc)

	rt.startDetachedOpenCode() // also arms the watcher (spawned → parent path)
	watchWaitFor(t, 10*time.Second, func() bool { return life.Snapshot().State == oclife.StateReady }, "initial boot ready")

	first := rtChildCmd(rt)
	if first == nil {
		t.Fatal("boot did not retain the spawned child cmd")
	}
	pid := first.Process.Pid

	killPid9(pid)

	// Death observed as failed with the signal named, and the old pid is a
	// ZOMBIE that signal-0 still reaches — i.e. detected but NOT reaped.
	watchWaitFor(t, 3*time.Second, func() bool {
		s := life.Snapshot()
		return s.State == oclife.StateFailed && strings.Contains(s.FailureSummary, "signal KILL/9")
	}, "watcher reports signal KILL/9 failure")
	watchWaitFor(t, 3*time.Second, func() bool { return ocProcState(pid) == 'Z' }, "killed child is a zombie")
	if !ocProcessAlive(pid) {
		t.Fatal("signal-0 liveness should still succeed on the unreaped zombie")
	}
	if s := life.Snapshot(); s.DownSince == nil {
		t.Fatal("death should mark DownSince")
	}

	// Self-heal: serialized restart spawns a fresh child and returns to
	// ready — while the OLD pid remains a zombie across the whole restart.
	watchWaitFor(t, 10*time.Second, func() bool {
		return life.Snapshot().State == oclife.StateReady && rtChildPID(rt) != 0 && rtChildPID(rt) != pid
	}, "auto-restart to a new ready child")
	if got := ocProcState(pid); got != 'Z' {
		t.Fatalf("old pid %d must stay unreaped across the restart, state=%q", pid, got)
	}

	// Tidy: reap the zombie we own so the test binary doesn't accumulate it.
	t.Cleanup(func() { _ = first.Wait() })
}

// Test 2 (mission): crash-loop cap — attempts stop exactly at the cap, the
// final state is the visible failed state, and no further spawns happen.
func TestOCWatchCrashLoopCap(t *testing.T) {
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, sc.bin)
	withWatchKnobs(t, 5*time.Millisecond, 5*time.Millisecond, 10*time.Millisecond, time.Hour, time.Hour, 3)
	rt, life := watchRuntime(sc)

	rt.startDetachedOpenCode()
	watchWaitFor(t, 10*time.Second, func() bool { return life.Snapshot().State == oclife.StateReady }, "boot ready")

	killCur := func() int {
		pid := rtChildPID(rt)
		if pid == 0 {
			t.Fatal("no current child to kill")
		}
		killPid9(pid)
		return pid
	}

	// 3 crashes → 3 auto-restarts (attempts 1..3 of cap 3), each healing.
	for i := 0; i < 3; i++ {
		old := killCur()
		watchWaitFor(t, 15*time.Second, func() bool {
			return life.Snapshot().State == oclife.StateReady && rtChildPID(rt) != 0 && rtChildPID(rt) != old
		}, fmt.Sprintf("heal after crash %d", i+1))
	}

	// 4th crash: cap reached → give up, failed, RestartCapped, no more spawns.
	killCur()
	watchWaitFor(t, 5*time.Second, func() bool {
		s := life.Snapshot()
		return s.State == oclife.StateFailed && s.RestartCapped && strings.Contains(s.FailureSummary, "crash-loop")
	}, "crash-loop give-up state")

	// Exactly cap restarts happened: boot + 3 = 4 spawns, and that count
	// must be stable once capped.
	want := 4
	watchWaitFor(t, 2*time.Second, func() bool { return fakeTotal(sc) == want }, "spawn count == boot+3")
	if got := fakeTotal(sc); got != want {
		t.Fatalf("spawn count = %d, want %d", got, want)
	}
	time.Sleep(300 * time.Millisecond)
	if got := fakeTotal(sc); got != want {
		t.Fatalf("spawn count grew past cap: %d", got)
	}
	if n := sc.alivePids(".fake"); len(n) != 0 {
		t.Fatalf("no live opencode expected after give-up, got %v", n)
	}
}

// Test 3 (mission): a user-initiated restart racing the watcher's scheduled
// auto-restart yields EXACTLY ONE spawn (the user's).
func TestOCWatchUserRestartRacesWatcher(t *testing.T) {
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, sc.bin)
	withDaemonOpenCodeDetached(t, true) // restartOpencode branches on this flag
	// Long backoff so the user restart wins the race deterministically.
	withWatchKnobs(t, 5*time.Millisecond, 1*time.Second, 2*time.Second, time.Hour, time.Hour, 5)
	rt, life := watchRuntime(sc)

	rt.startDetachedOpenCode()
	watchWaitFor(t, 10*time.Second, func() bool { return life.Snapshot().State == oclife.StateReady }, "boot ready")
	first := rtChildCmd(rt)
	pid := first.Process.Pid

	killPid9(pid)

	// Immediately drive the USER restart — the exact path the restart
	// server hook uses (mutex + restartOpencode).
	done := make(chan error, 1)
	go func() {
		rt.opencodeMu.Lock()
		defer rt.opencodeMu.Unlock()
		done <- rt.restartOpencode()
	}()
	if err := <-done; err != nil {
		t.Fatalf("user restart failed: %v", err)
	}
	watchWaitFor(t, 10*time.Second, func() bool {
		return life.Snapshot().State == oclife.StateReady && rtChildPID(rt) != 0 && rtChildPID(rt) != pid
	}, "user restart lands a new ready child")

	// Let any would-be auto-restart timer fire well past its backoff and
	// confirm it defers/skips instead of queueing a second spawn.
	time.Sleep(1500 * time.Millisecond)
	if got, want := fakeTotal(sc), 2; got != want {
		t.Fatalf("spawn count = %d, want exactly %d (boot + user restart)", got, want)
	}
	if s := life.Snapshot(); s.State != oclife.StateReady {
		t.Fatalf("final state = %s, want ready", s.State)
	}
	t.Cleanup(func() { _ = first.Wait() })
}

// Test 4a (mission): daemon REATTACHED to an OpenCode it did not spawn (the
// starter subprocess is gone → the child was reparented, we are not its
// parent). Death is detected via the identity-poll path (exit status
// honestly unobserved) and the auto-restart still goes through the
// serialized path, now spawning our own child.
func TestOCWatchReattachDeathIdentityPollRestart(t *testing.T) {
	sc := newOCLockScenario(t)
	sc.startStarter("A", nil, false)
	rep := sc.waitReport("A", 30*time.Second)
	if rep.Verdict != "spawned" {
		t.Fatalf("starter A verdict = %q, want spawned", rep.Verdict)
	}
	if fakes := sc.waitAliveCount(".fake", 1, 10*time.Second); len(fakes) != 1 {
		t.Fatalf("fake pid not alive after spawn: %v", fakes)
	}
	withDaemonOpenCodeBin(t, sc.bin)
	withWatchKnobs(t, 5*time.Millisecond, 400*time.Millisecond, 1*time.Second, time.Hour, time.Hour, 5)
	rt, life := watchRuntime(sc)

	rt.startDetachedOpenCode() // reattach: cmd nil, watcher armed non-parent
	if c := rtChildCmd(rt); c != nil {
		t.Fatalf("reattach must not retain a cmd, got pid %d", c.Process.Pid)
	}
	watchWaitFor(t, 10*time.Second, func() bool { return life.Snapshot().State == oclife.StateReady }, "reattach ready")

	killPid9(rep.PID) // not our child → ECHILD → identity-poll path

	watchWaitFor(t, 3*time.Second, func() bool {
		s := life.Snapshot()
		return s.State == oclife.StateFailed && strings.Contains(s.FailureSummary, "exit status unobserved (reattached")
	}, "identity-poll death reported honestly as unobserved")

	watchWaitFor(t, 15*time.Second, func() bool {
		return life.Snapshot().State == oclife.StateReady && rtChildPID(rt) != 0
	}, "auto-restart spawns our own replacement child")
	if got, want := fakeTotal(sc), 2; got != want {
		t.Fatalf("spawn count = %d, want %d (starter's + replacement)", got, want)
	}
}

// Test 4b (mission): auto-restart never spawns beside a live owner-lock
// holder — the grandchild keeps the owner flock, every restart attempt
// fails the bounded owner-release wait, the crash cap trips, zero spawns.
func TestOCWatchReattachNoSpawnBesideHolder(t *testing.T) {
	sc := newOCLockScenario(t)
	sc.startStarter("A", map[string]string{"VH_FAKE_OC_GRANDCHILD": "1"}, false)
	rep := sc.waitReport("A", 30*time.Second)
	if rep.Verdict != "spawned" {
		t.Fatalf("starter A verdict = %q, want spawned", rep.Verdict)
	}
	if fakes := sc.waitAliveCount(".fake", 1, 10*time.Second); len(fakes) != 1 {
		t.Fatalf("fake pid not alive after spawn: %v", fakes)
	}
	if len(sc.alivePids(".gchild")) == 0 {
		t.Fatal("grandchild (owner-lock holder) not alive")
	}
	withOwnerReleaseWait(t, 300*time.Millisecond)
	withDaemonOpenCodeBin(t, sc.bin)
	withWatchKnobs(t, 5*time.Millisecond, 50*time.Millisecond, 100*time.Millisecond, time.Hour, time.Hour, 2)
	rt, life := watchRuntime(sc)

	rt.startDetachedOpenCode() // reattach; watcher armed non-parent on rep.PID
	watchWaitFor(t, 10*time.Second, func() bool { return life.Snapshot().State == oclife.StateReady }, "reattach ready")

	killPid9(rep.PID)
	waitPidDead(rep.PID, 5*time.Second)

	// Two attempts (cap 2), each blocking on the owner-release wait and
	// failing without spawning, then the give-up state.
	watchWaitFor(t, 15*time.Second, func() bool {
		s := life.Snapshot()
		return s.State == oclife.StateFailed && s.RestartCapped && strings.Contains(s.FailureSummary, "crash-loop")
	}, "crash-loop give-up beside live owner holder")

	if got := fakeTotal(sc); got != 1 {
		t.Fatalf("spawn count = %d, want 1 (the starter's only — never beside the holder)", got)
	}
	if len(sc.alivePids(".gchild")) == 0 {
		t.Fatal("grandchild owner-holder must still be alive")
	}
}

// Test 5 (mission): deliberate stops never auto-restart — both the
// SetStopped path and daemon-teardown context cancellation.
func TestOCWatchDeliberateStopNoRestart(t *testing.T) {
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, sc.bin)
	withDaemonOpenCodeDetached(t, true) // restartOpencode branches on this flag
	withWatchKnobs(t, 5*time.Millisecond, 50*time.Millisecond, 100*time.Millisecond, time.Hour, time.Hour, 5)
	rt, life := watchRuntime(sc)

	rt.startDetachedOpenCode()
	watchWaitFor(t, 10*time.Second, func() bool { return life.Snapshot().State == oclife.StateReady }, "boot ready")
	pid := rtChildPID(rt)

	// (a) deliberate stop: the stopper's SetStopped is the discriminator.
	life.SetStopped()
	killPid9(pid)
	time.Sleep(400 * time.Millisecond)
	if got, want := fakeTotal(sc), 1; got != want {
		t.Fatalf("spawn count after deliberate-stop death = %d, want %d (no restart)", got, want)
	}
	if s := life.Snapshot(); s.State != oclife.StateStopped {
		t.Fatalf("state = %s, want stopped (death must not overwrite deliberate stop)", s.State)
	}

	// (b) daemon-teardown suppression, ISOLATED: a separately LIVE ready
	// child, cancel the watcher context FIRST, then kill. The old shape of
	// this case killed the already-dead child from (a) — proving nothing.
	rt.opencodeMu.Lock()
	err := rt.restartOpencode()
	rt.opencodeMu.Unlock()
	if err != nil {
		t.Fatalf("user restart for teardown case: %v", err)
	}
	watchWaitFor(t, 10*time.Second, func() bool { return life.Snapshot().State == oclife.StateReady }, "restart ready for teardown case")
	pid2 := rtChildPID(rt)
	if pid2 == 0 || pid2 == pid {
		t.Fatalf("no fresh child for teardown case (pid=%d pid2=%d)", pid, pid2)
	}
	rt.vhCancel()
	time.Sleep(100 * time.Millisecond) // let the watcher loop observe ctx.Done and exit
	killPid9(pid2)
	time.Sleep(400 * time.Millisecond) // > several ticks + would-be backoff: nothing may spawn
	if got, want := fakeTotal(sc), 2; got != want {
		t.Fatalf("spawn count after teardown death = %d, want %d (no restart at shutdown)", got, want)
	}
	if s := life.Snapshot(); s.State != oclife.StateReady {
		t.Fatalf("state = %s, want ready (exiting watcher must not rewrite state)", s.State)
	}
}

// Test 6 (mission, --web opencode): detection-only — the web child's death
// is observed, the sole Wait() runs (populating ProcessState so the
// teardown HealthCheck can finally see it), and NO restart is attempted.
func TestOCWatchWebModeDetectionOnly(t *testing.T) {
	sc := newOCLockScenario(t)
	rt := &clientDaemonRuntime{cwd: sc.dir}
	port := freePort()
	c, err := startOpenCodeWeb(sc.bin, "127.0.0.1", port, "", sc.dir)
	if err != nil {
		t.Fatalf("startOpenCodeWeb: %v", err)
	}
	t.Cleanup(func() { _ = c.Wait() })
	rt.opencodeWebCmd = c

	ctx, cancel := context.WithCancel(context.Background())
	rt.vhCtx, rt.vhCancel = ctx, cancel
	t.Cleanup(cancel)

	rt.webWatcher = newOCDeathWatcher(nil, nil) // no lifecycle, no restart
	reapDone := make(chan struct{})
	rt.webWatcher.Reap = func() {
		_ = c.Wait()
		close(reapDone)
	}
	rt.webWatcher.Start(ctx)
	rt.webWatcher.Arm(c.Process.Pid, port, true)

	// Fake `opencode web` listens on the port; kill it once settled.
	watchWaitFor(t, 10*time.Second, func() bool { return waitForPort(port, 2*time.Second) == nil }, "web child listening")
	killPid9(c.Process.Pid)

	select {
	case <-reapDone:
	case <-time.After(3 * time.Second):
		t.Fatal("detection-only watcher never reaped the web child")
	}
	if c.ProcessState == nil {
		t.Fatal("ProcessState must be populated by the sole Wait (teardown HealthCheck depends on it)")
	}
}

// Test 6b: the parent fast-path reports a clean EXIT CODE (not only
// signals), detection-only.
func TestOCWatchExitCodeReported(t *testing.T) {
	sc := newOCLockScenario(t)
	withWatchKnobs(t, 5*time.Millisecond, time.Hour, time.Hour, time.Hour, time.Hour, 5)
	life := oclife.New("detached")
	rt := &clientDaemonRuntime{cwd: sc.dir}

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)

	// A child that exits by itself with a distinctive code.
	c := exec.Command("sh", "-c", "sleep 0.2; exit 7")
	setDetachedAttrs(c)
	if err := c.Start(); err != nil {
		t.Fatalf("start exit-7 child: %v", err)
	}
	t.Cleanup(func() { _ = c.Wait() })

	rt.ocWatcher = newOCDeathWatcher(life, nil) // restart nil → detection-only
	rt.ocWatcher.Start(ctx)
	rt.ocWatcher.Arm(c.Process.Pid, 0, true)

	watchWaitFor(t, 3*time.Second, func() bool {
		s := life.Snapshot()
		return s.State == oclife.StateFailed && strings.Contains(s.FailureSummary, "exit code 7")
	}, "exit code 7 reported")
	if got, want := fakeTotal(sc), 0; got != want {
		t.Fatalf("detection-only watcher spawned something: %d", got)
	}
}
