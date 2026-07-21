package state

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"
)

// This file is the Gate C extension property test for the remaining 7
// incremental subtree indexes introduced in Phase 1 of the collapsed-frontier
// projection (O1). It mirrors subtree_busy_test.go: for each index it builds an
// INDEPENDENT O(n) reference recompute from s.sessions / s.activity / s.perms /
// s.questions (NOT consulting the incremental index under test), then asserts
// the incremental index matches the reference after every mutation in a
// randomized driver. A missed maintenance site surfaces as a differential
// failure with a mutation trace + tree dump.
//
// Test surface:
//   - TestSubtreeIndexes_TargetedScenarios — named matrix cases per index
//     (orphan-reabsorb-on-recreate, busy↔retry, perm/question transitions,
//     reparent-of-max-holder, delete-of-max-holder, phantom-perm-then-create,
//     bucket transitions).
//   - TestSubtreeIndexesProperty — 1000 random sequences of 50 mutations each
//     (seeded), differential check after every mutation. The driver is a
//     SUPERSET of subtree_busy_test.go's applyRandomMutation: ~85% reuses it
//     (full coverage of session/status/reparent/delete/archive/message/
//     MarkIdle/SetActivityFromStatuses/RemoveSessions/Hydrate/phantom-busy-
//     then-create), ~15% injects permission.asked/replied + question.asked/
//     replied events to exercise the pending-input chokepoint.
//   - TestSubtreeIndexesConcurrent — race-cleanliness under concurrent
//     Snapshot readers + a single writer.
//
// ADDITIVE in Phase 1: the snapshot path is UNCHANGED (still calls
// computeSubtreeBusyLocked, not the new indexes). These tests prove the
// indexes are EQUIVALENT to an independent recompute so Phase 4 may swap the
// projection onto them.

// ----------------------------------------------------------------------------
// REFERENCES — each computes a fresh O(n) ground truth under RLock, INDEPENDENT
// of the incremental index under test. Cycle-guarded (matches the prototype).
// ----------------------------------------------------------------------------

// refChildrenRef builds the effective-parent children map from s.sessions.
// parentID normalizes via the SAME orphan-inclusive rule as
// effectiveParentOfLocked: a child whose parentID is empty OR points at a
// session absent from s.sessions is a root (key ""). Returns sorted-id slices
// so set-equality comparison is order-independent (the incremental index uses
// insertion-ordered slices; order is not part of the contract).
func refChildrenRef(s *Store) map[string][]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[string][]string{}
	for id, se := range s.sessions {
		p := se.parentID
		if p == "" || s.sessions[p] == nil {
			p = "" // orphan-inclusive root
		}
		out[p] = append(out[p], id)
	}
	for k := range out {
		sortStringsInPlace(out[k])
	}
	return out
}

// refRootIDsRef returns the sorted live session ids whose effective parent is "".
func refRootIDsRef(s *Store) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var out []string
	for id, se := range s.sessions {
		p := se.parentID
		if p == "" || s.sessions[p] == nil {
			out = append(out, id)
		}
	}
	sortStringsInPlace(out)
	return out
}

// refSubtreeRetryCount is the count generalization for retry.
func refSubtreeRetryCount(s *Store) map[string]int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	children := map[string][]string{}
	for id, se := range s.sessions {
		if se.parentID != "" && s.sessions[se.parentID] != nil {
			children[se.parentID] = append(children[se.parentID], id)
		}
	}
	self := func(id string) int {
		if s.activity[id] == ActivityRetry {
			return 1
		}
		return 0
	}
	memo := map[string]int{}
	visiting := map[string]bool{}
	var visit func(id string) int
	visit = func(id string) int {
		if v, ok := memo[id]; ok {
			return v
		}
		sum := self(id)
		memo[id] = sum
		visiting[id] = true
		for _, c := range children[id] {
			if visiting[c] {
				continue
			}
			sum += visit(c)
		}
		delete(visiting, id)
		memo[id] = sum
		return sum
	}
	out := make(map[string]int, len(s.sessions))
	for id := range s.sessions {
		out[id] = visit(id)
	}
	return out
}

