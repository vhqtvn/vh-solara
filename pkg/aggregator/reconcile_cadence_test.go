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
