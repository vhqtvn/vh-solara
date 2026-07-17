package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/auth"
)

// TestDiagLatencyRouteAuthChainController pins the security boundary for the
// controller-edge latency diagnostic route (Finding 8). It proves the route is
// reachable only through the authenticated chain and remains read-only:
//
//   - an UNAUTHENTICATED GET is rejected (the /vh/* path is an API request, so
//     passphrase-mode issues a 401, not a login redirect);
//   - an AUTHENTICATED GET returns 200 with a JSON diagnostic snapshot;
//   - an unsafe method (POST) — even authenticated — is rejected with 405
//     (the route is registered GET-only via Go 1.22 method patterns);
//   - the ONLY auth exemption on the edge remains /vh/healthz (cross-checked
//     so an accidental exemption regression on /vh/diag/latency is caught).
//
// This test FAILS if /vh/diag/latency is accidentally mounted outside auth
// (unauth GET would return 200) or if the route starts accepting mutations
// (POST would return something other than 405). It reuses the real-passphrase
// scaffolding from healthz_test.go / csrf_test.go.
func TestDiagLatencyRouteAuthChainController(t *testing.T) {
	d := NewDaemon(":0", ":0", "")
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a
	h := d.buildRootHandler()
	session := loginPassphrase(t, h, "secret")

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

	// 3. Unsafe method (POST) — even authenticated — → 405. The route is
	// registered as `GET /vh/diag/latency`, so Go 1.22's method-aware mux
	// returns 405 for a POST. csrfGuard does not gate /vh/* (only /api/*),
	// so the request reaches the mux and is method-rejected there.
	rec3 := httptest.NewRecorder()
	req3 := httptest.NewRequest(http.MethodPost, "/vh/diag/latency", nil)
	req3.AddCookie(session)
	h.ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusMethodNotAllowed {
		t.Fatalf("authenticated POST /vh/diag/latency: want 405 (GET-only route), got %d (body=%q)", rec3.Code, rec3.Body.String())
	}

	// 4. /vh/healthz remains the ONLY auth exemption: a credential-less GET
	// still answers 200. Cross-checked so a regression that broadens or
	// removes the exemption is caught alongside the diag route test.
	rec4 := httptest.NewRecorder()
	req4 := httptest.NewRequest(http.MethodGet, "/vh/healthz", nil)
	h.ServeHTTP(rec4, req4)
	if rec4.Code != http.StatusOK {
		t.Fatalf("GET /vh/healthz without credentials: want 200 (only auth exemption), got %d", rec4.Code)
	}
}
