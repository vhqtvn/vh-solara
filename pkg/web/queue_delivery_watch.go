package web

// Early delivery resolution for the backend-authoritative per-session queue.
//
// PROBLEM (2026-10-12 "msg vừa send được vừa kẹt trong queue" report): on
// accepted_2xx the drain loop deliberately leaves the item in `dispatching`
// (the receipt-policy note in queue_drain_loop.go: a 2xx is NEVER durability,
// and an inline resolve would race the ambiguous classes). The ONLY thing
// that resolved the item was the stale-recovery pass — 30s later
// (staleDispatchThreshold) — via the exact-ID GET. So a message that was
// delivered, visible in the transcript, with the assistant already replying,
// still showed "Sending…" on its chip for ~30 seconds.
//
// SOLUTION: the daemon's aggregator ALREADY observes the moment OpenCode
// persists a user message — the same state.Store event (KindMessageUpsert)
// that drives the transcript and the browser's SSE. This watcher subscribes
// to that stream and, when a USER message is persisted under an id that is
// EXACTLY a dispatching queue item's OpencodeMsgID (the claim-minted
// correlation id threaded into prompt_async's messageID body field —
// caller-id-wins), resolves the item to `sent` immediately. This is the SAME
// exact-match authority the stale-recovery reconciler applies
// (queue_msg_reconcile.go invariant 2: exact id + role==="user" ONLY, never
// text/time/position matching) — it just fires at the moment of persistence
// instead of 30s later.
//
// SCOPE DISCIPLINE (what this watcher does NOT do):
//   - It NEVER invokes prompt_async (no re-dispatch; invariant 1 preserved).
//   - It NEVER bumps the reconcile budget, throttles, or terminal markers:
//     a user-message event is POSITIVE delivery evidence, not a lookup that
//     can 404. Items with NO event keep every existing disposition path —
//     the 30s stale pass, the certified ladder, the passive reconciler —
//     byte-identical (the genuinely-ambiguous dispatch classes are untouched).
//   - It resolves ONLY custody-era items (ClaimGeneration != 0) in
//     `dispatching`. The LEGACY browser path (ClaimGeneration==0) resolves
//     its own items immediately after its own 2xx (queue.ts resolveQueued);
//     a watcher resolve racing the browser's would rewrite the terminal
//     detail and manufacture a spurious queue_resolve_conflict 409 on the
//     browser's write. Daemon-era items can never hit that race: the
//     browser's claim/resolve routes are refused (409 queue_custody_active)
//     while the custody loop owns the project.
//   - A requeuePending item (certified redelivery awaiting resume, still
//     `dispatching` under the SAME correlation id) resolves to sent when the
//     ORIGINAL POST's persistence is observed — itemForResume then aborts
//     the resume cleanly (its designed "state changed since classification"
//     path), which SKIPS a needless same-msgid redelivery entirely.
//
// The watcher is idempotent and composes with every concurrent resolver by
// construction: Resolve is mutex-serialized and monotonic (an identical
// re-resolve is a no-op; a raced different-terminal is a logged conflict,
// never a force). It runs on the aggregator's subscriber goroutine, mirrors
// the installQueueSessionErrorSignal lifecycle exactly (one subscriber per
// (dir, aggregator), retired by store.Close, reset by reload teardown), and
// holds NO custody token — the same posture as the passive reconciler, which
// also calls plain Resolve for heal-to-sent.

