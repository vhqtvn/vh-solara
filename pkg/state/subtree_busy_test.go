package state

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// This file is the Gate C de-risking property test for the incremental
// subtreeBusyCount index (the central, busiest of the 8 collapsed-frontier
// indexes). It proves the incremental index matches an INDEPENDENT O(n)
// reference recompute under randomized mutations across every site that can
// change busy state or tree topology. The reference (referenceSubtreeBusyCount)
// is a count generalization of computeSubtreeBusyLocked; it does NOT consult
// s.subtreeBusyCount, so a missed maintenance site shows up as a differential
// failure.
//
// Test surface:
//   - TestSubtreeBusyCount_TargetedScenarios — named matrix cases (leaf-busy,
//     internal-busy, reparent-a-busy-subtree, delete-a-busy-subtree,
//     busy-then-idle, idle-then-busy, multi-level cascade, phantom-status-then-
//     create, message-stream busy escalation, hydrate reparent).
//   - TestSubtreeBusyCountProperty — 1000 random sequences of 50 mutations each
//     (seeded), differential check after every mutation.

// referenceSubtreeBusyCount is the INDEPENDENT O(n) ground truth: for every
// session currently in s.sessions, the count of busy/retry sessions in its
// subtree (including itself when busy/retry). It is the count generalization of
// computeSubtreeBusyLocked — computeSubtreeBusyLocked returns bool (= count > 0);
// maintaining the stricter count invariant is what proves the pattern sound for
// replication to the other 7 indexes. It does NOT read s.subtreeBusyCount.
// Reads s.sessions + s.activity under s.mu.RLock (race-clean).
func referenceSubtreeBusyCount(s *Store) map[string]int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	children := map[string][]string{}
	for id, se := range s.sessions {
		if se.parentID != "" && s.sessions[se.parentID] != nil {
			children[se.parentID] = append(children[se.parentID], id)
		}
	}
	selfBusy := func(id string) int {
		a := s.activity[id]
		if a == ActivityBusy || a == ActivityRetry {
			return 1
		}
		return 0
	}
	memo := map[string]int{}
	visiting := map[string]bool{} // cycle guard (matches computeSubtreeBusyLocked intent)
	var visit func(id string) int
	visit = func(id string) int {
		if v, ok := memo[id]; ok {
			return v
		}
		sum := selfBusy(id)
		memo[id] = sum
		visiting[id] = true
		for _, c := range children[id] {
			if visiting[c] {
				continue // malformed cyclic parent link: skip, never recurse forever
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

// copySubtreeBusyCount returns a snapshot copy of the incremental index under
// s.mu.RLock. The copy is what we compare against the reference so the
// comparison itself is lock-free and race-clean under -race.
func copySubtreeBusyCount(s *Store) map[string]int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make(map[string]int, len(s.subtreeBusyCount))
	for k, v := range s.subtreeBusyCount {
		out[k] = v
	}
	return out
}

// subtreeBusyCountDiff returns "" when the incremental index matches the
// reference for EVERY session in the union of keys, else a human-readable
// description of the first mismatches. A phantom entry in the incremental index
// (key not in s.sessions) or a missing entry (session in s.sessions with no
// index entry when reference > 0) both surface here.
func subtreeBusyCountDiff(s *Store) string {
	ref := referenceSubtreeBusyCount(s)
	inc := copySubtreeBusyCount(s)
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
			fmt.Fprintf(&sb, "session %q: reference=%d incremental=%d; ", k, ref[k], inc[k])
		}
	}
	return sb.String()
}

// assertSubtreeBusyCount checks the differential and fails the test with the
// mutation trace if a mismatch is found.
func assertSubtreeBusyCount(t *testing.T, s *Store, trace string) {
	t.Helper()
	if diff := subtreeBusyCountDiff(s); diff != "" {
		t.Fatalf("subtreeBusyCount mismatch after [%s]:\n  %s\n(tree state: %s)", trace, diff, dumpTree(s))
	}
}

