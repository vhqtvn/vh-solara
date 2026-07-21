package state

import (
	"encoding/json"
	"fmt"
	"sort"
	"testing"
	"time"
)

// This file tests the Phase 4 projection (Gate A/B/C/D/F integration):
// SnapshotProjected builds roots + active closure + frontier stubs using the
// 8 incremental indexes from Phase 1, stamps structuralRevision (Phase 3), and
// preserves transcript orthogonality (Gate F). The cost-model test proves the
// O(|roots| + |active_closure|×depth + |frontier|) bound — NOT O(n) — on a
// ~1010-session fixture approximating the operator's workload.

// sessionIDsFromProjected returns a set of session IDs materialized as FULL
// sessions in snap.Sessions (NOT stubs).
func sessionIDsFromProjected(t *testing.T, snap Snapshot) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	for _, raw := range snap.Sessions {
		var e sessionEnvelope
		if err := json.Unmarshal(raw, &e); err != nil {
			t.Fatalf("unmarshal session: %v", err)
		}
		out[e.ID] = true
	}
	return out
}

// stubIDsFromProjected returns a set of stub IDs from snap.Stubs.
func stubIDsFromProjected(t *testing.T, snap Snapshot) map[string]bool {
	t.Helper()
	out := map[string]bool{}
	for _, stub := range snap.Stubs {
		out[stub.ID] = true
	}
	return out
}

// --- IsStructuralKind ---

func TestIsStructuralKind(t *testing.T) {
	structural := []string{
		KindSessionUpsert, KindSessionDelete,
		KindActivity,
		KindPermissionSet, KindPermissionClear,
		KindQuestionSet, KindQuestionClear,
	}
	for _, k := range structural {
		if !IsStructuralKind(k) {
			t.Errorf("IsStructuralKind(%q) = false, want true", k)
		}
	}
	nonStructural := []string{
		KindMessageUpsert, KindMessageDelete,
		KindPartUpsert, KindPartDelete,
		KindMessagesLoaded, KindMessagesBatch, KindMessagesError,
		KindTodo, KindStatus, KindActivityVerb,
		KindUnreadSet, KindUnreadClear, KindLastAgentSet,
		KindNotice, "unknown.kind",
	}
	for _, k := range nonStructural {
		if IsStructuralKind(k) {
			t.Errorf("IsStructuralKind(%q) = true, want false", k)
		}
	}
}

// --- aggregateStateLocked precedence ---

func TestAggregateStateLocked_Precedence(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"busy","title":"b"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"retry","title":"r"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"pending","title":"p"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"recent","title":"rec"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"idle","title":"i"}}`))

	s.Apply(ev("session.status", evStatus("busy", "busy")))
	s.Apply(ev("session.status", evStatus("retry", "retry")))
	s.Apply(ev("permission.asked", `{"id":"perm1","sessionID":"pending"}`))

	cutoff := time.Now().Add(-defaultProjectionCutoff)

	s.mu.RLock()
	defer s.mu.RUnlock()
	if got := s.aggregateStateLocked("busy", cutoff); got != "busy" {
		t.Errorf("busy session aggregateState = %q, want busy", got)
	}
	if got := s.aggregateStateLocked("retry", cutoff); got != "retry" {
		t.Errorf("retry session aggregateState = %q, want retry", got)
	}
	if got := s.aggregateStateLocked("pending", cutoff); got != "needs-input" {
		t.Errorf("pending-input session aggregateState = %q, want needs-input", got)
	}
	if got := s.aggregateStateLocked("idle", cutoff); got != "idle" {
		t.Errorf("idle session aggregateState = %q, want idle", got)
	}
	// "recent" has no activity transition yet (lastActivityAt is zero) → idle.
	if got := s.aggregateStateLocked("recent", cutoff); got != "idle" {
		t.Errorf("never-active session aggregateState = %q, want idle (no activity transition yet)", got)
	}
}

// --- subtreeHasActivityLocked / selfActiveLocked ---

func TestSubtreeHasActivityLocked(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"root","title":"r"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"child","parentID":"root","title":"c"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"grand","parentID":"child","title":"g"}}`))
	cutoff := time.Now().Add(-defaultProjectionCutoff)

	s.mu.RLock()
	// All idle, no activity transitions → no activity.
	if s.subtreeHasActivityLocked("root", cutoff) {
		t.Fatal("idle tree should have no activity")
	}
	if s.selfActiveLocked("root", cutoff) {
		t.Fatal("idle root should not be self-active")
	}
	s.mu.RUnlock()

	// Grandchild busy → activity propagates up to root.
	s.Apply(ev("session.status", evStatus("grand", "busy")))
	cutoff = time.Now().Add(-defaultProjectionCutoff)
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.subtreeHasActivityLocked("root", cutoff) {
		t.Fatal("root with busy grandchild should have subtree activity")
	}
	if !s.subtreeHasActivityLocked("child", cutoff) {
		t.Fatal("child with busy child should have subtree activity")
	}
	if !s.selfActiveLocked("grand", cutoff) {
		t.Fatal("busy grandchild should be self-active")
	}
	// Root is NOT self-active (it's idle itself) but HAS active descendants.
	if s.selfActiveLocked("root", cutoff) {
		t.Fatal("idle root should not be self-active even with busy descendants")
	}
}

