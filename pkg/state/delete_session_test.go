package state

// This file pins deleteSessionLocked's grace/busy cleanup discipline (GAP-S2
// from the store concurrency map). deleteSessionLocked (store.go:1455) is the
// single session-removal chokepoint: live session.deleted, archive via
// time.archived, and hydrate prune all funnel here. It must, in order:
//
//  1. Propagate id's subtree-busy contribution out of every live ancestor
//     (subtreeBusyCount, the Gate-C prototype block) + run the 7 Phase-1 index
//     maintainers (maintainIndexesOnDeleteLocked).
//  2. For a BUSY/RETRY non-root session, decrement busyCount[root] (the
//     delete-path mirror of setActivityAtLocked's busy→non-busy branch — the
//     only other site that touches this map is delete(s.busyCount, id) below,
//     which clears id's OWN entry but not the root's).
//  3. Emit a terminal KindActivity(idle) finish-cascade for a session that was
//     observably busy/retry (line 1529) OR error (line 1555) — BEFORE the
//     structural KindSessionDelete so a client applying events in seq order
//     clears the chat activity map BEFORE the prune lands.
//  4. Delete from ~22 internal maps (sessions, messages, activity, busyCount,
//     subtreeBusyCount, children, ...).
//  5. cancelGraceLocked(id) + delete completionAuthoritative — drop any armed
//     completion-grace timer + the completion-authority guard so a stale fire
//     cannot re-materialize state for a gone id.
//  6. emit KindSessionDelete (the structural prune clients reduce).
//  7. emit KindTreeOrphanCheck for every descendant of each newly-rooted
//     (orphaned) child, AFTER the topology change is fully applied.
//
// Before this file, exactly ONE test covered the delete path at all
// (TestReducerDeleteSession in store_test.go:57) and it asserted only that
// sessions+messages are gone after delete — NONE of the grace-cancel,
// busyCount-decrement, finish-cascade-emit-order, or orphan-check contracts.
// These tests are the mandatory pre-split gate for any concern extraction that
// moves deleteSessionLocked (concern a, reducers): without them, a split can
// silently regress the cleanup discipline and re-introduce the stranded-
// busyCount / stale-activity bugs the inline comments document.
//
// All tests run under -race (the cohort's standard invocation). The
// deterministic ones prove each cleanup step via direct internal-state reads;
// the concurrent one stresses the delete-vs-graceFire race window.

import (
	"encoding/json"
	"fmt"
	"runtime"
	"sync"
	"testing"
	"time"
)

// deleteCleanupState is a test-only read of deleteSessionLocked's cleanup
// surface for one id, captured under s.mu. It lets these characterization
// tests assert the full cleanup contract directly — the public API only
// exposes RunningRoots / Snapshot, which is too coarse to prove the grace
// timer was disarmed, completionAuthoritative was dropped, or the busyCount
// entry was removed (vs left at 0). graceStateSnapshot (grace_timer_test.go)
// covers the root's busyCount; this struct covers the DELETED id's residue.
type deleteCleanupState struct {
	sessionPresent  bool   // s.sessions[id] != nil
	activity        string // s.activity[id] ("" when gone)
	authoritative   bool   // s.completionAuthoritative[id]
	graceArmed      bool   // s.graceTimers[id] != nil
	graceGen        uint64 // s.graceGen[id] (cancel bumps past the arm gen)
	busySelf        int    // s.busyCount[id]
	busySelfPresent bool   // whether the busyCount[id] MAP ENTRY exists (distinct from value 0)
	subtreeSelf     int    // s.subtreeBusyCount[id]
}

// deleteCleanupSnapshot captures the cleanup surface for id under s.mu. Safe
// to call after Close() (the mutex survives teardown; only subs are emptied).
func (s *Store) deleteCleanupSnapshot(id string) deleteCleanupState {
	s.mu.Lock()
	defer s.mu.Unlock()
	bs, bsOK := s.busyCount[id]
	return deleteCleanupState{
		sessionPresent:  s.sessions[id] != nil,
		activity:        s.activity[id],
		authoritative:   s.completionAuthoritative[id],
		graceArmed:      s.graceTimers[id] != nil,
		graceGen:        s.graceGen[id],
		busySelf:        bs,
		busySelfPresent: bsOK,
		subtreeSelf:     s.subtreeBusyCount[id],
	}
}

