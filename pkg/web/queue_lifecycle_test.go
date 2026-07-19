package web

import (
	"bytes"
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
//	/vh/archive calls CleanupSession DIRECTLY inside the handler (the archive
//	branch's loop). The queue.json must be gone by the time the POST returns —
//	archive correctness must NOT depend on best-effort subscriber delivery
//	(events can be dropped, delayed, or fired before subscription).
func TestQueueGC_DirectArchiveRemovesQueue(t *testing.T) {
	f := &fakeOC{}
	web, agg, _, root := queueLifecycleServer(t, f)
	seedQueueFile(t, root, "s1")
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	resp := csrfPost(t, web.URL+"/vh/archive", map[string]any{"sessionID": "s1"})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive: got %d, want 200", resp.StatusCode)
	}
	// The direct CleanupSession call ran synchronously inside the handler —
	// no wait needed. This is the deterministic-backstop guarantee.
	if queueFileExists(root, "s1") {
		t.Fatalf("direct archive: queue.json must be gone by the time the POST returns")
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
//	fakeOC.archiveStatus makes PATCH /session/:id return 5xx, so
//	agg.Client().SetArchived fails and the archive handler returns 502 BEFORE
//	reaching the CleanupSession loop. The queue.json must persist — a failed
//	archive must never lose queued messages.
func TestQueueGC_FailedArchivePreservesQueue(t *testing.T) {
	f := &fakeOC{archiveStatus: http.StatusInternalServerError}
	web, agg, _, root := queueLifecycleServer(t, f)
	seedQueueFile(t, root, "s1")
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	resp := csrfPost(t, web.URL+"/vh/archive", map[string]any{"sessionID": "s1"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("/vh/archive with failing SetArchived: got %d, want 502", resp.StatusCode)
	}
	// Queue must still be present — the handler returned early before the
	// direct CleanupSession call. Poll the negative condition across a short
	// window (rather than a single sleep) so a delayed stray event surfaces as
	// a test failure instead of being masked by timing. No event should fire
	// here: RemoveSessions is only reached on archive success.
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		if !queueFileExists(root, "s1") {
			t.Fatalf("failed archive must NOT prematurely delete queue.json (stray event fired)")
		}
		time.Sleep(10 * time.Millisecond)
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
