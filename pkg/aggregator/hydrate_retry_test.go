package aggregator

// hydrate_retry_test.go — regression gate for Run's inline hydrate retry
// (task task-2026-08-25t09-41-28: the 2026-08-25 incident class — SSE stream
// healthy, ListSessions failing → Run called hydrate once, logged the failure,
// and parked on <-errc, leaving the store at seq 0 (empty project in the UI)
// until a manual POST /vh/reload).
//
// Seam (adjudicated on the task card): pkg/aggregator tests fake the opencode
// BACKEND, not the client — httptest.NewServer over a mux that gates GET
// /session (archived=='') to 500 for its first N requests, delegating
// everything else to fixtures.New().Handler(). A 500 surfaces identically to
// the incident's Client.Timeout as a ListSessions error at hydration's early
// return, so no real 30s timeout is needed; the fixtures /event stream stays
// healthily connected forever (server.connected + 10s heartbeats) — exactly
// the incident's "stream up, hydrate failing" condition. Precedent:
// TestOnHydrateFiringDiscipline/FailureDoesNotFire
// (lifecycle_characterization_test.go).

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
)

// sessionGateHandler gates the live session list (GET /session with no
// archived param — exactly what opencode.Client.ListSessions issues via
// listSessionsAdaptive's "/session?limit=N") to 500 for its first failN
// requests, then delegates. Every other request — /event, /session/status,
// /session/:id/message, POST /session, /session?archived=true — delegates
// straight to the wrapped fixtures handler. Counters are atomic: writes come
// from server handler goroutines (driven by Run's hydrate) and reads from the
// test goroutine; the atomics give the sequentially-consistent ordering the
// post-success assertions below rely on.
type sessionGateHandler struct {
	inner    http.Handler
	failN    int32
	failures atomic.Int32 // times the gate returned 500
	liveHits atomic.Int32 // total gated live-list requests seen (fails + passes)
}

func (h *sessionGateHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet && r.URL.Query().Get("archived") == "" {
		if h.liveHits.Add(1) <= h.failN {
			h.failures.Add(1)
			http.Error(w, "gate: upstream down", http.StatusInternalServerError)
			return
		}
	}
	h.inner.ServeHTTP(w, r)
}

// TestRunRetriesHydrateUntilFirstSuccess proves the crux of the fix: with the
// SSE stream healthy but ListSessions failing, Run's per-connection loop
// retries hydrate (capped backoff) until the first success instead of parking
// on <-errc with an empty store.
//
// Counter determinism: the 4 fixture sessions (demo/sub/other/slow) are live
// in the default no-directory list, none archived, and sessionPageSize (2000)
// exceeds the fixture count, so each ListSessions call issues exactly ONE
// gated GET — the counters count hydrate ATTEMPTS: attempts 1..3 fail, attempt
// 4 succeeds.
func TestRunRetriesHydrateUntilFirstSuccess(t *testing.T) {
	const failN = 3

	// One FakeOpenCode instance so the gated /session list and the delegated
	// /event stream share state. "/session" (no trailing slash) matches ONLY
	// the exact path — /session/status, /session/:id/message etc. fall through
	// to "/" — mirroring the FailureDoesNotFire precedent mux.
	fx := fixtures.New()
	gate := &sessionGateHandler{inner: fx.Handler(), failN: failN}
	mux := http.NewServeMux()
	mux.Handle("/session", gate)
	mux.Handle("/", fx.Handler())
	oc := httptest.NewServer(mux)
	defer oc.Close()

	agg := New(oc.URL, 100)
	// Shrink the retry base so the three retries elapse in milliseconds, and
	// park the tree reconciler's ticker (its own ListSessions poll would
	// pollute the gate counters). Both MUST be set before Run so the goroutine
	// launch establishes the happens-before edge to the readers — the same
	// discipline documented on statusReconcileInterval / treeReconcileInterval.
	agg.hydrateRetryBase = 2 * time.Millisecond
	agg.treeReconcileInterval = time.Hour

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	runDone := make(chan struct{})
	go func() {
		agg.RunManaged(ctx)
		close(runDone)
	}()

	// (1) The store eventually hydrates despite the first 3 ListSessions
	// failures: the sticky flag flips and the fixture's live sessions are
	// reconciled into the store (seq > 0, sessions present).
	if !waitForAnyHydrateCompleted(agg, 5*time.Second) {
		t.Fatal("Run never completed a hydrate: the retry loop did not self-heal 3 transient ListSessions failures")
	}
	if !agg.Store().HasSession("demo") || !agg.Store().HasSession("sub") {
		t.Fatal("hydrated store is missing fixture sessions (demo/sub)")
	}
	if snap := agg.Store().Snapshot(nil); snap.Seq == 0 || len(snap.Sessions) == 0 {
		t.Fatalf("hydrated store must hold a non-empty view at seq > 0, got seq=%d sessions=%d", snap.Seq, len(snap.Sessions))
	}

	// (2) Exactly failN failures were served: attempts 1..3 failed, attempt 4
	// succeeded, and no extra attempts fired. AnyHydrateCompleted is set after
	// attempt 4's response completed, so these counters are already final.
	if got := gate.failures.Load(); got != failN {
		t.Fatalf("gate failures = %d, want exactly %d", got, failN)
	}
	if got := gate.liveHits.Load(); got != failN+1 {
		t.Fatalf("live-list requests = %d, want exactly %d (failN failures + 1 successful attempt)", got, failN+1)
	}

	// (3) Retries STOP at the first success: across a settle window far
	// longer than several retry-base intervals, no further live-list request
	// arrives (no post-success polling; the tree reconciler is parked at 1h).
	hits := gate.liveHits.Load()
	time.Sleep(300 * time.Millisecond)
	if got := gate.liveHits.Load(); got != hits {
		t.Fatalf("live-list requests kept arriving after hydrate success: %d -> %d (retry/poll did not stop)", hits, got)
	}
	if got := gate.failures.Load(); got != failN {
		t.Fatalf("gate failures after settle = %d, want %d (post-success retries would grow this)", got, failN)
	}

	// Teardown: cancel Run's ctx, wait for Run to return, then Stop the
	// aggregator (idempotent with the cancel; closes the store) and drain the
	// background cold-seed so nothing outlives the test.
	cancel()
	select {
	case <-runDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not return after ctx cancel")
	}
	agg.Stop()
	agg.waitColdSeed()
}