// refSubtreePendingInput is the count generalization for pending-input
// (has any pending permission OR question).
func refSubtreePendingInput(s *Store) map[string]int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	children := map[string][]string{}
	for id, se := range s.sessions {
		if se.parentID != "" && s.sessions[se.parentID] != nil {
			children[se.parentID] = append(children[se.parentID], id)
		}
	}
	self := func(id string) int {
		if len(s.perms[id]) > 0 || len(s.questions[id]) > 0 {
			return 1
		}
		return 0
	}
	memo := map[string]int{}
	visiting := map[string]bool{}
	var visit func(id string) int
	visit = func(id string) int {
		if v, ok := memo[id]; ok {
			return v
		}
		sum := self(id)
		memo[id] = sum
		visiting[id] = true
		for _, c := range children[id] {
			if visiting[c] {
				continue
			}
			sum += visit(c)
		}
		delete(visiting, id)
		memo[id] = sum
		return sum
	}
	out := make(map[string]int, len(s.sessions))
	for id := range s.sessions {
		out[id] = visit(id)
	}
	return out
}

// refSubtreeDescendantCount is the count of live nodes in each subtree (self=1).
func refSubtreeDescendantCount(s *Store) map[string]int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	children := map[string][]string{}
	for id, se := range s.sessions {
		if se.parentID != "" && s.sessions[se.parentID] != nil {
			children[se.parentID] = append(children[se.parentID], id)
		}
	}
	memo := map[string]int{}
	visiting := map[string]bool{}
	var visit func(id string) int
	visit = func(id string) int {
		if v, ok := memo[id]; ok {
			return v
		}
		sum := 1 // self
		memo[id] = sum
		visiting[id] = true
		for _, c := range children[id] {
			if visiting[c] {
				continue
			}
			sum += visit(c)
		}
		delete(visiting, id)
		memo[id] = sum
		return sum
	}
	out := make(map[string]int, len(s.sessions))
	for id := range s.sessions {
		out[id] = visit(id)
	}
	return out
}

// refSubtreeNewestActivity is the MAX of lastActivityAt over each subtree.
// Zero time.Time (= never active) when no node in the subtree has a recorded
// activity time.
func refSubtreeNewestActivity(s *Store) map[string]time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	children := map[string][]string{}
	for id, se := range s.sessions {
		if se.parentID != "" && s.sessions[se.parentID] != nil {
			children[se.parentID] = append(children[se.parentID], id)
		}
	}
	memo := map[string]time.Time{}
	visiting := map[string]bool{}
	var visit func(id string) time.Time
	visit = func(id string) time.Time {
		if v, ok := memo[id]; ok {
			return v
		}
		max := s.lastActivityAt[id]
		visiting[id] = true
		for _, c := range children[id] {
			if visiting[c] {
				continue
			}
			ct := visit(c)
			if ct.After(max) {
				max = ct
			}
		}
		delete(visiting, id)
		memo[id] = max
		return max
	}
	out := make(map[string]time.Time, len(s.sessions))
	for id := range s.sessions {
		out[id] = visit(id)
	}
	return out
}

// refRecentBucket derives the expected bucket map from lastActivityAt: each
// session with a non-zero lastActivityAt lives in the bucket for its minute.
// Returns map[minute][]sorted-ids AND the sorted key list. Matches what
// touchRecentBucketLocked would have produced (modulo retention eviction,
// which only drops old buckets; the reference includes all so the differential
// catches an over-eviction).
func refRecentBucket(s *Store) (map[int64][]string, []int64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := map[int64][]string{}
	for id, t := range s.lastActivityAt {
		if t.IsZero() {
			continue
		}
		// Only include sessions still in the live tree (delete drops the entry).
		if s.sessions[id] == nil {
			continue
		}
		minute := t.Unix() / 60
		out[minute] = append(out[minute], id)
	}
	for k := range out {
		sortStringsInPlace(out[k])
	}
	keys := make([]int64, 0, len(out))
	for k := range out {
		keys = append(keys, k)
	}
	sortInt64InPlace(keys)
	return out, keys
}

// ----------------------------------------------------------------------------
// COPIES — snapshot the incremental indexes under RLock for lock-free compare.
// ----------------------------------------------------------------------------

func copyChildren(s *Store) map[string][]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string][]string, len(s.children))
	for k, v := range s.children {
		cp := make([]string, len(v))
		copy(cp, v)
		out[k] = cp
	}
	return out
}

func copyRootIDs(s *Store) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	cp := make([]string, len(s.rootIDs))
	copy(cp, s.rootIDs)
	return cp
}

func copyIntIndex(s *Store, idx map[string]int) map[string]int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]int, len(idx))
	for k, v := range idx {
		out[k] = v
	}
	return out
}

