package web

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// Delete (POST /vh/delete) mirrors archive (POST /vh/archive): it computes the
// live subtree, applies the C5 fingerprint drift fence, loops the per-id op
// (DeleteSession), then prunes the local live view (RemoveSessions + queue
// cleanup + pins unpin). These tests cover the same boundary the archive tests
// (archive_orphan_test.go, archive_drift_test.go) lock: subtree cascade, the
// gone-tolerance (404/410) vs abort (everything else) split, queue cleanup, and
// the preview→commit drift fence. Delete has NO re-assert goroutine (a deleted
// session has no archived field to clobber), so no re-assert coverage is needed.

// postDelete POSTs /vh/delete and returns the response + decoded affected list.
func postDelete(t *testing.T, url, id string) (*http.Response, []string) {
	t.Helper()
	resp := csrfPost(t, url+"/vh/delete", map[string]any{"sessionID": id})
	var j struct {
		OK       bool     `json:"ok"`
		Affected []string `json:"affected"`
	}
	json.NewDecoder(resp.Body).Decode(&j)
	resp.Body.Close()
	return resp, j.Affected
}

// deleteIDCalls returns a snapshot copy of the ids DELETEd via DeleteSession.
func deleteIDCalls(f *fakeOC) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.deleteIDs))
	copy(out, f.deleteIDs)
	return out
}

// postDeleteFP POSTs /vh/delete with a CSRF header + optional fingerprint and
// returns (status, decoded body) so the drift test can inspect the 409 shape.
func postDeleteFP(t *testing.T, url, id, fingerprint string) (int, map[string]any) {
	t.Helper()
	body := map[string]any{"sessionID": id}
	if fingerprint != "" {
		body["expectedFingerprint"] = fingerprint
	}
	resp := csrfPost(t, url+"/vh/delete", body)
	defer resp.Body.Close()
	var out map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// TestDelete_CascadesToSubtree: deleting a root deletes it AND its whole
// subtree. handleDelete must call DeleteSession for every affected id, remove
// them from the live store, set the tombstone, and clean up each session's
// queue state (the direct /vh/delete path, independent of the subscriber).
func TestDelete_CascadesToSubtree(t *testing.T) {
	f := &fakeOC{}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1","title":"root"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c1","parentID":"s1","title":"child"}}`))
	seedQueueFile(t, root, "s1")
	seedQueueFile(t, root, "c1")

	resp, affected := postDelete(t, web.URL, "s1")
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/delete s1: got %d, want 200", resp.StatusCode)
	}
	if len(affected) != 2 || !containsAny(toAny(affected), "s1") || !containsAny(toAny(affected), "c1") {
		t.Fatalf("affected: got %v, want [s1 c1]", affected)
	}
	// DeleteSession must have been called for every affected id (per-id loop).
	calls := deleteIDCalls(f)
	if countID(calls, "s1") < 1 || countID(calls, "c1") < 1 {
		t.Fatalf("DeleteSession not called for s1+c1; all DELETEs: %v", calls)
	}
	// Both must be removed from the live store.
	if agg.Store().Descendants("s1") != nil {
		t.Error("s1 subtree still in store after delete; RemoveSessions should have pruned it")
	}
	// Tombstone must be set (holds against resurrection during the window — a
	// deleted session must NOT re-enter via a stale hydrate).
	if !agg.Store().IsRecentlyArchived("s1") || !agg.Store().IsRecentlyArchived("c1") {
		t.Error("deleted ids not tombstoned after delete")
	}
	// Queue state must be cleaned up for both (the direct /vh/delete path).
	waitForQueueGone(t, root, "s1", "delete must clean s1 queue")
	waitForQueueGone(t, root, "c1", "delete must clean c1 queue")
}

// TestDelete_NotInStoreFallback: the requested session is NOT in the server
// store (pruned by a prior cascade/demotion, or already gone). handleDelete
// falls back to [body.SessionID], calls DeleteSession for it, and returns it in
// affected so the client can prune.
func TestDelete_NotInStoreFallback(t *testing.T) {
	f := &fakeOC{}
	web, agg, _, _ := queueLifecycleServer(t, f)

	resp, affected := postDelete(t, web.URL, "ghost")
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/delete ghost: got %d, want 200", resp.StatusCode)
	}
	if len(affected) != 1 || affected[0] != "ghost" {
		t.Fatalf("affected: got %v, want [ghost] (fallback to body.SessionID)", affected)
	}
	if countID(deleteIDCalls(f), "ghost") < 1 {
		t.Fatalf("DeleteSession not called for ghost; all DELETEs: %v", deleteIDCalls(f))
	}
	if !agg.Store().IsRecentlyArchived("ghost") {
		t.Error("ghost not tombstoned after delete")
	}
}

// TestDelete_ToleratesGoneStatus: DeleteSession returns 404 (the session is a
// ghost, or was already cascade-deleted by OpenCode / an earlier parent delete
// in this loop). The delete must NOT abort — it logs the error, continues, and
// RemoveSessions still fires so the tree is pruned + tombstoned. 410 (Gone) is
// treated the same.
func TestDelete_ToleratesGoneStatus(t *testing.T) {
	f := &fakeOC{deleteStatus: http.StatusNotFound}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)
	seedQueueFile(t, root, "orphan")
	agg.Store().Apply(ev("session.created", `{"info":{"id":"orphan","parentID":"root"}}`))

	resp, affected := postDelete(t, web.URL, "orphan")
	// MUST be 200, NOT 502 — the 404 means the session is verifiably gone.
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/delete with 404 DeleteSession: got %d, want 200 (gone tolerated)", resp.StatusCode)
	}
	if len(affected) != 1 || affected[0] != "orphan" {
		t.Fatalf("affected: got %v, want [orphan]", affected)
	}
	if agg.Store().Descendants("orphan") != nil {
		t.Error("orphan still in store after delete; RemoveSessions should fire for gone status")
	}
	if !agg.Store().IsRecentlyArchived("orphan") {
		t.Error("orphan not tombstoned after best-effort delete")
	}
	if countID(deleteIDCalls(f), "orphan") < 1 {
		t.Fatalf("DeleteSession not called for orphan; all DELETEs: %v", deleteIDCalls(f))
	}
	// Queue cleanup still fires despite the upstream 404 (delete intent satisfied).
	waitForQueueGone(t, root, "orphan", "delete must clean orphan queue on gone status")
}

// TestDelete_NonGoneStatusAborts: DeleteSession returns 409 (Conflict) — the
// session IS still live in OpenCode. The delete MUST abort with 502 so
// RemoveSessions and CleanupSession (queue deletion) do NOT fire. This locks the
// boundary: only 404/410 are tolerated; everything else preserves the queue.
// Same expectation for 400/401/403/429/5xx/network.
func TestDelete_NonGoneStatusAborts(t *testing.T) {
	f := &fakeOC{deleteStatus: http.StatusConflict} // 409
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)
	seedQueueFile(t, root, "orphan")
	agg.Store().Apply(ev("session.created", `{"info":{"id":"orphan","parentID":"root"}}`))

	resp, _ := postDelete(t, web.URL, "orphan")
	// MUST be 502 — the session is still live (409), so the delete aborts to
	// preserve the queue.
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("/vh/delete with 409 DeleteSession: got %d, want 502 (abort)", resp.StatusCode)
	}
	// Must STILL be in the store — RemoveSessions must NOT have fired.
	if agg.Store().Descendants("orphan") == nil {
		t.Error("orphan removed from store after aborted delete; RemoveSessions should NOT fire")
	}
	// Queue state must survive — CleanupSession must NOT have fired. Poll the
	// negative condition across a short window so a delayed stray cleanup
	// surfaces as a failure (mirrors TestArchiveOrphan_NonGoneStatusAborts).
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		if !queueFileExists(root, "orphan") {
			t.Fatalf("409 delete must NOT delete queue.json (CleanupSession fired)")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestDeleteDrift_SpawnBetweenPreviewAndCommit is the C5 crux for delete: a new
// descendant spawns under the target between preview and commit. The stale
// fingerprint MUST 409 and delete NOTHING — the operator never saw the new
// session and did not consent to deleting it. (Mirrors the archive crux.)
func TestDeleteDrift_SpawnBetweenPreviewAndCommit(t *testing.T) {
	f := &fakeOC{}
	web, agg, srv, _ := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1","title":"root"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c1","parentID":"s1","title":"child1"}}`))

	// T0 — preview. Capture the fingerprint of {s1, c1}.
	fpBefore, idsBefore := previewFingerprint(t, web.URL, "s1")
	if len(idsBefore) != 2 {
		t.Fatalf("preview before drift: want 2 descendants [s1 c1], got %v", idsBefore)
	}

	// DRIFT — a subagent spawns under s1 between preview and commit.
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c2","parentID":"s1","title":"child2"}}`))

	// T1 — commit with the STALE fingerprint.
	status, body := postDeleteFP(t, web.URL, "s1", fpBefore)
	if status != http.StatusConflict {
		t.Fatalf("drift commit: got %d, want 409 (no delete performed)", status)
	}
	if body["ok"] != false || body["error"] != "descendants_changed" {
		t.Fatalf("409 body: got %v, want {ok:false, error:descendants_changed}", body)
	}
	cur, _ := body["current"].(map[string]any)
	if cur == nil || cur["fingerprint"] == fpBefore {
		t.Fatalf("409 current must carry a NEW fingerprint, got %v", body)
	}
	if affected, _ := cur["affected"].([]any); !containsAny(affected, "c2") {
		t.Fatalf("409 current.affected must include spawned c2, got %v", affected)
	}

	// NO-DELETE PROOF — nothing was DELETEed and the sessions are still live.
	if calls := deleteIDCalls(f); len(calls) != 0 {
		t.Fatalf("drift must delete NOTHING — DeleteSession DELETEs fired: %v", calls)
	}
	if got := agg.Store().Descendants("s1"); len(got) != 3 {
		t.Fatalf("drift must NOT remove sessions — Descendants(s1) want 3, got %v", got)
	}
}

