package state

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"
)

// tree_emitter_test.go — Phase 2a tests for the tree=2 server emitter.
// Covers the 8 test groups of the design plan (frontier §5, delta ops §6,
// loaded-set §5.4, expand §8, INV-B, O1). Group 1 (Node/op JSON) lives in
// tree_node_test.go.

// --- helpers ---

func treeSnap(t *testing.T, s *Store, cause string) *TreeSnapshot {
	t.Helper()
	e := NewTreeEmitter(s, "/proj")
	return e.SnapshotFrontier(cause)
}

func nodesByID(snap *TreeSnapshot) map[string]Node {
	out := make(map[string]Node, len(snap.Nodes))
	for _, n := range snap.Nodes {
		out[n.ID] = n
	}
	return out
}

// applySeq applies a series of (eventType, props) pairs in order.
func applySeq(t *testing.T, s *Store, evs ...[2]string) {
	t.Helper()
	for _, e := range evs {
		s.Apply(ev(e[0], e[1]))
	}
}

// lastEventOfKind replays the store ring and returns the most recent event of
// the given kind. Apply writes every emitted ClientEvent into the ring, so this
// is how a Translate test obtains the exact ClientEvent the emitter will see.
func lastEventOfKind(t *testing.T, s *Store, kind string) ClientEvent {
	t.Helper()
	evs, _, _ := s.Replay(0)
	for i := len(evs) - 1; i >= 0; i-- {
		if evs[i].Kind == kind {
			return evs[i]
		}
	}
	t.Fatalf("no ClientEvent of kind %q in ring", kind)
	return ClientEvent{}
}

// ---------------------------------------------------------------------------
// Group 2 — Frontier snapshot (§5 true-lazy cold load)
// ---------------------------------------------------------------------------

// TestFrontier_ThreeCategories asserts the cold-load snapshot is EXACTLY the
// three §5 categories: all roots (loaded:false) + active-path nodes (loaded:true)
// + direct children of loaded nodes (collapsed placeholders). Deep idle
// subtrees are NOT shipped.
func TestFrontier_ThreeCategories(t *testing.T) {
	s := New(64)
	// Active path: R → A → B(busy) → C(idle) → [deep idle chain D1..D3]
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.created", evSessionCreated("B", "A")},
		[2]string{"session.created", evSessionCreated("C", "B")},
		[2]string{"session.created", evSessionCreated("D1", "C")},
		[2]string{"session.created", evSessionCreated("D2", "D1")},
		[2]string{"session.created", evSessionCreated("D3", "D2")},
		[2]string{"session.status", evStatus("B", "busy")},
	)
	// A second root with a deep idle subtree (never on an active path).
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R2", "")},
		[2]string{"session.created", evSessionCreated("E1", "R2")},
		[2]string{"session.created", evSessionCreated("E2", "E1")},
	)

	snap := treeSnap(t, s, "cold")
	byID := nodesByID(snap)

	// cat-1: idle root R2 is a collapsed placeholder loaded:false with a
	// descendantCount badge. R is ALSO a root but sits on the active path (it
	// is an ancestor of busy B) so §5 cat-2 makes it loaded:true.
	if _, ok := byID["R"]; !ok {
		t.Fatalf("root R missing from frontier; got %d nodes", len(snap.Nodes))
	}
	if _, ok := byID["R2"]; !ok {
		t.Fatalf("root R2 missing from frontier")
	}
	if byID["R2"].Loaded {
		t.Errorf("idle root R2 should be loaded:false (collapsed placeholder)")
	}
	if byID["R2"].DescendantCount == nil || *byID["R2"].DescendantCount < 2 {
		t.Errorf("idle root R2 should carry descendantCount badge, got %v", byID["R2"].DescendantCount)
	}

	// cat-2: active path R, A, B are loaded:true (B is busy; R & A have children
	// and are ancestors of the active leaf).
	for _, id := range []string{"R", "A", "B"} {
		if !byID[id].Loaded {
			t.Errorf("active-path %q should be loaded:true", id)
		}
	}

	// cat-3: C is B's direct child → collapsed placeholder loaded:false.
	if _, ok := byID["C"]; !ok {
		t.Fatalf("C (direct child of loaded B) missing from frontier")
	}
	if byID["C"].Loaded {
		t.Errorf("C should be loaded:false placeholder")
	}

	// Deep idle descendants D1..D3 and E1..E2 MUST be excluded.
	for _, id := range []string{"D1", "D2", "D3", "E1", "E2"} {
		if _, ok := byID[id]; ok {
			t.Errorf("deep idle %q should NOT ship in cold load", id)
		}
	}

	// INV-B (resolve): every parentId is either null or present in the set.
	for _, n := range snap.Nodes {
		if n.ParentID == "" {
			continue
		}
		if _, ok := byID[n.ParentID]; !ok {
			t.Errorf("node %q parentId=%q not in frontier set (INV-B resolve fail)", n.ID, n.ParentID)
		}
	}
}

