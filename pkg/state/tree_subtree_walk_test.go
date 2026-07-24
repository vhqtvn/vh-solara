package state

// tree_subtree_walk_test.go — RED tests for the two ancestor-walk bugs in the
// tree=2 emitter (d-F1): facet propagation truncating at an UNMATERIALIZED
// intermediate ancestor (CAUSE 1) and the delete path not re-emitting ancestor
// subtree aggregates (CAUSE 2).
//
// CAUSE 1 (truncation): onActivityLocked / onQuestionLocked walk the ancestor
// chain emitting subtree{Busy,NeedsInput} facets only for KNOWN ancestors. When
// the walk hit an intermediate ancestor that this connection does NOT hold
// (!e.known[cur]), it `break`-ed — abandoning every KNOWN ancestor above it. So
// a known root above a collapsed/unmaterialized intermediate kept a stale
// busy/needs-input flag until a full reload (buildNodeLocked / F5). Fix: keep
// walking past the unknown intermediate, emitting only for known ancestors.
//
// Constructing the gap state: SnapshotFrontier seeds e.known from the active
// path, and the active-path walk materializes EVERY ancestor of an active node,
// so a plain cold load never leaves an intermediate ancestor unknown. The gap
// arises from per-connection e.known drift (a connection that holds a node and a
// remote ancestor but not the node between them — e.g. post-snapshot event
// racing / cross-connection state). We simulate that connection state directly
// by deleting the intermediate id from e.known after the snapshot, which is the
// cleanest honest way to exercise the walk's skip-but-continue branch.

import (
	"testing"
)

// ---------------------------------------------------------------------------
// CAUSE 1a — onActivityLocked subtreeBusy walk must propagate past an
// unmaterialized intermediate ancestor.
// ---------------------------------------------------------------------------

