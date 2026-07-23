package aggregator

import (
	"context"
	"log"
	"time"
)

// tree_reconcile.go — Phase 2 §6.2 server reconcile ticker.
//
// Periodic tick that diffs the store against OpenCode's authoritative /session
// list and emits corrective ops, absorbing /event flakiness (missed deletes,
// clobber-reverted archives) in ONE server-side place. Folds in the existing
// archive re-assert (reassertArchive) and the resurrection tombstone so Phase 2
// merges rather than duplicates them.

// TreeReconcileInterval is how often runTreeReconcile polls OpenCode's /session
// list to detect ghosts and clobbered archives. The tick is cheap (a flat-list
// diff against an in-memory map), so it can run frequently. A var (not const)
// so tests can shrink it; mirrors the StatusReconcileInterval precedent.
var TreeReconcileInterval = 5 * time.Second

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
func (a *Aggregator) runTreeReconcile(ctx context.Context) {
	ticker := time.NewTicker(TreeReconcileInterval)
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
	}
}
