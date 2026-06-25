package auth

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func newPassphrase(t *testing.T) *Authenticator {
	t.Helper()
	a, err := New(context.Background(), Config{Mode: ModePassphrase, Passphrase: "hunter2"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	return a
}

func TestCheckBindSafety(t *testing.T) {
	cases := []struct {
		addr    string
		mode    Mode
		wantErr bool
	}{
		{"127.0.0.1:7700", ModeNone, false},  // loopback, no auth → ok (dev)
		{"localhost:7700", ModeNone, false},  // loopback name → ok
		{"[::1]:7700", ModeNone, false},      // ipv6 loopback → ok
		{":8080", ModeNone, true},            // all interfaces, no auth → refuse
		{"0.0.0.0:8080", ModeNone, true},     // explicit any, no auth → refuse
		{"192.168.1.5:8080", ModeNone, true}, // LAN, no auth → refuse
		{":8080", ModePassphrase, false},     // public but auth configured → ok
	}
	for _, c := range cases {
		err := CheckBindSafety(c.addr, Config{Mode: c.mode, Passphrase: "x"})
		if (err != nil) != c.wantErr {
			t.Errorf("CheckBindSafety(%q,%q): err=%v want err=%v", c.addr, c.mode, err, c.wantErr)
		}
	}
}

func TestNewRejectsIncompleteConfig(t *testing.T) {
	cases := []Config{
		{Mode: ModePassphrase}, // no passphrase
		{Mode: ModeTrustProxy}, // no header
		{Mode: ModeOIDC, OIDCClientID: "x", OIDCRedirectURL: "y", AllowedDomains: []string{"z"}}, // no issuer
		{Mode: ModeOIDC, OIDCIssuer: "https://x", OIDCClientID: "x", OIDCRedirectURL: "y"},       // no allow-list
		{Mode: "bogus"}, // unknown mode
	}
	for i, c := range cases {
		if _, err := New(context.Background(), c); err == nil {
			t.Errorf("case %d: New(%+v) should have errored", i, c)
		}
	}
}

func TestEmailAllowed(t *testing.T) {
	a := &Authenticator{cfg: Config{
		AllowedEmails:  []string{"Alice@example.com"},
		AllowedDomains: []string{"Corp.com"},
	}}
	cases := map[string]bool{
		"alice@example.com": true,  // exact (case-insensitive)
		"bob@corp.com":      true,  // domain
		"bob@example.com":   false, // wrong domain, not listed
		"":                  false,
		"no-at-sign":        false,
	}
	for email, want := range cases {
		if got := a.emailAllowed(email); got != want {
			t.Errorf("emailAllowed(%q)=%v want %v", email, got, want)
		}
	}
}

func TestModeNoneIsPassthrough(t *testing.T) {
	a, _ := New(context.Background(), Config{Mode: ModeNone})
	called := false
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called = true }))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/", nil))
	if !called {
		t.Fatal("ModeNone should pass through to the next handler")
	}
}

func TestUnauthenticatedAPIGets401(t *testing.T) {
	a := newPassphrase(t)
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Fatal("handler must not run for an unauthenticated API request")
	}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/vh/snapshot", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("want 401 for unauthenticated /vh/, got %d", rec.Code)
	}
}

func TestUnauthenticatedNavigationRedirects(t *testing.T) {
	a := newPassphrase(t)
	h := a.Middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/some/page", nil))
	if rec.Code != http.StatusSeeOther || rec.Header().Get("Location") != "/auth/login" {
		t.Fatalf("want 303→/auth/login, got %d %q", rec.Code, rec.Header().Get("Location"))
	}
}

func TestHealthzIsPublic(t *testing.T) {
	a := newPassphrase(t)
	ok := false
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/vh/healthz" {
			ok = true
		}
	}))
	h.ServeHTTP(httptest.NewRecorder(), httptest.NewRequest("GET", "/vh/healthz", nil))
	if !ok {
		t.Fatal("/vh/healthz must be reachable without auth")
	}
}

