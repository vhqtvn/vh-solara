package diagnostics

import "net/http"

// ProxyPathClass enumerates the fixed HTTP-handler path-classes whose egress
// bytes cross the tunnel but were NOT attributed by Probe 3 (which wraps only
// the /vh/stream SSE pump via StreamStatsWriter). Before this probe, every
// non-stream tunnel byte — passthrough /oc/*, embedded views, code files,
// renders, one-shot snapshots, branch expands, message pages, and the terminal
// websocket pump — showed up ONLY in the aggregate ws_write / yamux totals
// (a live re-measurement found ~97-99% of a 1806 MB/hr tunnel burst was this
// uninstrumented raw-proxy traffic). Each such handler now reports its egress
// bytes into exactly one of these classes so the operator can reconcile
// sum(handler_bytes) + sum(stream.bytes) against the aggregate ws_write.
//
// Fixed cardinality — NO per-URL / per-session / per-stream-id labels, by the
// same discipline as every other probe.
const (
	ProxyPathPassthrough = iota // 0 — handlePassthrough /oc/* reverse proxy → OpenCode
	ProxyPathView               // 1 — managed embedded views reverse-proxy → unix/tcp upstream
	ProxyPathCodeFile           // 2 — /vh/code/file (one file's content)
	ProxyPathRender             // 3 — /vh/render (batched markdown/diff/patch render)
	ProxyPathSnapshot           // 4 — /vh/snapshot (one-shot full/projected snapshot)
	ProxyPathBranch             // 5 — /vh/sessions/branch (lazy-expand projected page)
	ProxyPathMessages           // 6 — /vh/session/{id}/messages (historical message page)
	ProxyPathTerminal           // 7 — /vh/term/ws websocket pump (terminal PTY egress)
	numProxyPathClasses
)

// proxyPathClassName mirrors the constants for JSON output.
var proxyPathClassName = [numProxyPathClasses]string{
	"passthrough",
	"view",
	"code_file",
	"render",
	"snapshot",
	"branch",
	"messages",
	"terminal",
}

// HandlerBytesStats is the per-path-class byte counter for the non-stream
// tunnel legs. Counter-only (no histograms) so NO initSentinels entry is
// needed — see primitives.go (only Histograms require the uninitialized-min
// sentinel). All fields are pure atomics; safe for concurrent use.
type HandlerBytesStats struct {
	// Bytes written to the ResponseWriter (post-compression, since the handler
	// writes the maybeCompressSnapshot'd payload). For the terminal pump this
	// is the websocket frame payload length.
	Bytes Counter
	// Number of Write calls (≈ one per response for one-shot handlers, many
	// for streamed reverse-proxy legs).
	Writes Counter
}

// HandlerBytesWriter wraps an http.ResponseWriter to count egress bytes at the
// HTTP-handler altitude. It mirrors StreamStatsWriter (Probe 3) but is stripped
// to a byte counter only — no timing / interarrival / incident ring, because
// these handlers are request/response (not a long-lived SSE pump) and the
// timing signal is already captured downstream in Probe 4 (yamux) / Probe 5
// (ws_write) / Probe 6 (io.Copy). Preserves http.Flusher so reverse-proxy
// streaming (httputil.ReverseProxy with FlushInterval=-1, which type-asserts
// http.Flusher) keeps working.
//
// IMPORTANT CAVEAT (same as StreamStatsWriter): a successful Write only means
// the bytes reached the local kernel TCP send buffer, NOT the browser. On the
// tunnel topology these bytes are then re-read by the controller's io.Copy
// (Probe 6) and written into a yamux stream (Probe 4) and the tunnel WebSocket
// (Probe 5). The handler_bytes counter is the ORIGIN attribution; correlate
// with ws_write / yamux / copy for end-to-end timing.
type HandlerBytesWriter struct {
	http.ResponseWriter
	flusher http.Flusher
	stats   *HandlerBytesStats
}

// NewHandlerBytesWriter wraps rw for the given path-class. The class must be
// one of the ProxyPathClass constants. The caller assigns the returned value
// back to its local w and the rest of the handler writes through it unchanged.
func NewHandlerBytesWriter(rw http.ResponseWriter, class int) *HandlerBytesWriter {
	flusher, _ := rw.(http.Flusher)
	return &HandlerBytesWriter{
		ResponseWriter: rw,
		flusher:        flusher,
		stats:          &Default.HandlerBytes[class],
	}
}

func (h *HandlerBytesWriter) Write(p []byte) (int, error) {
	n, err := h.ResponseWriter.Write(p)
	h.stats.Bytes.Add(uint64(n))
	h.stats.Writes.Inc()
	return n, err
}

// Unwrap exposes the underlying http.ResponseWriter so an http.ResponseController
// (Go 1.20+) can reach the real writer's Hijack / Flusher / Pusher through this
// wrapper. This is REQUIRED for the reverse-proxy legs (handlePassthrough /oc/*
// and dispatchView managed views): httputil.ReverseProxy.handleUpgradeResponse
// calls http.NewResponseController(rw).Hijack() on a 101 Switching Protocols
// response, and without Unwrap it would return http.ErrNotSupported and abort
// the upgrade (breaking any /oc/* or view WebSocket/protocol-upgrade leg). The
// StreamStatsWriter pattern this mirrors was safe only because /vh/stream is SSE
// (a 200 text/event-stream, never 101) — applying the same wrapper to a surface
// that CAN upgrade MUST chain through Unwrap so the hijack reaches the real
// connection. Mirrors the canonical Go ResponseController unwrap contract.
func (h *HandlerBytesWriter) Unwrap() http.ResponseWriter { return h.ResponseWriter }

// Flush delegates to the underlying Flusher so reverse-proxy streaming keeps
// working. No-op if the wrapped writer does not implement http.Flusher.
func (h *HandlerBytesWriter) Flush() {
	if h.flusher != nil {
		h.flusher.Flush()
	}
}

// RecordHandlerBytes adds n bytes to a path-class counter without a writer
// wrapper. Used by handlers that do not write through http.ResponseWriter —
// specifically the terminal websocket pump, which writes via
// conn.WriteMessage (a hijacked connection, not the ResponseWriter).
func RecordHandlerBytes(class int, n int) {
	if class < 0 || class >= numProxyPathClasses || n <= 0 {
		return
	}
	Default.HandlerBytes[class].Bytes.Add(uint64(n))
	Default.HandlerBytes[class].Writes.Inc()
}

// IncStream2ReplayFallback notes that a Stream2 (projected /vh/stream) resume
// fell back to a fresh full snapshot because the shared replay ring had
// evicted the client's cursor (Replay returned ok=false despite hasCursor).
// A non-zero rate under multi-session load is the signal that the single
// 4096-event shared ring (cmd/client-daemon.go) is evicting one session's
// cursor under another session's traffic — see the deferred per-session-ring
// finding. Recorded at the handleStream fresh-snapshot branch.
func IncStream2ReplayFallback() {
	Default.Stream2ReplayFallback.Inc()
}
