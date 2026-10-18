package web

// Queue lifecycle installation + reconciliation, moved verbatim from server.go
// (slice 9 of the server.go split): the queue-GC session.delete subscriber
// arming (installQueueGCCleanup, with the queueGCSubscribeBuffer const — the
// installer ALSO owns the aggregator's single onHydrate callback registration
// plus its immediate-run arm, both of which dispatch through
// spawnPostHydrateReconciles) and the GC-3 orphan-queue reconciliation driver
// (reconcileQueuesForAgg → queueRegistry.reconcileOrphanQueues). The shared
// post-hydrate orchestration between the two regions
// (spawnPostHydrateReconciles, pinsReconcileEntryCount,
// labelsReconcileEntryCount — slice 10) and the Server fields used here
// (queues, queueGCMu/queueGCOn, lifecycleWG, bgWG) stay in server.go, as do
// the aggFor call sites and Shutdown's lifecycleWG join.
//
// Known contradiction, moved as-is: the queueGCSubscribeBuffer doc below calls
// authoritative filesystem reconciliation "future work" (the deferred GC-3
// slice) although reconcileQueuesForAgg IS installed and wired through the
// onHydrate callback — the commentary predates GC-3 landing and is preserved
// byte-for-byte per move-only discipline.

import (
	"encoding/json"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/state"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// queueGCSubscribeBuffer is the per-subscriber channel buffer for the queue-GC
// session.delete subscriber. session.delete is a STRUCTURAL event (not
// message-class), so the subscriber passes Interest{MessageSessions: empty{}} to
// drop ALL message-class events at fanout — only session.* / activity / status /
// permission / question / notice / unread events reach the channel. These are
// low-frequency compared to the message/part token-delta flood, so 128 slots is
// ample headroom against realistic bursts.
//
// IMPORTANT non-durability caveat (mirrors ensurePermissionWatcher's doc): the
// store's emit() does NONBLOCKING fanout — on channel-overflow the channel is
// CLOSED and the subscriber is silently DROPPED. If that happens this goroutine
// exits and queue cleanup stops firing on session.delete for this aggregator
// until process restart (default aggregator) or Reload-project (per-dir
// aggregator) rebuilds it. This is INTENTIONAL and accepted: queue cleanup is
// also driven DIRECTLY by the /vh/archive handler (so archive correctness never
// depends on subscriber delivery), and the deferred GC-3 slice will add
// authoritative filesystem reconciliation as a periodic backstop that catches
// orphans regardless of subscriber state. Per Settled Assumption #8 the
// subscriber is best-effort only.
const queueGCSubscribeBuffer = 128

// installQueueGCCleanup arms the queue-GC session.delete subscriber on a's
// store, once per (dir, aggregator) pair (idempotent, guarded by queueGCOn).
// It is called from aggFor so it runs for the default project AND every
// lazily-created per-dir aggregator, before any HTTP request can observe a
// queue-owning session that has already been deleted upstream.
//
// Why a live-tail subscriber is acceptable here but NOT for the fail-closed
// permission watcher (ensurePermissionWatcher, which uses a deterministic
// reconcile sweep): the permission watcher enforces a SAFETY guarantee that
// MUST fire on every match — a silently-dropped subscriber would let an
// unattended prompt hang with no signal. Queue GC is a CLEANUP optimization:
// the /vh/archive path already deletes the queue DIRECTLY (so operator-driven
// archive is correct even with zero subscriber delivery), and a missed
// session.delete just leaves an orphan queue.json that GC-3 will eventually
// reap. Idempotent cleanup means the direct path + subscriber path compose
// without harm.
//
// Async delivery (verified in pkg/state/store.go emit/Subscribe): emit() does a
// nonblocking send under the store lock; the consumer reads from the channel in
// its OWN goroutine, so CleanupSession's filesystem os.Remove never holds the
// store lock. No buffered-channel/worker indirection is needed.
//
// Lifecycle: the goroutine ranges over the channel until the store closes it.
// store.Close() (called from aggregator.Stop() during handleReloadProject and
// at process exit) closes every subscriber channel and clears the subs map, so
// this goroutine exits cleanly with no leak. The unsubscribe func returned by
// Subscribe is intentionally discarded — store.Close already removes the subs
// entry, so there is nothing to leak. queueGCOn[dir] stays true across a
// Reload-project cycle: the dir's aggregator is deleted from s.aggs so the NEXT
// aggFor(dir) builds a FRESH aggregator (new store, new subs map), and
// installQueueGCCleanup sees queueGCOn[dir]==true and skips. That is the WRONG
// behavior (the new aggregator's store is never subscribed) — so
// handleReloadProject resets queueGCOn[dir] after tearing down the old
// aggregator. See the call site there.
func (s *Server) installQueueGCCleanup(dir string, a *aggregator.Aggregator) {
	s.queueGCMu.Lock()
	if s.queueGCOn[dir] {
		s.queueGCMu.Unlock()
		return
	}
	s.queueGCOn[dir] = true
	s.queueGCMu.Unlock()

	// FIX-QUEUE-GC-3: install the orphan-queue reconciliation callback on this
	// aggregator. The callback fires from hydrate's goroutine at the end of
	// every successful hydrate (startup, reconnect, post-reload) and dispatches
	// the actual scan+cleanup to a fresh goroutine so hydrate is never blocked.
	// This wiring shares installQueueGCCleanup's queueGCOn guard lifecycle:
	// installed once per (dir, aggregator), and handleReloadProject resets
	// queueGCOn[dir] when it tears down the old aggregator so the fresh
	// aggregator built by aggFor gets a fresh callback. The immediate-run
	// branch covers the default aggregator, which is started (and hydrated) by
	// the daemon BEFORE the first HTTP request reaches aggFor("") — without it,
	// the default dir's orphans would only be cleaned after the NEXT hydrate
	// (i.e. the next reconnect), not the one that already happened at boot.
	//
	// Phase 4 (pins L3 backstop) is COMPOSED INTO this same callback. The
	// aggregator exposes a SINGLE onHydrate slot (see SetOnHydrate doc:
	// production installs ONE callback per aggregator, here), so the pins
	// post-hydrate reconcile piggybacks on it rather than registering a second
	// callback that would clobber this one. reconcilePinsForAgg is fail-closed
	// (gated on AnyHydrateCompleted, scoped by projectBySessionId) and dispatches to
	// its own goroutine, so it never blocks hydrate or serializes against the
	// queue reconcile. See pkg/web/pins_lifecycle.go.
	a.SetOnHydrate(func() {
		s.spawnPostHydrateReconciles(dir, a)
	})
	if a.AnyHydrateCompleted() {
		s.spawnPostHydrateReconciles(dir, a)
	}

	root, err := projectRoot(dir)
	if err != nil {
		// projectRoot only fails if os.Getwd (default dir) or filepath.Abs
		// (per-dir) fails — both effectively never. If it somehow does, leave
		// queueGCOn[dir]==true so we don't retry uselessly on every request,
		// and rely on /vh/archive's direct cleanup + GC-3 backstop.
		vhlog.Error("queue-GC subscriber not installed: projectRoot failed", "dir", dir, "err", err)
		return
	}
	store := a.Store()
	// Drop ALL message-class events at fanout — we only care about the
	// structural session.delete event. An empty (non-nil) MessageSessions map
	// means "deliver message-class events only for sessions in the set", and an
	// empty set drops them all (see state.Interest.wants).
	ch, _ := store.SubscribeWith(queueGCSubscribeBuffer, state.Interest{MessageSessions: map[string]bool{}})
	// Track on lifecycleWG for NON-DEFAULT dirs only: the default dir's
	// subscriber is daemon-owned (process-lifetime — the default aggregator is
	// NOT stopped by Shutdown), so awaiting it would hang until process exit.
	// Non-default subscribers exit when Shutdown stops their aggregator
	// (Aggregator.Stop() → store.Close() closes this channel), so Shutdown can
	// await them. Add BEFORE launch; Done is deferred inside the goroutine.
	if dir != "" {
		s.lifecycleWG.Add(1)
	}
	go func() {
		if dir != "" {
			defer s.lifecycleWG.Done()
		}
		for ev := range ch {
			if ev.Kind != state.KindSessionDelete {
				continue
			}
			var p struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(ev.Payload, &p) != nil || p.ID == "" {
				continue
			}
			// Sanitize the id the same way /vh/archive does (safeID strips
			// anything that could escape the session directory on disk).
			sid := safeID.ReplaceAllString(p.ID, "")
			if sid == "" {
				continue
			}
			s.queues.CleanupSession(root, sid)
		}
	}()
}

// reconcileQueuesForAgg is the per-aggregator driver for FIX-QUEUE-GC-3
// orphan-queue reconciliation. It is the glue between the aggregator's
// post-hydrate signal (SetOnHydrate / AnyHydrateCompleted, installed in
// installQueueGCCleanup) and the queueRegistry's reconcileOrphanQueues scan.
//
// FAIL-CLOSED gate: if a.AnyHydrateCompleted() is false, the aggregator has not yet
// produced an authoritative active-session set, so this function returns
// WITHOUT deleting anything. The empty active-set case (hydrate succeeded with
// zero sessions) is the OPPOSITE: AnyHydrateCompleted is true, SessionIDs returns an
// empty slice, reconcileOrphanQueues receives an empty non-nil map, and every
// on-disk queue is correctly treated as an orphan. This is the distinction
// GC-3 exists to enforce — see the field doc on Aggregator.anyHydrateCompleted.
//
// Active-set source: a.Store().SessionIDs() returns the store's current session
// IDs under RLock. This is the SAME authoritative set store.Hydrate just
// installed (hydrate calls store.Hydrate BEFORE firing onHydrate, and
// SessionIDs reads the map Hydrate writes). Calling it AFTER the AnyHydrateCompleted
// gate guarantees we read a set produced by a completed hydrate, not a
// stale/pre-hydrate map.
//
// Root derivation: projectRoot(dir), matching installQueueGCCleanup's GC-2
// subscriber. A root-resolution failure logs and returns (no deletion) —
// projectRoot only fails if os.Getwd/filepath.Abs fail, which is effectively
// never in practice.
//
// Concurrency: dispatched to a fresh goroutine by the onHydrate callback (so
// hydrate's goroutine is never blocked) and by the immediate-run branch in
// installQueueGCCleanup (default-aggregator boot case) — both arms spawn via
// spawnPostHydrateReconciles, which tracks the pass on bgWG so Shutdown joins
// an in-flight pass before returning (its orphan deletions persist via
// queueRegistry.deleteStore). Multiple concurrent invocations for the same dir
// are safe — reconcileOrphanQueues serializes its per-session work through
// queueRegistry.mu, and CleanupSession is idempotent.
func (s *Server) reconcileQueuesForAgg(dir string, a *aggregator.Aggregator) {
	// FAIL-CLOSED: no authoritative set yet → delete nothing.
	if !a.AnyHydrateCompleted() {
		return
	}
	root, err := projectRoot(dir)
	if err != nil {
		vhlog.Error("queue reconcile: projectRoot failed", "dir", dir, "err", err)
		return
	}
	store := a.Store()
	ids := store.SessionIDs()
	active := make(map[string]bool, len(ids))
	for _, id := range ids {
		active[id] = true
	}
	// GC-3 race closure (FIX-QUEUE-GC-3-RACE): re-validate each orphan
	// candidate at T2 (immediately before deletion) against the live store.
	// A session created between the T1 inventory snapshot above (SessionIDs)
	// and this T2 scan would otherwise have its fresh queue.json deleted as
	// an orphan. The recheck narrows the race window to T2.recheck→T2.delete,
	// which is the GC-2 pattern (a different, accepted hazard — see the
	// "GC-2 hazard — OPEN" block in reconcileOrphanQueues's doc comment).
	if err := s.queues.reconcileOrphanQueues(root, active, func(sid string) bool {
		return store.HasSession(sid)
	}); err != nil {
		vhlog.Error("queue reconcile failed", "dir", dir, "root", root, "err", err)
	}
}
