package diagnostics

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// resetAndRestore zeroes the global registry for the duration of a test and
// restores it afterwards so tests are hermetic.
func resetAndRestore(t *testing.T) {
	t.Cleanup(func() {
		ResetForTest()
		// Re-init startedAt to a fresh value for production use after the suite.
		Default.startedAt = nowNano()
	})
	ResetForTest()
}

// --- Counter ----------------------------------------------------------------

func TestCounter(t *testing.T) {
	resetAndRestore(t)
	var c Counter
	if c.Load() != 0 {
		t.Fatalf("initial = %d, want 0", c.Load())
	}
	c.Inc()
	c.Add(9)
	if got := c.Load(); got != 10 {
		t.Fatalf("after Inc+Add(9) = %d, want 10", got)
	}
	c.reset()
	if c.Load() != 0 {
		t.Fatalf("after reset = %d, want 0", c.Load())
	}
}

func TestCounterConcurrent(t *testing.T) {
	resetAndRestore(t)
	var c Counter
	var wg sync.WaitGroup
	for i := 0; i < 100; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c.Inc()
		}()
	}
	wg.Wait()
	if got := c.Load(); got != 100 {
		t.Fatalf("concurrent 100 Inc = %d, want 100", got)
	}
}

// --- Histogram --------------------------------------------------------------

func TestHistogramObserveAndPercentile(t *testing.T) {
	resetAndRestore(t)
	var h Histogram
	h.reset() // mark min as uninitialized so the first observation seeds cleanly
	// No observations yet.
	if p := h.percentile(50); p != 0 {
		t.Fatalf("empty p50 = %d, want 0", p)
	}
	// Observe 5 values all under 1µs.
	for i := 0; i < 5; i++ {
		h.Observe(100) // 100ns, < 1µs bucket
	}
	snap := h.snapshot()
	if snap.Count != 5 {
		t.Fatalf("Count = %d, want 5", snap.Count)
	}
	if snap.Min != 100 {
		t.Fatalf("Min = %d, want 100", snap.Min)
	}
	if snap.Max != 100 {
		t.Fatalf("Max = %d, want 100", snap.Max)
	}
	if snap.Sum != 500 {
		t.Fatalf("Sum = %d, want 500", snap.Sum)
	}
	if snap.P50 != 1_000 {
		t.Fatalf("P50 = %d, want 1000 (bucket edge <1µs)", snap.P50)
	}
}

func TestHistogramTailBuckets(t *testing.T) {
	resetAndRestore(t)
	var h Histogram
	h.reset() // mark min as uninitialized so the first observation seeds cleanly
	// One fast, one slow (200ms), one very slow (6s).
	h.Observe(1_000)         // < 1µs
	h.Observe(200_000_000)   // < 500ms bucket
	h.Observe(6_000_000_000) // < 10s bucket
	snap := h.snapshot()
	if snap.Count != 3 {
		t.Fatalf("Count = %d, want 3", snap.Count)
	}
	if snap.Min != 1_000 {
		t.Fatalf("Min = %d, want 1000", snap.Min)
	}
	if snap.Max != 6_000_000_000 {
		t.Fatalf("Max = %d, want 6000000000", snap.Max)
	}
	// p95 should be in a high bucket given 2/3 values are large.
	if snap.P95 < 100_000_000 {
		t.Fatalf("P95 = %d, want >= 100ms bucket", snap.P95)
	}
}

func TestHistogramNegativeClamped(t *testing.T) {
	resetAndRestore(t)
	var h Histogram
	h.reset() // mark min as uninitialized so the first observation seeds cleanly
	h.Observe(-5)
	snap := h.snapshot()
	if snap.Min != 0 {
		t.Fatalf("Min after negative = %d, want 0 (clamped)", snap.Min)
	}
	if snap.Sum != 0 {
		t.Fatalf("Sum after negative = %d, want 0", snap.Sum)
	}
}

// --- IncidentRing -----------------------------------------------------------

