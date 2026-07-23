package web

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
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
	wantID := strconv.FormatUint(head, 10)
	if ev.id != wantID {
		t.Errorf("snapshot SSE id: got %q, want %q (store head seq)", ev.id, wantID)
	}
}

// TestTreeReplay_ReconnectReplaysDelta asserts a reconnect with a valid cursor
// (Last-Event-ID = store head from the initial snapshot) replays ONLY the delta
// events, NOT a full tree.snapshot. Before the fix, the snapshot id was 0
// (emitter seq), so store.Replay(0) replayed EVERYTHING and a spurious
// tree.snapshot was also emitted on every valid replay.
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

	// 4. First event should be tree.op for C2, NOT tree.snapshot.
	ev2 := readFirstEvent(t, resp2.Body, 3*time.Second)
	if ev2.event == "tree.snapshot" {
		t.Fatalf("reconnect with valid cursor emitted tree.snapshot (should replay delta only); id=%q data=%.200s", ev2.id, ev2.data)
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
// "reconnect" (NOT "initial"). Uses a tiny ring (cap=4) and applies 5 events so
// Seq=1 is evicted; reconnecting with cursor=0 triggers a genuine ring-gap.
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

	ev := readFirstEvent(t, resp.Body, 3*time.Second)
	t.Logf("FULL ev.data length=%d:\n%s", len(ev.data), ev.data)
	if ev.event != "tree.snapshot" {
		t.Fatalf("ring-gap reconnect: first event got %q, want tree.snapshot", ev.event)
	}
	if !strings.Contains(ev.data, `"reconnect"`) {
		t.Errorf("ring-gap snapshot cause should be \"reconnect\", got data=%.200s", ev.data)
	}
}
