package state

// turn_state_test.go — the P7 turn-boundary state machine SPEC.
//
// This is the SAME hazard class as the coherent-snapshot barrier arc: a
// turn-boundary STATE MACHINE in the state layer, where prose reasoning about
// soundness is worthless and the tests are the spec. These tests were written
// RED-FIRST in Phase 1: each encodes a target invariant adapted from paseo's
// PROVEN turn/stop-boundary model (researches/sources/paseo/04-opencode-adapter.md
// § "d9b72e1 RE-PIN"), and each went RED because the target states/transitions
// did not exist yet (the Phase 1 scaffold in turn_state.go was compile-only:
// Stop was a no-op, TurnState returned TurnIdle, AbortSettling returned false).
// AGPL: the MODEL is adapted, never paseo's code; these tests assert the adapted
// Go behavior, written from the study's prose invariants.
//
// CURRENT STATE (Phase 2 landed): turn_state.go holds the real implementation,
// and these tests are GREEN. Each was then defect-injected (e.g. made an abort
// NOT outlive the stop, or made the #2696 guard never fire) to prove its
// RED-ability, reverted, and re-confirmed green. This header is kept as RED-first
// provenance; the file is the implemented spec, not the scaffold.
//
// The five interleavings below mirror the paseo model's load-bearing boundaries:
//   1. running → stop issued → stopping (not back to idle until the canceled run's terminal).
//   2. abort OUTLIVES the stop: a second turn while a prior abort is settling waits (fail-closed gate).
//   3. turn terminal (failed/canceled) arriving while stopping → correct settle.
//   4. the #2696 guard: a mutable message.updated AFTER idle must NOT reopen/start a turn.
//   5. on-subscribe adoption: a provider-reported already-busy session is adopted as running,
//      with a race guard so a live idle supersedes a stale busy snapshot.

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// assertTurn is the spec-test helper for the turn-boundary state. It uses Errorf
// (non-fatal) so a single test reports every invariant it violated, not just the
// first — Phase 2 defect-injection then maps each error back to the exact
// transition it pins.
func assertTurn(t *testing.T, s *Store, id string, want TurnState, msg string) {
	t.Helper()
	got := s.TurnState(id)
	if got != want {
		t.Errorf("%s: TurnState(%q)=%q, want %q", msg, id, got, want)
	}
}

// TestP7_RunningToStopEntersStopping pins invariant 1: a stop issued on a
// running turn enters TurnStopping, and the session does NOT fall back to idle
// until the canceled run's terminal arrives. The current layer has no stopping
// state — its abort path (MarkIdle) idles synchronously — so this RED-flags the
// absent state machine. paseo model: OpenCodeTurnState running→stopping, the
// stopping payload carries the canceled run's terminal.
func TestP7_RunningToStopEntersStopping(t *testing.T) {
	s := New(100)
	defer s.Close() // tidy: no armed timers in this scenario, but consistent with the cohort
	s.Apply(ev("session.created", evSessionCreated("R", "")))

	// Turn is running: signal from AUTHORITATIVE runner status (session.status
	// busy), not from a mutable message record. A running turn derived from a
	// mutable message is precisely the #2696 trap (see TestP7_PostIdle...).
	s.Apply(ev("session.status", evStatus("R", "busy")))
	assertTurn(t, s, "R", TurnRunning, "after authoritative busy (status)")

	// Stop issued on the in-flight turn. The transition is running → stopping,
	// NOT running → idle: the canceled run's terminal has not arrived yet.
	s.Stop("R", "turn1")
	assertTurn(t, s, "R", TurnStopping, "after Stop (canceled run's terminal has NOT arrived)")

	// While stopping the session is still RUNNING-CLASS (a coordinator still
	// observes work in flight) and NOT sendable (the fail-closed gate). These
	// observable side-effects are what makes "stopping" a distinct, useful state
	// rather than a synonym for idle.
	if got := s.RunningRoots(); got != 1 {
		t.Errorf("while stopping: RunningRoots=%d, want 1 (stopping is still running-class; the canceled run is still in flight)", got)
	}
	if sendable, _, exists := s.SendableNow("R"); !exists {
		t.Fatalf("while stopping: SendableNow reports session does not exist")
	} else if sendable {
		t.Errorf("while stopping: SendableNow=true, want false (cannot send while a turn is stopping)")
	}
}

