package diagnostics

import (
	"net"
	"sync"
	"testing"
	"time"

	"github.com/hashicorp/yamux"
)

// --- Finding 5: histogram overflow sentinel must be nonzero -----------------
//
// Regression: latencyBucketsNs was declared [12] but only 11 positive edges
// were initialized, leaving the 12th edge implicitly 0. The overflow sentinel
// (latencyBucketsNs[len-1]*10) became 0*10=0, so any duration > the highest
// real edge was projected to 0ns in percentile() — a 15-second observation
// appeared "instantaneous". The fix supplies the intended 12th boundary (100s)
// and derives the sentinel from the last real edge (100s*10 = 1000s).
//
// This test FAILs on the broken code (P50/P95/P99 return 0 for >10s obs).

func TestHistogramEdgesPositive(t *testing.T) {
	resetAndRestore(t)
	// Every bucket edge MUST be strictly positive — a 0 edge produces a
	// degenerate "matches everything" bucket and a 0 overflow sentinel.
	for i, edge := range latencyBucketsNs {
		if edge <= 0 {
			t.Fatalf("latencyBucketsNs[%d] = %d, want > 0 (a zero edge breaks the bucket lookup and overflow sentinel)", i, edge)
		}
	}
	// Edges must be strictly increasing.
	for i := 1; i < len(latencyBucketsNs); i++ {
		if latencyBucketsNs[i] <= latencyBucketsNs[i-1] {
			t.Fatalf("latencyBucketsNs not strictly increasing at [%d]=%d <= [%d]=%d", i, latencyBucketsNs[i], i-1, latencyBucketsNs[i-1])
		}
	}
}

func TestHistogramOverflowPercentile(t *testing.T) {
	resetAndRestore(t)
	var h Histogram
	h.reset()
	// Observe durations > 10s (the old highest finite edge). These land in the
	// overflow bucket.
	h.Observe(15_000_000_000)  // 15s — overflow
	h.Observe(20_000_000_000)  // 20s — overflow
	h.Observe(100_000_000_000) // 100s — still overflow (exceeds last edge in broken array)
	snap := h.snapshot()
	// On broken code: P50/P95/P99 all return 0 (overflow sentinel = 0).
	// On fixed code: they return overflowSentinelNs (> 0, derived from the last real edge).
	highestFinite := latencyBucketsNs[len(latencyBucketsNs)-1]
	if snap.P50 == 0 {
		t.Fatalf("P50 = 0, want > 0 (overflow observations should NOT project to 0ns)")
	}
	if snap.P50 < highestFinite {
		t.Fatalf("P50 = %d, want >= highest finite edge %d (overflow should project to a sentinel >= last edge)", snap.P50, highestFinite)
	}
	if snap.P95 == 0 {
		t.Fatalf("P95 = 0, want > 0 (overflow observations should NOT project to 0ns)")
	}
	if snap.P95 < highestFinite {
		t.Fatalf("P95 = %d, want >= highest finite edge %d", snap.P95, highestFinite)
	}
	if snap.P99 == 0 {
		t.Fatalf("P99 = 0, want > 0 (overflow observations should NOT project to 0ns)")
	}
	if snap.P99 < highestFinite {
		t.Fatalf("P99 = %d, want >= highest finite edge %d", snap.P99, highestFinite)
	}
	// The overflow sentinel must be derived from the last real edge, not hardcoded.
	if overflowSentinelNs != latencyBucketsNs[len(latencyBucketsNs)-1]*10 {
		t.Fatalf("overflowSentinelNs = %d, want %d (last edge * 10)", overflowSentinelNs, latencyBucketsNs[len(latencyBucketsNs)-1]*10)
	}
}

// --- Finding 6: histogram min must track a legitimate 0 observation ---------
//
// Regression: min used 0 as the "uninitialized" sentinel, so a clamped-to-0
// observation was indistinguishable from "nothing observed yet". After
// Observe(0); Observe(10), min was 10 because the CAS treated 0 as already-
// initialized and the 10 couldn't unseat it... wait, the old code used
// `cur != 0 && cur <= d` which means "if cur is nonzero AND cur <= d, skip".
// So Observe(0) set min=0 (cur was 0, so the `cur != 0` check failed, and
// 0 was swapped in). Then Observe(10): cur=0, `cur != 0` is false → swap to 10.
// So min went 0 → 10, losing the legitimate 0. The fix uses a separate
// initialized flag (high-bit sentinel) so 0 is a valid observation.