func TestPassphraseLoginFlow(t *testing.T) {
	a := newPassphrase(t)
	protected := false
	h := a.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { protected = true }))

	// Wrong passphrase → login page, no cookie.
	rec := httptest.NewRecorder()
	bad := httptest.NewRequest("POST", "/auth/login", strings.NewReader("passphrase=nope"))
	bad.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	h.ServeHTTP(rec, bad)
	if c := rec.Result().Cookies(); len(c) > 0 && c[0].Value != "" {
		t.Fatal("wrong passphrase must not set a session")
	}

	// Correct passphrase → session cookie + redirect.
	rec = httptest.NewRecorder()
	good := httptest.NewRequest("POST", "/auth/login", strings.NewReader("passphrase=hunter2"))
	good.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	h.ServeHTTP(rec, good)
	if rec.Code != http.StatusSeeOther {
		t.Fatalf("correct login want 303, got %d", rec.Code)
	}
	var session *http.Cookie
	for _, c := range rec.Result().Cookies() {
		if c.Name == "vh_session" && c.Value != "" {
			session = c
		}
	}
	if session == nil {
		t.Fatal("correct login must set vh_session cookie")
	}
	if !session.HttpOnly {
		t.Error("session cookie must be HttpOnly")
	}

	// Reuse the cookie → protected handler runs.
	rec = httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/some/page", nil)
	req.AddCookie(session)
	h.ServeHTTP(rec, req)
	if !protected {
		t.Fatal("authenticated request should reach the protected handler")
	}
}

func TestTrustProxyMode(t *testing.T) {
	a, err := New(context.Background(), Config{Mode: ModeTrustProxy, TrustProxyHeader: "X-Forwarded-Email"})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	ran := 0
	h := a.Middleware(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { ran++ }))

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/", nil)) // no header → blocked
	if ran != 0 {
		t.Fatal("missing identity header must be blocked")
	}
	rec = httptest.NewRecorder()
	req := httptest.NewRequest("GET", "/", nil)
	req.Header.Set("X-Forwarded-Email", "alice@corp.com")
	h.ServeHTTP(rec, req) // header present → allowed
	if ran != 1 {
		t.Fatal("present identity header must be allowed through")
	}
}

func TestSafeRedirect(t *testing.T) {
	host := &Authenticator{cfg: Config{}}                               // host-only
	shared := &Authenticator{cfg: Config{CookieDomain: ".example.com"}} // shared
	r := httptest.NewRequest("GET", "https://app.example.com/", nil)

	cases := []struct {
		a    *Authenticator
		dest string
		want bool
	}{
		{host, "/sessions/123", true},                        // relative path
		{host, "//evil.com/x", false},                        // protocol-relative
		{host, "https://app.example.com/x", true},            // same host
		{host, "https://evil.com/x", false},                  // cross host (host-only)
		{shared, "https://w1.example.com/x", true},           // sibling within shared domain
		{shared, "https://example.com/x", true},              // apex within shared domain
		{shared, "https://evil.com/x", false},                // outside domain
		{shared, "https://notexample.com.evil.com/x", false}, // suffix-trick must fail
		{host, "", false},                                    // empty
	}
	for _, c := range cases {
		if got := c.a.safeRedirect(c.dest, r); got != c.want {
			t.Errorf("safeRedirect(%q)=%v want %v", c.dest, got, c.want)
		}
	}
}

func TestSameOrigin(t *testing.T) {
	if !sameOrigin("https://app.example.com", "app.example.com") {
		t.Error("matching origin/host should be same-origin")
	}
	if sameOrigin("https://evil.com", "app.example.com") {
		t.Error("different host must not be same-origin")
	}
}

func TestAbsURLForwardedProto(t *testing.T) {
	r := httptest.NewRequest("GET", "/p?q=1", nil)
	r.Host = "w1.example.com"
	r.Header.Set("X-Forwarded-Proto", "https")
	if got, want := absURL(r), "https://w1.example.com/p?q=1"; got != want {
		t.Fatalf("absURL=%q want %q", got, want)
	}
}

// guard against url import being dropped if the test evolves
var _ = url.Parse
