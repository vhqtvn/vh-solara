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
	"github.com/vhqtvn/vh-solara/pkg/opencode"
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

// TestColdSeedPushesLastAgentEventToConnectedClient pins the fix for the
// cold-tree chip regression: a client subscribed to the store BEFORE the
// background cold seed completes must receive the seeded agent name as a LIVE
// lastAgent.set event — so the per-agent chip renders in the tree without the
// session being opened and without waiting for a reconnect to serve a fresh
// snapshot. Before the fix, SetLastAgents mutated se.lastAgent but emitted
// nothing, and snapshots are served fresh per connection, so a client whose
// first snapshot landed mid-seed saw an empty lastAgents map and a blank chip
// until it reconnected. The other cold-seed tests all waitColdSeed() before
// asserting; this one subscribes first and reads the event off the channel.
func TestColdSeedPushesLastAgentEventToConnectedClient(t *testing.T) {
	oc := httptest.NewServer(fixtures.New().Handler())
	defer oc.Close()

	agg := New(oc.URL, 100)
	// Subscribe BEFORE hydrate triggers the seed — exactly like a client already
	// connected when the daemon's background seedColdLastAgents runs.
	ch, unsub := agg.Store().Subscribe(128)
	defer unsub()

	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	// Do NOT waitColdSeed before reading the channel: the delivery mechanism
	// under test IS the live event, not a later snapshot.
	agents := map[string]string{}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && agents["demo"] == "" {
		select {
		case e := <-ch:
			if e.Kind == "lastAgent.set" {
				var p struct {
					SessionID string `json:"sessionID"`
					Agent     string `json:"agent"`
				}
				if json.Unmarshal(e.Payload, &p) == nil {
					agents[p.SessionID] = p.Agent
				}
			}
		case <-time.After(20 * time.Millisecond):
		}
	}
	if got := agents["demo"]; got != "build" {
		t.Fatalf("connected client must receive lastAgent.set demo=build via live event, got %q (all: %+v)", got, agents)
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

// slowFullMessageHandler wraps an OpenCode handler and delays the FULL message
// fetch (GET /session/:id/message with NO ?limit=) — exactly the request
// client.Messages issues (the lazy-hydration path) — while leaving every other
// request (incl. the cold-seed's ?limit= tail) fast. This is the async-msg
// analog of slowTailHandler. The !limit distinction is what separates the
// lazy full-fetch from the cold-seed tail-fetch.
type slowFullMessageHandler struct {
	inner    http.Handler
	delay    time.Duration
	mu       sync.Mutex
	count    map[string]int // sessionID -> full-fetch count
	released chan struct{}  // optional: if set, block fetches until closed (deterministic in-flight)
}

func (h *slowFullMessageHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/session/") &&
		strings.HasSuffix(r.URL.Path, "/message") && r.URL.Query().Get("limit") == "" {
		sid := strings.TrimPrefix(r.URL.Path, "/session/")
		sid = strings.TrimSuffix(sid, "/message")
		h.mu.Lock()
		h.count[sid]++
		h.mu.Unlock()
		if h.released != nil {
			<-h.released // hold the fetch open until the test releases it
		}
		if h.delay > 0 {
			time.Sleep(h.delay)
		}
	}
	h.inner.ServeHTTP(w, r)
}

func (h *slowFullMessageHandler) countOf(sid string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.count[sid]
}

// waitForCount polls until the full-fetch count for sid reaches want or the
// deadline lapses. Used to deterministically observe an in-flight fetch (e.g.
// before canceling a request ctx, to prove the background survives).
func (h *slowFullMessageHandler) waitForCount(t *testing.T, sid string, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if h.countOf(sid) >= want {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("full-fetch count for %s: want %d, got %d (timed out)", sid, want, h.countOf(sid))
}

// TestEnsureMessagesAsyncSingleFlight proves concurrent opens of the same
// (unloaded) session collapse to ONE upstream fetch — the per-session in-flight
// map dedupes. This keeps a rapid session-switch / multi-consumer storm from
// fanning out into N full GET /session/:id/message requests.
func TestEnsureMessagesAsyncSingleFlight(t *testing.T) {
	const delay = 80 * time.Millisecond
	h := &slowFullMessageHandler{inner: fixtures.New().Handler(), delay: delay, count: map[string]int{}}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := New(oc.URL, 100)
	// Seed the session into the tree so it is a known candidate (EnsureMessagesAsync
	// no-ops early on "" / already-loaded only; it issues the fetch regardless of
	// tree presence, but a present session is the realistic path).
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	agg.waitColdSeed()
	// demo is NOT loaded after a cold hydrate (cold-seed only tails; the full
	// history fetch happens on open). Sanity-check the precondition.
	if agg.Store().IsMessagesLoaded("demo") {
		t.Fatal("precondition: demo must NOT be loaded before async hydration")
	}

	// Register + launch the first fetch synchronously so the in-flight slot
	// exists before we fan out concurrent opens against it (otherwise the test
	// could read the count before the callers are even scheduled).
	agg.EnsureMessagesAsync(context.Background(), "demo")
	// Fan out several MORE concurrent opens; every one must dedupe against the
	// already-in-flight fetch (not start a second).
	for i := 0; i < 5; i++ {
		go agg.EnsureMessagesAsync(context.Background(), "demo")
	}
	agg.waitMessagesAsync("demo")

	if got := h.countOf("demo"); got != 1 {
		t.Fatalf("concurrent opens must collapse to 1 full fetch, got %d", got)
	}
	if !agg.Store().IsMessagesLoaded("demo") {
		t.Fatal("after the fetch, demo must be marked loaded")
	}

	// A subsequent open is a no-op (already loaded) → no second fetch.
	agg.EnsureMessagesAsync(context.Background(), "demo")
	if got := h.countOf("demo"); got != 1 {
		t.Fatalf("already-loaded session must not trigger a second fetch, got %d", got)
	}
}

// TestEnsureMessagesAsyncSuccessEmitsCompletion proves the success path:
// SetSessionMessages marks loaded AND a messages.loaded completion event is
// emitted — UNCONDITIONALLY, even when the fetch returns ZERO messages. This is
// the empty/no-diff completion trap: without the explicit event, a fetch that
// produced no message.* deltas would never signal "done" and the client would
// wedge on its loading state forever.
func TestEnsureMessagesAsyncSuccessEmitsCompletion(t *testing.T) {
	// A fixture session whose message history is EMPTY (no assistant/user turns)
	// isolates the zero-message case. We synthesize one via a tiny handler that
	// answers GET /session/empty/message with [].
	mux := http.NewServeMux()
	mux.HandleFunc("/session/empty/message", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") == "" {
			w.Header().Set("Content-Type", "application/json")
			w.Write([]byte("[]"))
			return
		}
		http.Error(w, "no tail", http.StatusNotFound)
	})
	// Delegate everything else to the standard fixture so the aggregator's
	// hydrate (sessions list, cold-seed tails) still works.
	inner := fixtures.New().Handler()
	mux.Handle("/", inner)
	oc := httptest.NewServer(mux)
	defer oc.Close()

	agg := New(oc.URL, 100)
	// Subscribe to capture the completion event.
	ch, unsub := agg.Store().Subscribe(128)
	defer unsub()

	agg.EnsureMessagesAsync(context.Background(), "empty")
	agg.waitMessagesAsync("empty")

	if !agg.Store().IsMessagesLoaded("empty") {
		t.Fatal("empty-session fetch must still mark loaded")
	}
	// Drain subscribers and assert a messages.loaded arrived. Even though the
	// fetch returned zero messages (no message.* delta), the explicit
	// completion event must fire.
	var sawLoaded bool
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && !sawLoaded {
		select {
		case e := <-ch:
			if e.Kind == "messages.loaded" {
				sawLoaded = true
			}
		case <-time.After(20 * time.Millisecond):
		}
	}
	if !sawLoaded {
		t.Fatal("zero-message fetch must still emit messages.loaded (the empty/no-diff completion trap)")
	}
}

// TestEnsureMessagesAsyncFailureEmitsError proves the failure path: an upstream
// error emits messages.error, clears the in-flight slot (so a reselect retries),
// and does NOT mark the session loaded.
func TestEnsureMessagesAsyncFailureEmitsError(t *testing.T) {
	// Count the full-fetch requests (no ?limit=, exactly what client.Messages
	// issues) so the test can prove the retry actually re-issues an upstream
	// fetch rather than short-circuiting on a stale in-flight slot.
	var (
		mu        sync.Mutex
		fullCount int
	)
	mux := http.NewServeMux()
	mux.HandleFunc("/session/broken/message", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") == "" {
			mu.Lock()
			fullCount++
			mu.Unlock()
			http.Error(w, "upstream down", http.StatusInternalServerError)
			return
		}
		http.Error(w, "no tail", http.StatusNotFound)
	})
	mux.Handle("/", fixtures.New().Handler())
	oc := httptest.NewServer(mux)
	defer oc.Close()

	agg := New(oc.URL, 100)
	ch, unsub := agg.Store().Subscribe(128)
	defer unsub()

	agg.EnsureMessagesAsync(context.Background(), "broken")
	agg.waitMessagesAsync("broken")

	if agg.Store().IsMessagesLoaded("broken") {
		t.Fatal("a failed fetch must NOT mark the session loaded (retry on reselect)")
	}
	// The in-flight slot must be cleared so the next selection retries.
	agg.msgMu.Lock()
	_, stillInflight := agg.msgInflight["broken"]
	agg.msgMu.Unlock()
	if stillInflight {
		t.Fatal("a failed fetch must clear the in-flight slot so a reselect retries")
	}
	// The first attempt must have hit the upstream exactly once.
	mu.Lock()
	firstFetches := fullCount
	mu.Unlock()
	if firstFetches != 1 {
		t.Fatalf("first fetch: want 1 full upstream GET, got %d", firstFetches)
	}
	// A messages.error must be emitted.
	var sawErr bool
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && !sawErr {
		select {
		case e := <-ch:
			if e.Kind == "messages.error" {
				sawErr = true
			}
		case <-time.After(20 * time.Millisecond):
		}
	}
	if !sawErr {
		t.Fatal("a failed fetch must emit messages.error")
	}

	// Retry on reselect: a second trigger issues a fresh fetch (the slot was
	// cleared and the session is still unloaded).
	agg.EnsureMessagesAsync(context.Background(), "broken")
	agg.waitMessagesAsync("broken")
	// The retry must have issued a SECOND upstream GET — proving the cleared
	// slot allowed a genuine re-fetch rather than a silent no-op.
	mu.Lock()
	retryFetches := fullCount
	mu.Unlock()
	if retryFetches != 2 {
		t.Fatalf("retry must issue a fresh upstream GET: want 2 (1 fail + 1 retry), got %d", retryFetches)
	}
}

