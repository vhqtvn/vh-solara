package web

// Demotion-sweep proving tests for the Phase-2 time-based demotion fix.
//
// The sweep goroutine (Store.RunDemotionSweep) catches TIME-DRIVEN demotion:
// a session that aged past the cutoff with no accompanying event. These tests
// prove the two invariants that must hold alongside the positive e2e case
// (tests/e2e/projection_demotion_test.go → TestProjectionDemotion_SweepDemotesOnAlreadyOpenStream):
//
//  1. NEGATIVE: a sweep with NOTHING due (a BUSY session — busy sessions have no
//     demotion deadline) emits ZERO promotion snapshots. Guards against
//     reintroducing the amplifier (a timer that re-projects unconditionally).
//  2. ANTI-THRASH: a session touched within the cutoff is never demoted by the
//     sweep. Mirrors TestProjection_NoThrash_RecentStaysActive (pkg/state) but
//     through the sweep→handleStream SSE path.
//
// These use the same deterministic seam as promotion_coalesce_test.go
// (newNoPollServer — no aggregator poll loop). The sweep goroutine is started
// manually via startDemotionSweep because newNoPollServer deliberately does
// NOT start aggregator.Run (where RunDemotionSweep is launched in production).

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// startDemotionSweep launches the store's demotion-sweep goroutine bound to a
// context canceled on test cleanup. The cutoff policy MUST be armed via
// SetProjectionCutoffForTest BEFORE calling this so the ticker interval is
// correct from the first tick (and the projectionCutoffChanged poke is
// consumed cleanly).
func startDemotionSweep(t *testing.T, srv *Server) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go srv.agg.Store().RunDemotionSweep(ctx)
}

// countPromotions returns how many of the snapshot causes are "promotion".
func countPromotions(causes []string) int {
	n := 0
	for _, c := range causes {
		if c == "promotion" {
			n++
		}
	}
	return n
}

// TestDemotionSweep_NothingDueEmitsNoPromotion is the NEGATIVE test: a sweep
// with nothing demotion-eligible must NOT emit any promotion snapshot. A BUSY
// session is never stub-eligible (subtreeBusyCount > 0 keeps it in the active
// closure regardless of cutoff), so the sweep ticks repeatedly with no shrink.
// Modelled as the inverse of TestPromotionCoalesce_BurstShipsOneSnapshot.
//
// FAIL-without: if the sweep (or any timer path) re-projects unconditionally
// (the old amplifier behavior), promotion snapshots would fire on every tick.
// PASS-with: the sweep signals ONLY on genuine shrink; a busy session never
// shrinks out → zero promotions.
func TestDemotionSweep_NothingDueEmitsNoPromotion(t *testing.T) {
	withPromotionCoalesce(t, 50*time.Millisecond)

	srv, web := newNoPollServer(t)
	seedSessionDirect(t, srv, "busy1")
	// Drive the session busy BEFORE opening the stream so its busy state is
	// baked into the initial snapshot (no structural event arms promotion
	// post-stream-open). A busy session is always in the active closure.
	srv.agg.Store().Apply(statusBusyEvent("busy1"))

	// Arm a shrunk cutoff so the sweep ticks fast. Set BEFORE starting the
	// sweep so the ticker interval is correct from tick one.
	const cutoff = 200 * time.Millisecond
	state.SetProjectionCutoffForTest(cutoff, 2)
	t.Cleanup(func() { state.SetProjectionCutoffForTest(0, 0) })

	sweepInterval := srv.agg.Store().SweepInterval()

	startDemotionSweep(t, srv)

	// Open the stream with a deadline that covers many sweep intervals. The
	// body closes at the deadline, unblocking drainSnapshotCauses.
	deadline := 4*sweepInterval + 300*time.Millisecond
	reader, _ := openProjectedStream(t, web.URL, deadline)

	// Consume the initial snapshot (cause:"initial") — this also sets
	// lastNotifiedClosure = {busy1: true} via SnapshotProjected.
	if initEv, _ := readSSEFrameSilent(reader); initEv != "snapshot" {
		t.Fatalf("first frame want snapshot, got %q", initEv)
	}

	// No further events applied. The sweep ticks ~(deadline / sweepInterval)
	// times; busy1 never leaves the active closure → no shrink → no signal.
	causes := drainSnapshotCauses(t, reader)
	if promoCount := countPromotions(causes); promoCount != 0 {
		t.Fatalf("negative: busy session (nothing due): want 0 promotion snapshots over %v (sweepInterval=%v), got %d (causes=%v) — sweep is signaling without a genuine shrink",
			deadline, sweepInterval, promoCount, causes)
	}
}

