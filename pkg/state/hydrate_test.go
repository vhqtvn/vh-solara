package state

// This file pins the GAP-S3 characterization gap from the store concurrency
// map (.opencode/state/workstreams/refactor-maintainability/
// store-concurrency-map.md §7 GAP-S3, HIGH): Hydrate's DIRECT-ASSIGN index
// maintenance discipline is the gate for the hydration concern extraction
// (concern d in the map's §6).
//
// Hydrate (store.go:2593) bypasses the normal upsertSessionLocked path and
// assigns s.sessions[sid] DIRECTLY. It then owns the consistency of every
// derived map itself — a subtly different maintenance surface than Apply's
// reducer path. The load-bearing sequence, ALL under s.mu and in this exact
// order, is:
//
//   1. s.cancelAllGraceLocked()               ← GAP-S3's namesake concern
//   2. per session: s.sessions[id] = &sessionEntry{...}   (direct assign,
//      guarded by `old == nil || !bytes.Equal(old.info, info)`)
//   3. per assigned session: the 6 subtree-index maintainers
//      (maintainSubtreeBusy / Children / Retry / PendingInput / Descendant /
//      NewestActivity — each `...OnSessionUpsertLocked`), in that order
//   4. per unseen session: deleteSessionLocked (the cleanup chokepoint —
//      maintains busyCount, cancels per-session grace, drops
//      completionAuthoritative, maintains the delete-side subtree indexes,
//      emits the finish-cascade)
//   5. per provided messages[sid]: reconcileMessagesLocked, which bumps
//      msgRev[sid] via bumpMsgRev (the cold-batch ABA token)
//   6. publishColdBatch(sid) per cold-loaded session, OUTSIDE the lock
//
// If any index maintainer in step 3 is skipped, the derived maps drift from
// the authoritative sessions map. If step 1 is skipped, a grace timer armed
// against the pre-reconnect live stream fires post-hydrate and strands/
// corrupts busy state. If step 5's bumpMsgRev is skipped, the cold-batch ABA
// guard loses its token.
//
// Coverage note: TestSubtreeIndexes_TargetedScenarios/hydrate_reabsorbs_and_
// reconciles (subtree_indexes_test.go) already exercises Hydrate against the
// 7 Phase-1 subtree indexes via assertSubtreeIndexes. This file COMPLEMENTS
// that coverage with the surfaces it does NOT pin:
//   - the direct-assign itself (s.sessions[id] field shape, not just indexes)
//   - subtreeBusyCount (the Gate C prototype count index) across a hydrate
//     that re-assigns busy/pending sessions
//   - the cancelAllGraceLocked contract (GAP-S3's namesake — no test covered
//     it before; TestHydrateDiffEmitsOnlyChanges does not touch grace state)
//   - the idempotent / replace contract on info-byte change
//   - the msgRev bump from reconcileMessagesLocked
//
// Mutation-observability is documented per test: each test names the exact
// maintainer whose removal would flip it red. All tests run under -race
// (the cohort's standard invocation).

import (
	"encoding/json"
	"testing"
	"time"
)

// hydrateAssignSnapshot is a test-only read of the DIRECT-ASSIGN path's
// ground truth for one session, captured under s.mu. It lets these tests
// assert the direct-assign contract (Hydrate writes &sessionEntry{id,
// parentID, info} straight into s.sessions, bypassing upsertSessionLocked)
// by reading the entry's denormalized fields — not just the derived indexes
// or the public HasSession bool. The public API cannot distinguish a
// direct-assigned entry from one created via the reducer; the field-shape
// read can.
//
// `infoBytes` is a copy (the entry's underlying json.RawMessage aliases the
// caller's input); tests must not mutate it. Returns present=false when the
// id is not in s.sessions.
func (s *Store) hydrateAssignSnapshot(id string) (present bool, parentID string, infoBytes []byte) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	se := s.sessions[id]
	if se == nil {
		return false, "", nil
	}
	cp := make([]byte, len(se.info))
	copy(cp, se.info)
	return true, se.parentID, cp
}

