package web

// FIX-QUEUE-GC-5: automatic bounded compaction of terminal queue items.
//
// These 12 cases pin the retention contract:
//   - sent:    TTL 1h,  cap 50
//   - failed:  TTL 7d,  cap 100
//   - unknown: TTL 30d, cap 200
//   - pending/dispatching: NEVER purged
//
// Age is measured from ResolvedAt (the terminal-state arrival time), NEVER
// CreatedAt. Missing ResolvedAt is conservative: survives TTL, ordered by
// Order as fallback in the count-cap pass. Compaction triggers on List()
// (after stale-dispatch recovery) and Resolve() (after the terminal
// transition) — no dedicated goroutine/ticker. The 12th case
// (TestQueueCompactListArchivedGuardNoFreshFileDeletion) pins the b-F1 fix:
// List()'s archived tombstone guard must prevent a retained archived-store
// pointer from deleting a fresh post-archive store's queue.json via the
// empty-queue os.Remove branch.

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"
)

// seedTerminalItem writes ONE terminal item directly into the store with the
// given ResolvedAt, bypassing Resolve() (which stamps time.Now()). The item
// is persisted durably so a fresh sessionQueueStore pointing at the same
// path observes it. Mirrors seedDispatchingItem.
func seedTerminalItem(t *testing.T, s *sessionQueueStore, id, text string, state QueueItemState, resolvedAt int64) QueueItem {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		t.Fatalf("seedTerminalItem load: %v", err)
	}
	s.order++
	it := QueueItem{
		ID:          id,
		Order:       s.order,
		State:       state,
		Text:        text,
		Attachments: []QueueAttachment{},
		CreatedAt:   time.Now().UnixMilli(),
		ResolvedAt:  resolvedAt,
	}
	s.items = append(s.items, it)
	if err := s.save(); err != nil {
		t.Fatalf("seedTerminalItem save: %v", err)
	}
	return it
}

// seedTerminalBatch writes n terminal items of one state in ONE atomic save,
// each with auto-incrementing Order and ResolvedAt taken from resolvedAts.
// IDs are <prefix>-<index>. Faster than per-item seeding for cap/volume
// tests (one save vs n saves).
func seedTerminalBatch(t *testing.T, s *sessionQueueStore, state QueueItemState, resolvedAts []int64, idPrefix string) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		t.Fatalf("seedTerminalBatch load: %v", err)
	}
	now := time.Now().UnixMilli()
	for i, ra := range resolvedAts {
		s.order++
		s.items = append(s.items, QueueItem{
			ID:          idPrefix + "-" + strconv.Itoa(i),
			Order:       s.order,
			State:       state,
			Text:        "msg",
			Attachments: []QueueAttachment{},
			CreatedAt:   now,
			ResolvedAt:  ra,
		})
	}
	if err := s.save(); err != nil {
		t.Fatalf("seedTerminalBatch save: %v", err)
	}
}

// runCompactionForTest runs compactTerminalItemsLocked under the store mutex
// with an injected now, so tests drive the clock precisely without going
// through List() (which stamps time.Now() internally). Returns changed.
func runCompactionForTest(t *testing.T, s *sessionQueueStore, now time.Time) bool {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		t.Fatalf("runCompactionForTest load: %v", err)
	}
	return s.compactTerminalItemsLocked(now)
}

// itemPresent reports whether the item with the given id is currently in
// s.items. Caller-side locking is handled internally.
func itemPresent(t *testing.T, s *sessionQueueStore, id string) bool {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, it := range s.items {
		if it.ID == id {
			return true
		}
	}
	return false
}

// countState returns the number of items currently in s.items with the given
// state. Caller-side locking is handled internally.
func countState(t *testing.T, s *sessionQueueStore, state QueueItemState) int {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	n := 0
	for _, it := range s.items {
		if it.State == state {
			n++
		}
	}
	return n
}

