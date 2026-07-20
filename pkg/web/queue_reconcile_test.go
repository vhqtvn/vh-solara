package web

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
)

// FIX-QUEUE-GC-3 (Slice 3 of 5) — authoritative orphan-queue reconciliation as
// the durable backstop for GC-2's best-effort session.delete event subscriber.
// GC-2 fires CleanupSession inline as session.delete events stream in, but
// store.emit()'s fan-out is nonblocking and a full subscriber buffer drops the
// event — leaving an orphan queue.json on disk whose session ID is no longer in
// the authoritative active set. GC-3 scans the filesystem after a successful
// hydrate and removes every queue.json whose session ID is NOT in
// store.SessionIDs().
//
// FAIL-CLOSED is the single most important contract (tests 3, 4b): if hydrate
// failed, the inventory is nil, or the aggregator has not yet hydrated, GC-3
// MUST delete nothing. Distinguishing "0 sessions after a successful hydrate"
// (test 4a — all on-disk queues are orphans, delete all) from "not yet
// hydrated" (test 4b — no authoritative set, delete nothing) is the whole
// reason the aggregator exposes a HydratedOnce signal.
//
// These tests target two surfaces:
//   - queueRegistry.reconcileOrphanQueues (the filesystem scan + cleanup) —
//     called directly with a hand-built active map. Covers cases 1, 2, 3, 4a,
//     5, 6, 7, 8.
//   - Server.reconcileQueuesForAgg (the fail-closed driver gating on
//     HydratedOnce + reading store.SessionIDs) — covers case 4b (not-yet-
//     hydrated aggregator deletes nothing).
//
// Test harness: queueLifecycleServer wires a Server + temp root + chdir and
// triggers aggFor("") so the GC-2 subscriber (and now the GC-3 onHydrate
// callback) is installed. The aggregator's Run loop is NOT started, so tests
// drive the store directly and call reconcileOrphanQueues / reconcileQueuesForAgg
// explicitly — deterministic, no async hydrate timing.

// 1. Orphan queue removed after successful inventory.
//
//	Seed two on-disk queue.json files, run reconciliation with an active set
//	containing exactly one of them, assert the orphan's queue.json is gone
//	and the live one survives.
func TestQueueReconcile_OrphanRemovedAfterSuccessfulInventory(t *testing.T) {
	_, _, srv, root := queueLifecycleServer(t, &fakeOC{})
	seedQueueFile(t, root, "live")
	seedQueueFile(t, root, "orphan")

	active := map[string]bool{"live": true}
	if err := srv.queues.reconcileOrphanQueues(root, active, nil); err != nil {
		t.Fatalf("reconcileOrphanQueues: %v", err)
	}

	if !queueFileExists(root, "live") {
		t.Errorf("live session queue.json was removed; must survive reconciliation")
	}
	if queueFileExists(root, "orphan") {
		t.Errorf("orphan session queue.json survived; must be removed")
	}
}

// 2. Live-session queue items are preserved (not just the file's existence).
//
//	A live session's queue.json is loaded through the registry, populated with
//	real items via Enqueue, and then reconciliation runs with that session in
//	the active set. The queue.json must survive AND its items must be intact
//	(read back through a fresh store so we observe on-disk truth, not cache).
func TestQueueReconcile_LiveSessionQueueItemsPreserved(t *testing.T) {
	_, _, srv, root := queueLifecycleServer(t, &fakeOC{})
	seedQueueFile(t, root, "live")
	seedQueueFile(t, root, "orphan")

	// Populate the live queue with real items through the registry so its
	// queue.json carries non-empty items on disk.
	st := srv.queues.store(root, "live")
	if _, err := st.Enqueue("hello", nil, QueueSendConfig{}, "test-client"); err != nil {
		t.Fatalf("Enqueue: %v", err)
	}

	active := map[string]bool{"live": true}
	if err := srv.queues.reconcileOrphanQueues(root, active, nil); err != nil {
		t.Fatalf("reconcileOrphanQueues: %v", err)
	}

	if !queueFileExists(root, "live") {
		t.Fatalf("live session queue.json removed by reconciliation")
	}
	// Read items back through a FRESH store handle so we observe the on-disk
	// state reconciliation wrote (the original `st` may still hold in-memory
	// cache from before).
	fresh := srv.queues.store(root, "live")
	items, err := fresh.List()
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if len(items) != 1 || items[0].Text != "hello" {
		t.Errorf("live queue items not preserved: got %+v, want 1 item text=%q", items, "hello")
	}
}

