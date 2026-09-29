package server

// status_stream_test.go — lane-1 co-located tests for GET /vh/fleet/stream
// (Slice 1 of tmp/agent-runs/android-push-20260928/stream-readstate-brief.md).
//
// The SSE surface is exercised through the REAL handler chain
// (buildRootHandler → auth → csrfGuard → hostInterceptor → userMux →
// handleFleetStream) over REAL HTTP servers (httptest.NewServer), because the
// stream's load-bearing behaviors need a real connection: finite write
// deadlines (a plain ResponseRecorder does not support SetWriteDeadline, and
// the handler honestly refuses to stream without them), incremental frame
// reads, and blocked-writer termination. Every read is watchdog-bounded so a
// broken stream fails the test instead of hanging the suite.
//
// The lane-3 companion (tests/e2e/fleet_stream_e2e_test.go) proves the route
// through the real controller/tunnel stack; this file pins the protocol and
// the service invariants (coalescing, demand loop, cap, failure postures).

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/auth"
	"github.com/vhqtvn/vh-solara/pkg/state"
	"github.com/vhqtvn/vh-solara/pkg/tunnel"

	"github.com/hashicorp/yamux"
)

// ---------------------------------------------------------------------------
// Scaffolding: SSE test client (watchdog-bounded) + knob helper
// ---------------------------------------------------------------------------

// sseClient is one watchdog-bounded stream reader over a real HTTP
// connection. frames carries complete SSE blocks (split on blank lines);
// done closes when the server ends the stream (EOF/error).
type sseClient struct {
	resp   *http.Response
	frames chan string
	cancel context.CancelFunc
	done   chan struct{}
}

// splitSSE tokenizes an SSE byte stream into frame blocks terminated by a
// blank line ("\n\n").
func splitSSE(data []byte, atEOF bool) (advance int, token []byte, err error) {
	if atEOF && len(data) == 0 {
		return 0, nil, nil
	}
	if i := bytes.Index(data, []byte("\n\n")); i >= 0 {
		return i + 2, data[:i], nil
	}
	if atEOF {
		return len(data), data, nil
	}
	return 0, nil, nil
}

// parseSSEFrame extracts the event name and data payload from one block.
func parseSSEFrame(t *testing.T, block string) (event, data string) {
	t.Helper()
	for _, ln := range strings.Split(block, "\n") {
		if e, ok := strings.CutPrefix(ln, "event: "); ok {
			event = e
		}
		if d, ok := strings.CutPrefix(ln, "data: "); ok {
			data = d
		}
	}
	return event, data
}

// openStream connects one stream client to srvURL and pumps complete SSE
// blocks onto a channel. Cleanup cancels the request and joins the reader so
// no test can leak a blocked handler past its scope.
func openStream(t *testing.T, srvURL string, hdr map[string]string) *sseClient {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srvURL+"/vh/fleet/stream", nil)
	if err != nil {
		cancel()
		t.Fatalf("stream request: %v", err)
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatalf("stream connect: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		resp.Body.Close()
		cancel()
		t.Fatalf("stream connect: want 200, got %d", resp.StatusCode)
	}
	c := &sseClient{
		resp:   resp,
		frames: make(chan string, 128),
		cancel: cancel,
		done:   make(chan struct{}),
	}
	go func() {
		defer close(c.done)
		defer resp.Body.Close()
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
		sc.Split(splitSSE)
		for sc.Scan() {
			if sc.Text() == "" {
				continue
			}
			select {
			case c.frames <- sc.Text():
			case <-ctx.Done():
				return
			}
		}
	}()
	t.Cleanup(func() {
		c.cancel()
		<-c.done
	})
	return c
}

// next waits for one frame block with a hard watchdog (never hangs the
// suite on a broken stream).
func (c *sseClient) next(t *testing.T, what string, timeout time.Duration) string {
	t.Helper()
	select {
	case b := <-c.frames:
		return b
	case <-c.done:
		t.Fatalf("stream ended while waiting for %s", what)
	case <-time.After(timeout):
		t.Fatalf("timed out (%s) waiting for %s", timeout, what)
	}
	return ""
}

// nextOrEnd waits for one frame block or stream end (ok=false). Never
// blocks longer than timeout.
func (c *sseClient) nextOrEnd(timeout time.Duration) (string, bool) {
	select {
	case b := <-c.frames:
		return b, true
	case <-c.done:
		return "", false
	case <-time.After(timeout):
		return "", true // still open, nothing arrived within the window
	}
}

// drainAndClose cancels the client and returns every buffered frame.
func (c *sseClient) drainAndClose() []string {
	c.cancel()
	<-c.done
	var out []string
	for {
		select {
		case b := <-c.frames:
			out = append(out, b)
		default:
			return out
		}
	}
}

// tryStream performs one connect and returns the response WITHOUT a frame
// reader (for non-200 postures and for the never-reading blocked-writer
// client). The body is fully read and closed unless keepBody.
func tryStream(t *testing.T, srvURL string, keepBody bool) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, srvURL+"/vh/fleet/stream", nil)
	if err != nil {
		t.Fatalf("stream request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("stream connect: %v", err)
	}
	if !keepBody {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Logf("tryStream: %d %s", resp.StatusCode, string(b))
		resp.Body = io.NopCloser(strings.NewReader(string(b)))
	}
	if keepBody {
		t.Cleanup(func() { resp.Body.Close() })
	}
	return resp
}

// setStreamKnobs retightens the service's stream cadences under the service
// mutex (fields are read under the same lock by the handler and the demand
// loop, so live changes race-free).
func setStreamKnobs(svc *fleetStatusService, heartbeat, demand, writeBudget time.Duration, maxSubs int) {
	svc.mu.Lock()
	defer svc.mu.Unlock()
	if heartbeat != 0 {
		svc.streamHeartbeat = heartbeat
	}
	if demand != 0 {
		svc.streamDemandInterval = demand
	}
	if writeBudget != 0 {
		svc.streamWriteBudget = writeBudget
	}
	if maxSubs != 0 {
		svc.streamMaxSubs = maxSubs
	}
}