// 1. TTL boundary: items just under, exactly at, and just over the TTL.
// Strict `>` semantics — age == TTL SURVIVES; age > TTL is purged.
func TestQueueCompactTTLBoundary(t *testing.T) {
	defer SetCompactionTTLsForTest(0, 0, 0) // restore defaults
	SetCompactionTTLsForTest(100*time.Millisecond, 0, 0)
	s, _ := newTestStore(t, "s1")
	now := time.Now()
	const ttlMs = int64(100)
	seedTerminalItem(t, s, "q-under", "under", QueueSent, now.Add(-time.Duration(ttlMs-1)*time.Millisecond).UnixMilli())
	seedTerminalItem(t, s, "q-exact", "exact", QueueSent, now.Add(-time.Duration(ttlMs)*time.Millisecond).UnixMilli())
	seedTerminalItem(t, s, "q-over", "over", QueueSent, now.Add(-time.Duration(ttlMs+1)*time.Millisecond).UnixMilli())
	runCompactionForTest(t, s, now)
	if !itemPresent(t, s, "q-under") {
		t.Error("q-under (age < TTL) should survive")
	}
	if !itemPresent(t, s, "q-exact") {
		t.Error("q-exact (age == TTL, strict >) should survive")
	}
	if itemPresent(t, s, "q-over") {
		t.Error("q-over (age > TTL) should be purged")
	}
}

// 2. Count cap under burst: seed cap+10 fresh sent items (within TTL); after
// compaction exactly cap survive, the oldest 10 (by ResolvedAt) are removed.
func TestQueueCompactCountCapUnderBurst(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	now := time.Now()
	n := sentItemCap + 10
	// ResolvedAt strictly increasing by index: item 0 = newest, item n-1 = oldest.
	ras := make([]int64, n)
	for i := range ras {
		ras[i] = now.Add(-time.Duration(i) * time.Millisecond).UnixMilli()
	}
	seedTerminalBatch(t, s, QueueSent, ras, "q")
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != sentItemCap {
		t.Fatalf("cap: got %d survivors, want %d", len(got), sentItemCap)
	}
	// The 10 OLDEST (i = sentItemCap .. n-1, lowest ResolvedAt) trimmed.
	for i := sentItemCap; i < n; i++ {
		if itemPresent(t, s, "q-"+strconv.Itoa(i)) {
			t.Errorf("oldest q-%d should be trimmed by cap", i)
		}
	}
	// The newest sentItemCap (i = 0 .. sentItemCap-1) survive.
	for i := 0; i < sentItemCap; i++ {
		if !itemPresent(t, s, "q-"+strconv.Itoa(i)) {
			t.Errorf("newer q-%d should survive cap", i)
		}
	}
}

// 3. Combined TTL + cap: expired items removed first (TTL pass), then
// within-TTL items trimmed to cap (count-cap pass). Both rules applied.
func TestQueueCompactCombinedTTLAndCap(t *testing.T) {
	defer SetCompactionTTLsForTest(0, 0, 0)
	SetCompactionTTLsForTest(100*time.Millisecond, 0, 0) // sent TTL = 100ms
	s, _ := newTestStore(t, "s1")
	now := time.Now()
	// 5 expired sent items (age 1h >> TTL) — purged by TTL pass.
	for i := 0; i < 5; i++ {
		seedTerminalItem(t, s, "q-exp-"+strconv.Itoa(i), "exp", QueueSent, now.Add(-time.Hour).UnixMilli())
	}
	// sentItemCap+5 fresh sent items (within TTL), ResolvedAt strictly
	// increasing by index: item 0 = newest, item cap+4 = oldest of this batch.
	n := sentItemCap + 5
	ras := make([]int64, n)
	for i := range ras {
		ras[i] = now.Add(-time.Duration(i) * time.Millisecond).UnixMilli()
	}
	seedTerminalBatch(t, s, QueueSent, ras, "q-fresh")
	runCompactionForTest(t, s, now)
	// All expired should be gone.
	for i := 0; i < 5; i++ {
		if itemPresent(t, s, "q-exp-"+strconv.Itoa(i)) {
			t.Errorf("expired q-exp-%d should be TTL-purged", i)
		}
	}
	// Of the fresh batch, the newest sentItemCap survive; oldest 5 trimmed.
	for i := 0; i < sentItemCap; i++ {
		if !itemPresent(t, s, "q-fresh-"+strconv.Itoa(i)) {
			t.Errorf("fresh q-fresh-%d should survive cap", i)
		}
	}
	for i := sentItemCap; i < n; i++ {
		if itemPresent(t, s, "q-fresh-"+strconv.Itoa(i)) {
			t.Errorf("oldest fresh q-fresh-%d should be cap-trimmed", i)
		}
	}
}

