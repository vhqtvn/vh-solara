// Package state: Phase 1 (Gate C extension) — the remaining 7 incremental
// subtree indexes that the collapsed-frontier projection (O1) needs to build
// roots + active closure + frontier stubs in O(|roots| + |closure|×depth +
// |frontier|) instead of O(n).
//
// The prototype (subtreeBusyCount, commit 89eb0e7e) proved the incremental-index
// pattern for ONE aggregate (busy/retry count). This file replicates that
// pattern — same maintenance sites, same orphan-inclusive effective-parent
// definition, same fresh-create O(n) child-scan for descendant reabsorption —
// for the 7 remaining aggregates the projection reads:
//
//   - children, rootIDs              (topology; root/closure walk)
//   - subtreeRetryCount              (sum; aggregateState "retry")
//   - subtreePendingInput            (sum; aggregateState "needs-input")
//   - subtreeNewestActivity          (max; "recent" cutoff window)
//   - subtreeDescendantCount         (sum; stub descendantCount)
//   - recentBucket                   (bucket; active-closure seed)
//
// ADDITIVE in Phase 1: the snapshot path (computeSubtreeBusyLocked / Snapshot /
// SendableNow / busyCount[root]) is UNCHANGED. These indexes coexist with the
// prototype and are proven equivalent to an independent O(n) recompute by
// TestSubtreeIndexesProperty (random-mutation differential, mirroring
// subtree_busy_test.go). The projection itself lands in Phase 4.
//
// Maintenance sites (grep-verified COMPLETE, mirroring the prototype):
//   - setActivityLocked  — busy-state chokepoint; also covers message-stream
//     escalation (upsertMessageLocked / appendPartDeltaLocked funnel through
//     it). Runs for EVERY real transition incl. busy-neutral (busy↔retry,
//     error→idle), so retry-count / activity-time / bucket updates must fire
//     BEFORE the wasBusy==isBusy early-return in setActivityLocked.
//   - upsertSessionLocked + Hydrate direct-assign — create / reparent.
//   - deleteSessionLocked — delete chokepoint (non-cascading: descendants are
//     orphaned to roots, NOT deleted).
//   - permission.asked/replied + question.asked/replied (+ the
//     SetPendingPermissions / SetPendingQuestions reconcile entrypoints) — the
//     pending-input chokepoint, funneled through notePendingInputChangeLocked.
//
// All helpers hold s.mu (same lock as the prototype index). The fresh-create
// branch's O(n) child-scan is the cold path; reparent / activity / perm /
// question transitions stay O(depth) or O(children-of-id) on the hot paths.

package state

import "time"

// recentBucketRetentionMinutes bounds the number of minute-buckets retained in
// s.recentBucket, bounding memory. Generous vs the default 10-min projection
// cutoff (Phase 6) so a cutoff change within the window doesn't lose data.
// Package var so Phase 6 / tests can tune it.
var recentBucketRetentionMinutes = 60

// ----------------------------------------------------------------------------
// SUM-class helpers (subtreeRetryCount, subtreePendingInput, subtreeDescendantCount)
//
// Each sum-class index satisfies:
//
//	idx[id] == selfFn(id) + Σ idx[c] for each live direct child c of id
//
// for every id in s.sessions. The prototype (subtreeBusyCount) is the model;
// only selfFn differs. Maintenance is by ±delta propagated up the live
// ancestor chain (orphan-inclusive: chain terminates at a dead parent, same
// definition as rootOfLocked / adjustAncestorChainFromLocked).
// ----------------------------------------------------------------------------

// adjustAncestorChainSumLocked adds delta to idx[firstParentID] and every live
// strict ancestor above it, walking parentID up while the parent exists in
// s.sessions. Stops at empty parentID or a parent absent from the live tree
// (orphan-inclusive). firstParentID is the PARENT of the session whose subtree
// changed. Caller holds s.mu.
func (s *Store) adjustAncestorChainSumLocked(firstParentID string, delta int, idx map[string]int) {
	cur := firstParentID
	for i := 0; i < 100000; i++ { // bound vs a malformed cyclic parent link
		if cur == "" {
			return
		}
		se := s.sessions[cur]
		if se == nil {
			return // parent absent from live tree → orphan root, stop
		}
		idx[cur] += delta
		cur = se.parentID
	}
}

