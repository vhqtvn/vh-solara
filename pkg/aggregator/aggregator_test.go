package aggregator

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
)

// A daemon restart rebuilds the store from a fresh hydrate. Pending questions
// only ever arrive as live events, so hydrate must re-fetch them from
// GET /question — otherwise a question the user still needs to answer vanishes.
func TestHydrateRecoversPendingQuestion(t *testing.T) {
	oc := httptest.NewServer(fixtures.New().Handler())
	defer oc.Close()

	// Raise a pending question on the demo session ([[ask]] pauses the turn).
	resp, err := http.Post(oc.URL+"/session/demo/message", "application/json",
		strings.NewReader(`{"parts":[{"type":"text","text":"[[ask]]"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	// The turn runs async; wait until the question is actually pending.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		r, err := http.Get(oc.URL + "/question")
		if err == nil {
			var qs []json.RawMessage
			_ = json.NewDecoder(r.Body).Decode(&qs)
			r.Body.Close()
			if len(qs) > 0 {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}

	// A FRESH aggregator (as after a daemon restart) must recover it via hydrate.
	agg := New(oc.URL, 100)
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	agg.waitColdSeed() // cold-seed is async now; ensure it has reconciled
	if got := agg.Store().Snapshot(nil).Questions; len(got) == 0 {
		t.Fatal("expected hydrate to recover the pending question, got none")
	}
}

// A cold tree (fresh daemon, no session opened) must still render per-agent
// chips. hydrate fetches a lightweight message tail per un-opened session and
// seeds lastAgent — the tree snapshot carries no messages, so without this the
// chip would stay empty until a session is opened. The demo fixture seeds
// assistant turns m2=build, m4=plan, m6=build (newest); sub seeds sm1=general.
func TestHydrateSeedsColdLastAgents(t *testing.T) {
	oc := httptest.NewServer(fixtures.New().Handler())
	defer oc.Close()

	agg := New(oc.URL, 100)
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	agg.waitColdSeed() // cold-seed runs in the background now; wait for it
	snap := agg.Store().Snapshot(nil)
	// On a fresh aggregator, demo is NOT in LoadedSessions() — the cold path
	// (tail fetch) must seed its lastAgent from the newest assistant message.
	if got := snap.LastAgents["demo"]; got != "build" {
		t.Fatalf("cold demo lastAgent: want 'build' (newest assistant m6), got %q", got)
	}
	if got := snap.LastAgents["sub"]; got != "general" {
		t.Fatalf("cold sub lastAgent: want 'general' (sm1), got %q", got)
	}
}

// tailCountingHandler wraps an OpenCode handler and counts lightweight tail
// fetches (GET /session/:id/message?limit=...) per session. This is exactly the
// request seedColdLastAgents issues, so the count is the "cold-seed fetch storm"
// metric: memoization must keep it at one fetch per session across reconnects.
type tailCountingHandler struct {
	inner http.Handler
	mu    sync.Mutex
	tails map[string]int // sessionID -> tail-fetch count
}

func (h *tailCountingHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/session/") &&
		strings.HasSuffix(r.URL.Path, "/message") && r.URL.Query().Get("limit") != "" {
		sid := strings.TrimPrefix(r.URL.Path, "/session/")
		sid = strings.TrimSuffix(sid, "/message")
		h.mu.Lock()
		h.tails[sid]++
		h.mu.Unlock()
	}
	h.inner.ServeHTTP(w, r)
}

func (h *tailCountingHandler) count(sid string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.tails[sid]
}

// TestColdSeedMemoizedAcrossReconnects proves the reconnect fetch-storm fix:
// each cold session is tail-fetched ONCE for the aggregator's lifetime, not on
// every (re)connect. A second Rehydrate (the reconnect path) must NOT re-fetch
// already-seeded sessions, while the labels still resolve to the same value.
func TestColdSeedMemoizedAcrossReconnects(t *testing.T) {
	h := &tailCountingHandler{inner: fixtures.New().Handler(), tails: map[string]int{}}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := New(oc.URL, 100)
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate #1: %v", err)
	}
	agg.waitColdSeed()
	if got := h.count("demo"); got != 1 {
		t.Fatalf("after first hydrate, demo tail fetches: want 1, got %d", got)
	}
	if got := h.count("sub"); got != 1 {
		t.Fatalf("after first hydrate, sub tail fetches: want 1, got %d", got)
	}
	if got := agg.Store().Snapshot(nil).LastAgents["demo"]; got != "build" {
		t.Fatalf("first hydrate demo lastAgent: want 'build', got %q", got)
	}

	// Second Rehydrate = the reconnect path. The memo must suppress the re-fetch.
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate #2: %v", err)
	}
	agg.waitColdSeed()
	if got := h.count("demo"); got != 1 {
		t.Fatalf("after second hydrate, demo tail fetches must stay 1 (memoized), got %d", got)
	}
	if got := h.count("sub"); got != 1 {
		t.Fatalf("after second hydrate, sub tail fetches must stay 1 (memoized), got %d", got)
	}
	// End-state unchanged: labels still present and correct.
	if got := agg.Store().Snapshot(nil).LastAgents["demo"]; got != "build" {
		t.Fatalf("second hydrate demo lastAgent: want 'build', got %q", got)
	}
}

// slowTailHandler wraps an OpenCode handler and stalls tail fetches
// (?limit=...) for a fixed duration, while leaving every other request fast.
// This makes the cold-seed definitively slower than hydrate, so a test can prove
// hydrate no longer blocks on it.
type slowTailHandler struct {
	inner http.Handler
	delay time.Duration
}

func (h *slowTailHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/session/") &&
		strings.HasSuffix(r.URL.Path, "/message") && r.URL.Query().Get("limit") != "" {
		time.Sleep(h.delay)
	}
	h.inner.ServeHTTP(w, r)
}

// TestColdSeedDoesNotBlockHydrate proves the blocking fix: Rehydrate must return
// promptly even when the cold-seed's tail fetches are slow, because the seed
// runs in the background off the reconnect-critical path. The labels still
// populate afterwards (once the background seed catches up).
func TestColdSeedDoesNotBlockHydrate(t *testing.T) {
	const tailDelay = 150 * time.Millisecond
	h := &slowTailHandler{inner: fixtures.New().Handler(), delay: tailDelay}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := New(oc.URL, 100)
	start := time.Now()
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	elapsed := time.Since(start)
	// hydrate returned without waiting on the (parallel) tail fetches. Two cold
	// sessions at 8-wide concurrency take ~tailDelay; hydrate must be far under.
	if elapsed >= tailDelay {
		t.Fatalf("hydrate blocked on the cold-seed: elapsed=%v >= tailDelay=%v", elapsed, tailDelay)
	}
	// Right after Rehydrate the background seed has not finished (it sleeps),
	// so labels are not expected yet — that is the point of the non-blocking
	// move. Waiting for the seed brings them in.
	agg.waitColdSeed()
	if got := agg.Store().Snapshot(nil).LastAgents["demo"]; got != "build" {
		t.Fatalf("after background seed, demo lastAgent: want 'build', got %q", got)
	}
}

// TestRehydrateSeedSurvivesRequestCancel proves the lifetime fix (B1): the
// background cold-seed must be bound to the AGGREGATOR's lifetime, not to the
// request that triggered it. POST /vh/reload passes r.Context() into Rehydrate;
// before the fix, canceling that ctx when the handler returned killed in-flight
// MessagesTail fetches and skipped MarkColdSeeded, so labels never populated.
// Here Rehydrate is driven by a ctx canceled the instant it returns; the seed
// (detached to the aggregator's lifetime ctx, or WithoutCancel when Run hasn't
// run yet as in this test) must still complete and populate the cold-tree chips.
func TestRehydrateSeedSurvivesRequestCancel(t *testing.T) {
	const tailDelay = 100 * time.Millisecond
	// slowTailHandler stalls the seed's tail fetches so cancel() lands while
	// they are still in flight — this is what makes the regression deterministic.
	h := &slowTailHandler{inner: fixtures.New().Handler(), delay: tailDelay}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := New(oc.URL, 100)
	// A short-lived request ctx, modeling POST /vh/reload's r.Context().
	reqCtx, cancel := context.WithCancel(context.Background())
	if err := agg.Rehydrate(reqCtx); err != nil {
		cancel()
		t.Fatalf("rehydrate: %v", err)
	}
	// Cancel the request immediately after Rehydrate returns. The seed's tail
	// fetches are still stalled (slowTailHandler), so without the lifetime fix
	// this would abort them and skip MarkColdSeeded.
	cancel()

	// The seed is detached from the request, so it must still finish and seed
	// the cold-tree labels despite the request ctx being canceled.
	agg.waitColdSeed()
	snap := agg.Store().Snapshot(nil)
	if got := snap.LastAgents["demo"]; got != "build" {
		t.Fatalf("seed died with the canceled request: demo lastAgent want 'build', got %q", got)
	}
	if got := snap.LastAgents["sub"]; got != "general" {
		t.Fatalf("seed died with the canceled request: sub lastAgent want 'general', got %q", got)
	}
}
