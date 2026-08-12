package state

// message_window_coldbatch_concurrency_test.go — DEFER #4 (part-append-stream
// redesign): the concurrent cold-batch-hook goroutine test that closes the
// coverage gap around the ABA guard (bumpMsgRev + publishColdBatch's
// discard-retry loop).
//
// The guard is correct BY INSPECTION: Snapshot flushes buffered streaming
// deltas via flushAllBufferedDeltasLocked (which writes me.parts + bumps
// msgRev for any flushed session), and publishColdBatch revalidates msgRev[sid]
// after packaging and discards+retries when it advanced during packaging. The
// existing TestSnapshotDoesNotMutateColdBatchCapture exercises the
// coldBatchAfterCaptureHook but only with a Snapshot that has NO unflushed
// deltas remaining (the sanity-check Snapshot at the top of that test already
// flushed everything) — so the discard-retry branch never fires there.
//
// This test arms the hook to fire a Snapshot that HAS unflushed part deltas (so
// the hook-time Snapshot flushes + bumps msgRev) WHILE a cold batch is
// mid-package, then asserts the ABA guard discards the stale package and emits
// exactly ONE batch carrying the post-flush (authoritative) part text — under
// -race, with the retry/fail-safe bounds holding (no infinite loop, no
// deadlock).

import (
	"sync"
	"testing"
	"time"
)

