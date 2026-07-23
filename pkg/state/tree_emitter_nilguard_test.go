package state

// tree_emitter_nilguard_test.go — regression coverage for the nil-session-deref
// class of panics in the tree=2 emitter (Translate event handlers).
//
// Root cause being guarded: the per-connection e.known set LAGS the store. A
// session can be deleted from s.sessions (deleteSessionLocked →
// delete(s.sessions, id)) while a connection still holds e.known[id]==true
// because that connection has not yet processed the KindSessionDelete event.
// Any Translate handler that dereferences s.sessions[id] for an id sourced from
// an event payload (not from a store-resident cursor) must nil-guard, or it
// panics on the lagging connection. tree=2 is the shipped default client path,
// so this was live-hitting users.
//
// These tests construct the lag explicitly: seed e.known via a snapshot, capture
// a facet event from the ring, DELETE the target from the store WITHOUT routing
// the delete through the emitter, then Translate the captured facet event.

import (
	"testing"
)

// deletedSessionLagFixture builds R → A → S with S busy (so the active path
// R,A,S is loaded:true and thus e.known[R|A|S]==true after the snapshot), runs
// the cold snapshot, then applies question.asked(S) (capturing the resulting
// KindQuestionSet event) and finally DELETES S from the store — WITHOUT calling
// Translate on the delete. The returned (emitter, qset-event) leave the emitter
// in the lagging state: e.known[S]==true but s.sessions[S]==nil.
func deletedSessionLagFixture(t *testing.T) (e *TreeEmitter, qsetEvent ClientEvent) {
	t.Helper()
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.created", evSessionCreated("S", "A")},
		[2]string{"session.status", evStatus("S", "busy")}, // S seeds the active path → R,A,S loaded
	)
	e = NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold") // seeds e.known[R|A|S] = true

	// Pending question on S → ring now holds KindQuestionSet{sessionID:S}.
	s.Apply(ev("question.asked", evQuestionAsked("S", "q1")))
	qsetEvent = lastEventOfKind(t, s, KindQuestionSet)

	// DELETE S from the store. Critically we do NOT route this through
	// e.Translate, so e.known[S] stays true (the lagging-connection state).
	s.Apply(ev("session.deleted", evSessionDeleted("S")))

	// Sanity: the lag is real — S is gone from the store but still known.
	s.mu.RLock()
	gone := s.sessions["S"] == nil
	s.mu.RUnlock()
	if !gone {
		t.Fatalf("fixture invariant: S must be deleted from s.sessions")
	}
	if !e.known["S"] {
		t.Fatalf("fixture invariant: e.known[S] must still be true (lagging connection)")
	}
	return e, qsetEvent
}

// TestEmitter_NilGuard_QuestionSetForDeletedSession is the CRUX regression: a
// KindQuestionSet event for a session that is still in e.known but already
// deleted from the store MUST NOT panic. Before the fix, onQuestionLocked
// dereferenced s.sessions[p.SessionID].parentID unconditionally at the ancestor
// walk seed → nil pointer → panic.
//
// Semantics choice (documented): for a known-but-gone node the pendingInput
// facet is STILL emitted (the client holds the stale node and will receive a
// node.remove once it processes the delete; a transient facet on it is
// harmless), but the ancestor walk is correctly skipped — there are no live
// ancestors to propagate up because the node is gone from the store.
func TestEmitter_NilGuard_QuestionSetForDeletedSession(t *testing.T) {
	e, qset := deletedSessionLagFixture(t)

	// Must not panic.
	ops := e.Translate(qset)

	// pendingInput facet on S is still emitted (e.known[S] gate at the top of
	// onQuestionLocked is unaffected by the fix).
	var pendingOnS *NodeFacet
	var subtreeFacets int
	for _, op := range ops {
		f, ok := op.(*NodeFacet)
		if !ok {
			continue
		}
		if f.Data.ID == "S" && f.Data.Flags["pendingInput"] {
			pendingOnS = f
		}
		if _, has := f.Data.Flags["subtreeNeedsInput"]; has {
			subtreeFacets++
		}
	}
	if pendingOnS == nil {
		t.Errorf("expected pendingInput:true facet on deleted-but-known S; ops=%v", opKinds(ops))
	}
	// Ancestor walk MUST be skipped for a gone node: no subtreeNeedsInput facets.
	if subtreeFacets != 0 {
		t.Errorf("expected 0 subtreeNeedsInput facets (node gone, no ancestor walk); got %d in ops=%v",
			subtreeFacets, opKinds(ops))
	}
}

