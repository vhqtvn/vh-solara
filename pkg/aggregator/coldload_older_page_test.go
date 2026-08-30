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

// TestColdLoadTailCursorTruthfulHasOlder is the has-older-truthfulness CRUX:
// with a fixture session of >WindowMaxCount small messages (light tail under
// 1MiB — the exact repro shape that used to report has_older=false), a cold
// load via the tail GET's X-Next-Cursor must leave the store NOT-exhausted, so
// (a) the snapshot messageWindows meta reports has_older=true (the Load-older
// affordance the SPA keys on), and (b) a client load-older walk — pages via
// SnapshotMessagesPage with the same boundary-demand D-trigger the HTTP handler
// runs (messages_http.go:122) — reaches the session's OLDEST message (cm1).
// It also pins the no-inverse-lie direction: a small fully-fetched session
// (no X-Next-Cursor on its tail) reports has_older=false.
func TestColdLoadTailCursorTruthfulHasOlder(t *testing.T) {
	fake := fixtures.New()
	const sid = "bigtail"
	n := state.WindowMaxCount + 74 // light tail under 1 MiB, older history beyond
	fake.SeedChronologicalMessages(sid, n)
	oc := httptest.NewServer(fake.Handler())
	defer oc.Close()

	agg := New(oc.URL, 100)
	ctx := context.Background()

	// Cold load. The fixture tail GET (limit=WindowMaxCount < n) sets
	// X-Next-Cursor → the aggregator records NOT-exhausted.
	if err := agg.EnsureMessages(ctx, sid); err != nil {
		t.Fatalf("EnsureMessages (cold-load): %v", err)
	}

	// (a) CRUX — snapshot messageWindows meta reports has_older=true even
	// though neither dual bound fires on the light exact-window resident.
	snap := agg.Store().Snapshot(map[string]bool{sid: true})
	meta, ok := snap.MessageWindows[sid]
	if !ok {
		t.Fatalf("snapshot must carry MessageWindows[%s]", sid)
	}
	if len(snap.Messages[sid]) != state.WindowMaxCount {
		t.Fatalf("snapshot window: want %d messages, got %d", state.WindowMaxCount, len(snap.Messages[sid]))
	}
	if meta.HasOlder != true {
		t.Fatalf("CRUX (a) FAIL: snapshot MessageWindows[%s].HasOlder want true (fetch-truncated light tail, cursor present), got false", sid)
	}
	if meta.CountLimited || meta.BytesLimited {
		t.Fatalf("snapshot window: want no limit flags (light tail), got %+v", meta)
	}

	// (b) CRUX — a client load-older walk reaches the session's oldest
	// message. Replicates the FE walk + the HTTP handler's boundary-demand
	// D-trigger (fetch one older page via the backward cursor, merge, re-page).
	before := meta.OldestLoadedID
	if before == "" {
		t.Fatal("window meta carried no OldestLoadedID to walk from")
	}
	reached := ""
	for step := 0; step < 32; step++ {
		page := agg.Store().SnapshotMessagesPage(sid, before, state.WindowMaxCount, 1<<20)
		// Boundary-demand D-trigger (pkg/web/messages_http.go:133-140): the
		// handler gate is resident-floor equality — BoundaryFound &&
		// !CountLimited && !BytesLimited && !HistoryExhausted && before ==
		// floorID (before != floorID defers to the next click; the old
		// !OversizedItem term was dropped). This walk keeps a stricter inline
		// replication — still testing !OversizedItem, walking `before` via
		// the loop cursor instead of floor equality — equivalent on this
		// light, never-oversized fixture: fetch one older page from opencode,
		// merge, re-project.
		if page.BoundaryFound && !page.CountLimited && !page.BytesLimited && !page.OversizedItem && !page.HistoryExhausted {
			if oid, oms, ok := agg.Store().OldestResidentCursorTuple(sid); ok {
				if err := agg.EnsureOlderMessages(sid, oid, oms); err != nil {
					t.Fatalf("EnsureOlderMessages (walk step %d): %v", step, err)
				}
				page = agg.Store().SnapshotMessagesPage(sid, before, state.WindowMaxCount, 1<<20)
			}
		}
		reached = page.OldestID
		if !page.HasOlder {
			break
		}
		before = page.OldestID
	}
	if reached != "cm1" {
		t.Fatalf("CRUX (b) FAIL: load-older walk reached %q, want cm1 (the session oldest)", reached)
	}

	// No-inverse-lie: a small session (n < WindowMaxCount) whose tail GET
	// carries NO X-Next-Cursor reports has_older=false (fully loaded).
	const small = "small"
	fake.SeedChronologicalMessages(small, 40)
	if err := agg.EnsureMessages(ctx, small); err != nil {
		t.Fatalf("EnsureMessages (small session): %v", err)
	}
	smallMeta, ok := agg.Store().Snapshot(map[string]bool{small: true}).MessageWindows[small]
	if !ok {
		t.Fatalf("snapshot must carry MessageWindows[%s]", small)
	}
	if smallMeta.HasOlder {
		t.Fatalf("no-inverse-lie FAIL: small fully-fetched session HasOlder want false, got true (%+v)", smallMeta)
	}
}