// newStreamServer stands up the real HTTP server for the handler chain.
func newStreamServer(t *testing.T, h http.Handler) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	return srv
}

// seedQuietFleet registers one online worker whose acquisition answers two
// scripted bodies (discovery + empty snapshot) — the minimal healthy fleet.
func seedQuietFleet(t *testing.T, d *Daemon, fake *fleetFake) {
	t.Helper()
	fleetAddOnline(t, d.Registry, "w1")
	fake.setBody("w1", "/vh/projects", fleetProjectsBody(""))
	fake.setBody("w1", "/vh/snapshot?z=1", fleetSnapBody(map[string]state.GateFacts{}))
}

// quietStreamKnobs silences heartbeat and demand (hour-scale) so a test
// observes only the frames it deliberately triggers.
func quietStreamKnobs(svc *fleetStatusService) {
	setStreamKnobs(svc, time.Hour, time.Hour, 0, 0)
}

// ---------------------------------------------------------------------------
// 1. Bootstrap: exact body, headers, retry hint
// ---------------------------------------------------------------------------

// TestFleetStream_BootstrapExactBodyHeadersRetry pins the wire contract of
// the stream's start: SSE headers (event-stream, no-cache/no-transform,
// X-Accel-Buffering off, NO ETag on the held response), the `retry: 2000`
// reconnect hint, and a bootstrap `fleet.status` frame whose data is the
// EXACT published rollup body a plain GET serves (byte-for-byte, same
// generation) with no `id:` line.
func TestFleetStream_BootstrapExactBodyHeadersRetry(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	seedQuietFleet(t, d, fake)
	svc := d.fleetStatusService()
	svc.budgets.TTL = time.Minute // one quiet generation
	quietStreamKnobs(svc)
	h := d.buildRootHandler()
	srv := newStreamServer(t, h)

	rec := doFleet(h)
	if rec.Code != http.StatusOK {
		t.Fatalf("reference GET: want 200, got %d", rec.Code)
	}
	body0 := rec.Body.String()

	c := openStream(t, srv.URL, nil)
	if ct := c.resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("Content-Type: want text/event-stream, got %q", ct)
	}
	if cc := c.resp.Header.Get("Cache-Control"); cc != "private, no-cache, no-transform" {
		t.Fatalf("Cache-Control: want private, no-cache, no-transform, got %q", cc)
	}
	if xa := c.resp.Header.Get("X-Accel-Buffering"); xa != "no" {
		t.Fatalf("X-Accel-Buffering: want no, got %q", xa)
	}
	if e := c.resp.Header.Get("ETag"); e != "" {
		t.Fatalf("held stream response must not carry an ETag, got %q", e)
	}
	if b := c.next(t, "retry preamble", 3*time.Second); b != "retry: 2000" {
		t.Fatalf("first block: want %q, got %q", "retry: 2000", b)
	}
	block := c.next(t, "bootstrap frame", 3*time.Second)
	if strings.Contains(block, "\nid: ") || strings.HasPrefix(block, "id: ") {
		t.Fatalf("stream frames must carry no id: line, got %q", block)
	}
	event, data := parseSSEFrame(t, block)
	if event != "fleet.status" {
		t.Fatalf("bootstrap event: want fleet.status, got %q", event)
	}
	if data != body0 {
		t.Fatalf("bootstrap data must equal the GET body byte-for-byte:\n got %s\nwant %s", data, body0)
	}

	// The plain GET's conditional semantics are untouched by the stream
	// being open: If-None-Match within the same generation still 304s.
	rec2 := doFleet(h, withINM(rec.Header().Get("ETag")))
	if rec2.Code != http.StatusNotModified {
		t.Fatalf("GET If-None-Match with stream open: want 304, got %d", rec2.Code)
	}
}

// ---------------------------------------------------------------------------
// 1b. Bootstrap after a slow acquisition: the write budget must not go stale
// ---------------------------------------------------------------------------

// flushOnFirstWriteRW forwards the handler's first body write and then
// flushes the REAL response — the SSE-chain shape where the committed
// headers/preamble reach the socket immediately instead of sitting in
// net/http's response buffering (the 2 KB response bufio + 4 KB conn bufio
// that would otherwise swallow a 13-byte `retry:` preamble). It exists for
// the same reason smallSndBufListener does (section 9): to exercise the
// handler's REAL socket write discipline, not the buffer's luck. Unwrap lets
// http.NewResponseController reach the real connection's deadlines (the same
// pattern the scs session wrapper uses).
type flushOnFirstWriteRW struct {
	http.ResponseWriter
	flushed bool
}

func (w *flushOnFirstWriteRW) Unwrap() http.ResponseWriter { return w.ResponseWriter }

func (w *flushOnFirstWriteRW) Write(p []byte) (int, error) {
	n, err := w.ResponseWriter.Write(p)
	if !w.flushed {
		w.flushed = true
		if ferr := http.NewResponseController(w.ResponseWriter).Flush(); ferr != nil {
			return n, ferr
		}
	}
	return n, err
}

