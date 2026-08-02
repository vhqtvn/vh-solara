package aggregator

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// TestEnsureMessagesRefetchesMissingResidentParts is the behavioral proof of the
// S5 hydration contract: a cold history GET that returns a COMPLETED assistant
// with NO inline parts (the envelope-only schema-drift shape — the opencode DB
// actually HAS the parts) must NOT be reported "loaded", and the daemon must
// serve the real parts. The disambiguation loop performs ONE bounded re-fetch
// WITHIN the single open so a lying cold load resolves without a manual re-select
// (the web client does not auto-retry a stuck-loaded session).
//
// CONTRACT: one EnsureMessages call → the schema-drift cold load (GET #1, 0
// parts) is NOT admitted; the aggregator immediately re-fetches (GET #2) which
// serves the real parts → resident → loaded → messages.loaded emitted. Exactly
// two upstream GETs; IsMessagesLoaded true; last_assistant_empty reflects content.
func TestEnsureMessagesRefetchesMissingResidentParts(t *testing.T) {
	// schemaDriftHandler serves the FIRST full GET as a completed assistant with
	// NO inline parts (the lying cold-load shape), then serves the real parts on
	// the next full fetch (the opencode DB has them).
	h := &schemaDriftHandler{
		inner:        fixtures.New().Handler(),
		count:        map[string]int{},
		envelopeOnly: map[string]bool{"sub": true},
	}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := New(oc.URL, 100)
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	agg.waitColdSeed()

	ch, unsub := agg.Store().Subscribe(256)
	defer unsub()

	// ONE open. GET #1 is the schema-drift shape (0 parts) → not loaded → the
	// disambiguation loop re-fetches once → GET #2 serves the real parts.
	if err := agg.EnsureMessages(context.Background(), "sub"); err != nil {
		t.Fatalf("EnsureMessages: %v", err)
	}
	if got, want := h.countOf("sub"), 2; got != want {
		t.Fatalf("schema-drift must resolve within ONE open via exactly one disambiguating re-fetch: full-fetch count=%d want %d", got, want)
	}
	// The re-fetch populated the real parts → loaded is true.
	if !agg.Store().IsMessagesLoaded("sub") {
		t.Fatalf("IsMessagesLoaded must be true once the re-fetch populated resident parts")
	}
	g := agg.Store().Snapshot(nil).Gate["sub"]
	if !g.MessagesLoaded {
		t.Fatalf("gate.messagesLoaded must be true once parts are resident")
	}
	if g.LastAssistantEmpty {
		t.Fatalf("gate.last_assistant_empty must reflect the resident text content, got true")
	}
	if !drainForLoaded(t, ch, time.Second) {
		t.Fatalf("messages.loaded must be emitted once the schema-drift re-fetch served the parts")
	}
}

// TestEnsureMessagesAsyncSchemaDriftResolvesInOneOpen is the Stream-2 (async)
// counterpart: the async open path's schema-drift cold load (GET #1, 0 parts)
// must resolve via the in-open disambiguating re-fetch (GET #2, parts) and emit
// messages.loaded — the client's completion contract keys on that event, so
// without the in-open re-fetch a schema-drift session would wedge on the loading
// state (the client does not auto-retry). Gate↔emit consistency (b-F1) is
// preserved: loaded is emitted only after the final IsMessagesLoaded gate holds.
func TestEnsureMessagesAsyncSchemaDriftResolvesInOneOpen(t *testing.T) {
	h := &schemaDriftHandler{
		inner:        fixtures.New().Handler(),
		count:        map[string]int{},
		envelopeOnly: map[string]bool{"sub": true},
	}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := New(oc.URL, 100)
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	agg.waitColdSeed()

	ch, unsub := agg.Store().Subscribe(256)
	defer unsub()

	// ONE async open. GET #1 schema-drift (0 parts) → re-fetch → GET #2 parts.
	agg.EnsureMessagesAsync("sub")
	agg.waitMessagesAsync("sub")
	if got, want := h.countOf("sub"), 2; got != want {
		t.Fatalf("async schema-drift must resolve within ONE open via one disambiguating re-fetch: full-fetch count=%d want %d", got, want)
	}
	if !agg.Store().IsMessagesLoaded("sub") {
		t.Fatalf("IsMessagesLoaded must be true once the async re-fetch populated resident parts")
	}
	if !drainForLoaded(t, ch, time.Second) {
		t.Fatalf("messages.loaded must be emitted once the async schema-drift re-fetch served the parts")
	}
}

