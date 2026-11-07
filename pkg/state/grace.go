// Package state: the grace concern — the completion-grace timer +
// completion-authority guard state machine (Lane A fix for the stale
// "1 running" strand), mechanically extracted from store.go (reference model:
// snapshots.go, reducers.go, hydration.go, subscriptions.go, message_window.go,
// subtree_indexes.go). This file owns:
//   - armGraceLocked — arm the completion-grace timer (called by the reducer's
//     upsertMessageLocked on turn completion);
//   - cancelGraceLocked — cancel one session's grace (called by the reducer on
//     new inflight / session.idle / delete);
//   - cancelAllGraceLocked — cancel every armed grace timer (called by Hydrate
//     and Close so no callback fires into a reconciling / torn-down store);
//   - graceFire — the time.AfterFunc callback (G-S1, the only goroutine the
//     store spawns), which re-acquires s.mu fresh, re-checks graceGen, and
//     fires the authoritative completion; and
//   - clearOnCompletionLocked — the authoritative idle-clear cascade (routes
//     through setActivityLocked + arms completionAuthoritative).
//
// Approach-B rider (false-interrupted-marker fix, bug 2026-10-14): this file
// also owns the completion-authority ARM/DISCRIMINATE/DISARM surface the fix
// added — armCompletionAuthorityLocked (every arm site records WHAT the
// authority was armed over, armedAuthorityRecord), newTurnSupersedesArmed-
// AuthorityLocked (the strict created-key new-turn discriminator consumed by
// SetActivityFromStatuses), disarmCompletionAuthorityLocked, and the
// newestAssistantLocked / messageCreatedHighWaterLocked record inputs.
//
// The Store struct and its single s.mu RWMutex stay in store.go and are shared
// across this whole package (same-package file split; no protocol change). The
// graceTimers / graceGen / completionAuthoritative / completionGrace STRUCT
// FIELDS stay on the Store struct (same-package cross-file access from this
// concern); only the functions that read/write them move here.
//
// graceGen is the authoritative race-closer: time.Timer.Stop does not guarantee
// the callback will not run once started, so graceGen is bumped under s.mu on
// every grace-canceling event (arm / cancel / cancelAll) and re-checked inside
// graceFire before any state mutation — a fire that races a cancel is a benign
// no-op. Behavior-preserving verbatim move.
package state

import (
	"math"
	"time"
)

// --- completion-grace window + completion-authority guard (Lane A) ---
//
// The completion-grace window is the fast clearer for a stranded busyCount when
// session.idle is missed. The completion-authority guard is the permanent
// protection: once the turn is authoritatively over (grace fired or session.idle
// observed), a stale busy from /session/status must not re-strand it. Together
// they make message.updated{completed} WIN over a stale /session/status snapshot
// — the authority ordering the Lane A fix requires.

// armGraceLocked arms the completion-grace window for sessionID: after
// completionGrace with no new activity, the session is authoritatively marked
// idle (clearing the stranded busyCount entry that session.idle would have
// cleared) and the completion-authority guard is armed. Caller holds s.mu.
//
// A new assistant inflight message (upsertMessageLocked), session.idle, a
// delete (deleteSessionLocked), or a hydrate cancels it. The timer callback
// re-checks graceGen so a fire that races a cancel is a no-op: time.Timer.Stop
// does not guarantee the callback will not run once started, so the generation
// counter is the authoritative supersede signal.
func (s *Store) armGraceLocked(sessionID string) {
	s.graceGen[sessionID]++
	gen := s.graceGen[sessionID]
	if prev := s.graceTimers[sessionID]; prev != nil {
		prev.Stop() // defensive: arm is gated on a completion transition, so a
		// pending timer for the same session should not normally exist; stop
		// any straggler before replacing it.
	}
	s.graceTimers[sessionID] = time.AfterFunc(s.completionGrace, func() {
		s.graceFire(sessionID, gen)
	})
}

