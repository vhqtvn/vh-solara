package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
	"github.com/vhqtvn/vh-solara/pkg/tunnel"
)

// Proxy handles proxying OpenChamber requests through yamux streams to workers.
type Proxy struct {
	Registry *Registry
}

func NewProxy(registry *Registry) *Proxy {
	return &Proxy{
		Registry: registry,
	}
}

// HandleWorkerDirect proxies a request to the worker's local web server via a
// yamux stream. All requests use raw TCP proxying for immediate chunk-by-chunk
// streaming, handling HTTP, SSE, and WebSocket uniformly.
func (p *Proxy) HandleWorkerDirect(workerID string, worker *Worker, w http.ResponseWriter, r *http.Request) {
	p.handleRawProxy(worker, w, r)
}

// handleRawProxy handles all requests by hijacking the browser connection
// and doing raw bidirectional byte proxying through a yamux stream to the client's local port.
func (p *Proxy) handleRawProxy(worker *Worker, w http.ResponseWriter, r *http.Request) {
	// log.Printf("[RawProxy] Starting raw proxy for %s %s", r.Method, r.URL.Path)

	if worker.Transport == nil || worker.Transport.IsClosed() {
		// PROBE 4 (Phase 4): record the controller-side fast-fail. This 502 is
		// served when the worker tunnel is down (nil/closed transport) AT
		// REQUEST TIME — distinct from StreamOpenFails (which fires after the
		// nil/closed check passes but OpenStream errors). A non-zero rate here
		// while the browser's EventSource auto-retries is the signature of
		// "operator hit the controller while the worker tunnel was down".
		diag.Default.Yamux.TunnelDownRejections.Inc()
		log.Printf("[RawProxy] Worker transport is nil or closed")
		http.Error(w, "Worker transport is closed", http.StatusBadGateway)
		return
	}

	// log.Printf("[RawProxy] Opening yamux stream...")
	// setupStart brackets the FULL request-setup handshake (open → req write →
	// ACK read). Recorded as SetupDur — the operator-felt "conn" leg before the
	// SSE starts streaming. openStart (OpenDur) is the in-process OpenStream
	// sub-duration only.
	setupStart := time.Now()
	openStart := setupStart
	stream, err := worker.Transport.OpenStream()
	if err != nil {
		// PROBE 4: record open failure.
		yst := &diag.Default.Yamux
		yst.StreamOpenFails.Inc()
		log.Printf("[RawProxy] Failed to open yamux stream: %v", err)
		http.Error(w, "Failed to reach worker", http.StatusBadGateway)
		return
	}
	// PROBE 4: record successful open. ActiveStreams is a TRUE global inc/dec
	// counter (+1 here, -1 in the deferred close) — NOT a per-NumStreams()
	// sample. The previous design stored one worker's NumStreams() into the
	// gauge, so a multi-worker controller's last sample silently overwrote the
	// others (gauge showed the last-sampled worker's stream count, not the
	// fleet total). Per-session correlation now rides on each slow-write
	// incident's Aux (sampled from the incident's OWN session via
	// YamuxWriteMonitor.WithSession).
	{
		yst := &diag.Default.Yamux
		yst.StreamsOpened.Inc()
		yst.OpenDur.Observe(int64(time.Since(openStart)))
		yst.ActiveStreams.Add(1)
	}
	// PROBE 4: record stream close reason + decrement the global active-stream
	// counter. Default is StreamCloseSetup (most early returns below are setup
	// failures); upgraded to StreamCloseAck once past hijack, and to
	// StreamCloseCopyError if a copy leg errors.
	closeReason := diag.StreamCloseSetup
	// setupRecorded guards the deferred SetupDur observation so it fires once
	// per call no matter which return path executes. Each setup-failure return
	// below records SetupDur before stream.Close; the success path records it
	// right after the ACK is accepted, before the copy phase begins.
	setupRecorded := false
	recordSetup := func() {
		if setupRecorded {
			return
		}
		setupRecorded = true
		diag.Default.Yamux.SetupDur.Observe(int64(time.Since(setupStart)))
	}
	defer func() {
		recordSetup()
		diag.Default.Yamux.CloseReason[closeReason].Inc()
		diag.Default.Yamux.ActiveStreams.Add(-1)
	}()
	// log.Printf("[RawProxy] Yamux stream opened successfully")

	// Send the raw proxy request telling the client which port to connect to.
	// F1 (remote-latency brief): the header frame is PADDED to exactly
	// tunnel.RawProxyHeaderFrameLen — see that constant for why this is the
	// load-bearing one-sided-safety mechanism (it keeps the pipelined request
	// bytes below out of an OLD worker's json.Decoder first-Read window; the
	// padding residue the decoder does swallow is discardable by design).
	rawReq := tunnel.RawProxyMessage{
		BaseMessage: tunnel.BaseMessage{
			Type: tunnel.TypeRawProxy,
		},
		Port: 0, // 0 means use the worker's web port on the agent side
	}
	// log.Printf("[RawProxy] Sending RawProxyMessage...")
	// PROBE 4 (Phase 4): ReqWriteDur brackets the WriteJSON call. For a healthy
	// tunnel this is sub-millisecond (it's a tiny JSON frame written into the
	// local yamux send buffer); a tail here implies send-window backpressure
	// from an un-acked prior stream — rare and worth flagging separately from
	// AckDur (which is where a silently-dead tunnel blocks until yamux's
	// keepalive/connection-write timeout fires).
	reqWriteStart := time.Now()
	if err := stream.WriteJSONPadded(rawReq, tunnel.RawProxyHeaderFrameLen); err != nil {
		diag.Default.Yamux.ReqWriteDur.Observe(int64(time.Since(reqWriteStart)))
		log.Printf("[RawProxy] Failed to send raw proxy request: %v", err)
		http.Error(w, "Failed to setup raw proxy", http.StatusBadGateway)
		stream.Close()
		return
	}
	diag.Default.Yamux.ReqWriteDur.Observe(int64(time.Since(reqWriteStart)))

	// F1 (remote-latency brief, 2026-10-12): PIPELINE the request write ahead
	// of the ACK read. The pre-F1 order (write header → block on ack → write
	// request) serializes a full controller↔worker RTT into EVERY proxied
	// request (measured warm p50 262ms = 3×RTT, of which ~85ms is pure ack
	// wait). Writing the full request bytes IMMEDIATELY after the padded
	// header means the request crosses the tunnel in the same flight as the
	// worker's ack returning: warm ≈ 2×RTT. Wire compatibility (one-sided
	// safe): the worker's copy loop (pkg/agent/daemon.go handleRawProxy)
	// drains stream.Raw() — the request bytes simply wait in its yamux recvBuf
	// until the copy starts — and the padded header keeps those bytes out of
	// the worker header reader's decoder window (tunnel.RawProxyHeaderFrameLen).
	// Error paths unchanged: on dial failure the worker sends TypeError JSON
	// and closes (our already-written request bytes are discarded with the
	// stream); on a dead tunnel the ack read below still blocks until yamux
	// keepalive/ConnectionWriteTimeout fires, preserving the AckDur signature.

	// Read the request body BEFORE the ack read (it feeds the request write
	// below; also required before hijack — Go forbids reading r.Body after
	// Hijack).
	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		log.Printf("[RawProxy] Failed to read request body: %v", err)
		http.Error(w, "Failed to read request body", http.StatusInternalServerError)
		stream.Close()
		return
	}

	// Hijack the browser's HTTP connection to get raw TCP access
	// log.Printf("[RawProxy] Hijacking HTTP connection...")
	hj, ok := w.(http.Hijacker)
	if !ok {
		log.Printf("[RawProxy] Hijacking not supported by ResponseWriter")
		http.Error(w, "Hijacking not supported", http.StatusInternalServerError)
		stream.Close()
		return
	}

	// Write the HTTP request to the yamux stream manually (can't use r.Write after hijack)
	// log.Printf("[RawProxy] Writing HTTP request to stream...")
	//
	// PROBE 4 (Finding 1): wrap stream.Raw() as a write destination so EVERY
	// write to the yamux stream (this initial request write AND the
	// browser→yamux io.Copy below) is timed per-call and attributed to the
	// REQUEST direction (controller browser→yamux). The RESPONSE direction
	// (worker local-service→yamux, where flow-control backpressure actually
	// accumulates) is instrumented separately on the worker in
	// pkg/agent/daemon.go handleRawProxy — see NewYamuxWriteMonitor there.
	// yamux.Stream does not implement io.WriterTo / io.ReaderFrom, so wrapping
	// does not change io.Copy's generic buffered loop — it stays
	// observation-only.
	var yamuxW io.Writer = diag.NewYamuxWriteMonitor(stream.Raw(), diag.YamuxWriteRequest)
	if worker.Transport != nil && worker.Transport.Session != nil {
		yamuxW.(*diag.YamuxWriteMonitor).WithSession(worker.Transport.Session)
	}
	reqURL := r.URL.RequestURI()
	fmt.Fprintf(yamuxW, "%s %s HTTP/1.1\r\n", r.Method, reqURL)
	fmt.Fprintf(yamuxW, "Host: %s\r\n", r.Host)
	for key, vals := range r.Header {
		for _, val := range vals {
			fmt.Fprintf(yamuxW, "%s: %s\r\n", key, val)
		}
	}
	fmt.Fprintf(yamuxW, "\r\n")
	if len(bodyBytes) > 0 {
		yamuxW.Write(bodyBytes)
	}
	// log.Printf("[RawProxy] Request written (%d body bytes), waiting for ACK", len(bodyBytes))

	// Wait for the client to confirm the connection is established
	// log.Printf("[RawProxy] Waiting for ACK from agent...")
	// PROBE 4 (Phase 4): AckDur brackets the ack read. Still the PRIMARY
	// "silently-dead-but-online tunnel" signal under F1 pipelining for
	// typical requests: the header AND request bytes sit in the local send
	// buffer (a request smaller than yamux's 256KB initial send window
	// buffers without a round trip), and this read blocks until yamux's
	// keepalive miss (~10s) + ConnectionWriteTimeout (~10s) fire and tear
	// the session down. A tail in AckDur p99/max near 10-20s remains the
	// signature of the freeze this probe is built to capture. CAVEAT: a
	// request body LARGER than the send window on a dead tunnel blocks in
	// the request write ABOVE instead — that stall lands in ReqWriteDur /
	// nowhere, not here; the 502 outcome is identical either way.
	//
	// F1 decoder-buffer bridge (the known subtlety): with the request
	// pipelined, the worker's ack and the first response bytes can coalesce in
	// the stream (the worker's copy loop starts the moment it acks). Reading
	// the ack with a bare json.Decoder would swallow the response head into
	// the decoder's private buffer and drop it. decodeAckWithResidue returns
	// those buffered bytes as a residue reader that is drained — ahead of the
	// raw stream — by the yamux→browser copy leg below.
	var ack tunnel.BaseMessage
	ackReadStart := time.Now()
	ack, residue, readErr := decodeAckWithResidue(stream.Raw())
	diag.Default.Yamux.AckDur.Observe(int64(time.Since(ackReadStart)))
	if readErr != nil {
		log.Printf("[RawProxy] ACK read failed: %v", readErr)
		http.Error(w, "Worker failed to connect to local service", http.StatusBadGateway)
		stream.Close()
		return
	}
	// log.Printf("[RawProxy] Got ACK type: %s", ack.Type)
	if ack.Type == tunnel.TypeError {
		log.Printf("[RawProxy] Agent reported error — service not available")
		http.Error(w, "Worker cannot proxy: service not available", http.StatusBadGateway)
		stream.Close()
		return
	}
	// ACK accepted — record the full setup duration NOW (before the copy
	// phase) so SetupDur is the clean operator-felt "time from request arrive
	// to tunnel-setup done". Under F1 this includes the browser body read AND
	// the request write (which overlapped the ack transit) — the setup leg is
	// now ~1 RTT shorter. Probe consumers comparing across the F1 boundary
	// should note both inclusions: a slow streaming upload now inflates
	// SetupDur where it previously sat between the ack and this bracket.
	recordSetup()

	clientConn, clientBuf, err := hj.Hijack()
	if err != nil {
		log.Printf("[RawProxy] Hijack failed: %v", err)
		stream.Close()
		return
	}
	// log.Printf("[RawProxy] Hijack successful")
	// log.Printf("[RawProxy] Starting bidirectional copy (%d body bytes)", len(bodyBytes))

	// Past setup — copy phase. Upgrade the default close reason to "normal".
	closeReason = diag.StreamCloseAck

	// Bidirectional copy between browser connection and yamux stream.
	//
	// PROBE 6 (controller browser-leg accounting): each copy direction records
	// bytes / total duration / termination class via atomic ops measured around
	// the io.Copy call. The controller stays protocol-agnostic — NO SSE parsing.
	// Probe 4's per-write timing for the browser→yamux direction comes from the
	// yamuxW wrapper above (the io.Copy destination); reads from yamux are
	// passive and their blocked time shows up in Copy[yamux_to_browser].Dur.
	//
	// The yamux→browser source drains the F1 ack-decode residue FIRST when the
	// ack read swallowed the head of the response, then the raw stream.
	yamuxReadSrc := io.MultiReader(residue, stream.Raw())
	if p.runBidirectionalCopy(clientConn, clientBuf, yamuxW, yamuxReadSrc, func() { _ = stream.Close() }) {
		closeReason = diag.StreamCloseCopyError
	}
	// log.Printf("[RawProxy] Raw proxy session ended for %s", r.URL.Path)
}