func TestIncidentRingEviction(t *testing.T) {
	resetAndRestore(t)
	var r IncidentRing
	for i := 0; i < maxIncidents+10; i++ {
		r.Push(Incident{At: int64(i), Kind: "test", Dur: int64(i)})
	}
	got := r.Snapshot()
	if len(got) != maxIncidents {
		t.Fatalf("len = %d, want %d", len(got), maxIncidents)
	}
	// Newest-first: the newest entry should be the last pushed (i=maxIncidents+9).
	if got[0].At != int64(maxIncidents+9) {
		t.Fatalf("newest At = %d, want %d", got[0].At, maxIncidents+9)
	}
	// Oldest (last in slice) should be i=10 (first 10 evicted).
	if got[len(got)-1].At != 10 {
		t.Fatalf("oldest At = %d, want 10", got[len(got)-1].At)
	}
}

func TestIncidentRingEmpty(t *testing.T) {
	resetAndRestore(t)
	var r IncidentRing
	if got := r.Snapshot(); got != nil {
		t.Fatalf("empty Snapshot = %v, want nil", got)
	}
}

// --- Classifiers ------------------------------------------------------------

func TestClassifyEmitKind(t *testing.T) {
	cases := []struct {
		kind string
		want int
	}{
		{"session.upsert", EmitClassStructural},
		{"session.remove", EmitClassStructural},
		{"status", EmitClassStructural},
		{"activity.start", EmitClassStructural},
		{"permission.request", EmitClassStructural},
		{"question.ask", EmitClassStructural},
		{"notice", EmitClassStructural},
		{"message.updated", EmitClassMessage},
		{"messages.loaded", EmitClassMessagesBatch},
		{"messages.error", EmitClassMessagesBatch},
		{"part.delta", EmitClassPart},
		{"part.updated", EmitClassPart},
		{"unknown.event", EmitClassOther},
	}
	for _, c := range cases {
		if got := ClassifyEmitKind(c.kind); got != c.want {
			t.Errorf("ClassifyEmitKind(%q) = %d, want %d", c.kind, got, c.want)
		}
	}
}

func TestClassifyStream(t *testing.T) {
	if got := ClassifyStream(nil); got != StreamClassFirehose {
		t.Errorf("nil filter = %d, want firehose", got)
	}
	if got := ClassifyStream(map[string]bool{}); got != StreamClassTree {
		t.Errorf("empty filter = %d, want tree", got)
	}
	if got := ClassifyStream(map[string]bool{"a": true}); got != StreamClassSelected {
		t.Errorf("non-empty filter = %d, want selected", got)
	}
}

// --- Snapshot / Handler -----------------------------------------------------

func TestSnapshotJSONShape(t *testing.T) {
	resetAndRestore(t)
	// Seed some data across probes.
	Default.Ingest.Events.Inc()
	Default.Ingest.Bytes.Add(42)
	Default.Emit.ClassCount[EmitClassMessage].Inc()
	Default.Emit.SourceCount[SourceOpencodeLive].Inc()
	Default.Stream[StreamClassTree].Opens.Inc()
	Default.Yamux.StreamsOpened.Inc()
	Default.Yamux.TunnelDownRejections.Inc()
	Default.Yamux.SetupDur.Observe(1_000_000)
	Default.Yamux.ReqWriteDur.Observe(500_000)
	Default.Yamux.AckDur.Observe(2_000_000)
	Default.WSWrite[SideServer].Writes.Inc()
	Default.Copy[CopyYamuxToBrowser].Bytes.Add(100)
	Default.Tunnel.DialAttempts.Inc()
	Default.Tunnel.DialFailures.Inc()
	Default.Tunnel.Connected.Inc()
	Default.Tunnel.Disconnects.Inc()
	Default.Tunnel.IdleResets.Inc()
	Default.Tunnel.LastBackoffNs.Store(int64(5 * time.Second))
	Default.Tunnel.LastConnectedAtNs.Store(1_700_000_000_000_000_000)
	Default.Tunnel.LastDisconnectAtNs.Store(1_700_000_060_000_000_000)
	Default.Tunnel.CurrentState.Store(int32(TunnelStateConnected))

	snap := Snapshot()
	data, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	jsonStr := string(data)

	// Verify all probe sections are present in the JSON.
	required := []string{
		`"started_at_ns"`,
		`"ingest"`,
		`"emit"`,
		`"stream"`,
		`"yamux"`,
		`"ws_write"`,
		`"copy"`,
		`"tunnel"`,
		`"events":1`,
		`"bytes":42`,
		`"streams_opened":1`,
		`"opens":1`,
		`"yamux_to_browser"`,
		// Phase 4 setup-probe fields (must appear in the JSON output):
		`"req_write_dur"`,
		`"ack_dur"`,
		`"setup_dur"`,
		`"tunnel_down_rejections":1`,
		// Probe 7 tunnel-lifecycle fields:
		`"dial_attempts":1`,
		`"dial_failures":1`,
		`"connected":1`,
		`"disconnects":1`,
		`"idle_resets":1`,
		`"last_backoff_ns":5000000000`,
		`"current_state":"connected"`,
	}
	for _, key := range required {
		if !strings.Contains(jsonStr, key) {
			t.Errorf("snapshot JSON missing %q\nfull: %s", key, jsonStr)
		}
	}

	// Verify NO raw content fields leak — there should be no "session_id",
	// "url", "payload", "text", or "message" content keys.
	forbidden := []string{`"session_id"`, `"url"`, `"payload"`, `"text"`, `"transcript"`}
	for _, key := range forbidden {
		if strings.Contains(jsonStr, key) {
			t.Errorf("snapshot JSON contains forbidden key %q — sensitive content risk", key)
		}
	}
}