// TestEnsureMessagesAsyncSurvivesRequestCancel proves the lifetime binding: the
// background fetch must be bound to the AGGREGATOR's lifetime (a.runCtx, or
// WithoutCancel(ctx) before Run), NOT to the caller's ctx. handleStream passes
// r.Context() (well, Background() in the helper, but the contract is the same);
// canceling a short-lived caller ctx must NOT abort a still-in-flight fetch.
// Mirrors TestRehydrateSeedSurvivesRequestCancel.
func TestEnsureMessagesAsyncSurvivesRequestCancel(t *testing.T) {
	released := make(chan struct{})
	h := &slowFullMessageHandler{inner: fixtures.New().Handler(), count: map[string]int{}, released: released}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := New(oc.URL, 100)
	// A short-lived caller ctx, modeling handleStream's r.Context() dying when
	// the handler returns.
	reqCtx, cancel := context.WithCancel(context.Background())
	agg.EnsureMessagesAsync(reqCtx, "demo")
	// Wait until the fetch is observably in flight, THEN cancel the caller ctx.
	h.waitForCount(t, "demo", 1)
	cancel()
	// Release the fetch and let it complete. If the goroutine were bound to
	// reqCtx, this completion would never happen (loaded stays false).
	close(released)
	agg.waitMessagesAsync("demo")

	if !agg.Store().IsMessagesLoaded("demo") {
		t.Fatal("the background fetch must survive the caller-ctx cancel and mark loaded")
	}
}

