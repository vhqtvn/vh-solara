package state

import (
	"encoding/json"
	"strings"
	"testing"
)

// structural_revision_test.go — Phase 3 (Gate B) tests for the Store-wide
// structuralRevision counter: monotonicity, bump-site coverage, snapshot
// stamping, and the omitempty-zero semantics (revision 0 = fresh store).
//
// The bump sites (5 chokepoints):
//   - setActivityLocked            (all activity transitions incl busy-neutral)
//   - upsertSessionLocked          (session create / reparent)
//   - deleteSessionLocked          (session delete)
//   - notePendingInputChangeLocked (perm/question asked/replied — when pendingInputSelf changes)
//   - Hydrate                      (hydrate create / reparent)
//
// Non-structural mutations (message/part upsert that does NOT escalate to Busy,
// todos, currentVerb changes) must NOT bump.

// evSessCreated is a shorthand for session.created events with id + parentID.
func evSessCreated(id, parentID string) string {
	return `{"info":{"id":"` + id + `","parentID":"` + parentID + `"}}`
}

// TestStructuralRevision_StartsAtZero asserts a fresh store has revision 0
// (the "fresh store, never mutated" sentinel that omitempty suppresses from
// JSON so old clients always apply).
func TestStructuralRevision_StartsAtZero(t *testing.T) {
	s := New(64)
	if rev := s.structuralRevision; rev != 0 {
		t.Fatalf("fresh store structuralRevision = %d, want 0", rev)
	}
	snap := s.Snapshot(nil)
	if snap.StructuralRevision != 0 {
		t.Fatalf("fresh snapshot StructuralRevision = %d, want 0", snap.StructuralRevision)
	}
}

// TestStructuralRevision_Monotonicity applies a mixed sequence of mutations
// and asserts structuralRevision is strictly increasing after each one.
func TestStructuralRevision_Monotonicity(t *testing.T) {
	s := New(64)
	var prev uint64 // starts at 0

	checkBumped := func(label string) {
		t.Helper()
		cur := s.structuralRevision
		if cur <= prev {
			t.Fatalf("%s: structuralRevision did not increase: prev=%d cur=%d", label, prev, cur)
		}
		prev = cur
	}

	// session.created
	s.Apply(ev("session.created", evSessCreated("a", "")))
	checkBumped("create a")

	// session.created child
	s.Apply(ev("session.created", evSessCreated("b", "a")))
	checkBumped("create b under a")

	// session.status (idle → busy). NOTE: normalizeActivity maps "busy"→Busy;
	// "running" falls through to the default (Idle), so we use "busy" explicitly.
	s.Apply(ev("session.status", evStatus("b", "busy")))
	checkBumped("status b busy")

	// session.status (busy → retry)
	s.Apply(ev("session.status", evStatus("b", "retry")))
	checkBumped("status b retry")

	// session.status (retry → busy)
	s.Apply(ev("session.status", evStatus("b", "busy")))
	checkBumped("status b busy again")

	// session.idle (busy → idle)
	s.Apply(ev("session.idle", evIdle("b")))
	checkBumped("idle b")

	// permission.asked on b (0→1 pendingInputSelf)
	s.Apply(ev("permission.asked", evPermissionAsked("b", "perm1")))
	checkBumped("perm asked b")

	// permission.asked on b again (1→1 pendingInputSelf — NOT a boundary change)
	revBeforeDup := s.structuralRevision
	s.Apply(ev("permission.asked", evPermissionAsked("b", "perm2")))
	if s.structuralRevision != revBeforeDup {
		t.Fatalf("duplicate perm on same session should NOT bump: before=%d after=%d",
			revBeforeDup, s.structuralRevision)
	}

	// permission.replied clearing both perms (1→0 pendingInputSelf)
	s.Apply(ev("permission.replied", evPermissionReplied("b", "perm1")))
	s.Apply(ev("permission.replied", evPermissionReplied("b", "perm2")))
	checkBumped("perm replied b (clears pendingInputSelf)")

	// question.asked on b (0→1)
	s.Apply(ev("question.asked", evQuestionAsked("b", "q1")))
	checkBumped("question asked b")

	// question.replied clearing (1→0)
	s.Apply(ev("question.replied", evQuestionReplied("b", "q1")))
	checkBumped("question replied b")

	// session.updated (reparent b from a to root)
	s.Apply(ev("session.updated", evSessCreated("b", "")))
	checkBumped("reparent b to root")

	// session.deleted — dispatch expects {"info":{"id":"b"}}, not {"id":"b"}.
	s.Apply(ev("session.deleted", `{"info":{"id":"b"}}`))
	checkBumped("delete b")

	// Hydrate
	s.Hydrate([]json.RawMessage{json.RawMessage(`{"id":"c","parentID":""}`)}, nil)
	checkBumped("hydrate c")
}

