package tunnel

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"
	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
)

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

// NewMuxTransportServer creates a yamux server session over the given WebSocket connection.
// The "server" in yamux terminology is the side that calls AcceptStream().
// In our architecture, the vh-solara server is the yamux server.
func NewMuxTransportServer(conn *websocket.Conn) (*MuxTransport, error) {
	rwc := newWSRWC(conn, diag.SideServer)

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

// NewMuxTransportClient creates a yamux client session over the given WebSocket connection.
// The "client" in yamux terminology is the side that calls OpenStream().
// In our architecture, the agent/client-daemon is the yamux client.
func NewMuxTransportClient(conn *websocket.Conn) (*MuxTransport, error) {
	rwc := newWSRWC(conn, diag.SideClient)

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
