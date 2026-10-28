package web

// Pending-chip Send-now escalation — queue-policy-send-now slice B1
// (2026-10-29 amendment §2 "Pending queue chip escalation" + §3 "Escalation
// modeling").
//
// CHOSEN MODEL: (a) cancel + re-admit. An escalation of a PENDING queue item
// removes that item and admits a NEW item — same payload (text, attachments,
// sendConfig), policy "now", a FRESH backend id, order, and admission
// identity — in ONE atomic save behind the custody fence. The amendment
// explicitly blesses either model ("cancel-and-re-admit with policy now, or
// an append-only policy escalation event in the attempt journal"); (a) was
// chosen because:
//
//   - it keeps the policy IMMUTABLE on every admitted item — the new item is
//     born "now"; no journal event can disagree with the stored policy, so
//     the drain loop's single bypass key (the stored policy, H2) stays the
//     ONLY key;
//   - it preserves the original admission's receipt bytes VERBATIM (the
//     receipt log is never touched; the original gesture's custody history
//     stays replayable long after the item is gone);
//   - "exactly one dispatch" falls out of the ordinary single-writer loop —
//     there is exactly one new pending item, and the fingerprint rule
//     (policy joins admission identity) makes the re-admit a DISTINCT
//     admission that can never collapse into the original queue admission.
//
// Model (b) — an append-only journal escalation event authorizing
// now-bypass — was rejected because it would introduce a SECOND bypass
// authority (event ≠ stored policy) that every selection site must consult,
// splitting the "stored policy is the ONLY bypass key" invariant the mission
// fixes for H2.
//
// INVARIANTS (mission bullet 5, all held here):
//   - custody fence: the whole transition runs behind fenceGateLocked — a
//     stale/concurrent-token escalation is rejected by generation
//     (errQueueFenced) before any mutation;
//   - durable: cancel + re-admit persist in ONE atomic save (a crash leaves
//     either both or neither — no window where the message is lost, no
//     window where both items exist);
//   - original receipt bytes intact: s.receipts is never read-for-write
//     here; the original admission (any attemptId/intentId it carried)
//     remains replayable and returns the ORIGINAL item snapshot;
//   - exactly one dispatch: one new pending now-item, claimed once by the
//     custody loop under the same fence as every dispatch.

import (
	"fmt"
)

// escalationProvenanceDetailFmt is stamped as the escalated item's Detail:
// the durable, operator-readable record of WHICH admission the now item
// escalated from (the original item is removed; its receipt — if any — only
// carries the pre-escalation snapshot). %s is the original item id.
const escalationProvenanceDetailFmt = "Send-now escalation of pending queue item %s (operator override consent; cancel + re-admit with dispatchPolicy \"now\" — the amendment's one policy-immutability exception)."

// EscalatePendingToNow transitions a PENDING queue item to immediate-dispatch
// semantics (model (a) above). Requires the policy scheduler active and a
// live custody token (the fence gate stamps the escalation's epoch into the
// same atomic save). Accepted input: a pending item — anything else is
// errQueueNotEscalatable (dispatching is owned by the custody state machine;
// terminal states by the resolve matrix's monotonicity). Escalating an item
// that is ALREADY policy "now" is a successful no-op returning the item
// unchanged (it already has immediate-dispatch semantics; re-admitting would
// churn the admission identity for nothing).
//
// Concurrency: serialized by s.mu; two racing escalations of the same item
// linearize — the winner re-admits (the original id disappears), the loser
// finds no pending item and gets errQueueNotFound. A stale token (generation
// superseded between snapshot and fence) gets errQueueFenced with the store
// untouched.
func (s *sessionQueueStore) EscalatePendingToNow(tok *QueueCustody, itemID string) (QueueItem, error) {
	if !queuePolicySchedulerActive() {
		// The escalation surface is daemon-side: without the policy
		// scheduler there is no now-bypass to escalate INTO (and no custody
		// owner to fence the transition).
		return QueueItem{}, errQueuePolicyUnsupported
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.archived {
		return QueueItem{}, errQueueArchived
	}
	if err := s.fenceGateLocked(tok); err != nil {
		return QueueItem{}, err
	}
	if err := s.load(); err != nil {
		return QueueItem{}, err
	}
	for i := range s.items {
		if s.items[i].ID != itemID {
			continue
		}
		if s.items[i].State != QueuePending {
			return QueueItem{}, fmt.Errorf("%w: item %s state %s", errQueueNotEscalatable, itemID, s.items[i].State)
		}
		if s.items[i].DispatchPolicy == QueueDispatchPolicyNow {
			// Already immediate-dispatch semantics — idempotent no-op.
			return s.items[i], nil
		}
		orig := s.items[i]
		// Cancel + re-admit in ONE atomic save: remove the original at its
		// position, append the now item at the BACK with a fresh order and
		// identity (a NEW admission, never a mutation of the original).
		preItems := s.items
		preOrder := s.order
		newItem := QueueItem{
			ID:             newQueueID(),
			Order:          s.order + 1,
			State:          QueuePending,
			Text:           orig.Text,
			Attachments:    orig.Attachments,
			SendConfig:     orig.SendConfig,
			DispatchPolicy: QueueDispatchPolicyNow,
			// AttemptID/IntentID deliberately NOT copied: the escalation is
			// a fresh admission identity (same payload + different policy
			// fingerprints differently by design — non-collapse).
			Detail:    fmt.Sprintf(escalationProvenanceDetailFmt, orig.ID),
			CreatedAt: queueNow().UnixMilli(),
		}
		candidate := make([]QueueItem, 0, len(preItems))
		candidate = append(candidate, preItems[:i]...)
		candidate = append(candidate, preItems[i+1:]...)
		candidate = append(candidate, newItem)
		s.items = candidate
		s.order = newItem.Order
		if err := s.save(); err != nil {
			// Roll back to the pre-escalation state: neither the cancel nor
			// the re-admit was durably committed.
			s.items = preItems
			s.order = preOrder
			return QueueItem{}, err
		}
		return newItem, nil
	}
	return QueueItem{}, errQueueNotFound
}
