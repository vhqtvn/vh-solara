package state

// tree_finish_cascade_test.go — RED→GREEN tests for the finish-side transition
// gap (the symmetric counterpart to tree_frontier_promotion_test.go).
//
// Symptom: a subsession that has finished (reached a terminal state — archived
// or deleted while still observably busy) is still displayed as "running" in
// the chat activity view. The chat-side Part.tsx reads syncState.activity[id]
// straight from server-precomputed state; the server-side activity map is the
// authority.
//
// Root cause hypothesis: deleteSessionLocked (the archive/prune path — the
// "finish cascade" referenced by pkg/state/store.go:1983 Descendants) deletes
// s.activity[id] silently and emits only KindSessionDelete. It does NOT emit a
// terminal KindActivity event, so a client that held a stale activity="busy"
// for the id (from the last busy event / snapshot seed) is never told the id
// transitioned out of busy. The TreeRow is pruned by node.remove (so no stale
// activity chip there), but the chat activity map (syncState.activity[id],
// read by Part.tsx for the parent's task tool) retains the stale "busy" until
// a full reload.
//
// The symmetric precedent: tree_frontier_promotion_test.go fixed the
// APPEAR-side gap (new active subsession doesn't appear until F5). This file
// pins the FINISH-side gap: a busy subsession being deleted must cascade a
// terminal activity clear so every observer (tree + chat) drops the busy
// signal in the same transition.

import (
	"encoding/json"
	"fmt"
	"testing"
)

// --- helpers ---

// (drainAll is shared from subscribe_interest_test.go.)

// ---------------------------------------------------------------------------
// PRIMARY symptom — a BUSY subsession deleted/archived must cascade a terminal
// KindActivity so the chat activity map clears.
// ---------------------------------------------------------------------------

// TestFinishCascade_BusySubsessionDeletedEmitsTerminalActivity asserts that
// when a BUSY non-root session is removed (the canonical "sub-session finishes
// and gets archived" path — RemoveSessions/deleteSessionLocked), the store
// emits a terminal KindActivity carrying state=idle for that id BEFORE the
// KindSessionDelete. Without this, a client that held activity[id]="busy"
// (from the snapshot seed or the last busy event) is never told the id is no
// longer busy: node.remove prunes the TreeRow, but the chat-side
// syncState.activity[id] (read by Part.tsx for the parent's task tool status)
// retains the stale "busy" indefinitely — the subsession looks "running" in
// the Part activity timeline even though it's gone from the tree.
//
// This is the finish-side mirror of the frontier-promotion gap
// (TestFrontierPromotion_ActiveChildShipsLive): there, a node becoming active
// while unknown needed a live promote; here, a node becoming GONE while busy
// needs a live terminal-activity cascade.
func TestFinishCascade_BusySubsessionDeletedEmitsTerminalActivity(t *testing.T) {
	s := New(100)
	// Root R with a busy child C (a subagent in flight).
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("C", "R")},
		[2]string{"session.status", evStatus("C", "busy")},
	)
	// Sanity: C is observably busy in the store.
	s.mu.RLock()
	cAct := s.activity["C"]
	s.mu.RUnlock()
	if cAct != ActivityBusy {
		t.Fatalf("setup invariant: s.activity[C]=%q, want %q", cAct, ActivityBusy)
	}

	ch, unsub := s.Subscribe(256)
	defer unsub()
	// Drain the subscription buffer (setup emits still queued).
	drainAll(ch)

	// The load-bearing moment: archive/remove the BUSY child.
	s.RemoveSessions([]string{"C"})

	// Assert a terminal KindActivity(idle) for C was emitted. This is the
	// event the chat stream uses to clear syncState.activity["C"].
	all := drainAll(ch)
	var acts, dels []ClientEvent
	for _, ev := range all {
		switch ev.Kind {
		case KindActivity:
			acts = append(acts, ev)
		case KindSessionDelete:
			dels = append(dels, ev)
		}
	}

	// Must have emitted exactly one terminal activity for C carrying idle.
	var terminal *struct {
		SessionID string `json:"sessionID"`
		State     string `json:"state"`
	}
	for i := range acts {
		var p struct {
			SessionID string `json:"sessionID"`
			State     string `json:"state"`
		}
		if json.Unmarshal(acts[i].Payload, &p) != nil {
			continue
		}
		if p.SessionID == "C" {
			if terminal != nil {
				t.Fatalf("expected exactly one terminal KindActivity for C; got multiple: %v", acts)
			}
			terminal = &p
		}
	}
	if terminal == nil {
		t.Fatalf("FINISH CASCADE: busy C deleted but no terminal KindActivity emitted; "+
			"acts=%v deletes=%d (chat syncState.activity[C] stays stale \"busy\")", acts, len(dels))
	}
	if terminal.State != ActivityIdle {
		t.Errorf("FINISH CASCADE: terminal KindActivity state=%q, want %q (idle)", terminal.State, ActivityIdle)
	}

	// The delete must still fire (the session IS gone).
	if len(dels) == 0 {
		t.Errorf("FINISH CASCADE: KindSessionDelete for C must still emit (node pruned from tree)")
	}

	// And the activity map must be clean (no stale busy entry left on the id).
	s.mu.RLock()
	postAct, postExists := s.activity["C"]
	s.mu.RUnlock()
	if postExists && postAct == ActivityBusy {
		t.Errorf("FINISH CASCADE: s.activity[C]=%q still busy after delete (stale)", postAct)
	}
}

