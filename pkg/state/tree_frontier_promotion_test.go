package state

// tree_frontier_promotion_test.go — RED→GREEN tests for the tree=2 live
// frontier-promotion fix (the "new active subsession doesn't appear until F5"
// gap).
//
// Root cause: e.ec (the per-connection loaded-set E_c) was only ever grown by
// SnapshotFrontier (cold) and MarkLoaded (explicit expand) — NEVER on a live
// create/activity event. So once a connection drifted into the gap state (the
// client shows a parent EXPANDED but the emitter's e.ec[parent]=false after a
// non-destructive resync), every new child was suppressed as a count-only facet
// (onSessionUpsertLocked's collapsed-parent gate) until a full reload
// (SnapshotFrontier recomputing the active path WITH the new child).
//
// The fix adds promoteActiveFrontierLocked: when a node becomes active on a
// live activity/create/permission/question event, it promotes the node's
// inclusive ancestor chain into loaded/E_c and ships the previously-unshipped
// chain nodes (parent-before-child), mirroring SnapshotFrontier's activePath
// seeding live.

import (
	"testing"
)

// --- small op-inspection helpers (test-only) ---

// upsertByID returns the first NodeUpsert op whose Node.ID == id, or nil.
func upsertByID(ops []TreeOp, id string) *NodeUpsert {
	for _, op := range ops {
		if u, ok := op.(*NodeUpsert); ok && u.Node.ID == id {
			return u
		}
	}
	return nil
}

// upsertIDs returns the IDs of every NodeUpsert op, in emit order.
func upsertIDs(ops []TreeOp) []string {
	out := make([]string, 0, len(ops))
	for _, op := range ops {
		if u, ok := op.(*NodeUpsert); ok {
			out = append(out, u.Node.ID)
		}
	}
	return out
}

// upsertBefore reports whether a NodeUpsert for a precedes one for b in ops.
func upsertBefore(ops []TreeOp, a, b string) bool {
	ia, ib := -1, -1
	for i, op := range ops {
		u, ok := op.(*NodeUpsert)
		if !ok {
			continue
		}
		if u.Node.ID == a && ia < 0 {
			ia = i
		}
		if u.Node.ID == b && ib < 0 {
			ib = i
		}
	}
	return ia >= 0 && ib >= 0 && ia < ib
}

// ---------------------------------------------------------------------------
// PRIMARY symptom — activity path (the load-bearing hook)
// ---------------------------------------------------------------------------

// TestFrontierPromotion_ActiveChildShipsLive builds the gap state with NO
// direct e.ec manipulation: an idle root R (no active descendants) snapshots
// collapsed (loaded:false, e.ec[R]=false). A new child C created under R is
// idle at create time → suppressed. When C subsequently goes busy, the activity
// event must promote R→loaded:true and ship C loaded:true so C appears live
// (no F5). Before the fix the busy event no-ops (C unknown) and C never ships.
func TestFrontierPromotion_ActiveChildShipsLive(t *testing.T) {
	s := New(64)
	applySeq(t, s, [2]string{"session.created", evSessionCreated("R", "")})
	e := NewTreeEmitter(s, "/proj")
	snap := e.SnapshotFrontier("cold")
	byID := nodesByID(snap)

	// Sanity: idle root R shipped collapsed, NOT on the active path.
	if _, ok := byID["R"]; !ok {
		t.Fatalf("setup: idle root R should ship as a root placeholder")
	}
	if byID["R"].Loaded {
		t.Fatalf("setup invariant: idle root R should be loaded:false, got loaded:true")
	}
	if e.ec["R"] {
		t.Fatalf("setup invariant: e.ec[R] should be false (R not on active path)")
	}

	// Create C under R (idle at create → suppressed under collapsed R).
	applySeq(t, s, [2]string{"session.created", evSessionCreated("C", "R")})
	createOps := e.Translate(lastEventOfKind(t, s, KindSessionUpsert))
	if hasNodeID(createOps, "C") {
		t.Fatalf("setup: idle C under collapsed R must NOT ship on create; got %v", opKinds(createOps))
	}

	// C goes busy → the load-bearing moment.
	applySeq(t, s, [2]string{"session.status", evStatus("C", "busy")})
	busyOps := e.Translate(lastEventOfKind(t, s, KindActivity))

	// RED assertion: C must ship as a real node (live frontier).
	if !hasNodeID(busyOps, "C") {
		t.Fatalf("PROMOTION: busy C should ship as node.upsert (live frontier); got %v", opKinds(busyOps))
	}
	// R must re-ship loaded:true (flipped collapsed→expanded so C is visible).
	rUp := upsertByID(busyOps, "R")
	if rUp == nil {
		t.Fatalf("PROMOTION: ancestor R should re-ship as node.upsert loaded:true; got upserts=%v", upsertIDs(busyOps))
	}
	if !rUp.Node.Loaded {
		t.Errorf("PROMOTION: R should re-ship loaded:true (expanded so C is visible), got loaded:false")
	}
	// INV-B: R (parent) before C (child) in the upsert stream.
	if !upsertBefore(busyOps, "R", "C") {
		t.Errorf("INV-B: R should ship before C in promotion upserts; order=%v", upsertIDs(busyOps))
	}
	// E_c / known re-aligned with the client.
	if !e.ec["R"] {
		t.Errorf("PROMOTION: e.ec[R] should be true after promotion")
	}
	if !e.known["C"] {
		t.Errorf("PROMOTION: e.known[C] should be true after promotion")
	}
}

