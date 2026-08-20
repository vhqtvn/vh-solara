package web

// Stream-2 window-filter proving tests (2026-08-20 stale-rows follow-up).
//
// The sendable() egress filter in handleStream drops part-class re-publication
// events (part.upsert / part.append / part.delete) whose parent message is
// OUTSIDE the client snapshot window (pkg/state window = newest 100 msgs /
// 1 MiB, mirrored via Store.MessageInWindow). The FE already holds such events
// as keyless shadows (never rendered), so this is a bandwidth/CPU optimization
// only — it must NOT change:
//   - message-class events (message.upsert passes even for out-of-window
//     parents — cold clients converge via snapshot + message events),
//   - the cold-client snapshot path (window contents identical),
//   - ordinal contiguity (drops happen BEFORE ordinal++, so no O3 gaps).
//
// Seeding note: newReloadServer's store ring capacity is 100 but the window is
// the state default (newest 100 messages / 1 MiB via state.DefaultConfig), so
// seeding 105 tiny messages puts m1..m5 outside the window and m6..m105 inside.
// Replay tests record the cursor AFTER seeding, so ring retention of the seed
// events themselves is irrelevant.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// partUpdatedEvent builds a message.part.updated opencode.Event for direct
// store seeding, mirroring the integration-test pattern: the store reducer
// extracts {id, sessionID, messageID, type, text} from the "part" envelope and
// re-emits KindPartUpsert with the part JSON as payload.
func partUpdatedEvent(sid, mid, pid, text string) opencode.Event {
	return opencode.Event{
		Type: "message.part.updated",
		Properties: json.RawMessage(fmt.Sprintf(
			`{"part":{"id":%q,"sessionID":%q,"messageID":%q,"type":"text","text":%q}}`,
			pid, sid, mid, text)),
	}
}

// windowFilterStreamDeadline bounds each test's /vh/stream request. It is
// deliberately generous (5s vs the 750ms previously used here and the 500ms
// common in sibling stream tests): these tests connect
// to a session holding 105 messages, so the server must write a ~100-message
// snapshot BEFORE the awaited live-tail/replay frame; under full-tree parallel
// test load that write can exceed a sub-second deadline (observed flake at
// 750ms). The done-predicates stop reading as soon as the expected frames
// arrive, so a healthy unloaded run still completes in milliseconds.
const windowFilterStreamDeadline = 5 * time.Second

// seedSessionMessages seeds one session with n tiny messages (m1..mn) via
// direct synchronous store Apply. With n > 100 the oldest n-100 messages fall
// outside the snapshot window.
func seedSessionMessages(t *testing.T, srv *Server, sid string, n int) {
	t.Helper()
	srv.agg.Store().Apply(sessionCreatedEvent(sid))
	waitFor(t, func() bool { return srv.agg.Store().HasSession(sid) },
		"seed session "+sid)
	for i := 1; i <= n; i++ {
		srv.agg.Store().Apply(messageUpdatedEvent(sid, fmt.Sprintf("m%d", i), "user"))
	}
}

// framePartMessageID extracts the top-level messageID from a part-class frame
// payload. Returns "" for frames without one.
func framePartMessageID(t *testing.T, f sseFrameID) string {
	t.Helper()
	var p struct {
		MessageID string `json:"messageID"`
	}
	if err := json.Unmarshal([]byte(f.data), &p); err != nil {
		return "" // non-part payload shape; ignore
	}
	return p.MessageID
}

// hasPartFrameFor reports whether any delivered frame is a part-class event
// whose parent messageID equals mid.
func hasPartFrameFor(t *testing.T, frames []sseFrameID, mid string) bool {
	t.Helper()
	for _, f := range frames {
		if f.event != "part.upsert" && f.event != "part.append" && f.event != "part.delete" {
			continue
		}
		if framePartMessageID(t, f) == mid {
			return true
		}
	}
	return false
}

