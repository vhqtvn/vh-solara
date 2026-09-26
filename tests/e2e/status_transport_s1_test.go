package e2e

// status_transport_s1_test.go — S1 EVIDENCE-GATE tests (task card
// task-2026-09-25-…-compact-readonly-fleet-status-rollup-api-controller).
//
// Mission: prove (or refute) transport containment for controller→worker
// HTTP-over-yamux fetches through the REAL multiplexed transport, as the gate
// for the future GET /api/fleet/status endpoint. The endpoint itself is NOT
// implemented here.
//
// What "real" means in this file:
//
//   - The controller side is a REAL controller daemon (server.NewDaemon:
//     real WS tunnel endpoint, real yamux server session, real Registry +
//     Proxy) — the exact production fetch path under test.
//   - The adversarial worker peer is a REAL yamux client session built with
//     the production pkg/tunnel constructors (gorilla WS dial →
//     tunnel.NewMuxTransportClient → RegisterMessage handshake), the same
//     way pkg/agent daemon connects. Only the peer's APPLICATION-layer
//     behavior is scripted adversarially (never ACK, stall head, stall
//     body, oversize body, HTTP 500) — a stand-in for a hung/slow/misbehaving
//     worker machine. The "healthy" script relays to a real local HTTP server
//     exactly like agent handleRawProxy does (dial → ACK → bidirectional
//     copy), so the success path is a full production-shaped round trip.
//   - TestS1BoundedFetch_RealStackHappyPath additionally drives the SHARED
//     cluster (TestMain): real controller + real agent daemon + real worker
//     web server end to end.
//
// Containment properties asserted (one per subtest):
//
//  1. healthy fetch returns the exact body within the bound;
//  2. never-ACK fetch terminates at the bound AND a sibling stream on the
//     SAME tunnel completes concurrently and afterwards (no parent-session
//     teardown, same-session isolation);
//  3. repeated stalled fetches do not accumulate retained goroutines;
//  4. stalled response head (ACK then silence) terminates at the bound;
//  5. stalled body (head + partial body then silence) terminates at the bound;
//  6. oversize body is REJECTED by cap-plus-one detection (explicit error,
//     never silent truncation);
//  7. non-2xx is reported as such (not a timeout);
//  8. stream-open against a saturated accept backlog (256 unaccepted
//     streams) terminates at the caller's ctx bound, the parked-opener
//     residual is bounded, and everything drains when the session closes.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/vhqtvn/vh-solara/pkg/server"
	"github.com/vhqtvn/vh-solara/pkg/tunnel"
)

// --- S1 bounds used across the phases -------------------------------------
//
// The fetch bound is deliberately generous vs CI timing noise: stall cases
// must return at ≈bound (assert 0.6×…2× + fixed slop), and fast cases must
// merely be < 2×bound.
const (
	s1Bound   = 1500 * time.Millisecond // per-fetch bound passed to the helper
	s1BodyCap = 8192                    // body cap for the adversarial phases
	s1PeerID  = "s1-adversarial-worker"
)

// Peer scripts for the accepted-stream handler.
const (
	s1ScriptHealthy     int32 = iota // ACK + full relay to a real local HTTP server
	s1ScriptAckThenHang              // ACK, then never send a response head
	s1ScriptStallBody                // ACK + head + partial body, then silence (no FIN)
	s1ScriptOversize                 // ACK + head + cap+4096 body bytes, then silence
	s1ScriptHTTP500                  // ACK + complete 500 response, clean close
)

