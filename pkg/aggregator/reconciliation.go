package aggregator

import (
	"context"
	"log"
	"time"
)

// reconciliation.go — the periodic self-heal tickers.
//
// Two independent ticker loops that poll OpenCode's authoritative endpoints on
// a fixed cadence and reconcile the result into the store, absorbing /event
// stream flakiness (missed idles, missed deletes, clobber-reverted archives)
// in ONE server-side place each:
//
//   - runStatusReconcile (Phase 2 §6.1) re-derives busy-state from
//     /session/status, clearing a stale "busy" flag left by a missed
//     session.idle.
//   - runTreeReconcile (Phase 2 §6.2) diffs the store against /session to evict
//     ghost nodes (missed session.deleted) and re-PATCH clobber-reverted
//     archives. Folds in the archive re-assert (reassertArchive) and the
//     resurrection tombstone so Phase 2 merges rather than duplicates them.
//
// Both loops are spawned once from Run, bound to Run's ctx, and block until
// that ctx is cancelled. Each is best-effort: a fetch error with ctx.Err()==nil
// is logged and retried on the next tick. Neither holds an aggregator lock;
// they touch the Store only via documented Store methods (taking s.mu), so there
// is no lock nesting and no cross-concern coupling — this is why reconciliation
// is the cleanly splittable concern (see the aggregator concurrency map §6).
//
// Both intervals are PER-INSTANCE Aggregator fields (statusReconcileInterval,
// treeReconcileInterval), set in New / NewForDirectory and read once at the top
// of each loop before the ticker is created. The goroutine launch in Run
// establishes the happens-before edge to that read, so a test that shrinks an
// interval on the instance under test cannot race a lingering reconcile
// goroutine from another aggregator / a prior -count iteration — the exact
// global-mutation race that bit the old package-global statusReconcileInterval.

// runStatusReconcile periodically re-derives busy-state from OpenCode's
// /session/status and reconciles it into the store. It is the self-heal path
// for a stale "busy" flag: the event stream owns busy-state in the common
// case, but if a session.idle is ever missed the in-memory flag would stick
// forever. This ticker clears anything OpenCode no longer reports busy by
// routing through store.SetActivityFromStatuses -> setActivityLocked, which is
// the single chokepoint that also keeps busyCount, subtreeBusyCount, and the
// seven O1 subtree indexes consistent. It is best-effort: a fetch error is
// logged and retried on the next tick. It never clears busyCount directly.
// Blocks until ctx is cancelled.
//
// The poll interval is the per-instance field a.statusReconcileInterval
// (default 60s, set in New / NewForDirectory). A test shrinks it on the
// instance under test (e.g. agg.statusReconcileInterval = 5*time.Millisecond)
// rather than mutating a package global: a global written by one test's
// goroutine would race a lingering runStatusReconcile goroutine from another
// aggregator (or a prior -count iteration) that reads it once at the top of
// this function. The instance field removes that race entirely.
func (a *Aggregator) runStatusReconcile(ctx context.Context) {
	ticker := time.NewTicker(a.statusReconcileInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		statuses, err := a.client.SessionStatuses(ctx)
		if err != nil {
			// Silent on shutdown; otherwise log and try again next tick.
			if ctx.Err() != nil {
				return
			}
			log.Printf("[aggregator] status reconcile fetch failed: %v", err)
			continue
		}
		a.store.SetActivityFromStatuses(statuses)
	}
}

// runTreeReconcile periodically diffs the store against OpenCode's
// authoritative /session list and emits corrective ops (design §6.2). It is
// the self-heal for an unreliable /event stream:
//
//   - Missed session.deleted → the store holds a ghost node; this tick emits
//     node.remove to evict it deterministically.
//   - Clobber-reverted archive → a tombstoned session reappeared in /session;
//     this tick re-PATCHs time.archived (the fold-in of reassertArchive).
//
// The tombstone (store.go isRecentlyArchivedLocked, TTL 30s) gates both
// branches: a tombstoned id is not ghost-removed (intentional archive), and
// only a tombstoned id is clobber-reported (proven archive intent). A
// legitimate un-archive (ClearArchiveTombstones) or an expired tombstone is
// NOT re-archived.
//
// Every corrective op carries a seq (§4.1/INV-A) and flows through the ring
// (§5.5), so a reconnecting client replays them like any other op.
//
// Best-effort: a fetch error is logged and retried on the next tick. Blocks
// until ctx is cancelled.
//
// The poll interval is the per-instance field a.treeReconcileInterval
// (default 5s, set in New / NewForDirectory). It mirrors statusReconcileInterval
// as a per-instance field rather than the old package-global
// TreeReconcileInterval: a global written by one test's goroutine would race a
// lingering runTreeReconcile goroutine from another aggregator (or a prior
// -count iteration) that reads it once at the top of this function. No test
// mutates it today, but the instance field removes the latent race
// proactively — a future test can shrink a.treeReconcileInterval on the
// instance under test with no global-mutation hazard.
func (a *Aggregator) runTreeReconcile(ctx context.Context) {
	ticker := time.NewTicker(a.treeReconcileInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		sessions, err := a.client.ListSessions(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("[aggregator] tree reconcile fetch failed: %v", err)
			continue
		}
		result := a.store.ReconcileSessions(sessions)
		// Re-PATCH clobbered archives: OpenCode reverted time.archived while
		// the tombstone was still live. This restores the archive intent.
		// Only tombstoned ids reach here (ReconcileSessions gates on the
		// tombstone), so a legitimate un-archive is never re-archived.
		for _, id := range result.ClobberedArchives {
			if err := a.client.SetArchived(ctx, id, time.Now().UnixMilli()); err != nil {
				log.Printf("[aggregator] re-assert archive failed for %s: %v", id, err)
			}
		}
		// Refresh the authoritative archived-ID snapshot + run the Defect-3
		// orphan backstop sweep. The /session list fetched above (sessions)
		// excludes archived entries, so the snapshot is derived from the
		// archived-session fetch (ListArchivedSessions / /session?archived=true).
		// Best-effort: a fetch error leaves the snapshot stale until the next
		// tick. Fetch is outside the store lock; RefreshArchivedSnapshot takes
		// the lock only for the in-memory rebuild + sweep.
		archived, err := a.client.ListArchivedSessions(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			log.Printf("[aggregator] archived snapshot fetch failed at reconcile: %v", err)
		} else {
			a.store.RefreshArchivedSnapshot(archived)
		}
	}
}