// decodeAckWithResidue reads the worker's ack JSON frame from r, returning the
// ack plus a bridge reader over the bytes that follow the ack frame. F1
// pipelining makes this bridge mandatory: the worker's ack and the first
// bytes of the HTTP response can coalesce in the stream (the worker's copy
// goroutine starts pumping the local service the instant it sends the ack),
// and a bare ReadJSON would strand the response head inside the decoder's
// private buffer — dropped when the decoder is discarded, so the browser
// would receive a truncated response.
//
// The ack frame is value+'\n' (Stream.WriteJSON). Where the decoder's last
// Read landed decides whether that '\n' sits at the head of dec.Buffered()
// or is still unread in r — exactly one byte is consumed from the combined
// (residue ∥ source) stream so the returned bridge starts precisely at the
// response head (a stray '\n' forwarded ahead of "HTTP/1.1 ..." would be a
// protocol impurity on the hijacked browser connection). The terminating
// byte is always in flight with the ack itself, so this one-byte read cannot
// block beyond the ack's arrival.
func decodeAckWithResidue(r io.Reader) (tunnel.BaseMessage, io.Reader, error) {
	dec := json.NewDecoder(r)
	var ack tunnel.BaseMessage
	if err := dec.Decode(&ack); err != nil {
		return ack, emptyReader, err
	}
	src := io.MultiReader(dec.Buffered(), r)
	var first [1]byte
	n, rerr := src.Read(first[:])
	if rerr != nil && n == 0 {
		// Source ended immediately after the ack value — nothing to bridge.
		return ack, emptyReader, nil
	}
	if n == 1 && first[0] == '\n' {
		// The frame terminator, wherever the read boundary left it: consumed,
		// never forwarded.
		return ack, src, nil
	}
	// Not the terminator — Decode already consumed it (or a malformed peer
	// omitted it): this byte is the first response byte, preserve it.
	return ack, io.MultiReader(bytes.NewReader(first[:n]), src), nil
}