// cancelGraceLocked cancels a pending completion-grace timer for sessionID and
// bumps graceGen so a callback already in flight (or about to fire) detects the
// supersede and aborts. Caller holds s.mu.
func (s *Store) cancelGraceLocked(sessionID string) {
	s.graceGen[sessionID]++
	if t := s.graceTimers[sessionID]; t != nil {
		t.Stop()
		delete(s.graceTimers, sessionID)
	}
}

// cancelAllGraceLocked cancels every pending completion-grace timer (used on
// hydrate / shutdown). Caller holds s.mu.
func (s *Store) cancelAllGraceLocked() {
	for id, t := range s.graceTimers {
		t.Stop()
		s.graceGen[id]++
		delete(s.graceTimers, id)
	}
}

// graceFire is the completion-grace timer callback. It runs on a time.AfterFunc
// goroutine. Under s.mu it re-checks graceGen (abort if superseded by a new
// turn / cancel / hydrate), then authoritatively marks the session idle and
// arms the completion-authority guard so a stale /session/status cannot
// re-strand it.
func (s *Store) graceFire(sessionID string, gen uint64) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.graceGen[sessionID] != gen {
		return // superseded: a new inflight, session.idle, delete, or hydrate
		// bumped graceGen after this timer captured it.
	}
	delete(s.graceTimers, sessionID)
	s.clearOnCompletionLocked(sessionID)
}

// clearOnCompletionLocked is the authoritative idle-clear on completion (grace
// fire). It routes through setActivityLocked so busyCount, subtreeBusyCount,
// the seven O1 subtree indexes, the KindActivity emit, and the (correct,
// non-spurious) "finished" unread mark all stay consistent — exactly the path
// session.idle takes. Arms completionAuthoritative so a stale busy from
// /session/status (the HTTP poll) does not re-escalate. Caller holds s.mu.
func (s *Store) clearOnCompletionLocked(sessionID string) {
	s.setActivityLocked(sessionID, ActivityIdle)
	s.armCompletionAuthorityLocked(sessionID)
}

// armCompletionAuthorityLocked arms the completion-authority guard for
// sessionID and records WHAT it was armed over (armedAuthorityRecord): the
// newest assistant row's identity and created key at arm time, plus whether
// that row ANCHORS a sound newness bound (anchored: resident AND keyed), and
// the created-key high-water over the whole resident view. The record is the
// approach-B discriminator for the false-interrupted-marker fix (bug
// 2026-10-14, "False interrupted marker after restart"): it lets a later
// busy/retry statuses observation prove a NEW turn started (a keyed
// assistant row whose created key strictly postdates the arm-time view,
// still uncompleted) and disarm the authority — while a stale same-turn busy
// (newest==armed or newest completed) and a #2696 post-terminal trap row
// (old/equal/unkeyed created — it cannot prove it postdates the arm) both
// stay blocked. Called from EVERY authority arm site: the live session.idle
// and session.error terminals (reducers.go) and graceFire (via
// clearOnCompletionLocked). Caller holds s.mu.
func (s *Store) armCompletionAuthorityLocked(sessionID string) {
	var rec armedAuthorityRecord
	sm := s.messages[sessionID]
	if newest := newestAssistantLocked(sm); newest != nil && newest.createdOK {
		// ANCHOR RULE (commit-review rounds 2-4): the armed-over assistant
		// row must be the LAST RESIDENT ROW of the view AND carry the whole
		// view's max created key for the record to carry a sound newness
		// bound. The order check sees rows the keyed comparison cannot:
		// keyless placeholders (which sort at +∞ — a user prompt that
		// arrived as a part-before-message placeholder) and equal-created
		// rows (stable-inserted after the assistant) postdate it in ORDER
		// while leaving the keyed high-water untouched. Any resident row
		// following the newest assistant — typically the finished turn's
		// own USER prompt (an older-turn assistant is resident while the
		// finished turn's rows were swallowed by a reconnect gap), or a
		// prompt queued during the run — is the signature of a prompt whose
		// assistant rows may be entirely unseen, in which case no
		// view-derived bound can exclude a previously-unseen row of the
		// FINISHED turn (old key, completion stripped). Record unanchored
		// and refuse disarms; the busy-report latch reset + sweep-skip in
		// SetActivityFromStatuses keep such a turn from being
		// false-marked, and a live session.status busy (the authoritative
		// new-turn signal) still clears the authority.
		lastInOrder := sm != nil && len(sm.order) > 0 && sm.order[len(sm.order)-1] == newest.id
		hw := s.messageCreatedHighWaterLocked(sessionID)
		if lastInOrder && newest.createdMs >= hw {
			rec.anchored = true
			rec.newestAssistantID = newest.id
			rec.createdHighWater = hw
		}
	}
	s.completionAuthoritative[sessionID] = true
	s.completionArmedOver[sessionID] = rec
}

