package state

// ingest_contract_test.go — slice #3 (the contract/translator rewire) test home.
//
// Slice #3 rewires reducers.go's inbound event ingestion onto a NORMALIZED
// AgentStreamEvent behind a single versioned translation interface (paseo's
// model, adapted to Go — AGPL: adapt the design, never copy code). F4 (the
// session.error #2696-guard gap) is FOLDED IN because it lives in the same
// reducers.go event path this slice rewires — folding avoids a second pass over
// that path where a half-migrated event shape would hide.
//
// DISCIPLINE (operator-named, load-bearing): RED-first on the ingestion
// invariants BEFORE the rewire, not after. A rewire that lands green with no
// pre-existing failing test proves only that the tests do NOT cover the
// ingestion contract. This file holds the F4 fold's genuinely-RED-today test
// (the gap the fold closes) and will hold the translator-invariant net tests in
// Phase 2. The session.idle #2696 guard, the observed-vs-inferred terminal
// distinction, and the field mappings are already pinned green by the existing
// P7 / grace / message suites (see the Phase 1 report's invariant→test map) —
// those form the net the rewire must keep green; this file adds the ONE new gap.

import "testing"

// TestP7Fold_PostErrorMutableMessageDoesNotReopenTurn pins the F4 gap folded
// into slice #3.
//
// session.error is a turn TERMINAL — it routes to settleTerminalLocked exactly
// like session.idle (reducers.go:432-436). But the #2696 guard in
// upsertMessageLocked (reducers.go:927) keys on liveIdleObserved, which
// session.idle arms (reducers.go:426) and session.error does NOT. So the guard
// covers ONE of TWO OBSERVED terminals today: a post-session.error MUTABLE
// assistant message re-opens the turn (re-escalates activity to busy) — the
// exact #2696 trap (OpenCode stamps its fs-snapshot diff onto a message AFTER
// the turn ended).
//
// This test is RED TODAY because the guard is absent on the session.error path:
// the late inflight after session.error re-escalates to ActivityBusy. Phase 2
// (the rewire + F4 fold) arms liveIdleObserved on session.error too — extending
// OBSERVED-terminal coverage from {session.idle} to {session.idle,
// session.error} — and turns this green. (graceFire stays OUT of the guard by
// design: it is an INFERRED terminal, and the principle is "never BLOCK a turn
// on an inference." F4 extends OBSERVED coverage only.)
//
// Sibling: TestP7_PostIdleMutableMessageDoesNotReopenTurn (turn_state_test.go)
// is the session.idle analog — GREEN today (the guard exists there). This test
// is its session.error twin, RED today (the gap).
func TestP7Fold_PostErrorMutableMessageDoesNotReopenTurn(t *testing.T) {
	s := New(100)
	defer s.Close()
	s.Apply(ev("session.created", evSessionCreated("R", "")))

	// A turn is running (authoritative status → markTurnRunningLocked clears
	// liveIdleObserved, as it must for any new turn).
	s.Apply(ev("session.status", evStatus("R", "busy")))
	assertTurn(t, s, "R", TurnRunning, "turn running (authoritative busy)")

	// The turn ends in ERROR. session.error is a TERMINAL (settleTerminalLocked),
	// so TurnRunning → TurnIdle. But — the gap — it does NOT arm liveIdleObserved
	// (only session.idle does today).
	s.Apply(ev("session.error", `{"sessionID":"R","status":{"type":"error"}}`))
	assertTurn(t, s, "R", TurnIdle, "session.error is a terminal → TurnIdle")

	// A MUTABLE assistant message arrives AFTER the terminal — the #2696 trap.
	// The guard MUST refuse to re-open the turn, exactly as it does after
	// session.idle. Today it does NOT (liveIdleObserved is false after
	// session.error), so the late inflight re-escalates to ActivityBusy.
	s.Apply(ev("message.updated", evAssistantInflight("R", "m_late")))

	if got := s.Snapshot(nil).Activity["R"]; got == ActivityBusy {
		t.Errorf("F4 gap: late inflight after session.error re-escalated activity to %q — "+
			"the #2696 guard must cover session.error terminals too (it covers "+
			"session.idle today via liveIdleObserved, but NOT session.error)", got)
	}
	assertTurn(t, s, "R", TurnIdle,
		"F4 gap: late inflight after session.error must not re-open the turn")
}
