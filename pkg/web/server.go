// Package web serves the vh-solara client UI plus the client-agnostic
// snapshot/resume protocol backed by the daemon's materialized state, and
// passes write operations through to the local OpenCode server.
package web

import (
	"context"
	"embed"
	"fmt"
	"io"
	"io/fs"
	"mime"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/auth"
	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
	"github.com/vhqtvn/vh-solara/pkg/oclife"
	"github.com/vhqtvn/vh-solara/pkg/procmgr"
	"github.com/vhqtvn/vh-solara/pkg/quota"
	"github.com/vhqtvn/vh-solara/pkg/render"
	"github.com/vhqtvn/vh-solara/pkg/skill"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

//go:embed dist
var distFS embed.FS

// hostDistFS embeds the multi-server HOST shell (host-web/ SPA), materialized
// into pkg/web/host-dist/ by embed-producing targets (mirror of distFS for the
// single-server SPA). The tracked pkg/web/host-dist/placeholder.html keeps a
// cold `go build`/`go test` compiling and serving a real page with no host-web
// build. Served at `/` (the default view) and `/host/*` (its namespaced assets).
//
//go:embed host-dist
var hostDistFS embed.FS

// Server wires the aggregator's view to HTTP: /vh/* protocol endpoints, /oc/*
// OpenCode passthrough, and the embedded SPA at /.
type Server struct {
	agg *aggregator.Aggregator // default project (OpenCode serve cwd)
	// proxy is the /oc/* reverse proxy target. Stored in an atomic pointer
	// (P1-API-003): RetargetOpenCode swaps the WHOLE proxy after a
	// fresh-port restart of the serve process, and handlePassthrough loads
	// it per request — never a torn half-retargeted director. Always built
	// by newOpenCodeProxy so a swap preserves the proxy configuration
	// exactly (FlushInterval + ErrorHandler).
	proxy    atomic.Pointer[httputil.ReverseProxy]
	staticFS fs.FS
	static   http.Handler
	// hostFS is the embedded multi-server HOST shell (host-dist), served at `/`
	// (the default view) with its assets under `/host/*`. nil-equivalent never:
	// NewServer always materializes it from hostDistFS. The single-server SPA
	// (staticFS) is served at `/app`.
	hostFS     fs.FS
	hostStatic http.Handler
	// hostShellAtRoot is the fold switch: true (production default) → the host
	// shell is served at `/` (the default view) and the single-server SPA at
	// `/app`; false (test-only, set by the fixture server) → the single-server
	// SPA owns `/` (legacy pre-fold behavior) so the web e2e lane, which targets
	// the single-server SPA at `/`, is unchanged by the fold. This is a TEST
	// SEAM, not an operator flag: production (local-server / client-daemon) never
	// toggles it. The host-web real-embed e2e uses the real binary, so it always
	// runs with the host at `/` (production posture).
	hostShellAtRoot bool
	renderer        *render.Renderer

	// Multi-project: one aggregator per directory, created lazily. Access
	// for "" is special-cased OUTSIDE the map (aggFor/aggForExisting return
	// agg directly), but NewServer ALSO seeds an aggs[""] entry pointing at
	// that same default aggregator — it is LOAD-BEARING for
	// RetargetOpenCode's map walk, which covers the default only through
	// that entry (the walk never reads s.agg). Do not remove the seed.
	opencodeURL string
	ringCap     int
	aggMu       sync.Mutex
	aggs        map[string]*aggregator.Aggregator

	cssOnce sync.Once
	css     string

	// staticAssets maps every embedded static file path (single-server dist) to
	// its precomputed serving metadata (content-hash ETag + optional gzip
	// body), built lazily on the first distAssetMeta call by walking the
	// immutable embed FS ONCE and reading each file. handleStatic's
	// real-asset-vs-SPA-route probe stays a cheap map lookup; the ETag/gzip
	// work is paid once per process, not per request.
	staticAssetsOnce sync.Once
	staticAssets     map[string]*staticAssetMeta

	// hostStaticAssets is the analogue of staticAssets for the HOST shell
	// embed (hostFS), keyed by host-internal path. Built lazily on first
	// hostAssetMeta call.
	hostStaticAssetsOnce sync.Once
	hostStaticAssets     map[string]*staticAssetMeta

	quotaMu    sync.Mutex
	quotaCache *quota.Report
	quotaAt    time.Time

	// restartOC, when set by the daemon, restarts the managed OpenCode process.
	// nil in environments that don't manage OpenCode (e.g. the fixture server).
	restartOC func(context.Context) error
	// restartAbortPerCall / restartAbortBudget bound the P1-API-007
	// pre-restart abort sweep (abortInflightBeforeRestart): per-call is the
	// ctx timeout around each Abort RPC; budget is the shared wall-clock cap
	// across the whole fleet sweep. Abort failure/hang must NEVER block the
	// restart — budget expiry proceeds to restartOC and layer (b) (the
	// store-side interrupted-turn sweep) heals whatever the abort could not
	// close. Per-instance (mirrors reassertDelay et al.) so tests shrink them
	// without touching shared state.
	restartAbortPerCall time.Duration
	restartAbortBudget  time.Duration
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
	//
	// Stored in an atomic.Pointer (F3 / P2-TEST-006): the setter may run while
	// the server is serving (the fixture server swaps it from its own handler;
	// the daemon swaps it once the topology is known), so a plain field would
	// be a publication race with every reader. Each request Loads the pointer
	// exactly ONCE and reuses that *Lifecycle for its whole duration.
	ocLifecycle atomic.Pointer[oclife.Lifecycle]

	// tunnelState, when set, is the daemon→FE TUNNEL STATUS provider (Slice B,
	// send-net-resilience): a pure func returning the worker↔controller tunnel
	// state ("connected" / "disconnected") for the X-VH-Tunnel-State response
	// header stamped by stampMeta on /vh/* responses. nil (local-server, the
	// fixture server, tests) = the header is OMITTED — the frontend then reads
	// tunnel state as UNKNOWN (never "down": a controller topology where the
	// header can't arrive says nothing about the tunnel). Wired only by
	// client-daemon.go from diagnostics.Default.Tunnel.CurrentState, which the
	// daemon keeps current across reconnects. OBSERVATIONAL ONLY (debate-1 Q5,
	// BINDING): this is a STATUS INPUT for the graded ConnStatus reduction —
	// never retry/delivery/redelivery authority. Atomic for the same
	// publication-race reason as ocLifecycle (set while serving).
	tunnelState atomic.Pointer[func() string]

	// corsOrigins is the explicit allowlist of cross-origin callers. Empty =
	// no CORS (strict same-origin). "*" allows any origin (which disables the
	// cross-origin half of the CSRF protection — only set it if you mean it).
	corsOrigins []string

	// frameAncestors is the CSP frame-ancestors source-list allowlist for who
	// may embed the web UI in an <iframe>. Empty (default) = 'self' only
	// (same-origin, the historic secure default — blocks cross-origin
	// clickjacking). Set by the daemon from --frame-ancestors to permit a
	// trusted host (e.g. https://app.my-root-domain) to embed the UI
	// cross-origin. The list REPLACES 'self' (see frameAncestorsDirective).
	frameAncestors []string

	// auth, when set, gates the whole server (login + session). nil = no auth
	// (only safe on a loopback bind; see auth.CheckBindSafety).
	auth *auth.Authenticator

	// idem dedups typed write verbs by their idempotency_key (A1).
	idem *idemCache

	// queues is the backend-authoritative per-session message queue registry,
	// keyed by (project root, sessionID). One store per session; lazy-loaded;
	// durable via .vh-solara/sessions/<id>/queue.json. See queue.go.
	queues *queueRegistry

	// pins is the worker-wide pinned-sessions store (Phase 2 of server-managed
	// pinned sessions, building on the Phase 1 PinStore from commit 89db96e).
	// Constructed once at NewServer from filepath.Join(stateBaseDir(),
	// "pins.json"); serves GET/PUT /vh/pins. See pins.go (Phase 1 store) and
	// pins_http.go (Phase 2 HTTP layer).
	pins *PinStore

	// namedLayouts is the worker-wide named tab-layout catalog (worker-scoped
	// v1). Constructed once at NewServer from
	// filepath.Join(stateBaseDir(), "named-layouts.json"); serves GET/PUT
	// /vh/layouts with PER-ENTRY CAS upsert granularity (no whole-catalog
	// replace, no SSE fan-out — pinned by the task card). See
	// named_layouts.go (store) and named_layouts_http.go (HTTP layer).
	namedLayouts *NamedLayoutStore

	// labelsReg is the per-project root-session labels registry (groups +
	// tags). Each project owns an independent LabelStore at
	// <stateBaseDir>/projects/<projectKey>/labels.json with its own
	// revision/CAS domain, resolved lazily via labelsForDir from reqDir(r)
	// (HTTP/stream) or the aggregator's dir (lifecycle/reconcile). The store
	// API (labels.go) is unchanged from the Slice-1 design; only its scope
	// moved from worker-wide to per-project. NewServer runs the one-time
	// worker-wide → per-project migration (migrateLabelsToPerProject) before
	// any store can be opened. See labels_registry.go, labels.go (store), and
	// labels_http.go (HTTP layer).
	labelsReg *labelRegistry

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
	// Reload stopper, but Shutdown's stopAllPermissionWatchers cancels EVERY
	// watcher — including the default dir's — and awaits all of them on
	// lifecycleWG. Both maps are guarded by watcherMu.
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

	// sessionErrMu + sessionErrOn guard the one-time, per-dir installation
	// of the session.error → queue-detail signal subscriber (slice 2b phase
	// 2; see installQueueSessionErrorSignal). Exact same lifecycle shape as
	// queueGCMu/queueGCOn: installed from aggFor, reset by
	// handleReloadProject's teardown, retired by store.Close.
	sessionErrMu sync.Mutex
	sessionErrOn map[string]bool

	// queueDeliverMu + queueDeliverOn guard the one-time, per-dir
	// installation of the message-persistence → queue-resolve subscriber
	// (queue_delivery_watch.go: the early delivery-resolution watcher — a
	// user message persisted under a dispatching item's exact correlation id
	// resolves it to sent immediately, instead of waiting out the 30s stale
	// pass). Exact same lifecycle shape as sessionErrMu/sessionErrOn:
	// installed from aggFor, reset by handleReloadProject's teardown and
	// stopServerOwnedAggregators, retired by store.Close.
	queueDeliverMu sync.Mutex
	queueDeliverOn map[string]bool

	// drainLoopsMu + drainLoops hold the per-dir queue drain loops (slice 2b
	// phase 2, queue_drain_loop.go) — the daemon dispatcher, started from
	// aggFor when daemon dispatch is enabled (production default OFF).
	// Keyed by dir; stopQueueDrainLoop (reload teardown) waits for a full
	// exit + custody release; Shutdown reaches the loops via bgCtx.
	drainLoopsMu sync.Mutex
	drainLoops   map[string]*queueDrainLoop

	// ocGenFn is the OPTIONAL OpenCode process-generation provider (a
	// monotonic incarnation counter bumped on every observed spawn/respawn)
	// — the restart-barrier input for certified redelivery classification.
	// When nil, ocGeneration() falls back to the lifecycle's Generation()
	// (SetOpenCodeLifecycle), and 0 (unknown) means the barrier can never
	// certify (fail-closed). Set once by the daemon wiring (local-server /
	// tests) before serving.
	ocGenFn func() uint64

	// queueReconcileInFlight is a sync.Map keyed by storeKey(root,sid) that
	// holds a per-session in-flight guard for message-id reconciliation. The
	// guard is the LoadOrStore(sentinel)+Delete-on-completion idiom (sync.Map
	// has no compare-and-swap on a missing key): it bounds reconciliation to
	// ONE concurrent pass per session, so a FE poll storm (or a test poll
	// loop) cannot fan out overlapping GET /session/:sid/message/:mid passes
	// for the same session. Purely in-memory; a restart simply loses the guard
	// (the next poll re-runs reconciliation, still bounded by the persisted
	// attempt/terminal markers).
	queueReconcileInFlight sync.Map

	// providerSFMu + providerFlights implement single-flight for GET
	// /oc/provider (S4): concurrent identical requests (same flight key =
	// project dir + raw query) share ONE upstream OpenCode fetch. The
	// leader proxies into a capture; on settle (success OR failure) the
	// map entry is deleted, so the next request always starts fresh — no
	// result caching and no negative caching beyond the in-flight window
	// (the service worker owns /oc/provider response caching; this is
	// purely server-CPU hygiene against the ~600ms upstream provider
	// compute under concurrent load, e.g. simultaneous SWR expiry).
	providerSFMu    sync.Mutex
	providerFlights map[string]*providerFlight

	// pinsGCMu + pinsGCOn guard the one-time, per-dir installation of the L2
	// session.delete subscriber for pinned-session cleanup (Phase 4). It is the
	// direct structural mirror of queueGCMu/queueGCOn and shares the exact same
	// lifecycle: installed from aggFor for the default + every per-dir
	// aggregator, run exactly once per (dir, aggregator) pair, the goroutine
	// exits when the store closes its subscriber channels, and
	// handleReloadProject resets pinsGCOn[dir] when it tears down a per-dir
	// aggregator so the fresh aggFor(dir) rebuild gets a fresh subscriber. See
	// installPinsLifecycle (pkg/web/pins_lifecycle.go) for the full rationale.
	pinsGCMu sync.Mutex
	pinsGCOn map[string]bool

	// labelsGCMu + labelsGCOn guard the one-time, per-dir installation of the L2
	// session.delete subscriber for label lifecycle cleanup (Slice 3). It is the
	// direct structural mirror of pinsGCMu/pinsGCOn (and queueGCMu/queueGCOn) and
	// shares the exact same lifecycle: installed from aggFor for the default +
	// every per-dir aggregator, run exactly once per (dir, aggregator) pair, the
	// goroutine exits when the store closes its subscriber channels, and
	// handleReloadProject/stopServerOwnedAggregators resets labelsGCOn[dir] when
	// it tears down a per-dir aggregator so the fresh aggFor(dir) rebuild gets a
	// fresh subscriber. See installLabelsLifecycle for the full rationale.
	labelsGCMu sync.Mutex
	labelsGCOn map[string]bool

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
	// upstreamDownProbe, when set by the daemon (oc-death-watch S2), is
	// installed on the default aggregator immediately and on every per-dir
	// aggregator aggFor lazily creates, so ALL Run loops quiet their retry
	// ramp while the daemon knows OpenCode is down. nil (external
	// --opencode-url mode) leaves aggregator behavior untouched.
	upstreamDownProbe func() bool
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

	// Post-hydrate reconcile pass entry counters (atomic). Test observability
	// for the Shutdown-join rendezvous tests (posthydrate_reconcile_shutdown_
	// test.go) — the SAME seam pattern as queueRegistry.cleanupCalls: each
	// counter is incremented in reconcilePinsForAgg / reconcileLabelsForAgg
	// immediately BEFORE the pass's first store-mutex acquisition (the pin-doc
	// snapshot / the labels reconcile snapshot), so a test that already holds
	// that mutex observes counter ≥ 1 exactly when the pass is
	// deterministically parked on the acquisition — past the fail-closed gate,
	// with its durable write (PinStore.RemoveIDs / LabelStore.RemoveRootIDs,
	// persisted under the SAME mutex) still pending. Not read by production
	// code paths.
	pinsReconcileEntries   int64
	labelsReconcileEntries int64

	// Archive cascade job (Defect 1 fix) state. The job is dispatched by
	// handleArchive under bgCtx/bgWG (same lifecycle as reassert); these fields
	// configure its retry policy and record operator-visible failures.
	//
	// archiveRetryBudget/Base/Max are captured under bgMu at job launch (same
	// seam pattern as reassertDelay): the job receives a frozen
	// archiveRetryConfig and never reads shared mutable state after dispatch.
	// Defaults from defaultArchiveRetry* (archive.go); test override via
	// SetArchiveRetryConfig.
	archiveRetryBudget int
	archiveRetryBase   time.Duration
	archiveRetryMax    time.Duration
	// archiveJobsActive counts in-flight cascade jobs (atomic). Test seam:
	// awaitArchiveJobs (archive_job_test.go) polls it to deterministically wait
	// for the bg job to reach terminal state before asserting side-effects (the
	// cascade is async — POST returns before RemoveSessions/Cleanup run). Not
	// read by production code.
	archiveJobsActive int64
	// archiveFailures records ids that reached terminal failure in a cascade
	// job (permanent error, budget exhaustion on a root/unresolvable chain, or
	// shutdown cancellation). A descendant-of-archived exhausted id is NOT
	// recorded here — the orphan banner (Slices 1/2) surfaces it, and recording
	// it as a failure would double-count the recovery affordance. This is the
	// Slice-1 operator-visibility surface: the archive-failures.snapshot (SSE
	// bootstrap) + archive-failures.updated (record/clear fan-out) frames drive
	// the mobile ArchiveFailureBanner. The registry is a per-project (dir,id)
	// composite-keyed UPSERT map (one coherent record per stuck root, refreshed
	// on repeat permanent failure — not an append-log). In-memory + current-
	// daemon-only (no persistence). Guarded by archiveFailuresMu.
	archiveFailuresMu sync.Mutex
	archiveFailures   map[archiveFailureKey]archiveJobFailure

	// archiveJobsActiveRoots is the set of (dir, rootID) pairs with an in-flight
	// archive cascade job — the Slice-2 active-jobs registry that makes the OOB-
	// reconcile backstop race-free. Guarded by bgMu (the EXISTING server-level
	// job lock — handleArchive's launch site and runArchiveCascade's terminal
	// defer are the ONLY register/deregister sites, both already under bgMu).
	// The Slice-2 backstop (reconcileArchiveFailures) reads it under bgMu to
	// SKIP a root whose cascade is still running — the cascade's own clear-on-
	// success (at the success funnel) / re-record-on-failure owns that root's
	// lifecycle, and the backstop must not race it. Keyed by the SAME composite
	// (archiveFailureKey) as archiveFailures so the backstop's "is (dir,root)
	// active?" lookup is a direct map hit. NOT archiveJobsActive (the atomic
	// counter at line ~312): that has no dir/id and is a test-only seam.
	archiveJobsActiveRoots map[archiveFailureKey]bool

	// archiveBackstopInterval is the cadence of the Slice-2 OOB-reconcile
	// backstop ticker (runArchiveBackstop). Default defaultArchiveBackstopInterval
	// (5s, matching the aggregator's tree-reconcile tick that refreshes the
	// snapshot the backstop reads). Read ONCE at backstop-goroutine startup
	// (happens-before via the goroutine launch in NewServer). Tests do NOT rely
	// on the ticker — they call reconcileArchiveFailures() directly for
	// determinism.
	archiveBackstopInterval time.Duration

	// lifecycleWG tracks the Server-owned per-directory lifecycle goroutines so
	// Shutdown can AWAIT (not merely cancel) them: every permission watcher (all
	// dirs, incl. the default — the Server arms them) and every NON-DEFAULT
	// queue/pin store subscriber. The default dir's subscribers are daemon-owned
	// (process-lifetime: the default aggregator is started with plain Run(vhCtx),
	// not RunManaged, and is NOT stopped by Shutdown), so they are deliberately
	// NOT tracked here — awaiting them would hang until process exit. Shutdown
	// cancels all watchers (stopAllPermissionWatchers) and stops every non-default
	// aggregator (stopServerOwnedAggregators, whose Aggregator.Stop() closes the
	// store → closes every subscriber channel, retiring the subscriber loops),
	// then waits on bgWG followed by lifecycleWG. Add(1) happens BEFORE goroutine
	// launch at each install site; Done() is deferred inside the goroutine.
	lifecycleWG sync.WaitGroup

	// Test-only seams for the per-dir watcher Shutdown-ownership test (nil in
	// production). reconcileReadyCh, if set, is signalled (non-blocking) once
	// runPermissionReconcile completes its immediate sweep and reaches its block
	// point. reconcileBlockCh, if set, makes the reconcile goroutine block on a
	// pure (ctx-independent) receive from it — so a test can hold the watcher in
	// a spot watcher cancellation CANNOT reach, proving the only way Shutdown
	// returns is by awaiting lifecycleWG.
	reconcileReadyCh chan struct{}
	reconcileBlockCh chan struct{}
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

// SetFrameAncestors sets the CSP frame-ancestors allowlist (who may embed the
// web UI in an <iframe>). Optional; default is 'self' (same-origin only). Each
// entry is a CSP source expression (e.g. https://app.my-root-domain, or 'self');
// the list REPLACES the default — include 'self' explicitly if the app's own
// same-origin iframes (e.g. the code viewer) must keep working.
func (s *Server) SetFrameAncestors(origins []string) { s.frameAncestors = origins }

// SetHostShellAtRoot controls whether the multi-server HOST shell is served at
// `/` (true, the production default) or whether the single-server SPA owns `/`
// (false, legacy pre-fold behavior). TEST SEAM for the fixture server: the web
// e2e lane targets the single-server SPA at `/`, so the fixture server sets this
// false to stay unchanged by the fold. Production never toggles it. When false,
// `/app` still serves the single-server SPA (direct access) and `/host/*` falls
// through to the single-server (the host shell is effectively unmounted).
func (s *Server) SetHostShellAtRoot(enabled bool) { s.hostShellAtRoot = enabled }

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
//
// Safe to call while the server is serving: the pointer is published
// atomically. Atomicity is per publication, NOT transactional across a
// sequence of setter calls — a request that starts under lifecycle A and is
// still in flight when B is stored completes against A (each handler Loads
// exactly once and reuses that object for the whole request), and callers
// performing several lifecycle mutations (e.g. the fixture server's
// MarkDown/SetFailed/SetRestartProgress choreography) still sequence those
// through the Lifecycle's own internal locking.
func (s *Server) SetOpenCodeLifecycle(l *oclife.Lifecycle) { s.ocLifecycle.Store(l) }

// SetTunnelStateProvider wires the daemon's tunnel-state provider (Slice B,
// send-net-resilience). The func is loaded per /vh/* request inside stampMeta
// and its return value stamped as X-VH-Tunnel-State; an empty return omits the
// header (same as never wiring it). Safe to call while serving (atomic
// publication). Wired ONLY by client-daemon.go — local-server (no controller
// connection) and the fixture server leave it nil so the FE degrades to
// unknown-tunnel, honestly.
func (s *Server) SetTunnelStateProvider(fn func() string) { s.tunnelState.Store(&fn) }

// SetOpenCodeGenerationFn installs the OpenCode process-generation provider
// (a monotonic incarnation counter bumped on every observed spawn/respawn)
// — the restart-barrier input for certified redelivery classification
// (slice 2b phase 2). Optional: when unset, ocGeneration falls back to the
// lifecycle's Generation(); with neither wired, the generation is unknown
// (0) and the post-restart barrier can NEVER certify (fail-closed — an
// unknown generation cannot prove a restart happened). Tests wire it to the
// fixture's restart counter; the daemon wiring prefers the lifecycle.
func (s *Server) SetOpenCodeGenerationFn(fn func() uint64) { s.ocGenFn = fn }

// ocGeneration reports the current OpenCode process generation: the wired
// provider if any, else the lifecycle's counter, else 0 (unknown).
func (s *Server) ocGeneration() uint64 {
	if fn := s.ocGenFn; fn != nil {
		return fn()
	}
	if l := s.ocLifecycle.Load(); l != nil {
		return l.Generation()
	}
	return 0
}

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
	rp := newOpenCodeProxy(target)

	// Ensure the PWA manifest is served with a sensible content type (Go's
	// default mime table has no .webmanifest entry).
	_ = mime.AddExtensionType(".webmanifest", "application/manifest+json")

	bgCtx, bgCancel := context.WithCancel(context.Background())
	sub, err := fs.Sub(distFS, "dist")
	if err != nil {
		bgCancel()
		return nil, err
	}
	// Materialize the HOST shell embed (host-dist) the same way as the
	// single-server SPA (dist). The tracked placeholder.html keeps a cold
	// build serving a real page. Served at `/` (default view) + `/host/*`.
	hostSub, err := fs.Sub(hostDistFS, "host-dist")
	if err != nil {
		bgCancel()
		return nil, err
	}
	// Worker-wide pinned-sessions store (Phase 2). Constructed ONCE at server
	// startup — never per-request — grounded at stateBaseDir()/"pins.json"
	// (same worker-wide flat dir notes.go uses; no worker-id subpath). A
	// construction failure (permission, etc.) is propagated to the caller,
	// matching how fs.Sub failure is handled above. A missing file or a
	// corrupt/schema-mismatched file is NOT an error (NewPinStore returns a
	// zero doc — see pins.go).
	pinsPath := filepath.Join(stateBaseDir(), "pins.json")
	pinStore, err := NewPinStore(pinsPath)
	if err != nil {
		bgCancel()
		return nil, fmt.Errorf("pins: init store: %w", err)
	}
	// Worker-wide named tab-layout catalog (worker-scoped v1). Same
	// construction discipline as pins: built ONCE at server startup, grounded
	// at stateBaseDir()/"named-layouts.json". A construction failure
	// (permission, etc.) propagates to the caller; a missing or
	// corrupt/schema-mismatched file is NOT an error (NewNamedLayoutStore
	// returns a zero doc — see named_layouts.go).
	namedLayoutsPath := filepath.Join(stateBaseDir(), "named-layouts.json")
	namedLayoutStore, err := NewNamedLayoutStore(namedLayoutsPath)
	if err != nil {
		bgCancel()
		return nil, fmt.Errorf("named-layouts: init store: %w", err)
	}
	// Per-project root-session labels: run the one-time worker-wide →
	// per-project migration (idempotent, synchronous) BEFORE any store can be
	// opened by labelsForDir. Migration reads the legacy
	// stateBaseDir()/"labels.json" (if present), partitions it into
	// <stateBaseDir>/projects/<key>/labels.json files using the existing
	// projectByRootSessionId sidecar, routes ambiguous material to
	// labels-legacy-unassigned.json, and removes the legacy file (single
	// cutover, no dual-writer). A missing legacy file is a no-op (writes the
	// completion marker and returns). See labels_registry.go.
	if err := migrateLabelsToPerProject(); err != nil {
		bgCancel()
		return nil, fmt.Errorf("labels: per-project migration: %w", err)
	}
	srv := &Server{
		agg:        agg,
		staticFS:   sub,
		renderer:   render.New(),
		static:     http.FileServer(http.FS(sub)),
		hostFS:     hostSub,
		hostStatic: http.FileServer(http.FS(hostSub)),
		// Production default: the host shell is the default view at `/`. The
		// fixture server (web e2e lane) calls SetHostShellAtRoot(false) to keep
		// the single-server SPA at `/` (legacy, so the web e2e is unchanged).
		hostShellAtRoot:         true,
		opencodeURL:             opencodeURL,
		ringCap:                 ringCapacity,
		aggs:                    map[string]*aggregator.Aggregator{"": agg},
		idem:                    newIdemCache(10 * time.Minute),
		features:                defaultFeatures(),
		views:                   newViewRegistry(),
		queues:                  newQueueRegistry(),
		pins:                    pinStore,
		namedLayouts:            namedLayoutStore,
		labelsReg:               newLabelRegistry(),
		failFast:                map[string]struct{}{},
		watcherOn:               map[string]bool{},
		watcherCancel:           map[string]context.CancelFunc{},
		queueGCOn:               map[string]bool{},
		sessionErrOn:            map[string]bool{},
		queueDeliverOn:          map[string]bool{},
		drainLoops:              map[string]*queueDrainLoop{},
		pinsGCOn:                map[string]bool{},
		providerFlights:         map[string]*providerFlight{},
		labelsGCOn:              map[string]bool{},
		bgCtx:                   bgCtx,
		bgCancel:                bgCancel,
		reassertDelay:           defaultReassertDelay,
		restartAbortPerCall:     defaultRestartAbortPerCall,
		restartAbortBudget:      defaultRestartAbortBudget,
		archiveRetryBudget:      defaultArchiveRetryBudget,
		archiveRetryBase:        defaultArchiveRetryBase,
		archiveRetryMax:         defaultArchiveRetryMax,
		archiveFailures:         map[archiveFailureKey]archiveJobFailure{},
		archiveJobsActiveRoots:  map[archiveFailureKey]bool{},
		archiveBackstopInterval: defaultArchiveBackstopInterval,
	}
	srv.proxy.Store(rp)
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
	// Spawn the Slice-2 OOB-reconcile backstop (archive-failure visibility).
	// Bound to bgCtx (Shutdown cancels via bgCancel) and tracked by bgWG
	// (Shutdown awaits via bgWG.Wait) — same lifecycle as the archive cascade
	// jobs. The goroutine reads archiveBackstopInterval once at startup.
	srv.bgWG.Add(1)
	go srv.runArchiveBackstop()
	return srv, nil
}

// RetargetOpenCode re-targets the RUNNING server at a new OpenCode base URL
// (P1-API-003: after a fresh-port restart of the serve process — foreign
// listener on the old port, or a re-derived port — the daemon must keep
// serving through the new port immediately). Under aggMu it:
//
//  1. records s.opencodeURL, so per-directory aggregators created LAZILY
//     after the swap inherit the new target (aggFor reads it under the same
//     lock);
//  2. atomically swaps the /oc/* reverse proxy for one built against the new
//     target (whole-proxy swap: a director's parsed target is captured at
//     construction, so mutating it in place could never take effect);
//  3. re-targets every LIVE aggregator's client, the default "" included —
//     the aggregator keeps its store/subscribers and its reconnect loop
//     re-dials the new BaseURL per connection.
//
// NON-OBVIOUS INVARIANT — default-aggregator coverage (step 3): the default
// aggregator is ACCESSED outside the map (aggFor("")/aggForExisting("")
// return s.agg without consulting s.aggs), but its retarget coverage flows
// ONLY through the `s.aggs[""]` entry NewServer seeds alongside s.agg —
// the map walk below never looks at s.agg. Removing that seeded entry as
// "redundant" would silently drop default coverage (a retargeted server
// whose default aggregator keeps dialing the dead old port); conversely,
// "simplifying" the accessors to map-only lookups would still work only
// because the entry exists. The two designs are coupled on purpose; see
// reload_test.go's `s.aggs[""] == s.agg` assertions, which pin the entry.
//
// LOOPBACK ASSUMPTION: baseURL is a same-host loopback target by
// construction — both binaries spawn/attach `opencode serve --hostname
// 127.0.0.1` and retarget only to a port they just spawned on or
// re-derived from their own recorded state. RetargetOpenCode parses the URL
// but does NOT validate reachability or host shape; nothing here enforces
// loopback. A future remote-OpenCode feature that hands this a non-loopback
// URL is knowingly breaking that assumption (aggregator reconnects and the
// /oc proxy would dial off-host).
//
// Callers re-target BEFORE flipping any readiness signal (ocLife.SetReady):
// an observer that acts on readiness must never see ready state served
// through the old port. A same-URL call is a benign refresh. An unparseable
// URL keeps the current target (per-request 502s) rather than corrupting the
// running server; daemon-resolved URLs are parseable by construction.
func (s *Server) RetargetOpenCode(baseURL string) {
	u := strings.TrimRight(baseURL, "/")
	target, err := url.Parse(u)
	if err != nil {
		vhlog.Error("retarget refused an unparseable opencode URL; keeping the current target", "url", baseURL, "err", err)
		return
	}
	s.aggMu.Lock()
	defer s.aggMu.Unlock()
	s.opencodeURL = u
	s.proxy.Store(newOpenCodeProxy(target))
	for _, a := range s.aggs {
		a.Retarget(u)
	}
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

// SetArchiveRetryConfig overrides the archive cascade job's retry policy (a test
// seam mirroring SetReassertDelay). budget is the max SetArchived attempts per
// id; base is the initial exponential backoff; max is its ceiling. Captured
// under bgMu at job launch so the running job never reads shared mutable state.
// Tests shrink budget/base/max to keep failure-path assertions deterministic
// (production defaults are calibrated in archive.go — see defaultArchiveRetry*).
func (s *Server) SetArchiveRetryConfig(budget int, base, max time.Duration) {
	s.bgMu.Lock()
	s.archiveRetryBudget = budget
	s.archiveRetryBase = base
	s.archiveRetryMax = max
	s.bgMu.Unlock()
}

// Shutdown retires the Server's owned lifetimes and awaits them, bounded by ctx.
// It is idempotent and safe to call repeatedly (every cancellation it issues is
// idempotent; the WaitGroups are only ever waited, never re-Add'd after exit).
// It establishes an EXPLICIT per-directory ownership boundary — not a blanket
// context swap — by issuing each retirement signal AND awaiting the goroutines:
//
//  1. bgCancel() — cancels the background-task ctx (the post-archive re-assert
//     goroutine, and every non-default aggregator's RunManaged Run loop).
//  2. stopAllPermissionWatchers() — cancels + clears EVERY per-dir permission
//     watcher, including the default dir's. Watchers root their own ctx in
//     context.Background() (NOT bgCtx), so bgCancel alone cannot retire them;
//     cancelling the watcher ctx also aborts an in-flight auto-reject RPC (that
//     RPC's timeout is now derived from the watcher ctx — see reconcileFailFastPerms).
//  3. stopServerOwnedAggregators() — stops every NON-DEFAULT aggregator the
//     Server created lazily via aggFor. Aggregator.Stop() closes its store,
//     which closes every subscriber channel, retiring the queue/pin subscriber
//     range loops those aggregators own. The DEFAULT aggregator is daemon-owned
//     (started with plain Run(vhCtx), process-lifetime) and is deliberately NOT
//     stopped here — closing its store would sever daemon-owned SSE streams and
//     break callers that keep using the default aggregator across a Shutdown.
//
// After all retirement signals are issued, Shutdown awaits bgWG then lifecycleWG
// (the watchers + non-default subscribers), returning nil once both drain or
// ctx.Err() if the await is bounded by ctx. This proves server-owned per-dir
// watchers and subscriber-backed workers cannot remain live after Shutdown.
//
// Terminal-Shutdown contract: this is a terminal, single-caller teardown. In
// production both callers (cmd/client-daemon-vh, cmd/local-server) drain the HTTP
// server (vhHTTP.Shutdown) BEFORE srv.Shutdown, so no concurrent aggFor can
// install fresh lifecycle work during teardown; tests call Shutdown in cleanup.
// There is intentionally no admission barrier: the default aggFor path is
// lock-free for per-request performance, and the only race that could install
// post-signal work cannot occur at the actual call sites.
func (s *Server) Shutdown(ctx context.Context) error {
	s.bgCancel() // idempotent; never reassigned after NewServer
	s.stopAllPermissionWatchers()
	// Stop the per-dir drain loops (slice 2b phase 2) BEFORE the aggregator
	// teardown: bgCancel already signalled them AND stopAllQueueDrainLoops
	// fires each loop's retained per-loop cancel, then waits for the exit
	// (the loops' own aggregator lookups take aggMu, so waiting must happen
	// outside stopServerOwnedAggregators' aggMu hold — this is that outside
	// point). Non-default loops also retire their lifecycleWG entries, which
	// the wait below awaits.
	s.stopAllQueueDrainLoops()
	s.stopServerOwnedAggregators()
	waitDone := make(chan struct{})
	go func() {
		s.bgWG.Wait()
		s.lifecycleWG.Wait()
		close(waitDone)
	}()
	select {
	case <-waitDone:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// stopAllPermissionWatchers cancels and clears every per-dir permission
// reconcile watcher the Server armed (including the default dir's). Idempotent:
// a second call is a no-op over already-cleared entries. watcherMu is taken
// standalone (NOT nested under aggMu here) — Shutdown issues it as a separate
// phase before stopServerOwnedAggregators and never holds both at once, so it
// does not invert the established aggMu-outer nesting order. Cancelling the
// watcher ctx propagates to the in-flight auto-reject RPC inside
// reconcileFailFastPerms (its timeout derives from this ctx), letting a watcher
// blocked on a slow reject exit promptly instead of waiting out permRejectTimeout.
func (s *Server) stopAllPermissionWatchers() {
	s.watcherMu.Lock()
	for dir, cancel := range s.watcherCancel {
		cancel()
		delete(s.watcherCancel, dir)
		delete(s.watcherOn, dir)
	}
	s.watcherMu.Unlock()
}

// stopAllQueueDrainLoops signals every registered drain loop to stop — each
// loop's RETAINED per-loop cancel first, then the done wait — so the exit +
// custody release do not depend solely on bgCtx having been cancelled.
// Shutdown-only (reload uses the per-dir stopQueueDrainLoop). Safe on an
// empty registry.
func (s *Server) stopAllQueueDrainLoops() {
	s.drainLoopsMu.Lock()
	loops := make([]*queueDrainLoop, 0, len(s.drainLoops))
	for dir, l := range s.drainLoops {
		loops = append(loops, l)
		delete(s.drainLoops, dir)
	}
	s.drainLoopsMu.Unlock()
	for _, l := range loops {
		if l.cancel != nil {
			l.cancel()
		}
		<-l.done
	}
}

// stopServerOwnedAggregators stops every NON-DEFAULT aggregator the Server
// created lazily via aggFor, mirroring handleReloadProject's per-dir teardown
// (stop + delete + reset queueGCOn/pinsGCOn) applied to all server-owned
// non-default dirs at once. The read+stop+delete for each entry happens inside
// ONE aggMu critical section — no pre-snapshot — so it stays safe against a
// concurrent handleReloadProject identity recheck (shutdown-first → reload's
// cur==a recheck sees the entry gone and skips; reload-first → shutdown stops
// the replacement). Aggregator.Stop() closes the store (idempotent), closing
// every subscriber channel and retiring the queue/pin subscriber loops. The
// DEFAULT dir ("") is skipped: that aggregator is daemon-owned and
// process-lifetime (its Run loop is owned by vhCancel, not RunManaged), so
// stopping/closing it here would invalidate a resource owned by another
// lifecycle boundary. Nested lock order matches reload: aggMu outer,
// queueGCMu/pinsGCMu inner.
func (s *Server) stopServerOwnedAggregators() {
	s.aggMu.Lock()
	for dir, a := range s.aggs {
		if dir == "" {
			continue
		}
		a.Stop()
		delete(s.aggs, dir)
		s.queueGCMu.Lock()
		delete(s.queueGCOn, dir)
		s.queueGCMu.Unlock()
		s.sessionErrMu.Lock()
		delete(s.sessionErrOn, dir)
		s.sessionErrMu.Unlock()
		s.queueDeliverMu.Lock()
		delete(s.queueDeliverOn, dir)
		s.queueDeliverMu.Unlock()
		s.pinsGCMu.Lock()
		delete(s.pinsGCOn, dir)
		s.pinsGCMu.Unlock()
		s.labelsGCMu.Lock()
		delete(s.labelsGCOn, dir)
		s.labelsGCMu.Unlock()
	}
	s.aggMu.Unlock()
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
		s.installQueueSessionErrorSignal("", s.agg)
		s.installQueueDeliveryWatcher("", s.agg)
		s.installPinsLifecycle("", s.agg)
		s.installLabelsLifecycle("", s.agg)
		s.maybeStartQueueDrainLoop("")
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
	// Upstream-down gating (oc-death-watch S2): propagate the daemon's
	// lifecycle-derived predicate so this per-dir Run loop also skips the
	// 1s retry ramp while OpenCode is known down. Read outside aggMu — the
	// daemon installs it once at boot, before any request can reach aggFor.
	if s.upstreamDownProbe != nil {
		a.SetUpstreamDownProbe(s.upstreamDownProbe)
	}
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
	s.installQueueSessionErrorSignal(dir, a)
	s.installQueueDeliveryWatcher(dir, a)
	s.installPinsLifecycle(dir, a)
	s.installLabelsLifecycle(dir, a)
	s.maybeStartQueueDrainLoop(dir)
	// Run under the Server's background-task lifetime (bgCtx) so Shutdown cancels
	// this per-directory aggregator's RunManaged child. RunManaged derives a
	// cancellable CHILD of bgCtx and arms a.cancel internally, so cancelling that
	// child closes the aggregator's always-on /event SSE subscription — the
	// connection a backing httptest/fake server's /event handler waits on, so the
	// server can Close() without hanging. Per-project drop isolation is preserved:
	// handleReloadProject can still drop ONE project via a.Stop() (cancels only
	// that child) without disturbing the default or any other project. Scope note:
	// Shutdown now retires these per-dir lifetimes EXPLICITLY — it cancels every
	// permission watcher (stopAllPermissionWatchers) and stops this non-default
	// aggregator (stopServerOwnedAggregators → a.Stop() → store.Close(), retiring
	// the queue/pin subscriber range loops) and awaits all of them via lifecycleWG.
	// The default aggregator ("") is daemon-owned and is NOT stopped by Shutdown.
	go a.RunManaged(s.bgCtx)
	return a
}

// aggForExisting returns the aggregator for dir only if one already exists —
// WITHOUT creating it or firing the managed-project / open hooks. Request paths
// that must not have the side effect of opening a project (header stamping on an
// arbitrary ?dir=) use this, so a benign GET can't launch a project's managed
// processes or grow the aggregator map for an attacker-chosen directory. Returns
// the default aggregator for "" (already running, accessed via s.agg OUTSIDE
// the map — see the aggs field note and RetargetOpenCode's coverage invariant)
// and nil for an unopened dir.
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

// SetUpstreamDownProbe installs the daemon's "OpenCode is known down right now"
// predicate (oc-death-watch S2): applied to the default aggregator immediately
// and to every per-dir aggregator aggFor lazily creates, so all aggregator Run
// loops cap their reconnect/hydrate retry backoffs while the daemon knows the
// upstream is dead instead of ramping from 1s against the dead port (N+1
// per-project loops otherwise hammer it every second). The daemon calls this
// once at boot, before serving requests; not calling it (external
// --opencode-url mode) leaves every aggregator's behavior unchanged.
func (s *Server) SetUpstreamDownProbe(fn func() bool) {
	s.upstreamDownProbe = fn
	if s.agg != nil && fn != nil {
		s.agg.SetUpstreamDownProbe(fn)
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
	// Busy-indexes diagnostic: read-only GET, auth-gated like every other
	// /vh/* route. GET-only at the handler too (defense in depth, mirrors
	// /vh/diag/latency). Dumps per-workspace RunningRoots + subtreeBusy +
	// per-session activity so a phantom running count is one-query-diagnosable.
	mux.HandleFunc("/vh/diag/busy", s.handleDiagBusy)
	// Standing-proof invariant diagnostic (GET-only → no CSRF). Diffs the
	// daemon's resident message/parts vs a fresh OpenCode fetch per session and
	// reports per-invariant pass/fail/deferred with evidence for the daemon-side
	// subset (INV-1/2/3 live; INV-4/8 structural → deferred to Go property
	// tests). Side-effect-free: uses aggForExisting (never opens a project). See
	// pkg/web/diag_invariants.go.
	mux.HandleFunc("/vh/diag/invariants", s.handleDiagInvariants)
	mux.HandleFunc("/vh/skill/emit", s.handleSkillEmit)
	mux.HandleFunc("/vh/version", func(w http.ResponseWriter, r *http.Request) {
		// Capability advert (send-net-resilience slice 1; slice 2b phase 2
		// made daemonDispatchCapable RUNTIME-reflective): queueSchemaVersion
		// is the on-disk queue.json schema this binary writes/understands;
		// daemonDispatchCapable advertises daemon-owned dispatch custody —
		// the LIVE value of the --daemon-dispatch opt-in (default OFF) — so
		// clients feature-detect the daemon-dispatch era on the EXISTING
		// version endpoint rather than a parallel mechanism. Additive keys:
		// existing consumers read "version" only.
		writeJSONResp(w, map[string]any{
			"version":               s.version(),
			"queueSchemaVersion":    queueSchemaVersion,
			"daemonDispatchCapable": DaemonDispatchEnabled(),
		})
	})
	mux.HandleFunc("/vh/snapshot", s.handleSnapshot)
	mux.HandleFunc("/vh/projects", s.handleProjects)
	// Lean fleet-rollup acquisition endpoint (GET-only → no CSRF exception
	// needed): the controller's /vh/fleet/status rollup consumes ONLY the
	// per-project gate map, and a full /vh/snapshot per project ships
	// megabytes of session/message JSON the rollup never reads (measured
	// ~5.9 MB across 7 real projects, timing out a WAN-tunnel refresh). One
	// batched request returns only the gate facts. See handleFleetGates.
	mux.HandleFunc("/vh/gates", s.handleFleetGates)
	mux.HandleFunc("/vh/views", s.handleViews)
	mux.HandleFunc("/vh/managed", s.handleManaged)
	mux.HandleFunc("/vh/project-settings", s.handleProjectSettings)
	mux.HandleFunc("/vh/project-settings/watch", s.handleProjectSettingsWatch)
	mux.HandleFunc("/vh/trust", s.handleTrust)
	mux.HandleFunc("/vh/theme.json", s.handleThemeJSON)
	mux.HandleFunc("/vh/theme.css", s.handleThemeCSS)
	mux.HandleFunc("/vh/stream", s.handleStream)
	// Liveness sentinel probe (webperf slice 4): POST /vh/stream/probe emits a
	// transient no-id vh.liveness event into the project store. See
	// stream_probe.go for the full wire contract and invariant set.
	mux.HandleFunc("/vh/stream/probe", s.handleStreamProbe)
	mux.HandleFunc("/vh/render", s.handleRender)
	mux.HandleFunc("/vh/highlight.css", s.handleHighlightCSS)
	// Image proxy: GET-only, auth-gated (under /vh/*). Fetches external images
	// through an SSRF-hardened transport so the SPA never makes a direct
	// cross-origin image request. See pkg/web/img.go.
	mux.HandleFunc("/vh/img", s.handleImg)
	mux.HandleFunc("/vh/notes", s.handleNotes)
	// Server-managed pinned sessions (Phase 2): GET reads the worker-wide pin
	// doc, PUT applies a CAS-guarded replace. PUT is state-changing and is
	// guarded by the csrfGuard middleware wrapping every /vh/* route (no
	// per-handler CSRF check needed). See pkg/web/pins_http.go.
	mux.HandleFunc("/vh/pins", s.handlePins)
	// Server-managed named tab layouts (worker-scoped v1): GET reads the
	// worker-wide catalog, PUT applies a PER-ENTRY CAS upsert (one entry +
	// required baseRevision per request — whole-catalog replace is a design
	// violation). PUT is state-changing and is guarded by the csrfGuard
	// middleware wrapping every /vh/* route (no per-handler CSRF check
	// needed). No SSE fan-out in v1. See pkg/web/named_layouts_http.go.
	mux.HandleFunc("/vh/layouts", s.handleNamedLayouts)
	// Server-managed root-session labels (Slice 2): GET reads the worker-wide
	// labels doc (groups + tags + per-root tag assignments), PUT applies a
	// CAS-guarded replace. PUT is state-changing and is guarded by the
	// csrfGuard middleware wrapping every /vh/* route (no per-handler CSRF
	// check needed). See pkg/web/labels_http.go.
	mux.HandleFunc("/vh/labels", s.handleLabels)
	mux.HandleFunc("/vh/attach", s.handleAttach)
	mux.HandleFunc("/vh/quota", s.handleQuota)
	mux.HandleFunc("/vh/archive", s.handleArchive)
	mux.HandleFunc("/vh/unarchive", s.handleArchive)
	// POST /vh/delete {sessionID, expectedFingerprint?} — delete a session and
	// its subtree (DESTRUCTIVE, irreversible; OpenCode auto-cascades). Mirrors
	// /vh/archive's cascade + C5 drift fence + RemoveSessions/queue/pins tail,
	// minus the archive re-assert goroutine. See pkg/web/delete.go.
	mux.HandleFunc("/vh/delete", s.handleDelete)
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
	// P4: server-authoritative archive-impact descendant list. GET-only → no
	// CSRF. Returns {epoch, revision, data:{sessionId, descendants:[{id,title,
	// parentID}]}}. Replaces the FE resident-map walk that omitted unloaded
	// descendants of collapsed frontier nodes. See pkg/web/session_subtree_http.go.
	mux.HandleFunc("GET /vh/session/{sessionId}/descendants", s.handleSessionDescendants)
	// P5: server-authoritative subtree todo rollup. GET-only → no CSRF.
	// Returns {epoch, revision, data:{sessionId, items:[TodoItem],
	// totals:{active,left,total}}}. Replaces the FE resident-map walk
	// (sessionTodos/sessionTodoCounts) that omitted unloaded descendants.
	// See pkg/web/session_subtree_http.go.
	mux.HandleFunc("GET /vh/session/{sessionId}/subtree-todos", s.handleSubtreeTodos)
	// Phase 2 tree=2 expand endpoint: GET → no CSRF.
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
	mux.HandleFunc("/vh/git/log", s.handleGitLog)
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
	return s.securityHeaders(s.auth.Middleware(s.cors(csrfGuard(logRequests(s.stampMeta(s.dispatchView(mux)))))))
}

// stampMeta sets X-VH-Epoch and X-VH-Seq on /vh/* responses so a cross-worker
// coordinator can key its resume cursor by (worker, epoch, seq) and detect a
// worker restart (epoch change) from any response — not just a snapshot. The seq
// is the head at request entry (a hint; the authoritative cursor is the snapshot/
// stream's own seq). Headers are set before the handler writes, so they survive
// streaming and hijacked (terminal/WebSocket) responses. Slice B additionally
// stamps X-VH-Tunnel-State (daemon tunnel status) when a provider is wired.
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
			// Slice B (send-net-resilience): stamp the daemon's tunnel state
			// when a provider is wired (client-daemon only). Omitted
			// otherwise — absence means UNKNOWN to the FE, never "down".
			// Observational status input only (debate-1 Q5): nothing gates
			// delivery on this header.
			if fn := s.tunnelState.Load(); fn != nil {
				if v := (*fn)(); v != "" {
					h.Set("X-VH-Tunnel-State", v)
				}
			}
		}
		next.ServeHTTP(w, r)
	})
}
