package web

// Certified redelivery classification — slice 2b phase 2 (the behavior wave).
//
// THE OPERATOR-ACCEPTED POLICY (debate-4 DEFAULT) IS BINDING: auto-redelivery
// is allowed for EXACTLY three certified classes —
//
//   1. never-started  (custody-claimed, ZERO attempt records — the write-
//                      ahead protocol is begin→POST, so no attempt record
//                      proves no POST ran; design.md "Certified Redelivery"
//                      class 1)
//   2. connect_failed (the receipt proves the dial never established ⇒
//                      nothing was written; class 2)
//   3. post-restart barrier
//                    (OpenCode restarted AFTER the attempt started — the
//                    journaled OCGeneration is older than the current one —
//                    AND the exact-ID GET 404s post-restart AND
//                    custodyBarrierCertified(externalOC); class 3. The
//                    projector pin (tmp/agent-runs/send-design/projector-
//                    pin.md) proves event-append and projection commit in
//                    ONE SQLite transaction inside commitDurableEvent, so a
//                    post-restart 404 for the exact id proves the
//                    MessageUpdated transaction never committed — the
//                    message never durably existed. Retires the P1-API-008
//                    class as self-healing.)
//
// The live-uncertain class (written_unknown / accepted_2xx / an OPEN attempt
// with OpenCode alive + 404) NEVER auto-redelivers — it surfaces as the
// durable AmbiguousDelivery terminal for the FE (slice 3 builds the chip +
// one-tap replacement on it). Restarting OpenCode to FORCE a barrier is
// PROHIBITED as routine automation (escalation only, design B2/O3) — this
// file never restarts anything; it only OBSERVES restarts via the generation
// signal.
//
// session.error events are recorded as DETAIL-LEVEL SIGNAL ONLY (the
// projector pin: the failure branch always publishes NamedError.Unknown with
// a human pretty-print — weak semantics, never a classification input, never
// a state transition). See installQueueSessionErrorSignal.
//
// CLASS-TRANSITION TABLE (state × evidence → action; design.md refs):
//
//	item state        | journal evidence               | GET       | action
//	------------------+--------------------------------+-----------+-----------------------
//	unknown/stale     | ClaimGeneration==0 (legacy)    | any       | passive flow only —
//	dispatching       |                                |           | UNCERTIFIABLE (design
//	                |                                 |           | "Legacy unknown chips");
//	                |                                 |           | never requeue
//	unknown/stale     | zero attempts (C1)             | any*      | requeue, SAME msgid
//	dispatching       |                                |           | (id never left machine)
//	unknown/stale     | last=connect_failed (C2)       | any*      | requeue, SAME msgid
//	                |                                 |           | (dial never established)
//	unknown/stale     | restart since attempt (OCGen   | 404 +     | requeue, SAME msgid
//	dispatching       | bumped) + barrier certified    | barrier   | (commit provably never
//	                |                                 | certified | landed; class 3)
//	unknown/stale     | open/written_unknown/          | 404       | AMBIGUOUS terminal +
//	dispatching       | accepted_2xx, OC alive         |           | marker (class 4 — never
//	                |                                 |           | auto-POST)
//	any eligible      | any                            | 200 exact | Resolve(sent) — exact-ID
//	                |                                 |           | GET is the ONLY delivery
//	                |                                 |           | claim (invariant 1)
//	stale dispatching | last=server_error              | n/a       | Resolve(failed) — the
//	                |                                 |           | explicit non-2xx verdict
//	                |                                 |           | (class 5, no loop)
//
//	* C1/C2 verdicts are proven by the JOURNAL alone (the design's ladder
//	  does not gate them on the GET); the GET still runs first on the shared
//	  path because a 200-exact match overrides every class — if the exact id
//	  maps to a persisted user message, the item is SENT no matter what the
//	  journal says. A transient GET error does NOT block a C1/C2 requeue.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/state"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// certifiedClass names the disposition the classifier reaches for one item.
type certifiedClass string

const (
	// classNone: no certified verdict (legacy item — leave it to the
	// passive flow's ambiguous budget path).
	classNone certifiedClass = ""
	// classNeverStarted: C1 — custody-claimed, zero attempt records.
	classNeverStarted certifiedClass = "never_started"
	// classConnectFailed: C2 — last attempt receipt is connect_failed.
	classConnectFailed certifiedClass = "connect_failed"
	// classRestartBarrier: C3 — OpenCode restarted since the attempt AND the
	// post-restart exact-ID GET 404'd AND custodyBarrierCertified.
	classRestartBarrier certifiedClass = "restart_barrier"
	// classAmbiguous: C4 — live-uncertain (never auto-redeliver; the passive
	// budget path terminalizes with the AmbiguousDelivery marker).
	classAmbiguous certifiedClass = "ambiguous"
	// classServerErrno: C5 — the journal's last receipt is an explicit
	// server_error; resolve terminal failed (no loop).
	classServerErrno certifiedClass = "server_error"
)

