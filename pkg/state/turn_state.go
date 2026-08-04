// Package state: the P7 turn-boundary state machine concern — the per-session
// idle | running | stopping state machine adapted from paseo's PROVEN
// turn/stop-boundary model (researches/sources/paseo/04-opencode-adapter.md §
// "d9b72e1 RE-PIN — turn/stop boundary"). AGPL: the MODEL is adapted, never the
// code — this file is a clean-room Go implementation of the modelled states and
// authority rules, written from the study's prose invariants only.
//
// WHY A SEPARATE STATE MACHINE (on top of the existing activity map).
// The activity map (s.activity: idle|busy|retry|error) is a DERIVED UI indicator
// of "is the sidebar spinning." It conflates two concerns paseo's model keeps
// distinct and that this concern separates:
//
//  1. OpenCodeRunnerStatus (idle|busy|retry) — "is the runner doing work right
//     now." Authoritative source: session.status busy|retry (routed through
//     markTurnRunningLocked). Maps to vh-solara's {busy, retry} activity values.
//  2. OpenCodeTurnState (idle|running|stopping) — the turn BOUNDARY state: is a
//     turn in flight, being canceled, or quiescent. "stopping" is a state the
//     activity map CANNOT express: a stopping session is still running-class
//     (RunningRoots counts it, SendableNow is false) but its turn is terminally
//     doomed — neither busy-with-progress nor idle.
//
// The activity map stays the UI indicator; this concern adds the authoritative
// turn-boundary layer. The two are wired together in reducers.go (Apply routes
// the authoritative status/terminal events through this machine) and the #2696
// guard lives in upsertMessageLocked.
//
// ADAPTED MODEL (the TESTS are the authority, not this prose):
//
//	TurnState = idle | running | stopping
//
//	stopping payload: { pendingCancellationTurnID (stopTurnID), terminal } — the
//	  canceled run's terminal signal (paseo's OpenCodeStop carries ONLY
//	  { pendingCancellationTurnId, terminal }).
//
//	session-scoped ABORT accumulator (the fail-closed gate, AbortSettling):
//	  lives on the SESSION (not the stop), because OpenCode's abort is
//	  session-scoped and OUTLIVES the stop that issued it. Stop closes the gate;
//	  the canceled run's terminal (session.idle|error) OPENS it. Only the
//	  newest stop may hold the gate (Stop-again-during-stop is idempotent —
//	  routes to the same stop). The gate is a pure GATE: the state layer reports
//	  whether it is open; the state layer does NOT auto-start / auto-promote a
//	  pending turn — caller-driven, never state-initiated.
//
//	CONSUMPTION STATUS (honest — do NOT read this as "the abort race is closed").
//	  Three separate properties; each can pass/fail independently (see the
//	  behavioral-closure token for the F-slice):
//	  (a) #2696 guard — LIVE, scoped to session.idle terminals ONLY (session.error
//	      path is the F4 deferred question).
//	  (b) SendableNow CAS rejection — LIVE: turnState != TurnStopping in
//	      SendableNow (snapshots.go) is consumed by the production CAS send path
//	      (pkg/web/verbs.go:113-121), so post-abort sends return 409 Conflict
//	      during the ~completionGrace Stopping window (intended fail-closed shift).
//	  (c) AbortSettling await — the INTENDED caller contract for a FOLLOW-UP
//	      dispatch slice (the awaitRunnerQuiescence analog: a new turn's caller
//	      would await AbortSettling at the top of its start path). NO production
//	      caller consumes AbortSettling today — only tests + this doc reference
//	      it. The current live production behavior is the SendableNow 409 window
//	      (b), NOT an AbortSettling await.
//
//	settle-timer fallback (stopFire): OpenCode does NOT emit session.idle on
//	  abort (reducers.go:249 / verbs.go:261), so the terminal that opens the
//	  gate may never arrive. The settle timer (completionGrace, the same tunable
//	  the completion-grace window uses for the identical "missed session.idle"
//	  case) force-opens the gate and idles activity after the grace window if no
//	  terminal arrived — the deferred counterpart of the retired synchronous
//	  Store.MarkIdle the abort verb used to call. stopGen (mirroring graceGen) is
//	  the authoritative supersede signal: time.Timer.Stop does not guarantee the
//	  callback will not run once started, so stopGen is bumped under s.mu on
//	  every settle-canceling event (terminal, authoritative new turn, delete,
//	  hydrate, Close) and re-checked inside stopFire.
//
//	autonomous-start guard (#2696, the PRIMARY CRUX — enforced in
//	  upsertMessageLocked): a turn may be (re)opened ONLY on AUTHORITATIVE runner
//	  status (session.status busy|retry → markTurnRunningLocked) — NEVER on a
//	  mutable message.updated arriving after idle. Message records are mutable;
//	  OpenCode stamps its fs-snapshot diff onto them AFTER idle (#2696).
//
//	on-subscribe reconcile (SetActivityFromStatuses): a provider-reported
//	  already-busy session is adopted as TurnRunning; the race guard is
//	  completionAuthoritative (set by a live session.idle / graceFire): a live
//	  idle supersedes a stale busy snapshot, so the snapshot is not re-adopted.
package state