// seedSumOnCreateLocked seeds idx[id] on a fresh create. total = selfFn(id) +
// Σ idx[c] for live c with parentID==id (the cold-path O(n) child scan that
// reabsorbs orphaned descendants — deleteSessionLocked is non-cascading, so a
// recreated id may have live children still pointing at it). If total != 0,
// writes idx[id]=total and propagates up newParentID's chain. Caller holds
// s.mu. prev MUST be nil (fresh create / recreate of a previously-deleted id).
func (s *Store) seedSumOnCreateLocked(id, newParentID string, idx map[string]int, selfFn func(string) int) {
	total := selfFn(id)
	for cid, ce := range s.sessions {
		if ce.parentID == id {
			total += idx[cid]
		}
	}
	if total != 0 {
		idx[id] = total
		s.adjustAncestorChainSumLocked(newParentID, total, idx)
	}
}

// moveSumOnReparentLocked subtracts idx[id] from the OLD ancestor chain and
// adds it to the NEW ancestor chain on a reparent. id's own entry is unchanged
// (its subtree moves with it wholesale). No-op when idx[id]==0. Caller holds
// s.mu.
func (s *Store) moveSumOnReparentLocked(id, oldParentID, newParentID string, idx map[string]int) {
	if sub := idx[id]; sub != 0 {
		s.adjustAncestorChainSumLocked(oldParentID, -sub, idx)
		s.adjustAncestorChainSumLocked(newParentID, +sub, idx)
	}
}

// ----------------------------------------------------------------------------
// subtreeRetryCount (sum; self = activity==Retry)
// ----------------------------------------------------------------------------

// subtreeRetrySelfLocked returns id's OWN retry contribution: 1 when its
// activity is retry, else 0. Caller holds s.mu.
func (s *Store) subtreeRetrySelfLocked(id string) int {
	if s.activity[id] == ActivityRetry {
		return 1
	}
	return 0
}

// maintainSubtreeRetryOnActivityLocked updates subtreeRetryCount for a real
// activity transition (prev → st). Only a retry↔non-retry flip changes id's
// own contribution; busy↔retry is retry-neutral on the "busy" axis but
// retry-changing on this axis, so this MUST run for busy-neutral transitions
// (it's placed before the wasBusy==isBusy early-return in setActivityLocked).
// No-op when the transition is retry-neutral (e.g. idle→busy) or when id is a
// phantom (not yet in the live tree). Caller holds s.mu.
func (s *Store) maintainSubtreeRetryOnActivityLocked(id, prev, st string) {
	wasRetry := prev == ActivityRetry
	isRetry := st == ActivityRetry
	if wasRetry == isRetry {
		return
	}
	se := s.sessions[id]
	if se == nil {
		return // phantom guard: a phantom status must not create an index entry
	}
	delta := 1
	if !isRetry {
		delta = -1
	}
	s.subtreeRetryCount[id] += delta
	s.adjustAncestorChainSumLocked(se.parentID, delta, s.subtreeRetryCount)
}

// maintainSubtreeRetryOnSessionUpsertLocked maintains subtreeRetryCount after
// a session create / reparent (mirrors maintainSubtreeBusyOnSessionUpsertLocked
// exactly, only the index differs). Caller holds s.mu; s.sessions[id] must
// already be written.
func (s *Store) maintainSubtreeRetryOnSessionUpsertLocked(id string, prev *sessionEntry, newParentID string) {
	switch {
	case prev == nil:
		s.seedSumOnCreateLocked(id, newParentID, s.subtreeRetryCount, s.subtreeRetrySelfLocked)
	case s.effectiveParentOfLocked(prev.parentID) == s.effectiveParentOfLocked(newParentID):
		// No effective topology change; activity untouched by upsert → no-op.
	default:
		s.moveSumOnReparentLocked(id, prev.parentID, newParentID, s.subtreeRetryCount)
	}
}

