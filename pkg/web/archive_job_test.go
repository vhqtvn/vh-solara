package web

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"sort"
	"sync/atomic"
	"testing"
	"time"
)

// Archive cascade job (Defect 1 fix) — server-owned background job that
// survives mobile disconnect, retries transient per-id failures, resumes
// idempotently, retains failed ids, and hands stuck stragglers to the orphan
// banner (Slices 1/2) instead of silently dropping them.
//
// These tests (RT1a–RT1d) model the cascade job the way archive_reassert_test.go
// models the re-assert: a fakeOC + queueLifecycleServer + per-id failure
// injection. awaitArchiveJobs is the deterministic wait for the bg job to reach
// terminal state (the cascade is async — POST returns before RemoveSessions /
// Cleanup run).

// awaitArchiveJobs polls the Server's in-flight archive-job counter until it
// reaches zero (no cascade job active) or fails the test on timeout. Test-only
// seam: production never awaits inline. The cascade is async, so a test that
// asserts side-effects (store removal, queue cleanup, orphan flag) MUST wait
// for the job to finish first.
func (s *Server) awaitArchiveJobs(tb testing.TB, timeout time.Duration) {
	tb.Helper()
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if atomic.LoadInt64(&s.archiveJobsActive) == 0 {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	tb.Fatalf("archive cascade job still active after %v", timeout)
}

// archiveCtxPost POSTs /vh/archive with a CALLER-SUPPLIED request context (so a
// test can cancel the request context after the handler accepts, modelling a
// mobile disconnect mid-cascade — RT1b). Returns the response without decoding
// the body (the caller closes it).
func archiveCtxPost(t *testing.T, url, id string, reqCtx context.Context) *http.Response {
	t.Helper()
	body, _ := json.Marshal(map[string]any{"sessionID": id})
	req, err := http.NewRequestWithContext(reqCtx, http.MethodPost, url+"/vh/archive", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-VH-CSRF", "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// RT1a — a transient failure injected at a middle descendant of an M-descendant
// cascade is RETRIED to completion: every id reaches archived in OpenCode, is
// RemoveSessions'd, and has its queue cleaned. This proves the bounded retry
// (decision C) actually drives a transiently-failing id to success rather than
// aborting the whole cascade (the prior behavior).
func TestArchiveJob_RetriesTransientFailureToCompletion(t *testing.T) {
	// 3-descendant cascade: root r + c1 + c2. Inject 2 transient (500) failures
	// on c1 (a middle id). The job must retry c1 to success.
	f := &fakeOC{archiveFailNext: map[string]int{"c1": 2}}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetArchiveRetryConfig(5, 1*time.Millisecond, 4*time.Millisecond)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c1","parentID":"r"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c2","parentID":"r"}}`))
	seedQueueFile(t, root, "r")
	seedQueueFile(t, root, "c1")
	seedQueueFile(t, root, "c2")
	// Report all three as archived so the re-assert phase is a no-op (cleaner
	// patch-count assertions — reassert skips ids already in the list).
	f.listSessionsReply = []byte(`[{"id":"r","time":{"archived":1}},{"id":"c1","time":{"archived":1}},{"id":"c2","time":{"archived":1}}]`)

	resp, affected := postArchive(t, web.URL, "r")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive: got %d, want 200 (job accepted)", resp.StatusCode)
	}
	if len(affected) != 3 {
		t.Fatalf("affected: got %v, want 3 ids", affected)
	}
	srv.awaitArchiveJobs(t, 5*time.Second)

	patches := archivedPATCHes(f)
	// Every id was PATCHed at least once (archived in OpenCode).
	for _, id := range []string{"r", "c1", "c2"} {
		if countID(patches, id) < 1 {
			t.Errorf("id %s never PATCHed (all=%v)", id, patches)
		}
	}
	// c1 was retried: 2 injected transient failures + 1 success = 3 PATCHes
	// (the reassert is a no-op because listSessionsReply reports it archived).
	if n := countID(patches, "c1"); n != 3 {
		t.Errorf("c1 PATCH count: got %d, want 3 (2 transient + 1 success; reassert no-op)", n)
	}
	// Every id was removed from the live store (RemoveSessions per success).
	for _, id := range []string{"r", "c1", "c2"} {
		if agg.Store().Descendants(id) != nil {
			t.Errorf("id %s still in live store after archive (not RemoveSessions'd)", id)
		}
	}
	// Every id's queue was cleaned (CleanupSession per success).
	for _, id := range []string{"r", "c1", "c2"} {
		if queueFileExists(root, id) {
			t.Errorf("queue.json for %s still present after archive (not cleaned)", id)
		}
	}
}

// RT1b — THE CRUX of Defect 1: cancelling the REQUEST context (mobile
// screen-off) AFTER the handler accepts must NOT cancel the cascade. The job
// runs under the Server's bgCtx, not r.Context(), so it completes despite the
// request going away. Under the prior request-bound loop, a mid-cascade
// disconnect aborted the whole sweep, leaving stragglers with no recovery.
//
// To prove the crux at the cancellation boundary (not merely infer it), the bg
// job is PINNED mid-flight: archiveBlockCh holds the first SetArchived call
// inside the goroutine while archiveReachedCh confirms the job has REACHED it.
// The request context is cancelled exactly then — with the cascade demonstrably
// in-flight — then the job is released and must still complete.
func TestArchiveJob_SurvivesRequestCancellation(t *testing.T) {
	f := &fakeOC{}
	f.archiveBlockCh = make(chan struct{})
	f.archiveReachedCh = make(chan struct{}, 1)
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c1","parentID":"r"}}`))
	seedQueueFile(t, root, "r")
	seedQueueFile(t, root, "c1")

	// POST with a cancellable request context. The handler accepts (200) and
	// dispatches the bg job, which reaches SetArchived(r) and blocks.
	reqCtx, reqCancel := context.WithCancel(context.Background())
	resp := archiveCtxPost(t, web.URL, "r", reqCtx)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive: got %d, want 200 (job accepted)", resp.StatusCode)
	}
	// Confirm the bg job is IN-FLIGHT: it has reached the first SetArchived call
	// and is now blocked inside it (not yet finished, not raced ahead).
	select {
	case <-f.archiveReachedCh:
		// good — the cascade is demonstrably mid-flight on id r
	case <-time.After(3 * time.Second):
		t.Fatalf("bg archive job never reached a blocked SetArchived (archiveReachedCh not signaled)")
	}
	// Mobile disconnect: cancel the REQUEST context WHILE the cascade is
	// in-flight. The job (under bgCtx) must NOT be cancelled by this.
	reqCancel()
	// Release the pinned SetArchived so the cascade can proceed.
	close(f.archiveBlockCh)

	srv.awaitArchiveJobs(t, 5*time.Second)
	// The cascade completed despite the request cancellation: both ids were
	// PATCHed, removed from the store, and their queues cleaned.
	patches := archivedPATCHes(f)
	if countID(patches, "r") < 1 || countID(patches, "c1") < 1 {
		t.Fatalf("cascade did not PATCH both ids (request cancel killed the job?): %v", patches)
	}
	for _, id := range []string{"r", "c1"} {
		if agg.Store().Descendants(id) != nil {
			t.Errorf("id %s still in live store (cascade did not complete after request cancel)", id)
		}
		if queueFileExists(root, id) {
			t.Errorf("queue.json for %s still present (cascade did not complete after request cancel)", id)
		}
	}
}