// TestEnsureMessagesConfirmsSourceEmptyWithinSingleOpen is the ses_05ff fix: a
// session whose newest COMPLETED assistant GENUINELY has zero source parts (the
// opencode DB has none) must load within ONE open instead of looping forever.
// The disambiguation loop re-fetches once; the second reconcile observing the
// SAME empty newest confirms source-truth → admitted → messages.loaded emitted.
// Exactly two upstream GETs (never a third).
func TestEnsureMessagesConfirmsSourceEmptyWithinSingleOpen(t *testing.T) {
	h := &sourceEmptyHandler{inner: fixtures.New().Handler(), count: map[string]int{}}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := New(oc.URL, 100)
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	agg.waitColdSeed()

	ch, unsub := agg.Store().Subscribe(256)
	defer unsub()

	// ONE open. GET #1 = 0 parts (pending, not confirmed) → re-fetch → GET #2 =
	// 0 parts again (confirmed source-truth) → admitted as genuinely empty.
	if err := agg.EnsureMessages(context.Background(), "sub"); err != nil {
		t.Fatalf("EnsureMessages: %v", err)
	}
	if got, want := h.countOf("sub"), 2; got != want {
		t.Fatalf("source-empty must confirm within ONE open via exactly one disambiguating re-fetch: full-fetch count=%d want %d (never a third)", got, want)
	}
	if !agg.Store().IsMessagesLoaded("sub") {
		t.Fatalf("IsMessagesLoaded must be TRUE for a source-confirmed empty newest (the ses_05ff fix)")
	}
	g := agg.Store().Snapshot(nil).Gate["sub"]
	if !g.MessagesLoaded {
		t.Fatalf("gate.messagesLoaded must be true once the empty newest is confirmed")
	}
	if !drainForLoaded(t, ch, time.Second) {
		t.Fatalf("messages.loaded must be emitted once the empty newest is confirmed by the re-fetch")
	}
}

// TestEnsureMessagesAsyncConfirmsSourceEmptyWithinSingleOpen is the async
// counterpart of the ses_05ff fix on the Stream-2 path.
func TestEnsureMessagesAsyncConfirmsSourceEmptyWithinSingleOpen(t *testing.T) {
	h := &sourceEmptyHandler{inner: fixtures.New().Handler(), count: map[string]int{}}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := New(oc.URL, 100)
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	agg.waitColdSeed()

	ch, unsub := agg.Store().Subscribe(256)
	defer unsub()

	agg.EnsureMessagesAsync("sub")
	agg.waitMessagesAsync("sub")
	if got, want := h.countOf("sub"), 2; got != want {
		t.Fatalf("async source-empty must confirm within ONE open: full-fetch count=%d want %d", got, want)
	}
	if !agg.Store().IsMessagesLoaded("sub") {
		t.Fatalf("IsMessagesLoaded must be TRUE for a source-confirmed empty newest (async)")
	}
	if !drainForLoaded(t, ch, time.Second) {
		t.Fatalf("messages.loaded must be emitted once the async empty-newest re-fetch confirmed it")
	}
}

// drainForLoaded drains ch until a messages.loaded event arrives or the deadline
// passes. Returns true if loaded was observed.
func drainForLoaded(t *testing.T, ch <-chan state.ClientEvent, deadline time.Duration) bool {
	t.Helper()
	end := time.Now().Add(deadline)
	for time.Now().Before(end) {
		select {
		case e := <-ch:
			if e.Kind == "messages.loaded" {
				return true
			}
		case <-time.After(20 * time.Millisecond):
		}
	}
	return false
}

// schemaDriftHandler wraps the fixture backend. The FIRST full fetch
// (GET /session/:id/message with NO limit) for an sid flagged in envelopeOnly is
// answered as a completed-assistant envelope with NO inline parts; the flag is
// then cleared so the next full fetch serves the real parts. Tail fetches
// (?limit=N, used by cold-seed) and all other paths delegate to the fixture.
type schemaDriftHandler struct {
	inner        http.Handler
	mu           sync.Mutex
	count        map[string]int  // sid -> full-fetch count
	envelopeOnly map[string]bool // sid -> next full-fetch is envelope-only
}