// requeueJustification* are the DURABLE Detail texts stamped on requeue (the
// operator-readable record of WHICH certified class authorized the
// redelivery — each cites its design.md basis).
const (
	requeueJustificationNeverStarted  = "Certified redelivery (never started): the dispatch journal has no attempt record for this custody-claimed item, so the prompt POST never ran (claim→begin is strictly sequential). Redelivering under the same correlation id; the id never left this machine. [design.md Certified Redelivery class 1]"
	requeueJustificationConnectFailed = "Certified redelivery (connect failed): the last attempt's transport receipt proves the connection was never established, so nothing was written to OpenCode. Redelivering under the same correlation id. [design.md Certified Redelivery class 2]"
	requeueJustificationRestartBarrie = "Certified redelivery (post-restart barrier): OpenCode restarted after this attempt and the post-restart exact-id lookup returned 404 — the upstream persistence transaction never committed (event+projection commit atomically), so the prompt provably never durably landed. Redelivering under the same correlation id. [design.md Certified Redelivery class 3]"
)

// classifyCertifiedRedelivery is the PURE classifier (unit-testable, no I/O):
// given the item's CURRENT durable shape, the OpenCode process generation
// now, whether the topology may certify the restart barrier
// (custodyBarrierCertified), and whether the just-run exact-ID GET returned
// a definitive 404 (get404; false for 200/transient/4xx-other — the caller
// supplies only this bit, keeping the network out of the pure core).
//
// Precedence (see the class-transition table): server_error → never-started
// → connect_failed → restart-barrier → ambiguous. Legacy items
// (ClaimGeneration==0) can never certify anything.
func classifyCertifiedRedelivery(it QueueItem, ocGenNow uint64, barrierCertified, get404 bool) certifiedClass {
	// The era marker gates EVERYTHING: an item claimed by the legacy
	// browser path shares queue.json with custody items but its dispatch
	// history is unwitnessed by this daemon's journal protocol.
	if it.ClaimGeneration == 0 {
		return classNone
	}
	// Explicit upstream rejection: terminal failed, no loop (class 5).
	if n := len(it.Attempts); n > 0 && it.Attempts[n-1].TransportClass == QueueAttemptServerError {
		return classServerErrno
	}
	// C1 — never-started: the journal proves no POST ran.
	if len(it.Attempts) == 0 {
		return classNeverStarted
	}
	// C2 — connect_failed: the receipt proves nothing was written.
	if last := it.Attempts[len(it.Attempts)-1]; last.TransportClass == QueueAttemptConnectFailed {
		return classConnectFailed
	}
	// C3 — post-restart barrier: restart observed since the attempt AND the
	// post-restart GET 404'd AND the topology matrix certifies the claim.
	// All three conjuncts are REQUIRED (a restart alone or a 404 alone
	// proves nothing — the id may still commit late; an uncertified topology
	// — external OC, non-Linux — never gets the barrier).
	if barrierCertified && get404 {
		last := it.Attempts[len(it.Attempts)-1]
		if last.OCGeneration != 0 && ocGenNow > last.OCGeneration {
			return classRestartBarrier
		}
	}
	// C4 — live-uncertain: everything else (open attempt / written_unknown /
	// accepted_2xx with OC alive, or a barrier that cannot be certified).
	// NEVER auto-redeliver; the ambiguous budget path owns the disposition.
	return classAmbiguous
}

