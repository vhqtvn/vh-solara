package aggregator

// reconcile_cadence_test.go — the tree reconcile must not re-fetch the full
// archived list on every tick. OpenCode ignores ?archived=true and returns ALL
// of a project's sessions, so doing it per tick on 10k+-session projects kept
// OpenCode's single JS thread pinned. The archived refresh is spaced by
// archivedSnapshotInterval (hydrate always refreshes), and onConnected fires
// once per OpenCode connection.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
)

// listCounter counts live (/session?limit=) vs archived (?archived=true) list
// requests, delegating everything to the fixture.
type listCounter struct {
	inner    http.Handler
	live     atomic.Int64
	archived atomic.Int64
}

func (c *listCounter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("archived") == "true" {
		c.archived.Add(1)
	} else {
		c.live.Add(1)
	}
	c.inner.ServeHTTP(w, r)
}

func runCountingAggregator(t *testing.T, tree, idle, archived time.Duration) (*Aggregator, *listCounter, func()) {
	t.Helper()
	fx := fixtures.New()
	cnt := &listCounter{inner: fx.Handler()}
	mux := http.NewServeMux()
	mux.Handle("/session", cnt) // exact path: only the list endpoint
	mux.Handle("/", fx.Handler())
	oc := httptest.NewServer(mux)

	agg := New(oc.URL, 100)
	agg.treeReconcileInterval = tree
	agg.treeReconcileIdleInterval = idle // set before Run: read by the reconcile goroutine
	agg.archivedSnapshotInterval = archived
	agg.statusReconcileInterval = time.Hour

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		agg.RunManaged(ctx)
		close(runDone)
	}()
	if !waitForAnyHydrateCompleted(agg, 5*time.Second) {
		cancel()
		oc.Close()
		t.Fatal("aggregator never hydrated")
	}
	stop := func() {
		cancel()
		select {
		case <-runDone:
		case <-time.After(5 * time.Second):
			t.Error("Run did not return after cancel")
		}
		agg.Stop()
		agg.waitColdSeed()
		oc.Close()
	}
	return agg, cnt, stop
}