var emptyReader io.Reader = strings.NewReader("")

// runBidirectionalCopy pumps bytes between the browser connection and the yamux
// stream, recording Probe 6 copy accounting (bytes / duration / termination
// class) and Probe 4 yamux bytes-read. It returns true if either copy leg
// errored (used to pick the stream close-reason probe).
//
// Finding 3: copyErrored is an atomic.Bool, not a plain bool. The two io.Copy
// goroutines terminate concurrently and BOTH may Store(true) with no
// synchronization — a plain-bool race that `go test -race -race` flags. Reads
// happen only after wg.Wait, but the two unsynchronized writes still race each
// other; the atomic makes the write side race-free. Extracted from
// handleRawProxy so the concurrent-write boundary is unit-testable under
// `-race -count=N` without standing up full yamux transport.
func (p *Proxy) runBidirectionalCopy(clientConn net.Conn, clientBuf *bufio.ReadWriter, yamuxW io.Writer, yamuxRead io.Reader, closeStream func()) bool {
	var wg sync.WaitGroup
	var copyErrored atomic.Bool
	wg.Add(2)

	// yamux → browser (yamux is the reader, browser conn is the writer)
	go func() {
		defer wg.Done()
		copyStart := time.Now()
		n, err := io.Copy(clientConn, yamuxRead)
		dur := time.Since(copyStart)
		cs := &diag.Default.Copy[diag.CopyYamuxToBrowser]
		cs.Bytes.Add(uint64(n))
		cs.Dur.Observe(int64(dur))
		if err != nil {
			cs.Term[diag.CopyTermError].Inc()
			copyErrored.Store(true)
		} else {
			cs.Term[diag.CopyTermNormal].Inc()
		}
		// PROBE 4: bytes read FROM yamux in this direction.
		diag.Default.Yamux.BytesRead.Add(uint64(n))
		clientConn.Close()
	}()

	// browser → yamux (browser buf is the reader, yamux is the writer via the
	// Probe 4 wrapper so per-write timing is captured)
	go func() {
		defer wg.Done()
		copyStart := time.Now()
		n, err := io.Copy(yamuxW, clientBuf)
		dur := time.Since(copyStart)
		cs := &diag.Default.Copy[diag.CopyBrowserToYamux]
		cs.Bytes.Add(uint64(n))
		cs.Dur.Observe(int64(dur))
		if err != nil {
			cs.Term[diag.CopyTermError].Inc()
			copyErrored.Store(true)
		} else {
			cs.Term[diag.CopyTermNormal].Inc()
		}
		closeStream()
	}()

	wg.Wait()
	return copyErrored.Load()
}

