package diagnostics

import (
	"bufio"
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestHandlerBytesWriter verifies the core Phase-1 proving property: a handler
// writing N bytes through a HandlerBytesWriter increments its path-class
// counter by exactly N (post-compression payload, since the handler writes the
// maybeCompressSnapshot'd bytes). This is the per-path attribution that was
// previously invisible (only /vh/stream was wrapped by StreamStatsWriter).
func TestHandlerBytesWriter(t *testing.T) {
	resetAndRestore(t)

	rw := httptest.NewRecorder()
	w := NewHandlerBytesWriter(rw, ProxyPathRender)

	payload := []byte(`[{"id":"b1","html":"<p>hi</p>"}]`)
	n, err := w.Write(payload)
	if err != nil {
		t.Fatalf("Write failed: %v", err)
	}
	if n != len(payload) {
		t.Fatalf("Write returned n=%d, want %d", n, len(payload))
	}

	got := Default.HandlerBytes[ProxyPathRender].Bytes.Load()
	if got != uint64(len(payload)) {
		t.Fatalf("Render bytes = %d, want %d", got, len(payload))
	}
	if writes := Default.HandlerBytes[ProxyPathRender].Writes.Load(); writes != 1 {
		t.Fatalf("Render writes = %d, want 1", writes)
	}
}

// TestHandlerBytesFlusherPreservation verifies the wrapper preserves
// http.Flusher — critical because the reverse-proxy legs (passthrough /oc/* and
// managed views) rely on httputil.ReverseProxy's FlushInterval=-1 streaming,
// which type-asserts http.Flusher. A wrapper that dropped the Flusher interface
// would silently break streaming (the proxy falls back to buffered writes).
func TestHandlerBytesFlusherPreservation(t *testing.T) {
	resetAndRestore(t)

	// httptest.NewRecorder implements both http.ResponseWriter and http.Flusher.
	rw := httptest.NewRecorder()
	w := NewHandlerBytesWriter(rw, ProxyPathPassthrough)

	if _, ok := interface{}(w).(http.Flusher); !ok {
		t.Fatal("HandlerBytesWriter does NOT implement http.Flusher — reverse-proxy streaming would break")
	}
	// Flush must be a safe no-op-or-call (delegates to the underlying recorder).
	w.Flush()
}

// TestHandlerBytesMultipleClasses verifies that distinct path-classes are
// counted independently and the per-class attribution is correct (fixed
// cardinality — no cross-contamination).
func TestHandlerBytesMultipleClasses(t *testing.T) {
	resetAndRestore(t)

	for _, class := range []int{ProxyPathPassthrough, ProxyPathView, ProxyPathCodeFile, ProxyPathRender, ProxyPathSnapshot, ProxyPathBranch, ProxyPathMessages} {
		rw := httptest.NewRecorder()
		w := NewHandlerBytesWriter(rw, class)
		_, _ = w.Write([]byte{0xAB, 0xCD, 0xEF, 0x01}) // 4 bytes per class
	}

	for class := 0; class < numProxyPathClasses; class++ {
		got := Default.HandlerBytes[class].Bytes.Load()
		var want uint64
		if class < ProxyPathTerminal { // 0-6 were written above
			want = 4
		}
		if got != want {
			t.Fatalf("class %d (%s) bytes = %d, want %d", class, proxyPathClassName[class], got, want)
		}
	}
}

// TestRecordHandlerBytes verifies the explicit counter path used by the
// terminal websocket pump (which writes via conn.WriteMessage, not
// http.ResponseWriter.Write).
func TestRecordHandlerBytes(t *testing.T) {
	resetAndRestore(t)

	RecordHandlerBytes(ProxyPathTerminal, 256)
	RecordHandlerBytes(ProxyPathTerminal, 16)

	got := Default.HandlerBytes[ProxyPathTerminal].Bytes.Load()
	if got != 272 {
		t.Fatalf("terminal bytes = %d, want 272", got)
	}
	if writes := Default.HandlerBytes[ProxyPathTerminal].Writes.Load(); writes != 2 {
		t.Fatalf("terminal writes = %d, want 2", writes)
	}
	// Guard: non-positive n and out-of-range class are ignored.
	RecordHandlerBytes(ProxyPathTerminal, 0)
	RecordHandlerBytes(ProxyPathTerminal, -5)
	RecordHandlerBytes(numProxyPathClasses, 10)
	if got := Default.HandlerBytes[ProxyPathTerminal].Writes.Load(); got != 2 {
		t.Fatalf("guard failed: writes = %d, want 2", got)
	}
}

// TestStream2ReplayFallback verifies the replay-fallback counter increments.
func TestStream2ReplayFallback(t *testing.T) {
	resetAndRestore(t)

	IncStream2ReplayFallback()
	IncStream2ReplayFallback()
	IncStream2ReplayFallback()

	if got := Default.Stream2ReplayFallback.Load(); got != 3 {
		t.Fatalf("replay fallback = %d, want 3", got)
	}
}

// TestHandlerBytesSnapshotExposure verifies the JSON snapshot includes the
// handler_bytes section and stream2_replay_fallback with the fixed path-class
// cardinality and bounded shape (no per-URL/per-session labels).
func TestHandlerBytesSnapshotExposure(t *testing.T) {
	resetAndRestore(t)

	w := NewHandlerBytesWriter(httptest.NewRecorder(), ProxyPathCodeFile)
	_, _ = w.Write([]byte("hello world")) // 11 bytes
	IncStream2ReplayFallback()

	snap := Snapshot()

	if len(snap.Probes.HandlerBytes) != numProxyPathClasses {
		t.Fatalf("handler_bytes has %d entries, want %d", len(snap.Probes.HandlerBytes), numProxyPathClasses)
	}
	var found bool
	for _, hb := range snap.Probes.HandlerBytes {
		if hb.Class == "code_file" {
			found = true
			if hb.Bytes != 11 {
				t.Fatalf("code_file bytes = %d, want 11", hb.Bytes)
			}
			if hb.Writes != 1 {
				t.Fatalf("code_file writes = %d, want 1", hb.Writes)
			}
		}
	}
	if !found {
		t.Fatal("code_file class not found in handler_bytes snapshot")
	}
	if snap.Probes.Stream2ReplayFallback != 1 {
		t.Fatalf("stream2_replay_fallback = %d, want 1", snap.Probes.Stream2ReplayFallback)
	}
}

// TestReconciliationProperty is the Phase-1 proving test: the sum of all
// per-path handler_bytes counters PLUS the sum of all stream.bytes counters
// reconciles with the total bytes attributed across both probes. Before Phase 1
// only stream.bytes was counted (the blind spot); now the per-path counters
// make the previously-unattributed raw-proxy traffic visible. This test fails
// without the per-path counters (the gap is the blind spot) and passes with
// them.
func TestReconciliationProperty(t *testing.T) {
	resetAndRestore(t)

	// Simulate a burst: stream traffic + several non-stream handler legs.
	// Stream leg (Probe 3): a tree-class stream writes some bytes.
	sw := NewStreamStatsWriter(httptest.NewRecorder(), StreamClassTree)
	_, _ = sw.Write([]byte("sse-frame-payload-1234")) // 21 bytes

	// Non-stream legs (Probe 8): a snapshot + a render + a code-file.
	_, _ = NewHandlerBytesWriter(httptest.NewRecorder(), ProxyPathSnapshot).Write([]byte("snapshot-body"))
	_, _ = NewHandlerBytesWriter(httptest.NewRecorder(), ProxyPathRender).Write([]byte("render-body!!"))
	_, _ = NewHandlerBytesWriter(httptest.NewRecorder(), ProxyPathCodeFile).Write([]byte("code-file-bdy"))

	// Aggregate: sum all per-path handler bytes.
	var handlerTotal uint64
	for i := 0; i < numProxyPathClasses; i++ {
		handlerTotal += Default.HandlerBytes[i].Bytes.Load()
	}
	// Aggregate: sum all stream bytes.
	var streamTotal uint64
	for i := 0; i < numStreamClasses; i++ {
		streamTotal += Default.Stream[i].Bytes.Load()
	}

	// The reconciliation property: sum(handler_bytes) + sum(stream.bytes) =
	// the total attributed tunnel-origin bytes. Every byte is now visible to
	// at least one per-class counter — the blind spot is closed.
	totalAttributed := handlerTotal + streamTotal
	// Sanity: each simulated leg wrote a known body; their sum is the total.
	wantTotal := uint64(len("sse-frame-payload-1234") + len("snapshot-body") + len("render-body!!") + len("code-file-bdy"))
	if totalAttributed != wantTotal {
		t.Fatalf("reconciliation failed: handler=%d + stream=%d = %d, want %d (blind spot remains)",
			handlerTotal, streamTotal, totalAttributed, wantTotal)
	}
	// Confirm handlerTotal is non-zero — without Phase 1 this would be 0
	// (the blind spot). With it, the non-stream legs are attributed.
	if handlerTotal == 0 {
		t.Fatal("handler_bytes total is 0 — the non-stream blind spot was NOT instrumented")
	}
}

// TestHandlerBytesJSONShape verifies the snapshot JSON round-trips with the
// expected field names so an operator/dash consumer can rely on the shape.
func TestHandlerBytesJSONShape(t *testing.T) {
	resetAndRestore(t)

	w := NewHandlerBytesWriter(httptest.NewRecorder(), ProxyPathPassthrough)
	_, _ = w.Write([]byte("x"))

	snap := Snapshot()
	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("unmarshal snapshot: %v", err)
	}
	probes, ok := decoded["probes"].(map[string]any)
	if !ok {
		t.Fatal("probes missing in JSON")
	}
	if _, ok := probes["handler_bytes"]; !ok {
		t.Fatal("handler_bytes missing from JSON probes")
	}
	if _, ok := probes["stream2_replay_fallback"]; !ok {
		t.Fatal("stream2_replay_fallback missing from JSON probes")
	}
}

