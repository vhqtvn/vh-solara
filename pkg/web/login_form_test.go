package web

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/auth"
)

// TestLoginFormPostAcceptsSameOriginOrigin is the crux regression for the
// browser-broken passphrase login form (F-LOGIN).
//
// Root cause (confirmed): pkg/web served `Referrer-Policy: no-referrer` on every
// response (incl. /auth/login), and under that policy Chromium AND Firefox
// serialize `Origin: null` on a native form-POST navigation; submitPassphrase's
// same-origin guard then rejected it with 403, breaking the rendered login form
// in a real browser. (A JS fetch POST set a real Origin and worked; that hid the
// bug from SPA-driven flows.) The fix changed Referrer-Policy to same-origin,
// which lets the browser send a genuine same-origin Origin while still sending
// NO referrer cross-origin (third-party-leak protection preserved).
//
// This test exercises the real pkg/web chain (securityHeaders -> auth ->
// cors -> csrfGuard -> ... -> mux) and pins three things:
//
//  1. the FIX: a POST carrying a genuine same-origin Origin (what a browser now
//     sends) authenticates -> 303 redirect (the form works).
//  2. the GUARD is NOT weakened: Origin "null" (the old browser failure mode)
//     and a cross-origin Origin are still rejected with 403 (login-CSRF defense
//     intact). The fix is the header, not a guard relaxation.
//  3. the header reaches the login route through the chain: /auth/login carries
//     `Referrer-Policy: same-origin`.
//
// A real browser is not driveable from a Go test, so the browser-internal
// "no-referrer -> Origin: null" fact (the spike at host-web/tests/e2e/
// spike-real-iframe.spec.ts verified it out-of-band for both engines) is taken
// as ground truth; this test verifies the server-side consequence that the fix
// targets.
func TestLoginFormPostAcceptsSameOriginOrigin(t *testing.T) {
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	// Install REAL passphrase auth so auth.Middleware actually gates the POST
	// through submitPassphrase (not a nil/ModeNone pass-through).
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	srv.SetAuth(a)
	h := srv.Handler()

	const host = "app.example.test" // arbitrary; r.Host and Origin are matched against this

	loginReq := func(origin string) *http.Request {
		req := httptest.NewRequest(http.MethodPost, "http://"+host+"/auth/login",
			strings.NewReader("passphrase=secret"))
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		return req
	}

	// 1. THE FIX: a genuine same-origin Origin (what a browser sends now that
	//    the policy is no longer no-referrer) authenticates -> 303.
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, loginReq("http://"+host))
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("same-origin Origin: want 303 (login succeeds), got %d (body=%q)",
			rec.Code, rec.Body.String())
	}
	gotSession := false
	for _, c := range rec.Result().Cookies() {
		if c.Name == "vh_session" && c.Value != "" {
			gotSession = true
		}
	}
	if !gotSession {
		t.Fatal("same-origin Origin login: want vh_session cookie set, got none")
	}

	// 2a. GUARD NOT WEAKENED: Origin "null" (the old failure mode under
	//     no-referrer) is still rejected -> 403.
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, loginReq("null"))
	if rec2.Code != http.StatusForbidden {
		t.Fatalf(`Origin "null": want 403 (login-CSRF guard must reject), got %d`, rec2.Code)
	}

	// 2b. GUARD NOT WEAKENED: a cross-origin Origin is rejected -> 403.
	rec3 := httptest.NewRecorder()
	h.ServeHTTP(rec3, loginReq("https://evil.example.test"))
	if rec3.Code != http.StatusForbidden {
		t.Fatalf("cross-origin Origin: want 403 (login-CSRF guard must reject), got %d", rec3.Code)
	}

	// 3. HEADER reaches /auth/login through the chain (this is the actual fix
	//    site: a browser only sends a real Origin when this is NOT no-referrer).
	rec4 := httptest.NewRecorder()
	h.ServeHTTP(rec4, httptest.NewRequest(http.MethodGet, "http://"+host+"/auth/login", nil))
	if got := rec4.Result().Header.Get("Referrer-Policy"); got != "same-origin" {
		t.Fatalf("/auth/login Referrer-Policy: want same-origin, got %q", got)
	}
}
