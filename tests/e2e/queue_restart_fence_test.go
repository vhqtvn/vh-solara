package e2e

// queue_restart_fence_test.go — the queue-dispatch arm of the
// restart-interruption contract, end-to-end (the mid-run assistant-turn arm
// is pinned by restart_orphan_heal_test.go).
//
// SCENARIO (incident 2026-09-18, ses_f4ee263afffe6JK1yaiNy0nvs2): a queue
// item is claimed (`dispatching`, prompt_async POST in flight) when the
// operator clicks restart; the OpenCode process dies mid-dispatch; the user
// message is never persisted; the message-id reconciler later runs its
// bounded 3×404 budget and terminalizes the item. Pre-fence, that terminal
// carried ONLY the generic persistent-404 text — indistinguishable from an
// unrelated 404. With the restart fence (pkg/web/restart_fence.go), the
// restart handler durably stamps the in-flight item BEFORE killing the
// process, and the recovery + reconcile-terminal details explain the
// restart.
//
// Process death is modelled the same way queue_recovery_test.go models
// never-persisted dispatches: the POST never lands, so the (surviving) fake
// has no record of the message and its GET /session/:sid/message/:mid
// returns a real 404 — exactly the observable a restarted-from-scratch
// OpenCode presents for a message whose persist never completed. The
// restart itself is driven through the REAL /vh/restart-opencode handler
// (restart hook wired on the shared cluster's worker server, restored to
// unwired on cleanup — the harness default).

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/web"
)

// fencedItemView is the slice of a queue item this test asserts on
// (superset of the shared queueItemView: it also decodes the fence marker).
type fencedItemView struct {
	ID                string `json:"id"`
	State             string `json:"state"`
	Detail            string `json:"detail"`
	RestartFenceAt    int64  `json:"restartFenceAt"`
	ReconcileAttempts int    `json:"reconcileAttempts"`
	ReconcileTerminal bool   `json:"reconcileTerminal"`
}