// snapshotCertifyCandidates returns the items the drain loop's recovery pass
// should look at NOW, pacing them via the SAME in-memory per-item throttle
// map the passive reconciler uses (reconcileLast) so the two flows compose
// into ONE bounded lookup cadence per item. Eligibility: custody-claimed
// (ClaimGeneration != 0), correlation-bearing, and in a classify-worthy
// state — `unknown` (recovered) or STALE `dispatching` (aged past the
// threshold; in-flight dispatches are skipped, and the in-flight re-check
// happens again under s.mu at mutation time). ALREADY-TERMINAL items are
// re-opened ONLY where the certified ladder supersedes the passive budget
// without needing the GET verdict first: journal-proven C1/C2 (the probe
// classifier passes ocGen=0/barrier=false/get404=false so only those can
// fire) and barrier-SHAPEABLE C3 (a restart was observed since the last
// attempt inside a certifying topology — the pass's GET then decides; a
// 200 heals to sent instead). A passive-terminalized live-uncertain item
// with NO certified shape keeps its ambiguous terminal (fail-closed).
// Mirrors snapshotReconcileCandidates' shape.
func (s *sessionQueueStore) snapshotCertifyCandidates(now time.Time, ocGen uint64, barrierCertified bool) []reconcileCandidate {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		return nil
	}
	if err := s.load(); err != nil {
		return nil
	}
	if s.reconcileLast == nil {
		s.reconcileLast = map[string]int64{}
	}
	nowMs := now.UnixMilli()
	thresholdMs := int64(currentStaleThreshold() / time.Millisecond)
	var out []reconcileCandidate
	for i := range s.items {
		it := &s.items[i]
		// Unlike the passive gate, server_error items ARE candidates: the
		// loop must resolve them to failed even with no browser polling.
		if it.ClaimGeneration == 0 || it.OpencodeMsgID == "" {
			delete(s.reconcileLast, it.ID)
			continue
		}
		eligible := false
		if it.ReconcileTerminal {
			// The certified ladder SUPERSEDES the passive budget: an item
			// the passive reconciler already terminalized may still be
			// certified-recoverable. Journal-only shapes (C1/C2) re-open
			// unconditionally; barrier-shapeable C3 re-opens when a restart
			// was observed since the last attempt inside a certifying
			// topology (the pass's GET decides the actual verdict). Every
			// other terminal (live-uncertain ambiguous, 400 caller bug,
			// budget-exhausted) stays closed — fail-closed.
			switch classifyCertifiedRedelivery(*it, 0, false, false) {
			case classNeverStarted, classConnectFailed:
				eligible = true
			default:
				if barrierCertified && len(it.Attempts) > 0 {
					last := it.Attempts[len(it.Attempts)-1]
					if last.OCGeneration != 0 && ocGen > last.OCGeneration {
						eligible = true
					}
				}
			}
		} else if it.State == QueueUnknown {
			eligible = true
		} else if it.State == QueueDispatching {
			if it.DispatchStartedAt == 0 || nowMs-it.DispatchStartedAt > thresholdMs {
				eligible = true
			}
		}
		if !eligible {
			delete(s.reconcileLast, it.ID)
			continue
		}
		if last, ok := s.reconcileLast[it.ID]; ok && nowMs-last < thresholdMs {
			continue
		}
		s.reconcileLast[it.ID] = nowMs
		out = append(out, reconcileCandidate{ID: it.ID, Mid: it.OpencodeMsgID})
	}
	return out
}

// certifyItemSnapshot returns the current durable shape of one item for
// classification (nil, false when it left the eligible set — the
// snapshot→GET window can change the world; every mutation re-checks under
// s.mu again anyway).
func (s *sessionQueueStore) certifyItemSnapshot(id string) (QueueItem, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		return QueueItem{}, false
	}
	if err := s.load(); err != nil {
		return QueueItem{}, false
	}
	for i := range s.items {
		if s.items[i].ID == id {
			it := s.items[i]
			if it.State != QueueUnknown && it.State != QueueDispatching {
				return QueueItem{}, false
			}
			return it, true
		}
	}
	return QueueItem{}, false
}