// RT1c — a PERMANENT failure (403) on a DESCENDANT id whose parent was archived:
// after the job, the descendant REMAINS live (retain-on-failure) and is NOT
// recorded as a root job failure (it is a descendant-of-archived → left for the
// orphan sweep). Once the authoritative archived snapshot reflects the archived
// parent (the 5s reconcile in production), the Slice 1/2 sweep flags it
// orphan → IsOrphanFlagged becomes true. This is the stuck-handoff recovery
// path (decision 6, DESCENDANT case).
func TestArchiveJob_PermanentFailureOnDescendant_BecomesOrphan(t *testing.T) {
	// r (root) + c1 (child). c1 always returns 403 (permanent). r succeeds.
	f := &fakeOC{archiveStatusByID: map[string]int{"c1": http.StatusForbidden}}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetArchiveRetryConfig(3, 1*time.Millisecond, 2*time.Millisecond)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c1","parentID":"r"}}`))
	seedQueueFile(t, root, "r")
	seedQueueFile(t, root, "c1")
	// Prime the authoritative snapshot so the job's classify step sees r as an
	// archived parent: when c1 fails AFTER r is RemoveSessions'd, c1's chain
	// (c1→r, r absent from live store, r present in snapshot) terminates at an
	// archived root → classified DESCENDANT (left for sweep, not recorded as a
	// root failure). r is still LIVE here, so this prime does NOT yet flag c1
	// (chainTerminatesAtArchived walks the live store first).
	agg.Store().RefreshArchivedSnapshot([]json.RawMessage{
		json.RawMessage(`{"id":"r","time":{"archived":1}}`),
	})

	resp, _ := postArchive(t, web.URL, "r")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive: got %d, want 200 (job accepted)", resp.StatusCode)
	}
	srv.awaitArchiveJobs(t, 5*time.Second)

	// r succeeded → removed + queue cleaned.
	if agg.Store().Descendants("r") != nil {
		t.Error("r still in live store (should be archived)")
	}
	if queueFileExists(root, "r") {
		t.Error("r queue.json still present (should be cleaned on success)")
	}
	// c1 FAILED permanently → retain-on-failure: stays live + queue survives.
	if agg.Store().Descendants("c1") == nil {
		t.Error("c1 removed from live store after FAILED archive (must be retained)")
	}
	if !queueFileExists(root, "c1") {
		t.Error("c1 queue.json deleted after FAILED archive (retain-on-failure violated)")
	}
	// c1 is a DESCENDANT of archived r (snapshot primed) → NOT recorded as a
	// root job failure (the orphan banner surfaces it instead).
	for _, fail := range srv.ArchiveFailures() {
		if fail.ID == "c1" {
			t.Errorf("c1 recorded as a root job failure (should be left for orphan sweep): %+v", fail)
		}
	}
	// c1 is not YET orphan-flagged (the sweep last ran at the prime, when r was
	// still live). Simulate the 5s reconcile refreshing the snapshot now that r
	// is archived → the sweep re-evaluates c1 and flags it.
	if agg.Store().IsOrphanFlagged("c1") {
		t.Error("c1 orphan-flagged prematurely (sweep should not have run since r left)")
	}
	agg.Store().RefreshArchivedSnapshot([]json.RawMessage{
		json.RawMessage(`{"id":"r","time":{"archived":1}}`),
	})
	if !agg.Store().IsOrphanFlagged("c1") {
		t.Error("c1 not orphan-flagged after snapshot refresh (sweep must flag the descendant of archived r)")
	}
}