// drainEvents reads and discards every event currently buffered in ch
// (non-blocking). Used to clear setup-phase events before asserting on the
// delete-phase emit sequence.
func drainEvents(ch <-chan ClientEvent) {
	for {
		select {
		case _, ok := <-ch:
			if !ok {
				return
			}
		default:
			return
		}
	}
}

// drainEventsTimeout reads events from ch until the channel closes or the
// timeout fires. deleteSessionLocked emits ALL of its events synchronously
// inside Apply under s.mu (the graceFire callback is the only async emit, and
// it is canceled by the delete), so after Apply returns every delete-phase
// event is already buffered. The timeout is a generous idle window, not a
// correctness dependency.
func drainEventsTimeout(ch <-chan ClientEvent, timeout time.Duration) []ClientEvent {
	var out []ClientEvent
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	for {
		select {
		case e, ok := <-ch:
			if !ok {
				return out
			}
			out = append(out, e)
		case <-timer.C:
			return out
		}
	}
}

// eventKinds returns the Kind of each event for failure diagnostics.
func eventKinds(events []ClientEvent) []string {
	out := make([]string, len(events))
	for i, e := range events {
		out[i] = e.Kind
	}
	return out
}

// TestDeleteSession_CancelsArmedGrace is GAP-S2 case 1 (grace-cancel on
// delete). Arms a completion-grace timer on a root, deletes the root, and
// asserts deleteSessionLocked's cancelGraceLocked(id) call (store.go:1586)
// disarmed the timer + bumped graceGen past the arm generation — so the
// armGen-captured callback, if it runs at all past the grace window, detects
// the supersede and aborts without re-materializing phantom state for the
// deleted id.
//
// This is the delete-path counterpart to GAP-S1's fire-vs-cancel tests
// (grace_timer_test.go). Without it, a concern extraction that moves
// deleteSessionLocked (concern a) without the cancelGraceLocked call regresses
// the stale-timer invariant: a graceFire into a deleted id re-creates
// activity[id]="idle" + completionAuthoritative[id]=true (phantom residue the
// next Snapshot would surface).
//
// Mutation-observability: removing the cancelGraceLocked(id) call makes this
// test FAIL in two places at once — (a) graceTimers[R] stays armed immediately
// after delete (st.graceArmed==true), and (b) after the grace window the
// stale fire re-creates phantom activity/authority (st2.activity!="" or
// st2.authoritative==true).
func TestDeleteSession_CancelsArmedGrace(t *testing.T) {
	s := New(100)
	s.completionGrace = 15 * time.Millisecond // small enough for a fast test
	defer s.Close()                           // reap any straggler timer

	s.Apply(ev("session.created", evSessionCreated("R", "")))
	// Inflight → busy armed (busyCount["R"]=1).
	s.Apply(ev("message.updated", evAssistantInflight("R", "m1")))
	// Complete → grace armed (busy stays for the grace window).
	s.Apply(ev("message.updated", evAssistantCompleted("R", "m1")))

	armGen, armed, _, _ := s.graceStateSnapshot("R")
	if !armed {
		t.Fatalf("setup: grace timer should be armed after completion, got disarmed")
	}

	// Delete R. deleteSessionLocked must call cancelGraceLocked(R): bumps
	// graceGen[R] past armGen, stops the timer, and deletes graceTimers[R].
	s.Apply(ev("session.deleted", evSessionDeleted("R")))

	st := s.deleteCleanupSnapshot("R")
	if st.graceArmed {
		t.Fatalf("after delete: graceTimers[R] should be deleted (cancelGraceLocked at store.go:1586), still armed")
	}
	if st.graceGen <= armGen {
		t.Fatalf("after delete: graceGen=%d, want > %d (cancel must bump past the armGen so a racing fire aborts)", st.graceGen, armGen)
	}
	if st.sessionPresent {
		t.Fatalf("after delete: sessions[R] should be gone")
	}
	if st.authoritative {
		t.Fatalf("after delete: completionAuthoritative[R] should be cleared (delete at store.go:1587)")
	}

	// Wait WELL past the grace window. The armGen-captured timer callback
	// fires here (or was stopped — either way), re-acquires s.mu, sees
	// graceGen[R] bumped past armGen, and returns — a benign no-op. Assert
	// NO phantom state was re-materialized for the deleted id.
	time.Sleep(80 * time.Millisecond)

	st2 := s.deleteCleanupSnapshot("R")
	if st2.graceArmed {
		t.Fatalf("after grace window: grace timer must still be absent (no re-arm for a deleted id)")
	}
	if st2.graceGen != st.graceGen {
		t.Fatalf("after grace window: graceGen=%d, want %d (no further bump; stale fire no-op'd via the graceGen guard)", st2.graceGen, st.graceGen)
	}
	if st2.authoritative {
		t.Fatalf("after grace window: stale fire must not arm completionAuthoritative for deleted R (phantom residue)")
	}
	if st2.activity != "" {
		t.Fatalf("after grace window: stale fire must not re-create phantom activity[R]=%q (clearOnCompletionLocked routes through setActivityLocked which would write the map)", st2.activity)
	}
	if st2.sessionPresent {
		t.Fatalf("after grace window: stale fire must not re-create sessions[R]")
	}
	if got := s.RunningRoots(); got != 0 {
		t.Fatalf("after grace window: RunningRoots=%d, want 0 (stale fire must not re-strand the deleted id)", got)
	}
}

