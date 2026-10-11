package web

// Regression test for the teardown-join race in the six post-hydrate reconcile
// spawns (follow-up slice F7 to the b5d209b list-spawn fix — same defect
// class): installQueueGCCleanup dispatched
// `go s.reconcileQueuesForAgg/Pins/Labels(dir, a)` fire-and-forget from BOTH
// of its trigger arms — the onHydrate callback (fired at the tail of every
// successful hydrate) and the immediate-run branch (install time with
// AnyHydrateCompleted already true — the default aggregator's boot shape).
// The passes were tracked on NEITHER bgWG NOR lifecycleWG, so Server.Shutdown
// — which awaits exactly those two groups — could return while a pass was
// still in flight. reconcileQueuesForAgg performs durable writes (orphan
// queue.json deletion via queueRegistry.deleteStore, under qr.mu), and the
// pins/labels backstops persist doc removals via PinStore.RemoveIDs /
// LabelStore.RemoveRootIDs — so an in-flight pass races the caller's teardown
// exactly like the 2026-10-11 TempDir RemoveAll ENOTEMPTY incident.
//
// Rendezvous design (deterministic, no timing race — same discipline as
// queue_msg_reconcile_shutdown_test.go): the reconcilers make no HTTP calls,
// so the b5d209b fake-endpoint-block trick does not transfer. Instead the test
// holds the queue REGISTRY mutex (srv.queues.mu) — the lock deleteStore
// acquires across its os.Remove(queue.json) critical section — and observes
// the pass's entry via the atomic CleanupCallCount counter (incremented in
// CleanupSession immediately BEFORE deleteStore parks on the lock). With the
// lock held, a spawned queue pass is deterministically parked INSIDE its
// durable-delete critical section; Shutdown must then not return until the
// lock is released (bgWG join), and the deletion must have landed by the time
// Shutdown returns.
//
// Both trigger arms are exercised:
//   - TestShutdownJoinsOnHydrateSpawnedQueueReconcile: the onHydrate callback
//     arm (callback installed before the aggregator's first hydrate, then
//     agg.Run fires it from the hydrate tail);
//   - TestShutdownJoinsImmediateRunQueueReconcile: the immediate-run arm
//     (hydrate first — callback still nil at the tail, so no spawn — then
//     aggFor, whose AnyHydrateCompleted branch spawns synchronously).
// The pins/labels passes share the same spawn helper and the same
// Add-before-launch / deferred-Done shape; they are no-ops in this fixture
// (empty pin doc / empty label store) and contribute only already-drained
// bgWG entries, which is why the window assertion is specific to the parked
// queue pass.

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// exercisePostHydrateSpawnJoin builds the server fixture, seeds one orphan
// queue, parks the spawned queue pass inside deleteStore's critical section
// via the held registry lock, and asserts Shutdown's join contract. trigger
// fires the arm-specific spawn while the registry lock is held.
func exercisePostHydrateSpawnJoin(t *testing.T, arm string, trigger func(srv *Server, ocCtx context.Context)) {
	t.Helper()
	root := t.TempDir()

	fake := newFake()
	ocSrv := httptest.NewServer(fake.handler())
	t.Cleanup(ocSrv.Close)
	t.Cleanup(ocSrv.CloseClientConnections)

	agg := aggregator.New(ocSrv.URL, 20)
	srv, err := NewServer(agg, ocSrv.URL, 20)
	if err != nil {
		t.Fatal(err)
	}
	ocCtx, ocCancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx) // idempotent with the explicit Shutdown below
	})
	t.Cleanup(ocCancel)
	t.Chdir(root) // projectRoot("") → root (the default project)

	// Seed an orphan queue on disk: <root>/.vh-solara/sessions/orphan1/queue.json.
	// The fake's /session list is empty, so the post-hydrate active set is the
	// empty NON-NIL map — the authoritative-zero case — making orphan1 a
	// reconcile candidate (revalidate: store.HasSession("orphan1") == false).
	orphan := queuePath(root, "orphan1")
	if err := os.MkdirAll(filepath.Dir(orphan), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(orphan, []byte(`{"items":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}

	// RENDEZVOUS: hold the registry lock — deleteStore takes qr.mu across its
	// os.Remove(queue.json) + empty-dir rmdir (see the BLK-1 contract on
	// deleteStore) — so once the pass increments CleanupCallCount it is
	// deterministically parked mid-durable-delete until release. sync.Once
	// guards the pairing between the explicit release below and this Goexit
	// safety net (t.Fatalf runs deferred calls).
	srv.queues.mu.Lock()
	var releaseOnce sync.Once
	releaseRegistry := func() {
		releaseOnce.Do(func() { srv.queues.mu.Unlock() })
	}
	defer releaseRegistry()

	// Fire the arm-specific trigger (under the held lock — aggFor and the
	// onHydrate tail never need qr.mu, so only the spawned queue pass parks).
	trigger(srv, ocCtx)

	// The queue pass has ENTERED its durable-delete critical section: the
	// cleanup counter is incremented BEFORE deleteStore parks on qr.mu.
	waitFor(t, func() bool { return srv.queues.CleanupCallCount() >= 1 },
		"post-hydrate queue reconcile pass entered CleanupSession ("+arm+" arm)")

	// The pass is NOW observably in flight (parked on qr.mu). Shutdown must
	// join it: no Shutdown phase before the Wait takes qr.mu (no drain loops
	// are registered, s.aggs is empty, the default aggregator is not stopped),
	// so the ONLY thing that can hold Shutdown here is the bgWG entry.
	shutdownDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		shutdownDone <- srv.Shutdown(ctx)
	}()
	select {
	case err := <-shutdownDone:
		t.Fatalf("Shutdown returned (err=%v) while the post-hydrate queue reconcile pass (%s arm) was parked in its durable-delete critical section — the spawn is untracked (not on bgWG), so deleteStore's os.Remove can race the caller's teardown", err, arm)
	case <-time.After(300 * time.Millisecond):
		// Still parked on the in-flight pass: the join is holding.
	}

	// Drain the pass; Shutdown must now complete…
	releaseRegistry()
	select {
	case <-shutdownDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Shutdown did not return after the in-flight post-hydrate reconcile pass drained")
	}

	// …and the durable delete landed BEFORE Shutdown returned (bgWG ordering):
	// the parked os.Remove could only have run after the release, yet before
	// the pass's deferred Done let the Wait through.
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatalf("orphan queue.json still present after Shutdown (stat err=%v) — the joined pass's durable delete must have landed before Shutdown returned", err)
	}
}

// TestShutdownJoinsOnHydrateSpawnedQueueReconcile pins the join contract for
// the onHydrate-callback spawn arm: the callback is installed (aggFor) BEFORE
// the aggregator's first hydrate, then agg.Run's initial hydrate fires it at
// its tail — deterministically after installation (program order).
func TestShutdownJoinsOnHydrateSpawnedQueueReconcile(t *testing.T) {
	exercisePostHydrateSpawnJoin(t, "onHydrate-callback", func(srv *Server, ocCtx context.Context) {
		srv.aggFor("") // installs the onHydrate callback; AnyHydrateCompleted==false → immediate-run arm stays quiet
		go srv.agg.Run(ocCtx)
	})
}

// TestShutdownJoinsImmediateRunQueueReconcile pins the join contract for the
// immediate-run spawn arm: the aggregator hydrates FIRST (callback still nil
// at the hydrate tail, so no spawn there), then aggFor installs the callback
// and its AnyHydrateCompleted branch spawns synchronously — the production
// shape of the default aggregator, which the daemon hydrates before the first
// request reaches aggFor("").
func TestShutdownJoinsImmediateRunQueueReconcile(t *testing.T) {
	exercisePostHydrateSpawnJoin(t, "immediate-run", func(srv *Server, ocCtx context.Context) {
		go srv.agg.Run(ocCtx)
		waitFor(t, func() bool { return srv.agg.AnyHydrateCompleted() }, "initial hydrate before aggFor")
		srv.aggFor("") // AnyHydrateCompleted==true → immediate-run arm fires here
	})
}