func copyTimeIndex(s *Store, idx map[string]time.Time) map[string]time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]time.Time, len(idx))
	for k, v := range idx {
		out[k] = v
	}
	return out
}

func copyRecentBucket(s *Store) (map[int64][]string, []int64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[int64][]string, len(s.recentBucket))
	for k, v := range s.recentBucket {
		cp := make([]string, len(v))
		copy(cp, v)
		out[k] = cp
	}
	keys := make([]int64, len(s.recentBucketKeys))
	copy(keys, s.recentBucketKeys)
	return out, keys
}

// ----------------------------------------------------------------------------
// DIFFERENTIAL — returns "" when the incremental index matches the reference,
// else a human-readable description of the first mismatches.
// ----------------------------------------------------------------------------

func childrenDiff(s *Store) string {
	ref := refChildrenRef(s)
	inc := copyChildren(s)
	// Compare as sorted sets (order is not contractual).
	for k := range inc {
		sortStringsInPlace(inc[k])
	}
	return mapSliceDiff("children", ref, inc)
}

func rootIDsDiff(s *Store) string {
	ref := refRootIDsRef(s)
	inc := copyRootIDs(s)
	sortStringsInPlace(inc)
	if !equalStrings(ref, inc) {
		return fmt.Sprintf("rootIDs: reference=%v incremental=%v; ", ref, inc)
	}
	return ""
}

func subtreeRetryCountDiff(s *Store) string {
	return intIndexDiff("subtreeRetryCount", refSubtreeRetryCount(s), copyIntIndex(s, s.subtreeRetryCount))
}

func subtreePendingInputDiff(s *Store) string {
	return intIndexDiff("subtreePendingInput", refSubtreePendingInput(s), copyIntIndex(s, s.subtreePendingInput))
}

func subtreeDescendantCountDiff(s *Store) string {
	return intIndexDiff("subtreeDescendantCount", refSubtreeDescendantCount(s), copyIntIndex(s, s.subtreeDescendantCount))
}

func subtreeNewestActivityDiff(s *Store) string {
	ref := refSubtreeNewestActivity(s)
	inc := copyTimeIndex(s, s.subtreeNewestActivity)
	keys := map[string]bool{}
	for k := range ref {
		keys[k] = true
	}
	for k := range inc {
		keys[k] = true
	}
	var sb strings.Builder
	for k := range keys {
		rv := ref[k]
		iv := inc[k]
		if !rv.Equal(iv) {
			fmt.Fprintf(&sb, "session %q: reference=%v incremental=%v; ", k, rv, iv)
		}
	}
	return sb.String()
}

func recentBucketDiff(s *Store) string {
	refMap, refKeys := refRecentBucket(s)
	incMap, incKeys := copyRecentBucket(s)
	// Sort each incremental bucket for set-equality compare.
	for k := range incMap {
		sortStringsInPlace(incMap[k])
	}
	var sb strings.Builder
	if d := mapInt64SliceDiff("recentBucket", refMap, incMap); d != "" {
		sb.WriteString(d)
	}
	if !equalInt64(refKeys, incKeys) {
		fmt.Fprintf(&sb, "recentBucketKeys: reference=%v incremental=%v; ", refKeys, incKeys)
	}
	return sb.String()
}

// ----------------------------------------------------------------------------
// shared diff helpers
// ----------------------------------------------------------------------------

func mapSliceDiff(label string, ref, inc map[string][]string) string {
	keys := map[string]bool{}
	for k := range ref {
		keys[k] = true
	}
	for k := range inc {
		keys[k] = true
	}
	var sb strings.Builder
	for k := range keys {
		r := ref[k]
		v := inc[k]
		if !equalStrings(r, v) {
			fmt.Fprintf(&sb, "%s[parent=%q]: reference=%v incremental=%v; ", label, k, r, v)
		}
	}
	return sb.String()
}

func mapInt64SliceDiff(label string, ref, inc map[int64][]string) string {
	keys := map[int64]bool{}
	for k := range ref {
		keys[k] = true
	}
	for k := range inc {
		keys[k] = true
	}
	var sb strings.Builder
	for k := range keys {
		r := ref[k]
		v := inc[k]
		if !equalStrings(r, v) {
			fmt.Fprintf(&sb, "%s[minute=%d]: reference=%v incremental=%v; ", label, k, r, v)
		}
	}
	return sb.String()
}

