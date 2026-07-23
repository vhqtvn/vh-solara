package web

import (
	"context"
	"testing"
	"time"
)

// ISSUE 4 (A): handleArchive now spawns a re-assert goroutine that re-reads
// OpenCode's authoritative session list after a short delay and re-PATCHes any
// affected id where time.archived didn't stick (a busy/compacting subagent can
// cause OpenCode to rewrite the full session record from a pre-PATCH snapshot,
// reverting archived to null). The store-side tombstone (pkg/state, tested in
// archive_tombstone_test.go) holds the live tree during the window; these tests
// cover the OpenCode-side re-assert that makes the archive actually persist.
//
// They drive the full /vh/archive HTTP path with a fakeOC that records PATCH
// ids and serves a configurable GET /session reply, so we can assert the
// re-assert fires (or not) based on whether OpenCode reports the id as archived.
//
// LIFECYCLE (Issue A): the re-assert goroutine is OWNED by the Server. Its
// delay is per-Server (srv.SetReassertDelay), not a mutable package global (the
// global was a -race data race: the goroutine read it while another test wrote
// it). The goroutine registers with the Server's bgWG so Shutdown awaits it;
// its RPC ctx derives from the Server's bgCtx so Shutdown cancels it. Every
// test deterministically awaits the goroutine via srv.Shutdown (the test
// helpers queueLifecycleServer/newVerbServerSrv install a Shutdown cleanup) —
// no leaked goroutine outlives a test, no sleeps used to mask races.

// archivedPATCHes returns a snapshot copy of the ids PATCHed via SetArchived.
func archivedPATCHes(f *fakeOC) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, len(f.archivedPATCHes))
	copy(out, f.archivedPATCHes)
	return out
}

func countID(ids []string, id string) int {
	n := 0
	for _, x := range ids {
		if x == id {
			n++
		}
	}
	return n
}

// TestArchiveReassert_ReparchesClobberedID: the initial PATCHes all return 200
// but OpenCode's authoritative list reports the id with archived=null (busy
// subagent clobbered it). The re-assert goroutine must re-PATCH that id.
func TestArchiveReassert_ReparchesClobberedID(t *testing.T) {
	// OpenCode reports s1 with archived=null → the re-assert sees it as
	// not-stuck and re-PATCHes.
	list := []byte(`[{"id":"s1","parentID":"","time":{"archived":null}}]`)
	f := &fakeOC{listSessionsReply: list}
	web, agg, srv, _ := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1"}}`))

	resp := csrfPost(t, web.URL+"/vh/archive", map[string]any{"sessionID": "s1"})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive: got %d, want 200", resp.StatusCode)
	}

	// The re-assert fires ~5ms after the POST returned. Poll for the second
	// PATCH on s1 (initial + re-assert). Generous deadline so it's not flaky
	// under scheduling stress.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if countID(archivedPATCHes(f), "s1") >= 2 {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if n := countID(archivedPATCHes(f), "s1"); n < 2 {
		t.Fatalf("re-assert did not re-PATCH clobbered s1: got %d PATCHes, want >=2 (all=%v)",
			n, archivedPATCHes(f))
	}
}

// TestArchiveReassert_SkipsWhenStuck: the initial PATCH persisted (OpenCode's
// authoritative list reports the id with archived set). The re-assert goroutine
// must NOT re-PATCH.
func TestArchiveReassert_SkipsWhenStuck(t *testing.T) {
	// OpenCode reports s1 with archived=<ts> → the re-assert sees it as stuck
	// and skips.
	list := []byte(`[{"id":"s1","parentID":"","time":{"archived":1700000000000}}]`)
	f := &fakeOC{listSessionsReply: list}
	web, agg, srv, _ := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1"}}`))

	resp := csrfPost(t, web.URL+"/vh/archive", map[string]any{"sessionID": "s1"})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive: got %d, want 200", resp.StatusCode)
	}

	// Wait long past the re-assert window so a stray re-PATCH would land.
	time.Sleep(60 * time.Millisecond)
	if n := countID(archivedPATCHes(f), "s1"); n != 1 {
		t.Fatalf("re-assert re-PATCHed stuck s1: got %d PATCHes, want exactly 1 (all=%v)",
			n, archivedPATCHes(f))
	}
}

// TestArchiveReassert_SkipsRepatchAfterTombstoneCleared is the regression for
// review finding d-F1: if the operator archives then unarchives (or otherwise
// clears the tombstone) within the re-assert window, the goroutine must NOT
// re-PATCH the id back to archived — that would undo the legitimate unarchive.
// The re-assert uses IsRecentlyArchived as its signal that the archive intent
// still holds: once ClearArchiveTombstones runs (the explicit unarchive flow),
// the id is no longer expected to be archived.
func TestArchiveReassert_SkipsRepatchAfterTombstoneCleared(t *testing.T) {
	// OpenCode reports s1 with archived=null (the clobber shape). Without the
	// IsRecentlyArchived guard the re-assert would re-PATCH; with it, the
	// cleared tombstone makes the goroutine skip.
	list := []byte(`[{"id":"s1","parentID":"","time":{"archived":null}}]`)
	f := &fakeOC{listSessionsReply: list}
	web, agg, srv, _ := queueLifecycleServer(t, f)
	srv.SetReassertDelay(30 * time.Millisecond) // window to clear the tombstone first
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1"}}`))

	resp := csrfPost(t, web.URL+"/vh/archive", map[string]any{"sessionID": "s1"})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive: got %d, want 200", resp.StatusCode)
	}
	// Simulate the unarchive flow clearing the tombstone BEFORE the 30ms
	// re-assert fires (the POST returned immediately; this runs microseconds
	// later, well inside the window).
	agg.Store().ClearArchiveTombstones([]string{"s1"})

	// Wait well past the re-assert window so a stray re-PATCH would land.
	time.Sleep(120 * time.Millisecond)
	if n := countID(archivedPATCHes(f), "s1"); n != 1 {
		t.Fatalf("re-assert re-PATCHed an id whose tombstone was cleared (unarchive): "+
			"got %d PATCHes, want exactly 1 (all=%v)", n, archivedPATCHes(f))
	}
}

