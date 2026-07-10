import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { streamOpenCodeUpdate } from "../admin";
import Icon from "./Icon";
import RestartOpenCode from "./RestartOpenCode";

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
// Restart is owned by the shared RestartOpenCode component (also mounted as a
// permanent standalone entry in the admin menu): this dialog gates WHEN it
// appears in the footer via offerRestart() and passes its version refetch as
// onRestarted. RestartOpenCode renders its own entry + a session-aware
// confirmation that counts running sessions across ALL workspaces the daemon
// manages (restarting OpenCode interrupts every workspace, not just the one
// this tab is viewing) + the result line — and is the SOLE caller of
// /vh/restart-opencode.
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
          {/* Restart is owned by the shared RestartOpenCode component (the SOLE
              caller of /vh/restart-opencode); this dialog gates WHEN it appears
              via offerRestart() and hands its version refetch as onRestarted so
              a successful restart refreshes the version readout. RestartOpenCode
              renders its own entry button + session-aware confirmation + result
              line. */}
          <Show when={offerRestart()}>
            <RestartOpenCode onRestarted={refetch} disabled={phase() === "updating"} />
          </Show>
          <button type="button" class="admin-btn" disabled={phase() === "updating"} onClick={props.onClose}>Close</button>
        </div>
      </div>
    </div>
    </Portal>
  );
}