// dumpTree returns a compact readable view of the live session tree + activity
// for failure diagnostics: each line is "id(parent=parentID,act=activity,sub=inc)".
func dumpTree(s *Store) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if len(s.sessions) == 0 {
		return "(empty)"
	}
	var sb strings.Builder
	for id, se := range s.sessions {
		fmt.Fprintf(&sb, "%s(parent=%s,act=%s,sub=%d) ", id, se.parentID, s.activity[id], s.subtreeBusyCount[id])
	}
	return strings.TrimSpace(sb.String())
}

// --- helpers for issuing Apply events with realistic payloads ---

func evSessionCreated(id, parentID string) string {
	if parentID == "" {
		return fmt.Sprintf(`{"info":{"id":%q,"title":"%s"}}`, id, id)
	}
	return fmt.Sprintf(`{"info":{"id":%q,"parentID":%q,"title":"%s"}}`, id, parentID, id)
}

func evSessionUpdated(id, parentID string) string {
	// session.updated routes through the SAME upsertSessionLocked path as
	// session.created; reusing it for reparents / metadata refreshes exercises
	// the create+reparent site with a realistic payload.
	return evSessionCreated(id, parentID)
}

func evSessionArchived(id string) string {
	// time.archived set → upsertSessionLocked funnels to deleteSessionLocked.
	return fmt.Sprintf(`{"info":{"id":%q,"time":{"archived":1700000000}}}`, id)
}

func evSessionDeleted(id string) string {
	return fmt.Sprintf(`{"info":{"id":%q}}`, id)
}

func evStatus(id, typ string) string {
	return fmt.Sprintf(`{"sessionID":%q,"status":{"type":%q}}`, id, typ)
}

func evIdle(id string) string {
	return fmt.Sprintf(`{"sessionID":%q}`, id)
}

// evAssistantInflight upserts an assistant message with NO time.completed so
// assistantInflightLocked returns true → upsertMessageLocked escalates to busy
// via setActivityLocked (store.go line ~1712). Exercises the message-stream
// busy-escalation site the research gate missed.
func evAssistantInflight(id, msgID string) string {
	return fmt.Sprintf(`{"info":{"id":%q,"sessionID":%q,"role":"assistant"}}`, msgID, id)
}

// evAssistantCompleted upserts an assistant message WITH time.completed so it
// does NOT trigger escalation (turn finished). The session's activity is owned
// by session.idle, not this; included to prove a completed assistant msg does
// not corrupt the index.
func evAssistantCompleted(id, msgID string) string {
	return fmt.Sprintf(`{"info":{"id":%q,"sessionID":%q,"role":"assistant","time":{"completed":1700000000}}}`, msgID, id)
}

// --- targeted scenario tests (named matrix cases) ---

