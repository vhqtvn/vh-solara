import { createMemo, For, onCleanup, onMount, Show } from "solid-js";
import {
  diagEntries,
  diagLogEnabled,
  MAX_DIAG_AGE_MS,
  MAX_DIAG_ENTRIES,
  setDiagLogOn,
  type DiagEntry,
} from "../sync/diaglog";
import { projectDir } from "../sync";
import Icon from "./Icon";
import styles from "./DiagLogDialog.module.css";

// Hidden diagnostic log viewer: a bounded, default-OFF ring buffer of FE timing
// entries, surfaced from the server-admin menu (right-click / long-press the
// Settings button). Lets the operator select/copy one or all entries. The caps
// and the default-off toggle are shown in-app so the "must not log too much"
// guarantee is visible, not magic.
const ms = (v: number | undefined): string => (typeof v === "number" ? `${v}` : "—");
const iso = (ts: number): string => {
  try {
    return new Date(ts).toISOString();
  } catch {
    return String(ts);
  }
};

// One entry -> a single copy-friendly line. `switch (kind)` is the extension
// point: a new entry kind adds a case here. With a single union member TS knows
// the switch is exhaustive; adding a kind makes it non-exhaustive → compile
// error nudges the renderer to grow alongside the type (no runtime guard needed).
function entryLine(e: DiagEntry): string {
  switch (e.kind) {
    case "cold-open":
      return `${iso(e.ts)} cold-open sess=${e.sessionId} open=${ms(e.open)} snap=${ms(e.snap)} hydrate=${ms(e.hydrate)} fetch=${ms(e.fetchMs)} recon=${ms(e.reconcileMs)}`;
  }
}

const mins = (msVal: number) => `${Math.round(msVal / 60000)} min`;

export default function DiagLogDialog(props: { onClose: () => void }) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  // Newest first for scanning (the buffer stores newest last).
  const list = createMemo(() => [...diagEntries()].reverse());
  const allText = () => list().map(entryLine).join("\n");

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(allText() || "(no entries)");
    } catch {
      /* selection still works */
    }
  }

  return (
    <div class="dialog-overlay" onClick={props.onClose}>
      <div class="dialog" role="dialog" aria-label="Diagnostic log" onClick={(e) => e.stopPropagation()}>
        <div class="dialog-head">
          <span class="dialog-title">Diagnostic log</span>
          <button type="button" class="icon-btn" aria-label="Close" onClick={props.onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div class="dialog-body">
          <div class={styles.dir}>
            <Icon name="sidebar" size={12} />
            <code>{projectDir() || "(default project)"}</code>
          </div>

          <label class={styles.toggle}>
            <input
              type="checkbox"
              checked={diagLogEnabled()}
              onChange={(e) => setDiagLogOn(e.currentTarget.checked)}
            />
            <span>Capture cold-open timing</span>
          </label>
          <p class={styles.help}>
            Off by default. When off, nothing is recorded. When on, each cold session open appends one
            entry (session id + timestamp + open/snap/hydrate/fetchMs/reconcileMs). Older entries age
            out automatically.
          </p>

          <div class={styles.caps}>
            <span>max age {mins(MAX_DIAG_AGE_MS)}</span>
            <span>·</span>
            <span>max {MAX_DIAG_ENTRIES} entries</span>
            <span>·</span>
            <Show when={diagLogEnabled()} fallback={<span class={styles.off}>OFF</span>}>
              <span class={styles.on}>ON</span>
            </Show>
          </div>

          <div class={styles.listHead}>
            <span class={styles.listCount}>{list().length} entry{list().length === 1 ? "" : "ies"}</span>
            <Show when={list().length > 0}>
              <button type="button" class={styles.copyAll} onClick={copyAll}>
                <Icon name="copy" size={13} /> Copy all
              </button>
            </Show>
          </div>

          <Show
            when={list().length > 0}
            fallback={<div class={styles.empty}>No entries yet. Open a cold session with capture on.</div>}
          >
            <pre class={styles.list} aria-label="Diagnostic entries">
              {allText()}
            </pre>
          </Show>
        </div>
      </div>
    </div>
  );
}
