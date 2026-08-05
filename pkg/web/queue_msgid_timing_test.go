package web

// Ordering/timing tests for the OpenCode message-id mint, after the mint moved
// from Enqueue to Claim. These pin the defect that motivated the move:
//
// OpenCode orders messages by STRING id (message-v2.ts latest() re-derives the
// newest message per role via string `>` on info.id, independent of SQL
// time_created ordering — see refs/opencode/.../session/message-v2.ts:585-601).
// sst/opencode's Identifier.ascending("message") id encodes a wall-clock
// millisecond in its 12-hex prefix, so lexicographic string order matches
// chronological order ONLY when mints track wall-clock. An id minted at Enqueue
// and then left pending can encode a wall-clock EARLIER than messages that land
// while the item waits; under string ordering the dispatched user message then
// sorts INTO THE PAST of the transcript, is not the newest user message, and the
// assistant-turn trigger never fires (loop break on lastUser.id < lastAssistant.id
// — refs/opencode/.../session/prompt.ts:1111-1130). Minting at Claim makes the id
// track the actual dispatch wall-clock as closely as possible.
//
// These tests use string comparison (`>`, `<`) on the full id — that is the
// ordering OpenCode actually applies. The 12-hex prefix carries the ordering; to
// make same-millisecond mints (which would share a prefix and differ only in the
// random tail) deterministic, the helpers below advance the wall-clock millisecond
// between mints.

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// advanceWallMillis sleeps until time.Now().UnixMilli() strictly exceeds `since`
// (captured BEFORE a mint). MintMessageID encodes time.Now().UnixMilli() (wall,
// not monotonic) into the id's 12-hex prefix; two mints in the SAME millisecond
// share that prefix and differ only in the 14-char random tail — so their string
// order is non-deterministic. Looping until the wall ms actually advances
// guarantees a strictly-later prefix, making the ordering assertions below
// deterministic rather than flaky.
func advanceWallMillis(since int64) int64 {
	for {
		now := time.Now().UnixMilli()
		if now > since {
			return now
		}
		time.Sleep(time.Millisecond)
	}
}

// TestQueueClaimMintsIDAfterInterveningMessage is THE CRUX of the fix. It models
// the incident: a queued user message sits pending while another message (the
// prior assistant turn) lands in the transcript, and the queued message is only
// dispatched later. Under the OLD enqueue-time mint the item's id encoded the
// enqueue wall-clock, so it sorted BEFORE the intervening message and the
// assistant turn never fired. Under the fix the id is minted at Claim (dispatch
// time), so it sorts AFTER the intervening message and is correctly the newest
// user message.
//
// Load-bearing assertion: the claimed item's OpencodeMsgID must sort AFTER the
// intervening id by STRING comparison. This FAILS against unfixed code (enqueue
// mint encodes an earlier wall-clock than the intervening mint) and PASSES after.
func TestQueueClaimMintsIDAfterInterveningMessage(t *testing.T) {
	s, _ := newTestStore(t, "s1")

	// 1. Enqueue a queued user message, capturing the enqueue wall-clock so we
	//    can advance past it deterministically. (The pending-emptiness contract
	//    — empty id until Claim — is pinned by TestQueueClaimMintsOpencodeMsgID
	//    and TestQueuePendingItemSkippedByReconciler; THIS test focuses purely
	//    on the load-bearing ORDERING property, so it does not assert on the
	//    pending id's emptiness and lets the ordering check be what fails under
	//    unfixed code.)
	mustEnqueue(t, s, "queued user msg")
	enqMs := time.Now().UnixMilli()

	// 2. Simulate an intervening message landing WHILE the item sits pending.
	//    In the incident this was the prior assistant turn (msg_fd111dac6 at
	//    08:37:16) that completed 30s before the queued user message was
	//    dispatched. Mint its id strictly AFTER the enqueue wall-clock so its
	//    time-prefix is strictly later (stands in for that assistant message).
	interveningMs := advanceWallMillis(enqMs)
	intervening := opencode.MintMessageID()

	// 3. Claim dispatches the item. Under the fix the id is minted HERE
	//    (strictly after the intervening message); under unfixed code the id
	//    was minted at enqueue (strictly BEFORE the intervening message).
	//    Advance past the intervening wall-clock so a fixed-code claim mint is
	//    deterministically later.
	advanceWallMillis(interveningMs)
	claimed, won, err := s.Claim()
	if err != nil || !won {
		t.Fatalf("Claim: won=%v err=%v", won, err)
	}
	if claimed.OpencodeMsgID == "" {
		t.Fatal("claimed item must have a minted OpencodeMsgID")
	}

	// 4. THE LOAD-BEARING ASSERTION — OpenCode's string-id ordering. The
	//    dispatched user message must sort AFTER the intervening message, or it
	//    is not the newest user message and the turn trigger does not fire
	//    (loop break on lastUser.id < lastAssistant.id). Under unfixed code
	//    (enqueue mint) the claimed id is the enqueue-time id, which encodes a
	//    wall-clock BEFORE the intervening mint, so this is FALSE → the defect.
	if !(claimed.OpencodeMsgID > intervening) {
		t.Fatalf("claimed id %q must sort AFTER intervening id %q (string compare) — "+
			"under OpenCode's string-id ordering an earlier id sorts the dispatched "+
			"user message into the past and the turn trigger never fires",
			claimed.OpencodeMsgID, intervening)
	}
}

