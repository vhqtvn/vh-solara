package e2e

// In-process e2e coverage (under `go test -race`) for the Server-level
// queueReconcileInFlight overlap guard in pkg/web/queue_msg_reconcile.go:
//
//	if _, loaded := s.queueReconcileInFlight.LoadOrStore(key, struct{}{}); loaded {
//	    return
//	}
//	defer s.queueReconcileInFlight.Delete(key)
//
// That LoadOrStore+Delete idiom bounds reconciliation to ONE concurrent pass per
// (root, session): a FE poll storm (or a test poll loop) cannot fan out
// overlapping GET /session/:sid/message/:mid passes for the same session. The
// store-level unit tests (pkg/web/queue_msg_reconcile_test.go) cover
// reconciliation with a fake resolver + injected clock; the single-pass recovery
// flow (tests/e2e/queue_recovery_test.go) covers one delivered-but-stuck item
// resolving end-to-end. NEITHER covers the Server-level guard under genuinely
// concurrent List/reconcile invocations for one session — which is what this file
// proves.
//
// THE DELAYED-GET SEAM (pkg/fixtures/opencode.go): the fake now exposes a
// test-only, off-by-default blocker on the exact message-GET
// (GET /session/:sid/message/:mid) — ArmReconcileGetBlock / ReleaseReconcileGetBlock
// plus a race-free ReconcileGetCount counter. A test arms it, fires a reconcile,
// and the pass's exact-GET blocks at the seam (holding the guard sentinel
// mid-flight). The fake is shared across the e2e package, so all count
// assertions are DELTA-based (baseline snapshot before, delta after).
//
// WHY THIS GENUINELY TESTS THE GUARD (the throttle confound): the store has a
// SECOND defense — a per-item throttle in snapshotReconcileCandidates
// (nowMs-last < thresholdMs) that would ALSO suppress a double-GET for concurrent
// same-item passes within the threshold window. A naive "fire N concurrent Lists,
// assert count==1" test would pass even if the LoadOrStore guard were removed
// (the throttle would save it). To isolate the guard, TestReconcileInFlightGuard…
// holds pass1's exact-GET blocked PAST the threshold window so the per-item
// throttle expires while pass1 is still mid-flight, THEN fires concurrent
// reconciles. At that point:
//   - guard present → concurrent passes return at reconcileSessionQueue (the
//     LoadOrStore sees the sentinel), the exact-GET count stays at 1;
//   - guard ABSENT  → a concurrent pass re-snapshots (throttle expired) and
//     issues a SECOND exact-GET → count rises to 2.
//
// So the crux assertion (exactly one exact-GET) fails if the LoadOrStore guard
// is removed, which is what makes it a true regression test for the guard rather
// than for the throttle.

