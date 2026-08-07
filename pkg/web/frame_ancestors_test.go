package web

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// TestFrameAncestorsCSP verifies the CSP frame-ancestors directive and the
// X-Frame-Options decision reflect the --frame-ancestors allowlist. This is a
// SECURITY BOUNDARY (who may embed the web UI in a cross-origin <iframe>):
//   - the default (flag absent) MUST stay 'self' with no accidental widening;
//   - an explicit allowlist MUST widen frame-ancestors to the operator's list
//     (replacing, not merging, 'self') and MUST drop the legacy X-Frame-Options
//     so the intended cross-origin embed actually works.
//
// The assertions observe the actual header VALUE (outcome), not just that the
// setter ran.
func TestFrameAncestorsCSP(t *testing.T) {
	// newServer builds a Server wired to a fake OpenCode, mirroring
	// TestSecurityHeaders. The returned httptest server is the caller's
	// responsibility (defer Close).
	newServer := func(t *testing.T) (*Server, *httptest.Server) {
		fake := newFake()
		ocSrv := httptest.NewServer(fake.handler())
		t.Cleanup(ocSrv.Close)
		srv, _ := NewServer(aggregator.New(ocSrv.URL, 10), ocSrv.URL, 1000)
		return srv, httptest.NewServer(srv.Handler())
	}

	t.Run("default_is_self_and_xfo_present", func(t *testing.T) {
		_, ws := newServer(t)
		defer ws.Close()

		resp, err := http.Get(ws.URL + "/vh/healthz")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()

		csp := resp.Header.Get("Content-Security-Policy")
		// Default must be exactly the historic secure value.
		if !strings.Contains(csp, "frame-ancestors 'self'") {
			t.Fatalf("default CSP frame-ancestors should be 'self': %q", csp)
		}
		// Defense-in-depth: legacy X-Frame-Options stays SAMEORIGIN at default.
		if got := resp.Header.Get("X-Frame-Options"); got != "SAMEORIGIN" {
			t.Fatalf("default X-Frame-Options want SAMEORIGIN, got %q", got)
		}
	})

	t.Run("explicit_allowlist_replaces_self_and_omits_xfo", func(t *testing.T) {
		srv, ws := newServer(t)
		defer ws.Close()
		srv.SetFrameAncestors([]string{"https://app.my-root-domain"})

		resp, err := http.Get(ws.URL + "/vh/healthz")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()

		csp := resp.Header.Get("Content-Security-Policy")
		// The allowlist origin must be present in frame-ancestors.
		if !strings.Contains(csp, "frame-ancestors https://app.my-root-domain") {
			t.Fatalf("CSP frame-ancestors should list the allowlist origin: %q", csp)
		}
		// 'self' must NOT be implicitly retained — the operator's list replaces
		// it (mirrors --cors-origin semantics; include 'self' explicitly if
		// needed).
		if strings.Contains(csp, "frame-ancestors 'self'") {
			t.Fatalf("explicit allowlist must REPLACE 'self', not merge it: %q", csp)
		}
		// X-Frame-Options must be OMITTED: legacy/superseded by CSP
		// frame-ancestors, and keeping SAMEORIGIN would block the intended
		// embed on browsers that honor XFO.
		if got := resp.Header.Get("X-Frame-Options"); got != "" {
			t.Fatalf("X-Frame-Options should be OMITTED with an explicit allowlist, got %q", got)
		}
	})

	t.Run("multiple_origins_joined_space_separated", func(t *testing.T) {
		srv, ws := newServer(t)
		defer ws.Close()
		// Operator keeps 'self' (for the app's own code-viewer iframe) AND adds
		// the trusted host — the documented usage.
		srv.SetFrameAncestors([]string{"'self'", "https://app.my-root-domain"})

		resp, err := http.Get(ws.URL + "/vh/healthz")
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()

		csp := resp.Header.Get("Content-Security-Policy")
		// CSP source lists are space-separated.
		const want = "frame-ancestors 'self' https://app.my-root-domain"
		if !strings.Contains(csp, want) {
			t.Fatalf("CSP frame-ancestors want %q in %q", want, csp)
		}
		// Explicit allowlist set → XFO still omitted regardless of 'self' entry.
		if got := resp.Header.Get("X-Frame-Options"); got != "" {
			t.Fatalf("X-Frame-Options should be OMITTED with an explicit allowlist, got %q", got)
		}
	})
}