// TestFleetStream_SlowAcquisitionBootstrapKeepsWriteBudget pins the B-F1
// regression (cascade ses_f150267e7ffeSAAIyD4DqOwMXZ): the admission-time
// write deadline is a CONNECTION-SUPPORT PROBE only — the bootstrap serve()
// may legitimately take up to RefreshBudget*2+1s (31s default), far longer
// than the write budget. When the acquisition seam completes SUCCESSFULLY
// after more than the write budget (here ~800ms of scripted fetch delay vs
// a tightened 100ms knob, far inside the 15s refresh budget), the committed
// stream must still open with a FULL write budget: the client receives both
// the retry preamble and the full fleet.status bootstrap frame
// (docs/guides/controller-live-state.md § "Latest-state semantics": the
// FIRST fleet.status frame is unconditional). Pre-fix, the post-commit
// preamble write ran under the long-expired admission deadline: its flush
// failed and the stuck conn bufio lost the whole bootstrap.
func TestFleetStream_SlowAcquisitionBootstrapKeepsWriteBudget(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	seedQuietFleet(t, d, fake)
	// Slow-but-SUCCESSFUL acquisition: every worker fetch stalls 400ms —
	// 4x the tightened write budget per fetch, comfortably inside the
	// refresh budget, so the bootstrap serve() settles with a valid
	// generation.
	base := fake.fetch
	d.fetchWorkerJSON = func(ctx context.Context, workerID, path string, timeout time.Duration, maxBodyBytes int64) ([]byte, error) {
		time.Sleep(400 * time.Millisecond)
		return base(ctx, workerID, path, timeout, maxBodyBytes)
	}
	svc := d.fleetStatusService()
	svc.budgets.TTL = time.Minute // post-bootstrap quiet: only the asserted frames flow
	setStreamKnobs(svc, time.Hour, time.Hour, 100*time.Millisecond, 0)
	srv := newStreamServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		d.buildRootHandler().ServeHTTP(&flushOnFirstWriteRW{ResponseWriter: w}, r)
	}))

	c := openStream(t, srv.URL, nil)
	if b := c.next(t, "retry preamble", 5*time.Second); b != "retry: 2000" {
		t.Fatalf("first block: want %q, got %q", "retry: 2000", b)
	}
	event, data := parseSSEFrame(t, c.next(t, "bootstrap frame", 5*time.Second))
	if event != "fleet.status" {
		t.Fatalf("bootstrap event: want fleet.status, got %q", event)
	}
	var resp fleetStatusResponse
	if err := json.Unmarshal([]byte(data), &resp); err != nil || resp.Schema != 1 {
		t.Fatalf("bootstrap after slow acquisition is not a valid rollup: %v (%s)", err, data)
	}
}

// TestFleetStream_SlowFailingBootstrapErrorKeepsWriteBudget pins the B-F1′
// regression (cascade ses_f14e4e6f2ffeP1lzXXbzR1OjZS): the bootstrap
// serve()'s ERROR branch also answers AFTER the wait. A slow FAILING
// acquisition — churn exhausts serve()'s bounded loop while every fetch is
// stalled 400ms (4x the tightened 100ms write budget per fetch; the ~2.5s
// failure stays far inside the refresh budget, so it is the loop's churn
// exhaust, not a waiter timeout, that produces the error) — reaches the
// pre-header 503 with the admission probe's deadline long expired. Like the
// committed stream, that 503 must run under a re-armed budget: on a REAL
// flushed connection the client receives the documented plain-text 503 with
// the failure reason — NOT the transport EOF of a write dropped on the
// expired probe deadline (the pre-fix behavior this test was red against).
func TestFleetStream_SlowFailingBootstrapErrorKeepsWriteBudget(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	seedQuietFleet(t, d, fake)
	// Slow-FAILING acquisition: churn from the first fetch, with every
	// fetch stalled 400ms first — serve()'s bounded loop exhausts after
	// three churn-invalidated refreshes (~2.5s), far past the 100ms probe
	// deadline yet far inside the refresh budget.
	tc := newChurnFetcher(t, d, fake)
	base := tc.fetch
	d.fetchWorkerJSON = func(ctx context.Context, workerID, path string, timeout time.Duration, maxBodyBytes int64) ([]byte, error) {
		time.Sleep(400 * time.Millisecond)
		return base(ctx, workerID, path, timeout, maxBodyBytes)
	}
	tc.enable()
	svc := d.fleetStatusService()
	svc.mu.Lock()
	svc.budgets.TTL = time.Minute
	svc.mu.Unlock()
	setStreamKnobs(svc, time.Hour, time.Hour, 100*time.Millisecond, 0)
	srv := newStreamServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		d.buildRootHandler().ServeHTTP(&flushOnFirstWriteRW{ResponseWriter: w}, r)
	}))

	// One watchdog-bounded request (the failure takes ~2.5s; nothing may
	// hang the suite). Pre-fix the flushed 503 write fails on the expired
	// probe deadline and this Do returns a transport error (EOF); post-fix
	// it must deliver the documented 503 with the failure reason.
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/vh/fleet/stream", nil)
	if err != nil {
		t.Fatalf("stream request: %v", err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("slow-failing bootstrap: client got a transport error (EOF) instead of the documented 503: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("slow-failing bootstrap: want 503, got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("slow-failing bootstrap refusal must be plain text, got %q", ct)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("reading 503 body: %v", err)
	}
	if !strings.Contains(string(body), "fleet status unavailable:") {
		t.Fatalf("503 body must carry the failure reason, got %q", string(body))
	}
}

// ---------------------------------------------------------------------------
// 2. Heartbeat: named ping on a quiet stream
// ---------------------------------------------------------------------------

// TestFleetStream_PingHeartbeat pins the keepalive shape: on a stream with
// no generation churn, a named `ping` event with data {} arrives at the
// (tightened) heartbeat cadence — and pings never masquerade as
// fleet.status frames.
func TestFleetStream_PingHeartbeat(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	seedQuietFleet(t, d, fake)
	svc := d.fleetStatusService()
	svc.budgets.TTL = time.Minute // no demand/TTL churn: only pings flow
	setStreamKnobs(svc, 40*time.Millisecond, time.Hour, 0, 0)
	srv := newStreamServer(t, d.buildRootHandler())

	c := openStream(t, srv.URL, nil)
	c.next(t, "retry preamble", 3*time.Second)
	c.next(t, "bootstrap frame", 3*time.Second)

	pings := 0
	deadline := time.Now().Add(400 * time.Millisecond)
	for time.Now().Before(deadline) {
		block, ok := c.nextOrEnd(60 * time.Millisecond)
		if !ok {
			t.Fatal("stream ended during heartbeat window")
		}
		if block == "" {
			continue // quiet slice of the cadence
		}
		event, data := parseSSEFrame(t, block)
		if event == "ping" {
			if data != "{}" {
				t.Fatalf("ping data: want {}, got %q", data)
			}
			pings++
		} else {
			t.Fatalf("quiet stream must emit only pings, got event %q (%q)", event, data)
		}
	}
	if pings < 2 {
		t.Fatalf("want >=2 pings in 400ms at 40ms cadence, got %d", pings)
	}
}

// ---------------------------------------------------------------------------
// 3. Auth (session-cookie family), method semantics, HEAD
// ---------------------------------------------------------------------------

// TestFleetStream_AuthMethodAndHeadFamily pins the security posture on the
// real chain shape (recorder is sufficient for everything the HANDLER never
// streams): unauthenticated GETs get auth's clean 401 (never a redirect),
// POST is 405 with or without X-VH-CSRF (GET-only route outside csrfGuard's
// /api/ scope), an authenticated GET needs no CSRF header (it reaches the
// handler — which then honestly refuses to stream through a recorder, since
// a recorder enforces no write deadlines), and HEAD answers headers-only
// without consuming a subscriber slot.
func TestFleetStream_AuthMethodAndHeadFamily(t *testing.T) {
	d, _ := newFleetTestDaemon(t, "")
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a
	h := d.buildRootHandler()
	session := loginPassphrase(t, h, "secret")

	// 1. Unauthenticated API-shaped GET → clean 401.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/fleet/stream", nil)
	req.Header.Set("Accept", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated API GET: want 401, got %d", rec.Code)
	}
	// 2. Unauthenticated browser-shaped GET → 401, no redirect.
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/vh/fleet/stream", nil))
	if rec2.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated browser GET: want 401, got %d (Location %q)", rec2.Code, rec2.Header().Get("Location"))
	}
	if loc := rec2.Header().Get("Location"); loc != "" {
		t.Fatalf("unauthenticated GET must not redirect, got Location %q", loc)
	}

	// 3. Authenticated GET (no X-VH-CSRF — read-only needs none) reaches
	// the handler. A recorder cannot enforce write deadlines, so the
	// handler's honest pre-headers refusal fires — proving both CSRF
	// exemption and the fail-closed deadline posture.
	rec3 := httptest.NewRecorder()
	req3 := httptest.NewRequest(http.MethodGet, "/vh/fleet/stream", nil)
	req3.AddCookie(session)
	h.ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusServiceUnavailable || !strings.Contains(rec3.Body.String(), "write deadlines unsupported") {
		t.Fatalf("authenticated GET via recorder: want 503 naming unsupported write deadlines, got %d %q", rec3.Code, rec3.Body.String())
	}
	if got := d.fleetStatusService().streamSubscriberCount(); got != 0 {
		t.Fatalf("refused stream must not hold a subscriber slot, held %d", got)
	}

	// 4. POST is 405 (GET-only pattern), CSRF header irrelevant.
	for _, withCSRF := range []bool{false, true} {
		recp := httptest.NewRecorder()
		reqp := httptest.NewRequest(http.MethodPost, "/vh/fleet/stream", nil)
		reqp.AddCookie(session)
		if withCSRF {
			reqp.Header.Set("X-VH-CSRF", "1")
		}
		h.ServeHTTP(recp, reqp)
		if recp.Code != http.StatusMethodNotAllowed {
			t.Fatalf("POST (csrf=%v): want 405, got %d", withCSRF, recp.Code)
		}
	}

	// 5. HEAD rides the GET pattern: SSE headers, empty body, no slot.
	rech := httptest.NewRecorder()
	reqh := httptest.NewRequest(http.MethodHead, "/vh/fleet/stream", nil)
	reqh.AddCookie(session)
	h.ServeHTTP(rech, reqh)
	if rech.Code != http.StatusOK {
		t.Fatalf("HEAD: want 200, got %d", rech.Code)
	}
	if ct := rech.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("HEAD Content-Type: want text/event-stream, got %q", ct)
	}
	if rech.Body.Len() != 0 {
		t.Fatalf("HEAD must carry no body, got %q", rech.Body.String())
	}
	if got := d.fleetStatusService().streamSubscriberCount(); got != 0 {
		t.Fatalf("HEAD must not hold a subscriber slot, held %d", got)
	}
}

