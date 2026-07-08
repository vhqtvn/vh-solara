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
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/auth"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/procmgr"
	"github.com/vhqtvn/vh-solara/pkg/quota"
	"github.com/vhqtvn/vh-solara/pkg/render"
	"github.com/vhqtvn/vh-solara/pkg/skill"
	"github.com/vhqtvn/vh-solara/pkg/state"
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

	// failFast is the set of sessionIDs whose spawn requested the fail-closed
	// permission policy (unattended/automated spawning): when such a session
	// raises a permission prompt, the permission watcher auto-rejects it (never
	// "always") so an unattended worker can't hang on a prompt. SessionIDs are
	// globally unique opencode UUIDs, so one server-wide set is correct across
	// project dirs. IN-MEMORY ONLY: a server restart loses the binding, so a
	// fail_fast session that hits a prompt after restart would not be
	// auto-rejected. Acceptable because such sessions are short-lived relative to
	// server uptime, and the caller already has a backstop —
	// snapshot.permissions[sessionID] exposes the pending permission ID and the
	// caller can reject it via reply_permission itself.
	failFastMu sync.RWMutex
	failFast   map[string]struct{}

	// watcherOn + watcherMu guard the one-time, per-dir registration of the
	// fail-closed permission reconcile sweep on each project's store (idempotent
	// per dir, like aggHook). Registered from aggFor so the sweep is running
	// before any fail_fast session can be minted (the spawn that creates it
	// calls aggFor first).
	watcherMu sync.Mutex
	watcherOn map[string]bool

	// features are the capability modules mounted at startup (B). The
	// coordination verbs are the first one (dogfood).
	features []Feature

	// views holds consumer-registered reverse-proxy views (embedded sandboxed
	// iframes, peer to chat). Generic + policy-free; see views.go.
	views *viewRegistry

	// managed, when set by the daemon, owns repo-declared processes+views for
	// projects (.vh-solara/project.jsonc). nil = managed-projects disabled.
	managed *Orchestrator

	// aggHook, when set, is invoked for each project aggregator as it is touched
	// (default project and every lazily-created one) — the alerts engine uses it
	// to subscribe its detector to the project's store. Idempotent per dir.
	aggHook func(dir string, a *aggregator.Aggregator)
	// managedDefaultOnce guards the one-time managed-project open of the default
	// project (daemon cwd), triggered by the first request that touches it.
	managedDefaultOnce sync.Once
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

// version is the running daemon's build version ("dev" if unstamped) — the single
// source for /vh/version and the skill stamp, so they agree by construction.
func (s *Server) version() string {
	if s.appVersion != "" {
		return s.appVersion
	}
	return "dev"
}

// handleSkillEmit serves the version-stamped client skill generated from the
// RUNNING daemon's surface — the exact bytes `vh-solara skill emit` produces — so
// a consumer (e.g. in a container with no vh-solara binary) can fetch it over the
// socket and diff against its committed copy. Read-only; the version rides a
// header so a pin-match is one call. Provisioning (install) stays a host CLI step.
func (s *Server) handleSkillEmit(w http.ResponseWriter, r *http.Request) {
	v := s.version()
	w.Header().Set("Content-Type", "text/markdown; charset=utf-8")
	w.Header().Set("X-VH-Skill-Version", v)
	_, _ = io.WriteString(w, skill.Generate(v))
}

// SetRestartOpenCode wires the daemon's OpenCode-restart hook. Optional.
func (s *Server) SetRestartOpenCode(fn func(context.Context) error) { s.restartOC = fn }

// SetRestartServer wires the daemon's vh-server-restart hook (re-exec, or exit
// for a supervisor to relaunch). Optional.
func (s *Server) SetRestartServer(fn func()) { s.restartServer = fn }

// SetManaged installs the managed-project orchestrator (repo-declared processes
// + views). Optional; nil leaves managed projects disabled.
func (s *Server) SetManaged(o *Orchestrator) { s.managed = o }

