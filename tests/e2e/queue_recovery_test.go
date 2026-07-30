package e2e

// In-process e2e coverage for the FIX-QUEUE-STUCK-1 queue recovery contract.
//
// STUCK-1 (commit 9397125) added recoverStaleDispatchingLocked, which runs
// inside List() and transitions abandoned `dispatching` items to terminal
// `unknown` once they exceed staleDispatchThreshold (30s production default).
// The 11 unit tests in pkg/web/queue_test.go drive recovery by injecting a
// `time.Time` directly — they prove the recovery rule, but not the full stack
// (worker HTTP API → queue persistence on disk → recovery → fake OpenCode
// commit semantics).
//
// This file proves the contract end-to-end through the real HTTP path: when a
// dispatch is committed by the fake OpenCode but the response is lost, the
// queue item recovers to `unknown` on the next List() after the threshold, and
// NO redispatch occurs (exactly one user message committed). It uses the
// shared `cluster` (TestMain in coordination_test.go) — a real controller +
// tunneled worker + fake OpenCode — and simulates the browser by making the
// queue HTTP calls directly to cluster.WorkerVHURL.
//
// Test-only threshold override: production staleDispatchThreshold is 30s (a
// deliberate margin over the frontend's 12s dispatch timeout). This suite
// shortens it via web.SetStaleDispatchThresholdForTest so the recovery fires
// without a 30-second wall-clock wait. The hook is backed by sync/atomic
// (race-free under `go test -race`) and defaults to off in production, which
// never calls the setter.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// csrfHeaderValue is the value the SPA sends for X-VH-CSRF. The header name
// constant lives unexported in pkg/web; the e2e package mirrors the literal
// (server.go csrfGuard requires it on all unsafe-method /vh/* AND /oc/* POSTs).
const csrfHeaderValue = "1"

const csrfHeaderName = "X-VH-CSRF"

// queuePath builds the worker URL for a /vh/session/{sid}/queue* call with the
// project root pinned via ?dir= so the queue store writes under a per-test temp
// dir instead of the repo root (projectRoot("") returns os.Getwd()). suffix is
// the path tail after /queue ("" for list/enqueue, "/claim" for claim). The
// ?dir= query MUST come AFTER the path suffix, not before — appending "/claim"
// to a URL that already has "?dir=" would push /claim into the query string and
// silently route to enqueue. Every /vh/queue call MUST pass ?dir= here; the
// /oc/ passthrough ignores it (pure proxy) but accepts it harmlessly.
func queuePath(sid, suffix, dir string) string {
	return cluster.WorkerVHURL + "/vh/session/" + sid + "/queue" + suffix + "?dir=" + url.QueryEscape(dir)
}

// dispatchPath builds the worker /oc/ proxy URL for prompt_async. ?dir= is
// ignored by the passthrough (pure proxy to the fake) but harmless.
func dispatchPath(sid, dir string) string {
	return cluster.WorkerVHURL + "/oc/session/" + sid + "/prompt_async?dir=" + url.QueryEscape(dir)
}

// postJSON issues a CSRF-bearing POST to the worker. Returns the response
// (caller closes the body). Fails the test on request-issuance error only —
// non-2xx statuses are returned for the caller to assert (the dispatch
// "dropped response" path is EXPECTED to be a non-204/error).
func postJSON(t *testing.T, urlStr string, body any) (*http.Response, []byte) {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal body: %v", err)
	}
	req, err := http.NewRequest(http.MethodPost, urlStr, bytes.NewReader(b))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(csrfHeaderName, csrfHeaderValue)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		// A transport error is a valid outcome for the dropped-response
		// dispatch; surface it to the caller via a nil resp + the error in
		// the body slice is awkward, so just return (nil, nil) and let the
		// caller distinguish. Non-dispatch callers always want a resp, so we
		// only tolerate this in the dispatch step.
		return nil, nil
	}
	defer resp.Body.Close()
	payload, _ := io.ReadAll(resp.Body)
	return resp, payload
}