import (
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// getListAsync fires a GET /vh/session/{sid}/queue List and drains the body,
// ignoring errors. It is safe to run from a goroutine (never touches t): the
// List's important side effect — spawning reconcileSessionQueue when an eligible
// item exists — is what the caller is observing via the GET-count seam. Calling
// t.Fatalf from a non-test goroutine is forbidden by testing, so this helper is
// deliberately assertion-free.
func getListAsync(sid, dir string) {
	resp, err := http.DefaultClient.Get(queuePath(sid, "", dir))
	if err == nil {
		drainBody(resp)
	}
}

// pollCount polls ReconcileGetCount until it reaches (>=) want within deadline.
// Used to wait for an async reconcile pass to reach the exact-GET branch and
// block at the seam. Returns whether the count was reached.
func pollCount(t *testing.T, want int64, deadline time.Duration) bool {
	t.Helper()
	end := time.Now().Add(deadline)
	for time.Now().Before(end) {
		if cluster.Fake.ReconcileGetCount() >= want {
			return true
		}
		time.Sleep(10 * time.Millisecond)
	}
	return cluster.Fake.ReconcileGetCount() >= want
}

// seedDispatchingItem enqueues+claims+dispatches (commit-then-drop) one item and
// waits past the stale threshold so the NEXT List() will recover it to terminal
// `unknown` (the reconcile-eligible state). It does NOT List, so the caller can
// arm the exact-GET seam before the recover+reconcile fires. Returns the minted
// item id and the OpenCode correlation id. The dispatch commits exactly one user
// message under the correlation id (the crux of the ambiguous-receipt window).
func seedDispatchingItem(t *testing.T, sid, dir, text string, threshold time.Duration) (itemID, opencodeMsgID string) {
	t.Helper()
	itemID, opencodeMsgID = enqueueAndClaim(t, sid, dir, text)
	if dispatchWithMessageID(t, sid, dir, text, opencodeMsgID) {
		t.Fatalf("commit-then-drop: dispatch returned 204; want dropped/error")
	}
	// Wait past the stale threshold so the next List() recovers dispatching->unknown.
	time.Sleep(threshold + 200*time.Millisecond)
	return itemID, opencodeMsgID
}

// TestReconcileInFlightGuardSingleFlightsConcurrentPasses is THE CRUX: under
// genuinely concurrent List/reconcile invocations for one session, the
// queueReconcileInFlight LoadOrStore guard admits AT MOST ONE overlapping
// reconcile pass — i.e. exactly one exact-GET occurs while pass1 is in flight.
// (See the file header for why the throttle is defeated to isolate the guard.)
//
// It also verifies the post-release outcome: releasing the seam lets pass1's GET
// complete and the item auto-resolves to `sent` with NO second dispatch
// (UserMessageCount stays 1 — the reconciler only GETs + Resolve()s, never
// prompt_async).
func TestReconcileInFlightGuardSingleFlightsConcurrentPasses(t *testing.T) {
	const testThreshold = 250 * time.Millisecond
	web.SetStaleDispatchThresholdForTest(testThreshold)
	t.Cleanup(func() { web.SetStaleDispatchThresholdForTest(0) })

	// Defensive: never leave the seam armed. The cluster fake is shared across the
	// e2e package; a leaked armed blocker would hang every later reconcile GET.
	// ReleaseReconcileGetBlock is idempotent (no-op when not armed).
	t.Cleanup(func() { cluster.Fake.ReleaseReconcileGetBlock() })

	// Unique dir leaf so the fake's synthetic per-dir session (proj_<leaf>) does
	// not collide with other tests' TempDir leaves (all bare TempDir alias "01").
	dir := filepath.Join(t.TempDir(), "rcov-race")
	openProjectForDir(t, dir) // the reconcile uses aggForExisting(dir); open it first
	sid := fakeSessionForDir(dir)

	cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncCommitThenDropResponse)
	t.Cleanup(func() { cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncNormal) })

	itemID, opencodeMsgID := seedDispatchingItem(t, sid, dir, "race probe A", testThreshold)

	// Arm the seam, then fire the FIRST List. List() recovers the stale
	// dispatching item -> unknown AND spawns reconcile pass 1, whose exact-GET now
	// blocks at the seam. Poll until exactly one GET is observed in flight.
	cluster.Fake.ArmReconcileGetBlock()
	getsBefore := cluster.Fake.ReconcileGetCount()
	getListAsync(sid, dir) // returns immediately; reconcile runs in a goroutine
	if !pollCount(t, getsBefore+1, 2*time.Second) {
		t.Fatalf("pass1 setup: expected 1 in-flight exact-GET, got delta %d", cluster.Fake.ReconcileGetCount()-getsBefore)
	}

	// DEFEAT THE PER-ITEM THROTTLE: hold pass1's exact-GET blocked PAST the
	// threshold window so reconcileLast[item] expires. Without this, a concurrent
	// pass would be suppressed by the throttle (nowMs-last < threshold) rather
	// than the guard — and this test would pass even if the LoadOrStore guard were
	// removed. With the throttle expired, a concurrent pass that got past the guard
	// would re-snapshot and issue a SECOND exact-GET.
	time.Sleep(testThreshold + 200*time.Millisecond)

	// Fire two concurrent Lists for the SAME (root, session). Each spawns a
	// reconcileSessionQueue goroutine. The guard must reject both (sentinel held by
	// pass1) — no second exact-GET. (Two goroutines + the shared fake + the guard's
	// sync.Map are exactly what -race scrutinizes here.)
	go getListAsync(sid, dir)
	go getListAsync(sid, dir)

	// Settle: give the rejected passes time to run reconcileSessionQueue and return
	// at the LoadOrStore guard. Generous because -race slows scheduling.
	time.Sleep(300 * time.Millisecond)

	// CRUX ASSERTION: exactly one exact-GET occurred while pass1 was in flight.
	inFlightGets := cluster.Fake.ReconcileGetCount() - getsBefore
	if inFlightGets != 1 {
		t.Fatalf("CRUX FAILED: expected exactly 1 exact-GET while pass1 in flight (guard single-flights), "+
			"got %d — the LoadOrStore guard admitted an overlapping reconcile pass", inFlightGets)
	}

	// Release the seam: pass1's GET completes -> 200 exact-match -> Resolve(sent).
	cluster.Fake.ReleaseReconcileGetBlock()

	// Outcome correctness: the item auto-resolves to `sent` (one Resolve, no second
	// dispatch). pollQueue until the async Resolve lands.
	items, ok := pollQueue(t, sid, dir, 5*time.Second, func(items []queueItemView) (bool, string) {
		return len(items) == 1 && items[0].State == "sent", "sent"
	})
	if !ok {
		t.Fatalf("item %s did not auto-resolve to sent after releasing the seam; last=%+v", itemID, items)
	}
	if items[0].ID != itemID {
		t.Fatalf("item id drifted: enqueue=%s list=%s", itemID, items[0].ID)
	}
	// NO re-dispatch: the reconciler only GETs + Resolve()s, so the fake still has
	// exactly one committed user message for this session.
	if got := cluster.Fake.UserMessageCount(sid); got != 1 {
		t.Fatalf("after reconcile: UserMessageCount=%d want 1 (reconciler must NOT re-dispatch)", got)
	}
	// No second exact-GET sneaked in after release either: pass1 already owned the
	// only lookup for this eligible item.
	if got := cluster.Fake.ReconcileGetCount() - getsBefore; got != 1 {
		t.Fatalf("post-release: expected 1 total exact-GET, got %d (a second pass slipped through)", got)
	}

	t.Logf("CRUX verified under -race: overlapping reconcile passes single-flighted by the guard "+
		"(exactly 1 exact-GET for item %s under minted id %s; UserMessageCount=1, no re-dispatch)",
		itemID, opencodeMsgID)
}