func intIndexDiff(label string, ref, inc map[string]int) string {
	keys := map[string]bool{}
	for k := range ref {
		keys[k] = true
	}
	for k := range inc {
		keys[k] = true
	}
	var sb strings.Builder
	for k := range keys {
		if ref[k] != inc[k] {
			fmt.Fprintf(&sb, "session %q: %s reference=%d incremental=%d; ", k, label, ref[k], inc[k])
		}
	}
	return sb.String()
}

func equalInt64(a, b []int64) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func sortStringsInPlace(a []string) {
	// Simple insertion sort — these slices are tiny (test fixtures).
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j-1] > a[j]; j-- {
			a[j-1], a[j] = a[j], a[j-1]
		}
	}
}

func sortInt64InPlace(a []int64) {
	for i := 1; i < len(a); i++ {
		for j := i; j > 0 && a[j-1] > a[j]; j-- {
			a[j-1], a[j] = a[j], a[j-1]
		}
	}
}

// assertSubtreeIndexes checks ALL 7 indexes against their references and fails
// the test with the mutation trace + a tree dump on the first mismatch.
func assertSubtreeIndexes(t *testing.T, s *Store, trace string) {
	t.Helper()
	var sb strings.Builder
	if d := childrenDiff(s); d != "" {
		fmt.Fprintf(&sb, "[children] %s\n", d)
	}
	if d := rootIDsDiff(s); d != "" {
		fmt.Fprintf(&sb, "[rootIDs] %s\n", d)
	}
	if d := subtreeRetryCountDiff(s); d != "" {
		fmt.Fprintf(&sb, "[subtreeRetryCount] %s\n", d)
	}
	if d := subtreePendingInputDiff(s); d != "" {
		fmt.Fprintf(&sb, "[subtreePendingInput] %s\n", d)
	}
	if d := subtreeDescendantCountDiff(s); d != "" {
		fmt.Fprintf(&sb, "[subtreeDescendantCount] %s\n", d)
	}
	if d := subtreeNewestActivityDiff(s); d != "" {
		fmt.Fprintf(&sb, "[subtreeNewestActivity] %s\n", d)
	}
	if d := recentBucketDiff(s); d != "" {
		fmt.Fprintf(&sb, "[recentBucket] %s\n", d)
	}
	if sb.Len() > 0 {
		t.Fatalf("subtree index mismatch after [%s]:\n%s\n(tree state: %s)", trace, sb.String(), dumpTreeIndexes(s))
	}
}

// dumpTreeIndexes returns a compact view of all indexes for failure diagnostics.
func dumpTreeIndexes(s *Store) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var sb strings.Builder
	fmt.Fprintf(&sb, "rootIDs=%v ", s.rootIDs)
	for id, se := range s.sessions {
		fmt.Fprintf(&sb, "%s(par=%s,act=%s,retry=%d,pending=%d,desc=%d,t=%v,max=%v) ",
			id, se.parentID, s.activity[id],
			s.subtreeRetryCount[id], s.subtreePendingInput[id], s.subtreeDescendantCount[id],
			s.lastActivityAt[id], s.subtreeNewestActivity[id])
	}
	return strings.TrimSpace(sb.String())
}

// ----------------------------------------------------------------------------
// event helpers for permission / question (extend the ev* set in
// subtree_busy_test.go). Payload shapes match the Apply dispatch cases.
// ----------------------------------------------------------------------------

func evPermissionAsked(sid, pid string) string {
	return fmt.Sprintf(`{"id":%q,"sessionID":%q}`, pid, sid)
}

func evPermissionReplied(sid, pid string) string {
	return fmt.Sprintf(`{"sessionID":%q,"requestID":%q}`, sid, pid)
}

func evQuestionAsked(sid, qid string) string {
	return fmt.Sprintf(`{"id":%q,"sessionID":%q}`, qid, sid)
}

func evQuestionReplied(sid, qid string) string {
	return fmt.Sprintf(`{"sessionID":%q,"requestID":%q}`, sid, qid)
}

// ----------------------------------------------------------------------------
// TARGETED SCENARIOS — one named case per index class + the cross-cutting
// orphan-reabsorb generalization.
// ----------------------------------------------------------------------------

