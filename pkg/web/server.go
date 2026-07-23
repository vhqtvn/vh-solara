// Package web serves the vh-solara client UI plus the client-agnostic
// snapshot/resume protocol backed by the daemon's materialized state, and
// passes write operations through to the local OpenCode server.
package web

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"embed"
	"encoding/base64"
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
	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
	"github.com/vhqtvn/vh-solara/pkg/oclife"
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

	// staticPaths is the set of embedded static file paths, built lazily on the
	// first handleStatic call so the real-asset-vs-SPA-route probe is a cheap
	// map lookup instead of an embed Open+Close that http.FileServer then
	// repeats on the same path.
	staticPathsOnce sync.Once
	staticPaths     map[string]bool

	quotaMu    sync.Mutex
	quotaCache *quota.Report
	quotaAt    time.Time

	// restartOC, when set by the daemon, restarts the managed OpenCode process.
	// nil in environments that don't manage OpenCode (e.g. the fixture server).
	restartOC func(context.Context) error
	// externalOC reports whether OpenCode is attached externally (--opencode-url)
	// rather than spawned/co-located by this daemon. Drives the direct-DB
	// unarchive topology guard (pkg/web/archive.go): in external mode the local DB
	// file is NOT guaranteed to be the remote instance's DB, so unarchive refuses
	// unless VH_OPENCODE_DB_PATH is set. Default false (spawned topology).
	externalOC    bool
	restartServer func()
	ocVersionFn   func(context.Context) (installed, running, latest string, err error)
	ocUpdateFn    func(ctx context.Context, w io.Writer) error
	ocChangelogFn OpenCodeChangelogFn // optional; nil → /vh/opencode-changelog returns available=false
	appVersion    string              // this vh-solara build's version (set by the daemon)

	// ocLifecycle is the worker-local OpenCode lifecycle, exposed at
	// /vh/opencode/status. nil on servers that don't manage an OpenCode (e.g.
	// the fixture server); the handler returns 503 in that case. Set by the
	// daemon (client-daemon.go) after the topology is known.
	ocLifecycle *oclife.Lifecycle

	// corsOrigins is the explicit allowlist of cross-origin callers. Empty =
	// no CORS (strict same-origin). "*" allows any origin (which disables the
	// cross-origin half of the CSRF protection — only set it if you mean it).
	corsOrigins []string

	// auth, when set, gates the whole server (login + session). nil = no auth
	// (only safe on a loopback bind; see auth.CheckBindSafety).
	auth *auth.Authenticator

	// idem dedups typed write verbs by their idempotency_key (A1).
	idem *idemCache

	// queues is the backend-authoritative per-session message queue registry,
	// keyed by (project root, sessionID). One store per session; lazy-loaded;
	// durable via .vh-solara/sessions/<id>/queue.json. See queue.go.
	queues *queueRegistry

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
	//
	// watcherCancel holds the per-dir cancel func for the sweep goroutine, so a
	// non-default dir's sweep can be stopped cleanly when Reload drops its
	// aggregator (stopPermissionWatcher). The default dir's sweep ("") has no
	// stopper: it is process-lifetime and is never reloaded. Both maps are
	// guarded by watcherMu.
	watcherMu     sync.Mutex
	watcherOn     map[string]bool
	watcherCancel map[string]context.CancelFunc

	// queueGCMu + queueGCOn guard the one-time, per-dir installation of the
	// queue-GC session.delete subscriber (FIX-QUEUE-GC-2). The subscriber is
	// installed from aggFor for the default project AND every lazily-created
	// per-dir aggregator, and must run exactly once per (dir, aggregator)
	// pair: aggFor("") returns s.agg on every default-project request and
	// would otherwise spawn a fresh goroutine + channel per call.
	//
	// Lifecycle: the goroutine exits naturally when the store closes its
	// subscriber channels — store.Close() is called from a.Stop() during
	// handleReloadProject (per-dir teardown) and at process exit (default).
	// The returned unsubscribe func is intentionally discarded: store.Close
	// clears the subs entry itself, so there is no goroutine/channel leak.
	queueGCMu sync.Mutex
	queueGCOn map[string]bool

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

	// Background-task lifecycle. The post-archive re-assert goroutine
	// (handleArchive) is owned by the Server, not the HTTP request: it derives
	// its context from bgCtx (so Shutdown cancels it) and registers with bgWG
	// (so Shutdown awaits it). This replaces the prior fire-and-forget
	// goroutine that read a mutable package-level delay — a cross-test data
	// race under -race. bgCtx/bgCancel are created once in NewServer and never
	// reassigned; bgCancel is idempotent (safe for Shutdown to call repeatedly).
	// bgMu guards reassertDelay (a test seam): the re-assert goroutine captures
	// the delay + bgCtx under bgMu BEFORE launch and passes them as args, so it
	// never reads shared mutable state after dispatch — eliminating the race.
	bgMu          sync.Mutex
	bgCtx         context.Context
	bgCancel      context.CancelFunc
	bgWG          sync.WaitGroup
	reassertDelay time.Duration
	// Test-only seams for the Issue-A ownership test (nil in production).
	// reassertReadyCh, if set, is closed once when reassertArchive reaches its
	// post-delay block point. reassertBlockCh, if set, makes reassertArchive
	// block on a pure (ctx-independent) receive from it — so a test can hold
	// the goroutine in a spot Shutdown's bgCancel CANNOT reach, proving the
	// only way Shutdown returns is by awaiting bgWG. Guarded by bgMu for the
	// one-shot close of reassertReadyCh.
	reassertReadyCh chan struct{}
	reassertBlockCh chan struct{}
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

// SetExternalOpenCode records whether OpenCode is attached externally
// (--opencode-url) rather than spawned/co-located by this daemon. Drives the
// direct-DB unarchive topology guard in pkg/web/archive.go.
func (s *Server) SetExternalOpenCode(external bool) { s.externalOC = external }

// SetOpenCodeLifecycle wires the worker-local OpenCode lifecycle so it is
// reachable at /vh/opencode/status. The lifecycle is the p1-oc-001 decoupling
// hinge: a fatal OpenCode startup failure is recorded as a failed state here
// instead of killing the worker, so the operator can observe + restart
// OpenCode through the tunnel while the worker keeps reporting.
func (s *Server) SetOpenCodeLifecycle(l *oclife.Lifecycle) { s.ocLifecycle = l }

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

	bgCtx, bgCancel := context.WithCancel(context.Background())
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		bgCancel()
		return nil, err
	}
	srv := &Server{
		agg:           agg,
		proxy:         rp,
		staticFS:      sub,
		renderer:      render.New(),
		static:        http.FileServer(http.FS(sub)),
		opencodeURL:   opencodeURL,
		ringCap:       ringCapacity,
		aggs:          map[string]*aggregator.Aggregator{"": agg},
		idem:          newIdemCache(10 * time.Minute),
		features:      defaultFeatures(),
		views:         newViewRegistry(),
		queues:        newQueueRegistry(),
		failFast:      map[string]struct{}{},
		watcherOn:     map[string]bool{},
		watcherCancel: map[string]context.CancelFunc{},
		queueGCOn:     map[string]bool{},
		bgCtx:         bgCtx,
		bgCancel:      bgCancel,
		reassertDelay: defaultReassertDelay,
	}
	// Arm the DEFAULT aggregator synchronously, BEFORE the server can serve
	// any HTTP request. The default aggregator is created in the daemon
	// (cmd/local-server.go / cmd/client-daemon.go) and started with plain
	// `go agg.Run(vhCtx)`; without this synchronous arm there is no
	// happens-before guarantee that Run sets armed=true before the HTTP
	// listener accepts its first request. In that window the defense-in-depth
	// backstop in EnsureMessages/EnsureMessagesAsync (project-isolation:
	// armed && !HasSession → silent no-op) would be disabled on the default
	// project, and ShouldServeSession would return true (fail-open) for any
	// foreign id. Mirrors the synchronous a.Arm() inside aggFor for
	// per-directory aggregators. Run's later a.armed = true is a redundant
	// no-op (Arm is idempotent — same value, same lock). See the armed field
	// doc in pkg/aggregator/aggregator.go for the full model.
	agg.Arm()
	return srv, nil
}

