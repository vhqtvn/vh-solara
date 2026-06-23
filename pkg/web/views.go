package web

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"

	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// Embedded views: a generic, policy-free reverse-proxy + sandboxed-iframe
// surface. A consumer registers an UPSTREAM web server (its own); vh-solara
// reverse-proxies it under a PATH PREFIX (so it inherits vh-solara's host, auth
// and TLS — not a subdomain) and the SPA shows it as a selectable, sandboxed
// iframe peer to chat. vh-solara stays domain-agnostic: it owns the proxy +
// routing + iframe surface + auth-gating + sandbox; the consumer owns the
// upstream and all semantics.
//
// Prefix-correctness contract (pinned): the CONSUMER serves prefix-relative —
// asset/link URLs RELATIVE (no leading slash) — and vh-solara helps by (a)
// stripping the prefix before forwarding, (b) injecting <base href="<prefix>/">
// into HTML so relative URLs resolve under the prefix, and (c) rewriting
// redirect Location headers under the prefix. Root-absolute URLs ("/x") bypass
// the prefix and are the consumer's to avoid (or set their own <base>).
//
// Transport: the upstream spec is one of
//   unix:/path/to.sock        (recommended — matches the /vh UDS pattern)
//   http://127.0.0.1:PORT     (or https://)
//   tcp:host:port             (shorthand for http://host:port)
//
// Auth: the proxy runs INSIDE auth.Middleware (same handler chain on TCP and the
// UDS), so the proxied path is gated by the same session as the rest of the UI.
// The vh-solara session cookie is NEVER forwarded to the upstream (stripped in
// the Director) — auth is enforced here, the upstream gets a clean request.

// viewReg is one registered view + its built reverse-proxy.
type viewReg struct {
	ID         string `json:"view_id"`
	Title      string `json:"title"`
	PathPrefix string `json:"path_prefix"` // normalized, leading slash, no trailing slash
	Upstream   string `json:"upstream"`
	Sandbox    string `json:"sandbox,omitempty"` // iframe sandbox attr (sanitized)
	// Origin labels who owns a registration: "manual" (operator POST /vh/views) or
	// "managed" (a repo-declared project view). Dir is the project dir for managed
	// views (empty for manual). Managed views are replaced/evicted by (dir,id).
	Origin string `json:"origin,omitempty"`
	Dir    string `json:"dir,omitempty"`

	proxy *httputil.ReverseProxy `json:"-"`
}

// Origin tags. Default for a manual registration is OriginManual.
const (
	OriginManual  = "manual"
	OriginManaged = "managed"
)

// viewCSP bounds a proxied page: same-origin only (no external load/exfiltration)
// while still letting it run + letting OUR app frame it (frame-ancestors 'self').
// 'self' here resolves to vh-solara's origin, which the iframe shares — so the
// board's relative fetches under the prefix are allowed and external ones aren't.
const viewCSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' data: blob:; " +
	"style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
	"font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; object-src 'none'"

// sandbox tokens we permit in a registration (a safe read-only subset). Notably
// NO allow-top-navigation (the iframe can't yank the top page away).
var sandboxAllowed = map[string]bool{
	"allow-scripts": true, "allow-same-origin": true, "allow-forms": true,
	"allow-popups": true, "allow-modals": true, "allow-downloads": true,
}

// defaultSandbox: allow-same-origin is REQUIRED for a path-based (same-origin)
// embed so the board's cookie auth + same-origin polling work; allow-scripts so
// it can render/refresh. This is defense-in-depth for an OPERATOR-REGISTERED
// upstream, not a hostile-content boundary — for that, a separate origin would
// be needed (out of scope for the path-based design).
const defaultSandbox = "allow-scripts allow-same-origin"

func sanitizeSandbox(s string) string {
	if strings.TrimSpace(s) == "" {
		return defaultSandbox
	}
	out := make([]string, 0, 4)
	seen := map[string]bool{}
	for _, tok := range strings.Fields(s) {
		tok = strings.ToLower(tok)
		if sandboxAllowed[tok] && !seen[tok] {
			out = append(out, tok)
			seen[tok] = true
		}
	}
	if len(out) == 0 {
		return defaultSandbox
	}
	return strings.Join(out, " ")
}

// viewRegistry holds the live registrations, dispatched by longest path prefix.
type viewRegistry struct {
	mu   sync.RWMutex
	byID map[string]*viewReg
}

func newViewRegistry() *viewRegistry { return &viewRegistry{byID: map[string]*viewReg{}} }

