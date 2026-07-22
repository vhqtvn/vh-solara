package web

// Promotion-coalescing proving tests for the tunnel-volume amplifier #1 fix.
//
// Before the fix, handleStream re-snapshotted + re-shipped the whole
// active-closure projection on EVERY structural event (IsStructuralKind includes
// KindActivity). With 373 active children flipping busy/idle, that was the
// dominant tunnel volume (~150 MB/hr at rest in the live study). The fix
// coalesces a burst of structural events into ONE promotion snapshot per
// promotionCoalesceInterval window, and records the diagnostic counter at the
// promotion write site (it previously undercounted — RecordSnapshotPath was
// only on the initial-snapshot branch).
//
// These three tests are the FAIL-without/PASS-with proof:
//   1. a burst of N structural events within the coalesce window → exactly ONE
//      promotion snapshot shipped (not N);
//   2. a structural event followed by a quiet period → one snapshot ships
//      within the bounded window (the real-timer guarantee, not a lazy check);
//   3. the instrumented SnapshotPath counter increments on the promotion path
//      (no longer undercounts).

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/diagnostics"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// newNoPollServer builds a web Server backed by a fresh store with NO
// aggregator poll loop running. The promotion coalesce tests apply events
// directly to the store (store.Apply), so they don't need the aggregator's
// concurrent /events tail — and that tail is the source of nondeterministic
// interference (re-hydration re-applies, event bursts that fill subscriber
// channels, timing-dependent subscriber drops). Without the poll loop, these
// tests are fully deterministic.
func newNoPollServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	agg := aggregator.New("http://unused.local", 100)
	srv, err := NewServer(agg, "http://unused.local", 1000)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(func() {
		web.CloseClientConnections()
		web.Close()
	})
	return srv, web
}

// seedSessionDirect applies a session.created event directly to the store
// (synchronous, no aggregator poll loop needed). Used with newNoPollServer.
func seedSessionDirect(t *testing.T, srv *Server, id string) {
	t.Helper()
	srv.agg.Store().Apply(sessionCreatedEvent(id))
}

// withPromotionCoalesce temporarily overrides the package-level
// promotionCoalesceInterval (mirrors the deltaFlushInterval override pattern in
// pkg/state/delta_coalesce_test.go) so the coalescing tests are deterministic
// without relying on the 150ms production default. Restored via t.Cleanup.
func withPromotionCoalesce(t *testing.T, d time.Duration) {
	t.Helper()
	prev := promotionCoalesceInterval
	promotionCoalesceInterval = d
	t.Cleanup(func() { promotionCoalesceInterval = prev })
}

// openProjectedStream opens a /vh/stream?sessions=&proj=1 tree stream bound to
// a deadline-bounded context and returns the response body reader plus a cancel
// func. The empty ?sessions= makes it a tree-class stream (StreamClassTree);
// proj=1 opts into the projection path so structural events arm the promotion
// coalescer. z is left absent so snapshot data is raw JSON (parsable for cause).
func openProjectedStream(t *testing.T, webURL string, deadline time.Duration) (*bufio.Reader, context.CancelFunc) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), deadline)
	t.Cleanup(cancel)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet,
		webURL+"/vh/stream?sessions=&proj=1", nil)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	return bufio.NewReader(resp.Body), cancel
}

// drainSnapshotCauses reads SSE frames until the body closes (ctx deadline) and
// returns the `cause` field of every snapshot frame seen. Non-snapshot frames
// (activity, ping) are skipped. Returns when readSSEFrameSilent yields ("","").
func drainSnapshotCauses(t *testing.T, r *bufio.Reader) []string {
	t.Helper()
	var causes []string
	for {
		ev, data := readSSEFrameSilent(r)
		if ev == "" {
			return causes
		}
		if ev != "snapshot" {
			continue
		}
		var snap struct {
			Cause string `json:"cause"`
		}
		_ = json.Unmarshal([]byte(data), &snap)
		causes = append(causes, snap.Cause)
	}
}

