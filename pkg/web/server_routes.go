// Route table: Handler assembles the mux and the middleware chain; stampMeta
// stamps /vh/* responses with resume-cursor metadata. Split from server.go
// (move-only refactor).
package web

import (
	"net/http"
	"strconv"
	"strings"

	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
)

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
		// made daemonDispatchCapable RUNTIME-reflective; queue-policy slice
		// B1 added queueDispatchPolicyVersion): queueSchemaVersion is the
		// MAX on-disk queue.json schema this binary writes/understands;
		// daemonDispatchCapable advertises daemon-owned dispatch custody —
		// the LIVE value of the --daemon-dispatch opt-in (default OFF) — so
		// clients feature-detect the daemon-dispatch era on the EXISTING
		// version endpoint rather than a parallel mechanism.
		// queueDispatchPolicyVersion is advertised ONLY while the policy
		// scheduler is ACTIVE (2026-10-29 amendment §4 / G3: "advertised in
		// server capabilities only when the policy scheduler is supported
		// and actively enabled" — the same enablement that runs the daemon
		// drain loop); the key is ABSENT otherwise so a missing/unsupported
		// capability never activates modern gestures. Additive keys:
		// existing consumers read "version" only.
		advert := map[string]any{
			"version":               s.version(),
			"queueSchemaVersion":    queueSchemaVersion,
			"daemonDispatchCapable": DaemonDispatchEnabled(),
		}
		if queuePolicySchedulerActive() {
			advert["queueDispatchPolicyVersion"] = queueDispatchPolicyVersion
		}
		writeJSONResp(w, advert)
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
	// Server-managed root-session labels (Slice 2): GET reads the PER-PROJECT
	// labels doc (groups + tags + per-root tag assignments; resolved via
	// labelsForDir — see labels_registry.go), PUT applies a CAS-guarded
	// replace. PUT is state-changing and is guarded by the
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
	// Pending-chip Send-now escalation (queue-policy slice B1; 2026-10-29
	// amendment §2): cancel + re-admit with dispatchPolicy "now" behind the
	// custody fence. An admission-grade gesture (browser-callable like
	// enqueue, unlike claim/resolve); CSRF enforced by csrfGuard.
	mux.HandleFunc("POST /vh/session/{sessionId}/queue/{itemId}/escalate", s.handleQueueEscalate)
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
