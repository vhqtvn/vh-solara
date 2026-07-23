package web

// tree_detail_test.go — Phase 3 Step A.5 (GAP 3): session-detail frames flow in
// tree=2 mode.
//
// tree=2 replaces the STRUCTURE projection only (the wholesale snapshot →
// tree.snapshot frontier + tree.op deltas). Session-detail (the legacy snapshot
// that bootstraps state.sessions/permissions/questions/todos, and live detail
// events like permission.upsert/question.upsert/todo/session.upsert) is
// ORTHOGONAL and must still flow so cross-session detail consumers
// (NotificationCenter, selectors) stay populated.
//
// Before the fix, when treeEmitter != nil the server took a tree.op-only branch
// with `continue` in BOTH the replay and live loops, and emitted ONLY
// tree.snapshot on fresh connect — so state.sessions/permissions/questions/todos
// were NEVER populated for a fresh tree=2 client.
//
// The fix emits the legacy detail snapshot alongside tree.snapshot on fresh
// connect, and emits the legacy writeEvent (for every non-tree.orphan kind)
// alongside tree.op in the replay + live loops.
//
// These tests assert BOTH projections appear on the wire in tree=2 mode.

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// startSSEReader spins a goroutine that parses SSE blocks from body and pushes
// complete events (those with an "event:" line) onto the returned channel. The
// channel is closed when body.Read returns an error (stream closed). Allows
// draining events in phases (initial vs live) against one open response body.
func startSSEReader(t *testing.T, body io.Reader) <-chan sseEvent {
	t.Helper()
	ch := make(chan sseEvent, 128)
	go func() {
		defer close(ch)
		buf := make([]byte, 0, 8192)
		tmp := make([]byte, 512)
		for {
			n, err := body.Read(tmp)
			if n > 0 {
				buf = append(buf, tmp[:n]...)
				s := string(buf)
				blocks := strings.Split(s, "\n\n")
				// The last element is the trailing (possibly incomplete) remainder;
				// keep it for the next read. Everything before is a complete block.
				complete := blocks[:len(blocks)-1]
				buf = []byte(blocks[len(blocks)-1])
				for _, block := range complete {
					if !strings.Contains(block, "event: ") {
						continue // comment/retry/keepalive blocks
					}
					var ev sseEvent
					for _, line := range strings.Split(block, "\n") {
						line = strings.TrimSpace(line)
						switch {
						case strings.HasPrefix(line, "id: "):
							ev.id = strings.TrimSpace(line[4:])
						case strings.HasPrefix(line, "event: "):
							ev.event = strings.TrimSpace(line[7:])
						case strings.HasPrefix(line, "data: "):
							ev.data = line[6:]
						}
					}
					if ev.event != "" {
						ch <- ev
					}
				}
			}
			if err != nil {
				return
			}
			if len(buf) > 1<<20 {
				return
			}
		}
	}()
	return ch
}

// drainIdle collects events from ch until no event arrives for idleTimeout
// (a quiet period), then returns everything collected so far.
func drainIdle(ch <-chan sseEvent, idleTimeout time.Duration) []sseEvent {
	var out []sseEvent
	for {
		select {
		case ev, ok := <-ch:
			if !ok {
				return out
			}
			out = append(out, ev)
		case <-time.After(idleTimeout):
			return out
		}
	}
}

func hasEvent(events []sseEvent, kind string) bool {
	for _, e := range events {
		if e.event == kind {
			return true
		}
	}
	return false
}

func eventDataFor(events []sseEvent, kind, needle string) (string, bool) {
	for _, e := range events {
		if e.event == kind && strings.Contains(e.data, needle) {
			return e.data, true
		}
	}
	return "", false
}

