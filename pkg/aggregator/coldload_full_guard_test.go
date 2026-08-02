package aggregator

// coldload_full_guard_test.go — 7648673-F1 guard: the cold-load fetch must be
// the FULL transcript (client.Messages, NO ?limit=), NOT MessagesTail(N). This
// is the aggregator-level complement to pkg/state's
// TestSnapshotMessagesPage_FullResidentSupportsOlderHistory (which pins the
// state-store paging path but bypasses the fetch). If a future change swaps
// EnsureMessages/EnsureMessagesAsync back to MessagesTail(WindowMaxCount), the
// fetch would carry ?limit=<WindowMaxCount> and THIS test fails (sawLimit != "").
//
// Inverse of the removed bounded_coldload_test.go (which asserted ?limit=100 WAS
// sent under the reverted Part-A bound).

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// TestEnsureMessagesColdLoadFetchesFullTranscript proves the post-revert
// contract: EnsureMessages issues a no-?limit full-transcript fetch. A session
// with total=state.WindowMaxCount+50 messages cold-loads via a GET whose ?limit
// query is ABSENT. If MessagesTail(WindowMaxCount) is re-introduced, sawLimit
// becomes "<WindowMaxCount>" and this fails.
func TestEnsureMessagesColdLoadFetchesFullTranscript(t *testing.T) {
	total := state.WindowMaxCount + 50 // 150 > WindowMaxCount (100)
	// Newest-last page (opencode chronological order); each a COMPLETED assistant
	// turn with one text part so the gate's latestAssistantResident finds a
	// parts-bearing newest assistant and IsMessagesLoaded flips.
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

	// CRUX (7648673-F1): the cold-load fetch carried NO ?limit — i.e. it was
	// client.Messages (full transcript), NOT MessagesTail(N). If a future change
	// re-introduces MessagesTail(WindowMaxCount), sawLimit becomes "100" → fail.
	mu.Lock()
	gotLimit := sawLimit
	mu.Unlock()
	if gotLimit != "" {
		t.Fatalf("cold-load fetch must be full (no ?limit=, client.Messages); got ?limit=%q — MessagesTail re-introduced at messages.go?", gotLimit)
	}
	// The gate still flips (the full fetch populates the resident store; the
	// newest assistant m149 is present with parts).
	if !agg.Store().IsMessagesLoaded("big") {
		t.Fatal("full cold-load fetch must mark the session loaded")
	}
}

// TestEnsureMessagesAsyncColdLoadFetchesFullTranscript is the async-path twin:
// EnsureMessagesAsync must likewise issue a no-?limit full fetch. Guards the
// second cold-load call site (messages.go EnsureMessagesAsync).
func TestEnsureMessagesAsyncColdLoadFetchesFullTranscript(t *testing.T) {
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
	if gotLimit != "" {
		t.Fatalf("async cold-load fetch must be full (no ?limit=); got ?limit=%q — MessagesTail re-introduced?", gotLimit)
	}
	if !agg.Store().IsMessagesLoaded("big2") {
		t.Fatal("async full cold-load fetch must mark the session loaded")
	}
}