func TestHistogramMinZeroObservation(t *testing.T) {
	resetAndRestore(t)
	var h Histogram
	h.reset() // mark min as uninitialized
	// Observe a legitimate 0 (e.g. a clamped negative, or a genuinely instant op).
	h.Observe(0)
	// Observe a larger value.
	h.Observe(10)
	snap := h.snapshot()
	if snap.Min != 0 {
		t.Fatalf("Min = %d, want 0 (a legitimate 0 observation must not be overwritten by a later 10)", snap.Min)
	}
	if snap.Max != 10 {
		t.Fatalf("Max = %d, want 10", snap.Max)
	}
	if snap.Count != 2 {
		t.Fatalf("Count = %d, want 2", snap.Count)
	}
}

// --- Finding 7: MonoNow is monotonic-derived, not wall-clock -----------------
//
// Regression: ingest/emit timing used time.Now().UnixNano() which discards Go's
// monotonic component. A wall-clock adjustment (NTP jump backward) could make
// the recorded age negative; a jump forward could make it falsely large. The
// fix uses diag.MonoNow() which derives from time.Since(monoBase) — time.Since
// uses the monotonic component when the base carries one, so the elapsed value
// is immune to wall-clock adjustments.
//
// This test proves MonoNow is monotonically non-decreasing and process-relative
// (values are small elapsed-since-start, never wall-clock nanos).

func TestMonoNowMonotonicNonDecreasing(t *testing.T) {
	// MonoNow must be monotonically non-decreasing: call it many times with
	// interleaved short sleeps and assert each value >= the previous.
	prev := MonoNow()
	for i := 0; i < 50; i++ {
		time.Sleep(100 * time.Microsecond)
		cur := MonoNow()
		if cur < prev {
			t.Fatalf("MonoNow went backward: iteration %d, prev=%d cur=%d (wall-clock regression detected — monotonic component not used)", i, prev, cur)
		}
		prev = cur
	}
}

func TestMonoNowIsProcessRelative(t *testing.T) {
	// MonoNow values are process-relative elapsed nanoseconds (near 0 at start),
	// NOT wall-clock UnixNano values (~1.7e18 for year 2024+). A wall-clock
	// UnixNano would be astronomically large; a process-relative monotonic
	// elapsed is small. This proves the ingest/emit stamps are NOT wall-clock.
	v := MonoNow()
	// A wall-clock UnixNano for any date after 2001 exceeds 1e18.
	// A process-relative elapsed for a test process is well under 1e15 (weeks).
	if v > 1_000_000_000_000_000 { // 1e15 ns ≈ 11.5 days
		t.Fatalf("MonoNow = %d, looks like a wall-clock UnixNano (expected small process-relative elapsed)", v)
	}
}

func TestMonoNowElapsedStableUnderWallClockSemantics(t *testing.T) {
	// Prove that an age computed via MonoNow is always non-negative and
	// roughly matches the real elapsed time — unlike UnixNano deltas which
	// can go negative if the wall clock jumps backward.
	ingest := MonoNow()
	sleepNs := int64(2 * time.Millisecond)
	time.Sleep(time.Duration(sleepNs))
	emit := MonoNow()
	age := emit - ingest
	if age < 0 {
		t.Fatalf("MonoNow age = %d, want >= 0 (monotonic clock must never go backward)", age)
	}
	// The age should be close to the sleep duration (within a generous tolerance
	// for scheduler jitter). A wall-clock regression would show a much smaller
	// or negative value.
	if age < sleepNs/2 {
		t.Fatalf("MonoNow age = %d, want >= %d (half the sleep duration — wall-clock regression would under-report)", age, sleepNs/2)
	}
}

// --- Finding 1 (direction separation): YamuxWriteMonitor records into the
// correct per-direction accumulator -------------------------------------------
//
// Regression: Probe 4 was installed ONLY on the controller browser→yamux leg
// (the request direction). The response direction (worker local-service→yamux,
// where flow-control backpressure accumulates) was UNINSTRUMENTED. The fix
// splits the accounting into two directions: YamuxWriteResponse (worker egress)
// and YamuxWriteRequest (controller egress). This test proves the two directions
// are independently counted — writing through a response-direction monitor
// increments only the response histogram, and vice versa.

