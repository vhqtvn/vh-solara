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
