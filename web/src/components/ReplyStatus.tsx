import { Show } from "solid-js";
// Side-effect import: all classes are :global (unit + e2e query them).
import "./ReplyStatus.module.css";

// ReplyStatus — the shared honest-lifecycle surface for the pending-input
// cards (PermissionCard / QuestionCard), send-net-resilience slice 4a.
//
// The card that owns a reply gesture renders one of three states:
//   sending — the reply is in flight; actions are single-flighted.
//   unknown — no confirmation arrived (timeout / network / 5xx / in-flight
//             duplicate). The reply MAY have been applied upstream, so this
//             is never worded as failure; the explicit Retry re-sends the
//             same answer (safe: upstream replies are single-shot — a retry
//             can never double-apply; it either lands or comes back gone).
//   gone    — the request is no longer pending upstream (410 Gone / the
//             shutdown-404 shape; the two are indistinguishable from here).
//             A VISIBLE terminal that is never styled or worded as success:
//             "no longer pending — the outcome was not confirmed". Dismiss
//             clears the dead card; no retry is offered because the request
//             itself is gone.
//
// Purely presentational: the owning card drives the status and supplies the
// retry/dismiss handlers, so both the inline surface and the popup mirror
// (shared body()) stay synchronized through the card's own signals.
export default function ReplyStatus(props: {
  status: "sending" | "unknown" | "gone";
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  return (
    <div class={`reply-status ${props.status}`} role="status">
      <Show when={props.status === "sending"}>
        <span class="reply-status-text">Sending reply…</span>
      </Show>
      <Show when={props.status === "unknown"}>
        <span class="reply-status-text">
          Reply not confirmed — it may still have been applied. Retrying is
          safe and cannot double-apply.
        </span>
        <button type="button" class="reply-retry" onClick={() => props.onRetry?.()}>
          Retry
        </button>
      </Show>
      <Show when={props.status === "gone"}>
        <span class="reply-status-text">
          This reply is no longer pending — the outcome was not confirmed.
        </span>
        <button
          type="button"
          class="reply-dismiss"
          onClick={() => props.onDismiss?.()}
        >
          Dismiss
        </button>
      </Show>
    </div>
  );
}