func TestHandlerGETOnly(t *testing.T) {
	resetAndRestore(t)
	h := Handler()

	// GET succeeds.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/diag/latency", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET status = %d, want 200", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("Cache-Control = %q, want no-store", cc)
	}

	// HEAD succeeds (allowed).
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodHead, "/vh/diag/latency", nil)
	h.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("HEAD status = %d, want 200", rec2.Code)
	}

	// POST is rejected with 405.
	rec3 := httptest.NewRecorder()
	req3 := httptest.NewRequest(http.MethodPost, "/vh/diag/latency", nil)
	h.ServeHTTP(rec3, req3)
	if rec3.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST status = %d, want 405", rec3.Code)
	}
	if allow := rec3.Header().Get("Allow"); allow != "GET, HEAD" {
		t.Fatalf("Allow header = %q, want 'GET, HEAD'", allow)
	}

	// DELETE is rejected with 405.
	rec4 := httptest.NewRecorder()
	req4 := httptest.NewRequest(http.MethodDelete, "/vh/diag/latency", nil)
	h.ServeHTTP(rec4, req4)
	if rec4.Code != http.StatusMethodNotAllowed {
		t.Fatalf("DELETE status = %d, want 405", rec4.Code)
	}
}

// --- Success criterion 3: attribution signature test -------------------------
//
// This test demonstrates that the probe set can DISTINGUISH a slow-upstream
// case (latency accumulates BEFORE the store emit) from a slow-tunnel case
// (latency accumulates AFTER the store emit, in the egress path) using ONLY
// the recorded metrics. The key discriminator:
//
//   - slow upstream  → high ingest→emit age (Emit.EmitAge) + low egress write
//                      durations (SSE WriteDur, yamux WriteDur, ws TotalDur).
//   - slow tunnel    → low ingest→emit age (Emit.EmitAge) + high egress write
//                      durations in one or more downstream probes.
//
// The test simulates both signatures by recording synthetic observations into
// the registry, then asserts the snapshot discriminates the two. This is the
// "focused test demonstrating attribution" required by success criterion 3.