// TestEnsureMessagesAsyncShutdownCancels proves the goroutine is bound to the
// aggregator's lifetime: canceling a.runCtx (Run's ctx) aborts the in-flight
// fetch silently — no spurious messages.error into a torn-down store, and the
// session stays unloaded (a fresh aggregator / reconnect retries).
func TestEnsureMessagesAsyncShutdownCancels(t *testing.T) {
	released := make(chan struct{})
	h := &slowFullMessageHandler{inner: fixtures.New().Handler(), count: map[string]int{}, released: released}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := New(oc.URL, 100)
	// Run binds a.runCtx; canceling it models aggregator shutdown. Set it under
	// its documented guard (seedMu) like Run does, since EnsureMessagesAsync
	// reads it under seedMu.
	runCtx, runCancel := context.WithCancel(context.Background())
	agg.seedMu.Lock()
	agg.runCtx = runCtx
	agg.seedMu.Unlock()

	agg.EnsureMessagesAsync(context.Background(), "demo")
	h.waitForCount(t, "demo", 1)
	// Shut the aggregator down while the fetch is in flight.
	runCancel()
	// Release the (now-cancelled) fetch's gate so the goroutine observes the
	// shutdown and exits cleanly.
	close(released)
	agg.waitMessagesAsync("demo")

	if agg.Store().IsMessagesLoaded("demo") {
		t.Fatal("a shutdown must NOT mark the session loaded")
	}
	agg.msgMu.Lock()
	_, stillInflight := agg.msgInflight["demo"]
	agg.msgMu.Unlock()
	if stillInflight {
		t.Fatal("shutdown must clear the in-flight slot")
	}
}

