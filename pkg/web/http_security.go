package web

// HTTP security helpers, moved verbatim from server.go (slice 6 of the
// server.go split): the CSP corpus (cspDirectives, hostCSPDirectives,
// isHostRoute, frameAncestorsDirective, contentSecurityPolicyForPath), the
// document security-headers middleware (securityHeaders), CORS (originAllowed,
// cors), and the CSRF guard (csrfHeader const + csrfGuard middleware). The
// middleware nesting in server.go's Handler (securityHeaders → auth → cors →
// csrfGuard → logRequests → stampMeta → dispatchView → mux) and the views.go
// outer-CSP exemption are unchanged; only the declarations moved.

import (
	"net/http"
	"strings"
)

// cspDirectives are the static CSP directives. dev-friendly but still blocks a
// key XSS goal — EXTERNAL resource loading/exfiltration. script-src allows
// 'unsafe-inline'/'unsafe-eval' (relaxed while developing), but lists no
// external origins, so an injected script can't pull in external scripts;
// connect-src/img-src/default-src stay 'self', so it can't fetch or beacon out
// to other origins either.
// TODO: tighten script-src to 'self' (drop unsafe-inline/eval) once stable.
//
// frame-ancestors is NOT in this list: it is per-server (see
// Server.frameAncestorsDirective) so an operator can widen framing for a trusted
// host embed via --frame-ancestors, while the default stays 'self'.
var cspDirectives = []string{
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline' 'unsafe-eval'",
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
	"font-src 'self' https://fonts.gstatic.com data:",
	"img-src 'self' data: blob:",
	"connect-src 'self'",
	"worker-src 'self'",
	"manifest-src 'self'",
	"object-src 'none'",
	"base-uri 'self'",
}

// hostCSPDirectives are the CSP directives for the HOST shell routes (`/` and
// `/host/*`). They are cspDirectives PLUS `frame-src http: https:`, which the
// host needs because its whole purpose is to embed operator-chosen servers as
// (possibly cross-origin) <iframe>s. Without an explicit frame-src the
// single-server SPA's default-src 'self' applies (frame-src falls back to it),
// which would BLOCK cross-origin remote-server embeds — defeating the host's
// multi-server role. The added frame-src is the ONLY difference from
// cspDirectives; every other directive is identical so the host inherits the
// same exfiltration/XSS posture (no external connect/img/script origins).
//
// This is frame-SRC (what WE frame), NOT frame-ANCESTORS (who frames us). The
// frame-ancestors default ('self') is UNCHANGED and is appended per-server below
// for BOTH policies — so the host page at `/` is still NOT embeddable
// cross-origin unless an operator passes --frame-ancestors (unchanged behavior).
var hostCSPDirectives = []string{
	"default-src 'self'",
	"script-src 'self' 'unsafe-inline' 'unsafe-eval'",
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
	"font-src 'self' https://fonts.gstatic.com data:",
	"img-src 'self' data: blob:",
	"connect-src 'self'",
	"worker-src 'self'",
	"manifest-src 'self'",
	"object-src 'none'",
	"base-uri 'self'",
	"frame-src http: https:",
}

// isHostRoute reports whether path is served by the HOST shell (`/` and the
// host's namespaced `/host/*` assets). Used to select the host CSP (which adds
// frame-src so the host can embed operator-chosen servers). Every other path —
// the single-server SPA at `/app`, its root-level assets, and the daemon routes
// `/vh/*`, `/oc/*` — keeps the strict single-server CSP (cspDirectives).
func isHostRoute(path string) bool {
	return path == "/" || strings.HasPrefix(path, "/host/")
}

// frameAncestorsDirective returns the CSP frame-ancestors directive for this
// server.
//
// Default (no --frame-ancestors): 'self'. This lets the app frame its OWN pages
// (the code viewer runs in a same-origin iframe to keep its heavy DOM out of the
// main document) while still blocking cross-origin framing / clickjacking.
//
// Explicit allowlist (--frame-ancestors set): the operator's source list verbatim
// (space-separated, the CSP-correct separator for a source-expression list). This
// REPLACES 'self' — an operator who still needs the app's own same-origin
// iframes (e.g. the code viewer) must include 'self' in the list, e.g.
// `--frame-ancestors 'self' --frame-ancestors https://app.my-root-domain`. This
// mirrors how --cors-origin works (full replacement, operator controls the list)
// and avoids implicit broadening: only an operator who sets the flag widens
// framing permission.
func (s *Server) frameAncestorsDirective() string {
	if len(s.frameAncestors) == 0 {
		return "frame-ancestors 'self'"
	}
	return "frame-ancestors " + strings.Join(s.frameAncestors, " ")
}

// contentSecurityPolicyForPath returns the full CSP for this server on the given
// path: the HOST directives (with frame-src) for host routes, the single-server
// directives otherwise; both plus the per-server frame-ancestors directive.
// Host-route selection is gated on hostShellAtRoot: in legacy/test mode (fixture
// server, hostShellAtRoot=false) `/` is the single-server SPA, so it gets the
// single-server CSP (no frame-src).
func (s *Server) contentSecurityPolicyForPath(path string) string {
	dirs := make([]string, 0, len(cspDirectives)+2)
	if s.hostShellAtRoot && isHostRoute(path) {
		dirs = append(dirs, hostCSPDirectives...)
	} else {
		dirs = append(dirs, cspDirectives...)
	}
	dirs = append(dirs, s.frameAncestorsDirective())
	return strings.Join(dirs, "; ")
}

