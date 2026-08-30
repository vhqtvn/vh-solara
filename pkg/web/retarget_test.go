package web

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// markerUpstream builds an httptest upstream that stamps every response with
// a per-instance marker — so a proxied response body identifies WHICH upstream
// actually served it (outcome evidence, not field inspection).
func markerUpstream(t *testing.T, marker string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, "upstream:%s", marker)
	}))
	t.Cleanup(srv.Close)
	return srv
}

// proxiedBody fetches path through the RUNNING server's /oc passthrough and
// returns the response body — the same route a browser/UI hits.
func proxiedBody(t *testing.T, ts *httptest.Server, path string) (int, string) {
	t.Helper()
	res, err := http.Get(ts.URL + path)
	if err != nil {
		t.Fatalf("GET %s through the running server: %v", path, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

// TestRetargetOpenCodeReRoutesRunningServer — P1-API-003: RetargetOpenCode
// must make the RUNNING server serve through the new port immediately:
//
//   - the /oc/* reverse proxy (whose director captured the parsed old target
//     at construction — the hard capture) re-routes to the new upstream;
//   - every LIVE aggregator (default "" and already-created per-directory
//     ones) gets its client re-targeted;
//   - per-directory aggregators created LAZILY afterwards inherit the new
//     URL (aggFor builds them from the recorded s.opencodeURL);
//   - the rebuilt proxy keeps its configuration: the ErrorHandler still
//     turns a dead upstream into a logged 502 (FlushInterval is structural —
//     same builder — and not directly observable here).
func TestRetargetOpenCodeReRoutesRunningServer(t *testing.T) {
	oldUp := markerUpstream(t, "old")
	newUp := markerUpstream(t, "new")

	agg := aggregator.New(oldUp.URL, 64)
	srv, err := NewServer(agg, oldUp.URL, 64)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	// A per-directory aggregator created BEFORE the retarget (the "every
	// live aggregator" half) and one created AFTER (the lazy-inheritance
	// half). aggFor is the same lazy path a ?dir= request drives.
	early := srv.aggFor(t.TempDir())
	if got := early.Client().BaseURL(); got != oldUp.URL {
		t.Fatalf("early per-dir aggregator built against %q, want the original target %q", got, oldUp.URL)
	}

	// Pre-check: the running proxy serves the OLD upstream (proves the
	// post-retarget body below is a routing CHANGE, not a coincidence).
	if code, body := proxiedBody(t, ts, "/oc/probe"); code != 200 || body != "upstream:old" {
		t.Fatalf("pre-retarget /oc/probe = %d/%q, want 200/upstream:old", code, body)
	}
	if got := srv.agg.Client().BaseURL(); got != oldUp.URL {
		t.Fatalf("default aggregator target %q before retarget, want %q", got, oldUp.URL)
	}

	srv.RetargetOpenCode(newUp.URL)

	// CRUX (outcome-level): a request through the STILL-RUNNING server now
	// reaches the NEW upstream — identified by the marker only it serves.
	if code, body := proxiedBody(t, ts, "/oc/probe"); code != 200 || body != "upstream:new" {
		t.Fatalf("post-retarget /oc/probe = %d/%q, want 200/upstream:new (the running server must serve through the new port)", code, body)
	}

	// Every live aggregator's client follows: the default and the
	// pre-existing per-dir one.
	if got := srv.agg.Client().BaseURL(); got != newUp.URL {
		t.Fatalf("default aggregator target after retarget = %q, want %q", got, newUp.URL)
	}
	if got := early.Client().BaseURL(); got != newUp.URL {
		t.Fatalf("pre-existing per-dir aggregator target after retarget = %q, want %q", got, newUp.URL)
	}

	// Lazy creation inherits the new URL (s.opencodeURL was re-recorded).
	late := srv.aggFor(t.TempDir())
	if got := late.Client().BaseURL(); got != newUp.URL {
		t.Fatalf("lazily-created per-dir aggregator target = %q, want the retargeted %q", got, newUp.URL)
	}

	// The rebuilt proxy keeps its ErrorHandler config: retargeted at a dead
	// port, a passthrough request surfaces the logged 502 shape (not a bare
	// hijacked connection or a panic).
	dead := markerUpstream(t, "dead")
	deadURL := dead.URL
	dead.Close() // unreachable now; Close is idempotent with the cleanup above

	srv.RetargetOpenCode(deadURL)
	if code, body := proxiedBody(t, ts, "/oc/probe"); code != http.StatusBadGateway || !strings.HasPrefix(body, "upstream error:") {
		t.Fatalf("/oc/probe against a dead upstream = %d/%q, want 502 with the ErrorHandler's body (proxy config must survive the rebuild)", code, body)
	}
}
