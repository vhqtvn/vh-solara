import { createEffect, createSignal, on, onMount, Show } from "solid-js";
import Icon from "./Icon";

// RestartOpenCode OWNS the complete OpenCode-restart operation end to end: the
// entry affordance, a session-aware confirmation (RestartConfirm), the
// in-flight state, the SOLE client-side POST to /vh/restart-opencode, and the
// success/failure result line. After this extraction there is exactly ONE
// caller of the endpoint, and every restart path traverses RestartConfirm (the
// session-interrupt gate that counts running sessions across ALL workspaces the
// daemon manages — restarting OpenCode interrupts every workspace, not just the
// one this tab is viewing).
//
// Two surfaces mount this component:
//   • the admin menu — a permanent full-width "Restart OpenCode…" row. This is
//     the only restart affordance at idle when there is no pending install /
//     restartNeeded signal (the UX gap this component closes).
//   • the update dialog footer — gated by offerRestart(), passing the dialog's
//     version refetch as onRestarted so a successful restart refreshes the
//     version readout.
// The entry uses a conventional full-width .admin-btn row (the same surface the
// other admin commands use) — no split/two-up pattern.
export type RestartOpenCodeProps = {
  onRestarted?: () => void; // fired after a successful POST (dialog refetches)
  disabled?: boolean; // dialog disables while an install is running
  accent?: boolean; // dialog footer restyles the entry as .admin-btn.accent
  // Emits true when this component is in an interactive/blocking state
  // (RestartConfirm open OR a restart POST in-flight), false when back to idle.
  // The update dialog uses this to hide its Close button (focus-lock) while a
  // restart confirmation/POST owns the footer. Deferred so the initial mount
  // (idle) does not churn the parent's state.
  onActiveChange?: (active: boolean) => void;
};

type RunningSessions = { count: number; workspaces: { dir: string; count: number }[] };

export default function RestartOpenCode(props: RestartOpenCodeProps) {
  const [confirmRestart, setConfirmRestart] = createSignal(false);
  const [restarting, setRestarting] = createSignal(false);
  const [restartMsg, setRestartMsg] = createSignal("");

  // Reflect the active (blocking) state to an optional parent callback so a host
  // dialog can focus-lock (hide its Close button) while RestartConfirm is open or
  // a restart POST is in-flight. `defer: true` skips the initial idle run so a
  // fresh mount does not spuriously toggle the parent's state — only real
  // transitions (confirm opened/closed, POST start/finish) emit.
  createEffect(
    on(
      () => confirmRestart() || restarting(),
      (active) => props.onActiveChange?.(active),
      { defer: true },
    ),
  );

  // The single POST to /vh/restart-opencode. On success the optional callback
  // fires so a host dialog can refresh its version readout; failure surfaces a
  // compact result line. 501 = "not managed here" (the daemon isn't managing an
  // OpenCode process for this workspace), any other non-ok = generic failure.
  async function doRestart() {
    setRestarting(true);
    setRestartMsg("");
    try {
      const res = await fetch("/vh/restart-opencode", { method: "POST" });
      if (res.ok) {
        setRestartMsg("✓ OpenCode restarted");
        props.onRestarted?.();
      } else {
        setRestartMsg(res.status === 501 ? "Not managed here" : "Restart failed");
      }
    } catch {
      setRestartMsg("Restart failed");
    } finally {
      setRestarting(false);
      setConfirmRestart(false);
    }
  }

  return (
    <Show
      when={!confirmRestart()}
      fallback={
        <RestartConfirm
          restarting={restarting()}
          onConfirm={doRestart}
          onCancel={() => setConfirmRestart(false)}
        />
      }
    >
      {/* Restart result reads as a distinct terminal state, not another log
          line. Shown alongside the entry so a completed restart is visible and
          the entry remains available to restart again. */}
      <Show when={restartMsg()}>
        <p class="ocu-restart-result">{restartMsg()}</p>
      </Show>
      <button
        type="button"
        class="admin-btn"
        classList={{ accent: !!props.accent }}
        disabled={props.disabled || restarting()}
        onClick={() => (setRestartMsg(""), setConfirmRestart(true))}
      >
        <Icon name="retry" size={14} /> Restart OpenCode…
      </button>
    </Show>
  );
}

// RestartConfirm is the session-aware confirmation. It states exactly how many
// running sessions a restart will interrupt — counted across ALL workspaces the
// daemon manages (restarting OpenCode interrupts every workspace, not just the
// one this tab is viewing). The count is fetched on mount from
// /vh/running-sessions; until it resolves the warning reads "Checking active
// sessions…" so we never show a stale per-workspace number. Includes "0 running
// sessions" so "safe" is explicit, never implied by silence.
export function RestartConfirm(props: {
  restarting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [data, setData] = createSignal<RunningSessions | null>(null);
  onMount(() => {
    fetch("/vh/running-sessions")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: RunningSessions | null) => setData(d ?? { count: 0, workspaces: [] }))
      .catch(() => setData({ count: 0, workspaces: [] }));
  });
  const count = () => data()?.count ?? 0;
  const wsCount = () => data()?.workspaces.length ?? 0;

  return (
    <div class="ocu-confirm">
      <Show
        when={data() !== null}
        fallback={<span class="ocu-confirm-loading">Checking active sessions…</span>}
      >
        <span classList={{ warn: count() > 0 }}>
          <Show
            when={count() > 0}
            fallback={
              <>0 running sessions — safe to restart. OpenCode will be briefly unavailable; sessions are preserved.</>
            }
          >
            ⚠ {count()} running session{count() === 1 ? "" : "s"}
            {wsCount() > 1 ? ` across ${wsCount()} workspaces` : ""} will be interrupted. The
            in-flight turn(s) stop; sessions and history are preserved.
          </Show>
        </span>
      </Show>
      <div class="admin-confirm-btns">
        <button
          type="button"
          class="admin-btn danger"
          disabled={props.restarting}
          onClick={props.onConfirm}
        >
          {props.restarting ? "Restarting…" : "Restart OpenCode"}
        </button>
        <button
          type="button"
          class="admin-btn"
          disabled={props.restarting}
          onClick={props.onCancel}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