import "time"

// TurnState is the per-session turn-boundary state (the P7 state machine). It is
// distinct from the activity map's idle|busy|retry|error UI indicator: a session
// may be TurnStopping while its activity is still busy-class (the canceled run
// has not yet emitted its terminal).
type TurnState string

const (
	// TurnIdle: no turn in flight. The session is sendable (subject to the rest
	// of the SendableNow gate).
	TurnIdle TurnState = "idle"
	// TurnRunning: a turn is in flight and not being canceled. Set ONLY by
	// authoritative runner status (session.status busy|retry, or on-subscribe
	// reconcile adoption) via markTurnRunningLocked — never by a mutable message
	// (the #2696 guard).
	TurnRunning TurnState = "running"
	// TurnStopping: a stop/abort was issued on the in-flight turn. Still
	// running-class (RunningRoots counts it; SendableNow is false) but terminally
	// doomed — stays stopping until the canceled run's terminal arrives (or the
	// settle timer fires), then settles to TurnIdle.
	TurnStopping TurnState = "stopping"
)

// Stop is the state-layer entry for "a stop/abort was issued on sessionID's
// in-flight turn canceledTurnID." It transitions the session to TurnStopping and
// CLOSES the fail-closed abort gate (AbortSettling → true). Idempotent: a Stop
// issued while already TurnStopping routes to the SAME stop (no re-arm, no
// pendingCancellationTurnID overwrite). It does NOT touch activity — a stopping
// session is still running-class (the canceled run is in flight until its
// terminal), which is what makes "stopping" observably distinct from "idle"
// (RunningRoots stays 1, the spinner stays on until the settle).
func (s *Store) Stop(sessionID, canceledTurnID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopLocked(sessionID, canceledTurnID)
}

// stopLocked is the under-lock body of Stop. Caller holds s.mu.
func (s *Store) stopLocked(sessionID, canceledTurnID string) {
	// Idempotent: Stop-again-during-stop routes to the SAME stop. Do not re-arm a
	// fresh abort, do not change pendingCancellationTurnID, do not bump stopGen.
	if s.turnState[sessionID] == TurnStopping {
		return
	}
	s.turnState[sessionID] = TurnStopping
	s.abortSettling[sessionID] = true
	s.stopTurnID[sessionID] = canceledTurnID
	s.armStopTimerLocked(sessionID)
}

// TurnState returns sessionID's turn-boundary state. Unknown / never-started
// sessions report TurnIdle (the safe default — a session the store has never
// observed a turn on is not running one from this store's perspective).
func (s *Store) TurnState(sessionID string) TurnState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if ts, ok := s.turnState[sessionID]; ok && ts != "" {
		return ts
	}
	return TurnIdle
}

// AbortSettling reports whether a session-scoped abort is still settling on
// sessionID — the fail-closed gate. While true, a new turn started on sessionID
// must WAIT (the awaitRunnerQuiescence analog) before proceeding: OpenCode's
// abort is session-scoped and outlives the stop that issued it, so a new turn
// that races the settling abort would double-drive the runner. This is a pure
// GATE: the state layer reports open/closed; the new turn's CALLER polls/awaits
// it and starts the turn itself (caller-driven — the state layer never
// auto-starts a pending turn). Closed by Stop; opened by the canceled run's
// terminal (session.idle|error), an authoritative new turn start, or the settle
// timer.
func (s *Store) AbortSettling(sessionID string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.abortSettling[sessionID]
}