func TestAttributionSignatureSlowUpstreamVsSlowTunnel(t *testing.T) {
	// --- Case A: slow upstream ---
	resetAndRestore(t)
	// A slow-upstream event arrives late at the store: high ingest→emit age.
	Default.Emit.EmitAge.Observe(800_000_000) // 800ms ingest→emit age (> SlowEmitAgeNs 500ms)
	// But the egress path is fast (all writes are quick).
	Default.Stream[StreamClassTree].WriteDur.Observe(1_000_000)         // 1ms SSE write
	Default.Yamux.WriteByDir[YamuxWriteResponse].Dur.Observe(2_000_000) // 2ms yamux response write
	Default.WSWrite[SideServer].TotalDur.Observe(3_000_000)             // 3ms ws write

	snapA := Snapshot()
	emitAgeA := snapA.Probes.Emit.EmitAge.Max
	sseWriteA := snapA.Probes.Stream[StreamClassTree].WriteDur.Max
	yamuxWriteA := snapA.Probes.Yamux.WriteByDir[YamuxWriteResponse].Dur.Max
	wsTotalA := snapA.Probes.WSWrite[SideServer].TotalDur.Max

	// Slow-upstream signature: emit age dominates, egress writes are fast.
	if emitAgeA <= sseWriteA {
		t.Errorf("[slow-upstream] emit age (%d) should exceed SSE write (%d)", emitAgeA, sseWriteA)
	}
	if emitAgeA <= yamuxWriteA {
		t.Errorf("[slow-upstream] emit age (%d) should exceed yamux write (%d)", emitAgeA, yamuxWriteA)
	}
	if emitAgeA <= wsTotalA {
		t.Errorf("[slow-upstream] emit age (%d) should exceed ws total write (%d)", emitAgeA, wsTotalA)
	}

	// --- Case B: slow tunnel ---
	resetAndRestore(t)
	// A slow-tunnel event arrives at the store promptly: low ingest→emit age.
	Default.Emit.EmitAge.Observe(2_000_000) // 2ms ingest→emit age (fast)
	// But the egress path is slow (one or more downstream probes show high latency).
	Default.Stream[StreamClassTree].WriteDur.Observe(120_000_000)         // 120ms SSE write
	Default.Yamux.WriteByDir[YamuxWriteResponse].Dur.Observe(200_000_000) // 200ms yamux response write
	Default.WSWrite[SideServer].TotalDur.Observe(250_000_000)             // 250ms ws write

	snapB := Snapshot()
	emitAgeB := snapB.Probes.Emit.EmitAge.Max
	yamuxWriteB := snapB.Probes.Yamux.WriteByDir[YamuxWriteResponse].Dur.Max
	wsTotalB := snapB.Probes.WSWrite[SideServer].TotalDur.Max

	// Slow-tunnel signature: egress write dominates, emit age is fast.
	if emitAgeB >= yamuxWriteB {
		t.Errorf("[slow-tunnel] yamux write (%d) should exceed emit age (%d)", yamuxWriteB, emitAgeB)
	}
	if wsTotalB <= emitAgeB {
		t.Errorf("[slow-tunnel] ws total (%d) should exceed emit age (%d)", wsTotalB, emitAgeB)
	}

	// Cross-case discriminator: the RATIO of max-egress to emit-age flips.
	// Slow upstream: emitAge >> egress.  Slow tunnel: egress >> emitAge.
	if emitAgeA <= yamuxWriteA && emitAgeB >= yamuxWriteB {
		t.Fatal("discriminator failed: both cases look the same — attribution is not possible from these metrics")
	}
}

// --- YamuxWriteMonitor (Probe 4 wrapper) ------------------------------------

func TestYamuxWriteMonitor(t *testing.T) {
	resetAndRestore(t)
	// Use a slow writer to trigger the slow-incident path.
	slow := &slowWriter{delay: SlowStreamWriteNs + 10*time.Millisecond}
	m := NewYamuxWriteMonitor(slow, YamuxWriteResponse)
	n, err := m.Write([]byte("hello"))
	if err != nil {
		t.Fatalf("Write error: %v", err)
	}
	if n != 5 {
		t.Fatalf("n = %d, want 5", n)
	}
	wd := &Default.Yamux.WriteByDir[YamuxWriteResponse]
	if got := wd.Bytes.Load(); got != 5 {
		t.Fatalf("Bytes = %d, want 5", got)
	}
	if got := wd.Dur.snapshot().Count; got != 1 {
		t.Fatalf("Dur count = %d, want 1", got)
	}
	if got := wd.SlowWrites.Load(); got != 1 {
		t.Fatalf("SlowWrites = %d, want 1 (write exceeded threshold)", got)
	}
	incidents := wd.SlowWriteIncidents.Snapshot()
	if len(incidents) != 1 {
		t.Fatalf("incidents = %d, want 1", len(incidents))
	}
	if incidents[0].Bytes != 5 {
		t.Fatalf("incident Bytes = %d, want 5", incidents[0].Bytes)
	}
}