// SetReassertDelay overrides the per-Server re-assert delay (a test seam that
// replaces the prior mutable package global). Must be called before the archive
// request whose re-assert it should affect; the delay is captured under bgMu at
// goroutine-launch time, so the launched goroutine never reads shared mutable
// state. No-op-safe with concurrent reads because both the read (at launch) and
// this write are under bgMu.
func (s *Server) SetReassertDelay(d time.Duration) {
	s.bgMu.Lock()
	s.reassertDelay = d
	s.bgMu.Unlock()
}

// Shutdown cancels the Server's background-task lifetime (bgCtx) and awaits
// outstanding background work (bgWG), bounded by ctx. It is idempotent: bgCancel
// is safe to call repeatedly. The daemon's restart and KillFunc paths call this
// so a re-assert goroutine in flight is cancelled (its ListSessions ctx is a
// child of bgCtx) and awaited before the process exits — no detached goroutine
// outlives the Server. Returns ctx.Err() if the await is bounded by ctx.
func (s *Server) Shutdown(ctx context.Context) error {
	s.bgCancel() // idempotent; never reassigned after NewServer
	waitDone := make(chan struct{})
	go func() { s.bgWG.Wait(); close(waitDone) }()
	select {
	case <-waitDone:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
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
		s.installQueueGCCleanup("", s.agg)
		return s.agg
	}
	s.aggMu.Lock()
	defer s.aggMu.Unlock()
	if a, ok := s.aggs[dir]; ok {
		return a
	}
	a := aggregator.NewForDirectory(s.opencodeURL, dir, s.ringCap)
	// Arm synchronously BEFORE storing / returning, so no HTTP request can
	// observe an unarmed production aggregator. Without this, a GET
	// /vh/sessions/closeout?dir=<fresh-project>&id=<foreign-id> that wins the
	// race against the RunManaged goroutine below would see
	// ShouldServeSession==true (fail-open) and leak the foreign project's
	// messages via the project-blind Client().Messages upstream. The DEFAULT
	// aggregator is armed analogously by NewServer; Run's later a.armed = true
	// is a redundant no-op for both paths. See the armed field doc in
	// pkg/aggregator/aggregator.go for the full model.
	a.Arm()
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
	s.installQueueGCCleanup(dir, a)
	// Run under a context the aggregator itself can cancel via Stop(), so
	// handleReloadProject can drop ONE project (a.Stop()) without disturbing the
	// default or any other project. RunManaged derives the cancellable child and
	// arms a.cancel internally.
	go a.RunManaged(context.Background())
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
	ctx, cancel := context.WithCancel(context.Background())
	s.watcherOn[dir] = true
	s.watcherCancel[dir] = cancel
	s.watcherMu.Unlock()

	go s.runPermissionReconcile(ctx, a)
}

// queueGCSubscribeBuffer is the per-subscriber channel buffer for the queue-GC
// session.delete subscriber. session.delete is a STRUCTURAL event (not
// message-class), so the subscriber passes Interest{MessageSessions: empty{}} to
// drop ALL message-class events at fanout — only session.* / activity / status /
// permission / question / notice / unread events reach the channel. These are
// low-frequency compared to the message/part token-delta flood, so 128 slots is
// ample headroom against realistic bursts.
//
// IMPORTANT non-durability caveat (mirrors ensurePermissionWatcher's doc): the
// store's emit() does NONBLOCKING fanout — on channel-overflow the channel is
// CLOSED and the subscriber is silently DROPPED. If that happens this goroutine
// exits and queue cleanup stops firing on session.delete for this aggregator
// until process restart (default aggregator) or Reload-project (per-dir
// aggregator) rebuilds it. This is INTENTIONAL and accepted: queue cleanup is
// also driven DIRECTLY by the /vh/archive handler (so archive correctness never
// depends on subscriber delivery), and the deferred GC-3 slice will add
// authoritative filesystem reconciliation as a periodic backstop that catches
// orphans regardless of subscriber state. Per Settled Assumption #8 the
// subscriber is best-effort only.
const queueGCSubscribeBuffer = 128

// installQueueGCCleanup arms the queue-GC session.delete subscriber on a's
// store, once per (dir, aggregator) pair (idempotent, guarded by queueGCOn).
// It is called from aggFor so it runs for the default project AND every
// lazily-created per-dir aggregator, before any HTTP request can observe a
// queue-owning session that has already been deleted upstream.
//
// Why a live-tail subscriber is acceptable here but NOT for the fail-closed
// permission watcher (ensurePermissionWatcher, which uses a deterministic
// reconcile sweep): the permission watcher enforces a SAFETY guarantee that
// MUST fire on every match — a silently-dropped subscriber would let an
// unattended prompt hang with no signal. Queue GC is a CLEANUP optimization:
// the /vh/archive path already deletes the queue DIRECTLY (so operator-driven
// archive is correct even with zero subscriber delivery), and a missed
// session.delete just leaves an orphan queue.json that GC-3 will eventually
// reap. Idempotent cleanup means the direct path + subscriber path compose
// without harm.
//
// Async delivery (verified in pkg/state/store.go emit/Subscribe): emit() does a
// nonblocking send under the store lock; the consumer reads from the channel in
// its OWN goroutine, so CleanupSession's filesystem os.Remove never holds the
// store lock. No buffered-channel/worker indirection is needed.
//
// Lifecycle: the goroutine ranges over the channel until the store closes it.
// store.Close() (called from aggregator.Stop() during handleReloadProject and
// at process exit) closes every subscriber channel and clears the subs map, so
// this goroutine exits cleanly with no leak. The unsubscribe func returned by
// Subscribe is intentionally discarded — store.Close already removes the subs
// entry, so there is nothing to leak. queueGCOn[dir] stays true across a
// Reload-project cycle: the dir's aggregator is deleted from s.aggs so the NEXT
// aggFor(dir) builds a FRESH aggregator (new store, new subs map), and
// installQueueGCCleanup sees queueGCOn[dir]==true and skips. That is the WRONG
// behavior (the new aggregator's store is never subscribed) — so
// handleReloadProject resets queueGCOn[dir] after tearing down the old
// aggregator. See the call site there.
func (s *Server) installQueueGCCleanup(dir string, a *aggregator.Aggregator) {
	s.queueGCMu.Lock()
	if s.queueGCOn[dir] {
		s.queueGCMu.Unlock()
		return
	}
	s.queueGCOn[dir] = true
	s.queueGCMu.Unlock()

	// FIX-QUEUE-GC-3: install the orphan-queue reconciliation callback on this
	// aggregator. The callback fires from hydrate's goroutine at the end of
	// every successful hydrate (startup, reconnect, post-reload) and dispatches
	// the actual scan+cleanup to a fresh goroutine so hydrate is never blocked.
	// This wiring shares installQueueGCCleanup's queueGCOn guard lifecycle:
	// installed once per (dir, aggregator), and handleReloadProject resets
	// queueGCOn[dir] when it tears down the old aggregator so the fresh
	// aggregator built by aggFor gets a fresh callback. The immediate-run
	// branch covers the default aggregator, which is started (and hydrated) by
	// the daemon BEFORE the first HTTP request reaches aggFor("") — without it,
	// the default dir's orphans would only be cleaned after the NEXT hydrate
	// (i.e. the next reconnect), not the one that already happened at boot.
	a.SetOnHydrate(func() { go s.reconcileQueuesForAgg(dir, a) })
	if a.HydratedOnce() {
		go s.reconcileQueuesForAgg(dir, a)
	}

	root, err := projectRoot(dir)
	if err != nil {
		// projectRoot only fails if os.Getwd (default dir) or filepath.Abs
		// (per-dir) fails — both effectively never. If it somehow does, leave
		// queueGCOn[dir]==true so we don't retry uselessly on every request,
		// and rely on /vh/archive's direct cleanup + GC-3 backstop.
		vhlog.Error("queue-GC subscriber not installed: projectRoot failed", "dir", dir, "err", err)
		return
	}
	store := a.Store()
	// Drop ALL message-class events at fanout — we only care about the
	// structural session.delete event. An empty (non-nil) MessageSessions map
	// means "deliver message-class events only for sessions in the set", and an
	// empty set drops them all (see state.Interest.wants).
	ch, _ := store.SubscribeWith(queueGCSubscribeBuffer, state.Interest{MessageSessions: map[string]bool{}})
	go func() {
		for ev := range ch {
			if ev.Kind != state.KindSessionDelete {
				continue
			}
			var p struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(ev.Payload, &p) != nil || p.ID == "" {
				continue
			}
			// Sanitize the id the same way /vh/archive does (safeID strips
			// anything that could escape the session directory on disk).
			sid := safeID.ReplaceAllString(p.ID, "")
			if sid == "" {
				continue
			}
			s.queues.CleanupSession(root, sid)
		}
	}()
}

