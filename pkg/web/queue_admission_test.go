package web

// Send-reliability slice 1 — idempotent queue admission + replay-safe resolve.
//
// These cases pin the two backend guarantees the accepted plan (derived from
// tmp/agent-runs/send-reliability-brief/brief.md §4.1/§4.2) requires:
//
//   - Admission is durably idempotent per (session, client attempt id,
//     canonical payload): concurrent identical requests create exactly ONE
//     item and every caller receives the SAME original receipt; a changed
//     payload under the same attempt id conflicts; the receipt+item pair is
//     written atomically (rollback on save failure); receipts are independent
//     of the item list (replay works after removal AND compaction, without
//     resurrection); the receipt log is bounded and never evicts valid
//     records; receipt lifetime ends with cleanup — the cleanup/admission
//     race must never resurrect or ghost.
//   - Resolve is monotonic: pending → terminal rejected; dispatching → any
//     terminal allowed; identical terminal re-resolve is a timestamp-
//     preserving no-op; unknown → sent allowed (manual + reconciler
//     recovery); every other terminal rewrite — notably sent → failed/unknown
//     — is a surfaced conflict.

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

// itemsEqual is deep equality for QueueItem (Attachments is a slice, so ==
// does not compile). Used to assert receipt identity: a replay must return
// the original admission snapshot VERBATIM.
func itemsEqual(a, b QueueItem) bool { return reflect.DeepEqual(a, b) }

// mustEnqueueAttempt admits an item with a client attempt id and fails the
// test unless it is a FRESH admission (replayed==false).
func mustEnqueueAttempt(t *testing.T, s *sessionQueueStore, attemptID, text string) QueueItem {
	t.Helper()
	it, replayed, err := s.EnqueueWithAttemptID(attemptID, text, nil, QueueSendConfig{}, "")
	if err != nil {
		t.Fatalf("EnqueueWithAttemptID(%q): %v", attemptID, err)
	}
	if replayed {
		t.Fatalf("EnqueueWithAttemptID(%q): fresh attempt id must not report replayed", attemptID)
	}
	return it
}

// 1. Basic idempotent replay: same (attempt id, payload) → the ORIGINAL
// receipt (same id/order/createdAt), replayed=true, exactly one item. The
// receipt survives a full store reload (fresh store = what a vh-solara
// restart serves).
func TestQueueAdmissionReplayReturnsOriginalReceipt(t *testing.T) {
	s, root := newTestStore(t, "s1")
	first := mustEnqueueAttempt(t, s, "att-1", "hello")

	second, replayed, err := s.EnqueueWithAttemptID("att-1", "hello", nil, QueueSendConfig{}, "")
	if err != nil {
		t.Fatalf("replay: %v", err)
	}
	if !replayed {
		t.Fatal("replay: replayed=false, want true")
	}
	if !itemsEqual(second, first) {
		t.Fatalf("replay receipt mismatch:\n first=%+v\nsecond=%+v", first, second)
	}
	items, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("replay created a second item: %d items", len(items))
	}

	// Restart-equivalent: a fresh store at the same path replays the same
	// receipt from the persisted receipt log.
	fresh := &sessionQueueStore{path: queuePath(root, "s1")}
	third, replayed, err := fresh.EnqueueWithAttemptID("att-1", "hello", nil, QueueSendConfig{}, "")
	if err != nil {
		t.Fatalf("replay after reload: %v", err)
	}
	if !replayed || !itemsEqual(third, first) {
		t.Fatalf("replay after reload: replayed=%v item=%+v, want the original receipt", replayed, third)
	}
}

// 2. THE CRUX — concurrent identical admission: N callers race the SAME
// (attempt id, payload). Exactly one item must exist; every caller must get
// the SAME receipt; exactly one caller sees replayed=false (the creator) and
// the rest see replayed=true.
func TestQueueAdmissionConcurrentIdenticalSingleItem(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	const n = 16
	items := make([]QueueItem, n)
	replayed := make([]bool, n)
	errs := make([]error, n)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			<-start
			items[i], replayed[i], errs[i] = s.EnqueueWithAttemptID("att-race", "concurrent payload", nil, QueueSendConfig{}, "client-A")
		}(i)
	}
	close(start)
	wg.Wait()

	creators := 0
	for i := 0; i < n; i++ {
		if errs[i] != nil {
			t.Fatalf("caller %d: %v", i, errs[i])
		}
		if !itemsEqual(items[i], items[0]) {
			t.Fatalf("caller %d got a different receipt:\n got=%+v\nwant=%+v", i, items[i], items[0])
		}
		if !replayed[i] {
			creators++
		}
	}
	if creators != 1 {
		t.Fatalf("creators = %d, want exactly 1 (all others must be replays)", creators)
	}
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("List: %d items, want exactly 1", len(got))
	}
	if !itemsEqual(got[0], items[0]) {
		t.Fatalf("stored item %+v differs from the returned receipt %+v", got[0], items[0])
	}
}

