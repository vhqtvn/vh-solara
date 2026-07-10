import { createSignal, onMount, Show } from "solid-js";
import { state } from "../sync";
import Icon from "./Icon";
import styles from "./SessionTimingBlock.module.css";

// Copy-friendly cold-open timing for the inspected session. The connLatency
// store reflects the ACTIVE session stream — and SessionInspector is only ever
// opened for the selected (active) session (App gates it on selectedId()), so
// state.connLatency.session here IS the inspected session's timing. Renders a
// real selectable <pre> (the operator pastes these numbers into a bug report),
// the session id, a captured-at timestamp, and a one-click Copy.
const ms = (v: number | undefined): string => (typeof v === "number" ? `${v} ms` : "—");

export default function SessionTimingBlock(props: { sessionId: string }) {
  const [copied, setCopied] = createSignal(false);

  // Stamp the moment the operator opened the inspector — the "when" that
  // travels with a copied snapshot into a bug report. Fixed for this open.
  const [capturedAt, setCapturedAt] = createSignal("");
  onMount(() => setCapturedAt(new Date().toISOString()));

  // The full text put into the clipboard + available for manual selection.
  const text = () => {
    const t = state.connLatency.tree;
    const s = state.connLatency.session;
    const hydrate = typeof s.hydrate === "number" ? `${s.hydrate} ms` : s.hydrate === "warm" ? '"warm"' : "—";
    return [
      `session: ${props.sessionId}`,
      `captured: ${capturedAt()}`,
      `tree.open:    ${ms(t.open)}    # Stream 1 onopen->first event`,
      `tree.snap:    ${ms(t.snap)}    # Stream 1 onopen->first snapshot`,
      `session.open: ${ms(s.open)}    # Stream 2 onopen->first event`,
      `session.snap: ${ms(s.snap)}    # Stream 2 onopen->first snapshot`,
      `hydrate:      ${hydrate}    # first snapshot->messages.loaded (cold stall; "warm" = instant)`,
      `fetchMs:      ${ms(s.fetchMs)}    # hydrate split: upstream OpenCode GET round-trip`,
      `reconcileMs:  ${ms(s.reconcileMs)}    # hydrate split: daemon SetSessionMessages`,
    ].join("\n");
  };

  async function copy() {
    try {
      await navigator.clipboard.writeText(text());
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked (no focus / permissions) — selection still works */
    }
  }

  return (
    <div class={styles.wrap}>
      <div class={styles.head}>
        <span class={styles.label}>Cold-open timing</span>
        <button type="button" class={styles.copy} onClick={copy} aria-label="Copy timing">
          <Icon name={copied() ? "check" : "copy"} size={13} />
          <span>{copied() ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre class={styles.pre} aria-label="Session cold-open timing">
        {text()}
      </pre>
      <p class={styles.note}>
        <Show when={state.connLatency.session.hydrate === "warm"} fallback="Cold session: numbers above are this session's open latency. Paste into a bug report with the session id + captured time.">
          Warm session: first snapshot already had messages loaded (no fetch), so hydrate is instant by design.
        </Show>
      </p>
    </div>
  );
}