// reconcileQueuesForAgg is the per-aggregator driver for FIX-QUEUE-GC-3
// orphan-queue reconciliation. It is the glue between the aggregator's
// post-hydrate signal (SetOnHydrate / HydratedOnce, installed in
// installQueueGCCleanup) and the queueRegistry's reconcileOrphanQueues scan.
//
// FAIL-CLOSED gate: if a.HydratedOnce() is false, the aggregator has not yet
// produced an authoritative active-session set, so this function returns
// WITHOUT deleting anything. The empty active-set case (hydrate succeeded with
// zero sessions) is the OPPOSITE: HydratedOnce is true, SessionIDs returns an
// empty slice, reconcileOrphanQueues receives an empty non-nil map, and every
// on-disk queue is correctly treated as an orphan. This is the distinction
// GC-3 exists to enforce — see the field doc on Aggregator.hydratedOnce.
//
// Active-set source: a.Store().SessionIDs() returns the store's current session
// IDs under RLock. This is the SAME authoritative set store.Hydrate just
// installed (hydrate calls store.Hydrate BEFORE firing onHydrate, and
// SessionIDs reads the map Hydrate writes). Calling it AFTER the HydratedOnce
// gate guarantees we read a set produced by a completed hydrate, not a
// stale/pre-hydrate map.
//
// Root derivation: projectRoot(dir), matching installQueueGCCleanup's GC-2
// subscriber. A root-resolution failure logs and returns (no deletion) —
// projectRoot only fails if os.Getwd/filepath.Abs fail, which is effectively
// never in practice.
//
// Concurrency: dispatched to a fresh goroutine by the onHydrate callback (so
// hydrate's goroutine is never blocked) and by the immediate-run branch in
// installQueueGCCleanup (default-aggregator boot case). Multiple concurrent
// invocations for the same dir are safe — reconcileOrphanQueues serializes its
// per-session work through queueRegistry.mu, and CleanupSession is idempotent.
func (s *Server) reconcileQueuesForAgg(dir string, a *aggregator.Aggregator) {
	// FAIL-CLOSED: no authoritative set yet → delete nothing.
	if !a.HydratedOnce() {
		return
	}
	root, err := projectRoot(dir)
	if err != nil {
		vhlog.Error("queue reconcile: projectRoot failed", "dir", dir, "err", err)
		return
	}
	store := a.Store()
	ids := store.SessionIDs()
	active := make(map[string]bool, len(ids))
	for _, id := range ids {
		active[id] = true
	}
	// GC-3 race closure (FIX-QUEUE-GC-3-RACE): re-validate each orphan
	// candidate at T2 (immediately before deletion) against the live store.
	// A session created between the T1 inventory snapshot above (SessionIDs)
	// and this T2 scan would otherwise have its fresh queue.json deleted as
	// an orphan. The recheck narrows the race window to T2.recheck→T2.delete,
	// which is the GC-2 pattern (a different, accepted hazard — see the
	// "GC-2 hazard — OPEN" block in reconcileOrphanQueues's doc comment).
	if err := s.queues.reconcileOrphanQueues(root, active, func(sid string) bool {
		return store.HasSession(sid)
	}); err != nil {
		vhlog.Error("queue reconcile failed", "dir", dir, "root", root, "err", err)
	}
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
// depend on the store's lossy live-tail channel.
//
// Lifetime: the DEFAULT dir's sweep ("") is PROCESS-LIFETIME — the goroutine
// runs for as long as this daemon owns the default aggregator's store, and its
// ctx is never cancelled by Reload (handleReloadProject skips teardown for the
// default dir). A NON-DEFAULT dir's sweep is STOPPABLE: stopPermissionWatcher
// cancels its ctx when handleReloadProject drops that dir's aggregator, so the
// goroutine exits promptly instead of ticking forever on an orphaned store. On
// daemon exit the whole process (and the local opencode server it drives) goes
// away together, so any still-running sweep's ticker simply stops.
//
// There is no per-re-arm leak: ensurePermissionWatcher registers the sweep
// exactly once per dir (guarded by watcherOn), and after Reload clears
// watcherOn[dir] a subsequent aggFor(dir) re-arms a FRESH sweep.
func (s *Server) runPermissionReconcile(ctx context.Context, a *aggregator.Aggregator) {
	ticker := time.NewTicker(permReconcileInterval)
	defer ticker.Stop()
	store := a.Store()
	client := a.Client()
	// One sweep immediately on arming, so a permission already pending at
	// registration is rejected with ~0 latency instead of waiting a full tick.
	s.reconcileFailFastPerms(store, client)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.reconcileFailFastPerms(store, client)
		}
	}
}

