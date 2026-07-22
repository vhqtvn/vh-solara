package web

// Session-stream replay proving tests for the Stream2 resumability fix.
//
// The handleStream handler is SHARED between Stream1 (?sessions= tree) and
// Stream2 (?sessions=<id> selected session). The replay-vs-snapshot branch
// (server.go ~1394-1467) already honors Last-Event-ID / cursor= for ANY filter
// — but the Stream2 CLIENT never sent a cursor (stream.ts openSessionStream
// constructed a cursorless URL), so the server ALWAYS took the fresh-snapshot
// branch for session streams. The client fix (this phase) tracks a local
// sesCursor and passes cursor= on retry, so a transient CLOSED→manual-retry
// hits the replay branch and catches up via ring deltas instead of re-shipping
// the full transcript.
//
// These tests prove the SERVER SIDE already handles session-scoped replay
// correctly (the shared handler's sendable() filter scopes message/part events
// to ?sessions=<id>). They lock the behavior the client fix depends on:
//   1. A valid cursor → replay (deltas from ring, NOT a fresh snapshot).
//   2. No cursor → fresh snapshot (the cold-open path).
//   3. A too-old cursor (ring overflow) → fresh snapshot (the windowing bound).

import (
	"bufio"
	"context"
	"net/http"
	"strconv"
	"testing"
	"time"
)

// openSessionStreamReq opens a /vh/stream?sessions=<sid> with an optional
// cursor, bound to a deadline-bounded context. z is omitted so snapshot data is
// raw JSON (parsable for assertions). Returns the body reader + cancel func.
func openSessionStreamReq(t *testing.T, webURL, sid string, cursor uint64, hasCursor bool, deadline time.Duration) (*bufio.Reader, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), deadline)
	t.Cleanup(cancel)
	url := webURL + "/vh/stream?sessions=" + sid
	if hasCursor {
		url += "&cursor=" + strconv.FormatUint(cursor, 10)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return bufio.NewReader(resp.Body), cancel
}

// firstFrameEvent reads the first dispatchable SSE frame and returns its event
// name. Returns "" if the body closes before a frame dispatches. Comment lines
// (: hello) and retry: hints are skipped by readSSEFrameSilent.
func firstFrameEvent(t *testing.T, r *bufio.Reader) string {
	t.Helper()
	ev, _ := readSSEFrameSilent(r)
	return ev
}

// TestSessionStream_ReplayOnValidCursor proves a session stream with a valid
// cursor takes the REPLAY branch: missed deltas are shipped from the ring, NOT
// a fresh snapshot. This is the path the client fix (sesCursor → cursor=)
// activates on retry. FAIL-without (if the server ignored cursor for session
// streams) / PASS-with.
func TestSessionStream_ReplayOnValidCursor(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)
	_ = fake

	// Seed a session. After this, head = seq of the session.created event.
	srv.agg.Store().Apply(sessionCreatedEvent("s1"))
	waitFor(t, func() bool { return srv.agg.Store().HasSession("s1") },
		"seed session s1")

	// Cursor = the session.created seq. Replay will return events with seq >
	// this cursor.
	cursor := srv.agg.Store().Head()

	// Apply an activity event AFTER recording the cursor. This event (seq >
	// cursor) should be replayed.
	srv.agg.Store().Apply(statusBusyEvent("s1"))

	// Open the session stream WITH the cursor. The server should take the
	// replay branch and ship the activity delta, NOT a fresh snapshot.
	reader, _ := openSessionStreamReq(t, web.URL, "s1", cursor, true, 500*time.Millisecond)

	first := firstFrameEvent(t, reader)
	if first == "snapshot" {
		t.Fatal("valid cursor: want replay (delta event, NOT snapshot), got snapshot — server did not take the replay branch for a session stream")
	}
	if first == "" {
		t.Fatal("valid cursor: stream closed before any frame dispatched — expected a replayed delta event")
	}
	// The session.status event emits TWO client events: KindStatus ("status")
	// then KindActivity ("activity" — idle→busy is a state change). Either is a
	// valid replayed structural delta proving the replay branch was taken.
	if first != "status" && first != "activity" {
		t.Fatalf("valid cursor: want first replayed event 'status' or 'activity', got %q", first)
	}
}

