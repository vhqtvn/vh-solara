package web

// stream_probe_test.go — webperf slice 4 unit coverage for the end-to-end
// liveness sentinel probe (POST /vh/stream/probe → transient vh.liveness).
//
// Invariants pinned here (the three fences the design demands):
//  1. EMIT + NONCE ECHO: a POST with a nonce reaches every LIVE subscriber
//     of the project store — including a message-FILTERED session stream
//     (?sessions=<id>) and the tree-only stream (?sessions=) — because
//     state.Store.EmitTransient bypasses the Interest filter. The frame
//     carries the nonce verbatim.
//  2. NO-ID: the vh.liveness frame has NO `id:` line (writeRawNoID path), so
//     it can never advance Last-Event-ID / resume cursors or the per-
//     connection delivery ordinal — exactly like ping/notice.
//  3. RING/SEQ ISOLATION: the probe does not advance the store seq and is
//     not recorded in the replay ring — a reconnect with cursor=<pre-probe
//     head> never replays a vh.liveness frame.
// Plus the auth/CSRF/method/validation ladder.
//
// Lane: Go co-located unit (pkg/web/), real HTTP stack via httptest.

import (
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// probeServer builds the standard verb-test server (fakeOC backend, Shutdown
// cleanup) — the same fixture newVerbServer provides, kept local for clarity.
func probeServer(t *testing.T) (*httptest.Server, *aggregator.Aggregator) {
	t.Helper()
	f := &fakeOC{}
	return newVerbServer(t, f)
}

// openProbeStream opens a /vh/stream with the given sessions= filter, drains
// the bootstrap frames, and returns the still-running SSE reader channel so
// the live tail can be drained in a later phase (one reader per body — the
// startSSEReader goroutine owns the body from here on).
func openProbeStream(t *testing.T, webURL, sessionsQ string) (*http.Response, <-chan sseEvent, []sseEvent) {
	t.Helper()
	u := webURL + "/vh/stream"
	if sessionsQ != "" {
		u += "?" + sessionsQ
	}
	resp, err := http.Get(u)
	if err != nil {
		t.Fatalf("GET /vh/stream: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("GET /vh/stream: status %d", resp.StatusCode)
	}
	ch := startSSEReader(t, resp.Body)
	return resp, ch, drainIdle(ch, 400*time.Millisecond)
}

// postProbe POSTs the sentinel probe with the CSRF header and returns the
// response (body unclosed for status asserts).
func postProbe(t *testing.T, webURL, nonce string, hdr map[string]string) *http.Response {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, webURL+"/vh/stream/probe?nonce="+nonce, nil)
	req.Header.Set(csrfHeader, "1")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST /vh/stream/probe: %v", err)
	}
	return resp
}

// --- 1. Emit + nonce echo + interest bypass + no-id -------------------------

func TestStreamProbeEmitsLivenessEverySubscriberNoID(t *testing.T) {
	web, agg := probeServer(t)
	_ = agg

	// Two subscribers with DIFFERENT interest shapes: a message-filtered
	// session stream (Interest.MessageSessions = {sess-x}) and the tree-only
	// stream (empty filter). EmitTransient must reach BOTH.
	s1, ch1, boot1 := openProbeStream(t, web.URL, "sessions=sess-x")
	defer s1.Body.Close()
	s2, ch2, boot2 := openProbeStream(t, web.URL, "sessions=")
	defer s2.Body.Close()
	for i, b := range [][]sseEvent{boot1, boot2} {
		for _, e := range b {
			if e.event == "vh.liveness" {
				t.Fatalf("bootstrap batch %d contained vh.liveness (should only ever be live): %v", i, eventNames(b))
			}
		}
	}

	resp := postProbe(t, web.URL, "nonce-abc-123", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST probe: status %d, want 200", resp.StatusCode)
	}
	resp.Body.Close()

	for name, ch := range map[string]<-chan sseEvent{"session-filtered": ch1, "tree-only": ch2} {
		events := drainIdle(ch, 2*time.Second)
		var live *sseEvent
		for i := range events {
			if events[i].event == "vh.liveness" {
				live = &events[i]
				break
			}
		}
		if live == nil {
			t.Fatalf("%s stream did not receive vh.liveness; events: %v", name, eventNames(events))
		}
		if live.id != "" {
			t.Fatalf("%s vh.liveness carries id %q — MUST have no id line (cursor advance)", name, live.id)
		}
		if !strings.Contains(live.data, "nonce-abc-123") {
			t.Fatalf("%s vh.liveness data missing nonce: %s", name, live.data)
		}
	}
}