// listFencedRaw lists the queue through the raw JSON so RestartFenceAt (a
// field the shared queueItemView does not carry) is decoded too.
func listFencedRaw(t *testing.T, sid, dir string) []fencedItemView {
	t.Helper()
	resp, err := http.Get(queuePath(sid, "", dir))
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list: want 200, got %d", resp.StatusCode)
	}
	var out struct {
		Items []fencedItemView `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("list decode: %v", err)
	}
	return out.Items
}

// TestQueueRestartFence_MidDispatchRestartExplained is the queue-arm crux:
// a mid-dispatch item at restart time ends up distinguishable from an
// unrelated 404 — fenced while dispatching, recovered to unknown with the
// restart-specific text, and terminalized by the UNCHANGED 3×404 detector
// with the restart-specific explanation (not the generic one).
func TestQueueRestartFence_MidDispatchRestartExplained(t *testing.T) {
	// Keep the PRODUCTION stale threshold (30s) until the fence assertions
	// complete so the "still dispatching right after the restart" check is
	// deterministic; shrink it afterwards to drive recovery+reconcile fast.
	const fastThreshold = 200 * time.Millisecond
	t.Cleanup(func() { web.SetStaleDispatchThresholdForTest(0) })

	// Unique dir leaf so the fake's synthetic per-dir session id does not
	// collide across tests; open the project so the reconcile's
	// aggForExisting(dir) finds the aggregator (mirrors production: the FE
	// opens the project before listing the queue).
	dir := t.TempDir() + "/qfence"
	openProjectForDir(t, dir)
	sid := fakeSessionForDir(dir)

	// Wire the restart hook on the shared cluster's worker server (in-package
	// access; the harness leaves it unwired). The hook models restartOC
	// completing: the process was killed and a fresh one is up. Restore the
	// unwired (nil) default on cleanup.
	cluster.webSrv.SetRestartOpenCode(func(ctx context.Context) error { return nil })
	t.Cleanup(func() { cluster.webSrv.SetRestartOpenCode(nil) })

	// 1. Enqueue + claim — the item is now mid-dispatch (state `dispatching`,
	// prompt_async POST in flight). The restart fires BEFORE the POST
	// completes: nothing is ever persisted under the minted id.
	itemID, opencodeMsgID := enqueueAndClaim(t, sid, dir, "restart fence probe")
	if got := cluster.Fake.UserMessageCount(sid); got != 0 {
		t.Fatalf("setup: UserMessageCount=%d, want 0 (dispatch interrupted before persist)", got)
	}

	// 2. THE RESTART — through the real handler. The fence fires inside,
	// before the restart hook "kills" the process.
	resp, body := postJSON(t, cluster.WorkerVHURL+"/vh/restart-opencode", nil)
	if resp == nil || resp.StatusCode != 200 {
		t.Fatalf("restart: want 200, got resp=%v body=%s", resp, body)
	}

	// 3. Immediately after the restart: the item is STILL dispatching (the
	// fence stamps, it does not transition state) and carries the durable
	// restart fence marker.
	items := listFencedRaw(t, sid, dir)
	if len(items) != 1 {
		t.Fatalf("post-restart list: want 1 item, got %d", len(items))
	}
	if items[0].State != "dispatching" {
		t.Fatalf("post-restart state = %q, want dispatching (fence must not touch the state machine)", items[0].State)
	}
	if items[0].RestartFenceAt <= 0 {
		t.Fatalf("post-restart restartFenceAt = %d, want > 0 (fence not durable before the kill)", items[0].RestartFenceAt)
	}

	// 4. Shrink the stale threshold; recovery fires on the next List and must
	// use the RESTART-SPECIFIC detail (not the generic interrupted-dispatch
	// text).
	web.SetStaleDispatchThresholdForTest(fastThreshold)
	time.Sleep(fastThreshold + 300*time.Millisecond)

	recovered := listFencedRaw(t, sid, dir)
	if len(recovered) != 1 || recovered[0].State != "unknown" {
		t.Fatalf("post-threshold: want 1 recovered unknown item, got %+v", recovered)
	}
	if !strings.Contains(recovered[0].Detail, "OpenCode restart") {
		t.Fatalf("recovered detail = %q, want the restart-specific recovery text", recovered[0].Detail)
	}

	// 5. CRUX — the reconciler (unchanged detector, unchanged 3-attempt
	// budget) terminalizes with the restart-specific explanation.
	items2, ok := pollQueue(t, sid, dir, 5*time.Second, func(items []queueItemView) (bool, string) {
		return len(items) == 1 && items[0].ReconcileTerminal, "terminal"
	})
	if !ok {
		t.Fatalf("fenced item %s never reached ReconcileTerminal; last=%+v", itemID, items2)
	}
	got := items2[0]
	if got.ID != itemID {
		t.Fatalf("item id drifted: enqueue=%s list=%s", itemID, got.ID)
	}
	if got.State != "unknown" {
		t.Fatalf("terminal state = %q, want unknown (fail-closed, never resent)", got.State)
	}
	if got.ReconcileAttempts != 3 {
		t.Fatalf("ReconcileAttempts = %d, want 3 (fence must NOT weaken the 3×404 detector)", got.ReconcileAttempts)
	}
	if !strings.Contains(got.Detail, "restart") {
		t.Fatalf("terminal detail = %q, want the restart-interrupted explanation", got.Detail)
	}
	if strings.Contains(got.Detail, "may have failed before persisting") {
		t.Fatalf("terminal detail = %q — must NOT be the generic persistent-404 text (the restart case must be distinguishable)", got.Detail)
	}

	// 6. NEVER resend: the reconciler only GETs; the fake still has zero user
	// messages for this session.
	if n := cluster.Fake.UserMessageCount(sid); n != 0 {
		t.Fatalf("after terminal: UserMessageCount=%d, want 0 (NEVER resend on 404)", n)
	}

	t.Logf("queue-arm crux verified end-to-end: mid-dispatch item %s (correlation %s) fenced at restart, "+
		"recovered with restart detail, and terminalized after 3 real 404s with the restart explanation: %q",
		itemID, opencodeMsgID, got.Detail)
}

// TestQueueRestartFence_IdleRestartUnfenced is the no-regression control
// (success criterion 3): a restart while NOTHING is mid-dispatch fences
// nothing — a later ordinary abandoned dispatch (no restart involved) keeps
// the GENERIC recovery/terminal texts.
func TestQueueRestartFence_IdleRestartUnfenced(t *testing.T) {
	const fastThreshold = 200 * time.Millisecond
	web.SetStaleDispatchThresholdForTest(fastThreshold)
	t.Cleanup(func() { web.SetStaleDispatchThresholdForTest(0) })

	dir := t.TempDir() + "/qfence-idle"
	openProjectForDir(t, dir)
	sid := fakeSessionForDir(dir)

	cluster.webSrv.SetRestartOpenCode(func(ctx context.Context) error { return nil })
	t.Cleanup(func() { cluster.webSrv.SetRestartOpenCode(nil) })

	// Restart FIRST (idle: no queue items at all) — must succeed normally.
	resp, body := postJSON(t, cluster.WorkerVHURL+"/vh/restart-opencode", nil)
	if resp == nil || resp.StatusCode != 200 {
		t.Fatalf("idle restart: want 200, got resp=%v body=%s", resp, body)
	}

	// Then an ordinary abandoned dispatch (browser crash class, NO restart
	// involvement): claim and never resolve.
	itemID, _ := enqueueAndClaim(t, sid, dir, "no restart here")
	time.Sleep(fastThreshold + 300*time.Millisecond)

	items, ok := pollQueue(t, sid, dir, 5*time.Second, func(items []queueItemView) (bool, string) {
		return len(items) == 1 && items[0].State == "unknown", "recovered"
	})
	if !ok {
		t.Fatalf("ordinary abandoned dispatch did not recover: %+v", items)
	}
	// The item must NOT carry a fence marker (restart happened while idle),
	// and the recovery detail is the GENERIC text.
	raw := listFencedRaw(t, sid, dir)
	if len(raw) != 1 || raw[0].ID != itemID {
		t.Fatalf("raw list drift: %+v want [%s]", raw, itemID)
	}
	if raw[0].RestartFenceAt != 0 {
		t.Fatalf("idle-restart test item was fenced (restartFenceAt=%d) — fence must only touch in-flight dispatches", raw[0].RestartFenceAt)
	}
	if !strings.Contains(raw[0].Detail, "Recovery:") || strings.Contains(raw[0].Detail, "OpenCode restart") {
		t.Fatalf("unfenced recovery detail = %q, want the GENERIC recovery text (no restart mention)", raw[0].Detail)
	}

	t.Logf("no-regression control verified: idle restart fenced nothing; later abandoned dispatch %s "+
		"kept the generic recovery text: %q", itemID, raw[0].Detail)
}
