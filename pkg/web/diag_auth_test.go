package web

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/auth"
)

// TestDiagLatencyRouteAuthChainWorker pins the security boundary for the
// worker-edge latency diagnostic route (Finding 8). Mirrors the controller-side
// test in pkg/server/diag_auth_test.go but exercises the pkg/web chain
// (securityHeaders → auth → cors → csrfGuard → … → mux). Proves:
//
//   - an UNAUTHENTICATED GET is rejected (401: /vh/* is an API request path);
//   - an AUTHENTICATED GET returns 200 with a JSON diagnostic snapshot;
//   - an unsafe POST WITHOUT X-VH-CSRF is stopped by csrfGuard (403) — the
//     first line of read-only enforcement on the worker edge;
//   - an unsafe POST WITH X-VH-CSRF still reaches diag.Handler's own method
//     guard and is rejected with 405 — proving the route is read-only at the
//     handler level too (defense in depth);
//   - /vh/healthz remains the ONLY auth exemption on the edge.
//
// This test FAILS if /vh/diag/latency is accidentally mounted outside auth or
// starts accepting mutations.
func TestDiagLatencyRouteAuthChainWorker(t *testing.T) {
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	// Install REAL passphrase auth so Auth.Middleware actually gates — proving
	// the route is reachable only through the authenticated chain rather than a
	// nil/ModeNone no-op pass-through.
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	srv.SetAuth(a)
	h := srv.Handler()

	// Perform the passphrase login flow and return the vh_session cookie.
	session := func() *http.Cookie {
		t.Helper()
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader("passphrase=secret"))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusSeeOther {
			t.Fatalf("login: want 303, got %d (body=%q)", rec.Code, rec.Body.String())
		}
		for _, c := range rec.Result().Cookies() {
			if c.Name == "vh_session" && c.Value != "" {
				return c
			}
		}
		t.Fatal("login: no vh_session cookie set")
		return nil
	}()

	// 1. Unauthenticated GET → rejected (401: /vh/* is an API request path).
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/diag/latency", nil)
	h.ServeHTTP(rec, req)
	if rec.Code == http.StatusOK {
		t.Fatalf("unauthenticated GET /vh/diag/latency: want rejection (not 200), got 200 — route is mounted OUTSIDE auth")
	}
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET /vh/diag/latency: want 401 (API path challenge), got %d", rec.Code)
	}

	// 2. Authenticated GET → 200 JSON snapshot.
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodGet, "/vh/diag/latency", nil)
	req2.AddCookie(session)
	h.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("authenticated GET /vh/diag/latency: want 200, got %d (body=%q)", rec2.Code, rec2.Body.String())
	}
	if ct := rec2.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("authenticated GET /vh/diag/latency: want Content-Type application/json, got %q", ct)
	}
	var snap map[string]any
	if err := json.Unmarshal(rec2.Body.Bytes(), &snap); err != nil {
		t.Fatalf("authenticated GET /vh/diag/latency: body is not valid JSON: %v (body=%q)", err, rec2.Body.String())
	}
	if _, ok := snap["probes"]; !ok {
		t.Fatalf("authenticated GET /vh/diag/latency: JSON missing top-level \"probes\" field (body=%q)", rec2.Body.String())
	}

	// 3a. Unsafe POST WITHOUT X-VH-CSRF → 403 (csrfGuard defense, the first
	// read-only enforcement on the worker edge).
	rec3 := httptest.NewRecorder()
	req3 := httptest.NewRequest(http.MethodPost, "/vh/diag/latency", nil)
	req3.AddCookie(session)
	h.ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusForbidden {
		t.Fatalf("authenticated POST /vh/diag/latency without %s: want 403 (csrfGuard), got %d (body=%q)",
			csrfHeader, rec3.Code, rec3.Body.String())
	}

	// 3b. Unsafe POST WITH X-VH-CSRF → 405 (handler-level method guard). The
	// CSRF header lets the request past csrfGuard so diag.Handler's own
	// GET/HEAD-only check fires — proving read-only enforcement at the handler
	// level too (defense in depth).
	rec4 := httptest.NewRecorder()
	req4 := httptest.NewRequest(http.MethodPost, "/vh/diag/latency", nil)
	req4.AddCookie(session)
	req4.Header.Set(csrfHeader, "1")
	h.ServeHTTP(rec4, req4)
	if rec4.Code != http.StatusMethodNotAllowed {
		t.Fatalf("authenticated POST /vh/diag/latency with %s: want 405 (handler-level GET-only), got %d (body=%q)",
			csrfHeader, rec4.Code, rec4.Body.String())
	}

	// 4. /vh/healthz remains the ONLY auth exemption: a credential-less GET
	// still answers 200.
	rec5 := httptest.NewRecorder()
	req5 := httptest.NewRequest(http.MethodGet, "/vh/healthz", nil)
	h.ServeHTTP(rec5, req5)
	if rec5.Code != http.StatusOK {
		t.Fatalf("GET /vh/healthz without credentials: want 200 (only auth exemption), got %d", rec5.Code)
	}
}
