package state

// Phase-2 (tunnel-amp finding B) unit tests for the frontier-membership
// counter (Store.frontierSeq / FrontierSeq()). This counter is the
// DIAGNOSTICS-ONLY mirror of the per-event ClientEvent.FrontierChanged flag
// (retained for observability — not yet wired to /vh/diag/latency). The
// stream handler gates the promotion-coalesce arm on FrontierChanged, NOT on
// this counter — but the two MUST stay
// consistent (same bump predicate) so the diagnostics counter faithfully
// reflects what the gate decided.
//
// The counter must advance on genuine frontier changes (create / delete /
// reparent / pending-input boundary / the FIRST activity of a previously-
// inactive session) and must NOT advance on activity flips of an already-
// materialized session — the exact amplifier (busy↔retry churn of active
// subagents re-shipping a full ~74KB tree snapshot per flip) the fix kills.
//
// These tests isolate the Store contract from the handler: they assert the
// raw counter deltas directly, so a regression in bumpFrontierSeqLocked's
// placement surfaces here as a wrong delta rather than as a flaky
// integration timing failure.

import (
	"testing"
	"time"
)

// assertFrontierSeq is a small helper that pins the counter at want after a
// label, failing with both values for diagnosis.
func assertFrontierSeq(t *testing.T, s *Store, want uint64, label string) {
	t.Helper()
	if got := s.FrontierSeq(); got != want {
		t.Fatalf("frontierSeq %s: want %d, got %d", label, want, got)
	}
}

// TestFrontierSeq_CreateDeleteBumps proves the two unconditional frontier
// changes. session.created and session deletion both change live-tree
// membership, so each must bump the counter exactly once.
func TestFrontierSeq_CreateDeleteBumps(t *testing.T) {
	s := New(100)
	assertFrontierSeq(t, s, 0, "fresh store")

	s.Apply(ev("session.created", evSessionCreated("a", "")))
	assertFrontierSeq(t, s, 1, "after create a")

	s.Apply(ev("session.created", evSessionCreated("b", "a")))
	assertFrontierSeq(t, s, 2, "after create b (child)")

	// A metadata-only session.updated (same parent) re-runs
	// upsertSessionLocked but does NOT change frontier membership (the session
	// was already materialized, stays materialized). After the F1 fix, it must
	// NOT bump frontierSeq. structuralRevision still bumps (client staleness).
	s.Apply(ev("session.updated", evSessionUpdated("b", "a")))
	assertFrontierSeq(t, s, 2, "after session.updated b (same parent, metadata-only)")

	// A genuine reparent (parent changed) DOES change frontier topology.
	s.Apply(ev("session.updated", evSessionUpdated("b", "")))
	assertFrontierSeq(t, s, 3, "after session.updated b (reparent to root)")

	// Archive routes through deleteSessionLocked.
	s.Apply(ev("session.created", evSessionArchived("b")))
	assertFrontierSeq(t, s, 4, "after archive (delete) b")
}

// TestFrontierSeq_FirstActivityOfFreshSessionBumps is the genuine-promotion
// case: a freshly-created session (no activity, never touched) receiving its
// first busy is a real idle-stub → active promotion, so frontierSeq MUST bump.
// This is the case the promotion coalesce must still arm for (a stub going
// busy carries only activity state on the wire, not the materialization
// payload, so the client cannot self-promote).
func TestFrontierSeq_FirstActivityOfFreshSessionBumps(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", evSessionCreated("a", "")))
	assertFrontierSeq(t, s, 1, "after create")

	// First busy of a never-touched session: genuine promotion.
	s.Apply(ev("session.status", evStatus("a", "busy")))
	assertFrontierSeq(t, s, 2, "after first busy (genuine promotion)")
}

// TestFrontierSeq_BusyRetryFlipOfActiveSessionDoesNotBump is THE amplifier
// regression guard. Once a session is busy, flipping busy↔retry is the
// high-frequency churn of running subagents. Both count as "busy" for
// subtreeBusyCount (wasBusy==isBusy → early-return), and the session is
// already selfActive, so frontierSeq MUST NOT bump. Before the fix, every
// such flip armed a full re-snapshot (~16.6 MB/hr with one flapping session).
func TestFrontierSeq_BusyRetryFlipOfActiveSessionDoesNotBump(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", evSessionCreated("a", "")))
	s.Apply(ev("session.status", evStatus("a", "busy")))
	seqAfterBusy := s.FrontierSeq()

	// busy → retry: wasBusy==isBusy early-return; no frontier change.
	s.Apply(ev("session.status", evStatus("a", "retry")))
	assertFrontierSeq(t, s, seqAfterBusy, "after busy→retry flip (amplifier case)")

	// retry → busy: same early-return; no frontier change.
	s.Apply(ev("session.status", evStatus("a", "busy")))
	assertFrontierSeq(t, s, seqAfterBusy, "after retry→busy flip")
}