// 3. Inventory failure removes NOTHING (FAIL-CLOSED — the most important test).
//
//	A nil active map simulates "hydrate failed / no authoritative inventory."
//	With orphans present, reconciliation MUST return nil (not an error) and
//	MUST NOT delete a single file. This is the rule that makes GC-3 safe to
//	run at all: a broken hydrate can never murder live sessions' queues.
func TestQueueReconcile_NilInventoryRemovesNothing(t *testing.T) {
	_, _, srv, root := queueLifecycleServer(t, &fakeOC{})
	seedQueueFile(t, root, "s1")
	seedQueueFile(t, root, "s2")
	seedQueueFile(t, root, "s3")

	// nil active map = "no authoritative set." Must delete nothing.
	if err := srv.queues.reconcileOrphanQueues(root, nil, nil); err != nil {
		t.Fatalf("reconcileOrphanQueues(nil) returned error: %v (must be nil)", err)
	}

	for _, sid := range []string{"s1", "s2", "s3"} {
		if !queueFileExists(root, sid) {
			t.Errorf("queue.json for %q was removed under nil inventory; FAIL-CLOSED violation", sid)
		}
	}
}

// 4a. Empty inventory AFTER a successful hydrate = all on-disk queues are
// orphans and all are deleted. This is the OPPOSITE of case 3 / 4b: an empty
// NON-NIL map means "hydrate succeeded and reported zero active sessions," so
// every queue.json on disk is stale. This distinction is the entire reason
// reconcileOrphanQueues gates on `activeSessions == nil` rather than
// `len(activeSessions) == 0`.
func TestQueueReconcile_EmptyNonNilInventoryDeletesAll(t *testing.T) {
	_, _, srv, root := queueLifecycleServer(t, &fakeOC{})
	seedQueueFile(t, root, "stale1")
	seedQueueFile(t, root, "stale2")

	// Empty NON-nil map = "hydrate succeeded with zero sessions." All on-disk
	// queues are orphans → all deleted.
	active := map[string]bool{}
	if err := srv.queues.reconcileOrphanQueues(root, active, nil); err != nil {
		t.Fatalf("reconcileOrphanQueues(empty): %v", err)
	}

	for _, sid := range []string{"stale1", "stale2"} {
		if queueFileExists(root, sid) {
			t.Errorf("queue.json for %q survived empty-non-nil inventory; should be deleted as orphan", sid)
		}
	}
}

// 4b. Not-yet-hydrated aggregator deletes nothing via reconcileQueuesForAgg.
//
//	The HydratedOnce gate is the second fail-closed line: even if the registry
//	scan is reached through the Server driver (the production trigger path),
//	an aggregator that has never completed a hydrate must short-circuit before
//	building the active map. queueLifecycleServer does NOT start the Run loop,
//	so the returned aggregator's HydratedOnce() is false — exactly the boot
//	race condition this gate exists to defend.
func TestQueueReconcile_NotYetHydratedAggregatorDeletesNothing(t *testing.T) {
	_, agg, srv, root := queueLifecycleServer(t, &fakeOC{})
	seedQueueFile(t, root, "s1")
	seedQueueFile(t, root, "s2")

	if agg.HydratedOnce() {
		t.Fatalf("precondition: aggregator already hydrated (HydratedOnce=true); test harness assumption violated")
	}

	// This is the production trigger path (post-hydrate callback would call
	// exactly this). With HydratedOnce=false it must return having deleted
	// nothing, even though orphan queue.json files exist on disk.
	srv.reconcileQueuesForAgg("", agg)

	for _, sid := range []string{"s1", "s2"} {
		if !queueFileExists(root, sid) {
			t.Errorf("queue.json for %q removed by not-yet-hydrated aggregator; FAIL-CLOSED violation", sid)
		}
	}
}