// ---------------------------------------------------------------------------
// 4. Reconnect: resnapshot, Last-Event-ID ignored
// ---------------------------------------------------------------------------

// TestFleetStream_ReconnectResnapshotIgnoresLastEventID pins the no-replay
// contract: a client presenting Last-Event-ID gets the same unconditional
// validated bootstrap snapshot as a fresh client, and a reconnect after a
// generation change receives the CURRENT generation — never a replay of the
// pre-disconnect one.
func TestFleetStream_ReconnectResnapshotIgnoresLastEventID(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	seedQuietFleet(t, d, fake)
	svc := d.fleetStatusService()
	svc.budgets.TTL = time.Minute
	quietStreamKnobs(svc)
	h := d.buildRootHandler()
	srv := newStreamServer(t, h)

	body1 := doFleet(h).Body.String()

	// First connection carries a bogus Last-Event-ID: ignored, full
	// snapshot served.
	c1 := openStream(t, srv.URL, map[string]string{"Last-Event-ID": "9999"})
	c1.next(t, "retry preamble", 3*time.Second)
	_, data1 := parseSSEFrame(t, c1.next(t, "bootstrap frame", 3*time.Second))
	if data1 != body1 {
		t.Fatalf("bootstrap with Last-Event-ID: want current snapshot, got %s", data1)
	}
	c1.drainAndClose()

	// Change the fleet and force the next generation: the reconnect must
	// serve the NEW current body, not the pre-disconnect generation.
	fake.setBody("w1", "/vh/snapshot?z=1", fleetSnapBody(map[string]state.GateFacts{
		"s1": fleetGF("idle", true, false), // permission pending appears
	}))
	expireFleetCache(d)
	body2 := doFleet(h).Body.String()
	if body2 == body1 {
		t.Fatal("setup: the changed fleet must produce a different rollup body")
	}

	c2 := openStream(t, srv.URL, map[string]string{"Last-Event-ID": "9999"})
	c2.next(t, "retry preamble", 3*time.Second)
	_, data2 := parseSSEFrame(t, c2.next(t, "bootstrap frame", 3*time.Second))
	if data2 != body2 {
		t.Fatalf("reconnect bootstrap: want the CURRENT generation body, got %s (want %s)", data2, body2)
	}
}

