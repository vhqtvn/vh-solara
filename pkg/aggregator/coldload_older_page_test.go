package aggregator

// coldload_older_page_test.go — Part-B boundary-demand CORE proof (runnable in
// pkg/aggregator; does NOT need pkg/web, which is currently blocked by a
// concurrent labels break). Exercises the load-bearing fetch+merge path:
// EnsureOlderMessages → Client.MessagesBefore(cursor) → fixture's cursor API
// (strictly-older page + X-Next-Cursor) → Store.MergeOlderMessages (ID-prepend).
// The HTTP D-trigger wrapper (messages_http.go) + the full e2e are blocked by
// the concurrent pkg/web break; this test + the pkg/state guard cover the
// mechanics that wrapper delegates to.

import (
	"context"
	"fmt"
	"net/http/httptest"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// TestEnsureOlderMessagesFetchesAndMerges proves the boundary-demand core: after
// a bounded cold-load (resident = newest WindowMaxCount), EnsureOlderMessages
// fetches the strictly-older page via the cursor and merges it (ID-prepend), so
// older history becomes resident without reconnect.
func TestEnsureOlderMessagesFetchesAndMerges(t *testing.T) {
	fake := fixtures.New()
	const sid = "bigcursor"
	n := state.WindowMaxCount + 50 // 150 > WindowMaxCount (100)
	fake.SeedChronologicalMessages(sid, n)
	oc := httptest.NewServer(fake.Handler())
	defer oc.Close()

	agg := New(oc.URL, 100)
	ctx := context.Background()

	// 1. Bounded cold-load → resident = newest WindowMaxCount (cm{n-W+1}..cm{n}).
	if err := agg.EnsureMessages(ctx, sid); err != nil {
		t.Fatalf("EnsureMessages (cold-load): %v", err)
	}
	oid, otime, ok := agg.Store().OldestResidentCursorTuple(sid)
	if !ok {
		t.Fatal("OldestResidentCursorTuple: no oldest resident after cold-load")
	}
	wantOldest := fmt.Sprintf("cm%d", n-state.WindowMaxCount+1) // cm51
	if oid != wantOldest {
		t.Fatalf("after bounded cold-load, oldest resident: want %s, got %s (cold-load not bounded?)", wantOldest, oid)
	}

	// 2. Boundary-demand CORE: fetch the strictly-older page via the cursor + merge.
	if err := agg.EnsureOlderMessages(sid, oid, otime); err != nil {
		t.Fatalf("EnsureOlderMessages: %v", err)
	}

	// 3. CRUX — the older page merged (ID-prepend). The oldest resident is now
	//    cm1 (the transcript start), proving older history is now resident.
	oid2, _, ok2 := agg.Store().OldestResidentCursorTuple(sid)
	if !ok2 {
		t.Fatal("OldestResidentCursorTuple: no oldest resident after merge")
	}
	if oid2 != "cm1" {
		t.Fatalf("CRUX FAIL: after EnsureOlderMessages, oldest resident want cm1 (older page merged via cursor), got %s", oid2)
	}
	t.Logf("CRUX PASS: EnsureOlderMessages merged the older page — oldest resident %s → %s (older history now resident without reconnect)", oid, oid2)

	// 4. The merged older page is paged-back truthfully: SnapshotMessagesPage from
	//    the original oldest resident now reaches cm1, and historyExhausted is true
	//    (the fixture returned ≤ WindowMaxCount strictly-older → no X-Next-Cursor).
	page := agg.Store().SnapshotMessagesPage(sid, oid, state.WindowMaxCount, 1<<20)
	if page.OldestID != "cm1" {
		t.Fatalf("after merge, page oldest_id want cm1, got %q", page.OldestID)
	}
	if page.HasOlder {
		t.Fatalf("after merge: has_older want false (history exhausted — fixture returned ≤WindowMaxCount, no X-Next-Cursor), got true")
	}
}