// TestP7_AbortOutlivesStop_NewTurnWaitsForSettlement pins invariant 2: OpenCode's
// abort is SESSION-SCOPED and outlives the stop that issued it (a tool mid-flight
// keeps aborting after issueStop returns). Therefore a new turn started while a
// prior abort is settling must WAIT for that abort (the fail-closed gate /
// awaitRunnerQuiescence) before proceeding to TurnRunning. paseo model:
// abortSettlement lives on the SESSION (not the stop); only the newest abort may
// hold the gate; the canceled run's terminal drains it.
//
// CALLER-DRIVEN (operator directive #1): the state layer is a pure GATE — it
// reports whether the gate is open (AbortSettling), it does NOT auto-start /
// auto-promote a pending turn. Auto-promotion would (a) give the state layer
// agency to initiate turns, breaking the INFORMS-not-acts authority line this
// project holds everywhere; (b) hide a trigger ("why did a turn start"); (c)
// diverge from the working reference (paseo's caller-driven
// awaitRunnerQuiescence); (d) cost promotion logic in the reducer for no gain.
// So this test asserts the gate OPENS after the canceled run's terminal settles
// (AbortSettling → false), NOT that a turn auto-started. The new turn's CALLER
// awaits the gate at the top of its start path; that caller lives outside the
// state layer and is not exercised here.
func TestP7_AbortOutlivesStop_NewTurnWaitsForSettlement(t *testing.T) {
	s := New(100)
	defer s.Close()
	s.Apply(ev("session.created", evSessionCreated("R", "")))

	// turn1 is running (authoritative status, not a mutable message).
	s.Apply(ev("session.status", evStatus("R", "busy")))
	assertTurn(t, s, "R", TurnRunning, "turn1 running (authoritative busy)")

	// Stop issued on turn1: running → stopping, and the session-scoped abort
	// begins settling. AbortSettling is the fail-closed gate.
	s.Stop("R", "turn1")
	assertTurn(t, s, "R", TurnStopping, "after Stop on turn1")
	if !s.AbortSettling("R") {
		t.Errorf("after Stop: AbortSettling=false, want true (gate CLOSED — session-scoped abort OUTLIVES the stop that issued it)")
	}

	// The canceled run's terminal has NOT arrived yet — the gate stays CLOSED.
	// (A new turn's caller would observe AbortSettling=true here and wait; the
	// state layer does NOT auto-promote a pending turn — caller-driven.)
	if !s.AbortSettling("R") {
		t.Errorf("before terminal: AbortSettling=false, want true (gate still closed; caller must wait)")
	}

	// The canceled run's terminal arrives (session.idle is the session-scoped
	// terminal) → the abort settles → the gate OPENS. The state layer does NOT
	// auto-start a pending turn; it only reports the gate is now open. The
	// caller, polling/awaiting AbortSettling, observes false and may now proceed
	// to start the next turn itself.
	s.Apply(ev("session.idle", evIdle("R")))
	if s.AbortSettling("R") {
		t.Errorf("after terminal: AbortSettling=true, want false (gate OPEN — abort settled; caller may now proceed)")
	}
	assertTurn(t, s, "R", TurnIdle, "after terminal (stop settled to idle — NOT auto-promoted to running)")
}

// TestP7_TerminalWhileStopping_SettlesToIdle pins invariant 3: while TurnStopping,
// ONLY the canceled run's terminal settles the stop to TurnIdle; a non-terminal
// event (a streaming part delta for the doomed run) must NOT settle it
// prematurely. paseo model: discardEventWhileStopping ignores non-terminal
// events; finishStoppingTurn fires on the terminal.
func TestP7_TerminalWhileStopping_SettlesToIdle(t *testing.T) {
	s := New(100)
	defer s.Close()
	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("session.status", evStatus("R", "busy")))
	s.Stop("R", "turn1")
	assertTurn(t, s, "R", TurnStopping, "after Stop")

	// A non-terminal event while stopping: a streaming part delta for the doomed
	// run. It must NOT settle the stop (the run is still aborting).
	s.Apply(ev("message.part.delta", `{"sessionID":"R","messageID":"m_turn1","partID":"p1","field":"text","delta":"x"}`))
	assertTurn(t, s, "R", TurnStopping, "after non-terminal part delta while stopping (must not settle)")
	if !s.AbortSettling("R") {
		t.Errorf("after non-terminal event while stopping: AbortSettling=false, want true (only the terminal settles the abort)")
	}

	// The canceled run's terminal arrives → settle to TurnIdle, abort released.
	s.Apply(ev("session.idle", evIdle("R")))
	assertTurn(t, s, "R", TurnIdle, "after canceled run's terminal (settles to idle)")
	if s.AbortSettling("R") {
		t.Errorf("after terminal: AbortSettling=true, want false (abort settled)")
	}
}

