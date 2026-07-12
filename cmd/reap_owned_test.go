package cmd

import (
	"os"
	"os/exec"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/oclife"
)

// TestReaperHelper is a pseudo-test that, when the test binary is re-executed
// with VH_TEST_HELPER=block, blocks forever until killed. It never runs as a
// real test in the parent (the env var is only set in the spawned child). This
// is the standard Go pattern for spawning a controllable child from a test
// (cf. os/exec's own helper-process tests): os.Args[0] is the compiled test
// binary, and -test.run scopes it to this single helper.
func TestReaperHelper(t *testing.T) {
	if os.Getenv("VH_TEST_HELPER") != "block" {
		t.Skip("only runs as the helper subprocess")
	}
	select {} // block until killed by the parent test
}

// spawnBlocker starts the test binary as a child that blocks forever, returning
// the running *exec.Cmd. The caller kills it; reapOwnedOpenCode owns the Wait.
func spawnBlocker(t *testing.T) *exec.Cmd {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=TestReaperHelper")
	cmd.Env = append(os.Environ(), "VH_TEST_HELPER=block")
	// Discard the child test runner's stdout/stderr so it can't fill a pipe.
	cmd.Stdout = nil
	cmd.Stderr = nil
	if err := cmd.Start(); err != nil {
		t.Fatalf("start helper subprocess: %v", err)
	}
	return cmd
}

// TestReapOwnedOpenCodeSetsStateBeforeClosingDone pins the ORDERING INVARIANT
// the P1 race fix establishes: by the time reapOwnedOpenCode closes `done`, it
// has ALREADY recorded the exit in lifecycle state. restartOpencodeLocked
// unblocks on <-oldDone, so this guarantee is what lets the restart path's
// SetStarting()/SetReady() overwrite the reaper's honest exit report in the
// right order.
//
// Under the old ordering (close(done) BEFORE SetFailed/SetStopped), reading the
// state immediately after <-done was a data race — the reaper goroutine had not
// necessarily run the state-set yet, so the state could still read "ready" (the
// pre-exit value). `go test -race` flags that; functionally it intermittently
// failed. With the fix, close(done) happens-after the state-set, so the channel
// establishes happens-before and this read is race-free and deterministic.
func TestReapOwnedOpenCodeSetsStateBeforeClosingDone(t *testing.T) {
	life := oclife.New(oclife.TopologyOwned)
	life.SetReady() // baseline: OpenCode was up before the child died

	cmd := spawnBlocker(t)
	done := make(chan struct{})
	go reapOwnedOpenCode(cmd, done, life)

	// Kill the child (as a SIGTERM/killed exit) and wait for the reaper.
	if err := cmd.Process.Kill(); err != nil {
		t.Fatalf("kill helper: %v", err)
	}
	<-done

	// INVARIANT: the reaper recorded the exit BEFORE closing done. A killed
	// child yields a non-zero exit, so the recorded state is failed (never the
	// pre-exit "ready" / "starting"). Asserting a terminal exit state here —
	// not the pre-exit value — is exactly what the old ordering violated.
	s := life.Snapshot()
	if s.State != oclife.StateFailed && s.State != oclife.StateStopped {
		t.Fatalf("state = %q after <-done; reaper must record exit BEFORE closing done (want failed/stopped)", s.State)
	}
}

// TestReapOwnedOpenCodeRestartDoesNotClobberReady reproduces the owned-restart
// lifecycle race end to end: the old reaper's SetFailed must land BEFORE the
// restart path's SetStarting()/SetReady() so the fresh SetReady is the final
// state. This is the user-visible symptom of the P1 bug — the health panel
// flashing/sticking on "failed: signal: terminated" for 2-5s after a restart.
//
// With the buggy ordering (close(done) before SetFailed), the old reaper's
// SetFailed raced the restart path's SetReady with no synchronization, so the
// final state was nondeterministically "failed". With the fix, the reaper's
// state-set happens-before <-done, which happens-before SetStarting/SetReady,
// so SetReady is deterministically the final state.
func TestReapOwnedOpenCodeRestartDoesNotClobberReady(t *testing.T) {
	life := oclife.New(oclife.TopologyOwned)
	life.SetReady()

	cmd := spawnBlocker(t)
	done := make(chan struct{})
	go reapOwnedOpenCode(cmd, done, life)

	// Mirror restartOpencodeLocked's owned arm: signal the old child, wait for
	// the reaper's done, then drive the fresh state machine.
	if err := cmd.Process.Kill(); err != nil {
		t.Fatalf("kill helper: %v", err)
	}
	<-done
	life.SetStarting()
	life.SetReady()

	s := life.Snapshot()
	if s.State != oclife.StateReady {
		t.Fatalf("after restart sequence, state = %q, want ready (old reaper state-set must not overwrite SetReady)", s.State)
	}
}