// TestSubtreeBusy_ActivityWalkPropagatesPastUnmaterializedAncestor mirrors
// TestSubtreeBusy_ActivityAncestorFacetWalk but inserts an UNMATERIALIZED
// intermediate M between R and the transitioning leaf L. When L goes idle, the
// walk seeds at M (L's parent); M is not in e.known, so the walk must SKIP
// emitting for M but CONTINUE up to R (known) and emit subtreeBusy:false there.
// With the truncation bug the walk breaks at M and R never gets the facet → the
// root keeps a stale busy spinner until F5.
func TestSubtreeBusy_ActivityWalkPropagatesPastUnmaterializedAncestor(t *testing.T) {
	s := New(64)
	// Tree: R → M → L, L busy → active path R,M,L all loaded → all known.
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("M", "R")},
		[2]string{"session.created", evSessionCreated("L", "M")},
		[2]string{"session.status", evStatus("L", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold") // e.known[R|M|L] = true

	// Sanity: the chain is live and the snapshot materialized all three.
	if !e.known["R"] || !e.known["M"] || !e.known["L"] {
		t.Fatalf("setup invariant: e.known must hold R,M,L; got %v", e.known)
	}
	s.mu.RLock()
	rBusy := s.subtreeBusyCount["R"]
	s.mu.RUnlock()
	if rBusy == 0 {
		t.Fatalf("setup invariant: subtreeBusyCount[R]=0, want >0 (L busy under R)")
	}

	// Simulate the gap: M is a real live session but THIS connection does not
	// hold it (unmaterialized intermediate ancestor).
	delete(e.known, "M")

	// L goes idle → onActivityLocked must walk L→M(skip, unknown)→R(emit).
	applySeq(t, s, [2]string{"session.idle", evIdle("L")})
	idleEv := lastEventOfKind(t, s, KindActivity)
	ops := e.Translate(idleEv)

	got := map[string]bool{} // id -> subtreeBusy value emitted
	for _, op := range ops {
		f, ok := op.(*NodeFacet)
		if !ok {
			continue
		}
		if v, has := f.Data.Flags["subtreeBusy"]; has {
			got[f.Data.ID] = v
		}
	}
	// M (unmaterialized) must NOT receive a facet — it is skipped, not emitted.
	if _, saw := got["M"]; saw {
		t.Errorf("unmaterialized M must be skipped (no subtreeBusy facet); got %v", got["M"])
	}
	// R (known ancestor above M) MUST receive subtreeBusy:false now that L is
	// idle. This is the load-bearing RED assertion: with the truncation bug the
	// walk breaks at M and R never gets the facet.
	val, saw := got["R"]
	if !saw {
		t.Fatalf("CAUSE 1a: expected subtreeBusy facet on known ancestor R above unmaterialized M; got=%v ops=%v", got, opKinds(ops))
	}
	if val {
		t.Errorf("CAUSE 1a: R subtreeBusy = true, want false (L now idle, whole subtree idle)")
	}
}

// ---------------------------------------------------------------------------
// CAUSE 1b — onQuestionLocked subtreeNeedsInput walk must propagate past an
// unmaterialized intermediate ancestor (the question-walk twin of 1a).
// ---------------------------------------------------------------------------

// TestEmitter_QuestionWalkPropagatesPastUnmaterializedAncestor mirrors
// TestEmitter_QuestionFacet_HappyPath_AncestorWalk but inserts an
// UNMATERIALIZED intermediate M between R and the leaf L that asks a question.
// When L's question flips subtreePendingInput, the walk must skip unknown M and
// still emit subtreeNeedsInput:true on known R above it. With the truncation bug
// R never gets the facet → the root keeps a stale needs-input flag until F5.
func TestEmitter_QuestionWalkPropagatesPastUnmaterializedAncestor(t *testing.T) {
	s := New(64)
	// Tree: R → M → L, L busy → active path R,M,L all loaded → all known.
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("M", "R")},
		[2]string{"session.created", evSessionCreated("L", "M")},
		[2]string{"session.status", evStatus("L", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold") // e.known[R|M|L] = true

	// Simulate the gap: M is a real live session but not held by this connection.
	delete(e.known, "M")

	// L asks a question → subtreePendingInput flips for L's known ancestors.
	s.Apply(ev("question.asked", evQuestionAsked("L", "q1")))
	qset := lastEventOfKind(t, s, KindQuestionSet)

	// Sanity: the store index now reflects a pending input under R.
	s.mu.RLock()
	rPending := s.subtreePendingInput["R"]
	s.mu.RUnlock()
	if rPending == 0 {
		t.Fatalf("setup invariant: subtreePendingInput[R]=0, want >0 (L asked under R)")
	}

	ops := e.Translate(qset)

	got := map[string]bool{} // id -> subtreeNeedsInput value emitted
	for _, op := range ops {
		f, ok := op.(*NodeFacet)
		if !ok {
			continue
		}
		if v, has := f.Data.Flags["subtreeNeedsInput"]; has {
			got[f.Data.ID] = v
		}
	}
	// M (unmaterialized) must NOT receive a facet.
	if _, saw := got["M"]; saw {
		t.Errorf("unmaterialized M must be skipped (no subtreeNeedsInput facet); got %v", got["M"])
	}
	// R (known ancestor above M) MUST receive subtreeNeedsInput:true. Load-bearing
	// RED assertion: with the truncation bug the walk breaks at M.
	val, saw := got["R"]
	if !saw {
		t.Fatalf("CAUSE 1b: expected subtreeNeedsInput facet on known ancestor R above unmaterialized M; got=%v ops=%v", got, opKinds(ops))
	}
	if !val {
		t.Errorf("CAUSE 1b: R subtreeNeedsInput = false, want true (L has an open question)")
	}
}

// ---------------------------------------------------------------------------
// CAUSE 2 — onSessionDeleteLocked must re-emit ancestor subtree aggregates.
// ---------------------------------------------------------------------------

// TestEmitter_DeletePropagatesAncestorFacets asserts that deleting a busy +,
// question-holding descendant D walks D's ancestor chain and emits the CURRENT
// (post-delete) subtreeBusy + subtreeNeedsInput facets for each KNOWN ancestor.
// Before the fix onSessionDeleteLocked emitted only node.remove(D) + re-root
// moves, so a collapsed-but-known ancestor P kept its stale busy/needs-input
// flag until a full reload (buildNodeLocked / F5).
//
// Tree: R → P(known) → D(busy, open question). Delete D → P and R must each
// receive subtreeBusy:false and subtreeNeedsInput:false live.
func TestEmitter_DeletePropagatesAncestorFacets(t *testing.T) {
	s := New(64)
	// R → P → D; D busy + open question → active path R,P,D all loaded → all known.
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("P", "R")},
		[2]string{"session.created", evSessionCreated("D", "P")},
		[2]string{"session.status", evStatus("D", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold") // e.known[R|P|D] = true
	s.Apply(ev("question.asked", evQuestionAsked("D", "q1")))

	// Sanity: P and R are known, and the store indexes carry D's contributions.
	if !e.known["R"] || !e.known["P"] || !e.known["D"] {
		t.Fatalf("setup invariant: e.known must hold R,P,D; got %v", e.known)
	}
	s.mu.RLock()
	pBusyBefore := s.subtreeBusyCount["P"]
	pInputBefore := s.subtreePendingInput["P"]
	s.mu.RUnlock()
	if pBusyBefore == 0 || pInputBefore == 0 {
		t.Fatalf("setup invariant: subtreeBusyCount[P]=%d subtreePendingInput[P]=%d, want both >0", pBusyBefore, pInputBefore)
	}

	// Delete D routed THROUGH the emitter (the real client path).
	s.Apply(ev("session.deleted", evSessionDeleted("D")))
	delEv := lastEventOfKind(t, s, KindSessionDelete)
	ops := e.Translate(delEv)

	// Sanity: D is gone from the store and its ancestor indexes are decremented.
	s.mu.RLock()
	pBusyAfter := s.subtreeBusyCount["P"]
	pInputAfter := s.subtreePendingInput["P"]
	dGone := s.sessions["D"] == nil
	s.mu.RUnlock()
	if !dGone {
		t.Fatalf("setup invariant: D must be deleted from s.sessions")
	}
	if pBusyAfter != 0 || pInputAfter != 0 {
		t.Fatalf("setup invariant: post-delete subtreeBusyCount[P]=%d subtreePendingInput[P]=%d, want both 0", pBusyAfter, pInputAfter)
	}

	// Collect subtreeBusy / subtreeNeedsInput facets emitted for ancestors.
	busy := map[string]bool{}       // id -> value
	needsInput := map[string]bool{} // id -> value
	var removeSeen bool
	for _, op := range ops {
		switch f := op.(type) {
		case *NodeRemove:
			if f.ID == "D" {
				removeSeen = true
			}
		case *NodeFacet:
			if v, has := f.Data.Flags["subtreeBusy"]; has {
				busy[f.Data.ID] = v
			}
			if v, has := f.Data.Flags["subtreeNeedsInput"]; has {
				needsInput[f.Data.ID] = v
			}
		}
	}
	if !removeSeen {
		t.Errorf("expected node.remove(D) in delete ops; got %v", opKinds(ops))
	}
	// P (known direct ancestor) MUST receive subtreeBusy:false + subtreeNeedsInput:false.
	// This is the load-bearing RED assertion for CAUSE 2.
	if val, saw := busy["P"]; !saw {
		t.Errorf("CAUSE 2: expected subtreeBusy facet on known ancestor P after deleting busy D; got=%v ops=%v", busy, opKinds(ops))
	} else if val {
		t.Errorf("CAUSE 2: P subtreeBusy = true, want false (D deleted, P's subtree now idle)")
	}
	if val, saw := needsInput["P"]; !saw {
		t.Errorf("CAUSE 2: expected subtreeNeedsInput facet on known ancestor P after deleting question-holding D; got=%v ops=%v", needsInput, opKinds(ops))
	} else if val {
		t.Errorf("CAUSE 2: P subtreeNeedsInput = true, want false (D deleted, P's subtree has no pending input)")
	}
	// R (known ancestor above P) must also clear (full chain walk).
	if val, saw := busy["R"]; !saw {
		t.Errorf("CAUSE 2: expected subtreeBusy facet on known root R; got=%v ops=%v", busy, opKinds(ops))
	} else if val {
		t.Errorf("CAUSE 2: R subtreeBusy = true, want false")
	}
}