// ----------------------------------------------------------------------------
// subtreePendingInput (sum; self = has any pending permission OR question)
//
// pendingInputSelf[id] is the per-session shadow of self (0/1) so a
// notePendingInputChangeLocked call can resolve the delta without re-deriving
// the previous self from the (already-mutated) perms/questions maps.
// ----------------------------------------------------------------------------

// pendingInputSelfLocked returns id's OWN pending-input contribution: 1 when
// it has any pending permission or question, else 0. Caller holds s.mu.
func (s *Store) pendingInputSelfLocked(id string) int {
	if len(s.perms[id]) > 0 || len(s.questions[id]) > 0 {
		return 1
	}
	return 0
}

// notePendingInputChangeLocked is the SINGLE pending-input chokepoint: called
// after every mutation to perms[id] or questions[id] (Apply permission.asked /
// replied, question.asked / replied / rejected, and the SetPendingPermissions
// / SetPendingQuestions reconcile loops). Recomputes id's own contribution,
// resolves the delta vs pendingInputSelf[id], and propagates up. Idempotent
// (a no-op when the contribution is unchanged). Phantom-guarded. Caller holds
// s.mu.
func (s *Store) notePendingInputChangeLocked(id string) {
	se := s.sessions[id]
	if se == nil {
		return // phantom: perms/questions may arrive before session.created
	}
	want := s.pendingInputSelfLocked(id)
	prev := s.pendingInputSelf[id]
	s.pendingInputSelf[id] = want
	if want == prev {
		return
	}
	delta := want - prev
	s.subtreePendingInput[id] += delta
	s.adjustAncestorChainSumLocked(se.parentID, delta, s.subtreePendingInput)
	// Phase 3 (Gate B): a session entering/exiting the pending-input closure
	// changes the projection boundary — bump the structural revision so the
	// client's stale-response guard and idempotent-skip logic fire correctly.
	s.bumpStructuralRevisionLocked()
	// Phase 2 (finding B): pending-input boundary change alters frontier
	// membership (a session with pending input is always materialized). Set
	// curFrontierChanged so the accompanying emit (in Apply, after this
	// returns) stamps the event's FrontierChanged flag.
	s.bumpFrontierSeqLocked()
	s.curFrontierChanged = true
}

// maintainSubtreePendingInputOnSessionUpsertLocked maintains subtreePendingInput
// after a session create / reparent. On fresh-create, ALSO syncs
// pendingInputSelf[id] so a later notePendingInputChangeLocked call resolves
// the correct delta (seedSumOnCreateLocked already propagated; this write is
// bookkeeping only). Caller holds s.mu; s.sessions[id] must already be written.
func (s *Store) maintainSubtreePendingInputOnSessionUpsertLocked(id string, prev *sessionEntry, newParentID string) {
	switch {
	case prev == nil:
		s.seedSumOnCreateLocked(id, newParentID, s.subtreePendingInput, s.pendingInputSelfLocked)
		// Sync the per-session self shadow (no further propagation: seedSum
		// already added self to subtreePendingInput[id] + ancestors).
		s.pendingInputSelf[id] = s.pendingInputSelfLocked(id)
	case s.effectiveParentOfLocked(prev.parentID) == s.effectiveParentOfLocked(newParentID):
		// No effective topology change → no-op.
	default:
		s.moveSumOnReparentLocked(id, prev.parentID, newParentID, s.subtreePendingInput)
	}
}

// ----------------------------------------------------------------------------
// subtreeDescendantCount (sum; self = 1 always for a live session)
// ----------------------------------------------------------------------------

// maintainSubtreeDescendantOnSessionUpsertLocked maintains subtreeDescendantCount
// after a session create / reparent. Self is always 1 (the node itself).
// Caller holds s.mu; s.sessions[id] must already be written.
func (s *Store) maintainSubtreeDescendantOnSessionUpsertLocked(id string, prev *sessionEntry, newParentID string) {
	switch {
	case prev == nil:
		s.seedSumOnCreateLocked(id, newParentID, s.subtreeDescendantCount, func(string) int { return 1 })
	case s.effectiveParentOfLocked(prev.parentID) == s.effectiveParentOfLocked(newParentID):
		// No effective topology change → no-op.
	default:
		s.moveSumOnReparentLocked(id, prev.parentID, newParentID, s.subtreeDescendantCount)
	}
}

