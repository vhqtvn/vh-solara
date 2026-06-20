// Package web serves the vh-solara client UI plus the client-agnostic
// snapshot/resume protocol backed by the daemon's materialized state, and
// passes write operations through to the local OpenCode server.
package web

import (
	"bufio"
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/auth"
	"github.com/vhqtvn/vh-solara/pkg/quota"
	"github.com/vhqtvn/vh-solara/pkg/render"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

//go:embed dist
var distFS embed.FS

// Server wires the aggregator's view to HTTP: /vh/* protocol endpoints, /oc/*
// OpenCode passthrough, and the embedded SPA at /.
type Server struct {
	agg      *aggregator.Aggregator // default project (OpenCode serve cwd)
	proxy    *httputil.ReverseProxy
	staticFS fs.FS
	static   http.Handler
	renderer *render.Renderer

	// Multi-project: one aggregator per directory, created lazily. "" → agg.
	opencodeURL string
	ringCap     int
	aggMu       sync.Mutex
	aggs        map[string]*aggregator.Aggregator

	cssOnce sync.Once
	css     string

	quotaMu    sync.Mutex
	quotaCache *quota.Report
	quotaAt    time.Time

	// restartOC, when set by the daemon, restarts the managed OpenCode process.
	// nil in environments that don't manage OpenCode (e.g. the fixture server).
	restartOC     func(context.Context) error
	restartServer func()
	ocVersionFn   func(context.Context) (installed, running, latest string, err error)
	ocUpdateFn    func(ctx context.Context, w io.Writer) error
	appVersion    string // this vh-solara build's version (set by the daemon)

	// corsOrigins is the explicit allowlist of cross-origin callers. Empty =
	// no CORS (strict same-origin). "*" allows any origin (which disables the
	// cross-origin half of the CSRF protection — only set it if you mean it).
	corsOrigins []string

	// auth, when set, gates the whole server (login + session). nil = no auth
	// (only safe on a loopback bind; see auth.CheckBindSafety).
	auth *auth.Authenticator

	// idem dedups typed write verbs by their idempotency_key (A1).
	idem *idemCache

	// features are the capability modules mounted at startup (B). The
	// coordination verbs are the first one (dogfood).
	features []Feature
}

// RegisterFeature adds a capability module to be mounted by Handler(). Call
// before Handler() is first invoked. Returns the server for chaining.
func (s *Server) RegisterFeature(f Feature) *Server {
	s.features = append(s.features, f)
	return s
}

// SetAuth installs the auth layer as the outermost wrapper of Handler(). nil or
// a ModeNone authenticator leaves the server open (loopback-only use).
func (s *Server) SetAuth(a *auth.Authenticator) { s.auth = a }

// SetCORSOrigins sets the allowed cross-origin callers (e.g. a separate app or
// dev frontend). Optional; default is strict same-origin.
func (s *Server) SetCORSOrigins(origins []string) { s.corsOrigins = origins }

// SetAppVersion records this vh-solara build's version for GET /vh/version.
func (s *Server) SetAppVersion(v string) { s.appVersion = v }

// SetRestartOpenCode wires the daemon's OpenCode-restart hook. Optional.
func (s *Server) SetRestartOpenCode(fn func(context.Context) error) { s.restartOC = fn }

// SetRestartServer wires the daemon's vh-server-restart hook (re-exec, or exit
// for a supervisor to relaunch). Optional.
func (s *Server) SetRestartServer(fn func()) { s.restartServer = fn }

// NewServer builds the HTTP server. opencodeURL is the local OpenCode base URL
// (e.g. http://127.0.0.1:4096) for write passthrough. ringCapacity sizes the
// event log of lazily-created per-project aggregators.
func NewServer(agg *aggregator.Aggregator, opencodeURL string, ringCapacity int) (*Server, error) {
	target, err := url.Parse(opencodeURL)
	if err != nil {
		return nil, err
	}
	rp := httputil.NewSingleHostReverseProxy(target)
	rp.FlushInterval = -1 // flush immediately so any proxied stream isn't buffered
	// A failed proxy hop (OpenCode down, connection reset) otherwise surfaces as
	// a bare 502 with nothing in the logs — exactly the case that's painful to
	// diagnose. Log the upstream error with the method+path that triggered it.
	rp.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		vhlog.Error("proxy upstream error", "method", r.Method, "path", r.URL.Path, "err", err)
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write([]byte("upstream error: " + err.Error()))
	}

	// Ensure the PWA manifest is served with a sensible content type (Go's
	// default mime table has no .webmanifest entry).
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")

	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		return nil, err
	}
	srv := &Server{
		agg:         agg,
		proxy:       rp,
		staticFS:    sub,
		renderer:    render.New(),
		static:      http.FileServer(http.FS(sub)),
		opencodeURL: opencodeURL,
		ringCap:     ringCapacity,
		aggs:        map[string]*aggregator.Aggregator{"": agg},
		idem:        newIdemCache(10 * time.Minute),
		features:    defaultFeatures(),
	}
	return srv, nil
}

