package state

// This file pins the completion-grace supersede contract (GAP-S1 from the
// store concurrency map): the graceGen generation counter is the authoritative
// supersede signal for the single goroutine the Store spawns (G-S1, the
// time.AfterFunc completion-grace callback). time.Timer.Stop does NOT
// guarantee the callback will not run once started, so every grace-canceling
// site (new inflight, session.idle, delete, hydrate, Close) bumps graceGen
// under s.mu, and graceFire re-checks it under s.mu and aborts on mismatch.
//
// Before this file, exactly ONE test covered the whole grace machinery
// (TestBusyCompletionStrand_NoSessionIdle_StrandsRunningRoots in
// store_busy_completion_test.go) and it characterized the strand fix, NOT the
// race-closer itself. These tests are the mandatory pre-split gate for any
// concern extraction that moves armGrace / cancelGrace / graceFire (concern g
// in the concurrency map): without them, a split can silently regress the
// supersede guard and re-introduce the stranded-busyCount race the strand fix
// closed.
//
// All tests run under -race (the cohort's standard invocation). The
// deterministic ones prove the graceGen no-op outcome; the concurrent one
// stresses the actual fire-vs-cancel race window.

import (
	"encoding/json"
	"fmt"
	"runtime"
	"sync"
	"testing"
	"time"
)

// graceStateSnapshot is a test-only read of the grace machinery's internal
// state for one session, captured under s.mu. It lets these characterization
// tests assert the graceGen / graceTimers / completionAuthoritative
// invariants directly — the public API only exposes RunningRoots / activity,
// which is too coarse to prove the supersede guard fired (a stale fire that
// no-op'd is observationally identical to a fire that never happened, unless
// you read graceGen + completionAuthoritative).
//
// `rootBusy` is s.subtreeBusyCount[id] (the single source of truth for the
// per-root busy aggregate, meaningful when id IS a root — all tests here use
// root sessions). Returns the post-snapshot values; safe to call after
// Close() (the mutex survives teardown; only subs are emptied).
func (s *Store) graceStateSnapshot(id string) (gen uint64, armed bool, authoritative bool, rootBusy int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	gen = s.graceGen[id]
	_, armed = s.graceTimers[id]
	authoritative = s.completionAuthoritative[id]
	rootBusy = s.subtreeBusyCount[id]
	return
}

// withCompletionGrace sets the per-instance completion-grace window on a Config
// (the GAP-S5-promoted tunable), returning the modified Config for chaining.
// Pair with mustNew so the value flows through Config.validate() at
// construction — no Store instance field is mutated post-construction. Mirrors
// withFlushInterval / withPartTextCap / withRecentArchiveTTL / withWindowBounds.
// Config.validate() rejects CompletionGrace <= 0, so a test that needs the
// tightest legal window uses time.Nanosecond (the validated equivalent of the
// former direct s.completionGrace = 0 mutation).
func withCompletionGrace(cfg Config, d time.Duration) Config {
	cfg.CompletionGrace = d
	return cfg
}

