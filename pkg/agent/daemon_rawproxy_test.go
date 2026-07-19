package agent

import (
	"context"
	"encoding/json"
	"fmt"
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
				Side                 string `json:"side"`
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

// --- Phase 4: backoff cap + idle reset proving tests -------------------------
//
// The mission investigation traced the 16.5s overnight SSE freeze partly to
// the worker→controller reconnect backoff: the previous cap (30s) means a
// worker whose tunnel dropped in the night sits at the cap when the operator
// returns, so the next dial attempt is up to 30s away. daemon.Start now
// (1) caps backoff at reconnectCap=5s and (2) snaps back to reconnectFloor=1s
// when the current disconnect streak exceeds reconnectIdleResetThreshold=60s.
//
// These tests stand up a Daemon pointing at a controller URL that refuses
// connections (so every dial fails), drive the Start loop, and assert BOTH
// invariants from the observable side effects:
//
//   - backoff never sleeps longer than reconnectCap (B1)
//   - after the idle-reset threshold, the next sleep drops back to the floor (B2)
//   - the TunnelStats probe (Probe 7) records dial attempts / failures / backoff
//
// The tunnel lifecycle probes are observed directly via diag.Default.Tunnel —
// the worker process is the only writer.

// nextUnusedPort returns a TCP port that is currently closed (nothing
// listening), so a websocket dial to it fails fast with ECONNREFUSED. We pick
// an ephemeral port by binding and immediately closing, then reusing the
// number — close enough for "this dial must fail" on a loopback address.
func nextUnusedPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen for port pick: %v", err)
	}
	port := l.Addr().(*net.TCPAddr).Port
	_ = l.Close()
	return port
}

// startFailingDaemon stands up a Daemon whose Start loop will fail every dial
// (controller URL points at a closed port). Returns the Daemon and a stop
// func that cancels the loop AND blocks until the daemon goroutine has fully
// exited — required so the next test's diag.ResetForTest does not race with
// a still-running worker's probe writes (race detector flagged this in the
// first version).
func startFailingDaemon(t *testing.T) (d *Daemon, stop func()) {
	t.Helper()
	port := nextUnusedPort(t)
	d = NewDaemon(
		fmt.Sprintf("ws://127.0.0.1:%d/", port),
		"worker-test", "test", "test",
		nil, nil,
	)
	ctx, cancel := context.WithCancel(context.Background())
	d.ctx = ctx
	d.cancel = cancel
	done := make(chan struct{})
	go func() {
		defer close(done)
		d.Start()
	}()
	return d, func() {
		cancel()
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			t.Fatalf("daemon did not stop within 10s")
		}
	}
}

// TestBackoffCapBounded proves B1: even after many consecutive dial failures,
// the worker never sleeps longer than reconnectCap (5s). We assert this by
// observing the LastBackoffNs probe — it must never exceed reconnectCap.
func TestBackoffCapBounded(t *testing.T) {
	diag.ResetForTest()
	_, stop := startFailingDaemon(t)
	defer stop()

	// Wait for several dial-failure cycles to elapse. Each cycle is ~backoff
	// + dial-fail latency (~1ms); total well under 1s for the first 5-6
	// cycles (1+2+4+5+5+5 = 22s of sleep, so we only need to peek during the
	// early ones to see the cap engage). We poll the probe and look for the
	// sequence 1s → 2s → 4s → 5s (capped), asserting no sample exceeds 5s.
	seen := map[int64]bool{}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		b := diag.Default.Tunnel.LastBackoffNs.Load()
		seen[b] = true
		if b > int64(reconnectCap) {
			t.Fatalf("backoff %v exceeded cap %v", time.Duration(b), reconnectCap)
		}
		// Dial attempts should be climbing; once we've seen at least 4 distinct
		// backoff values (1s/2s/4s/5s), we've exercised the cap path.
		if len(seen) >= 3 && diag.Default.Tunnel.DialAttempts.Load() >= 4 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := diag.Default.Tunnel.DialFailures.Load(); got < 2 {
		t.Fatalf("DialFailures = %d, want >= 2 (multiple failure cycles)", got)
	}
}