// markTurnRunningLocked transitions a session to TurnRunning on AUTHORITATIVE
// runner status (session.status busy|retry, or on-subscribe reconcile adoption).
// This is the paseo shouldStartAutonomousTurn boundary: only authoritative
// busy/retry starts a turn — NOT a mutable message.updated (the #2696 guard,
// enforced in upsertMessageLocked). A genuine new turn clears the prior turn's
// authority (completionAuthoritative) and, if a stop was in flight, opens the
// abort gate (the server accepting a new turn ⇒ the prior abort settled ⇒ the
// caller-driven awaitRunnerQuiescence succeeds). Caller holds s.mu.
func (s *Store) markTurnRunningLocked(sessionID string) {
	delete(s.completionAuthoritative, sessionID)
	delete(s.liveIdleObserved, sessionID)
	s.cancelStopTimerLocked(sessionID)
	s.abortSettling[sessionID] = false
	delete(s.stopTurnID, sessionID)
	s.turnState[sessionID] = TurnRunning
}

// settleTerminalLocked handles a turn-TERMINAL event (session.idle /
// session.error) in the turn-state machine:
//   - TurnStopping: the canceled run's terminal arrived — settle the abort (OPEN
//     the gate), drop the pendingCancellationTurnID, go TurnIdle.
//   - TurnRunning: the turn ended normally — go TurnIdle.
//   - TurnIdle: no-op.
//
// NO auto-promotion: a new turn's caller must observe AbortSettling==false and
// start the turn itself (caller-driven). The activity-side idle/error clear is
// done by the reducer's status handler (Apply), NOT here — this function owns
// only the turn-boundary state + the gate. Caller holds s.mu.
func (s *Store) settleTerminalLocked(sessionID string) {
	switch s.turnState[sessionID] {
	case TurnStopping:
		s.cancelStopTimerLocked(sessionID)
		s.abortSettling[sessionID] = false
		delete(s.stopTurnID, sessionID)
		s.turnState[sessionID] = TurnIdle
	case TurnRunning:
		s.turnState[sessionID] = TurnIdle
	}
}

// armStopTimerLocked arms the settle timer for sessionID.
//
// Rationale + asymmetry (Deviation 2 of the P7 slice): an inference must never
// BLOCK a turn (over-blocks, suppresses real work) but MAY UNBLOCK after a
// bounded wait — otherwise a missing terminal wedges the session in Stopping
// forever. OpenCode does NOT emit session.idle on abort (reducers.go:249 /
// verbs.go:261), so the gate's settle cannot rely on a terminal arriving after
// an abort verb. stopFire is therefore a LIVENESS fallback, not a settle
// authority. Different fail-safe directions, same observed-vs-inferred
// principle as the #2696 guard: never BLOCK on an inference (liveIdleObserved),
// but a bounded UNBLOCK on a missing terminal (this timer) is safe.
//
// Failure mode: if this duration is too SHORT, stopFire unblocks while the
// runner is still aborting mid-flight — exactly the bug this slice fixes (the
// old synchronous MarkIdle in pkg/web/verbs.go:abort). The periodic reconcile
// (SetActivityFromStatuses clearActivity fallback), NOT this timer, is the real
// corrector. The timer is a liveness backstop; the reconcile is the settle
// authority.
//
// Duration: completionGrace (default defaultCompletionGrace = 5s, store.go:1377)
// — generous on purpose (a too-short timer re-introduces the abort-mid-flight
// race). The supersede generation counter (stopGen) closes the timer-vs-cancel
// race. After completionGrace with no terminal arriving, stopFire force-opens
// the gate and idles activity — the deferred counterpart of the retired
// synchronous MarkIdle. Caller holds s.mu.
func (s *Store) armStopTimerLocked(sessionID string) {
	s.stopGen[sessionID]++
	gen := s.stopGen[sessionID]
	if prev := s.stopTimers[sessionID]; prev != nil {
		prev.Stop() // defensive: Stop is gated on entering TurnStopping, so a
		// pending timer for the same session should not normally exist; stop any
		// straggler before replacing it.
	}
	s.stopTimers[sessionID] = time.AfterFunc(s.completionGrace, func() {
		s.stopFire(sessionID, gen)
	})
}

