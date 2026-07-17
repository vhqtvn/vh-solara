package agent

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
	"github.com/vhqtvn/vh-solara/pkg/tunnel"
)

// This file proves the B-F1 fix: the worker-side handleRawProxy maintains the
// process-local ActiveStreams gauge (diag.Default.Yamux.ActiveStreams) for the
// lifetime of each accepted proxy stream. The pre-fix worker process never
// touched the gauge, so worker_client active_streams_at_write — sampled by
// wsRWC.Write from that gauge — recorded always-zero, surfacing misleading data
// in the very Performance diagnostics dialog this slice adds.
//
// The end-to-end test below stands up BOTH tunnel endpoints in one process
// (a paired controller-side + worker-side MuxTransport over a real websocket, so
// each side has its own wsRWC reporting into diag.Default), drives a real
// RawProxy stream through Daemon.handleRawProxy, and asserts that a wsRWC.Write
// fired by yamux DURING the active worker proxy stream records a NON-ZERO
// worker_client active_streams_at_write sample. Lock-freedom (the hot path does
// NOT call yamux NumStreams()) is proven independently and structurally by
// TestWSRWCWriteHotPathSkipsNumStreams in pkg/tunnel/websocket_hotpath_test.go;
// the two tests compose to fully retire B-F1.

// pairedMux stands up a paired controller↔worker tunnel in one process: a
// websocket server end and a websocket client end, each wrapped by a
// tunnel.MuxTransport (controller = yamux Server / wsRWC SideServer, worker =
// yamux Client / wsRWC SideClient). Mirrors the real tunnel topology so both
// wsRWC instances report into diag.Default and we can read either side's
// histogram. cleanup tears down both sessions and the http server.
func pairedMux(t *testing.T) (controller, worker *tunnel.MuxTransport, cleanup func()) {
	t.Helper()
	done := make(chan struct{})
	upCh := make(chan *websocket.Conn, 1)
	up := websocket.Upgrader{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade: %v", err)
			return
		}
		upCh <- c
		<-done // hold the upgraded conn's handler until cleanup
	}))

	dialURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/"
	cliConn, _, err := websocket.DefaultDialer.Dial(dialURL, nil)
	if err != nil {
		close(done)
		srv.Close()
		t.Fatalf("dial paired mux: %v", err)
	}
	srvConn := <-upCh

	worker, err = tunnel.NewMuxTransportClient(cliConn)
	if err != nil {
		close(done)
		cliConn.Close()
		srvConn.Close()
		srv.Close()
		t.Fatalf("worker mux: %v", err)
	}
	controller, err = tunnel.NewMuxTransportServer(srvConn)
	if err != nil {
		close(done)
		worker.Close()
		srvConn.Close()
		srv.Close()
		t.Fatalf("controller mux: %v", err)
	}

	cleanup = func() {
		close(done)
		controller.Close()
		worker.Close()
		srv.Close()
	}
	return controller, worker, cleanup
}

// workerClientActiveStreamsAtWrite reads the worker_client ws_write
// active_streams_at_write histogram out of the diagnostics snapshot via JSON
// (the snapshot types are unexported in package diagnostics, so we mirror only
// the fields we assert on, the same pattern as pkg/tunnel's wsSnap). Returns
// (count, max) for the worker_client side; (0, 0) if no such side exists yet.
func workerClientActiveStreamsAtWrite(t *testing.T) (count, max int64) {
	t.Helper()
	b, err := json.Marshal(diag.Snapshot())
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	var snap struct {
		Probes struct {
			WSWrite []struct {
				Side string `json:"side"`
				ActiveStreamsAtWrite struct {
					Count int64 `json:"count"`
					Max   int64 `json:"max_ns"`
				} `json:"active_streams_at_write"`
			} `json:"ws_write"`
		} `json:"probes"`
	}
	if err := json.Unmarshal(b, &snap); err != nil {
		t.Fatalf("unmarshal snapshot: %v", err)
	}
	for _, w := range snap.Probes.WSWrite {
		if w.Side == "worker_client" {
			return w.ActiveStreamsAtWrite.Count, w.ActiveStreamsAtWrite.Max
		}
	}
	return 0, 0
}