// statusRetryEvent builds a session.status retry opencode.Event. retry↔busy is
// a wasBusy==isBusy transition (both count as "busy" for subtreeBusyCount), so
// it is the exact amplifier case: before the Phase-2 frontier gate it armed a
// full re-snapshot on every flip of an already-active session; after the gate
// it must NOT arm (frontierSeq is unchanged by busy↔retry).
func statusRetryEvent(id string) opencode.Event {
	return opencode.Event{
		Type:       "session.status",
		Properties: json.RawMessage(fmt.Sprintf(`{"sessionID":%q,"status":{"type":"retry"}}`, id)),
	}
}

// statusBusyEvent builds a session.status busy opencode.Event for a direct
// store.Apply (synchronous, deterministic — bypasses the fake.events poll loop
// so a burst of N events lands in the subscriber channel within microseconds,
// well inside the coalesce window). busy is KindActivity → structural.
func statusBusyEvent(id string) opencode.Event {
	return opencode.Event{
		Type:       "session.status",
		Properties: json.RawMessage(fmt.Sprintf(`{"sessionID":%q,"status":{"type":"busy"}}`, id)),
	}
}

// sessionCreatedEvent builds a session.created opencode.Event for direct
// store seeding via seedSessionDirect (used with newNoPollServer, which has
// no aggregator poll loop and no fake backend).
func sessionCreatedEvent(id string) opencode.Event {
	return opencode.Event{
		Type:       "session.created",
		Properties: json.RawMessage(fmt.Sprintf(`{"info":{"id":%q,"title":%q}}`, id, id)),
	}
}

// TestPromotionCoalesce_BurstShipsOneSnapshot is the core proof: a burst of N
// structural events within the coalesce window must re-ship ONE promotion
// snapshot, not N. FAIL-without (un-throttled path ships N) / PASS-with.
func TestPromotionCoalesce_BurstShipsOneSnapshot(t *testing.T) {
	withPromotionCoalesce(t, 80*time.Millisecond)

	srv, web := newNoPollServer(t)
	// Seed 5 root sessions directly to the store (no aggregator poll loop →
	// deterministic: no re-hydration interference, no subscriber drops).
	for i := 0; i < 5; i++ {
		seedSessionDirect(t, srv, fmt.Sprintf("s%d", i))
	}
	if !srv.agg.Store().HasSession("s4") {
		t.Fatal("seed 5 root sessions: s4 missing")
	}

	reader, _ := openProjectedStream(t, web.URL, 600*time.Millisecond)
	// Consume the initial snapshot frame (cause:"initial").
	initEv, _ := readSSEFrameSilent(reader)
	if initEv != "snapshot" {
		t.Fatalf("first frame want snapshot, got %q", initEv)
	}

	// Counter snapshot AFTER the initial snapshot's increment is recorded: the
	// delta over the burst window is exactly the promotion snapshots shipped.
	counterBefore := diagnostics.Default.Stream[diagnostics.StreamClassTree].SnapshotPath.Load()

	// Fire a tight burst of 5 structural (KindActivity) events. Direct store
	// Apply emits to the subscriber channel synchronously under s.mu, so all 5
	// land in the handler well inside the 80ms coalesce window.
	for i := 0; i < 5; i++ {
		srv.agg.Store().Apply(statusBusyEvent(fmt.Sprintf("s%d", i)))
	}

	causes := drainSnapshotCauses(t, reader)
	promoCount := 0
	for _, c := range causes {
		if c == "promotion" {
			promoCount++
		}
	}
	if promoCount != 1 {
		t.Fatalf("burst of 5 structural events: want exactly 1 promotion snapshot, got %d (causes=%v)",
			promoCount, causes)
	}

	counterAfter := diagnostics.Default.Stream[diagnostics.StreamClassTree].SnapshotPath.Load()
	if got := counterAfter - counterBefore; got != 1 {
		t.Fatalf("SnapshotPath counter delta: want 1 (one coalesced promotion), got %d (undercount or over-ship)",
			got)
	}
}