// --- 2. Ring/seq isolation ---------------------------------------------------

func TestStreamProbeNotReplayedNotSeqAdvancing(t *testing.T) {
	web, agg := probeServer(t)

	// Apply one real event so the store has a nonzero head + ring content.
	applyCreate(agg.Store(), "sess-a", "")
	head := agg.Store().Head()

	// Stream once to establish a baseline, then probe.
	s1, ch1, _ := openProbeStream(t, web.URL, "")
	defer s1.Body.Close()
	resp := postProbe(t, web.URL, "nonce-ring", nil)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("POST probe: status %d", resp.StatusCode)
	}
	resp.Body.Close()
	// Drain the live liveness frame so it cannot confuse the reconnect read.
	drainIdle(ch1, 500*time.Millisecond)

	// Fence (b): the probe must NOT advance the store seq (EmitTransient
	// reuses the head).
	if got := agg.Store().Head(); got != head {
		t.Fatalf("store head advanced by probe: before=%d after=%d", head, got)
	}

	// Fence (c): a reconnect at cursor=head must NOT replay vh.liveness.
	s2, boot := openProbeStreamCursor(t, web.URL, head)
	defer s2.Body.Close()
	for _, e := range boot {
		if e.event == "vh.liveness" {
			t.Fatalf("vh.liveness was REPLAYED on reconnect (cursor=%d) — must not be in the ring", head)
		}
	}
}

// openProbeStreamCursor is openProbeStream with a cursor= resume param
// (bootstrap drain included; the reader channel is dropped — this stream is
// only used for the replay assertion).
func openProbeStreamCursor(t *testing.T, webURL string, cursor uint64) (*http.Response, []sseEvent) {
	t.Helper()
	resp, err := http.Get(webURL + "/vh/stream?cursor=" + strconv.FormatUint(cursor, 10))
	if err != nil {
		t.Fatalf("GET /vh/stream?cursor: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		t.Fatalf("GET /vh/stream?cursor: status %d", resp.StatusCode)
	}
	ch := startSSEReader(t, resp.Body)
	return resp, drainIdle(ch, 400*time.Millisecond)
}

// --- 3. CSRF / method / validation ladder -----------------------------------

func TestStreamProbeGuardLadder(t *testing.T) {
	web, _ := probeServer(t)

	// POST WITHOUT the CSRF header → the cross-cutting csrfGuard rejects
	// (exact code pinned — 401/404/500 would also fail the rung but mask a
	// guard regression; mirrors diag_auth_test.go's ladder precision).
	req, _ := http.NewRequest(http.MethodPost, web.URL+"/vh/stream/probe?nonce=x", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("POST without CSRF: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("POST without CSRF header: got %d, want 403", resp.StatusCode)
	}

	// GET → handler method guard (CSRF header lets it past csrfGuard so the
	// 405 proves the handler-level guard, mirroring diag_auth_test.go 3b).
	req2, _ := http.NewRequest(http.MethodGet, web.URL+"/vh/stream/probe?nonce=x", nil)
	req2.Header.Set(csrfHeader, "1")
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatalf("GET probe: %v", err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET probe: status %d, want 405", resp2.StatusCode)
	}

	// Missing nonce → 400.
	r3 := postProbe(t, web.URL, "", nil)
	r3.Body.Close()
	if r3.StatusCode != http.StatusBadRequest {
		t.Fatalf("POST probe without nonce: status %d, want 400", r3.StatusCode)
	}

	// Oversized nonce (129 chars) → 400.
	r4 := postProbe(t, web.URL, strings.Repeat("n", 129), nil)
	r4.Body.Close()
	if r4.StatusCode != http.StatusBadRequest {
		t.Fatalf("POST probe with 129-char nonce: status %d, want 400", r4.StatusCode)
	}
}
