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
	"github.com/vhqtvn/vh-solara/pkg/state"
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

// TestColdSeedReseedLateHeldResponseKeepsLoadedAgent is the W5
// late-overwrite falsification cell (third-pass brief
// tmp/agent-runs/defer-restudy-2026-11-16/solution-brief-final-5.md, "O1 —
// defer-reseed-adversarial-coverage: DO-NOW investigation" / "Proposed W5"):
// a slow reseed tail response whose OLD data (agent A) was captured BEFORE a
// newer authoritative history load (agent B, via SetSessionMessages — the
// message-recompute path that owns a loaded session's lastAgent) must NOT
// clobber B when it finally lands. The interleaving, exactly as the brief
// encodes it:
//
//  1. s_late tracked+unloaded+unseeded → reseed fetches the tail (GET #1);
//  2. the handler CAPTURES the request and A's armed body, then blocks
//     BEFORE writing the response (holdTail rendezvous);
//  3. SetSessionMessages installs authoritative history with agent B →
//     session becomes LOADED, snapshot lastAgent = B;
//  4. the held response A is released and the reseed completes;
//  5. THE CELL: snapshot lastAgent must STILL be B (A must not overwrite
//     it), and exactly ONE tail GET may have occurred for s_late.
//
// A != B deliberately (an identical-agent clobber would be an invisible
// no-op at setLastAgentLocked's unchanged guard). Static prediction was RED
// (reseedCreatedSessionAgent checks loaded-state only at entry, before the
// fetch; setLastAgentLocked has no loaded fence) — a genuine failure here is
// a FINDING to be repaired in a separate slice, not an in-slice fix.
func TestColdSeedReseedLateHeldResponseKeepsLoadedAgent(t *testing.T) {
	h := &reseedTailHandler{
		inner: fixtures.New().Handler(),
		count: map[string]int{},
		tails: map[string]string{},
	}
	oc := httptest.NewServer(h)

	agg := New(oc.URL, 100)
	if err := agg.Rehydrate(context.Background()); err != nil {
		defer oc.Close()
		t.Fatalf("rehydrate: %v", err)
	}
	agg.waitColdSeed()

	// The production trigger shape (same as the W4 cell above): a
	// session.created for an id the hydrate never saw, applied to the store —
	// the event lifecycle.go routes to the single-id reseed.
	agg.Store().Apply(opencode.Event{Type: "session.created", Properties: json.RawMessage(`{"info":{"id":"s_late"}}`)})
	if got := agg.Store().ColdSeedNeeded([]string{"s_late"}); len(got) != 1 {
		defer oc.Close()
		t.Fatalf("precondition: s_late must be tracked and un-seeded, got %v", got)
	}

	// Arm OLD agent A and HOLD the response: the first armed GET is captured
	// (counted), announced via `entered`, and its body write blocks.
	entered, release := h.holdTail("s_late", `[{"info":{"id":"la0","sessionID":"s_late","role":"assistant","agent":"A"}}]`)

	// Cleanup order is LIFO and load-bearing: release() runs FIRST (unblocks
	// the held GET on any assertion-failure path), then the goroutine join,
	// then oc.Close — httptest.Server.Close waits for outstanding requests,
	// so releasing before Close is what keeps failure paths deadlock-free.
	done := make(chan struct{})
	defer oc.Close()
	defer func() { <-done }()
	defer release()

	go func() {
		defer close(done)
		agg.reseedCreatedSessionAgent(context.Background(), "s_late")
	}()

	// The reseed has captured response A: its GET is counted and held
	// pre-body, which also proves it is past the entry loaded/memo guards.
	<-entered

	// Authoritative history B lands in the SAME session while A is held.
	agg.Store().SetSessionMessages("s_late", []state.MessageWithParts{
		{Info: json.RawMessage(`{"id":"lb1","sessionID":"s_late","role":"user"}`)},
		{Info: json.RawMessage(`{"id":"lb2","sessionID":"s_late","role":"assistant","agent":"B"}`)},
	})
	loaded := false
	for _, id := range agg.Store().LoadedSessions() {
		if id == "s_late" {
			loaded = true
		}
	}
	if !loaded {
		t.Fatalf("precondition: s_late must be LOADED after SetSessionMessages")
	}
	if got := agg.Store().Snapshot(nil).LastAgents["s_late"]; got != "B" {
		t.Fatalf("precondition: authoritative load must set lastAgent B, got %q", got)
	}

	// Release the stale response A and join the reseed completion.
	release()
	<-done

	// THE CELL: the authoritative loaded agent B must SURVIVE the late old-A
	// response — A must not clobber it.
	if got := agg.Store().Snapshot(nil).LastAgents["s_late"]; got != "B" {
		t.Fatalf("HAZARD MANIFESTED (third-pass brief O1, loaded-B/late-A cell): late old-agent tail response (agent %q) clobbered the authoritative loaded lastAgent B", got)
	}
	// Exactly ONE tail GET for s_late (the held one): rules out an
	// accidental extra fetch masking or manufacturing the outcome.
	if got, want := h.tailGETs("s_late"), 1; got != want {
		t.Fatalf("exactly one tail GET expected for the held reseed: GETs=%d want %d", got, want)
	}
}

