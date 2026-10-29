package web

// stream_baseline_fallback_reason_test.go — PWA warm-resume fallback
// attribution (card task-2026-10-28t15-08-16). The always-on "stream
// baseline" journal line must carry fallback_reason ∈ {cursorless,
// ring_eviction, compatibility_fallback, none} + part_append_in_range so a
// real-resume capture can tell WHY each fresh snapshot was served WITHOUT
// VH_DEBUG and without touching the (deliberately unchanged) partial.ringGap
// wire semantics. Branch coverage:
//
//   cursorless             — fresh connect, no resume cursor.
//   ring_eviction          — cursor older than the retained ring window
//                            (store.Replay itself reports !ok).
//   compatibility_fallback — replay range contains part.append on a
//                            non-opted-in connection (the §4.3 scan flips
//                            replayOK; NO events were actually missed).
//   none                   — the replay branch served the cursor (opted-in
//                            over a part.append range → part_append_in_range
//                            remains observable on the replay path too).
//
// The line is emitted at Info level (always-on) so capture works on the
// production binary; vhlog.SetOutput intercepts it here.

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// lockedWriter serializes concurrent handler-goroutine log writes.
type lockedWriter struct {
	mu  *sync.Mutex
	buf *bytes.Buffer
}

func (w lockedWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.buf.Write(p)
}

// captureBaselines swaps the vhlog sink around `do`, returning every
// "stream baseline" line written while it ran.
func captureBaselines(t *testing.T, do func()) []string {
	t.Helper()
	var mu sync.Mutex
	var buf bytes.Buffer
	prev := vhlog.SetOutput(lockedWriter{&mu, &buf})
	defer vhlog.SetOutput(prev)
	do()
	mu.Lock()
	defer mu.Unlock()
	var lines []string
	for _, l := range strings.Split(buf.String(), "\n") {
		if strings.Contains(l, "stream baseline") {
			lines = append(lines, l)
		}
	}
	return lines
}

// lastBaselineLine returns the (single) baseline line captured; fails the
// test if the count differs from want.
func lastBaselineLine(t *testing.T, lines []string, want int) string {
	t.Helper()
	if len(lines) != want {
		t.Fatalf("captured %d stream-baseline lines, want %d: %v", len(lines), want, lines)
	}
	return lines[want-1]
}

// The cursorless + compatibility_fallback + none branches over the SAME
// part.append-in-range store, mirroring TestPartAppend_LegacyReplayFallback.
func TestStreamBaseline_FallbackReason_Matrix(t *testing.T) {
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	store.Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	store.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"s1","role":"assistant"}}`))
	store.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"s1","messageID":"m1","type":"text","text":""}}`))

	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// 1. Cursorless: fresh connect, no Last-Event-ID, no cursor param. The
	//    snapshot id this connect emits is ALSO the resume cursor for steps
	//    2–3 (captured BEFORE any deltas land — mirrors the §4.3 test).
	var cursor string
	var cursorlessLine string
	lines := captureBaselines(t, func() {
		resp, err := http.Get(web.URL + "/vh/stream?sessions=s1")
		if err != nil {
			t.Fatal(err)
		}
		evs := drainIdle(startSSEReader(t, resp.Body), 500*time.Millisecond)
		resp.Body.Close()
		cursor = lastEventIDOf(evs, "snapshot")
		if cursor == "" {
			t.Fatalf("fresh connect: no snapshot id; events=%v", eventNames(evs))
		}
	})
	cursorlessLine = lastBaselineLine(t, lines, 1)
	if !strings.Contains(cursorlessLine, "path=fresh") || !strings.Contains(cursorlessLine, "fallback_reason=cursorless") {
		t.Errorf("cursorless: line = %q", cursorlessLine)
	}
	if !strings.Contains(cursorlessLine, "part_append_in_range=false") {
		t.Errorf("cursorless: part_append_in_range should be false (no range scanned): %q", cursorlessLine)
	}

	// Land KindPartAppend events into the ring at seq > cursor (the §4.3
	// replay range). The flush path emits part.append for the allowlisted
	// text field regardless of live subscribers.
	store.Apply(ev("message.part.delta", `{"sessionID":"s1","messageID":"m1","partID":"p1","field":"text","delta":"a"}`))
	store.Apply(ev("message.part.delta", `{"sessionID":"s1","messageID":"m1","partID":"p1","field":"text","delta":"b"}`))

	// 2. compatibility_fallback: LEGACY reconnect (no part_delta) whose
	// replay range contains a part.append → fresh snapshot despite no loss.
	lines = captureBaselines(t, func() {
		req, _ := http.NewRequest("GET", web.URL+"/vh/stream?sessions=s1", nil)
		req.Header.Set("Last-Event-ID", cursor)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		legacyResumed := drainIdle(startSSEReader(t, resp.Body), 700*time.Millisecond)
		resp.Body.Close()
		if !hasEvent(legacyResumed, "snapshot") {
			t.Errorf("§4.3: legacy reconnect must fall back to a SNAPSHOT, events=%v", eventNames(legacyResumed))
		}
	})
	compatLine := lastBaselineLine(t, lines, 1)
	if !strings.Contains(compatLine, "path=fresh") || !strings.Contains(compatLine, "fallback_reason=compatibility_fallback") {
		t.Errorf("compatibility_fallback: line = %q", compatLine)
	}
	if !strings.Contains(compatLine, "had_cursor=true") {
		t.Errorf("compatibility_fallback: had_cursor must be true: %q", compatLine)
	}
	if !strings.Contains(compatLine, "part_append_in_range=true") {
		t.Errorf("compatibility_fallback: part_append_in_range must be true (that is WHY it flipped): %q", compatLine)
	}

	// 3. none: OPTED-IN reconnect over the SAME range replays the suffixes;
	//    the journal keeps fallback_reason=none and still reports
	//    part_append_in_range=true (the range contains part.append).
	lines = captureBaselines(t, func() {
		req, _ := http.NewRequest("GET", web.URL+"/vh/stream?sessions=s1&part_delta=1", nil)
		req.Header.Set("Last-Event-ID", cursor)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		optResumed := drainIdle(startSSEReader(t, resp.Body), 700*time.Millisecond)
		resp.Body.Close()
		if !hasEvent(optResumed, "part.append") {
			t.Errorf("opted-in reconnect must replay part.append, events=%v", eventNames(optResumed))
		}
	})
	noneLine := lastBaselineLine(t, lines, 1)
	if !strings.Contains(noneLine, "path=replay") || !strings.Contains(noneLine, "fallback_reason=none") {
		t.Errorf("none/replay: line = %q", noneLine)
	}
	if !strings.Contains(noneLine, "part_append_in_range=true") {
		t.Errorf("none/replay: part_append_in_range must be observable on the replay path: %q", noneLine)
	}
}

