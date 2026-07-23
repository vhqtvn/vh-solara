package web

// tree_resume_detail_test.go — Phase 3 Step B (C-F1): tree=2 resume/reconnect
// must bootstrap the FULL session-detail snapshot (and re-seed the tree
// frontier), mirroring the fresh-connect path (GAP 3, committed 3903b131).
//
// The fresh-connect path (else branch, server.go ~1562) and the ring-gap path
// already emit BOTH tree.snapshot (structure) AND the legacy detail snapshot
// (state.sessions/permissions/questions/todos bootstrap). The replay branch
// (hasCursor && replayOK, server.go ~1480) emitted ONLY tree.op deltas + legacy
// writeEvent detail frames for the replayed window — it did NOT re-bootstrap a
// tree.snapshot frontier NOR a fresh legacy detail snapshot.
//
// Why that matters: the tree flat map (treeMap) is NEVER persisted (design §11)
// and the detail maps are not persisted either. A tree=2 client that enters the
// replay branch with an empty/unseeded treeMap (e.g. native EventSource
// auto-reconnect after a transient drop on a reloaded page, or any future path
// that resumes with a valid cursor) would receive only ring deltas — leaving
// structure + detail unpopulated. Contract completeness also demands every
// tree=2 connect path emits both projections.
//
// The fix mirrors the GAP 3 fresh-connect block into the replay branch: AFTER
// the replay loop + baseline=head, when treeEmitter != nil, emit tree.snapshot
// (cause "reconnect") + the raw legacy detail snapshot. The replayed deltas
// (seq N+1..head) are superseded by the authoritative snapshots at head; the
// live-tail baseline guard (ev.Seq > baseline) prevents re-forwarding.
//
// This test asserts the resume/reconnect path emits BOTH snapshots (RED on the
// pre-fix replay path which emitted only tree.op ring deltas).

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// lastEventIDOf returns the SSE id of the last event in events whose event kind
// matches kind, or "" if none.
func lastEventIDOf(events []sseEvent, kind string) string {
	for i := len(events) - 1; i >= 0; i-- {
		if events[i].event == kind {
			return events[i].id
		}
	}
	return ""
}

// TestTreeResume_ReconnectBootstrapsDetail asserts a tree=2 reconnect with a
// valid cursor (replay-OK path) emits BOTH tree.snapshot AND the legacy detail
// snapshot, not just tree.op ring deltas. This is the C-F1 gap-closure: the
// resume path must bootstrap full detail (mirroring GAP 3's fresh-connect
// block) so a client reconnecting with empty in-memory detail maps is seeded.
func TestTreeResume_ReconnectBootstrapsDetail(t *testing.T) {
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	applyCreate(store, "R", "")
	applyCreate(store, "C1", "R")

	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// 1. Fresh connect: drain initial pair + capture the cursor (tree.snapshot
	//    SSE id = store head seq).
	resp1, err := http.Get(web.URL + "/vh/stream?tree=2")
	if err != nil {
		t.Fatal(err)
	}
	ch1 := startSSEReader(t, resp1.Body)
	initial := drainIdle(ch1, 600*time.Millisecond)
	resp1.Body.Close()
	if !hasEvent(initial, "tree.snapshot") {
		t.Fatalf("fresh connect: missing tree.snapshot; events=%v", eventNames(initial))
	}
	cursor := lastEventIDOf(initial, "tree.snapshot")
	if cursor == "" {
		t.Fatalf("fresh connect: tree.snapshot has no SSE id; events=%v", eventNames(initial))
	}

	// 2. Advance head so the replay window is non-empty (a delta to replay).
	applyCreate(store, "C2", "R")

	// 3. Reconnect with Last-Event-ID = cursor (valid → replay-OK path).
	req, _ := http.NewRequest("GET", web.URL+"/vh/stream?tree=2", nil)
	req.Header.Set("Last-Event-ID", cursor)
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()

	ch2 := startSSEReader(t, resp2.Body)
	resumed := drainIdle(ch2, 600*time.Millisecond)

	// C-F1: the resume path MUST bootstrap BOTH projections, not just deltas.
	if !hasEvent(resumed, "tree.snapshot") {
		t.Errorf("tree=2 resume: MISSING tree.snapshot (frontier re-seed); events=%v", eventNames(resumed))
	}
	if !hasEvent(resumed, "snapshot") {
		t.Errorf("tree=2 resume: MISSING legacy snapshot (detail bootstrap); events=%v", eventNames(resumed))
	}
	// The legacy detail snapshot must carry the session detail (incl. C2).
	if data, ok := eventDataFor(resumed, "snapshot", "C2"); !ok {
		t.Errorf("tree=2 resume: legacy snapshot should contain C2 detail; events=%v", eventNames(resumed))
	} else if !strings.Contains(data, "R") {
		t.Errorf("tree=2 resume: legacy snapshot should also contain R; data=%.200s", data)
	}
}

// TestTreeResume_ReconnectAtHeadBootstrapsDetail is the no-delta variant: the
// client reconnects at exactly head (no new events since the cursor). The replay
// window is empty (replayOK=true, events=[]) but the bootstrap snapshots must
// STILL flow — a client that resumed at head with empty detail maps must be
// seeded. This is the purest C-F1 signal (no ring deltas to mask the gap).
func TestTreeResume_ReconnectAtHeadBootstrapsDetail(t *testing.T) {
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	applyCreate(store, "R", "")
	applyCreate(store, "C1", "R")

	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// Fresh connect to capture cursor = head.
	resp1, err := http.Get(web.URL + "/vh/stream?tree=2")
	if err != nil {
		t.Fatal(err)
	}
	initial := drainIdle(startSSEReader(t, resp1.Body), 600*time.Millisecond)
	resp1.Body.Close()
	cursor := lastEventIDOf(initial, "tree.snapshot")
	if cursor == "" {
		t.Fatalf("fresh connect: no tree.snapshot id; events=%v", eventNames(initial))
	}
	_ = store // no advance — reconnect at exactly head

	// Reconnect at head (no new events): replay window empty, replayOK=true.
	req, _ := http.NewRequest("GET", web.URL+"/vh/stream?tree=2", nil)
	req.Header.Set("Last-Event-ID", cursor)
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()

	resumed := drainIdle(startSSEReader(t, resp2.Body), 600*time.Millisecond)

	if !hasEvent(resumed, "tree.snapshot") {
		t.Errorf("tree=2 resume@head: MISSING tree.snapshot; events=%v", eventNames(resumed))
	}
	if !hasEvent(resumed, "snapshot") {
		t.Errorf("tree=2 resume@head: MISSING legacy snapshot; events=%v", eventNames(resumed))
	}
}
