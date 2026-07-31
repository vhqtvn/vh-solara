package web

// SSE stream tests for Slice 3 of server-managed root-session labels.
//
// Slice 3 wires the LabelStore into the /vh/stream SSE channel:
//   - labels.snapshot: a bootstrap frame emitted on EVERY fresh /vh/stream
//     connect, sourced from s.labels.Snapshot(). It is the catch-up mechanism
//     for a reconnecting client (transient labels.updated events are NOT
//     replayed from the ring — see pkg/state/emit_transient).
//   - labels.updated: a transient fan-out emitted after a committed PUT 200,
//     reaching ALL active project stores' live subscribers (worker-wide — a
//     mutation on project A reaches a subscriber viewing project B).
//
// Both frames carry the public LabelsDoc payload {revision, groups, tags,
// tagIdsByRootSessionId} and are written with NO `id:` line (writeRawNoID) so
// they never become a resume cursor — they are orthogonal to the state store's
// seq space.
//
// This file mirrors pkg/web/pins_stream_test.go test-for-test (snapshot-on-
// connect, update fan-out to multiple project streams, reconnect restoration,
// subscribe-before-snapshot bootstrap race protection, worker-wide fan-out, and
// no broadcast from rejected writes). The SSE reader helpers (startSSEReader,
// drainIdle, hasEvent, eventDataFor, eventNames) and lastCursor are shared from
// tree_detail_test.go / pins_stream_test.go.
//
// Lane: Go co-located unit (pkg/web/). Exercises the real HTTP stack via
// httptest.NewServer(srv.Handler()) and the shared SSE reader helpers.

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// decodeLabelsSSEData decodes a LabelsDoc from a single SSE data: line. All
// labels frames carry single-line compact JSON (json.Marshal output), so the
// sseEvent.data field (which holds the last data: line) is sufficient.
func decodeLabelsSSEData(t *testing.T, data string) LabelsDoc {
	t.Helper()
	var r LabelsDoc
	if err := json.Unmarshal([]byte(data), &r); err != nil {
		t.Fatalf("decode labels SSE data: %v (data: %s)", err, data)
	}
	return r
}

// maxLabelsRevision observes the highest revision across ALL labels.snapshot and
// labels.updated events in the batch. Used by the mutation-during-bootstrap test
// where the mutation may be covered by EITHER the snapshot OR the queued live
// frame depending on the race outcome.
func maxLabelsRevision(t *testing.T, events []sseEvent) int64 {
	t.Helper()
	var max int64 = -1
	for _, e := range events {
		if e.event != "labels.snapshot" && e.event != "labels.updated" {
			continue
		}
		r := decodeLabelsSSEData(t, e.data)
		if r.Revision > max {
			max = r.Revision
		}
	}
	return max
}

// labelsRootIDs extracts the set of root ids referenced anywhere in the doc (a
// convenience for stream assertions that check membership without caring about
// the group vs tag-assignment split).
func labelsRootIDs(r LabelsDoc) map[string]bool {
	out := make(map[string]bool)
	for _, g := range r.Groups {
		for _, rid := range g.OrderedRootSessionIDs {
			out[rid] = true
		}
	}
	for rid := range r.TagIDsByRootSessionID {
		out[rid] = true
	}
	return out
}

// --- 1. Bootstrap: fresh connect receives labels.snapshot -------------------

// TestLabelsStreamBootstrapSnapshot asserts a fresh /vh/stream connect emits a
// labels.snapshot frame carrying the current label state. This is the catch-up
// contract: whatever the LabelStore holds at connect time is delivered as the
// initial labels truth, before the live tail begins.
func TestLabelsStreamBootstrapSnapshot(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	seedLabelSession(t, srv.agg, "root-a", "")

	// Establish labels state: rev 1, one group with [root-a].
	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "Backend", "color": "blue", "orderedRootSessionIds": []string{"root-a"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("seed PUT: status %d, want 200. body: %s", resp.StatusCode, b)
	}
	resp.Body.Close()

	// Fresh connect — no cursor.
	sresp, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatalf("GET /vh/stream: %v", err)
	}
	defer sresp.Body.Close()

	ch := startSSEReader(t, sresp.Body)
	events := drainIdle(ch, 500*time.Millisecond)

	snapData, ok := eventDataFor(events, "labels.snapshot", "revision")
	if !ok {
		t.Fatalf("fresh connect did not receive labels.snapshot; events: %v", eventNames(events))
	}
	r := decodeLabelsSSEData(t, snapData)
	if r.Revision != 1 {
		t.Fatalf("labels.snapshot revision = %d, want 1", r.Revision)
	}
	if len(r.Groups) != 1 || r.Groups[0].ID != "g1" || len(r.Groups[0].OrderedRootSessionIDs) != 1 || r.Groups[0].OrderedRootSessionIDs[0] != "root-a" {
		t.Fatalf("labels.snapshot groups = %+v, want g1 with [root-a]", r.Groups)
	}
	// The snapshot must NOT leak projectByRootSessionId (internal field).
	if strings.Contains(snapData, "projectByRootSessionId") {
		t.Fatalf("labels.snapshot leaks projectByRootSessionId: %s", snapData)
	}
}