// 3. Payload fingerprint conflicts: same attempt id + changed text, changed
// attachments, or changed sendConfig → errQueueAdmissionConflict, no second
// item, and the ORIGINAL receipt remains replayable with the original payload.
// originClientID is NOT part of the fingerprint (diagnostics-only) — the same
// attempt observed from a different browser is a replay, not a conflict.
func TestQueueAdmissionFingerprintConflict(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	first := mustEnqueueAttempt(t, s, "att-1", "hello")
	cfg := QueueSendConfig{ProviderID: "p", ModelID: "m"}

	// originClientID difference → still a replay.
	_, replayed, err := s.EnqueueWithAttemptID("att-1", "hello", nil, QueueSendConfig{}, "other-browser")
	if err != nil || !replayed {
		t.Fatalf("originClientId must not affect the fingerprint: replayed=%v err=%v", replayed, err)
	}
	// nil vs [] attachments → identical canonical payload → replay.
	_, replayed, err = s.EnqueueWithAttemptID("att-1", "hello", []QueueAttachment{}, QueueSendConfig{}, "")
	if err != nil || !replayed {
		t.Fatalf("nil vs empty attachments must fingerprint identically: replayed=%v err=%v", replayed, err)
	}

	for name, tc := range map[string]struct {
		text        string
		attachments []QueueAttachment
		cfg         QueueSendConfig
	}{
		"changed text":        {"hello world", nil, QueueSendConfig{}},
		"changed attachments": {"hello", []QueueAttachment{{URL: "file:///a", Filename: "a"}}, QueueSendConfig{}},
		"changed sendConfig":  {"hello", nil, cfg},
	} {
		_, _, err := s.EnqueueWithAttemptID("att-1", tc.text, tc.attachments, tc.cfg, "")
		if !errors.Is(err, errQueueAdmissionConflict) {
			t.Fatalf("%s: err=%v, want errQueueAdmissionConflict", name, err)
		}
	}
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 {
		t.Fatalf("conflicts must not create items: %d items", len(got))
	}
	// The original receipt is untouched by the conflicts.
	r, replayed, err := s.EnqueueWithAttemptID("att-1", "hello", nil, QueueSendConfig{}, "")
	if err != nil || !replayed || !itemsEqual(r, first) {
		t.Fatalf("original receipt damaged by conflicts: replayed=%v err=%v", replayed, err)
	}
	// A DIFFERENT attempt id admits the changed payload fine (conflict is
	// scoped to the attempt id, not the payload).
	if _, _, err := s.EnqueueWithAttemptID("att-2", "hello world", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatalf("different attempt id with changed payload: %v", err)
	}
}

// 4. Replay after item REMOVAL: the original receipt comes back, the item is
// NOT resurrected.
func TestQueueAdmissionReplayAfterRemoval(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	first := mustEnqueueAttempt(t, s, "att-1", "bye")
	if err := s.Remove(first.ID); err != nil {
		t.Fatalf("remove: %v", err)
	}
	r, replayed, err := s.EnqueueWithAttemptID("att-1", "bye", nil, QueueSendConfig{}, "")
	if err != nil || !replayed {
		t.Fatalf("replay after removal: replayed=%v err=%v", replayed, err)
	}
	if !itemsEqual(r, first) {
		t.Fatalf("replay after removal: got %+v, want the original receipt", r)
	}
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("replay resurrected the removed item: %d items", len(got))
	}
}

