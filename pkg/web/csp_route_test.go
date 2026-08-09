package web

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// TestRouteAwareCSP is the regression test for the host-shell fold's route-aware
// Content-Security-Policy split (DEFER f461094). The fold splits CSP by route:
//
//   - HOST routes (`/`, `/host/*`) get `frame-src http: https:` added so the host
//     shell can embed operator-chosen servers as (possibly cross-origin)
//     <iframe>s — its whole multi-server purpose.
//   - every other route (`/app`, root-level single-server `/assets/*`, `/vh/*`,
//     ...) keeps the STRICT single-server CSP, which has NO frame-src directive
//     at all (so default-src 'self' applies to frames → cross-origin embeds stay
//     blocked).
//
// This is frame-SRC (what WE frame), NOT frame-ANCESTORS (who frames us).
//
// The security INVARIANT the fold preserved — and which this test pins — is that
// frame-ancestors 'self' AND X-Frame-Options: SAMEORIGIN are UNCHANGED on EVERY
// route: the host page at `/` is still NOT embeddable cross-origin by default.
// A future edit that leaks frame-src onto `/app`, drops frame-ancestors, or omits
// X-Frame-Options on any route fails this test.
//
// Both the production-default fold (hostShellAtRoot=true, the NewServer default)
// and the legacy pre-fold mode (hostShellAtRoot=false, the fixture-server
// posture) are covered. The assertions observe the actual header VALUE attached
// to each served route (the outcome), not just that the setter ran.
func TestRouteAwareCSP(t *testing.T) {
	// Injected embed FSes with real assets so every asserted route resolves to a
	// served 200. The CSP is attached by the outermost securityHeaders middleware
	// regardless of status, but asserting against actually-served routes is the
	// meaningful crux: it proves the policy is attached to each REAL route class,
	// not merely that a 404 happens to carry a header.
	dist := fstest.MapFS{
		"index.html":    {Data: []byte("<!doctype html><title>VHSolara</title>")},
		"assets/app.js": {Data: []byte("// single-server app asset")},
	}
	host := fstest.MapFS{
		"index.html":     {Data: []byte("<!doctype html><title>VHSolara · Host</title>")},
		"assets/host.js": {Data: []byte("// host shell asset")},
	}

	// newCSPTestServer mirrors newStaticTestServer (static_test.go) but returns
	// the *Server so the fold switch can be toggled for the legacy-mode table.
	newCSPTestServer := func(t *testing.T) (*Server, *httptest.Server) {
		t.Helper()
		agg := aggregator.New("http://127.0.0.1:1", 100) // not started; static + healthz need no opencode
		srv, err := NewServer(agg, "http://127.0.0.1:1", 1000)
		if err != nil {
			t.Fatal(err)
		}
		srv.staticFS = dist
		// Rebuild the FileServer over the swapped FS so static-asset requests
		// serve from the test FS (handleStatic delegates real-asset paths to
		// srv.static); without this, staticFS and static would disagree.
		srv.static = http.FileServer(http.FS(dist))
		srv.hostFS = host
		srv.hostStatic = http.FileServer(http.FS(host))
		return srv, httptest.NewServer(srv.Handler())
	}

	// headersOf fetches path, drains+closes the body, and returns the CSP and
	// X-Frame-Options header values. statusOK asserts a 200 so the policy is
	// proven attached to a real served route (not a 404 fallback).
	headersOf := func(t *testing.T, ws *httptest.Server, path string) (csp, xfo string) {
		t.Helper()
		resp, err := http.Get(ws.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		_, _ = io.Copy(io.Discard, resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("GET %s: status = %d, want 200 (asserting the CSP on a real served route)", path, resp.StatusCode)
		}
		return resp.Header.Get("Content-Security-Policy"), resp.Header.Get("X-Frame-Options")
	}

	// The fold switch defaults to true in NewServer (production posture: the host
	// shell is the default view at `/`). The fixture server opts out via
	// SetHostShellAtRoot(false); production never toggles it. See server.go
	// hostShellAtRoot field doc + contentSecurityPolicyForPath.
	t.Run("production_default_host_at_root", func(t *testing.T) {
		_, ws := newCSPTestServer(t)
		defer ws.Close()
		// hostShellAtRoot is true by construction; not toggled here.

		cases := []struct {
			name         string
			path         string
			wantFrameSrc bool // CSP contains "frame-src http: https:" (host routes only)
		}{
			// Host routes — the fold ADDS frame-src so the host can embed
			// operator-chosen cross-origin servers.
			{"root_is_host_shell", "/", true},
			{"host_namespaced_asset", "/host/assets/host.js", true},

			// Non-host routes — the STRICT single-server CSP is unchanged.
			// cspDirectives (server.go) has NO frame-src entry at all, so these
			// assert not just "not the host frame-src" but "no frame-src
			// directive whatsoever".
			{"single_server_app_entry", "/app", false},
			{"single_server_root_asset", "/assets/app.js", false},
			{"vh_daemon_endpoint", "/vh/healthz", false},
		}
		for _, tc := range cases {
			tc := tc
			t.Run(tc.name, func(t *testing.T) {
				csp, xfo := headersOf(t, ws, tc.path)

				// Fold crux: frame-src http: https: is present on host routes
				// and ABSENT on every other route.
				hasFrameSrc := strings.Contains(csp, "frame-src http: https:")
				if hasFrameSrc != tc.wantFrameSrc {
					t.Errorf("path %s: frame-src http: https: present=%v, want %v\nCSP: %s",
						tc.path, hasFrameSrc, tc.wantFrameSrc, csp)
				}
				// Stricter than the table for the non-host case: the
				// single-server CSP must carry NO frame-src directive at all
				// (cspDirectives has no frame-src entry). Catches any frame-src
				// variant leaking onto a non-host route.
				if !tc.wantFrameSrc && strings.Contains(csp, "frame-src ") {
					t.Errorf("path %s: strict single-server CSP must have NO frame-src directive\nCSP: %s",
						tc.path, csp)
				}

				// Preserved invariant 1: frame-ancestors 'self' on EVERY route
				// (the fold changed frame-src, NOT who may frame us).
				if !strings.Contains(csp, "frame-ancestors 'self'") {
					t.Errorf("path %s: CSP must contain frame-ancestors 'self' (unchanged invariant)\nCSP: %s",
						tc.path, csp)
				}
				// Preserved invariant 2: X-Frame-Options SAMEORIGIN on EVERY
				// route (defense-in-depth for legacy browsers; only omitted when
				// an operator sets an explicit --frame-ancestors allowlist,
				// which this test does not).
				if xfo != "SAMEORIGIN" {
					t.Errorf("path %s: X-Frame-Options = %q, want SAMEORIGIN (unchanged invariant)",
						tc.path, xfo)
				}
			})
		}
	})

	// Legacy pre-fold mode (the fixture-server / web-e2e posture): the
	// single-server SPA owns `/`, so `/` must get the STRICT single-server CSP
	// (no frame-src). This is the route the fold switch exists to isolate —
	// without it, the web e2e lane (which targets the single-server SPA at `/`)
	// would observe the host's frame-src and the lane's CSP expectations could
	// drift. See server.go SetHostShellAtRoot doc.
	t.Run("legacy_single_server_at_root", func(t *testing.T) {
		srv, ws := newCSPTestServer(t)
		defer ws.Close()
		srv.SetHostShellAtRoot(false) // single-server SPA owns `/` (legacy)

		csp, xfo := headersOf(t, ws, "/")

		// `/` is now the single-server SPA → strict CSP, NO frame-src directive.
		if strings.Contains(csp, "frame-src") {
			t.Errorf("legacy `/` must NOT add frame-src (single-server SPA owns `/`): %s", csp)
		}
		// frame-ancestors invariant still holds in legacy mode.
		if !strings.Contains(csp, "frame-ancestors 'self'") {
			t.Errorf("legacy `/` CSP must still contain frame-ancestors 'self': %s", csp)
		}
		// X-Frame-Options invariant still holds in legacy mode.
		if xfo != "SAMEORIGIN" {
			t.Errorf("legacy `/` X-Frame-Options = %q, want SAMEORIGIN", xfo)
		}
	})
}
