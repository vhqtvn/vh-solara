package web

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// FIX-QUEUE-GC-2 (Slice 2 of 5) — web-layer subscriber for normalized
// session.delete events routes through the GC-1 cleanup primitive
// (queueRegistry.deleteStore, exposed as CleanupSession). These tests cover
// the subscriber path (raw delete, archive-equivalent RemoveSessions, hydrate
// prune), the direct /vh/archive path (must clean up independently of
// subscriber delivery), their idempotent composition, the failed-archive
// guarantee (no premature cleanup), and the async subscriber model (the store
// is never blocked on filesystem I/O).
//
// Test harness: queueLifecycleServer wires a Server + temp root + chdir, so
// projectRoot("") resolves to the temp root (mirrors newQueueTestServer). The
// default aggregator's queue-GC subscriber is installed by triggering aggFor
// (the same lazy-install path the first HTTP request hits). The aggregator's
// Run loop is NOT started; tests drive the store directly via Apply /
// RemoveSessions / Hydrate, which is sufficient to fire KindSessionDelete
// through the real emit→subscriber channel.

// seedQueueFile creates <root>/.vh-solara/sessions/<sid>/queue.json with a
// minimal valid body. Returns the queue.json path.
func seedQueueFile(t *testing.T, root, sid string) string {
	t.Helper()
	p := queuePath(root, sid)
	if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(`{"order":0,"items":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	return p
}

func queueFileExists(root, sid string) bool {
	_, err := os.Stat(queuePath(root, sid))
	return err == nil
}

// queueLifecycleServer wires a Server whose default-aggregator queue-GC
// subscriber is installed, with the daemon cwd chdir'd to a temp dir so
// projectRoot("") resolves there. The returned web server is a real
// httptest.Server (POST /vh/archive exercises the full handler chain).
func queueLifecycleServer(t *testing.T, f *fakeOC) (*httptest.Server, *aggregator.Aggregator, *Server, string) {
	t.Helper()
	root := t.TempDir()
	oc := httptest.NewServer(f.handler())
	t.Cleanup(oc.Close)
	agg := aggregator.New(oc.URL, 100)
	srv, err := NewServer(agg, oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	// projectRoot("") returns os.Getwd(); chdir into root so the default
	// project resolves there (mirrors newQueueTestServer).
	t.Chdir(root)
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)
	// The queue-GC subscriber is installed lazily on the first aggFor("")
	// call. Trigger it so subsequent direct store mutations reach the
	// subscriber's channel before the test asserts.
	_ = srv.aggFor("")
	// Issue A: the Server owns the post-archive re-assert goroutine (bgWG).
	// Await it at test end so no detached goroutine outlives the test (the
	// prior fire-and-forget goroutine leaked and raced a mutable global).
	// Idempotent with any explicit Shutdown a test drives mid-run.
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})
	return web, agg, srv, root
}

// waitForQueueGone polls for the queue.json's removal — subscriber delivery
// is async via a channel-consumer goroutine, so the file removal lands shortly
// after the store emits KindSessionDelete.
func waitForQueueGone(t *testing.T, root, sid, msg string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !queueFileExists(root, sid) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("%s: queue.json for %q still present after 2s", msg, sid)
}

// 1. Raw normalized delete triggers cleanup.
//
//	Seed a session + queue.json, fire the live session.deleted event, assert
//	the queue.json is removed by the subscriber.
func TestQueueGC_RawSessionDeleteRemovesQueue(t *testing.T) {
	f := &fakeOC{}
	_, agg, _, root := queueLifecycleServer(t, f)
	seedQueueFile(t, root, "s1")
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	agg.Store().Apply(ev("session.deleted", `{"info":{"id":"s1"}}`))
	waitForQueueGone(t, root, "s1", "raw session.deleted")
}

// 2. External-archive-equivalent triggers the same cleanup.
//
//	archive.go calls agg.Store().RemoveSessions(affected) after OpenCode's
//	SetArchived succeeds — this is the normalized delete chokepoint that
//	external-client archives (archived session.updated) also funnel through.
//	The subscriber must fire for that path too.
func TestQueueGC_RemoveSessionsRemovesQueue(t *testing.T) {
	f := &fakeOC{}
	_, agg, _, root := queueLifecycleServer(t, f)
	seedQueueFile(t, root, "s1")
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	agg.Store().RemoveSessions([]string{"s1"})
	waitForQueueGone(t, root, "s1", "RemoveSessions (archive-equivalent)")
}

// 3. Direct local archive invokes cleanup even without the subscriber.
//
//	/vh/archive accepts the job (200) and the background cascade calls
//	CleanupSession DIRECTLY per successful id. The queue.json must be gone once
//	the bg job finishes — archive correctness must NOT depend on best-effort
//	subscriber delivery (events can be dropped, delayed, or fired before
//	subscription). (Pre-Defect-1 this was synchronous; the cascade is now async
//	under bgCtx so the cleanup lands shortly after the POST returns.)
func TestQueueGC_DirectArchiveRemovesQueue(t *testing.T) {
	f := &fakeOC{}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)
	seedQueueFile(t, root, "s1")
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	resp := csrfPost(t, web.URL+"/vh/archive", map[string]any{"sessionID": "s1"})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive: got %d, want 200", resp.StatusCode)
	}
	// The cascade is async — wait for the bg job's direct CleanupSession to land
	// (it runs per successful id, after SetArchived returns 200). This is the
	// deterministic-backstop guarantee: cleanup does not depend on the
	// best-effort subscriber.
	srv.awaitArchiveJobs(t, 5*time.Second)
	if queueFileExists(root, "s1") {
		t.Fatalf("direct archive: queue.json must be gone once the cascade job finishes")
	}
}

// 4. Direct cleanup + event cleanup is idempotent.
//
//	Archive a session via POST /vh/archive (which fires BOTH the direct call
//	AND an internal RemoveSessions → KindSessionDelete → subscriber call),
//	THEN fire an explicit session.deleted event. The second subscriber call
//	runs CleanupSession on an already-removed id — no panic, no error, no
//	observable side effect.
func TestQueueGC_DirectAndEventCleanupIsIdempotent(t *testing.T) {
	f := &fakeOC{}
	web, agg, _, root := queueLifecycleServer(t, f)
	seedQueueFile(t, root, "s1")
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	resp := csrfPost(t, web.URL+"/vh/archive", map[string]any{"sessionID": "s1"})
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive: got %d, want 200", resp.StatusCode)
	}
	waitForQueueGone(t, root, "s1", "direct archive")
	// Fire an ADDITIONAL session.deleted event — the subscriber calls
	// CleanupSession again on the already-removed id. deleteStore is
	// idempotent (missing file/directory is a no-op), so this must not
	// panic, error, or re-create any side effect.
	agg.Store().Apply(ev("session.deleted", `{"info":{"id":"s1"}}`))
	// Give the async subscriber a brief window to process the redundant
	// event, then assert the queue stays gone (no regression).
	deadline := time.Now().Add(150 * time.Millisecond)
	for time.Now().Before(deadline) {
		if queueFileExists(root, "s1") {
			t.Fatalf("idempotent re-delete: queue.json reappeared (should stay gone)")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// 5. Failed OpenCode archive does NOT prematurely delete the queue.
//
//	fakeOC.archiveStatus makes PATCH /session/:id return 5xx, so the cascade
//	job's SetArchived fails. Under the Defect 1 fix the handler ACCEPTS the job
//	(200, not the prior 502) and the background cascade retries the transient
//	5xx under budget; on exhaustion the id is retained (retain-on-failure). The
//	queue.json must persist — a failed archive must never lose queued messages.
func TestQueueGC_FailedArchivePreservesQueue(t *testing.T) {
	f := &fakeOC{archiveStatus: http.StatusInternalServerError}
	web, agg, srv, root := queueLifecycleServer(t, f)
	// Shrink the retry budget + backoff so the job reaches terminal failure in
	// milliseconds (production defaults span ~15s).
	srv.SetArchiveRetryConfig(3, 1*time.Millisecond, 2*time.Millisecond)
	srv.SetReassertDelay(5 * time.Millisecond)
	seedQueueFile(t, root, "s1")
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	resp := csrfPost(t, web.URL+"/vh/archive", map[string]any{"sessionID": "s1"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("/vh/archive with failing SetArchived: got %d, want 200 (job accepted; failure handled async)", resp.StatusCode)
	}
	// Wait for the bg job to exhaust its retries and reach terminal failure.
	srv.awaitArchiveJobs(t, 5*time.Second)
	// RETAIN-ON-FAILURE: the queue must survive (CleanupSession never ran for
	// the failed id), and the session must stay in the live store
	// (RemoveSessions never ran).
	if !queueFileExists(root, "s1") {
		t.Fatalf("failed archive must NOT delete queue.json (retain-on-failure violated)")
	}
	if agg.Store().Descendants("s1") == nil {
		t.Fatal("failed archive must NOT remove the session from the live store (retain-on-failure)")
	}
}

// 9. RT4 — re-issuing /vh/archive on a (now fully-)archived root is idempotent:
// no 502/error on the already-archived ids, CleanupSession fires exactly once
// per id from the job (the counting registry proves no double-cleanup), and the
// already-cleaned queues stay gone (no re-creation). This is the resume
// contract (decision B): re-issuing handleArchive completes the remainder
// idempotently — SetArchived re-writes 200 on already-archived, RemoveSessions
// skips-if-absent (so no session.delete event → no subscriber double-cleanup),
// and CleanupSession is a no-op on an already-removed queue.
func TestQueueGC_ReissueArchiveIsIdempotent(t *testing.T) {
	f := &fakeOC{}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c1","parentID":"r"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"c2","parentID":"r"}}`))
	seedQueueFile(t, root, "r")
	seedQueueFile(t, root, "c1")
	seedQueueFile(t, root, "c2")

	// First archive: all three. Count the CleanupSession calls (job direct +
	// subscriber for each — the idempotent composition already pinned by
	// TestQueueGC_DirectAndEventCleanupIsIdempotent).
	resp := csrfPost(t, web.URL+"/vh/archive", map[string]any{"sessionID": "r"})
	if sc := resp.StatusCode; sc != 200 {
		t.Fatalf("first /vh/archive: got %d, want 200", sc)
	}
	resp.Body.Close()
	srv.awaitArchiveJobs(t, 5*time.Second)
	for _, id := range []string{"r", "c1", "c2"} {
		if agg.Store().Descendants(id) != nil {
			t.Fatalf("[first archive] id %s not removed from store", id)
		}
		if queueFileExists(root, id) {
			t.Fatalf("[first archive] queue.json for %s not removed", id)
		}
	}
	countAfterFirst := srv.queues.CleanupCallCount()

	// RE-ISSUE /vh/archive on the same (now-archived) root. Descendants(r) is
	// nil (r removed) → the fallback makes affected=[r]. The job re-PATCHes r
	// (SetArchived idempotently re-writes 200 — NO error on already-archived),
	// RemoveSessionIfPresent(r) returns false (r already gone → THIS job did
	// NOT transition it → skip CleanupSession), and the tombstone is refreshed.
	// The CAS gate (F2 fix) is what prevents double-queue-cleanup under
	// concurrent re-issue: no CleanupSession fires for an already-removed id.
	resp2 := csrfPost(t, web.URL+"/vh/archive", map[string]any{"sessionID": "r"})
	if sc := resp2.StatusCode; sc != 200 {
		t.Fatalf("re-issue /vh/archive: got %d, want 200 (no error on already-archived)", sc)
	}
	resp2.Body.Close()
	srv.awaitArchiveJobs(t, 5*time.Second)
	// ZERO additional CleanupSession calls: RemoveSessionIfPresent(r) returned
	// false (r absent) → the CAS gate skipped CleanupSession entirely. This is
	// the no-double-cleanup guarantee the F2 fix provides.
	if got := srv.queues.CleanupCallCount() - countAfterFirst; got != 0 {
		t.Errorf("re-issue CleanupSession delta: got %d, want 0 (CAS skips cleanup for already-removed id)", got)
	}
	// All queues stay gone (no re-creation; idempotent).
	for _, id := range []string{"r", "c1", "c2"} {
		if queueFileExists(root, id) {
			t.Errorf("re-issue re-created queue.json for %s (must stay gone)", id)
		}
	}
}

