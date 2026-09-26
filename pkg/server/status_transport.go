package server

// status_transport.go — S1 evidence-gate bounded worker-JSON fetch.
//
// Context (task card task-2026-09-25-…-compact-readonly-fleet-status-rollup):
// before any GET /api/fleet/status endpoint work, slice S1 must prove that a
// controller→worker HTTP-over-yamux fetch can be CONTAINED — bounded stream
// open, bounded handshake, bounded header+body reads, bounded allocation —
// without closing the shared tunnel and while unrelated streams on the same
// session keep working.
//
// Why Proxy.FetchWorkerSnapshot (proxy.go) is not reused as-is — measured
// yamux v0.1.2 facts, exercised and asserted end-to-end through the real
// tunnel by the lane-3 test tests/e2e/status_transport_s1_test.go:
//
//   - yamux.Stream.Close() does NOT wake a Read that is blocked with no data
//     pending (a stalled peer keeps the read blocked forever). The existing
//     helper's post-ACK close-watcher therefore bounds WRITES only; a stalled
//     ACK, stalled response head, or stalled body still hangs the fetch until
//     the whole session dies.
//   - yamux.Stream read/write DEADLINES do wake blocked reads and writes
//     ("i/o deadline reached", os.IsTimeout=true) and leave the session
//     usable for other streams afterwards. Deadlines are the containment
//     mechanism this helper relies on.
//   - Session.OpenStream() has no deadline and blocks once 256 opened
//     streams sit unaccepted in the remote backlog (a peer whose yamux layer
//     is alive but whose accept loop is stuck answers keepalives fine, so
//     the session never dies). This helper bounds stream-open by racing the
//     open against the caller's bound; see the comment on the race for the
//     residual, documented cost.
//
// The framing (RawProxy handshake, Port=0, Connection: close) mirrors
// FetchWorkerSnapshot / handleRawProxy on purpose: the worker-side agent
// (pkg/agent/daemon.go handleRawProxy) serves this identically, so this is
// the REAL transport path, not a parallel protocol.

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/tunnel"
)

// ErrFetchResponseBodyTooLarge is returned when the worker's response body
// exceeds the caller's byte cap. Detected by reading cap+1 bytes (explicit
// excess detection) — never by silently truncating at the cap.
var ErrFetchResponseBodyTooLarge = errors.New("response body exceeds cap")

// FetchTimeoutError marks a bounded-fetch failure caused by a deadline
// firing at a specific stage (stream open, handshake, response head, body).
// It satisfies the timeout interface so callers can classify it with
// os.IsTimeout without unwrapping. Timeout() covers BOTH deadline expiry and
// context cancellation — either way the fetch ran out of its time budget at
// that stage (the Cause distinguishes them: "i/o deadline reached" vs a
// context.Canceled/DeadlineExceeded).
type FetchTimeoutError struct {
	WorkerID string
	Stage    string
	Cause    error
}

func (e *FetchTimeoutError) Error() string {
	return fmt.Sprintf("worker %s: %s: %v", e.WorkerID, e.Stage, e.Cause)
}

func (e *FetchTimeoutError) Timeout() bool { return true }
func (e *FetchTimeoutError) Unwrap() error { return e.Cause }

// Stage-budget defaults for FetchWorkerJSONBounded. The ACK is a single
// WriteJSON line (JSON + '\n', tens of bytes); 4 KiB is a generous ceiling.
// The response-head budget covers status line + headers + HTTP framing
// slack; the body cap is caller-supplied (maxBodyBytes).
const (
	fetchACKLineBudget  = 4 << 10
	fetchHeadWireBudget = 64 << 10
)

