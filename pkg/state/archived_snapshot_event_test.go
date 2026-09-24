package state

import (
	"encoding/json"
	"testing"
)

// archived_snapshot_event_test.go — the authoritative archived snapshot is kept
// current from live archive events (noteArchivedLocked), so the aggregator's
// full ListArchivedSessions refresh can run rarely without leaving stragglers
// unflagged in between.

// An archive event for the parent flags its live child as an orphan
// immediately — no RefreshArchivedSnapshot call needed.
func TestArchivedSnapshot_ArchiveEventFlagsStragglerWithoutRefresh(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("P", "")},
		[2]string{"session.created", evSessionCreated("C", "P")},
		[2]string{"session.created", evSessionCreated("other", "")},
	)
	applySeq(t, s, [2]string{"session.updated", evSessionArchived("P")})

	if s.HasSession("P") {
		t.Fatalf("archive event should drop P from the live tree")
	}
	if !s.IsOrphanFlagged("C") {
		t.Errorf("C should be flagged orphan from the archive event alone (snapshot updated incrementally)")
	}
	if s.IsOrphanFlagged("other") {
		t.Errorf("unrelated live root must never be flagged")
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.isArchivedAuthoritativeLocked("P") {
		t.Errorf("P should be in the authoritative snapshot after its archive event")
	}
}

// The incremental path is additive only: a later archived=null update (the
// clobber-revert shape) must not remove the id from the snapshot. Only a full
// refresh can drop it.
func TestArchivedSnapshot_NullArchivedEventDoesNotRemove(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("P", "")},
		[2]string{"session.created", evSessionCreated("C", "P")},
		[2]string{"session.updated", evSessionArchived("P")},
		// Clobber-revert: OpenCode rewrites P with archived=null.
		[2]string{"session.updated", evSessionUpdated("P", "")},
	)
	s.mu.RLock()
	inSnap := s.isArchivedAuthoritativeLocked("P")
	s.mu.RUnlock()
	if !inSnap {
		t.Fatalf("an archived=null event must not remove P from the snapshot")
	}

	// A full refresh without P (a genuine un-archive) is what removes it.
	s.RefreshArchivedSnapshot([]json.RawMessage{})
	s.mu.RLock()
	inSnap = s.isArchivedAuthoritativeLocked("P")
	s.mu.RUnlock()
	if inSnap {
		t.Errorf("a full refresh that no longer lists P should drop it from the snapshot")
	}
}

// A repeated archive event for an id already in the snapshot is a no-op (no
// redundant sweep / re-emission).
func TestArchivedSnapshot_RepeatedArchiveEventIsNoop(t *testing.T) {
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("P", "")},
		[2]string{"session.created", evSessionCreated("C", "P")},
		[2]string{"session.updated", evSessionArchived("P")},
	)
	before := ringCountKind(s, KindTreeOrphanCheck)
	if before == 0 {
		t.Fatalf("precondition: the first archive event should have emitted an orphan check for C")
	}
	applySeq(t, s, [2]string{"session.updated", evSessionArchived("P")})
	if after := ringCountKind(s, KindTreeOrphanCheck); after != before {
		t.Errorf("repeated archive event re-emitted orphan checks: before=%d after=%d", before, after)
	}
}

func ringCountKind(s *Store, kind string) int {
	evs, _, _ := s.Replay(0)
	n := 0
	for _, e := range evs {
		if e.Kind == kind {
			n++
		}
	}
	return n
}
