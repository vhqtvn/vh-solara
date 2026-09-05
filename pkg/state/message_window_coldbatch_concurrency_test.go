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
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/json"
	"io"
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

// TestColdBatchHookExhaustionFlipDiscardsStaleHasOlder is the has_older OUTCOME
// crux for the empty floor-reaching merge's msgRev bump (the revision gap the
// truthfulness fix left open): a publishColdBatch that captured
// (list, historyExhausted=false) BEFORE the flip must NOT be able to emit its
// stale has_older=true window AFTER the flip. The hook fires the empty
// floor-reaching merge BETWEEN capture and validation (mid-package,
// deterministic — the hook is synchronous, no goroutine race needed):
//
//   - attempt 0: capture (3-message light tail, exhausted=false, rev T) with
//     window has_older=true; hook runs MergeOlderMessages(sid, nil, true) →
//     flag flips + msgRev bumps T→T+1; the packaged window says has_older=true;
//     validation msgRev==T? NO → DISCARD (stale capture rejected).
//   - attempt 1: capture (same list, exhausted=true, rev T+1) with window
//     has_older=false; hook merges again (flag already true → NO bump);
//     validation msgRev==T+1? YES → EMIT.
//
// The load-bearing assertion is on the EMITTED batch's window.has_older (the
// user-visible truthfulness outcome), NOT merely the revision mechanics:
// without the bump, this exact scenario emits the stale has_older=true batch
// (attempt 0 passes validation because the flag changed while the token
// didn't). The ==2 hook-attempts pin also catches repeat-flip churn at the
// outcome level: a merge that re-bumped on the already-true flag would fail
// attempt 1's validation and force a third capture.
func TestColdBatchHookExhaustionFlipDiscardsStaleHasOlder(t *testing.T) {
	const sid = "s" // matches pageMsg's embedded sessionID
	s := mustNew(t, DefaultConfig(100))
	s.Apply(ev("session.created", `{"info":{"id":"s","title":"S"}}`))
	res := s.SetSessionMessagesExhausted(sid, []MessageWithParts{
		pageMsg("m1", 10), pageMsg("m2", 10), pageMsg("m3", 10),
	}, false) // fetch-truncated light tail: has_older=true, exhausted=false
	if res.Status != ColdBatchEmitted {
		t.Fatalf("seed: SetSessionMessagesExhausted want ColdBatchEmitted, got %v", res.Status)
	}

	// Firehose subscriber (the plain Subscribe pattern the other batch tests
	// use); the seed-time batch predates the subscription, drain residue.
	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainAll(ch)

	var hookAttempts int
	coldBatchAfterCaptureHook = func(hsid string) {
		if hsid != sid {
			return
		}
		hookAttempts++
		// THE crux call on EVERY capture attempt: the empty floor-reaching
		// merge, mid-package. First fire flips the flag + bumps msgRev;
		// later fires hit the already-true flag and must NOT bump.
		s.MergeOlderMessages(sid, nil, true)
	}
	t.Cleanup(func() { coldBatchAfterCaptureHook = nil })

	if status := s.publishColdBatch(sid); status != ColdBatchEmitted {
		t.Fatalf("publishColdBatch: want ColdBatchEmitted, got %v", status)
	}

	// CRUX — the emitted batch's window is the POST-flip truthful one.
	batches := collectBatches(t, ch)
	if len(batches) != 1 {
		t.Fatalf("want exactly 1 emitted cold batch, got %d", len(batches))
	}
	window := decodeBatchWindow(t, batches[0].Payload)
	if window.HasOlder {
		t.Fatalf("CRUX FAIL: emitted cold batch window.has_older=true — the STALE exhausted=false capture leaked through the ABA guard (want false, the post-flip truthful end-of-history)")
	}
	if window.MessageCount != 3 {
		t.Fatalf("emitted window message_count: want 3 (same resident list, only the flag changed), got %d", window.MessageCount)
	}
	// Exactly 2 capture attempts: 1 stale-discarded + 1 emitted. This also
	// proves the repeat flip did not re-bump (a re-bump would fail attempt
	// 1's validation and force attempt 2, surfacing here as 3+).
	if hookAttempts != 2 {
		t.Fatalf("publishColdBatch capture attempts: got %d (via hookAttempts), want exactly 2 (1 stale-discarded + 1 emitted)", hookAttempts)
	}
}

