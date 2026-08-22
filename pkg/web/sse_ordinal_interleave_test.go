package web

// sse_ordinal_interleave_test.go — O3 Finding 3: structural-interleave
// regression test driving the REAL server's ordinal assignment.
//
// The pre-commit unit tests MOCKED the wire with hand-crafted contiguous
// ordinals — that is why they were green while the real server's structural
// interleave broke the ordinal contract (Finding 1: structural events on
// Stream 2 bumped the ordinal invisibly to the FE → spurious resync).
//
// This test drives the actual handleStream handler (?sessions=s1, the
// session/firehose stream, treeEmitter==nil) through a cursor-based REPLAY
// of [message → structural → message], then asserts the REAL ordinal
// assignment:
//   - message.upsert frames carry compound ids with contiguous ordinals (1, 2).
//   - structural frames (status/activity) between them carry NO id line at all
//     (writeRawNoID — the ordinal did NOT advance for them).
//
// NON-VACUITY: revert Finding 1's fix (the IsMessageClassKind gate in the
// replay loop) → structural frames get ordinals too → the second
// message.upsert gets ordinal 3+ (not 2) and structural frames carry id
// lines → this test fails deterministically. That is the red→green proof the
// pre-commit greens missed.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// messageUpdatedEvent builds a message.updated opencode.Event for direct store
// seeding (synchronous — no aggregator poll loop / fake backend needed), mirroring
// sessionCreatedEvent and statusBusyEvent.
func messageUpdatedEvent(sid, mid, role string) opencode.Event {
	return opencode.Event{
		Type: "message.updated",
		Properties: json.RawMessage(fmt.Sprintf(
			`{"info":{"id":%q,"sessionID":%q,"role":%q}}`, mid, sid, role)),
	}
}

// sseFrameID captures one SSE frame's id, event name, and data.
type sseFrameID struct {
	id    string
	event string
	data  string
}

// readSSEFramesUntil reads SSE frames from r until predicate returns true (on
// the accumulated slice) or until the body closes (context deadline). Each
// frame is delimited by a blank line; id/event/data lines are parsed.
func readSSEFramesUntil(t *testing.T, r *bufio.Reader, done func([]sseFrameID) bool) []sseFrameID {
	t.Helper()
	var frames []sseFrameID
	var cur sseFrameID
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			if cur.event != "" {
				frames = append(frames, cur)
			}
			break // body closed (context deadline)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if cur.event != "" {
				frames = append(frames, cur)
				if done != nil && done(frames) {
					break
				}
			}
			cur = sseFrameID{}
			continue
		}
		switch {
		case strings.HasPrefix(line, "id: "):
			cur.id = strings.TrimSpace(line[4:])
		case strings.HasPrefix(line, "event: "):
			cur.event = strings.TrimSpace(line[7:])
		case strings.HasPrefix(line, "data: "):
			cur.data = strings.TrimSpace(line[6:])
		}
	}
	return frames
}

// frameSummarys formats a short summary of each frame for error messages.
func frameSummarys(fs []sseFrameID) string {
	var b strings.Builder
	b.WriteString("[")
	for i, f := range fs {
		if i > 0 {
			b.WriteString(", ")
		}
		fmt.Fprintf(&b, "{ev:%s id:%s}", f.event, f.id)
	}
	b.WriteString("]")
	return b.String()
}

// ordinalOf extracts the ordinal component from a compound SSE id
// ("globalSeq.ordinal").
func ordinalOf(t *testing.T, id string) int {
	t.Helper()
	if id == "" {
		t.Fatalf("ordinalOf: empty id")
	}
	dot := strings.LastIndexByte(id, '.')
	if dot < 0 {
		t.Fatalf("ordinalOf: id %q has no dot (not a compound id)", id)
	}
	var n int
	if _, err := fmt.Sscanf(id[dot+1:], "%d", &n); err != nil {
		t.Fatalf("ordinalOf: id %q ordinal parse: %v", id, err)
	}
	return n
}