// aggFor returns the aggregator for a project directory, creating and starting
// one lazily for directories beyond the default. Concurrent-safe.
func (s *Server) aggFor(dir string) *aggregator.Aggregator {
	if dir == "" {
		return s.agg
	}
	s.aggMu.Lock()
	defer s.aggMu.Unlock()
	if a, ok := s.aggs[dir]; ok {
		return a
	}
	a := aggregator.NewForDirectory(s.opencodeURL, dir, s.ringCap)
	s.aggs[dir] = a
	go a.Run(context.Background())
	return a
}

// reqDir extracts the requested project directory from ?dir= (snapshot/stream)
// or the x-opencode-directory header (passthrough).
func reqDir(r *http.Request) string {
	if d := r.URL.Query().Get("dir"); d != "" {
		return d
	}
	return r.Header.Get("x-opencode-directory")
}

// Handler returns the routed http.Handler.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/vh/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("ok"))
	})
	mux.HandleFunc("/vh/version", func(w http.ResponseWriter, r *http.Request) {
		v := s.appVersion
		if v == "" {
			v = "dev"
		}
		writeJSONResp(w, map[string]string{"version": v})
	})
	mux.HandleFunc("/vh/snapshot", s.handleSnapshot)
	mux.HandleFunc("/vh/stream", s.handleStream)
	mux.HandleFunc("/vh/render", s.handleRender)
	mux.HandleFunc("/vh/highlight.css", s.handleHighlightCSS)
	mux.HandleFunc("/vh/notes", s.handleNotes)
	mux.HandleFunc("/vh/attach", s.handleAttach)
	mux.HandleFunc("/vh/quota", s.handleQuota)
	mux.HandleFunc("/vh/archive", s.handleArchive)
	mux.HandleFunc("/vh/unarchive", s.handleArchive)
	// Feature modules (B) — the coordination write verbs (A1) are the first one.
	s.mountFeatures(mux)
	mux.HandleFunc("/vh/ack", s.handleAck)
	mux.HandleFunc("/vh/archived", s.handleArchived)
	mux.HandleFunc("/vh/reload", s.handleReload)
	mux.HandleFunc("/vh/restart-opencode", s.handleRestartOpenCode)
	mux.HandleFunc("/vh/restart-server", s.handleRestartServer)
	mux.HandleFunc("/vh/term/ws", s.handleTerminalWS)
	mux.HandleFunc("/vh/term/list", s.handleTermList)
	mux.HandleFunc("/vh/term/kill", s.handleTermKill)
	mux.HandleFunc("/vh/git/status", s.handleGitStatus)
	mux.HandleFunc("/vh/git/stage", s.handleGitStage)
	mux.HandleFunc("/vh/git/unstage", s.handleGitUnstage)
	mux.HandleFunc("/vh/git/discard", s.handleGitDiscard)
	mux.HandleFunc("/vh/git/commit", s.handleGitCommit)
	mux.HandleFunc("/vh/git/push", s.handleGitPush)
	mux.HandleFunc("/vh/opencode-version", s.handleOpenCodeVersion)
	mux.HandleFunc("/vh/update-opencode", s.handleUpdateOpenCode)
	mux.HandleFunc("/oc/", s.handlePassthrough)
	mux.HandleFunc("/", s.handleStatic)
	// Auth gates everything (login page + session); it sits inside securityHeaders
	// so the login page still gets CSP, and outside cors/csrf so an unauthenticated
	// request is challenged before reaching application logic. nil/ModeNone = no-op.
	return securityHeaders(s.auth.Middleware(s.cors(csrfGuard(logRequests(s.stampMeta(mux))))))
}