// msgRevSnapshot reads s.msgRev[sid] under s.mu. The msgRev token is a private
// map read in the cold-batch ABA tests (store_test.go:1749 reads it bare);
// this helper centralizes the locked read for the Hydrate characterization so
// the comparison is race-clean under -race. Returns 0 when the session was
// never mutated (Go map zero value — a valid "never bumped" baseline, see the
// msgRev field comment at store.go:599-628).
func (s *Store) msgRevSnapshot(sid string) uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.msgRev[sid]
}

// containsString is a tiny test-only membership check for the unordered
// slices returned by the read-side API (Descendants, SessionIDs). Kept local
// to avoid colliding with the equalStrings / sortStringsInPlace helpers in
// the subtree-index test files.
func containsString(haystack []string, needle string) bool {
	for _, s := range haystack {
		if s == needle {
			return true
		}
	}
	return false
}

// TestHydrate_SessionAssignedDirectly is GAP-S3 case 1: the direct-assign
// path. Hydrate writes &sessionEntry{id, parentID, info} straight into
// s.sessions (store.go:2633), bypassing upsertSessionLocked. This test pins
// the field shape so a split that reroutes Hydrate through a different
// constructor (or drops the denormalized parentID/info) is caught.
//
// Mutation-observability: if the line `s.sessions[env.ID] = &sessionEntry{...}`
// (store.go:2633) were removed, no entry would land in s.sessions — the
// present/parentID/info assertions fail immediately, and HasSession returns
// false. If the entry were constructed without parentID, the reparent
// assertion (child under root) fails.
func TestHydrate_SessionAssignedDirectly(t *testing.T) {
	s := New(100)

	// Hydrate a root and a child. RawMessage is the INNER info object (Hydrate
	// takes session info directly, NOT the {"info":...} wrapper that Apply
	// consumes).
	s.Hydrate(
		[]json.RawMessage{
			json.RawMessage(`{"id":"R","title":"root"}`),
			json.RawMessage(`{"id":"C","parentID":"R","title":"child"}`),
		},
		map[string][]MessageWithParts{}, // no messages on this path
	)

	// Root: present, empty parentID, info bytes preserved verbatim.
	if present, parent, info := s.hydrateAssignSnapshot("R"); !present {
		t.Fatalf("root R: direct-assign must place the entry in s.sessions, got absent")
	} else if parent != "" {
		t.Fatalf("root R: direct-assign parentID want \"\", got %q", parent)
	} else if string(info) != `{"id":"R","title":"root"}` {
		t.Fatalf("root R: direct-assign info bytes want verbatim input, got %q", string(info))
	}

	// Child: present, parentID denormalized to the hydrated parent, info preserved.
	if present, parent, info := s.hydrateAssignSnapshot("C"); !present {
		t.Fatalf("child C: direct-assign must place the entry in s.sessions, got absent")
	} else if parent != "R" {
		t.Fatalf("child C: direct-assign parentID want \"R\", got %q (parentID must be denormalized from the envelope)", parent)
	} else if string(info) != `{"id":"C","parentID":"R","title":"child"}` {
		t.Fatalf("child C: direct-assign info bytes want verbatim input, got %q", string(info))
	}

	// Public-API cross-check: both ids are observable through the read path.
	if !s.HasSession("R") || !s.HasSession("C") {
		t.Fatalf("HasSession: R=%v C=%v, want both true (direct-assign must be observable through the read API)", s.HasSession("R"), s.HasSession("C"))
	}
	if got := s.RootCount(); got != 1 {
		t.Fatalf("RootCount=%d, want 1 (R is the only root; C is its child)", got)
	}
	// Descendants(id) INCLUDES id itself (snapshots.go:43 — "id plus every
	// live session transitively parented by it"). So R's descendant set is
	// {R, C}, len 2.
	descR := s.Descendants("R")
	if len(descR) != 2 {
		t.Fatalf("Descendants(R) len=%d, want 2 (R itself + C — Descendants is self-inclusive)", len(descR))
	}
	if !containsString(descR, "C") {
		t.Fatalf("Descendants(R)=%v, want it to contain C (the hydrated child)", descR)
	}
}