// TestGraceTimer_CancelSupersedesStaleFire is GAP-S1 case 1 (fire-vs-cancel):
// arm a grace timer, cancel it via a new inflight assistant message (the
// production cancel path), and assert the stale fire is a no-op.
//
// The contract (store.go:1641-1655, documented at 886-889): graceFire
// re-checks graceGen[sessionID] != gen and returns without clearing busy or
// arming completionAuthoritative when a cancel superseded the captured
// generation. time.Timer.Stop() losing the race (callback already running)
// is the exact case graceGen exists to close.
//
// This test is deterministic in OUTCOME regardless of host scheduling:
//   - If Stop() won: the timer never fires. busy stays 1.
//   - If Stop() lost (callback running / about to run): graceGen guard
//     aborts graceFire. busy stays 1.
//
// Either way busy stays 1 and authority stays clear — that is the
// race-closer's observable contract.
func TestGraceTimer_CancelSupersedesStaleFire(t *testing.T) {
	s := mustNew(t, withCompletionGrace(DefaultConfig(100), 15*time.Millisecond)) // small enough for a fast test
	defer s.Close()                                                               // GAP-S1: cancel armed grace so no timer fires into a later test

	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("message.updated", evAssistantInflight("R", "m1")))
	if got := s.RunningRoots(); got != 1 {
		t.Fatalf("inflight: RunningRoots=%d, want 1", got)
	}

	// Complete turn 1 → arm grace. graceGen[R] is bumped to armGen (the
	// exact value depends on prior cancel arms from the inflight path; we
	// capture it and compare relatively). Synchronously still busy: the
	// grace window protects multi-step turns.
	s.Apply(ev("message.updated", evAssistantCompleted("R", "m1")))
	armGen, armed, auth, busy := s.graceStateSnapshot("R")
	if !armed {
		t.Fatalf("after completion: grace timer should be armed, got disarmed")
	}
	if auth {
		t.Fatalf("after completion: authority should be clear (grace pending, not fired)")
	}
	if busy != 1 {
		t.Fatalf("after completion (grace pending): busy=%d, want 1", busy)
	}

	// Cancel the armed grace via a new inflight message (turn 2 starts).
	// cancelGraceLocked bumps graceGen[R] PAST armGen and stops+deletes the
	// timer. The armGen-captured callback (if it runs at all) will see the
	// bumped graceGen != armGen and abort.
	s.Apply(ev("message.updated", evAssistantInflight("R", "m2")))
	cancelGen, armed2, auth2, busy2 := s.graceStateSnapshot("R")
	if cancelGen <= armGen {
		t.Fatalf("after new inflight: graceGen=%d, want > %d (cancel must bump past the armed gen)", cancelGen, armGen)
	}
	if armed2 {
		t.Fatalf("after new inflight: grace timer should be deleted from graceTimers, still armed")
	}
	if auth2 {
		t.Fatalf("after new inflight: completionAuthoritative should be cleared (new turn started)")
	}
	if busy2 != 1 {
		t.Fatalf("after new inflight: busy=%d, want 1 (turn 2 re-armed busy)", busy2)
	}

	// Wait WELL past the original grace window. The armGen-captured timer
	// callback fires here (or was stopped — either way), takes s.mu, sees
	// graceGen[R]==cancelGen != armGen, and returns — a benign no-op.
	// Assert the session is STILL busy (the stale fire did not clear turn
	// 2's busy) and the authority guard is STILL clear (grace never
	// authoritatively fired). graceGen must be unchanged (no further bump
	// — the stale fire no-op'd without touching graceGen).
	time.Sleep(80 * time.Millisecond)
	gen3, armed3, auth3, busy3 := s.graceStateSnapshot("R")
	if gen3 != cancelGen {
		t.Fatalf("after stale-fire window: graceGen=%d, want %d (no further bump; stale fire no-op'd)", gen3, cancelGen)
	}
	if armed3 {
		t.Fatalf("after stale-fire window: no grace timer should be armed")
	}
	if auth3 {
		t.Fatalf("after stale-fire window: completionAuthoritative must still be false " +
			"(stale armGen fire no-op'd via graceGen guard) — got true")
	}
	if busy3 != 1 {
		t.Fatalf("after stale-fire window: busy=%d, want 1 (stale fire must not clear turn 2's busy)", busy3)
	}
	if got := s.RunningRoots(); got != 1 {
		t.Fatalf("after stale-fire window: RunningRoots=%d, want 1", got)
	}
}