// s1Peer is a real-tunnel adversarial worker. The WS dial, yamux client
// session, and registration are the production stack (pkg/tunnel + the same
// RegisterMessage the agent sends); only the per-stream behavior is scripted.
type s1Peer struct {
	t   *testing.T
	mux *tunnel.MuxTransport

	helloAddr string // real local HTTP server for the healthy relay script

	script atomic.Int32 // behavior for non-hung accepted streams
	// hangNext: the next N accepted streams hang BEFORE the ACK (read the
	// RawProxy request, never respond, keep the stream open).
	hangNext atomic.Int32

	// hungSeen is signaled (non-blocking) each time a stream enters the
	// pre-ACK hang, so the test can start the sibling fetch only after the
	// hung stream has actually been accepted and read.
	hungSeen chan struct{}

	// pause support: when paused is set, the accept loop quiesces (signals
	// pausedSeen, then blocks on resumeCh) so opened streams pile up in the
	// remote accept backlog — the saturated-backlog phase.
	paused     atomic.Bool
	pausedSeen chan struct{}
	resumeCh   chan struct{}
}

// startS1Daemon boots a private real controller daemon on free loopback
// ports (same shape as the harness's step 3, but owned by this test so the
// adversarial peer never touches the shared cluster).
func startS1Daemon(t *testing.T) *server.Daemon {
	t.Helper()
	userAddr, err := freeAddr()
	if err != nil {
		t.Fatalf("freeAddr: %v", err)
	}
	daemonAddr, err := freeAddr()
	if err != nil {
		t.Fatalf("freeAddr: %v", err)
	}
	d := server.NewDaemon(userAddr, daemonAddr, "")
	d.APIToken = "s1-token"
	go func() { _ = d.Start() }()
	if err := waitHTTP("http://"+userAddr+"/api/coord/workers", "s1-token", 200, 10*time.Second); err != nil {
		t.Fatalf("s1 controller did not come up: %v", err)
	}
	return d
}

// connectS1Peer dials the controller's tunnel endpoint and registers a
// worker using the production pkg/tunnel machinery, then serves accepted
// streams from the scripted handler.
func connectS1Peer(t *testing.T, d *server.Daemon, helloAddr string) *s1Peer {
	t.Helper()
	conn, _, err := websocket.DefaultDialer.Dial("ws://"+d.DaemonAddr+"/vh-solara/ws", nil)
	if err != nil {
		t.Fatalf("peer dial: %v", err)
	}
	mux, err := tunnel.NewMuxTransportClient(conn)
	if err != nil {
		t.Fatalf("peer yamux client: %v", err)
	}

	// Registration — identical to pkg/agent handleTunnel: first stream
	// carries the RegisterMessage.
	regStream, err := mux.OpenStream()
	if err != nil {
		t.Fatalf("peer register stream: %v", err)
	}
	reg := tunnel.RegisterMessage{
		BaseMessage: tunnel.BaseMessage{
			Type:     tunnel.TypeRegister,
			WorkerID: s1PeerID,
		},
		WorkerName: "s1-adversarial",
		Version:    "test",
	}
	if err := regStream.WriteJSON(reg); err != nil {
		t.Fatalf("peer register write: %v", err)
	}
	regStream.Close()

	p := &s1Peer{
		t:          t,
		mux:        mux,
		helloAddr:  helloAddr,
		hungSeen:   make(chan struct{}, 16),
		pausedSeen: make(chan struct{}, 1),
	}
	go p.acceptLoop()
	return p
}

func (p *s1Peer) acceptLoop() {
	for {
		if p.paused.Load() {
			// Signal quiescence (non-blocking) and park until resumed.
			select {
			case p.pausedSeen <- struct{}{}:
			default:
			}
			<-p.resumeCh
		}
		stream, err := p.mux.AcceptStream()
		if err != nil {
			return
		}
		go p.handle(stream)
	}
}

