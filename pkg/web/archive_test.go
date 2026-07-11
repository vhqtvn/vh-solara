package web

import (
	"encoding/json"
	"testing"
)

// archSession builds a raw JSON session envelope for archivedLevel tests.
// archived == nil omits time.archived entirely (a non-archived session).
func archSession(t *testing.T, id, parentID string, created, updated float64, archived *float64) json.RawMessage {
	t.Helper()
	timeMap := map[string]any{"created": created, "updated": updated}
	if archived != nil {
		timeMap["archived"] = *archived
	}
	m := map[string]any{"id": id, "time": timeMap}
	if parentID != "" {
		m["parentID"] = parentID
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// archIDs decodes the id field of each item returned by archivedLevel.
func archIDs(t *testing.T, items []json.RawMessage) []string {
	t.Helper()
	out := make([]string, 0, len(items))
	for _, raw := range items {
		var env struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(raw, &env); err != nil {
			t.Fatal(err)
		}
		out = append(out, env.ID)
	}
	return out
}

func floatPtr(v float64) *float64 { return &v }

// TestArchivedLevelFiltersNonArchived exercises the core leak fix: OpenCode
// 1.17.x ignores ?archived=true and hands back archived AND non-archived
// sessions. archivedLevel must keep only genuinely archived sessions
// (time.archived set to a non-zero value) out of items, total, and child counts.
func TestArchivedLevelFiltersNonArchived(t *testing.T) {
	sessions := []json.RawMessage{
		// archived root r1
		archSession(t, "r1", "", 5, 30, floatPtr(15)),
		// archived child c1 of r1
		archSession(t, "c1", "r1", 8, 50, floatPtr(20)),
		// NON-archived root r2 (no time.archived) — must be excluded
		archSession(t, "r2", "", 1, 40, nil),
		// NON-archived child c2 of r1 (no time.archived) — must be excluded
		// AND must not bump r1's archived child count
		archSession(t, "c2", "r1", 9, 60, nil),
		// archived=0 is treated as non-archived (mirrors store.go archivedAt) — excluded
		archSession(t, "z0", "", 1, 2, floatPtr(0)),
	}

	// Roots level (parent=""): only r1 survives (c1 is a child; r2/z0 are
	// non-archived). total counts archived roots only.
	items, total, counts := archivedLevel(sessions, "", 0, 50)
	if ids := archIDs(t, items); len(ids) != 1 || ids[0] != "r1" {
		t.Fatalf("roots want [r1], got %v", ids)
	}
	if total != 1 {
		t.Fatalf("roots total want 1, got %d", total)
	}
	// r1 has exactly ONE archived child (c1); c2 must not bump the count.
	if got := counts["r1"]; got != 1 {
		t.Fatalf("r1 child count want 1 (c1 only; c2 is non-archived), got %d", got)
	}
	// No leaked non-archived ids in counts.
	if _, leaked := counts["r2"]; leaked {
		t.Fatalf("non-archived r2 leaked into counts")
	}

	// Children of r1: only c1 survives (c2 is non-archived).
	items, total, counts = archivedLevel(sessions, "r1", 0, 50)
	if ids := archIDs(t, items); len(ids) != 1 || ids[0] != "c1" {
		t.Fatalf("r1 children want [c1], got %v", ids)
	}
	if total != 1 {
		t.Fatalf("r1 children total want 1, got %d", total)
	}
	if len(counts) != 0 {
		t.Fatalf("c1 has no archived children, want empty counts, got %v", counts)
	}

	// Children of r2 (a non-archived root): nothing — c2 was filtered out.
	items, total, counts = archivedLevel(sessions, "r2", 0, 50)
	if len(items) != 0 {
		t.Fatalf("non-archived parent r2 should have no items, got %v", archIDs(t, items))
	}
	if total != 0 {
		t.Fatalf("non-archived parent r2 total want 0, got %d", total)
	}
	if len(counts) != 0 {
		t.Fatalf("non-archived parent r2 counts want empty, got %v", counts)
	}
}

// TestArchivedLevelRootsPaginationAndCounts verifies archived roots paginate and
// that the archived child count is attached only to the page item that owns the
// children (mirroring the established archivedLevel contract).
func TestArchivedLevelRootsPaginationAndCounts(t *testing.T) {
	sessions := []json.RawMessage{
		archSession(t, "ra", "", 1, 10, floatPtr(100)),   // archived root
		archSession(t, "rb", "", 1, 20, floatPtr(100)),   // archived root
		archSession(t, "rc", "", 1, 30, floatPtr(100)),   // archived root (newest)
		archSession(t, "ca", "ra", 1, 40, floatPtr(100)), // archived child of ra
	}

	// All roots, newest first: rc, rb, ra. ra carries the archived child count.
	items, total, counts := archivedLevel(sessions, "", 0, 50)
	if ids := archIDs(t, items); len(ids) != 3 || ids[0] != "rc" || ids[1] != "rb" || ids[2] != "ra" {
		t.Fatalf("roots want [rc rb ra] by updated desc, got %v", ids)
	}
	if total != 3 {
		t.Fatalf("total want 3 archived roots, got %d", total)
	}
	if got := counts["ra"]; got != 1 {
		t.Fatalf("ra child count want 1, got %d", got)
	}

	// Page 1 (limit=2): rc, rb — neither has children, so counts is empty even
	// though ra (off-page) has a child.
	items, total, counts = archivedLevel(sessions, "", 0, 2)
	if ids := archIDs(t, items); len(ids) != 2 || ids[0] != "rc" || ids[1] != "rb" {
		t.Fatalf("page 1 want [rc rb], got %v", ids)
	}
	if total != 3 {
		t.Fatalf("page 1 total want 3, got %d", total)
	}
	if len(counts) != 0 {
		t.Fatalf("page 1 counts want empty (no children on page), got %v", counts)
	}

	// Page 2 (offset=2, limit=2): ra — its archived child count surfaces now.
	items, total, counts = archivedLevel(sessions, "", 2, 2)
	if ids := archIDs(t, items); len(ids) != 1 || ids[0] != "ra" {
		t.Fatalf("page 2 want [ra], got %v", ids)
	}
	if total != 3 {
		t.Fatalf("page 2 total want 3, got %d", total)
	}
	if got := counts["ra"]; got != 1 {
		t.Fatalf("page 2 ra child count want 1, got %d", got)
	}
}

// TestArchivedLevelEmptyInput guards the no-data case.
func TestArchivedLevelEmptyInput(t *testing.T) {
	items, total, counts := archivedLevel(nil, "", 0, 50)
	if len(items) != 0 || total != 0 || len(counts) != 0 {
		t.Fatalf("empty input want items/total/counts all empty, got items=%d total=%d counts=%v", len(items), total, counts)
	}
}

// equalSet reports whether want and got hold the same ids regardless of order
// (archivedDescendants returns a subtree whose traversal order is irrelevant to
// its callers).
func equalSet(want, got []string) bool {
	if len(want) != len(got) {
		return false
	}
	w := make(map[string]int, len(want))
	for _, s := range want {
		w[s]++
	}
	for _, s := range got {
		if w[s]--; w[s] < 0 {
			return false
		}
	}
	for _, c := range w {
		if c != 0 {
			return false
		}
	}
	return true
}

// TestArchivedDescendantsIncludesSubtree covers the core contract: for an
// archived root, archivedDescendants returns the root plus every genuinely
// archived session transitively parented by it.
func TestArchivedDescendantsIncludesSubtree(t *testing.T) {
	sessions := []json.RawMessage{
		// archived root r1
		archSession(t, "r1", "", 5, 30, floatPtr(15)),
		// archived child c1 of r1
		archSession(t, "c1", "r1", 8, 50, floatPtr(20)),
		// archived grandchild g1 of r1 (via c1)
		archSession(t, "g1", "c1", 9, 60, floatPtr(25)),
	}
	got := archivedDescendants(sessions, "r1")
	want := []string{"r1", "c1", "g1"}
	if !equalSet(want, got) {
		t.Fatalf("r1 subtree want %v, got %v", want, got)
	}
}

// TestArchivedDescendantsFiltersNonArchived exercises the consistency fix:
// OpenCode 1.17.x ignores ?archived=true and returns archived AND non-archived
// sessions. archivedDescendants must keep only genuinely archived sessions
// (time.archived set to a non-zero value) in the computed subtree — a
// non-archived child, descendant, or sibling must never be folded in.
func TestArchivedDescendantsFiltersNonArchived(t *testing.T) {
	sessions := []json.RawMessage{
		// archived root r1
		archSession(t, "r1", "", 5, 30, floatPtr(15)),
		// archived child c1 of r1
		archSession(t, "c1", "r1", 8, 50, floatPtr(20)),
		// NON-archived child c2 of r1 (time.archived nil) — must be excluded
		archSession(t, "c2", "r1", 9, 60, nil),
		// NON-archived grandchild g0 under c2 (time.archived nil) — must be
		// excluded even though its parent chain reaches r1.
		archSession(t, "g0", "c2", 1, 2, nil),
		// NON-archived sibling r2 (time.archived=0, treated as non-archived,
		// mirroring store.go archivedAt) — must be excluded.
		archSession(t, "r2", "", 1, 2, floatPtr(0)),
	}
	got := archivedDescendants(sessions, "r1")
	want := []string{"r1", "c1"}
	if !equalSet(want, got) {
		t.Fatalf("r1 subtree want %v (non-archived c2/g0/r2 excluded), got %v", want, got)
	}
}

// TestArchivedDescendantsUnknownID guards the fallback at the existing
// archive.go return: when the target id is not present in the (filtered)
// archived set, archivedDescendants returns [id] so the caller still attempts
// the single-id operation.
func TestArchivedDescendantsUnknownID(t *testing.T) {
	sessions := []json.RawMessage{
		archSession(t, "r1", "", 5, 30, floatPtr(15)),
	}
	got := archivedDescendants(sessions, "missing")
	want := []string{"missing"}
	if !equalSet(want, got) {
		t.Fatalf("unknown id want %v, got %v", want, got)
	}
}

// TestArchivedDescendantsRetryReachesArchivedChildAfterRootUnarchives is the
// regression for blocker b-F1: a partial-batch unarchive failure leaves the
// root already active (time.archived cleared) while a child stays archived.
// The recovery contract — re-clicking Restore on the SAME root retries the
// still-archived child — was false under the old archivedDescendants, because
// it built its tree only from the archived set, so once the root left that set
// the child became unreachable (the function returned [root] only).
//
// Setup mirrors that post-partial-failure state: root r1 is ACTIVE (no
// time.archived), child c1 is still archived. The retry on r1 must include c1.
func TestArchivedDescendantsRetryReachesArchivedChildAfterRootUnarchives(t *testing.T) {
	sessions := []json.RawMessage{
		// r1 already unarchived (partial-batch success) — ACTIVE, no archived ts.
		archSession(t, "r1", "", 5, 30, nil),
		// c1 still archived (mid-batch failure) — the retry MUST reach it.
		archSession(t, "c1", "r1", 8, 50, floatPtr(20)),
	}
	got := archivedDescendants(sessions, "r1")
	want := []string{"r1", "c1"}
	if !equalSet(want, got) {
		t.Fatalf("retry on active root r1 want %v (still-archived child c1 must be reachable), got %v", want, got)
	}
	// Specifically assert the previously-unreachable child is present.
	hit := false
	for _, id := range got {
		if id == "c1" {
			hit = true
		}
	}
	if !hit {
		t.Fatalf("still-archived child c1 not reached on retry of active root r1: got %v", got)
	}
}

// TestArchivedDescendantsRetryReachesDeepArchivedDescendant covers the deeper
// partial-failure shape: the root and one mid-level descendant unarchived, but
// a deeper archived descendant is still pending, reached through an
// already-active intermediate node.
func TestArchivedDescendantsRetryReachesDeepArchivedDescendant(t *testing.T) {
	sessions := []json.RawMessage{
		// r1 already active (unarchived) — retry root.
		archSession(t, "r1", "", 5, 30, nil),
		// m1 already active — mid node that already unarchived.
		archSession(t, "m1", "r1", 6, 40, nil),
		// g1 still archived — must be reached through the active r1->m1 chain.
		archSession(t, "g1", "m1", 7, 50, floatPtr(25)),
	}
	got := archivedDescendants(sessions, "r1")
	want := []string{"r1", "g1"}
	if !equalSet(want, got) {
		t.Fatalf("retry want %v (deep archived g1 via active r1->m1), got %v", want, got)
	}
}
