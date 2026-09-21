package tunnel

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"
	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
)

// --- Q4c: negotiated permessage-deflate on the tunnel WebSocket (experiment) ---
//
// The single shared worker↔controller tunnel rides ONE WebSocket connection
// (the physical carrier under yamux). Both endpoints of that WebSocket are
// ours: the worker dials it (pkg/agent) and the controller upgrades it
// (pkg/server). This block implements a DEFAULT-OFF, policy-controlled
// permessage-deflate experiment for that leg (open-questions brief Q4(c)):
//
//   - gorilla v1.5.3 negotiates permessage-deflate with
//     server_no_context_takeover + client_no_context_takeover at compression
//     level 1 (its default), exposes NO size threshold and NO window-bits
//     option, and toggles compression per message via
//     conn.EnableWriteCompression (a plain bool store on the conn; it is a
//     documented no-op when compression was not negotiated).
//
//   - Negotiation reality: permessage-deflate is used only when BOTH sides
//     offer it. A new worker offering compression to an old controller (or
//     vice versa) simply stays uncompressed — the rolling-deploy story: no
//     mixed-version pairing ever breaks, it just falls back to today's
//     behavior. Knob coherence is operator-controlled (both endpoints are
//     ours); the recommended pairing is the SAME policy on both sides so each
//     direction of the link gets the same treatment.
//
//   - Default `off` is byte-identical to the pre-knob behavior: the side
//     never offers the extension in the handshake (no
//     Sec-WebSocket-Extensions header either way) and wsRWC.Write never
//     calls EnableWriteCompression.
//
//   - SECURITY (pre-default-enablement review item): compression oracles
//     (BREACH/CRIME-class) apply when attacker-influenced and secret bytes
//     share compressed messages on a link the attacker can observe. This leg
//     carries only operator/worker traffic between OUR two endpoints over an
//     operator-controlled link (the browser WebSocket legs are NOT this
//     connection), so the exposure is low — but review mixed
//     secret/attacker-influenced content in shared messages before EVER
//     flipping the default away from `off`.
//
//   - Double compression: `z=1` gzip64 snapshot envelopes (application-level
//     gzip + base64, pkg/web) are left untouched. Deflate composed on top of
//     a gzip64 payload mostly recovers only the base64 envelope redundancy
//     (~25% at best), NOT a second pass over the raw JSON — it is not
//     equivalent to compressing the raw payload once. It composes safely for
//     correctness; the CPU/byte tradeoff for already-gzipped content is what
//     the shaped-link rail measures, not something this code assumes.
//
// Knob: VH_TUNNEL_DEFLATE = off | all | 1k | 4k (default off; an unparseable
// value parses to off AND returns an error so callers can log loudly instead
// of silently flying uncompressed while the operator believes otherwise).

// DeflatePolicy selects when the tunnel WebSocket applies negotiated
// permessage-deflate to OUTGOING messages. The read side always inflates
// transparently (gorilla decompresses any frame carrying the compression
// flag), so the two endpoints may run different policies mechanically —
// identical policies on both sides are still the recommended pairing.
type DeflatePolicy int

const (
	// DeflateOff never offers compression in the handshake and never
	// compresses a message (the default; byte-identical to the pre-knob
	// behavior).
	DeflateOff DeflatePolicy = iota
	// DeflateAll compresses every message (when negotiated).
	DeflateAll
	// Deflate1KiB compresses only messages >= 1 KiB (when negotiated) —
	// avoids wasting deflate cycles on tiny yamux control/data frames.
	Deflate1KiB
	// Deflate4KiB compresses only messages >= 4 KiB (when negotiated).
	Deflate4KiB
)

const (
	// EnvTunnelDeflate is the env var both endpoints read (worker dialer and
	// controller upgrader). Same name on both sides so a single-process e2e
	// run forces both endpoints with one env, while production machines set
	// it independently per host.
	EnvTunnelDeflate = "VH_TUNNEL_DEFLATE"

	deflateMin1KiB = 1024
	deflateMin4KiB = 4096
)

// ParseDeflatePolicy parses one VH_TUNNEL_DEFLATE value. Empty/off is the
// default; matching is case-insensitive and tolerates surrounding whitespace.
func ParseDeflatePolicy(s string) (DeflatePolicy, error) {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "", "off":
		return DeflateOff, nil
	case "all":
		return DeflateAll, nil
	case "1k":
		return Deflate1KiB, nil
	case "4k":
		return Deflate4KiB, nil
	default:
		return DeflateOff, fmt.Errorf("invalid %s value %q (want off|all|1k|4k)", EnvTunnelDeflate, s)
	}
}