func (p *s1Peer) handle(stream *tunnel.Stream) {
	var base tunnel.BaseMessage
	if err := stream.ReadJSON(&base); err != nil {
		stream.Close()
		return
	}
	if base.Type != tunnel.TypeRawProxy {
		stream.Close()
		return
	}

	// Pre-ACK hang: the request arrived, we never respond, and the stream is
	// deliberately NOT closed (closing would let the controller's read error
	// out; the adversarial point is silence while the session stays alive).
	if p.hangNext.Add(-1) >= 0 {
		select {
		case p.hungSeen <- struct{}{}:
		default:
		}
		return // goroutine exits; stream stays open
	}

	ack := tunnel.BaseMessage{Type: tunnel.TypeRawProxy}
	switch p.script.Load() {
	case s1ScriptHealthy:
		p.relayHealthy(stream)
	case s1ScriptAckThenHang:
		if err := stream.WriteJSON(ack); err != nil {
			return
		}
		// ACK sent; never write a response head. Return without closing.
	case s1ScriptStallBody:
		if err := stream.WriteJSON(ack); err != nil {
			return
		}
		stream.Raw().Write([]byte("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"partial\":"))
		// No more bytes, no FIN. Return without closing.
	case s1ScriptOversize:
		if err := stream.WriteJSON(ack); err != nil {
			return
		}
		stream.Raw().Write([]byte("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n"))
		// body = cap + 4096 bytes, sent synchronously. Total written stays
		// far below the 256 KiB initial send window, so this write completes
		// without blocking and the handler exits (no parked goroutine).
		body := strings.Repeat("x", s1BodyCap+4096)
		stream.Raw().Write([]byte(body))
	case s1ScriptHTTP500:
		if err := stream.WriteJSON(ack); err != nil {
			return
		}
		stream.Raw().Write([]byte("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"))
		stream.Close() // clean end: ReadResponse completes with 500
	default:
		stream.Close()
	}
}

// relayHealthy mirrors pkg/agent handleRawProxy: dial the local service,
// ACK, then bidirectional copy — a full production-shaped round trip.
func (p *s1Peer) relayHealthy(stream *tunnel.Stream) {
	conn, err := net.DialTimeout("tcp", p.helloAddr, 2*time.Second)
	if err != nil {
		stream.WriteJSON(tunnel.BaseMessage{Type: tunnel.TypeError})
		stream.Close()
		return
	}
	if err := stream.WriteJSON(tunnel.BaseMessage{Type: tunnel.TypeRawProxy}); err != nil {
		conn.Close()
		stream.Close()
		return
	}
	go func() {
		io.Copy(conn, stream.Raw())
		conn.Close()
	}()
	io.Copy(stream.Raw(), conn)
	stream.Close()
}

func (p *s1Peer) close() {
	_ = p.mux.Close()
}

// waitS1Worker polls the controller registry until the peer is online.
func waitS1Worker(t *testing.T, d *server.Daemon, id string) *server.Worker {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if w, ok := d.Registry.GetWorker(id); ok {
			// Transport read under the registry lock (WorkerTransport) so
			// this poll cannot race with MarkWorkerOffline's Transport=nil.
			if tr, _ := d.Registry.WorkerTransport(id); tr != nil && !tr.IsClosed() {
				return w
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("worker %s never registered", id)
	return nil
}

// assertBoundedFail asserts a stalled fetch errored, was timeout-classified,
// and took approximately the bound (not fail-fast, not runaway).
func assertBoundedFail(t *testing.T, label string, err error, dur time.Duration, bound time.Duration) {
	t.Helper()
	if err == nil {
		t.Fatalf("%s: expected error, got success after %v", label, dur)
	}
	if !os.IsTimeout(err) {
		t.Fatalf("%s: want timeout-classified error, got %v", label, err)
	}
	if dur < time.Duration(float64(bound)*0.6) {
		t.Fatalf("%s: returned suspiciously fast (%v < 60%% of bound %v) — did it actually wait?", label, dur, bound)
	}
	if dur > bound*2+750*time.Millisecond {
		t.Fatalf("%s: exceeded bound (%v > %v + slop)", label, dur, bound)
	}
}

// s1Watchdog bounds how long any single deliberately-stalled fetch (or its
// result receive) may take before the subtest FAILS FAST (B2 rider from the
// S1 commit review, binding on this file): if the bounded-fetch containment
// ever regresses (deadline mechanism broken, stream never errors), the test
// must fail in seconds — not hang until the global go-test timeout. Comfortably
// above the asserted bound slop (s1Bound*2+750ms) so a slow-but-contained
// fetch never trips it.
const s1Watchdog = 8 * time.Second

// fetchWatched runs one fetch under the no-hang watchdog and fails the test
// fast if it neither returns nor is contained within s1Watchdog.
func fetchWatched(t *testing.T, fetch func(context.Context) ([]byte, error, time.Duration), ctx context.Context, label string) ([]byte, error, time.Duration) {
	t.Helper()
	type result struct {
		b   []byte
		err error
		dur time.Duration
	}
	done := make(chan result, 1)
	go func() {
		b, err, dur := fetch(ctx)
		done <- result{b, err, dur}
	}()
	select {
	case r := <-done:
		return r.b, r.err, r.dur
	case <-time.After(s1Watchdog):
		t.Fatalf("%s: fetch did not settle within %v watchdog — bounded-fetch containment regressed (B2)", label, s1Watchdog)
		return nil, nil, 0
	}
}

// watchdogErr runs fn (a single deliberately-stalled direct call) under the
// no-hang watchdog and fails the test fast if it does not settle, returning
// fn's error otherwise. Same B2 contract as fetchWatched, for call sites that
// don't go through the shared `fetch` closure.
func watchdogErr(t *testing.T, bound time.Duration, label string, fn func() error) error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- fn() }()
	select {
	case err := <-done:
		return err
	case <-time.After(bound):
		t.Fatalf("%s: call did not settle within %v watchdog — bounded-fetch containment regressed (B2)", label, bound)
		return nil
	}
}