// armedAuthorityRecord is what a completion-authority arm site captured:
// whether the arm-time view ANCHORS a sound newness bound, the armed-over
// newest assistant row's identity, and the arm-time created-key high-water.
//
// anchored is true only when the newest assistant row was the LAST RESIDENT
// ROW of the view AND the carrier of the whole view's max created key
// (nothing follows it in sm.order — keyless placeholders and equal-created
// stable-inserts included — and no keyed row exceeds it): its created key
// (== the whole-view high-water) then upper-bounds everything the finished
// turn could have produced. When the view held no keyed assistant, or any
// row follows the newest assistant in order (an empty, user-only, or
// prompt-after-assistant view — the reconnect-gap shapes),
// NO sound bound exists (the turn's own rows may arrive later carrying older
// or slightly-newer keys), so the discriminator refuses every disarm and the
// busy-report latch reset + sweep-skip carry the false-marker burden.
//
// Accepted residual (the information-theoretic boundary, commit-review
// round 2 dropped-F4 / rounds 3-4 accepted as bounded): when the final step
// of a multi-step finished turn was NEVER DELIVERED (the resident newest
// assistant is an EARLIER step, and nothing else follows it — the view
// still anchors), a stripped-completion re-serve of that unseen final step
// carries a created key strictly newer than the high-water and is
// observably equivalent to the first row of a genuine new turn under every
// separator the store can actually consult. No established, complete
// turn-boundary separator exists in the v1 contract: message parentID (v1
// rows may carry it) links a response to its prompt but does not bound
// multi-step turns and is absent from the terminal events; the alternatives
// are all rejected elsewhere (wall clock — forbidden by the fix's mission
// and skew-tuning-burdened; two-consecutive-busy generation counting —
// resurrects the permanent Lane A strand on a persistently stale
// /session/status; upstream turn-id provenance — absent from the v1 event
// contract). The residual's failure direction is bounded: it can only
// OVER-REPORT a turn as busy (re-adoption that clears on the first truthful
// not-busy observation), never produce a false VHSolaraInterruptedError.
// Pinned as documented behavior in
// TestSweepArmedAuthorityAcceptedResidual_StrippedUnseenStep.
type armedAuthorityRecord struct {
	newestAssistantID string
	anchored          bool
	createdHighWater  float64
}

// messageCreatedHighWaterLocked returns the maximum created key (time.created,
// unix ms) over every message resident for sessionID, or -Inf when none is
// keyed. It is an ARM-TIME snapshot of "everything the turn that armed the
// authority could see" — the bar a later row must strictly exceed to count
// as new-turn evidence. Caller holds s.mu.
func (s *Store) messageCreatedHighWaterLocked(sessionID string) float64 {
	sm := s.messages[sessionID]
	if sm == nil {
		return math.Inf(-1)
	}
	hw := math.Inf(-1)
	for _, me := range sm.byID {
		if me != nil && me.createdOK && me.createdMs > hw {
			hw = me.createdMs
		}
	}
	return hw
}

// disarmCompletionAuthorityLocked drops the completion-authority guard
// together with its armed-over record and the #2696 observed-terminal
// discriminator. This is the approach-B new-turn path: once a busy/retry
// statuses observation is backed by a provably newer uncompleted assistant
// row, the prior turn's authority no longer applies — clearing
// liveIdleObserved re-opens the live message-stream escalation path for the
// new turn (a later mutable message.updated on the NEW row must not hit the
// #2696 guard). markTurnRunningLocked performs the same pair-clear on
// authoritative turn starts. Caller holds s.mu.
func (s *Store) disarmCompletionAuthorityLocked(sessionID string) {
	delete(s.completionAuthoritative, sessionID)
	delete(s.liveIdleObserved, sessionID)
	delete(s.completionArmedOver, sessionID)
}

