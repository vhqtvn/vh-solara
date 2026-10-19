package web

// Server configuration and wiring setters, moved verbatim from server.go
// (slice 15 of the server.go split): capability registration
// (RegisterFeature), auth/CORS/frame-ancestors/host-fold/app-version wiring,
// the version + skill-emit pair, OpenCode
// topology/lifecycle/generation/restart wiring, managed-projects wiring
// (SetManaged/InitManaged), and the test-seam timing overrides
// (SetReassertDelay/SetArchiveRetryConfig). The Server struct, NewServer,
// the route table (Handler), and stampMeta remain in server.go.

import (
	"context"
	"io"
	"net/http"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/auth"
	"github.com/vhqtvn/vh-solara/pkg/oclife"
	"github.com/vhqtvn/vh-solara/pkg/procmgr"
	"github.com/vhqtvn/vh-solara/pkg/skill"
)

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
// + views). Optional; nil leaves managed projects disabled. The field write is
// aggMu-guarded to match aggFor's locked reads, so safety does not rest on the
// daemon's once-at-boot, before-serving install discipline (the daemons do
// still call it that way).
func (s *Server) SetManaged(o *Orchestrator) {
	s.aggMu.Lock()
	s.managed = o
	s.aggMu.Unlock()
}

// InitManaged builds and installs the managed-project orchestrator over the
// given process manager and trust store, sharing this server's view registry.
// cfgOverride ("") uses conventional .vh-solara/project.jsonc discovery;
// autoTrust is the headless escape hatch that approves configs without a prompt.
// Discovery is lazy for every project (default + ?dir=): the aggFor open hook
// fires on the first browser request that touches a project, so the returned
// orchestrator need not be driven by the caller. Like SetManaged, the field
// install is aggMu-guarded (aggFor reads the field under the same lock).
func (s *Server) InitManaged(mgr *procmgr.Manager, trust *TrustStore, cfgOverride string, autoTrust bool) *Orchestrator {
	o := NewOrchestrator(mgr, trust, s.views, cfgOverride)
	o.autoTrust = autoTrust
	s.aggMu.Lock()
	s.managed = o
	s.aggMu.Unlock()
	return o
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
