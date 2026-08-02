package aggregator

// bounded_coldload_test.go — Part A: prove the initial cold-load is bounded to
// the render window. EnsureMessages fetches the newest state.WindowMaxCount
// messages via MessagesTail (?limit=N), NOT the whole transcript via Messages()
// (no ?limit). The fake-opencode fixture honors ?limit=N (newest N, tail slice)
// exactly like real opencode, so this models the bound faithfully.
//
// The gate (IsMessagesLoaded) keys on the newest COMPLETED assistant, which is
// within the tail-N window; latestAssistantResidentLocked returns true vacuously
// when no assistant is resident. So the bounded fetch keeps the gate correct
// (window-complete, not transcript-complete). See the cold-load-overfetch spec.

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

// TestEnsureMessagesBoundedColdLoad is the Part-A verifier: a session with
// total=250 (>> WindowMaxCount=100) COMPLETED assistant turns cold-loads via a
// ?limit=WindowMaxCount fetch (MessagesTail), NOT a no-limit fetch (Messages).
// Pre-Part-A the handler saw ?limit="" and returned all 250; Post-Part-A it sees
// ?limit=100 and returns the newest 100. The gate still flips (newest assistant
// m249 is within the tail-100).
func TestEnsureMessagesBoundedColdLoad(t *testing.T) {
	const total = 250 // >> state.WindowMaxCount (100)
	// Newest-last page (opencode chronological order). Each entry is a COMPLETED
	// assistant turn with one text part, so the gate's latestAssistantResident
	// finds a parts-bearing newest assistant within the tail.
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
		l := r.URL.Query().Get("limit")
		mu.Lock()
		sawLimit = l
		mu.Unlock()
		if n, _ := strconv.Atoi(l); n > 0 && n < total {
			// newest N (tail slice), chronological order — mirrors the fixture.
			w.Write([]byte("[" + strings.Join(msgs[total-n:], ",") + "]"))
			return
		}
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

	// CRUX (Part A bound): the fetch carried ?limit=state.WindowMaxCount — i.e.
	// MessagesTail was used, NOT the no-limit Messages(). Pre-Part-A sawLimit=="".
	mu.Lock()
	gotLimit := sawLimit
	mu.Unlock()
	if gotLimit != strconv.Itoa(state.WindowMaxCount) {
		t.Fatalf("bounded cold-load: fetch ?limit want %d, got %q (MessagesTail not used — over-fetch not bounded)", state.WindowMaxCount, gotLimit)
	}
	// Gate still flips: the newest assistant (m249) is within the tail-100, so
	// latestAssistantResidentLocked holds and IsMessagesLoaded is true. This is
	// the "bounded fetch keeps the gate correct" guarantee (window-complete).
	if !agg.Store().IsMessagesLoaded("big") {
		t.Fatal("bounded fetch must still mark the session loaded (newest assistant is within the tail — gate keys on window-complete)")
	}
}

// TestEnsureMessagesBoundedColdLoad_ShortSession proves the bound does NOT
// over-truncate: a session with FEWER than WindowMaxCount messages is fetched in
// full (the tail is the whole session). ?limit is still sent (MessagesTail), but
// the fixture returns all of them (limit >= len → no slice).
func TestEnsureMessagesBoundedColdLoad_ShortSession(t *testing.T) {
	const total = 30 // < state.WindowMaxCount (100)
	msgs := make([]string, total)
	for i := 0; i < total; i++ {
		msgs[i] = fmt.Sprintf(
			`{"info":{"id":"m%d","sessionID":"small","role":"assistant","time":{"completed":1700000000}},"parts":[{"id":"p%d","sessionID":"small","messageID":"m%d","type":"text","text":"x"}]}`,
			i, i, i,
		)
	}
	full := "[" + strings.Join(msgs, ",") + "]"
	mux := http.NewServeMux()
	mux.HandleFunc("/session/small/message", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		// limit=100 >= total=30 → the fixture returns all (no truncation).
		w.Write([]byte(full))
	})
	inner := fixtures.New().Handler()
	mux.Handle("/", inner)
	oc := httptest.NewServer(mux)
	defer oc.Close()

	agg := New(oc.URL, 100)
	if err := agg.EnsureMessages(context.Background(), "small"); err != nil {
		t.Fatalf("EnsureMessages: %v", err)
	}
	// Short session still loads (all 30 fetched; no over-truncation).
	if !agg.Store().IsMessagesLoaded("small") {
		t.Fatal("short session (< WindowMaxCount) must still load — the bound must not over-truncate")
	}
}
