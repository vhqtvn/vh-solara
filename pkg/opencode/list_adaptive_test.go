package opencode

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
)

// list_adaptive_test.go — listSessionsAdaptive's start-limit hint. Before the
// hint, every fetch re-walked 2000→4000→…, so a 16k-session list cost five
// requests per call; the tree reconcile repeated that per project on a ticker.

// fakeSessionList serves `total` sessions honoring ?limit=, and records every
// requested limit.
type fakeSessionList struct {
	mu     sync.Mutex
	total  int
	limits []int
}

func (f *fakeSessionList) handler(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	f.mu.Lock()
	f.limits = append(f.limits, limit)
	n := f.total
	f.mu.Unlock()
	if limit < n {
		n = limit
	}
	out := make([]map[string]string, n)
	for i := range out {
		out[i] = map[string]string{"id": fmt.Sprintf("ses_%d", i)}
	}
	_ = json.NewEncoder(w).Encode(out)
}

func (f *fakeSessionList) reset(total int) []int {
	f.mu.Lock()
	defer f.mu.Unlock()
	got := f.limits
	f.limits = nil
	f.total = total
	return got
}

func TestListSessionsAdaptive_HintMakesSteadyStateOneCall(t *testing.T) {
	f := &fakeSessionList{total: 16598}
	srv := httptest.NewServer(http.HandlerFunc(f.handler))
	defer srv.Close()
	c := New(srv.URL)
	ctx := context.Background()

	// Cold: no hint yet → the doubling walk, and it must fetch everything.
	got, err := c.ListArchivedSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 16598 {
		t.Fatalf("cold fetch returned %d sessions, want all 16598", len(got))
	}
	if cold := f.reset(16598); len(cold) != 5 {
		t.Fatalf("cold fetch limits = %v, want the 5-step 2000..32000 walk", cold)
	}

	// Warm: the hint covers the known count → exactly one request.
	got, err = c.ListArchivedSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	warm := f.reset(40000)
	if len(warm) != 1 || len(got) != 16598 {
		t.Fatalf("warm fetch: %d requests (limits %v), %d sessions; want 1 request, 16598 sessions", len(warm), warm, len(got))
	}

	// Growth past the hint (16598 → 40000, beyond 2×) still fetches everything,
	// doubling from the hinted start until a page comes back not full.
	got, err = c.ListArchivedSessions(ctx)
	if err != nil {
		t.Fatal(err)
	}
	grow := f.reset(40000)
	if len(got) != 40000 {
		t.Fatalf("after growth fetched %d sessions, want all 40000 (limits %v)", len(got), grow)
	}
	if len(grow) != 2 || grow[0] != 2*16598 {
		t.Errorf("growth limits = %v, want [%d %d]", grow, 2*16598, 4*16598)
	}
}

// Hints are per path format: the live list and the archived list of the same
// client do not share a count.
func TestListSessionsAdaptive_HintIsPerPath(t *testing.T) {
	c := New("http://unused")
	c.setListHint("/session?limit=%d", 900) // 2×900 = 1800 < floor
	c.setListHint("/session?archived=true&limit=%d", 16000)
	if got := c.listStartLimit("/session?limit=%d"); got != sessionPageSize {
		t.Errorf("small live list start = %d, want floor %d", got, sessionPageSize)
	}
	if got := c.listStartLimit("/session?archived=true&limit=%d"); got != 32000 {
		t.Errorf("archived list start = %d, want 32000", got)
	}
	c.setListHint("/x?limit=%d", sessionListMax)
	if got := c.listStartLimit("/x?limit=%d"); got != sessionListMax {
		t.Errorf("start limit must clamp to sessionListMax, got %d", got)
	}
}