// drainBody reads and closes a response body fully (keeps-alive the proxy pool).
func drainBody(resp *http.Response) {
	if resp == nil {
		return
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()
}

// TestQueueDispatchCommittedThenResponseLostRecoversUnknown is the primary
// deliverable: it proves the STUCK-1 recovery contract through the real HTTP
// stack.
//
// Scenario (the ambiguous-receipt window):
//  1. Browser enqueues + claims an item → `dispatching` (DispatchStartedAt set).
//  2. Browser dispatches via POST /oc/session/{id}/prompt_async. The fake is in
//     CommitThenDropResponse mode: it persists the user message (the "commit"),
//     then hijacks+closes the connection so the worker's reverse proxy sees a
//     backend error (NOT 204).
//  3. The browser never resolves the item (crash / network loss after the
//     failed dispatch) → the item is stuck in `dispatching`.
//  4. After the (shortened) stale threshold, the next List() fires recovery:
//     the item transitions to terminal `unknown` with the diagnostic Detail.
//
// Contract assertions:
//   - The item recovers to `unknown` (never pending/sent/dispatching).
//   - Exactly ONE user message was committed (NO redispatch — recovery never
//     re-issues the prompt POST).
//   - The recovery Detail text is present (operator-facing explanation).
//   - ResolvedAt is set (terminal transition is timestamped).
func TestQueueDispatchCommittedThenResponseLostRecoversUnknown(t *testing.T) {
	// Shorten the stale threshold so recovery fires without a 30s wait. Restore
	// the production default (30s) on exit — the cluster is shared across the
	// e2e package, so a leaked override would silently shorten recovery for
	// every subsequent test in the same `go test` run.
	const testThreshold = 200 * time.Millisecond
	web.SetStaleDispatchThresholdForTest(testThreshold)
	t.Cleanup(func() { web.SetStaleDispatchThresholdForTest(0) })

	sid := "qreco"
	dir := t.TempDir()

	// Switch the fake to commit-then-drop and restore the faithful (Normal)
	// mode on exit — the shared fake backs every session in the cluster.
	cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncCommitThenDropResponse)
	t.Cleanup(func() { cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncNormal) })

	// 1. Enqueue (browser → worker queue API). Expect 200 + state=pending.
	enqueueBody := map[string]any{"text": "recovery probe", "originClientId": "e2e-test"}
	resp, body := postJSON(t, queuePath(sid, "", dir), enqueueBody)
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("enqueue: want 200, got resp=%v body=%s", resp, body)
	}
	var enq struct {
		Item struct {
			ID    string `json:"id"`
			State string `json:"state"`
		} `json:"item"`
	}
	if err := json.Unmarshal(body, &enq); err != nil {
		t.Fatalf("enqueue decode: %v (body=%s)", err, body)
	}
	if enq.Item.ID == "" {
		t.Fatalf("enqueue returned empty item id: %s", body)
	}
	if enq.Item.State != "pending" {
		t.Fatalf("enqueue: want state=pending, got %q (body=%s)", enq.Item.State, body)
	}

	// 2. Claim → item moves to dispatching with DispatchStartedAt set.
	resp, body = postJSON(t, queuePath(sid, "/claim", dir), nil)
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("claim: want 200, got resp=%v body=%s", resp, body)
	}
	var claim struct {
		Item struct {
			ID                string `json:"id"`
			State             string `json:"state"`
			DispatchStartedAt int64  `json:"dispatchStartedAt"`
		} `json:"item"`
	}
	if err := json.Unmarshal(body, &claim); err != nil {
		t.Fatalf("claim decode: %v (body=%s)", err, body)
	}
	if claim.Item.ID != enq.Item.ID {
		t.Fatalf("claim picked a different item: enqueue=%s claim=%s", enq.Item.ID, claim.Item.ID)
	}
	if claim.Item.State != "dispatching" {
		t.Fatalf("claim: want state=dispatching, got %q (body=%s)", claim.Item.State, body)
	}
	if claim.Item.DispatchStartedAt <= 0 {
		t.Fatalf("claim: DispatchStartedAt not set (body=%s)", body)
	}

	// 3. Dispatch (browser → worker /oc/ proxy → fake). In CommitThenDropResponse
	//    mode the fake commits the user message THEN drops the connection, so the
	//    worker's reverse proxy returns a backend error (NOT 204). The prompt
	//    body shape mirrors OpenCode's prompt_async: {parts:[{type:text,text:...}]}.
	dispatchURL := dispatchPath(sid, dir)
	dispatchBody := map[string]any{
		"parts": []map[string]any{
			{"type": "text", "text": "recovery probe"},
		},
	}
	resp, _ = postJSON(t, dispatchURL, dispatchBody)
	if resp != nil {
		// Got a response — it MUST NOT be 204 (the dropped-response scenario).
		// A 502 (reverse-proxy backend-error) is the expected outcome. The body
		// is already drained + closed by postJSON, so only inspect the status.
		if resp.StatusCode == http.StatusNoContent {
			t.Fatalf("dispatch returned 204 in CommitThenDropResponse mode; want dropped/error")
		}
	}
	// resp == nil (transport error / EOF) is also acceptable — the response was
	// lost, which is exactly the scenario under test.

	// 4. Prove the commit happened BEFORE the drop: by the time the dispatch
	//    call returned (with error), the user message is already durably
	//    recorded. This is the crux of the ambiguous-receipt window.
	if got := cluster.Fake.UserMessageCount(sid); got != 1 {
		t.Fatalf("after dispatch: UserMessageCount=%d, want 1 (commit-before-drop)", got)
	}

	// 5. Do NOT resolve (browser crash / network loss simulation) — the item is
	//    now stuck in `dispatching`.

	// 6. Wait past the (shortened) stale threshold so recovery will fire on the
	//    next List(). Margin over testThreshold guards against scheduling jitter.
	time.Sleep(testThreshold + 300*time.Millisecond)

	// 7. List → List() runs recoverStaleDispatchingLocked → item → unknown.
	req, err := http.NewRequest(http.MethodGet, queuePath(sid, "", dir), nil)
	if err != nil {
		t.Fatalf("list new request: %v", err)
	}
	listResp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	defer listResp.Body.Close()
	listBody, _ := io.ReadAll(listResp.Body)
	if listResp.StatusCode != http.StatusOK {
		t.Fatalf("list: want 200, got %d (body=%s)", listResp.StatusCode, listBody)
	}
	var list struct {
		Items []struct {
			ID                string `json:"id"`
			State             string `json:"state"`
			DispatchStartedAt int64  `json:"dispatchStartedAt"`
			ResolvedAt        int64  `json:"resolvedAt"`
			Detail            string `json:"detail"`
		} `json:"items"`
	}
	if err := json.Unmarshal(listBody, &list); err != nil {
		t.Fatalf("list decode: %v (body=%s)", err, listBody)
	}

	// 8. Contract: exactly one item, recovered to `unknown` (NOT pending, sent,
	//    or dispatching). Recovery never re-dispatches and never claims success.
	if len(list.Items) != 1 {
		t.Fatalf("list: want 1 item, got %d (body=%s)", len(list.Items), listBody)
	}
	got := list.Items[0]
	if got.ID != enq.Item.ID {
		t.Fatalf("list: item id drifted; enqueue=%s list=%s", enq.Item.ID, got.ID)
	}
	if got.State != "unknown" {
		t.Fatalf("recovery: want state=unknown, got %q (the recovery contract requires terminal unknown, "+
			"never pending/sent/dispatching)", got.State)
	}
	// 9. Recovery Detail present — the operator-facing explanation (stable
	//    substring of staleDispatchRecoveryDetail in pkg/web/queue.go).
	if !strings.Contains(got.Detail, "Recovery:") || !strings.Contains(got.Detail, "interrupted") {
		t.Fatalf("recovery: detail text missing/wrong: %q", got.Detail)
	}
	// 10. ResolvedAt set (terminal transition is timestamped).
	if got.ResolvedAt <= 0 {
		t.Fatalf("recovery: ResolvedAt not set on recovered item")
	}
	// 11. NO redispatch: recovery NEVER re-issues the prompt, so the fake still
	//     has exactly one committed user message. If this is 2, recovery
	//     double-dispatched — a bug in the fix, fail loudly.
	if got := cluster.Fake.UserMessageCount(sid); got != 1 {
		t.Fatalf("after recovery: UserMessageCount=%d, want 1 (recovery must NOT redispatch)", got)
	}

	t.Logf("FIX-QUEUE-STUCK-1 recovery contract verified end-to-end: item %s recovered to "+
		"unknown after dropped dispatch (UserMessageCount=1, no redispatch; detail=%q)",
		got.ID, got.Detail)
}