// TestP7_PostIdleMutableMessageDoesNotReopenTurn pins invariant 4 — the #2696
// guard, the root cause the d9b72e1 RE-PIN fixed in paseo. Message records are
// MUTABLE: OpenCode stamps its filesystem-snapshot diff onto the user/assistant
// message AFTER the runner goes idle, so a message.updated arriving post-idle is
// NOT evidence a turn is running. Only AUTHORITATIVE runner status
// (session.status busy|retry, or an inflight assistant arriving WHILE running)
// may start / reopen a turn. The current layer VIOLATES this:
// upsertMessageLocked's escalation block (reducers.go) deletes
// completionAuthoritative and sets ActivityBusy on ANY inflight assistant
// message — including a post-idle one — so this test RED-flags a live bug.
func TestP7_PostIdleMutableMessageDoesNotReopenTurn(t *testing.T) {
	s := New(100)
	defer s.Close()
	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("session.status", evStatus("R", "busy"))) // turn running
	assertTurn(t, s, "R", TurnRunning, "turn running")

	// The runner goes idle — the AUTHORITATIVE turn-end signal.
	s.Apply(ev("session.idle", evIdle("R")))
	assertTurn(t, s, "R", TurnIdle, "after authoritative session.idle")
	if got := s.Snapshot(nil).Activity["R"]; got != ActivityIdle {
		t.Fatalf("setup: after session.idle activity=%q, want %q", got, ActivityIdle)
	}

	// #2696 trap: a mutable message.updated arrives AFTER idle (e.g. OpenCode
	// patching an assistant record post-hoc). It must NOT reopen the turn.
	s.Apply(ev("message.updated", evAssistantInflight("R", "m_late")))
	assertTurn(t, s, "R", TurnIdle, "#2696 guard: late inflight message after idle must not reopen the turn")
	if got := s.Snapshot(nil).Activity["R"]; got == ActivityBusy {
		t.Errorf("#2696 guard: late inflight message after idle re-escalated activity to %q — only authoritative busy/retry status may (re)start a turn", got)
	}

	// Contrast: AUTHORITATIVE runner status arriving after idle (a genuine new
	// turn starting server-side) IS honored — that is the legitimate path the
	// #2696 guard must NOT over-block.
	s.Apply(ev("session.status", evStatus("R", "busy")))
	assertTurn(t, s, "R", TurnRunning, "authoritative busy after idle IS a real new turn (guard must not over-block)")
}

// TestP7_SubscribeAdoptsAlreadyBusy_RaceGuarded pins invariant 5: on (re)hydrate
// the on-subscribe reconcile (SetActivityFromStatuses, the /session/status
// snapshot) adopts a session the provider reports as already-busy as TurnRunning
// (reconcileExternalRunnerStatus). A race guard (paseo: runnerStatusRevision)
// ensures a live idle event supersedes a stale busy snapshot: the snapshot is
// async, and between probe and apply a live idle may have fired — applying the
// stale busy must not resurrect running. The current layer adopts busy but has
// no TurnRunning concept and no revision guard (it relies on the coarser
// completionAuthoritative boolean), so the adoption assertion RED-flags the
// absent state-machine adoption.
func TestP7_SubscribeAdoptsAlreadyBusy_RaceGuarded(t *testing.T) {
	s := New(100)
	defer s.Close()
	s.Apply(ev("session.created", evSessionCreated("R", "")))

	// On-subscribe reconcile: the provider reports R as already-busy. Adopt it
	// as TurnRunning (the turn started elsewhere / before this daemon connected).
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		"R": json.RawMessage(`{"type":"busy"}`),
	})
	assertTurn(t, s, "R", TurnRunning, "on-subscribe adoption of provider-busy session")
	if got := s.Snapshot(nil).Activity["R"]; got != ActivityBusy {
		t.Fatalf("on-subscribe adoption: activity=%q, want %q (busy)", got, ActivityBusy)
	}

	// Race guard: a LIVE idle event arrives (the runner actually stopped). It
	// supersedes the adopted-busy snapshot — TurnRunning → TurnIdle.
	s.Apply(ev("session.idle", evIdle("R")))
	assertTurn(t, s, "R", TurnIdle, "live idle supersedes adopted-busy")

	// A STALE busy snapshot applied AFTER the live idle must NOT re-adopt the
	// session as running (the snapshot was taken before the idle; its revision is
	// superseded). This is the race the revision guard closes.
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		"R": json.RawMessage(`{"type":"busy"}`),
	})
	assertTurn(t, s, "R", TurnIdle, "stale busy snapshot after live idle must not re-adopt (race guard)")
	if got := s.Snapshot(nil).Activity["R"]; got == ActivityBusy {
		t.Errorf("race guard: stale busy snapshot after live idle re-escalated activity to %q", got)
	}
}