// TestHydrate_IndexesConsistent is GAP-S3 case 2 — THE LOAD-BEARING TEST.
// Hydrate calls 6 subtree-index maintainers after every direct-assign
// (store.go:2639-2648). This test drives Hydrate across the full matrix of
// shapes that exercise every maintainer (create, reparent, replace-with-
// changed-info, drop-unseen) AND interleaves Apply to seed busy / pending
// state so the maintainers have non-trivial values to preserve across the
// re-assign. After every Hydrate, ALL 8 incremental indexes (the 7 Phase-1
// indexes via assertSubtreeIndexes + the Gate C prototype subtreeBusyCount
// via assertSubtreeBusyCount) are differentially compared against independent
// O(n) reference recomputes.
//
// Mutation-observability — which test fails if each maintainer is removed:
//   - maintainSubtreeBusyOnSessionUpsertLocked  → assertSubtreeBusyCount
//   - maintainChildrenOnSessionUpsertLocked     → assertSubtreeIndexes [children]
//     AND [rootIDs] (topology pair)
//   - maintainSubtreeRetryOnSessionUpsertLocked → assertSubtreeIndexes [retry]
//   - maintainSubtreePendingInputOnSessionUpsertLocked → assertSubtreeIndexes [pendingInput]
//   - maintainSubtreeDescendantOnSessionUpsertLocked  → assertSubtreeIndexes [descendant]
//   - maintainNewestActivityOnSessionUpsertLocked     → assertSubtreeIndexes [newestActivity]
//
// (recentBucket is maintained only on activity transitions via setActivityLocked,
// NOT by Hydrate's session loop — so a Hydrate that re-assigns an entry whose
// lastActivityAt is unchanged leaves recentBucket consistent by construction.)
//
// The "re-assign with changed info" phase is the one that actually exercises
// the maintainers' create/reparent branches with a non-nil `old` (the
// idempotent case skips them entirely via the !bytes.Equal guard).
func TestHydrate_IndexesConsistent(t *testing.T) {
	s := New(100)

	// Phase A — seed live state via Apply so the indexes carry real values
	// (busy, retry, pending perm) that a subsequent Hydrate re-assign MUST
	// preserve. Pure Apply here; baseline consistency established by the
	// existing property tests.
	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("session.created", evSessionCreated("C", "R")))
	s.Apply(ev("session.status", evStatus("C", "busy")))          // C busy → subtreeBusyCount[R] >= 1
	s.Apply(ev("permission.asked", evPermissionAsked("C", "p1"))) // C pending → subtreePendingInput[R] >= 1
	assertSubtreeIndexes(t, s, "Apply baseline: R→C busy+pending")
	assertSubtreeBusyCount(t, s, "Apply baseline: R→C busy+pending")

	// Phase B — Hydrate re-providing R and C with CHANGED info bytes. This
	// forces the direct-assign branch (old.info != new info → the guard
	// admits) so all 6 maintainers run against a non-nil `old`. They must
	// preserve C's busy + pending contributions to R's subtree (the
	// create/reparent fast-paths are no-ops on same-effective-parent, but
	// they MUST not zero the prior contributions).
	s.Hydrate(
		[]json.RawMessage{
			json.RawMessage(`{"id":"R","title":"root-renamed"}`),             // changed info → re-assign R
			json.RawMessage(`{"id":"C","parentID":"R","title":"c-renamed"}`), // changed info → re-assign C (same parent)
		},
		map[string][]MessageWithParts{},
	)
	assertSubtreeIndexes(t, s, "Hydrate re-assign R+C with changed info (same topology)")
	assertSubtreeBusyCount(t, s, "Hydrate re-assign R+C with changed info (busy/pending must survive re-assign)")

	// The re-assign preserves busy/pending state at the PUBLIC-API level too:
	// C is still busy, R's subtree still counts as busy.
	if got := s.RunningRoots(); got != 1 {
		t.Fatalf("after re-assign hydrate: RunningRoots=%d, want 1 (C still busy under R)", got)
	}

	// Phase C — Hydrate REPARENTS C from R to a new root R2 (changed parentID
	// + changed info). maintainChildren / maintainSubtreeBusy / Retry /
	// PendingInput / Descendant / NewestActivity must each propagate C's
	// contribution out of R's subtree and into R2's. This is the reparent
	// branch of every maintainer.
	s.Hydrate(
		[]json.RawMessage{
			json.RawMessage(`{"id":"R","title":"root-renamed"}`),
			json.RawMessage(`{"id":"R2","title":"root2"}`),
			json.RawMessage(`{"id":"C","parentID":"R2","title":"c-reparented"}`), // reparent R → R2
		},
		map[string][]MessageWithParts{},
	)
	assertSubtreeIndexes(t, s, "Hydrate reparent C R→R2 (every maintainer's reparent branch)")
	assertSubtreeBusyCount(t, s, "Hydrate reparent C R→R2 (busy contribution must move to R2)")

	// Public-API confirmation: two roots now (R, R2). NOTE: RunningRoots is
	// NOT asserted here — see the SURPRISE block after Phase D.
	if got := s.RootCount(); got != 2 {
		t.Fatalf("after reparent hydrate: RootCount=%d, want 2 (R, R2)", got)
	}

	// Phase D — Hydrate DROPS C entirely (delete-unseen). The prune loop
	// routes through deleteSessionLocked, which maintains the delete-side
	// indexes (maintainIndexesOnDeleteLocked) AND busyCount (the non-root
	// busy-decrement). All subtree indexes must settle to a C-less world.
	s.Hydrate(
		[]json.RawMessage{
			json.RawMessage(`{"id":"R","title":"root-renamed"}`),
			json.RawMessage(`{"id":"R2","title":"root2"}`),
		},
		map[string][]MessageWithParts{},
	)
	assertSubtreeIndexes(t, s, "Hydrate drop C (delete-unseen via deleteSessionLocked)")
	assertSubtreeBusyCount(t, s, "Hydrate drop C (busy contribution removed)")

	// SURPRISE (GAP-S3 finding worth surfacing to the operator): Hydrate
	// maintains the 8 SUBTREE indexes (7 Phase-1 + subtreeBusyCount prototype)
	// on reparent — asserted above, all correct. It does NOT maintain
	// busyCount[root], and busyCount has a PRE-EXISTING reparent gap that
	// this sequence exposes:
	//   - Phase A set C busy under R  → busyCount["R"]++ (=1).
	//   - Phase C reparented C R→R2   → busyCount UNCHANGED (reparent never
	//     touches busyCount — true of upsertSessionLocked too, NOT
	//     Hydrate-specific). busyCount["R"] still 1, busyCount["R2"] still 0.
	//   - Phase D deleted C           → deleteSessionLocked decrements
	//     busyCount[rootOf("C")="R2"] (=0, no-op via the >0 guard). The
	//     original increment to busyCount["R"] is NEVER matched by a
	//     corresponding decrement → phantom busyCount["R"]=1.
	// The phantom is NOT healable by SetActivityFromStatuses: R's own
	// activity was never "busy" (C was), so setActivityAtLocked("R", Idle)
	// sees wasBusy==isBusy==false and skips the busyCount decrement. Only
	// the runStatusReconcile heal ticker (or never reparenting a busy
	// session) can clear it. The subtreeBusyCount index (asserted above) IS
	// correct — only the legacy busyCount drifts. This is out of scope for
	// GAP-S3 (a Hydrate-direct-assign gate) but documented so a future
	// concern split that moves busyCount knows the reparent gap exists.
	if got := s.RunningRoots(); got != 1 {
		t.Fatalf("post-drop busyCount characterization: RunningRoots=%d, want 1 (phantom busyCount[R] from the Phase C reparent of a busy session — a pre-existing busyCount gap, not Hydrate-specific)", got)
	}
	// Cross-check: the subtreeBusyCount index (the newer Gate C prototype
	// that Hydrate DOES maintain) correctly reports ZERO busy sessions,
	// confirming the subtree index is consistent even though legacy
	// busyCount drifted. This is the load-bearing GAP-S3 assertion.
	if diff := subtreeBusyCountDiff(s); diff != "" {
		t.Fatalf("post-drop subtreeBusyCount mismatch (the Hydrate-maintained index must be correct even though busyCount drifted):\n  %s", diff)
	}
}