// TestGraceTimer_ConcurrentArmCancelNoRace is the -race stress variant of the
// fire-vs-cancel test (GAP-S1). It rapidly arms and cancels grace timers
// across many sessions from multiple goroutines while a concurrent reader
// polls RunningRoots, then calls Close() (cancelAllGraceLocked) while timers
// are still armed.
//
// The graceGen guard + s.mu make every fire-vs-cancel a benign no-op; this
// test exists to catch any unsynchronized access under -race. The
// deterministic outcome is "no data race reported, no panic, Close()
// succeeds, no leaked timer mutates state post-Close". The -race detector is
// the verifier — a regression that introduces an unsynchronized read/write
// in the arm/cancel/fire path will fail this test under -race.
func TestGraceTimer_ConcurrentArmCancelNoRace(t *testing.T) {
	s := mustNew(t, withCompletionGrace(DefaultConfig(2000), time.Millisecond)) // tiny so timers fire frequently during the test

	// Seed N root sessions so writers spread across ids.
	const N = 40
	for i := 0; i < N; i++ {
		sid := fmt.Sprintf("s%d", i)
		s.Apply(ev("session.created", evSessionCreated(sid, "")))
	}

	var wg sync.WaitGroup
	stop := make(chan struct{})

	// Writers: rapidly inflight→complete cycles to arm/cancel grace. Uses a
	// bounded message-id space (iter%50) so the store's message map does not
	// grow unboundedly; the wrap-around re-inflights a completed message,
	// which is a real production scenario (re-upsert) the grace machinery
	// must also handle race-free.
	for w := 0; w < 4; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for iter := 0; ; iter++ {
				select {
				case <-stop:
					return
				default:
				}
				i := (iter + w) % N
				sid := fmt.Sprintf("s%d", i)
				mid := fmt.Sprintf("m%d", iter%50)
				s.Apply(ev("message.updated", evAssistantInflight(sid, mid)))
				s.Apply(ev("message.updated", evAssistantCompleted(sid, mid)))
			}
		}(w)
	}

	// Reader: poll RunningRoots concurrently to stress the read path while
	// grace fires mutate busyCount.
	wg.Add(1)
	go func() {
		defer wg.Done()
		for {
			select {
			case <-stop:
				return
			default:
			}
			_ = s.RunningRoots()
		}
	}()

	// Let the race window get exercised.
	time.Sleep(100 * time.Millisecond)
	close(stop)
	wg.Wait()

	// Final consistency: Close() calls cancelAllGraceLocked, which stops
	// every pending timer + bumps graceGen + deletes every graceTimers
	// entry. After Close + a grace period, no grace timer callback may
	// still be mutating store state. Assert graceTimers is empty.
	s.Close()
	// Allow the runtime to reap any timer goroutines that were mid-callback
	// when Close() bumped graceGen under them (they will re-acquire s.mu,
	// see the bumped gen, and abort).
	time.Sleep(30 * time.Millisecond)

	s.mu.Lock()
	armedCount := len(s.graceTimers)
	s.mu.Unlock()
	if armedCount != 0 {
		t.Fatalf("post-Close: graceTimers should be empty (cancelAllGraceLocked on Close), still has %d entries", armedCount)
	}

	// Sanity: the test reaching this point under -race without a reported
	// data race IS the assertion. Also bound leaked goroutines so a
	// regression that ORPHANS a timer callback (Stop lost + graceGen guard
	// regressed) surfaces as a goroutine leak.
	deadline := time.Now().Add(2 * time.Second)
	startGoroutines := runtime.NumGoroutine()
	for time.Now().Before(deadline) {
		if runtime.NumGoroutine() <= startGoroutines {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	// Do not hard-assert NumGoroutine (the runtime timer queue + GC noise
	// make exact counts flaky). The -race pass + graceTimers-empty check
	// above are the load-bearing assertions; this loop just gives stragglers
	// a chance to reap before the next test.
}

// TestGraceTimer_MultiStepRearmLatestWins is GAP-S1 case 2 (multi-step
// rearm): a multi-step turn (text → tool → text) arms and cancels grace
// repeatedly, and only the LATEST arm's callback must take effect.
//
// Sequence: step 1 completes (arm, gen=armGen1), step 2's inflight cancels
// (gen=cancelGen), step 2 completes (re-arm, gen=armGen2). When armGen2's
// timer fires, busy is cleared and authority is armed; the superseded
// armGen1 timer (stopped at step 2's cancel, but its callback may run if
// Stop lost the race) no-ops via the graceGen mismatch. Asserts graceGen is
// strictly monotonic across the lifecycle and the final fire reflects only
// the latest decision.
func TestGraceTimer_MultiStepRearmLatestWins(t *testing.T) {
	s := mustNew(t, withCompletionGrace(DefaultConfig(100), 15*time.Millisecond))
	defer s.Close() // GAP-S1: cancel armed grace so no timer fires into a later test

	s.Apply(ev("session.created", evSessionCreated("R", "")))

	// Step 1: inflight → busy armed (inflight path cancels grace, bumping gen).
	s.Apply(ev("message.updated", evAssistantInflight("R", "m1")))
	// Step 1 completes → arm grace (gen=armGen1).
	s.Apply(ev("message.updated", evAssistantCompleted("R", "m1")))
	armGen1, armed1, _, _ := s.graceStateSnapshot("R")
	if !armed1 {
		t.Fatalf("after step 1 completion: grace timer should be armed (first arm)")
	}

	// Step 2 inflight → cancel grace (gen=cancelGen > armGen1), clear
	// authority, re-arm busy.
	s.Apply(ev("message.updated", evAssistantInflight("R", "m2")))
	cancelGen, _, auth, busy := s.graceStateSnapshot("R")
	if cancelGen <= armGen1 {
		t.Fatalf("after step 2 inflight: graceGen=%d, want > %d (cancel must bump past armGen1)", cancelGen, armGen1)
	}
	if auth {
		t.Fatalf("after step 2 inflight: authority should be cleared (new turn)")
	}
	if busy != 1 {
		t.Fatalf("after step 2 inflight: busy=%d, want 1 (turn 2 re-armed)", busy)
	}

	// Step 2 completes → re-arm grace (gen=armGen2 > cancelGen).
	s.Apply(ev("message.updated", evAssistantCompleted("R", "m2")))
	armGen2, armed2, _, busy2 := s.graceStateSnapshot("R")
	if armGen2 <= cancelGen {
		t.Fatalf("after step 2 completion: graceGen=%d, want > %d (second arm must bump past cancelGen)", armGen2, cancelGen)
	}
	if !armed2 {
		t.Fatalf("after step 2 completion: grace timer should be armed (latest arm)")
	}
	if busy2 != 1 {
		t.Fatalf("after step 2 completion (grace pending): busy=%d, want 1", busy2)
	}

	// Wait for armGen2's timer to fire. Only armGen2's callback takes
	// effect: busy→0, authority armed. The superseded armGen1 timer
	// (stopped at step 2's cancel) no-ops via graceGen mismatch even if its
	// callback runs.
	if !waitForRunningRoots(s, 0, time.Second) {
		t.Fatalf("after armGen2 fire window: RunningRoots=%d, want 0 "+
			"(latest arm's callback must clear busy; stale armGen1 fire must be a no-op)", s.RunningRoots())
	}
	finalGen, finalArmed, finalAuth, _ := s.graceStateSnapshot("R")
	if finalGen != armGen2 {
		t.Fatalf("after fire: graceGen=%d, want %d (no further bump; stale armGen1 did not re-fire)", finalGen, armGen2)
	}
	if finalArmed {
		t.Fatalf("after fire: grace timer should be deleted (fired), still armed")
	}
	if !finalAuth {
		t.Fatalf("after fire: completionAuthoritative should be armed (armGen2 fired authoritatively)")
	}
}

// TestGraceTimer_CloseCancelsArmed is GAP-S1 case 3 (Close cancels armed):
// Close() MUST call cancelAllGraceLocked() (store.go:4133) so no grace
// callback fires after teardown against a torn-down store.
//
// Arms grace, calls Close() while the timer is pending, waits past the grace
// window, and asserts no late callback mutated store state (busy NOT
// cleared, authority NOT armed, graceTimers emptied). This is the
// teardown-safety contract: a grace fire into a closed store would emit into
// the emptied subs map (benign today) AND, more critically, would mutate
// busyCount / completionAuthoritative post-teardown — corrupting any
// post-Close diagnostic read and risking a nil-map panic if a future
// refactor nils maps on Close.
func TestGraceTimer_CloseCancelsArmed(t *testing.T) {
	s := mustNew(t, withCompletionGrace(DefaultConfig(100), 15*time.Millisecond))

	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("message.updated", evAssistantInflight("R", "m1")))
	s.Apply(ev("message.updated", evAssistantCompleted("R", "m1")))

	// Pre-close: grace armed, busy=1, authority clear.
	_, armed, auth, busy := s.graceStateSnapshot("R")
	if !armed {
		t.Fatalf("pre-close: grace timer should be armed")
	}
	if auth {
		t.Fatalf("pre-close: authority should be clear (grace pending)")
	}
	if busy != 1 {
		t.Fatalf("pre-close: busy=%d, want 1 (grace pending, not yet fired)", busy)
	}

	// Close while grace is armed. cancelAllGraceLocked stops every timer,
	// bumps graceGen for every armed id, and deletes every graceTimers
	// entry. The armed gen-N callback, if it runs, sees bumped graceGen and
	// aborts.
	s.Close()

	// Post-close: graceTimers emptied; busy NOT cleared; authority NOT armed.
	_, armedAfter, authAfter, busyAfter := s.graceStateSnapshot("R")
	if armedAfter {
		t.Fatalf("post-close: graceTimers[R] should be deleted (cancelAllGraceLocked on Close), still armed")
	}
	if authAfter {
		t.Fatalf("post-close: completionAuthoritative must be clear (grace never fired), got armed")
	}
	if busyAfter != 1 {
		t.Fatalf("post-close: busy=%d, want 1 (grace must not have cleared it on Close)", busyAfter)
	}

	// Wait WELL past the grace window. The stopped timer's callback (if it
	// runs at all) sees the Close-time graceGen bump and aborts. Assert
	// state is UNCHANGED — no late fire corrupted the post-close store.
	time.Sleep(80 * time.Millisecond)
	_, armedLate, authLate, busyLate := s.graceStateSnapshot("R")
	if armedLate {
		t.Fatalf("post-close+wait: grace timer should still be absent (no re-arm after Close)")
	}
	if authLate {
		t.Fatalf("post-close+wait: authority must still be clear (late fire must not arm it post-teardown)")
	}
	if busyLate != 1 {
		t.Fatalf("post-close+wait: busy=%d, want 1 (late fire must not clear it post-teardown)", busyLate)
	}
}