// RT1d — a PERMANENT failure (403) on a ROOT id: after the job, the root
// REMAINS live (retain-on-failure) and is NEVER orphan-flagged (a root's chain
// terminates at a live root, not an archived parent — the e88f19e false-positive
// gate). It is recorded as an EXPLICIT job failure (the build-validate-4
// operator-visibility surface) so a stuck root is surfaced, not silently
// dropped, and not fabricated as an orphan.
func TestArchiveJob_PermanentFailureOnRoot_RecordedNotOrphaned(t *testing.T) {
	// r (root, no parent) always returns 403 (permanent).
	f := &fakeOC{archiveStatusByID: map[string]int{"r": http.StatusForbidden}}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetArchiveRetryConfig(3, 1*time.Millisecond, 2*time.Millisecond)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	seedQueueFile(t, root, "r")

	resp, _ := postArchive(t, web.URL, "r")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive: got %d, want 200 (job accepted)", resp.StatusCode)
	}
	srv.awaitArchiveJobs(t, 5*time.Second)

	// r FAILED permanently → retain-on-failure: stays live + queue survives.
	if agg.Store().Descendants("r") == nil {
		t.Error("r removed from live store after FAILED archive (must be retained)")
	}
	if !queueFileExists(root, "r") {
		t.Error("r queue.json deleted after FAILED archive (retain-on-failure violated)")
	}
	// r is a ROOT → NEVER orphan-flagged (e88f19e false-positive gate), even
	// after a snapshot refresh.
	if agg.Store().IsOrphanFlagged("r") {
		t.Error("r orphan-flagged (a root must NEVER be orphan-flagged)")
	}
	agg.Store().RefreshArchivedSnapshot(nil)
	if agg.Store().IsOrphanFlagged("r") {
		t.Error("r orphan-flagged after snapshot refresh (a root must NEVER be orphan-flagged)")
	}
	// r is recorded as an EXPLICIT job failure (operator-visibility surface).
	fails := srv.ArchiveFailures()
	found := false
	for _, fl := range fails {
		if fl.ID == "r" {
			found = true
		}
	}
	if !found {
		t.Errorf("r not recorded in ArchiveFailures (stuck root must surface explicitly): %+v", fails)
	}
}

