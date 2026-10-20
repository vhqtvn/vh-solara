package state

import (
	"encoding/json"
	"reflect"
	"testing"
)

// TestStatusReconcileSuppressesUnreadOnlyForItsTransitions is the M9/L-16
// standing-check. It pins the explicit per-transition unread policy that
// replaced the retired ambient Store.suppressUnread flag at the
// setActivityAtLocked busy↔non-busy chokepoint:
//
//   - an ORDINARY busy→idle completion (MarkIdle/abort, Apply idle|error|status,
//     message & part-delta escalation, graceFire — all markOnIdle=true) MARKS
//     the root finished-unread (KindUnreadSet emitted, snapshot Unread advanced);
//   - a STATUS-RECONCILE busy→idle transition (SetActivityFromStatuses, the
//     /session/status snapshot reconcile on (re)hydrate — markOnIdle=false) does
//     NOT mark the root unread (no event, no snapshot advance);
//   - the running-again (idle→busy) clearUnreadLocked fires UNCONDITIONALLY,
//     regardless of markOnIdle.
//
// It also asserts the ambient Store.suppressUnread field no longer exists
// (structural reflection check) — the load-bearing architectural change of M9.
//
// Scope fences honored: root-scoped reach (rootOfLocked → root) is unchanged
// (L-13 by-design); subtreeBusyCount count maintenance stays unconditional;
// clearUnreadLocked stays unconditional.
func TestStatusReconcileSuppressesUnreadOnlyForItsTransitions(t *testing.T) {
	// Structural assertion: the ambient flag is gone. If this fails, the M9/L-16
	// hardening regressed — the per-transition markOnIdle policy must be the
	// ONLY unread-context mechanism. (Any live code reference would also fail to
	// compile, so this is a belt-and-suspenders declaration.)
	if _, ok := reflect.TypeOf(Store{}).FieldByName("suppressUnread"); ok {
		t.Fatal("Store.suppressUnread must not exist: the ambient flag was replaced by the explicit per-transition markOnIdle policy (M9/L-16)")
	}

	// ordinary_busy_to_idle_marks_root_unread: a real completion (site in the
	// markOnIdle=true family) marks the root finished-unread.
	t.Run("ordinary_busy_to_idle_marks_root_unread", func(t *testing.T) {
		s := New(100)
		defer s.Close() // cancel armed grace so no timer fires into a later test
		ch, unsub := s.Subscribe(128)
		defer unsub()
		// root R with a single child C (a subagent).
		s.Apply(ev("session.created", `{"info":{"id":"R"}}`))
		s.Apply(ev("session.created", `{"info":{"id":"C","parentID":"R"}}`))
		drainEvents(ch) // drop session.upsert setup events

		// C busy via the ordinary session.status path (markOnIdle=true).
		// subtreeBusyCount[R]: 0 → 1; wasZero so clearUnreadLocked(R) is a no-op.
		s.Apply(ev("session.status", evStatus("C", "busy")))
		drainEvents(ch)
		if got := s.subtreeBusyCount["R"]; got != 1 {
			t.Fatalf("after busy: subtreeBusyCount[R]=%d, want 1", got)
		}

		// C idle via the ordinary session.idle path (markOnIdle=true): the
		// busy→idle flip with subtreeBusyCount[R] → 0 MUST mark R unread.
		s.Apply(ev("session.idle", evIdle("C")))

		if !s.unread["R"] {
			t.Fatal("ordinary busy→idle must mark root R unread (markOnIdle=true)")
		}
		if got := s.subtreeBusyCount["R"]; got != 0 {
			t.Fatalf("after idle: subtreeBusyCount[R]=%d, want 0 (count maintenance is unconditional)", got)
		}
		if evs := drainKind(ch, KindUnreadSet); len(evs) != 1 {
			t.Fatalf("want exactly 1 KindUnreadSet for R, got %d", len(evs))
		}
		snap := s.Snapshot(nil)
		if !unreadHas(snap.Unread, "R") {
			t.Fatalf("snapshot Unread must contain R, got %v", snap.Unread)
		}
	})

	// status_reconcile_busy_to_idle_does_not_mark_unread: a status-snapshot
	// reconcile (markOnIdle=false) clears busy WITHOUT flagging the root.
	t.Run("status_reconcile_busy_to_idle_does_not_mark_unread", func(t *testing.T) {
		s := New(100)
		defer s.Close()
		ch, unsub := s.Subscribe(128)
		defer unsub()
		s.Apply(ev("session.created", `{"info":{"id":"R"}}`))
		s.Apply(ev("session.created", `{"info":{"id":"C","parentID":"R"}}`))
		drainEvents(ch)

		// Establish C busy via the ordinary path.
		s.Apply(ev("session.status", evStatus("C", "busy")))
		drainEvents(ch)
		if got := s.subtreeBusyCount["R"]; got != 1 {
			t.Fatalf("setup: subtreeBusyCount[R]=%d, want 1", got)
		}

		// Status reconcile clears C to idle through the clearActivity closure,
		// which routes through setActivityAtLocked with markOnIdle=false (M9).
		// The busy→idle flip MUST NOT mark R unread.
		s.SetActivityFromStatuses(map[string]json.RawMessage{})

		if s.unread["R"] {
			t.Fatal("status-reconcile busy→idle must NOT mark root R unread (markOnIdle=false)")
		}
		if got := s.subtreeBusyCount["R"]; got != 0 {
			t.Fatalf("after reconcile: subtreeBusyCount[R]=%d, want 0 (count maintenance is unconditional)", got)
		}
		if evs := drainKind(ch, KindUnreadSet); len(evs) != 0 {
			t.Fatalf("status reconcile must emit no KindUnreadSet, got %d: %+v", len(evs), evs)
		}
		snap := s.Snapshot(nil)
		if unreadHas(snap.Unread, "R") {
			t.Fatalf("snapshot Unread must NOT contain R, got %v", snap.Unread)
		}
	})

	// running_again_clears_unread_unconditionally: the idle→busy running-again
	// clearUnreadLocked is NOT policy-gated — it fires regardless of markOnIdle.
	// Proven via the status-reconcile path (markOnIdle=false): a root already
	// marked unread is cleared when the subtree goes busy again.
	t.Run("running_again_clears_unread_unconditionally", func(t *testing.T) {
		s := New(100)
		defer s.Close()
		ch, unsub := s.Subscribe(128)
		defer unsub()
		s.Apply(ev("session.created", `{"info":{"id":"R"}}`))
		s.Apply(ev("session.created", `{"info":{"id":"C","parentID":"R"}}`))
		drainEvents(ch)

		// First establish R as unread via an ordinary busy→idle on C. We use
		// session.status (not session.idle) deliberately: session.idle arms
		// completionAuthoritative[C], which would force the subsequent busy
		// reconcile back to idle (the lane-A stale-busy guard) and prevent the
		// running-again flip under test. session.status is an ordinary path
		// that marks unread (markOnIdle=true) WITHOUT arming that guard.
		s.Apply(ev("session.status", evStatus("C", "busy")))
		s.Apply(ev("session.status", evStatus("C", "idle")))
		drainEvents(ch)
		if !s.unread["R"] {
			t.Fatal("precondition: R must be unread before the running-again clear")
		}

		// Running again: drive C busy via the status-reconcile path
		// (markOnIdle=false). The idle→busy running-again clear is UNCONDITIONAL
		// — clearUnreadLocked fires regardless of the per-transition policy.
		s.SetActivityFromStatuses(map[string]json.RawMessage{
			"C": json.RawMessage(`{"type":"busy"}`),
		})

		if s.unread["R"] {
			t.Fatal("running-again (idle→busy) must clear R unread unconditionally (clearUnreadLocked is not policy-gated)")
		}
		if got := s.subtreeBusyCount["R"]; got != 1 {
			t.Fatalf("after running-again: subtreeBusyCount[R]=%d, want 1", got)
		}
		if evs := drainKind(ch, KindUnreadClear); len(evs) != 1 {
			t.Fatalf("running-again must emit exactly 1 KindUnreadClear for R, got %d", len(evs))
		}
	})
}