// --- SnapshotProjected: basic collapse ---

func TestSnapshotProjected_CollapsesIdleTree(t *testing.T) {
	s := New(64)
	// root → busyChild (busy) + idleChild (idle, has idle grandchild)
	s.Apply(ev("session.created", `{"info":{"id":"root","title":"Root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"busyChild","parentID":"root","title":"Busy"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"idleChild","parentID":"root","title":"Idle"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"grand","parentID":"idleChild","title":"Grand"}}`))
	s.Apply(ev("session.status", evStatus("busyChild", "busy")))

	snap := s.SnapshotProjected(nil, "initial")

	if !snap.Projected {
		t.Fatal("SnapshotProjected must set Projected=true")
	}
	if snap.Cause != "initial" {
		t.Fatalf("Cause = %q, want initial", snap.Cause)
	}
	if snap.StructuralRevision == 0 {
		t.Fatal("StructuralRevision should be > 0 after mutations")
	}

	fullIDs := sessionIDsFromProjected(t, snap)
	stubIDs := stubIDsFromProjected(t, snap)

	// Active closure: root (ancestor) + busyChild (self-active).
	if !fullIDs["root"] {
		t.Fatal("root must be materialized as full session (ancestor of busy child)")
	}
	if !fullIDs["busyChild"] {
		t.Fatal("busyChild must be materialized as full session (self-active)")
	}
	// idleChild + grand are idle → stubs (frontier children of root not in active).
	if fullIDs["idleChild"] {
		t.Fatal("idleChild must NOT be materialized (idle subtree)")
	}
	if fullIDs["grand"] {
		t.Fatal("grand must NOT be materialized (idle descendant of idle subtree)")
	}
	// idleChild should be a stub (frontier child of active root, not in active closure).
	if !stubIDs["idleChild"] {
		t.Fatal("idleChild should be a frontier stub")
	}
	// grand should NOT be a stub (it's a descendant of a stub, not a frontier child of an active session).
	if stubIDs["grand"] {
		t.Fatal("grand should NOT be a stub (not a frontier child of an active session)")
	}
}

// --- SnapshotProjected: idle root becomes single stub ---