// 5. Direct filesystem files never loaded into queueRegistry are discovered.
//
//	By definition an orphan from a previous run was never loaded into this
//	process's queueRegistry (it was left on disk by a prior process that has
//	since exited). seedQueueFile writes queue.json directly to disk without
//	touching the registry, so we assert the registry is empty BEFORE reconcile
//	(proving the orphan is filesystem-only) and then assert reconciliation
//	still finds and removes it. This validates the "scan the filesystem, not
//	the registry" requirement.
func TestQueueReconcile_DiscoversFilesystemOnlyOrphans(t *testing.T) {
	_, _, srv, root := queueLifecycleServer(t, &fakeOC{})
	seedQueueFile(t, root, "ghost")

	// Prove the orphan is filesystem-only: it is NOT in the registry's loaded
	// stores map. (store(root, sid) would have populated this; we never called
	// it for "ghost".)
	srv.queues.mu.Lock()
	loadedCount := len(srv.queues.stores)
	srv.queues.mu.Unlock()
	if loadedCount != 0 {
		t.Errorf("precondition: registry has %d loaded stores before reconcile; want 0 (orphan must be filesystem-only)", loadedCount)
	}

	active := map[string]bool{"some-other-session": true}
	if err := srv.queues.reconcileOrphanQueues(root, active, nil); err != nil {
		t.Fatalf("reconcileOrphanQueues: %v", err)
	}

	if queueFileExists(root, "ghost") {
		t.Errorf("filesystem-only orphan queue.json survived; scanner must find it via os.ReadDir")
	}
}

// 6. Attachment-bearing orphan loses ONLY queue.json.
//
//	An orphan session directory may legitimately contain an attachments/
//	subdir (peer of queue.json). GC-3's scope is queue files only — attachment
//	lifecycle is unproven against retained OpenCode transcript file://
//	references (see deleteStore doc). So CleanupSession uses empty-only rmdir:
//	queue.json is removed, but a non-empty session directory (one holding
//	attachments/) survives. This test pins that contract.
func TestQueueReconcile_AttachmentBearingOrphanKeepsAttachmentsDir(t *testing.T) {
	_, _, srv, root := queueLifecycleServer(t, &fakeOC{})
	seedQueueFile(t, root, "orphan-with-attachments")
	// Create a peer attachments/ subdir with a dummy file. The session dir is
	// now non-empty even after queue.json is removed.
	attachDir := filepath.Join(root, ".vh-solara", "sessions", "orphan-with-attachments", "attachments")
	if err := os.MkdirAll(attachDir, 0o755); err != nil {
		t.Fatal(err)
	}
	dummy := filepath.Join(attachDir, "resume.pdf")
	if err := os.WriteFile(dummy, []byte("%PDF-1.4 fake"), 0o644); err != nil {
		t.Fatal(err)
	}

	active := map[string]bool{}
	if err := srv.queues.reconcileOrphanQueues(root, active, nil); err != nil {
		t.Fatalf("reconcileOrphanQueues: %v", err)
	}

	// queue.json must be gone.
	if queueFileExists(root, "orphan-with-attachments") {
		t.Errorf("orphan queue.json survived; must be removed")
	}
	// attachments/ subdir AND its dummy file must survive (empty-only rmdir).
	if _, err := os.Stat(dummy); err != nil {
		t.Errorf("attachment file removed; GC-3 must not touch attachments: %v", err)
	}
	// The session directory itself must survive (non-empty → rmdir fails, which
	// is the correct safe behavior).
	sessionDir := filepath.Dir(queuePath(root, "orphan-with-attachments"))
	if _, err := os.Stat(sessionDir); err != nil {
		t.Errorf("non-empty session directory removed; must survive empty-only rmdir: %v", err)
	}
}