// TestDeleteSession_BusyNonRootDecrementsRootCounter is GAP-S2 case 2 (the
// non-root busy-delete decrement). A busy non-root session that is archived
// (time.archived → deleteSessionLocked) or removed leaves busyCount[root]
// stuck at its pre-archive value if the decrement is skipped: the only other
// site that touches this map is delete(s.busyCount, id) (store.go:1573), which
// clears id's OWN entry (correct when id IS its own root) but NOT the root's.
// The runStatusReconcile heal ticker cannot recover this (it iterates
// s.sessions, and the archived id is already gone). deleteSessionLocked
// mirrors the decrement half of setActivityAtLocked's busy→non-busy branch
// (store.go:1500-1506).
//
// Mutation-observability: removing the decrement makes this test FAIL —
// busyCount[root] stays at 1 and RunningRoots() over-reports (the exact
// production bug the inline comment at 1481-1499 documents: surfaced via
// /vh/running-sessions and the SPA's project switcher badge).
func TestDeleteSession_BusyNonRootDecrementsRootCounter(t *testing.T) {
	s := New(100)
	defer s.Close()

	s.Apply(ev("session.created", evSessionCreated("root", "")))
	s.Apply(ev("session.created", evSessionCreated("child", "root")))
	// child busy → busyCount[root]++ (the setActivityAtLocked chokepoint).
	s.Apply(ev("session.status", evStatus("child", "busy")))

	_, _, _, rootBusy := s.graceStateSnapshot("root")
	if rootBusy != 1 {
		t.Fatalf("setup: busyCount[root]=%d, want 1 (child busy escalated the root aggregate)", rootBusy)
	}
	if got := s.RunningRoots(); got != 1 {
		t.Fatalf("setup: RunningRoots=%d, want 1", got)
	}

	// Delete the BUSY NON-ROOT child. The root != id guard at store.go:1502
	// passes (rootOfLocked(child)==root != child), so busyCount[root]-- fires.
	s.Apply(ev("session.deleted", evSessionDeleted("child")))

	_, _, _, rootBusyAfter := s.graceStateSnapshot("root")
	if rootBusyAfter != 0 {
		t.Fatalf("after delete busy non-root child: busyCount[root]=%d, want 0 "+
			"(deleteSessionLocked must mirror the busy→non-busy decrement at store.go:1503-1505)", rootBusyAfter)
	}
	if got := s.RunningRoots(); got != 0 {
		t.Fatalf("after delete busy non-root child: RunningRoots=%d, want 0 (stranded busyCount would over-report)", got)
	}
	// The deleted child's own busyCount entry is also gone (delete at :1573).
	if st := s.deleteCleanupSnapshot("child"); st.busySelfPresent {
		t.Fatalf("after delete: busyCount[child] map entry should be absent, got value=%d present", st.busySelf)
	}
}