func TestSubtreeIndexes_TargetedScenarios(t *testing.T) {
	t.Run("topology_create_reparent_delete", func(t *testing.T) {
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("a", "r")))
		s.Apply(ev("session.created", evSessionCreated("b", "r")))
		s.Apply(ev("session.created", evSessionCreated("c", "a")))
		assertSubtreeIndexes(t, s, "setup r→a,b; a→c")
		// Reparent c from a to b.
		s.Apply(ev("session.updated", evSessionUpdated("c", "b")))
		assertSubtreeIndexes(t, s, "reparent c a→b")
		// Reparent b to root.
		s.Apply(ev("session.updated", evSessionUpdated("b", "")))
		assertSubtreeIndexes(t, s, "reparent b to root")
		// Delete a (no descendants now).
		s.Apply(ev("session.deleted", evSessionDeleted("a")))
		assertSubtreeIndexes(t, s, "delete a")
	})

	t.Run("topology_recreate_parent_reabsorbs_orphans", func(t *testing.T) {
		// Generalization of the prototype's recreate_parent_with_busy_orphans:
		// each index must reabsorb orphaned descendants on fresh-create.
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("p", "r")))
		s.Apply(ev("session.created", evSessionCreated("c1", "p")))
		s.Apply(ev("session.created", evSessionCreated("c2", "p")))
		s.Apply(ev("session.status", evStatus("c1", "retry")))
		s.Apply(ev("permission.asked", evPermissionAsked("c2", "perm1")))
		assertSubtreeIndexes(t, s, "setup; c1 retry, c2 pending")
		// Delete p (non-cascading): c1, c2 orphaned to roots.
		s.Apply(ev("session.deleted", evSessionDeleted("p")))
		assertSubtreeIndexes(t, s, "p deleted; c1,c2 orphaned to roots")
		// Recreate p under a new root r2: c1, c2 reabsorbed under p.
		s.Apply(ev("session.created", evSessionCreated("r2", "")))
		s.Apply(ev("session.created", evSessionCreated("p", "r2")))
		assertSubtreeIndexes(t, s, "p recreated under r2 reabsorbs c1,c2")
	})

	t.Run("retry_busy_neutral_transitions", func(t *testing.T) {
		// busy↔retry is busy-neutral (no subtreeBusyCount change) but
		// retry-CHANGING. retryCount must update on both transitions.
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("x", "r")))
		assertSubtreeIndexes(t, s, "setup idle")
		s.Apply(ev("session.status", evStatus("x", "busy")))
		assertSubtreeIndexes(t, s, "x busy (retry=0)")
		s.Apply(ev("session.status", evStatus("x", "retry")))
		assertSubtreeIndexes(t, s, "x retry (retry=1)")
		s.Apply(ev("session.status", evStatus("x", "busy")))
		assertSubtreeIndexes(t, s, "x busy again (retry=0)")
		s.Apply(ev("session.idle", evIdle("x")))
		assertSubtreeIndexes(t, s, "x idle")
	})

	t.Run("pending_input_permission_lifecycle", func(t *testing.T) {
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("c", "r")))
		assertSubtreeIndexes(t, s, "setup")
		s.Apply(ev("permission.asked", evPermissionAsked("c", "p1")))
		assertSubtreeIndexes(t, s, "perm p1 asked on c")
		s.Apply(ev("permission.asked", evPermissionAsked("c", "p2")))
		assertSubtreeIndexes(t, s, "perm p2 asked on c (still self=1)")
		s.Apply(ev("permission.replied", evPermissionReplied("c", "p1")))
		assertSubtreeIndexes(t, s, "perm p1 replied (still self=1 via p2)")
		s.Apply(ev("permission.replied", evPermissionReplied("c", "p2")))
		assertSubtreeIndexes(t, s, "perm p2 replied (self=0)")
	})

	t.Run("pending_input_question_lifecycle", func(t *testing.T) {
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("c", "r")))
		s.Apply(ev("question.asked", evQuestionAsked("c", "q1")))
		assertSubtreeIndexes(t, s, "question q1 asked on c")
		s.Apply(ev("question.rejected", evQuestionReplied("c", "q1")))
		assertSubtreeIndexes(t, s, "question q1 rejected")
	})

	t.Run("pending_input_or_union", func(t *testing.T) {
		// A session with a pending perm AND a cleared question (or vice versa)
		// still reads self=1.
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("c", "r")))
		s.Apply(ev("permission.asked", evPermissionAsked("c", "p1")))
		s.Apply(ev("question.asked", evQuestionAsked("c", "q1")))
		assertSubtreeIndexes(t, s, "perm + question both set")
		s.Apply(ev("permission.replied", evPermissionReplied("c", "p1")))
		assertSubtreeIndexes(t, s, "perm cleared, question still set (self=1)")
		s.Apply(ev("question.replied", evQuestionReplied("c", "q1")))
		assertSubtreeIndexes(t, s, "both cleared (self=0)")
	})

	t.Run("phantom_perm_then_create_seeds", func(t *testing.T) {
		// Phantom perm/question (arrives before session.created) must NOT create
		// an index entry; on create, subtreePendingInput is seeded from current
		// perms/questions.
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("permission.asked", evPermissionAsked("ghost", "p1")))
		assertSubtreeIndexes(t, s, "phantom perm on ghost (must not appear)")
		s.Apply(ev("question.asked", evQuestionAsked("ghost", "q1")))
		assertSubtreeIndexes(t, s, "phantom question on ghost (must not appear)")
		s.Apply(ev("session.created", evSessionCreated("ghost", "r")))
		assertSubtreeIndexes(t, s, "ghost created; pendingInput seeded from phantom perm+question")
	})

	t.Run("newest_activity_reparent_of_max_holder", func(t *testing.T) {
		// Reparenting the newest-activity holder out of a subtree must decrease
		// the old root's max (cold-path recompute on departure).
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r1", "")))
		s.Apply(ev("session.created", evSessionCreated("r2", "")))
		s.Apply(ev("session.created", evSessionCreated("c", "r1")))
		s.Apply(ev("session.status", evStatus("c", "busy"))) // records c's activity time
		assertSubtreeIndexes(t, s, "setup r1→c busy")
		// Reparent c from r1 to r2: r1's newestActivity drops to zero.
		s.Apply(ev("session.updated", evSessionUpdated("c", "r2")))
		assertSubtreeIndexes(t, s, "reparent c r1→r2 (r1 max decreases)")
	})

	t.Run("newest_activity_delete_of_max_holder", func(t *testing.T) {
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("c", "r")))
		s.Apply(ev("session.status", evStatus("c", "busy"))) // c's activity time > r's (zero)
		assertSubtreeIndexes(t, s, "setup r→c busy")
		s.Apply(ev("session.deleted", evSessionDeleted("c")))
		assertSubtreeIndexes(t, s, "delete c (r's max returns to zero)")
	})

	t.Run("newest_activity_chain_increase_propagates", func(t *testing.T) {
		// A leaf activity propagates up through every ancestor's max.
		s := New(100)
		ids := []string{"a", "b", "c", "d", "e"}
		s.Apply(ev("session.created", evSessionCreated("a", "")))
		for i := 1; i < len(ids); i++ {
			s.Apply(ev("session.created", evSessionCreated(ids[i], ids[i-1])))
		}
		assertSubtreeIndexes(t, s, "5-deep chain, all idle/zero")
		s.Apply(ev("session.status", evStatus("e", "busy")))
		assertSubtreeIndexes(t, s, "e busy propagates up to a")
		s.Apply(ev("session.idle", evIdle("e")))
		assertSubtreeIndexes(t, s, "e idle (records another activity time)")
	})

	t.Run("recent_bucket_dedup_and_move", func(t *testing.T) {
		// Within one minute, multiple transitions dedup into one bucket entry.
		// A later transition in a new minute moves the id (removes from old,
		// adds to new).
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("c", "r")))
		s.Apply(ev("session.status", evStatus("c", "busy")))
		assertSubtreeIndexes(t, s, "c busy (bucket entry created)")
		// Another transition within the same minute — dedup.
		s.Apply(ev("session.idle", evIdle("c")))
		assertSubtreeIndexes(t, s, "c idle same minute (dedup)")
		// Force a different minute by sleeping > 1s — but tests should be fast,
		// so this case asserts the dedup invariant only. The property test
		// covers cross-minute moves when wall-clock advances.
	})

	t.Run("set_pending_permissions_reconcile", func(t *testing.T) {
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("a", "r")))
		s.Apply(ev("session.created", evSessionCreated("b", "r")))
		rawA := json.RawMessage(evPermissionAsked("a", "p1"))
		rawB := json.RawMessage(evPermissionAsked("b", "p1"))
		s.SetPendingPermissions([]json.RawMessage{rawA, rawB})
		assertSubtreeIndexes(t, s, "SetPendingPermissions a,b")
		// Reconcile down to just a.
		s.SetPendingPermissions([]json.RawMessage{rawA})
		assertSubtreeIndexes(t, s, "SetPendingPermissions a only (b cleared)")
		s.SetPendingPermissions(nil)
		assertSubtreeIndexes(t, s, "SetPendingPermissions empty (all cleared)")
	})

	t.Run("set_pending_questions_reconcile", func(t *testing.T) {
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("a", "r")))
		rawA := json.RawMessage(evQuestionAsked("a", "q1"))
		s.SetPendingQuestions([]json.RawMessage{rawA})
		assertSubtreeIndexes(t, s, "SetPendingQuestions a")
		s.SetPendingQuestions(nil)
		assertSubtreeIndexes(t, s, "SetPendingQuestions empty")
	})

	t.Run("hydrate_reabsorbs_and_reconciles", func(t *testing.T) {
		// Hydrate must maintain every index on direct-assign AND on delete-unseen.
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r1", "")))
		s.Apply(ev("session.created", evSessionCreated("x", "r1")))
		s.Apply(ev("session.status", evStatus("x", "busy")))
		s.Apply(ev("permission.asked", evPermissionAsked("x", "p1")))
		assertSubtreeIndexes(t, s, "setup x busy+pending under r1")
		// Hydrate: keep r1, drop r2; reparent x to r2 (new info bytes force
		// the assign branch).
		s.Hydrate([]json.RawMessage{
			json.RawMessage(`{"id":"r1","title":"r1"}`),
			json.RawMessage(`{"id":"r2","title":"r2"}`),
			json.RawMessage(`{"id":"x","parentID":"r2","title":"x-renamed"}`),
		}, nil)
		assertSubtreeIndexes(t, s, "hydrate reparent x r1→r2")
		// Hydrate dropping x entirely.
		s.Hydrate([]json.RawMessage{
			json.RawMessage(`{"id":"r1","title":"r1"}`),
			json.RawMessage(`{"id":"r2","title":"r2"}`),
		}, nil)
		assertSubtreeIndexes(t, s, "hydrate drop x (delete-unseen)")
	})
}