// 7. Concurrent Claim/Resolve/Enqueue racing against reconciliation: no
// corruption, no panic (run with -race in verification).
//
//	A live session's store is actively mutated (Enqueue/Claim/Resolve loop)
//	while reconciliation scans and cleans ORPHAN session dirs alongside it.
//	The live session's queue.json is touched by both the mutator (save on
//	every Enqueue/Claim/Resolve) and by reconciliation's scanner (stat) —
//	this test proves the registry's mutex discipline (qr.mu + st.mu) keeps
//	them safe. Run with -race to catch any data race the test's logic wouldn't
//	assert directly.
func TestQueueReconcile_ConcurrentMutationIsRaceSafe(t *testing.T) {
	_, _, srv, root := queueLifecycleServer(t, &fakeOC{})

	// A live session with a real loaded store — the mutator's target.
	seedQueueFile(t, root, "live")
	st := srv.queues.store(root, "live")

	// Several orphan sessions on disk (filesystem-only) that reconciliation
	// will clean while the live store is being mutated.
	for _, sid := range []string{"orphan1", "orphan2", "orphan3"} {
		seedQueueFile(t, root, sid)
	}

	var wg sync.WaitGroup
	stop := make(chan struct{})

	// Mutator goroutine: tight Enqueue → Claim → Resolve loop on the live store.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			item, err := st.Enqueue("concurrent", nil, QueueSendConfig{}, "race-test")
			if err != nil {
				// Once reconciliation or another goroutine archives the store,
				// Enqueue returns errQueueArchived — but that does not happen
				// here because "live" is in the active set. Any other error is
				// a real bug worth failing the test for; surface via panic so
				// the race detector + test harness report it.
				panic(err)
			}
			if claimed, ok, cerr := st.Claim(); cerr != nil {
				panic(cerr)
			} else if ok {
				if _, rerr := st.Resolve(claimed.ID, QueueSent, "ok"); rerr != nil {
					panic(rerr)
				}
			}
			_ = item
		}
	}()

	// Reconciler goroutine: repeatedly run reconciliation with "live" active.
	// Each pass stats the live queue.json and cleans the orphans. The live
	// store's save() and the scanner's stat() race against each other — mutex
	// discipline must keep them safe.
	wg.Add(1)
	go func() {
		defer wg.Done()
		active := map[string]bool{"live": true}
		for i := 0; i < 50; i++ {
			if err := srv.queues.reconcileOrphanQueues(root, active, nil); err != nil {
				panic(err)
			}
		}
	}()

	// Let the mutator run briefly, then signal stop and wait for clean exit.
	// The reconciler goroutine has a fixed iteration count and exits on its own.
	close(stop)
	wg.Wait()

	// Final consistency check: live queue.json still present, orphans gone.
	if !queueFileExists(root, "live") {
		t.Errorf("live queue.json removed by concurrent reconciliation; must survive")
	}
	for _, sid := range []string{"orphan1", "orphan2", "orphan3"} {
		if queueFileExists(root, sid) {
			t.Errorf("orphan %q survived reconciliation; must be removed", sid)
		}
	}
}

// 8. Reconciliation tolerates disappearing files mid-scan.
//
//	An orphan queue.json that vanishes between the scanner's ReadDir and its
//	per-entry os.Stat / CleanupSession must NOT cause a panic or an error.
//	deleteStore's os.Remove is best-effort and swallows ENOENT, so a file
//	removed by a concurrent process (or a double-reconcile race) degrades
//	graefully. This test seeds orphans, runs MANY concurrent reconciliation
//	passes (so passes observe each other's mid-removal), and asserts no error
//	plus a consistent clean final state.
func TestQueueReconcile_ToleratesDisappearingFiles(t *testing.T) {
	_, _, srv, root := queueLifecycleServer(t, &fakeOC{})
	for _, sid := range []string{"ephemeral1", "ephemeral2", "ephemeral3", "ephemeral4"} {
		seedQueueFile(t, root, sid)
	}

	// Launch several concurrent reconcilers with an empty active set (every
	// on-disk queue is an orphan). They race to remove the same files: each
	// file is removed exactly once, but the OTHER reconcilers will stat /
	// deleteStore an already-removed file. Every such touch must be a graceful
	// no-op (ENOENT swallowed), never an error or panic.
	const N = 8
	var wg sync.WaitGroup
	errs := make(chan error, N)
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			active := map[string]bool{}
			if err := srv.queues.reconcileOrphanQueues(root, active, nil); err != nil {
				errs <- err
			}
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent reconcile returned error on disappearing files: %v", err)
	}

	// Final state: all orphans gone regardless of which reconciler won each
	// file. A file present here would mean a reconciler failed mid-scan.
	for _, sid := range []string{"ephemeral1", "ephemeral2", "ephemeral3", "ephemeral4"} {
		if queueFileExists(root, sid) {
			t.Errorf("orphan %q survived concurrent reconciliation; must be removed", sid)
		}
	}
}