// statusIdleEvent builds a session.status idle opencode.Event for a direct
// store.Apply. "idle" maps to ActivityIdle (normalizeActivity default branch) —
// the RECENCY-GATED state: the session's presence in the active closure depends
// on lastActivityAt staying within the cutoff, unlike busy/retry which are
// always self-active. busy→idle is a real transition that advances
// lastActivityAt to now and does NOT arm FrontierChanged (wasSelfActive=true).
func statusIdleEvent(id string) opencode.Event {
	return opencode.Event{
		Type:       "session.status",
		Properties: json.RawMessage(fmt.Sprintf(`{"sessionID":%q,"status":{"type":"idle"}}`, id)),
	}
}

// TestDemotionSweep_RecentActivityNotDemoted is the ANTI-THRASH test: a
// recency-gated (idle) session whose lastActivityAt stays within the cutoff is
// never demoted by the sweep. This is the genuine anti-thrash scenario — the
// session is NOT busy-exempt (it is idle), so its continued materialization
// depends entirely on recency. Mirrors TestProjection_NoThrash_RecentStaysActive
// (pkg/state) but through the full sweep→handleStream SSE path.
//
// The session is driven busy→idle (real transition → lastActivityAt=now,
// recency-gated) BEFORE the stream opens, then re-touched at cutoff/2 via
// idle→busy→idle (two real transitions that advance lastActivityAt). Neither
// re-touch arms FrontierChanged: at cutoff/2 lastActivityAt is within cutoff →
// wasSelfActive=true → no event-driven promotion. So the only thing that could
// ship a snapshot is the sweep, which must see no shrink → zero promotions.
//
// FAIL-without: if the sweep demotes on timer-elapsed-alone (ignoring
// recency), a recently-touched recency-gated session would be stubbed.
// PASS-with: the sweep only signals genuine aging past cutoff.
func TestDemotionSweep_RecentActivityNotDemoted(t *testing.T) {
	withPromotionCoalesce(t, 50*time.Millisecond)

	srv, web := newNoPollServer(t)
	seedSessionDirect(t, srv, "recent1")
	// Drive busy then IDLE so the session is RECENCY-GATED (not busy-exempt):
	// its presence in the active closure depends on lastActivityAt staying
	// within the cutoff. busy→idle is a real transition that advances
	// lastActivityAt to now; it does NOT arm FrontierChanged (wasSelfActive).
	srv.agg.Store().Apply(statusBusyEvent("recent1"))
	srv.agg.Store().Apply(statusIdleEvent("recent1"))

	// Cutoff long enough that a mid-window re-touch keeps the session within
	// the recency window for the remainder of the test.
	const cutoff = 400 * time.Millisecond
	state.SetProjectionCutoffForTest(cutoff, 2)
	t.Cleanup(func() { state.SetProjectionCutoffForTest(0, 0) })

	sweepInterval := srv.agg.Store().SweepInterval()

	startDemotionSweep(t, srv)

	// Stream deadline = cutoff + margin. After re-touch at cutoff/2, the
	// remaining window is cutoff/2 + margin, which is < cutoff → the session
	// stays within recency for every tick until the body closes.
	deadline := cutoff + 100*time.Millisecond
	reader, _ := openProjectedStream(t, web.URL, deadline)

	if initEv, _ := readSSEFrameSilent(reader); initEv != "snapshot" {
		t.Fatalf("first frame want snapshot, got %q", initEv)
	}

	// Re-touch the session at cutoff/2 via REAL activity transitions
	// (idle→busy→idle) so lastActivityAt advances and stays within the cutoff
	// for the remainder of the window. Neither transition arms FrontierChanged
	// (lastActivityAt is within cutoff → wasSelfActive=true at both flips).
	time.Sleep(cutoff / 2)
	srv.agg.Store().Apply(statusBusyEvent("recent1"))
	srv.agg.Store().Apply(statusIdleEvent("recent1"))

	causes := drainSnapshotCauses(t, reader)
	if promoCount := countPromotions(causes); promoCount != 0 {
		t.Fatalf("anti-thrash: recently-touched recency-gated session demoted by sweep: want 0 promotion snapshots over %v (sweepInterval=%v, cutoff=%v), got %d (causes=%v) — sweep is demoting a session still within the cutoff",
			deadline, sweepInterval, cutoff, promoCount, causes)
	}
}

