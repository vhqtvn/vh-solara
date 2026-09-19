package web

// The restart queue fence — the queue-dispatch arm of the restart-interruption
// fix. (The assistant-turn arm is P1-API-007: abortInflightBeforeRestart +
// the pkg/state interrupted-turn sweep.)
//
// PROBLEM: a queue item claimed by the browser (state `dispatching`) whose
// prompt_async POST is in flight when a UI-triggered restart kills the
// OpenCode process is only EXPLAINABLE by inference afterwards. OpenCode
// never persisted the user message (killed mid-dispatch), so the message-id
// reconciler (queue_msg_reconcile.go) eventually exhausts its bounded 3×404
// budget and terminalizes the item with the GENERIC persistent-404 text
// ("OpenCode has no record of this message … may have failed before
// persisting"). The detection is correct — but the operator reading the chip
// cannot tell "the restart I clicked at 15:57 interrupted this dispatch"
// from "OpenCode 404'd for an unrelated reason". Incident 2026-09-18
// (ses_f4ee263afffe6JK1yaiNy0nvs2): item enqueued 15:57:20, restart clicked
// 15:57:37 killing opencode pid 572684 mid-dispatch, 3 real 404s → generic
// terminal text. (Contrast the mid-run arm: a queue item whose POST never
// persisted leaves NO assistant message, so the P1-API-007 orphan sweep —
// which selects uncompleted ASSISTANT rows — cannot see it. This fence is
// the queue-side answer.)
//
// FENCE (deterministic, not heuristic): at restart time — BEFORE the process
// is killed — the server durably stamps every in-flight `dispatching` queue
// item with RestartFenceAt (queue.json, OUR store only; never opencode's
// DB). The stamp does NOT change the item's state or lifecycle: stale-dispatch
// recovery, the reconciler's 3×404 budget, and the exact-match → sent heal
// all run EXACTLY as before (the detector is NOT weakened — an unfenced
// persistent 404 keeps the generic text and the same budget). The stamp only
// changes the EXPLANATION: stale-dispatch recovery and reconcile
// terminalization prefer the restart-specific detail when the marker is
// present, so the chip says the dispatch was interrupted by an OpenCode
// restart instead of offering the generic 404 guess as the dominant cause.
//
// WHY STAMP RATHER THAN RESOLVE: at fence time the POST's outcome is genuinely
// unknown — the browser may have landed the 204 before the kill and OpenCode
// may have persisted under the minted correlation id. Resolving the item to
// any terminal state at fence time would either foreclose the exact-match →
// sent heal or rewrite a terminal the browser's own resolve owns. Stamping a
// marker keeps the state machine untouched and lets the EXISTING recovery
// paths reach the correct terminal with the better explanation.
//
// BOUNDED: the fence is a bounded set of local atomic file writes (one per
// affected queue.json) — no network, no waits, no goroutines — so it cannot
// wedge the restart. A store-level failure logs and proceeds: the affected
// items fall back to the generic recovery/terminal texts (fail-open to the
// pre-fence behavior; the unchanged detector still owns them).
//
// COVERAGE BOUNDARY: the fence walks the in-memory queueRegistry — every
// store this daemon process has touched. A queue.json never opened by this
// daemon cannot be mid-dispatch FROM this daemon (the Claim that moved an
// item to `dispatching` goes through store()), so the walk is complete for
// the restart this daemon is about to perform. The vanishing race — a Claim
// landing on a store created after the fence snapshot, in the window before
// the process kill — is owned by generic stale-dispatch recovery, exactly as
// pre-fence.