// TestS1BoundedFetch_ContainmentThroughRealYamux drives the bounded-fetch
// helper against a private real controller daemon + a real-tunnel scripted
// adversarial peer. Phases run sequentially against one peer session; the
// backlog phase runs LAST because it saturates (then closes) the session.
func TestS1BoundedFetch_ContainmentThroughRealYamux(t *testing.T) {
	d := startS1Daemon(t)

	const helloBody = `{"hello":"s1","n":42}`
	hello := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, helloBody)
	}))
	defer hello.Close()

	peer := connectS1Peer(t, d, hello.Listener.Addr().String())
	defer peer.close()

	worker := waitS1Worker(t, d, s1PeerID)
	proxy := d.Proxy

	fetch := func(ctx context.Context) ([]byte, error, time.Duration) {
		start := time.Now()
		b, err := proxy.FetchWorkerJSONBounded(ctx, worker, "/hello.json", s1Bound, s1BodyCap)
		return b, err, time.Since(start)
	}

	t.Run("healthy_fetch_returns_exact_body", func(t *testing.T) {
		peer.hangNext.Store(0)
		peer.script.Store(s1ScriptHealthy)
		body, err, dur := fetch(context.Background())
		if err != nil {
			t.Fatalf("healthy fetch: %v (after %v)", err, dur)
		}
		if string(body) != helloBody {
			t.Fatalf("healthy fetch: body mismatch: got %q want %q", body, helloBody)
		}
		if dur > s1Bound {
			t.Fatalf("healthy fetch took %v > bound %v", dur, s1Bound)
		}
	})

	t.Run("never_ack_bounded_and_sibling_stream_survives", func(t *testing.T) {
		peer.script.Store(s1ScriptHealthy)
		peer.hangNext.Store(1)

		type result struct {
			err error
			dur time.Duration
		}
		done := make(chan result, 1)
		go func() {
			_, err, dur := fetch(context.Background())
			done <- result{err, dur}
		}()

		// Wait until the peer has actually accepted + read the hung stream,
		// so the sibling fetch provably shares the session with a live stall.
		select {
		case <-peer.hungSeen:
		case <-time.After(5 * time.Second):
			t.Fatalf("peer never observed the hung stream")
		}

		// Sibling fetch on the SAME tunnel while stream #1 is stalled. Under
		// the B2 watchdog: a regression that wedges sibling streams on a
		// stalled session must fail fast here, not hang the suite.
		sibBody, sibErr, sibDur := fetchWatched(t, fetch, context.Background(), "sibling fetch")
		if sibErr != nil {
			t.Fatalf("sibling fetch on same stalled tunnel failed: %v (after %v)", sibErr, sibDur)
		}
		if string(sibBody) != helloBody {
			t.Fatalf("sibling fetch: body mismatch: %q", sibBody)
		}

		// B2: the deliberately-stalled never-ack fetch must settle at its
		// bound — never park the subtest on a bare receive.
		var r result
		select {
		case r = <-done:
		case <-time.After(s1Watchdog):
			t.Fatalf("never-ack fetch did not settle within %v watchdog — bounded-fetch containment regressed (B2)", s1Watchdog)
		}
		assertBoundedFail(t, "never-ack fetch", r.err, r.dur, s1Bound)

		// And the tunnel is STILL usable after the contained failure.
		after, afterErr, _ := fetchWatched(t, fetch, context.Background(), "post-failure fetch")
		if afterErr != nil || string(after) != helloBody {
			t.Fatalf("post-failure fetch: err=%v body=%q", afterErr, after)
		}
	})

	t.Run("repeated_stalled_fetches_do_not_accumulate", func(t *testing.T) {
		peer.script.Store(s1ScriptHealthy)
		// Let background copy goroutines from earlier phases settle.
		time.Sleep(250 * time.Millisecond)
		g0 := runtime.NumGoroutine()
		for i := 0; i < 3; i++ {
			peer.hangNext.Store(1)
			_, err, dur := fetchWatched(t, fetch, context.Background(), fmt.Sprintf("stalled fetch #%d", i))
			if err == nil {
				t.Fatalf("stalled fetch #%d unexpectedly succeeded", i)
			}
			if dur > s1Bound*2+750*time.Millisecond {
				t.Fatalf("stalled fetch #%d exceeded bound: %v", i, dur)
			}
		}
		peer.hangNext.Store(0)
		if body, err, _ := fetchWatched(t, fetch, context.Background(), "post-stall healthy fetch"); err != nil || string(body) != helloBody {
			t.Fatalf("healthy fetch after repeated stalls: err=%v", err)
		}
		g1 := runtime.NumGoroutine()
		// A completed stalled fetch retains ZERO goroutines (deadline-driven,
		// no watcher); allow slop only for unrelated test-process noise.
		if g1-g0 > 8 {
			t.Fatalf("goroutines accumulated across 3 stalled fetches: before=%d after=%d", g0, g1)
		}
	})

	t.Run("stalled_response_head_bounded", func(t *testing.T) {
		peer.hangNext.Store(0)
		peer.script.Store(s1ScriptAckThenHang)
		_, err, dur := fetchWatched(t, fetch, context.Background(), "stalled head")
		assertBoundedFail(t, "stalled head", err, dur, s1Bound)
	})

	t.Run("stalled_body_bounded", func(t *testing.T) {
		peer.hangNext.Store(0)
		peer.script.Store(s1ScriptStallBody)
		_, err, dur := fetchWatched(t, fetch, context.Background(), "stalled body")
		assertBoundedFail(t, "stalled body", err, dur, s1Bound)
	})

	t.Run("oversize_body_rejected_cap_plus_one", func(t *testing.T) {
		peer.hangNext.Store(0)
		peer.script.Store(s1ScriptOversize)
		body, err, dur := fetch(context.Background())
		if err == nil {
			t.Fatalf("oversize body: expected cap error, got %d-byte success", len(body))
		}
		if !errors.Is(err, server.ErrFetchResponseBodyTooLarge) {
			t.Fatalf("oversize body: want ErrFetchResponseBodyTooLarge, got %v", err)
		}
		if dur > s1Bound*2+750*time.Millisecond {
			t.Fatalf("oversize body: detection took %v, beyond bound slop", dur)
		}
		// Cap-plus-one detection must reject, never silently truncate to a
		// cap-sized "success" — the error (not partial bytes) is the contract.
		if len(body) != 0 {
			t.Fatalf("oversize body: partial bytes returned alongside the error: %d", len(body))
		}
	})

	t.Run("non_2xx_reported_not_timeout", func(t *testing.T) {
		peer.hangNext.Store(0)
		peer.script.Store(s1ScriptHTTP500)
		_, err, dur := fetch(context.Background())
		if err == nil {
			t.Fatalf("HTTP 500: expected error")
		}
		if os.IsTimeout(err) {
			t.Fatalf("HTTP 500 misclassified as timeout: %v", err)
		}
		if !strings.Contains(err.Error(), "500") {
			t.Fatalf("HTTP 500 error should mention the status: %v", err)
		}
		if dur > s1Bound {
			t.Fatalf("HTTP 500 fetch took %v > bound %v", dur, s1Bound)
		}
	})

	// Backlog phase LAST: saturates and then closes the peer session.
	t.Run("stream_open_backlog_full_bounded", func(t *testing.T) {
		gBefore := runtime.NumGoroutine()

		// Quiesce the peer's accept loop so opened streams accumulate in the
		// remote accept backlog (yamux AcceptBacklog = 256). The loop is
		// parked inside AcceptStream when paused flips, so it observes the
		// pause only AFTER the next stream arrives — therefore the fillers
		// start first; the loop handles that ONE stream, then parks (its
		// pausedSeen signal), and the remaining 299 opens saturate the
		// backlog. The 257th-plus open parks inside OpenStream — the
		// measured yamux v0.1.2 fact this phase contains.
		peer.resumeCh = make(chan struct{})
		peer.paused.Store(true)

		fillDone := make(chan int, 1)
		// Snapshot the transport under the registry lock once (the filler
		// runs concurrently with the eventual session close → offline
		// transition, so it must not read the worker.Transport field).
		fillTr, ok := d.Registry.WorkerTransport(worker.ID)
		if !ok || fillTr == nil {
			t.Fatalf("filler: worker %s transport vanished", worker.ID)
		}
		go func() {
			n := 0
			for i := 0; i < 300; i++ {
				s, err := fillTr.OpenStream()
				if err != nil {
					break
				}
				n++
				_ = s
			}
			fillDone <- n
		}()
		select {
		case <-peer.pausedSeen:
		case <-time.After(5 * time.Second):
			t.Fatalf("peer accept loop never quiesced")
		}
		// Let the remaining real opens land and the filler park.
		time.Sleep(400 * time.Millisecond)
		select {
		case n := <-fillDone:
			t.Fatalf("filler finished early at %d opens — backlog never saturated", n)
		default:
		}

		// The bounded fetch must terminate at the CALLER's ctx bound even
		// though OpenStream itself would park (yamux v0.1.2 parks the opener
		// with a per-open timer goroutine — setOpenTimeout — until the
		// remote accepts, the session dies, or its ~10s
		// ConnectionWriteTimeout fires; none of which meets a fleet-status
		// per-worker budget).
		const openBound = 1200 * time.Millisecond
		ctx, cancel := context.WithTimeout(context.Background(), openBound)
		defer cancel()
		start := time.Now()
		err := watchdogErr(t, s1Watchdog, "backlog-full fetch", func() error {
			_, err := proxy.FetchWorkerJSONBounded(ctx, worker, "/hello.json", 5*time.Second, s1BodyCap)
			return err
		})
		dur := time.Since(start)
		if err == nil {
			t.Fatalf("backlog-full fetch: expected error, got success after %v", dur)
		}
		if !os.IsTimeout(err) {
			t.Fatalf("backlog-full fetch: want timeout-classified error, got %v", err)
		}
		if dur < time.Duration(float64(openBound)*0.6) {
			t.Fatalf("backlog-full fetch returned suspiciously fast: %v", dur)
		}
		if dur > openBound*2+750*time.Millisecond {
			t.Fatalf("backlog-full fetch exceeded bound: %v", dur)
		}

		// Residual accounting. The 256 filler opens each park a
		// yamux-INTERNAL timer goroutine (setOpenTimeout) — that is the
		// transport's own open-semaphore mechanics, NOT the helper's
		// residual, and it drains when the session closes (asserted below).
		// What MUST hold for the helper: a repeated bounded attempt in the
		// same saturated state does not accumulate — attempt #2 adds at most
		// its parked opener + janitor + the yamux open timer, i.e. a small
		// CONSTANT, not an unbounded per-attempt growth.
		gAfterFirst := runtime.NumGoroutine()
		ctx2, cancel2 := context.WithTimeout(context.Background(), openBound)
		err2 := watchdogErr(t, s1Watchdog, "backlog-full fetch #2", func() error {
			_, err := proxy.FetchWorkerJSONBounded(ctx2, worker, "/hello.json", 5*time.Second, s1BodyCap)
			return err
		})
		cancel2()
		if err2 == nil || !os.IsTimeout(err2) {
			t.Fatalf("backlog-full fetch #2: want timeout error, got %v", err2)
		}
		if g := runtime.NumGoroutine() - gAfterFirst; g > 4 {
			t.Fatalf("second saturated fetch added %d goroutines — per-attempt accumulation (want <= 4)", g)
		}

		// Close the session: every parked OpenStream resolves, janitors and
		// the filler all drain — the residual is bounded AND temporary.
		peer.close()
		close(peer.resumeCh) // unpark the quiesced accept loop; its AcceptStream then errors out
		select {
		case n := <-fillDone:
			if n != 256 {
				t.Logf("note: filler opened %d streams before parking (backlog=256)", n)
			}
		case <-time.After(5 * time.Second):
			t.Fatalf("parked OpenStream goroutines did not resolve after session close")
		}
		// Goroutines settle back to (near) the phase baseline. Window > 10s:
		// yamux's per-open setOpenTimeout timers fire at ConnectionWriteTimeout
		// (10s) even if they do not observe the shutdown directly; in the
		// common case (parked opens observe session death) settle is immediate.
		settleDeadline := time.Now().Add(12 * time.Second)
		for time.Now().Before(settleDeadline) {
			if runtime.NumGoroutine()-gBefore <= 4 {
				return
			}
			time.Sleep(250 * time.Millisecond)
		}
		t.Fatalf("goroutines did not settle after session close: +%d", runtime.NumGoroutine()-gBefore)
	})
}