// RT1c-noprime (F1 regression — reviewer tier1_b-F1): same as RT1c but WITHOUT
// pre-priming the archived snapshot. The job archives r (succeeded set gains r),
// then c1 fails permanently. At classify time, ChainTerminatesAtArchived(c1)
// returns false (r is already RemoveSessionIfPresent'd from the live store and
// NOT yet in the authoritative snapshot). The F1 fix's descendantOfSucceeded
// path walks the ORIGINAL captured parentOf chain (c1→r) and finds r in the
// succeeded set → classifies c1 as a descendant-of-archived → left live, NOT
// recorded as a root failure. Without the fix, c1 would be misclassified as a
// root/unresolvable failure and recorded in ArchiveFailures (the exact defect
// the reviewer flagged).
func TestArchiveJob_DescendantFailureRecognizedViaJobSucceededSet(t *testing.T) {
	f := &fakeOC{archiveStatusByID: map[string]int{"c1": http.StatusForbidden}}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetArchiveRetryConfig(3, 1*time.Millisecond, 2*time.Millisecond)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c1","parentID":"r"}}`))
	seedQueueFile(t, root, "r")
	seedQueueFile(t, root, "c1")
	// NO RefreshArchivedSnapshot — the snapshot is EMPTY. This is the F1
	// regression scenario: the job's own succeeded set + captured parent chain
	// must recognize c1 as a descendant of r (archived moments ago by this job).

	resp, _ := postArchive(t, web.URL, "r")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive: got %d, want 200", resp.StatusCode)
	}
	srv.awaitArchiveJobs(t, 5*time.Second)

	// r succeeded → removed + queue cleaned.
	if agg.Store().Descendants("r") != nil {
		t.Error("r still in live store (should be archived)")
	}
	if queueFileExists(root, "r") {
		t.Error("r queue.json still present (should be cleaned on success)")
	}
	// c1 FAILED permanently → retain-on-failure: stays live + queue survives.
	if agg.Store().Descendants("c1") == nil {
		t.Error("c1 removed from live store after FAILED archive (must be retained)")
	}
	if !queueFileExists(root, "c1") {
		t.Error("c1 queue.json deleted after FAILED archive (retain-on-failure violated)")
	}
	// F1 crux: c1 is NOT recorded as a root job failure — the succeeded-set
	// path (descendantOfSucceeded via the captured parentOf chain) recognized it
	// as a descendant of r archived by THIS job. Without the F1 fix, c1 would be
	// in ArchiveFailures (the misclassification defect).
	for _, fail := range srv.ArchiveFailures() {
		if fail.ID == "c1" {
			t.Errorf("c1 recorded as root failure (F1 fix failed — succeeded-set path missed it): %+v", fail)
		}
	}
	// After the snapshot reconciles (r enters the snapshot), the sweep flags
	// c1 as an orphan — the recovery path works end-to-end.
	agg.Store().RefreshArchivedSnapshot([]json.RawMessage{
		json.RawMessage(`{"id":"r","time":{"archived":1}}`),
	})
	if !agg.Store().IsOrphanFlagged("c1") {
		t.Error("c1 not orphan-flagged after snapshot refresh (recovery path broken)")
	}
}