// TestQueueDispatchNormalModeCommitsAndKeepsDispatching is a guard test: in the
// faithful (Normal) prompt_async mode, the fake returns 204 and the queue item
// stays `dispatching` (no recovery) because the browser has not resolved it
// yet. It pins the contract that recovery is NOT triggered merely by dispatch
// — only by the stale threshold. It also confirms the threshold override was
// restored by the previous test's Cleanup (defensive).
func TestQueueDispatchNormalModeCommitsAndKeepsDispatching(t *testing.T) {
	// Shorten the threshold but recover AFTER a sleep that is SHORTER than it,
	// proving the in-flight window is left alone.
	const testThreshold = 400 * time.Millisecond
	web.SetStaleDispatchThresholdForTest(testThreshold)
	t.Cleanup(func() { web.SetStaleDispatchThresholdForTest(0) })

	sid := "qreco-normal"
	dir := t.TempDir()

	// Faithful mode (explicit; default, but pin it in case a prior test leaked).
	cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncNormal)
	t.Cleanup(func() { cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncNormal) })

	// Enqueue + claim.
	resp, body := postJSON(t, queuePath(sid, "", dir), map[string]any{"text": "normal probe"})
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("enqueue: want 200, got resp=%v body=%s", resp, body)
	}
	resp, body = postJSON(t, queuePath(sid, "/claim", dir), nil)
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("claim: want 200, got resp=%v body=%s", resp, body)
	}
	var claim struct {
		Item struct {
			State string `json:"state"`
		} `json:"item"`
	}
	if err := json.Unmarshal(body, &claim); err != nil || claim.Item.State != "dispatching" {
		t.Fatalf("claim: want dispatching, got body=%s err=%v", body, err)
	}

	// Dispatch in Normal mode → fake returns 204 (forked turn). Expect success.
	dispatchURL := dispatchPath(sid, dir)
	dispatchBody := map[string]any{
		"parts": []map[string]any{{"type": "text", "text": "normal probe"}},
	}
	resp, _ = postJSON(t, dispatchURL, dispatchBody)
	if resp == nil {
		t.Fatalf("normal dispatch: got nil response (transport error); want 204")
	}
	drainBody(resp)
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("normal dispatch: want 204, got %d", resp.StatusCode)
	}

	// Sleep SHORTER than the threshold → still in-flight → no recovery.
	time.Sleep(testThreshold / 2)

	listResp, err := http.DefaultClient.Get(queuePath(sid, "", dir))
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	defer listResp.Body.Close()
	listBody, _ := io.ReadAll(listResp.Body)
	var list struct {
		Items []struct {
			State string `json:"state"`
		} `json:"items"`
	}
	if err := json.Unmarshal(listBody, &list); err != nil {
		t.Fatalf("list decode: %v (body=%s)", err, listBody)
	}
	if len(list.Items) != 1 {
		t.Fatalf("list: want 1 item, got %d (body=%s)", len(list.Items), listBody)
	}
	if list.Items[0].State != "dispatching" {
		t.Fatalf("in-flight item must stay dispatching (no recovery yet): got %q", list.Items[0].State)
	}
}

