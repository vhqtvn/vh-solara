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

// ---------------------------------------------------------------------------
// Archive-defect-chain Slice 1 — authoritative archived-ID snapshot + Defect-3
// backstop sweep (RT2 Go portion: flag survives rehydrate + daemon restart;
// RT3 Go portion: live/unresolvable chain root never flagged).
//
// The live store cannot be the orphan authority: RemoveSessions drops the
// archived parent, so a straggler child's parentID points at a session absent
// from the live store. The tombstone (recentlyArchived) is in-memory, 30s TTL,
// and lost on restart — so the ONLY cross-restart authority is OpenCode's
// archived-session list, captured in Store.archivedSnapshot and rebuilt by
// RefreshArchivedSnapshot (hydrate + each 5s reconcile). These tests pin that
// the snapshot-backed sweep flags stragglers across rehydrate AND a fresh-store
// restart (RT2 crux), and never flags a live/unresolvable root (RT3, the e88f19e
// false-positive gate).
// ---------------------------------------------------------------------------

// archivedSessionInfo builds a session JSON carrying time.archived (the shape
// ListArchivedSessions returns), so a test can feed RefreshArchivedSnapshot the
// authoritative archived-set payload without a real HTTP fetch.
func archivedSessionInfo(id string) json.RawMessage {
	return sessInfo(id, "", 1700000000)
}

// TestTreeOrphan_RT2_RehydrateKeepsFlag pins RT2(a): after a parent is archived
// (leaves the live store + arms the tombstone) and the store is rehydrated, the
// live child still carries flags.orphan because the snapshot — rebuilt from
// OpenCode's archived list — is the authority, not the in-memory tombstone.
func TestTreeOrphan_RT2_RehydrateKeepsFlag(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("P", "")},
		[2]string{"session.created", evSessionCreated("C", "P")},
	)
	// Archive P: RemoveSessions drops P from the live store + arms the tombstone.
	s.RemoveSessions([]string{"P"})

	// Simulate rehydrate: OpenCode's /session lists C (live) but NOT P (archived
	// — it is excluded from the default list). Hydrate reconciles: C re-inserted
	// (parentID still P), P absent (already deleted by RemoveSessions).
	s.Hydrate([]json.RawMessage{sessInfo("C", "P", 0)}, nil)

	// Build the authoritative archived snapshot from OpenCode's archived list,
	// then sweep. P is archived → snapshot{P:true} → C flagged.
	s.RefreshArchivedSnapshot([]json.RawMessage{archivedSessionInfo("P")})

	if !s.IsOrphanFlagged("C") {
		t.Errorf("RT2(a): C should carry flags.orphan after rehydrate (snapshot authority)")
	}
}

// TestTreeOrphan_RT2_RestartKeepsFlag is the CRUX of RT2(b): a FRESH store
// (tombstones empty — simulating a daemon restart) hydrates from OpenCode and
// the child STILL carries flags.orphan, because the authoritative snapshot — not
// the lost tombstone — is the authority. Without the snapshot this case fails:
// the fresh store has no way to know P was archived, so C would classify as a
// plain root and never be flagged (the Defect-2 false-negative).
func TestTreeOrphan_RT2_RestartKeepsFlag(t *testing.T) {
	// Fresh store: tombstones empty (daemon restart simulation).
	s := New(64)

	// Hydrate from OpenCode: /session lists C (live); P is archived and thus
	// excluded from the default list. C's parentID points at the absent P.
	s.Hydrate([]json.RawMessage{sessInfo("C", "P", 0)}, nil)

	// Confirm the tombstone is empty (restart precondition): without the
	// snapshot, nothing here knows P was archived.
	if s.IsRecentlyArchived("P") {
		t.Fatalf("precondition: fresh store must have empty tombstone for P")
	}

	// Build the snapshot from the archived list (the cross-restart authority).
	s.RefreshArchivedSnapshot([]json.RawMessage{archivedSessionInfo("P")})

	// CRUX: tombstones empty, but the snapshot is authoritative → C flagged.
	if !s.IsOrphanFlagged("C") {
		t.Errorf("RT2(b) crux: C should carry flags.orphan after daemon restart (snapshot, not tombstone, is authority)")
	}
}