// gatedRouteHandler wraps the fixture handler and GATES exactly the three
// routes hydrate fans out concurrently — GET /session/status, /question,
// /permission. Each gated route records that it was entered (under mu) and then
// blocks on <-release until the test closes release. This is the
// hydrate-fan-out analog of slowFullMessageHandler: it makes the three upstream
// GETs observably in-flight at once, so a test can prove they run concurrently.
type gatedRouteHandler struct {
	inner   http.Handler
	mu      sync.Mutex
	entered int
	release chan struct{}
}

func (h *gatedRouteHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		switch r.URL.Path {
		case "/session/status", "/question", "/permission":
			h.mu.Lock()
			h.entered++
			h.mu.Unlock()
			<-h.release // block until the test observes all three entered
		}
	}
	h.inner.ServeHTTP(w, r)
}

func (h *gatedRouteHandler) count() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.entered
}

// TestHydrateFansOutStatusQuestionsPermissionsConcurrently proves the three
// independent upstream GETs hydrate issues after the snapshot (SessionStatuses,
// ListQuestions, ListPermissions) run CONCURRENTLY, not serially. On cold start
// / reconnect (epoch change) this is what makes first-snapshot time pay ~1
// round-trip (max latency) instead of the sum of three.
//
// Deterministic: the three routes gate on a shared release channel. The test
// waits until all three are entered (in-flight at once) before releasing any.
// Reaching entered==3 is IMPOSSIBLE under serial execution — the first call
// would block on release forever, so the second and third would never be
// dispatched. It can only reach 3 if all three were dispatched concurrently.
func TestHydrateFansOutStatusQuestionsPermissionsConcurrently(t *testing.T) {
	release := make(chan struct{})
	h := &gatedRouteHandler{inner: fixtures.New().Handler(), release: release}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := New(oc.URL, 100)

	// Run hydrate on a goroutine; it blocks once it reaches the fan-out, since
	// all three gated routes are held on release.
	errc := make(chan error, 1)
	go func() { errc <- agg.Rehydrate(context.Background()) }()

	// Wait until all three gated routes are entered concurrently. Under serial
	// execution this can never reach 3 — the definitive concurrency proof.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && h.count() < 3 {
		time.Sleep(2 * time.Millisecond)
	}
	if got := h.count(); got != 3 {
		t.Fatalf("expected all 3 hydrate fan-out calls entered concurrently, got %d (serial execution would never reach 3)", got)
	}

	// All three are in flight at once: release them and assert hydrate returns
	// cleanly with the store populated.
	close(release)
	select {
	case err := <-errc:
		if err != nil {
			t.Fatalf("rehydrate: %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("rehydrate did not return after release")
	}
	agg.waitColdSeed()
}

// TestHydrateSwallowsEnrichmentErrors locks in the swallow+log semantics of
// hydrate's three-way enrichment fan-out (SessionStatuses/ListQuestions/
// ListPermissions): an upstream failure in ONE call must NOT fail hydrate
// (POST /vh/reload must not 502 on a partial enrichment), and the OTHER two
// calls must still apply their side-effects — proving a single failure does not
// abort its siblings. This matches the prior serial `err == nil`-guard behavior
// while keeping the concurrent fan-out; the failing call's error is logged
// rather than returned.
func TestHydrateSwallowsEnrichmentErrors(t *testing.T) {
	mux := http.NewServeMux()
	// ListQuestions (GET /question) fails — the call under test.
	mux.HandleFunc("/question", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "upstream down", http.StatusInternalServerError)
	})
	// SessionStatuses succeeds with an OBSERVABLE side-effect: demo is reported
	// busy, which SetActivityFromStatuses reflects in Snapshot().Activity.
	mux.HandleFunc("/session/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`{"demo":{"type":"busy"}}`))
	})
	// ListPermissions succeeds with an OBSERVABLE side-effect: one pending
	// permission for demo, which SetPendingPermissions reflects in
	// Snapshot().Permissions.
	mux.HandleFunc("/permission", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(`[{"id":"p1","sessionID":"demo"}]`))
	})
	// Delegate everything else (incl. /session list + cold-seed tails) to the
	// standard fixture so hydrate's earlier phases still succeed.
	mux.Handle("/", fixtures.New().Handler())
	oc := httptest.NewServer(mux)
	defer oc.Close()

	agg := New(oc.URL, 100)
	// hydrate must SWALLOW the /question failure: nil return, not a 500-surfaced
	// error. (Matches prior serial err == nil-guard behavior.)
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("hydrate must swallow enrichment errors (best-effort), got: %v", err)
	}
	agg.waitColdSeed()

	snap := agg.Store().Snapshot(nil)
	// Isolation proof #1: SessionStatuses' side-effect landed despite
	// ListQuestions failing — demo is marked busy.
	if got := snap.Activity["demo"]; got != "busy" {
		t.Fatalf("SessionStatuses side-effect must survive ListQuestions' failure: demo activity want \"busy\", got %q", got)
	}
	// Isolation proof #2: ListPermissions' side-effect landed too — one pending
	// permission for demo.
	if got := len(snap.Permissions["demo"]); got != 1 {
		t.Fatalf("ListPermissions side-effect must survive ListQuestions' failure: demo permissions want 1, got %d", got)
	}
}