// TestHydrate_DoesNotLeakGraceTimers is GAP-S3 case 3 — the namesake concern.
// Hydrate MUST call cancelAllGraceLocked (store.go:2605) before its session
// loop, so a grace timer armed against the pre-reconnect live message stream
// cannot fire post-hydrate and strand/corrupt busy state. The comment at
// store.go:2602-2604 documents the contract; before this file NO test
// asserted it (TestHydrateDiffEmitsOnlyChanges does not touch grace state).
//
// cancelAllGraceLocked stops every pending timer, bumps graceGen for every
// armed id (so an in-flight callback detects the supersede and aborts), and
// deletes every graceTimers entry. It does NOT touch busyCount — the
// aggregator's subsequent SetActivityFromStatuses owns the post-hydrate
// activity reconcile. So the observable contract is:
//   - graceTimers emptied (no armed timer post-hydrate)
//   - graceGen bumped past the armed gen (in-flight callback no-ops)
//   - busyCount UNCHANGED (cancel is not a clear; the grace never fired)
//   - completionAuthoritative UNCHANGED (the grace never fired authoritatively)
//
// Mutation-observability: if the `s.cancelAllGraceLocked()` line were
// removed from Hydrate, the armed timer remains. After the grace window the
// callback runs, sees graceGen unchanged (no supersede), fires
// clearOnCompletionLocked → busyCount→0 + authority armed. The test then
// fails on busyAfter != 1 / authAfter != false.
func TestHydrate_DoesNotLeakGraceTimers(t *testing.T) {
	s := New(100)
	s.completionGrace = 15 * time.Millisecond // small enough for a fast test

	// Arm grace the production way: a completed assistant turn on root R.
	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("message.updated", evAssistantInflight("R", "m1")))
	s.Apply(ev("message.updated", evAssistantCompleted("R", "m1")))

	// Pre-hydrate: grace armed, busy=1, authority clear (the multi-step-turn
	// protection window — synchronous idle would dip the spinner).
	armGen, armed, auth, busy := s.graceStateSnapshot("R")
	if !armed {
		t.Fatalf("pre-hydrate: grace timer should be armed (completion just landed), got disarmed")
	}
	if auth {
		t.Fatalf("pre-hydrate: authority should be clear (grace pending, not fired)")
	}
	if busy != 1 {
		t.Fatalf("pre-hydrate: busy=%d, want 1 (grace pending)", busy)
	}

	// Hydrate keeping R alive, with CHANGED info so the direct-assign branch
	// fires (proving the full Hydrate ran, not just the cancel). The cancel
	// happens BEFORE the session loop, so it fires whether or not R is
	// re-assigned — but the changed info makes the test robust to the
	// diff-guard's byte-comparison.
	s.Hydrate(
		[]json.RawMessage{
			json.RawMessage(`{"id":"R","title":"post-reconnect"}`),
		},
		map[string][]MessageWithParts{},
	)

	// Immediately post-hydrate: cancelAllGraceLocked ran. graceTimers[R] is
	// deleted, graceGen[R] bumped PAST armGen (an in-flight armGen-captured
	// callback will see the mismatch and abort), busy UNCHANGED (cancel is
	// not a clear), authority UNCHANGED (grace never fired).
	postGen, postArmed, postAuth, postBusy := s.graceStateSnapshot("R")
	if postArmed {
		t.Fatalf("post-hydrate: graceTimers[R] should be deleted by cancelAllGraceLocked, still armed")
	}
	if postGen <= armGen {
		t.Fatalf("post-hydrate: graceGen=%d, want > %d (cancelAllGraceLocked must bump past the armed gen so an in-flight callback aborts)", postGen, armGen)
	}
	if postAuth {
		t.Fatalf("post-hydrate: authority should still be clear (grace must not have fired), got armed")
	}
	if postBusy != 1 {
		t.Fatalf("post-hydrate: busy=%d, want 1 (cancelAllGraceLocked must NOT clear busy — SetActivityFromStatuses owns the post-hydrate reconcile)", postBusy)
	}

	// Wait WELL past the original grace window. The armGen-captured callback
	// (if it runs at all — Stop may have won) takes s.mu, sees graceGen[R] !=
	// armGen, and returns a benign no-op. State must be UNCHANGED: no stale
	// fire cleared busy or armed authority post-hydrate. graceGen must not
	// move further (the stale fire no-op'd without bumping).
	time.Sleep(80 * time.Millisecond)
	lateGen, lateArmed, lateAuth, lateBusy := s.graceStateSnapshot("R")
	if lateGen != postGen {
		t.Fatalf("post-hydrate+wait: graceGen=%d, want %d (no further bump; the stale armGen fire must no-op via the graceGen guard)", lateGen, postGen)
	}
	if lateArmed {
		t.Fatalf("post-hydrate+wait: no grace timer should be armed (cancelAllGraceLocked deleted it)")
	}
	if lateAuth {
		t.Fatalf("post-hydrate+wait: authority must still be clear — a stale fire post-hydrate armed it (cancelAllGraceLocked was skipped or regressed)")
	}
	if lateBusy != 1 {
		t.Fatalf("post-hydrate+wait: busy=%d, want 1 — a stale fire post-hydrate cleared it (cancelAllGraceLocked was skipped or regressed)", lateBusy)
	}
}