// TestSessionDeleteClearsUnreadVisibly pins the delete-path unread teardown:
// deleting a session whose id carries the finished-unread watermark must emit
// KindUnreadClear ON THE WIRE, BEFORE the structural KindSessionDelete prune,
// so a client that applied the earlier unread.set cannot keep a ghost flag.
// With the visible clear, the ack route's no-op (AckUnread on an absent entry
// emits nothing) is harmless — clients were already cleared by this emit.
//
// Regression (lane-8 real-embed nightly 2026-10-20): the fixture
// /fixture/reset queue-custody path (d41f0bf — session.deleted +
// session.created recreate) ran AFTER the reset's own session.idle had MARKED
// the root unread; the silent delete dropped s.unread[root], the test's
// POST /vh/ack then no-op'd with no unread.clear on the wire, and the SPA's
// unread badge stuck at 1 (tab pair (1|1) instead of (1|0); the next test's
// baseline never settled).
func TestSessionDeleteClearsUnreadVisibly(t *testing.T) {
	s := New(100)
	defer s.Close()
	ch, unsub := s.Subscribe(128)
	defer unsub()
	s.Apply(ev("session.created", `{"info":{"id":"R"}}`))
	drainEvents(ch)

	// Mark R unread via the ordinary session.status busy→idle family
	// (markOnIdle=true — same setup discipline as the subtests above).
	s.Apply(ev("session.status", evStatus("R", "busy")))
	s.Apply(ev("session.status", evStatus("R", "idle")))
	drainEvents(ch)
	if !s.unread["R"] {
		t.Fatal("precondition: R must be unread before the delete")
	}

	// Delete R: the flag must clear VISIBLY, and the clear must precede the
	// structural prune on the wire (seq order discipline).
	s.Apply(ev("session.deleted", `{"info":{"id":"R"}}`))
	if s.unread["R"] {
		t.Fatal("delete must drop s.unread[R]")
	}
	var kinds []string
	for len(ch) > 0 {
		kinds = append(kinds, (<-ch).Kind)
	}
	clearAt, deleteAt := -1, -1
	for i, k := range kinds {
		if k == KindUnreadClear && clearAt == -1 {
			clearAt = i
		}
		if k == KindSessionDelete {
			deleteAt = i
		}
	}
	if clearAt == -1 {
		t.Fatalf("delete of an unread root must emit KindUnreadClear, got kinds %v", kinds)
	}
	if deleteAt == -1 {
		t.Fatalf("delete must emit KindSessionDelete, got kinds %v", kinds)
	}
	if clearAt > deleteAt {
		t.Fatalf("KindUnreadClear (index %d) must precede KindSessionDelete (index %d): %v", clearAt, deleteAt, kinds)
	}

	// The ack on the now-absent entry must stay a SILENT no-op — with the
	// visible delete clear above, a second clear event would be redundant
	// churn, and its absence is what keeps AckUnread idempotent.
	s.AckUnread("R")
	if evs := drainKind(ch, KindUnreadClear); len(evs) != 0 {
		t.Fatalf("ack after delete must emit nothing (clients already cleared), got %d", len(evs))
	}
}

// unreadHas reports whether the snapshot's Unread list contains id. Test-local
// helper (the tree_emitter_test.go `contains` is a substring check, distinct).
func unreadHas(xs []string, id string) bool {
	for _, x := range xs {
		if x == id {
			return true
		}
	}
	return false
}
