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
	web, agg, srv, _ := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)
	// Seed an orphan: parent "root" is never inserted, so "orphan" is
	// genuinely parentless in the store.
	agg.Store().Apply(ev("session.created", `{"info":{"id":"orphan","parentID":"root"}}`))
	if agg.Store().Descendants("orphan") == nil {
		t.Fatal("precondition: orphan must be in the live store")
	}

	resp, affected := postArchive(t, web.URL, "orphan")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive orphan: got %d, want 200", resp.StatusCode)
	}
	if len(affected) != 1 || affected[0] != "orphan" {
		t.Fatalf("affected: got %v, want [orphan]", affected)
	}
	// The cascade is async — wait for the bg job to finish before asserting
	// store side-effects (POST returns 200 immediately on job acceptance).
	srv.awaitArchiveJobs(t, 5*time.Second)
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
	web, agg, srv, _ := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)
	// "ghost" is never seeded → Descendants returns nil.

	resp, affected := postArchive(t, web.URL, "ghost")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive ghost: got %d, want 200", resp.StatusCode)
	}
	if len(affected) != 1 || affected[0] != "ghost" {
		t.Fatalf("affected: got %v, want [ghost] (fallback to body.SessionID)", affected)
	}
	srv.awaitArchiveJobs(t, 5*time.Second)
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
	f := &fakeOC{archiveStatus: http.StatusNotFound}
	web, agg, srv, _ := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond) // shrink so the goroutine settles fast
	agg.Store().Apply(ev("session.created", `{"info":{"id":"orphan","parentID":"root"}}`))
	if agg.Store().Descendants("orphan") == nil {
		t.Fatal("precondition: orphan must be in the live store")
	}

	resp, affected := postArchive(t, web.URL, "orphan")
	defer resp.Body.Close()
	// MUST be 200, NOT 502 — the 404 means the session is verifiably gone, so
	// the loop continues past the failed SetArchived.
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive with 404 SetArchived: got %d, want 200 (gone tolerated)", resp.StatusCode)
	}
	if len(affected) != 1 || affected[0] != "orphan" {
		t.Fatalf("affected: got %v, want [orphan]", affected)
	}
	srv.awaitArchiveJobs(t, 5*time.Second)
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

// TestArchiveOrphan_NonGoneStatusRetainsQueueAndSession: SetArchived returns 409
// (Conflict) — the session IS still live in OpenCode. Under the Defect 1 fix the
// handler no longer aborts synchronously (502); it ACCEPTS the job (200) and the
// background cascade handles the failure. A 409 is re-derived: the authoritative
// list does not report the id archived (fakeOC serves "[]"), so it retries under
// budget; on exhaustion the id is classified (its parent "root" is absent from
// both the live store and the snapshot → root/unresolvable → explicit failure,
// NOT orphan-flagged). The core invariant is unchanged from the prior 502 test:
// RemoveSessions and CleanupSession (queue deletion) do NOT fire for a failed
// id — the queue and the live session are retained. (409 here is representative
// of the whole non-gone class: 400/403 terminal, 429/5xx/network transient —
// all retain-on-failure; the classification per status lives in archiveOneID.)
func TestArchiveOrphan_NonGoneStatusRetainsQueueAndSession(t *testing.T) {
	f := &fakeOC{archiveStatus: http.StatusConflict} // 409 on every PATCH
	web, agg, srv, root := queueLifecycleServer(t, f)
	// Shrink the retry budget + backoff so the job reaches terminal failure in
	// milliseconds (production defaults span ~15s — fine for the field, too
	// slow for a unit test).
	srv.SetArchiveRetryConfig(3, 1*time.Millisecond, 2*time.Millisecond)
	srv.SetReassertDelay(5 * time.Millisecond)
	seedQueueFile(t, root, "orphan")
	agg.Store().Apply(ev("session.created", `{"info":{"id":"orphan","parentID":"root"}}`))

	resp, _ := postArchive(t, web.URL, "orphan")
	defer resp.Body.Close()
	// 200 — the job is accepted; the 409 failure is handled in the background.
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/vh/archive with 409 SetArchived: got %d, want 200 (job accepted; failure handled async)", resp.StatusCode)
	}
	srv.awaitArchiveJobs(t, 5*time.Second)
	// RETAIN-ON-FAILURE (the non-negotiable invariant): the failed id stays in
	// the live store and its queue survives — RemoveSessions/CleanupSession did
	// NOT fire for it.
	if agg.Store().Descendants("orphan") == nil {
		t.Error("orphan removed from store after failed archive; RemoveSessions must NOT fire on failure")
	}
	if !queueFileExists(root, "orphan") {
		t.Error("orphan queue.json deleted after failed archive; CleanupSession must NOT fire on failure (retain-on-failure)")
	}
	// SetArchived was attempted (3 retries under the shrunk budget).
	if n := countID(archivedPATCHes(f), "orphan"); n != 3 {
		t.Errorf("orphan PATCH count: got %d, want 3 (budget exhausted on 409)", n)
	}
	// "orphan" is root/unresolvable (parent "root" absent everywhere) → recorded
	// as an EXPLICIT job failure, NOT orphan-flagged (e88f19e gate).
	if agg.Store().IsOrphanFlagged("orphan") {
		t.Error("orphan flagged (a root/unresolvable id must NEVER be orphan-flagged)")
	}
	found := false
	for _, fl := range srv.ArchiveFailures() {
		if fl.ID == "orphan" {
			found = true
		}
	}
	if !found {
		t.Errorf("orphan not recorded in ArchiveFailures (stuck root must surface): %+v", srv.ArchiveFailures())
	}
}
