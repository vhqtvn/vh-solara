import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { fetchLogs, lifecycleAvailable, snapshot } from "../opencode-lifecycle";
import Icon from "./Icon";
import styles from "./OpenCodeLogsDialog.module.css";

// Always-accessible OpenCode process-logs viewer.
//
// The backend already exposes the ring tail via GET /vh/opencode/logs (text/
// plain) regardless of OpenCode state — populated by the process-output fan-out
// (io.MultiWriter) on owned/detached topologies. OpenCodeHealthPanel only shows
// logs in a PROBLEM state (failed/stopped/unknown); this dialog is the separate,
// always-reachable entry point so the operator can read OpenCode's stdout/stderr
// (e.g. console.log from their own plugins) at any time, even when OpenCode is
// running fine.
//
// Reuses fetchLogs() + snapshot() + lifecycleAvailable() from
// opencode-lifecycle.ts — no duplicated fetch logic. Auto-refreshes every 5s
// (same cadence as the health panel) and mirrors its dedup (skip the signal
// write when the tail is unchanged → zero DOM work on a quiet process).
//
// Topology-aware: if snapshot()?.capabilities.has_log_tail is false (external
// topology) the log viewer is replaced with a clear "not available for this
// topology" note. If the lifecycle surface isn't wired (503 → lifecycleAvailable
// false, older daemon) it shows "not available on this server version" instead.
//
// Rendered as a centered, portaled overlay (same model as OpenCodeUpdateDialog
// / RestartOpenCodeDialog) and reached from the server-admin menu's Diagnostics
// section. The menu closes itself before opening this dialog (same as the
// sibling Diagnostic log entry), so the base --z-dialog layer is sufficient.
//
// PERF: the <pre> is a GPU-sensitive scroll surface — see the CSS module header
// and AGENTS.md → "Web frontend performance" for the forbidden patterns.
const LOG_REFRESH_MS = 5000;

export default function OpenCodeLogsDialog(props: { onClose: () => void }) {
  const snap = () => snapshot();
  const available = () => lifecycleAvailable();
  const hasTail = () => !!snap()?.capabilities.has_log_tail;

  // ── Logs tail ───────────────────────────────────────────────────────────
  const [logText, setLogText] = createSignal<string>("");
  const [logLoading, setLogLoading] = createSignal(false);
  const [logError, setLogError] = createSignal(false);
  let logTimer: ReturnType<typeof setInterval> | undefined;
  // Plain closure var for the dedup comparison (avoids a render on no-change).
  let lastLogText = "";

  async function refreshLogs(): Promise<void> {
    setLogLoading(true);
    const r = await fetchLogs();
    setLogLoading(false);
    if (!r.ok) {
      setLogError(true);
      return;
    }
    setLogError(false);
    // Only write the signal on a real change → no re-render when the tail is
    // unchanged (the common case on a quiet process).
    if (r.text !== lastLogText) {
      lastLogText = r.text;
      setLogText(r.text);
    }
  }

  // Auto-refresh only while the lifecycle surface is wired AND the topology
  // exposes a log tail. Started on first visibility, stopped on hide/unmount so
  // we don't poll in the background.
  createEffect(() => {
    if (available() && hasTail()) {
      // Kick an immediate load if we have no text yet (first visibility).
      if (!lastLogText) void refreshLogs();
      if (logTimer === undefined) {
        logTimer = setInterval(() => void refreshLogs(), LOG_REFRESH_MS);
      }
    } else if (logTimer !== undefined) {
      clearInterval(logTimer);
      logTimer = undefined;
    }
  });
  onCleanup(() => {
    if (logTimer !== undefined) clearInterval(logTimer);
  });

  // ── Close on Escape ─────────────────────────────────────────────────────
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") props.onClose();
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    // Portaled to <body> so the overlay escapes any ancestor stacking context
    // (consistent with OpenCodeUpdateDialog / RestartOpenCodeDialog).
    <Portal>
      <div class="dialog-overlay" onClick={props.onClose}>
        <div
          class="dialog"
          role="dialog"
          aria-label="OpenCode logs"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="dialog-head">
            <span class="dialog-title">
              <Icon name="terminal" size={15} /> OpenCode logs
            </span>
            <button
              type="button"
              class="icon-btn"
              aria-label="Close"
              onClick={props.onClose}
            >
              <Icon name="x" size={14} />
            </button>
          </div>

          <div class="dialog-body">
            {/* Lifecycle not wired (503 / older daemon) → defer to legacy
                behavior; no log viewer. */}
            <Show
              when={available()}
              fallback={
                <div class={styles.note}>
                  OpenCode logs not available on this server version.
                </div>
              }
            >
              {/* External topology → no process-output fan-out. */}
              <Show
                when={hasTail()}
                fallback={
                  <div class={styles.note}>
                    Logs not available for this topology.
                  </div>
                }
              >
                <div class={styles.loghead}>
                  <span class={styles.label}>Recent stdout / stderr</span>
                  <button
                    type="button"
                    class={styles.refresh}
                    onClick={() => void refreshLogs()}
                    disabled={logLoading()}
                    aria-label="Refresh logs"
                  >
                    <Icon name="retry" size={13} />
                    {logLoading() ? "Loading…" : "Refresh"}
                  </button>
                </div>
                <pre class={styles.log}>
                  {logText() || (logLoading() ? "…" : "(empty)")}
                </pre>
                <Show when={logError()}>
                  <div class={styles.err}>Couldn't load logs.</div>
                </Show>
              </Show>
            </Show>
          </div>
        </div>
      </div>
    </Portal>
  );
}