// TestStream2WindowFilter_ReplayDropsOutOfWindowParts drives the REPLAY branch
// (?sessions=s1&cursor=N): of three post-cursor events — part(out-of-window),
// part(in-window), message(out-of-window) — only the latter two may be
// delivered, and the delivered ordinals must stay contiguous (the drop happens
// before ordinal++, so no O3 gap is created).
func TestStream2WindowFilter_ReplayDropsOutOfWindowParts(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)
	_ = fake

	seedSessionMessages(t, srv, "s1", 105) // window = m6..m105; m1 out
	cursor := srv.agg.Store().Head()

	srv.agg.Store().Apply(partUpdatedEvent("s1", "m1", "p-old", "stale re-publication"))
	srv.agg.Store().Apply(partUpdatedEvent("s1", "m105", "p-new", "live tail update"))
	srv.agg.Store().Apply(messageUpdatedEvent("s1", "m1", "user"))

	reader, _ := openSessionStreamReq(t, web.URL, "s1", cursor, true, windowFilterStreamDeadline)
	frames := readSSEFramesUntil(t, reader, func(fs []sseFrameID) bool {
		return len(fs) >= 2 && hasPartFrameFor(t, fs, "m105") && hasMessageFrameFor(fs, "m1")
	})

	if hasPartFrameFor(t, frames, "m1") {
		t.Fatalf("replay: part event for out-of-window m1 must be dropped, got frame (frames=%s)",
			frameSummarys(frames))
	}
	if !hasPartFrameFor(t, frames, "m105") {
		t.Fatalf("replay: part event for in-window (newest) m105 must be delivered (frames=%s)",
			frameSummarys(frames))
	}
	if !hasMessageFrameFor(frames, "m1") {
		t.Fatalf("replay: message.upsert for out-of-window m1 must pass unchanged (frames=%s)",
			frameSummarys(frames))
	}

	// Ordinal contiguity: delivered frames carry ordinals 1..n with no gap
	// introduced by the dropped event.
	for i, f := range frames {
		if got, want := ordinalOf(t, f.id), i+1; got != want {
			t.Fatalf("replay: frame %d ordinal = %d, want %d (drop created an ordinal gap; frames=%s)",
				i, got, want, frameSummarys(frames))
		}
	}
}

// hasMessageFrameFor reports whether any delivered frame is a message-class
// event (message.upsert/message.delete) whose info.id equals mid.
func hasMessageFrameFor(frames []sseFrameID, mid string) bool {
	for _, f := range frames {
		if f.event != "message.upsert" && f.event != "message.delete" {
			continue
		}
		var p struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal([]byte(f.data), &p); err != nil {
			continue
		}
		if p.ID == mid {
			return true
		}
	}
	return false
}

// TestStream2WindowFilter_LiveTailDropsOutOfWindowParts drives the LIVE TAIL
// after a cold snapshot connect (?sessions=s1, no cursor): a part event for an
// out-of-window parent applied while streaming must never reach the wire,
// while the in-window part and the out-of-window MESSAGE event must. The
// dropped event is applied FIRST, so observing the later in-window delivery
// proves the earlier slot already passed through the filter.
func TestStream2WindowFilter_LiveTailDropsOutOfWindowParts(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)
	_ = fake

	seedSessionMessages(t, srv, "s1", 105)

	reader, _ := openSessionStreamReq(t, web.URL, "s1", 0, false, windowFilterStreamDeadline)
	if ev := firstFrameEvent(t, reader); ev != "snapshot" {
		t.Fatalf("live-tail: first frame = %q, want snapshot (cold open)", ev)
	}

	srv.agg.Store().Apply(partUpdatedEvent("s1", "m1", "p-old", "stale re-publication"))
	srv.agg.Store().Apply(partUpdatedEvent("s1", "m105", "p-new", "live tail update"))
	srv.agg.Store().Apply(messageUpdatedEvent("s1", "m1", "user"))

	var live []sseFrameID
	frames := readSSEFramesUntil(t, reader, func(fs []sseFrameID) bool {
		live = postSnapshotFrames(fs)
		return hasPartFrameFor(t, live, "m105") && hasMessageFrameFor(live, "m1")
	})
	live = postSnapshotFrames(frames)

	if hasPartFrameFor(t, live, "m1") {
		t.Fatalf("live tail: part event for out-of-window m1 must be dropped (live=%s)",
			frameSummarys(live))
	}
	if !hasPartFrameFor(t, live, "m105") {
		t.Fatalf("live tail: part event for in-window m105 must be delivered (live=%s)",
			frameSummarys(live))
	}
	if !hasMessageFrameFor(live, "m1") {
		t.Fatalf("live tail: message.upsert for out-of-window m1 must pass (live=%s)",
			frameSummarys(live))
	}
}

