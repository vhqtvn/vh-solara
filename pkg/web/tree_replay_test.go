package web

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// tree_replay_test.go — Phase 2 Item 2: reconnect/op-replay (design §5.5).
// Asserts the tree=2 stream's SSE id (Last-Event-ID cursor) uses the STORE seq
// space so store.Replay(cursor) works, and that a valid-cursor reconnect replays
// only the delta (no full frontier re-ship). A ring-gap falls back to a fresh
// tree.snapshot with cause "reconnect".

// --- SSE reader helpers ---

type sseEvent struct {
	id    string
	event string
	data  string
}

// readFirstEvent reads SSE bytes from body until it finds the first complete
// real event (one with an "event:" line, delimited by blank-line terminators),
// or times out. Comment blocks (": hello\nretry: 2000\n\n") are skipped.
func readFirstEvent(t *testing.T, body io.Reader, timeout time.Duration) sseEvent {
	t.Helper()
	ch := make(chan sseEvent, 1)
	go func() {
		buf := make([]byte, 0, 8192)
		tmp := make([]byte, 512)
		for {
			n, err := body.Read(tmp)
			if n > 0 {
				buf = append(buf, tmp[:n]...)
				s := string(buf)
				// SSE events are delimited by "\n\n". A COMPLETE block is
				// followed by "\n\n" — the LAST element from Split is always
				// the trailing remainder and may be incomplete (no terminator
				// yet). Only scan complete blocks to avoid extracting a
				// truncated data payload.
				blocks := strings.Split(s, "\n\n")
				complete := blocks
				if len(blocks) > 0 {
					complete = blocks[:len(blocks)-1] // drop trailing remainder
				}
				for _, block := range complete {
					if !strings.Contains(block, "event: ") {
						continue
					}
					var ev sseEvent
					for _, line := range strings.Split(block, "\n") {
						line = strings.TrimSpace(line)
						if strings.HasPrefix(line, "id: ") {
							ev.id = strings.TrimSpace(line[4:])
						} else if strings.HasPrefix(line, "event: ") {
							ev.event = strings.TrimSpace(line[7:])
						} else if strings.HasPrefix(line, "data: ") {
							ev.data = line[6:]
						}
					}
					if ev.event != "" {
						ch <- ev
						return
					}
				}
			}
			if err != nil {
				ch <- sseEvent{}
				return
			}
			if len(buf) > 65536 {
				ch <- sseEvent{}
				return
			}
		}
	}()
	select {
	case ev := <-ch:
		return ev
	case <-time.After(timeout):
		t.Fatalf("readFirstEvent: timed out after %v", timeout)
		return sseEvent{}
	}
}

// treeReplayServer builds a Server + store for replay tests. Returns the store so
// tests can apply events between connections.
func treeReplayServer(t *testing.T) (*Server, *aggregator.Aggregator) {
	t.Helper()
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	agg := aggregator.New(oc.URL, 1000)
	srv, err := NewServer(agg, oc.URL, 1000)
	if err != nil {
		t.Fatal(err)
	}
	return srv, agg
}

func applyCreate(store interface{ Apply(opencode.Event) }, id, parentID string) {
	props := `{"info":{"id":"` + id + `","title":"` + id + `","time":{"updated":1000}}}`
	if parentID != "" {
		props = `{"info":{"id":"` + id + `","parentID":"` + parentID + `","title":"` + id + `","time":{"updated":1000}}}`
	}
	store.Apply(opencode.Event{
		Type:       "session.created",
		Properties: json.RawMessage(props),
	})
}

// TestTreeReplay_SnapshotIdIsStoreHead asserts the initial tree.snapshot's SSE
// id line is the STORE head seq (NOT the emitter's per-connection seq counter).
// This is the root-cause fix: Last-Event-ID must be in the store seq space so
// store.Replay(cursor) works on reconnect.
func TestTreeReplay_SnapshotIdIsStoreHead(t *testing.T) {
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

	ev := readFirstEvent(t, resp.Body, 3*time.Second)
	if ev.event != "tree.snapshot" {
		t.Fatalf("initial event: got %q, want tree.snapshot", ev.event)
	}
	head := store.Head()
	wantID := compoundSSEID(head, 0)
	if ev.id != wantID {
		t.Errorf("snapshot SSE id: got %q, want %q (compound: globalSeq=head, ordinal=0 for snapshot)", ev.id, wantID)
	}
}

