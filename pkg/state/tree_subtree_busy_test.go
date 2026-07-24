package state

import (
	"testing"
)

// tree_subtree_busy_test.go — tree=2 UI-parity (P1-B): SubtreeBusy flag.
//
// A collapsed ancestor of a running subagent used to show NO spinner because its
// OWN activity is idle. The SubtreeBusy flag (the busy analog of
// subtreeNeedsInput) is rolled up from the existing subtreeBusyCount index and
// OR'd into TreeRow.isBusy on the client, so a collapsed ancestor of a busy
// descendant renders busy (spinner).
//
// These tests pin:
//   - T1: buildNodeLocked populates Flags.SubtreeBusy from subtreeBusyCount[id].
//   - T2: onActivityLocked (the KindActivity handler) walks the ancestor chain
//     emitting node.facet{flags:{subtreeBusy}} for every known ancestor, mirroring
//     onQuestionLocked's subtreeNeedsInput walk — so a busy↔idle transition
//     live-updates collapsed ancestors.

// ---------------------------------------------------------------------------
// T1 — Flags.SubtreeBusy in buildNodeLocked
// ---------------------------------------------------------------------------

// TestSubtreeBusy_FlagInBuildNode asserts buildNodeLocked sets Flags.SubtreeBusy
// true iff the subtree rooted at id (incl self) currently has a busy/retry
// session, as tracked by subtreeBusyCount[id]. This is the snapshot/expand path
// (the initial value a collapsed ancestor ships with).
func TestSubtreeBusy_FlagInBuildNode(t *testing.T) {
	s := New(64)
	// R → C; C busy → subtreeBusyCount[R] > 0.
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("C", "R")},
		[2]string{"session.status", evStatus("C", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")

	// R is an ancestor of busy C → SubtreeBusy must be true.
	s.mu.RLock()
	nR, ok := e.buildNodeLocked("R", false)
	s.mu.RUnlock()
	if !ok {
		t.Fatalf("buildNodeLocked(R) returned ok=false")
	}
	if !nR.Flags.SubtreeBusy {
		t.Errorf("R (ancestor of busy C): Flags.SubtreeBusy = false, want true")
	}

	// C is itself busy → SubtreeBusy true (self counts).
	s.mu.RLock()
	nC, ok := e.buildNodeLocked("C", false)
	s.mu.RUnlock()
	if !ok {
		t.Fatalf("buildNodeLocked(C) returned ok=false")
	}
	if !nC.Flags.SubtreeBusy {
		t.Errorf("C (self busy): Flags.SubtreeBusy = false, want true")
	}

	// Drive C idle, then re-check R → now SubtreeBusy false.
	applySeq(t, s, [2]string{"session.idle", evIdle("C")})
	s.mu.RLock()
	nR2, ok := e.buildNodeLocked("R", false)
	s.mu.RUnlock()
	if !ok {
		t.Fatalf("buildNodeLocked(R) after idle returned ok=false")
	}
	if nR2.Flags.SubtreeBusy {
		t.Errorf("R (subtree now all idle): Flags.SubtreeBusy = true, want false")
	}
}

// TestSubtreeBusy_FlagFalseForIdleRoot asserts a pure-idle root with no busy
// descendants ships SubtreeBusy false (the cold-start default).
func TestSubtreeBusy_FlagFalseForIdleRoot(t *testing.T) {
	s := New(64)
	// R → A → B, all idle.
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.created", evSessionCreated("B", "A")},
	)
	e := NewTreeEmitter(s, "/proj")
	s.mu.RLock()
	n, ok := e.buildNodeLocked("R", false)
	s.mu.RUnlock()
	if !ok {
		t.Fatalf("buildNodeLocked(R) returned ok=false")
	}
	if n.Flags.SubtreeBusy {
		t.Errorf("idle root R: Flags.SubtreeBusy = true, want false")
	}
}

// ---------------------------------------------------------------------------
// T2 — onActivityLocked ancestor facet walk (live subtreeBusy rollup)
// ---------------------------------------------------------------------------