// TestPromotionCoalesce_QuietPeriodFlushesWithinWindow proves the real-timer
// guarantee: a single structural event followed by a quiet period still flushes
// ONE promotion snapshot within the bounded coalesce window. The lazy-check
// pattern (deltaFlushInterval) would strand the last event until the next one
// arrived; this test fails under that design. FAIL-without / PASS-with.
func TestPromotionCoalesce_QuietPeriodFlushesWithinWindow(t *testing.T) {
	const window = 90 * time.Millisecond
	withPromotionCoalesce(t, window)

	srv, web := newNoPollServer(t)
	seedSessionDirect(t, srv, "only")
	if !srv.agg.Store().HasSession("only") {
		t.Fatal("seed 1 root session: only missing")
	}

	reader, _ := openProjectedStream(t, web.URL, 700*time.Millisecond)
	initEv, _ := readSSEFrameSilent(reader)
	if initEv != "snapshot" {
		t.Fatalf("first frame want snapshot, got %q", initEv)
	}

	// One structural event, then silence. The promotion must flush within the
	// window even though no further events arrive to trigger a lazy check.
	t0 := time.Now()
	srv.agg.Store().Apply(statusBusyEvent("only"))

	// Read frames until the promotion snapshot lands (or the body closes).
	var promoAt time.Time
	for {
		ev, _ := readSSEFrameSilent(reader)
		if ev == "" {
			if promoAt.IsZero() {
				t.Fatal("stream closed before any promotion snapshot shipped")
			}
			break
		}
		if ev == "snapshot" {
			promoAt = time.Now()
			break
		}
	}
	elapsed := promoAt.Sub(t0)
	// The flush must land inside window + a generous scheduler/IO margin. The
	// important bound is that it DOES flush (not strand) and is O(window), not
	// the 15s ping interval.
	if elapsed > window+500*time.Millisecond {
		t.Fatalf("promotion flush latency: want < %v, got %v (window=%v)",
			window+500*time.Millisecond, elapsed, window)
	}
}

// TestPromotionCoalesce_DiagnosticCounterIncrements is the focused proof for
// the instrumentation gap (Fix a): the promotion write path now records the
// snapshot_path counter, so the diagnostic no longer undercounts promotion
// volume. Before the fix the counter was calm while 150 MB/hr shipped. Captures
// the counter before/after a single promotion and asserts the delta is >= 1.
func TestPromotionCoalesce_DiagnosticCounterIncrements(t *testing.T) {
	withPromotionCoalesce(t, 60*time.Millisecond)

	srv, web := newNoPollServer(t)
	seedSessionDirect(t, srv, "x")
	if !srv.agg.Store().HasSession("x") {
		t.Fatal("seed 1 root session: x missing")
	}

	reader, _ := openProjectedStream(t, web.URL, 500*time.Millisecond)
	initEv, _ := readSSEFrameSilent(reader)
	if initEv != "snapshot" {
		t.Fatalf("first frame want snapshot, got %q", initEv)
	}

	counterBefore := diagnostics.Default.Stream[diagnostics.StreamClassTree].SnapshotPath.Load()
	srv.agg.Store().Apply(statusBusyEvent("x"))
	// Drain to let the coalesced promotion flush + record the counter.
	_ = drainSnapshotCauses(t, reader)

	counterAfter := diagnostics.Default.Stream[diagnostics.StreamClassTree].SnapshotPath.Load()
	if delta := counterAfter - counterBefore; delta < 1 {
		t.Fatalf("SnapshotPath counter did NOT increment on promotion path: before=%d after=%d (undercount bug present)",
			counterBefore, counterAfter)
	}
}