func TestSubtreeBusyCount_TargetedScenarios(t *testing.T) {
	t.Run("leaf_busy_then_idle", func(t *testing.T) {
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("root", "")))
		s.Apply(ev("session.created", evSessionCreated("child", "root")))
		assertSubtreeBusyCount(t, s, "setup root+child idle")
		// Leaf busy: child's own +1 propagates to root.
		s.Apply(ev("session.status", evStatus("child", "busy")))
		assertSubtreeBusyCount(t, s, "child busy")
		s.Apply(ev("session.idle", evIdle("child")))
		assertSubtreeBusyCount(t, s, "child idle")
	})

	t.Run("internal_busy_propagates_to_root", func(t *testing.T) {
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("m", "r")))
		s.Apply(ev("session.created", evSessionCreated("l", "m")))
		s.Apply(ev("session.status", evStatus("m", "busy")))
		assertSubtreeBusyCount(t, s, "internal m busy")
		// Both r and m should carry the busy count; leaf l should not.
	})

	t.Run("multi_level_cascade", func(t *testing.T) {
		s := New(100)
		// a -> b -> c -> d -> e  (5-deep chain)
		ids := []string{"a", "b", "c", "d", "e"}
		s.Apply(ev("session.created", evSessionCreated("a", "")))
		for i := 1; i < len(ids); i++ {
			s.Apply(ev("session.created", evSessionCreated(ids[i], ids[i-1])))
		}
		// Make e and c busy → every ancestor of each gets +1; a gets +2.
		s.Apply(ev("session.status", evStatus("e", "busy")))
		assertSubtreeBusyCount(t, s, "e busy")
		s.Apply(ev("session.status", evStatus("c", "busy")))
		assertSubtreeBusyCount(t, s, "e and c busy")
		// Idle e → a drops by 1.
		s.Apply(ev("session.idle", evIdle("e")))
		assertSubtreeBusyCount(t, s, "e idle, c still busy")
	})

	t.Run("reparent_busy_subtree", func(t *testing.T) {
		s := New(100)
		// Tree 1: r1 -> x (x busy); Tree 2: r2 -> y.
		s.Apply(ev("session.created", evSessionCreated("r1", "")))
		s.Apply(ev("session.created", evSessionCreated("r2", "")))
		s.Apply(ev("session.created", evSessionCreated("x", "r1")))
		s.Apply(ev("session.created", evSessionCreated("y", "r2")))
		s.Apply(ev("session.status", evStatus("x", "busy")))
		assertSubtreeBusyCount(t, s, "x busy under r1")
		// Reparent x from r1 to r2: r1 loses 1, r2 gains 1, x unchanged.
		s.Apply(ev("session.updated", evSessionUpdated("x", "r2")))
		assertSubtreeBusyCount(t, s, "x reparented r1→r2")
		// Reparent x to a root (empty parent): r2 loses 1, no new ancestor gains.
		s.Apply(ev("session.updated", evSessionUpdated("x", "")))
		assertSubtreeBusyCount(t, s, "x reparented to root")
	})

	t.Run("delete_busy_subtree", func(t *testing.T) {
		s := New(100)
		// r -> p -> c1, c2 (c1 and c2 both busy).
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("p", "r")))
		s.Apply(ev("session.created", evSessionCreated("c1", "p")))
		s.Apply(ev("session.created", evSessionCreated("c2", "p")))
		s.Apply(ev("session.status", evStatus("c1", "busy")))
		s.Apply(ev("session.status", evStatus("c2", "busy")))
		assertSubtreeBusyCount(t, s, "c1,c2 busy")
		// Delete p: p's subtree count (2) is subtracted from r. c1/c2 become
		// orphaned roots; their own counts are unchanged and self-contained.
		s.Apply(ev("session.deleted", evSessionDeleted("p")))
		assertSubtreeBusyCount(t, s, "p deleted (c1,c2 orphaned)")
	})

	t.Run("archive_via_updated_is_delete", func(t *testing.T) {
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("c", "r")))
		s.Apply(ev("session.status", evStatus("c", "busy")))
		assertSubtreeBusyCount(t, s, "c busy")
		// time.archived on c → upsertSessionLocked funnels to deleteSessionLocked.
		s.Apply(ev("session.updated", evSessionArchived("c")))
		assertSubtreeBusyCount(t, s, "c archived (deleted)")
	})

	t.Run("busy_then_retry_then_error_then_idle", func(t *testing.T) {
		// busy↔retry is a no-op for the busy count (both count as busy);
		// busy→error and busy→idle are real flips. Cover all transitions.
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("x", "")))
		s.Apply(ev("session.status", evStatus("x", "busy")))
		assertSubtreeBusyCount(t, s, "busy")
		s.Apply(ev("session.status", evStatus("x", "retry")))
		assertSubtreeBusyCount(t, s, "retry (still busy-class)")
		s.Apply(ev("session.error", evIdle("x")))
		assertSubtreeBusyCount(t, s, "error (no longer busy-class)")
		s.Apply(ev("session.status", evStatus("x", "busy")))
		assertSubtreeBusyCount(t, s, "busy again")
		s.Apply(ev("session.idle", evIdle("x")))
		assertSubtreeBusyCount(t, s, "idle")
	})

	t.Run("phantom_status_then_create", func(t *testing.T) {
		// A status event for a not-yet-created session must NOT create a phantom
		// index entry; when the session is later created, its own contribution
		// is seeded from the pre-set activity.
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		// Phantom busy for "ghost" (not in tree yet).
		s.Apply(ev("session.status", evStatus("ghost", "busy")))
		assertSubtreeBusyCount(t, s, "phantom ghost busy (must not appear)")
		// Create ghost under r → r must now reflect ghost's busy contribution.
		s.Apply(ev("session.created", evSessionCreated("ghost", "r")))
		assertSubtreeBusyCount(t, s, "ghost created under r after phantom busy")
	})

	t.Run("message_stream_busy_escalation", func(t *testing.T) {
		// The two sites the research gate MISSED: upsertMessageLocked and
		// appendPartDeltaLocked both escalate to busy via setActivityLocked
		// (store.go ~1712, ~2235). The incremental index must track them —
		// and does, because they funnel through setActivityLocked.
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("c", "r")))
		assertSubtreeBusyCount(t, s, "setup")
		// In-flight assistant message on c → c escalates to busy.
		s.Apply(ev("message.updated", evAssistantInflight("c", "m1")))
		assertSubtreeBusyCount(t, s, "assistant in-flight on c (busy escalation)")
		// Completed assistant message does NOT clear busy (only session.idle
		// does) — prove the index stays consistent through the no-op.
		s.Apply(ev("message.updated", evAssistantCompleted("c", "m1")))
		assertSubtreeBusyCount(t, s, "assistant completed (busy still set until idle)")
		s.Apply(ev("session.idle", evIdle("c")))
		assertSubtreeBusyCount(t, s, "c idle")
	})

	t.Run("mark_idle_entrypoint", func(t *testing.T) {
		// MarkIdle is the abort path; it calls setActivityLocked directly.
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("x", "")))
		s.Apply(ev("session.status", evStatus("x", "busy")))
		assertSubtreeBusyCount(t, s, "x busy")
		s.MarkIdle("x")
		assertSubtreeBusyCount(t, s, "MarkIdle(x)")
	})

	t.Run("set_activity_from_statuses", func(t *testing.T) {
		// SetActivityFromStatuses reconciles activity for a session set; it
		// calls setActivityLocked in a loop. Build a tree, set some busy, then
		// reconcile to a different busy set.
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("a", "r")))
		s.Apply(ev("session.created", evSessionCreated("b", "r")))
		s.Apply(ev("session.status", evStatus("a", "busy")))
		s.Apply(ev("session.status", evStatus("b", "busy")))
		assertSubtreeBusyCount(t, s, "a,b busy")
		// Reconcile: only b is busy now; a is cleared to idle.
		statusJSON := func(id, typ string) json.RawMessage {
			return json.RawMessage(fmt.Sprintf(`{"id":%q,"type":%q}`, id, typ))
		}
		s.SetActivityFromStatuses(map[string]json.RawMessage{
			"a": statusJSON("a", "idle"),
			"b": statusJSON("b", "busy"),
		})
		assertSubtreeBusyCount(t, s, "reconciled: b busy, a idle")
	})

	t.Run("remove_sessions_entrypoint", func(t *testing.T) {
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("c", "r")))
		s.Apply(ev("session.status", evStatus("c", "busy")))
		assertSubtreeBusyCount(t, s, "c busy")
		s.RemoveSessions([]string{"c"})
		assertSubtreeBusyCount(t, s, "RemoveSessions(c)")
	})

	t.Run("hydrate_reparent_and_create", func(t *testing.T) {
		// Hydrate assigns s.sessions directly (bypassing upsertSessionLocked),
		// so it must maintain the index itself. Build a tree, make some busy,
		// then Hydrate with a reparented + a new session.
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r1", "")))
		s.Apply(ev("session.created", evSessionCreated("r2", "")))
		s.Apply(ev("session.created", evSessionCreated("x", "r1")))
		s.Apply(ev("session.status", evStatus("x", "busy")))
		assertSubtreeBusyCount(t, s, "x busy under r1")
		// Hydrate: keep r1, r2; reparent x to r2 (new info bytes force the
		// assign branch); drop nothing. Empty messages.
		sess := []json.RawMessage{
			json.RawMessage(`{"id":"r1","title":"r1"}`),
			json.RawMessage(`{"id":"r2","title":"r2"}`),
			json.RawMessage(`{"id":"x","parentID":"r2","title":"x-renamed"}`), // new info + reparent
		}
		s.Hydrate(sess, nil)
		assertSubtreeBusyCount(t, s, "hydrate reparent x r1→r2")
		// Hydrate again dropping x entirely (delete via hydrate).
		s.Hydrate([]json.RawMessage{
			json.RawMessage(`{"id":"r1","title":"r1"}`),
			json.RawMessage(`{"id":"r2","title":"r2"}`),
		}, nil)
		assertSubtreeBusyCount(t, s, "hydrate drop x")
	})

	t.Run("recreate_same_id", func(t *testing.T) {
		// deleteSessionLocked clears activity; a re-created session starts idle.
		s := New(100)
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("x", "r")))
		s.Apply(ev("session.status", evStatus("x", "busy")))
		assertSubtreeBusyCount(t, s, "x busy")
		s.Apply(ev("session.deleted", evSessionDeleted("x")))
		assertSubtreeBusyCount(t, s, "x deleted")
		s.Apply(ev("session.created", evSessionCreated("x", "r")))
		assertSubtreeBusyCount(t, s, "x recreated (idle)")
	})

	t.Run("recreate_parent_with_busy_orphans", func(t *testing.T) {
		// Pins the production recreate path the fresh-create O(n) child scan
		// exists for (commit-review tc_F5). deleteSessionLocked does NOT
		// cascade, so deleting a parent orphans its children: they stay live
		// with parentID still pointing at the deleted id. A later
		// session.created (archive/un-archive) or Hydrate reappearance for the
		// same id MUST reabsorb those still-live, still-busy descendants into
		// the recreated parent and its new ancestor chain. The reference
		// rebuilds children every call so it sees the orphans; the incremental
		// fresh-create branch must match by summing direct children's
		// subtreeBusyCount. This was a real property-test failure (seed=91
		// step=41) before the scan was added.
		s := New(100)
		// Tree: r -> p -> c (c busy). subtreeBusy: c=1, p=1, r=1.
		s.Apply(ev("session.created", evSessionCreated("r", "")))
		s.Apply(ev("session.created", evSessionCreated("p", "r")))
		s.Apply(ev("session.created", evSessionCreated("c", "p")))
		s.Apply(ev("session.status", evStatus("c", "busy")))
		assertSubtreeBusyCount(t, s, "c busy under p under r")
		// Delete p (non-cascading): c is orphaned, parentID still "p".
		// subtreeBusy: c=1, r=0 (p gone). c's busy no longer reaches r.
		s.Apply(ev("session.deleted", evSessionDeleted("p")))
		assertSubtreeBusyCount(t, s, "p deleted, c orphaned")
		// Recreate p under a brand-new root r2. c is still a live busy child
		// of p. subtreeBusy must become: c=1, p=1, r2=1.
		s.Apply(ev("session.created", evSessionCreated("r2", "")))
		s.Apply(ev("session.created", evSessionCreated("p", "r2")))
		assertSubtreeBusyCount(t, s, "p recreated under r2 reabsorbs orphaned busy c")
	})
}