// 5. Atomicity under persistence failure: a blocked save rolls back BOTH the
// item AND the receipt — no ghost receipt may answer a later retry with
// "replayed" custody of an item that never reached disk.
func TestQueueAdmissionSaveFailureAtomicRollback(t *testing.T) {
	root := t.TempDir()
	qr := newQueueRegistry()
	st := qr.store(root, "s1")
	mustEnqueue(t, st, "pre-existing") // order=1, file exists

	// Block save(): replace the queue path's parent dir with a file so
	// writeQueueAtomic's MkdirAll fails (same mechanism as the existing
	// rollback tests).
	parent := filepath.Dir(st.path)
	if err := os.RemoveAll(parent); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(parent, []byte("blocker"), 0o644); err != nil {
		t.Fatal(err)
	}

	if _, _, err := st.EnqueueWithAttemptID("att-1", "ghost check", nil, QueueSendConfig{}, ""); err == nil {
		t.Fatal("enqueue: want save error from blocked parent dir, got nil")
	}

	// Unblock and verify the pair rolled back: a retry of the SAME attempt
	// must be a FRESH admission (replayed=false) — a ghost receipt would
	// return replayed=true with the snapshot of an item that never persisted.
	if err := os.Remove(parent); err != nil {
		t.Fatal(err)
	}
	it, replayed, err := st.EnqueueWithAttemptID("att-1", "ghost check", nil, QueueSendConfig{}, "")
	if err != nil {
		t.Fatalf("retry after save failure: %v", err)
	}
	if replayed {
		t.Fatal("GHOST RECEIPT: retry after a rolled-back save reported replayed=true")
	}
	got, err := st.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("want pre-existing + retried item (2), got %d", len(got))
	}
	if got[1].ID != it.ID {
		t.Fatalf("retried item not present: %+v vs %+v", got, it)
	}
	// The durable pair now exists: a subsequent replay is consistent.
	_, replayed, err = st.EnqueueWithAttemptID("att-1", "ghost check", nil, QueueSendConfig{}, "")
	if err != nil || !replayed {
		t.Fatalf("post-retry replay: replayed=%v err=%v", replayed, err)
	}
}

// 6. Capacity bound: at capacity a NEW attempt-carrying admission is rejected
// BEFORE any effect; valid receipts are never evicted (replays still work,
// the receipt log is unchanged); legacy no-attempt-id enqueues are unaffected.
func TestQueueAdmissionCapacityRejectsNewNeverEvicts(t *testing.T) {
	defer SetAdmissionReceiptCapForTest(0) // restore default
	SetAdmissionReceiptCapForTest(3)
	s, _ := newTestStore(t, "s1")

	mustEnqueueAttempt(t, s, "att-1", "one")
	mustEnqueueAttempt(t, s, "att-2", "two")
	third := mustEnqueueAttempt(t, s, "att-3", "three")

	_, _, err := s.EnqueueWithAttemptID("att-4", "four", nil, QueueSendConfig{}, "")
	if !errors.Is(err, errQueueAdmissionFull) {
		t.Fatalf("admission at capacity: err=%v, want errQueueAdmissionFull", err)
	}
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("rejected admission must have no effect: %d items", len(got))
	}
	// Replays at capacity still work — that is the point of never evicting.
	r, replayed, err := s.EnqueueWithAttemptID("att-1", "one", nil, QueueSendConfig{}, "")
	if err != nil || !replayed {
		t.Fatalf("replay at capacity: replayed=%v err=%v", replayed, err)
	}
	if r.Order != 1 {
		t.Fatalf("replay at capacity: order=%d, want original order 1", r.Order)
	}
	// No eviction: the receipt log still answers att-3 (the most recent).
	_, replayed, err = s.EnqueueWithAttemptID("att-3", "three", nil, QueueSendConfig{}, "")
	if err != nil || !replayed || third.Order != 3 {
		t.Fatalf("most-recent receipt evicted: replayed=%v err=%v", replayed, err)
	}
	// Legacy admissions consume no receipt capacity.
	if _, err := s.Enqueue("legacy", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatalf("legacy enqueue at receipt capacity: %v", err)
	}
	s.mu.Lock()
	if len(s.receipts) != 3 {
		t.Fatalf("receipt count changed: %d, want 3 (never evicted, never exceeded)", len(s.receipts))
	}
	s.mu.Unlock()
}

// 7. Legacy behavior is UNCHANGED: no attempt id → no receipt, no dedupe, no
// capacity accounting; the persisted file keeps its legacy shape (no
// admissionReceipts key) while only legacy admissions exist.
func TestQueueAdmissionLegacyNoAttemptIDUnchanged(t *testing.T) {
	s, root := newTestStore(t, "s1")
	a := mustEnqueue(t, s, "same text")
	b := mustEnqueue(t, s, "same text")
	if a.ID == b.ID {
		t.Fatal("legacy enqueue must stay non-idempotent (distinct ids)")
	}
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 {
		t.Fatalf("legacy: %d items, want 2", len(got))
	}
	if got[0].AttemptID != "" || got[1].AttemptID != "" {
		t.Fatalf("legacy items must not carry an attemptId: %+v", got[0])
	}
	// On-disk shape: legacy-only admissions persist no receipt log.
	data, err := os.ReadFile(queuePath(root, "s1"))
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(data, &raw); err != nil {
		t.Fatal(err)
	}
	if _, ok := raw["admissionReceipts"]; ok {
		t.Fatal("legacy-only queue.json must not carry an admissionReceipts key")
	}
	// The attempt-carrying receipt is ALSO visible on the item wire shape.
	it := mustEnqueueAttempt(t, s, "att-x", "tagged")
	if it.AttemptID != "att-x" {
		t.Fatalf("item.AttemptID = %q, want att-x echoed", it.AttemptID)
	}
}

