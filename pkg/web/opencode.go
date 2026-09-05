package web

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// Bounding constants for abortInflightBeforeRestart (P1-API-007 layer a).
// Per-call ~2s: a healthy Abort is one HTTP round-trip; anything slower is a
// dying instance. Shared budget ~5s across the whole fleet sweep so a fleet
// of hung instances cannot serially stall the restart request. Both are
// ceilings, not targets — the sweep returns as soon as every running session
// is attempted, and budget expiry PROCEEDS to the restart (the store-side
// interrupted-turn sweep heals whatever the abort could not close).
const (
	defaultRestartAbortPerCall = 2 * time.Second
	defaultRestartAbortBudget  = 5 * time.Second
)

// abortInflightBeforeRestart runs the /vh/abort verb choreography (verbs.go:
// Abort → InflightAssistantID → Stop) for EVERY running turn across the whole
// aggregator fleet, before a restart kills the OpenCode process mid-turn
// (P1-API-007 layer a). Without this, the killed turn's assistant message is
// left permanently unmarked — OpenCode never writes a terminal for it — and
// the UI silently truncates the turn. A graceful Abort lets OpenCode itself
// write the REAL terminal (MessageAbortedError) into its own DB, the only
// writer that can close the upstream row; layer (b) (pkg/state
// sweepInterruptedTurnsLocked, authoritative-not-busy marker) heals the cases
// the abort cannot reach (hang, error, daemon restart, crash, reboot).
//
// Semantics mirror verbs.go exactly, per session: Abort error → log + skip
// Stop (the verb's early-return); Abort success → Stop(sid,
// InflightAssistantID(sid)) so the stop-generation machinery settles and any
// /vh/send CAS waiter wakes. Stop deliberately does NOT force idle
// synchronously — settlement stays Store.Stop's settle timer + periodic
// /session/status reconcile, unchanged.
//
// Failure containment (the operator's "abort itself cannot complete" case):
// every Abort carries a per-call timeout and the whole sweep a shared
// wall-clock budget. Expiry never blocks the restart — it logs and the caller
// proceeds; the orphan sweep later synthesizes the interrupted marker for
// turns the abort could not close. Bounded total worst case ≈ budget, not
// N×per-call.
//
// Restart is fleet-wide by nature (restartOC restarts THE instance every
// aggregator shares), so the sweep walks s.aggs under the same aggMu snapshot
// pattern as handleRunningSessions — NOT just the request's own aggregator.
func (s *Server) abortInflightBeforeRestart(ctx context.Context) {
	aggs := make([]*aggregator.Aggregator, 0, len(s.aggs))
	s.aggMu.Lock()
	for _, a := range s.aggs {
		aggs = append(aggs, a)
	}
	s.aggMu.Unlock()
	if len(aggs) == 0 {
		return
	}
	deadline := time.Now().Add(s.restartAbortBudget)
	for _, agg := range aggs {
		for _, sid := range agg.Store().RunningSessionIDs() {
			if err := ctx.Err(); err != nil {
				return
			}
			remaining := time.Until(deadline)
			if remaining <= 0 {
				vhlog.Warn("restart abort sweep: shared budget expired; proceeding to restart without further aborts",
					"runningSession", sid)
				return
			}
			perCall := s.restartAbortPerCall
			if perCall > remaining {
				perCall = remaining
			}
			callCtx, cancel := context.WithTimeout(ctx, perCall)
			if err := agg.Client().Abort(callCtx, sid); err != nil {
				cancel()
				// Mirror the verb's early-return semantics: no Stop, no
				// retry — the sweep's job is opportunistic closure, and the
				// store-side marker owns the heal for this turn.
				vhlog.Warn("restart abort sweep: Abort failed; skipping Stop (turn heals via interrupted-marker sweep)",
					"sessionID", sid, "error", err.Error())
				continue
			}
			cancel()
			canceledTurnID := agg.Store().InflightAssistantID(sid)
			agg.Store().Stop(sid, canceledTurnID)
		}
	}
}

// OpenCode version/update hooks, wired by the daemon (which knows the binary
// and the environment OpenCode runs under). nil when OpenCode isn't managed.
type OpenCodeVersions struct {
	// Installed is the on-disk binary's version (`<bin> --version`). Running is
	// the version of the live `opencode serve` process (captured when it was
	// last started). After an update without a restart, Installed advances while
	// Running stays — that gap is what the UI prompts the user to apply.
	Installed string `json:"installed"`
	Running   string `json:"running"`
	Latest    string `json:"latest"`

	UpdateAvailable bool `json:"updateAvailable"` // a newer version than Installed exists
	RestartNeeded   bool `json:"restartNeeded"`   // Installed differs from Running
}