// TestArchiveReassert_ResponseNotBlocked: the re-assert goroutine must not
// delay the archive response — even with the default 1s delay the POST returns
// immediately. Verifies the goroutine is dispatched async (guards the
// response-latency contract under future edits).
func TestArchiveReassert_ResponseNotBlocked(t *testing.T) {
	// Do NOT shrink the delay — keep the 1s default and prove the response
	// still returns in well under that.
	f := &fakeOC{}
	web, agg, _, _ := queueLifecycleServer(t, f)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1"}}`))

	start := time.Now()
	resp := csrfPost(t, web.URL+"/vh/archive", map[string]any{"sessionID": "s1"})
	elapsed := time.Since(start)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive: got %d, want 200", resp.StatusCode)
	}
	// The default re-assert delay is 1s. The response must return in well
	// under that — the goroutine runs async. 500ms is a generous upper bound
	// (the rest of the handler is sub-millisecond).
	if elapsed > 500*time.Millisecond {
		t.Fatalf("archive response blocked on re-assert goroutine: %v (want <500ms)", elapsed)
	}
}

// TestArchiveReassert_ShutdownOwnsOutstandingWork proves the Issue-A lifecycle
// fix: the Server OWNS the re-assert goroutine (it is registered with bgWG),
// so Shutdown does NOT return while that goroutine is still in-flight.
//
// Why a test seam (reassertBlockCh) and not a fake ListSessions hang: the http
// CLIENT aborts an in-flight request the instant its context cancels, so once
// Shutdown cancels bgCtx the re-assert goroutine's ListSessions returns
// immediately regardless of what the server-side fake does. That makes
// Shutdown's bgWG.Wait unobservable via timing on the real code path. The seam
// places the goroutine in a pure (ctx-independent) channel receive — the ONE
// spot bgCancel cannot reach — so the goroutine provably cannot exit until the
// test releases it. If Shutdown returns during that window, it did NOT await
// bgWG (a regression to fire-and-forget would fail here).
func TestArchiveReassert_ShutdownOwnsOutstandingWork(t *testing.T) {
	f := &fakeOC{listSessionsReply: []byte(`[]`)}
	web, agg, srv, _ := queueLifecycleServer(t, f)
	// NOTE: queueLifecycleServer installs a t.Cleanup(srv.Shutdown). Shutdown
	// is idempotent, so the explicit call below (mid-test, for the await
	// assertion) and the cleanup call (at test end) compose harmlessly.
	agg.Store().Apply(ev("session.created", `{"info":{"id":"s1"}}`))
	srv.SetReassertDelay(1 * time.Millisecond) // pass the delay fast, reach the block

	// Install the test seam: signal when the goroutine reaches its post-delay
	// block point, then hold it there on a pure channel receive.
	ready := make(chan struct{})
	block := make(chan struct{})
	srv.reassertReadyCh = ready
	srv.reassertBlockCh = block

	// POST /vh/archive — returns immediately (goroutine dispatched async).
	resp := csrfPost(t, web.URL+"/vh/archive", map[string]any{"sessionID": "s1"})
	if resp.StatusCode != 200 {
		resp.Body.Close()
		t.Fatalf("/vh/archive: got %d, want 200", resp.StatusCode)
	}
	resp.Body.Close()

	// Wait until the re-assert goroutine has reached its block point.
	select {
	case <-ready:
	case <-time.After(2 * time.Second):
		t.Fatal("re-assert goroutine never reached its post-delay block point")
	}

	// Shutdown in a goroutine: bgCancel (cannot reach the pure channel block)
	// then bgWG.Wait (blocks — goroutine is still alive at the block).
	shutdownDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		shutdownDone <- srv.Shutdown(ctx)
	}()
	// Fail-fast poll: prove Shutdown does NOT return while the goroutine is
	// held at the block. The goroutine CANNOT exit until `block` closes (pure
	// receive, bgCancel doesn't touch it), so Shutdown returning here means it
	// did NOT await bgWG.
	deadline := time.Now().Add(120 * time.Millisecond)
	for time.Now().Before(deadline) {
		select {
		case err := <-shutdownDone:
			t.Fatalf("Shutdown returned while the re-assert goroutine was still "+
				"blocked: %v (Server must own + await outstanding tracked work)", err)
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}
	// Release the goroutine: the pure block completes → the goroutine proceeds
	// to ListSessions whose ctx is a child of the (now-cancelled) bgCtx →
	// ListSessions returns immediately → the goroutine exits → bgWG.Done →
	// Shutdown's Wait returns.
	close(block)
	select {
	case err := <-shutdownDone:
		if err != nil {
			t.Fatalf("Shutdown returned error after release: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Shutdown never returned after the goroutine was released (not awaited)")
	}
}