// --- 2. Two concurrent subscribers both receive labels.updated ---------------

// TestLabelsStreamTwoSubsBothGetUpdate asserts that after a committed PUT 200,
// EVERY live /vh/stream subscriber receives a labels.updated frame. This is the
// cross-client broadcast contract: a label edit on one tab is seen by all open
// tabs.
func TestLabelsStreamTwoSubsBothGetUpdate(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	seedLabelSession(t, srv.agg, "root-a", "")
	seedLabelSession(t, srv.agg, "root-b", "")

	// Establish rev 1: one group [root-a].
	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "Backend", "color": "blue", "orderedRootSessionIds": []string{"root-a"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	resp.Body.Close()

	// Open TWO concurrent subscribers.
	s1, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatalf("GET /vh/stream sub1: %v", err)
	}
	defer s1.Body.Close()
	s2, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatalf("GET /vh/stream sub2: %v", err)
	}
	defer s2.Body.Close()

	ch1 := startSSEReader(t, s1.Body)
	ch2 := startSSEReader(t, s2.Body)

	// Drain the initial bootstrap so only live events remain.
	drainIdle(ch1, 500*time.Millisecond)
	drainIdle(ch2, 500*time.Millisecond)

	// Commit rev 2: group now [root-a, root-b].
	resp2 := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 1,
		"groups": []map[string]any{
			{"id": "g1", "name": "Backend", "color": "blue", "orderedRootSessionIds": []string{"root-a", "root-b"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	if resp2.StatusCode != 200 {
		b, _ := io.ReadAll(resp2.Body)
		resp2.Body.Close()
		t.Fatalf("PUT rev 2: status %d, want 200. body: %s", resp2.StatusCode, b)
	}
	resp2.Body.Close()

	ev1 := drainIdle(ch1, 1*time.Second)
	ev2 := drainIdle(ch2, 1*time.Second)

	for name, events := range map[string][]sseEvent{"sub1": ev1, "sub2": ev2} {
		data, ok := eventDataFor(events, "labels.updated", "revision")
		if !ok {
			t.Fatalf("%s did not receive labels.updated; events: %v", name, eventNames(events))
		}
		r := decodeLabelsSSEData(t, data)
		if r.Revision != 2 {
			t.Fatalf("%s labels.updated revision = %d, want 2", name, r.Revision)
		}
		ids := labelsRootIDs(r)
		if !ids["root-a"] || !ids["root-b"] {
			t.Fatalf("%s labels.updated root ids = %v, want {root-a root-b}", name, ids)
		}
	}
}

// --- 3. Reconnect catches up via snapshot (transient not replayed) --------

// TestLabelsStreamReconnectCatchUpViaSnapshot asserts the catch-up contract: a
// transient labels.updated is NOT replayed from the ring on reconnect, but the
// fresh labels.snapshot frame on the reconnect carries the latest committed
// state. This is why labels.updated is emitted via EmitTransient (no ring
// record) and labels.snapshot is emitted on every fresh connect.
func TestLabelsStreamReconnectCatchUpViaSnapshot(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	seedLabelSession(t, srv.agg, "root-a", "")
	seedLabelSession(t, srv.agg, "root-b", "")

	// rev 1 [root-a] — no listeners, so the transient is emitted to nobody.
	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"root-a"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	resp.Body.Close()

	// Connect stream A, drain bootstrap, capture cursor.
	sa, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatalf("GET /vh/stream stream A: %v", err)
	}
	cha := startSSEReader(t, sa.Body)
	initA := drainIdle(cha, 500*time.Millisecond)
	cursor := lastCursor(initA)

	// Confirm the bootstrap snapshot shows rev 1.
	if data, ok := eventDataFor(initA, "labels.snapshot", "revision"); !ok {
		t.Fatalf("stream A bootstrap missing labels.snapshot; events: %v", eventNames(initA))
	} else {
		if r := decodeLabelsSSEData(t, data); r.Revision != 1 {
			t.Fatalf("stream A labels.snapshot rev = %d, want 1", r.Revision)
		}
	}

	// Commit rev 2 [root-a, root-b] → stream A's LIVE subscriber gets the
	// transient labels.updated (delivered once to the live channel).
	resp2 := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 1,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"root-a", "root-b"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	resp2.Body.Close()
	liveA := drainIdle(cha, 1*time.Second)
	if !hasEvent(liveA, "labels.updated") {
		t.Fatalf("stream A did not receive the live labels.updated for rev 2; events: %v", eventNames(liveA))
	}
	sa.Body.Close()

	// Reconnect with the captured cursor. The transient labels.updated from
	// above is NOT in the ring, so replay must NOT include it. But the fresh
	// labels.snapshot must carry rev 2 (the catch-up).
	rb, _ := http.NewRequest(http.MethodGet, web.URL+"/vh/stream?cursor="+cursor, nil)
	srb, err := http.DefaultClient.Do(rb)
	if err != nil {
		t.Fatalf("reconnect GET: %v", err)
	}
	defer srb.Body.Close()
	chrb := startSSEReader(t, srb.Body)
	reconn := drainIdle(chrb, 500*time.Millisecond)

	// The reconnect snapshot must show rev 2 (latest committed state).
	data, ok := eventDataFor(reconn, "labels.snapshot", "revision")
	if !ok {
		t.Fatalf("reconnect missing labels.snapshot; events: %v", eventNames(reconn))
	}
	rSnap := decodeLabelsSSEData(t, data)
	if rSnap.Revision != 2 {
		t.Fatalf("reconnect labels.snapshot rev = %d, want 2 (catch-up via snapshot)", rSnap.Revision)
	}

	// The transient labels.updated must NOT appear in the reconnect stream —
	// it was live-only and is not replayed.
	if hasEvent(reconn, "labels.updated") {
		t.Fatalf("reconnect replayed a transient labels.updated — it must be live-only; events: %v", eventNames(reconn))
	}
}

// --- 4. Mutation during bootstrap is not lost -----------------------------

// TestLabelsStreamMutationDuringBootstrapNotLost asserts the subscribe-before-
// snapshot ordering guarantee: handleStream subscribes to the store BEFORE
// reading the labels snapshot, so a mutation that lands between connect and
// snapshot-read is covered by EITHER the snapshot (if the read happened after
// the commit) OR the queued live labels.updated (if the read happened before).
// The client never misses a mutation that raced with its bootstrap.
func TestLabelsStreamMutationDuringBootstrapNotLost(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	seedLabelSession(t, srv.agg, "root-a", "")
	seedLabelSession(t, srv.agg, "root-b", "")

	// rev 1 [root-a].
	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"root-a"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	resp.Body.Close()

	// Connect and immediately race a rev-2 mutation into the bootstrap.
	sresp, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatalf("GET /vh/stream: %v", err)
	}
	ch := startSSEReader(t, sresp.Body)

	resp2 := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 1,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"root-a", "root-b"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	if resp2.StatusCode != 200 {
		b, _ := io.ReadAll(resp2.Body)
		resp2.Body.Close()
		t.Fatalf("racing PUT rev 2: status %d, want 200. body: %s", resp2.StatusCode, b)
	}
	resp2.Body.Close()

	// Drain everything — bootstrap + any queued live frame.
	events := drainIdle(ch, 1*time.Second)
	sresp.Body.Close()

	// Regardless of the race outcome, the client must have observed rev 2:
	// either via labels.snapshot (read after commit) or via labels.updated
	// (queued because subscribe preceded the snapshot read).
	maxRev := maxLabelsRevision(t, events)
	if maxRev < 2 {
		t.Fatalf("mutation during bootstrap was lost: max labels revision observed = %d, want >= 2; events: %v",
			maxRev, eventNames(events))
	}
}