// TestSessionStream_FreshSnapshotOnNoCursor proves a session stream with NO
// cursor takes the fresh-snapshot branch (the cold-open path). This is the
// existing behavior and the correct path for a session switch / first open.
func TestSessionStream_FreshSnapshotOnNoCursor(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)
	_ = fake

	srv.agg.Store().Apply(sessionCreatedEvent("s1"))
	waitFor(t, func() bool { return srv.agg.Store().HasSession("s1") },
		"seed session s1")

	// Open with NO cursor — the server must take the fresh-snapshot branch.
	reader, _ := openSessionStreamReq(t, web.URL, "s1", 0, false, 500*time.Millisecond)

	first := firstFrameEvent(t, reader)
	if first != "snapshot" {
		t.Fatalf("no cursor: want first frame 'snapshot', got %q (fresh-snapshot branch not taken)", first)
	}
}

// TestSessionStream_FreshSnapshotOnStaleCursor proves a session stream with a
// too-old cursor (the ring has overflowed past it) falls back to the fresh-
// snapshot branch. This is the windowing bound: replay only works within the
// ring's retained window; outside it, a snapshot reconciles authoritatively.
// The test ring capacity is 100 (newReloadServer → aggregator.New(url, 100)).
func TestSessionStream_FreshSnapshotOnStaleCursor(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)
	_ = fake

	srv.agg.Store().Apply(sessionCreatedEvent("s1"))
	waitFor(t, func() bool { return srv.agg.Store().HasSession("s1") },
		"seed session s1")

	// Record a cursor BEFORE overflowing the ring.
	staleCursor := srv.agg.Store().Head()

	// Overflow the 100-capacity ring: apply 101 activity events so the ring
	// evicts everything at or below staleCursor.
	for i := 0; i < 101; i++ {
		srv.agg.Store().Apply(statusBusyEvent("s1"))
	}

	// Open with the stale cursor. Replay(staleCursor) must return ok=false
	// (gap: the ring's oldest retained event has seq > staleCursor+1), so the
	// server takes the fresh-snapshot branch.
	reader, _ := openSessionStreamReq(t, web.URL, "s1", staleCursor, true, 500*time.Millisecond)

	first := firstFrameEvent(t, reader)
	if first != "snapshot" {
		t.Fatalf("stale cursor: want first frame 'snapshot' (ring overflow → fresh snapshot), got %q", first)
	}
}

// TestSessionStream_RetryHintSent proves the server emits an SSE retry: hint so
// the browser's native EventSource auto-reconnect backs off appropriately. The
// hint is what lets a transient CONNECTING-state drop self-heal via native
// auto-reconnect (which sends Last-Event-ID → replay) without falling to the
// manual CLOSED→fresh-snapshot retry path.
func TestSessionStream_RetryHintSent(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)
	_ = fake

	srv.agg.Store().Apply(sessionCreatedEvent("s1"))
	waitFor(t, func() bool { return srv.agg.Store().HasSession("s1") },
		"seed session s1")

	reader, _ := openSessionStreamReq(t, web.URL, "s1", 0, false, 500*time.Millisecond)

	// Scan raw lines for the retry: hint (before any event frame). The hint is
	// sent immediately after the initial : hello comment, before the snapshot.
	foundRetry := false
	for i := 0; i < 10; i++ {
		line, err := reader.ReadString('\n')
		if err != nil {
			break
		}
		// Check for the retry hint (the line starts with "retry:").
		if len(line) >= 7 && line[:7] == "retry: " {
			foundRetry = true
			break
		}
		// Stop after the first event frame — the hint is at the top of the stream.
		if len(line) >= 7 && line[:7] == "event: " {
			break
		}
	}
	if !foundRetry {
		t.Fatal("SSE retry: hint not found at stream open — native EventSource auto-reconnect will not back off")
	}
}