// TestTreeReplay_ReconnectReplaysDelta asserts a reconnect with a valid cursor
// (Last-Event-ID = the initial tree.snapshot's SSE id = store head) replays the
// delta FIRST — the tree.op for the session created after the initial snapshot.
// Before the cursor-id fix, the snapshot id was 0 (emitter seq), so
// store.Replay(0) replayed EVERYTHING and a spurious tree.snapshot was emitted
// as the first event.
//
// Per C-F1 (Phase 3 Step B), the reconnect path ALSO emits tree.snapshot + the
// legacy detail snapshot AFTER the replayed deltas to re-seed a client that
// reconnected with empty in-memory detail/frontier (see tree_resume_detail_test.go).
// This test checks only that the delta is the FIRST event — the C-F1 bootstrap
// is asserted separately there.
func TestTreeReplay_ReconnectReplaysDelta(t *testing.T) {
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	applyCreate(store, "R", "")
	applyCreate(store, "C1", "R")

	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// 1. Initial connection: get the snapshot + its SSE id.
	resp1, err := http.Get(web.URL + "/vh/stream?tree=2")
	if err != nil {
		t.Fatal(err)
	}
	ev1 := readFirstEvent(t, resp1.Body, 3*time.Second)
	resp1.Body.Close()
	if ev1.event != "tree.snapshot" {
		t.Fatalf("initial event: got %q, want tree.snapshot", ev1.event)
	}
	if ev1.id == "" {
		t.Fatal("initial snapshot has no SSE id")
	}

	// 2. Generate a new session AFTER the initial snapshot.
	applyCreate(store, "C2", "R")

	// 3. Reconnect with Last-Event-ID = the snapshot's id.
	req, _ := http.NewRequest("GET", web.URL+"/vh/stream?tree=2", nil)
	req.Header.Set("Last-Event-ID", ev1.id)
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()

	// 4. First event should be tree.op for C2, NOT tree.snapshot. (Per C-F1 a
	//    tree.snapshot + legacy detail snapshot also follow AFTER the deltas to
	//    re-seed the frontier; here we only assert the delta comes first.)
	ev2 := readFirstEvent(t, resp2.Body, 3*time.Second)
	if ev2.event == "tree.snapshot" {
		t.Fatalf("reconnect with valid cursor emitted tree.snapshot as the FIRST event (delta should come first); id=%q data=%.200s", ev2.id, ev2.data)
	}
	if ev2.event != "tree.op" {
		t.Fatalf("reconnect: first event got %q, want tree.op", ev2.event)
	}
	// The replayed delta should be for C2 (the new session), not R or C1.
	if !strings.Contains(ev2.data, "C2") {
		t.Errorf("replay delta should reference C2, got data=%.200s", ev2.data)
	}
}

// TestTreeReplay_RingGapSendsReconnectSnapshot asserts a reconnect where the
// cursor is too old (ring evicted it) sends a fresh tree.snapshot with cause
// "reconnect" (NOT "initial"), and that the DETAIL snapshot following it
// carries partial.ringGap:true — the sole true-gap stamp
// (detailSnap.Partial.RingGap in handleStream's fresh-snapshot fallback,
// hasCursor && !replayOK). Uses a tiny ring (cap=4) and applies 5 events so
// Seq=1 is evicted; reconnecting with cursor=0 triggers a genuine ring-gap.
//
// The ringGap assertions below are green-on-arrival pins of EXISTING server
// emission (D-F1, review ses_ed9164bb2): no RED was expected — they pin the
// wire contract the Slice B client switch (noteServerRingGap) consumes.
func TestTreeReplay_RingGapSendsReconnectSnapshot(t *testing.T) {
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	agg := aggregator.New(oc.URL, 4) // small ring so 5 events evict Seq=1
	srv, err := NewServer(agg, oc.URL, 4)
	if err != nil {
		t.Fatal(err)
	}
	store := agg.Store()
	// 5 roots → Seq 1..5; ring cap=4 evicts Seq=1. oldest is now Seq=2.
	for _, id := range []string{"R", "R2", "R3", "R4", "R5"} {
		applyCreate(store, id, "")
	}

	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// cursor=0 → cursor+1=1 < items[oldest].Seq=2 → genuine ring-gap.
	req, _ := http.NewRequest("GET", web.URL+"/vh/stream?tree=2", nil)
	req.Header.Set("Last-Event-ID", "0")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	// Drain the full ring-gap burst: coarse tree.snapshot first, then the
	// DETAIL `snapshot` that follows it (server write order), then the
	// snapshot.complete boundary.
	events := drainIdle(startSSEReader(t, resp.Body), 600*time.Millisecond)
	t.Logf("ring-gap reconnect events: %v", eventNames(events))

	if len(events) == 0 {
		t.Fatal("ring-gap reconnect: no events received")
	}
	if events[0].event != "tree.snapshot" {
		t.Fatalf("ring-gap reconnect: first event got %q, want tree.snapshot", events[0].event)
	}
	if !strings.Contains(events[0].data, `"reconnect"`) {
		t.Errorf("ring-gap snapshot cause should be \"reconnect\", got data=%.200s", events[0].data)
	}

	// D-F1 green-on-arrival pin (review ses_ed9164bb2): the DETAIL snapshot
	// that FOLLOWS the coarse tree.snapshot must carry partial.ringGap:true —
	// the sole stamping site (detailSnap.Partial.RingGap in handleStream's
	// fresh-snapshot fallback, hasCursor && !replayOK). This is the PRECISE
	// signal the Slice B client switch (noteServerRingGap) consumes; the
	// coarse cause:"reconnect" above is stamped on every cursor-resume
	// reconnect and cannot discriminate. Pinning EXISTING emission — no RED
	// expected or observed.
	detailIdx := -1
	for i, e := range events {
		if e.event == "snapshot" {
			detailIdx = i
			break
		}
	}
	if detailIdx < 0 {
		t.Fatalf("ring-gap reconnect: no detail `snapshot` event followed tree.snapshot; events=%v", eventNames(events))
	}
	detail := events[detailIdx].data
	if !strings.Contains(detail, `"partial"`) {
		t.Errorf("ring-gap detail snapshot should be a partial frame (tree-only filter={}); data=%.200s", detail)
	}
	if !strings.Contains(detail, `"ringGap":true`) {
		t.Errorf("ring-gap detail snapshot must carry partial.ringGap:true (sole stamping site: detailSnap.Partial.RingGap, hasCursor && !replayOK); data=%.200s", detail)
	}
}