// 6. Subscriber does not block store processing.
//
//	The subscriber does filesystem I/O (os.Remove) in its OWN goroutine; the
//	store's emit is a nonblocking channel send (select-default on full). The
//	store never holds s.mu during the cleanup. Verify that events fired
//	immediately AFTER a delete are reflected in Snapshot without delay, AND
//	that the cleanup completes — a synchronous-callback model would either
//	deadlock or visibly delay the post-delete Apply.
func TestQueueGC_SubscriberDoesNotBlockStore(t *testing.T) {
	f := &fakeOC{}
	_, agg, _, root := queueLifecycleServer(t, f)
	seedQueueFile(t, root, "s1")
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s2"}}`))
	// Fire delete for s1 — the subscriber goroutine picks up the event and
	// runs os.Remove asynchronously.
	agg.Store().Apply(ev("session.deleted", `{"info":{"id":"s1"}}`))
	// Immediately fire an upsert for s2 — the store must process this
	// synchronously without waiting for the subscriber's cleanup. If emit()
	// were a synchronous callback under s.mu, this Apply would block on the
	// os.Remove (or deadlock if os.Remove needed s.mu).
	agg.Store().Apply(ev("session.updated", `{"info":{"id":"s2","title":"processed"}}`))
	// Snapshot must reflect the post-delete upsert (store processing is
	// unblocked by the subscriber's filesystem I/O).
	snap := agg.Store().Snapshot(nil)
	sawUpdated := false
	for _, raw := range snap.Sessions {
		if bytes.Contains(raw, []byte(`"s2"`)) && bytes.Contains(raw, []byte(`"processed"`)) {
			sawUpdated = true
			break
		}
	}
	if !sawUpdated {
		t.Fatal("post-delete upsert must be reflected in Snapshot (store not blocked by subscriber cleanup)")
	}
	// And the async cleanup completes — no deadlock from a sync-callback model.
	waitForQueueGone(t, root, "s1", "async subscriber cleanup")
}

