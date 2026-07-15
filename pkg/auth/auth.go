// Package auth is the secure-by-default login layer for published deployments
// (see docs/architecture/06-auth.md). It is the only place in the repo that imports an
// auth library; the rest of the codebase wraps its handler with one Middleware.
//
// Three modes, all funnelled through one server-side session (scs): OIDC SSO
// (recommended), a shared passphrase (fallback), and trust-proxy (opt-in, for an
// operator running their own forward-auth). The single most important behaviour
// is fail-closed: CheckBindSafety refuses a public bind with no auth configured.
package auth

import (
	"context"
	"crypto/subtle"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/alexedwards/scs/v2"
	"github.com/coreos/go-oidc/v3/oidc"
	"golang.org/x/oauth2"
)

// Mode selects the authentication method.
type Mode string

const (
	ModeNone       Mode = "none"        // no auth — permitted on a loopback bind only
	ModeOIDC       Mode = "oidc"        // delegate to an OIDC provider
	ModePassphrase Mode = "passphrase"  // single shared passphrase
	ModeTrustProxy Mode = "trust-proxy" // trust an identity header set by a fronting proxy
)

// Config is the operator-facing auth configuration (wired from CLI flags / env).
type Config struct {
	Mode Mode

	// OIDC
	OIDCIssuer       string
	OIDCClientID     string
	OIDCClientSecret string
	OIDCRedirectURL  string // absolute URL of /auth/callback on the fixed auth origin
	AllowedEmails    []string
	AllowedDomains   []string

	// Passphrase
	Passphrase string

	// TrustProxy: the header a fronting proxy sets with the authenticated user.
	// Only honoured because the app is expected to be bound private in this mode.
	TrustProxyHeader string

	// Cookie scope. Empty Domain → host-only (correct for a single-host install);
	// ".example.com" → shared across every <id>.example.com worker (one login,
	// SSO across workers). Secure should be true whenever traffic is TLS.
	CookieDomain string
	Secure       bool

	// RequireVerifiedEmail (oidc, opt-in): when true, an identity whose email
	// passes the allow-list is still denied unless the OIDC provider asserts
	// email_verified. Default false preserves historical behaviour (allow-list
	// alone grants a session). See grantOIDC / handleCallback.
	RequireVerifiedEmail bool
}

// Authenticator holds the live auth state: the session manager and, for OIDC,
// the verified provider/oauth2 config.
type Authenticator struct {
	cfg      Config
	sessions *scs.SessionManager

	oauth    *oauth2.Config
	verifier *oidc.IDTokenVerifier
}

const (
	sessUserKey  = "user"  // authenticated identity (email / "passphrase")
	sessStateKey = "state" // OIDC anti-CSRF state, valid only across the redirect
	sessNextKey  = "next"  // post-login destination
)

