package e2e

// Send-net-resilience slice 2a e2e: the two NEW fixture-backed scenarios —
//
//   (a) DelayedPersist (faithful async persistence): prompt_async 204s
//       immediately, the user message commits after a controlled delay. The
//       queue item rides the full passive path — stale recovery → unknown →
//       exact-ID reconcile → sent once the commit lands — with ZERO
//       re-dispatch (PromptArrivals delta stays 1).
//
//   (b) post-restart-404: DelayedPersist + SimulateRestart BEFORE the async
//       commit elapses — the pending commit vanishes (un-flushed
//       write-ahead), so the correlation id 404s forever. The item must
//       terminalize ReconcileTerminal (fail-closed, NEVER resend) as
//       non-sent, with zero committed messages and zero re-POSTs.
//
// Slice 2a scope note: these run through the LEGACY browser dispatch path
// (the daemon-dispatch capability is OFF in this slice), so the items carry
// NO attempt journal here — the journal-aware ambiguous-wait detail is unit-
// proven in pkg/web; this file proves the fixture hooks + the passive
// reconciler classification end-to-end.

import (
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

func TestQueueDelayedPersistReconcilesSent(t *testing.T) {
	const testThreshold = 200 * time.Millisecond
	web.SetStaleDispatchThresholdForTest(testThreshold)
	t.Cleanup(func() { web.SetStaleDispatchThresholdForTest(0) })

	// Unique dir leaf (proj_<leaf>) — see queue_recovery_test.go for the
	// collision rationale; the reconcile needs the per-dir aggregator, so the
	// project is opened first.
	dir := filepath.Join(t.TempDir(), "resil-delay")
	openProjectForDir(t, dir)
	sid := fakeSessionForDir(dir)

	// DelayedPersist with a delay LONGER than the stale threshold: the item
	// goes stale + gets its first (404) reconcile lookups BEFORE the commit
	// lands, then a later lookup finds it — exactly the async-persistence
	// window real OpenCode has.
	cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncDelayedPersist)
	cluster.Fake.SetPromptAsyncPersistDelay(400 * time.Millisecond)
	t.Cleanup(func() {
		cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncNormal)
		cluster.Fake.SetPromptAsyncPersistDelay(0)
	})

	// Shared-fake baselines: assert DELTAS (the fake accumulates across
	// serial e2e tests and -count>1 re-runs).
	baseUserMsgs := cluster.Fake.UserMessageCount(sid)
	baseArrivals := cluster.Fake.PromptArrivals(sid)

	itemID, opencodeMsgID := enqueueAndClaim(t, sid, dir, "delayed probe")

	// Dispatch → 204 IMMEDIATELY (the fake answers before committing).
	if !dispatchWithMessageID(t, sid, dir, "delayed probe", opencodeMsgID) {
		t.Fatalf("delayed-persist dispatch: want immediate 204, got dropped/error")
	}
	if got := cluster.Fake.PromptArrivals(sid) - baseArrivals; got != 1 {
		t.Fatalf("dispatch arrivals delta=%d, want exactly 1", got)
	}
	// Inside the async window: NOTHING is committed yet — the "2xx is never
	// durability" premise, observable.
	if got := cluster.Fake.UserMessageCount(sid) - baseUserMsgs; got != 0 {
		t.Fatalf("during delay window: UserMessageCount delta=%d, want 0 (async persistence)", got)
	}

	// The full passive path: stale recovery → unknown → (404 lookups during
	// the window) → commit lands → exact-ID GET 200 → auto-Resolve(sent).
	items, ok := pollQueue(t, sid, dir, 8*time.Second, func(items []queueItemView) (bool, string) {
		return len(items) == 1 && items[0].State == "sent", "sent"
	})
	if !ok {
		var states []string
		for _, it := range items {
			states = append(states, it.State)
		}
		t.Fatalf("item %s never reached sent (last states=%v); the delayed commit landed but reconcile missed it", itemID, states)
	}
	if items[0].ID != itemID {
		t.Fatalf("item id drifted: enqueue=%s list=%s", itemID, items[0].ID)
	}

	// Zero re-dispatch: exactly one arrival total, exactly one committed
	// message (the delayed one under the minted id).
	if got := cluster.Fake.PromptArrivals(sid) - baseArrivals; got != 1 {
		t.Fatalf("after reconcile: arrivals delta=%d, want 1 (the passive path must never re-POST)", got)
	}
	if got := cluster.Fake.UserMessageCount(sid) - baseUserMsgs; got != 1 {
		t.Fatalf("after reconcile: UserMessageCount delta=%d, want 1 (exactly the delayed commit)", got)
	}

	t.Logf("slice 2a DelayedPersist verified: item %s resolved sent via passive exact-ID reconcile "+
		"(1 arrival, 1 delayed commit, correlation id %s)", itemID, opencodeMsgID)
}