// 7. Hydrate prune triggers cleanup.
//
//	Hydrate reconciles the live session set against a snapshot; sessions in
//	the store but NOT in the new snapshot are pruned via deleteSessionLocked
//	(the unified removal chokepoint), which emits KindSessionDelete →
//	subscriber → CleanupSession. This covers the daemon-restart / config-edit
//	/ OpenCode-rebuild prune path.
func TestQueueGC_HydratePruneRemovesQueue(t *testing.T) {
	f := &fakeOC{}
	_, agg, _, root := queueLifecycleServer(t, f)
	seedQueueFile(t, root, "s1")
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	// Hydrate with a session set that EXCLUDES s1 → s1 is pruned.
	agg.Store().Hydrate([]json.RawMessage{
		json.RawMessage(`{"id":"s_other","title":"other"}`),
	}, nil)
	waitForQueueGone(t, root, "s1", "hydrate prune")
}

// 8. Reload-project reinstalls the queue-GC subscriber on the fresh aggregator.
//
//	GC-2 advisory F1: handleReloadProject tears down the per-dir aggregator
//	(a.Stop()), removes it from s.aggs, and resets queueGCOn[dir] so the next
//	aggFor(dir) rebuilds a FRESH aggregator. That fresh aggFor MUST also
//	re-install the queue-GC subscriber — otherwise session.delete events on
//	the new store silently leak their queue.json files (the exact leak the
//	subscriber exists to prevent). This test pins the re-install invariant:
//	after reload, a session.delete on the FRESH aggregator's store still
//	reaches CleanupSession.
//
//	Harness: newReloadServer (not queueLifecycleServer) because reload needs
//	fakeOpenCode's /instance/dispose handler. dirB is t.TempDir() so
//	projectRoot(dirB) resolves cleanly and the test auto-cleans.
func TestQueueGC_ReloadProjectReinstallsSubscriber(t *testing.T) {
	srv, _, _, web := newReloadServer(t)

	dirB := t.TempDir() // absolute; projectRoot(dirB) == dirB

	// (1) Materialize a per-dir aggregator. aggFor arms it, installs the
	//     queue-GC subscriber, and starts RunManaged.
	aB1 := srv.aggFor(dirB)

	// (2) Sanity: the subscriber is live on aB1. Seed a queue + session,
	//     fire session.deleted, confirm the queue.json is removed.
	seedQueueFile(t, dirB, "s1")
	aB1.Store().Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	aB1.Store().Apply(ev("session.deleted", `{"info":{"id":"s1"}}`))
	waitForQueueGone(t, dirB, "s1", "pre-reload subscriber cleanup")

	// (3) Reload dirB: disposes the OpenCode instance, Stops aB1, drops it
	//     from s.aggs, and resets queueGCOn[dirB] (so the next aggFor
	//     re-installs a fresh subscriber instead of skipping).
	resp := doReloadProject(t, web.URL, dirB)
	if sc := resp.StatusCode; sc != 200 {
		t.Fatalf("reload-project status: want 200, got %d", sc)
	}
	resp.Body.Close()

	// (4) Re-materialize. Must be a FRESH aggregator (not aB1).
	aB2 := srv.aggFor(dirB)
	if aB2 == aB1 {
		t.Fatal("aggFor(dirB) returned the SAME aggregator after reload — not rebuilt")
	}

	// (5) THE CONTRACT: the subscriber was re-installed on aB2. Seed a fresh
	//     queue + session, fire session.deleted on aB2's store, confirm the
	//     queue.json is removed. If the subscriber had NOT been re-installed
	//     (the GC-2 F1 bug), the queue.json for s2 would persist and
	//     waitForQueueGone would fatal.
	seedQueueFile(t, dirB, "s2")
	aB2.Store().Apply(ev("session.created", `{"info":{"id":"s2"}}`))
	aB2.Store().Apply(ev("session.deleted", `{"info":{"id":"s2"}}`))
	waitForQueueGone(t, dirB, "s2", "post-reload subscriber cleanup on fresh aggregator")
}
