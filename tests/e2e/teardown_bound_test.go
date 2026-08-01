package e2e

// Full-stack e2e guard: Cluster.Close() returns within a bound after a
// per-directory aggregator has opened its always-on /event SSE subscription to
// fakeSrv.
//
// ANTECEDENT: opening a non-default directory starts a per-directory aggregator
// whose always-on /event SSE subscription to fakeSrv is held open for the life
// of the aggregator (pkg/web/server.go aggFor → RunManaged). Cluster.Close →
// webSrv.Shutdown must reach and release that subscription so fakeSrv.Close()
// can complete; an unreleased /event handler blocks httptest's per-connection
// wg.Wait() forever. Shutdown now owns this release two ways — bgCancel cancels
// the RunManaged child, AND stopServerOwnedAggregators → Aggregator.Stop →
// store.Close retires the subscriber-backed /event tail — so Close() returns
// well under a second in the fixed state. This test pins that boundedness
// end-to-end: it opens such a directory on an ISOLATED Cluster, confirms the
// per-dir /event subscription was accepted by fakeSrv, and bounds Close() so
// any future regression that re-introduces an unreleased /event handler fails
// a bound instead of wedging the `go test` run.
//
// Complementary, not duplicative: pkg/web/shutdown_lifecycle_test.go
// (TestShutdownRetiresServerOwnedPerDirLifetimes, commit 35c54c4) covers
// Server.Shutdown ownership at the web-unit seam (subscriber close + watcher
// await + aggregator deletion) but does NOT exercise the full
// Cluster.Close → webSrv.Shutdown → fakeSrv.Close stack this test drives.
//
// The crux under test is teardown-boundedness AFTER a per-dir aggregator opened
// /event — NOT queue behavior.

import (
	"testing"
	"time"
)

func TestClusterCloseBoundedAfterPerDirEventSubscription(t *testing.T) {
	// Isolated cluster: its own free ports, fakeSrv, and daemon. NOT the
	// package-global `cluster` (re-read StartCluster/Cluster in harness.go) — the
	// global cluster is Closed only once by TestMain after m.Run(), so its
	// Close() completion can never be bounded and observed mid-suite. An isolated
	// cluster makes the teardown observable in isolation and cannot block the
	// shared stack.
	iso, err := StartCluster()
	if err != nil {
		t.Fatalf("isolated StartCluster: %v", err)
	}

	// Open a NON-default directory. waitForSessions GETs /vh/snapshot?dir=,
	// which triggers aggFor(dir) — creating the per-dir aggregator — and polls
	// until that aggregator hydrates and reports the fake's synthetic per-dir
	// session.
	dir := "/work/teardown-bound"
	waitForSessions(t, iso, dir, 1)

	// Deterministically confirm the per-dir aggregator's always-on /event SSE
	// subscription was ACCEPTED by fakeSrv — i.e. a live blocked /event handler
	// exists, which is the exact antecedent for the teardown-boundedness crux
	// (an unreleased such handler is what would block fakeSrv.Close() in
	// httptest's wg.Wait()). waitForSessions proves hydration, but the
	// aggregator's Run loop launches its /event goroutine concurrently with
	// hydrate; observing ActiveEventSubs() >= 2 removes any race between the two.
	// The isolated cluster has exactly ONE default aggregator (1 /event sub at
	// steady state); opening this per-dir project adds exactly ONE more, so a
	// count of 2 proves the per-dir /event connected — order-independent (whether
	// the default or per-dir sub registered first, reaching 2 requires both).
	waitEventSubs(t, iso, 2)

	// Drive Close() off the test goroutine and bound it. In the fixed state the
	// per-dir /event is released (bgCancel cancels the RunManaged child, and
	// stopServerOwnedAggregators → store.Close retires the subscriber tail) and
	// Close() returns well under a second. If a future regression re-introduces
	// an unreleased /event handler, fakeSrv.Close() would hang in wg.Wait() on
	// that handler and Close() would never return; the bound surfaces that as a
	// test failure instead of wedging the `go test` run. This test asserts ONLY
	// the boundedness outcome — it deliberately does not verify any single
	// release path in isolation (Shutdown owns two, so neither is singly
	// responsible for the bound). The bound sits comfortably above the harness's
	// internal 5s webSrv.Shutdown limit (plus CI-jitter margin) and far above the
	// sub-second fixed-state teardown, so it does not flake. Exactly one Close
	// path: no `defer iso.Close()` (on the timeout path that would add a second
	// Close and block test unwind); any hung goroutine owns only this isolated
	// cluster and leaks harmlessly until the test process exits. No t.Parallel()
	// — the e2e suite is serial by design.
	const teardownBound = 10 * time.Second
	closeDone := make(chan struct{})
	go func() {
		iso.Close()
		close(closeDone)
	}()
	select {
	case <-closeDone:
		// Close() completed within the bound — teardown is bounded.
	case <-time.After(teardownBound):
		t.Fatalf("isolated Cluster.Close() did not complete within %s after a per-dir aggregator opened /event (teardown-boundedness regression: an /event handler was not released by Shutdown)", teardownBound)
	}
}

// waitEventSubs polls the fake's active /event subscriber count until it reaches
// want, failing the test (bounded) if it never does. Used to deterministically
// gate the teardown-bound test on the per-dir aggregator's /event connection
// being accepted by fakeSrv.
func waitEventSubs(t *testing.T, c *Cluster, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if got := c.Fake.ActiveEventSubs(); got >= want {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("fake /event subscribers never reached %d (last=%d) for isolated cluster", want, c.Fake.ActiveEventSubs())
}