// TestDeleteDrift_MatchingFingerprint_Deletes is the happy path: no drift → the
// fingerprint matches → 200 + delete proceeds normally (fence is transparent).
func TestDeleteDrift_MatchingFingerprint_Deletes(t *testing.T) {
	f := &fakeOC{}
	web, agg, srv, _ := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1","title":"root"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c1","parentID":"s1"}}`))

	fp, _ := previewFingerprint(t, web.URL, "s1")

	status, body := postDeleteFP(t, web.URL, "s1", fp)
	if status != http.StatusOK {
		t.Fatalf("matching-fingerprint commit: got %d, want 200", status)
	}
	affected, _ := body["affected"].([]any)
	if len(affected) != 2 || !containsAny(affected, "s1") || !containsAny(affected, "c1") {
		t.Fatalf("matching-fingerprint affected: want [s1 c1], got %v", affected)
	}
	if calls := deleteIDCalls(f); len(calls) != 2 {
		t.Fatalf("matching fingerprint: want 2 DeleteSession calls, got %v", calls)
	}
	if agg.Store().Descendants("s1") != nil {
		t.Fatal("matching fingerprint: sessions must be removed from the live store")
	}
}

// toAny converts a []string to []any for the shared containsAny helper.
func toAny(xs []string) []any {
	out := make([]any, len(xs))
	for i, x := range xs {
		out[i] = x
	}
	return out
}