// --- randomized differential property test ---

// testEnv holds the driver's mirror of the live session set, used only to pick
// plausible mutation targets. The Store remains the source of truth; mirror
// drift is tolerable (a status for a just-deleted ID is a no-op the store
// handles gracefully and the differential still validates).
type testEnv struct {
	live    map[string]bool // live session IDs (driver mirror)
	parents map[string]string
}

func newTestEnv() *testEnv {
	return &testEnv{live: map[string]bool{}, parents: map[string]string{}}
}

func (e *testEnv) pick(rng *rand.Rand) string {
	for id := range e.live {
		if rng.Intn(2) == 0 {
			return id
		}
	}
	// Fallback: deterministic pick for reproducibility.
	for id := range e.live {
		return id
	}
	return ""
}

// pickParent returns a random existing live ID (to parent under) or "" (root),
// roughly half/half. Never returns the excluded id and never returns one of its
// descendants — parenting a session under its own descendant would create a
// CYCLE, which is not a valid input (OpenCode session trees are acyclic; the
// store's rootOfLocked / descendantsLocked / computeSubtreeBusyLocked all
// assume acyclicity, with only defense-in-depth iteration bounds). The driver
// mirror's parent links are the source for the descendant check.
func (e *testEnv) pickParent(rng *rand.Rand, exclude string) string {
	if rng.Intn(2) == 0 {
		return ""
	}
	for i := 0; i < 8; i++ {
		cand := e.pick(rng)
		if cand == "" || cand == exclude {
			continue
		}
		if e.isDescendant(cand, exclude) {
			continue // cand is under exclude → parenting exclude under cand would cycle
		}
		return cand
	}
	return ""
}