// TestFrontierPromotion_DriftedCollapsedParent mirrors the operator's literal
// symptom: R→A(busy) snapshots with R on the active path (loaded:true,
// e.ec[R]=true), then a non-destructive resync drops e.ec[R] to false (the
// client still shows R expanded). A new active child C under R must still ship.
// This is the same construction as TestLoadedSet_ChildPushGated's e2.
func TestFrontierPromotion_DriftedCollapsedParent(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.status", evStatus("A", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold")
	if !e.ec["R"] {
		t.Fatalf("setup invariant: R on active path should have e.ec[R]=true after snapshot")
	}
	// Simulate the drift: client shows R expanded, emitter forgot.
	delete(e.ec, "R")

	// Create + activate C under R.
	applySeq(t, s, [2]string{"session.created", evSessionCreated("C", "R")})
	_ = e.Translate(lastEventOfKind(t, s, KindSessionUpsert)) // idle, suppressed
	applySeq(t, s, [2]string{"session.status", evStatus("C", "busy")})
	busyOps := e.Translate(lastEventOfKind(t, s, KindActivity))

	if !hasNodeID(busyOps, "C") {
		t.Fatalf("PROMOTION (drift): busy C should ship under drifted-collapsed R; got %v", opKinds(busyOps))
	}
	if upsertByID(busyOps, "R") == nil {
		t.Errorf("PROMOTION (drift): R should re-ship loaded:true; got upserts=%v", upsertIDs(busyOps))
	}
}

// ---------------------------------------------------------------------------
// Deep-chain promotion — multi-level ancestor chain ships parent-before-child.
// ---------------------------------------------------------------------------

// TestFrontierPromotion_DeepChainShipsAncestors asserts that when a deeply
// nested leaf goes active under a chain of collapsed ancestors, the WHOLE
// inclusive ancestor chain ships loaded:true in root→leaf order (INV-B).
func TestFrontierPromotion_DeepChainShipsAncestors(t *testing.T) {
	s := New(64)
	// R → M → L, all idle at snapshot → R ships collapsed; M, L never ship.
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("M", "R")},
		[2]string{"session.created", evSessionCreated("L", "M")},
	)
	e := NewTreeEmitter(s, "/proj")
	snap := e.SnapshotFrontier("cold")
	byID := nodesByID(snap)
	if _, ok := byID["M"]; ok {
		t.Fatalf("setup: idle M under collapsed R must not ship in cold load")
	}
	if _, ok := byID["L"]; ok {
		t.Fatalf("setup: idle L under collapsed R must not ship in cold load")
	}

	// L goes busy → promote chain R→M→L.
	applySeq(t, s, [2]string{"session.status", evStatus("L", "busy")})
	ops := e.Translate(lastEventOfKind(t, s, KindActivity))

	for _, id := range []string{"R", "M", "L"} {
		if !hasNodeID(ops, id) {
			t.Errorf("PROMOTION: chain node %q should ship as node.upsert; got upserts=%v", id, upsertIDs(ops))
		}
	}
	// INV-B: R before M before L.
	if !upsertBefore(ops, "R", "M") || !upsertBefore(ops, "M", "L") {
		t.Errorf("INV-B: expected R→M→L upsert order; got %v", upsertIDs(ops))
	}
	for _, id := range []string{"R", "M", "L"} {
		if up := upsertByID(ops, id); up != nil && !up.Node.Loaded {
			t.Errorf("PROMOTION: chain node %q should ship loaded:true", id)
		}
	}
}

// ---------------------------------------------------------------------------
// Idempotency — re-promoting an already-promoted active node is a no-op.
// ---------------------------------------------------------------------------