// TestDemotionSweep_PerStreamFanout_BothStreamsReceive proves the demotion
// signal fans out to EVERY concurrent proj=1 stream, not just one. Under the
// old store-global consuming CAS (ConsumeTimeFrontierChange), exactly ONE of N
// open projected streams would ship the demotion snapshot; the others kept the
// session materialized until an unrelated frontier change or reconnect. With
// the per-stream demotionGen signal, each handleStream independently detects
// the gen has advanced since its last-seen value and arms the promotion path.
//
// FAIL-without (old CAS): only one of the two streams receives a promotion.
// PASS-with (per-stream gen): BOTH streams receive ≥1 promotion.
func TestDemotionSweep_PerStreamFanout_BothStreamsReceive(t *testing.T) {
	withPromotionCoalesce(t, 50*time.Millisecond)

	srv, web := newNoPollServer(t)
	seedSessionDirect(t, srv, "dem1")
	// Drive dem1 BUSY so it is self-active (busy sessions are always in the
	// active closure) at stream-open time. busy→idle is applied AFTER both
	// initial snapshots are read so both streams see dem1 as active initially;
	// busy→idle does NOT arm FrontierChanged (wasSelfActive=true), so no
	// event-driven promotion fires — the only snapshot after initial is the
	// sweep-driven demotion.
	srv.agg.Store().Apply(statusBusyEvent("dem1"))

	const cutoff = 300 * time.Millisecond
	state.SetProjectionCutoffForTest(cutoff, 2)
	t.Cleanup(func() { state.SetProjectionCutoffForTest(0, 0) })

	sweepInterval := srv.agg.Store().SweepInterval()

	startDemotionSweep(t, srv)

	// Deadline covers: two stream opens + initial reads, then busy→idle apply,
	// then cutoff aging, then one sweep tick (shrink detection) + one
	// sweepTicker poll per stream + the coalesce window, plus margin.
	deadline := cutoff + 8*sweepInterval + 300*time.Millisecond

	r1, _ := openProjectedStream(t, web.URL, deadline)
	r2, _ := openProjectedStream(t, web.URL, deadline)

	// Consume each initial snapshot (cause:"initial") so the only remaining
	// snapshots are the sweep-driven demotion promotions.
	if initEv, _ := readSSEFrameSilent(r1); initEv != "snapshot" {
		t.Fatalf("stream1 first frame want snapshot, got %q", initEv)
	}
	if initEv, _ := readSSEFrameSilent(r2); initEv != "snapshot" {
		t.Fatalf("stream2 first frame want snapshot, got %q", initEv)
	}

	// busy→idle: dem1 becomes recency-gated (self-active only while
	// lastActivityAt stays within the cutoff). No FrontierChanged → no
	// event-driven promotion. dem1 then ages past the cutoff → the sweep
	// detects the shrink and bumps demotionGen.
	srv.agg.Store().Apply(statusIdleEvent("dem1"))

	// Drain BOTH streams concurrently. A sequential drain (r1 then r2) would
	// stop reading r2 while blocked on r1's EOF; r2's server-side flush would
	// then block on a full TCP buffer and freeze its select loop before the
	// sweepTicker could arm. Concurrent draining keeps both connections flowing.
	var causes1, causes2 []string
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); causes1 = drainSnapshotCauses(t, r1) }()
	go func() { defer wg.Done(); causes2 = drainSnapshotCauses(t, r2) }()
	wg.Wait()

	if c1 := countPromotions(causes1); c1 < 1 {
		t.Fatalf("stream1: per-stream demotion fanout failed: want ≥1 promotion (demotion), got %d (causes=%v) — under the old store-global CAS only one stream claimed the signal", c1, causes1)
	}
	if c2 := countPromotions(causes2); c2 < 1 {
		t.Fatalf("stream2: per-stream demotion fanout failed: want ≥1 promotion (demotion), got %d (causes=%v) — under the old store-global CAS only one stream claimed the signal", c2, causes2)
	}
}