// 4. Deterministic oldest-first: seed cap+1 unknown items with strictly
// increasing ResolvedAt; the single OLDEST is trimmed, the rest survive.
func TestQueueCompactDeterministicOldestFirst(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	now := time.Now()
	n := unknownItemCap + 1
	// ResolvedAt strictly increasing by index: item 0 = OLDEST (now - n ms),
	// item n-1 = newest (now - 1ms). Cap keeps the newest n-1 = cap items.
	ras := make([]int64, n)
	for i := range ras {
		ras[i] = now.Add(-time.Duration(n-i) * time.Millisecond).UnixMilli()
	}
	seedTerminalBatch(t, s, QueueUnknown, ras, "q-u")
	runCompactionForTest(t, s, now)
	// The OLDEST (q-u-0) trimmed; the rest survive.
	if itemPresent(t, s, "q-u-0") {
		t.Error("oldest q-u-0 should be trimmed by cap")
	}
	for i := 1; i < n; i++ {
		if !itemPresent(t, s, "q-u-"+strconv.Itoa(i)) {
			t.Errorf("q-u-%d should survive cap", i)
		}
	}
}

// 5. Status-specific TTLs: seed sent + unknown items at the SAME age (2h).
// sent (1h TTL) is purged; unknown (30d TTL) survives. Demonstrates the
// retention order: unknown > sent.
func TestQueueCompactStatusSpecificLimits(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	twoHoursAgo := time.Now().Add(-2 * time.Hour).UnixMilli()
	seedTerminalItem(t, s, "q-sent", "sent", QueueSent, twoHoursAgo)
	seedTerminalItem(t, s, "q-unk", "unk", QueueUnknown, twoHoursAgo)
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range got {
		switch it.ID {
		case "q-sent":
			t.Errorf("q-sent (2h > 1h TTL) should be purged, survived in result")
		case "q-unk":
			// expected survivor
		}
	}
	if !itemPresent(t, s, "q-unk") {
		t.Error("q-unk (2h < 30d TTL) should survive")
	}
}

// 6. ResolvedAt-not-CreatedAt: a sent item with OLD CreatedAt but RECENT
// ResolvedAt survives TTL (age measured from ResolvedAt).
func TestQueueCompactUsesResolvedAtNotCreatedAt(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	// Item: CreatedAt = 30 days ago, ResolvedAt = 1 second ago.
	// If compaction used CreatedAt, it would be purged (30d > 1h sent TTL).
	// Since it uses ResolvedAt, it survives (1s < 1h sent TTL).
	oldCreated := time.Now().Add(-30 * 24 * time.Hour).UnixMilli()
	s.mu.Lock()
	if err := s.load(); err != nil {
		t.Fatalf("load: %v", err)
	}
	s.order++
	s.items = append(s.items, QueueItem{
		ID:          "q-recent-resolved",
		Order:       s.order,
		State:       QueueSent,
		Text:        "msg",
		Attachments: []QueueAttachment{},
		CreatedAt:   oldCreated,
		ResolvedAt:  time.Now().Add(-1 * time.Second).UnixMilli(),
	})
	if err := s.save(); err != nil {
		t.Fatalf("save: %v", err)
	}
	s.mu.Unlock()
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "q-recent-resolved" {
		t.Fatalf("item with old CreatedAt but recent ResolvedAt should survive; got %+v", got)
	}
}

// 7. Missing ResolvedAt is conservative: survives the TTL pass even when the
// TTL is so short that anything with a valid timestamp would be purged. CAN
// be removed by the count cap (ordered by Order as fallback).
func TestQueueCompactMissingResolvedAtConservative(t *testing.T) {
	defer SetCompactionTTLsForTest(0, 0, 0)
	// 1ns TTL: any item with ResolvedAt > 0 in the past is expired.
	SetCompactionTTLsForTest(1*time.Nanosecond, 1*time.Nanosecond, 1*time.Nanosecond)
	t.Run("survivesTTLPass", func(t *testing.T) {
		s, _ := newTestStore(t, "s1")
		now := time.Now()
		// One failed item WITH a valid (old) ResolvedAt — would be purged.
		seedTerminalItem(t, s, "q-with-ts", "with", QueueFailed, now.Add(-time.Hour).UnixMilli())
		// One failed item with ResolvedAt == 0 — conservative, survives TTL.
		seedTerminalItem(t, s, "q-missing-ts", "missing", QueueFailed, 0)
		runCompactionForTest(t, s, now)
		if itemPresent(t, s, "q-with-ts") {
			t.Error("q-with-ts (valid old timestamp, 1ns TTL) should be purged")
		}
		if !itemPresent(t, s, "q-missing-ts") {
			t.Error("q-missing-ts (ResolvedAt==0) should survive TTL pass (conservative)")
		}
	})
	t.Run("removedByCountCapByOrder", func(t *testing.T) {
		// Seed cap+5 failed items all with ResolvedAt==0. The cap removes the
		// 5 oldest by Order (fallback ordering).
		s, _ := newTestStore(t, "s1")
		now := time.Now()
		n := failedItemCap + 5
		ras := make([]int64, n) // all zero
		seedTerminalBatch(t, s, QueueFailed, ras, "q")
		runCompactionForTest(t, s, now)
		got := countState(t, s, QueueFailed)
		if got != failedItemCap {
			t.Fatalf("cap on missing-ResolvedAt items: got %d, want %d", got, failedItemCap)
		}
		// Items 0..4 (lowest Order) trimmed; items 5..n-1 survive.
		for i := 0; i < 5; i++ {
			if itemPresent(t, s, "q-"+strconv.Itoa(i)) {
				t.Errorf("oldest-by-Order q-%d should be cap-trimmed", i)
			}
		}
		for i := 5; i < n; i++ {
			if !itemPresent(t, s, "q-"+strconv.Itoa(i)) {
				t.Errorf("q-%d should survive cap", i)
			}
		}
	})
}