// --- 5. Worker-wide fan-out: other-project subscriber gets the update -----

// TestLabelsStreamOtherProjectFanOut asserts the worker-wide broadcast: a PUT
// on the DEFAULT project reaches a subscriber viewing a DIFFERENT project
// (/proj2). FanOutLabelsUpdate iterates ALL s.aggs stores under aggMu and emits
// to each, so the cross-project delivery is guaranteed.
func TestLabelsStreamOtherProjectFanOut(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	seedLabelSession(t, srv.agg, "root-a", "")

	// Register a second project aggregator so its store has a subscriber.
	const deadURL = "http://127.0.0.1:1"
	proj2 := aggregator.New(deadURL, 100)
	srv.aggs["/proj2"] = proj2

	// Subscriber on /proj2 — subscribes to proj2's store, NOT the default.
	s2, err := http.Get(web.URL + "/vh/stream?dir=/proj2")
	if err != nil {
		t.Fatalf("GET /vh/stream?dir=/proj2: %v", err)
	}
	defer s2.Body.Close()
	ch2 := startSSEReader(t, s2.Body)
	drainIdle(ch2, 500*time.Millisecond) // clear proj2 bootstrap

	// Also open a default-project subscriber to confirm BOTH receive it.
	s1, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatalf("GET /vh/stream default: %v", err)
	}
	defer s1.Body.Close()
	ch1 := startSSEReader(t, s1.Body)
	drainIdle(ch1, 500*time.Millisecond) // clear default bootstrap

	// Commit a PUT on the DEFAULT project (no ?dir=).
	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"root-a"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("PUT on default project: status %d, want 200. body: %s", resp.StatusCode, b)
	}
	resp.Body.Close()

	ev1 := drainIdle(ch1, 1*time.Second)
	ev2 := drainIdle(ch2, 1*time.Second)

	// The DEFAULT subscriber gets it (sanity).
	if !hasEvent(ev1, "labels.updated") {
		t.Fatalf("default-project subscriber did not receive labels.updated; events: %v", eventNames(ev1))
	}

	// The OTHER-project subscriber MUST also get it — this is the worker-wide
	// fan-out contract. If only the default store were notified, this fails.
	if !hasEvent(ev2, "labels.updated") {
		t.Fatalf("/proj2 subscriber did NOT receive labels.updated — fan-out did not reach the other project; events: %v", eventNames(ev2))
	}
	r2 := decodeLabelsSSEData(t, func() string {
		d, ok := eventDataFor(ev2, "labels.updated", "")
		if !ok {
			t.Fatalf("/proj2 subscriber labels.updated data missing (should be unreachable — hasEvent passed)")
		}
		return d
	}())
	if r2.Revision != 1 {
		t.Fatalf("/proj2 subscriber labels.updated revision = %d, want 1", r2.Revision)
	}
}

