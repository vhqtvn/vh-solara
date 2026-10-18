package web

// OpenCode passthrough proxy + provider single-flight, moved verbatim from
// server.go (slice 2 of the server.go split): the /oc/* reverse-proxy builder
// (newOpenCodeProxy), the /oc/ passthrough handler, and the GET /oc/provider
// single-flight (providerFlight / providerResponseCapture). The atomic proxy
// pointer and the providerSFMu/providerFlights registry are Server fields
// (see server.go); the /oc/ route is registered in server.go (Handler).

import (
	"bytes"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"

	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// newOpenCodeProxy builds the /oc/* reverse proxy for target. The ONE builder
// for both NewServer and RetargetOpenCode (P1-API-003) so a re-target rebuild
// preserves the proxy configuration exactly: immediate flushing (SSE through
// the passthrough must not be buffered) and the 502 ErrorHandler that logs
// the method+path of a failed upstream hop instead of surfacing a bare 502.
func newOpenCodeProxy(target *url.URL) *httputil.ReverseProxy {
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
	return rp
}

// handlePassthrough strips the /oc prefix and reverse-proxies to OpenCode.
func (s *Server) handlePassthrough(w http.ResponseWriter, r *http.Request) {
	w = diag.NewHandlerBytesWriter(w, diag.ProxyPathPassthrough) // PROBE 8: attribute non-stream tunnel bytes
	r.URL.Path = strings.TrimPrefix(r.URL.Path, "/oc")
	if r.URL.Path == "" {
		r.URL.Path = "/"
	}
	// P1-API-003: load per request — the proxy is swapped wholesale (under
	// aggMu in RetargetOpenCode) after a fresh-port restart, and the atomic
	// load/store pair guarantees every request sees exactly one coherent
	// proxy: old or new, never torn.
	if r.Method == http.MethodGet && r.URL.Path == "/provider" {
		s.serveProviderSingleFlight(w, r)
		return
	}
	s.proxy.Load().ServeHTTP(w, r)
}

// providerFlight is ONE in-flight (or just-settled) upstream GET /provider
// fetch. The leader stores status/header/body, then closes done; waiters
// read the fields only after done closes (channel close is the
// happens-before edge). Nothing here caches beyond that window.
type providerFlight struct {
	done   chan struct{}
	status int
	header http.Header
	body   []byte
}

// providerFlightKey is the single-flight identity: the project directory
// (same reqDir source every other route uses — ?dir= first, then the
// x-opencode-directory header the SPA stamps on all its fetches) plus the
// raw query, so a future variant (e.g. ?refresh=1) can never share a
// plain flight.
func providerFlightKey(r *http.Request) string {
	return reqDir(r) + "\x00" + r.URL.RawQuery
}

// providerResponseCapture is the minimal ResponseWriter the single-flight
// leader proxies into: it records the exact status/headers/body the
// reverse proxy produced. Hop-by-hop headers are already stripped by the
// proxy itself before it writes here, and Date/framing are added by
// net/http on the way out — so replaying these fields through a waiter's
// ResponseWriter is byte-faithful to a direct passthrough.
type providerResponseCapture struct {
	status int
	header http.Header
	body   bytes.Buffer
}

func (c *providerResponseCapture) Header() http.Header { return c.header }
func (c *providerResponseCapture) Write(b []byte) (int, error) {
	return c.body.Write(b)
}
func (c *providerResponseCapture) WriteHeader(code int) { c.status = code }
func (c *providerResponseCapture) Flush()               {}

// writeCapturedProvider replays a captured (or leader-local) provider
// response through w. Header values are appended into the waiter's own
// (middleware-wrapped) header map, so outer middleware observes the
// response exactly as it would a direct proxy write.
func writeCapturedProvider(w http.ResponseWriter, status int, header http.Header, body []byte) {
	for k, vs := range header {
		for _, v := range vs {
			w.Header().Add(k, v)
		}
	}
	if status != 0 {
		w.WriteHeader(status)
	}
	w.Write(body)
}

// serveProviderSingleFlight runs GET /provider under single-flight: the
// FIRST requester of a flight key becomes the leader and performs the one
// upstream fetch (on its own request context — a leader disconnect aborts
// the upstream and settles the flight, which waiters then share);
// concurrent identical requests block on the flight's done channel and
// replay the captured response. An in-flight failure propagates to every
// waiter of that flight; the settle deletes the map entry, so the next
// request starts fresh. This mirrors golang.org/x/sync/singleflight
// semantics (hand-rolled — x/sync is not a direct dependency) minus the
// Forget hook, which the delete-on-settle makes unnecessary.
func (s *Server) serveProviderSingleFlight(w http.ResponseWriter, r *http.Request) {
	key := providerFlightKey(r)
	s.providerSFMu.Lock()
	fl, ok := s.providerFlights[key]
	if !ok {
		fl = &providerFlight{done: make(chan struct{})}
		s.providerFlights[key] = fl
	}
	s.providerSFMu.Unlock()

	if ok {
		<-fl.done
		writeCapturedProvider(w, fl.status, fl.header, fl.body)
		return
	}

	// Leader. Settle the flight on EVERY exit — including a panic inside
	// the proxy — so waiters can never block on a dead flight (a panicked
	// leader still publishes whatever partial capture exists).
	capt := &providerResponseCapture{header: http.Header{}}
	defer func() {
		fl.status, fl.header, fl.body = capt.status, capt.header, capt.body.Bytes()
		s.providerSFMu.Lock()
		delete(s.providerFlights, key)
		s.providerSFMu.Unlock()
		close(fl.done)
	}()
	s.proxy.Load().ServeHTTP(capt, r)
	writeCapturedProvider(w, capt.status, capt.header, capt.body.Bytes())
}