// ---------------------------------------------------------------------------
// 5. Coalescing + convergence
// ---------------------------------------------------------------------------

// TestFleetStream_CoalescingWakeCapacity is the deterministic white-box
// coalescing proof: a subscriber that never drains receives EXACTLY ONE
// pending wake across a burst of 25 publications — capacity-one wakeups, so
// a slow client reconciles to the newest state instead of queueing a
// backlog.
func TestFleetStream_CoalescingWakeCapacity(t *testing.T) {
	d, _ := newFleetTestDaemon(t, "")
	svc := d.fleetStatusService()
	sub, ok := svc.subscribeStream()
	if !ok {
		t.Fatal("subscribe failed on an empty service")
	}
	defer svc.unsubscribeStream(sub)
	for i := 0; i < 25; i++ {
		svc.publishFallback(0, 0) // stamps irrelevant: only the wake matters
	}
	if n := len(sub.wake); n != 1 {
		t.Fatalf("burst of 25 publications must coalesce to ONE pending wake, channel holds %d", n)
	}
}

// TestFleetStream_ConvergenceUnderChurn pins the A2 reconciliation
// guarantee over real clients: while generations churn, every subscriber —
// including one that reads slowly — converges to the newest published state
// (here: a distinctive final fallback generation), and no subscriber is
// left behind when the churn stops.
func TestFleetStream_ConvergenceUnderChurn(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	seedQuietFleet(t, d, fake)
	svc := d.fleetStatusService()
	svc.mu.Lock()
	svc.budgets.TTL = 5 * time.Millisecond
	svc.mu.Unlock()
	// Heartbeat quiet from the start: convergence is WAKE-driven (the
	// final publication), and a running handler keeps its entry-time
	// heartbeat cadence — a short one here would spray pings into the
	// post-convergence quiet window.
	setStreamKnobs(svc, time.Hour, 15*time.Millisecond, 0, 0)
	srv := newStreamServer(t, d.buildRootHandler())

	clients := make([]*sseClient, 3)
	for i := range clients {
		clients[i] = openStream(t, srv.URL, nil)
		clients[i].next(t, "retry preamble", 3*time.Second)
		clients[i].next(t, fmt.Sprintf("client %d bootstrap", i), 3*time.Second)
	}

	// Churn window: demand ticks publish a stream of generations.
	time.Sleep(300 * time.Millisecond)

	// Quiesce the churn (one armed tick may still land — give it room),
	// then publish ONE distinctive final generation with CURRENT stamps so
	// every client's next serve accepts it.
	svc.mu.Lock()
	svc.budgets.TTL = time.Minute
	svc.mu.Unlock()
	setStreamKnobs(svc, time.Hour, time.Hour, 0, 0)
	time.Sleep(100 * time.Millisecond) // any in-flight/armed demand tick lands here
	svc.publishFallback(d.Registry.Generation(), d.statusCfg.generation())

	wantGen, err := svc.serve(context.Background())
	if err != nil {
		t.Fatalf("final generation serve: %v", err)
	}
	if !strings.Contains(string(wantGen.body), `"overall":"unknown"`) {
		t.Fatalf("setup: final fallback body must be distinctive (overall unknown), got %s", wantGen.body)
	}

	for i, c := range clients {
		conv := false
		deadline := time.Now().Add(3 * time.Second)
		for time.Now().Before(deadline) {
			block, ok := c.nextOrEnd(100 * time.Millisecond)
			if !ok {
				t.Fatalf("client %d: stream ended before convergence", i)
			}
			if block == "" {
				continue
			}
			event, data := parseSSEFrame(t, block)
			if event != "fleet.status" {
				continue
			}
			if data == string(wantGen.body) {
				conv = true
				break
			}
		}
		if !conv {
			t.Fatalf("client %d never converged to the final generation", i)
		}
		// Quiet: nothing further flows (no demand, no heartbeat).
		if block, ok := c.nextOrEnd(250 * time.Millisecond); ok && block != "" {
			event, _ := parseSSEFrame(t, block)
			t.Fatalf("client %d received %q after the final generation (churn not quiesced?)", i, event)
		}
	}
}

// ---------------------------------------------------------------------------
// 6. Subscriber cap: admission before headers, release on close
// ---------------------------------------------------------------------------

// TestFleetStream_CapAdmissionAndRelease pins the daemon-wide cap: the
// first two subscribers (cap tightened to 2) hold slots including their
// bootstraps, a third is refused BEFORE headers with a plain 503 +
// Retry-After, and releasing one slot admits the next client.
func TestFleetStream_CapAdmissionAndRelease(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	seedQuietFleet(t, d, fake)
	svc := d.fleetStatusService()
	svc.budgets.TTL = time.Minute
	setStreamKnobs(svc, time.Hour, time.Hour, 0, 2)
	srv := newStreamServer(t, d.buildRootHandler())

	c1 := openStream(t, srv.URL, nil)
	c1.next(t, "c1 bootstrap", 3*time.Second)
	c2 := openStream(t, srv.URL, nil)
	c2.next(t, "c2 bootstrap", 3*time.Second)

	resp := tryStream(t, srv.URL, false)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("over-cap connect: want 503, got %d", resp.StatusCode)
	}
	if ra := resp.Header.Get("Retry-After"); ra != "5" {
		t.Fatalf("over-cap connect: want Retry-After 5, got %q", ra)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("over-cap refusal must be plain text, got %q", ct)
	}

	c1.drainAndClose()
	if !waitForNotify(2*time.Second, func() bool { return svc.streamSubscriberCount() == 1 }) {
		t.Fatalf("released slot not observed (subs=%d)", svc.streamSubscriberCount())
	}

	c3 := openStream(t, srv.URL, nil) // must NOT fatalf: admission succeeds
	c3.next(t, "c3 bootstrap after release", 3*time.Second)
}

// ---------------------------------------------------------------------------
// 7. Demand refresh loop: runs without pollers or notifications, stops at zero
// ---------------------------------------------------------------------------

