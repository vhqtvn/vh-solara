package auth

import (
	"crypto/rand"
	"encoding/base64"
	"html"
	"net/http"
	"net/url"
	"strings"

	"golang.org/x/oauth2"
)

const sessVerifierKey = "pkce" // OIDC PKCE verifier, valid only across the redirect

// handleLogin starts the login flow. OIDC: redirect to the provider. Passphrase:
// serve the form on GET, verify on POST.
func (a *Authenticator) handleLogin(w http.ResponseWriter, r *http.Request) {
	switch a.cfg.Mode {
	case ModeOIDC:
		a.startOIDC(w, r)
	case ModePassphrase:
		if r.Method == http.MethodPost {
			a.submitPassphrase(w, r)
			return
		}
		a.serveLoginPage(w, "")
	default:
		http.NotFound(w, r)
	}
}

func (a *Authenticator) startOIDC(w http.ResponseWriter, r *http.Request) {
	state, err := randToken()
	if err != nil {
		// The system CSPRNG is unavailable: do NOT fall back to a weak token — a
		// predictable OAuth state would defeat the CSRF check in handleCallback.
		http.Error(w, "could not generate secure OAuth state token", http.StatusInternalServerError)
		return
	}
	verifier := oauth2.GenerateVerifier()
	a.sessions.Put(r.Context(), sessStateKey, state)
	a.sessions.Put(r.Context(), sessVerifierKey, verifier)
	url := a.oauth.AuthCodeURL(state, oauth2.S256ChallengeOption(verifier))
	http.Redirect(w, r, url, http.StatusSeeOther)
}

func (a *Authenticator) handleCallback(w http.ResponseWriter, r *http.Request) {
	if a.cfg.Mode != ModeOIDC {
		http.NotFound(w, r)
		return
	}
	if errParam := r.URL.Query().Get("error"); errParam != "" {
		a.serveLoginPage(w, "Sign-in was cancelled or failed: "+errParam)
		return
	}
	// Anti-CSRF: the state we stored before redirecting must come back verbatim.
	want := a.sessions.PopString(r.Context(), sessStateKey)
	verifier := a.sessions.PopString(r.Context(), sessVerifierKey)
	if want == "" || r.URL.Query().Get("state") != want {
		http.Error(w, "invalid OAuth state", http.StatusBadRequest)
		return
	}

	oauth2Token, err := a.oauth.Exchange(r.Context(), r.URL.Query().Get("code"), oauth2.VerifierOption(verifier))
	if err != nil {
		http.Error(w, "token exchange failed", http.StatusBadGateway)
		return
	}
	rawID, ok := oauth2Token.Extra("id_token").(string)
	if !ok {
		http.Error(w, "no id_token in response", http.StatusBadGateway)
		return
	}
	idToken, err := a.verifier.Verify(r.Context(), rawID)
	if err != nil {
		http.Error(w, "id_token verification failed", http.StatusBadGateway)
		return
	}
	var claims struct {
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
	}
	if err := idToken.Claims(&claims); err != nil {
		http.Error(w, "could not parse id_token claims", http.StatusBadGateway)
		return
	}
	if !a.emailAllowed(claims.Email) {
		a.serveLoginPage(w, "Account "+html.EscapeString(claims.Email)+" is not allowed.")
		return
	}
	// Opt-in verified-email gate (mirrors grantOIDC): when enabled, an identity
	// that passed the allow-list is still denied unless the provider asserts the
	// email is verified. Default off preserves historical behaviour.
	if a.cfg.RequireVerifiedEmail && !claims.EmailVerified {
		a.serveLoginPage(w, "Account "+html.EscapeString(claims.Email)+" email is not verified by the provider.")
		return
	}

	// New session ID on privilege change (prevents session fixation).
	_ = a.sessions.RenewToken(r.Context())
	a.sessions.Put(r.Context(), sessUserKey, claims.Email)
	http.Redirect(w, r, a.popNext(r), http.StatusSeeOther)
}