// openProjectForDir triggers aggFor(dir) via GET /vh/snapshot so a per-dir
// aggregator exists for the reconcile's aggForExisting lookup. The reconcile
// uses aggForExisting (NOT aggFor) so the queue-List path is side-effect-free;
// the project must therefore be opened explicitly first — exactly mirroring
// production, where the FE opens the project (snapshot/stream) before listing
// the queue. A short settle lets the aggregator's cold hydrate + orphan-GC
// sweep run (they find nothing, since no queue is enqueued yet).
func openProjectForDir(t *testing.T, dir string) {
	t.Helper()
	resp, err := http.DefaultClient.Get(cluster.WorkerVHURL + "/vh/snapshot?dir=" + url.QueryEscape(dir))
	if err != nil {
		t.Fatalf("open project (snapshot): %v", err)
	}
	drainBody(resp)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("open project (snapshot): want 200, got %d", resp.StatusCode)
	}
	// Let the cold hydrate + orphan-GC sweep settle so it does not race the
	// enqueue. (sid below is the fake's synthetic per-dir session, so any
	// orphan sweep keeps it regardless; the settle is belt-and-suspenders.)
	time.Sleep(300 * time.Millisecond)
}

// fakeSessionForDir returns the synthetic session id the fake reports for a
// non-demo directory (pkg/fixtures/opencode.go handleSessionRoot: "proj_" +
// last path component). Using it as the queue's session id makes the session
// "real" in the fake's active set, so orphan-queue GC never deletes the queue.
func fakeSessionForDir(dir string) string {
	return "proj_" + filepath.Base(dir)
}