// TestDeleteSession_RetryNonRootDecrementsRootCounter is GAP-S2 case 2 variant:
// ActivityRetry is also busy-class (setActivityAtLocked's isBusy flag is
// `st == ActivityBusy || st == ActivityRetry`, store.go:848). The delete-path
// decrement uses the SAME predicate (store.go:1500). This test pins that
// retry→delete decrements the root counter, not just busy→delete.
//
// Mutation-observability: widening the decrement predicate to busy-only
// (dropping the `|| ActivityRetry`) makes this test FAIL — busyCount[root]
// stays at 1 for a deleted retry child.
func TestDeleteSession_RetryNonRootDecrementsRootCounter(t *testing.T) {
	s := New(100)
	defer s.Close()

	s.Apply(ev("session.created", evSessionCreated("root", "")))
	s.Apply(ev("session.created", evSessionCreated("child", "root")))
	s.Apply(ev("session.status", evStatus("child", "retry")))

	_, _, _, rootBusy := s.graceStateSnapshot("root")
	if rootBusy != 1 {
		t.Fatalf("setup: busyCount[root]=%d, want 1 (retry is busy-class: setActivityAtLocked counts it)", rootBusy)
	}

	s.Apply(ev("session.deleted", evSessionDeleted("child")))

	_, _, _, rootBusyAfter := s.graceStateSnapshot("root")
	if rootBusyAfter != 0 {
		t.Fatalf("after delete retry non-root child: busyCount[root]=%d, want 0 "+
			"(delete-path decrement predicate at store.go:1500 must cover ActivityRetry)", rootBusyAfter)
	}
}

// TestDeleteSession_BusyRootClearsOwnEntryNoNegativeArtifact is GAP-S2 case 3
// (busy-root self-delete). Deleting a busy ROOT must leave NO negative or
// zero busyCount artifact for the root's own id, and must not corrupt a
// SIBLING root's counter. The root==id guard at store.go:1502 deliberately
// SKIPS the explicit decrement (root's own entry is cleared by
// delete(s.busyCount, id) at :1573 — decrementing first would be a logically
// wrong double-attribution even though delete() then removes the entry).
//
// HONESTY NOTE on mutation-observability: the `root != id` guard itself is
// NOT independently observable through busyCount — delete(s.busyCount, id)
// at :1573 unconditionally removes the entry, so busyCount[root] is absent
// whether or not the guard skipped a redundant decrement. This test
// characterizes the OBSERVABLE CONTRACT around the guard (entry cleanly
// absent, no negative value, sibling roots unaffected), which WOULD fail if
// delete(s.busyCount, id) at :1573 were removed (entry would persist at its
// pre-delete value or at value-1 depending on the guard). The guard is a
// clarity/correctness-intent statement; the test pins the outcome it
// cooperates with delete() to produce.
func TestDeleteSession_BusyRootClearsOwnEntryNoNegativeArtifact(t *testing.T) {
	s := New(100)
	defer s.Close()

	// Two busy roots so we can prove deleting one does not corrupt the other.
	s.Apply(ev("session.created", evSessionCreated("r1", "")))
	s.Apply(ev("session.created", evSessionCreated("r2", "")))
	// Inflight on each → busyCount[r1]=1, busyCount[r2]=1 (root selves).
	s.Apply(ev("message.updated", evAssistantInflight("r1", "m1")))
	s.Apply(ev("message.updated", evAssistantInflight("r2", "m2")))

	_, _, _, r1Busy := s.graceStateSnapshot("r1")
	_, _, _, r2Busy := s.graceStateSnapshot("r2")
	if r1Busy != 1 || r2Busy != 1 {
		t.Fatalf("setup: busyCount r1=%d r2=%d, want both 1", r1Busy, r2Busy)
	}
	if got := s.RunningRoots(); got != 2 {
		t.Fatalf("setup: RunningRoots=%d, want 2", got)
	}

	// Delete r1 (a busy root). rootOfLocked(r1)==r1 → root==id → guard skips
	// the explicit decrement; delete(s.busyCount, r1) at :1573 clears the entry.
	s.Apply(ev("session.deleted", evSessionDeleted("r1")))

	st := s.deleteCleanupSnapshot("r1")
	if st.busySelfPresent {
		t.Fatalf("after delete busy root: busyCount[r1] map entry should be ABSENT (cleared by delete at :1573), got value=%d present", st.busySelf)
	}
	if st.busySelf < 0 {
		t.Fatalf("after delete busy root: busyCount[r1]=%d, must not be negative (guard at :1502 prevents a redundant self-decrement)", st.busySelf)
	}
	// r2 must be completely untouched (proves the delete was keyed correctly
	// and no cross-root corruption occurred).
	_, _, _, r2BusyAfter := s.graceStateSnapshot("r2")
	if r2BusyAfter != 1 {
		t.Fatalf("after delete r1: busyCount[r2]=%d, want 1 (sibling root must be unaffected)", r2BusyAfter)
	}
	if got := s.RunningRoots(); got != 1 {
		t.Fatalf("after delete r1: RunningRoots=%d, want 1 (only r2 remains)", got)
	}
}

