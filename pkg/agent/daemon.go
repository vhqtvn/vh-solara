package agent

import (
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/hashicorp/yamux"
	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
	"github.com/vhqtvn/vh-solara/pkg/tunnel"
)

// Daemon coordinates the worker side: connecting back to the server and proxying requests.
type Daemon struct {
	ControllerURL string
	WorkerID      string
	WorkerName    string
	Version       string
	Headers       map[string]string
	Proxy         *Proxy
	KillFunc      func()
	HealthCheck   func() bool

	healthCheckMu sync.Mutex
	lastHealthCh  time.Time

	ctx    context.Context
	cancel context.CancelFunc
}

func NewDaemon(controller string, id string, name string, version string, headers map[string]string, proxy *Proxy) *Daemon {
	ctx, cancel := context.WithCancel(context.Background())
	return &Daemon{
		ControllerURL: controller,
		WorkerID:      id,
		WorkerName:    name,
		Version:       version,
		Headers:       headers,
		Proxy:         proxy,
		ctx:           ctx,
		cancel:        cancel,
	}
}

// Start begins the reconnect and proxying loop.
func (d *Daemon) Start() {
	var backoff = time.Second * 1

	for {
		select {
		case <-d.ctx.Done():
			log.Printf("Daemon context cancelled, stopping.")
			return
		default:
		}

		log.Printf("Connecting to controller at %s...", d.ControllerURL)

		var dialHeaders http.Header
		if len(d.Headers) > 0 {
			dialHeaders = make(http.Header)
			for k, v := range d.Headers {
				dialHeaders.Set(k, v)
			}
		}

		dialer := websocket.Dialer{
			ReadBufferSize:  256 * 1024,
			WriteBufferSize: 256 * 1024,
		}
		conn, _, err := dialer.Dial(d.ControllerURL, dialHeaders)
		if err != nil {
			log.Printf("Dial failed: %v", err)
			time.Sleep(backoff)
			if backoff < time.Second*30 {
				backoff *= 2
			}
			continue
		}

		log.Printf("Connected successfully.")
		backoff = time.Second * 1 // reset backoff

		d.handleTunnel(conn)

		log.Printf("Tunnel closed, scheduling reconnect...")
		select {
		case <-time.After(backoff):
			// continue loop
		case <-d.ctx.Done():
			log.Printf("Daemon context cancelled, stopping reconnect loop.")
			return
		}
	}
}

func (d *Daemon) handleTunnel(conn *websocket.Conn) {
	// Create yamux client session over the WebSocket
	mux, err := tunnel.NewMuxTransportClient(conn)
	if err != nil {
		log.Printf("Failed to init yamux session: %v", err)
		conn.Close()
		return
	}
	defer mux.Close()

	// 1. Send Register on a dedicated stream
	regStream, err := mux.OpenStream()
	if err != nil {
		log.Printf("Failed to open registration stream: %v", err)
		return
	}

	reg := tunnel.RegisterMessage{
		BaseMessage: tunnel.BaseMessage{
			Type:     tunnel.TypeRegister,
			WorkerID: d.WorkerID,
		},
		WorkerName: d.WorkerName,
		Version:    d.Version,
	}
	if err := regStream.WriteJSON(reg); err != nil {
		log.Printf("Failed to send register: %v", err)
		regStream.Close()
		return
	}
	regStream.Close()

	// 2. Start heartbeat goroutine — sends heartbeats on new streams
	done := make(chan struct{})
	defer close(done)
	go func() {
		ticker := time.NewTicker(10 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				stream, err := mux.OpenStream()
				if err != nil {
					return // mux closed
				}
				hb := tunnel.HeartbeatMessage{
					BaseMessage: tunnel.BaseMessage{
						Type:     tunnel.TypeHeartbeat,
						WorkerID: d.WorkerID,
					},
					Timestamp: time.Now().UTC().Format(time.RFC3339),
				}
				_ = stream.WriteJSON(hb)
				stream.Close()
			}
		}
	}()

	// 3. Accept incoming streams from the server (requests)
	for {
		stream, err := mux.AcceptStream()
		if err != nil {
			log.Printf("Stream accept error: %v", err)
			break
		}

		go d.handleStream(stream, mux.Session)
	}
}