func (h *schemaDriftHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Query().Get("limit") == strconv.Itoa(state.WindowMaxCount) &&
		strings.HasPrefix(r.URL.Path, "/session/") && strings.HasSuffix(r.URL.Path, "/message") {
		sid := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/session/"), "/message")
		h.mu.Lock()
		h.count[sid]++
		envOnly := h.envelopeOnly[sid]
		if envOnly {
			delete(h.envelopeOnly, sid) // only the FIRST full fetch is envelope-only
		}
		h.mu.Unlock()
		if envOnly {
			// Schema-drift cold-load shape: a COMPLETED assistant turn with NO
			// inline parts — the opencode DB actually has the parts.
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`[{"info":{"id":"sm1","sessionID":"sub","role":"assistant","agent":"general","time":{"created":1,"completed":2},"finish":"stop"}}]`))
			return
		}
		// The opencode DB actually has the parts — the re-fetch serves them.
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"info":{"id":"sm1","sessionID":"sub","role":"assistant","agent":"general","time":{"created":1,"completed":2},"finish":"stop"},"parts":[{"id":"sp1","type":"text","text":"Searched 12 files, found 3 matches."}]}]`))
		return
	}
	h.inner.ServeHTTP(w, r)
}

func (h *schemaDriftHandler) countOf(sid string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.count[sid]
}

// sourceEmptyHandler wraps the fixture backend and answers EVERY full fetch
// (GET /session/:id/message with NO limit) as a completed-assistant turn with
// NO inline parts — the source-truth-empty shape (the opencode DB genuinely has
// 0 parts for this turn). Tail fetches (?limit=N) and other paths delegate.
type sourceEmptyHandler struct {
	inner http.Handler
	mu    sync.Mutex
	count map[string]int // sid -> full-fetch count
}

func (h *sourceEmptyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Query().Get("limit") == strconv.Itoa(state.WindowMaxCount) &&
		strings.HasPrefix(r.URL.Path, "/session/") && strings.HasSuffix(r.URL.Path, "/message") {
		sid := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/session/"), "/message")
		h.mu.Lock()
		h.count[sid]++
		h.mu.Unlock()
		// Source truth: a COMPLETED assistant turn that genuinely produced no
		// parts. A single fetch returning this is ambiguous (could be schema
		// drift); two reconciles seeing the same empty newest confirms it.
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"info":{"id":"sm1","sessionID":"sub","role":"assistant","agent":"general","time":{"created":1,"completed":2},"finish":"stop"}}]`))
		return
	}
	h.inner.ServeHTTP(w, r)
}

func (h *sourceEmptyHandler) countOf(sid string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.count[sid]
}

// TestEnsureMessagesAbortedNewestLoadsInOneFetch is the terminal-error fast-path
// behavioral proof (TDD case #5): a session whose newest COMPLETED assistant is
// an ABORTED turn (info.error.name == "MessageAbortedError", zero parts — the
// confirmed ses_05ff9273dffe7N4dh1HliZhIXq shape) must load within ONE open via
// EXACTLY ONE upstream fetch. The aborted signal positively classifies the turn
// as terminal/outputless, so it is admitted on the first reconcile and the
// aggregator does NOT perform the O5 disambiguating re-fetch (contrast
// TestEnsureMessagesConfirmsSourceEmptyWithinSingleOpen, which needs two fetches
// for a non-aborted genuinely-empty newest). messages.loaded is emitted.
func TestEnsureMessagesAbortedNewestLoadsInOneFetch(t *testing.T) {
	h := &abortedHandler{inner: fixtures.New().Handler(), count: map[string]int{}}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := New(oc.URL, 100)
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	agg.waitColdSeed()

	ch, unsub := agg.Store().Subscribe(256)
	defer unsub()

	// ONE open. The aborted newest admits on the FIRST fetch — NO re-fetch.
	if err := agg.EnsureMessages(context.Background(), "sub"); err != nil {
		t.Fatalf("EnsureMessages: %v", err)
	}
	if got, want := h.countOf("sub"), 1; got != want {
		t.Fatalf("an aborted newest must load via exactly ONE fetch (terminal-error fast-path, no disambiguating re-fetch): full-fetch count=%d want %d", got, want)
	}
	if !agg.Store().IsMessagesLoaded("sub") {
		t.Fatalf("IsMessagesLoaded must be TRUE for an aborted newest after a single fetch")
	}
	g := agg.Store().Snapshot(nil).Gate["sub"]
	if !g.MessagesLoaded {
		t.Fatalf("gate.messagesLoaded must be true for an aborted newest after a single fetch")
	}
	if !drainForLoaded(t, ch, time.Second) {
		t.Fatalf("messages.loaded must be emitted for an aborted newest after a single fetch")
	}
}

