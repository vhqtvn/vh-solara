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
// that resending may duplicate work. We surface it VISIBLELY — not only in the
// data-tip tooltip — so the operator sees the duplicate-risk warning at a
// glance. No resend/retry button is ever rendered for terminal items (recovery
// means the operator creates a NEW message, never reviving this one).
//
// Dismissal (FIX-QUEUE-GC-4): the remove (x) button is shown for `pending`
// (cancel before dispatch) and for terminal `failed`/`unknown` (explicit
// operator dismissal — clears the chip from view). It is NEVER shown for
// `dispatching` (the dispatch may be in flight; the state machine must own the
// transition to terminal first). `sent` is filtered from the visible queue
// upstream (queueFor), so no dismiss surface is needed for it. The same button
// + label ("Remove queued message") is used for all dismissable states — the
// operator's intent is the same ("clear this chip") regardless of state.
export function QueueChip(props: {
  q: QueuedMessage;
  sessionId: string;
  onRemove: (id: string) => void;
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
        <Show when={props.q.state === "pending" || props.q.state === "failed" || props.q.state === "unknown"}>
          <button
            type="button"
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