// TestHandlerBytesUnwrapHijack is the upgrade-transparency regression test
// added in response to commit-reviewer finding b-F1 (which blocked Phase 1).
// The reverse-proxy legs (handlePassthrough /oc/* and dispatchView managed
// views) can carry a 101 Switching Protocols upgrade; on such a response
// httputil.ReverseProxy.handleUpgradeResponse resolves the writer via
// http.NewResponseController(rw).Hijack(), which walks Unwrap() to find an
// http.Hijacker. Without Unwrap on the wrapper, Hijack returns
// http.ErrNotSupported and the proxy fires its error handler instead of
// upgrading — a behavior change that violates the "passive observation only"
// contract. This test proves the wrapper is transparent to that resolution: a
// Hijacker-capable underlying writer is still reachable through the wrapper,
// and byte-counting keeps working for normal writes.
func TestHandlerBytesUnwrapHijack(t *testing.T) {
	resetAndRestore(t)

	inner := &hijackRW{}
	w := NewHandlerBytesWriter(inner, ProxyPathPassthrough)

	// The wrapper must chain Unwrap() so http.ResponseController reaches the
	// inner writer's Hijack. Before b-F1 was fixed this returned
	// http.ErrNotSupported and aborted the upgrade.
	rc := http.NewResponseController(w)
	conn, brw, err := rc.Hijack()
	if err != nil {
		t.Fatalf("Hijack through wrapper failed: %v (upgrade regression — Unwrap not chaining to Hijacker)", err)
	}
	defer conn.Close()
	_ = brw
	if !inner.hijacked {
		t.Fatal("inner Hijack not invoked — Unwrap did not reach the underlying writer")
	}

	// Write-counting must still work for ordinary (non-upgrade) responses.
	if _, err := w.Write([]byte("after")); err != nil {
		t.Fatalf("Write after hijack probe: %v", err)
	}
	if got := Default.HandlerBytes[ProxyPathPassthrough].Bytes.Load(); got != 5 {
		t.Fatalf("passthrough bytes = %d, want 5", got)
	}
}

// hijackRW is a minimal http.ResponseWriter + http.Hijacker + http.Flusher for
// the upgrade-transparency test. net.Pipe gives a real net.Conn so Hijack can
// return a usable connection without error; no bytes are actually transferred.
type hijackRW struct {
	header   http.Header
	hijacked bool
}

func (h *hijackRW) Header() http.Header {
	if h.header == nil {
		h.header = http.Header{}
	}
	return h.header
}
func (h *hijackRW) WriteHeader(int)             {}
func (h *hijackRW) Write(b []byte) (int, error) { return len(b), nil }
func (h *hijackRW) Flush()                      {}
func (h *hijackRW) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	h.hijacked = true
	c1, _ := net.Pipe()
	return c1, bufio.NewReadWriter(bufio.NewReader(c1), bufio.NewWriter(c1)), nil
}
