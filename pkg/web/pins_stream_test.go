package web

// SSE stream tests for Phase 3 of server-managed pinned sessions.
//
// Phase 3 wires the PinStore into the /vh/stream SSE channel:
//   - pins.snapshot: a bootstrap frame emitted on EVERY fresh /vh/stream
//     connect, sourced from s.pins.Snapshot() → pinsPublicRespFromDoc. It is
//     the catch-up mechanism for a reconnecting client (transient pins.updated
//     events are NOT replayed from the ring — see pkg/state/emit_transient).
//   - pins.updated: a transient fan-out emitted after a committed PUT 200,
//     reaching ALL active project stores' live subscribers (worker-wide — a
//     mutation on project A reaches a subscriber viewing project B).
//
// Both frames carry the public pins payload {revision, initialized,
// orderedSessionIds} and are written with NO `id:` line (writeRawNoID) so they
// never become a resume cursor — they are orthogonal to the state store's seq
// space.
//
// Lane: Go co-located unit (pkg/web/). Exercises the real HTTP stack via
// httptest.NewServer(srv.Handler()) and the SSE reader helpers shared with
// tree_detail_test.go / tree_replay_test.go.

import (
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// decodePinsSSEData decodes a pinsPublicResp from a single SSE data: line.
// All pins frames carry single-line compact JSON (json.Marshal output), so the
// sseEvent.data field (which holds the last data: line) is sufficient.
func decodePinsSSEData(t *testing.T, data string) pinsPublicResp {
	t.Helper()
	var r pinsPublicResp
	if err := json.Unmarshal([]byte(data), &r); err != nil {
		t.Fatalf("decode pins SSE data: %v (data: %s)", err, data)
	}
	return r
}

// lastCursor returns the highest numeric `id:` seen across events, or "0" if
// none. Used to build a reconnect cursor from the initial bootstrap drain.
// pins.snapshot/pins.updated carry no id (writeRawNoID), so they are skipped
// and only state-store seq events contribute.
func lastCursor(events []sseEvent) string {
	var max uint64
	for _, e := range events {
		if e.id == "" {
			continue
		}
		n, err := strconv.ParseUint(e.id, 10, 64)
		if err != nil {
			continue
		}
		if n > max {
			max = n
		}
	}
	return strconv.FormatUint(max, 10)
}

// maxPinsRevision observes the highest revision across ALL pins.snapshot and
// pins.updated events in the batch. Used by the mutation-during-bootstrap test
// where the mutation may be covered by EITHER the snapshot OR the queued live
// frame depending on the race outcome.
func maxPinsRevision(t *testing.T, events []sseEvent) int64 {
	t.Helper()
	var max int64 = -1
	for _, e := range events {
		if e.event != "pins.snapshot" && e.event != "pins.updated" {
			continue
		}
		r := decodePinsSSEData(t, e.data)
		if r.Revision > max {
			max = r.Revision
		}
	}
	return max
}

// --- 1. Bootstrap: fresh connect receives pins.snapshot -------------------

// TestPinsStreamBootstrapSnapshot asserts a fresh /vh/stream connect emits a
// pins.snapshot frame carrying the current pin state. This is the catch-up
// contract: whatever the PinStore holds at connect time is delivered as the
// initial pins truth, before the live tail begins.
func TestPinsStreamBootstrapSnapshot(t *testing.T) {
	srv, web := newPinsTestServer(t)
	seedPinSession(t, srv.agg, "sess-a")

	// Establish pins state: rev 1, [sess-a].
	resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"sess-a"},
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

	snapData, ok := eventDataFor(events, "pins.snapshot", "revision")
	if !ok {
		t.Fatalf("fresh connect did not receive pins.snapshot; events: %v", eventNames(events))
	}
	r := decodePinsSSEData(t, snapData)
	if r.Revision != 1 {
		t.Fatalf("pins.snapshot revision = %d, want 1", r.Revision)
	}
	if !r.Initialized {
		t.Fatalf("pins.snapshot initialized = false, want true")
	}
	if len(r.OrderedSessionIDs) != 1 || r.OrderedSessionIDs[0] != "sess-a" {
		t.Fatalf("pins.snapshot orderedSessionIds = %v, want [sess-a]", r.OrderedSessionIDs)
	}
	// The snapshot must NOT leak projectBySessionId (internal field).
	if strings.Contains(snapData, "projectBySessionId") {
		t.Fatalf("pins.snapshot leaks projectBySessionId: %s", snapData)
	}
}

// --- 2. Two concurrent subscribers both receive pins.updated ---------------