// cancelStopTimerLocked cancels a pending settle timer for sessionID and bumps
// stopGen so a callback already in flight (or about to fire) detects the
// supersede and aborts. Caller holds s.mu.
func (s *Store) cancelStopTimerLocked(sessionID string) {
	s.stopGen[sessionID]++
	if t := s.stopTimers[sessionID]; t != nil {
		t.Stop()
		delete(s.stopTimers, sessionID)
	}
}

// cancelAllStopTimersLocked cancels every pending settle timer (used on hydrate
// / shutdown so no callback fires into a reconciling / torn-down store). Caller
// holds s.mu.
func (s *Store) cancelAllStopTimersLocked() {
	for id, t := range s.stopTimers {
		t.Stop()
		s.stopGen[id]++
		delete(s.stopTimers, id)
	}
}

// stopFire is the settle-timer callback. It runs on a time.AfterFunc goroutine.
// Under s.mu it re-checks stopGen (abort if superseded by a terminal / new turn
// / cancel / hydrate), then force-settles: opens the gate, drops the
// pendingCancellationTurnID, goes TurnIdle, and authoritatively idles activity
// (the canceled run is assumed settled — OpenCode did not emit session.idle).
// Routed through setActivityLocked so busyCount / subtreeBusyCount / the
// KindActivity emit all stay consistent.
//
// INTENTIONAL OMISSION (F5): unlike graceFire (grace.go → clearOnCompletionLocked),
// stopFire does NOT set completionAuthoritative. graceFire arms the guard because
// it infers a NORMAL turn-end (a stale /session/status must not re-strand the
// completed turn); stopFire infers an ABORTED turn-end, and aborts do not emit
// session.idle, so there is no live-idle observation to pin the guard on here.
// Whether stopFire (and the session.error terminal path) SHOULD set
// completionAuthoritative to block a stale busy from re-escalating an
// abort/error-settled session is the F4 deferred question (open). Today neither
// path arms the guard — a stale busy snapshot post-settle is handled by the
// SetActivityFromStatuses completionAuthoritative guard only when session.idle
// or graceFire set it earlier, NOT by this path. See upsertMessageLocked's
// liveIdleObserved discriminator for the #2696 line.
func (s *Store) stopFire(sessionID string, gen uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.stopGen[sessionID] != gen {
		return // superseded: a terminal, authoritative new turn, cancel, or
		// hydrate bumped stopGen after this timer captured it.
	}
	delete(s.stopTimers, sessionID)
	s.abortSettling[sessionID] = false
	delete(s.stopTurnID, sessionID)
	s.turnState[sessionID] = TurnIdle
	// Authoritative idle clear (the deferred MarkIdle). setActivityLocked is a
	// no-op when already idle, so a real session.idle that landed first
	// reconciles harmlessly.
	s.setActivityLocked(sessionID, ActivityIdle)
}

// InflightAssistantID returns the id of sessionID's inflight assistant message
// (a turn generating right now), or "" if none. It is the turn id the abort verb
// (pkg/web/verbs.go) threads into Stop's pendingCancellationTurnID payload.
func (s *Store) InflightAssistantID(sessionID string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.inflightAssistantIDLocked(sessionID)
}

// inflightAssistantIDLocked is the under-lock body of InflightAssistantID. It
// returns the NEWEST inflight assistant message id (mirroring the
// newest-assistant scan in recomputeLastAssistantLocked). Caller holds s.mu (or
// s.mu.RLock for the read).
func (s *Store) inflightAssistantIDLocked(sessionID string) string {
	sm := s.messages[sessionID]
	if sm == nil {
		return ""
	}
	for i := len(sm.order) - 1; i >= 0; i-- {
		me := sm.byID[sm.order[i]]
		if me != nil && me.role == "assistant" && !me.completed {
			return me.id
		}
	}
	return ""
}
