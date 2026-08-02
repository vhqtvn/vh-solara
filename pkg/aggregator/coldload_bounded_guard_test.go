package aggregator

// coldload_bounded_guard_test.go — Part-B guard: the cold-load fetch is BOUNDED
// to the render window (client.MessagesTail(sid, state.WindowMaxCount), i.e.
// GET /session/:id/message?limit=<WindowMaxCount>), NOT the full transcript.
// Part B recovers older history via the boundary-demand path (EnsureOlderMessages
// → MessagesBefore cursor paging), so the bound is correct AND older history stays
// accessible.
//
// If a future change reverts to client.Messages (no ?limit), sawLimit becomes ""
// and THIS test fails. Complement to pkg/state's
// TestSnapshotMessagesPage_FullResidentSupportsOlderHistory (which pins the
// state-store paging path directly).

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// TestEnsureMessagesColdLoadFetchesBoundedTail proves the Part-B contract:
// EnsureMessages issues a ?limit=<WindowMaxCount> tail fetch (MessagesTail), not
// a full no-?limit fetch. A session with total=state.WindowMaxCount+50 messages
// cold-loads via a GET whose ?limit == state.WindowMaxCount. If the bound is
// removed (revert to client.Messages), sawLimit becomes "" → fail.
func TestEnsureMessagesColdLoadFetchesBoundedTail(t *testing.T) {
	total := state.WindowMaxCount + 50 // 150 > WindowMaxCount (100)
	// Newest-last page (opencode chronological order); each a COMPLETED assistant
	// turn with one text part so the gate's latestAssistantResident finds a
	// parts-bearing newest assistant (within the tail) and IsMessagesLoaded flips.
	msgs := make([]string, total)
	for i := 0; i < total; i++ {
		msgs[i] = fmt.Sprintf(
			`{"info":{"id":"m%d","sessionID":"big","role":"assistant","time":{"completed":1700000000}},"parts":[{"id":"p%d","sessionID":"big","messageID":"m%d","type":"text","text":"x"}]}`,
			i, i, i,
		)
	}
	full := "[" + strings.Join(msgs, ",") + "]"

	var sawLimit string
	var mu sync.Mutex
	mux := http.NewServeMux()
	mux.HandleFunc("/session/big/message", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// Record the ?limit the aggregator sent; serve the whole list regardless
		// (the assertion is on the REQUEST shape, not the response).
		mu.Lock()
		sawLimit = r.URL.Query().Get("limit")
		mu.Unlock()
		w.Write([]byte(full))
	})
	// Delegate everything else (sessions list, cold-seed tails) to the standard
	// fixture so the aggregator constructs cleanly.
	inner := fixtures.New().Handler()
	mux.Handle("/", inner)
	oc := httptest.NewServer(mux)
	defer oc.Close()

	agg := New(oc.URL, 100)
	if err := agg.EnsureMessages(context.Background(), "big"); err != nil {
		t.Fatalf("EnsureMessages: %v", err)
	}

	// CRUX (Part B): the cold-load fetch carried ?limit=<WindowMaxCount> — i.e.
	// client.MessagesTail (bounded tail), NOT client.Messages (full). If a future
	// change reverts to the full fetch, sawLimit becomes "" → fail.
	mu.Lock()
	gotLimit := sawLimit
	mu.Unlock()
	if gotLimit != strconv.Itoa(state.WindowMaxCount) {
		t.Fatalf("cold-load fetch must be bounded (?limit=%d, MessagesTail); got ?limit=%q — bound removed (client.Messages)?", state.WindowMaxCount, gotLimit)
	}
	// The gate still flips: the newest assistant (m149) is within the bounded
	// tail, so latestAssistantResident holds and IsMessagesLoaded is true
	// (window-complete, not transcript-complete — the spec intent).
	if !agg.Store().IsMessagesLoaded("big") {
		t.Fatal("bounded cold-load fetch must mark the session loaded (newest assistant within the tail)")
	}
}

// TestEnsureMessagesAsyncColdLoadFetchesBoundedTail is the async-path twin:
// EnsureMessagesAsync must likewise issue a ?limit=<WindowMaxCount> tail fetch.
// Guards the second cold-load call site (messages.go EnsureMessagesAsync).
func TestEnsureMessagesAsyncColdLoadFetchesBoundedTail(t *testing.T) {
	total := state.WindowMaxCount + 50
	msgs := make([]string, total)
	for i := 0; i < total; i++ {
		msgs[i] = fmt.Sprintf(
			`{"info":{"id":"m%d","sessionID":"big2","role":"assistant","time":{"completed":1700000000}},"parts":[{"id":"p%d","sessionID":"big2","messageID":"m%d","type":"text","text":"x"}]}`,
			i, i, i,
		)
	}
	full := "[" + strings.Join(msgs, ",") + "]"
	var sawLimit string
	var mu sync.Mutex
	mux := http.NewServeMux()
	mux.HandleFunc("/session/big2/message", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		mu.Lock()
		sawLimit = r.URL.Query().Get("limit")
		mu.Unlock()
		w.Write([]byte(full))
	})
	inner := fixtures.New().Handler()
	mux.Handle("/", inner)
	oc := httptest.NewServer(mux)
	defer oc.Close()

	agg := New(oc.URL, 100)
	agg.EnsureMessagesAsync("big2")
	agg.waitMessagesAsync("big2")

	mu.Lock()
	gotLimit := sawLimit
	mu.Unlock()
	if gotLimit != strconv.Itoa(state.WindowMaxCount) {
		t.Fatalf("async cold-load fetch must be bounded (?limit=%d); got ?limit=%q — bound removed?", state.WindowMaxCount, gotLimit)
	}
	if !agg.Store().IsMessagesLoaded("big2") {
		t.Fatal("async bounded cold-load fetch must mark the session loaded")
	}
}