// certifiedRecoveryPass runs ONE bounded classification pass over a session's
// custody-journaled items: for each eligible candidate, run the exact-ID GET
// (the ONLY claim of delivery — invariant 1) and apply the certified ladder.
// It is the drain loop's recovery arm and ALSO covers the no-browser case:
// unlike the passive reconciler (spawned only from queue List traffic), this
// pass drives the ambiguous budget itself (bumpReconcileAttempt), so a
// headless custody daemon still converges items to sent / requeued / failed
// / ambiguous-terminal without any FE poll.
//
// It composes with the passive reconciler by construction: identical
// Resolve/sent idempotence, the shared per-item throttle, and re-checks
// under s.mu at every mutation. Returns errQueueFenced (wrapped) if a
// requeue was rejected by the fence — the drain loop's exit condition.
func (s *Server) certifiedRecoveryPass(root, sid string, tok *QueueCustody, resolve opencodeMessageResolver) error {
	st := s.queues.store(root, sid)
	barrier := custodyBarrierCertified(s.externalOC)
	ocGen := s.ocGeneration()
	for _, c := range st.snapshotCertifyCandidates(time.Now(), ocGen, barrier) {
		it, ok := st.certifyItemSnapshot(c.ID)
		if !ok {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), reconcileLookupTimeout)
		body, gerr := resolve(ctx, sid, c.Mid)
		cancel()
		// The 200-exact-match authority first (overrides every class): if
		// the exact id maps to a persisted user message, the item is SENT.
		if gerr == nil {
			var info reconcileMessageInfo
			if err := json.Unmarshal(body, &info); err == nil &&
				info.Info.Role == "user" && info.Info.ID == c.Mid {
				if _, rerr := st.Resolve(c.ID, QueueSent, reconcileSentDetail); rerr != nil {
					vhlog.Warn("queue certify: Resolve(sent) failed", "sessionID", sid, "messageID", c.Mid, "err", rerr)
				}
				continue
			}
			// Malformed 200 body: fall through — C1/C2 still certify from
			// the journal; the ambiguous path bumps as mismatch-flavored.
		}
		get404 := gerr != nil && errors.Is(gerr, opencode.ErrMessageNotFound)
		switch classifyCertifiedRedelivery(it, ocGen, barrier, get404) {
		case classNeverStarted:
			if err := st.RequeueForCertifiedRedelivery(tok, c.ID, requeueJustificationNeverStarted); err != nil {
				return err
			}
		case classConnectFailed:
			if err := st.RequeueForCertifiedRedelivery(tok, c.ID, requeueJustificationConnectFailed); err != nil {
				return err
			}
		case classRestartBarrier:
			if err := st.RequeueForCertifiedRedelivery(tok, c.ID, requeueJustificationRestartBarrie); err != nil {
				return err
			}
		case classServerErrno:
			// Explicit non-2xx verdict from the journal: terminal failed
			// with the receipt's diagnostic (class 5 — no loop). NOTE the
			// resolve-matrix shape: this fires cleanly while the item is
			// STALE DISPATCHING (dispatching → failed is the normal
			// lifecycle completion). An item already recovered to `unknown`
			// (the crash window between receipt and the inline drain-loop
			// resolve) REJECTS with errQueueResolveConflict — logged, not
			// forced: the terminal-unknown posture keeps the journal
			// evidence and the operator dismissal path, and the inline
			// resolve owns the normal window.
			last := it.Attempts[len(it.Attempts)-1]
			detail := last.Detail
			if detail == "" {
				detail = string(QueueAttemptServerError)
			}
			if _, rerr := st.Resolve(c.ID, QueueFailed, "Dispatch failed: OpenCode rejected the prompt ("+detail+"). [design.md class 5]"); rerr != nil {
				vhlog.Warn("queue certify: server_error resolve rejected (already terminal-unknown; journal evidence retained)", "sessionID", sid, "item", c.ID, "err", rerr)
			}
		case classAmbiguous, classNone:
			// Live-uncertain (or legacy-no-verdict): NEVER auto-POST. Drive
			// the bounded ambiguous budget (the passive flow's exact
			// helpers) so a headless daemon still terminalizes with the
			// marker. A 400 (caller bug) terminalizes immediately,
			// mirroring reconcileOne.
			if gerr != nil && isOpencodeStatus(gerr, http.StatusBadRequest) {
				vhlog.Warn("queue certify: OpenCode rejected message id (400) — caller bug; marking terminal", "sessionID", sid, "messageID", c.Mid, "err", gerr)
				st.markReconcileTerminal(c.ID, reconcileTerminal400Detail)
				continue
			}
			kind := reconcileTerminalTransientDetailFmt
			if get404 {
				kind = reconcileTerminal404DetailFmt
			} else if gerr == nil {
				kind = reconcileTerminalMismatchDetailFmt // 200 non-exact
			}
			st.bumpReconcileAttempt(c.ID, kind, restartFenceTerminalTransientDetailFmt)
		}
	}
	return nil
}

