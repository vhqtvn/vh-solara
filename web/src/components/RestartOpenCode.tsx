import { createEffect, createSignal, on, onCleanup, onMount, Show } from "solid-js";
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
  // When true the component skips the entry-button click and shows RestartConfirm
  // immediately. Used by RestartOpenCodeDialog so the centered popup lands
  // directly on the confirm step. The POST behavior and RestartConfirm are
  // unchanged; the entry button is still rendered if confirmRestart is reset to
  // false (e.g. after Cancel / after a completed restart).
  autoConfirm?: boolean;
  // Emits true when this component is in an interactive/blocking state
  // (RestartConfirm open OR a restart POST in-flight), false when back to idle.
  // The update dialog uses this to hide its Close button (focus-lock) while a
  // restart confirmation/POST owns the footer. Deferred so the initial mount
  // (idle) does not churn the parent's state.
  onActiveChange?: (active: boolean) => void;
};

type RunningSessions = { count: number; workspaces: { dir: string; count: number }[] };

export default function RestartOpenCode(props: RestartOpenCodeProps) {
  // autoConfirm lands on the confirm step without an entry-button click (used by
  // RestartOpenCodeDialog). Read once at setup; autoConfirm is a static prop.
  const [confirmRestart, setConfirmRestart] = createSignal(!!props.autoConfirm);
  const [restarting, setRestarting] = createSignal(false);
  const [restartMsg, setRestartMsg] = createSignal("");
  // Tracks whether the current restartMsg is a success (green) or a failure
  // (red). A failure result must NOT render through the success-green result
  // box — it carries the .err modifier so the color matches the outcome.
  const [restartOk, setRestartOk] = createSignal(true);

  // Reflect the active (blocking) state to an optional parent callback so a host
  // dialog can focus-lock (hide its Close button) while RestartConfirm is open or
  // a restart POST is in-flight. `defer: true` skips the initial idle run so a
  // fresh mount does not spuriously toggle the parent's state — only real
  // transitions (confirm opened/closed, POST start/finish) emit.
  createEffect(
    on(
      () => confirmRestart() || restarting(),
      (active) => {
        // Defensive: if the component unmounts while active (confirm open or a
        // POST in-flight), emit a final false so the parent's restartActive
        // flag is not stranded at true. defer:true still skips the initial
        // idle mount — and because the effect never runs at idle, no cleanup
        // is registered there either, so an idle mount+unmount emits nothing.
        onCleanup(() => props.onActiveChange?.(false));
        props.onActiveChange?.(active);
      },
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
    setRestartOk(true);
    try {
      const res = await fetch("/vh/restart-opencode", { method: "POST" });
      if (res.ok) {
        setRestartMsg("✓ OpenCode restarted");
        setRestartOk(true);
        props.onRestarted?.();
      } else {
        setRestartMsg(res.status === 501 ? "Not managed here" : "Restart failed");
        setRestartOk(false);
      }
    } catch {
      setRestartMsg("Restart failed");
      setRestartOk(false);
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
        <p class="ocu-restart-result" classList={{ err: !restartOk() }}>
          {restartMsg()}
        </p>
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
// Tri-state for the running-sessions fetch. The previous implementation
// collapsed both a non-OK response and a network error to {count:0}, which
// rendered an UNKNOWN count as "0 running sessions — safe to restart" with the
// danger Restart button ENABLED — under-reporting exactly when uncertain. Fail
// closed instead: a non-OK response or a network error becomes "unknown", which
// surfaces an explicit uncertainty message and DISABLES the Restart button
// (Cancel stays enabled). The known count==0 path ("safe to restart") is
// unchanged.
type ConfirmState =
  | { status: "loading" }
  | { status: "known"; data: RunningSessions }
  | { status: "unknown" };

export function RestartConfirm(props: {
  restarting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [state, setState] = createSignal<ConfirmState>({ status: "loading" });
  onMount(() => {
    // cache:'no-store' — the count of running sessions across ALL workspaces
    // is the gate that decides whether the Restart button is "safe to restart"
    // vs "will interrupt N sessions". A stale browser-cached response here
    // would under- or over-report the interrupt impact at exactly the moment
    // the user is deciding. Server also emits Cache-Control:no-store.
    fetch("/vh/running-sessions", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: RunningSessions | null) =>
        setState(d ? { status: "known", data: d } : { status: "unknown" }),
      )
      .catch(() => setState({ status: "unknown" }));
  });
  // Accessors are only meaningful inside the "known" render branch (guarded in
  // JSX); they return 0 elsewhere so the disabled-unknown path never reads a
  // stale count.
  const known = (): RunningSessions | null => {
    const s = state();
    return s.status === "known" ? s.data : null;
  };
  const count = () => known()?.count ?? 0;
  const wsCount = () => known()?.workspaces.length ?? 0;

  return (
    <div class="ocu-confirm">
      <Show
        when={state().status !== "loading"}
        fallback={<span class="ocu-confirm-loading">Checking active sessions…</span>}
      >
        <Show
          when={state().status === "known"}
          fallback={
            <span class="warn">
              Couldn't verify active sessions — restart will interrupt any that are running.
            </span>
          }
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
      </Show>
      <div class="admin-confirm-btns">
        <button
          type="button"
          class="admin-btn danger"
          disabled={props.restarting || state().status === "unknown"}
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
