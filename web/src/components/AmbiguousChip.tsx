// AmbiguousChip — the durable live-uncertain queue chip (send-net-resilience
// slice 3, debate-4 B1 / debate-3 BLK-A2). Renders for queue items carrying
// the daemon's `ambiguousDelivery` marker: the message may or may not have
// arrived, it is NEVER auto-redelivered, and the operator gets exactly three
// actions behind the BINDING verbatim warning:
//
//   Wait            — collapse the actions; the chip STAYS (the operator
//                     chooses to wait for the reconciler; the chip re-expands
//                     on demand so the actions are never lost).
//   Copy text       — clipboard + an inline "Copied" confirmation.
//   Send new message— the one-tap replacement: a NEW gesture (new intentId,
//                     context-head recaptured at tap) after an explicit
//                     stale-context check; the OLD item is marked
//                     ambiguous_replacement_requested (rendered as
//                     "Replacement requested"). If the original arrives later,
//                     BOTH messages display truthfully.
//
// The warning text is VERBATIM per the binding contract — do not reword:
// "We could not confirm whether this message arrived. Send a new message may
//  result in both messages being processed if the original arrives later. The
//  original cannot be cancelled."
//
// CSS: co-located AmbiguousChip.module.css (scoped classes; consumes global
// tokens only — no new global CSS). Sits inside the composer's .queue-row.
import { createSignal, Show } from "solid-js";
import type { QueuedMessage } from "../queue";
import Icon from "./Icon";
import styles from "./AmbiguousChip.module.css";

export function AmbiguousChip(props: {
  q: QueuedMessage;
  // First tap of "Send new message" — the controller's eligibility + stale
  // gate. "confirmed" → the chip fires onReplace immediately; "stale-confirm"
  // → the chip renders its INLINE visible confirmation first (the replacement
  // only sends from the explicit second tap); "refused" → nothing (the
  // controller already notified).
  onTap: (q: QueuedMessage) => Promise<"confirmed" | "stale-confirm" | "refused">;
  // Replacement send (the one-tap new gesture). The handler owns minting the
  // new intentId, the outbox save, the stale-context re-verification, and
  // marking this item ambiguous_replacement_requested.
  onReplace: (q: QueuedMessage) => void;
  // True once a replacement was requested for this gesture (the outbox
  // overlay keyed by the item's intentId) — renders the subdued
  // "Replacement requested" state.
  replacementRequested: () => boolean;
  // Dismiss (explicit chip removal — the same DELETE every terminal chip
  // offers; FIX-QUEUE-GC-4). Distinct from Wait: Wait keeps the chip.
  onRemove: (id: string) => void;
}) {
  const [waiting, setWaiting] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  // Inline stale-context confirmation state (debate-4 finding 7, amended
  // 2026-10-09: a VISIBLE confirmation must precede the replacement when the
  // conversation moved on since the original gesture's captured context-head).
  const [staleConfirm, setStaleConfirm] = createSignal(false);

  const tapReplace = async () => {
    const verdict = await props.onTap(props.q);
    if (verdict === "confirmed") {
      setStaleConfirm(false);
      props.onReplace(props.q);
    } else if (verdict === "stale-confirm") {
      setStaleConfirm(true);
    }
    // "refused": the controller already surfaced the notice — chip unchanged.
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(props.q.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* clipboard unavailable (permissions/iframe) — the chip's visible text
         remains selectable as the manual fallback; never pretend it copied. */
    }
  };

  return (
    <span
      class={styles.ambiguousChip}
      data-state={props.replacementRequested() ? "replacement-requested" : waiting() ? "waiting" : "active"}
      data-testid="ambiguous-chip"
    >
      <span class={styles.state}>
        {props.replacementRequested() ? "Delivery unconfirmed — replacement requested" : "Delivery unconfirmed"}
      </span>
      <span class={styles.text}>{props.q.text || "(attachment)"}</span>
      <Show
        when={!props.replacementRequested() && !waiting()}
        fallback={
          /* Waiting / replaced: the chip stays subdued. While merely waiting,
         re-expand on demand so the three actions are never lost. */
          <Show when={!props.replacementRequested()}>
            <button
              type="button"
              class={styles.act}
              aria-label="Review this unconfirmed delivery"
              data-tip="Show the delivery options again"
              onClick={() => setWaiting(false)}
            >
              <Icon name="retry" size={11} />
            </button>
          </Show>
        }
      >
        {/* The BINDING warning text — VERBATIM (debate-4 B1). Precedes the
            replacement action; always rendered while the actions are shown. */}
        <span class={styles.warning} data-testid="ambiguous-warning">
          We could not confirm whether this message arrived. Send a new message may result in both
          messages being processed if the original arrives later. The original cannot be cancelled.
        </span>
        <button
          type="button"
          class={styles.act}
          data-testid="ambiguous-wait"
          aria-label="Wait — keep this message and check the transcript later"
          onClick={() => setWaiting(true)}
        >
          Wait
        </button>
        <button
          type="button"
          class={styles.act}
          data-testid="ambiguous-copy"
          aria-label="Copy this message text"
          onClick={() => void copyText()}
        >
          {copied() ? "Copied" : "Copy text"}
        </button>
        <Show
          when={staleConfirm()}
          fallback={
            <button
              type="button"
              class={styles.act}
              classList={{ [styles.replace]: true }}
              data-testid="ambiguous-replace"
              aria-label="Send new message — may result in both messages being processed if the original arrives later"
              onClick={() => void tapReplace()}
            >
              Send new message
            </button>
          }
        >
          {/* The visible stale-context confirmation (the conversation moved
              on since the original gesture was sent): the replacement only
              fires from this explicit second tap. */}
          <span class={styles.stale} data-testid="ambiguous-stale-confirm">
            The conversation moved on since this message was sent.
          </span>
          <button
            type="button"
            class={styles.act}
            classList={{ [styles.replace]: true }}
            data-testid="ambiguous-replace-anyway"
            onClick={() => {
              setStaleConfirm(false);
              props.onReplace(props.q);
            }}
          >
            Send anyway
          </button>
          <button
            type="button"
            class={styles.act}
            data-testid="ambiguous-stale-cancel"
            onClick={() => setStaleConfirm(false)}
          >
            Cancel
          </button>
        </Show>
      </Show>
      <button
        type="button"
        class={styles.act}
        data-testid="ambiguous-dismiss"
        aria-label="Remove unconfirmed message chip"
        onClick={() => props.onRemove(props.q.id)}
      >
        <Icon name="x" size={11} />
      </button>
    </span>
  );
}

export default AmbiguousChip;
