package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/auth"
)

// TestHealthzAuthExempt pins the cross-binary liveness contract: a credential-
// less GET /vh/healthz against the controller's edge returns 200 "ok", so the
// /vh/healthz healthcheck works on the controller (the "server" compose service)
// the same way it already works on the worker ("ui-demo"). It rides the same
// Auth.Middleware exemption as pkg/web/server.go (case "/vh/healthz" in
// pkg/auth/auth.go), so a real passphrase-mode gate must still let it through
// pre-login. It also asserts the exemption is SCOPED to /vh/healthz: another
// edge route (/api/workers) is still gated for a credential-less request.
func TestHealthzAuthExempt(t *testing.T) {
	d := NewDaemon(":0", ":0", "")
	// Real passphrase auth so Auth.Middleware actually gates — proving the
	// exemption rather than a ModeNone/nil no-op pass-through.
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a

	h := d.buildRootHandler()

	// No session cookie, no bearer — exactly what a compose healthcheck sends.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/healthz", nil)
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /vh/healthz without credentials: want 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "ok" {
		t.Fatalf("GET /vh/healthz body: want %q, got %q", "ok", rec.Body.String())
	}

	// The exemption must be scoped to /vh/healthz only: a credential-less hit on
	// a non-exempt edge route must NOT reach its handler. (The controller
	// challenges browser-style requests with a login redirect, so any gated
	// status other than 200 satisfies this invariant.)
	gated := httptest.NewRecorder()
	gReq := httptest.NewRequest(http.MethodGet, "/api/workers", nil)
	h.ServeHTTP(gated, gReq)
	if gated.Code == http.StatusOK {
		t.Fatalf("GET /api/workers without credentials should be gated (not 200), got %d", gated.Code)
	}
}

// TestHealthzAuthExemptTrustProxy is the trust-proxy regression for the
// cross-binary liveness contract. Under ModeTrustProxy the gate writes a 401
// the moment it sees a request with no identity header — and before this fix
// that 401 fired BEFORE the (passphrase/OIDC-only) /vh/healthz exemption ran,
// so a credential-less Docker healthcheck against a trust-proxy controller (or
// worker, which rides the same Auth.Middleware) got 401 and was marked
// unhealthy. The exemption now lives at the very top of Auth.Middleware
// (before any mode logic), so /vh/healthz must answer 200 even here. Also
// re-asserts the exemption is scoped: a credential-less /api/workers is still
// gated (401 under trust-proxy — no in-app login to redirect to).
func TestHealthzAuthExemptTrustProxy(t *testing.T) {
	d := NewDaemon(":0", ":0", "")
	// Real trust-proxy auth (gate active) so Auth.Middleware actually gates —
	// proving the exemption rather than a ModeNone/nil no-op pass-through.
	a, err := auth.New(context.Background(), auth.Config{
		Mode:             auth.ModeTrustProxy,
		TrustProxyHeader: "X-Forwarded-User",
	})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a

	h := d.buildRootHandler()

	// No identity header, no cookie — exactly what a compose healthcheck sends.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/healthz", nil)
	h.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("GET /vh/healthz without credentials under trust-proxy: want 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if rec.Body.String() != "ok" {
		t.Fatalf("GET /vh/healthz body: want %q, got %q", "ok", rec.Body.String())
	}

	// Scoping: a credential-less non-healthz edge route must still be gated.
	// Under trust-proxy a missing identity header is a direct 401 (no in-app
	// login to redirect to), so assert 401 specifically — not just "not 200".
	gated := httptest.NewRecorder()
	gReq := httptest.NewRequest(http.MethodGet, "/api/workers", nil)
	h.ServeHTTP(gated, gReq)
	if gated.Code != http.StatusUnauthorized {
		t.Fatalf("GET /api/workers without credentials under trust-proxy: want 401 (exemption must be scoped to /vh/healthz), got %d", gated.Code)
	}
}