// TestEmitter_NilGuard_QuestionClearForDeletedSession covers the
// KindQuestionClear branch, which routes through the SAME onQuestionLocked
// ancestor-walk seed (set=false). It must not panic either.
func TestEmitter_NilGuard_QuestionClearForDeletedSession(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.created", evSessionCreated("S", "A")},
		[2]string{"session.status", evStatus("S", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold")

	// Ask then reply → ring holds KindQuestionClear{sessionID:S}.
	s.Apply(ev("question.asked", evQuestionAsked("S", "q1")))
	s.Apply(ev("question.replied", evQuestionReplied("S", "q1")))
	qclear := lastEventOfKind(t, s, KindQuestionClear)

	// Delete S without routing through the emitter → lagging e.known.
	s.Apply(ev("session.deleted", evSessionDeleted("S")))

	// Must not panic.
	_ = e.Translate(qclear)
}

// TestEmitter_NilGuard_PermissionEventForDeletedSession audits the permission
// sibling: onPermissionLocked does NOT dereference s.sessions (it only consults
// e.known and emits a facet), so it is already safe. We assert that explicitly
// so a future refactor cannot silently reintroduce the deref.
func TestEmitter_NilGuard_PermissionEventForDeletedSession(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.created", evSessionCreated("S", "A")},
		[2]string{"session.status", evStatus("S", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold")

	s.Apply(ev("permission.asked", evPermissionAsked("S", "p1")))
	pset := lastEventOfKind(t, s, KindPermissionSet)

	// Delete S without routing through the emitter → lagging e.known.
	s.Apply(ev("session.deleted", evSessionDeleted("S")))

	// Must not panic (and is expected to be safe even without the fix).
	ops := e.Translate(pset)
	var permOnS *NodeFacet
	for _, op := range ops {
		f, ok := op.(*NodeFacet)
		if ok && f.Data.ID == "S" && f.Data.Flags["permission"] {
			permOnS = f
		}
	}
	if permOnS == nil {
		t.Errorf("expected permission:true facet on deleted-but-known S; ops=%v", opKinds(ops))
	}
}

// TestEmitter_QuestionFacet_HappyPath_AncestorWalk is the regression guard that
// the nil-guard fix did NOT break the happy path: for an EXISTING session, a
// KindQuestionSet event still walks the ancestor chain and emits
// subtreeNeedsInput:true on every known ancestor whose subtree index flips.
func TestEmitter_QuestionFacet_HappyPath_AncestorWalk(t *testing.T) {
	s := New(64)
	// R → A → Q, Q busy → active path R,A,Q all loaded:true → all known.
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.created", evSessionCreated("Q", "A")},
		[2]string{"session.status", evStatus("Q", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold") // e.known[R|A|Q] = true

	// Pending question on Q → notePendingInputChangeLocked flips
	// subtreePendingInput[A] and subtreePendingInput[R] > 0.
	s.Apply(ev("question.asked", evQuestionAsked("Q", "q1")))
	qset := lastEventOfKind(t, s, KindQuestionSet)

	ops := e.Translate(qset)

	want := map[string]bool{
		"Q": false, // pendingInput:true on Q itself
		"A": false, // subtreeNeedsInput:true on ancestor A
		"R": false, // subtreeNeedsInput:true on ancestor R
	}
	for _, op := range ops {
		f, ok := op.(*NodeFacet)
		if !ok {
			continue
		}
		if f.Data.ID == "Q" && f.Data.Flags["pendingInput"] {
			want["Q"] = true
		}
		if f.Data.ID == "A" && f.Data.Flags["subtreeNeedsInput"] {
			want["A"] = true
		}
		if f.Data.ID == "R" && f.Data.Flags["subtreeNeedsInput"] {
			want["R"] = true
		}
	}
	for id, saw := range want {
		if !saw {
			t.Errorf("happy-path ancestor walk missing expected facet on %q; ops=%v", id, opKinds(ops))
		}
	}
}