// DeflatePolicyFromEnv reads EnvTunnelDeflate. Unset/empty = off. An invalid
// value yields (off, error): callers log and continue with compression off.
func DeflatePolicyFromEnv() (DeflatePolicy, error) {
	return ParseDeflatePolicy(os.Getenv(EnvTunnelDeflate))
}

// OfferCompression reports whether this side should offer permessage-deflate
// in the WebSocket handshake. Wire the result into
// websocket.Dialer.EnableCompression (worker) / websocket.Upgrader.EnableCompression
// (controller). Only DeflateOff stays silent — with any other policy the
// handshake carries the extension offer, and compression activates only if
// the peer offers too.
func (p DeflatePolicy) OfferCompression() bool { return p != DeflateOff }

// CompressMessage reports whether an outgoing WebSocket message of n bytes
// (the payload handed to wsRWC.Write: a yamux frame, header included) should
// be compressed under this policy. Thresholds are inclusive (>=).
func (p DeflatePolicy) CompressMessage(n int) bool {
	switch p {
	case DeflateAll:
		return true
	case Deflate1KiB:
		return n >= deflateMin1KiB
	case Deflate4KiB:
		return n >= deflateMin4KiB
	default:
		return false
	}
}

func (p DeflatePolicy) String() string {
	switch p {
	case DeflateAll:
		return "all"
	case Deflate1KiB:
		return "1k"
	case Deflate4KiB:
		return "4k"
	default:
		return "off"
	}
}

// wsRWC adapts a gorilla/websocket.Conn into a net.Conn-like interface
// so it can be used as the underlying transport for yamux.
//
// yamux expects a stream-based connection (like TCP). WebSocket is message-based.
// This adapter stitches incoming messages into a continuous byte stream and
// sends outgoing writes as individual binary messages.
type wsRWC struct {
	conn   *websocket.Conn
	mu     sync.Mutex // protects writes
	reader io.Reader  // current in-progress message reader

	// side identifies which wsRWC role this is (Probe 5): controller-server or
	// worker-client. Set at construction so every Write attributes into the
	// correct per-side accumulator.
	side int
	// deflate is this endpoint's per-message permessage-deflate policy
	// (Q4c). Zero value (DeflateOff) keeps Write byte-identical to the
	// pre-knob adapter: EnableWriteCompression is never called.
	deflate DeflatePolicy
	// sampler holds the yamux.Session (wrapped as a streamSampler) so the SLOW
	// write path can read per-session NumStreams() for incident correlation.
	// The hot Write path does NOT touch it: the per-write active-streams
	// histogram is sourced from the lock-free global gauge
	// (diag.Default.Yamux.ActiveStreams) instead, because yamux's NumStreams()
	// acquires the session streamLock and the operator required the tunnel
	// write path to stay lock-free. atomic.Pointer so the slow path needs no
	// lock to read it.
	sampler atomic.Pointer[samplerHolder]
}

// streamSampler is the per-session stream-count surface the SLOW write path
// reads for incident correlation. *yamux.Session satisfies it (NumStreams()).
// Kept as an interface so the hot-path test (websocket_hotpath_test.go) can
// substitute a counting sampler and prove NumStreams() is never invoked on a
// fast write.
type streamSampler interface {
	NumStreams() int
}

// samplerHolder boxes the streamSampler interface behind a concrete pointer
// type so atomic.Pointer stays monomorphic (atomic.Pointer[T] cannot store an
// interface directly without a concrete boxing type).
type samplerHolder struct {
	s streamSampler
}

func newWSRWC(conn *websocket.Conn, side int) *wsRWC {
	return &wsRWC{conn: conn, side: side}
}

// setSession records the yamux session created on top of this wsRWC so the
// threshold-gated slow-write path can sample per-session NumStreams() for
// incident correlation. Called once, right after session creation.
func (w *wsRWC) setSession(s streamSampler) { w.sampler.Store(&samplerHolder{s: s}) }

func (w *wsRWC) Read(p []byte) (int, error) {
	for {
		if w.reader != nil {
			n, err := w.reader.Read(p)
			if err == io.EOF {
				w.reader = nil
				if n > 0 {
					return n, nil
				}
				continue // get next message
			}
			return n, err
		}

		_, reader, err := w.conn.NextReader()
		if err != nil {
			return 0, err
		}
		w.reader = reader
	}
}