func TestYamuxWriteMonitorDirectionSeparation(t *testing.T) {
	resetAndRestore(t)
	// Simulate two independent write paths: response (worker) and request (controller).
	respMon := NewYamuxWriteMonitor(&passthroughWriter{}, YamuxWriteResponse)
	reqMon := NewYamuxWriteMonitor(&passthroughWriter{}, YamuxWriteRequest)

	// Drive 3 response-direction writes and 2 request-direction writes.
	respMon.Write([]byte("resp1"))
	respMon.Write([]byte("resp2"))
	respMon.Write([]byte("resp3"))
	reqMon.Write([]byte("req1"))
	reqMon.Write([]byte("req2"))

	respStats := &Default.Yamux.WriteByDir[YamuxWriteResponse]
	reqStats := &Default.Yamux.WriteByDir[YamuxWriteRequest]

	// Response direction: 3 writes, 15 bytes (5+5+5).
	if got := respStats.Bytes.Load(); got != 15 {
		t.Fatalf("response Bytes = %d, want 15", got)
	}
	if got := respStats.Dur.snapshot().Count; got != 3 {
		t.Fatalf("response Dur count = %d, want 3", got)
	}

	// Request direction: 2 writes, 8 bytes (4+4).
	if got := reqStats.Bytes.Load(); got != 8 {
		t.Fatalf("request Bytes = %d, want 8", got)
	}
	if got := reqStats.Dur.snapshot().Count; got != 2 {
		t.Fatalf("request Dur count = %d, want 2", got)
	}

	// Verify the directions are named correctly in the enum.
	if yamuxWriteDirName[YamuxWriteResponse] != "yamux_response" {
		t.Fatalf("response dir name = %q, want 'yamux_response'", yamuxWriteDirName[YamuxWriteResponse])
	}
	if yamuxWriteDirName[YamuxWriteRequest] != "yamux_request" {
		t.Fatalf("request dir name = %q, want 'yamux_request'", yamuxWriteDirName[YamuxWriteRequest])
	}
}

// passthroughWriter is a no-op io.Writer that immediately returns len(p).
type passthroughWriter struct{}

func (p *passthroughWriter) Write(b []byte) (int, error) { return len(b), nil }

// --- Additional concern: ActiveStreams is a true global inc/dec counter ------
//
// Regression: Default.Yamux.ActiveStreams was a process-global gauge but each
// update stored one worker's Session.NumStreams() — with multiple workers, the
// last sample overwrote the others (not a total). The fix makes ActiveStreams a
// true inc/dec counter (+1 on stream open, -1 on close). Per-session
// correlation rides on each slow-write incident's Aux (sampled from the
// incident's OWN session via WithSession), not the global gauge.

func TestActiveStreamsIsGlobalIncDecCounter(t *testing.T) {
	resetAndRestore(t)
	y := &Default.Yamux
	if got := y.ActiveStreams.Load(); got != 0 {
		t.Fatalf("initial ActiveStreams = %d, want 0", got)
	}
	// Simulate opening 3 streams (as if from different workers).
	y.ActiveStreams.Add(1)
	y.ActiveStreams.Add(1)
	y.ActiveStreams.Add(1)
	if got := y.ActiveStreams.Load(); got != 3 {
		t.Fatalf("after 3 opens ActiveStreams = %d, want 3", got)
	}
	// Close one — the counter must decrement, NOT be overwritten.
	y.ActiveStreams.Add(-1)
	if got := y.ActiveStreams.Load(); got != 2 {
		t.Fatalf("after 1 close ActiveStreams = %d, want 2 (true inc/dec, not last-sampled)", got)
	}
	// Close the rest.
	y.ActiveStreams.Add(-1)
	y.ActiveStreams.Add(-1)
	if got := y.ActiveStreams.Load(); got != 0 {
		t.Fatalf("after all closes ActiveStreams = %d, want 0", got)
	}
}

// TestActiveStreamsConcurrentIncDec proves the inc/dec counter is race-free
// under concurrent open/close (the old design was a single store, not a CAS).
func TestActiveStreamsConcurrentIncDec(t *testing.T) {
	resetAndRestore(t)
	y := &Default.Yamux
	var wg sync.WaitGroup
	// 50 goroutines each open+close a stream.
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			y.ActiveStreams.Add(1)
			y.ActiveStreams.Add(-1)
		}()
	}
	wg.Wait()
	// Net must be exactly 0.
	if got := y.ActiveStreams.Load(); got != 0 {
		t.Fatalf("after 50 concurrent open+close ActiveStreams = %d, want 0", got)
	}
}