// stopPermissionWatcher stops and clears the per-dir fail-closed permission
// reconcile sweep for dir. It is a safe no-op if dir has no armed sweep. Called
// from handleReloadProject's non-default teardown branch so the sweep goroutine
// exits instead of ticking forever on the dropped aggregator's orphaned store.
// The DEFAULT dir ("") is never passed here — its sweep is process-lifetime.
func (s *Server) stopPermissionWatcher(dir string) {
	s.watcherMu.Lock()
	defer s.watcherMu.Unlock()
	if cancel, ok := s.watcherCancel[dir]; ok {
		cancel()
		delete(s.watcherCancel, dir)
	}
	delete(s.watcherOn, dir)
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
	// PROBE diagnostic exposure: read-only GET, auth-gated like every other
	// /vh/* route (Auth.Middleware wraps the whole mux). GET-only so NO
	// X-VH-CSRF exception is needed (CSRF defense applies to unsafe methods
	// only). Emits bounded aggregates only — no raw transcript/session/URL.
	mux.HandleFunc("/vh/diag/latency", diag.Handler().ServeHTTP)
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
	// Backend-authoritative per-session message queue (GET/POST list+enqueue,
	// claim, resolve, delete). Under /vh/* (beside the other write verbs), NOT
	// under /oc/* which stays a transparent proxy. Method-routed via Go 1.22
	// patterns; CSRF is enforced by csrfGuard on the unsafe methods.
	mux.HandleFunc("GET /vh/session/{sessionId}/queue", s.handleQueueList)
	mux.HandleFunc("POST /vh/session/{sessionId}/queue", s.handleQueueEnqueue)
	mux.HandleFunc("DELETE /vh/session/{sessionId}/queue/{itemId}", s.handleQueueRemove)
	mux.HandleFunc("POST /vh/session/{sessionId}/queue/claim", s.handleQueueClaim)
	mux.HandleFunc("POST /vh/session/{sessionId}/queue/{itemId}/resolve", s.handleQueueResolve)
	// Transcript-windowing historical-page endpoint (Phase 2). GET-only: serves
	// one bounded page of OLDER messages (?before=<id>) for prepend/merge-by-id
	// on the client. Distinct from the cold-load messages.batch SSE path: this
	// emits NO events and NO messages.batch/messages.loaded — only a one-shot
	// MessagePageResult JSON envelope. csrfGuard exempts GET, so no CSRF
	// exception is needed. See pkg/web/messages_http.go for the contract.
	mux.HandleFunc("GET /vh/session/{sessionId}/messages", s.handleSessionMessages)
	// Phase 4 lazy-expand endpoint: GET → no CSRF. Returns a projected snapshot
	// (cause:"lazy-expand") with the children of the given frontier stub
	// materialized as full sessions, plus stubs for the grandchildren. The
	// client merges it via the projected merge path (upsert sessions + stubs).
	// Continuation-based pagination via ?cursor=<last-child-id>; the next
	// cursor (if more children remain) is returned as X-VH-Branch-Cursor.
	mux.HandleFunc("GET /vh/sessions/branch", s.handleBranch)
	// Phase 2 tree=2 expand endpoint: GET → no CSRF (mirrors handleBranch).
	// Returns a node.children page for lazy-loading direct children of a
	// collapsed frontier node. See pkg/web/tree_children.go for the contract.
	mux.HandleFunc("GET /vh/tree/children", s.handleTreeChildren)
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
	mux.HandleFunc("/vh/reload-project", s.handleReloadProject)
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
	mux.HandleFunc("/vh/opencode-changelog", s.handleOpenCodeChangelog)
	mux.HandleFunc("/vh/update-opencode", s.handleUpdateOpenCode)
	// OpenCode lifecycle snapshot (owned/detached/external topology + state +
	// capabilities). GET-only; auth-gated like the other /vh/* routes. This is
	// the p1-oc-001 decoupling surface: it is served DIRECTLY (no OpenCode
	// dial), so it answers even when OpenCode has crashed and its port refuses
	// connections — which is exactly when the operator most needs to see it.
	mux.HandleFunc("/vh/opencode/status", s.handleOpenCodeStatus)
	// OpenCode log tail + restart (Slice 2). The log tail is a bounded read of
	// the lifecycle ring (owned/detached only); restart triggers the daemon's
	// restartOpencodeLocked via the existing restartOC hook. Both are
	// capability-aware: an external topology gets 501 (logs) / 405 (restart)
	// instead of fake data. Auth-gated like the other /vh/* routes; the restart
	// POST is CSRF-protected by csrfGuard.
	mux.HandleFunc("/vh/opencode/logs", s.handleOpenCodeLogs)
	mux.HandleFunc("/vh/opencode/restart", s.handleOpenCodeRestart)
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
//
// GET /vh/snapshot is also logged: it is the one-shot snapshot path whose
// server time is the daemon-side signal for warm-session hydrate latency (the
// frontend's conn·server·hydrate diagnostic line is the only other signal).
// GET /vh/stream is intentionally NOT logged — it is a long-lived EventSource,
// so its dur_ms would be the whole stream lifetime (minutes/hours), useless for
// measuring first-snapshot latency.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Path
		interesting := strings.HasPrefix(p, "/oc/") ||
			(strings.HasPrefix(p, "/vh/") && r.Method != http.MethodGet) ||
			(p == "/vh/snapshot" && r.Method == http.MethodGet)
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
	Dir   string `json:"dir"`   // project directory ("" = the worker's default project)
	Epoch string `json:"epoch"` // store lifetime id (changes on daemon restart)
	Seq   uint64 `json:"seq"`   // current head seq for this project's store
	Roots int    `json:"roots"` // live ROOT session count (children/archived excluded)
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
		out = append(out, projectInfo{Dir: e.dir, Epoch: st.Epoch(), Seq: st.Head(), Roots: st.RootCount()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Dir < out[j].Dir })
	// State-like GET: the response is computed fresh on every call from live
	// aggregator state (root count, head seq, epoch) — a stale browser/intermediary
	// cache hit would defeat the entire point of the endpoint (cross-project
	// discovery + counts). Mark it uncachable so a dialog re-open never paints
	// pre-change counts. (Client fetches also pass cache:'no-store' as a belt-
	// and-suspenders guard against intermediaries that ignore Cache-Control.)
	w.Header().Set("Cache-Control", "no-store")
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
	Count      int                    `json:"count"`
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
	// State-like GET: same rationale as handleProjects — the count is recomputed
	// live on every call (sum of per-aggregator RunningRoots), and a cached
	// response would lie about how many sessions a restart would interrupt.
	w.Header().Set("Cache-Control", "no-store")
	writeJSONResp(w, resp)
}

