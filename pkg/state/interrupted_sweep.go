// Package state: the P1-API-007 interrupted-turn sweep. A UI-triggered
// OpenCode restart (or an opencode crash, machine reboot, or vh-solara daemon
// restart) kills the process mid-turn; OpenCode never marks the interrupted
// assistant message terminal (its ~1.18.x orphan sweeps are prompt-gated), so
// the row is re-served uncompleted on every fetch forever. Before this sweep
// NOTHING wrote a terminal marker on the message entry: the FE's only closure
// was the client-side stampCompletionIfIdle, so cold loads re-served the
// truncation silently and the turn looked live-forever in gate facts.
//
// LAYERING: the pkg/web pre-restart abort (pkg/web/opencode.go
// abortInflightBeforeRestart) is the preferred half — a successful Abort lets
// OpenCode itself write the REAL terminal (MessageAbortedError) into ITS DB,
// the only writer that can close the upstream row. This sweep is the healing
// half that does not depend on the abort landing: it synthesizes OUR OWN
// terminal marker in the aggregated view (never in opencode's DB).
//
// AUTHORITY (the hard edge): the sweep fires ONLY on the
// SetActivityFromStatuses clear path — i.e. after a SUCCESSFUL
// /session/status fetch reported the session absent-or-not-busy on a live
// instance. A FAILED statuses fetch (dead opencode, network blip) never
// reaches SetActivityFromStatuses, so it cannot mark a still-running turn
// interrupted. Pin: TestSweepAggregatorAuthoritativeOnlyFailedStatusFetch.
//
// STABILITY (d-F1 two-observation gate): a single not-busy snapshot cannot
// distinguish a genuinely-dead run from the fetch→apply race — statuses
// fetched at T (session not yet busy), the turn starting and its first
// assistant mutation applied before SetActivityFromStatuses acquires s.mu.
// The clear path therefore fires the sweep only on the SECOND consecutive
// not-busy observation (the notBusyOnce latch), and ANY busy-class signal
// (a busy statuses observation, the live busy escalation a just-started turn
// performs, a session.status busy event) resets the run. A just-started live
// turn escalates activity to busy BEFORE the stale snapshot's clear path
// runs, so its latch is cleared and the stale not-busy cannot mark it; the
// next truthful observation reports busy and keeps it cleared. Pins:
// TestSweepTOCTOUTurnStartAfterFetchNotMarked, TestSweepLatchResetsOnBusy.
// Accepted cost: orphan heal lands on the SECOND consecutive not-busy
// observation after the kill (the next 60s reconcile tick, or the next
// reconnect-hydrate/reload — whichever comes first).
package state

import (
	"encoding/json"
	"time"
)

// InterruptedTurnErrorName is the terminal-error name the sweep synthesizes on
// an orphaned assistant message. It is DELIBERATELY distinct from every
// upstream name (e.g. MessageAbortedError, which only OpenCode writes): a
// reader can tell "vh-solara inferred this turn was interrupted" from
// "OpenCode positively aborted it". Surfaced through info.error.name, so the
// FE renders it via the EXISTING messageError → .msg-error affordance (no FE
// change needed), and time.completed renders the turn settled (no stream
// caret) — the exact affordances an aborted turn already gets.
const InterruptedTurnErrorName = "VHSolaraInterruptedError"

// interruptedTurnUserMessage is info.error.data.message for the synthesized
// marker — the user-facing string the FE shows (messageError prefers
// data.message over name). Deliberately cause-agnostic: by mark time the
// sweep cannot distinguish restart-kill from crash/reboot/daemon-restart.
const interruptedTurnUserMessage = "Turn was interrupted before completing (e.g. OpenCode restart)"

