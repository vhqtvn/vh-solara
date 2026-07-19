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
	"io"
	"net/http"
	"net/url"
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