// ----------------------------------------------------------------------------
// RANDOMIZED DIFFERENTIAL PROPERTY TEST
//
// The driver is a SUPERSET of subtree_busy_test.go's applyRandomMutation: ~85%
// reuses it (full coverage of every site the prototype index covers), ~15%
// injects permission.asked/replied + question.asked/replied events to exercise
// the pending-input chokepoint. The Store remains the source of truth; the
// driver mirror (testEnv) carries no perm/question state because the reference
// functions read s.perms / s.questions directly.
// ----------------------------------------------------------------------------

// applyRandomMutationWithInput extends applyRandomMutation with permission /
// question events. Returns a short description for the trace.
func applyRandomMutationWithInput(t *testing.T, s *Store, env *testEnv, rng *rand.Rand) string {
	// ~15% of the time (and only when the tree is non-empty), fire a perm/
	// question event on a random live session. Phantom (target not yet live)
	// is also exercised occasionally.
	if len(env.live) > 0 && rng.Intn(100) < 15 {
		return applyInputMutation(t, s, env, rng)
	}
	return applyRandomMutation(t, s, env, rng)
}

// applyInputMutation fires a permission or question event on a random live or
// phantom session, exercising the pending-input chokepoint.
func applyInputMutation(t *testing.T, s *Store, env *testEnv, rng *rand.Rand) string {
	// 20% phantom target (a not-yet-created id) to exercise the phantom guard.
	var sid string
	phantom := rng.Intn(5) == 0
	if phantom {
		sid = env.nextID(rng)
	} else {
		sid = env.pick(rng)
		if sid == "" {
			return "(no-op: empty)"
		}
	}
	pid := "p" + strconv.Itoa(rng.Intn(50))
	qid := "q" + strconv.Itoa(rng.Intn(50))
	switch rng.Intn(4) {
	case 0:
		s.Apply(ev("permission.asked", evPermissionAsked(sid, pid)))
		return fmt.Sprintf("permission.asked %q/%q (phantom=%v)", sid, pid, phantom)
	case 1:
		s.Apply(ev("permission.replied", evPermissionReplied(sid, pid)))
		return fmt.Sprintf("permission.replied %q/%q (phantom=%v)", sid, pid, phantom)
	case 2:
		s.Apply(ev("question.asked", evQuestionAsked(sid, qid)))
		return fmt.Sprintf("question.asked %q/%q (phantom=%v)", sid, qid, phantom)
	default:
		s.Apply(ev("question.replied", evQuestionReplied(sid, qid)))
		return fmt.Sprintf("question.replied %q/%q (phantom=%v)", sid, qid, phantom)
	}
}