// TestFleetStream_DemandLoopLifecycleNoPoller pins THE reason the demand
// loop exists: with notifications entirely unconfigured (the notify watcher
// refuses to start) and ZERO HTTP requests to GET /vh/fleet/status (a
// counting middleware proves it), an open stream keeps the rollup
// refreshing on its own and keeps delivering full snapshots; when the last
// subscriber leaves, the loop stops and refreshes freeze.
func TestFleetStream_DemandLoopLifecycleNoPoller(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	seedQuietFleet(t, d, fake)
	// The notify watcher must refuse to start in this posture (no store, no
	// transport) — the premise behind the stream's own demand driver.
	if d.StartNotifyWatcher() {
		t.Fatal("watcher started without store+transport — premise broken")
	}
	svc := d.fleetStatusService()
	svc.mu.Lock()
	svc.budgets.TTL = 5 * time.Millisecond
	svc.mu.Unlock()
	setStreamKnobs(svc, time.Hour, 25*time.Millisecond, 0, 0)

	var statusHits int32
	inner := d.buildRootHandler()
	wrapped := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/vh/fleet/status" {
			atomic.AddInt32(&statusHits, 1)
		}
		inner.ServeHTTP(w, r)
	})
	srv := newStreamServer(t, wrapped)

	if svc.streamDemandActive() {
		t.Fatal("demand loop must not run before any subscriber")
	}
	r0 := svc.refreshCount()
	c := openStream(t, srv.URL, nil)
	c.next(t, "retry preamble", 3*time.Second)
	c.next(t, "bootstrap frame", 3*time.Second)

	if !waitForNotify(3*time.Second, func() bool { return svc.refreshCount() >= r0+4 }) {
		t.Fatalf("demand loop never refreshed (refreshes=%d)", svc.refreshCount()-r0)
	}
	if !svc.streamDemandActive() {
		t.Fatal("demand loop must run while a subscriber exists")
	}
	frames := 0
	deadline := time.Now().Add(400 * time.Millisecond)
	for time.Now().Before(deadline) {
		block, ok := c.nextOrEnd(50 * time.Millisecond)
		if !ok {
			t.Fatal("stream ended during demand window")
		}
		if block == "" {
			continue
		}
		if event, _ := parseSSEFrame(t, block); event == "fleet.status" {
			frames++
		}
	}
	if frames < 3 {
		t.Fatalf("demand-driven stream delivered only %d snapshots in 400ms (want >=3)", frames)
	}

	c.drainAndClose()
	if !waitForNotify(2*time.Second, func() bool { return !svc.streamDemandActive() && svc.streamSubscriberCount() == 0 }) {
		t.Fatalf("demand loop did not stop at zero subscribers (active=%v subs=%d)",
			svc.streamDemandActive(), svc.streamSubscriberCount())
	}
	r1 := svc.refreshCount()
	time.Sleep(200 * time.Millisecond)
	if got := svc.refreshCount(); got != r1 {
		t.Fatalf("refreshes continued after the last subscriber left: %d -> %d", r1, got)
	}
	if n := atomic.LoadInt32(&statusHits); n != 0 {
		t.Fatalf("GET /vh/fleet/status was hit %d times — the stream must refresh without any poller", n)
	}
}

// ---------------------------------------------------------------------------
// 8. Demand ticks share the GET single-flight
// ---------------------------------------------------------------------------

// TestFleetStream_DemandAndGetsSingleFlight pins that the demand loop rides
// the EXISTING single-flight refresh: a burst of concurrent GETs during
// slow acquisitions coalesces with the demand ticks into a bounded number
// of refreshes (uncoalesced, 6 GETs + ~12 ticks would each refresh).
func TestFleetStream_DemandAndGetsSingleFlight(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	seedQuietFleet(t, d, fake)
	var mu sync.Mutex
	base := fake.fetch
	d.fetchWorkerJSON = func(ctx context.Context, workerID, path string, timeout time.Duration, maxBodyBytes int64) ([]byte, error) {
		time.Sleep(120 * time.Millisecond) // slow acquisition window: ticks + GETs pile up
		mu.Lock()
		defer mu.Unlock()
		return base(ctx, workerID, path, timeout, maxBodyBytes)
	}
	svc := d.fleetStatusService()
	svc.mu.Lock()
	svc.budgets.TTL = 5 * time.Millisecond
	svc.mu.Unlock()
	setStreamKnobs(svc, time.Hour, 40*time.Millisecond, 0, 0)
	h := d.buildRootHandler()
	srv := newStreamServer(t, h)

	c := openStream(t, srv.URL, nil) // bootstrap performs the first slow refresh
	c.next(t, "retry preamble", 5*time.Second)
	c.next(t, "bootstrap frame", 5*time.Second)

	r0 := svc.refreshCount()
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rec := doFleet(h)
			if rec.Code != http.StatusOK {
				t.Errorf("concurrent GET: want 200, got %d", rec.Code)
			}
		}()
	}
	wg.Wait()
	time.Sleep(500 * time.Millisecond)
	delta := svc.refreshCount() - r0
	// Serial 120ms refreshes bound the window to ~6 back-to-back; without
	// coalescing the 6 GETs + demand ticks would each add one.
	if delta > 8 {
		t.Fatalf("refreshes not coalesced across GETs + demand ticks: %d refreshes in the window", delta)
	}
	if delta < 1 {
		t.Fatalf("no refresh happened in the window (demand loop dead?)")
	}
}

// ---------------------------------------------------------------------------
// 9. Finite write deadlines: a stalled writer is closed
// ---------------------------------------------------------------------------

// smallSndBufListener shrinks the server-side socket send buffer so a
// never-reading client fills the TCP window quickly — the honest way to
// make a REAL handler write actually block in a test.
type smallSndBufListener struct{ net.Listener }

func (l smallSndBufListener) Accept() (net.Conn, error) {
	c, err := l.Listener.Accept()
	if err == nil {
		if sb, ok := c.(interface{ SetWriteBuffer(int) error }); ok {
			_ = sb.SetWriteBuffer(4096)
		}
	}
	return c, err
}