// TestEnsureMessagesSyncFailureEmitsErrorAndRetries mirrors
// TestEnsureMessagesAsyncFailureEmitsError for the SYNC EnsureMessages path. On a
// failed upstream GET the sync winner must: return the error to the caller, emit
// messages.error, clear the in-flight slot (so the failure path does not strand a
// reselect), and leave the session unloaded — so a second call issues a fresh GET
// (genuine retry, not a silent no-op on a stale slot).
//
// coldFetchActive note: pkg/state/store.go's coldFetchActive map is unexported
// with no accessor (this slice is comment-only on store.go), so we assert the
// in-flight slot is cleared instead. That transitively proves ClearColdFetchActive
// ran: the sync defer (aggregator.go ~216-224) clears the slot AND calls
// ClearColdFetchActive unconditionally in the same critical section. The async
// mirror test asserts the same way.
func TestEnsureMessagesSyncFailureEmitsErrorAndRetries(t *testing.T) {
	// Count the full-fetch requests (no ?limit=, exactly what client.Messages
	// issues) so the test can prove the retry actually re-issues an upstream
	// fetch rather than short-circuiting on a stale in-flight slot.
	var (
		mu        sync.Mutex
		fullCount int
	)
	mux := http.NewServeMux()
	mux.HandleFunc("/session/broken/message", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("limit") == "" {
			mu.Lock()
			fullCount++
			mu.Unlock()
			http.Error(w, "upstream down", http.StatusInternalServerError)
			return
		}
		http.Error(w, "no tail", http.StatusNotFound)
	})
	mux.Handle("/", fixtures.New().Handler())
	oc := httptest.NewServer(mux)
	defer oc.Close()

	agg := New(oc.URL, 100)
	ch, unsub := agg.Store().Subscribe(128)
	defer unsub()

	// First call: the sync winner's GET fails.
	err := agg.EnsureMessages(context.Background(), "broken")
	if err == nil {
		t.Fatal("EnsureMessages must return the upstream error on a failed GET")
	}
	if agg.Store().IsMessagesLoaded("broken") {
		t.Fatal("a failed fetch must NOT mark the session loaded (retry on reselect)")
	}
	// The in-flight slot must be cleared so the next selection retries.
	agg.msgMu.Lock()
	_, stillInflight := agg.msgInflight["broken"]
	agg.msgMu.Unlock()
	if stillInflight {
		t.Fatal("a failed fetch must clear the in-flight slot so a reselect retries")
	}
	// The first attempt must have hit the upstream exactly once.
	mu.Lock()
	firstFetches := fullCount
	mu.Unlock()
	if firstFetches != 1 {
		t.Fatalf("first fetch: want 1 full upstream GET, got %d", firstFetches)
	}
	// A messages.error must be emitted.
	var sawErr bool
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) && !sawErr {
		select {
		case e := <-ch:
			if e.Kind == "messages.error" {
				sawErr = true
			}
		case <-time.After(20 * time.Millisecond):
		}
	}
	if !sawErr {
		t.Fatal("a failed fetch must emit messages.error")
	}

	// Retry on reselect: a second call issues a fresh fetch (the slot was cleared
	// and the session is still unloaded). Proves the failure path did not strand
	// the slot.
	err = agg.EnsureMessages(context.Background(), "broken")
	if err == nil {
		t.Fatal("retry must also surface the upstream error (still failing)")
	}
	mu.Lock()
	retryFetches := fullCount
	mu.Unlock()
	if retryFetches != 2 {
		t.Fatalf("retry must issue a fresh upstream GET: want 2 (1 fail + 1 retry), got %d", retryFetches)
	}
}