// TestEnsureMessagesAsyncAbortedNewestLoadsInOneFetch is the async (Stream-2)
// counterpart of the terminal-error fast-path: a session whose newest COMPLETED
// assistant is an ABORTED turn must load within ONE open via EXACTLY ONE
// upstream fetch on the async path too. The aborted signal positively
// classifies the turn as terminal/outputless, so it admits on the FIRST
// reconcile (no O5 disambiguating re-fetch, contrast
// TestEnsureMessagesAsyncConfirmsSourceEmptyWithinSingleOpen which needs two
// fetches for a non-aborted genuinely-empty newest) and messages.loaded is
// emitted. Mirrors the async wait/assert idiom of
// TestEnsureMessagesAsyncConfirmsSourceEmptyWithinSingleOpen.
func TestEnsureMessagesAsyncAbortedNewestLoadsInOneFetch(t *testing.T) {
	h := &abortedHandler{inner: fixtures.New().Handler(), count: map[string]int{}}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := New(oc.URL, 100)
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	agg.waitColdSeed()

	ch, unsub := agg.Store().Subscribe(256)
	defer unsub()

	// ONE async open. The aborted newest admits on the FIRST fetch — NO re-fetch.
	agg.EnsureMessagesAsync("sub")
	agg.waitMessagesAsync("sub")
	if got, want := h.countOf("sub"), 1; got != want {
		t.Fatalf("an aborted newest must load via exactly ONE fetch on the async path (terminal-error fast-path, no disambiguating re-fetch): full-fetch count=%d want %d", got, want)
	}
	if !agg.Store().IsMessagesLoaded("sub") {
		t.Fatalf("IsMessagesLoaded must be TRUE for an aborted newest after a single fetch on the async path")
	}
	if !drainForLoaded(t, ch, time.Second) {
		t.Fatalf("messages.loaded must be emitted for an aborted newest after a single fetch on the async path")
	}
}

// abortedHandler wraps the fixture backend and answers EVERY full fetch
// (GET /session/:id/message with NO limit) as an ABORTED completed-assistant
// turn with zero parts — the confirmed ses_05ff shape: info.error.name ==
// "MessageAbortedError", tokens all zero, no finish. Tail fetches (?limit=N,
// used by cold-seed) and other paths delegate to the fixture.
type abortedHandler struct {
	inner http.Handler
	mu    sync.Mutex
	count map[string]int // sid -> full-fetch count
}

func (h *abortedHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Query().Get("limit") == strconv.Itoa(state.WindowMaxCount) &&
		strings.HasPrefix(r.URL.Path, "/session/") && strings.HasSuffix(r.URL.Path, "/message") {
		sid := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/session/"), "/message")
		h.mu.Lock()
		h.count[sid]++
		h.mu.Unlock()
		// The verbatim live shape of the offending newest assistant
		// msg_fb30d2644001rKpffGJmphivax: an aborted turn that produced no
		// output. info.error.name == "MessageAbortedError" is the positive
		// terminal classification the gate fast-paths on.
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[{"info":{"id":"sm1","sessionID":"sub","role":"assistant","agent":"general","time":{"created":1785415411268,"completed":1785415414277},"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}},"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"variant":"default"}}]`))
		return
	}
	h.inner.ServeHTTP(w, r)
}

func (h *abortedHandler) countOf(sid string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.count[sid]
}
