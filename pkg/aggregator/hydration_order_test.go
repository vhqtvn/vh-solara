package aggregator

// Regression test for the transcript "missing middle" bug at the REAL seam:
// the daemon's own fetch sequence against an opencode-shaped HTTP backend.
//
//   1. bounded cold load — EnsureMessages → client.MessagesTail(?limit=N),
//      resident = newest N only;
//   2. OpenCode event-stream RECONNECT — hydrate() → client.Messages (no
//      limit, FULL history) for every loaded session → store.Hydrate →
//      reconcileMessagesLocked;
//   3. live message.updated append (newest).
//
// Pre-fix, step 2 blind-appended every non-resident (OLDER) fetched id to the
// END of sm.order, so the served /vh/snapshot window showed an old block
// followed by live messages with the true recent middle unreachable (observed
// live on ses_0aad61b2bffeVy4HNWjnI0dr1A, 834 msgs). Post-fix the window/page
// projections must equal the true chronological newest messages.

import (
	"context"
	"encoding/json"
	"fmt"
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

// twoShapeMessageHandler serves session `sid`'s message listing in both fetch
// shapes the daemon issues:
//   - GET /session/{sid}/message?limit=N (MessagesTail — the bounded cold
//     load): the NEWEST N rows;
//   - GET /session/{sid}/message (Messages — the full-history hydrate fetch):
//     ALL rows.
//
// Every other path/session delegates to the stock fixture backend. Rows are
// pre-marshaled JSON message-with-parts, chronological oldest-first, each
// carrying a DISTINCT time.created (odd rows are completed assistants so the
// messages-loaded gate has a resident newest assistant).
type twoShapeMessageHandler struct {
	inner http.Handler
	sid   string
	rows  []string

	mu          sync.Mutex
	fullFetches int
}

func (h *twoShapeMessageHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/session/") && strings.HasSuffix(r.URL.Path, "/message") {
		sid := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/session/"), "/message")
		if sid == h.sid {
			rows := h.rows
			if lim := r.URL.Query().Get("limit"); lim != "" {
				if n, err := strconv.Atoi(lim); err == nil && n > 0 && n < len(rows) {
					rows = rows[len(rows)-n:]
				}
			} else {
				h.mu.Lock()
				h.fullFetches++
				h.mu.Unlock()
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte("[" + strings.Join(rows, ",") + "]"))
			return
		}
	}
	h.inner.ServeHTTP(w, r)
}

func (h *twoShapeMessageHandler) fullFetchCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.fullFetches
}

// createdOf extracts info.time.created from a message info blob.
func createdOf(t *testing.T, info json.RawMessage) float64 {
	t.Helper()
	var env struct {
		Time struct {
			Created *float64 `json:"created"`
		} `json:"time"`
	}
	if err := json.Unmarshal(info, &env); err != nil || env.Time.Created == nil {
		t.Fatalf("createdOf: bad info blob %s", info)
	}
	return *env.Time.Created
}