// TestColdBatchHookAllDupesFloorFlipDiscardsStaleHasOlder is the has_older
// OUTCOME crux for the ALL-DUPLICATES floor-reaching merge — the residual ABA
// sibling of TestColdBatchHookExhaustionFlipDiscardsStaleHasOlder: the
// f57c32f9 bump keyed on len(items)==0, but a NON-empty floor page whose every
// item is already resident (the overlap anchor re-served, or ids that arrived
// live before the page landed) dedups `prepend` to nothing and STILL flips
// historyExhausted false→true. A publishColdBatch that captured (list,
// exhausted=false) before that flip must NOT be able to emit its stale
// has_older=true window after it. The hook fires the all-resident
// floor-reaching merge BETWEEN capture and validation (mid-package,
// deterministic — the hook is synchronous):
//
//   - attempt 0: capture (3-message light tail, exhausted=false, rev T) with
//     window has_older=true; hook runs MergeOlderMessages(sid, [m1,m2,m3],
//     true) → every id resident → ZERO prepends, flag flips, msgRev bumps
//     T→T+1; the packaged window still says has_older=true; validation
//     msgRev==T? NO → DISCARD (stale capture rejected).
//   - attempt 1: capture (same list, exhausted=true, rev T+1) with window
//     has_older=false; hook merges the same page again (flag already true →
//     NO bump; dedup still prepends nothing); validation msgRev==T+1? YES →
//     EMIT.
//
// The load-bearing assertion is the EMITTED batch's window.has_older=false
// (the user-visible truthfulness outcome), NOT the revision counter: with the
// flip half of the bump condition disabled, this exact scenario emits the
// stale has_older=true batch (attempt 0 passes validation because the flag
// changed while the token didn't). The ==2 hook-attempts pin also catches
// repeat-flip churn at the outcome level (a merge that re-bumped on the
// already-true flag would fail attempt 1's validation and force a third
// capture).
func TestColdBatchHookAllDupesFloorFlipDiscardsStaleHasOlder(t *testing.T) {
	const sid = "s" // matches pageMsg's embedded sessionID
	s := mustNew(t, DefaultConfig(100))
	s.Apply(ev("session.created", `{"info":{"id":"s","title":"S"}}`))
	res := s.SetSessionMessagesExhausted(sid, []MessageWithParts{
		pageMsg("m1", 10), pageMsg("m2", 10), pageMsg("m3", 10),
	}, false) // fetch-truncated light tail: has_older=true, exhausted=false
	if res.Status != ColdBatchEmitted {
		t.Fatalf("seed: SetSessionMessagesExhausted want ColdBatchEmitted, got %v", res.Status)
	}

	// Firehose subscriber (the plain Subscribe pattern the sibling test
	// uses); the seed-time batch predates the subscription, drain residue.
	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainAll(ch)

	// The all-resident floor page: NON-empty, but the byID dedup empties
	// `prepend` — the exact shape the len(items)==0-keyed bump missed.
	allDupes := []MessageWithParts{pageMsg("m1", 10), pageMsg("m2", 10), pageMsg("m3", 10)}
	var hookAttempts int
	coldBatchAfterCaptureHook = func(hsid string) {
		if hsid != sid {
			return
		}
		hookAttempts++
		// THE crux call on EVERY capture attempt: the all-resident
		// floor-reaching merge, mid-package. First fire flips the flag +
		// bumps msgRev with zero prepends; later fires hit the already-true
		// flag and must NOT bump.
		s.MergeOlderMessages(sid, allDupes, true)
	}
	t.Cleanup(func() { coldBatchAfterCaptureHook = nil })

	if status := s.publishColdBatch(sid); status != ColdBatchEmitted {
		t.Fatalf("publishColdBatch: want ColdBatchEmitted, got %v", status)
	}

	// CRUX — the emitted batch's window is the POST-flip truthful one.
	batches := collectBatches(t, ch)
	if len(batches) != 1 {
		t.Fatalf("want exactly 1 emitted cold batch, got %d", len(batches))
	}
	window := decodeBatchWindow(t, batches[0].Payload)
	if window.HasOlder {
		t.Fatalf("CRUX FAIL: emitted cold batch window.has_older=true — the STALE exhausted=false capture leaked through the ABA guard on the all-dupes flip path (want false, the post-flip truthful end-of-history)")
	}
	if window.MessageCount != 3 {
		t.Fatalf("emitted window message_count: want 3 (same resident list; the all-dupes page prepended nothing), got %d", window.MessageCount)
	}
	// Exactly 2 capture attempts: 1 stale-discarded + 1 emitted. This also
	// proves the repeat all-dupes flip did not re-bump (a re-bump would fail
	// attempt 1's validation and force attempt 2, surfacing here as 3+).
	if hookAttempts != 2 {
		t.Fatalf("publishColdBatch capture attempts: got %d (via hookAttempts), want exactly 2 (1 stale-discarded + 1 emitted)", hookAttempts)
	}
}