func (a *Authenticator) submitPassphrase(w http.ResponseWriter, r *http.Request) {
	// Same-origin guard on the login POST: a cross-site form post carries an Origin
	// that won't match Host. (Login-CSRF on a single shared passphrase is low-risk,
	// but this closes it cheaply.)
	if o := r.Header.Get("Origin"); o != "" && !sameOrigin(o, r.Host) {
		http.Error(w, "cross-origin login blocked", http.StatusForbidden)
		return
	}
	if err := r.ParseForm(); err != nil {
		a.serveLoginPage(w, "Bad request.")
		return
	}
	if !a.checkPassphrase(r.PostFormValue("passphrase")) {
		a.serveLoginPage(w, "Incorrect passphrase.")
		return
	}
	_ = a.sessions.RenewToken(r.Context())
	a.sessions.Put(r.Context(), sessUserKey, "passphrase")
	http.Redirect(w, r, a.popNext(r), http.StatusSeeOther)
}

func (a *Authenticator) handleLogout(w http.ResponseWriter, r *http.Request) {
	_ = a.sessions.Destroy(r.Context())
	http.Redirect(w, r, "/auth/login", http.StatusSeeOther)
}

// popNext returns the stored post-login destination, defaulting to "/" and
// rejecting anything that fails the open-redirect guard.
func (a *Authenticator) popNext(r *http.Request) string {
	next := a.sessions.PopString(r.Context(), sessNextKey)
	if a.safeRedirect(next, r) {
		return next
	}
	return "/"
}

// safeRedirect is the open-redirect guard. A relative path ("/...", not "//") is
// always fine. An absolute URL is allowed only if its host is in scope: equal to
// the request host, or — when a shared cookie domain is configured — within that
// domain (so login on the auth origin can return to a sibling worker subdomain).
func (a *Authenticator) safeRedirect(dest string, r *http.Request) bool {
	if dest == "" {
		return false
	}
	if strings.HasPrefix(dest, "/") {
		return !strings.HasPrefix(dest, "//") // "//evil.com" is protocol-relative, reject
	}
	u, err := url.Parse(dest)
	if err != nil || u.Host == "" {
		return false
	}
	if d := a.cfg.CookieDomain; d != "" {
		bare := strings.TrimPrefix(d, ".")
		host := u.Hostname()
		return host == bare || strings.HasSuffix(host, "."+bare)
	}
	return strings.EqualFold(u.Host, r.Host)
}

// absURL reconstructs the absolute URL of a request (scheme from TLS or the
// X-Forwarded-Proto a trusted proxy may set).
func absURL(r *http.Request) string {
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if xf := r.Header.Get("X-Forwarded-Proto"); xf != "" {
		scheme = xf
	}
	return scheme + "://" + r.Host + r.URL.RequestURI()
}

func (a *Authenticator) serveLoginPage(w http.ResponseWriter, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	var note string
	if msg != "" {
		note = `<p class="err">` + html.EscapeString(msg) + `</p>`
	}
	_, _ = w.Write([]byte(`<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in · VHSolara</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;background:#0b0f19;color:#f3f4f6;
       display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  form{background:#151b2b;border:1px solid #232d42;border-radius:16px;padding:2rem;width:300px}
  h1{font-size:1.1rem;margin:0 0 1rem}
  input{width:100%;box-sizing:border-box;padding:.6rem;border-radius:8px;border:1px solid #232d42;
        background:#0b0f19;color:#f3f4f6;margin-bottom:1rem}
  button{width:100%;padding:.6rem;border:0;border-radius:8px;background:#3b82f6;color:#fff;
         font-weight:600;cursor:pointer}
  .err{color:#ef4444;font-size:.85rem;margin:0 0 1rem}
</style></head><body>
<form method="post" action="/auth/login">
  <h1>Sign in to VHSolara</h1>` + note + `
  <input type="password" name="passphrase" placeholder="Passphrase" autofocus autocomplete="current-password">
  <button type="submit">Sign in</button>
</form></body></html>`))
}

// randToken returns a URL-safe 256-bit random string for the OAuth state. A
// non-nil error means the system CSPRNG is unavailable; callers MUST propagate
// it and must not fall back to a weak token (a predictable OAuth state defeats
// the anti-CSRF check in handleCallback).
func randToken() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// sameOrigin reports whether an Origin header's host matches the request Host.
func sameOrigin(origin, host string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return strings.EqualFold(u.Host, host)
}