// InitManaged builds and installs the managed-project orchestrator over the
// given process manager and trust store, sharing this server's view registry.
// cfgOverride ("") uses conventional .vh-solara/project.jsonc discovery;
// autoTrust is the headless escape hatch that approves configs without a prompt.
// Discovery is lazy for every project (default + ?dir=): the aggFor open hook
// fires on the first browser request that touches a project, so the returned
// orchestrator need not be driven by the caller.
func (s *Server) InitManaged(mgr *procmgr.Manager, trust *TrustStore, cfgOverride string, autoTrust bool) *Orchestrator {
	o := NewOrchestrator(mgr, trust, s.views, cfgOverride)
	o.autoTrust = autoTrust
	s.managed = o
	return o
}

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
		views:       newViewRegistry(),
		failFast:    map[string]struct{}{},
		watcherOn:   map[string]bool{},
	}
	return srv, nil
}

// aggFor returns the aggregator for a project directory, creating and starting
// one lazily for directories beyond the default. Concurrent-safe.
func (s *Server) aggFor(dir string) *aggregator.Aggregator {
	if dir == "" {
		// Managed-project hook for the DEFAULT project (daemon cwd). Fired on the
		// first request that touches it — i.e. an authenticated browser actually
		// opening the project — NOT at daemon boot, so a restart never silently
		// runs repo-declared commands with no operator present.
		if s.managed != nil {
			s.managedDefaultOnce.Do(func() { s.managed.OpenProject("") })
		}
		if s.aggHook != nil {
			s.aggHook("", s.agg)
		}
		s.ensurePermissionWatcher("", s.agg)
		return s.agg
	}
	s.aggMu.Lock()
	defer s.aggMu.Unlock()
	if a, ok := s.aggs[dir]; ok {
		return a
	}
	a := aggregator.NewForDirectory(s.opencodeURL, dir, s.ringCap)
	s.aggs[dir] = a
	// Managed-project hook: discover .vh-solara/project.jsonc, gate on trust, and
	// (if trusted) start declared processes + register views. Non-blocking; nil
	// when the daemon hasn't enabled managed projects.
	if s.managed != nil {
		s.managed.OpenProject(dir)
	}
	if s.aggHook != nil {
		s.aggHook(dir, a)
	}
	s.ensurePermissionWatcher(dir, a)
	go a.Run(context.Background())
	return a
}

// aggForExisting returns the aggregator for dir only if one already exists —
// WITHOUT creating it or firing the managed-project / open hooks. Request paths
// that must not have the side effect of opening a project (header stamping on an
// arbitrary ?dir=) use this, so a benign GET can't launch a project's managed
// processes or grow the aggregator map for an attacker-chosen directory. Returns
// the default aggregator for "" (already running) and nil for an unopened dir.
func (s *Server) aggForExisting(dir string) *aggregator.Aggregator {
	if dir == "" {
		return s.agg
	}
	s.aggMu.Lock()
	defer s.aggMu.Unlock()
	return s.aggs[dir]
}

// SetAggHook installs a per-project callback fired as each aggregator is touched
// (default + lazily-created). The alerts engine uses it to subscribe. Optional.
func (s *Server) SetAggHook(fn func(dir string, a *aggregator.Aggregator)) { s.aggHook = fn }

// registerFailFast records sessionID as a fail-closed-permission spawn. Called
// only on the fresh-execution path of a fail_fast spawn's idempotent handler,
// so a replay never double-registers. See the failFast field doc.
func (s *Server) registerFailFast(sessionID string) {
	s.failFastMu.Lock()
	defer s.failFastMu.Unlock()
	s.failFast[sessionID] = struct{}{}
}

// isFailFast reports whether sessionID was spawned with the fail-closed
// permission policy. Used by the permission watcher to decide auto-reject.
func (s *Server) isFailFast(sessionID string) bool {
	s.failFastMu.RLock()
	defer s.failFastMu.RUnlock()
	_, ok := s.failFast[sessionID]
	return ok
}

// failFastCount returns the number of registered fail-closed sessions. Test-only
// accessor (kept unexported, same-package); production reads isFailFast per id.
func (s *Server) failFastCount() int {
	s.failFastMu.RLock()
	defer s.failFastMu.RUnlock()
	return len(s.failFast)
}