// stopStateSnapshot is the spec-test helper for the stop-settle timer + gate
// internals. Mirrors graceStateSnapshot's under-lock read so a test asserts the
// RAW fields (stopGen, stopTimers armed, abortSettling, turnState) directly,
// without going through the public read API (which would hide a deleted-but-
// still-settling state, or paper over the stopGen/stopTimers invariant the
// cancel-vs-fire race depends on). turnState is normalized to TurnIdle when
// unset so the snapshot matches the public TurnState default.
func (s *Store) stopStateSnapshot(id string) (gen uint64, armed bool, settling bool, ts TurnState) {
	s.mu.Lock()
	defer s.mu.Unlock()
	gen = s.stopGen[id]
	_, armed = s.stopTimers[id]
	settling = s.abortSettling[id]
	ts = s.turnState[id]
	if ts == "" {
		ts = TurnIdle
	}
	return
}

// TestP7_StopFireSettlesGateWhenNoTerminalArrives pins the stopFire settle-timer
// fallback (turn_state.go armStopTimerLocked/stopFire). This is NOT an edge path
// — it is the NORMAL production gate-open path, because OpenCode does NOT emit
// session.idle on abort (reducers.go:249 / verbs.go:261). An untested primary
// path is worse than an untested fallback, and the operator's stated timer
// failure-mode (a too-short timer unblocks while the runner is still aborting
// mid-flight = the old synchronous MarkIdle bug) is unverifiable without this
// test. Mirrors the graceFire family (TestGraceTimer_CancelSupersedesStaleFire /
// TestBusyCompletionStrand_NoSessionIdle_StrandsRunningRoots).
func TestP7_StopFireSettlesGateWhenNoTerminalArrives(t *testing.T) {
	s := mustNew(t, withCompletionGrace(DefaultConfig(100), 15*time.Millisecond)) // small enough for a fast test
	defer s.Close()                                                               // cancel armed stop timer so no callback fires into a later test

	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("session.status", evStatus("R", "busy"))) // turn running (authoritative)
	assertTurn(t, s, "R", TurnRunning, "turn running")

	// Stop issued: running → stopping, gate CLOSED, settle timer armed.
	s.Stop("R", "turn1")
	assertTurn(t, s, "R", TurnStopping, "after Stop")
	if !s.AbortSettling("R") {
		t.Fatalf("after Stop: AbortSettling=false, want true (gate CLOSED)")
	}
	if _, armed, _, _ := s.stopStateSnapshot("R"); !armed {
		t.Fatalf("after Stop: settle timer should be armed, got disarmed")
	}

	// NO terminal event arrives (the production abort case — OpenCode emits no
	// session.idle on abort). Let the shortened completionGrace settle window
	// expire.
	time.Sleep(80 * time.Millisecond)

	// stopFire force-opened the gate and idled the session: AbortSettling=false,
	// TurnIdle. This is the liveness fallback that prevents a missing terminal
	// from wedging the session in Stopping forever (Deviation 2). Routed through
	// setActivityLocked so the activity map idles consistently.
	if s.AbortSettling("R") {
		t.Errorf("after settle-timer fired (no terminal): AbortSettling=true, want false (stopFire opened the gate)")
	}
	assertTurn(t, s, "R", TurnIdle, "after settle-timer fired (stopFire idled the session)")
	if got := s.Snapshot(nil).Activity["R"]; got != ActivityIdle {
		t.Errorf("after settle-timer fired: activity=%q, want %q (stopFire idled activity)", got, ActivityIdle)
	}
}

