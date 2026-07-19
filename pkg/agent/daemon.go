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

// Worker→controller reconnect tuning. See the mission investigation for the
// 16.5s overnight-freeze attribution: the previous cap (30s) means a worker
// that had a tunnel drop in the night sits at the cap when the operator
// returns, so the next dial attempt is up to 30s away. We lower the cap to
// 5s (single-worker reconnect-storm risk is acceptable — one TCP attempt per
// attempt is trivial load) AND add a time-based idle reset so a worker that
// has been disconnected for a long time (≥ reconnectIdleResetThreshold) snaps
// back to the floor for its next attempt, instead of waiting for the cap.
//
// Values:
//   - reconnectFloor        = 1s   (initial backoff; unchanged)
//   - reconnectCap          = 5s   (was 30s — see above)
//   - reconnectIdleResetThreshold = 60s  (well above the cap, so a normal
//     transient blip uses the doubling schedule; only an extended disconnect
//     triggers the floor reset)
//
// reconnectFloor / reconnectCap are const (production-invariant). The idle
// threshold is a var so the unit tests can lower it (we can't wait 60s in a
// test) — this mirrors the existing pkg/diagnostics slow*Ns override pattern
// for time-based thresholds.
const (
	reconnectFloor = 1 * time.Second
	reconnectCap   = 5 * time.Second
)

var reconnectIdleResetThreshold = 60 * time.Second

// Start begins the reconnect and proxying loop.
func (d *Daemon) Start() {
	var backoff = reconnectFloor
	// disconnectedAt brackets the current "no tunnel up" period. Initialized
	// to process start so the idle-reset check is meaningful before the first
	// successful dial. Reset to time.Now() each time a tunnel session ends so
	// the NEXT failure streak starts a fresh window.
	disconnectedAt := time.Now()
	diag.Default.Tunnel.LastDisconnectAtNs.Store(disconnectedAt.UnixNano())
	diag.Default.Tunnel.CurrentState.Store(diag.TunnelStateDisconnected)

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
		// PROBE 7: stamp dial attempt BEFORE the call so the snapshot can
		// attribute a freeze to "worker is currently mid-dial" regardless of
		// whether this attempt succeeds.
		diag.Default.Tunnel.DialAttempts.Inc()
		conn, _, err := dialer.Dial(d.ControllerURL, dialHeaders)
		if err != nil {
			// PROBE 7: record the failure + the backoff we're about to sleep.
			diag.Default.Tunnel.DialFailures.Inc()
			// B2 (idle reset): if it has been a long time since we entered the
			// current disconnected period, snap backoff to the floor. Handles
			// the overnight-idle case where backoff had previously climbed to
			// the cap during an active failure streak and the operator just
			// returned. Without this the worker would keep sleeping at the cap
			// (5s) for as long as failures continue; with it the next attempt
			// is at the floor (1s) once the threshold has elapsed.
			//
			// The check fires on EVERY failure once the threshold has elapsed,
			// so a worker that's been failing for hours effectively retries at
			// ~1Hz — acceptable for a single worker (one TCP dial per second).
			if time.Since(disconnectedAt) >= reconnectIdleResetThreshold && backoff > reconnectFloor {
				log.Printf("Tunnel disconnected for %v; resetting backoff %v → %v",
					time.Since(disconnectedAt).Round(time.Second), backoff, reconnectFloor)
				backoff = reconnectFloor
				// PROBE 7: count the reset so an operator hitting the app
				// while the worker recovers can attribute it. LastBackoffNs
				// (stamped below) reports the post-reset value actually used.
				diag.Default.Tunnel.IdleResets.Inc()
			}
			diag.Default.Tunnel.LastBackoffNs.Store(int64(backoff))
			log.Printf("Dial failed: %v (sleeping %v)", err, backoff)
			select {
			case <-time.After(backoff):
			case <-d.ctx.Done():
				log.Printf("Daemon context cancelled during dial-failure backoff.")
				return
			}
			// B1 (lower cap): doubling stays, but bounded by reconnectCap.
			// Sequence after 4 consecutive failures: 1→2→4→5(capped). With the
			// idle-reset above, this cap is only reached during SHORT blips
			// (under the threshold) — for long disconnects the floor reset
			// keeps attempts at ~1Hz.
			backoff *= 2
			if backoff > reconnectCap {
				backoff = reconnectCap
			}
			continue
		}

		log.Printf("Connected successfully.")
		// PROBE 7: dial succeeded — stamp the connected state + reset backoff.
		backoff = reconnectFloor
		diag.Default.Tunnel.Connected.Inc()
		now := time.Now()
		diag.Default.Tunnel.LastConnectedAtNs.Store(now.UnixNano())
		diag.Default.Tunnel.CurrentState.Store(diag.TunnelStateConnected)

		d.handleTunnel(conn)

		// PROBE 7: tunnel session ended — stamp disconnect state + reset the
		// disconnected-period window for the next failure-streak idle check.
		disconnectedAt = time.Now()
		diag.Default.Tunnel.Disconnects.Inc()
		diag.Default.Tunnel.LastDisconnectAtNs.Store(disconnectedAt.UnixNano())
		diag.Default.Tunnel.CurrentState.Store(diag.TunnelStateDisconnected)
		// LastBackoffNs is also stamped on the post-close sleep below so the
		// snapshot can read "the worker is in the post-close reconnect sleep".
		diag.Default.Tunnel.LastBackoffNs.Store(int64(backoff))
		log.Printf("Tunnel closed, scheduling reconnect (sleeping %v)...", backoff)
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
	// PROBE 4 / B-F1: maintain the process-local active-stream gauge for the
	// lifetime of this accepted proxy stream, symmetric with the controller's
	// pkg/server/proxy.go handleRawProxy (which does ActiveStreams.Add(+1/-1)
	// around its controller-side OpenStream). The worker-side wsRWC.Write
	// samples this gauge into worker_client active_streams_at_write (see
	// pkg/tunnel/websocket.go Write); without this inc/dec the worker-process
	// gauge stays at 0 forever (nothing else on the worker touches it) and the
	// histogram records misleading always-zero data in the very Performance
	// diagnostics dialog this slice adds. atomic.Int64 inc/dec — lock-free,
	// identical to the controller leg. The defer covers every return path
	// (port==0 reject, dial failure, copy completion).
	diag.Default.Yamux.ActiveStreams.Add(1)
	defer diag.Default.Yamux.ActiveStreams.Add(-1)

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