// TestQueuePendingItemSkippedByReconciler pins the reconciler contract after the
// mint moved to Claim: a PENDING item has an EMPTY OpencodeMsgID (the id is only
// meaningful once dispatched) and is NOT a reconcile candidate, while a
// claimed/dispatched item carries a minted id. This preserves the reconciler's
// fail-closed guarantee (empty id → no exact-match lookup → never resend) for
// items that were never dispatched.
func TestQueuePendingItemSkippedByReconciler(t *testing.T) {
	s, _ := newTestStore(t, "s1")
	// Enqueue the soon-to-be-dispatched item FIRST, claim it (Claim returns the
	// oldest pending), THEN enqueue a still-pending item so the store ends with
	// one dispatched + one pending without fighting FIFO ordering.
	dispatched := mustEnqueue(t, s, "will be dispatched")
	claimed, won, err := s.Claim()
	if err != nil || !won {
		t.Fatalf("Claim: won=%v err=%v", won, err)
	}
	if claimed.ID != dispatched.ID {
		t.Fatalf("Claim returned %q, want %q", claimed.ID, dispatched.ID)
	}
	pending := mustEnqueue(t, s, "not yet dispatched")

	// Pending item: empty id, and NOT a reconcile candidate (the gate excludes
	// pending both by state and by empty id).
	if pending.OpencodeMsgID != "" {
		t.Fatalf("pending item must have empty OpencodeMsgID; got %q", pending.OpencodeMsgID)
	}
	if hasReconcileCandidate([]QueueItem{pending}) {
		t.Fatal("pending item must NOT be a reconcile candidate")
	}

	// Claimed/dispatched item carries a minted id (reconciler correlation).
	if claimed.OpencodeMsgID == "" {
		t.Fatal("claimed/dispatched item must carry a minted OpencodeMsgID")
	}
	// hasReconcileCandidate only fires on unknown/dispatching-stuck, not on a
	// freshly-claimed (dispatching but genuinely in-flight) item — assert the
	// gate still treats in-flight dispatching as not-yet-stuck, while the id is
	// present for when it does get stuck.
	if hasReconcileCandidate([]QueueItem{claimed}) {
		t.Fatal("freshly-claimed dispatching item must NOT be a reconcile candidate (genuinely in-flight)")
	}
	// An unknown-stuck item WITH the id IS a candidate (the reconciler can act).
	unknown := claimed
	unknown.State = QueueUnknown
	if !hasReconcileCandidate([]QueueItem{unknown}) {
		t.Fatal("unknown-stuck item WITH correlation id must be a reconcile candidate")
	}
}

// TestQueueClaimRollbackClearsOpencodeMsgID pins the never-regenerate guarantee
// for the ONLY claim-rollback path: Claim's save-failure rollback. That rollback
// fires STRICTLY BEFORE Claim returns (hence strictly before any dispatch POST
// reaches the network), so re-minting on a later successful Claim is safe — there
// is no duplicate-message hazard because OpenCode never persisted anything under
// the cleared id. The test forces the rollback by making save() fail, then
// unblocks and re-claims: the re-claim mints a FRESH id, and the previously
// (would-be) cleared id is not retained anywhere on disk.
func TestQueueClaimRollbackClearsOpencodeMsgID(t *testing.T) {
	root := t.TempDir()
	qr := newQueueRegistry()
	st := qr.store(root, "s1")
	a := mustEnqueue(t, st, "a")

	// Precondition: one pending item, no id yet.
	if a.OpencodeMsgID != "" {
		t.Fatalf("precondition: pending item must have empty id; got %q", a.OpencodeMsgID)
	}

	// Block save() by replacing the queue path's parent dir with a file so
	// writeQueueAtomic's MkdirAll fails (same mechanism as the Resolve/Remove
	// rollback tests). This forces Claim's save-failure rollback branch.
	parent := filepath.Dir(st.path)
	if err := os.RemoveAll(parent); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(parent, []byte("blocker"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Claim must fail (save error) and roll back to pending with a CLEARED id.
	if _, _, err := st.Claim(); err == nil {
		t.Fatal("Claim: want save error from blocked parent dir, got nil")
	}
	got, _ := st.List()
	if len(got) != 1 || got[0].State != QueuePending {
		t.Fatalf("rollback: want 1 pending item, got %+v", got)
	}
	if got[0].OpencodeMsgID != "" {
		t.Fatalf("rollback must CLEAR OpencodeMsgID (re-mint on later claim is safe ONLY if the cleared id never reached the network); got %q", got[0].OpencodeMsgID)
	}
	if got[0].DispatchStartedAt != 0 {
		t.Fatalf("rollback must reset DispatchStartedAt; got %d", got[0].DispatchStartedAt)
	}

	// Unblock the dir and re-claim: it must succeed and mint a FRESH id,
	// proving the cleared id was not retained and a re-mint is clean.
	if err := os.Remove(parent); err != nil {
		t.Fatal(err)
	}
	claimed, won, err := st.Claim()
	if err != nil || !won {
		t.Fatalf("re-claim after unblock: won=%v err=%v", won, err)
	}
	if claimed.State != QueueDispatching {
		t.Fatalf("re-claim: state got %q want dispatching", claimed.State)
	}
	if claimed.OpencodeMsgID == "" {
		t.Fatal("re-claim must mint a fresh OpencodeMsgID")
	}
	// The re-minted id is the ONLY id the item has ever had reach the network:
	// the rolled-back id was cleared before Claim returned, so there is no
	// duplicate-message hazard. (Lifecycle forbids a dispatching item from
	// returning to pending, so no later claim can re-mint over an id OpenCode
	// may already have persisted under.)
}