func (s *Server) handleSnapshot(w http.ResponseWriter, r *http.Request) {
	w = diag.NewHandlerBytesWriter(w, diag.ProxyPathSnapshot) // PROBE 8: attribute non-stream tunnel bytes
	agg := s.aggFor(reqDir(r))
	filter := messageFilter(r)
	filter = s.projectScopedFilter(agg, filter)
	s.ensureMessages(r.Context(), agg, filter)
	snap := agg.Store().Snapshot(filter)
	b, err := json.Marshal(snap)
	if err != nil {
		// snap is a well-typed *state.Snapshot, so this cannot fail today; but a
		// silent discard would mask a future regression. Surface it as a 500
		// instead of writing a nil slice (which would emit "null" as the body).
		vhlog.Error("snapshot: marshal failed", "dir", reqDir(r), "err", err)
		http.Error(w, "snapshot marshal failed", http.StatusInternalServerError)
		return
	}
	// gzip64-wrap on the same opt-in (z=1) + threshold as the stream snapshot.
	// fetchSessionMessages (refreshOpenSessions) pulls these on a tree reconnect
	// for every open session — each was shipping a full uncompressed transcript
	// through the tunnel. Application-level gzip64 (not HTTP Content-Encoding)
	// so it is tunnel-agnostic: the controller raw-proxies the body verbatim
	// (io.Copy in pkg/server/proxy.go) and the client decodes unconditionally.
	// A client that did not opt in (no z=1) gets the legacy raw JSON unchanged.
	w.Header().Set("Content-Type", "application/json")
	w.Write(maybeCompressSnapshot(b, wantsCompress(r)))
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

// handleBranch serves the lazy-expand endpoint (Phase 4): GET /vh/sessions/
// branch?id=<frontier-id>&cursor=<last-child-id>. Returns a projected snapshot
// with the children of the given frontier stub materialized as full sessions,
// plus stubs for their idle descendants. Continuation-based: the next cursor
// (if more children remain) is returned as X-VH-Branch-Cursor. GET → no CSRF.
// Pure read — no state mutation, no message hydration (the client fetches
// messages on demand for individual sessions).
func (s *Server) handleBranch(w http.ResponseWriter, r *http.Request) {
	w = diag.NewHandlerBytesWriter(w, diag.ProxyPathBranch) // PROBE 8: attribute non-stream tunnel bytes
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}
	agg := s.aggFor(reqDir(r))
	if agg == nil {
		http.Error(w, "project not found", http.StatusNotFound)
		return
	}
	cursor := r.URL.Query().Get("cursor")
	limitStr := r.URL.Query().Get("limit")
	limit := 0 // 0 → defaultBranchExpandLimit
	if limitStr != "" {
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 {
			limit = n
		}
	}
	snap, nextCursor := agg.Store().SnapshotBranch(id, cursor, limit)
	b, err := json.Marshal(snap)
	if err != nil {
		vhlog.Error("branch: marshal failed", "dir", reqDir(r), "err", err)
		http.Error(w, "branch marshal failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if nextCursor != "" {
		w.Header().Set("X-VH-Branch-Cursor", nextCursor)
	}
	w.Write(maybeCompressSnapshot(b, wantsCompress(r)))
}

// projectScopedFilter returns a filter containing only the IDs that are members
// of agg's project-scoped store. A nil filter ("all" request) passes through
// unchanged — the SAFE branch at the call site already iterates SessionIDs(),
// which is project-scoped by construction. This is the project-isolation guard
// at the HTTP boundary: without it, a request from project B carrying a session
// ID that belongs to project A would hydrate project A's messages into project
// B's store (OpenCode's /session/<id>/message endpoint is project-blind).
func (s *Server) projectScopedFilter(agg *aggregator.Aggregator, filter map[string]bool) map[string]bool {
	if filter == nil {
		return nil
	}
	scoped := make(map[string]bool, len(filter))
	for id := range filter {
		if agg.Store().HasSession(id) {
			scoped[id] = true
		}
	}
	return scoped
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

	// PROBE 3 (latency diagnostics): wrap the ResponseWriter with a
	// counting/timing writer that preserves http.Flusher. Per-class (tree /
	// selected-session / firehose — NOT per-session-id) aggregates feed the
	// bounded diagnostics registry: bytes, writes, write/flush duration,
	// inter-arrival gap, ping duration, snapshot-vs-replay path, and
	// disconnect reason. IMPORTANT CAVEAT: a successful Write here only means
	// bytes reached local TCP buffering; correlate with yamux (Probe 4),
	// tunnel ws (Probe 5), and controller io.Copy (Probe 6) for full
	// attribution. The wrapper adds pure-atomic overhead on Write/Flush and a
	// scoped-mutex IncidentRing push ONLY when a slow threshold is crossed.
	streamClass := diag.ClassifyStream(messageFilter(r))
	sw := diag.NewStreamStatsWriter(w, streamClass)
	w = sw
	flusher = sw // route Flush through the probe (sw implements http.Flusher)
	sw.RecordOpen()
	var discReason int = diag.DiscRequestCtxClosed // default: browser closed
	defer func() { sw.RecordDisconnect(discReason) }()

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
	//
	// SSE retry hint: tells the browser's native EventSource auto-reconnect (the
	// CONNECTING state on a transient drop) to wait 2s before reconnecting. This
	// is what lets a session stream (Stream2) absorb a transient tunnel blip via
	// native auto-reconnect — which sends Last-Event-ID → the server's replay
	// branch → missed deltas are caught up WITHOUT a fresh snapshot. A fatal
	// CLOSED (non-retryable) still falls to the client's manual retry path,
	// which passes cursor= explicitly. The hint is harmless for Stream1 (its
	// onerror only acts on CLOSED; in CONNECTING the same EventSource auto-
	// reconnects with no JS-level new connection).
	fmt.Fprintf(w, ": hello\nretry: 2000\n\n")
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
	filter = s.projectScopedFilter(agg, filter)
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

	// Phase 2 tree=2: per-connection emitter for the server-owned session tree.
	// Non-nil only when wantsTree2(r). Created once and reused for the replay,
	// reconnect-snapshot, and live-tail Translate paths below (carries E_c + seq).
	var treeEmitter *state.TreeEmitter
	if wantsTree2(r) {
		treeEmitter = state.NewTreeEmitter(store, reqDir(r))
	}

	events, head, replayOK := store.Replay(cursor)
	if hasCursor && replayOK {
		for _, ev := range events {
			if sendable(ev.Kind, ev.Payload) {
				if treeEmitter != nil {
					// tree=2 replay: translate each event to tree delta ops.
					for _, op := range treeEmitter.Translate(ev) {
						if b, err := json.Marshal(op); err == nil {
							writeRaw(w, op.Seq(), "tree.op", b)
						}
					}
				} else {
					writeEvent(w, ev.Seq, ev.Kind, ev.Payload)
				}
			}
		}
		baseline = head
		sw.RecordReplayPath() // PROBE 3: cursor-replay baseline branch
		// Finding #2 / DEFER #5: a projected Stream1 resume must RE-ESTABLISH
		// projection state even on a successful replay. branchStubs and
		// expandedBranches are EPHEMERAL (never persisted — store.ts persist()
		// saves only sessions/cursor/activity/lastAgents), so after a page
		// reload with a valid cursor the replay succeeds but the frontier stubs
		// are never reconstructed until the next structural event — the client
		// renders the stale full tree (defeating O1) or a pruned cache with
		// stubs missing. Emit a projected `cause:"reconnect"` snapshot AFTER the
		// replayed events so applyProjectedSnapshot rebuilds branchStubs
		// (reconnect is a fullCause → wholesale stub replace + reconcile). The
		// client's Finding #1 guard treats cause=reconnect as a fullRebuild →
		// exempt from the same-revision idempotency skip, so it applies even
		// when the replay already advanced the cursor to head. baseline is
		// pinned to the snapshot's seq so the replayed events (seq<=head) are
		// not re-forwarded by the live tail and the snapshot's coverage is not
		// duplicated. Legacy (non-projected) replay keeps the replay-only path:
		// a resumed legacy client already carries the wholesale authoritative
		// set from its first cold-load snapshot and reconciles via live events.
		if wantsProject(r) {
			rcSnap := store.SnapshotProjected(filter, "reconnect", wantsHoist(r))
			if rb, err := json.Marshal(rcSnap); err == nil {
				// Compute the wire payload once and record its length so
				// snapshot_bytes reflects true wire bytes (Phase 3-D: was
				// len(rb), overstating ~3x by recording the pre-compression
				// marshaled length). Phase 3-C: RecordSnapshotPath was MISSING
				// here entirely (unlike the initial/promotion sites), hiding
				// the reconnect snapshot from snapshot_path/snapshot_bytes.
				wire := maybeCompressSnapshot(rb, wantsCompress(r))
				writeRaw(w, rcSnap.Seq, "snapshot", wire)
				sw.RecordSnapshotPath(len(wire)) // PROBE 3: reconnect branch + wire bytes
				baseline = rcSnap.Seq
			} else {
				vhlog.Warn("stream reconnect snapshot: marshal failed, skipping", "err", err)
			}
		}
		if wantsTree2(r) {
			// tree=2 reconnect: re-seed the frontier from a fresh §5 snapshot.
			rcTreeSnap := treeEmitter.SnapshotFrontier("reconnect")
			if rb, err := json.Marshal(rcTreeSnap); err == nil {
				wire := maybeCompressSnapshot(rb, wantsCompress(r))
				writeRaw(w, rcTreeSnap.Seq, "tree.snapshot", wire)
				sw.RecordSnapshotPath(len(wire))
				baseline = store.Head()
			}
		}
	} else {
		// Fresh client or cursor too old: send a full snapshot, then live-tail.
		// PROBE 8: when the client HAD a cursor but the shared replay ring
		// evicted it (hasCursor && !replayOK), this is a silent fallback to a
		// fresh snapshot — the exact signal that reveals whether the single
		// 4096-event shared ring is evicting Stream2 cursors under multi-
		// session load (the deferred per-session-ring finding).
		if hasCursor && !replayOK {
			diag.IncStream2ReplayFallback()
		}
		// NON-BLOCKING hydration: kick the upstream fetch off in the background
		// (EnsureMessagesAsync) so the snapshot sends immediately, then forward
		// message.*/part.* deltas + messages.loaded over this same connection as
		// the fetch reconciles. Subscribe-before-trigger is preserved (we
		// subscribed above) so no completion event slips through the gap.
		s.triggerMessageLoad(agg, filter)
		if wantsTree2(r) {
			// Phase 2 tree=2: emit a frontier snapshot (roots + active-path +
			// direct-children-of-loaded placeholders) instead of the legacy
			// wholesale/projected snapshot. treeEmitter was created above.
			treeSnap := treeEmitter.SnapshotFrontier("initial")
			if rb, err := json.Marshal(treeSnap); err == nil {
				wire := maybeCompressSnapshot(rb, wantsCompress(r))
				writeRaw(w, treeSnap.Seq, "tree.snapshot", wire)
				sw.RecordSnapshotPath(len(wire))
			} else {
				vhlog.Warn("tree snapshot: marshal failed", "err", err)
			}
			baseline = store.Head()
		} else {
			// Phase 4: when proj=1, use the projected snapshot (roots + active
			// closure + frontier stubs) instead of the wholesale AUTHORITY_COMPLETE
			// snapshot. This is what cuts the ~1016-session payload to ~100 nodes
			// for an idle-heavy workload.
			var snap state.Snapshot
			if wantsProject(r) {
				snap = store.SnapshotProjected(filter, "initial", wantsHoist(r))
			} else {
				snap = store.Snapshot(filter)
			}
			b, err := json.Marshal(snap)
			if err != nil {
				// Cannot fail for a well-typed *state.Snapshot today; log and skip
				// the malformed snapshot write rather than emitting a nil/"null"
				// frame. baseline still advances to snap.Seq so the live tail does
				// not replay events already covered by the (would-be) snapshot.
				vhlog.Warn("stream snapshot: marshal failed, skipping snapshot write", "err", err)
			} else {
				// gzip64-wrap the snapshot when the client opted in (z=1) AND it is large
				// enough to benefit (a warm open of a loaded session — the megabyte-scale
				// transcript inlined at snap.Messages[sid]). Small/cold/messageless
				// snapshots fall under the threshold and ship raw. The envelope mirrors
				// the cold-load messages.batch gzip64 shape so the client decodes via the
				// same path; this is what cuts a warm open's end-to-end `snap` transport
				// ~3.4x (the controller tunnel does not compress at any lower layer).
				// Phase 3-D: record true wire bytes (was len(b), the pre-compression
				// marshaled length — overstated ~3x). snapshot_bytes now reflects the
				// actual bytes written, keeping the diag self-consistent with Phase-1
				// per-path wire counters.
				wire := maybeCompressSnapshot(b, wantsCompress(r))
				writeRaw(w, snap.Seq, "snapshot", wire)
				sw.RecordSnapshotPath(len(wire)) // PROBE 3: initial snapshot branch + wire bytes
			}
			baseline = snap.Seq
		}
	}
	flusher.Flush()

	// Promotion coalescing (tunnel-volume amplifier #1 fix). Before this, EVERY
	// structural event re-snapshotted + re-shipped the whole active-closure
	// projection synchronously inside the event case. With 373 active children
	// flipping activity, that dominated tunnel volume (~150 MB/hr at rest in the
	// live study). The design:
	//   - On the FIRST structural event in a burst, arm promoCoalesce; subsequent
	//     events see promoPending and are absorbed (the timer is already armed).
	//   - When the timer fires, take ONE SnapshotProjected (reflects the LATEST
	//     store state, so every event in the window is covered; none is lost),
	//     write it, bump baseline to its Seq, and clear promoPending.
	//   - Arm-on-first-event (NOT reset-on-every-event) bounds the flush rate to
	//     ~1/window under continuous churn; a real timer (not a lazy time-check)
	//     guarantees a final event flushes even when no further events arrive.
	// Ordering/baseline: promoSnap.Seq at flush time is >= every event seq
	// already written in this window, so baseline jumps forward correctly and no
	// event is double-shipped (writeEvent guards on ev.Seq > baseline).
	// Not-lost: SnapshotProjected reads live store state, so any event applied
	// during the window is in the flushed snapshot.
	// KindActivity stays in the trigger set: a stub going busy needs its full
	// payload (info/gate/perms) shipped — the live session.busy event carries
	// only the activity state, not the materialization payload, so the client
	// cannot self-promote a stub. Narrowing the trigger set would drop genuine
	// promotions.
	// lastDemotionGen is this stream's last-seen demotion-sweep generation. It
	// is initialized AFTER the initial/reconnect snapshot ships (so a demotion
	// the snapshot already reflects is not re-armed), refreshed in flushPromotion
	// (so an event-driven promotion that already reflects a demotion is not
	// re-armed by the next sweepTicker poll), and compared on every sweepTicker
	// tick. This per-stream value is what fans the demotion out to EVERY
	// concurrent proj=1 viewer (replacing the old store-global consuming CAS).
	lastDemotionGen := store.DemotionGen()
	promoCoalesce := time.NewTimer(promotionCoalesceInterval)
	promoCoalesce.Stop() // armed on first structural event, not at stream open
	defer promoCoalesce.Stop()
	promoPending := false
	// flushPromotion materializes + ships ONE promotion snapshot for the current
	// store state and records the diagnostic counter at the write site. Recording
	// here (not just on the initial branch) stops the snapshot_path/snapshot_bytes
	// diagnostic from undercounting promotion volume — the live study showed the
	// tree counter "calm" while 150 MB/hr shipped, because RecordSnapshotPath was
	// only on the initial-snapshot branch.
	flushPromotion := func() {
		promoPending = false
		promoSnap := store.SnapshotProjected(filter, "promotion", wantsHoist(r))
		if pb, err := json.Marshal(promoSnap); err == nil {
			// Pass `filter` (not nil) so promotion respects the same message
			// scoping as the initial snapshot — otherwise every promotion
			// re-ships transcripts for the entire active closure.
			// Phase 3-D: record true wire bytes (was len(pb), the pre-compression
			// marshaled length — overstated ~3x).
			wire := maybeCompressSnapshot(pb, wantsCompress(r))
			writeRaw(w, promoSnap.Seq, "snapshot", wire)
			sw.RecordSnapshotPath(len(wire)) // PROBE 3: promotion wire bytes
			// Advance baseline so buffered events already covered by the
			// promotion snapshot are not re-emitted (mirrors the initial
			// snapshot baseline bump at the snapshot send site above).
			baseline = promoSnap.Seq
			// SnapshotProjected updated lastNotifiedClosure (the sweep baseline),
			// so a demotion this promotion already reflects must not re-arm on
			// the next sweepTicker poll — advance this stream's last-seen gen.
			lastDemotionGen = store.DemotionGen()
		}
	}

	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	// sweepTicker drives the time-driven demotion re-projection: when the
	// store's demotion sweep detects a session has aged past the projection
	// cutoff (a wall-clock transition no event fires for), it bumps demotionGen.
	// This ticker polls DemotionGen() at SweepInterval (derived from the cutoff)
	// and, when it has advanced past this stream's last-seen value, arms the
	// SAME promotion-coalesce path as ev.FrontierChanged — no second snapshot
	// path. Each stream tracks its own last-seen value (lastDemotionGen) so
	// EVERY concurrent proj=1 viewer ships the demotion (mirroring the
	// ev.FrontierChanged per-event fanout), not just one. Identical arm shape
	// to the ev.FrontierChanged case below (gated on wantsProject).
	sweepTicker := time.NewTicker(store.SweepInterval())
	defer sweepTicker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-ch:
			if !ok {
				discReason = diag.DiscSubscriberChannelClosed // PROBE 3
				return                                        // dropped as a slow consumer; client will reconnect + resume
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
			if treeEmitter != nil {
				// Phase 2 tree=2: translate the raw store event to tree delta
				// ops (node.upsert/remove/move/children/facet) and emit each as
				// a tree.op SSE event. The emitter's per-connection E_c decides
				// whether a child op or only a count facet is shipped (§5.4).
				ops := treeEmitter.Translate(ev)
				for _, op := range ops {
					if b, err := json.Marshal(op); err == nil {
						writeRaw(w, op.Seq(), "tree.op", b)
					}
				}
				flusher.Flush()
				continue
			}
			writeEvent(w, ev.Seq, ev.Kind, ev.Payload)
			// Phase 4: for proj=1 clients, re-snapshot after structural events
			// (session/activity/permission/question changes) so the collapsed-
			// frontier view stays in sync. A hidden session that becomes busy
			// is promoted to the active closure; an active session that goes
			// idle may be demoted to a stub. The structuralRevision guard on
			// the client discards stale/duplicate re-snapshots. This rides the
			// same Seq-ordered snapshot path (NOT the notice path).
			//
			// Phase 2 (finding B) — per-event frontier-membership gate: arm the
			// promotion coalesce ONLY when THIS specific structural event
			// changed the frontier (ev.FrontierChanged, stamped at emit time).
			// Before this gate, every IsStructuralKind event — including every
			// KindActivity busy↔retry / idle→busy flip of an ALREADY-materialized
			// session — re-shipped a full ~74KB tree snapshot (~16.6 MB/hr with
			// one flapping session). The per-event flag is set ONLY on
			// create/delete/reparent, pending-input boundary change, and the
			// FIRST activity of a previously >cutoff-idle session (a genuine
			// idle-stub → active promotion). So:
			//   - busy↔retry of an active session: FrontierChanged=false → no arm.
			//   - idle→busy of a >10min-idle stub: FrontierChanged=true → arm
			//     (the genuine promotion that still must fire — the live
			//     session.busy event carries only activity state, not the
			//     materialization payload, so the client cannot self-promote a
			//     stub).
			//   - create/delete/perm/question: FrontierChanged=true → arm.
			// The per-event flag replaced an earlier global-counter gate
			// (store.FrontierSeq() > lastFrontier) which raced with the
			// aggregator's concurrent poll-loop re-applies.
			if wantsProject(r) && ev.FrontierChanged {
				if !promoPending {
					promoPending = true
					promoCoalesce.Reset(promotionCoalesceInterval)
				}
				// else: timer already armed — the flush will reflect this event.
			}
			flusher.Flush()
		case <-promoCoalesce.C:
			// Coalesce window elapsed: flush ONE promotion snapshot for the
			// latest state (covers every structural event armed in this window).
			// promoPending is false on a stray fire (shouldn't happen given the
			// arm-on-first-event logic, but the guard keeps it a no-op).
			if promoPending {
				flushPromotion()
				flusher.Flush()
			}
		case <-sweepTicker.C:
			// Time-driven demotion: the store's sweep detected a session aged
			// past the projection cutoff (a wall-clock crossing no event fires
			// for). Arm when the per-stream demotionGen has advanced past
			// lastDemotionGen, then record the new value — so EVERY concurrent
			// proj=1 stream ships the demotion (per-stream fanout, mirroring
			// ev.FrontierChanged), not just one. Then arm the IDENTICAL
			// promotion-coalesce path as ev.FrontierChanged above (same timer,
			// same flushPromotion — no second snapshot path). Non-projected
			// streams (wantsProject=false) short-circuit so they never observe
			// the gen.
			if wantsProject(r) && !promoPending {
				if gen := store.DemotionGen(); gen > lastDemotionGen {
					lastDemotionGen = gen
					promoPending = true
					promoCoalesce.Reset(promotionCoalesceInterval)
				}
			}
		case <-ticker.C:
			// A NAMED ping event (not an SSE ` : comment`) so the client can observe
			// it — EventSource hides comments, so the client uses these pings to
			// detect a dead-but-open connection and force a reconnect. No id line,
			// so Last-Event-ID (the resume cursor) is untouched.
			pingStart := time.Now() // PROBE 3: ping write+flush duration sentinel
			io.WriteString(w, "event: ping\ndata: {}\n\n")
			flusher.Flush()
			sw.RecordPing(time.Since(pingStart))
		}
	}
}

