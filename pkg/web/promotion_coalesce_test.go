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
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/diagnostics"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

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

// sessionCreatedEvent builds a session.created opencode.Event for direct store
// seeding. newReloadServer hydrates fake.sessions ONCE at aggregator startup, so
// appending after the server is built is too late — applying session.created
// directly to the store is synchronous and immediate (mirrors the seeding in
// snapshot_isolation_test.go). The session is then present for HasSession + the
// subsequent status-burst.
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

	srv, fake, _, web := newReloadServer(t)
	_ = fake
	// Seed 5 root sessions via direct store.Apply (newReloadServer hydrates
	// fake.sessions once at startup, so post-build append is too late).
	for i := 0; i < 5; i++ {
		srv.agg.Store().Apply(sessionCreatedEvent(fmt.Sprintf("s%d", i)))
	}
	waitFor(t, func() bool { return srv.agg.Store().HasSession("s4") },
		"seed 5 root sessions")

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

	srv, fake, _, web := newReloadServer(t)
	_ = fake
	srv.agg.Store().Apply(sessionCreatedEvent("only"))
	waitFor(t, func() bool { return srv.agg.Store().HasSession("only") },
		"seed 1 root session")

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

	srv, fake, _, web := newReloadServer(t)
	_ = fake
	srv.agg.Store().Apply(sessionCreatedEvent("x"))
	waitFor(t, func() bool { return srv.agg.Store().HasSession("x") },
		"seed 1 root session")

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