// TestReconcileInFlightGuardReleasesAfterCompletion proves the guard does not
// LEAK the sentinel: after pass1 completes (Delete-on-completion), a later List
// for the SAME (root, session) CAN admit a fresh reconcile pass. Without the
// defer-Delete, the sentinel would stay forever and every subsequent reconcile
// for that session would be silently dropped.
//
// It seeds a second eligible item in the same (root, sid) after the first pass
// completed and asserts a NEW exact-GET occurs (the count rises) — only possible
// if the sentinel was released.
func TestReconcileInFlightGuardReleasesAfterCompletion(t *testing.T) {
	const testThreshold = 250 * time.Millisecond
	web.SetStaleDispatchThresholdForTest(testThreshold)
	t.Cleanup(func() { web.SetStaleDispatchThresholdForTest(0) })
	t.Cleanup(func() { cluster.Fake.ReleaseReconcileGetBlock() })

	dir := filepath.Join(t.TempDir(), "rcov-race-rel")
	openProjectForDir(t, dir)
	sid := fakeSessionForDir(dir)

	cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncCommitThenDropResponse)
	t.Cleanup(func() { cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncNormal) })

	// Item A: seed, arm, List -> pass1 exact-GET blocked; release -> resolves sent.
	itemA, _ := seedDispatchingItem(t, sid, dir, "release probe A", testThreshold)
	cluster.Fake.ArmReconcileGetBlock()
	getsBeforeA := cluster.Fake.ReconcileGetCount()
	getListAsync(sid, dir)
	if !pollCount(t, getsBeforeA+1, 2*time.Second) {
		t.Fatalf("pass1: expected an in-flight exact-GET for A, got delta %d", cluster.Fake.ReconcileGetCount()-getsBeforeA)
	}
	cluster.Fake.ReleaseReconcileGetBlock()
	// Confirm A resolved to sent — i.e. pass1 COMPLETED and Delete'd the sentinel.
	if items, ok := pollQueue(t, sid, dir, 5*time.Second, func(items []queueItemView) (bool, string) {
		return len(items) == 1 && items[0].State == "sent", "sent"
	}); !ok {
		t.Fatalf("item A %s did not resolve to sent (pass1 did not complete); last=%+v", itemA, items)
	}

	// Item B in the SAME (root, sid): seed a second eligible unknown item. If the
	// guard leaked the sentinel (no Delete on completion), the List below would be
	// rejected and NO new pass would start (the exact-GET count would not rise).
	itemB, _ := seedDispatchingItem(t, sid, dir, "release probe B", testThreshold)
	cluster.Fake.ArmReconcileGetBlock()
	getsBeforeB := cluster.Fake.ReconcileGetCount()
	getListAsync(sid, dir)
	// A NEW pass must be admitted (sentinel was released): exactly one more GET.
	if !pollCount(t, getsBeforeB+1, 2*time.Second) {
		t.Fatalf("guard LEAKED: no new reconcile pass admitted for B after A completed "+
			"(expected exact-GET count to rise above %d, got %d) — the sentinel was not Delete'd on completion",
			getsBeforeB, cluster.Fake.ReconcileGetCount())
	}
	cluster.Fake.ReleaseReconcileGetBlock()

	// Both items resolve to sent; no duplicate dispatch (exactly two user messages,
	// one per item — the reconciler never re-dispatches).
	items, ok := pollQueue(t, sid, dir, 5*time.Second, func(items []queueItemView) (bool, string) {
		sent := 0
		for _, it := range items {
			if it.State == "sent" {
				sent++
			}
		}
		return sent == 2, "both sent"
	})
	if !ok {
		t.Fatalf("items did not both resolve to sent; last=%+v", items)
	}
	if got := cluster.Fake.UserMessageCount(sid); got != 2 {
		t.Fatalf("after both reconciles: UserMessageCount=%d want 2 (one per item; reconciler never re-dispatches)", got)
	}

	t.Logf("guard release verified: sentinel Delete'd on completion — a later List for the same "+
		"(%s,%s) admitted a fresh reconcile pass (A=%s, B=%s both sent; UserMessageCount=2)",
		dir, sid, itemA, itemB)
}
