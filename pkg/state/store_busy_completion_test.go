package state

import (
	"encoding/json"
	"testing"
)

// TestBusyCompletionStrand_NoSessionIdle_StrandsRunningRoots reproduces the
// "stranded busy" strand: an in-flight assistant message arms busyCount["R"];
// the assistant turn COMPLETES (message.updated with time.completed) but, per
// the reducer contract, that completion does NOT clear busy — only session.idle
// (or a status reconcile) does. OpenCode emits session.idle only when it gets
// around to it, so between completion and session.idle (or if session.idle is
// dropped on a flaky transport) RunningRoots() reports a phantom "running" root.
// This is the window the 60s /session/status reconcile backstops; this test
// pins BOTH sides of that window:
//   - after completion, before any idle: RunningRoots()==1  (RED — the strand)
//   - after SetActivityFromStatuses(idle): RunningRoots()==0 (backstop works)
//
// Fixture-INDEPENDENT: drives s.Apply directly, never imports pkg/fixtures, and
// never emits session.idle — exactly the gap the reconcile exists to close.
func TestBusyCompletionStrand_NoSessionIdle_StrandsRunningRoots(t *testing.T) {
	s := New(100)

	// Root session "R".
	s.Apply(ev("session.created", evSessionCreated("R", "")))

	// In-flight assistant message → busy armed via the message-stream busy
	// escalation site (upsertMessageLocked → setActivityLocked → busyCount["R"]++).
	s.Apply(ev("message.updated", evAssistantInflight("R", "m1")))

	// Sanity: busy correctly armed → one running root.
	if got := s.RunningRoots(); got != 1 {
		t.Fatalf("after inflight assistant message: RunningRoots()=%d, want 1 (busy armed)", got)
	}

	// Assistant turn COMPLETES (time.completed set). The reducer currently does
	// NOT clear busy here — only session.idle owns that transition. So
	// busyCount["R"] stays at 1 and RunningRoots() is STRANDED at 1 even though
	// the turn is finished. This is the gap the ~60s /session/status reconcile
	// exists to backstop.
	s.Apply(ev("message.updated", evAssistantCompleted("R", "m1")))

	// THE BUG (RED): a completed assistant turn with NO session.idle should NOT
	// strand the root in "running" state — the turn is finished, so the desired
	// behavior is RunningRoots()==0. Current HEAD leaves busyCount["R"] at 1
	// (completion does not clear busy), so this assertion FAILS. t.Errorf (not
	// Fatalf) so the backstop below still runs and is reported in the same run.
	if got, want := s.RunningRoots(), 0; got != want {
		t.Errorf("after completed assistant message (NO session.idle): RunningRoots()=%d, want %d "+
			"(the strand — busy not cleared by completion; stranded busyCount[\"R\"]==1)", got, want)
	}

	// Backstop: the ~60s /session/status reconcile observes "R" is idle and
	// reconciles activity, clearing the stranded busyCount entry. This PASSES —
	// it proves the reconcile closes the strand, and isolates the failure above
	// to the completion-doesn't-clear-busy gap rather than a deeper corruption.
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		"R": json.RawMessage(`{"id":"R","type":"idle"}`),
	})
	if got, want := s.RunningRoots(), 0; got != want {
		t.Errorf("after SetActivityFromStatuses(idle): RunningRoots()=%d, want %d (backstop should clear strand)", got, want)
	}
}