// ensurePermissionWatcher arms the fail-closed permission reconcile sweep for a
// project's store, once per dir (idempotent, guarded by watcherOn). It is called
// from aggFor so it runs for the default project and every lazily-created dir,
// and — critically — BEFORE any fail_fast session can be minted: the spawn that
// creates such a session calls aggFor first, so the sweep is always running in
// time. The sweep keeps the POLICY in the web layer: for any pending permission
// whose session is registered fail_fast it auto-rejects (never "always") and
// records the observable fact on the store. The store stays policy-free.
//
// Why a reconcile sweep and not a live-tail subscriber: the store's emit() is
// lossy on overflow — a slow subscriber's channel is CLOSED and the subscriber
// is dropped, so a `for ev := range ch` watcher exits SILENTLY and never re-arms
// (watcherOn stays set), which defeated the fail-closed guarantee with no signal
// (F1). The guarantee must rest on a deterministic backstop, not on event
// delivery. So instead of subscribing to the lossy channel, this starts a
// goroutine that periodically reads the authoritative Snapshot and rejects
// pending fail_fast permissions. Bounded latency = permReconcileInterval.
type permissionEnv struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionID"`
}

func (s *Server) ensurePermissionWatcher(dir string, a *aggregator.Aggregator) {
	s.watcherMu.Lock()
	if s.watcherOn[dir] {
		s.watcherMu.Unlock()
		return
	}
	s.watcherOn[dir] = true
	s.watcherMu.Unlock()

	go s.runPermissionReconcile(a)
}

// permReconcileInterval is the period of the per-directory fail-closed
// permission reconcile sweep. It is the BOUNDED LATENCY of the fail-closed
// guarantee: a fail_fast session's pending permission is rejected within at most
// one interval of becoming pending, regardless of store event-tail loss (the
// sweep reads the authoritative Snapshot, not the lossy live-tail channel).
//
// 2s is a deliberate tradeoff: fast enough that an unattended spawn's prompt
// never hangs in practice, slow enough that an idle dir does negligible work
// (one Snapshot read per tick; a reject RPC fires only when a fail_fast perm is
// actually pending). Lower it if a deployment needs sub-second auto-reject.
const permReconcileInterval = 2 * time.Second

// permRejectTimeout bounds a single auto-reject RPC. Generous because the reject
// goes through the local opencode server, which may be briefly busy.
const permRejectTimeout = 10 * time.Second

// runPermissionReconcile is the per-directory fail-closed backstop. It does NOT
// depend on the store's lossy live-tail channel. Lifetime is PROCESS-LIFETIME:
// the goroutine runs for as long as this daemon owns the aggregator's store.
// There is no per-re-arm leak because ensurePermissionWatcher registers the
// sweep exactly once per dir (guarded by watcherOn). A shutdown context is
// intentionally omitted — on daemon exit the whole process (and the local
// opencode server it drives) goes away together, so the ticker simply stops.
func (s *Server) runPermissionReconcile(a *aggregator.Aggregator) {
	ticker := time.NewTicker(permReconcileInterval)
	defer ticker.Stop()
	store := a.Store()
	client := a.Client()
	// One sweep immediately on arming, so a permission already pending at
	// registration is rejected with ~0 latency instead of waiting a full tick.
	s.reconcileFailFastPerms(store, client)
	for range ticker.C {
		s.reconcileFailFastPerms(store, client)
	}
}

