import { Show } from "solid-js";
import { type QueuedMessage } from "../queue";
import Icon from "./Icon";

// QueueChip renders a single queued-message pill in the composer's queue row,
// plus — for terminal `failed`/`unknown` items with a detail — a visible
// cause note (see the O2 single-owner note at the note's render site below).
//
// Extracted from ChatView (FIX-QUEUE-STUCK-2) so the terminal-state detail
// surfacing is unit-testable in isolation (ChatView pulls in ~15 stateful
// modules; mounting it whole for a rendering test is impractical). Behavior is
// identical to the former inline `<For>` body.
//
// Recovery detail: an `unknown` item whose dispatch was interrupted
// (stale-dispatch recovery in pkg/web/queue.go: recoverStaleDispatchingLocked)
// carries a backend-set `detail` explaining the ambiguous state and warning
// that resending may duplicate work. We surface it VISIBLELY — not only in
// the data-tip tooltip — so the operator sees the duplicate-risk warning at a
// glance.
//
// Recovery affordances (Bug 1 / Bug 2): terminal `failed`/`unknown` chips no
// longer offer ONLY a dismiss "x". Each state gets explicit, accessible
// actions so the operator can RECOVER a misclassified/timed-out send instead
// of being forced to cancel + re-type (the original DUPLICATE story):
//   - `unknown` with a retained claim-minted opencodeMsgID
//                 → RETRY (slice 3, intent recovery): re-sends the IDENTICAL
//                   payload under the SAME messageID — caller-id-wins on
//                   opencode ≥ 1.17.18, so no duplicate persists if the first
//                   dispatch landed. Explicit user action only; NEVER
//                   automatic (no timer/loop anywhere). UNKNOWN-ONLY: the
//                   queue resolve matrix allows exactly unknown→sent, so this
//                   is the one state whose retry success can be recorded.
//   - `failed`     → retract (restore the text to the composer to edit + re-send
//                    as a NEW message; the old item is deleted first and NEVER
//                    repends) + dismiss (discard outright). NO retry: `failed`
//                    proves non-delivery (nothing to idempotently revive) and
//                    the resolve matrix REJECTS failed→sent — a retry that
//                    succeeded could never be recorded.
//   - `unknown`    → mark-sent ("I can see it in the transcript" — resolves the
//                    item to terminal `sent`, the only auto-clear state, via the
//                    existing resolve op; NEVER enqueues or dispatches) + retract
//                    (carries a DUPLICATE-RISK warning because unknown may have
//                    already landed → re-sending can duplicate) + dismiss.
//   - `dispatching`→ NO action (the dispatch may be in flight; the backend
//                    rejects DELETE with 409 — the state machine must own the
//                    transition to terminal first).
//   - `pending`    → dismiss (cancel before dispatch), unchanged.
//   - `sent`       → hidden upstream (queueFor filters it); no chip renders.
// The actions are visually + aria distinguished (retry = circular arrow,
// retract = edit, mark-sent = check, dismiss = x) so they are never one
// ambiguous "x". The retry is the ONLY affordance that revives THIS item —
// and only on an `unknown` chip (the resolve matrix's allowed unknown→sent
// edge is what makes revival recordable) because the same-messageID resend
// is idempotent on opencode ≥ 1.17.18; every other recovery composes a NEW
// message (retract) or acknowledges an already-sent one (mark-sent). Items
// WITHOUT an opencodeMsgID (legacy, pre-correlation-id) get NO retry —
// their honest recovery remains retract with its duplicate-risk warning.
export function QueueChip(props: {
  q: QueuedMessage;
  // Dismiss: clear the chip from view (pending cancel or terminal dismissal).
  onRemove: (id: string) => void;
  // Retry (slice 3, intent recovery): re-send this exact message under its
  // original messageID (idempotent on opencode ≥ 1.17.18). UNKNOWN-state
  // items only (the resolve matrix allows exactly unknown→sent); the handler
  // revalidates at click time and refuses loudly otherwise.
  onRetry?: (q: QueuedMessage) => void;
  // Retract: pull this message's text back into the composer to edit + re-send
  // as a NEW message. Only meaningful for terminal `failed`/`unknown`; the
  // handler confirms the DELETE before touching the composer and never repends.
  onRetract?: (q: QueuedMessage) => void;
  // Mark-sent: resolve this `unknown` item to terminal `sent` (the operator
  // confirms they can see the corresponding user message in the transcript).
  // Only meaningful for `unknown`; reuses the existing resolve op and NEVER
  // enqueues or dispatches.
  onMarkSent?: (q: QueuedMessage) => void;
}) {
  const tip = (): string => {
    const q = props.q;
    if (q.state === "failed" || q.state === "unknown") {
      // Send-reliability slice 3: honest outcome copy. `unknown` is NOT
      // "interrupted" (which reads as "didn't send") — the outcome is UNKNOWN:
      // the dispatch may have been delivered, so the operator is told to check
      // the transcript before doing anything that could duplicate it.
      return q.detail
        ? `${q.state === "failed" ? "Failed" : "Outcome unknown"}: ${q.detail}`
        : q.state === "failed"
          ? "Failed to send"
          : "Send outcome unknown — it may have been delivered; check the transcript before resending";
    }
    if (q.state === "dispatching") return "Sending…";
    return q.text;
  };
  const label = (): string => {
    const q = props.q;
    if (q.state === "dispatching") return "Sending…";
    if (q.state === "failed") return "Failed";
    if (q.state === "unknown") return "Outcome unknown";
    return "";
  };
  return (
    <>
      <span class="queue-chip" data-state={props.q.state} data-tip={tip()}>
        <Show when={label()}>
          <span class="queue-state">{label()}</span>
        </Show>
        <span class="queue-text">{props.q.text || "(attachment)"}</span>
        {/* Retry (slice 3, intent recovery — 2026-10-03 incident): explicit,
            user-driven re-send of an OUTCOME-UNKNOWN item that retained its
            claim-minted opencodeMsgID. UNKNOWN-ONLY by design (review
            t1b-F1/t1d-F1): `unknown` is the one state where a resend is both
            honest (delivery was never disproven) and recordable (the queue
            resolve matrix allows exactly unknown→sent; failed→sent is
            REJECTED, so a `failed` item whose retry re-POST SUCCEEDED could
            never record it and the chip would re-render failed with a stale
            detail for a message that just landed). A `failed` item's honest
            recovery stays retract-to-compose (its copy already says nothing
            was delivered). The handler (createSend.retryQueuedItem) re-POSTs
            the IDENTICAL payload under the SAME messageID — idempotent on
            opencode ≥ 1.17.18 — and records the outcome. The data-tip
            carries the honest version boundary (one line, per the slice
            contract: no dialog). Not rendered without an opencodeMsgID
            (legacy items) or when the handler is unwired. */}
        <Show when={props.q.state === "unknown" && props.q.opencodeMsgID && props.onRetry}>
          <button
            type="button"
            class="queue-action queue-retry"
            aria-label="Retry send — re-sends this exact message; no duplicate if it already landed"
            data-tip="Retry send — re-sends this exact message under the same message ID. No duplicate on OpenCode ≥ 1.17.18; older OpenCode may duplicate."
            onClick={() => props.onRetry?.(props.q)}
          >
            <Icon name="retry" size={11} />
          </button>
        </Show>
        {/* Mark-sent (unknown only): resolve to terminal `sent`. The guidance
            copy tells the operator to only use it when they can see this
            message sent in the transcript (the confirmation contract). Distinct
            aria-label + data-tip so screen readers announce it unambiguously. */}
        <Show when={props.q.state === "unknown" && props.onMarkSent}>
          <button
            type="button"
            class="queue-action queue-mark-sent"
            aria-label="Mark sent — only if you can see this message in the transcript"
            data-tip="Mark sent — only use this if you can see this message sent in the transcript"
            onClick={() => props.onMarkSent!(props.q)}
          >
            <Icon name="check" size={11} />
          </button>
        </Show>
        {/* Retract (failed/unknown): restore the text to the composer to edit +
            re-send as a NEW message. For `unknown` the dispatch may already have
            landed, so the warning copy flags the duplicate risk before the
            operator re-sends. Never shown for `dispatching` (non-removable) or
            `pending` (cancel/dismiss is the right affordance there). */}
        <Show when={(props.q.state === "failed" || props.q.state === "unknown") && props.onRetract}>
          <button
            type="button"
            class="queue-action queue-retract"
            aria-label={
              props.q.state === "unknown"
                ? "Edit again — warning: this may have sent; sending it again can create a duplicate"
                : "Edit again (restore to composer)"
            }
            data-tip={
              props.q.state === "unknown"
                ? "Edit again — this message may have already sent; sending it again can create a duplicate"
                : "Edit again (restore to composer)"
            }
            onClick={() => props.onRetract!(props.q)}
          >
            <Icon name="edit" size={11} />
          </button>
        </Show>
        {/* Dismiss: clear the chip from view. pending (cancel before dispatch)
            and terminal failed/unknown (explicit dismissal — FIX-QUEUE-GC-4).
            Never for dispatching. Distinct from retract: dismiss discards the
            message outright; retract pulls its text back into the composer. */}
        <Show when={props.q.state === "pending" || props.q.state === "failed" || props.q.state === "unknown"}>
          <button
            type="button"
            class="queue-action queue-dismiss"
            aria-label="Remove queued message"
            onClick={() => props.onRemove(props.q.id)}
          >
            <Icon name="x" size={11} />
          </button>
        </Show>
      </span>
      {/* Terminal dispatch outcomes — O2 single-owner rule: the chip is the
          ONE persistent owner of a dispatch outcome, so its cause is rendered
          VISIBLY (not tooltip-only). This visibility is the precondition for
          suppressing the covered notification-history entries ("Queued
          message failed to send" / "…send outcome unknown" / "…send timed
          out") — removing them any earlier would leave the cause homeless.
          `unknown` additionally carries the standing check-transcript
          instruction (the dispatch may have been delivered); a reconcile
          give-up (reconcileTerminal) already ships its own "manual review
          advised" detail, so the suffix is skipped there. */}
      <Show when={(props.q.state === "unknown" || props.q.state === "failed") && props.q.detail}>
        <span class="queue-detail-note">
          {props.q.detail}
          <Show when={props.q.state === "unknown" && !props.q.reconcileTerminal}>
            {" — it may have been delivered; check the transcript before sending it again"}
          </Show>
        </span>
      </Show>
    </>
  );
}

export default QueueChip;