// isDescendant reports whether cand is a (transitive) descendant of root,
// walking the driver-mirror parent links up from cand. Used only to keep the
// random driver from synthesizing cyclic parent relationships.
func (e *testEnv) isDescendant(cand, root string) bool {
	cur := cand
	for i := 0; i < 10000; i++ {
		p, ok := e.parents[cur]
		if !ok || p == "" {
			return false
		}
		if p == root {
			return true
		}
		cur = p
	}
	return false
}

// nextID mints a new session ID not currently in the live mirror.
func (e *testEnv) nextID(rng *rand.Rand) string {
	for i := 0; i < 1000; i++ {
		cand := "s" + strconv.Itoa(rng.Intn(200))
		if !e.live[cand] {
			return cand
		}
	}
	return "s" + strconv.Itoa(rng.Intn(1<<30))
}

// runRandomSequence drives `n` random mutations through the Store's public API
// and asserts the incremental index matches the reference after EACH one. The
// `trace` records every mutation for a readable failure message.
func runRandomSequence(t *testing.T, seed int64, n int) {
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
		desc := applyRandomMutation(t, s, env, rng)
		flushTrace(step, desc)
		assertSubtreeBusyCount(t, s, trace.String())
	}
}

// applyRandomMutation picks a weighted random mutation, applies it via the
// Store's public API, updates the driver mirror, and returns a short
// description. Distribution is tuned to cover the full matrix while keeping the
// tree from collapsing to empty (creates outpace deletes).
func applyRandomMutation(t *testing.T, s *Store, env *testEnv, rng *rand.Rand) string {
	liveCount := len(env.live)
	r := rng.Intn(100)
	switch {
	// --- creates (biased up when the tree is small so we get depth) ---
	case liveCount < 4 || r < 25:
		id := env.nextID(rng)
		parent := env.pickParent(rng, id)
		s.Apply(ev("session.created", evSessionCreated(id, parent)))
		env.live[id] = true
		env.parents[id] = parent
		return fmt.Sprintf("create %q parent=%q", id, parent)

	// --- status transitions (the busy-state chokepoint via Apply) ---
	case r < 40:
		id := env.pick(rng)
		if id == "" {
			return "(no-op: empty)"
		}
		switch rng.Intn(4) {
		case 0:
			s.Apply(ev("session.status", evStatus(id, "busy")))
			return fmt.Sprintf("status %q=busy", id)
		case 1:
			s.Apply(ev("session.status", evStatus(id, "retry")))
			return fmt.Sprintf("status %q=retry", id)
		case 2:
			s.Apply(ev("session.status", evStatus(id, "idle-ish")))
			return fmt.Sprintf("status %q=other", id)
		default:
			s.Apply(ev("session.idle", evIdle(id)))
			return fmt.Sprintf("idle %q", id)
		}

	// --- error transition ---
	case r < 45:
		id := env.pick(rng)
		if id == "" {
			return "(no-op: empty)"
		}
		s.Apply(ev("session.error", evIdle(id)))
		return fmt.Sprintf("error %q", id)

	// --- reparent (session.updated with new parentID) ---
	case r < 58:
		id := env.pick(rng)
		if id == "" {
			return "(no-op: empty)"
		}
		newParent := env.pickParent(rng, id)
		s.Apply(ev("session.updated", evSessionUpdated(id, newParent)))
		env.parents[id] = newParent
		return fmt.Sprintf("reparent %q → %q", id, newParent)

	// --- metadata-only update (same parent, different title bytes) ---
	case r < 65:
		id := env.pick(rng)
		if id == "" {
			return "(no-op: empty)"
		}
		// Re-issue the same created payload (idempotent) to exercise the
		// same-parent fast path of maintainSubtreeBusyOnSessionUpsertLocked.
		s.Apply(ev("session.updated", evSessionCreated(id, env.parents[id])))
		return fmt.Sprintf("metadata-update %q", id)

	// --- delete ---
	case r < 76:
		id := env.pick(rng)
		if id == "" {
			return "(no-op: empty)"
		}
		s.Apply(ev("session.deleted", evSessionDeleted(id)))
		delete(env.live, id)
		delete(env.parents, id)
		return fmt.Sprintf("delete %q", id)

	// --- archive via session.updated (delete chokepoint via upsert) ---
	case r < 80:
		id := env.pick(rng)
		if id == "" {
			return "(no-op: empty)"
		}
		s.Apply(ev("session.updated", evSessionArchived(id)))
		delete(env.live, id)
		delete(env.parents, id)
		return fmt.Sprintf("archive %q", id)

	// --- message-stream busy escalation (the sites the research missed) ---
	case r < 88:
		id := env.pick(rng)
		if id == "" {
			return "(no-op: empty)"
		}
		msgID := "m" + id + strconv.Itoa(rng.Intn(50))
		if rng.Intn(2) == 0 {
			s.Apply(ev("message.updated", evAssistantInflight(id, msgID)))
			return fmt.Sprintf("assistant-inflight %q (busy escalation)", id)
		}
		s.Apply(ev("message.updated", evAssistantCompleted(id, msgID)))
		return fmt.Sprintf("assistant-completed %q", id)

	// --- MarkIdle entrypoint ---
	case r < 91:
		id := env.pick(rng)
		if id == "" {
			return "(no-op: empty)"
		}
		s.MarkIdle(id)
		return fmt.Sprintf("MarkIdle %q", id)

	// --- SetActivityFromStatuses reconcile ---
	case r < 93:
		if len(env.live) == 0 {
			return "(no-op: empty)"
		}
		st := map[string]json.RawMessage{}
		typs := []string{"busy", "retry", "idle"}
		for id := range env.live {
			if rng.Intn(2) == 0 {
				ty := typs[rng.Intn(len(typs))]
				st[id] = json.RawMessage(fmt.Sprintf(`{"id":%q,"type":%q}`, id, ty))
			}
		}
		s.SetActivityFromStatuses(st)
		return fmt.Sprintf("SetActivityFromStatuses(%d sessions)", len(st))

	// --- RemoveSessions entrypoint (delete chokepoint) ---
	case r < 95:
		if len(env.live) == 0 {
			return "(no-op: empty)"
		}
		var ids []string
		for id := range env.live {
			if rng.Intn(3) == 0 {
				ids = append(ids, id)
			}
		}
		if len(ids) == 0 {
			return "(no-op: empty)"
		}
		s.RemoveSessions(ids)
		for _, id := range ids {
			delete(env.live, id)
			delete(env.parents, id)
		}
		return fmt.Sprintf("RemoveSessions(%v)", ids)

	// --- Hydrate (direct-assign site + hydrate-side delete) ---
	case r < 98:
		if len(env.live) == 0 {
			return "(no-op: empty)"
		}
		var sess []json.RawMessage
		keep := map[string]bool{}
		for id := range env.live {
			if rng.Intn(4) != 0 {
				// Keep it: maybe reparent, maybe metadata-only change.
				par := env.parents[id]
				if rng.Intn(3) == 0 {
					par = env.pickParent(rng, id)
				}
				title := id
				if rng.Intn(2) == 0 {
					title = id + "-h" // new info bytes → forces the assign branch
				}
				if par == "" {
					sess = append(sess, json.RawMessage(fmt.Sprintf(`{"id":%q,"title":%q}`, id, title)))
				} else {
					sess = append(sess, json.RawMessage(fmt.Sprintf(`{"id":%q,"parentID":%q,"title":%q}`, id, par, title)))
				}
				keep[id] = true
				env.parents[id] = par
			}
		}
		// Occasionally introduce a brand-new session via Hydrate.
		if rng.Intn(3) == 0 {
			nid := env.nextID(rng)
			par := env.pickParent(rng, nid)
			if par == "" {
				sess = append(sess, json.RawMessage(fmt.Sprintf(`{"id":%q,"title":%q}`, nid, nid)))
			} else {
				sess = append(sess, json.RawMessage(fmt.Sprintf(`{"id":%q,"parentID":%q,"title":%q}`, nid, par, nid)))
			}
			keep[nid] = true
			env.parents[nid] = par
		}
		s.Hydrate(sess, nil)
		// Drop mirror entries not kept.
		for id := range env.live {
			if !keep[id] {
				delete(env.live, id)
				delete(env.parents, id)
			}
		}
		for id := range keep {
			env.live[id] = true
		}
		return fmt.Sprintf("Hydrate(%d sessions)", len(sess))

	// --- phantom status then create (guard + seeding) ---
	default:
		id := env.nextID(rng)
		parent := env.pickParent(rng, id)
		// Phantom status first (id not yet in tree).
		s.Apply(ev("session.status", evStatus(id, "busy")))
		// Then create it — index must seed own contribution + propagate.
		s.Apply(ev("session.created", evSessionCreated(id, parent)))
		env.live[id] = true
		env.parents[id] = parent
		return fmt.Sprintf("phantom-busy-then-create %q parent=%q", id, parent)
	}
}

