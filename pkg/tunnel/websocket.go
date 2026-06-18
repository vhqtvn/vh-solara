package tunnel

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"
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
}

func newWSRWC(conn *websocket.Conn) *wsRWC {
	return &wsRWC{conn: conn}
}

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
	w.mu.Lock()
	defer w.mu.Unlock()

	err := w.conn.WriteMessage(websocket.BinaryMessage, p)
	if err != nil {
		return 0, err
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
	rwc := newWSRWC(conn)

	cfg := yamux.DefaultConfig()
	cfg.EnableKeepAlive = true
	cfg.KeepAliveInterval = 10 * time.Second
	cfg.ConnectionWriteTimeout = 10 * time.Second
	cfg.LogOutput = io.Discard

	session, err := yamux.Server(rwc, cfg)
	if err != nil {
		return nil, fmt.Errorf("yamux server init: %w", err)
	}

	return &MuxTransport{Session: session, wsConn: conn}, nil
}

// NewMuxTransportClient creates a yamux client session over the given WebSocket connection.
// The "client" in yamux terminology is the side that calls OpenStream().
// In our architecture, the agent/client-daemon is the yamux client.
func NewMuxTransportClient(conn *websocket.Conn) (*MuxTransport, error) {
	rwc := newWSRWC(conn)

	cfg := yamux.DefaultConfig()
	cfg.EnableKeepAlive = true
	cfg.KeepAliveInterval = 10 * time.Second
	cfg.ConnectionWriteTimeout = 10 * time.Second
	cfg.LogOutput = io.Discard

	session, err := yamux.Client(rwc, cfg)
	if err != nil {
		return nil, fmt.Errorf("yamux client init: %w", err)
	}

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
