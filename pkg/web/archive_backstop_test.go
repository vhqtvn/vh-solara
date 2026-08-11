package web

// archive_backstop_test.go — Slice 2 of the archive-failure visibility feature:
// the OOB-reconcile backstop regression tests.
//
// This file owns the Slice-2 subset: the active-jobs registry + the race-free
// OOB reconcile backstop (reconcileArchiveFailures). Slice 1's RTs
// (archive_failures_test.go) are RE-RUN unchanged to prove no regression — they
// are not duplicated here.
//
// RT map (Slice 2):
//   BT1  Backstop clears an OOB-resolved stale failure + fans out the clear.
//   BT2  Backstop does NOT clear a failure whose root has an ACTIVE cascade
//        (the predicate's "no active job" half — race-freedom).
//   BT3  Active-jobs registry lifecycle: register on start, deregister on ALL
//        terminal paths (success AND exhaust) — no leaked entries.
//   BT4  Lock-order safety under -race: concurrent reconcileArchiveFailures +
//        handleArchive (a blocked in-flight cascade) — no deadlock, no data race.
//
// The crux is BT1 + BT2 together: the backstop clears a genuinely-resolved stale
// warning (BT1) AND refuses to race a running cascade (BT2). Both halves are
// exercised at the Go unit seam (unlike Slice 1's e2e gap), so `proven` is honest.

import (
	"encoding/json"
	"net/http"
	"sync"
	"testing"
	"time"
)

// backstopActiveJobsCount snapshots archiveJobsActiveRoots under bgMu (test
// helper for the lifecycle assertion BT3). Returns the number of registered
// active cascades across all (dir, root) pairs.
func (s *Server) backstopActiveJobsCount() int {
	s.bgMu.Lock()
	defer s.bgMu.Unlock()
	return len(s.archiveJobsActiveRoots)
}

// registerActiveArchiveJobForTest seeds archiveJobsActiveRoots under bgMu (BT2's
// "simulate a running cascade without dispatching a real one" helper). The test
// MUST clear the entry before teardown (deregisterActiveArchiveJobForTest) so a
// leaked active marker does not trip BT3 / other tests in the same Server.
func (s *Server) registerActiveArchiveJobForTest(dir, root string) {
	s.bgMu.Lock()
	s.archiveJobsActiveRoots[archiveFailureKey{Dir: dir, ID: root}] = true
	s.bgMu.Unlock()
}

func (s *Server) deregisterActiveArchiveJobForTest(dir, root string) {
	s.bgMu.Lock()
	delete(s.archiveJobsActiveRoots, archiveFailureKey{Dir: dir, ID: root})
	s.bgMu.Unlock()
}

// BT1 — THE CRUX (positive half): a stale failure record for (dir, root) whose
// root was archived/deleted OUT-OF-BAND is cleared by the backstop, and the
// clear is fanned out to connected clients via archive-failures.updated. This is
// the ONE gap Slice 1 left: Slice 1's clear-on-success fires only at THIS
// daemon's cascade success funnel, which never ran for an OOB resolution.
func TestBackstop_ClearsOOBResolvedStaleFailure(t *testing.T) {
	f := &fakeOC{}
	web, agg, srv, _ := queueLifecycleServer(t, f)
	// Seed a LIVE root r in the store (the cascade target).
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	// Record a terminal failure for r directly (models an exhausted-job failure
	// from a prior cascade — the same state recordArchiveFailure produces).
	srv.recordArchiveFailure("", "r", "r", "exhausted:5")
	if !hasArchiveFailureID(t, srv, "r") {
		t.Fatalf("seed: r not recorded before backstop")
	}

	// Connect a client and drain the bootstrap snapshot (which carries r).
	sresp, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer sresp.Body.Close()
	ch := startSSEReader(t, sresp.Body)
	drainIdle(ch, 500*time.Millisecond)

	// Simulate the OOB resolution: r was archived by another tool (or deleted).
	// The tree-reconcile tick would evict r from the live store (it drops out of
	// /session) and RefreshArchivedSnapshot would add it to the authoritative
	// snapshot. Model both here.
	agg.Store().RemoveSessionIfPresent("r")
	agg.Store().RefreshArchivedSnapshot([]json.RawMessage{
		json.RawMessage(`{"id":"r","time":{"archived":1}}`),
	})

	// Run the backstop synchronously (the production ticker's body).
	srv.reconcileArchiveFailures()

	// CRUX 1 — the stale failure record was cleared.
	if hasArchiveFailureID(t, srv, "r") {
		t.Errorf("r still in registry after backstop (OOB-resolved stale warning not cleared): %+v", srv.ArchiveFailures())
	}

	// CRUX 2 — the clear was fanned out: the connected client received an
	// archive-failures.updated frame with an empty failures set.
	evs := drainIdle(ch, 800*time.Millisecond)
	data, ok := eventDataFor(evs, "archive-failures.updated", "failures")
	if !ok {
		t.Fatalf("no archive-failures.updated frame after backstop clear; events=%v", eventNames(evs))
	}
	doc := decodeArchiveFailuresSSE(t, data)
	if len(doc.Failures) != 0 {
		t.Errorf("updated frame not empty after backstop clear (got %d failures): %+v", len(doc.Failures), doc)
	}
}