// TestEnsureMessagesSyncSingleFlightWaiter proves the sync single-flight waiter's
// retry/no-op semantics. Two concurrent sync EnsureMessages calls race for the
// same unloaded session; the first to register the done chan is the WINNER, the
// second parks on <-done (or takes the under-lock re-check branch). The outcome
// is fully determined by the winner's GET result:
//
//   - WinnerFailsWaiterRetries: winner's GET fails → defer clears slot + marker +
//     closes done. The waiter wakes, loops, re-checks IsMessagesLoaded (still
//     false), becomes the fresh winner, and its GET succeeds. Exactly 2 upstream
//     GETs (winner-fail + waiter-win); final state loaded.
//   - WinnerSucceedsWaiterNoop: winner's GET succeeds → SetSessionMessages marks
//     loaded + closes done. The waiter wakes, loops, re-checks IsMessagesLoaded
//     (now true), returns nil. Exactly 1 upstream GET (the winner's); final
//     state loaded.
//
// Deterministic rendezvous: a hold channel blocks the winner's GET inside the
// handler until the test closes it; a notify channel signals GET-in-flight so the
// test starts the waiter only after the winner's slot is registered (the slot is
// registered at aggregator.go ~207, before client.Messages at ~226, so it exists
// when notify fires). No sleeps. The GET-count + loaded-state assertions are
// invariant to whether the waiter parks on <-done or hits the under-lock re-check
// branch under adversarial scheduling — both paths yield the same counts.
func TestEnsureMessagesSyncSingleFlightWaiter(t *testing.T) {
	const sid = "race"
	const successBody = `[{"info":{"id":"m1","sessionID":"race","role":"user"},"parts":[{"id":"p1","sessionID":"race","messageID":"m1","type":"text","text":"loaded"}]}]`

	cases := []struct {
		name      string
		failFirst bool
		wantGETs  int
	}{
		{"WinnerFailsWaiterRetries", true, 2},
		{"WinnerSucceedsWaiterNoop", false, 1},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var (
				mu        sync.Mutex
				fullCount int
			)
			hold := make(chan struct{})      // blocks GET(s) until closed
			notify := make(chan struct{}, 1) // signals GET #1 in flight

			mux := http.NewServeMux()
			mux.HandleFunc("/session/"+sid+"/message", func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Query().Get("limit") == "" {
					mu.Lock()
					fullCount++
					n := fullCount
					mu.Unlock()
					select {
					case notify <- struct{}{}:
					default:
					}
					<-hold // deterministic in-flight: block until released
					if tc.failFirst && n == 1 {
						http.Error(w, "upstream down", http.StatusInternalServerError)
						return
					}
					w.Header().Set("Content-Type", "application/json")
					w.Write([]byte(successBody))
					return
				}
				http.Error(w, "no tail", http.StatusNotFound)
			})
			mux.Handle("/", fixtures.New().Handler())
			oc := httptest.NewServer(mux)
			defer oc.Close()

			agg := New(oc.URL, 100)
			ctx := context.Background()

			// Launch the WINNER: it registers the done chan, then issues the GET
			// which blocks on hold inside the handler.
			winErr := make(chan error, 1)
			go func() { winErr <- agg.EnsureMessages(ctx, sid) }()

			// Wait until the winner's GET is observably in flight. At this point
			// the done chan is already registered in msgInflight[sid] (registered
			// before client.Messages), so the waiter will find it.
			<-notify

			// Launch the WAITER. It will either park on <-done (if the winner is
			// still in flight) or hit the under-lock re-check branch (if the winner
			// already completed). Either path yields the same GET-count + loaded
			// outcome.
			waitErr := make(chan error, 1)
			go func() { waitErr <- agg.EnsureMessages(ctx, sid) }()

			// Release the winner's GET: it completes (fail or succeed), its defer
			// clears the slot + marker + closes done, and the waiter proceeds.
			close(hold)

			// Collect both results.
			if err := <-winErr; (err == nil) == tc.failFirst {
				t.Fatalf("winner EnsureMessages: failFirst=%v, got err=%v", tc.failFirst, err)
			}
			if err := <-waitErr; err != nil {
				t.Fatalf("waiter EnsureMessages: want nil error, got %v", err)
			}

			// Assert exact upstream full GET count.
			mu.Lock()
			gotGETs := fullCount
			mu.Unlock()
			if gotGETs != tc.wantGETs {
				t.Fatalf("upstream full GETs: want %d, got %d", tc.wantGETs, gotGETs)
			}

			// Assert final loaded state.
			if !agg.Store().IsMessagesLoaded(sid) {
				t.Fatal("final state must be loaded (winner or waiter succeeded)")
			}

			// Assert the in-flight slot is cleared after both calls complete.
			agg.msgMu.Lock()
			_, stillInflight := agg.msgInflight[sid]
			agg.msgMu.Unlock()
			if stillInflight {
				t.Fatal("in-flight slot must be cleared after both calls complete")
			}
		})
	}
}