// 8. pending/dispatching ALWAYS survive compaction, even alongside expired
// terminal items. Compaction never touches non-terminal states.
func TestQueueCompactNeverTouchesPendingOrDispatching(t *testing.T) {
	defer SetCompactionTTLsForTest(0, 0, 0)
	SetCompactionTTLsForTest(1*time.Nanosecond, 1*time.Nanosecond, 1*time.Nanosecond)
	s, _ := newTestStore(t, "s1")
	now := time.Now()
	// Expired terminal items (would all be purged).
	seedTerminalItem(t, s, "q-sent", "s", QueueSent, now.Add(-time.Hour).UnixMilli())
	seedTerminalItem(t, s, "q-failed", "f", QueueFailed, now.Add(-time.Hour).UnixMilli())
	seedTerminalItem(t, s, "q-unknown", "u", QueueUnknown, now.Add(-time.Hour).UnixMilli())
	// Non-terminal items that MUST survive. seedTerminalItem is used with a
	// non-terminal state and ResolvedAt=0 (pending/dispatching never resolve);
	// this direct-seeds an explicit ID so the survival check is unambiguous.
	seedTerminalItem(t, s, "pending-item", "p", QueuePending, 0)
	seedDispatchingItem(t, s, "dispatching-item", "d", now.Add(-time.Hour).UnixMilli())
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	// The 3 expired terminal items are gone; pending + dispatching survive.
	ids := map[string]bool{}
	for _, it := range got {
		ids[it.ID] = true
	}
	if !ids["pending-item"] {
		t.Error("pending-item must survive compaction")
	}
	if !ids["dispatching-item"] {
		t.Error("dispatching-item must survive compaction")
	}
	if ids["q-sent"] || ids["q-failed"] || ids["q-unknown"] {
		t.Errorf("expired terminal items should be purged, got ids=%v", ids)
	}
}

// 9. Unknown survives longest + higher volume. Two phases:
//
//	A) TTL ordering: at age 2h, sent is purged (2h > 1h); failed (2h < 7d) and
//	   unknown (2h < 30d) survive.
//	B) Cap ordering at high volume: seed 250 of each at a recent age; caps
//	   trim to sent=50, failed=100, unknown=200.
func TestQueueCompactUnknownSurvivesLongestAndHighestVolume(t *testing.T) {
	t.Run("TTL_ordering_age_2h", func(t *testing.T) {
		s, _ := newTestStore(t, "s1")
		twoHoursAgo := time.Now().Add(-2 * time.Hour).UnixMilli()
		for i := 0; i < 10; i++ {
			seedTerminalItem(t, s, "q-sent-"+strconv.Itoa(i), "s", QueueSent, twoHoursAgo)
			seedTerminalItem(t, s, "q-failed-"+strconv.Itoa(i), "f", QueueFailed, twoHoursAgo)
			seedTerminalItem(t, s, "q-unk-"+strconv.Itoa(i), "u", QueueUnknown, twoHoursAgo)
		}
		got, err := s.List()
		if err != nil {
			t.Fatal(err)
		}
		if n := countState(t, s, QueueSent); n != 0 {
			t.Errorf("sent (2h > 1h TTL): got %d survivors, want 0", n)
		}
		if n := countState(t, s, QueueFailed); n != 10 {
			t.Errorf("failed (2h < 7d TTL): got %d survivors, want 10", n)
		}
		if n := countState(t, s, QueueUnknown); n != 10 {
			t.Errorf("unknown (2h < 30d TTL): got %d survivors, want 10", n)
		}
		_ = got
	})
	t.Run("cap_ordering_high_volume", func(t *testing.T) {
		s, _ := newTestStore(t, "s1")
		now := time.Now()
		const perStatus = 250
		// Recent age (within all TTLs): only caps apply.
		// ResolvedAt strictly increasing by index within each status.
		ras := make([]int64, perStatus)
		for i := range ras {
			ras[i] = now.Add(-time.Duration(i) * time.Millisecond).UnixMilli()
		}
		seedTerminalBatch(t, s, QueueSent, ras, "q-s")
		seedTerminalBatch(t, s, QueueFailed, ras, "q-f")
		seedTerminalBatch(t, s, QueueUnknown, ras, "q-u")
		if _, err := s.List(); err != nil {
			t.Fatal(err)
		}
		if n := countState(t, s, QueueSent); n != sentItemCap {
			t.Errorf("sent cap: got %d, want %d", n, sentItemCap)
		}
		if n := countState(t, s, QueueFailed); n != failedItemCap {
			t.Errorf("failed cap: got %d, want %d", n, failedItemCap)
		}
		if n := countState(t, s, QueueUnknown); n != unknownItemCap {
			t.Errorf("unknown cap: got %d, want %d", n, unknownItemCap)
		}
	})
}