// TestP7_D4_ReconcileSnapshotBusyPreservesStopping_LiveBusyAdopts pins the D4
// fix (the mandatory companion to the /vh/send AbortSettling consumer). A
// reconcile-SNAPSHOT busy/retry arriving while a session is TurnStopping (a
// draining abort) is the canceled run's own still-busy status reflected back by
// /session/status — NOT evidence a new turn started. Without D4,
// SetActivityFromStatuses re-adopts it as TurnRunning via
// markTurnRunningLocked, which cancels the settle timer and OPENS the abort
// gate mid-drain — exactly the race window the consumer exists to close. D4
// threads a provenance flag (reconcile-snapshot vs live-event) into the busy-
// adoption path so a reconcile-snapshot busy preserves TurnStopping; a direct
// LIVE session.status busy stays authoritative new-turn evidence and still
// transitions to TurnRunning + opens the gate (the server accepting a new turn
// ⇒ the prior abort settled).
//
// Determinism: no real settle timer is relied on for the correctness proof
// here — state transitions are injected directly (Stop, SetActivityFromStatuses,
// live session.status). stopStateSnapshot reads the raw timer/gen/gate fields so
// the assertion can see "timer still armed" without waiting for it.
func TestP7_D4_ReconcileSnapshotBusyPreservesStopping_LiveBusyAdopts(t *testing.T) {
	s := New(100)
	defer s.Close()
	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("session.status", evStatus("R", "busy"))) // authoritative new turn
	assertTurn(t, s, "R", TurnRunning, "turn running (authoritative busy)")

	// Stop issued on the in-flight turn: running → stopping, gate CLOSED, settle
	// timer ARMED.
	s.Stop("R", "turn1")
	assertTurn(t, s, "R", TurnStopping, "after Stop")
	if !s.AbortSettling("R") {
		t.Fatalf("after Stop: AbortSettling=false, want true (gate CLOSED)")
	}
	_, armed, settling, _ := s.stopStateSnapshot("R")
	if !armed {
		t.Fatalf("after Stop: settle timer should be ARMED")
	}
	if !settling {
		t.Fatalf("after Stop: abortSettling should be true")
	}

	// D4 crux #1: a reconcile-SNAPSHOT busy (the periodic /session/status poll
	// reflecting the still-draining abort) must NOT re-adopt as TurnRunning. It
	// must preserve TurnStopping (gate closed, settle timer still armed).
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		"R": json.RawMessage(`{"type":"busy"}`),
	})
	assertTurn(t, s, "R", TurnStopping, "D4: reconcile-snapshot busy during drain must preserve TurnStopping (not re-adopt as Running)")
	if !s.AbortSettling("R") {
		t.Errorf("D4: reconcile-snapshot busy must keep the gate CLOSED (drain still in progress)")
	}
	_, armedAfterBusy, settlingAfterBusy, _ := s.stopStateSnapshot("R")
	if !armedAfterBusy {
		t.Errorf("D4: reconcile-snapshot busy must NOT cancel the settle timer (still armed)")
	}
	if !settlingAfterBusy {
		t.Errorf("D4: reconcile-snapshot busy must NOT clear abortSettling")
	}

	// D4 crux #2: repeat with retry — same provenance, same preservation.
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		"R": json.RawMessage(`{"type":"retry"}`),
	})
	assertTurn(t, s, "R", TurnStopping, "D4: reconcile-snapshot retry during drain still preserves TurnStopping")
	if !s.AbortSettling("R") {
		t.Errorf("D4: reconcile-snapshot retry must keep the gate CLOSED")
	}
	_, armedAfterRetry, _, _ := s.stopStateSnapshot("R")
	if !armedAfterRetry {
		t.Errorf("D4: reconcile-snapshot retry must NOT cancel the settle timer")
	}

	// D4 crux #3: a DIRECT LIVE session.status busy IS authoritative new-turn
	// evidence — it transitions to TurnRunning and OPENS the gate (the server
	// accepting a new turn ⇒ the prior abort settled). D4 must not over-block
	// the legitimate path.
	s.Apply(ev("session.status", evStatus("R", "busy")))
	assertTurn(t, s, "R", TurnRunning, "D4: live session.status busy IS authoritative new turn (must adopt)")
	if s.AbortSettling("R") {
		t.Errorf("D4: live busy must OPEN the gate (prior abort settled)")
	}
	_, armedAfterLive, _, _ := s.stopStateSnapshot("R")
	if armedAfterLive {
		t.Errorf("D4: live busy must cancel the settle timer (new turn adopted)")
	}
}