// TestReconnectHydrateAfterBoundedColdLoadKeepsTrueNewestWindow is the
// end-to-end regression: bounded cold load → reconnect full-history hydrate →
// live append. The served window and the historical page must be the TRUE
// chronological newest messages.
func TestReconnectHydrateAfterBoundedColdLoadKeepsTrueNewestWindow(t *testing.T) {
	total := state.WindowMaxCount + 50 // > WindowMaxCount → bounded cold load is a strict tail
	const baseMs = 1_786_000_000_000

	rows := make([]string, total)
	for i := 0; i < total; i++ {
		id := fmt.Sprintf("m%d", i+1)
		created := baseMs + int64(i)*1000
		if i%2 == 1 {
			rows[i] = fmt.Sprintf(`{"info":{"id":%q,"sessionID":"sub","role":"assistant","agent":"build","time":{"created":%d,"completed":%d},"finish":"stop"},"parts":[{"id":%q,"type":"text","text":"x"}]}`,
				id, created, created+500, id+"-p0")
		} else {
			rows[i] = fmt.Sprintf(`{"info":{"id":%q,"sessionID":"sub","role":"user","time":{"created":%d}},"parts":[{"id":%q,"type":"text","text":"x"}]}`,
				id, created, id+"-p0")
		}
	}

	h := &twoShapeMessageHandler{inner: fixtures.New().Handler(), sid: "sub", rows: rows}
	oc := httptest.NewServer(h)
	defer oc.Close()

	agg := New(oc.URL, 256)
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate #1 (sessions): %v", err)
	}
	agg.waitColdSeed()

	// 1. Bounded cold load (the first-open /vh/snapshot path): the tail fetch
	//    (?limit=WindowMaxCount) residents only m51..m150.
	if err := agg.EnsureMessages(context.Background(), "sub"); err != nil {
		t.Fatalf("EnsureMessages: %v", err)
	}
	if !agg.Store().IsMessagesLoaded("sub") {
		t.Fatal("IsMessagesLoaded: want true after the bounded cold load")
	}

	// 2. RECONNECT (the OpenCode event-stream drop path): hydrate refetches
	//    the FULL history (no limit param) for every loaded session.
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate #2 (reconnect): %v", err)
	}
	if got := h.fullFetchCount(); got < 1 {
		t.Fatalf("reconnect must issue a full-history fetch for the loaded session, got %d", got)
	}

	// 3. Live append: a message newer than everything fetched.
	liveMs := baseMs + int64(total)*1000
	live := fmt.Sprintf(`{"info":{"id":"mLive","sessionID":"sub","role":"user","time":{"created":%d}}}`, liveMs)
	agg.Store().Apply(opencode.Event{Type: "message.updated", Properties: json.RawMessage(live)})

	// The served /vh/snapshot window must be the TRUE newest WindowMaxCount:
	// m52..m150 + mLive, oldest-first, chronological by time.created.
	win := agg.Store().Snapshot(map[string]bool{"sub": true}).Messages["sub"]
	if len(win) != state.WindowMaxCount {
		t.Fatalf("window count: want %d, got %d", state.WindowMaxCount, len(win))
	}
	var winIDs []string
	for _, m := range win {
		var env struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(m.Info, &env); err != nil || env.ID == "" {
			t.Fatalf("window item with unreadable id: %s", m.Info)
		}
		winIDs = append(winIDs, env.ID)
	}
	if wantFirst, wantLast := "m52", "mLive"; winIDs[0] != wantFirst || winIDs[len(winIDs)-1] != wantLast {
		t.Fatalf("window span: want [%s..%s], got [%s..%s] (missing-middle corruption)", wantFirst, wantLast, winIDs[0], winIDs[len(winIDs)-1])
	}
	for i := 1; i < len(win); i++ {
		if prev, cur := createdOf(t, win[i-1].Info), createdOf(t, win[i].Info); prev > cur {
			t.Fatalf("window not chronological at [%d]: created %v then %v", i, prev, cur)
		}
	}

	// The historical page anchored mid-transcript (m120 is inside the fetched
	// older block that pre-fix was parked AFTER the tail) must return the
	// TRUE strictly-older run: m91..m120 (limit 30, overlap-inclusive).
	page := agg.Store().SnapshotMessagesPage("sub", "m120", 30, 1<<20)
	if !page.BoundaryFound {
		t.Fatal("page boundary_found: want true (m120 resident after full hydrate)")
	}
	var pageIDs []string
	for _, m := range page.Items {
		var env struct {
			ID string `json:"id"`
		}
		if err := json.Unmarshal(m.Info, &env); err != nil || env.ID == "" {
			t.Fatalf("page item with unreadable id: %s", m.Info)
		}
		pageIDs = append(pageIDs, env.ID)
	}
	wantPage := make([]string, 0, 30)
	for i := 91; i <= 120; i++ {
		wantPage = append(wantPage, fmt.Sprintf("m%d", i))
	}
	if len(pageIDs) != len(wantPage) {
		t.Fatalf("page len: want %d, got %d (%v)", len(wantPage), len(pageIDs), pageIDs)
	}
	for i := range wantPage {
		if pageIDs[i] != wantPage[i] {
			t.Fatalf("page before=m120: want %v.., got %v.. (first diff at %d)", wantPage[:3], pageIDs[:3], i)
		}
	}
}