// TestSubtreeBusy_ActivityAncestorFacetWalk is the CRUX live-update test: a
// KindActivity event for a leaf must walk the ancestor chain and emit
// node.facet{flags:{subtreeBusy}} for every KNOWN ancestor (mirroring
// onQuestionLocked's subtreeNeedsInput walk), so a collapsed ancestor's spinner
// live-updates on a busy↔idle transition of a descendant.
//
// Tree: R → A → C, C busy → active path R,A,C all loaded:true → all known.
func TestSubtreeBusy_ActivityAncestorFacetWalk(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.created", evSessionCreated("C", "A")},
		[2]string{"session.status", evStatus("C", "busy")}, // seeds active path → R,A,C known
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold") // e.known[R|A|C] = true

	// Sanity: with C busy, ancestors carry the busy count.
	s.mu.RLock()
	rBefore := s.subtreeBusyCount["R"]
	aBefore := s.subtreeBusyCount["A"]
	s.mu.RUnlock()
	if rBefore == 0 || aBefore == 0 {
		t.Fatalf("setup invariant: subtreeBusyCount[R]=%d [A]=%d, want both >0", rBefore, aBefore)
	}

	// --- Direction 1: C goes idle → ancestors must get subtreeBusy:false. ---
	applySeq(t, s, [2]string{"session.idle", evIdle("C")})
	idleEv := lastEventOfKind(t, s, KindActivity)
	ops := e.Translate(idleEv)

	// Self facet on C (activity) must still be present (regression guard).
	selfSeen := false
	// Ancestor facets: both A and R must carry subtreeBusy:false now.
	got := map[string]bool{} // id -> saw subtreeBusy facet
	for _, op := range ops {
		f, ok := op.(*NodeFacet)
		if !ok {
			continue
		}
		if f.Data.ID == "C" && f.Data.Activity != nil {
			selfSeen = true
		}
		if v, has := f.Data.Flags["subtreeBusy"]; has {
			got[f.Data.ID] = v
		}
	}
	if !selfSeen {
		t.Errorf("idle direction: expected self activity facet on C; ops=%v", opKinds(ops))
	}
	if got["A"] {
		t.Errorf("idle direction: ancestor A subtreeBusy facet = true, want false (C now idle)")
	}
	if _, saw := got["A"]; !saw {
		t.Errorf("idle direction: expected subtreeBusy facet on ancestor A; got=%v ops=%v", got, opKinds(ops))
	}
	if got["R"] {
		t.Errorf("idle direction: ancestor R subtreeBusy facet = true, want false (C now idle)")
	}
	if _, saw := got["R"]; !saw {
		t.Errorf("idle direction: expected subtreeBusy facet on ancestor R; got=%v ops=%v", got, opKinds(ops))
	}

	// --- Direction 2: C goes busy again → ancestors must get subtreeBusy:true. ---
	applySeq(t, s, [2]string{"session.status", evStatus("C", "busy")})
	busyEv := lastEventOfKind(t, s, KindActivity)
	ops2 := e.Translate(busyEv)

	selfSeen2 := false
	got2 := map[string]bool{}
	for _, op := range ops2 {
		f, ok := op.(*NodeFacet)
		if !ok {
			continue
		}
		if f.Data.ID == "C" && f.Data.Activity != nil {
			selfSeen2 = true
		}
		if v, has := f.Data.Flags["subtreeBusy"]; has {
			got2[f.Data.ID] = v
		}
	}
	if !selfSeen2 {
		t.Errorf("busy direction: expected self activity facet on C; ops=%v", opKinds(ops2))
	}
	if !got2["A"] {
		t.Errorf("busy direction: ancestor A subtreeBusy facet = false, want true (C busy again)")
	}
	if _, saw := got2["A"]; !saw {
		t.Errorf("busy direction: expected subtreeBusy facet on ancestor A; got=%v ops=%v", got2, opKinds(ops2))
	}
	if !got2["R"] {
		t.Errorf("busy direction: ancestor R subtreeBusy facet = false, want true (C busy again)")
	}
	if _, saw := got2["R"]; !saw {
		t.Errorf("busy direction: expected subtreeBusy facet on ancestor R; got=%v ops=%v", got2, opKinds(ops2))
	}
}

// ---------------------------------------------------------------------------
// T3 — onActivityLocked SELF facet must re-emit the node's OWN subtreeBusy
// ---------------------------------------------------------------------------

