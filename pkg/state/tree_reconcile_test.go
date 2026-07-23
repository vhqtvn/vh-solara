package state

import (
	"encoding/json"
	"testing"
	"time"
)

// tree_reconcile_test.go — Phase 2 §6.2 server reconcile loop.
//
// The reconcile tick diffs the in-memory store against OpenCode's authoritative
// /session list and emits corrective ops:
//   - node.remove (KindSessionDelete) for sessions in the store but GONE from
//     /session (ghosts / missed-delete resurrection).
//   - Reports tombstoned ids that reappeared in /session (clobber-revert) so
//     the aggregator can re-PATCH time.archived (fold-in of reassertArchive).
//
// Tombstone semantics:
//   - Tombstoned + absent from /session → NOT a ghost (expected archive path).
//   - Tombstoned + present in /session → clobber (re-PATCH needed).
//   - Tombstone cleared (legit un-archive) or expired → NOT clobbered.

// ---------------------------------------------------------------------------
// Ghost detection: session in store, gone from /session → node.remove
// ---------------------------------------------------------------------------

func TestReconcile_GhostRemovedFromStore(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("C", "R")},
	)
	// Simulate a missed delete: R is in the store but OpenCode doesn't list it.
	// C is still listed (becomes an orphan root after R is evicted).
	result := s.ReconcileSessions([]json.RawMessage{
		sessInfo("C", "R", 0),
	})
	if len(result.Ghosts) != 1 || result.Ghosts[0] != "R" {
		t.Fatalf("expected [R] as ghosts, got %v", result.Ghosts)
	}
	snap := s.Snapshot(nil)
	if containsID(sessIDs(snap), "R") {
		t.Errorf("ghost R should have been removed from store")
	}
	if !containsID(sessIDs(snap), "C") {
		t.Errorf("C should still be in store (it was in the authoritative list)")
	}
}

func TestReconcile_GhostEmitsNodeRemove(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
	)
	ch, unsub := s.Subscribe(64)
	defer unsub()
	drainKind(ch, KindSessionUpsert) // drain session.created

	result := s.ReconcileSessions([]json.RawMessage{})
	if len(result.Ghosts) != 1 || result.Ghosts[0] != "R" {
		t.Fatalf("expected [R] as ghosts, got %v", result.Ghosts)
	}
	dels := drainKind(ch, KindSessionDelete)
	if len(dels) != 1 {
		t.Fatalf("expected 1 KindSessionDelete emit, got %d", len(dels))
	}
}

// ---------------------------------------------------------------------------
// Clobber-revert detection: tombstoned id reappeared in /session
// ---------------------------------------------------------------------------

func TestReconcile_ClobberedArchiveReported(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
	)
	s.RemoveSessions([]string{"R"}) // arms tombstone, removes from store

	// OpenCode reverted the archive: R reappears in /session.
	result := s.ReconcileSessions([]json.RawMessage{
		sessInfo("R", "", 0),
	})
	if len(result.ClobberedArchives) != 1 || result.ClobberedArchives[0] != "R" {
		t.Fatalf("expected [R] as clobbered, got %v", result.ClobberedArchives)
	}
}

func TestReconcile_TombstonedAbsentNotGhost(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
	)
	s.RemoveSessions([]string{"R"}) // tombstoned + removed

	// R is absent from /session (expected — it was archived).
	result := s.ReconcileSessions([]json.RawMessage{})
	if len(result.Ghosts) != 0 {
		t.Fatalf("tombstoned absent session should NOT be a ghost, got %v", result.Ghosts)
	}
	if len(result.ClobberedArchives) != 0 {
		t.Fatalf("tombstoned absent session should NOT be clobbered, got %v", result.ClobberedArchives)
	}
}

// ---------------------------------------------------------------------------
// Tombstone respect: legitimate un-archive NOT re-archived
// ---------------------------------------------------------------------------

func TestReconcile_TombstoneClearedNotClobbered(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
	)
	s.RemoveSessions([]string{"R"})
	s.ClearArchiveTombstones([]string{"R"}) // explicit un-archive

	result := s.ReconcileSessions([]json.RawMessage{
		sessInfo("R", "", 0),
	})
	if len(result.ClobberedArchives) != 0 {
		t.Fatalf("legitimate un-archive (tombstone cleared) must NOT be re-archived, got %v", result.ClobberedArchives)
	}
}

func TestReconcile_ExpiredTombstoneNotClobbered(t *testing.T) {
	prev := recentArchiveTTL
	recentArchiveTTL = 5 * time.Millisecond
	t.Cleanup(func() { recentArchiveTTL = prev })

	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
	)
	s.RemoveSessions([]string{"R"})
	time.Sleep(20 * time.Millisecond) // tombstone expired

	result := s.ReconcileSessions([]json.RawMessage{
		sessInfo("R", "", 0),
	})
	if len(result.ClobberedArchives) != 0 {
		t.Fatalf("expired tombstone should NOT be clobbered, got %v", result.ClobberedArchives)
	}
}

// ---------------------------------------------------------------------------
// No-drift baseline
// ---------------------------------------------------------------------------

func TestReconcile_NoDriftReturnsEmpty(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("C", "R")},
	)
	result := s.ReconcileSessions([]json.RawMessage{
		sessInfo("R", "", 0),
		sessInfo("C", "R", 0),
	})
	if len(result.Ghosts) != 0 || len(result.ClobberedArchives) != 0 {
		t.Fatalf("no drift should return empty, got ghosts=%v clobbered=%v",
			result.Ghosts, result.ClobberedArchives)
	}
}