// TestS1BoundedFetch_RealStackHappyPath drives the bounded-fetch helper
// through the SHARED cluster (TestMain): real controller daemon → real agent
// daemon (pkg/agent) → real worker web server (pkg/web) → back. This proves
// the helper speaks the actual production handshake end to end — the
// adversarial peer above covers failure containment; this covers production
// interop. Byte-equality with a direct worker fetch is NOT asserted: the
// worker's diag snapshot contains live counters that advance between the two
// fetches; instead the response must be valid JSON with the worker diag
// snapshot's stable top-level shape.
func TestS1BoundedFetch_RealStackHappyPath(t *testing.T) {
	w, ok := cluster.Daemon.Registry.GetWorker(cluster.WorkerID)
	if !ok {
		t.Fatalf("shared-cluster worker %s not registered", cluster.WorkerID)
	}
	// Transport read under the registry lock — same rationale as above.
	if tr, _ := cluster.Daemon.Registry.WorkerTransport(cluster.WorkerID); tr == nil || tr.IsClosed() {
		t.Fatalf("shared-cluster worker %s not online", cluster.WorkerID)
	}
	body, err := cluster.Daemon.Proxy.FetchWorkerJSONBounded(context.Background(), w, "/vh/diag/latency", 5*time.Second, 1<<20)
	if err != nil {
		t.Fatalf("real-stack bounded fetch: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(body, &m); err != nil {
		t.Fatalf("real-stack bounded fetch: body is not JSON: %v (body=%q)", err, body)
	}
	if _, ok := m["probes"]; !ok {
		t.Fatalf("real-stack bounded fetch: diag snapshot missing top-level \"probes\" key: %q", body)
	}
}
