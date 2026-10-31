package web

// Session-stream replay proving tests for the Stream2 resumability fix.
//
// The handleStream handler is SHARED between Stream1 (?sessions= tree) and
// Stream2 (?sessions=<id> selected session). The replay-vs-snapshot branch
// (stream_http.go) already honors Last-Event-ID / cursor= for ANY filter
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
//
// Seeding: sessions are seeded via seedSession (seed_helpers_test.go) — the
// seed-vs-hydrate ghost-delete race guard. A bare Apply of
// sessionCreatedEvent races the aggregator's initial hydrate and the 5s
// reconcile tick, both of which DELETE store sessions absent from the fake's
// (initially empty) /session list.

import (
	"bufio"
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
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

	// Seed a session (guarded — see seed_helpers_test.go). After this,
	// head = seq of the session.created event.
	seedSession(t, srv, fake, "s1")

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

	seedSession(t, srv, fake, "s1")

	// Open with NO cursor — the server must take the fresh-snapshot branch.
	reader, _ := openSessionStreamReq(t, web.URL, "s1", 0, false, 500*time.Millisecond)

	frames := readSSEFramesUntil(t, reader, func(fs []sseFrameID) bool {
		return len(fs) >= 1 && fs[0].event == "snapshot"
	})
	if len(frames) == 0 || frames[0].event != "snapshot" {
		t.Fatalf("no cursor: want first frame 'snapshot', got %q (fresh-snapshot branch not taken)",
			firstEventName(frames))
	}

	// The snapshot must genuinely carry the seeded session. Before the
	// seed-vs-hydrate guard this test could pass VACUOUSLY: a ghost-delete
	// (hydrate/reconcile landing after a bare Apply) emptied the store, and
	// an EMPTY snapshot still satisfied the branch check above. s1 now
	// survives re-hydrate/reconcile, so pin its presence — the cold-open
	// snapshot is only proven when it carries the seeded session's content.
	var snap struct {
		Sessions []struct {
			ID string `json:"id"`
		} `json:"sessions"`
	}
	if err := json.Unmarshal([]byte(frames[0].data), &snap); err != nil {
		t.Fatalf("no cursor: snapshot frame unmarshal: %v", err)
	}
	found := false
	for _, s := range snap.Sessions {
		if s.ID == "s1" {
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("no cursor: seeded session s1 absent from snapshot sessions (ghost-delete regression; snapshot=%s)",
			frames[0].data)
	}
}

// TestSessionStream_FreshSnapshotOnStaleCursor proves a session stream with a
// too-old cursor (the ring has overflowed past it) falls back to the fresh-
// snapshot branch. This is the windowing bound: replay only works within the
// ring's retained window; outside it, a snapshot reconciles authoritatively.
// The test ring capacity is 100 (newReloadServer → aggregator.New(url, 100)).
func TestSessionStream_FreshSnapshotOnStaleCursor(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)

	seedSession(t, srv, fake, "s1")

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

// TestSessionStream_FreshSnapshotOnStaleEpochCursor proves the daemon-restart
// cursor invalidation fix (P2): a session stream whose cursor EXCEEDS the
// current store head (cursor > head — the cursor predates a daemon restart;
// a fresh store's seq restarts low) MUST fall back to the authoritative fresh
// path — snapshot first, then the message-load kick — instead of the old
// `cursor >= head → "client is current"` silent nothing (the incident: frozen
// transcript + stuck queue chip after a daemon restart, with the FE's 35s
// health watchdog looping reconnects forever). ring.since now returns ok=false
// for cursor > head, so handleStream routes to the fresh else-branch:
// triggerMessageLoad fires (asserted via the messages.loaded completion the
// async fetch emits on THIS connection) and the wholesale snapshot is frame 1.
// The journal must attribute the fallback as stale_cursor_exceeds_head
// (distinct from ring_eviction: restart-storm vs overflowed ring).
func TestSessionStream_FreshSnapshotOnStaleEpochCursor(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)

	// Seed the session and give the fake a message body with a real part so
	// the async fetch's completion gate (IsMessagesLoaded) holds and the
	// messages.loaded event actually fires (mirrors TestStreamAsyncHydration's
	// seeding — a user message with a resident text part).
	seedSession(t, srv, fake, "s1")
	fake.setMessage("s1", `[{"info":{"id":"m1","sessionID":"s1","role":"user"},"parts":[{"id":"p1","sessionID":"s1","messageID":"m1","type":"text","text":"hi"}]}]`)

	// A cursor from the PREVIOUS daemon lifetime: the client's last seen seq
	// sits far above the current (restarted-low) store head.
	head := srv.agg.Store().Head()
	staleCursor := head + 500
	if staleCursor <= head {
		t.Fatalf("test setup: staleCursor %d must exceed head %d", staleCursor, head)
	}

	var sawLoaded bool
	lines := captureBaselines(t, func() {
		reader, _ := openSessionStreamReq(t, web.URL, "s1", staleCursor, true, 3*time.Second)

		// Frame 1 MUST be the wholesale snapshot: the fresh branch ran, not
		// the (now unreachable for stale cursors) replay branch's silence.
		if first := firstFrameEvent(t, reader); first != "snapshot" {
			t.Fatalf("stale-epoch cursor: want first frame 'snapshot' (fresh re-seed), got %q", first)
		}

		// triggerMessageLoad fired: the async fetch reconciles the cold-load
		// (messages.batch) and its messages.loaded completion flows on THIS
		// connection — the message-load kick the incident's frozen
		// transcripts were missing. readSSEFrameSilent keeps reading until
		// the deadline ctx closes the body.
		for {
			ev, _ := readSSEFrameSilent(reader)
			if ev == "" {
				break // body closed (deadline) — stop scanning
			}
			if ev == "messages.loaded" {
				sawLoaded = true
				break
			}
		}
		if !sawLoaded {
			t.Fatal("stale-epoch cursor: messages.loaded never arrived — triggerMessageLoad did not fire on the fresh fallback")
		}
	})

	// The message-load kick is double-proven by the upstream GET itself.
	waitFor(t, func() bool { return fake.msgGetsCount("s1") > 0 },
		"stale-epoch cursor: message GET reached the fake (triggerMessageLoad)")

	// Journal attribution: fresh path + the stale-cursor discriminator.
	line := lastBaselineLine(t, lines, 1)
	if !strings.Contains(line, "path=fresh") {
		t.Errorf("stale-epoch cursor: journal must say path=fresh: %q", line)
	}
	if !strings.Contains(line, "fallback_reason=stale_cursor_exceeds_head") {
		t.Errorf("stale-epoch cursor: journal must attribute fallback_reason=stale_cursor_exceeds_head: %q", line)
	}
	if !strings.Contains(line, "had_cursor=true") {
		t.Errorf("stale-epoch cursor: had_cursor must be true: %q", line)
	}
}