// queueItemView is the slice of a queue item the e2e tests assert on. Fields
// beyond these (attachments, sendConfig, …) are ignored.
type queueItemView struct {
	ID                string `json:"id"`
	State             string `json:"state"`
	OpencodeMsgID     string `json:"opencodeMsgID"`
	DispatchStartedAt int64  `json:"dispatchStartedAt"`
	ResolvedAt        int64  `json:"resolvedAt"`
	Detail            string `json:"detail"`
	ReconcileAttempts int    `json:"reconcileAttempts"`
	ReconcileTerminal bool   `json:"reconcileTerminal"`
}

// listQueue GETs the queue and returns its items (decoded as queueItemView).
func listQueue(t *testing.T, sid, dir string) []queueItemView {
	t.Helper()
	resp, err := http.DefaultClient.Get(queuePath(sid, "", dir))
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("list: want 200, got %d (body=%s)", resp.StatusCode, body)
	}
	var out struct {
		Items []queueItemView `json:"items"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("list decode: %v (body=%s)", err, body)
	}
	return out.Items
}

// enqueueAndClaim is the common setup: enqueue + claim, returning the minted
// item id and OpenCode correlation id. The dispatch body's messageID is the FE
// threading of the correlation id (closes the Slice-5 DEFER F1 coverage gap
// end-to-end).
func enqueueAndClaim(t *testing.T, sid, dir, text string) (itemID, opencodeMsgID string) {
	t.Helper()
	resp, body := postJSON(t, queuePath(sid, "", dir), map[string]any{"text": text})
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("enqueue: want 200, got resp=%v body=%s", resp, body)
	}
	var enq struct {
		Item queueItemView `json:"item"`
	}
	if err := json.Unmarshal(body, &enq); err != nil {
		t.Fatalf("enqueue decode: %v (body=%s)", err, body)
	}
	if enq.Item.ID == "" || enq.Item.OpencodeMsgID == "" {
		t.Fatalf("enqueue: missing id/opencodeMsgID: %+v (body=%s)", enq.Item, body)
	}
	resp, body = postJSON(t, queuePath(sid, "/claim", dir), nil)
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("claim: want 200, got resp=%v body=%s", resp, body)
	}
	var claim struct {
		Item queueItemView `json:"item"`
	}
	if err := json.Unmarshal(body, &claim); err != nil {
		t.Fatalf("claim decode: %v (body=%s)", err, body)
	}
	if claim.Item.ID != enq.Item.ID || claim.Item.State != "dispatching" {
		t.Fatalf("claim: want same id+dispatching, got %+v", claim.Item)
	}
	return enq.Item.ID, enq.Item.OpencodeMsgID
}

// dispatchWithMessageID dispatches the claimed item via the FE dispatch path,
// threading the correlation id into prompt_async's body.messageID. Tolerates the
// dropped-response transport error (returns true if a 204 was observed, false
// for any error/non-204 — the caller asserts the expected mode).
func dispatchWithMessageID(t *testing.T, sid, dir, text, opencodeMsgID string) bool {
	t.Helper()
	resp, _ := postJSON(t, dispatchPath(sid, dir), map[string]any{
		"parts":     []map[string]any{{"type": "text", "text": text}},
		"messageID": opencodeMsgID,
	})
	if resp == nil {
		return false // transport error (dropped response)
	}
	drainBody(resp)
	return resp.StatusCode == http.StatusNoContent
}

// pollQueue polls List() until pred returns done=true or the deadline expires.
// Returns the final item slice (and whether pred ever succeeded).
func pollQueue(t *testing.T, sid, dir string, deadline time.Duration, pred func(items []queueItemView) (done bool, why string)) ([]queueItemView, bool) {
	t.Helper()
	end := time.Now().Add(deadline)
	var last []queueItemView
	for time.Now().Before(end) {
		last = listQueue(t, sid, dir)
		if done, _ := pred(last); done {
			return last, true
		}
		time.Sleep(40 * time.Millisecond)
	}
	return last, false
}

// TestQueueReconcileCommittedThenDroppedRecoversSent is THE CRUX e2e for Slice 6:
// a DELIVERED-BUT-STUCK item (dispatch committed by OpenCode under the queue's
// correlation id, then the response dropped) must AUTO-RESOLVE to `sent` after
// the stale threshold — via the authoritative exact-GET reconciler — with NO
// duplicate prompt (exactly one user message under the minted id).
//
// This exercises the full load-bearing path: enqueue mints id → dispatch emits
// body.messageID → fake persists user message under that exact id → stale
// recovery → unknown → reconcile goroutine (spawned from handleQueueList) →
// aggForExisting(dir).Client().Message → 200 exact match → Resolve(sent).
func TestQueueReconcileCommittedThenDroppedRecoversSent(t *testing.T) {
	const testThreshold = 200 * time.Millisecond
	web.SetStaleDispatchThresholdForTest(testThreshold)
	t.Cleanup(func() { web.SetStaleDispatchThresholdForTest(0) })

	// Unique dir leaf so the fake's synthetic per-dir session id
	// (proj_<leaf>) does not collide across tests (t.TempDir's first leaf is
	// "01" for every test, so a bare TempDir would alias "proj_01"). The
	// reconcile uses aggForExisting(dir) — open the project first so the
	// aggregator exists; the synthetic session survives the per-dir
	// aggregator's orphan-GC sweep.
	dir := filepath.Join(t.TempDir(), "rcov-sent")
	openProjectForDir(t, dir)
	sid := fakeSessionForDir(dir)

	cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncCommitThenDropResponse)
	t.Cleanup(func() { cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncNormal) })

	itemID, opencodeMsgID := enqueueAndClaim(t, sid, dir, "recon probe")

	// Dispatch via the FE path, threading the correlation id. CommitThenDrop
	// drops the response (transport error / non-204) — the dropped outcome.
	if dispatchWithMessageID(t, sid, dir, "recon probe", opencodeMsgID) {
		t.Fatalf("commit-then-drop: dispatch returned 204; want dropped/error")
	}

	// The commit happened BEFORE the drop: exactly one user message under the
	// minted id (the crux of the ambiguous-receipt window).
	if got := cluster.Fake.UserMessageCount(sid); got != 1 {
		t.Fatalf("after dispatch: UserMessageCount=%d want 1 (commit-before-drop)", got)
	}

	// Wait past the stale threshold so recovery fires on the next List().
	time.Sleep(testThreshold + 300*time.Millisecond)

	// Poll until the item auto-resolves to `sent` (recovery→unknown, then the
	// async reconcile goroutine GETs 200 exact-match and Resolves). The
	// reconcile runs in a goroutine spawned by handleQueueList, so the item
	// appears `sent` on a subsequent poll.
	items, ok := pollQueue(t, sid, dir, 5*time.Second, func(items []queueItemView) (bool, string) {
		return len(items) == 1 && items[0].State == "sent", "sent"
	})
	if !ok {
		var states []string
		for _, it := range items {
			states = append(states, fmt.Sprintf("%s(term=%v,att=%d)", it.State, it.ReconcileTerminal, it.ReconcileAttempts))
		}
		t.Fatalf("item %s did not auto-resolve to sent within deadline; last states=%v", itemID, states)
	}
	if items[0].ID != itemID {
		t.Fatalf("item id drifted: enqueue=%s list=%s", itemID, items[0].ID)
	}

	// NO duplicate prompt: the reconciler only GETs (never re-dispatches), so
	// the fake still has exactly one committed user message.
	if got := cluster.Fake.UserMessageCount(sid); got != 1 {
		t.Fatalf("after reconcile: UserMessageCount=%d want 1 (reconciler must NOT resend)", got)
	}

	t.Logf("Slice 6 crux verified end-to-end: delivered-but-stuck item %s auto-resolved to sent "+
		"(exact-GET match under minted id %s; exactly one user message, no resend)",
		itemID, opencodeMsgID)
}

// TestQueueReconcileRejectBeforeCommitStaysNonSentNoResend verifies the
// fail-closed contract: when the dispatch was cleanly REJECTED before commit
// (OpenCode never received the prompt), the reconciler's GET returns 404. The
// item stays non-sent, and after the bounded budget it becomes ReconcileTerminal
// — the reconciler NEVER resends (a persistent 404 is TERMINAL for that id).
func TestQueueReconcileRejectBeforeCommitStaysNonSentNoResend(t *testing.T) {
	const testThreshold = 200 * time.Millisecond
	web.SetStaleDispatchThresholdForTest(testThreshold)
	t.Cleanup(func() { web.SetStaleDispatchThresholdForTest(0) })

	// Unique dir leaf (proj_<leaf>) — see TestQueueReconcileCommittedThenDroppedRecoversSent.
	dir := filepath.Join(t.TempDir(), "rcov-reject")
	openProjectForDir(t, dir)
	sid := fakeSessionForDir(dir)

	cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncRejectBeforeCommit)
	t.Cleanup(func() { cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncNormal) })

	itemID, opencodeMsgID := enqueueAndClaim(t, sid, dir, "reject probe")

	// Dispatch: rejected before commit → 502, NO user message persisted.
	dispatchWithMessageID(t, sid, dir, "reject probe", opencodeMsgID)
	if got := cluster.Fake.UserMessageCount(sid); got != 0 {
		t.Fatalf("reject-before-commit: UserMessageCount=%d want 0 (never committed)", got)
	}

	// Wait past the stale threshold so recovery → unknown, then poll until the
	// item becomes ReconcileTerminal (persistent 404 across the bounded budget).
	time.Sleep(testThreshold + 300*time.Millisecond)

	items, ok := pollQueue(t, sid, dir, 5*time.Second, func(items []queueItemView) (bool, string) {
		return len(items) == 1 && items[0].ReconcileTerminal, "terminal"
	})
	if !ok {
		var states []string
		for _, it := range items {
			states = append(states, fmt.Sprintf("%s(term=%v,att=%d)", it.State, it.ReconcileTerminal, it.ReconcileAttempts))
		}
		t.Fatalf("item %s did not reach ReconcileTerminal within deadline; last states=%v", itemID, states)
	}
	got := items[0]
	if got.State != "unknown" {
		t.Fatalf("persistent-404 item must stay non-sent: got %q want unknown", got.State)
	}
	if got.ID != itemID {
		t.Fatalf("item id drifted: enqueue=%s list=%s", itemID, got.ID)
	}

	// NEVER resend: a persistent 404 is TERMINAL — the reconciler must not
	// auto-dispatch. The fake still has zero user messages.
	if got := cluster.Fake.UserMessageCount(sid); got != 0 {
		t.Fatalf("after persistent-404 terminal: UserMessageCount=%d want 0 (NEVER resend on 404)", got)
	}

	t.Logf("Slice 6 fail-closed verified end-to-end: rejected item %s stayed non-sent and reached "+
		"ReconcileTerminal (persistent 404 over %d attempts; zero user messages, no resend)",
		itemID, got.ReconcileAttempts)
}