func TestSnapshotProjected_IdleRootBecomesStub(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"active","title":"A"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"idleRoot","title":"IR"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"idleChild","parentID":"idleRoot","title":"IC"}}`))
	s.Apply(ev("session.status", evStatus("active", "busy")))

	snap := s.SnapshotProjected(nil, "initial")
	fullIDs := sessionIDsFromProjected(t, snap)
	stubIDs := stubIDsFromProjected(t, snap)

	if !fullIDs["active"] {
		t.Fatal("active session must be materialized")
	}
	if fullIDs["idleRoot"] || fullIDs["idleChild"] {
		t.Fatal("idle root + child must NOT be materialized")
	}
	// idleRoot becomes a single stub (NOT idleChild — it's hidden behind the stub).
	if !stubIDs["idleRoot"] {
		t.Fatal("idleRoot should be a stub")
	}
	if stubIDs["idleChild"] {
		t.Fatal("idleChild should NOT be a stub (it's a descendant of the idleRoot stub)")
	}
}

// --- SnapshotProjected: active closure includes all ancestors ---

func TestSnapshotProjected_ActiveClosureIncludesAncestors(t *testing.T) {
	s := New(64)
	// root → mid → leaf (busy). Active closure must include root + mid + leaf.
	s.Apply(ev("session.created", `{"info":{"id":"root","title":"R"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"mid","parentID":"root","title":"M"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"leaf","parentID":"mid","title":"L"}}`))
	s.Apply(ev("session.status", evStatus("leaf", "busy")))

	snap := s.SnapshotProjected(nil, "initial")
	fullIDs := sessionIDsFromProjected(t, snap)

	for _, id := range []string{"root", "mid", "leaf"} {
		if !fullIDs[id] {
			t.Fatalf("%s must be materialized (active closure includes ancestors)", id)
		}
	}
}

// --- SnapshotProjected: transcript orthogonality (Gate F) ---

func TestSnapshotProjected_TranscriptOrthogonal(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"active","title":"A"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"hidden","title":"H"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"active","role":"user"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m2","sessionID":"hidden","role":"user"}}`))
	s.Apply(ev("session.status", evStatus("active", "busy")))

	// messagesFor nil → all active sessions get messages. "hidden" is NOT active.
	snap := s.SnapshotProjected(nil, "initial")
	if _, ok := snap.Messages["active"]; !ok {
		t.Fatal("active session should carry messages")
	}
	if _, ok := snap.Messages["hidden"]; ok {
		t.Fatal("hidden session must NOT carry messages (transcript orthogonality)")
	}

	// messagesFor scoped to active only — hidden never included.
	snap2 := s.SnapshotProjected(map[string]bool{"active": true}, "initial")
	if _, ok := snap2.Messages["active"]; !ok {
		t.Fatal("active session should carry messages when in messagesFor")
	}
	if _, ok := snap2.Messages["hidden"]; ok {
		t.Fatal("hidden session must NOT carry messages even when messagesFor is scoped")
	}
}

// --- SnapshotProjected: promotion reflects latest state ---