// RT1-concurrent (F2 regression — reviewer tier1_b-F2): two /vh/archive requests
// accepted before the first detached job removes the live subtree launch
// independent background jobs over the same id. Without the CAS gate, both jobs
// call CleanupSession → double queue-cleanup. The F2 fix (RemoveSessionIfPresent
// returns true only for the job that actually deleted the id) ensures exactly
// one job owns the cleanup. This test forces the overlap via archiveBlockCh and
// asserts the CAS prevents doubling.
func TestArchiveJob_ConcurrentReissueNoDoubleCleanup(t *testing.T) {
	f := &fakeOC{}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	seedQueueFile(t, root, "r")

	// Block SetArchived OUTSIDE f.mu so both jobs' PATCH calls overlap at the
	// CAS window (both past SetArchived, both about to call RemoveSessionIfPresent).
	f.archiveBlockCh = make(chan struct{})

	// Issue two concurrent requests. Both handlers accept (200) and dispatch bg
	// jobs; both jobs block at SetArchived(r).
	resp1, _ := postArchive(t, web.URL, "r")
	resp1.Body.Close()
	resp2, _ := postArchive(t, web.URL, "r")
	resp2.Body.Close()

	// Release both jobs — they race through SetArchived → RemoveSessionIfPresent.
	close(f.archiveBlockCh)
	srv.awaitArchiveJobs(t, 5*time.Second)

	// Both jobs PATCHed r (concurrency proven — two independent bg jobs ran).
	patches := archivedPATCHes(f)
	if n := countID(patches, "r"); n < 2 {
		t.Errorf("r PATCHed only %d time(s), want >= 2 (both jobs must run concurrently)", n)
	}
	// r removed from the live store (correct end state — one job won the CAS).
	if agg.Store().Descendants("r") != nil {
		t.Error("r still in live store after concurrent archive")
	}
	// Queue cleaned (correct end state).
	if queueFileExists(root, "r") {
		t.Error("r queue.json still present after concurrent archive")
	}
	// CAS guarantee: CleanupSession was NOT called twice by the two jobs. With
	// the CAS, exactly one job's RemoveSessionIfPresent(r) returned true → one
	// job-direct CleanupSession; the async subscriber adds at most one more →
	// total <= 2. Without the CAS, both jobs call CleanupSession directly →
	// total >= 3 (2 direct + 1 subscriber). Brief settle for the async subscriber.
	stableDeadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(stableDeadline) {
		time.Sleep(50 * time.Millisecond)
	}
	if got := srv.queues.CleanupCallCount(); got > 2 {
		t.Errorf("CleanupSession called %d times for r, want <= 2 (CAS should prevent double job-direct cleanup; without CAS would be >= 3)", got)
	}
}