// TestHandleRawProxyMaintainsActiveStreamsGaugeForWorkerWrite is the end-to-end
// B-F1 retirement proof.
//
// FAIL-without (the bug): the worker process never inc/dec'd ActiveStreams, so
// during a live worker proxy stream the gauge stayed 0 and worker_client
// active_streams_at_write recorded count=N with max=0 (always zero). An operator
// watching the new Performance diagnostics dialog would see a flat-zero
// histogram while real proxy streams were active.
//
// PASS-with (the fix): handleRawProxy incs the gauge on entry / decs on exit,
// so (a) the gauge reads exactly 1 during the active proxy and 0 after, and
// (b) a wsRWC.Write fired by yamux during the active proxy records a NON-ZERO
// active_streams_at_write sample (count >= 1, max >= 1).
func TestHandleRawProxyMaintainsActiveStreamsGaugeForWorkerWrite(t *testing.T) {
	diag.ResetForTest()

	// 1. Local TCP target: accept one connection, write enough bytes to force
	//    yamux egress frames on the worker (response-direction copy leg:
	//    io.Copy(stream, localConn) → yamux.Stream.Write → wsRWC.Write), then
	//    hold the connection open via <‑release so the proxy stream stays
	//    active while we assert.
	release := make(chan struct{})
	targetLn, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("target listen: %v", err)
	}
	targetAccepted := make(chan struct{}, 1)
	go func() {
		conn, err := targetLn.Accept()
		if err != nil {
			return
		}
		defer conn.Close()
		targetAccepted <- struct{}{}
		// Minimal HTTP-ish response with a multi-KB body. The worker does raw
		// byte proxying (no HTTP parsing on the tunnel), so any bytes here flow
		// straight through to yamux egress and trigger wsRWC.Write.
		io.WriteString(conn, "HTTP/1.1 200 OK\r\nContent-Length: 8192\r\n\r\n")
		io.WriteString(conn, strings.Repeat("x", 8192))
		<-release
	}()
	defer targetLn.Close()
	defer close(release)

	_, portStr, _ := net.SplitHostPort(targetLn.Addr().String())
	webPort, _ := strconv.Atoi(portStr)

	// 2. Paired tunnel. handleRawProxy only touches d.Proxy.WebPort on the
	//    happy path (the HealthCheck path is dial-failure-only and unreachable
	//    here because the target is up), so a Daemon with just Proxy set is a
	//    faithful in-process stand-in.
	d := &Daemon{Proxy: &Proxy{WebPort: webPort}}
	controller, worker, cleanup := pairedMux(t)
	defer cleanup()

	// 3. Worker accept loop: accept exactly one stream and dispatch it through
	//    handleStream (which reads the RawProxyMessage and calls handleRawProxy).
	workerHandled := make(chan struct{})
	go func() {
		defer close(workerHandled)
		stream, err := worker.AcceptStream()
		if err != nil {
			return
		}
		d.handleStream(stream, worker.Session)
	}()

	// 4. Controller opens a stream and sends the RawProxy request (Port: 0 →
	//    worker uses its Proxy.WebPort, which points at targetLn). A drain
	//    goroutine reads the response bytes the worker sends back and closes
	//    cstream on EOF — this mirrors the real controller proxy's yamux→browser
	//    copy leg (pkg/server/proxy.go runBidirectionalCopy) and is required for
	//    clean stream teardown: without a reader, the worker's stream.Close()
	//    after localConn EOF would leave the yamux half-close pending and
	//    handleRawProxy's copy legs would not both terminate.
	cstream, err := controller.OpenStream()
	if err != nil {
		t.Fatalf("controller OpenStream: %v", err)
	}
	rawReq := tunnel.RawProxyMessage{
		BaseMessage: tunnel.BaseMessage{Type: tunnel.TypeRawProxy},
		Port:        0,
	}
	if err := cstream.WriteJSON(rawReq); err != nil {
		t.Fatalf("controller WriteJSON rawproxy: %v", err)
	}
	controllerDrainDone := make(chan struct{})
	go func() {
		defer close(controllerDrainDone)
		io.Copy(io.Discard, cstream.Raw())
		cstream.Close()
	}()

	// 5. Wait for the gauge to climb to exactly 1 — the worker's handleRawProxy
	//    incremented it on entry. Without the B-F1 fix this stays 0.
	if !withinDeadline(3*time.Second, func() bool {
		return diag.Default.Yamux.ActiveStreams.Load() == 1
	}) {
		t.Fatalf("ActiveStreams = %d during active worker proxy, want 1 "+
			"(worker handleRawProxy did not increment the gauge — B-F1 regression)",
			diag.Default.Yamux.ActiveStreams.Load())
	}

	// Sanity: the target was actually reached (proves the proxy dialed through).
	select {
	case <-targetAccepted:
	case <-time.After(3 * time.Second):
		t.Fatalf("target was never reached by the worker proxy")
	}

	// 6. The worker has written its ACK and is now copying response bytes from
	//    the target back through yamux → wsRWC.Write. Each such write samples
	//    the gauge (==1) into worker_client active_streams_at_write. Wait until
	//    at least one non-zero sample lands.
	if !withinDeadline(3*time.Second, func() bool {
		count, max := workerClientActiveStreamsAtWrite(t)
		return count >= 1 && max >= 1
	}) {
		count, max := workerClientActiveStreamsAtWrite(t)
		t.Fatalf("worker_client active_streams_at_write = (count=%d, max=%d), "+
			"want count>=1 AND max>=1 during an active proxy stream — the worker "+
			"wsRWC.Write recorded a zero sample (B-F1 regression: gauge not wired "+
			"on the worker process)", count, max)
	}

	// 7. Release the target so the proxy stream drains and handleRawProxy
	//    returns, which must decrement the gauge back to 0.
	release <- struct{}{}
	select {
	case <-workerHandled:
	case <-time.After(5 * time.Second):
		t.Fatalf("worker handleStream did not return after target release")
	}
	if !withinDeadline(3*time.Second, func() bool {
		return diag.Default.Yamux.ActiveStreams.Load() == 0
	}) {
		t.Fatalf("ActiveStreams = %d after proxy stream closed, want 0 "+
			"(worker handleRawProxy did not decrement the gauge on exit)",
			diag.Default.Yamux.ActiveStreams.Load())
	}

	// 8. The histogram retains the non-zero samples recorded during the active
	//    proxy (final-state confirmation: count>=1, max>=1, NOT all-zero).
	count, max := workerClientActiveStreamsAtWrite(t)
	if count < 1 || max < 1 {
		t.Fatalf("final worker_client active_streams_at_write = (count=%d, max=%d), "+
			"want retained non-zero samples from the active proxy window", count, max)
	}
}

// withinDeadline polls cond every ~2ms until it returns true or the deadline
// expires. Returns true if cond held at some poll, false on timeout. Used
// instead of fixed sleeps so the test is fast on warm runs and robust on slow
// CI without flake risk.
func withinDeadline(d time.Duration, cond func() bool) bool {
	deadline := time.Now().Add(d)
	for {
		if cond() {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(2 * time.Millisecond)
	}
}