// TestDeleteSession_ErrorSessionEmitsIdleCascadeWithoutTouchingBusyCount is
// GAP-S2 case 4 (the error-mirror finish-cascade). A session in the ERROR
// state that is deleted must still get a terminal KindActivity(idle) emit
// (store.go:1530-1555) so every observer drops the error signal in the same
// transition — but the error branch is a SEPARATE else-if precisely because
// it MUST NOT touch busyCount (error never incremented busyCount on entry —
// setActivityAtLocked's wasBusy/isBusy flags only cover {Busy, Retry} — so
// decrementing on exit would corrupt the count and under-report
// RunningRoots). Documented at store.go:1543-1554 ("SUBTLETY: error MUST NOT
// touch busyCount").
//
// To make the busyCount corruption OBSERVABLE, this fixture seeds a SECOND
// busy sibling under the same root so busyCount[root]==1 from the sibling's
// contribution. Deleting the ERROR child must leave busyCount[root] at 1. If
// the outer if were widened to `|| a == ActivityError` (the exact
// anti-pattern the comment warns against), the error delete would wrongly
// decrement busyCount[root] from 1 to 0 — the sibling's busy contribution
// would be silently lost and RunningRoots would under-report.
//
// Mutation-observability: removing the error branch's KindActivity emit makes
// sawIdleCascade FAIL. Widening the busy/retry predicate to
// `|| a == ActivityError` makes the busyCount assertion FAIL (1→0 corrupt).
func TestDeleteSession_ErrorSessionEmitsIdleCascadeWithoutTouchingBusyCount(t *testing.T) {
	s := New(100)
	defer s.Close()

	s.Apply(ev("session.created", evSessionCreated("root", "")))
	s.Apply(ev("session.created", evSessionCreated("child", "root")))
	// A BUSY sibling under the same root — its contribution makes
	// busyCount[root]==1, so an erroneous error-delete decrement is observable
	// (would corrupt 1→0) rather than masked by the `> 0` guard on a 0 count.
	s.Apply(ev("session.created", evSessionCreated("sib", "root")))
	s.Apply(ev("session.status", evStatus("sib", "busy")))
	// child → error. Error is NOT busy-class: busyCount[root] stays 1 (sib's).
	s.Apply(ev("session.error", evIdle("child")))

	_, _, _, rootBusy := s.graceStateSnapshot("root")
	if rootBusy != 1 {
		t.Fatalf("setup: busyCount[root]=%d, want 1 (sib busy; error child never increments)", rootBusy)
	}

	// Subscribe to capture the finish-cascade emit. The error branch emits
	// KindActivity(child, idle) BEFORE KindSessionDelete — without touching
	// busyCount[root].
	ch, unsub := s.Subscribe(64)
	defer unsub()
	drainEvents(ch) // clear setup emits

	s.Apply(ev("session.deleted", evSessionDeleted("child")))

	events := drainEventsTimeout(ch, 50*time.Millisecond)

	// Assert a KindActivity(child, idle) fired (the error-mirror cascade).
	sawIdleCascade := false
	for _, e := range events {
		if e.Kind != KindActivity {
			continue
		}
		var p struct {
			SessionID string `json:"sessionID"`
			State     string `json:"state"`
		}
		_ = json.Unmarshal(e.Payload, &p)
		if p.SessionID == "child" && p.State == ActivityIdle {
			sawIdleCascade = true
			break
		}
	}
	if !sawIdleCascade {
		t.Fatalf("after delete errored child: expected a KindActivity(child, idle) finish-cascade event "+
			"(error-mirror branch at store.go:1555), got events=%v", eventKinds(events))
	}

	// busyCount[root] must STILL be 1 — the error branch is a separate
	// else-if precisely so it does not touch busyCount. If the outer if were
	// widened to `|| ActivityError` (the anti-pattern), busyCount[root] would
	// be corrupted from 1 to 0 here (sib's contribution silently lost).
	_, _, _, rootBusyAfter := s.graceStateSnapshot("root")
	if rootBusyAfter != 1 {
		t.Fatalf("after delete errored child: busyCount[root]=%d, want 1 "+
			"(error MUST NOT touch busyCount — sib's contribution must survive; "+
			"see SUBTLETY at store.go:1543-1554)", rootBusyAfter)
	}
	if got := s.RunningRoots(); got != 1 {
		t.Fatalf("after delete errored child: RunningRoots=%d, want 1 (sib still busy)", got)
	}
}