// RT4-partial-resume — THE CRUX of this slice (Slice 4): re-issuing /vh/archive
// on a PARTIALLY-archived root (root itself already archived + absent from the
// live store, but with remaining LIVE descendants) completes the remainder.
// Before this slice, Descendants(root) returned nil (root pruned from live store)
// → the fallback made affected=[root] → the job re-PATCHed the already-archived
// root (a no-op) and the live stragglers were left behind (caught only by the
// orphan banner from Slices 1/2, not by the operator's named recovery path).
//
// The fix (resumeArchiveAffected): when Descendants(root) is nil, fetch
// OpenCode's authoritative lists, confirm the root is archived, derive the LIVE
// subtree, and make those stragglers the job's affected set.
//
// Seed: root r archived in OpenCode AND removed from the live store (simulating
// a prior partial cascade). Live child c (parentID=r) + live grandchild g
// (parentID=c, proves depth through a live intermediate). Unrelated live root
// "other" + its live child "otherC" (exact-subtree proof — the e88f19e spirit:
// never touch an unrelated live session).
func TestArchiveJob_ReissueOnPartiallyArchivedRootCompletesRemainder(t *testing.T) {
	f := &fakeOC{}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)

	// Seed the live store: r (root), c (child of r), g (grandchild of r via c),
	// and the unrelated other (root) + otherC (child of other).
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c","parentID":"r"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"g","parentID":"c"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"other"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"otherC","parentID":"other"}}`))

	// Seed queues for the stragglers + the unrelated pair (NOT for r — its queue
	// was cleaned by the prior archive that removed it).
	seedQueueFile(t, root, "c")
	seedQueueFile(t, root, "g")
	seedQueueFile(t, root, "other")
	seedQueueFile(t, root, "otherC")

	// Simulate the prior partial cascade: r was archived (PATCHed in OpenCode)
	// and removed from the live store (RemoveSessionIfPresent), but c and g were
	// left LIVE (the cascade aborted before reaching them — the defect). This is
	// the EXACT state the orphan banner from Slices 1/2 surfaces; this test
	// proves the operator's named recovery path (re-issue /vh/archive {r}) now
	// completes them instead of just re-PATCHing the already-archived root.
	agg.Store().RemoveSessionIfPresent("r")

	// Configure the fakeOC's authoritative lists to mirror the real OpenCode
	// split (pkg/fixtures/opencode.go:929-937): /session returns LIVE-only,
	// /session?archived=true returns ARCHIVED-only.
	//
	// LIVE list: c, g, other, otherC (all time.archived absent → live). r is NOT
	// here (it's archived). The resume helper fetches this to find the stragglers.
	f.listSessionsReply = []byte(`[
		{"id":"c","parentID":"r"},
		{"id":"g","parentID":"c"},
		{"id":"other"},
		{"id":"otherC","parentID":"other"}
	]`)
	// ARCHIVED list: r (time.archived set). The resume helper fetches this to
	// confirm the root is archived AND to link archived intermediates (none here,
	// but the helper traverses them if present — proven by g reaching through c).
	f.listArchivedReply = []byte(`[{"id":"r","time":{"archived":1}}]`)

	// THE ACTION: re-issue /vh/archive {r} on the partially-archived root.
	resp, affected := postArchive(t, web.URL, "r")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive reissue on partially-archived root: got %d, want 200", resp.StatusCode)
	}

	// The response's affected must be exactly {c, g} — the derived LIVE
	// stragglers. NOT r (already archived, excluded from the live set). NOT
	// other/otherC (unrelated subtree — the e88f19e exact-subtree gate).
	sort.Strings(affected)
	want := []string{"c", "g"}
	sort.Strings(want)
	if len(affected) != len(want) || affected[0] != want[0] || affected[len(affected)-1] != want[len(want)-1] {
		t.Fatalf("reissue affected: got %v, want %v (live stragglers of archived r only)", affected, want)
	}

	srv.awaitArchiveJobs(t, 5*time.Second)

	// CRUX — the stragglers were completed: PATCHed SetArchived in OpenCode,
	// removed from the live store, queue-cleaned.
	patches := archivedPATCHes(f)
	for _, id := range []string{"c", "g"} {
		if countID(patches, id) < 1 {
			t.Errorf("straggler %s never PATCHed (resume did not complete it): patches=%v", id, patches)
		}
		if agg.Store().Descendants(id) != nil {
			t.Errorf("straggler %s still in live store (not RemoveSessionIfPresent'd)", id)
		}
		if queueFileExists(root, id) {
			t.Errorf("straggler %s queue.json still present (not cleaned)", id)
		}
	}

	// EXACT-SUBTREE GATE (e88f19e spirit) — the unrelated live root + its child
	// were NOT touched: never PATCHed, still in the live store, queues survive.
	for _, id := range []string{"other", "otherC"} {
		if countID(patches, id) != 0 {
			t.Errorf("unrelated %s PATCHed (exact-subtree gate violated): patches=%v", id, patches)
		}
		if agg.Store().Descendants(id) == nil {
			t.Errorf("unrelated %s removed from live store (must not be touched)", id)
		}
		if !queueFileExists(root, id) {
			t.Errorf("unrelated %s queue.json removed (must survive — not in affected)", id)
		}
	}

	// r (the already-archived root) was NOT re-PATCHed by the resume path — it
	// is excluded from the derived live set (cur != rootID gate). The prior
	// fallback would have re-PATCHed it; the resume path correctly skips it.
	if countID(patches, "r") != 0 {
		t.Errorf("already-archived root r re-PATCHed by resume path (should be excluded from live set): patches=%v", patches)
	}
}