// --- 6. No broadcast on reject (409 / 400) --------------------------------

// TestLabelsStreamNoEmitOnReject asserts that a rejected PUT (409 CAS mismatch
// or 400 strict-input failure) does NOT broadcast a labels.updated frame. Only
// a committed 200 fans out.
func TestLabelsStreamNoEmitOnReject(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	seedLabelSession(t, srv.agg, "root-a", "")

	// Establish rev 1.
	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"root-a"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	resp.Body.Close()

	// Open a subscriber and clear bootstrap.
	sresp, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatalf("GET /vh/stream: %v", err)
	}
	defer sresp.Body.Close()
	ch := startSSEReader(t, sresp.Body)
	drainIdle(ch, 500*time.Millisecond)

	// 409: stale baseRevision (CAS mismatch — current is rev 1, claim 99).
	resp409 := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 99,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"root-a"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	if resp409.StatusCode != 409 {
		b, _ := io.ReadAll(resp409.Body)
		resp409.Body.Close()
		t.Fatalf("stale PUT: status %d, want 409. body: %s", resp409.StatusCode, b)
	}
	resp409.Body.Close()

	// 400: unknown root not in the active set.
	resp400 := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 1,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"root-ghost"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	if resp400.StatusCode != 400 {
		b, _ := io.ReadAll(resp400.Body)
		resp400.Body.Close()
		t.Fatalf("unknown-root PUT: status %d, want 400. body: %s", resp400.StatusCode, b)
	}
	resp400.Body.Close()

	// Drain an idle window — NO labels.updated must arrive.
	events := drainIdle(ch, 500*time.Millisecond)
	if hasEvent(events, "labels.updated") {
		t.Fatalf("a rejected PUT broadcast labels.updated — only a committed 200 may fan out; events: %v", eventNames(events))
	}
}
