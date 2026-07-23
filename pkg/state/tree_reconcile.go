package state

import "encoding/json"

// tree_reconcile.go — Phase 2 §6.2 server reconcile vs OpenCode's authoritative
// /session list.
//
// The daemon's /event tail is the primary reactive path, but /event is
// unreliable in the exact ways that caused our bugs: it can MISS deletes
// (→ resurrection/ghosts) and CLOBBER-revert archives on busy sessions. This
// reconcile tick is the periodic self-heal that absorbs that flakiness in ONE
// server-side place, leaving the client a dumb op-applier.
//
// Fold-in (not duplication): the tombstone (store.go isRecentlyArchivedLocked,
// TTL 30s) and the re-PATCH (archive.go reassertArchive → aggregator
// runTreeReconcile) are the SAME corrections, unified under this tick.

// TreeReconcileResult records what a reconcile tick found and corrected.
type TreeReconcileResult struct {
	// Ghosts are ids that were in the store but absent from OpenCode's
	// authoritative /session list, and were NOT tombstoned. Each was removed
	// from the store and emitted as KindSessionDelete (→ node.remove for
	// tree=2 clients). These are missed-delete ghosts: /event dropped a
	// session.deleted, so the store held a stale node until this tick evicted
	// it deterministically.
	Ghosts []string

	// ClobberedArchives are tombstoned ids that reappeared in the /session
	// list — OpenCode reverted time.archived (the clobber-revert case). The
	// caller (aggregator's runTreeReconcile) re-PATCHs time.archived to
	// restore the archive. Only tombstoned ids are reported: the tombstone
	// proves we own the archive intent. A tombstone-expired or explicitly-
	// cleared id is NOT reported (a legitimate un-archive).
	ClobberedArchives []string
}

// ReconcileSessions diffs the in-memory store against OpenCode's authoritative
// /session list and emits corrective ops for drift (design §6.2).
//
// rawSessions is the flat /session list (non-archived sessions only — OpenCode
// excludes archived from the default list). The method:
//
//   - Emits KindSessionDelete (→ node.remove) for any session in the store but
//     GONE from the list (ghosts). Tombstoned ids are skipped — they were
//     intentionally archived and their absence is expected.
//
//   - Reports tombstoned ids that reappeared in the list (clobber-revert) so
//     the caller can re-PATCH time.archived.
//
// Tombstone semantics (the fold-in of the resurrection tombstone):
//   - Tombstoned + absent → NOT a ghost (expected archive path).
//   - Tombstoned + present → clobber (re-PATCH needed).
//   - Tombstone cleared (legit un-archive) or expired → NOT clobbered.
//
// Every corrective op carries a seq (§4.1/INV-A) and flows through the
// reconnect/replay ring (§5.5): a client that drops and resumes across a
// reconcile tick replays the corrections, no special-case handling.
func (s *Store) ReconcileSessions(rawSessions []json.RawMessage) TreeReconcileResult {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Build the authoritative id set from the raw /session list.
	authoritative := make(map[string]bool, len(rawSessions))
	for _, raw := range rawSessions {
		var env sessionEnvelope
		if json.Unmarshal(raw, &env) != nil || env.ID == "" {
			continue
		}
		authoritative[env.ID] = true
	}

	var result TreeReconcileResult

	// Ghost detection: sessions in the store that are gone from /session.
	// Tombstoned ids are skipped — they were intentionally archived (their
	// absence from /session is the expected path, not a missed delete).
	for id := range s.sessions {
		if authoritative[id] {
			continue // still live in OpenCode
		}
		if s.isRecentlyArchivedLocked(id) {
			continue // tombstoned + absent = expected archive path
		}
		// Ghost: in our store, gone from OpenCode, not tombstoned.
		s.deleteSessionLocked(id)
		result.Ghosts = append(result.Ghosts, id)
	}

	// Clobber-revert detection: iterate the AUTHORITATIVE set (stable local
	// map — safe even though isRecentlyArchivedLocked may delete expired
	// tombstones from s.recentlyArchived). Only a live tombstone that also
	// appears in /session is reported: the tombstone proves we own the archive
	// intent, and the reappearance means OpenCode reverted it.
	for id := range authoritative {
		if s.isRecentlyArchivedLocked(id) {
			result.ClobberedArchives = append(result.ClobberedArchives, id)
		}
	}

	return result
}
