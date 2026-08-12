package web

// part_append_legacy_replay_test.go — Slice 2 §4.3 web-layer contract (see
// docs/ai/wire-protocols/part-append-streaming.md §4.3). A LEGACY
// (non-opted-in) connection whose replay range contains a KindPartAppend must
// NOT interpret those suffix frames — it would lose the full-text reference a
// legacy client needs. handleStream detects "replay range contains a kind the
// client did not negotiate" and falls back to a fresh snapshot.
//
// This test exercises the FULL handleStream path end-to-end (real SSE over
// httptest) for both the negative (legacy → snapshot) and the positive
// (opted-in → suffix replay) reconnect, so the §4.3 detection + the
// Interest.WantsPartDelta threading through the real subscription are both
// proven at the wire boundary.

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// TestPartAppend_LegacyReplayFallbackToSnapshot is the §4.3 negative: a legacy
// connection reconnecting with a cursor whose replay window contains a
// KindPartAppend must receive a fresh SNAPSHOT (its catch-up path), NOT the
// replayed suffix frames it cannot interpret. The opted-in reconnect over the
// SAME cursor replays the suffix frames normally (the positive control — the
// suffix is the negotiated format and replay is the happy path).
//
// Uses ?sessions=s1 so message-class events (part.append / part.upsert) pass
// the sendable() filter (plain /vh/stream is the tree-only Stream 1 with an
// empty non-nil filter that drops ALL message-class events).
func TestPartAppend_LegacyReplayFallbackToSnapshot(t *testing.T) {
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	store.Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	store.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"s1","role":"assistant"}}`))
	store.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"s1","messageID":"m1","type":"text","text":""}}`))

	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// 1. Fresh connect (?sessions=s1) to capture a cursor = head BEFORE any
	//    deltas. The fresh-connect path emits a wholesale "snapshot"; its SSE
	//    id is the store head seq (the resume cursor).
	resp1, err := http.Get(web.URL + "/vh/stream?sessions=s1")
	if err != nil {
		t.Fatal(err)
	}
	initial := drainIdle(startSSEReader(t, resp1.Body), 600*time.Millisecond)
	resp1.Body.Close()
	cursor := lastEventIDOf(initial, "snapshot")
	if cursor == "" {
		t.Fatalf("fresh connect: no snapshot SSE id; events=%v", eventNames(initial))
	}

	// 2. Land KindPartAppend events into the ring by applying deltas. The flush
	//    path emits part.append for the allowlisted text field regardless of
	//    live subscribers (the ring is the source of truth — spec §4). The first
	//    delta of a burst always flushes (immediate-first-token), so at least
	//    one part.append lands at seq > cursor.
	store.Apply(ev("message.part.delta", `{"sessionID":"s1","messageID":"m1","partID":"p1","field":"text","delta":"a"}`))
	store.Apply(ev("message.part.delta", `{"sessionID":"s1","messageID":"m1","partID":"p1","field":"text","delta":"b"}`))
	store.Apply(ev("message.part.delta", `{"sessionID":"s1","messageID":"m1","partID":"p1","field":"text","delta":"c"}`))

	// 3a. LEGACY reconnect (?sessions=s1, no part_delta=1): §4.3 must fall back
	//     to snapshot. The legacy client must NEVER see part.append on the wire.
	legacyReq, _ := http.NewRequest("GET", web.URL+"/vh/stream?sessions=s1", nil)
	legacyReq.Header.Set("Last-Event-ID", cursor)
	legacyResp, err := http.DefaultClient.Do(legacyReq)
	if err != nil {
		t.Fatal(err)
	}
	defer legacyResp.Body.Close()
	legacyResumed := drainIdle(startSSEReader(t, legacyResp.Body), 800*time.Millisecond)
	if !hasEvent(legacyResumed, "snapshot") {
		t.Errorf("§4.3: legacy reconnect over part.append ring range must get a SNAPSHOT (fallback), events=%v", eventNames(legacyResumed))
	}
	if hasEvent(legacyResumed, "part.append") {
		t.Errorf("§4.3: legacy reconnect must NEVER see part.append on the wire (live or replay), events=%v", eventNames(legacyResumed))
	}

	// 3b. OPTED-IN reconnect (?sessions=s1&part_delta=1) over the SAME cursor:
	//     replays the suffix frames normally (the positive control — the suffix
	//     is the negotiated format and replay is the happy path). It must NOT
	//     fall back to a snapshot (no §4.3 trigger for opted-in).
	optReq, _ := http.NewRequest("GET", web.URL+"/vh/stream?sessions=s1&part_delta=1", nil)
	optReq.Header.Set("Last-Event-ID", cursor)
	optResp, err := http.DefaultClient.Do(optReq)
	if err != nil {
		t.Fatal(err)
	}
	defer optResp.Body.Close()
	optResumed := drainIdle(startSSEReader(t, optResp.Body), 800*time.Millisecond)
	if !hasEvent(optResumed, "part.append") {
		t.Errorf("§4 positive: opted-in reconnect over part.append ring range must REPLAY the suffix frames, events=%v", eventNames(optResumed))
	}
	if hasEvent(optResumed, "snapshot") {
		t.Errorf("§4 positive: opted-in reconnect must NOT fall back to snapshot (§4.3 is legacy-only), events=%v", eventNames(optResumed))
	}
}