func (s *Server) SetOpenCodeVersion(fn func(context.Context) (installed, running, latest string, err error)) {
	s.ocVersionFn = fn
}

// SetUpdateOpenCode wires the update hook. It runs the configured update command
// streaming its output to w, and must NOT restart OpenCode — restart is a
// separate, explicit user action so the operator can confirm the new version and
// choose when to interrupt running sessions.
func (s *Server) SetUpdateOpenCode(fn func(ctx context.Context, w io.Writer) error) {
	s.ocUpdateFn = fn
}

// GET /vh/opencode-version — installed vs running vs latest OpenCode version.
func (s *Server) handleOpenCodeVersion(w http.ResponseWriter, r *http.Request) {
	if s.ocVersionFn == nil {
		http.Error(w, "OpenCode is not managed by this server", http.StatusNotImplemented)
		return
	}
	installed, running, latest, err := s.ocVersionFn(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSONResp(w, OpenCodeVersions{
		Installed:       installed,
		Running:         running,
		Latest:          latest,
		UpdateAvailable: latest != "" && installed != "" && latest != installed,
		RestartNeeded:   installed != "" && running != "" && installed != running,
	})
}

// GET /vh/opencode/status — the worker-local OpenCode lifecycle snapshot
// (topology, state, failure summary, exit code, capabilities, diagnostic
// completeness). This is the p1-oc-001 decoupling surface: it is served
// DIRECTLY from the worker's own memory with NO dial to OpenCode, so it
// answers even when OpenCode has crashed and its port refuses connections.
// That is precisely the case where an operator (reaching the worker through
// the yamux raw proxy) needs to SEE that OpenCode is failed and why — instead
// of the worker having died with it.
//
// Auth-gated like the other /vh/* routes (NOT in the /vh/healthz exempt list);
// GET is CSRF-exempt by csrfGuard. Returns 503 when this server does not
// manage an OpenCode lifecycle (e.g. the fixture server, or a topology that
// never wired one) — distinct from OpenCode being failed (which returns 200
// with state="failed").
func (s *Server) handleOpenCodeStatus(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.ocLifecycle == nil {
		http.Error(w, "OpenCode lifecycle is not managed by this server", http.StatusServiceUnavailable)
		return
	}
	writeJSONResp(w, s.ocLifecycle.Snapshot())
}

// ocLogMaxDefault / ocLogMaxCap bound the ?max= query param for
// /vh/opencode/logs. The default (4 KiB) is a reasonable recent-tail for a
// mobile UI; the cap (64 KiB) prevents a single response from dominating a
// tunnel-constrained link. The ring itself is bounded to ringlog.DefaultCap
// (256 KiB), so the cap is always <= what the ring could ever hold.
const (
	ocLogMaxDefault = 4096
	ocLogMaxCap     = 65536
)

// parseLogMax extracts the ?max= query param, clamped to [1, ocLogMaxCap].
// A missing, non-numeric, or non-positive value yields ocLogMaxDefault.
func parseLogMax(r *http.Request) int {
	raw := r.URL.Query().Get("max")
	if raw == "" {
		return ocLogMaxDefault
	}
	n, err := strconv.Atoi(raw)
	if err != nil || n <= 0 {
		return ocLogMaxDefault
	}
	if n > ocLogMaxCap {
		return ocLogMaxCap
	}
	return n
}

// GET /vh/opencode/logs — a bounded tail of the OpenCode process's merged
// stdout/stderr, served from the worker's own ring (no OpenCode dial). This is
// the second capability-aware endpoint on the p1-oc-001 lifecycle surface: it
// answers even when OpenCode has crashed, which is precisely when the operator
// most needs to see what the process printed before it died.
//
// Auth-gated like the other /vh/* routes; GET is CSRF-exempt by csrfGuard.
// Returns:
//   - 503 when no lifecycle is wired (fixture/local mode).
//   - 501 when the topology lacks HasLogTail (external — no ring to read).
//   - 200 text/plain with up to ?max= bytes (default 4 KiB, cap 64 KiB) of the
//     most recent process output.
//
// The body is raw, un-redacted process output. The endpoint is auth-gated
// (operator-only); a redaction utility is a follow-up.
func (s *Server) handleOpenCodeLogs(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.ocLifecycle == nil {
		http.Error(w, "OpenCode lifecycle is not managed by this server", http.StatusServiceUnavailable)
		return
	}
	snap := s.ocLifecycle.Snapshot()
	if !snap.Capabilities.HasLogTail {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusNotImplemented)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error": "this OpenCode topology does not expose a log tail (external)",
		})
		return
	}
	ring := s.ocLifecycle.Ring()
	if ring == nil {
		// Defensive: capability says HasLogTail but the ring is nil. Should not
		// happen for owned/detached (New allocates one), but guard against a
		// nil-deref so the endpoint degrades to 503 instead of a panic.
		http.Error(w, "log ring is not available", http.StatusServiceUnavailable)
		return
	}
	tail := ring.Tail(parseLogMax(r))
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(tail)
}

