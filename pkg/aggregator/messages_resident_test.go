package aggregator

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
)

// TestEnsureMessagesRefetchesMissingResidentParts is the behavioral proof of the
// S5 hydration contract fix. It reproduces the daemon's systemic steady state —
// a cold history GET that returns a COMPLETED assistant with NO inline parts (the
// envelope-only schema-drift shape) sets the msgLoaded latch while leaving ZERO
// resident parts — then proves the open path (EnsureMessages) RE-FETCHES and the
// parts actually populate, instead of early-returning on the lying latch.
//
// The contract (DONE-CRITERION): for an opened finished session, resident parts
// must equal the DB parts, gate.messagesLoaded is NEVER true with 0 parts on a
// completed message, and last_assistant_empty reflects the actual content. See
// the state-level pin TestMessagesLoadedDerivedFromResidentParts for the gate
// derivation itself; this test proves the EnsureMessages open path drives the
// re-fetch end-to-end.
func TestEnsureMessagesRefetchesMissingResidentParts(t *testing.T) {
	// schemaDriftHandler serves the FIRST full GET /session/sub/message as a
	// completed assistant with NO inline parts (the lying cold-load shape), then
	// serves the real parts on the next full fetch (the opencode DB has them).
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

	// First open: cold fetch hits the schema-drift shape → msgLoaded=true but the
	// completed assistant has ZERO resident parts (the systemic bug state).
	if err := agg.EnsureMessages(context.Background(), "sub"); err != nil {
		t.Fatalf("EnsureMessages: %v", err)
	}
	if got := h.countOf("sub"); got != 1 {
		t.Fatalf("expected 1 cold fetch, got %d", got)
	}
	// CONTRACT (the fix): despite msgLoaded=true, loaded must be FALSE because the
	// completed assistant has zero resident parts. Before the fix this was true
	// (the lying latch) and the open path below would have early-returned.
	if agg.Store().IsMessagesLoaded("sub") {
		t.Fatalf("IsMessagesLoaded must be false when the completed assistant has 0 resident parts — the latch must not report loaded without parts")
	}
	g := agg.Store().Snapshot(nil).Gate["sub"]
	if g.MessagesLoaded {
		t.Fatalf("gate.messagesLoaded must be false with 0 resident parts on a completed assistant")
	}

	// The open path must RE-FETCH (the latch no longer blocks it) and the DB now
	// serves the real parts → they populate. This is the core behavioral guarantee
	// ("the fix MUST make the DAEMON serve parts").
	if err := agg.EnsureMessages(context.Background(), "sub"); err != nil {
		t.Fatalf("EnsureMessages re-fetch: %v", err)
	}
	if got := h.countOf("sub"); got != 2 {
		t.Fatalf("open path must RE-FETCH when resident parts are missing, got count %d (the latch must not block the parts fetch)", got)
	}
	if !agg.Store().IsMessagesLoaded("sub") {
		t.Fatalf("IsMessagesLoaded must be true once the re-fetch populated resident parts")
	}
	g = agg.Store().Snapshot(nil).Gate["sub"]
	if !g.MessagesLoaded {
		t.Fatalf("gate.messagesLoaded must be true once parts are resident")
	}
	if g.LastAssistantEmpty {
		t.Fatalf("gate.last_assistant_empty must reflect the resident text content, got true")
	}
}

// TestEnsureMessagesAsyncSuppressesLoadedWithoutParts is the Stream-2 behavioral
// pin for the gate↔emit consistency fix (reviewer b-F1). When the ASYNC open
// path's fetch returns a COMPLETED assistant with NO inline parts (the S5
// envelope-only shape), the daemon must NOT emit messages.loaded — the client
// flips messagesLoaded=true on that event, so emitting it would override the
// resident-parts gate and reveal an empty transcript with no in-connection
// recovery. The loaded event fires only once the re-fetch serves real parts.
//
// (TestEnsureMessagesRefetchesMissingResidentParts above covers the SYNC path;
// this covers the async Stream-2 path whose completion contract keys on the
// messages.loaded event.)
func TestEnsureMessagesAsyncSuppressesLoadedWithoutParts(t *testing.T) {
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

	// First async open: schema-drift fetch returns a completed assistant with
	// NO inline parts.
	agg.EnsureMessagesAsync(context.Background(), "sub")
	agg.waitMessagesAsync("sub")
	if got := h.countOf("sub"); got != 1 {
		t.Fatalf("expected 1 async fetch, got %d", got)
	}
	// The gate must be honest: NOT loaded (0 resident parts on a completed msg).
	if agg.Store().IsMessagesLoaded("sub") {
		t.Fatalf("IsMessagesLoaded must be false when the completed assistant has 0 resident parts")
	}
	// And the daemon must NOT have emitted messages.loaded (b-F1): drain the
	// subscriber channel for a brief window and assert no loaded event arrived.
	// (The cold KindMessagesBatch may arrive — that is fine; only the loaded
	// completion event is gated, since that is what flips the client's
	// messagesLoaded.)
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		select {
		case e := <-ch:
			if e.Kind == "messages.loaded" {
				t.Fatalf("messages.loaded must NOT be emitted when the completed assistant has 0 resident parts (gate↔emit divergence b-F1)")
			}
		case <-time.After(20 * time.Millisecond):
		}
	}

	// Second async open: the DB serves the real parts → the re-fetch populates
	// them and the loaded event fires (the gate is now true).
	agg.EnsureMessagesAsync(context.Background(), "sub")
	agg.waitMessagesAsync("sub")
	if got := h.countOf("sub"); got != 2 {
		t.Fatalf("async open path must RE-FETCH when resident parts are missing, got count %d", got)
	}
	if !agg.Store().IsMessagesLoaded("sub") {
		t.Fatalf("IsMessagesLoaded must be true once the re-fetch populated resident parts")
	}
	var sawLoaded bool
	deadline = time.Now().Add(time.Second)
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
		t.Fatalf("messages.loaded must be emitted once resident parts are populated")
	}
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
	if r.Method == http.MethodGet && r.URL.Query().Get("limit") == "" &&
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
			// inline parts — sets the msgLoaded latch, leaves zero resident parts.
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