// stampMeta sets X-VH-Epoch and X-VH-Seq on /vh/* responses so a cross-worker
// coordinator can key its resume cursor by (worker, epoch, seq) and detect a
// worker restart (epoch change) from any response — not just a snapshot. The seq
// is the head at request entry (a hint; the authoritative cursor is the snapshot/
// stream's own seq). Headers are set before the handler writes, so they survive
// streaming and hijacked (terminal/WebSocket) responses.
func (s *Server) stampMeta(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/vh/") {
			st := s.aggFor(reqDir(r)).Store()
			h := w.Header()
			h.Set("X-VH-Epoch", st.Epoch())
			h.Set("X-VH-Seq", strconv.FormatUint(st.Head(), 10))
		}
		next.ServeHTTP(w, r)
	})
}

// logRequests emits a debug line per /oc/* and mutating /vh/* request with the
// response status and duration — these are the write operations (prompt send,
// permission/question reply, archive, restart) whose silent failures are the
// hard ones to diagnose after the fact. Gated by VH_DEBUG so the default path
// (and SSE/streaming responses) run completely unwrapped.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		interesting := strings.HasPrefix(p, "/oc/") ||
			(strings.HasPrefix(p, "/vh/") && r.Method != http.MethodGet)
		if !vhlog.Enabled() || !interesting {
			next.ServeHTTP(w, r)
			return
		}
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		start := time.Now()
		next.ServeHTTP(sw, r)
		vhlog.Debug("http",
			"method", r.Method, "path", p, "status", sw.status,
			"dur_ms", time.Since(start).Milliseconds())
	})
}

// statusWriter captures the response status for logging while forwarding
// http.Flusher so streamed/proxied responses keep flushing.
type statusWriter struct {
	http.ResponseWriter
	status int
	wrote  bool
}