// ----------------------------------------------------------------------------
// TOPOLOGY: children map[parentID][]childID ("" = roots) + rootIDs []sessionID
//
// effectiveParentOfLocked normalizes a raw parentID to "" when it is empty OR
// points at a session absent from the live tree — the SAME orphan-inclusive
// root definition as rootOfLocked / computeSubtreeBusyLocked. children[""] is
// kept in sync with rootIDs (both list the live roots); callers may use either.
// ----------------------------------------------------------------------------

// effectiveParentOfLocked returns p when p is a live session, else "". This is
// the orphan-inclusive normalization: a child whose parentID points at a
// deleted id is effectively a root. Caller holds s.mu.
func (s *Store) effectiveParentOfLocked(p string) string {
	if p == "" || s.sessions[p] == nil {
		return ""
	}
	return p
}

// childrenAppendLocked appends child to the children index under parent.
// Caller holds s.mu.
func (s *Store) childrenAppendLocked(parent, child string) {
	s.children[parent] = append(s.children[parent], child)
}

// childrenRemoveLocked removes child from the children index under parent.
// No-op if not present. Drops the map entry when the slice becomes empty so
// the index reports no entries for childless ids (matches the reference, which
// builds children fresh and only lists ids with ≥1 live child). Caller holds
// s.mu.
func (s *Store) childrenRemoveLocked(parent, child string) {
	arr := s.children[parent]
	for i, c := range arr {
		if c == child {
			if len(arr) == 1 {
				delete(s.children, parent)
			} else {
				s.children[parent] = append(arr[:i], arr[i+1:]...)
			}
			return
		}
	}
}

// rootsAppendLocked adds id to BOTH rootIDs and children[""] (kept in sync so
// readers may use either). Caller holds s.mu.
func (s *Store) rootsAppendLocked(id string) {
	s.rootIDs = append(s.rootIDs, id)
	s.children[""] = append(s.children[""], id)
}

// rootsRemoveLocked removes id from BOTH rootIDs and children[""]. No-op if not
// present. Caller holds s.mu.
func (s *Store) rootsRemoveLocked(id string) {
	for i, c := range s.rootIDs {
		if c == id {
			s.rootIDs = append(s.rootIDs[:i], s.rootIDs[i+1:]...)
			break
		}
	}
	s.childrenRemoveLocked("", id)
}

// maintainChildrenOnSessionUpsertLocked maintains the topology index (children
// + rootIDs) after a session create / reparent. On fresh-create, ALSO
// reabsorbs orphaned direct children: any live c with parentID==id that was
// sitting in roots (its parent was dead) moves to children[id] (the cold-path
// O(n) scan that matches the prototype's fresh-create branch, and the
// reference's children rebuild). Caller holds s.mu; s.sessions[id] must already
// be written.
func (s *Store) maintainChildrenOnSessionUpsertLocked(id string, prev *sessionEntry, newParentID string) {
	newEff := s.effectiveParentOfLocked(newParentID)
	switch {
	case prev == nil:
		// Fresh create / recreate. Place id in its new parent (or roots).
		if newEff == "" {
			s.rootsAppendLocked(id)
		} else {
			s.childrenAppendLocked(newEff, id)
		}
		// Reabsorb orphaned direct children (parentID == id, currently rooted).
		for cid, ce := range s.sessions {
			if cid == id {
				continue
			}
			if ce.parentID == id {
				s.rootsRemoveLocked(cid)
				s.childrenAppendLocked(id, cid)
			}
		}
	case s.effectiveParentOfLocked(prev.parentID) == newEff:
		// No effective topology change (raw parentID strings may differ only
		// when one points at a dead id, which effectiveParent normalizes).
		// No-op.
	default:
		oldEff := s.effectiveParentOfLocked(prev.parentID)
		if oldEff == "" {
			s.rootsRemoveLocked(id)
		} else {
			s.childrenRemoveLocked(oldEff, id)
		}
		if newEff == "" {
			s.rootsAppendLocked(id)
		} else {
			s.childrenAppendLocked(newEff, id)
		}
	}
}