// TestFrontierSeq_IdleBusyChurnOfWarmSessionDoesNotBump covers the second
// amplifier shape: a session that goes busy → idle → busy within the recent
// (10-min) cutoff window stays selfActive the whole time (the recent window
// keeps lastActivityAt fresh), so the second busy is NOT a genuine promotion.
// Without this guard the idle↔busy cycle of a frequently-pausing subagent
// would re-arm the re-snapshot on every cycle.
func TestFrontierSeq_IdleBusyChurnOfWarmSessionDoesNotBump(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", evSessionCreated("a", "")))
	s.Apply(ev("session.status", evStatus("a", "busy")))
	seqAfterFirstBusy := s.FrontierSeq()

	// busy → idle: NOT a frontier change. The session just had activity, so
	// it stays inside the recent cutoff window (selfActive via recency).
	s.Apply(ev("session.idle", evIdle("a")))
	assertFrontierSeq(t, s, seqAfterFirstBusy, "after busy→idle (still warm)")

	// idle → busy within the cutoff window: NOT a promotion (selfActive was
	// already true via recency). No bump.
	s.Apply(ev("session.status", evStatus("a", "busy")))
	assertFrontierSeq(t, s, seqAfterFirstBusy, "after idle→busy churn (warm)")
}

// TestFrontierSeq_PhantomStatusEventDoesNotBump proves the phantom guard. A
// session.status for an UNKNOWN session id must not bump the counter (the
// session is seeded on create; a stray status event for a phantom carries no
// frontier change). This prevents a malformed/late event from arming a
// spurious re-snapshot.
func TestFrontierSeq_PhantomStatusEventDoesNotBump(t *testing.T) {
	s := New(100)
	assertFrontierSeq(t, s, 0, "fresh store")

	// Status event for a session that was never created.
	s.Apply(ev("session.status", evStatus("ghost", "busy")))
	assertFrontierSeq(t, s, 0, "after phantom status (no create yet)")
}

// TestFrontierSeq_ColdSessionNonBusyActivityBumps is the B1 regression guard.
// A session that goes idle PAST the cutoff and then receives a NON-busy
// activity (e.g. ActivityError from a messages-stream error) is a genuine
// promotion: it was !wasSelfActive (idle past cutoff) and now becomes
// materialized (touchActivityTimeLocked makes it recent). Before the B1 fix,
// curFrontierChanged was stamped true but bumpFrontierSeqLocked sat AFTER the
// wasBusy==isBusy early-return (both non-busy → skip), so the diagnostics
// counter diverged from the gate flag. After the fix, both bump from the same
// predicate — this test pins that consistency.
func TestFrontierSeq_ColdSessionNonBusyActivityBumps(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", evSessionCreated("a", "")))
	s.Apply(ev("session.status", evStatus("a", "busy")))
	seqAfterBusy := s.FrontierSeq() // create + first-busy promotion

	// busy → idle: still warm (recent cutoff window). No bump.
	s.Apply(ev("session.idle", evIdle("a")))
	assertFrontierSeq(t, s, seqAfterBusy, "after busy→idle (warm)")

	// Shrink the cutoff so the session goes cold.
	SetProjectionCutoffForTest(50*time.Millisecond, 2)
	defer SetProjectionCutoffForTest(0, 0)
	time.Sleep(120 * time.Millisecond)

	// Now "a" is idle PAST the cutoff → wasSelfActive=false. Apply a NON-busy
	// activity directly (ActivityError, set via the messages-error path —
	// unreachable via session.status/normalizeActivity which maps non-busy to
	// idle). Both prev (idle) and new (error) are non-busy → wasBusy==isBusy
	// → the subtreeBusyCount early-return fires. Before the B1 fix, frontierSeq
	// was NOT bumped here (diverging from the FrontierChanged=true flag). After
	// the fix, the bump runs from the same predicate before the early-return.
	s.mu.Lock()
	s.setActivityLocked("a", ActivityError)
	s.mu.Unlock()
	assertFrontierSeq(t, s, seqAfterBusy+1, "after cold idle→error (non-busy promotion)")
}