// New validates cfg and builds the Authenticator. For OIDC it performs provider
// discovery (a network call), so it takes a context.
func New(ctx context.Context, cfg Config) (*Authenticator, error) {
	a := &Authenticator{cfg: cfg}

	// Only the session-backed modes need a session manager; trust-proxy carries
	// identity on every request and ModeNone is a passthrough.
	if cfg.Mode == ModeOIDC || cfg.Mode == ModePassphrase {
		sm := scs.New()
		sm.Lifetime = 7 * 24 * time.Hour
		sm.IdleTimeout = 24 * time.Hour
		sm.Cookie.Name = "vh_session"
		sm.Cookie.Path = "/"
		sm.Cookie.Domain = cfg.CookieDomain // empty → host-only
		sm.Cookie.HttpOnly = true           // XSS cannot read the session token
		sm.Cookie.Secure = cfg.Secure
		sm.Cookie.SameSite = http.SameSiteLaxMode
		a.sessions = sm
	}

	switch cfg.Mode {
	case ModeNone:
		// nothing to configure
	case ModePassphrase:
		if cfg.Passphrase == "" {
			return nil, fmt.Errorf("auth: passphrase mode requires a passphrase")
		}
	case ModeTrustProxy:
		if cfg.TrustProxyHeader == "" {
			return nil, fmt.Errorf("auth: trust-proxy mode requires a header name")
		}
	case ModeOIDC:
		if cfg.OIDCIssuer == "" || cfg.OIDCClientID == "" || cfg.OIDCRedirectURL == "" {
			return nil, fmt.Errorf("auth: oidc mode requires issuer, client-id and redirect-url")
		}
		if len(cfg.AllowedEmails) == 0 && len(cfg.AllowedDomains) == 0 {
			return nil, fmt.Errorf("auth: oidc mode requires an allowed-emails or allowed-domains list (refusing to allow any Google/etc. account)")
		}
		provider, err := oidc.NewProvider(ctx, cfg.OIDCIssuer)
		if err != nil {
			return nil, fmt.Errorf("auth: oidc discovery failed for %q: %w", cfg.OIDCIssuer, err)
		}
		a.verifier = provider.Verifier(&oidc.Config{ClientID: cfg.OIDCClientID})
		a.oauth = &oauth2.Config{
			ClientID:     cfg.OIDCClientID,
			ClientSecret: cfg.OIDCClientSecret,
			Endpoint:     provider.Endpoint(),
			RedirectURL:  cfg.OIDCRedirectURL,
			Scopes:       []string{oidc.ScopeOpenID, "email"},
		}
	default:
		return nil, fmt.Errorf("auth: unknown mode %q", cfg.Mode)
	}
	return a, nil
}

// Middleware wraps next with session loading, the /auth/* routes, the gate, and
// the cross-binary /vh/healthz liveness exemption. In ModeNone it is a
// passthrough. It is meant to be the outermost wrapper of the served handler so
// an unauthenticated request never reaches application code.
func (a *Authenticator) Middleware(next http.Handler) http.Handler {
	if a == nil || a.cfg.Mode == ModeNone {
		return next
	}

	// modeGate is the mode-specific auth gate. It is written assuming every
	// request needs real auth — the /vh/healthz liveness exemption is applied
	// uniformly at the very top of the returned handler (below) so modeGate
	// never sees a /vh/healthz request.
	var modeGate http.Handler
	if a.cfg.Mode == ModeTrustProxy {
		// No session needed: identity is the proxy-set header on every request.
		// A missing header means the fronting proxy didn't authenticate this
		// request — 401 directly (there is no in-app login to redirect to).
		modeGate = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get(a.cfg.TrustProxyHeader) != "" {
				next.ServeHTTP(w, r)
				return
			}
			http.Error(w, "authentication required (proxy did not provide identity)", http.StatusUnauthorized)
		})
	} else {
		// passphrase / oidc: session-backed gate plus the /auth/* routes.
		gated := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			switch r.URL.Path {
			case "/auth/login":
				a.handleLogin(w, r)
				return
			case "/auth/callback":
				a.handleCallback(w, r)
				return
			case "/auth/logout":
				a.handleLogout(w, r)
				return
			}
			if a.sessions.GetString(r.Context(), sessUserKey) != "" {
				next.ServeHTTP(w, r)
				return
			}
			a.challenge(w, r)
		})
		modeGate = a.sessions.LoadAndSave(gated)
	}

	// /vh/healthz is the cross-binary liveness contract served by BOTH the
	// controller (pkg/server) and the worker (pkg/web). It must answer 200
	// with NO credentials under EVERY gated mode (passphrase, oidc,
	// trust-proxy): a Docker/compose healthcheck sends no cookie/bearer/
	// identity header, and a 401 there marks a healthy binary unhealthy (the
	// latent trust-proxy gap — the missing-header 401 below fired before the
	// old passphrase/OIDC-only exemption could run). Exempt it as the very
	// first check, before any mode logic, so no mode-specific 401 or challenge
	// can fire on it. Exact-path match: both binaries register /vh/healthz
	// verbatim with no sub-paths, so a string-equal comparison is both
	// necessary and sufficient.
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/vh/healthz" {
			next.ServeHTTP(w, r)
			return
		}
		modeGate.ServeHTTP(w, r)
	})
}

