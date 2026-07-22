package web

import (
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

// withReassertDelay shrinks the package-level archiveReassertDelay for the
// lifetime of the test (save/restore; the suite is not parallel).
func withReassertDelay(t *testing.T, d time.Duration) {
	t.Helper()
	old := archiveReassertDelay
	archiveReassertDelay = d
	t.Cleanup(func() { archiveReassertDelay = old })
}

// TestArchiveReassert_ReparchesClobberedID: the initial PATCHes all return 200
// but OpenCode's authoritative list reports the id with archived=null (busy
// subagent clobbered it). The re-assert goroutine must re-PATCH that id.
func TestArchiveReassert_ReparchesClobberedID(t *testing.T) {
	withReassertDelay(t, 5*time.Millisecond)
	// OpenCode reports s1 with archived=null → the re-assert sees it as
	// not-stuck and re-PATCHes.
	list := []byte(`[{"id":"s1","parentID":"","time":{"archived":null}}]`)
	f := &fakeOC{listSessionsReply: list}
	web, agg, _, _ := queueLifecycleServer(t, f)
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
	withReassertDelay(t, 5*time.Millisecond)
	// OpenCode reports s1 with archived=<ts> → the re-assert sees it as stuck
	// and skips.
	list := []byte(`[{"id":"s1","parentID":"","time":{"archived":1700000000000}}]`)
	f := &fakeOC{listSessionsReply: list}
	web, agg, _, _ := queueLifecycleServer(t, f)
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
	withReassertDelay(t, 30*time.Millisecond) // window to clear the tombstone first
	// OpenCode reports s1 with archived=null (the clobber shape). Without the
	// IsRecentlyArchived guard the re-assert would re-PATCH; with it, the
	// cleared tombstone makes the goroutine skip.
	list := []byte(`[{"id":"s1","parentID":"","time":{"archived":null}}]`)
	f := &fakeOC{listSessionsReply: list}
	web, agg, _, _ := queueLifecycleServer(t, f)
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
