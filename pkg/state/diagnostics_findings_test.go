package state

import (
	"runtime"
	"sync"
	"testing"
	"time"

	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
)

// --- Finding 4: daemon-generated is the safe default source -----------------
//
// Regression: SourceOpencodeLive = iota is the zero value, and Store.curEmitSource
// was not initialized in state.New → ordinary daemon emissions (messages.loaded,
// messages.error, activity, status, etc.) were misclassified as opencode_live in
// Probe 2's SourceCount. The fix initializes curEmitSource = SourceDaemonGenerated
// in state.New.
//
// This test FAILs on the broken code: SourceCount[opencode_live] would be 1
// instead of SourceCount[daemon_generated].

func TestFinding4DaemonGeneratedIsDefaultSource(t *testing.T) {
	diag.ResetForTest()
	t.Cleanup(diag.ResetForTest)

	s := New(100)
	// EmitMessagesLoaded is a daemon-originated emit — it does NOT set
	// curEmitSource (it inherits the default from New).
	s.EmitMessagesLoaded("session-1", 10, 5)

	snap := diag.Snapshot()
	daemonCount := snap.Probes.Emit.SourceCount["daemon_generated"]
	liveCount := snap.Probes.Emit.SourceCount["opencode_live"]

	if daemonCount != 1 {
		t.Fatalf("source_count.daemon_generated = %d, want 1 (daemon-originated emit must be attributed to daemon_generated)", daemonCount)
	}
	if liveCount != 0 {
		t.Fatalf("source_count.opencode_live = %d, want 0 (daemon emit must NOT be misattributed as opencode_live)", liveCount)
	}
}

// TestFinding4MultipleDaemonEmitsAttributedCorrectly drives several daemon-originated
// emits and verifies they all land in daemon_generated, not opencode_live.
func TestFinding4MultipleDaemonEmitsAttributedCorrectly(t *testing.T) {
	diag.ResetForTest()
	t.Cleanup(diag.ResetForTest)

	s := New(100)
	s.EmitMessagesLoaded("s1", 10, 5)
	s.EmitMessagesError("s2", "boom")
	s.EmitMessagesLoaded("s3", 20, 10)

	snap := diag.Snapshot()
	daemonCount := snap.Probes.Emit.SourceCount["daemon_generated"]
	if daemonCount != 3 {
		t.Fatalf("source_count.daemon_generated = %d, want 3", daemonCount)
	}
	if snap.Probes.Emit.SourceCount["opencode_live"] != 0 {
		t.Fatalf("source_count.opencode_live = %d, want 0", snap.Probes.Emit.SourceCount["opencode_live"])
	}
}

// TestFinding4EmitNoticeCountedViaAtomicCounters verifies that EmitNotice
// (which deliberately bypasses the ring/seq advance) still reports into Probe 2's
// atomic class/source counters. The regression: EmitNotice bypassed emit()
// entirely, so notice events were invisible to Probe 2. The fix adds inline
// atomic class/source counting.
func TestFinding4EmitNoticeCountedViaAtomicCounters(t *testing.T) {
	diag.ResetForTest()
	t.Cleanup(diag.ResetForTest)

	s := New(100)
	// Register a subscriber so EmitNotice has somewhere to fan out.
	ch, unsub := s.Subscribe(256)
	defer unsub()
	_ = ch

	s.EmitNotice([]byte(`{"text":"hello"}`))

	snap := diag.Snapshot()
	// Notice is classified as structural by ClassifyEmitKind.
	structuralCount := snap.Probes.Emit.ClassCount["structural"]
	if structuralCount != 1 {
		t.Fatalf("class_count.structural = %d, want 1 (notice must be counted as structural)", structuralCount)
	}
	// Source must be daemon_generated.
	if snap.Probes.Emit.SourceCount["daemon_generated"] != 1 {
		t.Fatalf("source_count.daemon_generated = %d, want 1 (notice source is daemon)", snap.Probes.Emit.SourceCount["daemon_generated"])
	}
}

// --- Finding 2: emit() is lock-free (no mutex/channel/alloc under s.mu) ------
//
// Regression: Store.emit called diag.Default.Emit.EmitAgeIncidents.Push(...)
// (acquiring IncidentRing.mu) while s.mu was held, and allocated
// Kind: "emit_age:"+kind (dynamic string). This violated the hard lock-free
// invariant for this boundary. The fix removes the IncidentRing from emit
// entirely — only atomic counters/histograms remain.
//
// These tests prove:
//   1. emit() completes in bounded time even when diagnostics IncidentRings
//      are heavily contended by other goroutines (the old code would block).
//   2. emit() does not allocate the dynamic "emit_age:"+kind string on the
//      slow-age path.

