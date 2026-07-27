package state

import (
	"encoding/json"
	"testing"
	"time"
)

// TestBusyCompletionStrand_NoSessionIdle_StrandsRunningRoots covers the
// "stranded busy" scenario: an in-flight assistant message arms busyCount["R"];
// the assistant turn COMPLETES (message.updated with time.completed) but
// OpenCode emits session.idle only when it gets around to it — and on a flaky
// transport session.idle can be dropped entirely. Before the fix,
// busyCount["R"] stranded at 1 until the ~60s /session/status reconcile cleared
// it, and if /session/status itself was stale (reported busy) the strand was
// permanent.
//
// The fix is a completion-grace window + completion-authority guard:
//
//  1. Synchronously after completion the root is STILL "running" — the store
//     arms a short grace window rather than idling immediately, so a multi-step
//     turn (text → tool → text, next step's inflight not yet arrived) does not
//     dip the spinner or fire a spurious "finished" between steps.
//  2. After the grace window fires with no new activity, the turn is
//     authoritatively over: busy is cleared (busyCount["R"]→0,
//     RunningRoots()==0) WITHOUT needing session.idle.
//  3. The completion-authority guard then refuses to re-strand: a STALE busy
//     from /session/status (the ~60s HTTP poll lagging the real session state)
//     must NOT re-escalate. message.updated{completed} wins over a stale
//     status snapshot.
//  4. A NEW turn is respected: a fresh in-flight assistant message clears the
//     guard and re-arms busy (the guard is scoped to the completed turn, not a
//     permanent busy-lock).
//
// Fixture-INDEPENDENT: drives s.Apply directly, never imports pkg/fixtures, and
// never emits session.idle — exactly the gap the grace window + authority guard
// exist to close.
func TestBusyCompletionStrand_NoSessionIdle_StrandsRunningRoots(t *testing.T) {
	s := New(100)
	// Shrink the completion-grace window so the test can observe the
	// authoritative clear without waiting the prod default (5s). The grace
	// window is what lets a completed assistant turn clear a stranded
	// busyCount WITHOUT synchronously idling (which would dip the spinner mid
	// multi-step turn).
	s.completionGrace = 2 * time.Millisecond

	// Root session "R".
	s.Apply(ev("session.created", evSessionCreated("R", "")))

	// In-flight assistant message → busy armed via the message-stream busy
	// escalation site (upsertMessageLocked → setActivityLocked → busyCount["R"]++).
	s.Apply(ev("message.updated", evAssistantInflight("R", "m1")))

	// Sanity: busy correctly armed → one running root.
	if got := s.RunningRoots(); got != 1 {
		t.Fatalf("after inflight assistant message: RunningRoots()=%d, want 1 (busy armed)", got)
	}

	// Assistant turn COMPLETES (time.completed set). Synchronously the store
	// does NOT clear busy — it arms the completion-grace window so a multi-step
	// turn's inter-step gap does not dip the spinner. So synchronously the root
	// is STILL running: this is the multi-step-turn protection, NOT the strand.
	s.Apply(ev("message.updated", evAssistantCompleted("R", "m1")))
	if got := s.RunningRoots(); got != 1 {
		t.Fatalf("synchronously after completion (grace pending): RunningRoots()=%d, want 1 "+
			"(grace window protects multi-step turns; synchronous idle would dip the spinner)", got)
	}

	// THE FIX (was RED, now GREEN): after the completion-grace window fires
	// with no new activity, the turn is authoritatively over and busy is
	// cleared — busyCount["R"]→0, RunningRoots()==0. No session.idle needed.
	// Poll briefly for the async graceFire callback (runs on a time.AfterFunc
	// goroutine; takes s.mu fresh).
	if !waitForRunningRoots(s, 0, time.Second) {
		t.Fatalf("after completion-grace fired: RunningRoots()=%d, want 0 "+
			"(grace should clear stranded busy without session.idle)", s.RunningRoots())
	}

	// COMPLETION-AUTHORITY GUARD (permanent protection): once the grace fired,
	// the turn is authoritatively over and a STALE busy from /session/status
	// must NOT re-strand the root. This is the case the grace window ALONE
	// cannot cover: a stale busy status arriving after the grace clear would
	// re-arm busyCount["R"] without the guard.
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		"R": json.RawMessage(`{"id":"R","type":"busy"}`),
	})
	if got, want := s.RunningRoots(), 0; got != want {
		t.Errorf("after stale SetActivityFromStatuses(busy) post-completion: RunningRoots()=%d, want %d "+
			"(completion-authority guard must refuse to re-strand a completed turn)", got, want)
	}

	// A NEW turn must be respected: a fresh in-flight assistant message clears
	// the completion-authority guard and re-arms busy. This proves the guard is
	// scoped to the completed turn, not a permanent busy-lock that would hide a
	// genuinely-running session.
	s.Apply(ev("message.updated", evAssistantInflight("R", "m2")))
	if got := s.RunningRoots(); got != 1 {
		t.Fatalf("after new inflight assistant message (new turn): RunningRoots()=%d, want 1 "+
			"(authority cleared, busy re-armed for the new turn)", got)
	}

	// And the new turn's completion clears via grace again (guard re-arms),
	// proving the grace/authority cycle is repeatable across turns.
	s.Apply(ev("message.updated", evAssistantCompleted("R", "m2")))
	if !waitForRunningRoots(s, 0, time.Second) {
		t.Errorf("after second completion-grace fired: RunningRoots()=%d, want 0 "+
			"(new turn's grace should clear again)", s.RunningRoots())
	}

	// Idle backstop still works post-fix: an explicit idle status is a no-op
	// (already idle from grace) but must not corrupt state.
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		"R": json.RawMessage(`{"id":"R","type":"idle"}`),
	})
	if got, want := s.RunningRoots(), 0; got != want {
		t.Errorf("after SetActivityFromStatuses(idle): RunningRoots()=%d, want %d (idle backstop must remain consistent)", got, want)
	}
}

// waitForRunningRoots polls s.RunningRoots() until it matches want or the
// deadline elapses. Used to observe the async completion-grace timer fire
// without a fixed sleep. Returns true on match, false on timeout.
func waitForRunningRoots(s *Store, want int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if s.RunningRoots() == want {
			return true
		}
		time.Sleep(time.Millisecond)
	}
	return s.RunningRoots() == want
}