// TestTreeDetail_FreshConnectEmitsBothSnapshots asserts a fresh tree=2 connect
// emits tree.snapshot (structure) AND snapshot (legacy detail bootstrap) — the
// latter populates state.sessions/permissions/questions/todos on the client.
func TestTreeDetail_FreshConnectEmitsBothSnapshots(t *testing.T) {
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	applyCreate(store, "R", "")
	applyCreate(store, "C1", "R")

	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	resp, err := http.Get(web.URL + "/vh/stream?tree=2")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	ch := startSSEReader(t, resp.Body)
	initial := drainIdle(ch, 600*time.Millisecond)

	if !hasEvent(initial, "tree.snapshot") {
		t.Fatalf("fresh tree=2 connect: missing tree.snapshot (structure); events=%v", eventNames(initial))
	}
	if !hasEvent(initial, "snapshot") {
		t.Fatalf("fresh tree=2 connect: missing legacy snapshot (detail bootstrap, GAP 3); events=%v", eventNames(initial))
	}
	// The legacy detail snapshot must carry session detail (the sessions array).
	if data, ok := eventDataFor(initial, "snapshot", "R"); !ok {
		t.Errorf("legacy detail snapshot should contain session R; got events=%v", eventNames(initial))
	} else if !strings.Contains(data, "C1") {
		t.Errorf("legacy detail snapshot should contain child session C1; data=%.200s", data)
	}
}

// TestTreeDetail_LiveEventsEmitLegacyAlongsideTreeOp asserts a live store event
// in tree=2 mode emits BOTH tree.op (structure delta) AND the legacy detail event
// (e.g. session.upsert) so state.sessions stays current as sessions are created.
func TestTreeDetail_LiveEventsEmitLegacyAlongsideTreeOp(t *testing.T) {
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	applyCreate(store, "R", "")

	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	resp, err := http.Get(web.URL + "/vh/stream?tree=2")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	ch := startSSEReader(t, resp.Body)
	// Drain the initial snapshot pair so baseline is established.
	initial := drainIdle(ch, 600*time.Millisecond)
	if !hasEvent(initial, "tree.snapshot") || !hasEvent(initial, "snapshot") {
		t.Fatalf("expected tree.snapshot + snapshot on fresh connect; got %v", eventNames(initial))
	}

	// Apply a NEW session after the stream is live → seq > baseline → live loop.
	applyCreate(store, "C2", "R")

	live := drainIdle(ch, 600*time.Millisecond)

	// Structure: tree.op emitted for the new child.
	if !hasEvent(live, "tree.op") {
		t.Errorf("live tree=2: missing tree.op for new session; events=%v", eventNames(live))
	}
	if _, ok := eventDataFor(live, "tree.op", "C2"); !ok {
		t.Errorf("tree.op should reference C2; events=%v", eventNames(live))
	}
	// Detail: legacy session.upsert emitted alongside tree.op (GAP 3 fix).
	if _, ok := eventDataFor(live, "session.upsert", "C2"); !ok {
		t.Errorf("live tree=2: missing legacy session.upsert for C2 (detail, GAP 3); events=%v", eventNames(live))
	}
}

// TestTreeDetail_LegacySnapshotNotCompressedGzip64 asserts the legacy detail
// snapshot ships RAW (not gzip64) so it does not race tree.snapshot's async
// gzip64 decode on the client's shared treeSnapshotDecoding flag.
func TestTreeDetail_LegacySnapshotNotCompressedGzip64(t *testing.T) {
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	applyCreate(store, "R", "")

	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	resp, err := http.Get(web.URL + "/vh/stream?tree=2&z=1")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	ch := startSSEReader(t, resp.Body)
	initial := drainIdle(ch, 600*time.Millisecond)

	for _, e := range initial {
		if e.event == "snapshot" {
			if strings.Contains(e.data, `"encoding":"gzip64"`) {
				t.Errorf("legacy detail snapshot must ship RAW (not gzip64) to avoid the treeSnapshotDecoding flag race; data=%.120s", e.data)
			}
			return
		}
	}
	t.Fatalf("no legacy snapshot event on fresh connect; events=%v", eventNames(initial))
}

func eventNames(events []sseEvent) []string {
	out := make([]string, len(events))
	for i, e := range events {
		out[i] = e.event
	}
	return out
}
