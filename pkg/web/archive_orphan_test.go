package web

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"
)

// ISSUE 5 — a genuine orphan (parent absent from the live tree) must be
// archivable. Two failure modes were identified by code reading:
//
//  1. Descendants(id) returns nil when the session isn't in the server store
//     (e.g. pruned by a prior cascade or demotion) → affected=nil → no
//     SetArchived, no RemoveSessions, response affected=null → client gets
//     [] → nothing pruned, the banner stays.
//
//  2. SetArchived returns non-200 (OpenCode rejecting a modify on an
//     archived-tree member, or the session being a ghost) → http.Error 502 →
//     archiveSession throws → the dialog is stuck, nothing archived.
//
// The fix: (a) fall back to [body.SessionID] when Descendants is empty, and
// (b) tolerate ONLY 404/410 (session verifiably gone — a ghost or already
// cascade-deleted by OpenCode) in the SetArchived loop so RemoveSessions
// still prunes the tree. All other non-2xx statuses (400/401/403/409/429/5xx/
// network) abort with 502 so a still-live session's queue state is preserved.

// postArchive is a helper that POSTs /vh/archive and returns the response +
// decoded affected list.
func postArchive(t *testing.T, url, id string) (*http.Response, []string) {
	t.Helper()
	resp := csrfPost(t, url+"/vh/archive", map[string]any{"sessionID": id})
	var j struct {
		OK       bool     `json:"ok"`
		Affected []string `json:"affected"`
	}
	json.NewDecoder(resp.Body).Decode(&j)
	resp.Body.Close()
	return resp, j.Affected
}

// TestArchiveOrphan_InStoreSucceeds: an orphan (parentID absent from the
// store) is in the live store. handleArchive must archive it, remove it from
// the store, and set the tombstone.
func TestArchiveOrphan_InStoreSucceeds(t *testing.T) {
	f := &fakeOC{}
	web, agg, _, _ := queueLifecycleServer(t, f)
	// Seed an orphan: parent "root" is never inserted, so "orphan" is
	// genuinely parentless in the store.
	agg.Store().Apply(ev("session.created", `{"info":{"id":"orphan","parentID":"root"}}`))
	if agg.Store().Descendants("orphan") == nil {
		t.Fatal("precondition: orphan must be in the live store")
	}

	resp, affected := postArchive(t, web.URL, "orphan")
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive orphan: got %d, want 200", resp.StatusCode)
	}
	if len(affected) != 1 || affected[0] != "orphan" {
		t.Fatalf("affected: got %v, want [orphan]", affected)
	}
	// Must be removed from the live store.
	if agg.Store().Descendants("orphan") != nil {
		t.Error("orphan still in store after archive; RemoveSessions should have pruned it")
	}
	// Tombstone must be set (holds against resurrection during the window).
	if !agg.Store().IsRecentlyArchived("orphan") {
		t.Error("orphan not tombstoned after archive")
	}
	// SetArchived must have been called for the orphan.
	patches := archivedPATCHes(f)
	if countID(patches, "orphan") < 1 {
		t.Fatalf("SetArchived not called for orphan; all PATCHes: %v", patches)
	}
}

// TestArchiveOrphan_NotInStoreFallback: the requested session is NOT in the
// server store (pruned by a prior cascade/demotion). handleArchive must fall
// back to [body.SessionID], call SetArchived for it, and return it in affected
// so the client can prune.
func TestArchiveOrphan_NotInStoreFallback(t *testing.T) {
	f := &fakeOC{}
	web, agg, _, _ := queueLifecycleServer(t, f)
	// "ghost" is never seeded → Descendants returns nil.

	resp, affected := postArchive(t, web.URL, "ghost")
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive ghost: got %d, want 200", resp.StatusCode)
	}
	if len(affected) != 1 || affected[0] != "ghost" {
		t.Fatalf("affected: got %v, want [ghost] (fallback to body.SessionID)", affected)
	}
	// SetArchived must have been attempted for "ghost" even though it's not in
	// the store — the fallback populates affected=[ghost] and the loop runs.
	patches := archivedPATCHes(f)
	if countID(patches, "ghost") < 1 {
		t.Fatalf("SetArchived not called for ghost; all PATCHes: %v", patches)
	}
	// Tombstone must be set regardless (RemoveSessions always tombstones).
	if !agg.Store().IsRecentlyArchived("ghost") {
		t.Error("ghost not tombstoned after archive")
	}
}