// ----------------------------------------------------------------------------
// subtreeNewestActivity (MAX class; max of lastActivityAt over subtree)
//
// subtreeNewestActivity[id] = MAX( lastActivityAt[id],
//                                   MAX subtreeNewestActivity[c] for live children c )
//
// Zero time (= never active) when no node in the subtree has ever recorded an
// activity time. Maintenance:
//   - touchActivityTimeLocked (hot path): lastActivityAt[id] INCREASES only →
//     local-max can only increase → propagateNewestActivityIncreaseLocked walks
//     ancestors, recomputing each, stopping at the first unchanged (O(depth)).
//   - recomputeChainNewestActivityLocked (cold path): used when a subtree
//     DEPARTED a chain (delete / reparent out), so a former max-holder may have
//     decreased. Walks up recomputing each local max from scratch
//     (O(branching × depth)).
//
// lastActivityAt is bumped ONLY in setActivityLocked (every real transition,
// incl. idle/error), NOT on create. A newly-created session has zero activity
// time; it collapses as a frontier stub until its first activity-state change
// — matching the contract's maintenance-site list (create is a topology event,
// not an activity event).
// ----------------------------------------------------------------------------

// recomputeSubtreeNewestLocalMaxLocked recomputes id's subtreeNewestActivity
// from its own lastActivityAt + its direct children's subtreeNewestActivity
// (read via the children index, O(children-of-id)). Returns the recomputed
// value and whether it differs from the currently-stored value. Caller holds
// s.mu.
func (s *Store) recomputeSubtreeNewestLocalMaxLocked(id string) (time.Time, bool) {
	var max time.Time
	if t := s.lastActivityAt[id]; !t.IsZero() {
		max = t
	}
	for _, cid := range s.children[id] {
		if ct := s.subtreeNewestActivity[cid]; ct.After(max) {
			max = ct
		}
	}
	return max, !max.Equal(s.subtreeNewestActivity[id])
}

// propagateNewestActivityIncreaseLocked walks id's ancestor chain, recomputing
// each node's local max; stops at the first unchanged node (the increase has
// been fully absorbed) or at a dead/orphan parent. Hot path O(depth). Caller
// holds s.mu; id must be live.
func (s *Store) propagateNewestActivityIncreaseLocked(id string) {
	cur := id
	for i := 0; i < 100000; i++ {
		se := s.sessions[cur]
		if se == nil {
			return
		}
		newMax, changed := s.recomputeSubtreeNewestLocalMaxLocked(cur)
		if !changed {
			return
		}
		s.subtreeNewestActivity[cur] = newMax
		if se.parentID == "" || s.sessions[se.parentID] == nil {
			return
		}
		cur = se.parentID
	}
}

// recomputeChainNewestActivityLocked walks up from startParent recomputing each
// node's local max from scratch (cold path for a departing subtree: a former
// max holder may have decreased). Stops at the first unchanged node or a
// dead/orphan parent. Caller holds s.mu.
func (s *Store) recomputeChainNewestActivityLocked(startParent string) {
	cur := startParent
	for i := 0; i < 100000; i++ {
		if cur == "" {
			return
		}
		se := s.sessions[cur]
		if se == nil {
			return
		}
		newMax, changed := s.recomputeSubtreeNewestLocalMaxLocked(cur)
		if !changed {
			return
		}
		s.subtreeNewestActivity[cur] = newMax
		cur = se.parentID
	}
}

// touchActivityTimeLocked records that id was active at now. If now is after
// id's stored lastActivityAt, advances it, then recomputes id's local max
// (which may increase because id's own contribution rose) and propagates the
// increase up. No-op when id is phantom (not yet in the live tree — phantom
// status events don't create index entries; the contribution is seeded on
// create via maintainNewestActivityOnSessionUpsertLocked, which sees a zero
// lastActivityAt) or when now is not newer than the stored time. Caller holds
// s.mu.
func (s *Store) touchActivityTimeLocked(id string, now time.Time) {
	se := s.sessions[id]
	if se == nil {
		return // phantom guard
	}
	prev := s.lastActivityAt[id]
	if !now.After(prev) {
		return
	}
	s.lastActivityAt[id] = now
	s.propagateNewestActivityIncreaseLocked(id)
}