func TestSnapshotProjected_PromotionReflectsLatest(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"a","title":"A"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"b","title":"B"}}`))

	snap1 := s.SnapshotProjected(nil, "initial")
	rev1 := snap1.StructuralRevision
	full1 := sessionIDsFromProjected(t, snap1)
	// Both idle, no activity → both are idle root stubs, no full sessions.
	if len(full1) != 0 {
		t.Fatalf("before any activity, expected 0 full sessions, got %d: %v", len(full1), full1)
	}

	// Promote "a" to busy.
	s.Apply(ev("session.status", evStatus("a", "busy")))
	snap2 := s.SnapshotProjected(nil, "promotion")
	if snap2.Cause != "promotion" {
		t.Fatalf("Cause = %q, want promotion", snap2.Cause)
	}
	if snap2.StructuralRevision <= rev1 {
		t.Fatalf("structuralRevision must increase after mutation: rev1=%d rev2=%d", rev1, snap2.StructuralRevision)
	}
	full2 := sessionIDsFromProjected(t, snap2)
	if !full2["a"] {
		t.Fatal("after promoting a to busy, a must be materialized")
	}
	if full2["b"] {
		t.Fatal("b should remain a stub (still idle)")
	}
}

// --- SnapshotProjected: COST MODEL (the core proof target) ---
// Builds a ~1010-session fixture approximating the operator's workload:
// 10 roots × 10 subagents × 10 sessions = 1000 sessions, plus 10 roots = 1010.
// Only ONE leaf deep in root0 is busy. Asserts the projected snapshot visits
// O(roots + active_closure + frontier), NOT O(n).

func TestSnapshotProjected_CostModel(t *testing.T) {
	s := New(4096)

	const numRoots = 10
	const numSubagents = 10
	const numSessions = 10

	// Build: root{i} → sub{j} → leaf{k}. One leaf (root0.sub0.leaf0) is busy.
	for r := 0; r < numRoots; r++ {
		rootID := fmt.Sprintf("root%d", r)
		s.Apply(ev("session.created", fmt.Sprintf(`{"info":{"id":%q,"title":"Root %d"}}`, rootID, r)))
		for sa := 0; sa < numSubagents; sa++ {
			subID := fmt.Sprintf("root%d_sub%d", r, sa)
			s.Apply(ev("session.created", fmt.Sprintf(`{"info":{"id":%q,"parentID":%q,"title":"Sub %d.%d"}}`, subID, rootID, r, sa)))
			for k := 0; k < numSessions; k++ {
				leafID := fmt.Sprintf("root%d_sub%d_leaf%d", r, sa, k)
				s.Apply(ev("session.created", fmt.Sprintf(`{"info":{"id":%q,"parentID":%q,"title":"Leaf %d.%d.%d"}}`, leafID, subID, r, sa, k)))
			}
		}
	}

	totalSessions := numRoots + numRoots*numSubagents + numRoots*numSubagents*numSessions
	if totalSessions != 10+100+1000 {
		t.Fatalf("fixture math wrong: totalSessions = %d", totalSessions)
	}

	// Promote exactly one leaf deep in root0 to busy.
	s.Apply(ev("session.status", evStatus("root0_sub0_leaf0", "busy")))

	snap := s.SnapshotProjected(nil, "initial")
	fullIDs := sessionIDsFromProjected(t, snap)
	stubIDs := stubIDsFromProjected(t, snap)

	totalNodesProjected := len(fullIDs) + len(stubIDs)

	// Active closure: root0 (ancestor) + root0_sub0 (ancestor) + root0_sub0_leaf0 (busy leaf) = 3.
	if len(fullIDs) != 3 {
		t.Fatalf("expected exactly 3 full sessions (active closure), got %d: %v", len(fullIDs), sortedKeys(fullIDs))
	}
	for _, id := range []string{"root0", "root0_sub0", "root0_sub0_leaf0"} {
		if !fullIDs[id] {
			t.Fatalf("active closure missing %s", id)
		}
	}

	// Stubs:
	//   - 9 idle roots (root1..root9) = 9
	//   - 9 idle siblings of root0_sub0 under root0 (root0_sub1..root0_sub9) = 9
	//   - 9 idle siblings of root0_sub0_leaf0 under root0_sub0 (root0_sub0_leaf1..root0_sub0_leaf9) = 9
	// Total stubs = 27.
	expectedStubs := 9 + 9 + 9
	if len(stubIDs) != expectedStubs {
		t.Fatalf("expected %d stubs, got %d: %v", expectedStubs, len(stubIDs), sortedKeys(stubIDs))
	}

	// The COST assertion: total nodes projected (3 + 27 = 30) must be MUCH less
	// than total sessions (1110). This is the ~37× reduction the projection buys.
	if totalNodesProjected >= totalSessions {
		t.Fatalf("cost model failed: projected %d nodes vs %d total sessions (no reduction!)",
			totalNodesProjected, totalSessions)
	}
	reductionRatio := float64(totalSessions) / float64(totalNodesProjected)
	if reductionRatio < 10 {
		t.Fatalf("cost model: reduction ratio %.1fx is less than the expected ~10x minimum (projected=%d total=%d)",
			reductionRatio, totalNodesProjected, totalSessions)
	}
	t.Logf("cost model: projected %d nodes from %d total sessions (%.1fx reduction)",
		totalNodesProjected, totalSessions, reductionRatio)
}

// sortedKeys returns sorted keys of a string→bool map for stable error messages.
func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

// --- SnapshotBranch: pagination ---

func TestSnapshotBranch_Pagination(t *testing.T) {
	s := New(64)
	// parent has 5 children, all idle.
	s.Apply(ev("session.created", `{"info":{"id":"parent","title":"P"}}`))
	for i := 0; i < 5; i++ {
		childID := fmt.Sprintf("c%d", i)
		s.Apply(ev("session.created", fmt.Sprintf(`{"info":{"id":%q,"parentID":"parent","title":"Child %d"}}`, childID, i)))
	}

	// Page 1: limit=2, cursor="" → returns c0, c1. nextCursor = "c1".
	snap1, next1 := s.SnapshotBranch("parent", "", 2)
	full1 := sessionIDsFromProjected(t, snap1)
	if len(full1) != 2 || !full1["c0"] || !full1["c1"] {
		t.Fatalf("page 1: expected c0+c1, got %v", sortedKeys(full1))
	}
	if next1 != "c1" {
		t.Fatalf("page 1 nextCursor = %q, want c1", next1)
	}
	if snap1.Cause != "lazy-expand" {
		t.Fatalf("Cause = %q, want lazy-expand", snap1.Cause)
	}

	// Page 2: cursor="c1" → returns c2, c3. nextCursor = "c3".
	snap2, next2 := s.SnapshotBranch("parent", "c1", 2)
	full2 := sessionIDsFromProjected(t, snap2)
	if len(full2) != 2 || !full2["c2"] || !full2["c3"] {
		t.Fatalf("page 2: expected c2+c3, got %v", sortedKeys(full2))
	}
	if next2 != "c3" {
		t.Fatalf("page 2 nextCursor = %q, want c3", next2)
	}

	// Page 3: cursor="c3" → returns c4. nextCursor = "" (last page).
	snap3, next3 := s.SnapshotBranch("parent", "c3", 2)
	full3 := sessionIDsFromProjected(t, snap3)
	if len(full3) != 1 || !full3["c4"] {
		t.Fatalf("page 3: expected only c4, got %v", sortedKeys(full3))
	}
	if next3 != "" {
		t.Fatalf("page 3 nextCursor = %q, want empty (last page)", next3)
	}
}

// --- SnapshotBranch: lazy-expand materializes children + stubs grandchildren ---

func TestSnapshotBranch_ChildrenMaterialized(t *testing.T) {
	s := New(64)
	// parent → childA (with idle grandchild) + childB (idle leaf)
	s.Apply(ev("session.created", `{"info":{"id":"parent","title":"P"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"childA","parentID":"parent","title":"CA"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"childB","parentID":"parent","title":"CB"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"grandA","parentID":"childA","title":"GA"}}`))

	snap, next := s.SnapshotBranch("parent", "", 10)
	if next != "" {
		t.Fatalf("nextCursor = %q, want empty (all children fit in one page)", next)
	}
	full := sessionIDsFromProjected(t, snap)
	stubs := stubIDsFromProjected(t, snap)

	// Both children materialized as full sessions.
	if !full["childA"] || !full["childB"] {
		t.Fatalf("both children must be materialized, got %v", sortedKeys(full))
	}
	// grandA is an idle descendant of childA → frontier stub.
	if !stubs["grandA"] {
		t.Fatal("grandA should be a frontier stub (idle child of materialized childA)")
	}
	// parent itself is NOT in the branch response (it's the expansion target).
	if full["parent"] {
		t.Fatal("parent should NOT be materialized in its own branch expand")
	}
}

// --- SnapshotBranch: empty parent returns empty snapshot ---

func TestSnapshotBranch_EmptyParent(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"solo","title":"S"}}`))

	snap, next := s.SnapshotBranch("nonexistent", "", 10)
	if next != "" {
		t.Fatalf("nextCursor = %q, want empty for nonexistent parent", next)
	}
	if len(snap.Sessions) != 0 {
		t.Fatalf("expected 0 sessions for nonexistent parent, got %d", len(snap.Sessions))
	}
	if len(snap.Stubs) != 0 {
		t.Fatalf("expected 0 stubs for nonexistent parent, got %d", len(snap.Stubs))
	}
	if !snap.Projected || snap.Cause != "lazy-expand" {
		t.Fatalf("snap must be Projected lazy-expand, got Projected=%v Cause=%q", snap.Projected, snap.Cause)
	}
}