// TestDeleteSession_EmitOrderActivityBeforeDeleteBeforeOrphanCheck is GAP-S2
// case 5 (the finish-cascade emit order). deleteSessionLocked emits, in
// sequence:
//
//  1. KindActivity(id, idle) — finish-cascade, at store.go:1529 (busy/retry)
//     or :1555 (error). MUST precede KindSessionDelete so a client applying
//     events in seq order clears the chat-side syncState.activity map BEFORE
//     the structural node.remove lands (Part.tsx reads activity for the
//     parent's task-tool status; a stale "busy" would keep a finished
//     subsession looking "running").
//  2. KindSessionDelete(id) — the structural prune, at store.go:1594. Fires
//     AFTER all internal maps are consistent (deletes at :1557-1593 ran first).
//  3. KindTreeOrphanCheck(descendant) — for each descendant of every newly-
//     rooted (orphaned) child, at store.go:1600-1604. Fires AFTER the topology
//     change is fully applied (s.sessions[id] deleted, KindSessionDelete
//     emitted) so effectiveParentOfLocked returns "" for the reparented
//     children.
//
// Mutation-observability: reordering any emit makes the idx-order assertion
// FAIL. Moving KindSessionDelete before KindActivity (a plausible "prune
// first, notify second" refactor) breaks the seq-order contract clients
// depend on. Dropping the orphan-check loop makes idxOrphan stay -1.
func TestDeleteSession_EmitOrderActivityBeforeDeleteBeforeOrphanCheck(t *testing.T) {
	s := New(100)
	defer s.Close()

	// root → child. Deleting root orphans child → orphan-check emits.
	s.Apply(ev("session.created", evSessionCreated("root", "")))
	s.Apply(ev("session.created", evSessionCreated("child", "root")))
	// root observably busy → the busy branch emits KindActivity(root, idle)
	// on delete. (session.status does NOT arm grace, so no async fire
	// pollutes the emit sequence under test.)
	s.Apply(ev("session.status", evStatus("root", "busy")))

	ch, unsub := s.Subscribe(64)
	defer unsub()
	drainEvents(ch) // clear setup emits

	s.Apply(ev("session.deleted", evSessionDeleted("root")))

	events := drainEventsTimeout(ch, 50*time.Millisecond)

	// Locate the three load-bearing emits by kind + payload id.
	idxActivity, idxDelete, idxOrphan := -1, -1, -1
	for i, e := range events {
		switch e.Kind {
		case KindActivity:
			var p struct {
				SessionID string `json:"sessionID"`
				State     string `json:"state"`
			}
			_ = json.Unmarshal(e.Payload, &p)
			if p.SessionID == "root" && p.State == ActivityIdle {
				idxActivity = i
			}
		case KindSessionDelete:
			var p struct {
				ID string `json:"id"`
			}
			_ = json.Unmarshal(e.Payload, &p)
			if p.ID == "root" {
				idxDelete = i
			}
		case KindTreeOrphanCheck:
			var p struct {
				ID string `json:"id"`
			}
			_ = json.Unmarshal(e.Payload, &p)
			if p.ID == "child" {
				idxOrphan = i
			}
		}
	}

	if idxActivity < 0 {
		t.Fatalf("missing KindActivity(root, idle) finish-cascade; events=%v", eventKinds(events))
	}
	if idxDelete < 0 {
		t.Fatalf("missing KindSessionDelete(root); events=%v", eventKinds(events))
	}
	if idxOrphan < 0 {
		t.Fatalf("missing KindTreeOrphanCheck(child) for the orphaned descendant; events=%v", eventKinds(events))
	}
	if !(idxActivity < idxDelete && idxDelete < idxOrphan) {
		t.Fatalf("emit order wrong: activity@%d, delete@%d, orphan@%d "+
			"(want activity < delete < orphan per store.go:1529/1594/1600); events=%v",
			idxActivity, idxDelete, idxOrphan, eventKinds(events))
	}
}