// RT4-archived-intermediate — closes the "both lists required" coverage gap
// (commit-review F1, raised by 3 of 4 leaves): the load-bearing reason the
// resume helper fetches BOTH ListSessions (live) AND ListArchivedSessions
// (archived) is that a live straggler's parent chain may pass through an
// ARCHIVED intermediate — and the live list alone lacks that intermediate's
// parentID to link the straggler to the root. The prior test
// (TestArchiveJob_ReissueOnPartiallyArchivedRootCompletesRemainder) reaches
// grandchild g through a LIVE intermediate c; the live list alone suffices
// there, so the archived-list-as-intermediate-linker mechanism is dormant.
//
// This test exercises the dormant path: root r (archived) → intermediate m
// (ARCHIVED, parentID=r) → grandchild g (LIVE, parentID=m). g is reachable from
// r ONLY because the archived list supplies the r→m edge and the live list
// supplies the m→g edge. If the helper dropped the archived param, g would be
// unreachable (m is absent from the live list → g looks like an unrelated root
// in the live-only map) and the test would fail.
func TestArchiveJob_ReissueReachesStragglerThroughArchivedIntermediate(t *testing.T) {
	f := &fakeOC{}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)

	// Seed: r (root), m (intermediate child of r), g (grandchild of r via m),
	// and an unrelated live root other (exact-subtree gate).
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"m","parentID":"r"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"g","parentID":"m"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"other"}}`))

	seedQueueFile(t, root, "g")
	seedQueueFile(t, root, "other")

	// Prior partial cascade: r AND m were archived + removed from the live
	// store, but g (a grandchild) was left LIVE. m is an ARCHIVED intermediate.
	agg.Store().RemoveSessionIfPresent("r")
	agg.Store().RemoveSessionIfPresent("m")

	// LIVE list: g (parentID=m) + other. r and m are NOT here (both archived).
	// g's parentID points at m, which is NOT in the live list — so a live-only
	// walk from r reaches nothing. The archived list below is what links r→m→g.
	f.listSessionsReply = []byte(`[
		{"id":"g","parentID":"m"},
		{"id":"other"}
	]`)
	// ARCHIVED list: r (root, archived) + m (intermediate, archived, parentID=r).
	// The m→r edge here is what lets the DFS walk r→m, and the m entry (via its
	// presence in the unified map) is what links to g (from the live list). BOTH
	// fetches are load-bearing: drop either and g becomes unreachable from r.
	f.listArchivedReply = []byte(`[
		{"id":"r","time":{"archived":1}},
		{"id":"m","parentID":"r","time":{"archived":1}}
	]`)

	// Re-issue /vh/archive {r}.
	resp, affected := postArchive(t, web.URL, "r")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive reissue through archived intermediate: got %d, want 200", resp.StatusCode)
	}

	// affected must be exactly [g] — the live grandchild behind an archived
	// intermediate. NOT r/m (already archived). NOT other (unrelated subtree).
	sort.Strings(affected)
	if len(affected) != 1 || affected[0] != "g" {
		t.Fatalf("reissue affected through archived intermediate: got %v, want [g] (the live straggler reachable only via archived intermediate m)", affected)
	}

	srv.awaitArchiveJobs(t, 5*time.Second)

	// CRUX — g was completed: PATCHed, removed from store, queue cleaned.
	patches := archivedPATCHes(f)
	if countID(patches, "g") < 1 {
		t.Errorf("straggler g (behind archived intermediate m) never PATCHed: patches=%v", patches)
	}
	if agg.Store().Descendants("g") != nil {
		t.Errorf("straggler g still in live store (not RemoveSessionIfPresent'd)")
	}
	if queueFileExists(root, "g") {
		t.Errorf("straggler g queue.json still present (not cleaned)")
	}

	// EXACT-SUBTREE GATE — the unrelated live root was NOT touched.
	if countID(patches, "other") != 0 {
		t.Errorf("unrelated other PATCHed (exact-subtree gate violated): patches=%v", patches)
	}
	if agg.Store().Descendants("other") == nil {
		t.Errorf("unrelated other removed from live store (must not be touched)")
	}
	if !queueFileExists(root, "other") {
		t.Errorf("unrelated other queue.json removed (must survive)")
	}

	// r and m (already archived) were NOT re-PATCHed by the resume path.
	for _, id := range []string{"r", "m"} {
		if countID(patches, id) != 0 {
			t.Errorf("already-archived %s re-PATCHed by resume path (should be excluded from live set): patches=%v", id, patches)
		}
	}
}
