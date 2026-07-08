import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { streamOpenCodeUpdate } from "../admin";
import Icon from "./Icon";

type Versions = {
  installed: string;
  running: string;
  latest: string;
  updateAvailable: boolean;
  restartNeeded: boolean;
};

// The OpenCode update flow as a focused dialog. The layout is split into two
// stable zones so nothing jumps as npm version data resolves or the install
// progresses:
//   • status zone (top)  — live install log while updating; a compact result
//     line once done/failed, with the full log available on demand.
//   • install area (bottom, delimited) — the version readout + the single
//     install action (update / reinstall) in a STABLE slot. While npm version
//     data is unresolved that slot shows a loading indicator, never a button
//     whose label would later flip — that was the flicker root cause.
// Restart is owned ONLY by this dialog (the admin menu just opens it): the
// footer offers Restart OpenCode in the states where it applies, behind a
// session-aware confirmation that counts running sessions across ALL workspaces
// the daemon manages — restarting OpenCode interrupts every workspace, not just
// the one this tab is viewing.
export default function OpenCodeUpdateDialog(props: { onClose: () => void }) {
  const [ver, { refetch }] = createResource<Versions | null>(() =>
    fetch("/vh/opencode-version").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  );

  type Phase = "idle" | "updating" | "done" | "failed";
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [log, setLog] = createSignal("");
  const [beforeInstalled, setBeforeInstalled] = createSignal("");
  // D4: the install log collapses to a result line on completion and is exposed
  // on demand. While updating it streams live (this flag is ignored then).
  const [showLog, setShowLog] = createSignal(false);

  // Restart sub-flow — this dialog is the single owner.
  const [confirmRestart, setConfirmRestart] = createSignal(false);
  const [restarting, setRestarting] = createSignal(false);
  const [restartMsg, setRestartMsg] = createSignal("");

  let logEl: HTMLPreElement | undefined;
  const append = (t: string) => {
    setLog((prev) => prev + t);
    queueMicrotask(() => logEl && (logEl.scrollTop = logEl.scrollHeight));
  };

  async function runUpdate() {
    setBeforeInstalled(ver()?.installed || "");
    setLog("");
    setShowLog(false);
    setPhase("updating");
    try {
      await streamOpenCodeUpdate(append);
      await refetch();
      // The server marks the end of the stream with a sentinel line.
      setPhase(log().includes("[vh] update failed") ? "failed" : "done");
    } catch (e) {
      append("\n[vh] " + (e instanceof Error ? e.message : "update failed") + "\n");
      setPhase("failed");
    }
  }

  async function doRestart() {
    setRestarting(true);
    setRestartMsg("");
    try {
      const res = await fetch("/vh/restart-opencode", { method: "POST" });
      if (res.ok) {
        setRestartMsg("✓ OpenCode restarted");
        await refetch();
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

  const onKey = (e: KeyboardEvent) => {
    // Don't let Escape close mid-update (the request keeps running server-side).
    if (e.key === "Escape" && phase() !== "updating") props.onClose();
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  // Restart is offered when there is something to apply: after an install
  // attempt (done/failed) or when an already-installed update is pending
  // (idle + restartNeeded — formerly the admin menu's standalone restart).
  const offerRestart = () =>
    phase() === "done" || phase() === "failed" || (phase() === "idle" && !!ver()?.restartNeeded);

  const VerRow = (p: { label: string; value: string; accent?: boolean }) => (
    <div class="ocu-ver">
      <span class="ocu-ver-k">{p.label}</span>
      <span class="ocu-ver-v" classList={{ accent: p.accent }}>{p.value || "unknown"}</span>
    </div>
  );

  // The install action's label, given a resolved version readout. updateAvailable
  // is only known once npm resolved; until then the slot shows a loading state
  // instead of a button, so no visible button ever flips its label (D2).
  const actionLabel = () => {
    if (phase() === "updating") return "Updating…";
    return ver()?.updateAvailable ? `Update to ${ver()!.latest}` : "Reinstall latest";
  };

  return (
    // Portaled to <body> so the overlay escapes the admin popup's stacking
    // context (a z-index:60 positioned ancestor) — otherwise the modal paints
    // behind the menu. .ocu-overlay lifts it above that menu.
    <Portal>
    <div class="dialog-overlay ocu-overlay" onClick={() => phase() !== "updating" && props.onClose()}>
      <div class="dialog ocu" role="dialog" aria-label="Update OpenCode" onClick={(e) => e.stopPropagation()}>
        <div class="dialog-head">
          <span class="dialog-title"><Icon name="layers" size={15} /> Update OpenCode</span>
          <button type="button" class="icon-btn" aria-label="Close" disabled={phase() === "updating"} onClick={props.onClose}>
            <Icon name="x" size={14} />
          </button>
        </div>

        <div class="dialog-body ocu-body">
          {/* Status zone — live log while updating, compact result line after. */}
          <Show when={phase() === "updating" || showLog()}>
            <pre class="ocu-log" ref={logEl}>{log() || "…"}</pre>
          </Show>

          <Show when={phase() === "done"}>
            <div class="ocu-result">
              <p class="ocu-ok">
                ✓ Installed {ver()?.installed || "—"}
                <Show when={beforeInstalled() && beforeInstalled() !== ver()?.installed}> (was {beforeInstalled()})</Show>.
                <Show when={ver()?.restartNeeded}> Restart OpenCode to run it.</Show>
              </p>
              <button type="button" class="ocu-log-toggle" onClick={() => setShowLog((v) => !v)}>
                {showLog() ? "Hide install log" : "Show install log"}
              </button>
            </div>
          </Show>
          <Show when={phase() === "failed"}>
            <div class="ocu-result">
              <p class="ocu-err">Update failed — the running OpenCode is untouched. Use “Show install log” for details.</p>
              <button type="button" class="ocu-log-toggle" onClick={() => setShowLog((v) => !v)}>
                {showLog() ? "Hide install log" : "Show install log"}
              </button>
            </div>
          </Show>

          {/* Restart result reads as a distinct terminal state, not a log line. */}
          <Show when={restartMsg()}><p class="ocu-restart-result">{restartMsg()}</p></Show>

          {/* Install area (bottom, delimited): version readout + the single
              install action in a stable slot. No element here changes identity
              or position based on updateAvailable. */}
          <div class="ocu-install-area">
            <div class="ocu-install-vers">
              <Show
                when={ver()}
                fallback={<div class="ocu-vers-placeholder">Checking versions…</div>}
              >
                <VerRow label="Running" value={ver()!.running} />
                <VerRow label="Installed" value={ver()!.installed} accent={ver()!.restartNeeded} />
                <VerRow label="Latest (npm)" value={ver()!.latest} accent={ver()!.updateAvailable} />
              </Show>
            </div>
            <Show when={ver()?.restartNeeded && phase() === "idle"}>
              <p class="ocu-note">Installed {ver()?.installed} differs from the running {ver()?.running} — restart OpenCode to apply it.</p>
            </Show>
            {/* Stable action slot: a loading indicator until version data
                resolves, then the update/reinstall button in the SAME place. */}
            <div class="ocu-action-slot">
              <Show
                when={ver() !== undefined}
                fallback={<span class="ocu-action-loading">Checking latest version…</span>}
              >
                <button
                  type="button"
                  class="admin-btn"
                  classList={{ accent: !!ver()?.updateAvailable }}
                  disabled={phase() === "updating"}
                  onClick={runUpdate}
                >
                  <Icon name="layers" size={14} />
                  {actionLabel()}
                </button>
              </Show>
            </div>
          </div>
        </div>

        <div class="dialog-foot ocu-foot">
          {/* Restart is owned by this dialog only; the admin menu just opens it. */}
          <Show
            when={!confirmRestart()}
            fallback={<RestartConfirm restarting={restarting()} onConfirm={doRestart} onCancel={() => setConfirmRestart(false)} />}
          >
            <Show when={offerRestart()}>
              <button
                type="button"
                class="admin-btn accent"
                disabled={restarting()}
                onClick={() => (setRestartMsg(""), setConfirmRestart(true))}
              >
                <Icon name="retry" size={14} /> Restart OpenCode
              </button>
            </Show>
            <button type="button" class="admin-btn" disabled={phase() === "updating"} onClick={props.onClose}>Close</button>
          </Show>
        </div>
      </div>
    </div>
    </Portal>
  );
}

// RestartConfirm is the session-aware confirmation. It states exactly how many
// running sessions a restart will interrupt — counted across ALL workspaces the
// daemon manages (restarting OpenCode interrupts every workspace, not just the
// one this tab is viewing). The count is fetched on mount from
// /vh/running-sessions; until it resolves the warning reads "Checking active
// sessions…" so we never show a stale per-workspace number. Includes "0 running
// sessions" so "safe" is explicit, never implied by silence.
type RunningSessions = { count: number; workspaces: { dir: string; count: number }[] };

export function RestartConfirm(props: { restarting: boolean; onConfirm: () => void; onCancel: () => void }) {
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
            fallback={<>0 running sessions — safe to restart. OpenCode will be briefly unavailable; sessions are preserved.</>}
          >
            ⚠ {count()} running session{count() === 1 ? "" : "s"}
            {wsCount() > 1 ? ` across ${wsCount()} workspaces` : ""} will be interrupted. The in-flight turn(s) stop; sessions and history are preserved.
          </Show>
        </span>
      </Show>
      <div class="admin-confirm-btns">
        <button type="button" class="admin-btn danger" disabled={props.restarting} onClick={props.onConfirm}>
          {props.restarting ? "Restarting…" : "Restart OpenCode"}
        </button>
        <button type="button" class="admin-btn" disabled={props.restarting} onClick={props.onCancel}>Cancel</button>
      </div>
    </div>
  );
}