// TestSubtreeBusy_ActivitySelfFacetClearsOwnStaleFlag is the regression test for
// the /vh/abort stale-spinner bug (web/tests/e2e/ux.spec.ts:59 "Stop clears the
// working indicator immediately"). A ROOT node (no ancestors) whose own activity
// flips busy→idle must have its OWN current subtreeBusy value re-emitted on the
// activity facet, mirroring buildNodeLocked.
//
// Why this matters: subtreeBusyCount[id] INCLUDES the node's own busy
// contribution, so during a busy turn a node.upsert (buildNodeLocked) ships the
// node with Flags.SubtreeBusy=true. When the node later goes idle the activity
// event is the natural clearing moment — but for a ROOT there is no ancestor
// walk, so the ONLY way to clear a stale client flags.subtreeBusy=true is the
// node's own self facet. Before the fix onActivityLocked emitted only
// FacetData{Activity:&st} for the node, never its own subtreeBusy, so the
// spinner persisted after Stop.
func TestSubtreeBusy_ActivitySelfFacetClearsOwnStaleFlag(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.status", evStatus("R", "busy")}, // seeds active path → R known/resident
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold") // e.known[R] = true

	// --- Direction 1: R goes idle → self facet must carry subtreeBusy:false. ---
	applySeq(t, s, [2]string{"session.idle", evIdle("R")})
	idleEv := lastEventOfKind(t, s, KindActivity)
	ops := e.Translate(idleEv)

	idleSelf, idleHas := facetSubtreeBusy(ops, "R")
	if !idleHas {
		t.Fatalf("idle direction: expected self facet on R to carry flags.subtreeBusy (the only clearing path for a root); ops=%v", opKinds(ops))
	}
	if idleSelf {
		t.Errorf("idle direction: self facet flags.subtreeBusy = true, want false (R now idle, no busy descendants)")
	}

	// --- Direction 2: R goes busy again → self facet must carry subtreeBusy:true. ---
	applySeq(t, s, [2]string{"session.status", evStatus("R", "busy")})
	busyEv := lastEventOfKind(t, s, KindActivity)
	ops2 := e.Translate(busyEv)

	busySelf, busyHas := facetSubtreeBusy(ops2, "R")
	if !busyHas {
		t.Fatalf("busy direction: expected self facet on R to carry flags.subtreeBusy; ops=%v", opKinds(ops2))
	}
	if !busySelf {
		t.Errorf("busy direction: self facet flags.subtreeBusy = false, want true (R is busy)")
	}
}

// facetSubtreeBusy scans the emitted ops for the NodeFacet whose Data.ID == id
// and returns (value, found) for its Flags.subtreeBusy entry. A node may have at
// most one self facet per activity event.
func facetSubtreeBusy(ops []TreeOp, id string) (bool, bool) {
	for _, op := range ops {
		f, ok := op.(*NodeFacet)
		if !ok {
			continue
		}
		if f.Data.ID == id {
			if v, has := f.Data.Flags["subtreeBusy"]; has {
				return v, true
			}
		}
	}
	return false, false
}

// TestSubtreeBusy_ActivityNilGuardForDeletedSession mirrors the
// subtreeNeedsInput nil-guard regression: a KindActivity event for a session
// that is still in e.known but already deleted from the store MUST NOT panic in
// the ancestor walk. The self facet is gated by !e.known[id], so for a known-
// but-gone node it is still emitted (harmless, a node.remove follows); the
// ancestor walk must bail on the nil session.
func TestSubtreeBusy_ActivityNilGuardForDeletedSession(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.created", evSessionCreated("C", "A")},
		[2]string{"session.status", evStatus("C", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold") // e.known[R|A|C] = true

	applySeq(t, s, [2]string{"session.status", evStatus("C", "busy")})
	busyEv := lastEventOfKind(t, s, KindActivity)

	// Delete C without routing through the emitter → lagging e.known.
	s.Apply(ev("session.deleted", evSessionDeleted("C")))

	// Must not panic.
	ops := e.Translate(busyEv)

	// The ancestor walk must be skipped for a gone node → no subtreeBusy facets
	// on the ANCESTORS (R, A). The self facet on C (the gone node) is still
	// emitted — including its own subtreeBusy now (mirroring the activity self
	// facet, already emitted for a known-but-gone node) — but that is harmless: a
	// node.remove follows once the delete is processed.
	for _, op := range ops {
		f, ok := op.(*NodeFacet)
		if !ok {
			continue
		}
		if f.Data.ID == "C" {
			continue // self facet on the gone node is harmless (node.remove follows)
		}
		if _, has := f.Data.Flags["subtreeBusy"]; has {
			t.Errorf("nil-guard: expected no subtreeBusy facet for gone node's ancestors; got %v", opKinds(ops))
			break
		}
	}
}