// 8. Oversized attempt id → errQueueBadAttemptID (400 at the HTTP layer),
// no item, no receipt.
func TestQueueAdmissionRejectsOversizedAttemptID(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	big := strings.Repeat("x", attemptIDMaxLength+1)
	if _, _, err := s.EnqueueWithAttemptID(big, "t", nil, QueueSendConfig{}, ""); !errors.Is(err, errQueueBadAttemptID) {
		t.Fatalf("oversized attempt id: err=%v, want errQueueBadAttemptID", err)
	}
	got, err := s.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("rejected attempt id must have no effect: %d items", len(got))
	}
	// Exactly at the limit is accepted.
	if _, _, err := s.EnqueueWithAttemptID(strings.Repeat("y", attemptIDMaxLength), "t", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatalf("max-length attempt id should be accepted: %v", err)
	}
}

// 9. THE RISKIEST INVARIANT — cleanup/admission race. CleanupSession races an
// admission that follows the exact handler pattern (store() lookup, then
// mutate). Whatever the interleaving, the final observable state must be
// consistent: no pre-cleanup item or receipt ever resurfaces through a fresh
// store (BLK-1 extended to the receipt log), the racing admission either
// succeeds linearizably or is refused with errQueueArchived, and never
// reports a ghost replay.
func TestQueueAdmissionCleanupRaceConsistency(t *testing.T) {
	const iterations = 100
	for iter := 0; iter < iterations; iter++ {
		root := t.TempDir()
		qr := newQueueRegistry()
		sid := "s1"
		seed := mustEnqueueAttempt(t, qr.store(root, sid), "att-seed", "seed payload")

		start := make(chan struct{})
		var wg sync.WaitGroup
		var enqItem QueueItem
		var enqReplayed bool
		var enqErr error
		wg.Add(2)
		go func() {
			defer wg.Done()
			<-start
			qr.CleanupSession(root, sid)
		}()
		go func() {
			defer wg.Done()
			<-start
			st := qr.store(root, sid) // handler pattern: resolve store, then mutate
			enqItem, enqReplayed, enqErr = st.EnqueueWithAttemptID("att-race", "race payload", nil, QueueSendConfig{}, "c1")
		}()
		close(start)
		wg.Wait()

		// The final state — what the NEXT request would observe via a fresh
		// store() — must never contain the pre-cleanup seed (no resurrection
		// of items OR receipts through the surviving file).
		fresh := qr.store(root, sid)
		items, err := fresh.List()
		if err != nil {
			t.Fatalf("iter %d: fresh List: %v", iter, err)
		}
		for _, it := range items {
			if it.ID == seed.ID {
				t.Fatalf("iter %d: pre-cleanup seed item resurrected after CleanupSession", iter)
			}
		}

		// The racing admission's outcome must be one of the two legal
		// linearizations…
		if enqErr != nil {
			if !errors.Is(enqErr, errQueueArchived) {
				t.Fatalf("iter %d: racing admission err=%v, want nil or errQueueArchived", iter, enqErr)
			}
		} else if enqReplayed {
			// …and a first-ever admission can never report a replay.
			t.Fatalf("iter %d: racing admission reported replay with no prior durable admission (ghost receipt)", iter)
		}

		// If the racing admission succeeded and its receipt survived cleanup
		// losing the race, a replay must return the SAME item id — a receipt
		// pointing at a different item would be corruption. (If cleanup won
		// and deleted the file, the replay below is a legal fresh admission.)
		if enqErr == nil {
			it2, replayed, err := fresh.EnqueueWithAttemptID("att-race", "race payload", nil, QueueSendConfig{}, "c1")
			if err != nil {
				t.Fatalf("iter %d: post-race replay: %v", iter, err)
			}
			if replayed && it2.ID != enqItem.ID {
				t.Fatalf("iter %d: receipt points at %q, admitted item was %q", iter, it2.ID, enqItem.ID)
			}
		}

		// The seed attempt's replay guarantee ENDED with cleanup: a replay of
		// att-seed must never return the pre-cleanup receipt (its item id).
		seed2, replayedSeed, err := fresh.EnqueueWithAttemptID("att-seed", "seed payload", nil, QueueSendConfig{}, "")
		if err != nil {
			t.Fatalf("iter %d: post-cleanup seed replay: %v", iter, err)
		}
		if replayedSeed {
			t.Fatalf("iter %d: pre-cleanup receipt survived CleanupSession (seed id %q returned)", iter, seed2.ID)
		}
	}
}

