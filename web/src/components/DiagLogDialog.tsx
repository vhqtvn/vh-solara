import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  diagEntries,
  diagLogEnabled,
  entryLine,
  MAX_DIAG_AGE_MS,
  MAX_DIAG_ENTRIES,
  setDiagLogOn,
} from "../sync/diaglog";
import { projectDir } from "../sync";
import Icon from "./Icon";
import styles from "./DiagLogDialog.module.css";

// Hidden diagnostic log viewer: a bounded, default-OFF ring buffer of FE timing
// entries, surfaced from the server-admin menu (right-click / long-press the
// Settings button). Lets the operator select/copy one or all entries. The caps
// and the default-off toggle are shown in-app so the "must not log too much"
// guarantee is visible, not magic.

const mins = (msVal: number) => `${Math.round(msVal / 60000)} min`;

// The __vhSyncDiag snapshot (recovery counters, stream-open counts,
// weaklink, connstatus ring inputs — recovery-reasons.ts) is a plain window
// getter installed once by startSync. Read it defensively ONCE at dialog
// open: an absent getter (early boot, test envs) or a throwing read yields
// null → the dialog shows an absence note instead of breaking.
type SyncDiagFn = () => unknown;
function readSyncDiagJson(): string | null {
  try {
    const fn = (window as { __vhSyncDiag?: SyncDiagFn }).__vhSyncDiag;
    if (typeof fn !== "function") return null;
    // stringify yields undefined only for non-serializable top-level values
    // (undefined/function/symbol) — coerce to null so the annotation is
    // runtime-honest and every `!= null` gate absorbs it.
    return JSON.stringify(fn(), null, 2) ?? null;
  } catch {
    return null;
  }
}

export default function DiagLogDialog(props: { onClose: () => void }) {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  const syncDiag = readSyncDiagJson();

  // Newest first for scanning (the buffer stores newest last).
  const list = createMemo(() => [...diagEntries()].reverse());
  const entriesText = () => list().map(entryLine).join("\n");
  // Copy-all bundles the visible entries plus the __vhSyncDiag snapshot
  // (when present) under a separator, so one tap captures the full FE sync
  // picture — mirroring what `__vhSyncDiag()` prints to the console.
  const allText = () => {
    const entries = entriesText();
    if (syncDiag == null) return entries;
    return entries
      ? `${entries}\n\n--- __vhSyncDiag ---\n${syncDiag}`
      : `--- __vhSyncDiag ---\n${syncDiag}`;
  };

  // Copy-all status (debate-settled shape): scoped plain inline text — no
  // toast, no timer, no legacy fallback chain. A silent catch made a failed
  // export look identical to a successful one exactly when evidence capture
  // matters, so the write now reports per-attempt success/failure. Success
  // means the API resolved for THAT attempted snapshot (later log entries
  // are not implied copied); failure = the write rejected OR the clipboard
  // API absent, and shows manual-copy guidance instead.
  const COPY_OK_MSG = "Snapshot copied.";
  const COPY_FAIL_MSG =
    "Copy failed — select and copy the text manually. Expand sync diagnostics to include that snapshot.";
  const [copyStatus, setCopyStatus] = createSignal<{ ok: boolean } | null>(null);
  // Attempt token: an attempt that settles after a NEWER attempt started
  // (or after this dialog instance closed — App mounts us under <Show>, so
  // reopen is a fresh instance with fresh state) must not repopulate stale
  // feedback.
  let copyAttempt = 0;

  async function copyAll() {
    const attempt = ++copyAttempt;
    // Clear any prior status when a new attempt starts.
    setCopyStatus(null);
    try {
      const clip = navigator.clipboard;
      // Absent clipboard API (navigator.clipboard undefined) is a failure
      // too — a missing writeText throws below and lands in the same catch.
      if (!clip) throw new Error("clipboard API unavailable");
      await clip.writeText(allText() || "(no entries)");
      if (attempt === copyAttempt) setCopyStatus({ ok: true });
    } catch {
      if (attempt === copyAttempt) setCopyStatus({ ok: false });
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
            <span>Capture sync diagnostics</span>
          </label>
          <p class={styles.help}>
            Off by default. When off, nothing is recorded. When on, capture appends bounded entries:
            cold-open timing (session id + total/conn/snap/hydrate), stall detections, and — for
            warm-resume attribution — one line per stream open (stream, reason, generation, cursor)
            with lifecycle (onopen/onerror) records, so native retries are distinguishable from
            JS-owned opens.
            <code>total</code> = user-perceived cold-open time (conn + snap + hydrate);
            <code>conn</code> = pure transport (EventSource construction → onopen) — NOT total time.
            Older entries age out automatically.
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
            <Show when={list().length > 0 || syncDiag != null}>
              <button type="button" class={styles.copyAll} onClick={copyAll}>
                <Icon name="copy" size={13} /> Copy all
              </button>
            </Show>
          </div>

          {/* Per-attempt copy status: text-only polite live region directly
              under the copy controls (role="status" → aria-live=polite). */}
          <Show when={copyStatus()}>
            <p class={styles.copyStatus} classList={{ [styles.copyStatusErr]: !copyStatus()!.ok }} role="status">
              {copyStatus()!.ok ? COPY_OK_MSG : COPY_FAIL_MSG}
            </p>
          </Show>

          <Show
            when={list().length > 0}
            fallback={<div class={styles.empty}>No entries yet. Open a cold session with capture on.</div>}
          >
            <pre class={styles.list} aria-label="Diagnostic entries">
              {entriesText()}
            </pre>
          </Show>

          <details class={styles.syncDiag}>
            <summary>Sync snapshot (__vhSyncDiag)</summary>
            <Show
              when={syncDiag != null}
              fallback={<div class={styles.empty}>Not installed in this session — startSync has not run.</div>}
            >
              <pre class={styles.snapshot} aria-label="Sync snapshot">
                {syncDiag}
              </pre>
            </Show>
          </details>
        </div>
      </div>
    </div>
  );
}