// sweepInterruptedTurnsLocked is the P1-API-007 orphan sweep body, called ONLY
// from SetActivityFromStatuses' clearActivity closure (the authoritative
// not-busy branch). If sessionID's newest inflight assistant message is still
// uncompleted, the run that owned it is over and will never terminalize —
// synthesize the terminal marker. Caller holds s.mu.
//
// Predicate reuse: inflightAssistantIDLocked is the card's orphan predicate
// (newest assistant with !completed). An empty result (no uncompleted
// assistant) is the common idle case — the sweep is a cheap no-op, so running
// it under every clear-path iteration of every reconcile is fine.
//
// Guards respected:
//   - TurnStopping: the clear path settles the stop BEFORE calling here, so a
//     settling abort lands here as TurnIdle. A defensive early-return keeps a
//     future caller from marking mid-drain.
//   - TurnRunning (defensive only): on the clear path a running turn-state
//     with an uncompleted newest assistant + an authoritative not-busy report
//     IS the orphan shape (the run is over upstream), so running is NOT an
//     early-return; the statuses snapshot outranks the stale state machine.
//   - d-F2 real-terminal: an uncompleted entry already carrying a REAL
//     upstream terminalError is NEVER relabeled — it takes the settle arm
//     (completed stamped alongside the preserved error).
//   - #2696-class stickiness: the synthesized flag blocks a later uncompleted
//     message.updated / warm-reconcile diff from resurrecting the turn (see
//     upsertMessageLocked / reconcileMessagesLocked). A REAL terminal
//     (upstream completed or upstream error) supersedes and clears the marker.
//   - Idempotence: a marked message is completed, so the predicate no longer
//     selects it; re-deriving on every hydrate is a no-op.
func (s *Store) sweepInterruptedTurnsLocked(sessionID string) {
	if s.turnState[sessionID] == TurnStopping {
		// Defensive: an unsettled stop is mid-drain; the clear path settles
		// it first, so this is unreachable from production callers today.
		return
	}
	mid := s.inflightAssistantIDLocked(sessionID)
	if mid == "" {
		return
	}
	sm := s.messages[sessionID]
	if sm == nil {
		return
	}
	me := sm.byID[mid]
	if me == nil || me.completed {
		return
	}
	// d-F2 real-terminal guard: an entry already carrying a REAL upstream
	// terminal error (an error-without-time.completed body — e.g. layer (a)'s
	// own MessageAbortedError written because our pre-restart abort landed)
	// is positively classified by OpenCode. NEVER relabel it with our
	// inference: settle it instead (completed stamped alongside the PRESERVED
	// real error), so the presentation matches the canonical aborted shape
	// (see settleRealErrorTerminalLocked). synthesizedTerminal can never
	// co-exist with completed=false (the marker sets completed), so a non-
	// empty terminalError here is upstream truth by construction; the flag
	// check is defensive.
	if me.terminalError != "" && !me.synthesizedTerminal {
		s.settleRealErrorTerminalLocked(sessionID, me, time.Now())
		return
	}
	s.markInterruptedLocked(sessionID, me, time.Now())
}

// markInterruptedLocked stamps the synthesized terminal on me: cached fields
// (completed, terminalError, synthesizedTerminal, synthTerminalMs), the merged
// info JSON (time.completed + info.error), the denormalized gate-facts
// recomputes an assistant completion performs, and a KindMessageUpsert emit so
// connected clients re-render the row through the normal message channel.
// Caller holds s.mu. Idempotent per (message, marker): the merged bytes are
// derived from the entry's CURRENT info, so re-marking after a non-terminal
// body change re-merges; the sweep itself never re-selects a marked entry.
//
// bc-F1: this is a me.info mutation site, so it bumps the per-session message
// revision (mirroring upsertMessageLocked, reducers.go) per the Store-wide
// nextMsgRev ABA contract — a cold messages.batch projection captured just
// before the sweep and packaged outside s.mu must be discarded by
// publishColdBatch's revision validation rather than transiently clobbering
// the marked row client-side. Pin: TestColdBatchHookSweepMarkDiscardsStaleBatch.
func (s *Store) markInterruptedLocked(sessionID string, me *messageEntry, now time.Time) {
	ms := float64(now.UnixMilli())
	me.completed = true
	me.terminalError = InterruptedTurnErrorName
	me.synthesizedTerminal = true
	me.synthTerminalMs = ms
	merged := mergeInterruptedMarkerInfo(me.info, ms)
	if len(merged) > 0 {
		me.info = merged
	}
	s.bumpMsgRev(sessionID)
	s.recomputeLastAssistantLocked(sessionID)
	// A completing turn's running tools finalize: re-evaluate the facet so a
	// half-finished tool call stops presenting as the current activity
	// (mirrors the assistant-completion arm of upsertMessageLocked).
	s.recomputeCurrentVerbLocked(sessionID)
	s.emit(KindMessageUpsert, me.info)
}