// 10. Atomic persistence + rollback: when save() fails after compaction, ALL
// compaction mutations are rolled back (items restored in memory). The store
// stays consistent with disk.
func TestQueueCompactRollsBackOnSaveFailure(t *testing.T) {
	defer SetCompactionTTLsForTest(0, 0, 0)
	SetCompactionTTLsForTest(1*time.Nanosecond, 1*time.Nanosecond, 1*time.Nanosecond)
	s, _ := newTestStore(t, "s1")
	now := time.Now()
	// Seed 3 terminal items that compaction WILL purge (1ns TTL).
	seedTerminalItem(t, s, "q-a", "a", QueueSent, now.Add(-time.Hour).UnixMilli())
	seedTerminalItem(t, s, "q-b", "b", QueueFailed, now.Add(-time.Hour).UnixMilli())
	seedTerminalItem(t, s, "q-c", "c", QueueUnknown, now.Add(-time.Hour).UnixMilli())

	// Block save() by replacing the queue path's parent dir with a file so
	// writeQueueAtomic's MkdirAll fails (same mechanism as the recovery
	// rollback test). Also blocks os.Remove (parent is a file, not a dir) —
	// but since compaction empties the queue and persistAfterCompaction tries
	// os.Remove(s.path), the remove also fails (ENOENT-component on the
	// parent), surfacing an error that triggers rollback.
	parent := filepath.Dir(s.path)
	if err := os.RemoveAll(parent); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(parent, []byte("blocker"), 0o644); err != nil {
		t.Fatal(err)
	}

	// List() must fail (save/remove error during compaction persistence) and
	// roll back the in-memory compaction so all 3 items are still present.
	if _, err := s.List(); err == nil {
		t.Fatal("List: want save error from blocked parent dir, got nil")
	}

	// Inspect in-memory state directly (List returned an error).
	s.mu.Lock()
	items := make([]QueueItem, len(s.items))
	copy(items, s.items)
	s.mu.Unlock()
	if len(items) != 3 {
		t.Fatalf("rollback: want 3 items in memory, got %d", len(items))
	}
	for _, it := range items {
		if !isTerminalState(it.State) {
			t.Errorf("rollback failed: item %q state = %s, want terminal", it.ID, it.State)
		}
	}
}

// 11. Empty-queue file deletion: when compaction removes ALL items, queue.json
// is deleted from disk (not saved as an empty-items document). A subsequent
// load() treats the missing file as an empty queue (lazy-creation pattern).
func TestQueueCompactEmptyQueueDeletesFile(t *testing.T) {
	defer SetCompactionTTLsForTest(0, 0, 0)
	SetCompactionTTLsForTest(1*time.Nanosecond, 1*time.Nanosecond, 1*time.Nanosecond)
	s, root := newTestStore(t, "s1")
	seedTerminalItem(t, s, "q-a", "a", QueueSent, time.Now().Add(-time.Hour).UnixMilli())
	seedTerminalItem(t, s, "q-b", "b", QueueFailed, time.Now().Add(-time.Hour).UnixMilli())
	// Pre-condition: file exists.
	if _, err := os.Stat(s.path); err != nil {
		t.Fatalf("pre-compaction file stat: %v", err)
	}
	// Trigger compaction via List(). All items are terminal + expired → the
	// queue empties → persistAfterCompaction deletes queue.json.
	if _, err := s.List(); err != nil {
		t.Fatalf("List: %v", err)
	}
	if _, err := os.Stat(s.path); !os.IsNotExist(err) {
		t.Fatalf("post-compaction: want IsNotExist, got %v", err)
	}
	// Fresh store pointing at the same path loads as an empty queue.
	s2 := &sessionQueueStore{path: queuePath(root, "s1")}
	got, err := s2.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("fresh load after empty-queue deletion: got %d items, want 0", len(got))
	}
}