// TestHydrate_IdempotentOnIdenticalInfo_ReplaceOnChangedInfo is GAP-S3 case 4.
// Hydrate's direct-assign is guarded by `old == nil || !bytes.Equal(old.info,
// info)` (store.go:2632). Two contracts flow from that guard:
//
//   - IDEMPOTENT: re-hydrating a session with byte-identical info MUST be a
//     no-op for that session — no re-assign, no maintainer calls, no emit.
//     The indexes must NOT drift (the guard skips the maintainer calls
//     entirely, so the incremental indexes are untouched and stay consistent
//     with the untouched sessions map).
//   - REPLACE: re-hydrating with DIFFERENT info bytes MUST re-assign the
//     entry AND re-run every maintainer with `old` = the prior entry, so the
//     derived maps reflect the latest state with no orphan entries from the
//     first hydration.
//
// Mutation-observability:
//   - If the !bytes.Equal guard were removed, the idempotent phase would
//     re-emit (seq advances) — the seq-stability assertion catches it.
//   - If a maintainer were removed, the REPLACE phase (changed info) drifts
//     a derived index — assertSubtreeIndexes / assertSubtreeBusyCount catch
//     it. (The idempotent phase does NOT exercise the maintainers, by design;
//     the replace phase is the one that pins them.)
func TestHydrate_IdempotentOnIdenticalInfo_ReplaceOnChangedInfo(t *testing.T) {
	s := New(100)

	rootInfo := json.RawMessage(`{"id":"R","title":"v1"}`)
	childInfo := json.RawMessage(`{"id":"C","parentID":"R","title":"v1"}`)

	// First hydration.
	s.Hydrate(
		[]json.RawMessage{rootInfo, childInfo},
		map[string][]MessageWithParts{},
	)
	assertSubtreeIndexes(t, s, "first hydrate R+C")
	assertSubtreeBusyCount(t, s, "first hydrate R+C")
	if got := s.RootCount(); got != 1 {
		t.Fatalf("first hydrate: RootCount=%d, want 1", got)
	}

	// IDEMPOTENT phase: re-hydrate the SAME sessions with byte-identical info.
	// The guard skips re-assign + maintainers + emit; seq must not advance and
	// no index may drift. (This mirrors TestHydrateDiffEmitsOnlyChanges's
	// idempotent assertion, but extends it to the index invariants — that
	// test only checks seq, not the derived maps.)
	stableSeq := s.Snapshot(nil).Seq
	s.Hydrate(
		[]json.RawMessage{rootInfo, childInfo},
		map[string][]MessageWithParts{},
	)
	if got := s.Snapshot(nil).Seq; got != stableSeq {
		t.Fatalf("idempotent hydrate: seq moved %d→%d (the !bytes.Equal guard must skip re-emit for byte-identical info)", stableSeq, got)
	}
	assertSubtreeIndexes(t, s, "idempotent hydrate (no index drift expected)")
	assertSubtreeBusyCount(t, s, "idempotent hydrate (no index drift expected)")

	// REPLACE phase: re-hydrate with CHANGED info bytes for both sessions,
	// and REPARENT C to a new root R2. The guard admits (info differs), the
	// entry is replaced, every maintainer re-runs with old=prior-entry, and
	// the derived maps must reflect the NEW topology with no orphans from
	// the first hydration (no stale children[R], no stale rootIDs entry).
	s.Hydrate(
		[]json.RawMessage{
			json.RawMessage(`{"id":"R","title":"v2"}`),                            // changed info
			json.RawMessage(`{"id":"R2","title":"new-root"}`),                     // new root
			json.RawMessage(`{"id":"C","parentID":"R2","title":"v2-reparented"}`), // changed info + reparent R→R2
		},
		map[string][]MessageWithParts{},
	)
	assertSubtreeIndexes(t, s, "replace hydrate: R+R2 roots, C reparented to R2 (no orphans from first hydration)")
	assertSubtreeBusyCount(t, s, "replace hydrate (topology changed)")

	// Public-API confirmation of the replaced topology. Descendants(id)
	// INCLUDES id itself (snapshots.go:43), so Descendants("R") is {R} after
	// C moves away, and Descendants("R2") is {R2, C}.
	if got := s.RootCount(); got != 2 {
		t.Fatalf("replace hydrate: RootCount=%d, want 2 (R, R2)", got)
	}
	descR := s.Descendants("R")
	if len(descR) != 1 || !containsString(descR, "R") {
		t.Fatalf("replace hydrate: Descendants(R)=%v, want [R] only (C reparented away — no orphan children[R] entry)", descR)
	}
	descR2 := s.Descendants("R2")
	if len(descR2) != 2 || !containsString(descR2, "C") {
		t.Fatalf("replace hydrate: Descendants(R2)=%v, want [R2 C] (C reparented into R2's subtree)", descR2)
	}
	// The replaced entry carries the NEW info bytes (direct-assign overwrote
	// the prior entry, did not leave a stale one).
	if present, parent, info := s.hydrateAssignSnapshot("C"); !present || parent != "R2" ||
		string(info) != `{"id":"C","parentID":"R2","title":"v2-reparented"}` {
		t.Fatalf("replace hydrate: C entry present=%v parent=%q info=%q; want present, parent R2, new info bytes", present, parent, string(info))
	}
}