// reconcileFailFastPerms reads the authoritative store permission set and, for
// every PENDING permission whose session is registered fail_fast, rejects it
// (never "always") and records the observable permission_blocked fact. This
// makes fail-closed a bounded-latency guarantee even if every live-tail event is
// lost: the store's permission set is the source of truth, not the event stream.
//
// It uses PendingPermissions (read-locked, perms-only) rather than Snapshot:
// Snapshot materializes the entire view under the WRITE lock, which is wasted
// cost here since only permissions are read — and that write lock blocks
// incoming events and client-connect Snapshots for the duration of every sweep.
//
// Idempotent: a permission that was already replied/cleared between the perms
// read and the reject returns an error from ReplyPermission, which is swallowed
// (logged) — a stale reject is harmless and expected, since the sweep races the
// permission's normal clear path (store.Apply permission.replied deletes the perm
// before the next read, so a cleared perm is not re-rejected beyond the one
// in-flight race window). The client is the per-dir aggregator's Client() (same
// dir→client resolution the aggregator uses for every other write verb).
func (s *Server) reconcileFailFastPerms(store *state.Store, client *opencode.Client) {
	perms := store.PendingPermissions()
	for sessionID, plist := range perms {
		if !s.isFailFast(sessionID) {
			continue
		}
		for _, raw := range plist {
			var env permissionEnv
			if err := json.Unmarshal(raw, &env); err != nil || env.ID == "" || env.SessionID == "" {
				continue
			}
			// NEVER "always": no persistent grant, so a prompt can't widen what
			// the unattended worker is allowed to do.
			ctx, cancel := context.WithTimeout(context.Background(), permRejectTimeout)
			err := client.ReplyPermission(ctx, env.ID, sessionID, "reject")
			cancel()
			if err != nil {
				// Swallow: a stale/already-cleared permission errors here, the
				// expected outcome of an idempotent sweep racing the perm's clear.
				// Log so a genuine failure is observable, but never propagate —
				// the guarantee must not break on a benign reject race.
				vhlog.Error("permission reconcile: auto-reject failed",
					"sessionID", sessionID, "permissionID", env.ID, "err", err)
				continue
			}
			store.MarkPermissionBlocked(sessionID)
			vhlog.Info("permission reconcile: auto-rejected fail_fast permission",
				"sessionID", sessionID, "permissionID", env.ID)
		}
	}
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
	mux.HandleFunc("/vh/skill/emit", s.handleSkillEmit)
	mux.HandleFunc("/vh/version", func(w http.ResponseWriter, r *http.Request) {
		writeJSONResp(w, map[string]string{"version": s.version()})
	})
	mux.HandleFunc("/vh/snapshot", s.handleSnapshot)
	mux.HandleFunc("/vh/projects", s.handleProjects)
	mux.HandleFunc("/vh/views", s.handleViews)
	mux.HandleFunc("/vh/managed", s.handleManaged)
	mux.HandleFunc("/vh/project-settings", s.handleProjectSettings)
	mux.HandleFunc("/vh/project-settings/watch", s.handleProjectSettingsWatch)
	mux.HandleFunc("/vh/trust", s.handleTrust)
	mux.HandleFunc("/vh/theme.json", s.handleThemeJSON)
	mux.HandleFunc("/vh/theme.css", s.handleThemeCSS)
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
	// Fleet inventory + closeout reads for programmatic consumers (distinct
	// from /vh/archived above, which is the SPA's paginated archived-TREE
	// browser). See pkg/web/sessions.go for the /vh/sessions vs /vh/archived
	// distinction and the shaped schema.
	mux.HandleFunc("/vh/sessions", s.handleSessions)
	mux.HandleFunc("/vh/sessions/closeout", s.handleSessionsCloseout)
	mux.HandleFunc("/vh/reload", s.handleReload)
	mux.HandleFunc("/vh/restart-opencode", s.handleRestartOpenCode)
	mux.HandleFunc("/vh/restart-server", s.handleRestartServer)
	mux.HandleFunc("/vh/running-sessions", s.handleRunningSessions)
	mux.HandleFunc("/vh/term/ws", s.handleTerminalWS)
	mux.HandleFunc("/vh/term/list", s.handleTermList)
	mux.HandleFunc("/vh/term/kill", s.handleTermKill)
	mux.HandleFunc("/vh/git/status", s.handleGitStatus)
	mux.HandleFunc("/vh/git/stage", s.handleGitStage)
	mux.HandleFunc("/vh/git/unstage", s.handleGitUnstage)
	mux.HandleFunc("/vh/git/discard", s.handleGitDiscard)
	mux.HandleFunc("/vh/git/commit", s.handleGitCommit)
	mux.HandleFunc("/vh/git/push", s.handleGitPush)
	// Read-only codebase view.
	mux.HandleFunc("/vh/code/tree", s.handleCodeTree)
	mux.HandleFunc("/vh/code/file", s.handleCodeFile)
	mux.HandleFunc("/vh/code/raw", s.handleCodeRaw)
	mux.HandleFunc("/vh/code/search", s.handleCodeSearch)
	mux.HandleFunc("/vh/code/resolve", s.handleCodeResolve)
	mux.HandleFunc("/vh/code/status", s.handleCodeStatus)
	mux.HandleFunc("/vh/code/styles", s.handleCodeStyles)
	mux.HandleFunc("/vh/code/langs", s.handleCodeLangs)
	mux.HandleFunc("/vh/code/highlight.css", s.handleCodeHighlightCSS)
	mux.HandleFunc("/vh/opencode-version", s.handleOpenCodeVersion)
	mux.HandleFunc("/vh/update-opencode", s.handleUpdateOpenCode)
	mux.HandleFunc("/oc/", s.handlePassthrough)
	mux.HandleFunc("/", s.handleStatic)
	// Auth gates everything (login page + session); it sits inside securityHeaders
	// so the login page still gets CSP, and outside cors/csrf so an unauthenticated
	// request is challenged before reaching application logic. nil/ModeNone = no-op.
	return securityHeaders(s.auth.Middleware(s.cors(csrfGuard(logRequests(s.stampMeta(s.dispatchView(mux)))))))
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
			// Stamp from an EXISTING aggregator only — never open a project just to
			// stamp headers. An unopened dir falls back to the default store; the
			// real snapshot/stream endpoints (which do open it) carry the
			// authoritative seq anyway, so the epoch (worker identity) is what
			// matters here and is the same across this worker's stores.
			a := s.aggForExisting(reqDir(r))
			if a == nil {
				a = s.agg
			}
			st := a.Store()
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
	// 'self' (not 'none') so the app can frame its OWN pages — the code viewer
	// runs in a same-origin iframe to keep its heavy DOM out of the main
	// document. Cross-origin framing (clickjacking) is still blocked.
	"frame-ancestors 'self'",
}, "; ")

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Content-Security-Policy", contentSecurityPolicy)
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "SAMEORIGIN")
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