// messageTerminalFromBatch decodes a KindMessagesBatch payload (same gzip64
// envelope as partTextFromBatch) and returns (time.completed?,
// info.error.name) for the named message — the terminal-state view the sweep's
// ABA regression asserts on.
func messageTerminalFromBatch(t *testing.T, payload json.RawMessage, sid, mid string) (bool, string) {
	t.Helper()
	var env struct {
		SessionID string `json:"sessionID"`
		Encoding  string `json:"encoding"`
		Data      string `json:"data"`
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		t.Fatalf("batch payload unmarshal: %v", err)
	}
	if env.SessionID != sid || env.Encoding != "gzip64" {
		t.Fatalf("batch envelope: sessionID=%q encoding=%q", env.SessionID, env.Encoding)
	}
	raw, err := base64.StdEncoding.DecodeString(env.Data)
	if err != nil {
		t.Fatalf("batch base64 decode: %v", err)
	}
	gr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatalf("batch gzip reader: %v", err)
	}
	inner, err := io.ReadAll(gr)
	if err != nil {
		t.Fatalf("batch gunzip: %v", err)
	}
	if err := gr.Close(); err != nil {
		t.Fatalf("batch gzip close: %v", err)
	}
	var p struct {
		Messages []MessageWithParts `json:"messages"`
	}
	if err := json.Unmarshal(inner, &p); err != nil {
		t.Fatalf("batch inner unmarshal: %v", err)
	}
	for _, m := range p.Messages {
		var me struct {
			ID   string `json:"id"`
			Time struct {
				Completed *float64 `json:"completed"`
			} `json:"time"`
			Error *struct {
				Name string `json:"name"`
			} `json:"error"`
		}
		if err := json.Unmarshal(m.Info, &me); err != nil || me.ID != mid {
			continue
		}
		name := ""
		if me.Error != nil {
			name = me.Error.Name
		}
		return me.Time.Completed != nil, name
	}
	t.Fatalf("message %s/%s not found in batch", sid, mid)
	return false, ""
}