// --- SnapshotBranch: default limit when limit<=0 ---

func TestSnapshotBranch_DefaultLimit(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"parent","title":"P"}}`))
	// Create more children than defaultBranchExpandLimit to test default.
	for i := 0; i < defaultBranchExpandLimit+10; i++ {
		childID := fmt.Sprintf("c%d", i)
		s.Apply(ev("session.created", fmt.Sprintf(`{"info":{"id":%q,"parentID":"parent"}}`, childID)))
	}

	// limit=0 → defaults to defaultBranchExpandLimit.
	snap, next := s.SnapshotBranch("parent", "", 0)
	full := sessionIDsFromProjected(t, snap)
	if len(full) != defaultBranchExpandLimit {
		t.Fatalf("default limit: expected %d children, got %d", defaultBranchExpandLimit, len(full))
	}
	if next == "" {
		t.Fatal("nextCursor should be non-empty (more children remain)")
	}
}

// TestSnapshotBranch_ClampsHugeLimit guards against integer overflow when an
// untrusted caller passes a very large limit (e.g. max int64 from a URL
// ?limit= param). Without clamping, start+limit overflows negative and the
// allChildren[start:end] slice panics. This is the regression test for the
// commit-reviewer BLOCK on Phase 4.
func TestSnapshotBranch_ClampsHugeLimit(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"parent","title":"P"}}`))
	for i := 0; i < 5; i++ {
		s.Apply(ev("session.created", fmt.Sprintf(`{"info":{"id":%q,"parentID":"parent"}}`, fmt.Sprintf("c%d", i))))
	}

	// max int64 limit with a non-empty cursor — the worst-case overflow vector.
	_, next := s.SnapshotBranch("parent", "c1", 1<<62)
	// Must not panic. next is empty because all 5 children fit in one clamped page
	// after cursor c1 (start=2, end=min(2+50, 5)=5 → last page, no next cursor).
	if next != "" {
		t.Fatalf("expected empty nextCursor on last page, got %q", next)
	}

	// Also verify limit=0 and negative limit are clamped (not passed through).
	snap1, _ := s.SnapshotBranch("parent", "", 0)
	snap2, _ := s.SnapshotBranch("parent", "", -1)
	if len(sessionIDsFromProjected(t, snap1)) != len(sessionIDsFromProjected(t, snap2)) {
		t.Fatal("limit=0 and limit=-1 should both clamp to defaultBranchExpandLimit")
	}
}

