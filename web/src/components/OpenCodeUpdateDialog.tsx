import { createResource, createSignal, onCleanup, onMount, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { streamOpenCodeUpdate } from "../admin";
import { runningSessionCount } from "../sync";
import Icon from "./Icon";

type Versions = {
  installed: string;
  running: string;
  latest: string;
  updateAvailable: boolean;
  restartNeeded: boolean;
};

// The OpenCode update flow as a focused dialog: it streams the install log live
// (so the operator isn't guessing), confirms the new installed version, and only
// then — as a separate, session-aware step — offers to restart OpenCode to apply
// it. Restart is what interrupts running turns, so it's never bundled in.
export default function OpenCodeUpdateDialog(props: { onClose: () => void }) {
  const [ver, { refetch }] = createResource<Versions | null>(() =>
    fetch("/vh/opencode-version").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  );

  type Phase = "idle" | "updating" | "done" | "failed";
  const [phase, setPhase] = createSignal<Phase>("idle");
  const [log, setLog] = createSignal("");
  const [beforeInstalled, setBeforeInstalled] = createSignal("");

  // Restart sub-flow.
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

  const VerRow = (p: { label: string; value: string; accent?: boolean }) => (
    <div class="ocu-ver">
      <span class="ocu-ver-k">{p.label}</span>
      <span class="ocu-ver-v" classList={{ accent: p.accent }}>{p.value || "unknown"}</span>
    </div>
  );

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
          <Show when={ver()} fallback={<div class="placeholder">Checking version…</div>}>
            <div class="ocu-vers">
              <VerRow label="Running" value={ver()!.running} />
              <VerRow label="Installed" value={ver()!.installed} accent={ver()!.restartNeeded} />
              <VerRow label="Latest (npm)" value={ver()!.latest} accent={ver()!.updateAvailable} />
            </div>
            <Show when={ver()!.restartNeeded && phase() === "idle"}>
              <p class="ocu-note">Installed {ver()!.installed} differs from the running {ver()!.running} — restart OpenCode to apply it.</p>
            </Show>
          </Show>

          {/* Live install log (shown once an update starts). */}
          <Show when={phase() !== "idle"}>
            <pre class="ocu-log" ref={logEl}>{log() || "…"}</pre>
          </Show>

          <Show when={phase() === "done"}>
            <p class="ocu-ok">
              ✓ Installed {ver()?.installed}
              <Show when={beforeInstalled() && beforeInstalled() !== ver()?.installed}> (was {beforeInstalled()})</Show>.
              <Show when={ver()?.restartNeeded}> Restart OpenCode to run it.</Show>
              <Show when={!ver()?.restartNeeded}> Already running this version.</Show>
            </p>
          </Show>
          <Show when={phase() === "failed"}>
            <p class="ocu-err">Update failed — see the log above. The running OpenCode is untouched.</p>
          </Show>

          <Show when={restartMsg()}><p class="ocu-ok">{restartMsg()}</p></Show>
        </div>

        <div class="dialog-foot ocu-foot">
          {/* idle: start the update (or force-reinstall if already latest). */}
          <Show when={phase() === "idle"}>
            <button type="button" class="admin-btn accent" disabled={!ver()} onClick={runUpdate}>
              <Icon name="layers" size={14} />
              {ver()?.updateAvailable ? `Update to ${ver()!.latest}` : "Reinstall latest"}
            </button>
            <button type="button" class="admin-btn" onClick={props.onClose}>Close</button>
          </Show>

          <Show when={phase() === "updating"}>
            <button type="button" class="admin-btn" disabled>Updating…</button>
          </Show>

          {/* done/failed: the two requested buttons — Restart OpenCode + Close. */}
          <Show when={phase() === "done" || phase() === "failed"}>
            <Show
              when={!confirmRestart()}
              fallback={<RestartConfirm restarting={restarting()} onConfirm={doRestart} onCancel={() => setConfirmRestart(false)} />}
            >
              <button type="button" class="admin-btn accent" disabled={restarting()} onClick={() => (setRestartMsg(""), setConfirmRestart(true))}>
                <Icon name="retry" size={14} /> Restart OpenCode
              </button>
              <button type="button" class="admin-btn" onClick={props.onClose}>Close</button>
            </Show>
          </Show>
        </div>
      </div>
    </div>
    </Portal>
  );
}

// RestartConfirm is the session-aware confirmation: it states exactly how many
// running sessions a restart will interrupt (including "0 running sessions" so
// "safe" is explicit, never implied by silence).
export function RestartConfirm(props: { restarting: boolean; onConfirm: () => void; onCancel: () => void }) {
  const count = runningSessionCount();
  return (
    <div class="ocu-confirm">
      <span classList={{ warn: count > 0 }}>
        <Show
          when={count > 0}
          fallback={<>0 running sessions — safe to restart. OpenCode will be briefly unavailable; sessions are preserved.</>}
        >
          ⚠ {count} running session{count === 1 ? "" : "s"} will be interrupted. The in-flight turn(s) stop; sessions and history are preserved.
        </Show>
      </span>
      <div class="admin-confirm-btns">
        <button type="button" class="admin-btn danger" disabled={props.restarting} onClick={props.onConfirm}>
          {props.restarting ? "Restarting…" : "Restart OpenCode"}
        </button>
        <button type="button" class="admin-btn" disabled={props.restarting} onClick={props.onCancel}>Cancel</button>
      </div>
    </div>
  );
}