func (d *Daemon) handleStream(stream *tunnel.Stream, sess *yamux.Session) {
	defer stream.Close()

	var base tunnel.BaseMessage
	if err := stream.ReadJSON(&base); err != nil {
		log.Printf("Failed to read stream message: %v", err)
		return
	}

	switch base.Type {
	case tunnel.TypeKillInstance:
		log.Printf("Received remote kill signal for worker %s, terminating...", d.WorkerID)
		d.cancel()
		if d.KillFunc != nil {
			d.KillFunc()
		}
		return

	case tunnel.TypeFatalDuplicate:
		log.Fatalf("Fatal: Worker ID %q is already connected to the server. Please verify your --id flag.", d.WorkerID)

	case tunnel.TypeRawProxy:
		var req tunnel.RawProxyMessage
		// Re-parse from base — we only need the port
		req.Port = 0 // default
		// Don't close stream via defer — handleRawProxy manages its lifecycle
		d.handleRawProxy(stream, &req, sess)
		return // skip the deferred stream.Close()

	default:
		log.Printf("Unknown stream message type: %s", base.Type)
	}
}

// handleRawProxy connects to a local port and does bidirectional byte copying
// between the yamux stream and the local connection (for WebSocket proxying).
// sess is the worker's yamux.Session, used ONLY for Probe 4 per-incident
// NumStreams() sampling on the response-direction slow-write path; it is never
// used for behavior. May be nil (sampling is skipped).
func (d *Daemon) handleRawProxy(stream *tunnel.Stream, req *tunnel.RawProxyMessage, sess *yamux.Session) {
	port := req.Port
	if port == 0 {
		port = d.Proxy.WebPort
	}

	// log.Printf("[AgentRawProxy] Requested port: %d (WebPort: %d)", req.Port, d.Proxy.WebPort)

	if port == 0 {
		log.Printf("[AgentRawProxy] No port configured, rejecting")
		errMsg := tunnel.BaseMessage{Type: tunnel.TypeError}
		stream.WriteJSON(errMsg)
		stream.Close()
		return
	}

	// Connect to the local service
	// log.Printf("[AgentRawProxy] Connecting to 127.0.0.1:%d...", port)
	localConn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 5*time.Second)
	if err != nil {
		errMsg := tunnel.BaseMessage{Type: tunnel.TypeError}

		doCheck := false
		d.healthCheckMu.Lock()
		if time.Since(d.lastHealthCh) > 5*time.Second {
			d.lastHealthCh = time.Now()
			doCheck = true
		}
		d.healthCheckMu.Unlock()

		if doCheck {
			log.Printf("[AgentRawProxy] Failed to connect: %v", err)
			if d.HealthCheck != nil && !d.HealthCheck() {
				log.Printf("[AgentRawProxy] HealthCheck failed. Target web server is permanently offline. Exiting daemon.")
				d.cancel()
				if d.KillFunc != nil {
					d.KillFunc()
				}
			}
		}

		stream.WriteJSON(errMsg)
		stream.Close()
		return
	}
	// log.Printf("[AgentRawProxy] Connected to 127.0.0.1:%d successfully", port)

	// Send ACK to server — connection is established
	ack := tunnel.BaseMessage{Type: tunnel.TypeRawProxy}
	if err := stream.WriteJSON(ack); err != nil {
		log.Printf("[AgentRawProxy] Failed to send ACK: %v", err)
		localConn.Close()
		stream.Close()
		return
	}
	// log.Printf("[AgentRawProxy] ACK sent, starting bidirectional copy")

	// Bidirectional copy.
	//
	// PROBE 4 (Finding 1): the local-service → yamux write leg is the PRIMARY
	// egress signal — it is where yamux flow-control / send-window backpressure
	// accumulates (a stalled controller drain shows up as a blocked Write here,
	// not as a slow Read on the other leg). Wrapping stream.Raw() with a
	// YamuxWriteMonitor in the YamuxWriteResponse direction captures per-write
	// timing into YamuxStats.WriteByDir[Response]. yamux.Stream does not
	// implement io.WriterTo / io.ReaderFrom, so wrapping does not change
	// io.Copy's generic buffered loop — pure observation. The yamux→local-
	// service leg is left unwrapped: a Read on it blocks when there's nothing
	// to read (idle), so timing it would record idle time, not backpressure.
	var wg sync.WaitGroup
	wg.Add(2)

	// yamux stream → local service
	go func() {
		defer wg.Done()
		_, err := io.Copy(localConn, stream.Raw())
		if err != nil {
			// ignore copy errors
		}
		localConn.Close()
	}()

	// local service → yamux stream (response direction — primary egress signal)
	go func() {
		defer wg.Done()
		respW := diag.NewYamuxWriteMonitor(stream.Raw(), diag.YamuxWriteResponse).WithSession(sess)
		_, err := io.Copy(respW, localConn)
		if err != nil {
			// ignore copy errors
		}
		stream.Close()
	}()

	wg.Wait()
	// log.Printf("[AgentRawProxy] Raw proxy session ended for port %d", port)
}