// postSnapshotFrames returns the frames following the (single) snapshot frame.
func postSnapshotFrames(fs []sseFrameID) []sseFrameID {
	for i, f := range fs {
		if f.event == "snapshot" {
			return fs[i+1:]
		}
	}
	return fs
}

// TestStream2WindowFilter_FirehoseAlsoDrops proves the window predicate also
// applies to the firehose (?sessions=all → filter == nil): out-of-window part
// re-publications are dropped there too, since the FE treats them identically.
func TestStream2WindowFilter_FirehoseAlsoDrops(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)
	_ = fake

	seedSessionMessages(t, srv, "s1", 105)
	cursor := srv.agg.Store().Head()

	srv.agg.Store().Apply(partUpdatedEvent("s1", "m1", "p-old", "stale re-publication"))
	srv.agg.Store().Apply(partUpdatedEvent("s1", "m105", "p-new", "live tail update"))

	ctx, cancel := context.WithTimeout(context.Background(), windowFilterStreamDeadline)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		web.URL+"/vh/stream?sessions=all&cursor="+fmt.Sprint(cursor), nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	reader := bufio.NewReader(resp.Body)

	frames := readSSEFramesUntil(t, reader, func(fs []sseFrameID) bool {
		return hasPartFrameFor(t, fs, "m105")
	})

	if hasPartFrameFor(t, frames, "m1") {
		t.Fatalf("firehose: part event for out-of-window m1 must be dropped (frames=%s)",
			frameSummarys(frames))
	}
	if !hasPartFrameFor(t, frames, "m105") {
		t.Fatalf("firehose: part event for in-window m105 must be delivered (frames=%s)",
			frameSummarys(frames))
	}
}

// TestStream2WindowFilter_SnapshotWindowUnchanged pins the cold-client
// snapshot path: after seeding 105 messages and an out-of-window part event,
// the snapshot carries EXACTLY the newest-100 window (m6..m105), m1 absent.
// The egress filter must not perturb this (cold-client convergence guarantee).
func TestStream2WindowFilter_SnapshotWindowUnchanged(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)
	_ = fake

	seedSessionMessages(t, srv, "s1", 105)
	srv.agg.Store().Apply(partUpdatedEvent("s1", "m1", "p-old", "stale re-publication"))

	reader, _ := openSessionStreamReq(t, web.URL, "s1", 0, false, windowFilterStreamDeadline)
	// The snapshot is the first dispatchable frame (comments/retry hints are
	// skipped by the parser), so accumulate until it lands and parse it.
	frames := readSSEFramesUntil(t, reader, func(fs []sseFrameID) bool {
		return len(fs) >= 1 && fs[0].event == "snapshot"
	})

	var snap struct {
		Messages map[string][]struct {
			Info struct {
				ID string `json:"id"`
			} `json:"info"`
		} `json:"messages"`
	}
	if len(frames) == 0 || frames[0].event != "snapshot" {
		t.Fatalf("snapshot: first dispatchable frame = %q, want snapshot", firstEventName(frames))
	}
	if err := json.Unmarshal([]byte(frames[0].data), &snap); err != nil {
		t.Fatalf("snapshot frame: unmarshal: %v", err)
	}

	msgs := snap.Messages["s1"]
	if len(msgs) != 100 {
		t.Fatalf("snapshot window: got %d messages for s1, want 100", len(msgs))
	}
	ids := make(map[string]bool, len(msgs))
	for _, m := range msgs {
		ids[m.Info.ID] = true
	}
	if ids["m1"] {
		t.Fatal("snapshot window: out-of-window m1 must not be in the snapshot")
	}
	if !ids["m105"] || !ids["m6"] {
		t.Fatal("snapshot window: newest-100 bounds m6..m105 must be present")
	}
}

