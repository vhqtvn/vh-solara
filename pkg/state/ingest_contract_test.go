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
// like session.idle. Pre-F4, the #2696 guard in upsertMessageLocked keyed on
// liveIdleObserved, which session.idle armed but session.error did NOT, so the
// guard covered ONE of TWO OBSERVED terminals: a post-session.error MUTABLE
// assistant message re-opened the turn (re-escalated activity to busy) — the
// exact #2696 trap (OpenCode stamps its fs-snapshot diff onto a message AFTER
// the turn ended).
//
// This test was RED pre-fold (the guard was absent on the session.error path:
// the late inflight after session.error re-escalated to ActivityBusy). The F4
// fold arms liveIdleObserved on session.error too — extending OBSERVED-terminal
// coverage from {session.idle} to {session.idle, session.error} — and turned
// this GREEN. (graceFire stays OUT of the guard by design: it is an INFERRED
// terminal, and the principle is "never BLOCK a turn on an inference." F4
// extends OBSERVED coverage only.)
//
// Sibling: TestP7_PostIdleMutableMessageDoesNotReopenTurn (turn_state_test.go)
// is the session.idle analog (the guard already existed there). This test is
// its session.error twin — GREEN now that the fold arms both OBSERVED
// terminals.
func TestP7Fold_PostErrorMutableMessageDoesNotReopenTurn(t *testing.T) {
	s := New(100)
	defer s.Close()
	s.Apply(ev("session.created", evSessionCreated("R", "")))

	// A turn is running (authoritative status → markTurnRunningLocked clears
	// liveIdleObserved, as it must for any new turn).
	s.Apply(ev("session.status", evStatus("R", "busy")))
	assertTurn(t, s, "R", TurnRunning, "turn running (authoritative busy)")

	// The turn ends in ERROR. session.error is a TERMINAL (settleTerminalLocked),
	// so TurnRunning → TurnIdle. Post-fold it ALSO arms liveIdleObserved (both
	// OBSERVED terminals — session.idle AND session.error — arm it now).
	s.Apply(ev("session.error", `{"sessionID":"R","status":{"type":"error"}}`))
	assertTurn(t, s, "R", TurnIdle, "session.error is a terminal → TurnIdle")

	// A MUTABLE assistant message arrives AFTER the terminal — the #2696 trap.
	// The guard MUST refuse to re-open the turn, exactly as it does after
	// session.idle: session.error arms liveIdleObserved too (post-fold), so the
	// late inflight must NOT re-escalate to ActivityBusy.
	s.Apply(ev("message.updated", evAssistantInflight("R", "m_late")))

	if got := s.Snapshot(nil).Activity["R"]; got == ActivityBusy {
		t.Errorf("F4 regression: late inflight after session.error re-escalated activity to %q — "+
			"the #2696 guard covers BOTH OBSERVED terminals (session.idle AND "+
			"session.error) via liveIdleObserved, so a post-session.error "+
			"mutable message must NOT re-open the turn", got)
	}
	assertTurn(t, s, "R", TurnIdle,
		"F4 regression: late inflight after session.error must not re-open the turn")
}