// projectInfo describes one bridged project instance (a per-directory aggregator)
// for the discovery endpoint.
type projectInfo struct {
	Dir      string `json:"dir"`   // project directory ("" = the worker's default project)
	Epoch    string `json:"epoch"` // store lifetime id (changes on daemon restart)
	Seq      uint64 `json:"seq"`   // current head seq for this project's store
	Sessions int    `json:"sessions"`
}

// handleProjects lists the project instances this worker currently bridges — one
// per directory (default "" plus any ?dir= touched). Machine-readable so a client
// over the socket can discover which projects are live and their (epoch, seq)
// before pinning a watch loop. A logical session is owned by exactly one project:
// the dir it was created under. Pass that same ?dir= (or x-opencode-directory
// header) on EVERY verb so spawn → snapshot → stream → abort/archive route to it.
func (s *Server) handleProjects(w http.ResponseWriter, r *http.Request) {
	s.aggMu.Lock()
	type entry struct {
		dir string
		agg *aggregator.Aggregator
	}
	live := make([]entry, 0, len(s.aggs))
	for dir, a := range s.aggs {
		live = append(live, entry{dir, a})
	}
	s.aggMu.Unlock()

	out := make([]projectInfo, 0, len(live))
	for _, e := range live {
		st := e.agg.Store()
		out = append(out, projectInfo{Dir: e.dir, Epoch: st.Epoch(), Seq: st.Head(), Sessions: len(st.SessionIDs())})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Dir < out[j].Dir })
	writeJSONResp(w, out)
}

// handleRunningSessions aggregates how many sessions are currently running ACROSS ALL
// workspaces the daemon manages — not just the one the SPA is viewing. Restarting
// OpenCode interrupts every workspace, so the restart-confirmation warning must reflect the
// whole fleet, and the SPA's per-workspace runningSessionCount() can't see beyond
// its own projectDir(). Each workspace aggregator shares the single opencodeURL
// (one OpenCode process we own), and a session belongs to exactly one dir,
// so summing RunningRoots() across aggregators can't double-count.
type runningWorkspaceInfo struct {
	Dir   string `json:"dir"`
	Count int    `json:"count"`
}

type runningSessionsResp struct {
	Count      int                   `json:"count"`
	Workspaces []runningWorkspaceInfo `json:"workspaces"`
}