// Stop() is the teardown half of POST /vh/reload-project: it cancels the
// aggregator's Run context (so the event tail, hydrate, and cold-seed exit) and
// closes the store's subscribers (so downstream SSE streams drop and browsers
// reconnect against a fresh aggregator). This test exercises the full lifecycle
// — RunManaged arms a.cancel, Run runs, Stop() cancels+ closes — and asserts
// both observable effects: Run returns and a live subscriber's channel closes.
func TestStopCancelsRunAndClosesSubscribers(t *testing.T) {
	oc := httptest.NewServer(fixtures.New().Handler())
	defer oc.Close()

	agg := New(oc.URL, 100)

	// RunManaged derives a cancellable child of the parent ctx and arms a.cancel
	// internally (this is exactly how aggFor starts a per-project aggregator).
	done := make(chan struct{})
	go func() {
		agg.RunManaged(context.Background())
		close(done)
	}()

	// Subscribe and wait until Run has hydrated enough to emit at least one live
	// event — proof the loop is actually running before we Stop it.
	ch, unsub := agg.Store().Subscribe(128)
	defer unsub()
	deadline := time.Now().Add(3 * time.Second)
	gotEvent := false
	for time.Now().Before(deadline) && !gotEvent {
		select {
		case <-ch:
			gotEvent = true
		case <-time.After(20 * time.Millisecond):
		}
	}
	if !gotEvent {
		t.Fatal("aggregator never emitted an event before Stop (Run not running?)")
	}

	agg.Stop()

	// (1) Run must have exited because a.cancel() cancelled its ctx.
	select {
	case <-done:
		// good
	case <-time.After(3 * time.Second):
		t.Fatal("Run did not return after Stop()")
	}

	// (2) The subscriber channel must be closed (Store.Close): a receive returns
	// the zero value with ok==false. Drain any buffered events first, then a
	// fresh receive must show the close.
	drained := false
	for !drained {
		select {
		case _, ok := <-ch:
			if !ok {
				drained = true
			}
		case <-time.After(3 * time.Second):
			t.Fatal("subscriber channel was not closed by Stop() (Store.Close)")
		}
	}
}

// Stop() must be safe on the DEFAULT aggregator too — the daemon starts the
// default with plain Run (no a.cancel), so a Stop of it nil-checks cancel and
// still closes the store. This guards the nil path explicitly (the default
// aggregator is process-lifetime and is never dropped via handleReloadProject,
// but Stop must not panic if ever invoked on it).
func TestStopNilCancelIsSafe(t *testing.T) {
	oc := httptest.NewServer(fixtures.New().Handler())
	defer oc.Close()

	agg := New(oc.URL, 100)
	// Start Run directly (NOT RunManaged) so agg.cancel stays nil — this is the
	// daemon's default-aggregator start path. The parent ctx is cancellable only
	// for test cleanup; agg.cancel is never armed.
	parentCtx, cancelParent := context.WithCancel(context.Background())
	defer cancelParent()
	done := make(chan struct{})
	go func() {
		agg.Run(parentCtx) // plain Run, like the daemon — leaves cancel nil
		close(done)
	}()

	// Wait for Run to be live.
	ch, unsub := agg.Store().Subscribe(128)
	defer unsub()
	deadline := time.Now().Add(3 * time.Second)
	gotEvent := false
	for time.Now().Before(deadline) && !gotEvent {
		select {
		case <-ch:
			gotEvent = true
		case <-time.After(20 * time.Millisecond):
		}
	}
	if !gotEvent {
		t.Fatal("default aggregator never emitted an event before Stop")
	}

	// cancel is nil here; Stop must not panic. It closes the store (subscribers
	// drop) but does NOT cancel Run (the default has no armed cancel).
	agg.Stop()

	// Subscriber channel closed by Store.Close.
	closed := false
	for !closed {
		select {
		case _, ok := <-ch:
			if !ok {
				closed = true
			}
		case <-time.After(3 * time.Second):
			t.Fatal("subscriber channel was not closed by Stop() on default aggregator")
		}
	}

	// Clean up the still-running default aggregator (its cancel was nil, so Stop
	// didn't end Run) via the parent ctx before the server closes.
	cancelParent()
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("default Run did not exit after parent cancel")
	}
}