// TestPartWindowKey_ConservativeFallback unit-tests the payload classifier the
// window filter gates on: well-formed part payloads yield (sid, mid, ok);
// malformed JSON or a missing sessionID/messageID yields ok=false — the
// sendable filter then passes the event through UNCHANGED (never drop what
// cannot be attributed). Note the real store only ever emits well-formed part
// payloads (all three reducer shapes carry both ids), so the egress path
// cannot inject malformed ones; this unit seam is where the ok=false branch
// is demonstrable.
func TestPartWindowKey_ConservativeFallback(t *testing.T) {
	if sid, mid, ok := partWindowKey([]byte(`{"sessionID":"s1","messageID":"m9"}`)); !ok || sid != "s1" || mid != "m9" {
		t.Fatalf("well-formed: got (%q,%q,%v), want (s1,m9,true)", sid, mid, ok)
	}
	if _, _, ok := partWindowKey([]byte(`{not json`)); ok {
		t.Fatal("malformed JSON: must be ok=false (pass through)")
	}
	if _, _, ok := partWindowKey([]byte(`{"messageID":"m9"}`)); ok {
		t.Fatal("missing sessionID: must be ok=false (pass through)")
	}
	if _, _, ok := partWindowKey([]byte(`{"sessionID":"s1"}`)); ok {
		t.Fatal("missing messageID: must be ok=false (pass through)")
	}
	if _, _, ok := partWindowKey(nil); ok {
		t.Fatal("nil payload: must be ok=false (pass through)")
	}
}

// TestStream2WindowFilter_LiveStreamingNewMessageDelivered pins the
// 0d39634 live-streaming shape at the EGRESS seam: the FIRST part delta for a
// brand-new message (no message envelope yet) creates a keyless placeholder
// that is order[n-1] — the newest — so it is ALWAYS in the window and its part
// event MUST be delivered. This is the hot path for every streaming turn; a
// check-order regression in messageInWindowOrder would drop it (the pure
// pkg/state keyless test pins the same property at the helper seam).
func TestStream2WindowFilter_LiveStreamingNewMessageDelivered(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)
	_ = fake

	seedSessionMessages(t, srv, "s1", 105)

	reader, _ := openSessionStreamReq(t, web.URL, "s1", 0, false, windowFilterStreamDeadline)
	if ev := firstFrameEvent(t, reader); ev != "snapshot" {
		t.Fatalf("live-new: first frame = %q, want snapshot (cold open)", ev)
	}

	// Part delta BEFORE any message.updated for m-fresh — the store reducer
	// creates the keyless placeholder parent (newest) before emitting.
	srv.agg.Store().Apply(partUpdatedEvent("s1", "m-fresh", "p0", "streaming start"))

	frames := readSSEFramesUntil(t, reader, func(fs []sseFrameID) bool {
		return hasPartFrameFor(t, postSnapshotFrames(fs), "m-fresh")
	})
	live := postSnapshotFrames(frames)
	if !hasPartFrameFor(t, live, "m-fresh") {
		t.Fatalf("live-new: part event for brand-new (keyless-newest) m-fresh must be delivered (live=%s)",
			frameSummarys(live))
	}
}

// firstEventName returns the first frame's event name ("" when empty), for
// failure messages.
func firstEventName(fs []sseFrameID) string {
	if len(fs) == 0 {
		return ""
	}
	return fs[0].event
}
