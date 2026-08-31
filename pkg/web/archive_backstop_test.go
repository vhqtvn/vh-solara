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
//   BT5  Non-root contention (tier1_b-F4 proof gap): a failure keyed by a
//        NON-ROOT descendant under an ACTIVE root cascade — the registry guard
//        is a no-op for (dir, descendant) keys, so the clear is gated SOLELY by
//        the resolution seam (survives unresolved; clears at OOB resolution
//        while the root cascade is still registered).
//
// The crux is BT1 + BT2 together: the backstop clears a genuinely-resolved stale
// warning (BT1) AND refuses to race a running cascade (BT2). Both halves are
// exercised at the Go unit seam (unlike Slice 1's e2e gap), so `proven` is honest.
// BT5 closes the proof-completeness gap those two left: BT1/BT2 exercise
// ROOT-keyed failures only, where the registry key and the failure key MATCH.
// The non-root path (registry key ≠ failure key) is correct-by-construction
// (runArchiveCascade is one-shot-per-id; the clear fires only on confirmed OOB
// resolution) — BT5 turns that assessment into a deterministic proof.

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

// BT5 — the NON-ROOT contention proof (tier1_b-F4 gap). The active-jobs registry
// is keyed by (dir, ROOT) — the id handleArchive registers (body.SessionID) — but
// classifyArchiveFailure records a failure keyed by the id that reached terminal
// failure, which can be a NON-ROOT descendant (an unresolvable chain that is NOT
// a descendant-of-archived). For such a key reconcileOneArchiveFailure's
// active-jobs lookup MISSES (the registry holds the root, not the descendant), so
// the guard contributes nothing and the clear is gated SOLELY by the resolution
// seam (Store.IsArchiveRootResolved).
//
// The two halves proven here, deterministically (no dispatch, no sleeps beyond
// the SSE idle-drains BT1 already uses):
//
//	PHASE 1 (cascade active, descendant UNRESOLVED): the failure SURVIVES —
//	  nothing but the resolution seam withholds the clear. This is the
//	  discrimination assertion: neutering the IsArchiveRootResolved guard in
//	  reconcileOneArchiveFailure makes exactly this phase fail (BT1/BT2 stay
//	  green under that mutation — their keys are root-keyed and guard-covered).
//	PHASE 2 (cascade STILL active, descendant OOB-resolved): the failure
//	  CLEARS mid-cascade — the behavior the review panel unanimously assessed
//	  as correct-by-construction (runArchiveCascade is one-shot-per-id — the
//	  frozen `affected` loop never revisits d — so the running cascade cannot
//	  re-record the cleared failure).
func TestBackstop_NonRootFailureClearsOnlyViaResolution(t *testing.T) {
	f := &fakeOC{}
	web, agg, srv, _ := queueLifecycleServer(t, f)

	// Live tree: root r with child d. d's parentID chain terminates at LIVE r
	// — the unresolvable-chain shape classifyArchiveFailure RECORDS for the
	// child (both descendant-of-archived authorities fail: r is neither in the
	// authoritative archived snapshot nor in this job's succeeded set).
	agg.Store().Apply(ev("session.created", `{"info":{"id":"r"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"d","parentID":"r"}}`))

	// Seed the ACTIVE root cascade for r — the registry holds ("", "r"), the
	// (dir, ROOT) key handleArchive's launch site registers. Deterministic
	// direct seed (the registry IS the predicate — same seam as BT2).
	srv.registerActiveArchiveJobForTest("", "r")
	defer srv.deregisterActiveArchiveJobForTest("", "r")

	// Seed the NON-ROOT failure record for d — the exact state
	// classifyArchiveFailure produces via recordArchiveFailure(dir, d, r, …):
	// keyed ("", "d") with RootSrc=r. Note the key MISMATCH against the
	// registry's ("", "r") — the premise of this test.
	srv.recordArchiveFailure("", "d", "r", "permanent:403")
	if !hasArchiveFailureID(t, srv, "d") {
		t.Fatalf("seed: d not recorded before backstop")
	}

	// Connect a client and drain the bootstrap snapshot (which carries d), so
	// the phase-2 clear's fan-out is observable (BT1's plumbing).
	sresp, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer sresp.Body.Close()
	ch := startSSEReader(t, sresp.Body)
	drainIdle(ch, 500*time.Millisecond)

	// PHASE 1 — root cascade ACTIVE, d unresolved (live, not in the archived
	// snapshot, chain ends at live r → IsArchiveRootResolved("d") == false).
	// The registry guard is a no-op for key ("", "d"), so ONLY the resolution
	// seam can withhold the clear. Assert the failure survives.
	srv.reconcileArchiveFailures()
	if !hasArchiveFailureID(t, srv, "d") {
		t.Errorf("PHASE 1: non-root failure d cleared while UNRESOLVED with the root cascade active — the resolution seam (IsArchiveRootResolved) failed to gate the non-root clear: %+v", srv.ArchiveFailures())
	}

	// PHASE 2 — establish OOB resolution of d through the EXISTING resolution
	// seam's absent-from-live-tree authority: d archived/deleted out-of-band
	// (another tool / direct OpenCode call) → the tree-reconcile tick would
	// evict it from the live session tree. Model that eviction here. The root
	// cascade is STILL registered — this is the mid-cascade contention window.
	agg.Store().RemoveSessionIfPresent("d")
	srv.reconcileArchiveFailures()

	// CRUX 1 — the failure cleared exactly at resolution, the registry guard
	// notwithstanding: the mid-cascade clear fired through the resolution seam.
	if hasArchiveFailureID(t, srv, "d") {
		t.Errorf("PHASE 2: non-root failure d still recorded after OOB resolution (clear did not fire through the resolution seam while the root cascade was active): %+v", srv.ArchiveFailures())
	}

	// CRUX 2 — the mid-cascade premise held: the root cascade was STILL
	// registered when the clear fired, so the clear is not explained by
	// deregistration (the guard was genuinely a no-op for the non-root key).
	if n := srv.backstopActiveJobsCount(); n != 1 {
		t.Errorf("root cascade registration did not survive the clear (want 1 active entry, got %d) — the mid-cascade premise collapsed", n)
	}

	// CRUX 3 — the clear was fanned out: the connected client received an
	// archive-failures.updated frame with an empty failures set (client-visible
	// clear, mirroring BT1's second crux).
	evs := drainIdle(ch, 800*time.Millisecond)
	data, ok := eventDataFor(evs, "archive-failures.updated", "failures")
	if !ok {
		t.Fatalf("no archive-failures.updated frame after non-root clear; events=%v", eventNames(evs))
	}
	doc := decodeArchiveFailuresSSE(t, data)
	if len(doc.Failures) != 0 {
		t.Errorf("updated frame not empty after non-root clear (got %d failures): %+v", len(doc.Failures), doc)
	}
}