// TestRunStatusReconcileHealsStaleBusy is the FAIL-without / PASS-with proof for
// the periodic /session/status reconcile ticker wired into Run.
//
// Scenario: a root goes busy via a session.status event that the aggregator
// applied, but OpenCode later finishes the turn and the matching session.idle
// is LOST (dropped tunnel / reconnect gap / a turn that ended without emitting
// idle). OpenCode's /session/status authoritatively reports {} (nothing busy).
// The reconcile ticker must re-fetch it and clear the stale flag by routing
// through store.SetActivityFromStatuses -> setActivityLocked.
//
// To isolate the ticker as the ONLY heal source, the /event stream is held open
// by a hanging handler so NO reconnect / re-hydrate fires within the test
// window (SubscribeEvents's idle timeout is 45s, far longer than the test). The
// status reconcile interval is shrunk to ~5ms.
//
// WITHOUT the `go a.runStatusReconcile(ctx)` line in Run, RunningRoots() stays
// 1 for the whole window → the heal-poll times out → FAIL.
// WITH the ticker, the stale root is cleared within a few ticks → PASS.
func TestRunStatusReconcileHealsStaleBusy(t *testing.T) {
	mux := http.NewServeMux()
	// Empty session list: hydrate finds nothing to load.
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("[]"))
	})
	// Authoritative: nothing is busy. This is what clears the stale flag.
	mux.HandleFunc("/session/status", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("{}"))
	})
	// Hold the event stream open WITHOUT sending data so SubscribeEvents blocks
	// in its read goroutine and NO reconnect/re-hydrate fires within the test
	// (idleTimeout = 45s >> test deadline). This isolates the ticker as the only
	// heal source.
	mux.HandleFunc("/event", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if fl, ok := w.(http.Flusher); ok {
			fl.Flush()
		}
		<-r.Context().Done()
	})
	// Delegate everything else (cold-seed tails, etc.) to the fixture handler.
	mux.Handle("/", fixtures.New().Handler())

	oc := httptest.NewServer(mux)
	defer oc.Close()

	agg := New(oc.URL, 100)
	// Shrink the reconcile interval on THIS instance (not a package global,
	// which would race a lingering runStatusReconcile goroutine from another
	// aggregator / a prior -count iteration) so the heal fires within the
	// test window. Set before RunManaged so the goroutine launch establishes
	// the happens-before edge to runStatusReconcile's single read of it.
	agg.statusReconcileInterval = 5 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.RunManaged(ctx)

	// Wait for the one-shot hydrate reconcile to run against the empty store so
	// the later stale-busy seed is not coincidentally cleared by hydrate.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && !agg.HydratedOnce() {
		time.Sleep(2 * time.Millisecond)
	}
	if !agg.HydratedOnce() {
		t.Fatal("aggregator never completed initial hydrate")
	}
	agg.waitColdSeed()

	// NOW seed a stale-busy root AFTER hydrate, simulating a session.status the
	// aggregator applied but whose session.idle was lost.
	store := agg.Store()
	applyEvent := func(typ, props string) {
		store.Apply(opencode.Event{Type: typ, Properties: json.RawMessage(props)})
	}
	applyEvent("session.created", `{"info":{"id":"ghost"}}`)
	applyEvent("session.status", `{"sessionID":"ghost","status":{"type":"busy"}}`)
	if got := store.RunningRoots(); got != 1 {
		t.Fatalf("post-seed: want stale ghost counted as 1 running, got %d", got)
	}

	// Poll for the ticker to heal it. Without the ticker this times out → FAIL.
	healDeadline := time.Now().Add(1 * time.Second)
	for time.Now().Before(healDeadline) && store.RunningRoots() != 0 {
		time.Sleep(2 * time.Millisecond)
	}
	if got := store.RunningRoots(); got != 0 {
		t.Fatalf("reconcile ticker did not heal stale-busy root within 1s: RunningRoots=%d (want 0)", got)
	}

	// The snapshot path agrees: ghost is no longer busy / subtree-busy.
	gate := store.Snapshot(nil).Gate["ghost"]
	if gate.Activity != "idle" {
		t.Fatalf("after heal: want ghost Activity idle, got %q", gate.Activity)
	}
	if gate.SubtreeBusy {
		t.Fatal("after heal: want ghost SubtreeBusy false")
	}
}