// TestFrontierPromotion_Idempotent asserts that after an active chain is fully
// promoted (snapshot), a subsequent activity event for the same active node
// does NOT re-ship the chain as node.upsert (promotion returns nil). Multiple
// activity events for one active node must not double-ship.
func TestFrontierPromotion_Idempotent(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("C", "R")},
		[2]string{"session.status", evStatus("C", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold") // R, C on active path → both loaded:true, E_c
	if !e.ec["R"] || !e.ec["C"] || !e.known["R"] || !e.known["C"] {
		t.Fatalf("setup invariant: snapshot should have promoted R+C; ec=%v known=%v", e.ec, e.known)
	}

	// Subsequent activity event (busy→retry, still active).
	applySeq(t, s, [2]string{"session.status", evStatus("C", "retry")})
	ops := e.Translate(lastEventOfKind(t, s, KindActivity))

	// Promotion must not re-ship R or C as node.upsert.
	if hasNodeID(ops, "R") || hasNodeID(ops, "C") {
		t.Errorf("IDEMPOTENT: activity for already-promoted active node should not re-ship R/C as node.upsert; got upserts=%v", upsertIDs(ops))
	}
}

// ---------------------------------------------------------------------------
// No-regression — lazy-frontier preserved (idle child stays count-only).
// ---------------------------------------------------------------------------

// TestFrontierPromotion_IdleChildStaysCountOnly asserts the active gate
// preserves lazy-frontier: a new IDLE child under a collapsed parent must NOT
// ship (the count-only suppression is unchanged). This is the explicit
// active-vs-idle contrast to the promotion tests above.
func TestFrontierPromotion_IdleChildStaysCountOnly(t *testing.T) {
	s := New(64)
	applySeq(t, s, [2]string{"session.created", evSessionCreated("R", "")})
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold") // R collapsed (idle root), e.ec[R]=false

	applySeq(t, s, [2]string{"session.created", evSessionCreated("C", "R")})
	ops := e.Translate(lastEventOfKind(t, s, KindSessionUpsert))

	if hasNodeID(ops, "C") {
		t.Errorf("IDLE GATE: idle C under collapsed R must NOT ship (lazy frontier preserved); got upserts=%v", upsertIDs(ops))
	}
	// An idle status event for the unknown child must also not promote it.
	applySeq(t, s, [2]string{"session.idle", evIdle("C")})
	idleOps := e.Translate(lastEventOfKind(t, s, KindActivity))
	if hasNodeID(idleOps, "C") {
		t.Errorf("IDLE GATE: idle activity for C must NOT ship it; got upserts=%v", upsertIDs(idleOps))
	}
}

// ---------------------------------------------------------------------------
// Permission / Question hooks — a subsession that immediately asks is active.
// ---------------------------------------------------------------------------

// TestFrontierPromotion_PermissionAskedShipsNode asserts that a subsession that
// immediately asks a permission (no prior busy transition) is active via the
// permission branch of isActiveLocked, and the permission event promotes it.
func TestFrontierPromotion_PermissionAskedShipsNode(t *testing.T) {
	s := New(64)
	applySeq(t, s, [2]string{"session.created", evSessionCreated("R", "")})
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold") // R collapsed
	applySeq(t, s, [2]string{"session.created", evSessionCreated("C", "R")})
	_ = e.Translate(lastEventOfKind(t, s, KindSessionUpsert)) // idle, suppressed

	s.Apply(ev("permission.asked", evPermissionAsked("C", "perm1")))
	ops := e.Translate(lastEventOfKind(t, s, KindPermissionSet))
	if !hasNodeID(ops, "C") {
		t.Fatalf("PROMOTION (permission): C with pending permission should ship; got upserts=%v", upsertIDs(ops))
	}
}

// TestFrontierPromotion_QuestionAskedShipsNode asserts the question branch:
// a subsession that immediately asks a question is active and ships live.
func TestFrontierPromotion_QuestionAskedShipsNode(t *testing.T) {
	s := New(64)
	applySeq(t, s, [2]string{"session.created", evSessionCreated("R", "")})
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold")
	applySeq(t, s, [2]string{"session.created", evSessionCreated("C", "R")})
	_ = e.Translate(lastEventOfKind(t, s, KindSessionUpsert)) // idle, suppressed

	s.Apply(ev("question.asked", evQuestionAsked("C", "q1")))
	ops := e.Translate(lastEventOfKind(t, s, KindQuestionSet))
	if !hasNodeID(ops, "C") {
		t.Fatalf("PROMOTION (question): C with pending question should ship; got upserts=%v", upsertIDs(ops))
	}
}