// runIndexesRandomSequence drives `n` random mutations through the Store's
// public API and asserts ALL 7 indexes match their references after each one.
func runIndexesRandomSequence(t *testing.T, seed int64, n int) {
	t.Helper()
	rng := rand.New(rand.NewSource(seed))
	s := New(200)
	env := newTestEnv()
	var trace strings.Builder
	flushTrace := func(step int, desc string) {
		trace.Reset()
		fmt.Fprintf(&trace, "seq seed=%d step=%d: %s", seed, step, desc)
	}
	for step := 0; step < n; step++ {
		desc := applyRandomMutationWithInput(t, s, env, rng)
		flushTrace(step, desc)
		assertSubtreeIndexes(t, s, trace.String())
	}
}

// TestSubtreeIndexesProperty is the main differential property test for all 7
// new indexes: 1000 random sequences of 50 mutations each, seeded for
// reproducibility. After EVERY mutation ALL 7 indexes are compared against
// independent O(n) reference recomputes. A fixed base seed makes failures
// reproducible; override with SUBTREE_INDEXES_SEED for reproduction, or
// SUBTREE_INDEXES_SEQS / SUBTREE_INDEXES_STEPS to enlarge the run.
func TestSubtreeIndexesProperty(t *testing.T) {
	const (
		defaultSeqs  = 1000
		defaultSteps = 50
		defaultSeed  = 1
	)
	seqs := envInt("SUBTREE_INDEXES_SEQS", defaultSeqs)
	steps := envInt("SUBTREE_INDEXES_STEPS", defaultSteps)
	baseSeed := envInt64("SUBTREE_INDEXES_SEED", defaultSeed)
	t.Logf("subtree indexes property test: seqs=%d steps=%d baseSeed=%d", seqs, steps, baseSeed)
	for i := 0; i < seqs; i++ {
		seed := baseSeed + int64(i)
		runIndexesRandomSequence(t, seed, steps)
	}
}