// TestSubtreeBusyCountProperty is the main differential property test: 1000
// random sequences of 50 mutations each, seeded for reproducibility. After
// EVERY mutation the incremental index is compared against an independent O(n)
// reference recompute across the union of all session IDs. A fixed base seed
// makes failures reproducible; override it with SUBTREE_BUSY_SEED for
// reproduction, or SUBTREE_BUSY_SEQS / SUBTREE_BUSY_STEPS to enlarge the run.
func TestSubtreeBusyCountProperty(t *testing.T) {
	const (
		defaultSeqs  = 1000
		defaultSteps = 50
		defaultSeed  = 1
	)
	seqs := envInt("SUBTREE_BUSY_SEQS", defaultSeqs)
	steps := envInt("SUBTREE_BUSY_STEPS", defaultSteps)
	baseSeed := envInt64("SUBTREE_BUSY_SEED", defaultSeed)
	t.Logf("subtreeBusyCount property test: seqs=%d steps=%d baseSeed=%d", seqs, steps, baseSeed)
	for i := 0; i < seqs; i++ {
		seed := baseSeed + int64(i)
		runRandomSequence(t, seed, steps)
	}
}

func envInt(name string, def int) int {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func envInt64(name string, def int64) int64 {
	if v := os.Getenv(name); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

// TestSubtreeBusyCountConcurrent proves the index stays correct under concurrent
// readers (Snapshot path still uses computeSubtreeBusyLocked — additive) and a
// single writer applying mutations. Race-cleanliness under -race is the goal.
func TestSubtreeBusyCountConcurrent(t *testing.T) {
	s := New(200)
	// Seed an initial tree.
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
	s.Apply(ev("session.status", evStatus("c", "busy")))
	assertSubtreeBusyCount(t, s, "seed")

	var wg sync.WaitGroup
	wg.Add(2)
	// Writer: drive a deterministic sequence of mutations.
	go func() {
		defer wg.Done()
		s.Apply(ev("session.status", evStatus("a", "busy")))
		s.Apply(ev("session.status", evStatus("b", "retry")))
		s.Apply(ev("session.updated", evSessionUpdated("c", "b")))
		s.Apply(ev("session.idle", evIdle("a")))
		s.Apply(ev("session.status", evStatus("c", "idle")))
	}()
	// Reader: concurrent Snapshot calls (which use computeSubtreeBusyLocked,
	// unchanged) must not race against the index writes.
	go func() {
		defer wg.Done()
		for i := 0; i < 50; i++ {
			_ = s.Snapshot(nil)
		}
	}()
	wg.Wait()
	assertSubtreeBusyCount(t, s, "after concurrent writer+reader")
}
