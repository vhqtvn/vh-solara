package web

// Request logging, moved verbatim from server.go (slice 5 of the server.go
// split): the logRequests middleware (VH_DEBUG-gated debug line per /oc/* and
// mutating /vh/* request, wired in server.go's Handler chain) and the
// statusWriter wrapper that captures the response status while forwarding
// http.Flusher and http.Hijacker so streamed/proxied responses keep flushing
// and the terminal WebSocket upgrade can take over the connection.
// streamClassLabel, which sat between these two blocks in server.go, belongs
// to the stream slice and stays in server.go.

import (
	"bufio"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

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