// 10. Resolve matrix — the full transition table in one place. Terminal
// resolution is monotonic; only dispatching→terminal and unknown→sent move
// forward; identical re-resolve is a timestamp-preserving no-op; everything
// else conflicts; pending is rejected outright.
func TestQueueResolveMatrix(t *testing.T) {
	const setupDetail = "original detail"
	cases := []struct {
		name     string
		from     QueueItemState
		target   QueueItemState
		detail   string // detail of the RESOLVE under test
		wantErr  error  // nil = allowed
		wantNoop bool   // allowed AND must preserve the stored item verbatim
	}{
		{"pending→sent rejected", QueuePending, QueueSent, "", errQueueNotClaimed, false},
		{"pending→failed rejected", QueuePending, QueueFailed, "", errQueueNotClaimed, false},
		{"pending→unknown rejected", QueuePending, QueueUnknown, "", errQueueNotClaimed, false},
		{"dispatching→sent allowed", QueueDispatching, QueueSent, "d1", nil, false},
		{"dispatching→failed allowed", QueueDispatching, QueueFailed, "d2", nil, false},
		{"dispatching→unknown allowed", QueueDispatching, QueueUnknown, "d3", nil, false},
		{"sent→sent identical is a no-op", QueueSent, QueueSent, setupDetail, nil, true},
		{"sent→sent different detail conflicts", QueueSent, QueueSent, "other", errQueueResolveConflict, false},
		{"sent→failed rejected", QueueSent, QueueFailed, "", errQueueResolveConflict, false},
		{"sent→unknown rejected", QueueSent, QueueUnknown, "", errQueueResolveConflict, false},
		{"unknown→sent allowed", QueueUnknown, QueueSent, "recovered", nil, false},
		{"unknown→failed conflicts", QueueUnknown, QueueFailed, "", errQueueResolveConflict, false},
		{"unknown→unknown identical is a no-op", QueueUnknown, QueueUnknown, setupDetail, nil, true},
		{"unknown→unknown different detail conflicts", QueueUnknown, QueueUnknown, "z", errQueueResolveConflict, false},
		{"failed→sent conflicts", QueueFailed, QueueSent, "", errQueueResolveConflict, false},
		{"failed→unknown conflicts", QueueFailed, QueueUnknown, "", errQueueResolveConflict, false},
		{"failed→failed identical is a no-op", QueueFailed, QueueFailed, setupDetail, nil, true},
		{"failed→failed different detail conflicts", QueueFailed, QueueFailed, "z", errQueueResolveConflict, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s, _ := newTestStore(t, "s1")
			it := mustEnqueue(t, s, "m")
			if tc.from != QueuePending {
				claimed, won, err := s.Claim()
				if err != nil || !won || claimed.ID != it.ID {
					t.Fatalf("claim: won=%v err=%v", won, err)
				}
			}
			var before QueueItem
			if tc.from != QueueDispatching && tc.from != QueuePending {
				if _, err := s.Resolve(it.ID, tc.from, setupDetail); err != nil {
					t.Fatalf("setup resolve→%s: %v", tc.from, err)
				}
				got, _ := s.List()
				before = got[0]
			}

			got, err := s.Resolve(it.ID, tc.target, tc.detail)
			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("Resolve(%s→%s): err=%v, want %v", tc.from, tc.target, err, tc.wantErr)
				}
				// Rejected resolves must leave the item untouched.
				after, _ := s.List()
				if after[0].State != tc.from {
					t.Fatalf("rejected resolve mutated state: %s → %s", tc.from, after[0].State)
				}
				return
			}
			if err != nil {
				t.Fatalf("Resolve(%s→%s): %v", tc.from, tc.target, err)
			}
			if tc.wantNoop {
				// Identical terminal result: the stored item — timestamps
				// included — comes back verbatim.
				if !itemsEqual(got, before) {
					t.Fatalf("no-op resolve changed the item:\n before=%+v\n after =%+v", before, got)
				}
				if got.ResolvedAt != before.ResolvedAt {
					t.Fatalf("no-op resolve bumped ResolvedAt: %d → %d", before.ResolvedAt, got.ResolvedAt)
				}
				after, _ := s.List()
				if !itemsEqual(after[0], before) {
					t.Fatalf("no-op resolve mutated the stored item:\n before=%+v\n after =%+v", before, after[0])
				}
				return
			}
			// Allowed transition: state moved to the target.
			if got.State != tc.target {
				t.Fatalf("Resolve(%s→%s): state=%s", tc.from, tc.target, got.State)
			}
			if got.Detail != tc.detail {
				t.Fatalf("Resolve(%s→%s): detail=%q, want %q", tc.from, tc.target, got.Detail, tc.detail)
			}
		})
	}
}