// ---------------------------------------------------------------------------
// ORDERING — the terminal activity must precede the KindSessionDelete so a
// client applying events in seq order clears the chat activity map before the
// node is pruned (otherwise the Part.tsx reader can observe an orphan busy).
// ---------------------------------------------------------------------------

// TestFinishCascade_TerminalActivityBeforeDelete asserts the seq ordering: a
// client processing events in order must see KindActivity(idle) BEFORE
// KindSessionDelete, so the chat activity map is cleared while the id is still
// "known". (Mirrors the cross-stream completion bridge rationale in
// stream.ts:734 — the activity clear and the structural removal should land in
// the right order.)
func TestFinishCascade_TerminalActivityBeforeDelete(t *testing.T) {
	s := New(100)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("C", "R")},
		[2]string{"session.status", evStatus("C", "busy")},
	)

	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainAll(ch)

	s.RemoveSessions([]string{"C"})

	// Collect every event in seq order, find the indexes of the terminal
	// activity and the delete.
	all := drainAll(ch)
	var actSeq, delSeq uint64
	var actFound, delFound bool
	for _, ev := range all {
		if ev.Kind == KindActivity {
			var p struct {
				SessionID string `json:"sessionID"`
			}
			if json.Unmarshal(ev.Payload, &p) == nil && p.SessionID == "C" {
				actSeq = ev.Seq
				actFound = true
			}
		}
		if ev.Kind == KindSessionDelete {
			var p struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(ev.Payload, &p) == nil && p.ID == "C" {
				delSeq = ev.Seq
				delFound = true
			}
		}
	}
	if !actFound {
		t.Fatalf("ORDER: no terminal KindActivity for C; events=%v", all)
	}
	if !delFound {
		t.Fatalf("ORDER: no KindSessionDelete for C; events=%v", all)
	}
	if actSeq >= delSeq {
		t.Errorf("ORDER: terminal KindActivity seq=%d must precede KindSessionDelete seq=%d", actSeq, delSeq)
	}
}

// ---------------------------------------------------------------------------
// ERROR-PATH mirror — an ERROR subsession deleted/archived must cascade the
// same terminal KindActivity(idle). isActiveLocked (tree_emitter.go:201-213)
// treats ActivityError as active (a client that held activity[id]="error" has
// an observable active signal), but the finish-cascade guard above only covers
// {Busy, Retry} — so deleting an errored subsession left the chat-side
// syncState.activity[id]="error" stale on a session that no longer exists
// (cosmetic: error is terminal so isActivityWorking("error") is false → no
// spinner/heat, but the red dot persists on the parent's task row). This is
// the symmetric gap left by the Busy/Retry fix.
//
// SUBTLETY: error never contributed to busyCount (setActivityAtLocked's
// wasBusy/isBusy chokepoint only flags Busy/Retry), so the error branch MUST
// NOT touch busyCount — it emits ONLY the terminal idle. A widening of the
// outer `if` to `|| a == ActivityError` would wrongly decrement
// busyCount[root] for a session that never incremented it.
// ---------------------------------------------------------------------------

// evError is the session.error event payload (parallel to evIdle). Routes
// through store.go:1662-1663 → setActivityLocked(sid, ActivityError). NOT
// evStatus(id,"error"): normalizeActivity maps unknown status types to Idle,
// so only the dedicated session.error event type seeds ActivityError.
func evError(id string) string {
	return fmt.Sprintf(`{"sessionID":%q}`, id)
}