func (w *wsRWC) Write(p []byte) (int, error) {
	// PROBE 5 (latency diagnostics): record mutex-wait and WriteMessage
	// duration SEPARATELY. mutex-wait ALONE is NOT a sufficient saturation
	// metric — yamux serializes its own sender, so head-of-line delay may
	// appear as stream-Write wait (Probe 4) rather than wsRWC.mu contention.
	// Recording both signals independently lets the operator distinguish the
	// two. The lock scope is byte-for-bit identical to the original
	// (Lock + defer Unlock); the recording is pure atomics inside the locked
	// region, adding only a handful of atomic adds.
	waitStart := time.Now()
	w.mu.Lock()
	defer w.mu.Unlock()
	mutexWait := time.Since(waitStart)

	writeStart := time.Now()
	// Q4c: per-message compression policy. EnableWriteCompression is a cheap
	// unsynchronized bool store on the gorilla conn (and a documented no-op
	// when permessage-deflate wasn't negotiated); calling it under w.mu keeps
	// it strictly ordered before this WriteMessage — gorilla applies the
	// toggle to subsequent writes, and our mutex is the single-writer gate
	// for this conn. DeflateOff never touches it, so the default hot path is
	// unchanged (see websocket_hotpath_test.go).
	if w.deflate != DeflateOff {
		w.conn.EnableWriteCompression(w.deflate.CompressMessage(len(p)))
	}
	err := w.conn.WriteMessage(websocket.BinaryMessage, p)
	writeMsgDur := time.Since(writeStart)

	stats := &diag.Default.WSWrite[w.side]
	stats.Bytes.Add(uint64(len(p)))
	stats.Writes.Inc()
	stats.MutexWaitDur.Observe(int64(mutexWait))
	stats.WriteMsgDur.Observe(int64(writeMsgDur))
	stats.TotalDur.Observe(int64(mutexWait + writeMsgDur))
	// Active-streams histogram: sample the LOCK-FREE global gauge
	// (diag.Default.Yamux.ActiveStreams — an atomic.Int64 inc/dec'd on proxy
	// stream open/close in pkg/server/proxy.go), NOT yamux.Session.NumStreams(),
	// which acquires the session's streamLock (yamux@v0.1.2/session.go). The
	// hot write path must stay lock-free; the only per-session NumStreams()
	// read is threshold-gated to ≥SlowWSWriteNs below, where its lock cost is
	// negligible relative to the slow write itself.
	stats.ActiveStreamsAtWrite.Observe(diag.Default.Yamux.ActiveStreams.Load())
	if err != nil {
		stats.Errors.Inc()
		return 0, err
	}
	if int64(mutexWait+writeMsgDur) >= diag.SlowWSWriteNs {
		// Slow incident (≥100ms): per-session NumStreams() correlation is worth
		// the streamLock acquisition here — the write already cost ≥100ms, so a
		// mutex sample is noise. Aux carries that per-session count so the
		// operator can see "slow write while N streams were active in THIS
		// session" (the global gauge can't give per-session granularity).
		var aux int64
		if h := w.sampler.Load(); h != nil {
			aux = int64(h.s.NumStreams())
		}
		stats.SlowWriteIncidents.Push(diag.Incident{
			At:     writeStart.UnixNano(),
			Kind:   "ws_write",
			Bytes:  uint64(len(p)),
			Dur:    int64(mutexWait + writeMsgDur),
			Detail: int64(mutexWait),
			Aux:    aux,
		})
	}
	return len(p), nil
}

func (w *wsRWC) Close() error {
	return w.conn.Close()
}

// Implement net.Conn deadline interface so yamux keepalive works correctly.
// These delegate to the underlying gorilla/websocket conn which supports them.

func (w *wsRWC) LocalAddr() net.Addr {
	return w.conn.LocalAddr()
}

func (w *wsRWC) RemoteAddr() net.Addr {
	return w.conn.RemoteAddr()
}

func (w *wsRWC) SetDeadline(t time.Time) error {
	if err := w.conn.SetReadDeadline(t); err != nil {
		return err
	}
	return w.conn.SetWriteDeadline(t)
}

func (w *wsRWC) SetReadDeadline(t time.Time) error {
	return w.conn.SetReadDeadline(t)
}

func (w *wsRWC) SetWriteDeadline(t time.Time) error {
	return w.conn.SetWriteDeadline(t)
}

// MuxTransport wraps a yamux session over a WebSocket connection.
// It supports opening new streams (client→server requests) and
// accepting incoming streams (server→client requests).
type MuxTransport struct {
	Session *yamux.Session
	wsConn  *websocket.Conn
}

// NewMuxTransportServer creates a yamux server session over the given WebSocket connection
// with permessage-deflate disabled (the pre-experiment behavior; see the Q4c
// block at the top of this file). The "server" in yamux terminology is the
// side that calls AcceptStream(). In our architecture, the vh-solara server
// is the yamux server.
func NewMuxTransportServer(conn *websocket.Conn) (*MuxTransport, error) {
	return NewMuxTransportServerWithDeflate(conn, DeflateOff)
}