// TestColdBatchHookSweepMarkDiscardsStaleBatch is the bc-F1 ABA regression:
// markInterruptedLocked mutates me.info/me.completed, so it MUST bump the
// session's msgRev (the Store-wide nextMsgRev ABA contract — the mirror of
// upsertMessageLocked's bump). Without the bump, a cold messages.batch
// projection captured just BEFORE the sweep and packaged outside s.mu passes
// publishColdBatch's revision validation and transiently replaces the marked
// row client-side (the client treats messages.batch as a WHOLESALE
// replacement) until the next reconcile.
//
// The hook fires the sweep's confirming statuses observation BETWEEN capture
// and validation (mid-package, deterministic — the hook is synchronous):
//
//   - attempt 0: capture the UNMARKED orphan row at rev T; hook runs
//     SetActivityFromStatuses (the 2nd consecutive not-busy observation — the
//     1st was primed before publishColdBatch) → sweep marks + bumps T→T+1;
//     validation msgRev==T? NO → DISCARD (the stale pre-sweep batch is
//     rejected — the crux).
//   - attempt 1: capture the MARKED row at rev T+1; hook fires a 3rd
//     observation (predicate no-op — the entry is completed — NO bump);
//     validation msgRev==T+1? YES → EMIT.
//
// The load-bearing assertion is on the EMITTED batch's terminal state (the
// client-visible outcome), not the revision counter: with the bc-F1 bump
// removed, this exact scenario emits the STALE unmarked batch on attempt 0.
func TestColdBatchHookSweepMarkDiscardsStaleBatch(t *testing.T) {
	const sid = "s_sweep_aba"
	s := mustNew(t, DefaultConfig(100))
	s.Apply(ev("session.created", `{"info":{"id":"`+sid+`","title":"S"}}`))
	// Cold-load the orphan shape (completed user turn + UNCOMPLETED newest
	// assistant): resident, unmarked, and the session is batchable (msgLoaded).
	res := s.SetSessionMessagesExhausted(sid, []MessageWithParts{
		{Info: json.RawMessage(`{"id":"u1","sessionID":"` + sid + `","role":"user","time":{"created":10,"completed":11}}`)},
		{Info: json.RawMessage(`{"id":"oa1","sessionID":"` + sid + `","role":"assistant","time":{"created":20}}`)},
	}, true)
	if res.Status != ColdBatchEmitted {
		t.Fatalf("seed: SetSessionMessagesExhausted want ColdBatchEmitted, got %v", res.Status)
	}
	// Prime the sweep-stability latch (d-F1): observation 1 of 2 — the row
	// stays unmarked (a single not-busy observation must not sweep).
	s.SetActivityFromStatuses(map[string]json.RawMessage{})
	if c, te, _ := orphanState(t, s, sid, "oa1"); c || te != "" {
		t.Fatalf("seed: obs-1 must not mark (completed=%v err=%q)", c, te)
	}

	// Firehose subscriber; the seed-time batch predates it, drain residue.
	ch, unsub := s.Subscribe(256)
	defer unsub()
	drainAll(ch)

	var hookAttempts int
	coldBatchAfterCaptureHook = func(hsid string) {
		if hsid != sid {
			return
		}
		hookAttempts++
		// THE crux call on EVERY capture attempt: a successful not-busy
		// statuses observation lands mid-package. Attempt 0's call is the
		// CONFIRMING observation (sweep marks + bumps); attempt 1's is a
		// further no-op observation (entry completed → no bump).
		s.SetActivityFromStatuses(map[string]json.RawMessage{})
	}
	t.Cleanup(func() { coldBatchAfterCaptureHook = nil })

	if status := s.publishColdBatch(sid); status != ColdBatchEmitted {
		t.Fatalf("publishColdBatch: want ColdBatchEmitted, got %v", status)
	}

	// CRUX — the EMITTED batch carries the MARKED row; the stale pre-sweep
	// capture (completed=false, no error) never landed.
	batches := collectBatches(t, ch)
	if len(batches) != 1 {
		t.Fatalf("want exactly 1 emitted cold batch, got %d", len(batches))
	}
	completed, errName := messageTerminalFromBatch(t, batches[0].Payload, sid, "oa1")
	if !completed || errName != InterruptedTurnErrorName {
		t.Fatalf("CRUX FAIL: emitted batch carries the STALE pre-sweep row (completed=%v err=%q) — the sweep's bumpMsgRev did not invalidate the in-flight batch", completed, errName)
	}
	// Exactly 2 capture attempts: 1 stale-discarded + 1 emitted (convergent,
	// no loop; also proves attempt 1's observation did not re-bump).
	if hookAttempts != 2 {
		t.Fatalf("publishColdBatch capture attempts: got %d (via hookAttempts), want exactly 2 (1 stale-discarded + 1 emitted)", hookAttempts)
	}
}