// match returns the registered view whose prefix owns this path (exact or a
// "<prefix>/..." descendant), longest-prefix wins.
func (vr *viewRegistry) match(path string) *viewReg {
	vr.mu.RLock()
	defer vr.mu.RUnlock()
	var best *viewReg
	for _, v := range vr.byID {
		if path == v.PathPrefix || strings.HasPrefix(path, v.PathPrefix+"/") {
			if best == nil || len(v.PathPrefix) > len(best.PathPrefix) {
				best = v
			}
		}
	}
	return best
}

func (vr *viewRegistry) list() []viewReg {
	vr.mu.RLock()
	defer vr.mu.RUnlock()
	out := make([]viewReg, 0, len(vr.byID))
	for _, v := range vr.byID {
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Title < out[j].Title })
	return out
}

// listFor returns the views a given project should see: every manual (global)
// view plus only the managed views owned by dir. This keeps one project's
// repo-declared views from showing up while another project is active.
func (vr *viewRegistry) listFor(dir string) []viewReg {
	vr.mu.RLock()
	defer vr.mu.RUnlock()
	out := make([]viewReg, 0, len(vr.byID))
	for _, v := range vr.byID {
		if v.Origin == OriginManaged && v.Dir != dir {
			continue
		}
		out = append(out, *v)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Title < out[j].Title })
	return out
}

func (vr *viewRegistry) put(v *viewReg) error {
	vr.mu.Lock()
	defer vr.mu.Unlock()
	// A prefix may belong to at most one view; reject a collision with a DIFFERENT id.
	for _, ex := range vr.byID {
		if ex.ID != v.ID && hasPrefixOverlap(ex.PathPrefix, v.PathPrefix) {
			return errors.New("path_prefix overlaps an existing view (" + ex.ID + ")")
		}
	}
	vr.byID[v.ID] = v
	return nil
}

// managedViewKey is the registry id of a project's view: a short per-project
// hash + the declared id. Two projects can declare the same view id without
// colliding in the (global) registry.
func managedViewKey(dir, id string) string { return "m_" + projectKey(dir)[:12] + "_" + id }

// managedViewPrefix is the ROUTING path a project's view is mounted at: a short
// per-project hash namespace + the declared path_prefix. The proxy is a single
// HTTP origin, so two projects that both declare "/board" must serve at distinct
// paths — this makes each project's views independent of every other's. The
// declared prefix is what the author wrote; this is where vh-solara actually
// mounts it (and what the iframe loads).
func managedViewPrefix(dir, declared string) string { return "/_p/" + projectKey(dir)[:12] + declared }

// putManaged registers a repo-declared view. It REPLACES only an existing managed
// view with the SAME (origin,dir,id). Otherwise it inserts if the prefix is free.
// It returns errPrefixConflict (without registering) if the prefix is held by a
// manual view or another of THIS project's views — per the managed-process design
// a collision is NON-FATAL: the process still runs, the view just doesn't mount,
// surfacing as a "prefix-conflict" status in the UI. (Cross-project collisions
// can't happen: both the id and the prefix are per-project namespaced.)
func (vr *viewRegistry) putManaged(v *viewReg) error {
	vr.mu.Lock()
	defer vr.mu.Unlock()
	if ex, ok := vr.byID[v.ID]; ok {
		if ex.Origin == v.Origin && ex.Dir == v.Dir {
			vr.byID[v.ID] = v // re-registration for the same project+id (e.g. re-open)
			return nil
		}
		// Same id owned by someone else (manual, or a different project).
		return errPrefixConflict
	}
	for _, ex := range vr.byID {
		if hasPrefixOverlap(ex.PathPrefix, v.PathPrefix) {
			return errPrefixConflict
		}
	}
	vr.byID[v.ID] = v
	return nil
}

// delManaged removes the managed view for (dir, declaredID); no-op if absent or
// not owned by that project. Manual views are never evicted here.
func (vr *viewRegistry) delManaged(dir, declaredID string) bool {
	key := managedViewKey(dir, declaredID)
	vr.mu.Lock()
	defer vr.mu.Unlock()
	ex, ok := vr.byID[key]
	if !ok || ex.Origin != OriginManaged || ex.Dir != dir {
		return false
	}
	delete(vr.byID, key)
	return true
}

// errPrefixConflict signals a non-fatal managed-view prefix collision.
var errPrefixConflict = errors.New("path_prefix conflicts with an existing view")

// hasPrefixOverlap is true if two prefixes are equal or one nests under the other.
func hasPrefixOverlap(a, b string) bool {
	return a == b ||
		strings.HasPrefix(a+"/", b+"/") ||
		strings.HasPrefix(b+"/", a+"/")
}

func (vr *viewRegistry) del(id string) bool {
	vr.mu.Lock()
	defer vr.mu.Unlock()
	if _, ok := vr.byID[id]; !ok {
		return false
	}
	delete(vr.byID, id)
	return true
}