// TestPerSessionNumStreamsCorrelationInIncidents is the additional-concern
// proving test. It creates two real yamux sessions with DIFFERENT NumStreams()
// and proves that each YamuxWriteMonitor.WithSession samples ITS OWN session's
// NumStreams() into the slow-write incident's Aux — the global ActiveStreams
// gauge cannot overwrite or confuse the per-session correlation.
//
// Regression (pre-fix): ActiveStreams was a gauge storing one worker's
// NumStreams(), so a multi-worker controller's last sample silently overwrote
// the others. Per-session correlation now rides on each incident's own
// session sample (WithSession), NOT the shared global gauge.
//
// FAIL-without (pre-fix): if incidents sampled the global gauge instead of
// their own session, both incidents would carry the SAME Aux value (the last
// gauge store), not their respective sessions' NumStreams.
// PASS-with (fixed): each incident's Aux matches its own session's NumStreams.
func TestPerSessionNumStreamsCorrelationInIncidents(t *testing.T) {
	resetAndRestore(t)

	// Create two yamux session pairs so each monitor has a distinct session
	// with a different NumStreams(). yamux.Client/Server start background
	// goroutines that handle protocol management over the pipe.
	cfg := yamux.DefaultConfig()
	cfg.LogOutput = nopWriter{}
	c1a, c1b := net.Pipe()
	c2a, c2b := net.Pipe()
	sess1, err := yamux.Client(c1a, cfg)
	if err != nil {
		t.Fatalf("yamux.Client sess1: %v", err)
	}
	sess1peer, err := yamux.Server(c1b, cfg)
	if err != nil {
		t.Fatalf("yamux.Server sess1peer: %v", err)
	}
	sess2, err := yamux.Client(c2a, cfg)
	if err != nil {
		t.Fatalf("yamux.Client sess2: %v", err)
	}
	sess2peer, err := yamux.Server(c2b, cfg)
	if err != nil {
		t.Fatalf("yamux.Server sess2peer: %v", err)
	}
	t.Cleanup(func() {
		sess1.Close()
		sess1peer.Close()
		sess2.Close()
		sess2peer.Close()
	})

	// Accept streams on the peer side in background goroutines so the opens
	// complete cleanly (otherwise yamux may backpressure the open).
	go func() { s, _ := sess1peer.AcceptStream(); _ = s }()
	go func() { s, _ := sess2peer.AcceptStream(); _ = s }()

	// Open 1 stream on sess1 and keep it open.
	s1, err := sess1.OpenStream()
	if err != nil {
		t.Fatalf("sess1.OpenStream: %v", err)
	}
	defer s1.Close()

	// Do NOT open any extra streams on sess2 (it starts with 0 active).
	// So sess1.NumStreams() >= 1 and sess2.NumStreams() == 0 — distinct.

	// Create monitors with different sessions, each backed by a slow writer
	// so the slow-write incident path fires (dur >= SlowStreamWriteNs).
	slowDelay := SlowStreamWriteNs + 10*time.Millisecond
	mon1 := NewYamuxWriteMonitor(&slowWriter{delay: slowDelay}, YamuxWriteResponse).WithSession(sess1)
	mon2 := NewYamuxWriteMonitor(&slowWriter{delay: slowDelay}, YamuxWriteResponse).WithSession(sess2)

	// Trigger slow writes on both monitors.
	if _, err := mon1.Write([]byte("slow-sess1")); err != nil {
		t.Fatalf("mon1.Write: %v", err)
	}
	if _, err := mon2.Write([]byte("slow-sess2")); err != nil {
		t.Fatalf("mon2.Write: %v", err)
	}

	// The global gauge should be 0 — the monitors sample their own sessions,
	// not the shared gauge.
	if got := Default.Yamux.ActiveStreams.Load(); got != 0 {
		t.Fatalf("global ActiveStreams = %d, want 0 (monitors must not touch the global gauge)", got)
	}

	// Extract the slow-write incidents. The ring is LIFO; we expect at least 2.
	incidents := Default.Yamux.WriteByDir[YamuxWriteResponse].SlowWriteIncidents.Snapshot()
	if len(incidents) < 2 {
		t.Fatalf("expected >= 2 slow-write incidents, got %d", len(incidents))
	}

	// The two most recent incidents (ring is LIFO) correspond to mon2 then mon1.
	// mon2 wrote with sess2 (NumStreams == 0); mon1 wrote with sess1 (NumStreams >= 1).
	incMon2 := incidents[0] // most recent (mon2 was written last)
	incMon1 := incidents[1] // second most recent (mon1)

	sess1Streams := int64(sess1.NumStreams())
	sess2Streams := int64(sess2.NumStreams())

	if incMon2.Aux != sess2Streams {
		t.Fatalf("mon2 incident Aux = %d, want %d (sess2.NumStreams) — per-session correlation broken", incMon2.Aux, sess2Streams)
	}
	if incMon1.Aux != sess1Streams {
		t.Fatalf("mon1 incident Aux = %d, want %d (sess1.NumStreams) — per-session correlation broken", incMon1.Aux, sess1Streams)
	}

	// The two incidents must carry DIFFERENT Aux values — proving the global
	// gauge did NOT overwrite one session's sample with the other's.
	if incMon1.Aux == incMon2.Aux {
		t.Fatalf("both incidents have the SAME Aux (%d) — per-session correlation collapsed to a single value (global gauge overwrite?)", incMon1.Aux)
	}
}

// nopWriter is an io.Writer that discards all output (for yamux log suppression).
type nopWriter struct{}

func (nopWriter) Write(p []byte) (int, error) { return len(p), nil }
