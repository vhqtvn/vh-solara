package web

// tree_resume_detail_test.go — Phase 3 Step B (C-F1): tree=2 resume/reconnect
// must bootstrap the FULL session-detail snapshot (and re-seed the tree
// frontier), mirroring the fresh-connect path (GAP 3, committed 3903b131).
//
// The fresh-connect path (else branch, stream_http.go) and the ring-gap path
// already emit BOTH tree.snapshot (structure) AND the legacy detail snapshot
// (state.sessions/permissions/questions/todos bootstrap). The replay branch
// (hasCursor && replayOK, stream_http.go) emitted ONLY tree.op deltas + legacy
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
	"strconv"
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
	t.Parallel() // per-test treeReplayServer; no env/disk/log-sink changes and no exact shared-metric assertions (diagnostics counters may increase)
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
	// Slice-A partial contract: the tree=2 resume now emits a FRONTIER-SCOPED
	// detail snapshot (mode "tree-stream-1-frontier"), not the legacy full
	// detail. With no session loaded, the frontier = roots only (R); buried
	// children (C1, C2) are intentionally omitted and arrive via the expand
	// bundle (/vh/tree/children detail, slice-A D2) when the node is opened.
	// Assert: snapshot is partial, R (root/frontier) present, C2 (buried) absent.
	data, hasR := eventDataFor(resumed, "snapshot", "R")
	if !hasR {
		t.Errorf("tree=2 resume: partial snapshot should contain frontier root R; events=%v", eventNames(resumed))
	} else if !strings.Contains(data, "tree-stream-1-frontier") {
		t.Errorf("tree=2 resume: snapshot should be partial (mode tree-stream-1-frontier); data=%.200s", data)
	}
	if _, hasC2 := eventDataFor(resumed, "snapshot", "C2"); hasC2 {
		t.Errorf("tree=2 resume: partial snapshot must OMIT buried C2 (arrives via expand); events=%v", eventNames(resumed))
	}

	// D-F1 green-on-arrival pin (review ses_ed9164bb2): the replay-SUCCESS
	// re-seed's detail snapshot must NOT carry partial.ringGap — the server
	// stamps that flag ONLY on the ring-gap fallback (hasCursor && !replayOK);
	// omitempty drops a false flag from the wire entirely. This is the
	// benign-reconnect half of the contract: cause:"reconnect" WITHOUT
	// partial.ringGap is a cursor-resume that missed nothing. Pinning EXISTING
	// emission — no RED expected or observed.
	for _, e := range resumed {
		if e.event == "snapshot" && strings.Contains(e.data, `"ringGap":true`) {
			t.Errorf("replay-success resume: detail snapshot must NOT carry partial.ringGap (benign reconnect re-seed); data=%.200s", e.data)
		}
	}
}