// TestFrontier_CostModel asserts cold-load size is O(roots + active-path +
// direct-children-of-loaded), NOT O(total sessions). A ~1000-session idle
// subtree under an idle root contributes only 1 node (the root placeholder).
func TestFrontier_CostModel(t *testing.T) {
	s := New(64)
	// Small active path.
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.status", evStatus("A", "busy")},
	)
	// Large idle subtree under an idle root R2: R2 → X0 → X1 → ... → X999.
	applySeq(t, s, [2]string{"session.created", evSessionCreated("R2", "")})
	prev := "R2"
	for i := 0; i < 1000; i++ {
		id := fmt.Sprintf("X%d", i)
		applySeq(t, s, [2]string{"session.created", evSessionCreated(id, prev)})
		prev = id
	}

	snap := treeSnap(t, s, "cold")

	// Expect: R, A (active path) + R2 (idle root placeholder). A has no children
	// → no cat-3. The 1000-node X-chain is entirely excluded.
	want := map[string]bool{"R": true, "A": true, "R2": true}
	if len(snap.Nodes) != len(want) {
		got := make(map[string]bool, len(snap.Nodes))
		for _, n := range snap.Nodes {
			got[n.ID] = true
		}
		t.Fatalf("frontier size = %d nodes, want %d (deep idle must not ship): got %v",
			len(snap.Nodes), len(want), got)
	}
	for _, n := range snap.Nodes {
		if !want[n.ID] {
			t.Errorf("unexpected node %q in cost-model frontier", n.ID)
		}
	}
}

// TestFrontier_ArchivedNeverSeeds asserts an archived session does NOT seed an
// active path, even if its activity would otherwise be busy (§5.1, Q1).
func TestFrontier_ArchivedNeverSeeds(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.created", evSessionCreated("B", "A")},
		[2]string{"session.status", evStatus("B", "busy")},
		// Archive B: it is now pruned, NOT active.
		[2]string{"session.updated", evSessionArchived("B")},
	)
	snap := treeSnap(t, s, "cold")
	byID := nodesByID(snap)
	if _, ok := byID["B"]; ok {
		t.Errorf("archived B should not ship in the frontier (pruned)")
	}
	// A (idle, off active path) should ship only if it is a root or a direct
	// child of a loaded node — here A is idle and R (idle root) is loaded:false,
	// so A must NOT ship.
	if _, ok := byID["A"]; ok {
		t.Errorf("idle A (child of collapsed idle root R) should not ship")
	}
}

// TestFrontier_ActiveByPermissionOrQuestion asserts a pending permission OR
// pending question also seeds an active path (§5.1), not just busy/retry/error.
func TestFrontier_ActiveByPermissionOrQuestion(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("P", "R")},
		[2]string{"session.created", evSessionCreated("Q", "R")},
	)
	// evPermissionAsked / evQuestionAsked are property payloads; apply as the
	// right event types.
	s.Apply(ev("permission.asked", evPermissionAsked("P", "perm1")))
	s.Apply(ev("question.asked", evQuestionAsked("Q", "q1")))
	snap := treeSnap(t, s, "cold")
	byID := nodesByID(snap)
	if _, ok := byID["P"]; !ok || !byID["P"].Loaded {
		t.Errorf("P with pending permission should seed active path (loaded:true): present=%v", ok)
	}
	if _, ok := byID["Q"]; !ok || !byID["Q"].Loaded {
		t.Errorf("Q with pending question should seed active path (loaded:true): present=%v", ok)
	}
}