// BT2 — THE CRUX (negative half): the backstop does NOT clear a failure whose
// root has an ACTIVE cascade registered. The cascade's own clear-on-success /
// re-record-on-failure owns that root's lifecycle; the backstop must not race
// it. This is the race-freedom predicate — without the active-jobs guard, the
// backstop could clear a record moments before the cascade records a fresh
// failure (or after it re-records), losing the warning.
func TestBackstop_NoClearWhenActiveCascade(t *testing.T) {
	f := &fakeOC{}
	_, agg, srv, _ := queueLifecycleServer(t, f)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	srv.recordArchiveFailure("", "r", "r", "exhausted:5")
	if !hasArchiveFailureID(t, srv, "r") {
		t.Fatalf("seed: r not recorded before backstop")
	}

	// Simulate an in-flight cascade for r WITHOUT dispatching a real one: the
	// active-jobs registry is what the backstop checks, so seeding it directly
	// exercises the guard. (A real blocked cascade via archiveBlockCh would also
	// work, but the direct seed is the minimal crux proof — the registry IS the
	// predicate.)
	srv.registerActiveArchiveJobForTest("", "r")
	defer srv.deregisterActiveArchiveJobForTest("", "r")

	// Simulate the SAME OOB resolution as BT1 (root archived/deleted OOB).
	agg.Store().RemoveSessionIfPresent("r")
	agg.Store().RefreshArchivedSnapshot([]json.RawMessage{
		json.RawMessage(`{"id":"r","time":{"archived":1}}`),
	})

	// Run the backstop — it MUST skip r (active cascade owns it).
	srv.reconcileArchiveFailures()

	// CRUX — the failure record is STILL present: the backstop refused to clear
	// because an active cascade is registered. The cascade's own terminal will
	// clear-on-success or leave the record (re-record-on-failure); the backstop
	// must not interfere.
	if !hasArchiveFailureID(t, srv, "r") {
		t.Errorf("r cleared by backstop WHILE an active cascade is registered (race-freedom violated — backstop raced the cascade): %+v", srv.ArchiveFailures())
	}
}

// BT3 — active-jobs registry lifecycle: a cascade registers (dir, root) at
// launch and deregisters on EVERY terminal path. A leaked entry would make the
// backstop permanently skip that root (the warning would never clear via the
// backstop). Asserts the registry is empty after BOTH the success and the
// exhaust terminals.
func TestBackstop_ActiveJobsRegistryLifecycle(t *testing.T) {
	t.Run("success_terminal", func(t *testing.T) {
		f := &fakeOC{} // 200 success
		web, agg, srv, root := queueLifecycleServer(t, f)
		srv.SetReassertDelay(5 * time.Millisecond)
		// r archived in OpenCode so the reassert phase is a no-op.
		f.listSessionsReply = []byte(`[{"id":"r","time":{"archived":1}}]`)
		agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
		seedQueueFile(t, root, "r")

		resp, _ := postArchive(t, web.URL, "r")
		resp.Body.Close()
		srv.awaitArchiveJobs(t, 5*time.Second)

		// CRUX — the registry is empty after a SUCCESS terminal: the cascade
		// registered ("", "r") at launch and deregistered via the deferred
		// deregisterArchiveJob at the end of runArchiveCascade.
		if n := srv.backstopActiveJobsCount(); n != 0 {
			t.Errorf("active-jobs registry not empty after success terminal (leaked %d entries — backstop would permanently skip these roots): %+v", n, srv.archiveJobsActiveRoots)
		}
	})

	t.Run("exhaust_terminal", func(t *testing.T) {
		f := &fakeOC{archiveStatusByID: map[string]int{"r": http.StatusForbidden}} // permanent failure
		web, agg, srv, root := queueLifecycleServer(t, f)
		srv.SetArchiveRetryConfig(3, 1*time.Millisecond, 2*time.Millisecond)
		srv.SetReassertDelay(5 * time.Millisecond)
		agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
		seedQueueFile(t, root, "r")

		resp, _ := postArchive(t, web.URL, "r")
		resp.Body.Close()
		srv.awaitArchiveJobs(t, 5*time.Second)

		// CRUX — the registry is empty after an EXHAUST terminal too: even
		// though the cascade failed permanently and recorded a failure, the
		// deferred deregister still ran (the registry tracks in-flight jobs, not
		// failures — the failure registry is separate).
		if n := srv.backstopActiveJobsCount(); n != 0 {
			t.Errorf("active-jobs registry not empty after exhaust terminal (leaked %d entries): %+v", n, srv.archiveJobsActiveRoots)
		}
		// Sanity: the failure WAS recorded (the cascade reached terminal failure).
		if !hasArchiveFailureID(t, srv, "r") {
			t.Errorf("r not recorded as a failure after exhaust terminal (precondition for the backstop test)")
		}
	})
}