// reservedPrefixes are vh-solara's own roots; a view can't shadow them.
var reservedPrefixes = []string{"/vh", "/oc", "/auth", "/assets"}

// normalizeViewPrefix validates + canonicalizes a path_prefix (leading slash, no
// trailing slash, not "/", not a reserved root).
func normalizeViewPrefix(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" || !strings.HasPrefix(p, "/") {
		return "", errors.New("path_prefix must start with /")
	}
	p = "/" + strings.Trim(p, "/")
	if p == "/" {
		return "", errors.New("path_prefix cannot be /")
	}
	if strings.ContainsAny(p, " ?#") {
		return "", errors.New("path_prefix has invalid characters")
	}
	for _, r := range reservedPrefixes {
		if p == r || strings.HasPrefix(p+"/", r+"/") {
			return "", errors.New("path_prefix is reserved (" + r + ")")
		}
	}
	return p, nil
}

// buildViewProxy constructs the reverse-proxy for an upstream spec. It strips the
// prefix on the way in, never forwards the vh session cookie, and on the way out
// injects <base>, rewrites Location, overrides framing/CSP, and drops upstream
// Set-Cookie (so the upstream can't touch vh-solara's origin cookies).
func buildViewProxy(prefix, upstream string) (*httputil.ReverseProxy, error) {
	var target *url.URL
	var transport http.RoundTripper
	switch {
	case strings.HasPrefix(upstream, "unix:"):
		sock := strings.TrimPrefix(upstream, "unix:")
		if sock == "" {
			return nil, errors.New("unix upstream missing socket path")
		}
		target = &url.URL{Scheme: "http", Host: "unix"}
		d := &net.Dialer{}
		transport = &http.Transport{
			DialContext:        func(ctx context.Context, _, _ string) (net.Conn, error) { return d.DialContext(ctx, "unix", sock) },
			MaxIdleConns:       16,
			IdleConnTimeout:    90_000_000_000, // 90s
			DisableCompression: true,
			ForceAttemptHTTP2:  false,
		}
	case strings.HasPrefix(upstream, "http://"), strings.HasPrefix(upstream, "https://"):
		u, err := url.Parse(upstream)
		if err != nil {
			return nil, err
		}
		target = &url.URL{Scheme: u.Scheme, Host: u.Host}
		transport = http.DefaultTransport
	case strings.HasPrefix(upstream, "tcp:"):
		host := strings.TrimPrefix(upstream, "tcp:")
		if host == "" {
			return nil, errors.New("tcp upstream missing host:port")
		}
		target = &url.URL{Scheme: "http", Host: host}
		transport = http.DefaultTransport
	default:
		return nil, errors.New("upstream must be unix:<path>, http(s)://host:port, or tcp:host:port")
	}

	rp := &httputil.ReverseProxy{Transport: transport, FlushInterval: -1}
	rp.Director = func(req *http.Request) {
		req.URL.Scheme = target.Scheme
		req.URL.Host = target.Host
		req.Host = target.Host
		// Strip the prefix so the upstream sees clean paths ("/", "/assets/x").
		p := strings.TrimPrefix(req.URL.Path, prefix)
		if p == "" {
			p = "/"
		}
		req.URL.Path = p
		// Never leak vh-solara's session/CSRF to the consumer upstream. Force
		// identity encoding so HTML <base> injection isn't fighting gzip.
		req.Header.Del("Cookie")
		req.Header.Del("X-VH-CSRF")
		req.Header.Set("Accept-Encoding", "identity")
		req.Header.Set("X-Forwarded-Prefix", prefix)
	}
	rp.ModifyResponse = func(resp *http.Response) error {
		resp.Header.Del("Set-Cookie") // upstream must not write vh-solara's origin cookies
		// Allow OUR same-origin app to frame it; bound the page with our CSP.
		resp.Header.Del("X-Frame-Options")
		resp.Header.Set("X-Frame-Options", "SAMEORIGIN")
		resp.Header.Set("Content-Security-Policy", viewCSP)
		if loc := resp.Header.Get("Location"); loc != "" {
			resp.Header.Set("Location", rewriteViewLocation(loc, prefix))
		}
		if isHTMLResponse(resp) {
			return injectBaseTag(resp, prefix)
		}
		return nil
	}
	rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		vhlog.Error("view proxy upstream error", "prefix", prefix, "path", r.URL.Path, "err", err)
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("view upstream error: " + err.Error()))
	}
	return rp, nil
}