// maintainNewestActivityOnSessionUpsertLocked maintains subtreeNewestActivity
// after a session create / reparent. On fresh-create, id's local max may need
// to fold in orphaned descendants (their subtreeNewestActivity is self-contained
// and correct); propagateNewestActivityIncreaseLocked handles both. On
// reparent, id's whole subtree departed the old chain (may decrease) and joined
// the new chain (may increase); id's OWN local max is unchanged by the move,
// so we recompute both chains from the parents upward (the cold-path recompute
// handles both decrease and increase correctly and short-circuits at the first
// unaffected ancestor). Caller holds s.mu; s.sessions[id] must already be
// written AND maintainChildrenOnSessionUpsertLocked must have already run
// (the local-max recompute reads s.children[id]).
func (s *Store) maintainNewestActivityOnSessionUpsertLocked(id string, prev *sessionEntry, newParentID string) {
	switch {
	case prev == nil:
		s.propagateNewestActivityIncreaseLocked(id)
	case s.effectiveParentOfLocked(prev.parentID) == s.effectiveParentOfLocked(newParentID):
		// No effective topology change → no-op.
	default:
		s.recomputeChainNewestActivityLocked(prev.parentID) // old chain: id left, may decrease
		s.recomputeChainNewestActivityLocked(newParentID)   // new chain: id joined, may increase
	}
}

// ----------------------------------------------------------------------------
// recentBucket (BUCKET class; unix-minute → session ids)
//
// A session lives in AT MOST ONE bucket — the one for its last-activity minute
// (Unix/60). Maintenance: touchRecentBucketLocked (called from
// setActivityLocked on every real transition) moves id to its new bucket,
// removing it from any prior one. recentBucketRetentionMinutes bounds the
// number of buckets retained (memory-bounded). recentBucketKeys is the sorted
// ascending list of bucket minutes, so the projection's cutoff-window walk is
// O(buckets-in-window).
// ----------------------------------------------------------------------------

// touchRecentBucketLocked records that id was active at now. Idempotent if id
// is already in the bucket for now's minute. Otherwise removes id from any
// prior bucket, appends to the new minute bucket (creating it + inserting the
// sorted key), and evicts buckets older than the retention window. No-op for
// phantom ids. Caller holds s.mu.
func (s *Store) touchRecentBucketLocked(id string, now time.Time) {
	if s.sessions[id] == nil {
		return // phantom guard
	}
	minute := now.Unix() / 60
	// Dedup: already in the target bucket?
	for _, c := range s.recentBucket[minute] {
		if c == id {
			return
		}
	}
	s.removeRecentBucketEntryLocked(id)
	s.recentBucket[minute] = append(s.recentBucket[minute], id)
	s.insertRecentBucketKeyLocked(minute)
	s.evictRecentBucketsLocked()
}

