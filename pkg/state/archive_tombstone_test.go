package state

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// sessInfo builds a raw session JSON envelope with an optional archived ts.
// archived=0 omits time.archived (a non-archived / active session).
func sessInfo(id, parentID string, archived float64) json.RawMessage {
	t := map[string]any{"created": 1.0, "updated": 2.0}
	if archived != 0 {
		t["archived"] = archived
	}
	b, _ := json.Marshal(map[string]any{
		"id":       id,
		"parentID": parentID,
		"title":    id,
		"time":     t,
	})
	return b
}

// evUpsert builds a session.updated event for Apply.
func evUpsert(info json.RawMessage) opencode.Event {
	b, _ := json.Marshal(map[string]any{"info": info})
	return opencode.Event{Type: "session.updated", Properties: b}
}

func sessIDs(snap Snapshot) []string {
	out := make([]string, 0, len(snap.Sessions))
	for _, raw := range snap.Sessions {
		var e sessionEnvelope
		_ = json.Unmarshal(raw, &e)
		out = append(out, e.ID)
	}
	return out
}

func containsID(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

// TestArchiveTombstone_BlocksResurrectionFromStaleUpdated verifies the core
// fix for Issue 4 (B-i): after RemoveSessions (the archive path), a stale
// session.updated / session.compacted arriving with archived=null (because
// OpenCode rewrote the record from a pre-PATCH snapshot on a busy descendant)
// must NOT re-insert the session into the live tree. Without the tombstone,
// upsertSessionLocked treats archived=null as a normal upsert and resurrects
// the session; the subsequent status reconcile re-marks it busy → re-promotes.
func TestArchiveTombstone_BlocksResurrectionFromStaleUpdated(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"s1","title":"root"}}`))
	if !containsID(sessIDs(s.Snapshot(nil)), "s1") {
		t.Fatal("precondition: s1 must be live")
	}

	// Subscribe to observe emits.
	ch, unsub := s.Subscribe(64)
	defer unsub()

	// Archive: RemoveSessions drops s1 and sets the tombstone.
	s.RemoveSessions([]string{"s1"})
	if containsID(sessIDs(s.Snapshot(nil)), "s1") {
		t.Fatal("after RemoveSessions s1 must be gone from the live tree")
	}
	// Drain the session.delete emit from RemoveSessions.
	drainKind(ch, KindSessionDelete)

	// Simulate the clobber: a stale session.updated with archived=null.
	s.Apply(evUpsert(sessInfo("s1", "", 0)))

	// The tombstone must block re-insertion.
	if containsID(sessIDs(s.Snapshot(nil)), "s1") {
		t.Fatal("RESURRECTION: stale session.updated (archived=null) re-inserted tombstoned s1")
	}
	// And must NOT emit a KindSessionUpsert for it.
	if upserts := drainKind(ch, KindSessionUpsert); len(upserts) != 0 {
		t.Fatalf("tombstone must suppress KindSessionUpsert for s1; got %d", len(upserts))
	}
}

// TestArchiveTombstone_BlocksPromotionViaStatusReconcile verifies the mirror
// guard in setActivityLocked: a busy status for a tombstoned id (from the
// periodic status reconcile or a live session.status event) must NOT record
// activity or emit for it, so the session cannot be re-promoted via the
// activity path while tombstoned.
func TestArchiveTombstone_BlocksPromotionViaStatusReconcile(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"s1","title":"root"}}`))

	ch, unsub := s.Subscribe(64)
	defer unsub()

	s.RemoveSessions([]string{"s1"})
	drainKind(ch, KindSessionDelete)

	// Status reconcile reports s1 as busy (the subagent is still running).
	statuses := map[string]json.RawMessage{
		"s1": json.RawMessage(`{"type":"busy"}`),
	}
	s.SetActivityFromStatuses(statuses)

	// No KindActivity emit for the tombstoned id.
	for _, e := range drainKind(ch, KindActivity) {
		t.Fatalf("tombstone must suppress KindActivity for s1; got %v", e)
	}
	// Session stays out of the live tree.
	if containsID(sessIDs(s.Snapshot(nil)), "s1") {
		t.Fatal("status reconcile resurrected tombstoned s1")
	}
}