// NewMuxTransportServerWithDeflate is NewMuxTransportServer with a
// permessage-deflate write policy for this endpoint's outgoing messages. The
// controller must ALSO have offered compression via
// websocket.Upgrader.EnableCompression on the upgrade that produced conn —
// without a mutual handshake offer, no compression is negotiated and the
// policy is inert (safe with any peer version).
func NewMuxTransportServerWithDeflate(conn *websocket.Conn, deflate DeflatePolicy) (*MuxTransport, error) {
	rwc := newWSRWC(conn, diag.SideServer)
	rwc.deflate = deflate

	cfg := yamux.DefaultConfig()
	cfg.EnableKeepAlive = true
	cfg.KeepAliveInterval = 10 * time.Second
	cfg.ConnectionWriteTimeout = 10 * time.Second
	cfg.LogOutput = io.Discard

	session, err := yamux.Server(rwc, cfg)
	if err != nil {
		return nil, fmt.Errorf("yamux server init: %w", err)
	}
	rwc.setSession(session) // Probe 5: wire per-session sampler for slow-write incidents

	return &MuxTransport{Session: session, wsConn: conn}, nil
}

// NewMuxTransportClient creates a yamux client session over the given WebSocket connection
// with permessage-deflate disabled (the pre-experiment behavior; see the Q4c
// block at the top of this file). The "client" in yamux terminology is the
// side that calls OpenStream(). In our architecture, the agent/client-daemon
// is the yamux client.
func NewMuxTransportClient(conn *websocket.Conn) (*MuxTransport, error) {
	return NewMuxTransportClientWithDeflate(conn, DeflateOff)
}

// NewMuxTransportClientWithDeflate is NewMuxTransportClient with a
// permessage-deflate write policy for this endpoint's outgoing messages. The
// worker must ALSO have offered compression via
// websocket.Dialer.EnableCompression on the dial that produced conn — without
// a mutual handshake offer, no compression is negotiated and the policy is
// inert (safe with any peer version).
func NewMuxTransportClientWithDeflate(conn *websocket.Conn, deflate DeflatePolicy) (*MuxTransport, error) {
	rwc := newWSRWC(conn, diag.SideClient)
	rwc.deflate = deflate

	cfg := yamux.DefaultConfig()
	cfg.EnableKeepAlive = true
	cfg.KeepAliveInterval = 10 * time.Second
	cfg.ConnectionWriteTimeout = 10 * time.Second
	cfg.LogOutput = io.Discard

	session, err := yamux.Client(rwc, cfg)
	if err != nil {
		return nil, fmt.Errorf("yamux client init: %w", err)
	}
	rwc.setSession(session) // Probe 5: wire per-session sampler for slow-write incidents

	return &MuxTransport{Session: session, wsConn: conn}, nil
}

// OpenStream creates a new multiplexed stream to send a request.
func (m *MuxTransport) OpenStream() (*Stream, error) {
	s, err := m.Session.OpenStream()
	if err != nil {
		return nil, err
	}
	return &Stream{stream: s}, nil
}

// AcceptStream waits for the remote side to open a new stream.
func (m *MuxTransport) AcceptStream() (*Stream, error) {
	s, err := m.Session.AcceptStream()
	if err != nil {
		return nil, err
	}
	return &Stream{stream: s}, nil
}

// Close tears down the yamux session and the underlying WebSocket.
func (m *MuxTransport) Close() error {
	return m.Session.Close()
}

// IsClosed returns true if the yamux session has been shut down.
func (m *MuxTransport) IsClosed() bool {
	return m.Session.IsClosed()
}

// Stream wraps a single yamux stream and provides JSON read/write helpers.
// Each stream carries exactly one request-response exchange.
type Stream struct {
	stream *yamux.Stream
}

// WriteJSON sends a JSON-encoded message on this stream.
func (s *Stream) WriteJSON(v interface{}) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	// Append newline as delimiter
	data = append(data, '\n')
	_, err = s.stream.Write(data)
	return err
}

// ReadJSON reads a JSON-encoded message from this stream.
func (s *Stream) ReadJSON(v interface{}) error {
	dec := json.NewDecoder(s.stream)
	return dec.Decode(v)
}

// Raw returns the underlying yamux stream for direct bidirectional I/O.
func (s *Stream) Raw() *yamux.Stream {
	return s.stream
}

// Close closes the stream (not the whole session).
func (s *Stream) Close() error {
	return s.stream.Close()
}

// FormatError is a helper utility to format protocol errors to pass over the tunnel
func FormatError(reqID string, code string, format string, args ...interface{}) ErrorMessage {
	return ErrorMessage{
		BaseMessage: BaseMessage{
			Type:      TypeError,
			RequestID: reqID,
		},
		Code:    code,
		Message: fmt.Sprintf(format, args...),
	}
}