// 9. Revalidate callback saves a fresh session created between T1 and T2
// (THE test for FIX-QUEUE-GC-3-RACE — the T2 recheck closure).
//
//		The GC-3 race being closed: activeSessions is captured at T1
//		(SessionIDs()), the filesystem is scanned at T2; a session created in
//		the (T1, T2) window appears as an orphan at T2 because it is absent
//		from the T1 snapshot, even though it is NOW live. Pre-fix, its fresh
//		queue.json was deleted — murdering a brand-new session's queue. The
//		revalidate callback re-checks liveness at T2: if it returns true, the
//		deletion is skipped.
//
//	Test design:
//	  - activeSessions is EMPTY — the T1 snapshot was taken BEFORE either
//	    session existed. Without revalidate, both on-disk queues would be
//	    deleted as orphans (this is the case-4a contract).
//	  - revalidate returns true ONLY for "fresh" — simulating the session
//	    being active at T2 (created between T1 and T2). This is the T2
//	    recheck that closes GC-3.
//	  - "real-orphan" is a session revalidate reports as inactive — it MUST
//	    still be deleted, proving the recheck doesn't accidentally skip all
//	    deletions.
//	  - Assert: "fresh" queue.json survives (the recheck saved it); "real
//	    orphan" queue.json is gone (revalidate=false still deletes).
func TestQueueReconcile_RevalidateSavesFreshSession(t *testing.T) {
	_, _, srv, root := queueLifecycleServer(t, &fakeOC{})
	seedQueueFile(t, root, "fresh")       // created between T1 and T2 — must survive
	seedQueueFile(t, root, "real-orphan") // genuinely gone — must be deleted

	// activeSessions is EMPTY — T1 snapshot taken BEFORE either session
	// existed. Without revalidate, both queues would be deleted.
	active := map[string]bool{}
	// revalidate returns true ONLY for "fresh" — the session is now active
	// at T2 (created between T1 and T2). This is the T2 recheck that closes
	// GC-3. Production wiring passes store.HasSession; this stub simulates
	// the same liveness signal deterministically.
	revalidate := func(sid string) bool { return sid == "fresh" }

	if err := srv.queues.reconcileOrphanQueues(root, active, revalidate); err != nil {
		t.Fatalf("reconcileOrphanQueues with revalidate: %v", err)
	}

	if !queueFileExists(root, "fresh") {
		t.Errorf("fresh-session queue.json was deleted; T2 recheck must save a session created between T1 and T2 (GC-3 race closure)")
	}
	if queueFileExists(root, "real-orphan") {
		t.Errorf("real-orphan queue.json survived; revalidate must only save sessions it reports as active")
	}
}

// 10. Nil revalidate callback preserves the pre-fix behavior (orphans still
// deleted when absent from activeSessions).
//
//	The new `revalidate` parameter is backward-compatible: nil means "no
//	re-validation." This test pins that contract so a future refactor cannot
//	accidentally crash on nil or skip deletion when nil is passed. It mirrors
//	case-4a (empty-non-nil inventory deletes all) but with the explicit nil
//	revalidate argument — the two-arg call shape pre-FIX-QUEUE-GC-3-RACE.
func TestQueueReconcile_RevalidateNilDoesNotCrash(t *testing.T) {
	_, _, srv, root := queueLifecycleServer(t, &fakeOC{})
	seedQueueFile(t, root, "orphan")

	active := map[string]bool{}
	if err := srv.queues.reconcileOrphanQueues(root, active, nil); err != nil {
		t.Fatalf("reconcileOrphanQueues with nil revalidate returned error: %v", err)
	}

	if queueFileExists(root, "orphan") {
		t.Errorf("orphan queue.json survived; nil revalidate must preserve pre-fix behavior (delete orphans not in activeSessions)")
	}
}
