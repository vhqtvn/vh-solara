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
	// session holds the yamux.Session created on top of this wsRWC, set via
	// setSession immediately after yamux.Server/Client returns. Sampled (via
	// NumStreams) on each Write so "slow Write while N streams active" is
	// visible. atomic.Pointer so the Write path needs no lock to read it.
	session atomic.Pointer[yamux.Session]
}

func newWSRWC(conn *websocket.Conn, side int) *wsRWC {
	return &wsRWC{conn: conn, side: side}
}

// setSession records the yamux session created on top of this wsRWC so the
// Write probe can sample NumStreams. Called once, right after session creation.
func (w *wsRWC) setSession(s *yamux.Session) { w.session.Store(s) }

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
	var aux int64
	if s := w.session.Load(); s != nil {
		aux = int64(s.NumStreams())
		stats.ActiveStreamsAtWrite.Observe(aux)
	}
	if err != nil {
		stats.Errors.Inc()
		return 0, err
	}
	if int64(mutexWait+writeMsgDur) >= diag.SlowWSWriteNs {
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
	rwc.setSession(session) // Probe 5: wire NumStreams sampling

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
	rwc.setSession(session) // Probe 5: wire NumStreams sampling

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