// TestColdBatchHookFiresFlushingSnapshotMidPackage is the load-bearing DEFER #4
// test. It proves the ABA guard end-to-end under the exact concurrency shape it
// was designed for: a Snapshot fired INSIDE the coldBatchAfterCapture hook has
// unflushed deltas, so it flushes + bumps msgRev WHILE a cold batch is
// mid-package (between capture and validation).
//
// Scenario (deterministic):
//  1. Seed session "snap" with m1/p1 text "BASE".
//  2. Delta "A": first delta flushes (deltaLastEmit zero) → me.parts "BASEA",
//     deltaSentLen=1, msgRev bumped to T.
//  3. Delta "B": throttled (DeltaFlushInterval=time.Hour) → stays in deltaBuf;
//     me.parts lags at "BASEA" while the accumulator holds "BASEAB".
//  4. Arm coldBatchAfterCaptureHook to call s.Snapshot({"snap":true}) on every
//     fire for "snap". On the FIRST capture (attempt 0) the hook-time Snapshot
//     flushes "B" (me.parts→"BASEAB", deltaSentLen→2, msgRev bumped T→T+1).
//  5. publishColdBatch("snap") in a goroutine:
//     - attempt 0: capture me.parts "BASEA" + rev T; hook fires (Snapshot
//     flushes, rev→T+1); package "BASEA"; validate msgRev==T? NO (T+1) →
//     discard, retry.
//     - attempt 1: capture me.parts "BASEAB" + rev T+1; hook fires (Snapshot —
//     nothing left to flush on "snap", no bump); package "BASEAB"; validate
//     msgRev==T+1? YES → emit.
//
// A concurrent "churn" goroutine applies deltas to a SEPARATE session ("churn")
// throughout, giving -race genuine cross-goroutine store access (the store lock
// serializes it; captureMessagesBatchLocked's byte-copy keeps packaging
// race-free vs the live mutation). The "snap" batch outcome is unaffected by the
// churn (independent per-session revisions).
//
// Assertions:
//   - The hook fired a flushing Snapshot at least once (the crux: the path was
//     exercised).
//   - Exactly ONE cold batch is emitted, carrying "BASEAB" (the post-flush
//     authoritative text), NEVER "BASEA" (the stale pre-flush text).
//   - publishColdBatch converged in exactly 2 capture attempts (1 discard + 1
//     emit) — well beneath the maxColdBatchRetries=8 fail-safe, so no infinite
//     loop and no deadlock (the test reached its assertion).
//
// Run under `go test -race ./pkg/state/...`: the race detector is a mandatory
// assertion here (no data race between the hook's Snapshot writing me.parts and
// publishColdBatch reading the captured projection bytes outside the lock).
func TestColdBatchHookFiresFlushingSnapshotMidPackage(t *testing.T) {
	// Force throttling so delta "B" stays buffered deterministically
	// (independent of host scheduling jitter). The shrink is on the instance
	// (GAP-S5): a -race run cannot observe a global mutation racing a prior
	// iteration's lingering goroutine.
	s := mustNew(t, withFlushInterval(DefaultConfig(100), time.Hour))
	seedOnePartSession(s, "snap", "BASE")
	// A separate session for concurrent churn (-race cross-goroutine coverage).
	// Its exact state is not asserted; it only exercises concurrent locked
	// access of the store's maps while publishColdBatch packages "snap".
	seedOnePartSession(s, "churn", "C")

	// delta "A": first delta always flushes (deltaLastEmit zero) → me.parts
	// "BASEA", deltaSentLen=1.
	applyDelta(s, "snap", "m1", "p1", "text", "A")
	// delta "B": throttled → stays in deltaBuf; me.parts still "BASEA" but the
	// accumulator holds "BASEAB".
	applyDelta(s, "snap", "m1", "p1", "text", "B")

	// Arm the hook: fire a Snapshot on "snap" on EVERY capture attempt. The
	// hook-time Snapshot runs while publishColdBatch is between its capture and
	// validation (mid-package). On attempt 0 it flushes "B" + bumps msgRev; on
	// attempt 1 there is nothing left to flush on "snap" (no bump).
	hookSnapshotsWithFlush := 0
	var hookAttempts int
	coldBatchAfterCaptureHook = func(sid string) {
		if sid != "snap" {
			return
		}
		hookAttempts++
		// Detect whether "snap" still has unflushed deltas BEFORE the Snapshot
		// runs (under RLock) — if so, this hook-time Snapshot will flush + bump
		// msgRev, which is the crux scenario.
		s.mu.RLock()
		var willFlush bool
		if sm := s.messages["snap"]; sm != nil {
			willFlush = hasUnflushedDeltasLocked(sm.byID["m1"])
		}
		s.mu.RUnlock()
		// THE crux call: a Snapshot fired inside the hook, mid-package.
		s.Snapshot(map[string]bool{"snap": true})
		if willFlush {
			hookSnapshotsWithFlush++
		}
	}
	t.Cleanup(func() { coldBatchAfterCaptureHook = nil })

	// Subscriber to observe emitted events (the flush suffix + the cold batch).
	// SubscribeWith so we receive KindPartAppend (proving the flush emitted) and
	// KindMessagesBatch (the cold batch we assert on).
	ch, unsub := s.SubscribeWith(256, Interest{WantsPartDelta: true})
	defer unsub()
	drainAll(ch) // drop seed / initial-flush noise before the scenario

	// Concurrent churn goroutine: applies deltas to "churn" while
	// publishColdBatch packages "snap". Bounded so it definitely terminates.
	// The store lock serializes every access; captureMessagesBatchLocked's
	// byte-copy keeps publishColdBatch's packaging race-free vs this live
	// mutation. This is what gives -race genuine cross-goroutine bytes to
	// observe (not just a single-goroutine test that happens to run -race).
	const churnCount = 200
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		for i := 0; i < churnCount; i++ {
			applyDelta(s, "churn", "m1", "p1", "text", string(rune('a'+(i%26))))
		}
	}()

	// Run publishColdBatch("snap"). It runs to completion (the hook is
	// synchronous — no channel handoff, no deadlock surface): attempt 0
	// discards, attempt 1 emits.
	done := make(chan struct{})
	go func() {
		s.publishColdBatch("snap")
		close(done)
	}()
	<-done

	wg.Wait()

	// === ASSERTION 1: the crux path was exercised ===
	// The hook fired a Snapshot that flushed "snap"'s buffered deltas at least
	// once. Without this, the test did not exercise the ABA guard at all.
	if hookSnapshotsWithFlush < 1 {
		t.Fatalf("hook never fired a flushing Snapshot mid-package (hookSnapshotsWithFlush=%d) — scenario did not exercise the ABA guard", hookSnapshotsWithFlush)
	}

	// === ASSERTION 2: exactly ONE batch, carrying the post-flush text ===
	// The stale attempt-0 package ("BASEA") was discarded; the retry captured
	// and emitted the authoritative post-flush text ("BASEAB"). No stale /
	// partial batch lands.
	batches := collectBatches(t, ch)
	if len(batches) != 1 {
		t.Fatalf("want exactly 1 cold batch (stale discarded, retry emitted), got %d", len(batches))
	}
	got := partTextFromBatch(t, batches[0].Payload, "snap", "m1", "p1")
	if want := "BASEAB"; got != want {
		t.Fatalf("batch part text: want %q (post-flush authoritative), got %q (stale pre-flush text leaked through — ABA guard failed to discard)", want, got)
	}

	// === ASSERTION 3: retry / fail-safe bounds held ===
	// publishColdBatch converged in exactly 2 capture attempts (1 discard + 1
	// emit). This proves no infinite loop and (since we reached the assertion)
	// no deadlock. 2 << maxColdBatchRetries (8), so the fail-safe locked
	// repackage was never needed. (hookAttempts == len(captures).)
	if hookAttempts != 2 {
		t.Fatalf("publishColdBatch capture attempts: got %d (via hookAttempts), want 2 (1 discard + 1 emit) — non-convergent or extra retries", hookAttempts)
	}
}