// 10b. The no-op must ALSO survive the store boundary (a reload between the
// original resolve and its identical replay) — ResolvedAt durability is the
// anti-timestamp-bump guarantee the client retry loop depends on.
func TestQueueResolveNoopPreservesTimestampsAcrossReload(t *testing.T) {
	s, root := newTestStore(t, "s1")
	it := mustEnqueue(t, s, "m")
	if _, won, err := s.Claim(); err != nil || !won {
		t.Fatalf("claim: won=%v err=%v", won, err)
	}
	first, err := s.Resolve(it.ID, QueueSent, "done")
	if err != nil {
		t.Fatal(err)
	}
	fresh := &sessionQueueStore{path: queuePath(root, "s1")}
	second, err := fresh.Resolve(it.ID, QueueSent, "done")
	if err != nil {
		t.Fatalf("identical resolve after reload: %v", err)
	}
	if second.ResolvedAt != first.ResolvedAt || second.Detail != first.Detail {
		t.Fatalf("identical resolve after reload changed the record:\n first =%+v\n second=%+v", first, second)
	}
}

// 11. Snapshot-size impact of the receipt log (the brief flags this as
// untested): receipts embed the full admission snapshot, so queue.json grows
// linearly with retained attempts. Pin the per-receipt cost at a sane bound
// so the 10,000-receipt cap extrapolates to a bounded file (~1 KiB/receipt →
// ≲10 MiB at cap). If a change pushes the per-receipt cost past this, the cap
// or the encoding needs a revisit BEFORE shipping.
func TestQueueAdmissionReceiptSnapshotSize(t *testing.T) {
	defer SetAdmissionReceiptCapForTest(0)
	const capN = 200
	SetAdmissionReceiptCapForTest(capN)
	s, root := newTestStore(t, "s1")
	text := strings.Repeat("x", 64) // representative short prompt
	for i := 0; i < capN; i++ {
		mustEnqueueAttempt(t, s, fmt.Sprintf("att-%03d", i), text)
	}
	fi, err := os.Stat(queuePath(root, "s1"))
	if err != nil {
		t.Fatal(err)
	}
	perReceipt := fi.Size() / capN
	if perReceipt > 1024 {
		t.Fatalf("receipt snapshot cost %d bytes/receipt × 10,000 cap ≈ %d bytes — exceeds the 1 KiB/receipt budget; revisit the cap or encoding", perReceipt, perReceipt*10000)
	}
	t.Logf("receipt snapshot cost: %d bytes/receipt (%d bytes for %d receipts) → ≈%d bytes at the 10,000 cap", perReceipt, fi.Size(), capN, perReceipt*10000)
}

// --- HTTP layer: response shapes the client must feature-detect (slice 2/3) ---