// insertRecentBucketKeyLocked inserts minute into recentBucketKeys (sorted
// ascending), no-op if already present. Caller holds s.mu.
func (s *Store) insertRecentBucketKeyLocked(minute int64) {
	lo, hi := 0, len(s.recentBucketKeys)
	for lo < hi {
		mid := (lo + hi) / 2
		if s.recentBucketKeys[mid] < minute {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	if lo < len(s.recentBucketKeys) && s.recentBucketKeys[lo] == minute {
		return
	}
	s.recentBucketKeys = append(s.recentBucketKeys, 0)
	copy(s.recentBucketKeys[lo+1:], s.recentBucketKeys[lo:])
	s.recentBucketKeys[lo] = minute
}

// removeRecentBucketKeyLocked removes minute from recentBucketKeys. No-op if
// absent. Caller holds s.mu.
func (s *Store) removeRecentBucketKeyLocked(minute int64) {
	lo, hi := 0, len(s.recentBucketKeys)
	for lo < hi {
		mid := (lo + hi) / 2
		if s.recentBucketKeys[mid] < minute {
			lo = mid + 1
		} else {
			hi = mid
		}
	}
	if lo < len(s.recentBucketKeys) && s.recentBucketKeys[lo] == minute {
		s.recentBucketKeys = append(s.recentBucketKeys[:lo], s.recentBucketKeys[lo+1:]...)
	}
}

// removeRecentBucketEntryLocked removes id from whichever bucket holds it (id
// is in at most one). Drops the bucket + its sorted key when it becomes empty.
// No-op if id is in no bucket. Caller holds s.mu.
func (s *Store) removeRecentBucketEntryLocked(id string) {
	for minute, arr := range s.recentBucket {
		for i, c := range arr {
			if c == id {
				if len(arr) == 1 {
					delete(s.recentBucket, minute)
					s.removeRecentBucketKeyLocked(minute)
				} else {
					s.recentBucket[minute] = append(arr[:i], arr[i+1:]...)
				}
				return // id is in at most one bucket
			}
		}
	}
}

// evictRecentBucketsLocked drops buckets older than (newest - retention) to
// bound memory. Caller holds s.mu.
func (s *Store) evictRecentBucketsLocked() {
	if len(s.recentBucketKeys) == 0 {
		return
	}
	newest := s.recentBucketKeys[len(s.recentBucketKeys)-1]
	cutoff := newest - int64(recentBucketRetentionMinutes)
	for _, k := range s.recentBucketKeys {
		if k < cutoff {
			delete(s.recentBucket, k)
		}
	}
	kept := s.recentBucketKeys[:0]
	for _, k := range s.recentBucketKeys {
		if k >= cutoff {
			kept = append(kept, k)
		}
	}
	s.recentBucketKeys = kept
}

// ----------------------------------------------------------------------------
// DELETE chokepoint: maintainIndexesOnDeleteLocked
//
// Called at the TOP of deleteSessionLocked (BEFORE the per-session delete(...)
// calls) to propagate id's whole-subtree contributions out of every live
// ancestor, orphan id's direct children to roots, recompute the departed
// ancestor chain's max, and remove id from its bucket. Matches the prototype's
// busy-delete block shape; the per-session delete(...) calls below it drop id's
// own entries from each index map.
// ----------------------------------------------------------------------------

// maintainIndexesOnDeleteLocked maintains all 7 new indexes for a delete. se
// is id's soon-to-be-deleted entry (used to read parentID). Caller holds s.mu.
func (s *Store) maintainIndexesOnDeleteLocked(id string, se *sessionEntry) {
	if se == nil {
		return
	}

	// --- sum-class: propagate id's whole-subtree contribution out of ancestors ---
	if sub := s.subtreeRetryCount[id]; sub != 0 {
		s.adjustAncestorChainSumLocked(se.parentID, -sub, s.subtreeRetryCount)
	}
	if sub := s.subtreePendingInput[id]; sub != 0 {
		s.adjustAncestorChainSumLocked(se.parentID, -sub, s.subtreePendingInput)
	}
	if sub := s.subtreeDescendantCount[id]; sub != 0 {
		s.adjustAncestorChainSumLocked(se.parentID, -sub, s.subtreeDescendantCount)
	}

	// --- topology: orphan id's direct children to roots, unlink id from its parent ---
	// Children of id become roots (their parentID still points at id, which is
	// about to be dead → effectiveParent becomes ""). Their own subtree indexes
	// are self-contained and need no adjustment, matching the prototype.
	if orphans := s.children[id]; len(orphans) > 0 {
		for _, cid := range orphans {
			s.rootsAppendLocked(cid)
		}
		delete(s.children, id)
	}
	if effParent := s.effectiveParentOfLocked(se.parentID); effParent == "" {
		s.rootsRemoveLocked(id)
	} else {
		s.childrenRemoveLocked(effParent, id)
	}

	// --- max-class: recompute the departed ancestor chain (may decrease) ---
	// id has just been removed from its parent's children list above, so the
	// recompute correctly excludes id's contribution.
	s.recomputeChainNewestActivityLocked(se.parentID)

	// --- bucket: remove id from its bucket ---
	s.removeRecentBucketEntryLocked(id)
}