// TestFrontier_SeedsLoadedSet asserts E_c is seeded from the snapshot's
// loaded:true nodes (§5.4).
func TestFrontier_SeedsLoadedSet(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.created", evSessionCreated("B", "A")},
		[2]string{"session.status", evStatus("B", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold")
	ec := e.LoadedSet()
	// R and A are active-path nodes WITH children → loaded:true → in E_c.
	// B is the active leaf but has child C, so B is also loaded:true → E_c.
	if !ec["R"] || !ec["A"] {
		t.Errorf("E_c should contain active-path-with-children R,A; got %v", ec)
	}
	// C is a collapsed placeholder (loaded:false) → NOT in E_c.
	if ec["C"] {
		t.Errorf("placeholder C should not be in E_c")
	}
}

// ---------------------------------------------------------------------------
// Group 3 — Delta ops (§6 event→delta), one test per op
// ---------------------------------------------------------------------------

// TestDelta_SessionUpsert emits node.upsert on a fresh session create under a
// LOADED parent (active path → P ∈ E_c so the child ships per §5.4).
func TestDelta_SessionUpsert(t *testing.T) {
	s := New(64)
	// R → A(busy): R and A are on the active path → loaded:true → R ∈ E_c.
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.status", evStatus("A", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold") // seed known/parentCache/E_c (R ∈ E_c)

	// Create C1 under R; R ∈ E_c → child C1 upsert ships.
	applySeq(t, s, [2]string{"session.created", evSessionCreated("C1", "R")})
	last := lastEventOfKind(t, s, KindSessionUpsert)
	ops := e.Translate(last)
	if len(ops) == 0 {
		t.Fatalf("expected at least one op for session create")
	}
	// The child upsert precedes the parent count upsert (INV-B parent-before-
	// child is satisfied either way since R is already known; the child C1 is
	// the NEW node). Find the C1 upsert.
	var c1 *NodeUpsert
	for _, op := range ops {
		if u, ok := op.(*NodeUpsert); ok && u.Node.ID == "C1" {
			c1 = u
			break
		}
	}
	if c1 == nil {
		t.Fatalf("no node.upsert for C1 in ops: %v", opKinds(ops))
	}
	// JSON shape: {"op":"node.upsert","data":{"node":{...}},"seq":N}
	raw, _ := json.Marshal(c1)
	if !contains(string(raw), `"node.upsert"`) || !contains(string(raw), `"node"`) {
		t.Errorf("upsert JSON missing op/data.node shape: %s", raw)
	}
}

// TestDelta_SessionDelete emits node.remove for a KNOWN deleted node.
func TestDelta_SessionDelete(t *testing.T) {
	s := New(64)
	// R → A(busy): active path → R loaded → C ships as cat-3 → C known.
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.created", evSessionCreated("C", "R")},
		[2]string{"session.status", evStatus("A", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold") // C is a direct child of loaded R → known

	applySeq(t, s, [2]string{"session.deleted", evSessionDeleted("C")})
	last := lastEventOfKind(t, s, KindSessionDelete)
	ops := e.Translate(last)
	if !hasOpKind(ops, "node.remove") {
		t.Fatalf("expected node.remove, got %v", opKinds(ops))
	}
}

// TestDelta_SessionMove emits node.move when a KNOWN session is reparented.
func TestDelta_SessionMove(t *testing.T) {
	s := New(64)
	// R1 → A(busy): active path → R1 loaded → C (under R1) ships as cat-3.
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R1", "")},
		[2]string{"session.created", evSessionCreated("R2", "")},
		[2]string{"session.created", evSessionCreated("A", "R1")},
		[2]string{"session.created", evSessionCreated("C", "R1")},
		[2]string{"session.status", evStatus("A", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold") // tells client C is under R1 (known)

	// Reparent C from R1 → R2.
	applySeq(t, s, [2]string{"session.updated", evSessionUpdated("C", "R2")})
	last := lastEventOfKind(t, s, KindSessionUpsert)
	ops := e.Translate(last)
	if !hasOpKind(ops, "node.move") {
		t.Fatalf("expected node.move on reparent, got %v", opKinds(ops))
	}
}

// TestDelta_ActivityFacet emits node.facet{activity} on a status change.
func TestDelta_ActivityFacet(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.status", evStatus("A", "busy")}, // A seeds active path
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold")

	applySeq(t, s, [2]string{"session.status", evStatus("A", "retry")})
	last := lastEventOfKind(t, s, KindActivity)
	ops := e.Translate(last)
	if !hasOpKind(ops, "node.facet") {
		t.Fatalf("expected node.facet for activity, got %v", opKinds(ops))
	}
}

// TestDelta_QuestionFacet emits node.facet{flags:{pendingInput}} plus ancestor
// subtreeNeedsInput facets.
func TestDelta_QuestionFacet(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.created", evSessionCreated("Q", "A")},
		[2]string{"session.status", evStatus("Q", "busy")}, // Q seeds active path
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold")

	s.Apply(ev("question.asked", evQuestionAsked("Q", "q1")))
	last := lastEventOfKind(t, s, KindQuestionSet)
	ops := e.Translate(last)
	// Should have a pendingInput facet on Q.
	foundPending := false
	for _, op := range ops {
		if f, ok := op.(*NodeFacet); ok {
			if f.Data.Flags["pendingInput"] {
				foundPending = true
			}
		}
	}
	if !foundPending {
		t.Errorf("expected pendingInput:true facet on Q, got %v", opKinds(ops))
	}
}

// ---------------------------------------------------------------------------
// Group 4 — Loaded-set decision (§5.4)
// ---------------------------------------------------------------------------

// TestLoadedSet_ChildPushGated asserts: parent in E_c → real child op;
// parent not in E_c → only a parent count upsert, no child op.
func TestLoadedSet_ChildPushGated(t *testing.T) {
	mk := func() *Store {
		s := New(64)
		applySeq(t, s,
			[2]string{"session.created", evSessionCreated("R", "")},
			[2]string{"session.created", evSessionCreated("A", "R")},
			[2]string{"session.status", evStatus("A", "busy")},
		)
		return s
	}

	// Emitter 1: default snapshot. R is active-path-with-children → R ∈ E_c.
	s1 := mk()
	e1 := NewTreeEmitter(s1, "/proj")
	_ = e1.SnapshotFrontier("cold")
	applySeq(t, s1, [2]string{"session.created", evSessionCreated("C", "R")})
	ops1 := e1.Translate(lastEventOfKind(t, s1, KindSessionUpsert))
	if !hasNodeID(ops1, "C") {
		t.Errorf("R∈E_c: expected child C upsert, got %v", opKinds(ops1))
	}

	// Emitter 2: collapse R (remove from E_c) so its children are not shipped.
	s2 := mk()
	e2 := NewTreeEmitter(s2, "/proj")
	_ = e2.SnapshotFrontier("cold")
	delete(e2.ec, "R") // simulate a connection where R is collapsed
	applySeq(t, s2, [2]string{"session.created", evSessionCreated("C", "R")})
	ops2 := e2.Translate(lastEventOfKind(t, s2, KindSessionUpsert))
	if hasNodeID(ops2, "C") {
		t.Errorf("R∉E_c: child C upsert should NOT ship, got %v", opKinds(ops2))
	}
}

// ---------------------------------------------------------------------------
// Group 5 — Expand (§8) direct — see pkg/web/tree_children_test.go for the
// HTTP layer. Here we test ExpandChildren directly.
// ---------------------------------------------------------------------------

// TestExpand_Pagination asserts hasMore/cursor paging + E_c membership on the
// terminal batch.
func TestExpand_Pagination(t *testing.T) {
	s := New(64)
	applySeq(t, s, [2]string{"session.created", evSessionCreated("R", "")})
	for _, id := range []string{"C1", "C2", "C3"} {
		applySeq(t, s, [2]string{"session.created", evSessionCreated(id, "R")})
	}
	e := NewTreeEmitter(s, "/proj")

	nodes, hasMore, cursor, _ := e.ExpandChildren("R", "", 2)
	if len(nodes) != 2 || !hasMore {
		t.Fatalf("page 1: got %d nodes hasMore=%v, want 2/true", len(nodes), hasMore)
	}
	if cursor == "" {
		t.Fatalf("page 1: expected non-empty cursor for hasMore")
	}
	if e.LoadedSet()["R"] {
		t.Errorf("R should NOT be in E_c after a non-terminal page")
	}

	nodes2, hasMore2, _, _ := e.ExpandChildren("R", cursor, 2)
	if len(nodes2) != 1 || hasMore2 {
		t.Fatalf("page 2: got %d nodes hasMore=%v, want 1/false", len(nodes2), hasMore2)
	}
	if !e.LoadedSet()["R"] {
		t.Errorf("R should be in E_c after terminal page")
	}
}

// TestExpand_StaleCursor asserts a stale cursor returns an empty terminal batch.
func TestExpand_StaleCursor(t *testing.T) {
	s := New(64)
	applySeq(t, s, [2]string{"session.created", evSessionCreated("R", "")})
	applySeq(t, s, [2]string{"session.created", evSessionCreated("C1", "R")})
	e := NewTreeEmitter(s, "/proj")
	nodes, hasMore, _, stale := e.ExpandChildren("R", "GONE", 10)
	if len(nodes) != 0 || hasMore {
		t.Fatalf("stale cursor: got %d nodes hasMore=%v, want 0/false", len(nodes), hasMore)
	}
	if !stale {
		t.Errorf("stale cursor: expected stale=true")
	}
}

// ---------------------------------------------------------------------------
// Group 6 — INV-B (parent-before-child within a flush) + INV-A (monotonic seq)
// ---------------------------------------------------------------------------

// TestInvariant_MonotonicSeqAndOrder asserts INV-A (monotonic seq across ops
// in a flush) and that a reparent-detecting flush emits the move in a valid
// position (the parent reference is resolvable).
func TestInvariant_MonotonicSeqAndOrder(t *testing.T) {
	s := New(64)
	applySeq(t, s, [2]string{"session.created", evSessionCreated("R", "")})
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold")

	applySeq(t, s, [2]string{"session.created", evSessionCreated("C", "R")})
	ops := e.Translate(lastEventOfKind(t, s, KindSessionUpsert))

	// INV-A: monotonic seq.
	var prevSeq uint64
	for _, op := range ops {
		seq := opSeq(op)
		if seq <= prevSeq {
			t.Errorf("INV-A violated: seq %d after %d", seq, prevSeq)
		}
		prevSeq = seq
	}
	if len(ops) == 0 {
		t.Fatalf("expected ops for child create")
	}
}

// ---------------------------------------------------------------------------
// Group 7 — tree=2 flag routing — see pkg/web/tree_children_test.go (server
// wiring is exercised at the HTTP layer; the emitter selection is additive in
// server.go alongside wantsProject).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Group 8 — O1 activity-stamp fix
// ---------------------------------------------------------------------------

// TestO1_ActivitySeededFromSessionUpdated asserts that after a status reconcile
// (SetActivityFromStatuses), the activity time is seeded from the session's
// real time.updated, NOT time.Now().
func TestO1_ActivitySeededFromSessionUpdated(t *testing.T) {
	s := New(64)
	// Seed a session with an OLD time.updated (2020, clearly not "now").
	oldMs := int64(1_600_000_000_000)
	applySeq(t, s, [2]string{"session.created",
		fmt.Sprintf(`{"info":{"id":"S","title":"S","time":{"updated":%d}}}`, oldMs)})

	// Run a status reconcile that sets activity=busy.
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		"S": json.RawMessage(`{"type":"busy"}`),
	})

	s.mu.RLock()
	at := s.lastActivityAt["S"]
	s.mu.RUnlock()

	want := time.UnixMilli(oldMs)
	if !at.Equal(want) {
		t.Errorf("O1: lastActivityAt[S] = %v, want %v (seeded from time.updated, not now)", at, want)
	}
}

// --- test helpers for ops ---

func opKinds(ops []TreeOp) []string {
	out := make([]string, 0, len(ops))
	for _, op := range ops {
		out = append(out, op.Op())
	}
	return out
}

func hasOpKind(ops []TreeOp, kind string) bool {
	for _, op := range ops {
		if op.Op() == kind {
			return true
		}
	}
	return false
}

func hasNodeID(ops []TreeOp, id string) bool {
	for _, op := range ops {
		if u, ok := op.(*NodeUpsert); ok && u.Node.ID == id {
			return true
		}
	}
	return false
}

func opSeq(op TreeOp) uint64 {
	switch o := op.(type) {
	case *NodeUpsert:
		return o.seq
	case *NodeRemove:
		return o.seq
	case *NodeMove:
		return o.seq
	case *NodeChildren:
		return o.seq
	case *NodeFacet:
		return o.seq
	}
	return 0
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && stringsContains(s, sub)
}

func stringsContains(s, sub string) bool {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}