// TestGraceTimer_CompletionAuthoritativeReflectsLatestDecision is GAP-S1
// case 4 (completionAuthoritative-vs-stale-status): the authority map must
// reflect the LATEST grace decision, not a stale one.
//
// completionAuthoritative[sid] is the permanent guard (store.go:892-897):
// set when grace fires (clearOnCompletionLocked) OR session.idle is
// observed; cleared when a new inflight starts. While set, a stale busy
// from /session/status (the ~60s HTTP poll) must NOT re-escalate the
// session — the SetActivityFromStatuses guard at store.go:1698 clears it
// to idle when authority is set. This test asserts the authority map's
// set/clear lifecycle directly (not just the observable RunningRoots) so a
// split that moves the guard cannot silently regress it.
func TestGraceTimer_CompletionAuthoritativeReflectsLatestDecision(t *testing.T) {
	s := mustNew(t, withCompletionGrace(DefaultConfig(100), 15*time.Millisecond))
	defer s.Close() // GAP-S1: cancel armed grace so no timer fires into a later test

	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("message.updated", evAssistantInflight("R", "m1")))

	// Authority clear while inflight (turn in progress, no completion yet).
	_, _, auth, _ := s.graceStateSnapshot("R")
	if auth {
		t.Fatalf("inflight: authority should be clear (no completion yet)")
	}

	// Complete → grace fires → authority armed, busy cleared.
	s.Apply(ev("message.updated", evAssistantCompleted("R", "m1")))
	if !waitForRunningRoots(s, 0, time.Second) {
		t.Fatalf("grace should have cleared busy after completion")
	}
	_, _, authFired, _ := s.graceStateSnapshot("R")
	if !authFired {
		t.Fatalf("after grace fire: completionAuthoritative should be true (the latest grace decision)")
	}

	// Stale busy status must NOT re-escalate (the authority guard refuses).
	// Authority must remain armed reflecting the grace-fired decision.
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		"R": json.RawMessage(`{"id":"R","type":"busy"}`),
	})
	if got := s.RunningRoots(); got != 0 {
		t.Fatalf("stale busy status post-authority: RunningRoots=%d, want 0 (guard refuses re-escalation)", got)
	}
	_, _, authAfterStale, _ := s.graceStateSnapshot("R")
	if !authAfterStale {
		t.Fatalf("stale busy status must not clear authority (the latest grace decision stands)")
	}

	// A NEW inflight clears the guard (a new turn started). The authority
	// must now reflect THIS latest decision (clear), not the prior
	// completed turn's (armed).
	s.Apply(ev("message.updated", evAssistantInflight("R", "m2")))
	_, _, authNew, busyNew := s.graceStateSnapshot("R")
	if authNew {
		t.Fatalf("after new inflight: authority should be cleared (new turn's decision supersedes the prior), still armed")
	}
	if busyNew != 1 {
		t.Fatalf("after new inflight: busy=%d, want 1 (new turn re-armed; authority clear so legitimate busy is respected)", busyNew)
	}

	// And the new turn's completion re-arms authority — proving the
	// authority lifecycle is repeatable across turns and always reflects
	// the latest decision.
	s.Apply(ev("message.updated", evAssistantCompleted("R", "m2")))
	if !waitForRunningRoots(s, 0, time.Second) {
		t.Fatalf("second grace should have cleared busy")
	}
	_, _, authRepeat, _ := s.graceStateSnapshot("R")
	if !authRepeat {
		t.Fatalf("after second grace fire: authority should be armed again (lifecycle is repeatable)")
	}
}