// TestArchiveOrphan_ToleratesGoneStatus: SetArchived returns 404 (the session
// is a ghost or was already cascade-deleted by OpenCode). The archive must NOT
// abort — it logs the error, continues, and RemoveSessions still fires so the
// tree is pruned and the tombstone is set. 410 (Gone) is treated the same.
func TestArchiveOrphan_ToleratesGoneStatus(t *testing.T) {
	withReassertDelay(t, 5*time.Millisecond) // shrink so the goroutine settles fast
	f := &fakeOC{archiveStatus: http.StatusNotFound}
	web, agg, _, _ := queueLifecycleServer(t, f)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"orphan","parentID":"root"}}`))
	if agg.Store().Descendants("orphan") == nil {
		t.Fatal("precondition: orphan must be in the live store")
	}

	resp, affected := postArchive(t, web.URL, "orphan")
	// MUST be 200, NOT 502 — the 404 means the session is verifiably gone, so
	// the loop continues past the failed SetArchived.
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive with 404 SetArchived: got %d, want 200 (gone tolerated)", resp.StatusCode)
	}
	if len(affected) != 1 || affected[0] != "orphan" {
		t.Fatalf("affected: got %v, want [orphan]", affected)
	}
	// Must STILL be removed from the store despite the SetArchived failure.
	if agg.Store().Descendants("orphan") != nil {
		t.Error("orphan still in store after archive; RemoveSessions should fire for gone status")
	}
	// Tombstone must be set.
	if !agg.Store().IsRecentlyArchived("orphan") {
		t.Error("orphan not tombstoned after best-effort archive")
	}
	// SetArchived must have been attempted (and failed with 404, but the loop ran).
	patches := archivedPATCHes(f)
	if countID(patches, "orphan") < 1 {
		t.Fatalf("SetArchived not called for orphan; all PATCHes: %v", patches)
	}
}

// TestArchiveOrphan_NonGoneStatusAborts: SetArchived returns 409 (Conflict) —
// the session IS still live in OpenCode. The archive MUST abort with 502 so
// RemoveSessions and CleanupSession (queue deletion) do NOT fire. This locks
// the boundary: only 404/410 are tolerated; everything else preserves the
// queue state. Same expectation for 400/401/403/429/5xx/network.
func TestArchiveOrphan_NonGoneStatusAborts(t *testing.T) {
	withReassertDelay(t, 5*time.Millisecond)
	f := &fakeOC{archiveStatus: http.StatusConflict} // 409
	web, agg, _, root := queueLifecycleServer(t, f)
	seedQueueFile(t, root, "orphan")
	agg.Store().Apply(ev("session.created", `{"info":{"id":"orphan","parentID":"root"}}`))

	resp, _ := postArchive(t, web.URL, "orphan")
	// MUST be 502 — the session is still live (409 conflict), so the archive
	// aborts to preserve the queue.
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("/vh/archive with 409 SetArchived: got %d, want 502 (abort)", resp.StatusCode)
	}
	// Must STILL be in the store — RemoveSessions must NOT have fired.
	if agg.Store().Descendants("orphan") == nil {
		t.Error("orphan removed from store after aborted archive; RemoveSessions should NOT fire")
	}
	// Queue state must survive — CleanupSession must NOT have fired. Poll the
	// negative condition across a short window (mirrors the existing
	// TestQueueGC_FailedArchivePreservesQueue pattern) so a delayed stray
	// cleanup surfaces as a failure.
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		if !queueFileExists(root, "orphan") {
			t.Fatalf("409 archive must NOT delete queue.json (CleanupSession fired)")
		}
		time.Sleep(10 * time.Millisecond)
	}
}
