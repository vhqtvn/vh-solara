package state

import (
	"encoding/json"
	"testing"
)

// tree_orphan_test.go — Phase 2 §9 orphan computation + emit hooks.
//
// §9.1 rule: N is orphan iff effectiveParent non-empty AND chain ROOT archived
// AND N still resident. Live-rooted NEVER orphan.
//
// The orphan flag is COMPUTED in buildNodeLocked → isOrphanLocked (already
// shipped with every node). These tests cover the §9.2 EMIT hooks: facet
// emission when orphan status changes due to (a) root archive-state change,
// (b) delete reparenting.

// --- helpers ---

// setArchivedInfoLocked directly mutates a session's info to carry
// time.archived, BYPASSING upsertSessionLocked's archive→delete cascade. This
// simulates the §9 scenario where a root's archived flag is set while the root
// and its descendants are still resident (which the cascade-delete path makes
// unreachable via normal Apply, but the orphan computation must handle
// correctly for future archive-keep paths and for direct state inspection).
func setArchivedInfoLocked(s *Store, id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if se := s.sessions[id]; se != nil {
		var env sessionEnvelope
		_ = json.Unmarshal(se.info, &env)
		env.ID = id
		env.Time.Archived = pFloat64(1700000000)
		raw, _ := json.Marshal(env)
		se.info = raw
	}
}

func pFloat64(v float64) *float64 { return &v }

// facetOrphan extracts the orphan flag from a NodeFacet op's Flags map.
func facetOrphan(op TreeOp) (id string, orphan bool, ok bool) {
	f, isFacet := op.(*NodeFacet)
	if !isFacet {
		return "", false, false
	}
	orphan, ok = f.Data.Flags["orphan"]
	return f.Data.ID, orphan, ok
}

// ---------------------------------------------------------------------------
// §9.1 — isOrphanLocked correctness (the computation itself)
// ---------------------------------------------------------------------------

func TestOrphan_LiveRootNeverOrphan(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("C", "R")},
	)
	s.mu.RLock()
	defer s.mu.RUnlock()
	if isOrphanLocked(s, "R") {
		t.Errorf("root R should NOT be orphan (it is its own root, live)")
	}
	if isOrphanLocked(s, "C") {
		t.Errorf("child C of live root R should NOT be orphan")
	}
}

func TestOrphan_ArchivedRootMakesDescendantOrphan(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("C", "R")},
		[2]string{"session.created", evSessionCreated("D", "C")},
	)
	// Archive R WITHOUT triggering the cascade (direct info mutation).
	setArchivedInfoLocked(s, "R")

	s.mu.RLock()
	defer s.mu.RUnlock()
	if isOrphanLocked(s, "R") {
		t.Errorf("R is a root (even if archived) → not orphan by §9.1 cond 1")
	}
	if !isOrphanLocked(s, "C") {
		t.Errorf("C under archived root R SHOULD be orphan")
	}
	if !isOrphanLocked(s, "D") {
		t.Errorf("D (grandchild) under archived root R SHOULD be orphan")
	}
}

func TestOrphan_DeepChainWalksToRoot(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.created", evSessionCreated("B", "A")},
		[2]string{"session.created", evSessionCreated("C", "B")},
	)
	setArchivedInfoLocked(s, "R")
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, id := range []string{"A", "B", "C"} {
		if !isOrphanLocked(s, id) {
			t.Errorf("%s under archived root R SHOULD be orphan", id)
		}
	}
}

// ---------------------------------------------------------------------------
// §9.2 — emit hooks: orphan facet via KindTreeOrphanCheck
// ---------------------------------------------------------------------------

