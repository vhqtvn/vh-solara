// OpenCode lifecycle health panel.
//
// Renders OpenCode's lifecycle state from the opencode-lifecycle store. This
// replaces the old generic "OpenCode may not be connected" inference that lived
// in index.tsx (which conflated agent-loading failure with OpenCode health) with
// a real lifecycle-aware surface:
//
//   ready/starting → a subtle pill (minimal; don't clutter the normal UI)
//   failed         → a prominent card: failure_summary, exit code, timestamp,
//                    a refreshable logs tail, and a restart button (if allowed)
//   stopped        → a card with a restart button (if allowed)
//   unknown        → a card with an explanation
//
// When the lifecycle surface isn't wired (503 → lifecycleAvailable=false) the
// panel renders nothing, so an older daemon keeps its legacy behavior.
//
// Worker-SSE connection state (ConnectionToast) and OpenCode health are kept
// separate here: a live stream only means the worker is reachable, NOT that
// OpenCode is ready. See docs/ai/web-css-architecture.md for CSS conventions.
import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import {
  fetchLogs,
  lifecycleAvailable,
  restartOpenCode,
  snapshot,
} from "../opencode-lifecycle";
import Icon from "./Icon";
import styles from "./OpenCodeHealthPanel.module.css";

// Logs auto-refresh cadence (5s). Well under the ~5fps WebRender coalesce cap
// (AGENTS.md → "Web frontend performance"), and the ring is a bounded tail so a
// full <pre> re-render is cheap. We additionally skip the signal write when the
// fetched text is unchanged so a quiet log triggers zero DOM work.
const LOG_REFRESH_MS = 5000;
// How long the "ready" pill lingers before fading, so the normal UI is
// uncluttered.
const READY_PILL_MS = 4000;