// securityHeaders sets the document security headers. It is a method on *Server
// so the CSP (frame-ancestors) and X-Frame-Options can reflect the per-server
// --frame-ancestors allowlist.
//
// X-Frame-Options decision: when frame-ancestors is at its default ('self') we
// send X-Frame-Options: SAMEORIGIN for defense-in-depth (legacy browsers that
// don't understand CSP frame-ancestors). When an operator sets an explicit
// allowlist we OMIT X-Frame-Options: it is legacy/superseded by CSP
// frame-ancestors, modern browsers ignore it when frame-ancestors is present,
// and keeping SAMEORIGIN would actually BLOCK the intended cross-origin embed on
// browsers that DO honor X-Frame-Options — defeating the flag.
func (s *Server) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		// Path-aware CSP: host shell routes (`/`, `/host/*`) get the host policy
		// (adds frame-src so the host can embed operator-chosen servers); every
		// other path keeps the strict single-server policy. frame-ancestors is
		// appended identically for both (unchanged default 'self').
		h.Set("Content-Security-Policy", s.contentSecurityPolicyForPath(r.URL.Path))
		h.Set("X-Content-Type-Options", "nosniff")
		if len(s.frameAncestors) == 0 {
			h.Set("X-Frame-Options", "SAMEORIGIN")
		}
		// same-origin (not no-referrer): cross-origin requests still get NO
		// referrer (the third-party-leak protection no-referrer provided is
		// preserved), but same-origin requests carry a referrer to our own
		// server (which already knows its own URLs — no leak). This matters for
		// the native passphrase login <form>: under no-referrer, Chromium AND
		// Firefox serialize Origin as "null" on a form-POST navigation, and
		// submitPassphrase's same-origin guard then rejects it (403) — breaking
		// the rendered login form in a real browser. same-origin lets the
		// browser send a genuine same-origin Origin, which that guard
		// legitimately accepts. CSRF defense stays in the guard, unchanged.
		h.Set("Referrer-Policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

func (s *Server) originAllowed(origin string) bool {
	for _, o := range s.corsOrigins {
		if o == "*" || o == origin {
			return true
		}
	}
	return false
}

// cors applies the configured cross-origin allowlist. Allowed origins get full
// CORS (including the X-VH-CSRF header, which they need to pass the CSRF guard);
// disallowed origins get no CORS headers, so the browser blocks them — which is
// also what preserves CSRF protection. No credentials are used (no cookies).
func (s *Server) cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		if origin != "" && s.originAllowed(origin) {
			h := w.Header()
			h.Set("Access-Control-Allow-Origin", origin)
			h.Add("Vary", "Origin")
			h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Content-Type, "+csrfHeader+", Last-Event-ID")
			h.Set("Access-Control-Max-Age", "600")
		}
		if r.Method == http.MethodOptions {
			// Preflight (or any OPTIONS): answer here. Without the CORS headers
			// above (disallowed origin), the browser rejects the real request.
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

const csrfHeader = "X-VH-CSRF"

// csrfGuard requires a custom header on state-changing requests to the API
// (/oc/* and mutating /vh/*) — the check is PRESENCE only (any non-empty
// X-VH-CSRF value passes; the SPA's installCsrf sends "1", but the guard does
// not compare values). A cross-site page cannot set a custom header without a
// CORS preflight, which this server approves only for operator-configured
// origins (the cors allowlist also permits them the X-VH-CSRF header) — so
// beyond that allowlist, only the same-origin SPA can reach these endpoints.
// This needs no auth and is proxy-agnostic (no Origin/Host comparison). The
// /oc/* passthrough can run shell commands, so this is the line that stops a
// malicious page from doing so through the user's browser. Read methods and
// the side-effect-free /vh/render are exempt.
func csrfGuard(next http.Handler) http.Handler {
	unsafe := map[string]bool{http.MethodPost: true, http.MethodPut: true, http.MethodPatch: true, http.MethodDelete: true}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		guarded := (strings.HasPrefix(p, "/oc/") || strings.HasPrefix(p, "/vh/")) && p != "/vh/render"
		// /vh/internal/notify/* (notify controller-hub S2) is the bearer-
		// token-authenticated controller surface, not a browser surface: the
		// POST ACK carries the private token (constant-time checked in the
		// handler), which a cross-site page cannot know or set — the CSRF
		// threat model does not apply, and the controller sends no
		// X-VH-CSRF header. Exempted from the header requirement only; the
		// token check still rejects everything else with the plain 404.
		if strings.HasPrefix(p, "/vh/internal/notify/") {
			guarded = false
		}
		if unsafe[r.Method] && guarded && r.Header.Get(csrfHeader) == "" {
			http.Error(w, "missing "+csrfHeader+" header (CSRF protection)", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}