// reseedTailHandler wraps the fixture backend and answers cold-seed TAIL GETs
// (GET /session/:id/message?limit=coldTailLimit) for sids armed in tails with a
// mutable per-sid body (armed-"" → `[]`, the no-assistant-turn tail). Full
// fetches and every other path delegate to the fixture. The tail GET is exactly
// the request reseedCreatedSessionAgent/seedColdLastAgents issue — distinct
// from the full-fetch shape the messages_resident_test.go counters key on.
//
// W5 hold extension: a sid armed via holdTail additionally blocks its first
// captured GET pre-body until released (see holdTail). Sids with no hold gate
// — including every W4-only usage, where holds/entered stay nil — behave
// exactly as before.
type reseedTailHandler struct {
	inner   http.Handler
	mu      sync.Mutex
	count   map[string]int           // sid -> tail-GET count
	tails   map[string]string        // sid -> armed tail body ("" → empty tail)
	holds   map[string]chan struct{} // sid -> hold gate; captured GETs block until closed
	entered map[string]chan struct{} // sid -> closed once on the first HELD capture
}

func (h *reseedTailHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/session/") && strings.HasSuffix(r.URL.Path, "/message") &&
		r.URL.Query().Get("limit") == strconv.Itoa(coldTailLimit) {
		sid := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/session/"), "/message")
		h.mu.Lock()
		body, armed := h.tails[sid]
		var hold, entered chan struct{}
		if armed {
			h.count[sid]++
			if gate, held := h.holds[sid]; held {
				hold = gate
				// Announce exactly once: delete-then-close under the lock.
				if ent, ok := h.entered[sid]; ok {
					delete(h.entered, sid)
					entered = ent
				}
			}
		}
		h.mu.Unlock()
		if armed {
			if entered != nil {
				close(entered)
			}
			if hold != nil {
				<-hold // deterministic rendezvous: body write deferred to the test
			}
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

// holdTail arms sid's tail body and installs a hold gate for the W5
// late-overwrite falsification cell: the first armed tail GET for sid is
// captured (counted under the mutex) and announced by closing the returned
// entered channel, and its response-body write then BLOCKS until the returned
// release func is called — modeling a slow upstream whose old data was
// captured before newer authoritative state landed. release is idempotent
// (safe to call from both the test body and the cleanup defer). After
// release, the closed gate lets any later GET for sid answer immediately.
func (h *reseedTailHandler) holdTail(sid, body string) (entered <-chan struct{}, release func()) {
	ent := make(chan struct{})
	gate := make(chan struct{})
	var once sync.Once
	h.mu.Lock()
	h.tails[sid] = body
	if h.holds == nil {
		h.holds = map[string]chan struct{}{}
	}
	if h.entered == nil {
		h.entered = map[string]chan struct{}{}
	}
	h.holds[sid] = gate
	h.entered[sid] = ent
	h.mu.Unlock()
	return ent, func() { once.Do(func() { close(gate) }) }
}