// TestStreamBaseline_FallbackReason_TreeStreamPartDeltaReplay — the
// tree-stream (Stream 1) case the 2026-10-29 parked item actioned
// (task-2026-10-29t17-37-06-tree-stream-part-delta-opt-in): a tree stream
// that opts into part_delta=1 and reconnects over a replay range containing
// part.append MUST take the replay branch (fallback_reason=none) — the
// opt-in removes the COMPATIBILITY_FALLBACK branch classification (no fresh
// re-seed flip when part.append sits in the cursor range; the 00:03+07
// worker journal caught the mis-flip twice, gaps 712/1122, both under ring
// capacity). The replay branch still unconditionally emits its reconnect
// snapshot pair (stream_http.go:447-496 SnapshotWithTreePartial): a
// semantics/consistency fix + fallback_reason=none in the journal — not
// snapshot elimination.
//
// Tree-specific pins beyond the matrix test (which covers sessions=s1):
//   - The tree URL shape is `sessions=` EMPTY + `tree=2`, so the replayed
//     part.append events are dropped at the egress sendable() gate — the tree
//     client receives NO part.append frames (live parity: the same gate drops
//     them on the live tail, and the Interest filter keeps message-class
//     events out of the tree channel entirely). Replay tolerance merely
//     matches live tolerance.
//   - replayed counts the RAW ring slice (2 part.append events), even though
//     zero of them cross the wire for this stream.
//
// Red-first note: written against the OPT-IN path — with `&part_delta=1`
// removed from the URL this exact connect flips to path=fresh
// fallback_reason=compatibility_fallback (the matrix test's step 2 branch).
func TestStreamBaseline_FallbackReason_TreeStreamPartDeltaReplay(t *testing.T) {
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	store.Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	store.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"s1","role":"assistant"}}`))
	store.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"s1","messageID":"m1","type":"text","text":""}}`))
	// A SECOND message+part: deltaLastEmit is per-messageEntry (reducers.go
	// appendPartDeltaLocked), so two deltas on the SAME message inside the
	// flush-interval window coalesce into ONE ring event (the throttle —
	// first-of-burst flushes, the rest buffer). Seeding a second message makes
	// the replayed count below deterministic: each message's first delta
	// flushes → exactly TWO KindPartAppend ring events above the cursor.
	store.Apply(ev("message.updated", `{"info":{"id":"m2","sessionID":"s1","role":"assistant"}}`))
	store.Apply(ev("message.part.updated", `{"part":{"id":"p2","sessionID":"s1","messageID":"m2","type":"text","text":""}}`))

	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// 1. Cursorless tree connect (the real tree URL shape): fresh frontier
	//    bootstrap. The detail snapshot's SSE id (store head, compound form)
	//    is the resume cursor for step 3.
	var cursor string
	lines := captureBaselines(t, func() {
		resp, err := http.Get(web.URL + "/vh/stream?sessions=&tree=2")
		if err != nil {
			t.Fatal(err)
		}
		evs := drainIdle(startSSEReader(t, resp.Body), 500*time.Millisecond)
		resp.Body.Close()
		cursor = lastEventIDOf(evs, "snapshot")
		if cursor == "" {
			t.Fatalf("tree fresh connect: no detail snapshot id; events=%v", eventNames(evs))
		}
	})
	cursorlessLine := lastBaselineLine(t, lines, 1)
	if !strings.Contains(cursorlessLine, "path=fresh") || !strings.Contains(cursorlessLine, "fallback_reason=cursorless") {
		t.Errorf("tree cursorless: line = %q", cursorlessLine)
	}

	// Land KindPartAppend events into the ring at seq > cursor: one delta per
	// MESSAGE (m1, m2) so both flush (per-message throttle — see the seeding
	// comment above). Same flush shape as the matrix test: the flush emits the
	// ring event regardless of live subscribers — none are attached to this
	// store between connects.
	store.Apply(ev("message.part.delta", `{"sessionID":"s1","messageID":"m1","partID":"p1","field":"text","delta":"a"}`))
	store.Apply(ev("message.part.delta", `{"sessionID":"s1","messageID":"m2","partID":"p2","field":"text","delta":"c"}`))

	// 2. Opted-in TREE reconnect over the part.append-bearing range → the
	//    §4.3 scan must NOT flip: replay branch, fallback_reason=none, and
	//    (tree-specific) NO part frames delivered — the empty sessions filter
	//    drops them at sendable(), exactly as the live tail would.
	lines = captureBaselines(t, func() {
		req, _ := http.NewRequest("GET", web.URL+"/vh/stream?sessions=&tree=2&part_delta=1", nil)
		req.Header.Set("Last-Event-ID", cursor)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		treeResumed := drainIdle(startSSEReader(t, resp.Body), 700*time.Millisecond)
		resp.Body.Close()
		if hasEvent(treeResumed, "part.append") {
			t.Errorf("tree replay must NOT deliver part.append frames (empty sessions filter drops them at sendable): %v", eventNames(treeResumed))
		}
		if hasEvent(treeResumed, "part.upsert") {
			t.Errorf("tree replay must NOT deliver part.upsert frames either: %v", eventNames(treeResumed))
		}
	})
	line := lastBaselineLine(t, lines, 1)
	if !strings.Contains(line, "path=replay") || !strings.Contains(line, "fallback_reason=none") {
		t.Errorf("tree opt-in replay: line = %q", line)
	}
	if !strings.Contains(line, "part_append_in_range=true") {
		t.Errorf("tree opt-in replay: part_append_in_range must be true (the range contains them): %q", line)
	}
	if !strings.Contains(line, "replayed=2") {
		t.Errorf("tree opt-in replay: replayed must count the RAW ring slice (2 part.append events): %q", line)
	}
}