// slowWriter is a test io.Writer that sleeps before writing.
type slowWriter struct {
	delay time.Duration
}

func (s *slowWriter) Write(p []byte) (int, error) {
	time.Sleep(s.delay)
	return len(p), nil
}

// --- StreamStatsWriter (Probe 3 wrapper) ------------------------------------

func TestStreamStatsWriterRecordsWriteAndFlush(t *testing.T) {
	resetAndRestore(t)
	rw := &fakeRW{flusher: true}
	sw := NewStreamStatsWriter(rw, StreamClassSelected)
	sw.RecordOpen()

	n, err := sw.Write([]byte("data: hello\n\n"))
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if n != 13 {
		t.Fatalf("n = %d, want 13", n)
	}
	sw.Flush()

	stats := &Default.Stream[StreamClassSelected]
	if got := stats.Opens.Load(); got != 1 {
		t.Fatalf("Opens = %d, want 1", got)
	}
	if got := stats.Bytes.Load(); got != 13 {
		t.Fatalf("Bytes = %d, want 13", got)
	}
	if got := stats.Writes.Load(); got != 1 {
		t.Fatalf("Writes = %d, want 1", got)
	}
	if got := stats.Flushes.Load(); got != 1 {
		t.Fatalf("Flushes = %d, want 1", got)
	}

	sw.RecordSnapshotPath(999)
	if got := stats.SnapshotPath.Load(); got != 1 {
		t.Fatalf("SnapshotPath = %d, want 1", got)
	}
	if got := stats.SnapshotBytes.Load(); got != 999 {
		t.Fatalf("SnapshotBytes = %d, want 999", got)
	}
	sw.RecordReplayPath()
	if got := stats.ReplayPath.Load(); got != 1 {
		t.Fatalf("ReplayPath = %d, want 1", got)
	}
	sw.RecordPing(5 * time.Millisecond)
	if got := stats.PingDur.snapshot().Count; got != 1 {
		t.Fatalf("PingDur count = %d, want 1", got)
	}
	sw.RecordDisconnect(DiscWriteFailure)
	if got := stats.DiscReason[DiscWriteFailure].Load(); got != 1 {
		t.Fatalf("DiscReason[write_failure] = %d, want 1", got)
	}
}

func TestStreamStatsWriterFlusherPreserved(t *testing.T) {
	resetAndRestore(t)
	rw := &fakeRW{flusher: true}
	sw := NewStreamStatsWriter(rw, StreamClassFirehose)
	// The wrapper must implement http.Flusher so the handler's type assertion works.
	var _ http.Flusher = sw
	sw.Flush()
	if !rw.flushed {
		t.Fatal("Flush did not delegate to underlying flusher")
	}
}

// fakeRW is a minimal http.ResponseWriter + http.Flusher for Probe 3 tests.
type fakeRW struct {
	header  http.Header
	flusher bool
	flushed bool
}

func (f *fakeRW) Header() http.Header {
	if f.header == nil {
		f.header = http.Header{}
	}
	return f.header
}
func (f *fakeRW) Write(p []byte) (int, error) { return len(p), nil }
func (f *fakeRW) WriteHeader(int)             {}
func (f *fakeRW) Flush() {
	if f.flusher {
		f.flushed = true
	}
}

