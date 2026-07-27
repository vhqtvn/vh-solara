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
	s.completionAuthoritative[sessionID] = true
}