import (
	"time"

	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// Restart-specific operator-facing detail texts. These are the marker-aware
// counterparts of staleDispatchRecoveryDetail and the reconcileTerminal*Fmt
// constants: same fail-closed semantics, better explanation. The 400
// caller-bug terminal (reconcileTerminal400Detail) deliberately has NO
// restart variant — a 400 means OpenCode POSITIVELY rejected the message id,
// which a restart kill does not explain.
const (
	// restartFenceStaleRecoveryDetail is stamped by
	// recoverStaleDispatchingLocked when the abandoned dispatch carries the
	// restart fence marker.
	restartFenceStaleRecoveryDetail = "Recovery: the dispatch was interrupted by an OpenCode restart before the outcome could be confirmed. The prompt may have reached OpenCode; sending it again may duplicate work."

	// The %d is the final attempt count (fmt.Sprintf). Same budget and
	// fail-closed behavior as their generic counterparts — only the
	// explanation differs.
	restartFenceTerminal404DetailFmt       = "Reconcile terminal (restart-interrupted): OpenCode has no record of this message after %d attempt(s) (persistent 404) — the dispatch was in flight when an OpenCode restart killed the process. The turn never started; manual review advised."
	restartFenceTerminalTransientDetailFmt = "Reconcile terminal (restart-interrupted): OpenCode was unreachable or returned a non-matching record after %d attempt(s); cannot confirm the message was sent — the dispatch was interrupted by an OpenCode restart. Manual review advised."
	restartFenceTerminalMismatchDetailFmt  = "Reconcile terminal (restart-interrupted): the correlation id did not map to this session's user message after %d attempt(s) — the dispatch was interrupted by an OpenCode restart. Manual review advised."
)

// fenceInflightQueueDispatches is the Server-level restart fence entry,
// invoked by BOTH restart handlers immediately before
// abortInflightBeforeRestart / restartOC. It durably stamps every in-flight
// `dispatching` queue item across every registered queue store with
// RestartFenceAt so the item's eventual recovery/reconcile-terminal detail
// explains the restart. Bounded local writes; failures are logged per store
// and never block the restart.
func (s *Server) fenceInflightQueueDispatches() {
	n := s.queues.fenceDispatchingForRestart(time.Now())
	if n > 0 {
		vhlog.Info("restart queue fence: marked in-flight dispatch(es) interrupted by restart", "count", n)
	}
}

// fenceDispatchingForRestart stamps RestartFenceAt on every `dispatching`
// item in every registered store and returns how many items were stamped.
// Stores are snapshotted under the registry mutex (mirroring the
// abortInflightBeforeRestart aggMu snapshot pattern) and then fenced
// individually: a store archived (deleteStore) between snapshot and fence
// refuses via errQueueArchived — a benign skip, since the archived queue is
// going away by design. Disk I/O runs OUTSIDE qr.mu so concurrent store()
// creation is never blocked by the fence walk.
func (qr *queueRegistry) fenceDispatchingForRestart(now time.Time) int {
	qr.mu.Lock()
	stores := make([]*sessionQueueStore, 0, len(qr.stores))
	for _, st := range qr.stores {
		stores = append(stores, st)
	}
	qr.mu.Unlock()
	total := 0
	for _, st := range stores {
		n, err := st.fenceDispatchingForRestart(now)
		if err != nil {
			if err == errQueueArchived {
				// Archived between snapshot and fence — the queue is being
				// cleaned up; nothing to fence. Not a warning.
				continue
			}
			vhlog.Warn("restart queue fence: store fence failed; item falls back to generic recovery texts",
				"path", st.path, "err", err)
			continue
		}
		total += n
	}
	return total
}

// fenceDispatchingForRestart stamps RestartFenceAt=now.UnixMilli() on every
// `dispatching` item of this store, persisting atomically. It does NOT touch
// the item's state, lifecycle timestamps, or detail: the existing
// stale-dispatch recovery and reconciler paths remain the sole owners of the
// state machine (the marker only selects better detail texts downstream).
//
// Idempotent: an item already carrying a fence stamp is left untouched (the
// FIRST stamp is the honest one — a second restart before recovery must not
// rewrite the interruption time). A no-op store (nothing dispatching, or
// everything already stamped) performs no save. On save failure the
// in-memory mutation rolls back (mirrors the Claim/Resolve rollback pattern)
// and the error is returned for the caller to log.
func (s *sessionQueueStore) fenceDispatchingForRestart(now time.Time) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		return 0, errQueueArchived
	}
	if err := s.load(); err != nil {
		return 0, err
	}
	fenced := 0
	// Snapshot BEFORE any mutation so a save failure rolls the in-memory
	// state back (mirrors the Claim/Resolve rollback pattern). The shallow
	// copy is sufficient: the fence only mutates the scalar RestartFenceAt.
	pre := make([]QueueItem, len(s.items))
	copy(pre, s.items)
	for i := range s.items {
		if s.items[i].State != QueueDispatching || s.items[i].RestartFenceAt != 0 {
			continue
		}
		s.items[i].RestartFenceAt = now.UnixMilli()
		fenced++
	}
	if fenced == 0 {
		return 0, nil
	}
	if err := s.save(); err != nil {
		s.items = pre
		return 0, err
	}
	return fenced, nil
}