func writeEvent(w io.Writer, seq uint64, kind string, payload []byte) {
	writeRaw(w, seq, kind, payload)
}

func writeRaw(w io.Writer, seq uint64, event string, data []byte) {
	fmt.Fprintf(w, "id: %d\nevent: %s\ndata: %s\n\n", seq, event, data)
}

// snapshotCompressThreshold is the minimum marshaled-snapshot size above which
// maybeCompressSnapshot will gzip64-wrap the payload. Below it the raw JSON is
// sent as-is: small payloads (cold/messageless partial snapshots, a tiny tree)
// gain nothing from gzip and base64 inflates them, and keeping them raw lets
// the client ingest them on the synchronous fast path (no async
// DecompressionStream round-trip). Above the threshold, two payloads benefit:
// (1) the warm open of a loaded session (a full transcript — megabytes), and
// (2) the tree-only snapshot for a real project (~760 KiB–1.1 MiB of highly
// repetitive JSON — one directory/projectID/model/agent set repeated across
// ~1k sessions). Both clients opt in via `z=1`; the tree stream was wired to
// `z=1` after a live study found the tree reconnect cadence (~60/hr) was
// shipping ~40–68 MiB/hr of uncompressed tree snapshots through the tunnel.
const snapshotCompressThreshold = 2048