// TestP7_SessionErrorCompanion_CompletionAuthoritativeBlocksStaleReconcile pins
// the session.error companion to the #2696 fold: session.idle arms
// completionAuthoritative (reducers.go:421) so a stale reconcile busy cannot
// re-adopt the just-completed turn; session.error must do the SAME (mirror), or
// a stale reconcile busy arriving after an error terminal re-adopts the
// error-settled session as TurnRunning (completionAuthoritative is the only
// guard, since turnState is already TurnIdle after the error settle, so the D4
// TurnStopping check does not catch it).
func TestP7_SessionErrorCompanion_CompletionAuthoritativeBlocksStaleReconcile(t *testing.T) {
	s := New(100)
	defer s.Close()
	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("session.status", evStatus("R", "busy")))
	assertTurn(t, s, "R", TurnRunning, "turn running")
	s.Stop("R", "turn1")
	assertTurn(t, s, "R", TurnStopping, "after Stop")
	if !s.AbortSettling("R") {
		t.Fatalf("after Stop: gate should be CLOSED")
	}

	// The canceled run's terminal arrives as a LIVE session.error → the gate
	// RELEASES and the session settles to TurnIdle. The companion arms
	// completionAuthoritative so a subsequent stale reconcile busy cannot
	// re-adopt.
	s.Apply(ev("session.error", evError("R")))
	assertTurn(t, s, "R", TurnIdle, "session.error terminal settles to TurnIdle")
	if s.AbortSettling("R") {
		t.Errorf("after session.error: gate should be OPEN (terminal settled the abort)")
	}
	s.mu.RLock()
	auth := s.completionAuthoritative["R"]
	s.mu.RUnlock()
	if !auth {
		t.Fatalf("session.error must arm completionAuthoritative (the companion mirror of session.idle) — without it a stale reconcile busy re-adopts")
	}

	// Stale reconcile busy arrives (the /session/status snapshot predates the
	// error). It must NOT re-adopt the error-settled session as TurnRunning.
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		"R": json.RawMessage(`{"type":"busy"}`),
	})
	assertTurn(t, s, "R", TurnIdle, "companion: stale reconcile busy after error must NOT re-adopt (completionAuthoritative holds)")
	if got := s.Snapshot(nil).Activity["R"]; got == ActivityBusy {
		t.Errorf("companion: stale reconcile busy after error re-escalated activity to %q — completionAuthoritative must force it to idle", got)
	}
}