// rewriteViewLocation keeps a redirect under the prefix: a root-absolute path
// ("/x") becomes "<prefix>/x"; an already-prefixed or absolute URL is left alone.
func rewriteViewLocation(loc, prefix string) string {
	if loc == "" || strings.Contains(loc, "://") {
		return loc // absolute URL — out of our hands
	}
	if strings.HasPrefix(loc, prefix+"/") || loc == prefix {
		return loc
	}
	if strings.HasPrefix(loc, "/") {
		return prefix + loc
	}
	return loc // relative — resolves correctly under the prefixed page
}

func isHTMLResponse(resp *http.Response) bool {
	return strings.Contains(strings.ToLower(resp.Header.Get("Content-Type")), "text/html")
}

// injectBaseTag inserts <base href="<prefix>/"> so the consumer's RELATIVE asset
// URLs resolve under the prefix. Inserted right after <head> (or <html>, or at
// the start) — whichever appears first.
func injectBaseTag(resp *http.Response, prefix string) error {
	body, err := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if err != nil {
		return err
	}
	base := []byte(`<base href="` + prefix + `/">`)
	out := insertAfterTag(body, base)
	resp.Body = io.NopCloser(bytes.NewReader(out))
	resp.ContentLength = int64(len(out))
	resp.Header.Set("Content-Length", strconv.Itoa(len(out)))
	return nil
}

// insertAfterTag inserts ins right after the first <head...> open tag (else after
// <html...>, else prepends). Case-insensitive, no full HTML parse needed.
func insertAfterTag(body, ins []byte) []byte {
	low := bytes.ToLower(body)
	for _, tag := range [][]byte{[]byte("<head"), []byte("<html")} {
		if i := bytes.Index(low, tag); i >= 0 {
			if j := bytes.IndexByte(body[i:], '>'); j >= 0 {
				at := i + j + 1
				out := make([]byte, 0, len(body)+len(ins))
				out = append(out, body[:at]...)
				out = append(out, ins...)
				out = append(out, body[at:]...)
				return out
			}
		}
	}
	return append(append([]byte(nil), ins...), body...)
}

// --- HTTP surface -----------------------------------------------------------

// dispatchView is the innermost wrapper around the mux: if the path is owned by a
// registered view it reverse-proxies it (after clearing the global CSP/XFO that
// securityHeaders set, so the proxy's same-origin-framing CSP is the only one);
// otherwise the mux handles it.
func (s *Server) dispatchView(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if v := s.views.match(r.URL.Path); v != nil {
			h := w.Header()
			h.Del("Content-Security-Policy")
			h.Del("X-Frame-Options")
			v.proxy.ServeHTTP(w, r)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// handleViews is the registration surface (auth-gated; POST/DELETE need the CSRF
// header like every mutating /vh/*):
//
//	GET    /vh/views            → list registered views
//	POST   /vh/views            → register/replace {view_id,title,path_prefix,upstream,sandbox?}
//	DELETE /vh/views?view_id=ID → unregister
func (s *Server) handleViews(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		// With ?dir=, scope managed views to that project (manual views are always
		// included). Without it (e.g. cross-worker listing), return everything.
		if r.URL.Query().Has("dir") {
			writeJSONResp(w, s.views.listFor(absDir(r.URL.Query().Get("dir"))))
		} else {
			writeJSONResp(w, s.views.list())
		}
	case http.MethodPost:
		var in viewReg
		r.Body = http.MaxBytesReader(w, r.Body, 1<<16)
		if json.NewDecoder(r.Body).Decode(&in) != nil {
			http.Error(w, "invalid JSON", http.StatusBadRequest)
			return
		}
		if strings.TrimSpace(in.ID) == "" {
			http.Error(w, "view_id required", http.StatusBadRequest)
			return
		}
		prefix, err := normalizeViewPrefix(in.PathPrefix)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		proxy, err := buildViewProxy(prefix, strings.TrimSpace(in.Upstream))
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		v := &viewReg{
			ID:         in.ID,
			Title:      strings.TrimSpace(in.Title),
			PathPrefix: prefix,
			Upstream:   strings.TrimSpace(in.Upstream),
			Sandbox:    sanitizeSandbox(in.Sandbox),
			Origin:     OriginManual,
			proxy:      proxy,
		}
		if v.Title == "" {
			v.Title = v.ID
		}
		if err := s.views.put(v); err != nil {
			http.Error(w, err.Error(), http.StatusConflict)
			return
		}
		vhlog.Info("view registered", "id", v.ID, "prefix", v.PathPrefix, "upstream", v.Upstream)
		writeJSONResp(w, v)
	case http.MethodDelete:
		id := r.URL.Query().Get("view_id")
		if id == "" {
			http.Error(w, "view_id required", http.StatusBadRequest)
			return
		}
		writeJSONResp(w, map[string]any{"ok": s.views.del(id)})
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}