func waitLiveTicks(t *testing.T, cnt *listCounter, atLeast int64) {
	t.Helper()
	end := time.Now().Add(5 * time.Second)
	for cnt.live.Load() < atLeast {
		if time.Now().After(end) {
			t.Fatalf("tree reconcile ticked only %d times, want >= %d", cnt.live.Load(), atLeast)
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// Many tree ticks, long archived interval → the archived list is fetched once
// (by hydrate), not once per tick.
func TestTreeReconcile_ArchivedRefreshNotPerTick(t *testing.T) {
	_, cnt, stop := runCountingAggregator(t, 5*time.Millisecond, 0, time.Hour)
	defer stop()
	waitLiveTicks(t, cnt, 12) // hydrate + ≥11 reconcile ticks
	if got := cnt.archived.Load(); got != 1 {
		t.Errorf("archived list fetched %d times across %d live-list fetches; want exactly 1 (hydrate only)", got, cnt.live.Load())
	}
}

// Regression (cold-start duplicate): the reconcile ticker spawns before the
// first hydrate runs, so a tick can observe lastArchivedRefresh==0 ("never
// refreshed yet") while the hydrate's own archived-snapshot fetch is still in
// flight — and fire a duplicate /session?archived=true concurrent with it.
// The handler below gates the release on an EVENT, not a timer: it holds
// archived responses until the live-list count reaches 3 (hydrate's own live
// fetch is #1, so ≥2 reconcile ticks have completed their live fetch and
// reached the archived-due decision) before letting them through. On ungated
// code the first tick's due-check necessarily passes while the hold is open
// (its live fetch made the count 2 < 3, so no archived response has completed
// and lastArchivedRefresh is still 0) and its duplicate is counted on arrival
// — ≥2 archived fetches are banked before any release, making the RED
// (archived != 1) deterministic regardless of tick/fetch timing ratios. What
// remains inherently scheduler-bound is the instruction-level ordering
// between one tick's live-fetch return and its due-check (unobservable from
// the HTTP handler), which is why the release waits for a whole extra tick's
// live fetch instead of trying to catch the check itself. The hold is also
// bounded (see the handler): ungated code deadlocks the release condition
// itself — the duplicate fetch freezes the single reconcile goroutine and the
// live count with it — so the cap turns that hang into the count failure
// above. archivedSnapshotDue must hold the tick off until a hydrate has
// completed (gate added there).
func TestTreeReconcile_NoArchivedDupWhileColdStartSnapshotInFlight(t *testing.T) {
	fx := fixtures.New()
	cnt := &listCounter{inner: fx.Handler()}
	mux := http.NewServeMux()
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("archived") == "true" {
			// Event-based release: hold archived responses until ≥2
			// reconcile ticks have completed their live fetch (hydrate's
			// live fetch is #1) — i.e. ticks have reached the archived-due
			// decision while the hydrate's own fetch is still in flight
			// and lastArchivedRefresh is still 0. The hold is bounded (and
			// well under waitForAnyHydrateCompleted's timeout): on ungated
			// code the duplicate tick fetch is itself held, which freezes
			// the single reconcile goroutine and with it the live count —
			// the cap lets every handler complete so the test fails on the
			// fetch count instead of hanging the server close.
			deadline := time.Now().Add(3 * time.Second)
			for cnt.live.Load() < 3 && time.Now().Before(deadline) {
				time.Sleep(time.Millisecond)
			}
		}
		cnt.ServeHTTP(w, r)
	})
	mux.Handle("/", fx.Handler())
	oc := httptest.NewServer(mux)
	defer oc.Close()

	agg := New(oc.URL, 100)
	agg.treeReconcileInterval = 5 * time.Millisecond
	agg.treeReconcileIdleInterval = 0
	agg.archivedSnapshotInterval = time.Hour
	agg.statusReconcileInterval = time.Hour

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		agg.RunManaged(ctx)
		close(runDone)
	}()
	if !waitForAnyHydrateCompleted(agg, 5*time.Second) {
		cancel()
		t.Fatal("aggregator never hydrated")
	}
	stop := func() {
		cancel()
		select {
		case <-runDone:
		case <-time.After(5 * time.Second):
			t.Error("Run did not return after cancel")
		}
		agg.Stop()
		agg.waitColdSeed()
	}
	defer stop()

	waitLiveTicks(t, cnt, 12)
	if got := cnt.archived.Load(); got != 1 {
		t.Errorf("archived list fetched %d times across %d live-list fetches; want exactly 1 (hydrate's in-flight fetch, no tick duplicate)", got, cnt.live.Load())
	}
}