// TestStream2Ordinal_StructuralInterleave drives the REAL handleStream through
// a replay of [message → status(busy) → message] on a session-selected stream
// (?sessions=s1, treeEmitter==nil). Asserts:
//  1. message.upsert frames carry compound ids with contiguous ordinals (1, 2).
//  2. The structural frames (status/activity) between them carry NO id line
//     (writeRawNoID — Finding 1's fix).
//
// NON-VACUITY PROOF: revert Finding 1's fix (the IsMessageClassKind gate in
// the replay loop treeEmitter==nil branch) → structural frames advance the
// ordinal and carry id lines → the second message.upsert gets ordinal 3 (not 2)
// → both assertions fail. This test is the deterministic red→green that the
// pre-commit greens (hand-crafted contiguous ordinals) missed.
func TestStream2Ordinal_StructuralInterleave(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)

	// Seed a session so the stream has a scope (guarded against the
	// seed-vs-hydrate ghost-delete race — see seed_helpers_test.go).
	seedSession(t, srv, fake, "s1")

	// Record the cursor BEFORE the interleave — the replay branch ships events
	// with seq > cursor.
	cursor := srv.agg.Store().Head()

	// Apply the interleave: message → structural(busy) → message.
	srv.agg.Store().Apply(messageUpdatedEvent("s1", "m1", "user"))
	srv.agg.Store().Apply(statusBusyEvent("s1"))
	srv.agg.Store().Apply(messageUpdatedEvent("s1", "m2", "user"))

	// Open the session stream WITH the cursor → replay branch (treeEmitter==nil
	// because no tree=2 flag is sent).
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	t.Cleanup(cancel)
	url := web.URL + "/vh/stream?sessions=s1&cursor=" + fmt.Sprintf("%d", cursor)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	reader := bufio.NewReader(resp.Body)

	// Collect frames until we've seen 2 message.upsert events (the interleave
	// bookends), or the stream closes.
	frames := readSSEFramesUntil(t, reader, func(fs []sseFrameID) bool {
		count := 0
		for _, f := range fs {
			if f.event == "message.upsert" {
				count++
			}
		}
		return count >= 2
	})

	// Extract just the message.upsert frames.
	var msgUpserts []sseFrameID
	for _, f := range frames {
		if f.event == "message.upsert" {
			msgUpserts = append(msgUpserts, f)
		}
	}
	if len(msgUpserts) < 2 {
		t.Fatalf("expected ≥2 message.upsert frames in the replay, got %d. Frames: %s",
			len(msgUpserts), frameSummarys(frames))
	}

	// Assertion 1: the two message.upsert frames have contiguous ordinals
	// (1 and 2) — the structural event between them did NOT advance the ordinal.
	ord1 := ordinalOf(t, msgUpserts[0].id)
	ord2 := ordinalOf(t, msgUpserts[1].id)
	if ord1 != 1 {
		t.Errorf("first message.upsert ordinal: got %d, want 1. id=%q", ord1, msgUpserts[0].id)
	}
	if ord2 != 2 {
		t.Errorf("second message.upsert ordinal: got %d, want 2 (structural interleave must NOT advance the ordinal). id=%q\nAll frames: %s",
			ord2, msgUpserts[1].id, frameSummarys(frames))
	}

	// Assertion 2: structural frames (status/activity/etc.) between the two
	// message.upserts carry NO id line (writeRawNoID — Finding 1's fix).
	firstIdx := -1
	for i, f := range frames {
		if f.event == "message.upsert" {
			if firstIdx < 0 {
				firstIdx = i
			} else {
				for j := firstIdx + 1; j < i; j++ {
					sf := frames[j]
					if sf.id != "" {
						t.Errorf("structural frame %q between two message.upserts carries id %q — Finding 1 violated: structural events must NOT advance the ordinal. Frames: %s",
							sf.event, sf.id, frameSummarys(frames))
					}
				}
				break
			}
		}
	}
}