// TestTreeOrphan_RT2_DeepChain walks a multi-hop chain: grandchild G → child C →
// archived parent P. The sweep must walk through the LIVE intermediate (C) and
// flag G because the chain terminates at the archived P.
func TestTreeOrphan_RT2_DeepChain(t *testing.T) {
	s := New(64)
	// P archived (absent from /session); C and G are live, C's parent is P,
	// G's parent is C. Only C and G appear in /session.
	s.Hydrate([]json.RawMessage{
		sessInfo("C", "P", 0),
		sessInfo("G", "C", 0),
	}, nil)
	s.RefreshArchivedSnapshot([]json.RawMessage{archivedSessionInfo("P")})

	if !s.IsOrphanFlagged("C") {
		t.Errorf("deep chain: C (direct child of archived P) should be flagged")
	}
	if !s.IsOrphanFlagged("G") {
		t.Errorf("deep chain: G (grandchild via live C) should be flagged — chain terminates at archived P")
	}
}

// TestTreeOrphan_RT3_LiveRootNeverFlagged pins RT3: a live session whose
// parent-chain root is LIVE (in the store, not archived) is NEVER flagged orphan,
// even when the archived snapshot contains unrelated ids. This is the e88f19e
// false-positive gate, preserved.
func TestTreeOrphan_RT3_LiveRootNeverFlagged(t *testing.T) {
	s := New(64)
	// R (live root) → C (live child). Snapshot contains an unrelated archived X.
	s.Hydrate([]json.RawMessage{
		sessInfo("R", "", 0),
		sessInfo("C", "R", 0),
	}, nil)
	s.RefreshArchivedSnapshot([]json.RawMessage{archivedSessionInfo("X")})

	if s.IsOrphanFlagged("R") {
		t.Errorf("RT3: live root R should NOT be flagged orphan")
	}
	if s.IsOrphanFlagged("C") {
		t.Errorf("RT3: child C of live root R should NOT be flagged orphan")
	}
}

// TestTreeOrphan_RT3_UnresolvableParentNeverFlagged pins RT3: a live session
// whose parent NEVER existed (absent from the live store AND absent from the
// archived snapshot) is NEVER flagged orphan. The snapshot is the discriminator:
// without a confirmed-archived parent, the chain is "unresolvable", not orphan.
func TestTreeOrphan_RT3_UnresolvableParentNeverFlagged(t *testing.T) {
	s := New(64)
	// C's parent P never existed. Snapshot contains an unrelated archived X
	// (proving the gate keys on the ACTUAL terminating parent, not any archived id).
	s.Hydrate([]json.RawMessage{sessInfo("C", "P", 0)}, nil)
	s.RefreshArchivedSnapshot([]json.RawMessage{archivedSessionInfo("X")})

	if s.IsOrphanFlagged("C") {
		t.Errorf("RT3: child C whose parent P is unresolvable (not in snapshot) should NOT be flagged orphan")
	}
}

// TestTreeOrphan_SweepClearsStaleFlag pins the idempotent re-evaluation: after a
// parent leaves the archived snapshot (a legitimate un-archive), the child's
// stale orphan flag must be cleared by the next sweep.
func TestTreeOrphan_SweepClearsStaleFlag(t *testing.T) {
	s := New(64)
	s.Hydrate([]json.RawMessage{sessInfo("C", "P", 0)}, nil)
	// P archived → C flagged.
	s.RefreshArchivedSnapshot([]json.RawMessage{archivedSessionInfo("P")})
	if !s.IsOrphanFlagged("C") {
		t.Fatalf("setup: C should be flagged after P archived")
	}
	// P un-archived (legit unarchive) → leaves the snapshot. Empty archived set.
	s.RefreshArchivedSnapshot(nil)
	if s.IsOrphanFlagged("C") {
		t.Errorf("sweep: C flag should clear after parent leaves the snapshot (unarchive)")
	}
}

// TestTreeOrphan_IsArchivedAuthoritativeAccessor pins the read accessor Slice 2
// consumes: it reports snapshot membership under the store lock, distinct from
// the in-memory tombstone.
func TestTreeOrphan_IsArchivedAuthoritativeAccessor(t *testing.T) {
	s := New(64)
	s.Hydrate(nil, nil)
	// Empty snapshot before any refresh.
	s.mu.RLock()
	if s.isArchivedAuthoritativeLocked("P") {
		t.Errorf("accessor: empty snapshot should report P not archived")
	}
	s.mu.RUnlock()
	s.RefreshArchivedSnapshot([]json.RawMessage{archivedSessionInfo("P")})
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.isArchivedAuthoritativeLocked("P") {
		t.Errorf("accessor: snapshot should report P archived after refresh")
	}
	if s.isArchivedAuthoritativeLocked("Q") {
		t.Errorf("accessor: snapshot should report Q not archived")
	}
}