// TestPinsStreamTwoSubsBothGetUpdate asserts that after a committed PUT 200,
// EVERY live /vh/stream subscriber receives a pins.updated frame. This is the
// cross-client broadcast contract: a pin reorder on one tab is seen by all
// open tabs.
func TestPinsStreamTwoSubsBothGetUpdate(t *testing.T) {
	srv, web := newPinsTestServer(t)
	seedPinSession(t, srv.agg, "sess-a")
	seedPinSession(t, srv.agg, "sess-b")

	// Establish rev 1 [sess-a].
	resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"sess-a"},
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

	// Commit rev 2: reorder to [sess-a, sess-b].
	resp2 := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      1,
		"orderedSessionIds": []string{"sess-a", "sess-b"},
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
		data, ok := eventDataFor(events, "pins.updated", "revision")
		if !ok {
			t.Fatalf("%s did not receive pins.updated; events: %v", name, eventNames(events))
		}
		r := decodePinsSSEData(t, data)
		if r.Revision != 2 {
			t.Fatalf("%s pins.updated revision = %d, want 2", name, r.Revision)
		}
		if len(r.OrderedSessionIDs) != 2 || r.OrderedSessionIDs[1] != "sess-b" {
			t.Fatalf("%s pins.updated orderedSessionIds = %v, want [sess-a sess-b]", name, r.OrderedSessionIDs)
		}
	}
}

// --- 3. Reconnect catches up via snapshot (transient not replayed) --------

// TestPinsStreamReconnectCatchUpViaSnapshot asserts the catch-up contract: a
// transient pins.updated is NOT replayed from the ring on reconnect, but the
// fresh pins.snapshot frame on the reconnect carries the latest committed
// state. This is why pins.updated is emitted via EmitTransient (no ring record)
// and pins.snapshot is emitted on every fresh connect.
func TestPinsStreamReconnectCatchUpViaSnapshot(t *testing.T) {
	srv, web := newPinsTestServer(t)
	seedPinSession(t, srv.agg, "sess-a")
	seedPinSession(t, srv.agg, "sess-b")

	// rev 1 [sess-a] — no listeners, so the transient is emitted to nobody.
	resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"sess-a"},
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
	if data, ok := eventDataFor(initA, "pins.snapshot", "revision"); !ok {
		t.Fatalf("stream A bootstrap missing pins.snapshot; events: %v", eventNames(initA))
	} else {
		if r := decodePinsSSEData(t, data); r.Revision != 1 {
			t.Fatalf("stream A pins.snapshot rev = %d, want 1", r.Revision)
		}
	}

	// Commit rev 2 [sess-a, sess-b] → stream A's LIVE subscriber gets the
	// transient pins.updated (delivered once to the live channel).
	resp2 := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      1,
		"orderedSessionIds": []string{"sess-a", "sess-b"},
	})
	resp2.Body.Close()
	liveA := drainIdle(cha, 1*time.Second)
	if !hasEvent(liveA, "pins.updated") {
		t.Fatalf("stream A did not receive the live pins.updated for rev 2; events: %v", eventNames(liveA))
	}
	sa.Body.Close()

	// Reconnect with the captured cursor. The transient pins.updated from
	// above is NOT in the ring, so replay must NOT include it. But the fresh
	// pins.snapshot must carry rev 2 (the catch-up).
	rb, _ := http.NewRequest(http.MethodGet, web.URL+"/vh/stream?cursor="+cursor, nil)
	srb, err := http.DefaultClient.Do(rb)
	if err != nil {
		t.Fatalf("reconnect GET: %v", err)
	}
	defer srb.Body.Close()
	chrb := startSSEReader(t, srb.Body)
	reconn := drainIdle(chrb, 500*time.Millisecond)

	// The reconnect snapshot must show rev 2 (latest committed state).
	data, ok := eventDataFor(reconn, "pins.snapshot", "revision")
	if !ok {
		t.Fatalf("reconnect missing pins.snapshot; events: %v", eventNames(reconn))
	}
	rSnap := decodePinsSSEData(t, data)
	if rSnap.Revision != 2 {
		t.Fatalf("reconnect pins.snapshot rev = %d, want 2 (catch-up via snapshot)", rSnap.Revision)
	}

	// The transient pins.updated must NOT appear in the reconnect stream —
	// it was live-only and is not replayed. (No new mutation happened during
	// the reconnect, so no pins.updated should be present at all.)
	if hasEvent(reconn, "pins.updated") {
		t.Fatalf("reconnect replayed a transient pins.updated — it must be live-only; events: %v", eventNames(reconn))
	}
}

// --- 4. Mutation during bootstrap is not lost -----------------------------

