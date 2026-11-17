package aggregator

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// TestReseedCreatedSessionAgentEmptyTailStaysEligibleThenMemoizes is the W4
// debt-paydown proof for reseedCreatedSessionAgent's memo placement. A first
// re-seed whose tail has NO assistant turn (the genuinely-new-session shape)
// must NOT mark the cold-seed memo: the session stays retry-eligible, so a
// later trigger (a mid-stream remove/recreate's session.created, or a reconnect
// hydrate) performs a SECOND tail GET and recovers the agent. The NOW-successful
// seed memoizes, suppressing a THIRD GET. Pre-fix, the unconditional
// MarkColdSeeded pinned the memo on the empty tail, so the retry never happened
// and the session's lastAgent stayed empty forever on a connected daemon.
//
// CONTRACT (observed via the in-package HTTP-counting seam — per-sid tail GETs
// (?limit=coldTailLimit), the tail counterpart of the full-fetch counters in
// messages_resident_test.go):
//   - GET #1 (empty tail) → no lastAgent write, NO memo → ColdSeedNeeded still
//     returns the id
//   - GET #2 (agent "B")  → lastAgent["s_reseed"] == "B", memo marked
//   - third re-seed call  → ColdSeedNeeded guard exits pre-HTTP → count stays 2
func TestReseedCreatedSessionAgentEmptyTailStaysEligibleThenMemoizes(t *testing.T) {
	h := &reseedTailHandler{
		inner: fixtures.New().Handler(),
		count: map[string]int{},
		// Armed from the start with the empty tail: every s_reseed tail GET is
		// answered here (never delegated), so the count is exact.
		tails: map[string]string{"s_reseed": ""},
	}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := New(oc.URL, 100)
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	agg.waitColdSeed()

	// The production trigger shape: a session.created for an id the hydrate
	// never saw (mid-stream remove/recreate), applied to the store — the same
	// event lifecycle.go routes to startCreatedSessionReseed.
	agg.Store().Apply(opencode.Event{Type: "session.created", Properties: json.RawMessage(`{"info":{"id":"s_reseed"}}`)})
	if got := agg.Store().ColdSeedNeeded([]string{"s_reseed"}); len(got) != 1 {
		t.Fatalf("precondition: s_reseed must be tracked and un-seeded, got %v", got)
	}

	// Seed #1: empty tail. Must fetch (GET #1) but NOT memoize.
	agg.reseedCreatedSessionAgent(context.Background(), "s_reseed")
	if got, want := h.tailGETs("s_reseed"), 1; got != want {
		t.Fatalf("first re-seed must tail-fetch exactly once: GETs=%d want %d", got, want)
	}
	if got := agg.Store().ColdSeedNeeded([]string{"s_reseed"}); len(got) != 1 {
		t.Fatalf("empty-tail re-seed must NOT memoize (session stays retry-eligible), ColdSeedNeeded=%v", got)
	}

	// The session's first assistant turn lands (agent B).
	h.armTail("s_reseed", `[{"info":{"id":"rm1","sessionID":"s_reseed","role":"assistant","agent":"B"}}]`)

	// Seed #2: valid tail → GET #2 → agent B recovered AND memoized.
	agg.reseedCreatedSessionAgent(context.Background(), "s_reseed")
	if got, want := h.tailGETs("s_reseed"), 2; got != want {
		t.Fatalf("retry after empty tail must perform a SECOND tail GET: GETs=%d want %d", got, want)
	}
	if got := agg.Store().Snapshot(nil).LastAgents["s_reseed"]; got != "B" {
		t.Fatalf("second re-seed must recover agent B, got %q", got)
	}

	// Seed #3: the successful memo must suppress a third GET entirely.
	agg.reseedCreatedSessionAgent(context.Background(), "s_reseed")
	if got, want := h.tailGETs("s_reseed"), 2; got != want {
		t.Fatalf("successful seed must memoize and prevent a THIRD tail GET: GETs=%d want %d", got, want)
	}
}

// reseedTailHandler wraps the fixture backend and answers cold-seed TAIL GETs
// (GET /session/:id/message?limit=coldTailLimit) for sids armed in tails with a
// mutable per-sid body (armed-"" → `[]`, the no-assistant-turn tail). Full
// fetches and every other path delegate to the fixture. The tail GET is exactly
// the request reseedCreatedSessionAgent/seedColdLastAgents issue — distinct
// from the full-fetch shape the messages_resident_test.go counters key on.
type reseedTailHandler struct {
	inner http.Handler
	mu    sync.Mutex
	count map[string]int    // sid -> tail-GET count
	tails map[string]string // sid -> armed tail body ("" → empty tail)
}

func (h *reseedTailHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/session/") && strings.HasSuffix(r.URL.Path, "/message") &&
		r.URL.Query().Get("limit") == strconv.Itoa(coldTailLimit) {
		sid := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/session/"), "/message")
		h.mu.Lock()
		body, armed := h.tails[sid]
		if armed {
			h.count[sid]++
		}
		h.mu.Unlock()
		if armed {
			w.Header().Set("Content-Type", "application/json")
			if body == "" {
				body = "[]"
			}
			_, _ = w.Write([]byte(body))
			return
		}
	}
	h.inner.ServeHTTP(w, r)
}

func (h *reseedTailHandler) tailGETs(sid string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.count[sid]
}

func (h *reseedTailHandler) armTail(sid, body string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.tails[sid] = body
}