// TestFleetStream_BlockedWriterClosed pins the finite-write bound: a client
// that stops reading while the stream keeps producing frames must get its
// connection CLOSED by the write deadline (slot released, demand loop
// stopped) rather than an unbounded server-side buffer.
func TestFleetStream_BlockedWriterClosed(t *testing.T) {
	d, _ := newFleetTestDaemon(t, "")
	// Offline-only fleet: every refresh publishes fast (worker_down rows)
	// without any acquisition, maximizing frame production.
	d.Registry.AddWorker(&Worker{ID: "dead", Status: "offline"})
	svc := d.fleetStatusService()
	svc.mu.Lock()
	svc.budgets.TTL = 5 * time.Millisecond
	svc.mu.Unlock()
	setStreamKnobs(svc, 5*time.Millisecond, 5*time.Millisecond, 400*time.Millisecond, 0)

	srv := httptest.NewUnstartedServer(d.buildRootHandler())
	srv.Listener = smallSndBufListener{srv.Listener}
	srv.Start()
	t.Cleanup(srv.Close)

	// Connect and read ONLY the headers; never read the body.
	resp := tryStream(t, srv.URL, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("blocked-writer connect: want 200, got %d", resp.StatusCode)
	}

	if !waitForNotify(8*time.Second, func() bool { return svc.streamSubscriberCount() == 0 && !svc.streamDemandActive() }) {
		t.Fatalf("stalled writer never closed: subscriber=%d demand=%v",
			svc.streamSubscriberCount(), svc.streamDemandActive())
	}
}

// ---------------------------------------------------------------------------
// 10/11. Failure postures around headers
// ---------------------------------------------------------------------------

// churnFetcher builds a toggleable acquisition seam for the failure
// postures. While OFF it forwards the scripted bodies unchanged; once
// ENABLED every acquisition additionally REPLACES the worker registration
// (bumping the registry generation) while keeping it online with a fresh
// transport — serve()'s bounded loop can then never settle ("registry
// liveness kept changing"), the designed 503/close path. The daemon field
// itself is never swapped mid-flight (production fetcher() reads it without
// synchronization; a swap would race the refresh goroutines).
type churnFetcher struct {
	d    *Daemon
	fake *fleetFake

	mu      sync.Mutex
	on      bool
	closers []io.Closer
}

func newChurnFetcher(t *testing.T, d *Daemon, fake *fleetFake) *churnFetcher {
	t.Helper()
	tc := &churnFetcher{d: d, fake: fake}
	t.Cleanup(func() {
		tc.mu.Lock()
		defer tc.mu.Unlock()
		for _, c := range tc.closers {
			c.Close()
		}
	})
	return tc
}

func (tc *churnFetcher) enable() {
	tc.mu.Lock()
	tc.on = true
	tc.mu.Unlock()
}

func (tc *churnFetcher) fetch(ctx context.Context, workerID, path string, timeout time.Duration, maxBodyBytes int64) ([]byte, error) {
	tc.mu.Lock()
	on := tc.on
	tc.mu.Unlock()
	if !on {
		return tc.fake.fetch(ctx, workerID, path, timeout, maxBodyBytes)
	}
	c1, c2 := net.Pipe()
	cfg := yamux.DefaultConfig()
	cfg.LogOutput = io.Discard
	cfg.EnableKeepAlive = false
	cli, err1 := yamux.Client(c1, cfg)
	srv, err2 := yamux.Server(c2, cfg)
	if err1 != nil || err2 != nil {
		return nil, fmt.Errorf("churn yamux pair: %v / %v", err1, err2)
	}
	tc.mu.Lock()
	tc.closers = append(tc.closers, cli, srv)
	tc.mu.Unlock()
	tc.d.Registry.AddWorker(&Worker{
		ID:        workerID,
		Status:    "online",
		Transport: &tunnel.MuxTransport{Session: srv},
		LastSeen:  time.Now(),
	})
	return tc.fake.fetch(ctx, workerID, path, timeout, maxBodyBytes)
}

// TestFleetStream_BootstrapFailureBeforeHeaders pins the pre-headers
// failure posture: when the bootstrap serve cannot settle, the client gets
// a plain-text 503 (never SSE headers) and the reserved slot is released.
func TestFleetStream_BootstrapFailureBeforeHeaders(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	seedQuietFleet(t, d, fake)
	tc := newChurnFetcher(t, d, fake)
	d.fetchWorkerJSON = tc.fetch
	tc.enable() // every acquisition churns from the first bootstrap serve
	svc := d.fleetStatusService()
	svc.budgets.TTL = time.Minute
	quietStreamKnobs(svc)
	srv := newStreamServer(t, d.buildRootHandler())

	resp := tryStream(t, srv.URL, false)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("bootstrap failure: want 503, got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Fatalf("bootstrap failure must be plain text, got %q", ct)
	}
	if !waitForNotify(2*time.Second, func() bool { return svc.streamSubscriberCount() == 0 }) {
		t.Fatalf("failed bootstrap leaked its slot (subs=%d)", svc.streamSubscriberCount())
	}
}

// TestFleetStream_MidStreamRefreshFailureCloses pins the post-commit
// posture: once 200 is committed, a serve failure CLOSES the stream (the
// heartbeat's reconcile serve detects the churning refresh machinery) —
// and http.Error text is never appended into the SSE body.
func TestFleetStream_MidStreamRefreshFailureCloses(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	seedQuietFleet(t, d, fake)
	tc := newChurnFetcher(t, d, fake)
	d.fetchWorkerJSON = tc.fetch // OFF: healthy bootstrap first
	svc := d.fleetStatusService()
	svc.mu.Lock()
	svc.budgets.TTL = 5 * time.Millisecond // heartbeat serves must refresh
	svc.mu.Unlock()
	setStreamKnobs(svc, 60*time.Millisecond, time.Hour, 0, 0)
	srv := newStreamServer(t, d.buildRootHandler())

	c := openStream(t, srv.URL, nil)
	c.next(t, "retry preamble", 3*time.Second)
	c.next(t, "bootstrap frame", 3*time.Second)

	// Break the refresh machinery: from here on no serve can settle.
	tc.enable()

	closed := false
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		block, ok := c.nextOrEnd(100 * time.Millisecond)
		if !ok {
			closed = true
			break
		}
		if block != "" {
			// Whatever still arrives must be well-formed SSE — never an
			// http.Error body wedged into the stream.
			if strings.Contains(block, "fleet status unavailable") {
				t.Fatalf("http.Error text leaked into the SSE stream: %q", block)
			}
			parseSSEFrame(t, block)
		}
	}
	if !closed {
		t.Fatal("stream never closed after the refresh machinery broke")
	}
	if !waitForNotify(2*time.Second, func() bool { return svc.streamSubscriberCount() == 0 && !svc.streamDemandActive() }) {
		t.Fatalf("closed stream leaked state (subs=%d demand=%v)", svc.streamSubscriberCount(), svc.streamDemandActive())
	}
}