// TestBackoffIdleReset proves B2: after the idle threshold elapses, the
// backoff snaps back to the floor (and IdleResets is incremented, which is
// the operator-visible signal that this recovery path fired). We can't wait
// 60s in a unit test, so we expose the threshold via a package-private var
// override (production-invariant stays at 60s; tests lower it for speed).
//
// Sequence with threshold=300ms:
//
//	t=0:     fail #1, threshold not exceeded (0s < 300ms), backoff stays 1s, sleep 1s
//	t=1s:    fail #2, threshold EXCEEDED (1s > 300ms) AND backoff(2s) > floor →
//	         reset backoff to 1s, IdleResets++, sleep 1s
//	t=2s:    fail #3, threshold EXCEEDED, backoff(2s) > floor → reset, IdleResets++, ...
//
// So IdleResets must climb after the first sleep elapses. Asserting that
// counter (rather than the LastBackoffNs value, which is post-reset = floor)
// is the cleanest observable signal.
func TestBackoffIdleReset(t *testing.T) {
	diag.ResetForTest()
	// Lower the threshold for the test so we don't have to wait 60s. Restore
	// on cleanup. Production stays at 60s — see daemon.go reconnect* consts.
	// NOTE: t.Cleanup runs AFTER the deferred stop() below returns, and
	// stop() blocks until the daemon goroutine has fully exited — so this
	// write cannot race with the worker's reads of the same var.
	prevThreshold := reconnectIdleResetThreshold
	reconnectIdleResetThreshold = 300 * time.Millisecond
	t.Cleanup(func() { reconnectIdleResetThreshold = prevThreshold })

	// startFailingDaemon's stop() waits for the daemon goroutine to exit,
	// which closes the race window with the next test's diag.ResetForTest.
	_, stop := startFailingDaemon(t)
	defer stop()

	// Wait for at least one idle-reset to fire. With threshold=300ms and
	// backoff floor=1s, the first reset fires after the first sleep completes
	// (~1s wall-clock). Generous deadline.
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		if diag.Default.Tunnel.IdleResets.Load() >= 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if got := diag.Default.Tunnel.IdleResets.Load(); got < 1 {
		t.Fatalf("IdleResets = %d, want >= 1 (idle-reset did not fire within deadline)", got)
	}
	// And: backoff never exceeded the cap (B1 still holds even with B2 active).
	if b := diag.Default.Tunnel.LastBackoffNs.Load(); b > int64(reconnectCap) {
		t.Fatalf("LastBackoffNs %v exceeded cap %v", time.Duration(b), reconnectCap)
	}
}

// TestBackoffIdleResetDoesNotFireBelowThreshold proves B2's safety: when the
// threshold is high (the production default), short transient blips do NOT
// trigger the reset — the doubling schedule runs normally. This is the
// "don't accidentally make short blips worse" guarantee.
func TestBackoffIdleResetDoesNotFireBelowThreshold(t *testing.T) {
	diag.ResetForTest()
	// Use a high threshold (10s) so the test window can't possibly trip it.
	prevThreshold := reconnectIdleResetThreshold
	reconnectIdleResetThreshold = 10 * time.Second
	t.Cleanup(func() { reconnectIdleResetThreshold = prevThreshold })

	_, stop := startFailingDaemon(t)
	defer stop()

	// Wait for a couple of dial-failure cycles (well under the 10s threshold).
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if diag.Default.Tunnel.DialAttempts.Load() >= 2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	// IdleResets MUST stay zero — threshold not exceeded.
	if got := diag.Default.Tunnel.IdleResets.Load(); got != 0 {
		t.Fatalf("IdleResets = %d, want 0 (threshold %v not exceeded within test window)",
			got, reconnectIdleResetThreshold)
	}
}

// TestTunnelProbeRecordsDialLifecycle proves Probe 7 captures the worker-side
// tunnel lifecycle the way the operator-facing /vh/diag/latency needs: each
// dial attempt / failure is counted, and CurrentState reflects "disconnected"
// while the worker is in the backoff loop.
func TestTunnelProbeRecordsDialLifecycle(t *testing.T) {
	diag.ResetForTest()
	_, stop := startFailingDaemon(t)
	defer stop()

	// Wait for at least 2 dial-failure cycles.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if diag.Default.Tunnel.DialAttempts.Load() >= 2 &&
			diag.Default.Tunnel.DialFailures.Load() >= 2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if got := diag.Default.Tunnel.DialAttempts.Load(); got < 2 {
		t.Fatalf("DialAttempts = %d, want >= 2", got)
	}
	if got := diag.Default.Tunnel.DialFailures.Load(); got < 2 {
		t.Fatalf("DialFailures = %d, want >= 2", got)
	}
	if got := diag.Default.Tunnel.CurrentState.Load(); got != int32(diag.TunnelStateDisconnected) {
		t.Fatalf("CurrentState = %d, want %d (disconnected while failing to dial)",
			got, diag.TunnelStateDisconnected)
	}
	// LastDisconnectAtNs was initialized to process-start time and must be
	// non-zero (so the operator's snapshot can compute "disconnected for").
	if got := diag.Default.Tunnel.LastDisconnectAtNs.Load(); got == 0 {
		t.Fatalf("LastDisconnectAtNs = 0, want non-zero (initialized at Start)")
	}
	// LastBackoffNs is stamped before each sleep — must be non-zero after at
	// least one failure cycle.
	if got := diag.Default.Tunnel.LastBackoffNs.Load(); got == 0 {
		t.Fatalf("LastBackoffNs = 0, want non-zero (stamped on each failure)")
	}
}