// BT4 — lock-order safety under -race: concurrent reconcileArchiveFailures +
// handleArchive (with an in-flight blocked cascade) must not deadlock or trip the
// race detector. This exercises the NEW bgMu → store.s.mu and bgMu →
// archiveFailuresMu nestings under contention: the backstop holds bgMu across the
// per-root decision while handleArchive's launch site waits on bgMu and the
// cascade goroutine (released from bgMu) touches the store + registry. The -race
// flag (in the green-bar command) is the verifier.
func TestBackstop_ConcurrentWithHandleArchive(t *testing.T) {
	f := &fakeOC{}
	web, agg, srv, root := queueLifecycleServer(t, f)
	srv.SetReassertDelay(2 * time.Millisecond)
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	seedQueueFile(t, root, "r")

	// Hold the cascade in-flight via archiveBlockCh so a real (dir,root) entry
	// sits in the active-jobs registry while the backstop runs concurrently —
	// this is the contention shape the race-freedom predicate must survive.
	f.archiveBlockCh = make(chan struct{})
	f.archiveReachedCh = make(chan struct{}, 16)

	// Launch the cascade (it blocks at SetArchived(r)).
	resp, _ := postArchive(t, web.URL, "r")
	resp.Body.Close()
	// Wait until the cascade is demonstrably in-flight (reached SetArchived).
	select {
	case <-f.archiveReachedCh:
	case <-time.After(3 * time.Second):
		t.Fatalf("cascade never reached the blocked SetArchived")
	}

	// Run the backstop concurrently with the in-flight cascade for a bounded
	// window. The backstop will SEE ("", "r") as active and skip it; the crux is
	// that this concurrent access under bgMu + store.s.mu + archiveFailuresMu
	// does not deadlock or race.
	var wg sync.WaitGroup
	stop := make(chan struct{})
	for i := 0; i < 4; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				select {
				case <-stop:
					return
				default:
					srv.reconcileArchiveFailures()
				}
			}
		}()
	}
	// Let the contention run briefly, then stop + release the cascade.
	time.Sleep(150 * time.Millisecond)
	close(stop)
	wg.Wait()

	// While blocked, the backstop must NOT have cleared the in-flight root's
	// (still-absent) failure — there is no failure record here (the cascade is
	// blocked mid-success, before any record/clear), so this is a no-op
	// assertion that confirms the sweep ran without disturbing the registry.
	// Release the cascade and confirm it completes (no deadlock held it).
	close(f.archiveBlockCh)
	srv.awaitArchiveJobs(t, 5*time.Second)

	// CRUX — the cascade completed despite concurrent backstop sweeps: r was
	// PATCHed (the cascade was not starved or deadlocked by the backstop's bgMu
	// holds) and removed from the live store (success).
	patches := archivedPATCHes(f)
	if countID(patches, "r") < 1 {
		t.Errorf("r never PATCHed (cascade deadlocked/starved by concurrent backstop?): %v", patches)
	}
	if agg.Store().Descendants("r") != nil {
		t.Errorf("r still in live store (cascade did not complete after concurrent backstop)")
	}
	// The active-jobs registry drained cleanly (no leaked entry from the
	// concurrent sweep + cascade).
	if n := srv.backstopActiveJobsCount(); n != 0 {
		t.Errorf("active-jobs registry leaked %d entries after concurrent run", n)
	}
}