// TestStructuralRevision_NotBumpedByNonStructural asserts that mutations which
// do NOT affect the projection (message upsert without activity escalation,
// part deltas without activity change) leave structuralRevision unchanged.
func TestStructuralRevision_NotBumpedByNonStructural(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", evSessCreated("a", "")))
	revAfterCreate := s.structuralRevision

	// A user message (role=user) does NOT escalate to Busy.
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"user","content":[{"type":"text","text":"hi"}]}}`))
	if s.structuralRevision != revAfterCreate {
		t.Fatalf("non-escalating message upsert bumped structuralRevision: %d → %d",
			revAfterCreate, s.structuralRevision)
	}

	// A part delta on a USER message does NOT escalate (me.role == "user"
	// guards the setActivityLocked(Busy) call at the bottom of
	// appendPartDeltaLocked). A part delta on any non-user message (including
	// a fresh placeholder with role="") DOES escalate — that is correct server
	// behavior, not a bug. So we test non-escalation by targeting m1 (user).
	s.Apply(ev("message.part.delta", `{"sessionID":"a","messageID":"m1","partID":"p1","delta":"x"}`))
	if s.structuralRevision != revAfterCreate {
		t.Fatalf("non-escalating part delta bumped structuralRevision: %d → %d",
			revAfterCreate, s.structuralRevision)
	}
}

// TestStructuralRevision_MessageEscalationBumps asserts that an assistant
// message that escalates the session to Busy (via setActivityLocked) bumps
// structuralRevision.
func TestStructuralRevision_MessageEscalationBumps(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", evSessCreated("a", "")))
	revAfterCreate := s.structuralRevision

	// An assistant message that triggers escalation (assistantInflightLocked
	// returns true → setActivityLocked(Busy) → bump).
	s.Apply(ev("message.updated", evAssistantInflight("a", "m1")))
	if s.structuralRevision <= revAfterCreate {
		t.Fatalf("escalating assistant message did NOT bump structuralRevision: %d → %d",
			revAfterCreate, s.structuralRevision)
	}
}

// TestStructuralRevision_SnapshotStamping verifies that Snapshot.StructuralRevision
// matches the store's current revision after various mutations.
func TestStructuralRevision_SnapshotStamping(t *testing.T) {
	s := New(64)

	// Fresh store: revision 0.
	snap0 := s.Snapshot(nil)
	if snap0.StructuralRevision != 0 {
		t.Fatalf("fresh snapshot StructuralRevision = %d, want 0", snap0.StructuralRevision)
	}

	s.Apply(ev("session.created", evSessCreated("a", "")))
	s.Apply(ev("session.status", evStatus("a", "busy")))

	snap1 := s.Snapshot(nil)
	if snap1.StructuralRevision != s.structuralRevision {
		t.Fatalf("snapshot StructuralRevision %d != store %d",
			snap1.StructuralRevision, s.structuralRevision)
	}
	if snap1.StructuralRevision < 2 {
		t.Fatalf("expected at least 2 bumps (create + status), got %d",
			snap1.StructuralRevision)
	}
}

// TestStructuralRevision_OmitemptyZero verifies that revision 0 is omitted from
// JSON (so old clients never see the field, and the client treats absent as
// "always apply"). This is the omitempty contract.
func TestStructuralRevision_OmitemptyZero(t *testing.T) {
	s := New(64)
	snap := s.Snapshot(nil)
	b, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(b), "structuralRevision") {
		t.Fatalf("fresh snapshot should omit structuralRevision (omitempty), got: %s", b)
	}

	// After one mutation, the field appears.
	s.Apply(ev("session.created", evSessCreated("a", "")))
	snap2 := s.Snapshot(nil)
	b2, _ := json.Marshal(snap2)
	if !strings.Contains(string(b2), "structuralRevision") {
		t.Fatalf("post-mutation snapshot should include structuralRevision, got: %s", b2)
	}
}

// TestStructuralRevision_AllBumpSites systematically verifies each bump site.
func TestStructuralRevision_AllBumpSites(t *testing.T) {
	t.Run("activity_busy_neutral", func(t *testing.T) {
		s := New(64)
		s.Apply(ev("session.created", evSessCreated("a", "")))
		s.Apply(ev("session.status", evStatus("a", "busy"))) // idle→busy
		revAfterBusy := s.structuralRevision
		s.Apply(ev("session.status", evStatus("a", "retry"))) // busy→retry (busy-neutral)
		if s.structuralRevision <= revAfterBusy {
			t.Fatalf("busy→retry (busy-neutral) did NOT bump: %d → %d",
				revAfterBusy, s.structuralRevision)
		}
	})

	t.Run("activity_error_to_idle", func(t *testing.T) {
		s := New(64)
		s.Apply(ev("session.created", evSessCreated("a", "")))
		s.Apply(ev("session.error", evIdle("a"))) // idle→error
		revAfterError := s.structuralRevision
		s.Apply(ev("session.idle", evIdle("a"))) // error→idle (busy-neutral)
		if s.structuralRevision <= revAfterError {
			t.Fatalf("error→idle (busy-neutral) did NOT bump: %d → %d",
				revAfterError, s.structuralRevision)
		}
	})

	t.Run("delete_chokepoint", func(t *testing.T) {
		s := New(64)
		s.Apply(ev("session.created", evSessCreated("a", "")))
		revBeforeDelete := s.structuralRevision
		s.Apply(ev("session.deleted", `{"info":{"id":"a"}}`))
		if s.structuralRevision <= revBeforeDelete {
			t.Fatalf("session.deleted did NOT bump: %d → %d",
				revBeforeDelete, s.structuralRevision)
		}
	})

	t.Run("archive_via_updated", func(t *testing.T) {
		s := New(64)
		s.Apply(ev("session.created", evSessCreated("a", "")))
		revBeforeArchive := s.structuralRevision
		// time.archived set → upsertSessionLocked funnels to deleteSessionLocked.
		s.Apply(ev("session.updated", `{"info":{"id":"a","parentID":"","time":{"archived":1234567890.0}}}`))
		if s.structuralRevision <= revBeforeArchive {
			t.Fatalf("archive via updated did NOT bump: %d → %d",
				revBeforeArchive, s.structuralRevision)
		}
	})

	t.Run("set_pending_questions", func(t *testing.T) {
		s := New(64)
		s.Apply(ev("session.created", evSessCreated("a", "")))
		revBefore := s.structuralRevision
		// Add a question → pendingInputSelf 0→1 → bump.
		s.SetPendingQuestions([]json.RawMessage{
			json.RawMessage(`{"id":"q1","sessionID":"a"}`),
		})
		if s.structuralRevision <= revBefore {
			t.Fatalf("SetPendingQuestions (add) did NOT bump: %d → %d",
				revBefore, s.structuralRevision)
		}
		// Clear → pendingInputSelf 1→0 → bump.
		revAfterAdd := s.structuralRevision
		s.SetPendingQuestions([]json.RawMessage{})
		if s.structuralRevision <= revAfterAdd {
			t.Fatalf("SetPendingQuestions (clear) did NOT bump: %d → %d",
				revAfterAdd, s.structuralRevision)
		}
	})

	t.Run("set_pending_permissions", func(t *testing.T) {
		s := New(64)
		s.Apply(ev("session.created", evSessCreated("a", "")))
		revBefore := s.structuralRevision
		s.SetPendingPermissions([]json.RawMessage{
			json.RawMessage(`{"id":"p1","sessionID":"a"}`),
		})
		if s.structuralRevision <= revBefore {
			t.Fatalf("SetPendingPermissions (add) did NOT bump: %d → %d",
				revBefore, s.structuralRevision)
		}
	})

	t.Run("phantom_perm_no_bump", func(t *testing.T) {
		s := New(64)
		revBefore := s.structuralRevision
		// Permission for a session that does NOT exist yet → phantom → no bump.
		s.Apply(ev("permission.asked", evPermissionAsked("ghost", "p1")))
		if s.structuralRevision != revBefore {
			t.Fatalf("phantom perm SHOULD NOT bump: %d → %d",
				revBefore, s.structuralRevision)
		}
		// Now create the session — the perm gets seeded → bump.
		s.Apply(ev("session.created", evSessCreated("ghost", "")))
		if s.structuralRevision <= revBefore {
			t.Fatalf("create after phantom perm did NOT bump: %d → %d",
				revBefore, s.structuralRevision)
		}
	})
}

// TestStructuralRevision_RemoveSessions verifies RemoveSessions (which funnels
// through deleteSessionLocked) bumps.
func TestStructuralRevision_RemoveSessions(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", evSessCreated("a", "")))
	s.Apply(ev("session.created", evSessCreated("b", "a")))
	revBefore := s.structuralRevision
	s.RemoveSessions([]string{"b"})
	if s.structuralRevision <= revBefore {
		t.Fatalf("RemoveSessions did NOT bump: %d → %d", revBefore, s.structuralRevision)
	}
}

// TestStructuralRevision_SetActivityFromStatuses verifies the batch activity
// setter (which calls setActivityLocked per session) bumps.
func TestStructuralRevision_SetActivityFromStatuses(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", evSessCreated("a", "")))
	revBefore := s.structuralRevision
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		"a": json.RawMessage(`{"type":"busy"}`),
	})
	if s.structuralRevision <= revBefore {
		t.Fatalf("SetActivityFromStatuses did NOT bump: %d → %d",
			revBefore, s.structuralRevision)
	}
}

// TestStructuralRevision_MarkIdle verifies MarkIdle (→ setActivityLocked) bumps.
func TestStructuralRevision_MarkIdle(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", evSessCreated("a", "")))
	s.Apply(ev("session.status", evStatus("a", "busy"))) // busy
	revBefore := s.structuralRevision
	s.MarkIdle("a")
	if s.structuralRevision <= revBefore {
		t.Fatalf("MarkIdle did NOT bump: %d → %d", revBefore, s.structuralRevision)
	}
}

// TestStructuralRevision_HydrateDeleteUnseen verifies that the Hydrate
// delete-unseen loop (which funnels through deleteSessionLocked) bumps.
func TestStructuralRevision_HydrateDeleteUnseen(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", evSessCreated("a", "")))
	s.Apply(ev("session.created", evSessCreated("b", "")))
	revBefore := s.structuralRevision
	// Hydrate with only "a" → "b" is deleted as unseen.
	s.Hydrate([]json.RawMessage{json.RawMessage(`{"id":"a","parentID":""}`)}, nil)
	if s.structuralRevision <= revBefore {
		t.Fatalf("Hydrate delete-unseen did NOT bump: %d → %d",
			revBefore, s.structuralRevision)
	}
}

// TestStructuralRevision_NewStoreStartsFresh verifies that a new Store (new
// process/epoch) starts at revision 0 — the "reset on epoch change" semantic.
// (Epoch is per-Store-lifetime: New assigns a random epoch, never reassigned.)
func TestStructuralRevision_NewStoreStartsFresh(t *testing.T) {
	s1 := New(64)
	s1.Apply(ev("session.created", evSessCreated("a", "")))
	if s1.structuralRevision == 0 {
		t.Fatal("s1 should have bumped from create")
	}
	// A new store is a new epoch — revision starts at 0.
	s2 := New(64)
	if s2.structuralRevision != 0 {
		t.Fatalf("new store s2 structuralRevision = %d, want 0", s2.structuralRevision)
	}
	if s1.epoch == s2.epoch {
		t.Fatal("two stores should have different epochs")
	}
}