// ---------------------------------------------------------------------------
// 12. Obsolete stamps are never streamed (the E2/E3 premise correction)
// ---------------------------------------------------------------------------

// TestFleetStream_ObsoleteStampNeverStreamed pins the validation rule the
// brief's premise correction demands: a raw publication carrying obsolete
// registry/config stamps may sit in the cache, but the stream must never
// SEND it — the wake drives the handler back through serve(), which
// refreshes past the stale generation and streams only the revalidated
// body.
func TestFleetStream_ObsoleteStampNeverStreamed(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	seedQuietFleet(t, d, fake)
	svc := d.fleetStatusService()
	svc.budgets.TTL = time.Minute
	quietStreamKnobs(svc)
	srv := newStreamServer(t, d.buildRootHandler())

	c := openStream(t, srv.URL, nil)
	c.next(t, "retry preamble", 3*time.Second)
	block1 := c.next(t, "bootstrap frame", 3*time.Second)
	if event, _ := parseSSEFrame(t, block1); event != "fleet.status" {
		t.Fatalf("bootstrap event: want fleet.status, got %q", event)
	}

	// Inject an obsolete-stamped generation directly (stamps 0/0 can never
	// match the live registry/config generations). Its wake must NOT make
	// the handler send the fallback body.
	svc.publishFallback(0, 0)

	gotFrame := false
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		block, ok := c.nextOrEnd(100 * time.Millisecond)
		if !ok {
			t.Fatal("stream ended unexpectedly")
		}
		if block == "" {
			continue
		}
		event, data := parseSSEFrame(t, block)
		if event != "fleet.status" {
			t.Fatalf("unexpected non-status frame %q", block)
		}
		if strings.Contains(data, `"overall":"unknown"`) {
			t.Fatalf("OBSOLETE fallback body was streamed: %s", data)
		}
		var resp fleetStatusResponse
		if err := json.Unmarshal([]byte(data), &resp); err != nil {
			t.Fatalf("frame after stale injection is not a rollup: %v (%s)", err, data)
		}
		if resp.Overall != fleetOverallNominal {
			t.Fatalf("post-invalidation frame must be a fresh healthy rollup, got overall=%s", resp.Overall)
		}
		// The frame may be the bootstrap generation itself or the refresh
		// past the stale one (differing only in generated_at); both are
		// valid — the assertion that matters is the fallback body NEVER
		// appears (checked above).
		gotFrame = true
		break
	}
	if !gotFrame {
		t.Fatal("the stale publication's wake never produced a revalidated frame")
	}
}

// ---------------------------------------------------------------------------
// 13. hostInterceptor carve-out (worker-subdomain precedence)
// ---------------------------------------------------------------------------

// TestHostInterceptorFleetStreamRoutePrecedence mirrors the fleet/status
// precedent: a request with a per-worker-subdomain Host hitting
// /vh/fleet/stream must be served by the CONTROLLER's stream, not proxied
// down to the worker (the proxied path would 502 on the dead transport).
// The stream itself proves the carve-out by delivering a controller-built
// bootstrap frame.
func TestHostInterceptorFleetStreamRoutePrecedence(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "$ID.controller.test")
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a
	// A subdomain-matching worker with NO transport: if the carve-out
	// fails, hostInterceptor proxies to it and the request dies with 502.
	d.Registry.AddWorker(&Worker{ID: "abc", Name: "abc-worker", Status: "online", Version: "v1"})
	seedQuietFleet(t, d, fake) // the real acquisition target ("w1")
	svc := d.fleetStatusService()
	svc.budgets.TTL = time.Minute
	quietStreamKnobs(svc)
	h := d.buildRootHandler()
	srv := newStreamServer(t, h)
	session := loginPassphrase(t, h, "secret")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, srv.URL+"/vh/fleet/stream", nil)
	if err != nil {
		t.Fatalf("stream request: %v", err)
	}
	req.Host = "abc.controller.test"
	req.AddCookie(session)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("stream connect via worker host: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusBadGateway {
		t.Fatal("hostInterceptor proxied /vh/fleet/stream to the worker (502) — carve-out missing or broken")
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("stream via worker host: want 200, got %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("stream via worker host: want text/event-stream, got %q", ct)
	}
	// Read the first two blocks with a watchdog.
	c := &sseClient{resp: resp, frames: make(chan string, 8), cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(c.done)
		sc := bufio.NewScanner(resp.Body)
		sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
		sc.Split(splitSSE)
		for sc.Scan() {
			if sc.Text() == "" {
				continue
			}
			select {
			case c.frames <- sc.Text():
			case <-ctx.Done():
				return
			}
		}
	}()
	if b := c.next(t, "retry preamble", 3*time.Second); b != "retry: 2000" {
		t.Fatalf("first block via worker host: want retry preamble, got %q", b)
	}
	event, data := parseSSEFrame(t, c.next(t, "bootstrap frame", 3*time.Second))
	if event != "fleet.status" {
		t.Fatalf("bootstrap event via worker host: want fleet.status, got %q", event)
	}
	var respRollup fleetStatusResponse
	if err := json.Unmarshal([]byte(data), &respRollup); err != nil || respRollup.Schema != 1 {
		t.Fatalf("bootstrap via worker host is not the controller rollup: %v (%s)", err, data)
	}
	if fake.count("w1") == 0 {
		t.Fatal("controller acquisition never ran — the stream did not reach the controller's handler")
	}
}