// 12. HTTP admission round trip: fresh admission responds {item, replayed:
// false}; the replay responds the SAME item with replayed: true and creates
// no second item; the conflict is a 409 with code "queue_admission_conflict".
func TestQueueHTTPAdmissionIdempotency(t *testing.T) {
	web, _ := newQueueTestServer(t)
	sid := "s1"
	enq := func(attemptID, text string) (int, map[string]any) {
		t.Helper()
		body := map[string]any{"text": text}
		if attemptID != "" {
			body["attemptId"] = attemptID
		}
		resp := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue", body)
		defer resp.Body.Close()
		var m map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
			t.Fatalf("decode %d: %v", resp.StatusCode, err)
		}
		return resp.StatusCode, m
	}

	code, first := enq("att-http", "hello")
	if code != 200 {
		t.Fatalf("fresh admission: %d %v", code, first)
	}
	if first["replayed"] != false {
		t.Fatalf("fresh admission replayed=%v, want false", first["replayed"])
	}
	code, second := enq("att-http", "hello")
	if code != 200 {
		t.Fatalf("replay: %d %v", code, second)
	}
	if second["replayed"] != true {
		t.Fatalf("replay replayed=%v, want true", second["replayed"])
	}
	if fmt.Sprint(second["item"]) != fmt.Sprint(first["item"]) {
		t.Fatalf("replay item differs:\n first=%v\nsecond=%v", first["item"], second["item"])
	}

	code, conflict := enq("att-http", "CHANGED")
	if code != http.StatusConflict {
		t.Fatalf("conflict: %d %v, want 409", code, conflict)
	}
	if conflict["code"] != "queue_admission_conflict" {
		t.Fatalf("conflict body: %v, want code queue_admission_conflict", conflict)
	}

	// Exactly one item on the wire.
	resp, err := http.Get(web.URL + "/vh/session/" + sid + "/queue")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var list struct {
		Items []QueueItem `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 1 {
		t.Fatalf("list: %d items, want 1", len(list.Items))
	}
	if list.Items[0].AttemptID != "att-http" {
		t.Fatalf("item attemptId = %q, want att-http", list.Items[0].AttemptID)
	}

	// Legacy body (no attemptId) still works and reports replayed:false.
	code, legacy := enq("", "legacy")
	if code != 200 || legacy["replayed"] != false {
		t.Fatalf("legacy enqueue: %d replayed=%v", code, legacy["replayed"])
	}
}

// 13. HTTP resolve conflict shape: sent → failed is a 409 carrying code
// "queue_resolve_conflict"; an identical re-resolve is a 200 no-op.
func TestQueueHTTPResolveGuardShapes(t *testing.T) {
	web, _ := newQueueTestServer(t)
	sid := "s1"
	// Enqueue + claim via HTTP.
	resp := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue", map[string]any{"text": "m", "attemptId": "att-r"})
	defer resp.Body.Close()
	var enq struct {
		Item QueueItem `json:"item"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&enq); err != nil {
		t.Fatal(err)
	}
	cr := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue/claim", map[string]any{})
	defer cr.Body.Close()
	var claim struct {
		Item QueueItem `json:"item"`
	}
	if err := json.NewDecoder(cr.Body).Decode(&claim); err != nil {
		t.Fatal(err)
	}
	resolve := func(state, detail string) (int, map[string]any) {
		t.Helper()
		resp := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue/"+claim.Item.ID+"/resolve", map[string]any{"state": state, "detail": detail})
		defer resp.Body.Close()
		var m map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
			t.Fatalf("decode %d: %v", resp.StatusCode, err)
		}
		return resp.StatusCode, m
	}

	if code, body := resolve("sent", "ok"); code != 200 {
		t.Fatalf("resolve sent: %d %v", code, body)
	}
	if code, body := resolve("failed", "late failure"); code != http.StatusConflict || body["code"] != "queue_resolve_conflict" {
		t.Fatalf("sent→failed: %d %v, want 409 queue_resolve_conflict", code, body)
	}
	if code, body := resolve("unknown", ""); code != http.StatusConflict || body["code"] != "queue_resolve_conflict" {
		t.Fatalf("sent→unknown: %d %v, want 409 queue_resolve_conflict", code, body)
	}
	if code, body := resolve("sent", "ok"); code != 200 {
		t.Fatalf("identical re-resolve: %d %v, want 200 no-op", code, body)
	}

	// The stored record still says sent with the ORIGINAL detail.
	lr, err := http.Get(web.URL + "/vh/session/" + sid + "/queue")
	if err != nil {
		t.Fatal(err)
	}
	defer lr.Body.Close()
	var list struct {
		Items []QueueItem `json:"items"`
	}
	if err := json.NewDecoder(lr.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 1 || list.Items[0].State != QueueSent || list.Items[0].Detail != "ok" {
		t.Fatalf("stored record after guarded resolves: %+v", list.Items)
	}
}