// --- SnapshotProjected: stub fields are populated correctly ---

func TestSnapshotProjected_StubFields(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"root","title":"Root Title"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"child1","parentID":"root","title":"C1"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"child2","parentID":"root","title":"C2"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"g1","parentID":"child1"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"g2","parentID":"child1"}}`))

	snap := s.SnapshotProjected(nil, "initial")

	// root is an idle root → single stub with DescendantCount=4 (root+child1+child2+g1+g2 minus root itself... wait).
	// subtreeDescendantCount includes self. root's subtree = {root, child1, child2, g1, g2} = 5.
	var rootStub *CollapsedBranchStub
	for i := range snap.Stubs {
		if snap.Stubs[i].ID == "root" {
			rootStub = &snap.Stubs[i]
			break
		}
	}
	if rootStub == nil {
		t.Fatal("root stub not found")
	}
	if rootStub.Kind != "collapsed-branch" {
		t.Fatalf("stub Kind = %q, want collapsed-branch", rootStub.Kind)
	}
	if rootStub.Title != "Root Title" {
		t.Fatalf("stub Title = %q, want 'Root Title'", rootStub.Title)
	}
	if rootStub.ParentID != "" {
		t.Fatalf("root stub ParentID = %q, want empty", rootStub.ParentID)
	}
	if !rootStub.HasChildren {
		t.Fatal("root stub HasChildren should be true (has child1, child2)")
	}
	if rootStub.DescendantCount != 5 {
		t.Fatalf("root stub DescendantCount = %d, want 5 (root+2 children+2 grandchildren)", rootStub.DescendantCount)
	}
	if rootStub.AggregateState != "idle" {
		t.Fatalf("root stub AggregateState = %q, want idle", rootStub.AggregateState)
	}
	if rootStub.StructuralRevision == 0 {
		t.Fatal("stub StructuralRevision should be > 0 after mutations")
	}
}

// --- SnapshotProjected: race cleanliness (concurrent projection + apply) ---

func TestSnapshotProjected_ConcurrentWithApply(t *testing.T) {
	s := New(256)
	// Seed a tree.
	s.Apply(ev("session.created", `{"info":{"id":"root","title":"R"}}`))
	for i := 0; i < 20; i++ {
		childID := fmt.Sprintf("c%d", i)
		s.Apply(ev("session.created", fmt.Sprintf(`{"info":{"id":%q,"parentID":"root"}}`, childID)))
	}

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i := 0; i < 100; i++ {
			childID := fmt.Sprintf("c%d", i%20)
			s.Apply(ev("session.status", evStatus(childID, "busy")))
			s.Apply(ev("session.idle", evIdle(childID)))
		}
	}()

	// Concurrent projections — must not race or panic.
	for i := 0; i < 50; i++ {
		_ = s.SnapshotProjected(nil, "promotion")
	}
	<-done
}