// TestP7_WaitAbortSettling_SpuriousWakeAfterRearm_RecheckAuthoritative pins DEFER
// finding p7-d1: the "spurious true return is safe" doc claim at
// turn_state.go:370-375. The interleaving the claim rests on:
//  1. Stop#1 → TurnStopping, gate closed (channel A armed).
//  2. A CAS-bearing /vh/send awaits in WaitAbortSettling (parked on channel A).
//  3. Release#1 (live idle/error or reconcile-clear) opens the gate — channel A
//     is closed+deleted under s.mu via setAbortSettlingLocked.
//  4. Stop#2 is issued on the now-TurnIdle session → re-arms a FRESH channel B
//     (gate closed again), TurnStopping.
//  5. The stale waiter (parked on channel A from step 2) wakes — channel A was
//     closed by release#1.
//  6. The post-await FULL SendCASState+seq CAS recheck (the exact call the
//     /vh/send handler makes at verbs.go:162) sees the NEW TurnStopping →
//     sendable=false, abortSettling=true → the handler 409s with ZERO prompts
//     forwarded.
//
// WHY THE STATE LAYER (not the verbs layer): pinning this EXACT interleaving at
// the verbs layer requires Stop#2's re-arm to land in the race window between
// channel-A-close (release#1) and the handler's recheck — a window inside
// production code (verbs.go:159-162) with no test hook, and non-deterministic
// under -race (the waiter goroutine's SendCASState RLock can win against Stop#2's
// Lock, observing TurnIdle and forwarding instead of 409). The state layer runs
// the WHOLE interleaving sequentially on one goroutine (the channel close +
// re-arm are synchronous under s.mu), so the recheck deterministically observes
// Stop#2's TurnStopping. The recheck here is the SAME SendCASState call the
// verbs handler uses (snapshots.go:1062), so a sendable=false result is EXACTLY
// what produces 409 + zero prompts at the verbs layer (verbs.go:174-177). No
// production code is modified.
func TestP7_WaitAbortSettling_SpuriousWakeAfterRearm_RecheckAuthoritative(t *testing.T) {
	s := New(100)
	defer s.Close()
	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("session.status", evStatus("R", "busy"))) // authoritative new turn

	// Stop#1: TurnStopping, gate closed, channel A armed.
	s.Stop("R", "turn1")
	if !s.AbortSettling("R") {
		t.Fatalf("Stop#1: AbortSettling should be true (gate closed)")
	}

	// Capture channel A — exactly what WaitAbortSettling does internally
	// (turn_state.go:382: ch := s.abortWaitCh[sessionID] under RLock, then parks
	// on <-ch). The stale waiter holds this reference for the whole wait.
	s.mu.RLock()
	chA := s.abortWaitCh["R"]
	s.mu.RUnlock()
	if chA == nil {
		t.Fatalf("Stop#1: abort wait channel A should be armed")
	}

	// Release#1: a LIVE session.idle settles the abort — setAbortSettlingLocked(false)
	// (turn_state.go:336-340) closes channel A and deletes it from the map; the
	// session goes TurnIdle.
	s.Apply(ev("session.idle", evIdle("R")))
	if s.AbortSettling("R") {
		t.Fatalf("Release#1: AbortSettling should be false (gate opened, channel A closed)")
	}
	// The map entry is gone (closed+deleted), but chA is still a valid reference
	// to the now-closed channel — the stale waiter holds exactly this reference.
	s.mu.RLock()
	_, stillMapped := s.abortWaitCh["R"]
	s.mu.RUnlock()
	if stillMapped {
		t.Fatalf("Release#1: abortWaitCh[R] should be deleted (channel closed+removed)")
	}

	// Stop#2: the session is TurnIdle (NOT TurnStopping), so stopLocked runs the
	// FULL body (turn_state.go:138-141) — re-arms a FRESH channel B,
	// abortSettling=true, TurnStopping.
	s.Stop("R", "turn2")
	if !s.AbortSettling("R") {
		t.Fatalf("Stop#2: AbortSettling should be true again (gate re-armed)")
	}
	s.mu.RLock()
	chB := s.abortWaitCh["R"]
	s.mu.RUnlock()
	if chB == nil {
		t.Fatalf("Stop#2: a FRESH abort wait channel B should be armed")
	}
	if chB == chA {
		t.Fatalf("Stop#2: channel B must be a FRESH channel, not the reused channel A")
	}

	// Step 5 — the stale waiter (holding the chA reference from step 2) wakes.
	// channel A was closed by release#1, so this receive returns immediately —
	// the "spurious true return" the doc claim names. Non-blocking by construction.
	select {
	case <-chA:
		// good: the stale waiter woke (channel A was closed by release#1).
	default:
		t.Fatalf("stale waiter: channel A should be closed (spurious wake), but receive blocked")
	}

	// Step 6 — the caller's AUTHORITATIVE recheck. This is the exact SendCASState
	// call the /vh/send handler makes after WaitAbortSettling returns
	// (verbs.go:162). It must see Stop#2's NEW TurnStopping → sendable=false.
	// That sendable=false is what yields 409 + ZERO prompts at the verbs layer
	// (verbs.go:174-177); the spurious wake does NOT become send authority.
	sendable, _, exists, abortSettling := s.SendCASState("R")
	if !exists {
		t.Fatalf("recheck: session should still exist (Stop#2 did not delete it)")
	}
	if sendable {
		t.Errorf("recheck: SendableNow=true, want false (Stop#2 re-armed TurnStopping — the fresh recheck catches the new stop; the spurious wake must NOT become send authority)")
	}
	if !abortSettling {
		t.Errorf("recheck: AbortSettling=false, want true (Stop#2 re-armed the gate)")
	}

	// The FRESH channel B is still armed (open) — a FUTURE waiter would block on
	// it, confirming Stop#2 genuinely re-armed a new gate (not a no-op idempotent
	// return that left channel A's closed state in place).
	select {
	case <-chB:
		t.Errorf("channel B: should still be OPEN (a fresh waiter would block on it), but it was already closed")
	default:
		// good: channel B is open (armed) — the new gate is genuinely closed.
	}
}