// settleRealErrorTerminalLocked is the d-F2 settle arm: the selected uncompleted
// entry already carries a REAL upstream terminal error, so the sweep must NOT
// relabel it — it stamps ONLY the missing settled presentation, converging the
// row on opencode's canonical aborted shape (completed + preserved error, cf.
// the confirmed live MessageAbortedError payload recorded at isTerminalError:
// completed, error.name, zero output). The real error name survives in both the
// cached terminalError field and the merged info.error block; NO synthesized
// provenance is recorded (upstream, not this daemon, classified the turn). The
// stamp is sticky without any new flag: both re-serve paths
// (upsertMessageLocked / reconcileMessagesLocked terminal-stickiness arms)
// keep an already-completed entry completed when the fetched body still
// carries its error. Caller holds s.mu; idempotent (the completed entry is
// never re-selected).
func (s *Store) settleRealErrorTerminalLocked(sessionID string, me *messageEntry, now time.Time) {
	ms := float64(now.UnixMilli())
	me.completed = true
	if merged := mergeInterruptedMarkerInfo(me.info, ms); len(merged) > 0 {
		me.info = merged
	}
	s.bumpMsgRev(sessionID) // bc-F1: me.info mutation site — same ABA contract
	s.recomputeLastAssistantLocked(sessionID)
	s.recomputeCurrentVerbLocked(sessionID)
	s.emit(KindMessageUpsert, me.info)
}

// mergeInterruptedMarkerInfo merges the synthesized terminal into a message
// info body: time.completed = ms (synthesized). ERROR PRECEDENCE (d-F2): a
// base that already carries an error block (a REAL upstream terminal error)
// KEEPS it — the synthetic VHSolaraInterruptedError is written only into a
// body that lacks one, so a real error is never relabeled by construction
// (the sweep's real-terminal guard routes error-bearing rows to the settle
// arm, which relies on this preservation). Any pre-existing time.completed in
// base is OVERWRITTEN — callers only merge into bodies that lack a real
// terminal. Returns nil on an unparseable base (caller keeps the original
// bytes; the cached fields still carry the marker).
// Byte-stable for a fixed (base, ms): map marshaling sorts keys, so re-merging
// the same base with the stored ms reproduces the same bytes (no spurious
// diff-emits on repeated reconciles).
func mergeInterruptedMarkerInfo(base []byte, ms float64) []byte {
	var m map[string]any
	if err := json.Unmarshal(base, &m); err != nil {
		return nil
	}
	if m == nil {
		m = map[string]any{}
	}
	t, _ := m["time"].(map[string]any)
	if t == nil {
		t = map[string]any{}
	}
	t["completed"] = ms
	m["time"] = t
	// Precedence note: data.message is what the FE renders (messageError
	// prefers it over name), so the human-readable cause lives in data. A
	// base error block (REAL upstream error) is preserved verbatim; only an
	// error-less body gets the synthetic marker.
	if existing, ok := m["error"].(map[string]any); !ok || existing == nil {
		m["error"] = map[string]any{
			"name": InterruptedTurnErrorName,
			"data": map[string]any{"message": interruptedTurnUserMessage},
		}
	}
	out, err := json.Marshal(m)
	if err != nil {
		return nil
	}
	return out
}