// POST /vh/opencode/restart — restart the managed OpenCode process through the
// lifecycle surface. This is the capability-aware counterpart to the older
// /vh/restart-opencode endpoint: it checks CanRestart from the lifecycle
// snapshot (so an external topology gets an honest 405 instead of a deferred
// error) and returns the NEW lifecycle snapshot so the client sees the final
// state (ready/failed) without a follow-up poll.
//
// Auth-gated + CSRF-protected (the existing csrfGuard requires X-VH-CSRF: 1 on
// POST to /vh/*). Sync: the restart hook blocks until the new process is ready
// (or fails), which may take up to the 30 s readiness timeout. The lifecycle
// transitions to "starting" immediately (inside restartOpencodeLocked), so a
// client that times out and polls /vh/opencode/status sees the in-flight state.
//
// Returns:
//   - 503 when no lifecycle is wired.
//   - 405 when the topology lacks CanRestart (external without a restart cmd).
//   - 501 when the lifecycle advertises CanRestart but no restart hook is wired
//     (should not happen on the daemon; defensive for test/fixture servers).
//   - 500 when the restart hook returns an error (the lifecycle is already set
//     to "failed" with the summary by restartOpencodeLocked).
//   - 200 application/json with the post-restart Snapshot.
func (s *Server) handleOpenCodeRestart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.ocLifecycle == nil {
		http.Error(w, "OpenCode lifecycle is not managed by this server", http.StatusServiceUnavailable)
		return
	}
	snap := s.ocLifecycle.Snapshot()
	if !snap.Capabilities.CanRestart {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusMethodNotAllowed)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"error": "this OpenCode topology does not support restart (external)",
		})
		return
	}
	if s.restartOC == nil {
		http.Error(w, "OpenCode restart is not wired on this server", http.StatusNotImplemented)
		return
	}
	// P1-API-007 layer (a): abort every running turn fleet-wide BEFORE the
	// restart kills the process mid-turn, so OpenCode itself writes the real
	// terminal for each aborted turn. Bounded (≈5s shared budget): an abort
	// that fails or hangs never blocks the restart — the store-side
	// interrupted-marker sweep (layer b) heals those turns instead.
	s.abortInflightBeforeRestart(r.Context())
	if err := s.restartOC(r.Context()); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSONResp(w, s.ocLifecycle.Snapshot())
}

// POST /vh/update-opencode — run the configured OpenCode update (default
// `<bin> upgrade`, or --opencode-update-cmd) in OpenCode's environment, STREAMING
// its stdout/stderr to the response so the UI can show the install log live. Does
// not restart OpenCode; the client confirms the new version and restarts
// separately. The stream is plain text, chunked, flushed as output arrives.
func (s *Server) handleUpdateOpenCode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.ocUpdateFn == nil {
		http.Error(w, "OpenCode is not managed by this server", http.StatusNotImplemented)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(http.StatusOK)

	fw := &flushWriter{w: w}
	if f, ok := w.(http.Flusher); ok {
		fw.f = f
	}
	if err := s.ocUpdateFn(r.Context(), fw); err != nil {
		// The 200 header is already sent, so surface the failure in the stream
		// itself with a sentinel the client scans for.
		_, _ = io.WriteString(fw, "\n[vh] update failed: "+err.Error()+"\n")
		return
	}
	_, _ = io.WriteString(fw, "\n[vh] update complete\n")
}

// flushWriter flushes the HTTP response after every write so the client sees the
// install log line-by-line instead of buffered to the end.
type flushWriter struct {
	w io.Writer
	f http.Flusher
}

func (fw *flushWriter) Write(p []byte) (int, error) {
	n, err := fw.w.Write(p)
	if fw.f != nil {
		fw.f.Flush()
	}
	return n, err
}