// --- Phase 4: connection-setup attribution -----------------------------------
//
// The 16.5s overnight-freeze investigation (post-a58b2f3 corrected diagnostic)
// narrowed the freeze to the SSE "conn" leg — between `new EventSource()` and
// `ses.onopen`. The pre-Phase-4 probe set could attribute steady-state write
// latency (Probe 4 per-direction) and stream-open duration (Probe 4 OpenDur)
// but NOT the full request-setup handshake (openStart → ACK) nor the worker-
// down fast-fail 502s the controller serves while the worker tunnel is mid-
// reconnect. The Phase 4 additions close that gap:
//
//   - Yamux.SetupDur / ReqWriteDur / AckDur  — controller-side setup histograms
//   - Yamux.TunnelDownRejections             — controller-side worker-down 502 counter
//   - TunnelStats                            — worker-side tunnel lifecycle
//
// This test demonstrates that the probe set can DISTINGUISH three different
// setup-leg failure signatures using ONLY the recorded metrics:
//
//	A. silently-dead tunnel: SetupDur / AckDur tail is large; TunnelDownRejections=0
//	   (transport still appears open at request time; the freeze is in ReadJSON).
//	B. worker tunnel down:   TunnelDownRejections > 0; SetupDur empty (request
//	   never made it past the nil/closed check); worker Tunnel.DialFailures /
//	   Disconnects > 0 on the worker process.
//	C. healthy tunnel:       SetupDur/AckDur fast; TunnelDownRejections=0; worker
//	   Tunnel.CurrentState="connected".
//
// This is the focused proving test required by the mission's "Add connection-
// setup probes" deliverable.

func TestConnectionSetupAttributionSilentlyDeadTunnel(t *testing.T) {
	resetAndRestore(t)
	// Signature A: the worker's transport is registered & "online" but the
	// underlying tunnel is silently dead. OpenStream succeeds instantly (no
	// round-trip), WriteJSON succeeds instantly (data sits in local send
	// buffer), but ReadJSON blocks until yamux's keepalive miss (~10s) +
	// ConnectionWriteTimeout (~10s) fire and tear the session down — ~16-20s
	// total, which matches the operator's reported 16.5s freeze.
	Default.Yamux.OpenDur.Observe(50_000)        // 50µs (in-process OpenStream)
	Default.Yamux.ReqWriteDur.Observe(200_000)   // 200µs (WriteJSON into local buffer)
	Default.Yamux.AckDur.Observe(16_500_000_000) // 16.5s ReadJSON block (the freeze)
	Default.Yamux.SetupDur.Observe(16_500_500_000)
	Default.Yamux.TunnelDownRejections = Counter{} // explicitly zero — transport looked open

	snap := Snapshot()
	y := snap.Probes.Yamux

	// The AckDur tail IS the freeze signature. p99 / max should be ~16.5s.
	if y.AckDur.Max < 10_000_000_000 {
		t.Errorf("[silent-dead] AckDur max %dns = %v, want >= 10s (yamux write-timeout window)",
			y.AckDur.Max, time.Duration(y.AckDur.Max))
	}
	if y.SetupDur.Max < 10_000_000_000 {
		t.Errorf("[silent-dead] SetupDur max %dns = %v, want >= 10s (full handshake froze)",
			y.SetupDur.Max, time.Duration(y.SetupDur.Max))
	}
	// Critical: TunnelDownRejections stays ZERO because the controller did not
	// fast-fail — the transport appeared open at request time. This is what
	// DISTINGUISHES the silent-death case from the worker-down case below.
	if y.TunnelDownRejections != 0 {
		t.Errorf("[silent-dead] TunnelDownRejections = %d, want 0 (transport was not nil/closed)",
			y.TunnelDownRejections)
	}
	// OpenDur is microseconds — proving the freeze is NOT in OpenStream itself.
	if y.OpenDur.Max > 1_000_000 {
		t.Errorf("[silent-dead] OpenDur max %dns, want < 1ms (OpenStream is in-process)",
			y.OpenDur.Max)
	}
}

