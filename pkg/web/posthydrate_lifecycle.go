package web

// Shared post-hydrate reconcile orchestration, moved verbatim from server.go
// (slice 10 of the server.go split): spawnPostHydrateReconciles — the single
// spawn site shared by installQueueGCCleanup's two trigger arms (the
// aggregator onHydrate callback tail and the immediate-run branch), whose
// bgWG.Add(3) pre-launch accounting covers the three one-shot reconcile
// passes (queue GC-3 orphan reaping → reconcileQueuesForAgg in
// queue_lifecycle.go, pins L3 backstop → reconcilePinsForAgg in
// pins_lifecycle.go, labels L3 backstop → reconcileLabelsForAgg in
// labels_lifecycle.go), plus the two test-observability entry counters
// (pinsReconcileEntryCount / labelsReconcileEntryCount). The Server fields
// used here (bgWG, pinsReconcileEntries / labelsReconcileEntries atomics)
// stay in server.go.

import (
	"sync/atomic"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// spawnPostHydrateReconciles launches the three post-hydrate reconcile passes
// — queue GC-3 orphan reaping (reconcileQueuesForAgg), pins L3 backstop
// (reconcilePinsForAgg), labels L3 backstop (reconcileLabelsForAgg) — for one
// (dir, aggregator). It is the SINGLE spawn site shared by
// installQueueGCCleanup's two trigger arms: the onHydrate callback (fires at
// the tail of every successful hydrate on hydrate's own goroutine — the
// per-dir aggregators' steady-state path) and the immediate-run branch (the
// default aggregator, which the daemon starts and hydrates BEFORE the first
// request reaches aggFor(""), so install-time AnyHydrateCompleted is already
// true).
//
// Ownership contract (the b5d209b list-spawn precedent — same defect class,
// follow-up slice F7): each pass is server-owned background work tracked on
// bgWG — Add BEFORE launch, one deferred Done per goroutine on every return
// path (the archive-cascade pattern). Shutdown awaits bgWG, so an in-flight
// pass is JOINED before Shutdown returns instead of surviving it and racing
// the caller's teardown — the 2026-10-11 TempDir RemoveAll ENOTEMPTY race
// class. All three passes write durably: reconcileQueuesForAgg's orphan reaping
// deletes/moves <root>/.vh-solara/sessions/<sid>/queue.json via
// queueRegistry.deleteStore (under qr.mu), and the pins/labels backstops
// persist doc removals + revision bumps via PinStore.RemoveIDs /
// LabelStore.RemoveRootIDs when a project-scoped id is absent from the active
// set.
//
// Why bgWG and NOT lifecycleWG: lifecycleWG members are RETIREABLE loops that
// exit when Shutdown fires their retirement signal (permission-watcher
// cancels; non-default subscriber channels closed by store.Close during
// stopServerOwnedAggregators). These passes are bounded one-shot scans that
// complete on their own — no retirement signal applies, and they terminate
// promptly even for the DEFAULT aggregator (which Shutdown deliberately does
// not stop), so awaiting them cannot hang. The passes watch no context, so
// bgCancel does not shorten them; Shutdown's ctx bounds only the WAIT, not
// the passes (same as the archive-cascade and b5d209b joins).
//
// Admission caveat (accepted — see Server.Shutdown's terminal-teardown
// contract): there is intentionally NO admission barrier. A hydrate that
// completes after Shutdown's bgWG.Wait has already observed zero could still
// spawn an untracked pass — the default aggregator is daemon-owned and keeps
// hydrating past Shutdown. That window is the same accepted race class as the
// b5d209b HTTP-driven spawn: production callers drain the HTTP server before
// srv.Shutdown. What this join closes is the in-flight window — a pass
// launched before the Wait is awaited before Shutdown returns.
func (s *Server) spawnPostHydrateReconciles(dir string, a *aggregator.Aggregator) {
	s.bgWG.Add(3)
	go func() {
		defer s.bgWG.Done()
		s.reconcileQueuesForAgg(dir, a)
	}()
	go func() {
		defer s.bgWG.Done()
		s.reconcilePinsForAgg(dir, a)
	}()
	go func() {
		defer s.bgWG.Done()
		s.reconcileLabelsForAgg(dir, a)
	}()
}

// pinsReconcileEntryCount returns the total number of reconcilePinsForAgg
// invocations that reached the pin-doc snapshot step (test observability — see
// the pinsReconcileEntries field doc; the queueRegistry.CleanupCallCount
// mechanism mirrored for the pins pass).
func (s *Server) pinsReconcileEntryCount() int64 {
	return atomic.LoadInt64(&s.pinsReconcileEntries)
}

// labelsReconcileEntryCount returns the total number of reconcileLabelsForAgg
// invocations that reached the labels reconcile-snapshot step (test
// observability — see the labelsReconcileEntries field doc; the
// queueRegistry.CleanupCallCount mechanism mirrored for the labels pass).
func (s *Server) labelsReconcileEntryCount() int64 {
	return atomic.LoadInt64(&s.labelsReconcileEntries)
}