// TestStreamBaseline_FallbackReason_RingEviction — a cursor older than the
// retained ring window (capacity 1000 in treeReplayServer) makes store.Replay
// report !ok at ENTRY: the journal must say ring_eviction (a true gap), not
// compatibility_fallback.
func TestStreamBaseline_FallbackReason_RingEviction(t *testing.T) {
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	store.Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// Cursor at seq 1 (the first session.created), then evict it by applying
	// more than capacity (1000) further events.
	const extra = 1100
	for i := 0; i < extra; i++ {
		store.Apply(ev("session.created", `{"info":{"id":"x`+strconv.Itoa(i)+`"}}`))
	}

	lines := captureBaselines(t, func() {
		req, _ := http.NewRequest("GET", web.URL+"/vh/stream?sessions=s1", nil)
		req.Header.Set("Last-Event-ID", "1")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		evs := drainIdle(startSSEReader(t, resp.Body), 700*time.Millisecond)
		resp.Body.Close()
		if !hasEvent(evs, "snapshot") {
			t.Errorf("ring-eviction reconnect must be served a fresh SNAPSHOT, events=%v", eventNames(evs))
		}
	})
	line := lastBaselineLine(t, lines, 1)
	if !strings.Contains(line, "path=fresh") || !strings.Contains(line, "fallback_reason=ring_eviction") {
		t.Errorf("ring_eviction: line = %q", line)
	}
	if !strings.Contains(line, "had_cursor=true") {
		t.Errorf("ring_eviction: had_cursor must be true: %q", line)
	}
	if !strings.Contains(line, "part_append_in_range=false") {
		t.Errorf("ring_eviction: no replay range was scanned → part_append_in_range=false: %q", line)
	}
}
