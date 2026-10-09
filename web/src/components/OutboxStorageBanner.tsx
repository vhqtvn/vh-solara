// OutboxStorageBanner — the BLK-A3 BLOCKING persistent "not saved — copy your
// text" state (send-net-resilience slice 3). Rendered by ChatView above the
// composer whenever the outbox module's storageFailure() is armed: a send
// gesture's IndexedDB save failed (storage unavailable / quota / eviction /
// cleared store), so the gesture was blocked BEFORE admission and the
// composed text is retained in memory (the composer still holds it).
//
// PERSISTENT by contract: the banner stays until storage recovers (a
// successful "Try saving again" re-commit) — never a toast. The Copy action
// copies the EXACT retained payload (what would have been sent), which may
// differ from the composer's current text if the operator typed after Send.
//
// Also renders the honest eviction notice variant: the boot-time marker said
// records existed but the durable store reads empty — locally saved unsent
// gestures were cleared by the browser (the texts are unrecoverable; the
// operator must know rather than wonder).
import { createSignal, Show } from "solid-js";
import { evictionSuspected, retryFailedSave, storageFailure } from "../lib/outbox";
import styles from "./OutboxStorageBanner.module.css";

export function OutboxStorageBanner() {
  const [retrying, setRetrying] = createSignal(false);
  const [copied, setCopied] = createSignal(false);
  const failure = () => storageFailure();

  const copy = async () => {
    const f = failure();
    if (!f) return;
    try {
      await navigator.clipboard.writeText(f.payload.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    } catch {
      /* clipboard unavailable — the composer's retained text remains the
         manual fallback; never claim a copy that did not happen */
    }
  };

  const retry = async () => {
    setRetrying(true);
    try {
      await retryFailedSave();
    } finally {
      setRetrying(false);
    }
  };

  return (
    <Show when={failure() || evictionSuspected()}>
      <div class={styles.banner} role="alert" data-testid="outbox-storage-banner">
        <Show when={failure()}>
          <span class={styles.text} data-testid="outbox-storage-failure">
            {/* BLK-A3 contract string — "not saved — copy your text" (keep the
                exact phrase; the rest is the honest detail). */}
            <strong>Not saved — copy your text.</strong> Message storage is unavailable
            ({failure()!.reason.slice(0, 120)}), so this message was not queued. Your text is kept
            in the composer, but it will be lost if this tab closes.
          </span>
          <button type="button" class={styles.btn} onClick={() => void copy()}>
            {copied() ? "Copied" : "Copy text"}
          </button>
          <button
            type="button"
            class={styles.btn}
            disabled={retrying()}
            onClick={() => void retry()}
          >
            {retrying() ? "Saving…" : "Try saving again"}
          </button>
        </Show>
        <Show when={!failure() && evictionSuspected()}>
          <span class={styles.text}>
            <strong>Locally saved messages were cleared.</strong> The browser removed this app's
            local message storage; any unsent messages it held could not be recovered. Queued
            messages on the server are unaffected.
          </span>
        </Show>
      </div>
    </Show>
  );
}

export default OutboxStorageBanner;