// TestPromotionCoalesce_ActivityFlipOfActiveSessionDoesNotResnapshot is THE
// proving test for the Phase-2 finding-B fix (frontier-membership gate). The
// amplifier the gate kills: EVERY activity flip of an already-materialized
// session — including the high-frequency busy↔retry churn of running subagents
// — used to arm promoCoalesce and re-ship a full ~74KB tree snapshot (because
// IsStructuralKind includes KindActivity). The frontier gate narrows the arm
// to genuine frontier changes only, so busy↔retry of an active session must
// NOT arm.
//
// Shape: seed one session, open a projected stream, drive ONE genuine
// promotion (idle → busy) and observe exactly one promotion snapshot; then
// drive a busy↔retry flip of that now-active session and observe ZERO further
// promotion snapshots. FAIL-without (frontier gate absent → retry arms a
// second snapshot) / PASS-with.
func TestPromotionCoalesce_ActivityFlipOfActiveSessionDoesNotResnapshot(t *testing.T) {
	const window = 70 * time.Millisecond
	withPromotionCoalesce(t, window)

	srv, web := newNoPollServer(t)
	seedSessionDirect(t, srv, "flip")
	if !srv.agg.Store().HasSession("flip") {
		t.Fatal("seed 1 root session: flip missing")
	}

	reader, _ := openProjectedStream(t, web.URL, 900*time.Millisecond)
	// Consume the initial snapshot frame (cause:"initial").
	if initEv, _ := readSSEFrameSilent(reader); initEv != "snapshot" {
		t.Fatalf("first frame want snapshot, got %q", initEv)
	}

	// --- Phase A: a genuine promotion (idle → busy) MUST ship one snapshot. ---
	promoBefore := diagnostics.Default.Stream[diagnostics.StreamClassTree].SnapshotPath.Load()
	srv.agg.Store().Apply(statusBusyEvent("flip"))

	// Read frames until the promotion snapshot lands. The activity delta frame
	// (event:"activity") may precede it; skip non-snapshot frames.
	var promotionSeen int
	deadlineA := time.Now().Add(window + 600*time.Millisecond)
	for time.Now().Before(deadlineA) {
		ev, data := readSSEFrameSilent(reader)
		if ev == "" {
			break
		}
		if ev == "snapshot" {
			var snap struct {
				Cause string `json:"cause"`
			}
			_ = json.Unmarshal([]byte(data), &snap)
			if snap.Cause == "promotion" {
				promotionSeen++
			}
		}
		if promotionSeen >= 1 {
			break
		}
	}
	if promotionSeen != 1 {
		t.Fatalf("Phase A (genuine promotion): want exactly 1 promotion snapshot, got %d", promotionSeen)
	}
	promoAfterBusy := diagnostics.Default.Stream[diagnostics.StreamClassTree].SnapshotPath.Load()
	if got := promoAfterBusy - promoBefore; got != 1 {
		t.Fatalf("Phase A counter: want 1 promotion, got %d", got)
	}

	// --- Phase B: a busy↔retry flip of the NOW-active session must NOT arm. ---
	// The promotion timer has fired and promoPending cleared. busy→retry does
	// not set FrontierChanged (wasSelfActive=true for an already-active
	// session), so the gate must be false. Drain to the ctx deadline:
	// no further "promotion" snapshot may appear.
	counterBeforeRetry := diagnostics.Default.Stream[diagnostics.StreamClassTree].SnapshotPath.Load()
	srv.agg.Store().Apply(statusRetryEvent("flip"))
	causes := drainSnapshotCauses(t, reader)
	promoRetry := 0
	for _, c := range causes {
		if c == "promotion" {
			promoRetry++
		}
	}
	counterAfterRetry := diagnostics.Default.Stream[diagnostics.StreamClassTree].SnapshotPath.Load()
	if promoRetry != 0 {
		t.Fatalf("Phase B (busy↔retry of active session): want 0 promotion snapshots, got %d (causes=%v) — frontier gate is NOT narrowing the amplifier",
			promoRetry, causes)
	}
	if got := counterAfterRetry - counterBeforeRetry; got != 0 {
		t.Fatalf("Phase B counter: want 0 (frontier gate killed the re-snapshot), got %d", got)
	}
}