// wantsCompress reports whether the client opted into gzip64 snapshot encoding
// via the `z=1` query flag. EventSource cannot set custom request headers, so
// the opt-in is a query param (not Accept-Encoding). An absent/false flag keeps
// the legacy raw-JSON wire shape bit-for-bit — this is what protects a stale
// cached PWA (old client) against a new server that would otherwise emit a
// base64 blob it cannot render. The client's decode helper is a total function
// (pass-through when encoding is absent), so the reverse (new client, old
// server) also interops without special handling.
func wantsCompress(r *http.Request) bool {
	return r.URL.Query().Get("z") == "1"
}

// promotionCoalesceInterval bounds how long the promotion path waits before
// re-shipping a projected snapshot after the FIRST structural event in a burst.
// A burst of structural events (e.g. 373 active children flipping busy/idle in
// the live study) re-ships ONE promotion snapshot per window, not N — the
// un-throttled path re-marshalled + re-shipped the whole active-closure
// projection on every flip and was the dominant tunnel volume (~150 MB/hr at
// rest). The snapshot taken at flush reflects the LATEST store state, so every
// event that arrived during the window is reflected; none is lost.
//
// A real time.Timer (NOT the deltaFlushInterval lazy-check pattern) is required
// so a final structural event followed by a quiet period still flushes within
// this window — the lazy pattern would strand the last state until the next
// event arrived. The window bounds promotion latency: the operator sees a
// stub→active promotion within this delay, which is well inside the ~300ms
// "UI feels live" budget at 150ms. A package var (not const) so tests can shrink
// it to a deterministic value (mirrors deltaFlushInterval).
var promotionCoalesceInterval = 150 * time.Millisecond