// The retry branch: hydrate's own archived-snapshot fetch is best-effort —
// a failure leaves lastArchivedRefresh==0 and the snapshot stale, and the
// next reconcile tick (gate open, "never refreshed") must retry it. The
// handler below fails the FIRST archived arrival with a 500, then
// succeeds. The failed arrival is hydrate's own fetch: the
// completed-hydrate gate holds ticks off until after hydrate's fan-out, so
// no tick can reach the archived endpoint first. Both arrivals are counted
// (the failed one too — it is the retry trigger the assertion observes).
func TestTreeReconcile_RetriesArchivedSnapshotAfterHydrateFetchFailed(t *testing.T) {
	fx := fixtures.New()
	cnt := &listCounter{inner: fx.Handler()}
	var failArchived atomic.Bool
	failArchived.Store(true)
	mux := http.NewServeMux()
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Query().Get("archived") == "true" {
			cnt.archived.Add(1)
			if failArchived.CompareAndSwap(true, false) {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			cnt.inner.ServeHTTP(w, r)
			return
		}
		cnt.ServeHTTP(w, r)
	})
	mux.Handle("/", fx.Handler())
	oc := httptest.NewServer(mux)
	defer oc.Close()

	agg := New(oc.URL, 100)
	agg.treeReconcileInterval = 5 * time.Millisecond
	agg.treeReconcileIdleInterval = 0
	agg.archivedSnapshotInterval = time.Hour
	agg.statusReconcileInterval = time.Hour

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		agg.RunManaged(ctx)
		close(runDone)
	}()
	if !waitForAnyHydrateCompleted(agg, 5*time.Second) {
		cancel()
		t.Fatal("aggregator never hydrated")
	}
	stop := func() {
		cancel()
		select {
		case <-runDone:
		case <-time.After(5 * time.Second):
			t.Error("Run did not return after cancel")
		}
		agg.Stop()
		agg.waitColdSeed()
	}
	defer stop()

	// Hydrate's attempt (#1) failed; the next tick's retry (#2) must
	// succeed and refresh the snapshot. Long archived interval: any
	// further fetch beyond the retry is a spacing bug, but ≥2 is the
	// contract under test here.
	end := time.Now().Add(5 * time.Second)
	for cnt.archived.Load() < 2 {
		if time.Now().After(end) {
			t.Fatalf("archived fetch count %d; want >= 2 (hydrate's failed attempt + the tick's successful retry)", cnt.archived.Load())
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// Control: with a short archived interval the reconcile does refresh it
// periodically (the gate is spacing, not disabling).
func TestTreeReconcile_ArchivedRefreshStillPeriodic(t *testing.T) {
	_, cnt, stop := runCountingAggregator(t, 5*time.Millisecond, 0, 10*time.Millisecond)
	defer stop()
	end := time.Now().Add(5 * time.Second)
	for cnt.archived.Load() < 3 {
		if time.Now().After(end) {
			t.Fatalf("archived refresh ran %d times; want periodic refreshes (>= 3)", cnt.archived.Load())
		}
		time.Sleep(2 * time.Millisecond)
	}
}

// onConnected fires once per connection, after that connection's first
// successful hydrate — not on reconcile ticks.
func TestOnConnectedFiresOncePerConnection(t *testing.T) {
	fx := fixtures.New()
	oc := httptest.NewServer(fx.Handler())
	defer oc.Close()

	agg := New(oc.URL, 100)
	agg.treeReconcileInterval = 5 * time.Millisecond
	agg.statusReconcileInterval = time.Hour
	var fired atomic.Int64
	agg.SetOnConnected(func() {
		if !agg.AnyHydrateCompleted() {
			t.Error("onConnected fired before the connection's hydrate completed")
		}
		fired.Add(1)
	})

	ctx, cancel := context.WithCancel(context.Background())
	runDone := make(chan struct{})
	go func() {
		agg.RunManaged(ctx)
		close(runDone)
	}()
	if !waitForAnyHydrateCompleted(agg, 5*time.Second) {
		cancel()
		t.Fatal("aggregator never hydrated")
	}
	time.Sleep(100 * time.Millisecond) // ~20 reconcile ticks on the same connection
	if got := fired.Load(); got != 1 {
		t.Errorf("onConnected fired %d times on one connection, want 1", got)
	}
	cancel()
	<-runDone
	agg.Stop()
	agg.waitColdSeed()
}

// With no live archive tombstone the reconcile skips its full /session fetch
// until the idle interval elapses; a fresh archive (tombstone) brings the fast
// cadence back so clobber-revert detection keeps its timing.
func TestTreeReconcile_IdleUntilTombstone(t *testing.T) {
	agg, cnt, stop := runCountingAggregator(t, 5*time.Millisecond, time.Hour, time.Hour)
	defer stop()

	base := cnt.live.Load()
	time.Sleep(100 * time.Millisecond) // ~20 ticks, no tombstone
	if got := cnt.live.Load(); got > base+1 {
		t.Fatalf("idle reconcile still fetched /session every tick: %d -> %d", base, got)
	}

	agg.Store().RemoveSessions([]string{"other"}) // arms a live tombstone
	waitLiveTicks(t, cnt, cnt.live.Load()+5)      // fast cadence resumes
}