// recordSessionErrorSignal stamps the LATEST session.error text on this
// session's delivery-uncertain items — DETAIL-LEVEL SIGNAL ONLY (the
// projector pin: NamedError.Unknown with human pretty-print text; never a
// classification input, never a state transition, never a redelivery
// authorization). Items in flight or already resolved keep their existing
// detail; only unknown/stale-dispatching items with a correlation id carry
// the signal (the operator reading an uncertain chip sees the upstream
// failure text alongside the journal evidence). The store is per-session,
// so no sid threading is needed.
func (s *sessionQueueStore) recordSessionErrorSignal(text string) {
	if text == "" {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		return
	}
	if err := s.load(); err != nil {
		return
	}
	nowMs := queueNow().UnixMilli()
	thresholdMs := int64(currentStaleThreshold() / time.Millisecond)
	for i := range s.items {
		it := &s.items[i]
		if it.OpencodeMsgID == "" {
			continue
		}
		uncertain := it.State == QueueUnknown ||
			(it.State == QueueDispatching && (it.DispatchStartedAt == 0 || nowMs-it.DispatchStartedAt > thresholdMs))
		if !uncertain {
			continue
		}
		pre := *it // full-value rollback (scalar writes only below)
		it.SessionError = text
		it.SessionErrorAt = nowMs
		if err := s.save(); err != nil {
			*it = pre
			return // disk failed: stop the pass, next signal retries
		}
	}
}

// installQueueSessionErrorSignal arms the session.error → detail-level
// signal subscriber on a's store, once per (dir, aggregator) pair (guarded
// by sessionErrOn, mirroring the queueGCOn lifecycle). On every
// session.error event, the session's delivery-uncertain queue items record
// the error text (recordSessionErrorSignal) — SIGNAL ONLY: per the
// projector pin, the upstream failure branch publishes NamedError.Unknown
// with a human pretty-print (weakly typed), so this text NEVER drives a
// state transition, a classification, or a redelivery. The design's
// original "session.error resolves the item as failed" clause is
// deliberately NOT implemented as automation — the pin's limitation note
// and the operator's binding policy demote it to operator-facing evidence.
//
// Payload: the state pipeline NORMALIZES the wire event — Translate maps
// session.error to NormSessionTerminalError and the reducers' shared
// status-family arm re-emits it as KindStatus ("status") with the RAW wire
// payload (pkg/state/reducers.go), so NO Kind "session.error" ever exists
// on the client-event stream. The subscriber therefore matches the
// NORMALIZED kind and discriminates by payload shape: session.error — and
// ONLY session.error — carries a top-level error OBJECT
// {"sessionID": "...", "error": {name, message, ...}} (sst/opencode
// v1.17.18 SessionHttpApi.promptAsync catchCause), while the sibling
// status-family wire types (session.status / session.idle / session.diff)
// carry {"sessionID", "status": {type}} and never an error object — a
// non-nil parsed error object cannot collide. Only sessionID + a compact
// name/message rendering are consumed.
//
// Lifecycle: identical to installQueueGCCleanup — the goroutine ranges the
// subscriber channel until store.Close() (reload teardown / Shutdown stops
// the aggregator), handleReloadProject resets sessionErrOn[dir], and the
// interest filter drops message-class events (the normalized "status" kind
// is structural, so it flows).
func (s *Server) installQueueSessionErrorSignal(dir string, a *aggregator.Aggregator) {
	s.sessionErrMu.Lock()
	if s.sessionErrOn[dir] {
		s.sessionErrMu.Unlock()
		return
	}
	s.sessionErrOn[dir] = true
	s.sessionErrMu.Unlock()

	root, err := projectRoot(dir)
	if err != nil {
		// Mirror the queue-GC posture: leave the guard set (no per-request
		// retry), log, and rely on nothing worse than a missing detail
		// signal. projectRoot failing is effectively never.
		vhlog.Error("session-error signal subscriber not installed: projectRoot failed", "dir", dir, "err", err)
		return
	}
	ch, _ := a.Store().SubscribeWith(queueGCSubscribeBuffer, state.Interest{MessageSessions: map[string]bool{}})
	if dir != "" {
		s.lifecycleWG.Add(1)
	}
	go func() {
		if dir != "" {
			defer s.lifecycleWG.Done()
		}
		for ev := range ch {
			// D-F1: match the NORMALIZED kind, not the wire kind — the
			// pipeline re-emits session.error as KindStatus ("status").
			if ev.Kind != state.KindStatus {
				continue
			}
			var p struct {
				SessionID string `json:"sessionID"`
				Error     *struct {
					Name    string `json:"name"`
					Message string `json:"message"`
				} `json:"error"`
			}
			// Payload discrimination: a non-nil top-level error object is
			// unique to session.error among the status-family payloads.
			if err := json.Unmarshal(ev.Payload, &p); err != nil || p.SessionID == "" || p.Error == nil {
				continue
			}
			sid := safeID.ReplaceAllString(p.SessionID, "")
			if sid == "" {
				continue
			}
			text := p.Error.Message
			if p.Error.Name != "" {
				text = p.Error.Name + ": " + text
			}
			s.queues.store(root, sid).recordSessionErrorSignal(text)
		}
	}()
}