// newestAssistantLocked returns the newest assistant entry of a session
// message view (any completion state), or nil. Caller holds s.mu.
func newestAssistantLocked(sm *sessionMessages) *messageEntry {
	if sm == nil {
		return nil
	}
	for i := len(sm.order) - 1; i >= 0; i-- {
		if me := sm.byID[sm.order[i]]; me != nil && me.role == "assistant" {
			return me
		}
	}
	return nil
}

// newTurnSupersedesArmedAuthorityLocked reports whether the session's newest
// assistant message is provably NEWER than the turn that armed the
// completion authority AND still uncompleted — the approach-B new-turn
// evidence that lets a busy/retry statuses observation disarm the authority
// (the false-interrupted-marker fix). Caller holds s.mu.
//
// Newness is proven by the row's OWN chronology, never by sm.order position
// alone and never by wall clock, and only when the arm record is ANCHORED
// (the armed-over newest assistant row was resident and keyed at arm time):
// the newest assistant must carry a created key STRICTLY greater than the
// arm-time high-water of the whole resident view. That is independent
// new-turn provenance in the commit-review F4 sense — a #2696 post-terminal
// trap row cannot fake it:
//   - a re-served old record keeps its old key (<= high-water ⇒ refused);
//   - an equal-created stamped copy ties the high-water (strict > fails ⇒
//     refused);
//   - an unkeyed patched row (the stylized trap shape) cannot prove anything
//     (⇒ refused);
//   - an UNANCHORED arm (no keyed assistant, or a row postdating the newest
//     assistant — empty, user-only, or prompt-after-assistant arm-time views,
//     i.e. a terminal that arrived after a reconnect gap swallowed the turn's
//     rows) refuses outright: no view-derived bound can exclude a
//     previously-unseen row of the FINISHED turn (old key, completion
//     stripped), so no message-domain proof of newness exists at all. The
//     busy-report latch reset + sweep-skip in SetActivityFromStatuses carry
//     the false-marker burden there, and a LIVE session.status busy event
//     remains the authoritative clear.
//
// Further tighteners (each refuses the disarm, keeping HEAD behavior):
//   - no resident assistant, or the newest assistant COMPLETED: no live new
//     turn (a missed-idle turn that already completed stays protected);
//   - the newest assistant IS the armed-over row (same id): the #2696
//     same-row trap and Lane A's stale same-turn busy both land here;
//   - a missing armed-over record (authority set without its record — a
//     torn invariant): refuse conservatively.
//
// Honest residual (the price of soundness): on an UNANCHORED arm, a genuine
// reconcile-only new turn is not adopted as busy by its first statuses
// observation (the pre-existing #2696-wedge posture — idle until the
// authoritative live busy arrives or a provable row exists). It is never
// false-MARKED, which is the actual bug; under-reporting activity is the
// safe direction. The two-observation d-F1 gate remains the not-busy-path
// backstop either way.
func (s *Store) newTurnSupersedesArmedAuthorityLocked(sessionID string) bool {
	rec, ok := s.completionArmedOver[sessionID]
	if !ok {
		return false // torn invariant — conserve (HEAD behavior)
	}
	if !rec.anchored {
		return false // no sound newness bound exists (empty/partial arm-time view)
	}
	sm := s.messages[sessionID]
	if sm == nil {
		return false
	}
	me := newestAssistantLocked(sm)
	if me == nil {
		return false // no resident assistant
	}
	if me.completed {
		return false // newest assistant completed — no live new turn
	}
	if me.id == rec.newestAssistantID {
		return false // the SAME row the authority was armed over (#2696 / Lane A)
	}
	// Independent new-turn provenance: the row's own created key must
	// strictly postdate the ENTIRE arm-time view. Refuses old re-serves,
	// equal-created stamped copies, and unkeyed patched rows alike.
	return me.createdOK && me.createdMs > rec.createdHighWater
}
