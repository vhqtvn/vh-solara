package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/auth"
)

// loginPassphrase performs the passphrase login flow against h and returns the
// vh_session cookie to replay on subsequent authenticated requests. Mirrors the
// pattern in pkg/auth/auth_test.go (TestPassphraseLoginFlow): POST the form,
// grab the vh_session cookie scs sets on the 303 redirect.
func loginPassphrase(t *testing.T, h http.Handler, passphrase string) *http.Cookie {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader("passphrase="+passphrase))
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
}

// TestCSRFGuardRejectsMutatingWithoutHeader pins the defense-in-depth CSRF
// guard on the controller's browser-facing mutating endpoints: an authenticated
// POST/DELETE under /api/ without the X-VH-CSRF header is rejected with 403,
// mirroring the worker's pkg/web csrfGuard (same header name, same non-empty
// check, same 403, same unsafe-method gating). Uses the same scaffolding as
// healthz_test.go: a real passphrase-mode Authenticator + buildRootHandler.
func TestCSRFGuardRejectsMutatingWithoutHeader(t *testing.T) {
	d := NewDaemon(":0", ":0", "")
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a
	h := d.buildRootHandler()
	session := loginPassphrase(t, h, "secret")

	for _, tc := range []struct {
		name, method, path string
	}{
		{"kill", http.MethodPost, "/api/workers/w1/kill"},
		{"cleanup", http.MethodDelete, "/api/workers"},
	} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(tc.method, tc.path, nil)
		req.AddCookie(session)
		h.ServeHTTP(rec, req)
		if rec.Code != http.StatusForbidden {
			t.Errorf("%s %s without %s header (authenticated): want 403, got %d (body=%q)",
				tc.method, tc.path, csrfHeader, rec.Code, rec.Body.String())
		}
	}
}

// TestCSRFGuardAcceptsMutatingWithHeader confirms the same authenticated
// mutating requests PROCEED past the CSRF check once the header is present.
// They then fail for an unrelated reason (unknown worker → 404; cleanup of an
// empty registry → 200), which is exactly what proves the 403 in the test above
// was the CSRF rejection and not a generic block.
func TestCSRFGuardAcceptsMutatingWithHeader(t *testing.T) {
	d := NewDaemon(":0", ":0", "")
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a
	h := d.buildRootHandler()
	session := loginPassphrase(t, h, "secret")

	// POST /api/workers/{id}/kill WITH header → past CSRF; unknown worker → 404.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/workers/nope/kill", nil)
	req.AddCookie(session)
	req.Header.Set(csrfHeader, "1")
	h.ServeHTTP(rec, req)
	if rec.Code == http.StatusForbidden {
		t.Fatalf("POST kill WITH %s header: should pass CSRF guard, got 403 (body=%q)", csrfHeader, rec.Body.String())
	}

	// DELETE /api/workers WITH header → past CSRF; cleanup is a no-op → 200.
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodDelete, "/api/workers", nil)
	req2.AddCookie(session)
	req2.Header.Set(csrfHeader, "1")
	h.ServeHTTP(rec2, req2)
	if rec2.Code == http.StatusForbidden {
		t.Fatalf("DELETE /api/workers WITH %s header: should pass CSRF guard, got 403 (body=%q)", csrfHeader, rec2.Body.String())
	}
}

// TestCSRFGuardExemptsReads pins that GET endpoints are unaffected: a GET needs
// no X-VH-CSRF header and proceeds to its handler (same invariant the worker's
// csrfGuard gives — only unsafe methods are gated).
func TestCSRFGuardExemptsReads(t *testing.T) {
	d := NewDaemon(":0", ":0", "")
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a
	h := d.buildRootHandler()
	session := loginPassphrase(t, h, "secret")

	// GET /api/workers WITHOUT header → proceeds to handleListWorkers → 200 [].
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/workers", nil)
	req.AddCookie(session)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /api/workers without %s header: want 200 (reads exempt), got %d (body=%q)",
			csrfHeader, rec.Code, rec.Body.String())
	}
}

// TestCSRFGuardInsideAuth confirms the guard sits INSIDE Auth.Middleware (like
// the worker's chain): an UNAUTHENTICATED mutating request without the header is
// challenged by auth (a 303 redirect to /auth/login for a plain /api/* path),
// not by the CSRF guard — so the 403 path is only reachable for authenticated
// sessions. This preserves the existing edge behaviour for unauthenticated
// traffic (the guard is strictly additive defense-in-depth).
func TestCSRFGuardInsideAuth(t *testing.T) {
	d := NewDaemon(":0", ":0", "")
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a
	h := d.buildRootHandler()

	// No session cookie, no header. /api/* is neither /vh/ nor /oc/, so
	// isAPIRequest is false and passphrase mode issues a 303 redirect (not the
	// 401 an API path would get). Either way it must NOT be the CSRF 403.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/workers/w1/kill", nil)
	h.ServeHTTP(rec, req)
	if rec.Code == http.StatusForbidden {
		t.Fatalf("unauthenticated mutating request should be gated by auth (not 403 CSRF), got 403")
	}
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("unauthenticated mutating request: want 303 redirect to login, got %d", rec.Code)
	}
}