// challenge rejects an unauthenticated request: a 401 for API/XHR callers (so the
// SPA's fetches fail cleanly), a redirect to /auth/login for a page navigation.
func (a *Authenticator) challenge(w http.ResponseWriter, r *http.Request) {
	if isAPIRequest(r) {
		http.Error(w, "authentication required", http.StatusUnauthorized)
		return
	}
	// Remember where the user was headed so login can return them there. We store
	// the absolute URL (not just the path) because under a shared cookie the OIDC
	// callback lands on the fixed auth origin and must redirect back to the worker
	// subdomain the user actually wanted.
	if a.sessions != nil && r.Method == http.MethodGet {
		a.sessions.Put(r.Context(), sessNextKey, absURL(r))
	}
	http.Redirect(w, r, "/auth/login", http.StatusSeeOther)
}

// isAPIRequest reports whether a failed-auth response should be a 401 rather than
// a login redirect: the protocol/proxy endpoints and any explicit XHR/JSON call.
func isAPIRequest(r *http.Request) bool {
	p := r.URL.Path
	if strings.HasPrefix(p, "/vh/") || strings.HasPrefix(p, "/oc/") {
		return true
	}
	if r.Header.Get("X-Requested-With") != "" {
		return true
	}
	return strings.Contains(r.Header.Get("Accept"), "application/json")
}

// emailAllowed checks an identity against the allow-lists (case-insensitive).
func (a *Authenticator) emailAllowed(email string) bool {
	email = strings.ToLower(strings.TrimSpace(email))
	if email == "" {
		return false
	}
	for _, e := range a.cfg.AllowedEmails {
		if strings.ToLower(strings.TrimSpace(e)) == email {
			return true
		}
	}
	if at := strings.LastIndex(email, "@"); at >= 0 {
		domain := email[at+1:]
		for _, d := range a.cfg.AllowedDomains {
			if strings.ToLower(strings.TrimSpace(d)) == domain {
				return true
			}
		}
	}
	return false
}

// grantOIDC encodes the OIDC session-grant rule and exists to be unit-tested in
// isolation: an identity must pass the allow-list, and — when RequireVerifiedEmail
// is set — must additionally carry a provider-verified email. allowListOK is the
// precomputed result of emailAllowed(email) so callers keep one allow-list pass.
// handleCallback mirrors this rule inline (allow-list first, then the verified
// gate) so it can render distinct user-facing messages.
func grantOIDC(allowListOK, emailVerified bool, cfg Config) bool {
	if !allowListOK {
		return false
	}
	if cfg.RequireVerifiedEmail && !emailVerified {
		return false
	}
	return true
}

// checkPassphrase compares in constant time so a wrong guess can't be timed.
func (a *Authenticator) checkPassphrase(got string) bool {
	return subtle.ConstantTimeCompare([]byte(got), []byte(a.cfg.Passphrase)) == 1
}

// CheckBindSafety flags an insecure bind: it returns a non-nil error describing
// the risk when the server would serve a non-loopback interface with no auth
// configured. The caller decides what to do with it (vh logs it as a warning and
// serves anyway — front it with your own auth/TLS). Returns nil when safe.
func CheckBindSafety(addr string, cfg Config) error {
	if cfg.Mode != ModeNone {
		return nil
	}
	if isLoopbackAddr(addr) {
		return nil
	}
	return fmt.Errorf(
		"serving %q without authentication — the UI (and every proxied worker, for the controller) "+
			"is reachable by anyone who can hit this address. Set --auth-mode (oidc|passphrase|trust-proxy), "+
			"bind loopback (127.0.0.1), or ensure your own reverse proxy enforces auth/TLS", addr)
}

// isLoopbackAddr reports whether a listen address is loopback-only. A bare port
// (":8080") or 0.0.0.0/:: binds all interfaces and is therefore NOT loopback.
func isLoopbackAddr(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		host = addr // maybe no port
	}
	host = strings.TrimSpace(host)
	if host == "" || host == "0.0.0.0" || host == "::" {
		return false
	}
	if host == "localhost" {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		return ip.IsLoopback()
	}
	return false
}