// 14. HTTP 429 capacity shape (slice-1 review B1): with the receipt cap
// lowered, filling it via POST /queue rejects NEW attemptIds with 429 +
// code "queue_admission_full", while a REPLAY of an already-receipted
// attemptId still succeeds (capacity bounds fresh admissions, never dedupe).
// The client-facing contract this pins: 429 is a DEFINITIVE rejection — the
// FE surfaces an explicit state (queue_admission_full) and never retries
// forever.
func TestQueueHTTPAdmissionCapacity429ReplayStillOK(t *testing.T) {
	SetAdmissionReceiptCapForTest(2)
	defer SetAdmissionReceiptCapForTest(0) // restore default
	web, _ := newQueueTestServer(t)
	sid := "s1"
	enq := func(attemptID, text string) (int, map[string]any) {
		t.Helper()
		resp := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue", map[string]any{"text": text, "attemptId": attemptID})
		defer resp.Body.Close()
		var m map[string]any
		if err := json.NewDecoder(resp.Body).Decode(&m); err != nil {
			t.Fatalf("decode %d: %v", resp.StatusCode, err)
		}
		return resp.StatusCode, m
	}

	if code, body := enq("att-a", "a"); code != 200 {
		t.Fatalf("first admission: %d %v", code, body)
	}
	if code, body := enq("att-b", "b"); code != 200 {
		t.Fatalf("second admission: %d %v", code, body)
	}
	// Cap (2) reached: a NEW attemptId is a definitive 429.
	code, full := enq("att-c", "c")
	if code != http.StatusTooManyRequests {
		t.Fatalf("capacity rejection: %d %v, want 429", code, full)
	}
	if full["code"] != "queue_admission_full" {
		t.Fatalf("capacity body: %v, want code queue_admission_full", full)
	}
	// A REPLAY of an already-receipted attempt still succeeds at capacity —
	// dedupe must never be capacity-gated (a retry after a lost response is
	// the exact recovery path 429 must not break).
	code, replay := enq("att-a", "a")
	if code != 200 || replay["replayed"] != true {
		t.Fatalf("replay at capacity: %d replayed=%v, want 200 replayed=true", code, replay["replayed"])
	}

	// Exactly the two admitted items exist on the wire — the rejected third
	// admission created nothing.
	lr, err := http.Get(web.URL + "/vh/session/" + sid + "/queue")
	if err != nil {
		t.Fatal(err)
	}
	defer lr.Body.Close()
	var list struct {
		Items []QueueItem `json:"items"`
	}
	if err := json.NewDecoder(lr.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 2 {
		t.Fatalf("list after 429: %d items, want 2", len(list.Items))
	}
}

// 15. HTTP replay-after-removal (slice-1 review A2; queue_http.go
// path_touched): after the client's item is REMOVED (operator dismiss /
// retract-to-compose), a replay of the same attemptId returns the ORIGINAL
// receipt (200, replayed:true) and does NOT resurrect the deleted item — the
// list stays empty. This is the HTTP-level twin of the store-level
// TestQueueAdmissionReplayAfterRemoval (line ~199): the receipt's answer is
// honest custody history ("your attempt WAS admitted"), while queue
// membership remains deletion-authoritative.
func TestQueueHTTPReplayAfterRemoval(t *testing.T) {
	web, _ := newQueueTestServer(t)
	sid := "s1"
	resp := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue", map[string]any{"text": "m", "attemptId": "att-del"})
	defer resp.Body.Close()
	var enq struct {
		Item     QueueItem `json:"item"`
		Replayed bool      `json:"replayed"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&enq); err != nil {
		t.Fatal(err)
	}
	if enq.Item.ID == "" {
		t.Fatalf("enqueue returned no item id: %+v", enq)
	}

	// Remove the item over HTTP (pending/terminal removal path).
	dr, err := http.NewRequest(http.MethodDelete, web.URL+"/vh/session/"+sid+"/queue/"+enq.Item.ID, nil)
	if err != nil {
		t.Fatal(err)
	}
	dr.Header.Set(csrfHeader, "1")
	dres, err := http.DefaultClient.Do(dr)
	if err != nil {
		t.Fatal(err)
	}
	dres.Body.Close()
	if dres.StatusCode != 200 {
		t.Fatalf("delete: %d, want 200", dres.StatusCode)
	}

	// Replay the SAME attemptId: the ORIGINAL receipt comes back (replayed:
	// true, same item id) — the receipt is custody history, not resurrection.
	rp := csrfPost(t, web.URL+"/vh/session/"+sid+"/queue", map[string]any{"text": "m", "attemptId": "att-del"})
	defer rp.Body.Close()
	var replay struct {
		Item     QueueItem `json:"item"`
		Replayed bool      `json:"replayed"`
	}
	if err := json.NewDecoder(rp.Body).Decode(&replay); err != nil {
		t.Fatal(err)
	}
	if rp.StatusCode != 200 || !replay.Replayed {
		t.Fatalf("replay after removal: %d replayed=%v, want 200 replayed=true (original receipt)", rp.StatusCode, replay.Replayed)
	}
	if replay.Item.ID != enq.Item.ID {
		t.Fatalf("replay after removal echoed item id %q, want the original %q", replay.Item.ID, enq.Item.ID)
	}

	// The removed item is NOT resurrected: the queue stays empty.
	lr, err := http.Get(web.URL + "/vh/session/" + sid + "/queue")
	if err != nil {
		t.Fatal(err)
	}
	defer lr.Body.Close()
	var list struct {
		Items []QueueItem `json:"items"`
	}
	if err := json.NewDecoder(lr.Body).Decode(&list); err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 0 {
		t.Fatalf("replay resurrected the removed item: %d items: %+v", len(list.Items), list.Items)
	}
}