// TestSessionStream_StaleEpochCursorConcurrentStreams pins that the
// stale-cursor fresh fallback composes with a SECOND concurrent stream from
// the same client (one stale-cursor reconnect + one cursorless open): both
// connections independently take the fresh path and each receives its own
// snapshot as frame 1 — the fallback reads no shared per-client state.
func TestSessionStream_StaleEpochCursorConcurrentStreams(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)

	seedSession(t, srv, fake, "s1")

	head := srv.agg.Store().Head()
	staleCursor := head + 100

	// Open BOTH streams concurrently; read each one's first frame.
	r1, _ := openSessionStreamReq(t, web.URL, "s1", staleCursor, true, 2*time.Second)
	r2, _ := openSessionStreamReq(t, web.URL, "s1", 0, false, 2*time.Second)

	if first := firstFrameEvent(t, r1); first != "snapshot" {
		t.Fatalf("concurrent/stale: want first frame 'snapshot', got %q", first)
	}
	if first := firstFrameEvent(t, r2); first != "snapshot" {
		t.Fatalf("concurrent/cursorless: want first frame 'snapshot', got %q", first)
	}
}

// TestSessionStream_RetryHintSent proves the server emits an SSE retry: hint so
// the browser's native EventSource auto-reconnect backs off appropriately. The
// hint is what lets a transient CONNECTING-state drop self-heal via native
// auto-reconnect (which sends Last-Event-ID → replay) without falling to the
// manual CLOSED→fresh-snapshot retry path.
func TestSessionStream_RetryHintSent(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)

	seedSession(t, srv, fake, "s1")

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