func (s *statusWriter) WriteHeader(code int) {
	if !s.wrote {
		s.status = code
		s.wrote = true
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	s.wrote = true
	return s.ResponseWriter.Write(b)
}

func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Hijack lets the WebSocket upgrade (terminal) take over the connection through
// the logging wrapper.
func (s *statusWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	if hj, ok := s.ResponseWriter.(http.Hijacker); ok {
		return hj.Hijack()
	}
	return nil, nil, http.ErrNotSupported
}

// contentSecurityPolicy: dev-friendly but still blocks a key XSS goal —
// EXTERNAL resource loading/exfiltration. script-src allows 'unsafe-inline'/
// 'unsafe-eval' (relaxed while developing), but lists no external origins, so an
// injected script can't pull in external scripts; connect-src/img-src/default-src
// stay 'self', so it can't fetch or beacon out to other origins either.
// TODO: tighten script-src to 'self' (drop unsafe-inline/eval) once stable.
var contentSecurityPolicy = strings.Join([]string{
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
	"frame-ancestors 'none'",
}, "; ")

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Referrer-Policy", "no-referrer")
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
// (/oc/* and mutating /vh/*). A cross-site page cannot set a custom header
// without a CORS preflight, which this server never approves — so only the
// same-origin SPA can reach these endpoints. This needs no auth and is
// proxy-agnostic (no Origin/Host comparison). The /oc/* passthrough can run
// shell commands, so this is the line that stops a malicious page from doing so
// through the user's browser. Read methods and the side-effect-free /vh/render
// are exempt.
func csrfGuard(next http.Handler) http.Handler {
	unsafe := map[string]bool{http.MethodPost: true, http.MethodPut: true, http.MethodPatch: true, http.MethodDelete: true}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		guarded := (strings.HasPrefix(p, "/oc/") || strings.HasPrefix(p, "/vh/")) && p != "/vh/render"
		if unsafe[r.Method] && guarded && r.Header.Get(csrfHeader) == "" {
			http.Error(w, "missing "+csrfHeader+" header (CSRF protection)", http.StatusForbidden)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// messageFilter parses the `sessions` query param into a Snapshot filter:
//   - "all"          -> nil   (all sessions' messages)
//   - absent/empty   -> {}    (no messages; tree-only)
//   - "a,b,c"        -> {a,b,c}
func messageFilter(r *http.Request) map[string]bool {
	q := r.URL.Query().Get("sessions")
	if q == "all" {
		return nil
	}
	filter := map[string]bool{}
	for _, id := range strings.Split(q, ",") {
		if id = strings.TrimSpace(id); id != "" {
			filter[id] = true
		}
	}
	return filter
}

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	agg := s.aggFor(reqDir(r))
	filter := messageFilter(r)
	s.ensureMessages(r.Context(), agg, filter)
	snap := agg.Store().Snapshot(filter)
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(snap)
}

// ensureMessages lazily hydrates the messages for the sessions a snapshot/stream
// request will include, so lazy hydration is transparent to clients.
func (s *Server) ensureMessages(ctx context.Context, agg *aggregator.Aggregator, filter map[string]bool) {
	if filter == nil { // "all"
		for _, id := range agg.Store().SessionIDs() {
			_ = agg.EnsureMessages(ctx, id)
		}
		return
	}
	for id := range filter {
		_ = agg.EnsureMessages(ctx, id)
	}
}

// handleAck clears a root session's finished-unread flag (the client scrolled
// that session to the bottom). POST /vh/ack {sessionID}. Cross-device: the
// resulting unread.clear event/snapshot reaches every connected client.
func (s *Server) handleAck(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		SessionID string `json:"sessionID"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10)
	if json.NewDecoder(r.Body).Decode(&body) != nil || body.SessionID == "" {
		http.Error(w, "sessionID required", http.StatusBadRequest)
		return
	}
	s.aggFor(reqDir(r)).Store().AckUnread(body.SessionID)
	writeJSONResp(w, map[string]any{"ok": true})
}

func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("X-Accel-Buffering", "no")
	h.Set("Connection", "keep-alive")

	// Prefer the Last-Event-ID header (sent automatically by EventSource on
	// reconnect) over the cursor query param.
	cursorStr := r.Header.Get("Last-Event-ID")
	if cursorStr == "" {
		cursorStr = r.URL.Query().Get("cursor")
	}
	hasCursor := cursorStr != ""
	cursor, _ := strconv.ParseUint(cursorStr, 10, 64)

	agg := s.aggFor(reqDir(r))
	store := agg.Store()

	// Priority separation: high-volume message/part events are streamed ONLY for
	// the subscribed sessions (the active session via ?sessions=); structural
	// (session/activity/status) and notification (permission/question) events are
	// ALWAYS streamed. This keeps the important channels — sessions list, open
	// session, notifications — flowing even when a busy project floods the feed
	// with background subagent token-deltas. ?sessions=all opts back into the
	// full firehose.
	filter := messageFilter(r)
	sendable := func(kind string, payload []byte) bool {
		if filter == nil { // "all"
			return true
		}
		if !strings.HasPrefix(kind, "message.") && !strings.HasPrefix(kind, "part.") {
			return true // structural + notifications: always
		}
		var p struct {
			SessionID string `json:"sessionID"`
		}
		_ = json.Unmarshal(payload, &p)
		return p.SessionID != "" && filter[p.SessionID]
	}

	// Subscribe before resolving the resume baseline so no event slips through
	// the gap between snapshot/replay and the live tail.
	ch, unsub := store.Subscribe(256)
	defer unsub()

	var baseline uint64
	events, head, replayOK := store.Replay(cursor)
	if hasCursor && replayOK {
		for _, ev := range events {
			if sendable(ev.Kind, ev.Payload) {
				writeEvent(w, ev.Seq, ev.Kind, ev.Payload)
			}
		}
		baseline = head
	} else {
		// Fresh client or cursor too old: send a full snapshot, then live-tail.
		s.ensureMessages(r.Context(), agg, filter)
		snap := store.Snapshot(filter)
		b, _ := json.Marshal(snap)
		writeRaw(w, snap.Seq, "snapshot", b)
		baseline = snap.Seq
	}
	flusher.Flush()

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return // dropped as a slow consumer; client will reconnect + resume
			}
			if ev.Seq <= baseline {
				continue // already covered by snapshot/replay
			}
			baseline = ev.Seq
			if !sendable(ev.Kind, ev.Payload) {
				continue // background message/part for an unsubscribed session
			}
			writeEvent(w, ev.Seq, ev.Kind, ev.Payload)
			flusher.Flush()
		case <-ticker.C:
			// A NAMED ping event (not an SSE ` : comment`) so the client can observe
			// it — EventSource hides comments, so the client uses these pings to
			// detect a dead-but-open connection and force a reconnect. No id line,
			// so Last-Event-ID (the resume cursor) is untouched.
			io.WriteString(w, "event: ping\ndata: {}\n\n")
			flusher.Flush()
		}
	}
}

func writeEvent(w io.Writer, seq uint64, kind string, payload []byte) {
	writeRaw(w, seq, kind, payload)
}

func writeRaw(w io.Writer, seq uint64, event string, data []byte) {
	fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", seq, event, data)
}

// renderRequest is one item in a POST /vh/render batch. Clients render in-flight
// (streaming) content themselves and call this only for settled content, keyed
// by a stable id so results can be matched back and cached client-side.
type renderRequest struct {
	ID     string `json:"id"`
	Kind   string `json:"kind"` // "markdown" | "diff" | "patch"
	Text   string `json:"text,omitempty"`
	File   string `json:"file,omitempty"`
	Before string `json:"before,omitempty"`
	After  string `json:"after,omitempty"`
	Patch  string `json:"patch,omitempty"`
	Mode   string `json:"mode,omitempty"` // patch: "split" for side-by-side, else unified
}

type renderResult struct {
	ID   string `json:"id"`
	HTML string `json:"html"`
}

func (s *Server) handleRender(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var reqs []renderRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<20)).Decode(&reqs); err != nil {
		http.Error(w, "bad request", http.StatusBadRequest)
		return
	}
	// Render the batch across goroutines: the per-block work (goldmark + chroma +
	// sanitize) is CPU-bound and concurrent-safe (each call uses a local buffer;
	// only the renderer's cache map is mutex-guarded), so a big first-open batch
	// uses all cores instead of one. Bounded to NumCPU; results indexed (the
	// client maps by id, order doesn't matter). An unrendered slot keeps ID="" and
	// is filtered out (matches the old "skip unknown kind" behavior).
	slots := make([]renderResult, len(reqs))
	conc := runtime.NumCPU()
	if conc < 1 {
		conc = 1
	}
	sem := make(chan struct{}, conc)
	var wg sync.WaitGroup
	for i := range reqs {
		wg.Add(1)
		sem <- struct{}{}
		go func(i int) {
			defer wg.Done()
			defer func() { <-sem }()
			req := reqs[i]
			var html string
			switch req.Kind {
			case "markdown":
				html = s.renderer.Markdown(req.Text)
			case "diff":
				html = s.renderer.Diff(req.File, req.Before, req.After)
			case "patch":
				if req.Mode == "split" {
					html = s.renderer.PatchSplit(req.Patch)
				} else {
					html = s.renderer.Patch(req.Patch)
				}
			default:
				return // leave slot zero (ID=="") → filtered below
			}
			slots[i] = renderResult{ID: req.ID, HTML: html}
		}(i)
	}
	wg.Wait()
	results := make([]renderResult, 0, len(slots))
	for _, r := range slots {
		if r.ID != "" {
			results = append(results, r)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(results)
}

func (s *Server) handleHighlightCSS(w http.ResponseWriter, r *http.Request) {
	s.cssOnce.Do(func() {
		css, err := s.renderer.HighlightCSS()
		if err == nil {
			s.css = css
		}
	})
	w.Header().Set("Content-Type", "text/css; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	io.WriteString(w, s.css)
}

// handlePassthrough strips the /oc prefix and reverse-proxies to OpenCode.
func (s *Server) handlePassthrough(w http.ResponseWriter, r *http.Request) {
	r.URL.Path = strings.TrimPrefix(r.URL.Path, "/oc")
	if r.URL.Path == "" {
		r.URL.Path = "/"
	}
	s.proxy.ServeHTTP(w, r)
}

// handleStatic serves embedded assets, falling back to index.html for SPA routes.
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimPrefix(r.URL.Path, "/")
	if p == "" {
		p = "index.html"
	}
	if f, err := s.staticFS.Open(p); err == nil {
		f.Close()
		s.static.ServeHTTP(w, r)
		return
	}
	// SPA fallback.
	r2 := r.Clone(r.Context())
	r2.URL.Path = "/"
	s.static.ServeHTTP(w, r2)
}