// TestQueueCompactListArchivedGuardNoFreshFileDeletion pins the b-F1 fix from
// commit-review: List() now persists recovery+compaction, so it must carry the
// same s.archived tombstone guard as Enqueue/Remove/Claim/Resolve. Without it,
// a retained pointer to an archived store whose compaction empties its stale
// in-memory items would call os.Remove(s.path) — and since the retained and
// fresh stores hold DIFFERENT mutexes, the removal is not serialized against a
// fresh post-archive store that may have already written a new queue.json at
// the same path. Silent data loss.
//
// Scenario:
//  1. Seed expired terminal items on a store (compaction would empty + remove).
//  2. Retain a pointer, then deleteStore (archive): tombstones the pointer and
//     removes queue.json.
//  3. A FRESH store at the same path enqueues a new item → writes queue.json.
//  4. List() on the retained archived pointer must return errQueueArchived and
//     must NOT delete the fresh store's queue.json.
func TestQueueCompactListArchivedGuardNoFreshFileDeletion(t *testing.T) {
	defer SetCompactionTTLsForTest(0, 0, 0)
	SetCompactionTTLsForTest(1*time.Nanosecond, 1*time.Nanosecond, 1*time.Nanosecond)

	root := t.TempDir()
	qr := newQueueRegistry()
	sid := "s1"

	// 1. Seed expired terminal items. With 1ns TTL, these are all expired and
	//    compaction would empty the queue → trigger persistAfterCompaction's
	//    os.Remove branch. This is the dangerous branch under test.
	st := qr.store(root, sid)
	seedTerminalItem(t, st, "old-sent", "a", QueueSent, time.Now().Add(-time.Hour).UnixMilli())
	seedTerminalItem(t, st, "old-failed", "b", QueueFailed, time.Now().Add(-time.Hour).UnixMilli())
	if _, err := os.Stat(queuePath(root, sid)); err != nil {
		t.Fatalf("seed: queue.json should exist: %v", err)
	}

	// 2. deleteStore tombstones the retained pointer and removes queue.json.
	qr.deleteStore(root, sid)
	if _, err := os.Stat(queuePath(root, sid)); !os.IsNotExist(err) {
		t.Fatalf("post-archive: queue.json should be gone, got err=%v", err)
	}

	// 3. A FRESH store at the same path enqueues a new item → new queue.json.
	fresh := qr.store(root, sid)
	freshIt, err := fresh.Enqueue("after-archive", nil, QueueSendConfig{}, "")
	if err != nil {
		t.Fatalf("fresh post-archive Enqueue: %v", err)
	}
	if _, err := os.Stat(queuePath(root, sid)); err != nil {
		t.Fatalf("fresh queue.json should exist after post-archive Enqueue: %v", err)
	}

	// 4. List() on the retained ARCHIVED pointer must return errQueueArchived
	//    (NOT run compaction persistence, NOT delete the fresh file).
	if _, err := st.List(); !errors.Is(err, errQueueArchived) {
		t.Fatalf("retained List after archive: err=%v, want errQueueArchived (b-F1 guard)", err)
	}

	// 5. The fresh store's queue.json must STILL exist with the fresh item.
	if _, err := os.Stat(queuePath(root, sid)); err != nil {
		t.Fatalf("b-F1 REGRESSION: fresh queue.json deleted by retained-pointer List compaction: %v", err)
	}
	freshReload := &sessionQueueStore{path: queuePath(root, sid)}
	got, err := freshReload.List()
	if err != nil {
		t.Fatalf("reload fresh queue: %v", err)
	}
	if len(got) != 1 || got[0].ID != freshIt.ID {
		t.Fatalf("b-F1 REGRESSION: fresh queue contents lost: got %+v, want 1 item id=%s", got, freshIt.ID)
	}
}
