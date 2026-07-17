package server

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
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
		log.Printf("[RawProxy] Worker transport is nil or closed")
		http.Error(w, "Worker transport is closed", http.StatusBadGateway)
		return
	}

	// log.Printf("[RawProxy] Opening yamux stream...")
	openStart := time.Now()
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
	defer func() {
		diag.Default.Yamux.CloseReason[closeReason].Inc()
		diag.Default.Yamux.ActiveStreams.Add(-1)
	}()
	// log.Printf("[RawProxy] Yamux stream opened successfully")

	// Send the raw proxy request telling the client which port to connect to
	rawReq := tunnel.RawProxyMessage{
		BaseMessage: tunnel.BaseMessage{
			Type: tunnel.TypeRawProxy,
		},
		Port: 0, // 0 means use the worker's web port on the agent side
	}
	// log.Printf("[RawProxy] Sending RawProxyMessage...")
	if err := stream.WriteJSON(rawReq); err != nil {
		log.Printf("[RawProxy] Failed to send raw proxy request: %v", err)
		http.Error(w, "Failed to setup raw proxy", http.StatusBadGateway)
		stream.Close()
		return
	}

	// Wait for the client to confirm the connection is established
	// log.Printf("[RawProxy] Waiting for ACK from agent...")
	var ack tunnel.BaseMessage
	if err := stream.ReadJSON(&ack); err != nil {
		log.Printf("[RawProxy] ACK read failed: %v", err)
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

	// Read the request body BEFORE hijacking (Go forbids reading r.Body after Hijack)
	// log.Printf("[RawProxy] Reading request body before hijack...")
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

	clientConn, clientBuf, err := hj.Hijack()
	if err != nil {
		log.Printf("[RawProxy] Hijack failed: %v", err)
		stream.Close()
		return
	}
	// log.Printf("[RawProxy] Hijack successful")

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
	// log.Printf("[RawProxy] Request written (%d body bytes), starting bidirectional copy", len(bodyBytes))

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
	if p.runBidirectionalCopy(clientConn, clientBuf, yamuxW, stream.Raw(), func() { _ = stream.Close() }) {
		closeReason = diag.StreamCloseCopyError
	}
	// log.Printf("[RawProxy] Raw proxy session ended for %s", r.URL.Path)
}

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