func TestQueuePostRestart404TerminalNoResend(t *testing.T) {
	const testThreshold = 200 * time.Millisecond
	web.SetStaleDispatchThresholdForTest(testThreshold)
	t.Cleanup(func() { web.SetStaleDispatchThresholdForTest(0) })

	dir := filepath.Join(t.TempDir(), "resil-restart")
	openProjectForDir(t, dir)
	sid := fakeSessionForDir(dir)

	cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncDelayedPersist)
	cluster.Fake.SetPromptAsyncPersistDelay(400 * time.Millisecond)
	t.Cleanup(func() {
		cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncNormal)
		cluster.Fake.SetPromptAsyncPersistDelay(0)
	})

	baseUserMsgs := cluster.Fake.UserMessageCount(sid)
	baseArrivals := cluster.Fake.PromptArrivals(sid)

	itemID, opencodeMsgID := enqueueAndClaim(t, sid, dir, "restart probe")

	// 204 received...
	if !dispatchWithMessageID(t, sid, dir, "restart probe", opencodeMsgID) {
		t.Fatalf("delayed-persist dispatch: want immediate 204")
	}
	// ...then OpenCode restarts BEFORE the async persist commits: the pending
	// commit vanishes (un-flushed write-ahead state).
	cluster.Fake.SimulateRestart()

	// Wait out the stale threshold + the would-be delay, then poll to
	// ReconcileTerminal: every exact-ID GET 404s forever (the id provably
	// maps to nothing post-restart), so the bounded budget must terminalize
	// the item fail-closed.
	time.Sleep(testThreshold + 500*time.Millisecond)
	items, ok := pollQueue(t, sid, dir, 8*time.Second, func(items []queueItemView) (bool, string) {
		return len(items) == 1 && items[0].ReconcileTerminal, "terminal"
	})
	if !ok {
		t.Fatalf("item %s never reached ReconcileTerminal (persistent post-restart 404)", itemID)
	}
	got := items[0]
	if got.State != "unknown" {
		t.Fatalf("post-restart item must stay non-sent: got %q want unknown", got.State)
	}
	// No custody journal on the legacy path → the GENERIC persistent-404
	// terminal text (the journal-aware variant is unit-proven in pkg/web:
	// TestQueueMsgReconcile_JournalAwareTerminalDetailShapes and the
	// TestQueueMsgReconcile_JournalBearing* terminal tests in
	// queue_msg_reconcile_test.go).
	if !strings.Contains(got.Detail, "Reconcile terminal") || !strings.Contains(got.Detail, "404") {
		t.Fatalf("terminal detail missing the persistent-404 classification: %q", got.Detail)
	}

	// NEVER resend: the vanished commit never landed and nothing re-POSTs.
	if n := cluster.Fake.UserMessageCount(sid) - baseUserMsgs; n != 0 {
		t.Fatalf("post-restart terminal: UserMessageCount delta=%d, want 0 (commit vanished; no resend)", n)
	}
	if got := cluster.Fake.PromptArrivals(sid) - baseArrivals; got != 1 {
		t.Fatalf("post-restart terminal: arrivals delta=%d, want 1 (no re-POST of any class in 2a)", got)
	}

	t.Logf("slice 2a post-restart-404 verified: item %s terminal (unknown, %d attempts) with the commit "+
		"vanished by restart and zero re-dispatch (correlation id %s)", itemID, got.ReconcileAttempts, opencodeMsgID)
}