export default function OpenCodeHealthPanel() {
  const snap = () => snapshot();

  // ── ready pill auto-fade ────────────────────────────────────────────────
  const [showReady, setShowReady] = createSignal(false);
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const st = snap()?.state;
    if (st === "ready" && lifecycleAvailable()) {
      setShowReady(true);
      clearTimeout(readyTimer);
      readyTimer = setTimeout(() => setShowReady(false), READY_PILL_MS);
    } else {
      setShowReady(false);
      clearTimeout(readyTimer);
    }
  });
  onCleanup(() => clearTimeout(readyTimer));

  const showPill = (): boolean => {
    const s = snap();
    if (!s || !lifecycleAvailable()) return false;
    return (
      s.state === "starting" || (s.state === "ready" && showReady())
    );
  };

  const isProblem = (): boolean => {
    const s = snap();
    return (
      !!s &&
      lifecycleAvailable() &&
      (s.state === "failed" || s.state === "stopped" || s.state === "unknown")
    );
  };

  // ── Logs tail ───────────────────────────────────────────────────────────
  const [logText, setLogText] = createSignal<string>("");
  const [logLoading, setLogLoading] = createSignal(false);
  const [logError, setLogError] = createSignal(false);
  let logTimer: ReturnType<typeof setInterval> | undefined;
  // Plain closure var for the dedup comparison (avoids a render on no-change).
  let lastLogText = "";

  async function refreshLogs(): Promise<void> {
    const s = snap();
    if (!s?.capabilities.has_log_tail) return;
    setLogLoading(true);
    const r = await fetchLogs();
    setLogLoading(false);
    if (!r.ok) {
      setLogError(true);
      return;
    }
    setLogError(false);
    // Only write the signal on a real change → no re-render when the tail is
    // unchanged (the common case on a quiet/failing process).
    if (r.text !== lastLogText) {
      lastLogText = r.text;
      setLogText(r.text);
    }
  }

  // Auto-refresh logs only while the prominent panel is showing a state that
  // owns a log tail (failed/stopped/unknown + has_log_tail). Started on first
  // visibility, stopped on hide so we don't poll in the background.
  createEffect(() => {
    const s = snap();
    const visible =
      !!s && lifecycleAvailable() && isProblem() && s.capabilities.has_log_tail;
    if (visible) {
      // Kick an immediate load if we have no text yet (first visibility).
      if (!lastLogText) void refreshLogs();
      if (logTimer === undefined) {
        logTimer = setInterval(() => void refreshLogs(), LOG_REFRESH_MS);
      }
    } else {
      if (logTimer !== undefined) {
        clearInterval(logTimer);
        logTimer = undefined;
      }
      // Clear the cached tail when leaving the prominent+tail state so a later
      // re-entry shows fresh text instead of a stale buffer.
      lastLogText = "";
      setLogText("");
    }
  });
  onCleanup(() => {
    if (logTimer !== undefined) clearInterval(logTimer);
  });

  // ── Restart ─────────────────────────────────────────────────────────────
  const [restarting, setRestarting] = createSignal(false);
  const [restartErr, setRestartErr] = createSignal(false);

  // F2: confirm gate. Restarting OpenCode interrupts every running session
  // across ALL workspaces the daemon manages (not just this tab's view), so the
  // restart button does NOT POST immediately. Instead it enters an inline
  // confirm step (rendered inside the card — no separate centered dialog, since
  // the health panel is already a card overlay) that fetches
  // /vh/running-sessions and shows a warning. Mirrors RestartConfirm's tri-state
  // (loading / known / unknown) so the warning is honest about uncertainty;
  // fail-closed disables Restart while the count is unknown (the operator can
  // still Cancel). The POST still targets /vh/opencode/restart (NOT the legacy
  // /vh/restart-opencode) because it returns a post-restart Snapshot the store
  // adopts directly.
  const [confirmRestart, setConfirmRestart] = createSignal(false);
  type SessionFetchState = "loading" | "known" | "unknown";
  const [sessionState, setSessionState] =
    createSignal<SessionFetchState>("loading");
  const [sessionCount, setSessionCount] = createSignal(0);

  async function enterConfirm(): Promise<void> {
    setConfirmRestart(true);
    setRestartErr(false);
    setSessionState("loading");
    try {
      const res = await fetch("/vh/running-sessions");
      if (!res.ok) {
        setSessionState("unknown");
        return;
      }
      const d = (await res.json()) as { count?: number };
      setSessionCount(d.count ?? 0);
      setSessionState("known");
    } catch {
      setSessionState("unknown");
    }
  }

  async function onRestart(): Promise<void> {
    if (restarting()) return;
    setRestarting(true);
    setRestartErr(false);
    const ok = await restartOpenCode();
    setRestarting(false);
    setConfirmRestart(false);
    if (!ok) setRestartErr(true);
  }

  function fmtTime(iso: string): string {
    if (!iso) return "";
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }

  const exitCodeKnown = (): boolean => {
    const s = snap();
    return (
      !!s &&
      s.capabilities.has_exit_status &&
      s.exit_code !== null &&
      s.exit_code !== undefined
    );
  };

  return (
    <>
      {/* Minimal pill: starting (persistent) or ready (brief confirmation). */}
      <Show when={showPill()}>
        <div
          class={styles["och-pill"]}
          classList={{
            [styles["starting"]]: snap()?.state === "starting",
            [styles["ready"]]: snap()?.state === "ready",
          }}
          role="status"
        >
          <span class={styles["och-dot"]} />
          {snap()?.state === "starting"
            ? "OpenCode starting…"
            : "OpenCode ready"}
        </div>
      </Show>

      {/* Prominent card for problem states. Non-keyed Show: stays mounted across
          snapshot identity changes (only the state string gates visibility), so
          polling doesn't remount the card or reset scroll. */}
      <Show when={isProblem()}>
        <div
          class={styles["och-panel"]}
          classList={{ [styles["failed"]]: snap()?.state === "failed" }}
          role="alert"
          aria-live="polite"
        >
          <Show when={snap()?.state === "failed"}>
            <div class={styles["och-head"]}>
              <Icon name="alert" size={16} />
              <span class={styles["och-title"]}>OpenCode failed to start</span>
            </div>
            <Show when={snap()?.failure_summary}>
              <div class={styles["och-summary"]}>{snap()?.failure_summary}</div>
            </Show>
          </Show>

          <Show when={snap()?.state === "stopped"}>
            <div class={styles["och-head"]}>
              <Icon name="alert" size={16} />
              <span class={styles["och-title"]}>OpenCode stopped</span>
            </div>
          </Show>

          <Show when={snap()?.state === "unknown"}>
            <div class={styles["och-head"]}>
              <Icon name="help" size={16} />
              <span class={styles["och-title"]}>OpenCode status unknown</span>
            </div>
            <div class={styles["och-summary"]}>
              The vh-solara worker can't determine whether OpenCode is running.
              If it just started, this should clear shortly.
            </div>
          </Show>

          {/* Diagnostics row: exit code + timestamp + completeness. */}
          <Show
            when={
              snap()?.state === "failed" ||
              snap()?.state === "stopped" ||
              snap()?.state === "unknown"
            }
          >
            <div class={styles["och-meta"]}>
              <Show when={exitCodeKnown()}>
                <span>exit: {snap()?.exit_code}</span>
              </Show>
              <Show when={snap()?.state_changed_at}>
                <span>{fmtTime(snap()?.state_changed_at ?? "")}</span>
              </Show>
              <Show when={snap()?.diagnostic_completeness === "partial"}>
                <span>· partial diagnostics</span>
              </Show>
            </div>
          </Show>

          {/* Logs tail (owned/detached only). */}
          <Show
            when={snap()?.capabilities.has_log_tail}
            fallback={
              <div class={styles["och-nologs"]}>
                Logs not available for this topology.
              </div>
            }
          >
            <div class={styles["och-loghead"]}>
              <span>Recent logs</span>
              <button
                type="button"
                class={styles["och-refresh"]}
                onClick={() => void refreshLogs()}
                disabled={logLoading()}
                aria-label="Refresh logs"
              >
                <Icon name="retry" size={13} />
                {logLoading() ? "Loading…" : "Refresh"}
              </button>
            </div>
            <pre class={styles["och-log"]}>
              {logText() || (logLoading() ? "…" : "(empty)")}
            </pre>
            <Show when={logError()}>
              <div class={styles["och-logerr"]}>Couldn't load logs.</div>
            </Show>
          </Show>

          {/* Restart (owned/detached only). F2: an inline confirm gate shows a
              session-interrupt warning before the POST. The POST still targets
              /vh/opencode/restart (returns the post-restart Snapshot). */}
          <Show when={snap()?.capabilities.can_restart}>
            <Show
              when={!confirmRestart()}
              fallback={
                <div class={styles["och-confirm"]}>
                  <Show
                    when={sessionState() !== "loading"}
                    fallback={
                      <span class={styles["och-confirm-loading"]}>
                        Checking active sessions…
                      </span>
                    }
                  >
                    <Show
                      when={sessionState() === "known"}
                      fallback={
                        <span class={styles["och-confirm-warn"]}>
                          Couldn't verify active sessions — restart will
                          interrupt any that are running.
                        </span>
                      }
                    >
                      <Show
                        when={sessionCount() > 0}
                        fallback={
                          <span class={styles["och-confirm-safe"]}>
                            0 running sessions — safe to restart. OpenCode will
                            be briefly unavailable; sessions are preserved.
                          </span>
                        }
                      >
                        <span class={styles["och-confirm-warn"]}>
                          ⚠ {sessionCount()} running session
                          {sessionCount() === 1 ? "" : "s"} will be interrupted.
                          In-flight turn(s) stop; sessions and history are
                          preserved.
                        </span>
                      </Show>
                    </Show>
                  </Show>
                  <div class={styles["och-actions"]}>
                    <button
                      type="button"
                      class={styles["och-restart"]}
                      onClick={() => void onRestart()}
                      disabled={
                        restarting() ||
                        sessionState() === "loading" ||
                        sessionState() === "unknown"
                      }
                    >
                      <Icon name="retry" size={14} />
                      {restarting() ? "Restarting…" : "Restart OpenCode"}
                    </button>
                    <button
                      type="button"
                      class={styles["och-cancel"]}
                      onClick={() => {
                        if (restarting()) return;
                        setConfirmRestart(false);
                      }}
                      disabled={restarting()}
                    >
                      Cancel
                    </button>
                  </div>
                  <Show when={restartErr()}>
                    <span class={styles["och-restart-err"]}>
                      Restart failed — try again.
                    </span>
                  </Show>
                </div>
              }
            >
              <div class={styles["och-actions"]}>
                <button
                  type="button"
                  class={styles["och-restart"]}
                  onClick={() => void enterConfirm()}
                  disabled={restarting()}
                >
                  <Icon name="retry" size={14} />
                  {restarting() ? "Restarting…" : "Restart OpenCode"}
                </button>
                <Show when={restartErr()}>
                  <span class={styles["och-restart-err"]}>
                    Restart failed — try again.
                  </span>
                </Show>
              </div>
            </Show>
          </Show>
        </div>
      </Show>
    </>
  );
}