// FetchWorkerJSONBounded performs ONE bounded GET of a worker-local JSON path
// through the real yamux tunnel and returns the response body bytes.
//
// Containment contract (the S1 properties, each proven in
// tests/e2e/status_transport_s1_test.go):
//
//  1. stream open: bounded by min(ctx, timeout) via a race (see below);
//  2. handshake (RawProxy write + ACK read): bounded by stream deadlines;
//  3. response head read: bounded by stream deadlines AND a wire budget;
//  4. body read: bounded by stream deadlines AND maxBodyBytes (cap-plus-one
//     excess detection, never silent truncation);
//  5. cleanup: the stream is closed on every return path; no watcher
//     goroutine is used at all — deadlines do the unblocking — so a
//     completed (failed or successful) fetch retains no goroutines;
//  6. the parent tunnel is never closed; unrelated streams on the same
//     session keep working during and after a contained failure.
//
// The residual cost of bounding stream-open: if the caller's bound fires
// while OpenStream is still parked (remote backlog full — 256 unaccepted
// streams), exactly one opener goroutine remains parked inside OpenStream
// (plus a janitor that closes the stream when the open eventually resolves).
// The pair resolves as soon as the backlog drains or the session closes; it
// does not grow per call beyond that one pair.
//
// Total worst-case wall-clock cost is ~2× timeout unless ctx clamps it
// tighter: the stream-open race is bounded by `timeout`, and every subsequent
// stage is bounded by one absolute deadline at now+timeout (clamped to the
// ctx deadline when earlier). The two windows overlap only in the pathological
// case where the open resolves just before the timer fires.
//
// Read-only: this function mutates no controller state; it opens one stream,
// performs one GET, and closes the stream.
func (p *Proxy) FetchWorkerJSONBounded(ctx context.Context, worker *Worker, path string, timeout time.Duration, maxBodyBytes int64) ([]byte, error) {
	if worker == nil {
		return nil, fmt.Errorf("nil worker")
	}
	if p.Registry == nil {
		return nil, fmt.Errorf("worker %s: proxy has no registry", worker.ID)
	}
	// Snapshot the transport under the registry lock: reading the
	// worker.Transport field directly races with Registry.MarkWorkerOffline's
	// Transport=nil write when the worker disconnects mid-fetch (observed
	// under -race in the lane-3 test). Note the same unlocked field-read
	// pattern is pre-existing at other call sites (proxy.go, daemon.go,
	// coordapi.go) — those are out of scope for this slice. The snapshot may
	// already be closed; that is handled here and by stream errors.
	tr, ok := p.Registry.WorkerTransport(worker.ID)
	if !ok {
		return nil, fmt.Errorf("worker %s: not registered", worker.ID)
	}
	if tr == nil || tr.IsClosed() {
		return nil, fmt.Errorf("worker %s: transport closed", worker.ID)
	}
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("worker %s: %w", worker.ID, err)
	}
	if err := validFetchPath(path); err != nil {
		return nil, fmt.Errorf("worker %s: %w", worker.ID, err)
	}
	// A3: worker.ID is interpolated into the Host header below (and error
	// strings); guard it against CR/LF the same way validFetchPath guards
	// the request-line path. IDs come from worker registration, so this keeps
	// the primitive honest by construction rather than trusting the registrar.
	if strings.ContainsAny(worker.ID, "\r\n") {
		return nil, fmt.Errorf("invalid worker ID %q: CR/LF not allowed", worker.ID)
	}
	if maxBodyBytes < 0 {
		return nil, fmt.Errorf("worker %s: negative body cap", worker.ID)
	}

	// --- Stage 1: bounded stream open -----------------------------------
	// OpenStream has no deadline and blocks when the remote accept backlog
	// (256) is full, so bound it by racing it against min(ctx, timeout).
	type openResult struct {
		stream *tunnel.Stream
		err    error
	}
	openCh := make(chan openResult, 1) // buffered: opener never blocks on send
	go func() {
		s, err := tr.OpenStream()
		openCh <- openResult{s, err}
	}()
	timer := time.NewTimer(timeout)
	defer timer.Stop()

	closeIfLate := func() {
		// Janitor: close the stream if the parked open eventually resolves,
		// so it cannot linger in the remote backlog or the session map.
		go func() {
			if r := <-openCh; r.stream != nil {
				r.stream.Close()
			}
		}()
	}

	var stream *tunnel.Stream
	select {
	case r := <-openCh:
		if r.err != nil {
			return nil, fmt.Errorf("worker %s: open stream: %w", worker.ID, r.err)
		}
		stream = r.stream
	case <-ctx.Done():
		closeIfLate()
		return nil, &FetchTimeoutError{WorkerID: worker.ID, Stage: "open stream", Cause: ctx.Err()}
	case <-timer.C:
		closeIfLate()
		return nil, &FetchTimeoutError{WorkerID: worker.ID, Stage: "open stream", Cause: errors.New("i/o deadline reached")}
	}
	defer stream.Close()

	// One absolute deadline bounds every subsequent Read AND Write on this
	// stream (handshake write, ACK read, request write, head read, body
	// read): min(now+timeout, ctx deadline).
	deadline := time.Now().Add(timeout)
	if ctxDL, ok := ctx.Deadline(); ok && ctxDL.Before(deadline) {
		deadline = ctxDL
	}
	if err := stream.Raw().SetDeadline(deadline); err != nil {
		return nil, fmt.Errorf("worker %s: set deadline: %w", worker.ID, err)
	}

	// --- Stage 2: RawProxy handshake (identical framing to the diag path)
	rawReq := tunnel.RawProxyMessage{
		BaseMessage: tunnel.BaseMessage{Type: tunnel.TypeRawProxy},
		Port:        0, // 0 = the worker's web port on the agent side
	}
	if err := stream.WriteJSON(rawReq); err != nil {
		return nil, fetchStageErr(worker.ID, "send raw-proxy", err)
	}
	ackLine, err := readACKLine(stream.Raw(), fetchACKLineBudget)
	if err != nil {
		return nil, fetchStageErr(worker.ID, "read ack", err)
	}
	var ack tunnel.BaseMessage
	if err := json.Unmarshal(ackLine, &ack); err != nil {
		return nil, fmt.Errorf("worker %s: read ack: malformed (%w)", worker.ID, err)
	}
	if ack.Type == tunnel.TypeError {
		return nil, fmt.Errorf("worker %s: agent cannot proxy to local web port", worker.ID)
	}

	// --- Stage 3: bounded HTTP exchange ---------------------------------
	// The wire cap bounds TOTAL bytes read from the stream for the whole
	// exchange (head + framing + body): a fast-sending peer cannot push
	// unbounded header/body bytes inside the deadline window.
	wire := &budgetReader{r: stream.Raw(), budget: fetchHeadWireBudget + maxBodyBytes + 1}
	br := bufio.NewReaderSize(wire, 16<<10)

	req := "GET " + path + " HTTP/1.1\r\nHost: " + worker.ID + "\r\nConnection: close\r\n\r\n"
	if _, err := stream.Raw().Write([]byte(req)); err != nil {
		return nil, fetchStageErr(worker.ID, "write request", err)
	}

	resp, err := http.ReadResponse(br, nil)
	if err != nil {
		return nil, fetchStageErr(worker.ID, "read response head", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("worker %s: HTTP %d", worker.ID, resp.StatusCode)
	}

	// --- Stage 4: body with cap-plus-one excess detection ---------------
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxBodyBytes+1))
	if err != nil {
		return nil, fetchStageErr(worker.ID, "read body", err)
	}
	if int64(len(body)) > maxBodyBytes {
		return nil, fmt.Errorf("worker %s: %w (%d > %d bytes)", worker.ID, ErrFetchResponseBodyTooLarge, len(body), maxBodyBytes)
	}
	return body, nil
}