// TestHydrate_MsgRevConsistent is GAP-S3 case 5. Hydrate's messages loop
// calls reconcileMessagesLocked (store.go:2666), which unconditionally calls
// bumpMsgRev(sid) (store.go:2719) under s.mu. The msgRev token (store.go:599)
// is the cold-batch ABA guard: publishColdBatch captures it at batch-capture
// time and re-validates after packaging, discarding a stale batch whose
// capture point predates a later mutation. A Hydrate that reconciles
// messages MUST bump the token so:
//   - a cold-load batch packaged from the reconcile is current (token matches)
//   - a warm re-reconcile of an already-loaded session invalidates any prior
//     in-flight cold batch (token strictly greater)
//
// Contract pinned here:
//   - a session reconciled via Hydrate has msgRev > 0 (bumpMsgRev handed out
//     a fresh Store-wide-monotonic token, never zero — store.go:633)
//   - re-hydrating the SAME messages (warm path, msgLoaded already true) bumps
//     the token AGAIN (reconcileMessagesLocked bumps unconditionally on both
//     cold and warm paths — store.go:2712-2718)
//   - a session hydrated WITHOUT messages (absent from the messages map) is
//     NOT reconciled and its msgRev stays at the prior value (Hydrate's
//     session loop does not bump msgRev — only reconcile does)
//
// Mutation-observability: if the `s.bumpMsgRev(sid)` line were removed from
// reconcileMessagesLocked, msgRev stays 0 → the cold-hydrate assertion fails
// immediately, and the warm-reconcile assertion fails (no strict increase).
// This is the exact regression that would reintroduce the ABA hole the
// Store-wide nextMsgRev counter closed (TestColdBatchRecreatedSessionDoesNot-
// ReuseOldToken is the ABA gate; this test is its Hydrate-path mirror).
func TestHydrate_MsgRevConsistent(t *testing.T) {
	s := New(100)

	// Hydrate R with messages (cold path: msgLoaded false at entry →
	// reconcileMessagesLocked returns coldLoad=true, publishColdBatch runs
	// outside the lock). msgRev[R] must be > 0 after the reconcile.
	s.Hydrate(
		[]json.RawMessage{json.RawMessage(`{"id":"R","title":"root"}`)},
		map[string][]MessageWithParts{
			"R": {
				{Info: json.RawMessage(`{"id":"m1","sessionID":"R","role":"user"}`)},
				{Info: json.RawMessage(`{"id":"m2","sessionID":"R","role":"assistant","time":{"completed":1700000000}}`)},
			},
		},
	)
	coldRev := s.msgRevSnapshot("R")
	if coldRev == 0 {
		t.Fatalf("cold hydrate with messages: msgRev[R]=0, want > 0 (reconcileMessagesLocked must bump via bumpMsgRev)")
	}
	if !s.IsMessagesLoaded("R") {
		t.Fatalf("cold hydrate with messages: IsMessagesLoaded(R)=false, want true (reconcile sets msgLoaded)")
	}

	// A session hydrated WITHOUT messages (absent from the messages map) is
	// NOT reconciled — its msgRev stays at the zero baseline. This pins that
	// Hydrate's session loop does NOT bump msgRev (only reconcile does), so a
	// lazy-hydration daemon that defers message fetch does not hand out
	// spurious tokens.
	s.Hydrate(
		[]json.RawMessage{json.RawMessage(`{"id":"nomsg","title":"no-messages"}`)},
		map[string][]MessageWithParts{}, // no entry for "nomsg"
	)
	if got := s.msgRevSnapshot("nomsg"); got != 0 {
		t.Fatalf("hydrate without messages: msgRev[nomsg]=%d, want 0 (the session loop must not bump msgRev — only reconcileMessagesLocked does)", got)
	}

	// Warm re-reconcile: hydrate R's messages AGAIN (msgLoaded already true).
	// reconcileMessagesLocked bumps the token unconditionally on BOTH paths
	// (store.go:2712-2718 — a warm reconcile's present-message merge can
	// change the projection, so the token must move). The new token must be
	// STRICTLY GREATER than the cold token (Store-wide monotonic nextMsgRev).
	s.Hydrate(
		[]json.RawMessage{json.RawMessage(`{"id":"R","title":"root"}`)},
		map[string][]MessageWithParts{
			"R": {
				{Info: json.RawMessage(`{"id":"m1","sessionID":"R","role":"user"}`)},
				{Info: json.RawMessage(`{"id":"m2","sessionID":"R","role":"assistant","time":{"completed":1700000000}}`)},
				{Info: json.RawMessage(`{"id":"m3","sessionID":"R","role":"user"}`)}, // new message
			},
		},
	)
	warmRev := s.msgRevSnapshot("R")
	if warmRev <= coldRev {
		t.Fatalf("warm re-reconcile: msgRev[R]=%d, want > %d (reconcileMessagesLocked must bump on the warm path too — a stale in-flight cold batch must be invalidated)", warmRev, coldRev)
	}

	// Sanity: the Store-wide monotonic source advanced by exactly the number
	// of bumps (2 reconciles × 1 bump each = 2). nextMsgRev never hands out
	// zero (store.go:633), so the cold token is >= 1 and the warm token is
	// >= 2. This is the ABA guard's invariant surface.
	if coldRev < 1 || warmRev < 2 {
		t.Fatalf("ABA token shape: cold=%d warm=%d; want cold>=1, warm>=2 (nextMsgRev never hands out zero)", coldRev, warmRev)
	}

	// Final consistency echo: the indexes are unaffected by the message
	// reconcile (msgRev is orthogonal to the subtree indexes). This guards
	// against a future refactor that accidentally couples the two paths.
	assertSubtreeIndexes(t, s, "post-msgRev hydrate (indexes orthogonal to message reconcile)")
}