func (s *Server) handleRunningSessions(w http.ResponseWriter, r *http.Request) {
	type entry struct {
		dir string
		agg *aggregator.Aggregator
	}
	s.aggMu.Lock()
	live := make([]entry, 0, len(s.aggs))
	for dir, a := range s.aggs {
		live = append(live, entry{dir, a})
	}
	s.aggMu.Unlock()

	resp := runningSessionsResp{}
	for _, e := range live {
		n := e.agg.Store().RunningRoots()
		resp.Count += n
		if n > 0 {
			resp.Workspaces = append(resp.Workspaces, runningWorkspaceInfo{Dir: e.dir, Count: n})
		}
	}
	sort.Slice(resp.Workspaces, func(i, j int) bool { return resp.Workspaces[i].Dir < resp.Workspaces[j].Dir })
	writeJSONResp(w, resp)
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

// triggerMessageLoad is the NON-BLOCKING counterpart of ensureMessages used on
// the Stream 2 first-open path: it kicks off async hydration (EnsureMessagesAsync)
// for unloaded selected sessions and returns immediately, so handleStream can
// send the snapshot at once and then forward the message.*/part.* deltas +
// messages.loaded completion over the same open connection as the background
// fetch reconciles. This is what makes selecting an unloaded session fast on
// first open. No-op (deduped to one in-flight fetch) for already-loaded or
// in-flight sessions. NOTE: handleSnapshot (the one-shot GET) intentionally
// keeps the SYNCHRONOUS ensureMessages above — a snapshot consumer expects the
// full current view in the response body.
func (s *Server) triggerMessageLoad(agg *aggregator.Aggregator, filter map[string]bool) {
	if filter == nil { // "all" — explicit firehose; async-trigger every unloaded session
		for _, id := range agg.Store().SessionIDs() {
			agg.EnsureMessagesAsync(context.Background(), id)
		}
		return
	}
	for id := range filter {
		agg.EnsureMessagesAsync(context.Background(), id)
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

	// Honest conn: flush a no-op SSE comment IMMEDIATELY so the client's onopen
	// fires at handler entry (Go sends response headers on the first Write/Flush;
	// without this, onopen is delayed until the trailing snapshot flush, so ALL
	// pre-flush work — including Snapshot compute — is silently charged to the
	// client's `conn` measurement and `server/snap` reads ~0ms). The comment line
	// is ignored by EventSource (a `:`-prefixed line per the SSE spec) but it
	// forces the headers out, making `conn` transport-only (DNS/TCP/tunnel-
	// setup/slot-queuing) and letting subsequent server compute show up honestly
	// in `server/snap`. Do NOT move/remove the existing snapshot flush below.
	fmt.Fprintf(w, ": hello\n\n")
	flusher.Flush()

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
		if !strings.HasPrefix(kind, "message.") && !strings.HasPrefix(kind, "part.") && !strings.HasPrefix(kind, "messages.") {
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
	//
	// Push the interest filter UPSTREAM into the store subscription: irrelevant
	// token-delta floods (re-emitted by the store as part.upsert) never enter
	// this stream's channel. Before this, a structural-only tree stream's 256-slot
	// channel could fill with background message/part events it discards at the
	// egress sendable() check below, queueing a trailing session.upsert behind
	// them ("session appeared late"). The downstream sendable() stays as a
	// DEFENSIVE compatibility check (do not remove); the important guarantee is
	// that excluded events never enter the channel. filter == nil (?sessions=all)
	// → firehose Interest; a non-nil filter (incl. empty, the tree-only Stream 1)
	// → message-class events restricted to the selected sessions.
	interest := state.Interest{MessageSessions: filter}
	ch, unsub := store.SubscribeWith(256, interest)
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
		// NON-BLOCKING hydration: kick the upstream fetch off in the background
		// (EnsureMessagesAsync) so the snapshot sends immediately, then forward
		// message.*/part.* deltas + messages.loaded over this same connection as
		// the fetch reconciles. Subscribe-before-trigger is preserved (we
		// subscribed above) so no completion event slips through the gap.
		s.triggerMessageLoad(agg, filter)
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
			if ev.Kind == "notice" {
				// Transient alert (state.KindNotice): not part of the replayable
				// view and it reuses the current head seq, so forward it WITHOUT the
				// seq-baseline guard and WITHOUT an id line (don't move the resume
				// cursor). A resuming client never replays it.
				fmt.Fprintf(w, "event: notice\ndata: %s\n\n", ev.Payload)
				flusher.Flush()
				continue
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