// Ensure bufio.ReadWriter satisfies io.Reader for io.Copy
var _ io.Reader = (*bufio.ReadWriter)(nil)
var _ net.Conn = (net.Conn)(nil)

// FetchWorkerSnapshot fetches ONE worker's full /vh/diag/latency JSON through
// the yamux tunnel, returning the verbatim body bytes. This is the production
// per-worker fetcher for the controller's aggregated /vh/diag/latency handler
// (see pkg/server/diag_aggregate.go).
//
// Unlike handleRawProxy (which HIJACKS the browser's ResponseWriter for chunk-
// by-chunk streaming), this method does a clean buffered HTTP request/response
// round-trip: open stream → RawProxy handshake → write HTTP GET → read full
// HTTP response → return body. The worker's handleRawProxy (pkg/agent/daemon.go)
// does the matching bidirectional copy between this yamux stream and its local
// web server, so a complete request/response exchange works exactly as if the
// controller had dialed the worker's web port directly.
//
// The ctx bounds the fetch; cancellation (e.g. the aggregator's per-worker
// timeout) propagates through the yamux write/read to abort the round-trip. The
// caller's per-worker timeout caps how long this can hold the global response.
//
// Returns:
//   - body bytes (the worker's diag JSON) on HTTP 200
//   - an error wrapping the worker ID + step + HTTP status / underlying cause
//     otherwise (non-200, stream error, transport closed, ACK error)
//
// Probe accounting is DELIBERATELY omitted here: the aggregator is on-demand
// only (no hot-path cost), and the existing handleRawProxy already attributes
// stream-open / copy accounting to real user-driven requests. Adding the same
// probes here would conflate operator-driven diag fan-out with real traffic in
// Probe 4's histograms. The per-worker fetch's own latency surfaces as a
// `failures` reason string if it times out, which is the right diagnostic.
func (p *Proxy) FetchWorkerSnapshot(ctx context.Context, worker *Worker) ([]byte, error) {
	if worker == nil {
		return nil, fmt.Errorf("nil worker")
	}
	if worker.Transport == nil || worker.Transport.IsClosed() {
		return nil, fmt.Errorf("worker %s: transport closed", worker.ID)
	}

	// Respect ctx before we even open a stream — covers the global-deadline
	// branch in the aggregator when the fleet queues past the global timeout.
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("worker %s: %w", worker.ID, err)
	}

	stream, err := worker.Transport.OpenStream()
	if err != nil {
		return nil, fmt.Errorf("worker %s: open stream: %w", worker.ID, err)
	}
	defer stream.Close()

	// RawProxy handshake — identical to handleRawProxy, including the F1
	// pipelining (padded header frame + request bytes written BEFORE the ack
	// read; see tunnel.RawProxyHeaderFrameLen and decodeAckWithResidue). The
	// diag aggregator is on-demand only, but it fans out one full handshake per
	// worker per fetch — pipelining takes the same RTT out of each fan-out
	// leg. Port=0 → worker's web port on the agent side (see
	// pkg/agent/daemon.go handleRawProxy).
	rawReq := tunnel.RawProxyMessage{
		BaseMessage: tunnel.BaseMessage{Type: tunnel.TypeRawProxy},
		Port:        0,
	}
	if err := stream.WriteJSONPadded(rawReq, tunnel.RawProxyHeaderFrameLen); err != nil {
		return nil, fmt.Errorf("worker %s: send raw-proxy: %w", worker.ID, err)
	}

	// Abort the write side if ctx elapses mid-request. yamux.Stream writes are
	// not context-aware, so a goroutine closes the stream on ctx.Done to unblock
	// a stuck write. The defer-Stop() below stops the watcher on normal return.
	ctxStop := make(chan struct{})
	defer close(ctxStop)
	go func() {
		select {
		case <-ctx.Done():
			_ = stream.Close()
		case <-ctxStop:
		}
	}()

	// Write the HTTP request as raw bytes onto the stream immediately (F1:
	// no ack wait). Connection: close so the worker's local web server closes
	// the response after sending it, which lets http.ReadResponse terminate
	// cleanly without a Content-Length sniff.
	raw := stream.Raw()
	reqLine := "GET /vh/diag/latency HTTP/1.1\r\nHost: " + worker.ID + "\r\nConnection: close\r\n\r\n"
	if _, err := raw.Write([]byte(reqLine)); err != nil {
		return nil, fmt.Errorf("worker %s: write request: %w", worker.ID, err)
	}

	// Ack read with the F1 decoder-buffer bridge: with the request pipelined,
	// the ack and the response head can coalesce — the residue reader below is
	// drained ahead of the raw stream so http.ReadResponse sees a contiguous
	// response.
	ack, residue, err := decodeAckWithResidue(raw)
	if err != nil {
		return nil, fmt.Errorf("worker %s: read ack: %w", worker.ID, err)
	}
	if ack.Type == tunnel.TypeError {
		return nil, fmt.Errorf("worker %s: agent cannot proxy to local web port", worker.ID)
	}

	br := bufio.NewReader(io.MultiReader(residue, raw))
	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		return nil, fmt.Errorf("worker %s: read response: %w", worker.ID, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("worker %s: HTTP %d", worker.ID, resp.StatusCode)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, fmt.Errorf("worker %s: read body: %w", worker.ID, err)
	}
	return body, nil
}
