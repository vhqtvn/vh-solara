package server

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"sync"

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
	stream, err := worker.Transport.OpenStream()
	if err != nil {
		log.Printf("[RawProxy] Failed to open yamux stream: %v", err)
		http.Error(w, "Failed to reach worker", http.StatusBadGateway)
		return
	}
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
	reqURL := r.URL.RequestURI()
	fmt.Fprintf(stream.Raw(), "%s %s HTTP/1.1\r\n", r.Method, reqURL)
	fmt.Fprintf(stream.Raw(), "Host: %s\r\n", r.Host)
	for key, vals := range r.Header {
		for _, val := range vals {
			fmt.Fprintf(stream.Raw(), "%s: %s\r\n", key, val)
		}
	}
	fmt.Fprintf(stream.Raw(), "\r\n")
	if len(bodyBytes) > 0 {
		stream.Raw().Write(bodyBytes)
	}
	// log.Printf("[RawProxy] Request written (%d body bytes), starting bidirectional copy", len(bodyBytes))

	// Bidirectional copy between browser connection and yamux stream
	var wg sync.WaitGroup
	wg.Add(2)

	// stream → browser
	go func() {
		defer wg.Done()
		_, err := io.Copy(clientConn, stream.Raw())
		if err != nil {
			// ignore copy errors
		}
		clientConn.Close()
	}()

	// browser → stream (use clientBuf to flush any buffered data first)
	go func() {
		defer wg.Done()
		_, err := io.Copy(stream.Raw(), clientBuf)
		if err != nil {
			// ignore copy errors
		}
		stream.Close()
	}()

	wg.Wait()
	// log.Printf("[RawProxy] Raw proxy session ended for %s", r.URL.Path)
}

// Ensure bufio.ReadWriter satisfies io.Reader for io.Copy
var _ io.Reader = (*bufio.ReadWriter)(nil)
var _ net.Conn = (net.Conn)(nil)
