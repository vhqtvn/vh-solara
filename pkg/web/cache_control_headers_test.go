package web

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// State-like GET endpoints that return fresh-per-call aggregator data must opt
// out of caching so a dialog re-open (or any other client) never paints stale
// counts. The list below is intentionally narrow: only the endpoints whose
// response body is a live snapshot of mutable daemon state (and which the
// ProjectSwitcher / RestartConfirm flows depend on for cross-project counts).
//
// Endpoints that return immutable data (hashed assets), already-explicit
// cached data (e.g. handleQuota's 45s server-side cache), or per-stream
// snapshots (handled by cursor/epoch on the client) are intentionally NOT in
// this list — adding no-store there would either be a no-op or fight the
// existing cache discipline.
var noStoreGETEndpoints = []string{
	"/vh/projects",
	"/vh/running-sessions",
}

// TestNoStoreOnStateLikeGETs asserts each endpoint in noStoreGETEndpoints emits
// Cache-Control: no-store. Regression guard: without this header, a browser's
// HTTP cache (or an intermediary) could serve a stale response to a subsequent
// identical GET, defeating the dialog-refresh-on-open invariant. The client
// also passes cache:'no-store' on these fetches, but the SERVER header is the
// canonical, client-independent guarantee.
func TestNoStoreOnStateLikeGETs(t *testing.T) {
	for _, path := range noStoreGETEndpoints {
		t.Run(path, func(t *testing.T) {
			srv := newTestServer(t)
			web := httptest.NewServer(srv.Handler())
			t.Cleanup(web.Close)

			resp, err := http.Get(web.URL + path)
			if err != nil {
				t.Fatalf("GET %s: %v", path, err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("GET %s status want 200, got %d", path, resp.StatusCode)
			}
			if got := resp.Header.Get("Cache-Control"); got != "no-store" {
				t.Fatalf("GET %s Cache-Control want \"no-store\", got %q", path, got)
			}
		})
	}
}
