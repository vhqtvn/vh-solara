package web

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strconv"
)

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