// TestPinsStreamMutationDuringBootstrapNotLost asserts the subscribe-before-
// snapshot ordering guarantee: handleStream subscribes to the store BEFORE
// reading the pins snapshot, so a mutation that lands between connect and
// snapshot-read is covered by EITHER the snapshot (if the read happened after
// the commit) OR the queued live pins.updated (if the read happened before).
// The client never misses a mutation that raced with its bootstrap.
func TestPinsStreamMutationDuringBootstrapNotLost(t *testing.T) {
	srv, web := newPinsTestServer(t)
	seedPinSession(t, srv.agg, "sess-a")
	seedPinSession(t, srv.agg, "sess-b")

	// rev 1 [sess-a].
	resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"sess-a"},
	})
	resp.Body.Close()

	// Connect and immediately race a rev-2 mutation into the bootstrap.
	sresp, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatalf("GET /vh/stream: %v", err)
	}
	ch := startSSEReader(t, sresp.Body)

	resp2 := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      1,
		"orderedSessionIds": []string{"sess-a", "sess-b"},
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
	// either via pins.snapshot (read after commit) or via pins.updated
	// (queued because subscribe preceded the snapshot read).
	maxRev := maxPinsRevision(t, events)
	if maxRev < 2 {
		t.Fatalf("mutation during bootstrap was lost: max pins revision observed = %d, want >= 2; events: %v",
			maxRev, eventNames(events))
	}
}

// --- 5. Worker-wide fan-out: other-project subscriber gets the update -----

// TestPinsStreamOtherProjectFanOut asserts the worker-wide broadcast: a PUT
// on the DEFAULT project reaches a subscriber viewing a DIFFERENT project
// (/proj2). FanOutPinsUpdate iterates ALL s.aggs stores under aggMu and emits
// to each, so the cross-project delivery is guaranteed.
func TestPinsStreamOtherProjectFanOut(t *testing.T) {
	srv, web := newPinsTestServer(t)
	seedPinSession(t, srv.agg, "sess-a")

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
	resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"sess-a"},
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
	if !hasEvent(ev1, "pins.updated") {
		t.Fatalf("default-project subscriber did not receive pins.updated; events: %v", eventNames(ev1))
	}

	// The OTHER-project subscriber MUST also get it — this is the worker-wide
	// fan-out contract. If only the default store were notified, this fails.
	if !hasEvent(ev2, "pins.updated") {
		t.Fatalf("/proj2 subscriber did NOT receive pins.updated — fan-out did not reach the other project; events: %v", eventNames(ev2))
	}
	r2 := decodePinsSSEData(t, func() string {
		d, ok := eventDataFor(ev2, "pins.updated", "")
		if !ok {
			t.Fatalf("/proj2 subscriber pins.updated data missing (should be unreachable — hasEvent passed)")
		}
		return d
	}())
	if r2.Revision != 1 {
		t.Fatalf("/proj2 subscriber pins.updated revision = %d, want 1", r2.Revision)
	}
}

// --- 6. No broadcast on reject (409 / 400) --------------------------------

// TestPinsStreamNoEmitOnReject asserts that a rejected PUT (409 CAS mismatch
// or 400 strict-input failure) does NOT broadcast a pins.updated frame. Only
// a committed 200 fans out.
func TestPinsStreamNoEmitOnReject(t *testing.T) {
	srv, web := newPinsTestServer(t)
	seedPinSession(t, srv.agg, "sess-a")

	// Establish rev 1.
	resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"sess-a"},
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
	resp409 := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      99,
		"orderedSessionIds": []string{"sess-a"},
	})
	if resp409.StatusCode != 409 {
		b, _ := io.ReadAll(resp409.Body)
		resp409.Body.Close()
		t.Fatalf("stale PUT: status %d, want 409. body: %s", resp409.StatusCode, b)
	}
	resp409.Body.Close()

	// 400: unknown orderedSessionId not in the active set.
	resp400 := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      1,
		"orderedSessionIds": []string{"sess-ghost"},
	})
	if resp400.StatusCode != 400 {
		b, _ := io.ReadAll(resp400.Body)
		resp400.Body.Close()
		t.Fatalf("unknown-ID PUT: status %d, want 400. body: %s", resp400.StatusCode, b)
	}
	resp400.Body.Close()

	// Drain an idle window — NO pins.updated must arrive.
	events := drainIdle(ch, 500*time.Millisecond)
	if hasEvent(events, "pins.updated") {
		t.Fatalf("a rejected PUT broadcast pins.updated — only a committed 200 may fan out; events: %v", eventNames(events))
	}
}