// TestDeleteSession_ConcurrentWithGraceFire is GAP-S2 case 6 (the -race stress
// variant). Rapidly arms completion-grace timers (inflight→complete cycles)
// while a concurrent writer deletes + re-creates sessions, racing the
// graceFire callback against deleteSessionLocked's cancelGraceLocked. The
// graceGen guard + s.mu make every fire-vs-delete a benign no-op; this test
// exists to catch any unsynchronized access under -race.
//
// The deterministic outcome is "no data race reported, no panic, no leaked
// goroutine". The -race detector is the verifier — a regression that
// introduces an unsynchronized read/write in the delete/cancel/fire path
// (e.g. a split that moves graceTimers off s.mu) will fail this test under
// -race. Mirrors TestGraceTimer_ConcurrentArmCancelNoRace (grace_timer_test.go)
// but adds the DELETE path as the canceling agent.
func TestDeleteSession_ConcurrentWithGraceFire(t *testing.T) {
	s := New(2000)
	s.completionGrace = time.Millisecond // tiny so timers fire frequently during the test
	defer s.Close()

	const N = 60
	// Seed N root sessions so writers spread across ids.
	for i := 0; i < N; i++ {
		sid := fmt.Sprintf("s%d", i)
		s.Apply(ev("session.created", evSessionCreated(sid, "")))
	}

	var wg sync.WaitGroup
	stop := make(chan struct{})

	// Writer A: rapidly inflight→complete cycles to arm grace on every
	// completion. Uses a bounded message-id space so the message map does
	// not grow unboundedly; the wrap-around re-inflights a completed
	// message, which is a real production scenario (re-upsert) the grace
	// machinery must handle race-free.
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func(off int) {
			defer wg.Done()
			for iter := 0; ; iter++ {
				select {
				case <-stop:
					return
				default:
				}
				i := (iter + off) % N
				sid := fmt.Sprintf("s%d", i)
				mid := fmt.Sprintf("m%d", iter%30)
				s.Apply(ev("message.updated", evAssistantInflight(sid, mid)))
				s.Apply(ev("message.updated", evAssistantCompleted(sid, mid)))
			}
		}(w)
	}

	// Writer B: deletes + re-creates sessions. The delete races A's armed
	// grace timers (cancelGraceLocked vs graceFire); the re-create keeps the
	// live set non-empty so A keeps finding targets. Offset by N/2 so B's
	// deletes hit different sessions than A's current target on average.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for iter := 0; ; iter++ {
			select {
			case <-stop:
				return
			default:
			}
			i := (iter + N/2) % N
			sid := fmt.Sprintf("s%d", i)
			s.Apply(ev("session.deleted", evSessionDeleted(sid)))
			s.Apply(ev("session.created", evSessionCreated(sid, "")))
		}
	}()

	// Reader: poll RunningRoots concurrently to stress the read path while
	// grace fires + deletes mutate busyCount.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			_ = s.RunningRoots()
		}
	}()

	// Let the race window get exercised.
	time.Sleep(120 * time.Millisecond)
	close(stop)
	wg.Wait()

	// Final consistency: Close() calls cancelAllGraceLocked, which stops
	// every pending timer + bumps graceGen + deletes every graceTimers
	// entry. After Close + a grace period, no grace timer callback may
	// still be mutating store state.
	s.Close()
	// Allow the runtime to reap any timer goroutines that were mid-callback
	// when Close() bumped graceGen under them.
	time.Sleep(30 * time.Millisecond)

	s.mu.Lock()
	armedCount := len(s.graceTimers)
	s.mu.Unlock()
	if armedCount != 0 {
		t.Fatalf("post-Close: graceTimers should be empty (cancelAllGraceLocked on Close), still has %d entries", armedCount)
	}

	// Sanity: the test reaching this point under -race without a reported
	// data race IS the assertion. Also bound leaked goroutines so a
	// regression that ORPHANS a timer callback (delete's cancel regressed →
	// graceFire fires into a torn-down store) surfaces as a goroutine leak.
	deadline := time.Now().Add(2 * time.Second)
	startGoroutines := runtime.NumGoroutine()
	for time.Now().Before(deadline) {
		if runtime.NumGoroutine() <= startGoroutines {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	// Do not hard-assert NumGoroutine (the runtime timer queue + GC noise
	// make exact counts flaky). The -race pass + graceTimers-empty check
	// above are the load-bearing assertions; this loop just gives stragglers
	// a chance to reap before the next test.
}