// TestFinishCascade_ErrorSubsessionDeletedEmitsTerminalActivity asserts that
// when an ERROR non-root session is removed (an operator archives an errored
// subsession while its parent is live — the canonical G1 DEFER repro), the
// store emits a terminal KindActivity carrying state=idle for that id BEFORE
// KindSessionDelete. Without this, a client that held activity[id]="error"
// (snapshot seed or last error event) is never told the id transitioned out
// of error: node.remove prunes the TreeRow, but the chat-side
// syncState.activity[id] (read by Part.tsx for the parent's task tool status)
// retains the stale "error" indefinitely — the red dot persists on the
// parent's task row for a session that no longer exists.
func TestFinishCascade_ErrorSubsessionDeletedEmitsTerminalActivity(t *testing.T) {
	s := New(100)
	// Root R with an errored child C (a subagent that errored out).
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("C", "R")},
		[2]string{"session.error", evError("C")},
	)
	// Sanity: C is observably error in the store.
	s.mu.RLock()
	cAct := s.activity["C"]
	s.mu.RUnlock()
	if cAct != ActivityError {
		t.Fatalf("setup invariant: s.activity[C]=%q, want %q", cAct, ActivityError)
	}

	ch, unsub := s.Subscribe(256)
	defer unsub()
	// Drain the subscription buffer (setup emits still queued).
	drainAll(ch)

	// The load-bearing moment: archive/remove the ERROR child.
	s.RemoveSessions([]string{"C"})

	// Assert a terminal KindActivity(idle) for C was emitted. This is the
	// event the chat stream uses to clear syncState.activity["C"].
	all := drainAll(ch)
	var acts, dels []ClientEvent
	for _, ev := range all {
		switch ev.Kind {
		case KindActivity:
			acts = append(acts, ev)
		case KindSessionDelete:
			dels = append(dels, ev)
		}
	}

	// Must have emitted exactly one terminal activity for C carrying idle.
	var terminal *struct {
		SessionID string `json:"sessionID"`
		State     string `json:"state"`
	}
	for i := range acts {
		var p struct {
			SessionID string `json:"sessionID"`
			State     string `json:"state"`
		}
		if json.Unmarshal(acts[i].Payload, &p) != nil {
			continue
		}
		if p.SessionID == "C" {
			if terminal != nil {
				t.Fatalf("expected exactly one terminal KindActivity for C; got multiple: %v", acts)
			}
			terminal = &p
		}
	}
	if terminal == nil {
		t.Fatalf("FINISH CASCADE (error): error C deleted but no terminal KindActivity emitted; "+
			"acts=%v deletes=%d (chat syncState.activity[C] stays stale \"error\")", acts, len(dels))
	}
	if terminal.State != ActivityIdle {
		t.Errorf("FINISH CASCADE (error): terminal KindActivity state=%q, want %q (idle)", terminal.State, ActivityIdle)
	}

	// The delete must still fire (the session IS gone).
	if len(dels) == 0 {
		t.Errorf("FINISH CASCADE (error): KindSessionDelete for C must still emit (node pruned from tree)")
	}

	// And the activity map must be clean (no stale error entry left on the id).
	s.mu.RLock()
	postAct, postExists := s.activity["C"]
	s.mu.RUnlock()
	if postExists && postAct == ActivityError {
		t.Errorf("FINISH CASCADE (error): s.activity[C]=%q still error after delete (stale)", postAct)
	}
}

// TestFinishCascade_ErrorTerminalActivityBeforeDelete asserts the seq ordering
// for the error path: a client processing events in order must see
// KindActivity(idle) BEFORE KindSessionDelete, so the chat activity map is
// cleared while the id is still "known" (mirror of the busy-path ordering
// test above). The error branch must preserve the same seq-ordering guarantee
// the busy/retry branch does.
func TestFinishCascade_ErrorTerminalActivityBeforeDelete(t *testing.T) {
	s := New(100)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("C", "R")},
		[2]string{"session.error", evError("C")},
	)

	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainAll(ch)

	s.RemoveSessions([]string{"C"})

	// Collect every event in seq order, find the indexes of the terminal
	// activity and the delete.
	all := drainAll(ch)
	var actSeq, delSeq uint64
	var actFound, delFound bool
	for _, ev := range all {
		if ev.Kind == KindActivity {
			var p struct {
				SessionID string `json:"sessionID"`
			}
			if json.Unmarshal(ev.Payload, &p) == nil && p.SessionID == "C" {
				actSeq = ev.Seq
				actFound = true
			}
		}
		if ev.Kind == KindSessionDelete {
			var p struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(ev.Payload, &p) == nil && p.ID == "C" {
				delSeq = ev.Seq
				delFound = true
			}
		}
	}
	if !actFound {
		t.Fatalf("ORDER (error): no terminal KindActivity for C; events=%v", all)
	}
	if !delFound {
		t.Fatalf("ORDER (error): no KindSessionDelete for C; events=%v", all)
	}
	if actSeq >= delSeq {
		t.Errorf("ORDER (error): terminal KindActivity seq=%d must precede KindSessionDelete seq=%d", actSeq, delSeq)
	}
}