// TestP7_StopFireReleasesWaiter pins DEFER finding p7-d2 (settle-timer release
// path): stopFire (the settle-timer callback, turn_state.go:420-435) opens the
// abort gate + idles activity under s.mu, which must wake a blocked
// WaitAbortSettling caller so its post-await SendCASState recheck runs and
// observes the now-idle, sendable session. This is the NORMAL production
// gate-open path because OpenCode does NOT emit session.idle on abort
// (reducers.go:249 / verbs.go:261), so the terminal that opens the gate may
// never arrive — stopFire is the bounded-latency backstop.
//
// Bounded liveness check (per the task's determinism discipline): uses a
// shortened completionGrace so the test does NOT rely on the real 5s settle
// timer for its correctness proof — only for the bounded "the timer does fire
// and release the waiter" liveness observation, matching
// TestP7_StopFireSettlesGateWhenNoTerminalArrives. The OUTCOME is deterministic
// regardless of host scheduling: after stopFire the session is stably
// TurnIdle+ActivityIdle, so the waiter's recheck always observes sendable=true.
func TestP7_StopFireReleasesWaiter(t *testing.T) {
	s := mustNew(t, withCompletionGrace(DefaultConfig(100), 25*time.Millisecond))
	defer s.Close()

	s.Apply(ev("session.created", evSessionCreated("R", "")))
	s.Apply(ev("session.status", evStatus("R", "busy"))) // authoritative new turn
	s.Stop("R", "turn1")                                 // TurnStopping, gate closed, settle timer armed
	if !s.AbortSettling("R") {
		t.Fatalf("after Stop: AbortSettling should be true (gate closed)")
	}

	// Launch the waiter: WaitAbortSettling + the post-await SendCASState recheck
	// (the exact pair the /vh/send handler runs at verbs.go:159-162). It parks on
	// the abort wait channel until stopFire closes it. A bounded ctx guards
	// against a wedge leaking the goroutine if the test fails mid-flight.
	type recheck struct {
		opened   bool
		sendable bool
		exists   bool
	}
	done := make(chan recheck, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		opened := s.WaitAbortSettling(ctx, "R")
		sendable, _, exists, _ := s.SendCASState("R")
		done <- recheck{opened, sendable, exists}
	}()

	// The waiter must be genuinely blocked BEFORE the settle timer fires (RED
	// signal: a broken gate would not park the waiter at all). 10ms < 25ms timer,
	// and plenty for goroutine startup + the RLock/park.
	select {
	case <-done:
		t.Fatal("waiter returned before stopFire fired — it did NOT await (gate was not closed / consumer missing)")
	case <-time.After(10 * time.Millisecond):
		// good: still parked before the 25ms settle window expires.
	}

	// stopFire force-opened the gate + idled activity. Wait for the waiter to
	// unblock and run its recheck.
	select {
	case got := <-done:
		if !got.opened {
			t.Errorf("WaitAbortSettling returned opened=false, want true (stopFire opened the gate)")
		}
		if !got.exists {
			t.Fatalf("recheck: session should still exist after stopFire")
		}
		if !got.sendable {
			t.Errorf("recheck: SendableNow=false, want true (stopFire idled activity + went TurnIdle → sendable)")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("waiter did not unblock after the settle window — stopFire did not release it")
	}

	// Confirm stopFire settled the session (the authoritative ground truth).
	if s.AbortSettling("R") {
		t.Errorf("after stopFire: AbortSettling=true, want false (gate opened)")
	}
	assertTurn(t, s, "R", TurnIdle, "after stopFire (settle timer idled the session)")
}