// wantsProject reports whether the client opted into projected (collapsed-
// frontier) snapshot mode via the `proj=1` query flag. Mirrors wantsCompress:
// EventSource cannot set custom request headers, so the opt-in is a query param.
// An absent flag keeps the legacy AUTHORITY_COMPLETE wire shape — this protects
// a stale cached PWA (old client) against a new server that would otherwise
// emit a projected snapshot it cannot render. Combined with the `projected`
// envelope field on the Snapshot itself, it also protects a new client against
// an old server that ignores proj=1 (the client falls back to wholesale-replace
// when `projected` is absent). Phase 2: the flag is acknowledged (read) but the
// projection path is not yet built — the server still emits AUTHORITY_COMPLETE
// regardless of this flag. Phase 4 wires the actual projection when proj=1.
func wantsProject(r *http.Request) bool {
	return r.URL.Query().Get("proj") == "1"
}

// wantsTree2 reports whether the client opted into the server-owned session
// tree (Phase 2: tree=2) via the `tree=2` query flag. When true, handleStream
// emits a tree.snapshot (frontier) instead of the legacy wholesale snapshot,
// and live structural events are translated to tree delta ops
// (node.upsert/remove/move/children/facet) via state.TreeEmitter. The
// GET /vh/tree/children expand endpoint (handleTreeChildren) is the lazy-load
// counterpart. Old clients that don't send tree=2 get the legacy (or proj=1)
// path unchanged — both emitters coexist off the same store events during the
// transition (Phase 4 deletes the projection path).
func wantsTree2(r *http.Request) bool {
	return r.URL.Query().Get("tree") == "2"
}

// wantsHoist reports whether the client opted into hoisted per-session
// constants (Phase 3 trim) via the `hoist=1` query flag. Only meaningful when
// wantsProject(r) is also true (hoist is a modifier on the projected path).
// Old clients that don't send hoist=1 get legacy per-session fields; new
// clients send hoist=1 and get projectConstants + stripped sessions.
func wantsHoist(r *http.Request) bool {
	return r.URL.Query().Get("hoist") == "1"
}

// maybeCompressSnapshot gzip64-wraps a marshaled snapshot payload when compress
// is requested AND the payload is large enough to benefit. The envelope mirrors
// the cold-load messages.batch convention exactly:
//
//	{"encoding":"gzip64","data":"<base64(gzip(snapshotJSON))>"}
//
// so the client decodes it through the same native DecompressionStream path.
// Returns the bytes to write as the event/response body (the envelope when
// compressed, or the input unchanged when not). base64 is required because SSE
// data: fields are text/UTF-8 and raw gzip bytes are not valid UTF-8; the same
// applies to a JSON response body a client parses before feature-detecting.
func maybeCompressSnapshot(raw []byte, compress bool) []byte {
	if !compress || len(raw) < snapshotCompressThreshold {
		return raw
	}
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	_, _ = gw.Write(raw) // gzip.Writer.Write does not return a meaningful error mid-stream
	if err := gw.Close(); err != nil {
		// gzip.Close flushes the trailer; on failure buf holds an incomplete
		// gzip stream. The *bytes.Buffer backing writer cannot fail today, but a
		// silent discard would mask a future regression — fall back to the raw
		// JSON (the client's decode helper is pass-through when encoding is
		// absent, so this degrades gracefully rather than shipping corrupt bytes).
		vhlog.Warn("snapshot: gzip close failed, sending raw", "err", err)
		return raw
	}
	out, err := json.Marshal(struct {
		Encoding string `json:"encoding"`
		Data     string `json:"data"`
	}{Encoding: "gzip64", Data: base64.StdEncoding.EncodeToString(buf.Bytes())})
	if err != nil {
		vhlog.Warn("snapshot: marshal gzip64 envelope failed, sending raw", "err", err)
		return raw
	}
	return out
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
	w = diag.NewHandlerBytesWriter(w, diag.ProxyPathRender) // PROBE 8: attribute non-stream tunnel bytes
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
	w = diag.NewHandlerBytesWriter(w, diag.ProxyPathPassthrough) // PROBE 8: attribute non-stream tunnel bytes
	r.URL.Path = strings.TrimPrefix(r.URL.Path, "/oc")
	if r.URL.Path == "" {
		r.URL.Path = "/"
	}
	s.proxy.ServeHTTP(w, r)
}

// knownStatic reports whether p is a real embedded static file path. It builds
// the path set lazily on first use (walking the immutable embed FS once) so
// handleStatic's real-asset-vs-SPA-route decision is a map lookup rather than an
// Open+Close that http.FileServer then repeats on the same path.
func (s *Server) knownStatic(p string) bool {
	s.staticPathsOnce.Do(func() {
		s.staticPaths = map[string]bool{}
		_ = fs.WalkDir(s.staticFS, ".", func(path string, d fs.DirEntry, err error) error {
			if err != nil || d.IsDir() {
				return nil
			}
			s.staticPaths[path] = true
			return nil
		})
	})
	return s.staticPaths[p]
}

// handleStatic serves embedded static files. Real assets (hashed bundles,
// sw.js, manifest, icons) are served by http.FileServer. For the root path and
// unknown client routes (SPA history fallback) it serves embedded index.html
// when a real SPA build is materialized, otherwise the self-contained
// placeholder.html—​the only tracked file under dist/—​so a cold
// `go build`/`go test` with no frontend build serves a banner page instead of a
// directory listing. This explicitly does NOT rely on http.FileServer's
// directory-index/listing semantics, which would list the directory when
// index.html is absent.
func (s *Server) handleStatic(w http.ResponseWriter, r *http.Request) {
	p := strings.TrimPrefix(r.URL.Path, "/")
	// Serve an existing embedded static file directly (real assets, sw.js,
	// manifest, icons, etc.). knownStatic is a lazy map lookup over the embed
	// FS so this does not Open+Close a file that http.FileServer re-opens below.
	if p != "" && s.knownStatic(p) {
		s.static.ServeHTTP(w, r)
		return
	}
	// Root or SPA-history fallback: prefer index.html (the real SPA shell,
	// present only after an embed-producing target materialized a build); fall
	// back to placeholder.html (the always-tracked cold-build banner). Both are
	// served as text/html directly from the embed FS so the fallback does not
	// depend on FileServer resolving a directory index.
	if data, err := fs.ReadFile(s.staticFS, "index.html"); err == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(data)
		return
	}
	if data, err := fs.ReadFile(s.staticFS, "placeholder.html"); err == nil {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write(data)
		return
	}
	http.NotFound(w, r)
}