// TestSubtreeIndexesConcurrent proves the indexes stay correct under concurrent
// readers (Snapshot path still uses computeSubtreeBusyLocked — additive) and a
// single writer applying mutations including perm/question. Race-cleanliness
// under -race is the goal.
func TestSubtreeIndexesConcurrent(t *testing.T) {
	s := New(200)
	// Seed an initial tree with varied state.
	for _, id := range []string{"r", "a", "b", "c"} {
		parent := ""
		switch id {
		case "a", "b":
			parent = "r"
		case "c":
			parent = "a"
		}
		s.Apply(ev("session.created", evSessionCreated(id, parent)))
	}
	s.Apply(ev("session.status", evStatus("c", "retry")))
	s.Apply(ev("permission.asked", evPermissionAsked("c", "p1")))
	assertSubtreeIndexes(t, s, "seed")

	var wg sync.WaitGroup
	wg.Add(2)
	// Writer: deterministic mutations across every chokepoint.
	go func() {
		defer wg.Done()
		s.Apply(ev("session.status", evStatus("a", "busy")))
		s.Apply(ev("permission.asked", evPermissionAsked("a", "p1")))
		s.Apply(ev("question.asked", evQuestionAsked("b", "q1")))
		s.Apply(ev("session.updated", evSessionUpdated("c", "b")))
		s.Apply(ev("session.idle", evIdle("a")))
		s.Apply(ev("permission.replied", evPermissionReplied("c", "p1")))
		s.Apply(ev("session.status", evStatus("c", "idle")))
		s.Apply(ev("question.replied", evQuestionReplied("b", "q1")))
	}()
	// Reader: concurrent Snapshot calls (which use computeSubtreeBusyLocked,
	// unchanged — additive) must not race against the new index writes. Also
	// concurrently read the new indexes to prove they're race-clean too.
	go func() {
		defer wg.Done()
		for i := 0; i < 50; i++ {
			_ = s.Snapshot(nil)
			// Read the new indexes under RLock via the copy helpers.
			_ = copyChildren(s)
			_ = copyRootIDs(s)
			_ = copyIntIndex(s, s.subtreeRetryCount)
			_ = copyIntIndex(s, s.subtreePendingInput)
			_ = copyIntIndex(s, s.subtreeDescendantCount)
			_ = copyTimeIndex(s, s.subtreeNewestActivity)
			_, _ = copyRecentBucket(s)
		}
	}()
	wg.Wait()
	assertSubtreeIndexes(t, s, "after concurrent writer+reader")
}