import (
	"encoding/json"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/state"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// deliveredSentDetail is the terminal detail stamped by the delivery
// watcher. It must stay a CONSTANT: an identical re-resolve (same state +
// same detail) is the resolve matrix's successful no-op, so a repeated event
// for the same message (message.updated refreshes) can never conflict.
const deliveredSentDetail = "Delivered: OpenCode persisted the user message under the queue correlation id (observed on the live event stream); resolved to sent."

// installQueueDeliveryWatcher arms the message-persistence → queue-resolve
// subscriber on a's store, once per (dir, aggregator) pair (guarded by
// queueDeliverOn, mirroring installQueueSessionErrorSignal / the queueGCOn
// lifecycle). Installed from aggFor for the default project AND every
// lazily-created per-dir aggregator; the goroutine exits when the store
// closes its subscriber channels (a.Stop / Shutdown), and handleReloadProject
// resets queueDeliverOn[dir] so the fresh aggregator's store gets a fresh
// watcher.
//
// INTEREST: the zero Interest (MessageSessions == nil) is the firehose — all
// message-class events for every session, like the web layer's ?sessions=all.
// The subscriber loop discards non-KindMessageUpsert frames with a kind
// check before any parsing, so part-delta floods (the highest-rate class)
// cost one channel receive + one string compare each; the JSON parse runs
// only on message.upsert frames, and the registry lookup only for
// role==="user" frames (rare: one per dispatched prompt). emit()'s fanout is
// nonblocking — if this subscriber ever fell behind a flood, the store would
// close+remove it (the designed overload posture) and early resolution would
// silently fall back to the 30s stale-recovery path, never blocking the
// producer.
func (s *Server) installQueueDeliveryWatcher(dir string, a *aggregator.Aggregator) {
	s.queueDeliverMu.Lock()
	if s.queueDeliverOn[dir] {
		s.queueDeliverMu.Unlock()
		return
	}
	s.queueDeliverOn[dir] = true
	s.queueDeliverMu.Unlock()

	root, err := projectRoot(dir)
	if err != nil {
		// Mirror the queue-GC posture: leave the guard set (no per-request
		// retry), log, and degrade to the existing 30s recovery cadence.
		vhlog.Error("queue delivery watcher not installed: projectRoot failed", "dir", dir, "err", err)
		return
	}
	ch, _ := a.Store().SubscribeWith(queueGCSubscribeBuffer, state.Interest{})
	if dir != "" {
		s.lifecycleWG.Add(1)
	}
	go func() {
		if dir != "" {
			defer s.lifecycleWG.Done()
		}
		for ev := range ch {
			if ev.Kind != state.KindMessageUpsert {
				continue
			}
			// The payload IS the opencode message info blob (reducers.go
			// emits sm.byID[id].info): top-level id / sessionID / role.
			var p struct {
				ID        string `json:"id"`
				SessionID string `json:"sessionID"`
				Role      string `json:"role"`
			}
			if json.Unmarshal(ev.Payload, &p) != nil || p.ID == "" {
				continue
			}
			if p.Role != "user" {
				continue // exact-match authority: a USER message only
			}
			sid := safeID.ReplaceAllString(p.SessionID, "")
			if sid == "" {
				continue
			}
			s.queues.resolveDeliveredUnderRoot(root, sid, p.ID)
		}
		vhlog.Debug("queue delivery watcher: subscriber channel closed; early resolution falls back to the stale-recovery path", "dir", dir)
	}()
}

// resolveDeliveredUnderRoot looks up the (root, sid) queue store WITHOUT
// materializing one (a registry lookup, not store()) — a user-message event
// for a session that never had a queue must not grow the registry — and
// applies the exact-id delivery resolution when that session has a matching
// dispatching item.
func (qr *queueRegistry) resolveDeliveredUnderRoot(root, sid, msgID string) {
	st := qr.lookup(root, sid)
	if st == nil {
		return
	}
	st.resolveDeliveredByMsgID(msgID)
}

// lookup returns the registered store for (root, sessionID) or nil — the
// read-only twin of store(): no lazy creation, so event-driven resolution
// never materializes registry entries for queue-less sessions.
func (qr *queueRegistry) lookup(root, sessionID string) *sessionQueueStore {
	qr.mu.Lock()
	defer qr.mu.Unlock()
	return qr.stores[storeKey(root, sessionID)]
}

// resolveDeliveredByMsgID resolves the dispatching custody-era item whose
// OpencodeMsgID EXACTLY equals msgID to terminal `sent` (the normal
// lifecycle-completion edge of the resolve matrix). Anything else — no match,
// a pending item, a legacy-era claim, an already-terminal item — is a silent
// no-op: the event proves nothing about those, and their existing
// disposition paths (drain loop, stale recovery, passive reconciler) own
// them. The scan runs under s.mu; the Resolve itself runs AFTER releasing it
// (Resolve re-acquires and re-checks, so a drain-loop transition racing this
// call composes as the matrix defines — identical no-op, or a logged
// conflict that changes nothing).
func (s *sessionQueueStore) resolveDeliveredByMsgID(msgID string) {
	if msgID == "" {
		return
	}
	s.mu.Lock()
	if s.archived {
		s.mu.Unlock()
		return
	}
	if err := s.load(); err != nil {
		s.mu.Unlock()
		return
	}
	var itemID string
	for i := range s.items {
		it := &s.items[i]
		if it.OpencodeMsgID == msgID && it.State == QueueDispatching && it.ClaimGeneration != 0 {
			itemID = it.ID
			break
		}
	}
	s.mu.Unlock()
	if itemID == "" {
		return
	}
	if _, err := s.Resolve(itemID, QueueSent, deliveredSentDetail); err != nil {
		// A raced terminal transition (the drain loop's server_error inline
		// resolve, or a recovery pass that got there first). The matrix keeps
		// the first terminal; surface, never force.
		vhlog.Warn("queue delivery watcher: resolve rejected (item already transitioned)", "item", itemID, "messageID", msgID, "err", err)
	}
}