// TestTreeResume_ReconnectAtHeadBootstrapsDetail is the no-delta variant: the
// client reconnects at exactly head (no new events since the cursor). The replay
// window is empty (replayOK=true, events=[]) but the bootstrap snapshots must
// STILL flow — a client that resumed at head with empty detail maps must be
// seeded. This is the purest C-F1 signal (no ring deltas to mask the gap).
func TestTreeResume_ReconnectAtHeadBootstrapsDetail(t *testing.T) {
	t.Parallel() // per-test treeReplayServer; no env/disk/log-sink changes and no exact shared-metric assertions (diagnostics counters may increase)
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

// TestTreeResume_StaleEpochCursorFreshFallback is the daemon-restart variant
// (P2 cursor invalidation): a tree=2 reconnect whose cursor EXCEEDS the
// current store head (the cursor predates a daemon restart; a fresh store's
// seq restarts low) must take the FRESH fallback, not the old
// `cursor >= head → current` replay branch. ring.since returns ok=false for
// cursor > head, so handleStream routes into the fresh else-branch and the
// client receives the full snapshot trio — tree.snapshot with cause
// "reconnect" (wholesale replace), the detail snapshot with
// partial.ringGap:true stamped (the D1 sole stamping site:
// hasCursor && !replayOK), and the snapshot.complete boundary — plus the
// journal attributes the fallback as stale_cursor_exceeds_head. The live tail
// then flows from baseline=snap.Seq with no dupes: an event applied after the
// trio arrives EXACTLY once.
//
// Contrast with TestTreeResume_ReconnectAtHeadBootstrapsDetail above, which
// pins the cursor == head case (replay branch + trio) — byte-identical
// behavior preserved there.
func TestTreeResume_StaleEpochCursorFreshFallback(t *testing.T) {
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	applyCreate(store, "R", "")
	applyCreate(store, "C1", "R")

	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// A cursor from the PREVIOUS daemon lifetime, far above the current head.
	staleCursor := store.Head() + 500
	req, _ := http.NewRequest("GET", web.URL+"/vh/stream?tree=2", nil)
	req.Header.Set("Last-Event-ID", strconv.FormatUint(staleCursor, 10))

	// The stream open (Do) MUST happen INSIDE captureBaselines: Do returns
	// once the handler flushes headers, but the handler's "stream baseline"
	// journal write happens after that flush — swapping the sink after Do
	// would race the journal write to the previous sink (commit-review F1).
	var events []sseEvent
	var ch <-chan sseEvent
	var resp *http.Response
	lines := captureBaselines(t, func() {
		var err error
		resp, err = http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		ch = startSSEReader(t, resp.Body)
		// Phase 1 — drain the trio (snapshot.complete is its deterministic
		// end marker); the journal line precedes the trio on the wire, so
		// draining it also proves the line landed in the capture sink.
		events = drainIdle(ch, 600*time.Millisecond)
	})
	defer resp.Body.Close()

	// Full trio, in order: tree.snapshot (cause "reconnect") → detail
	// snapshot (partial, ringGap:true) → snapshot.complete.
	treeIdx, detailIdx, completeIdx := -1, -1, -1
	for i, e := range events {
		switch e.event {
		case "tree.snapshot":
			if treeIdx < 0 {
				treeIdx = i
			}
		case "snapshot":
			if detailIdx < 0 {
				detailIdx = i
			}
		case "snapshot.complete":
			if completeIdx < 0 {
				completeIdx = i
			}
		}
	}
	if treeIdx < 0 || detailIdx < 0 || completeIdx < 0 {
		t.Fatalf("stale-epoch tree reconnect: want the full trio (tree.snapshot, snapshot, snapshot.complete); events=%v", eventNames(events))
	}
	if !(treeIdx < detailIdx && detailIdx < completeIdx) {
		t.Fatalf("stale-epoch tree reconnect: trio out of order (tree=%d detail=%d complete=%d); events=%v", treeIdx, detailIdx, completeIdx, eventNames(events))
	}
	if !strings.Contains(events[treeIdx].data, `"reconnect"`) {
		t.Errorf("stale-epoch tree.snapshot cause must be \"reconnect\" (wholesale replace); data=%.200s", events[treeIdx].data)
	}
	if !strings.Contains(events[detailIdx].data, `"ringGap":true`) {
		t.Errorf("stale-epoch detail snapshot must carry partial.ringGap:true (D1 stamping site: hasCursor && !replayOK); data=%.200s", events[detailIdx].data)
	}

	// Journal attribution: fresh path + the stale-cursor discriminator.
	line := lastBaselineLine(t, lines, 1)
	if !strings.Contains(line, "path=fresh") {
		t.Errorf("stale-epoch tree reconnect: journal must say path=fresh: %q", line)
	}
	if !strings.Contains(line, "fallback_reason=stale_cursor_exceeds_head") {
		t.Errorf("stale-epoch tree reconnect: journal must attribute fallback_reason=stale_cursor_exceeds_head: %q", line)
	}

	// Live-tail no-dupe check on the SAME connection: with the trio's
	// baseline = snap.Seq, an event applied AFTER the fallback snapshot must
	// arrive on the tail exactly once (it is NOT in the snapshot, NOT
	// replayed — the stale cursor took the fresh branch — and the baseline
	// guard suppresses nothing new).
	applyCreate(store, "C2", "R")
	tail := drainIdle(ch, 600*time.Millisecond)

	c2Ops := 0
	for _, e := range tail {
		if e.event == "tree.op" && strings.Contains(e.data, `"C2"`) {
			c2Ops++
		}
	}
	if c2Ops != 1 {
		t.Fatalf("live tail after stale-epoch fallback: want exactly 1 tree.op referencing C2, got %d; tail=%v", c2Ops, eventNames(tail))
	}
}