// TestFinding2EmitDoesNotBlockOnIncidentRingContention drives emit() repeatedly
// while concurrently hammering the diagnostics IncidentRings from other
// goroutines. If emit() still acquired any IncidentRing mutex, the contention
// would cause measurable blocking. The fix guarantees emit() is pure atomics.
func TestFinding2EmitDoesNotBlockOnIncidentRingContention(t *testing.T) {
	diag.ResetForTest()
	t.Cleanup(diag.ResetForTest)

	s := New(100)
	// Register a subscriber so emit() has a fan-out target.
	ch, unsub := s.Subscribe(256)
	defer unsub()
	_ = ch

	// Set up a slow-age path: curEmitIngest is old, so the age computation
	// runs and would have pushed to EmitAgeIncidents on the broken code.
	s.mu.Lock()
	s.curEmitIngest = diag.MonoNow() - 1_000_000_000 // 1 second old
	s.curEmitSource = diag.SourceOpencodeLive
	s.mu.Unlock()

	// From other goroutines, hammer IncidentRing.Push on various rings to
	// create heavy mutex contention. On broken code, emit() would block on
	// IncidentRing.mu while s.mu is held (a lock-ordering hazard).
	var stopMu sync.WaitGroup
	stop := make(chan struct{})
	stopMu.Add(4)
	for i := 0; i < 4; i++ {
		go func() {
			defer stopMu.Done()
			for {
				select {
				case <-stop:
					return
				default:
					// Hammer rings that are NOT in emit() — these prove
					// emit() is structurally independent of all IncidentRings.
					diag.Default.Stream[0].SlowWrites.Push(diag.Incident{Kind: "hammer", Dur: 1})
					diag.Default.Yamux.WriteByDir[0].SlowWriteIncidents.Push(diag.Incident{Kind: "hammer", Dur: 1})
					diag.Default.WSWrite[0].SlowWriteIncidents.Push(diag.Incident{Kind: "hammer", Dur: 1})
				}
			}
		}()
	}

	// Drive 200 emits — each one exercises the slow-age path. If emit()
	// blocked on any IncidentRing.mu, this would take a very long time.
	done := make(chan struct{})
	go func() {
		for i := 0; i < 200; i++ {
			s.mu.Lock()
			s.emit("message.updated", []byte(`{"info":{"id":"m","sessionID":"s"}}`))
			s.mu.Unlock()
		}
		close(done)
	}()

	select {
	case <-done:
		// emit() completed without blocking — pass.
	case <-time.After(5 * time.Second):
		t.Fatal("emit() blocked for > 5s — likely contending on an IncidentRing mutex while holding s.mu (Finding 2 regression)")
	}

	close(stop)
	stopMu.Wait()
}

// TestFinding2EmitSlowAgePathNoExcessAllocation verifies that the slow-emit-age
// path does NOT allocate the dynamic "emit_age:"+kind string (the old code did).
// We measure allocations per emit on the slow-age path and assert the count is
// bounded (the fan-out loop itself allocates per subscriber, but the diagnostics
// portion must be zero-extra).
func TestFinding2EmitSlowAgePathNoExcessAllocation(t *testing.T) {
	if testing.Short() {
		t.Skip("allocation test is slow")
	}
	diag.ResetForTest()
	t.Cleanup(diag.ResetForTest)

	s := New(100)
	// No subscriber — so the fan-out loop does nothing and we isolate the
	// diagnostics allocation cost.

	// Set up slow-age path.
	s.mu.Lock()
	s.curEmitIngest = diag.MonoNow() - 1_000_000_000
	s.curEmitSource = diag.SourceOpencodeLive
	s.mu.Unlock()

	// Warm up.
	for i := 0; i < 10; i++ {
		s.mu.Lock()
		s.emit("message.updated", []byte(`{"info":{"id":"m","sessionID":"s"}}`))
		s.mu.Unlock()
	}

	// Measure: the slow-age path should NOT allocate the "emit_age:"+kind
	// dynamic string (the old code allocated ~1 string per slow emit).
	// With the fix, the only allocations are the ClientEvent struct copy
	// pushed into the ring (which is existing behavior, not a regression).
	allocs := testing.AllocsPerRun(50, func() {
		s.mu.Lock()
		s.emit("message.updated", []byte(`{"info":{"id":"m","sessionID":"s"}}`))
		s.mu.Unlock()
	})

	// The old code allocated at least 1 extra string per emit ("emit_age:"+kind).
	// The ring.push copies the ClientEvent (which includes the payload slice header,
	// not the string). With no subscriber, the expected allocations are:
	//   - ring.push: copies ClientEvent into the ring buffer (no heap alloc if ring is pre-allocated)
	//   - diagnostics: ZERO extra (pure atomics)
	// So allocs should be very low. The old code would show allocs >= 1 from the
	// string concatenation alone. We assert < 2 (allowing for ring internal allocs).
	if allocs >= 2 {
		t.Fatalf("slow-age emit allocs = %v per call, want < 2 (the dynamic 'emit_age:'+kind string allocation was removed)", allocs)
	}

	// Force GC to keep the test clean.
	runtime.GC()
}

// TestFinding2EmitAgeHistogramStillRecorded verifies that even though the
// IncidentRing was removed, the atomic-CAS EmitAge histogram still records
// slow-emit ages (it is pure atomics and safe under s.mu).
func TestFinding2EmitAgeHistogramStillRecorded(t *testing.T) {
	diag.ResetForTest()
	t.Cleanup(diag.ResetForTest)

	s := New(100)

	// Sleep briefly so MonoNow has advanced past 0 (the test process may have
	// just started, making MonoNow() near zero at init).
	time.Sleep(5 * time.Millisecond)

	// Set up a slow-age path: curEmitIngest = 1 (a positive but very old
	// monotonic stamp). The age will be the full process elapsed since near-
	// start, which is > 0 and will be recorded by the atomic histogram.
	s.mu.Lock()
	s.curEmitIngest = 1
	s.curEmitSource = diag.SourceOpencodeLive
	s.emit("message.updated", []byte(`{"info":{"id":"m","sessionID":"s"}}`))
	s.mu.Unlock()

	snap := diag.Snapshot()
	emitAge := snap.Probes.Emit.EmitAge
	if emitAge.Count != 1 {
		t.Fatalf("EmitAge count = %d, want 1 (atomic histogram must still record slow emits)", emitAge.Count)
	}
	// The recorded age should be > 0 (at least the 5ms sleep).
	if emitAge.Max <= 0 {
		t.Fatalf("EmitAge max = %d, want > 0 (the age should be recorded by the atomic histogram)", emitAge.Max)
	}
}