// TestOrphan_EmitFacet_ArchiveRoot proves the emitter emits a
// node.facet{flags:{orphan:true}} for a known descendant when the root's
// archive state flips.
func TestOrphan_EmitFacet_ArchiveRoot(t *testing.T) {
	s := New(64)
	// R (root) → C (child, busy so it's active/loaded → known to emitter).
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("C", "R")},
		[2]string{"session.status", evStatus("C", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")
	snap := e.SnapshotFrontier("cold")
	if _, ok := nodesByID(snap)["C"]; !ok {
		t.Fatalf("C should be in frontier (active child), got %d nodes", len(snap.Nodes))
	}

	// Archive R WITHOUT cascade (direct mutation).
	setArchivedInfoLocked(s, "R")

	// Emit orphan-check for R's subtree.
	s.EmitOrphanCheck([]string{"R", "C"})

	// Translate the orphan-check events.
	evs, _, _ := s.Replay(0)
	var orphanOps []TreeOp
	for _, ev := range evs {
		if ev.Kind == "tree.orphan" {
			orphanOps = append(orphanOps, e.Translate(ev)...)
		}
	}

	// Assert: C gets orphan=true facet.
	var foundC bool
	for _, op := range orphanOps {
		id, orphan, ok := facetOrphan(op)
		if !ok {
			continue
		}
		if id == "C" {
			foundC = true
			if !orphan {
				t.Errorf("C should have orphan=true, got false")
			}
		}
	}
	if !foundC {
		t.Errorf("expected orphan facet for C, got %d orphan ops", len(orphanOps))
	}
}

// TestOrphan_EmitFacet_LiveRootNotOrphan proves a live-rooted session gets
// orphan=false (or no facet change) from the orphan-check.
func TestOrphan_EmitFacet_LiveRootNotOrphan(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("C", "R")},
		[2]string{"session.status", evStatus("C", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")
	snap := e.SnapshotFrontier("cold")
	if _, ok := nodesByID(snap)["C"]; !ok {
		t.Fatalf("C should be in frontier")
	}

	// No archive change — root is live.
	s.EmitOrphanCheck([]string{"C"})

	evs, _, _ := s.Replay(0)
	for _, ev := range evs {
		if ev.Kind != "tree.orphan" {
			continue
		}
		ops := e.Translate(ev)
		for _, op := range ops {
			id, orphan, ok := facetOrphan(op)
			if !ok {
				continue
			}
			if id == "C" && orphan {
				t.Errorf("C under live root R should have orphan=false, got true")
			}
		}
	}
}

// TestOrphan_DeleteReparenting proves the deleteSessionLocked hook emits
// orphan-check for newly-rooted children after a delete reparents them.
func TestOrphan_DeleteReparenting(t *testing.T) {
	s := New(64)
	// R (root) → M (mid) → D (deep). M and D are busy (active → in frontier).
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("M", "R")},
		[2]string{"session.created", evSessionCreated("D", "M")},
		[2]string{"session.status", evStatus("M", "busy")},
		[2]string{"session.status", evStatus("D", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")
	snap := e.SnapshotFrontier("cold")
	byID := nodesByID(snap)
	if _, ok := byID["M"]; !ok {
		t.Fatalf("M should be in frontier")
	}
	if _, ok := byID["D"]; !ok {
		t.Fatalf("D should be in frontier")
	}

	// Delete R → M becomes a new root, D is child of M.
	// (Apply session.deleted for R; deleteSessionLocked re-roots M and emits
	// orphan-check for M's subtree.)
	s.Apply(ev("session.deleted", `{"info":{"id":"R"}}`))

	// Translate ALL events since snapshot to collect orphan-check facets.
	evs, _, _ := s.Replay(0)
	var orphanFacets []TreeOp
	for _, ev := range evs {
		ops := e.Translate(ev)
		orphanFacets = append(orphanFacets, ops...)
	}

	// After reparenting: M is a root (orphan=false), D's root is M (live → orphan=false).
	gotOrphan := map[string]bool{}
	for _, op := range orphanFacets {
		id, orphan, ok := facetOrphan(op)
		if ok {
			gotOrphan[id] = orphan
		}
	}
	// Both M and D should have been checked and gotten orphan=false.
	for _, id := range []string{"M", "D"} {
		v, ok := gotOrphan[id]
		if !ok {
			t.Errorf("expected orphan facet for %s after reparenting, not found", id)
			continue
		}
		if v {
			t.Errorf("%s should have orphan=false after reparenting to live root, got true", id)
		}
	}
}

// TestOrphan_UnknownNodeSkipped proves the emitter does NOT emit orphan facets
// for nodes the client doesn't hold (collapsed/unseen).
func TestOrphan_UnknownNodeSkipped(t *testing.T) {
	s := New(64)
	// R (root) → C (child, IDLE so NOT in frontier).
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("C", "R")},
	)
	e := NewTreeEmitter(s, "/proj")
	snap := e.SnapshotFrontier("cold")
	// C is idle under root R → NOT in frontier (only roots + active paths ship).
	if _, ok := nodesByID(snap)["C"]; ok {
		t.Fatalf("idle C should NOT be in frontier (only roots + active paths)")
	}

	// Archive R and emit orphan-check.
	setArchivedInfoLocked(s, "R")
	s.EmitOrphanCheck([]string{"C"})

	evs, _, _ := s.Replay(0)
	for _, ev := range evs {
		if ev.Kind != "tree.orphan" {
			continue
		}
		ops := e.Translate(ev)
		if len(ops) > 0 {
			t.Errorf("emitter should skip orphan facet for unknown node C, got %d ops", len(ops))
		}
	}
}