// TestArchiveTombstone_LiveStatusEventBlocked verifies that a LIVE
// session.status:busy event (not just the reconcile path) for a tombstoned id
// is also suppressed.
func TestArchiveTombstone_LiveStatusEventBlocked(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"s1","title":"root"}}`))

	ch, unsub := s.Subscribe(64)
	defer unsub()

	s.RemoveSessions([]string{"s1"})
	drainKind(ch, KindSessionDelete)

	s.Apply(ev("session.status", `{"sessionID":"s1","status":{"type":"busy"}}`))

	for _, e := range drainKind(ch, KindActivity) {
		t.Fatalf("tombstone must suppress KindActivity for s1 from live status event; got %v", e)
	}
}

// TestArchiveTombstone_ExpiresAndAllowsReinsertion verifies the tombstone has a
// bounded TTL: after it expires, a session.updated with archived=null is
// processed normally (so a genuine re-creation or a long-delayed event isn't
// suppressed forever).
func TestArchiveTombstone_ExpiresAndAllowsReinsertion(t *testing.T) {
	// Use a short TTL for the test.
	prev := recentArchiveTTL
	recentArchiveTTL = 5 * time.Millisecond
	t.Cleanup(func() { recentArchiveTTL = prev })

	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"s1","title":"root"}}`))
	s.RemoveSessions([]string{"s1"})

	// While tombstoned: blocked.
	s.Apply(evUpsert(sessInfo("s1", "", 0)))
	if containsID(sessIDs(s.Snapshot(nil)), "s1") {
		t.Fatal("tombstone should block re-insertion before expiry")
	}

	// Wait for expiry.
	time.Sleep(20 * time.Millisecond)

	// After expiry: a session.updated is processed normally.
	s.Apply(evUpsert(sessInfo("s1", "", 0)))
	if !containsID(sessIDs(s.Snapshot(nil)), "s1") {
		t.Fatal("after tombstone expiry, session.updated must re-insert s1")
	}
}

// TestArchiveTombstone_HydrateDoesNotClearTombstone is the regression for the
// blocker found in review (b-F1): the generic authoritative Hydrate must NOT
// clear the tombstone for an active (archived=null) upstream record, because a
// hydrate cannot distinguish a GENUINE unarchive from a STALE CLOBBER (both
// carry archived=null). During the archive re-assert window, a reconnect- or
// reload-triggered hydrate can receive the exact stale clobbered record the
// tombstone is meant to prevent; clearing here would re-install the session
// and leave it unguarded so the next busy status re-promotes it. The tombstone
// is cleared ONLY by the explicit unarchive flow (ClearArchiveTombstones).
func TestArchiveTombstone_HydrateDoesNotClearTombstone(t *testing.T) {
	prev := recentArchiveTTL
	recentArchiveTTL = 5 * time.Minute // long enough to not expire during the test
	t.Cleanup(func() { recentArchiveTTL = prev })

	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"s1","title":"root"}}`))
	s.RemoveSessions([]string{"s1"})

	// Tombstone is active: a stale session.updated is blocked.
	s.Apply(evUpsert(sessInfo("s1", "", 0)))
	if containsID(sessIDs(s.Snapshot(nil)), "s1") {
		t.Fatal("tombstone should block before Hydrate")
	}

	// Hydrate receives the STALE CLOBBER shape (archived=null) during the
	// re-assert window. It must NOT re-insert s1 — the tombstone holds.
	s.Hydrate([]json.RawMessage{sessInfo("s1", "", 0)}, nil)
	if containsID(sessIDs(s.Snapshot(nil)), "s1") {
		t.Fatal("Hydrate must NOT re-insert tombstoned s1 (stale-clobber shape); " +
			"only the explicit unarchive flow clears the tombstone")
	}

	// The explicit unarchive flow clears the tombstone, THEN Hydrate re-inserts.
	s.ClearArchiveTombstones([]string{"s1"})
	s.Hydrate([]json.RawMessage{sessInfo("s1", "", 0)}, nil)
	if !containsID(sessIDs(s.Snapshot(nil)), "s1") {
		t.Fatal("after ClearArchiveTombstones, Hydrate must re-insert genuinely active s1")
	}

	// After the explicit clear, a session.updated is processed normally.
	s.Apply(evUpsert(sessInfo("s1", "", 0)))
	if !containsID(sessIDs(s.Snapshot(nil)), "s1") {
		t.Fatal("after ClearArchiveTombstones, session.updated must keep s1")
	}
}

// TestArchiveTombstone_ArchivedEventStillDeletes verifies the tombstone does
// NOT interfere with the existing archivedAt→delete path: a session.updated
// with archived SET (time.archived non-zero) on a tombstoned id is still a
// no-op delete (the id is already gone), not an error or resurrection.
func TestArchiveTombstone_ArchivedEventStillNoop(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"s1","title":"root"}}`))
	s.RemoveSessions([]string{"s1"})

	// A session.updated with archived set — idempotent delete (already gone).
	s.Apply(evUpsert(sessInfo("s1", "", 1234567890.0)))
	if containsID(sessIDs(s.Snapshot(nil)), "s1") {
		t.Fatal("archived event must not resurrect s1")
	}
}
