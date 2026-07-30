import { Show } from "solid-js";
import { type QueuedMessage } from "../queue";
import Icon from "./Icon";

// QueueChip renders a single queued-message pill in the composer's queue row,
// plus — for recovered `unknown` items — a visible detail note.
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
//   - `failed`     → retract (restore the text to the composer to edit + re-send
//                    as a NEW message; the old item is deleted first and NEVER
//                    repends) + dismiss (discard outright).
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
// The three actions are visually + aria distinguished (retract = edit, mark-
// sent = check, dismiss = x) so they are never one ambiguous "x". No
// resend/retry affordance is ever rendered: recovery means the operator
// composes a NEW message (retract) or acknowledges an already-sent one
// (mark-sent), never reviving this item.
export function QueueChip(props: {
  q: QueuedMessage;
  // Dismiss: clear the chip from view (pending cancel or terminal dismissal).
  onRemove: (id: string) => void;
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
      return q.detail
        ? `${q.state === "failed" ? "Failed" : "Interrupted"}: ${q.detail}`
        : q.state === "failed"
          ? "Failed to send"
          : "Send was interrupted";
    }
    if (q.state === "dispatching") return "Sending…";
    return q.text;
  };
  const label = (): string => {
    const q = props.q;
    if (q.state === "dispatching") return "Sending…";
    if (q.state === "failed") return "Failed";
    if (q.state === "unknown") return "Unknown";
    return "";
  };
  return (
    <>
      <span class="queue-chip" data-state={props.q.state} data-tip={tip()}>
        <Show when={label()}>
          <span class="queue-state">{label()}</span>
        </Show>
        <span class="queue-text">{props.q.text || "(attachment)"}</span>
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
      {/* Recovered `unknown` items: surface the backend Detail (the
          duplicate-risk warning) visibly — not only in the data-tip tooltip —
          so the operator understands why the item is in an ambiguous state. */}
      <Show when={props.q.state === "unknown" && props.q.detail}>
        <span class="queue-detail-note">{props.q.detail}</span>
      </Show>
    </>
  );
}

export default QueueChip;