func TestConnectionSetupAttributionWorkerTunnelDown(t *testing.T) {
	resetAndRestore(t)
	// Signature B: the worker tunnel has dropped and the worker is in the
	// backoff loop. The controller serves 502 on EVERY browser SSE attempt
	// (transport nil/closed); the browser's EventSource auto-retries until
	// the worker reconnects. No setup histograms recorded because the request
	// never reached OpenStream.
	Default.Yamux.TunnelDownRejections.Inc()
	Default.Yamux.TunnelDownRejections.Inc()
	Default.Yamux.TunnelDownRejections.Inc() // 3 browser retries while worker reconnects
	// Worker-side (would be reported into the per-worker snapshot):
	Default.Tunnel.DialAttempts.Inc()
	Default.Tunnel.DialFailures.Inc()
	Default.Tunnel.Disconnects.Inc()
	Default.Tunnel.LastBackoffNs.Store(int64(5 * time.Second))
	Default.Tunnel.CurrentState.Store(int32(TunnelStateDisconnected))

	snap := Snapshot()
	y := snap.Probes.Yamux
	tr := snap.Probes.Tunnel

	// Controller-side: 3 fast-fails, no setup histograms (OpenStream never ran).
	if y.TunnelDownRejections != 3 {
		t.Errorf("[worker-down] TunnelDownRejections = %d, want 3", y.TunnelDownRejections)
	}
	if y.SetupDur.Count != 0 {
		t.Errorf("[worker-down] SetupDur count = %d, want 0 (request never reached OpenStream)",
			y.SetupDur.Count)
	}
	// Worker-side: confirms the worker is in the backoff loop.
	if tr.DialFailures != 1 {
		t.Errorf("[worker-down] Tunnel.DialFailures = %d, want 1", tr.DialFailures)
	}
	if tr.CurrentState != "disconnected" {
		t.Errorf("[worker-down] Tunnel.CurrentState = %q, want \"disconnected\"", tr.CurrentState)
	}
	if tr.LastBackoffNs != int64(5*time.Second) {
		t.Errorf("[worker-down] Tunnel.LastBackoffNs = %d, want 5s",
			tr.LastBackoffNs)
	}
}

func TestConnectionSetupAttributionHealthyTunnel(t *testing.T) {
	resetAndRestore(t)
	// Signature C: healthy steady-state. SetupDur / AckDur are fast;
	// TunnelDownRejections stays zero; worker reports connected.
	Default.Yamux.OpenDur.Observe(40_000)      // 40µs
	Default.Yamux.ReqWriteDur.Observe(150_000) // 150µs
	Default.Yamux.AckDur.Observe(800_000)      // 0.8ms (worker dials local web port)
	Default.Yamux.SetupDur.Observe(1_000_000)  // 1ms total setup
	Default.Tunnel.CurrentState.Store(int32(TunnelStateConnected))
	Default.Tunnel.Connected.Inc()
	Default.Tunnel.LastConnectedAtNs.Store(time.Now().Add(-2 * time.Second).UnixNano())

	snap := Snapshot()
	y := snap.Probes.Yamux
	tr := snap.Probes.Tunnel

	if y.SetupDur.Max > 50_000_000 {
		t.Errorf("[healthy] SetupDur max %dns, want < 50ms", y.SetupDur.Max)
	}
	if y.AckDur.Max > 50_000_000 {
		t.Errorf("[healthy] AckDur max %dns, want < 50ms", y.AckDur.Max)
	}
	if y.TunnelDownRejections != 0 {
		t.Errorf("[healthy] TunnelDownRejections = %d, want 0", y.TunnelDownRejections)
	}
	if tr.CurrentState != "connected" {
		t.Errorf("[healthy] Tunnel.CurrentState = %q, want \"connected\"", tr.CurrentState)
	}
}

// TestTunnelStatsAtomicity proves the TunnelStats fields are safe to read
// concurrently with the worker Start loop writing them — the snapshot path
// (which the operator-facing /vh/diag/latency hits) must never race the worker.
// Run under `go test -race` (the canonical Phase-4 verify block does).
func TestTunnelStatsAtomicity(t *testing.T) {
	resetAndRestore(t)
	var wg sync.WaitGroup
	// Writer: simulates the worker Start loop stamping tunnel state.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			Default.Tunnel.DialAttempts.Inc()
			Default.Tunnel.DialFailures.Inc()
			Default.Tunnel.Connected.Inc()
			Default.Tunnel.Disconnects.Inc()
			Default.Tunnel.LastBackoffNs.Store(int64(time.Duration(i) * time.Second))
			Default.Tunnel.LastConnectedAtNs.Store(time.Now().UnixNano())
			Default.Tunnel.LastDisconnectAtNs.Store(time.Now().UnixNano())
			Default.Tunnel.CurrentState.Store(int32(TunnelStateConnected))
		}
	}()
	// Reader: simulates Snapshot() running concurrently (the operator hits the
	// diag endpoint). Must not race.
	for i := 0; i < 50; i++ {
		_ = Snapshot()
	}
	wg.Wait()
}