// fetchStageErr wraps a stage failure, upgrading deadline/timeout causes to
// FetchTimeoutError so callers can classify with os.IsTimeout.
func fetchStageErr(workerID, stage string, err error) error {
	if os.IsTimeout(err) {
		return &FetchTimeoutError{WorkerID: workerID, Stage: stage, Cause: err}
	}
	return fmt.Errorf("worker %s: %s: %w", workerID, stage, err)
}

// budgetReader hard-fails once more than budget bytes have been read,
// bounding total allocation from a fast-sending peer.
type budgetReader struct {
	r        io.Reader
	budget   int64
	consumed int64
}

func (b *budgetReader) Read(p []byte) (int, error) {
	if b.consumed >= b.budget {
		return 0, fmt.Errorf("response exceeds wire budget of %d bytes", b.budget)
	}
	n, err := b.r.Read(p)
	b.consumed += int64(n)
	if b.consumed > b.budget {
		return 0, fmt.Errorf("response exceeds wire budget of %d bytes", b.budget)
	}
	return n, err
}

// readACKLine reads one newline-terminated ACK line (the peer's WriteJSON
// appends '\n') of at most limit bytes. Bounds the ACK allocation independently
// of json.Decoder's internal buffering.
func readACKLine(r io.Reader, limit int64) ([]byte, error) {
	lr := io.LimitReader(r, limit+1)
	var line []byte
	one := make([]byte, 1)
	for {
		n, err := lr.Read(one)
		if n > 0 {
			if one[0] == '\n' {
				return trimTrailingCR(line), nil
			}
			line = append(line, one[0])
		}
		if err == io.EOF {
			return nil, fmt.Errorf("ack line missing newline after %d bytes", len(line))
		}
		if err != nil {
			return nil, err
		}
		if int64(len(line)) > limit {
			return nil, fmt.Errorf("ack line exceeds %d bytes", limit)
		}
	}
}

func trimTrailingCR(b []byte) []byte {
	if n := len(b); n > 0 && b[n-1] == '\r' {
		return b[:n-1]
	}
	return b
}

// validFetchPath guards the request line against CRLF injection; paths are
// server-authored, this keeps the primitive honest by construction.
func validFetchPath(path string) error {
	if len(path) == 0 || path[0] != '/' {
		return fmt.Errorf("invalid fetch path %q: must start with /", path)
	}
	if strings.ContainsAny(path, "\r\n") {
		return fmt.Errorf("invalid fetch path %q: CR/LF not allowed", path)
	}
	return nil
}
