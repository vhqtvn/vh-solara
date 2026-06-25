import { createResource, createSignal, Show } from "solid-js";
import { forceReload, resetLocalStorage, restartVhServer } from "../admin";
import { dismiss } from "../lib/a11y";
import Icon from "./Icon";
import OpenCodeUpdateDialog, { RestartConfirm } from "./OpenCodeUpdateDialog";

// Server-admin popup (versions + update/reload/restart + local-storage reset),
// opened by right-clicking / long-pressing the Settings button. Kept out of the
// Servers panel and Settings dialog so those stay focused on info/preferences.
export default function AdminMenu(props: { onClose: () => void }) {
  const [vhVer] = createResource(() =>
    fetch("/vh/version").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  );
  const [ocVer, { refetch: refetchVer }] = createResource(() =>
    fetch("/vh/opencode-version").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  );

  const [updateOpen, setUpdateOpen] = createSignal(false);
  const [reloading, setReloading] = createSignal(false);
  const [reloadedAt, setReloadedAt] = createSignal(0);
  const [confirmRestart, setConfirmRestart] = createSignal(false);
  const [restarting, setRestarting] = createSignal(false);
  const [restartMsg, setRestartMsg] = createSignal("");
  const [confirmReset, setConfirmReset] = createSignal(false);

  async function reloadServer() {
    setReloading(true);
    try {
      await fetch("/vh/reload", { method: "POST" });
      setReloadedAt(Date.now());
    } finally {
      setReloading(false);
    }
  }
  async function restartOpenCode() {
    setRestarting(true);
    setRestartMsg("");
    try {
      const res = await fetch("/vh/restart-opencode", { method: "POST" });
      setRestartMsg(res.ok ? "✓ restarted" : res.status === 501 ? "Not managed here" : "Restart failed");
      if (res.ok) void refetchVer();
    } catch {
      setRestartMsg("Restart failed");
    } finally {
      setRestarting(false);
      setConfirmRestart(false);
    }
  }

  // Stay open while the portaled update dialog owns the interaction (a click in
  // it reads as "outside" this menu; the dialog handles its own Escape).
  return (
    <div
      class="admin-menu"
      role="dialog"
      aria-label="Server admin"
      use:dismiss={() => { if (!updateOpen()) props.onClose(); }}
    >
      <div class="admin-head">Server admin</div>

      <div class="admin-rows">
        <div class="admin-ver">
          <span>VHSolara</span>
          <span class="admin-ver-val">{vhVer()?.version ?? "…"}</span>
        </div>
        <div class="admin-ver">
          <span>OpenCode</span>
          <span class="admin-ver-val">
            <Show when={ocVer()} fallback="checking…">
              {ocVer()!.running || ocVer()!.installed || "unknown"}
              <Show when={ocVer()!.restartNeeded}> · installed {ocVer()!.installed} (restart to apply)</Show>
              <Show when={!ocVer()!.restartNeeded && ocVer()!.updateAvailable}> → {ocVer()!.latest}</Show>
            </Show>
          </span>
        </div>
      </div>

      {/* Update OpenCode — opens the streaming-log dialog. */}
      <button
        type="button"
        class="admin-btn"
        classList={{ accent: !!ocVer()?.updateAvailable || !!ocVer()?.restartNeeded }}
        disabled={!ocVer()}
        onClick={() => setUpdateOpen(true)}
      >
        <Icon name="layers" size={14} />
        {!ocVer()
          ? "Checking…"
          : ocVer()!.restartNeeded
            ? "Apply OpenCode update…"
            : ocVer()!.updateAvailable
              ? "Update OpenCode…"
              : "Update OpenCode (reinstall)…"}
      </button>

      <button type="button" class="admin-btn" disabled={reloading()} onClick={reloadServer}>
        <Icon name="retry" size={14} /> {reloading() ? "Reloading…" : "Reload server state"}
      </button>
      <Show when={reloadedAt() > 0 && !reloading()}><span class="admin-ok">✓ rebuilt from OpenCode</span></Show>

      <button type="button" class="admin-btn" onClick={() => (props.onClose(), restartVhServer())}>
        <Icon name="retry" size={14} /> Restart vh server
      </button>

      {/* Restart OpenCode — session-aware confirmation. */}
      <Show
        when={!confirmRestart()}
        fallback={<RestartConfirm restarting={restarting()} onConfirm={restartOpenCode} onCancel={() => setConfirmRestart(false)} />}
      >
        <button type="button" class="admin-btn" onClick={() => (setRestartMsg(""), setConfirmRestart(true))}>
          <Icon name="retry" size={14} /> Restart OpenCode…
        </button>
        <Show when={restartMsg()}><span class="admin-ok">{restartMsg()}</span></Show>
      </Show>

      <div class="admin-sep" />

      <button type="button" class="admin-btn" onClick={() => (props.onClose(), void forceReload())}>
        <Icon name="retry" size={14} /> Force reload (clear cache)
      </button>

      {/* Reset local storage (corruption recovery) */}
      <Show
        when={!confirmReset()}
        fallback={
          <div class="admin-confirm">
            <span>⚠ Clears this app's local cache (selections, drafts, tree state) and reloads. Sessions on the server are untouched.</span>
            <div class="admin-confirm-btns">
              <button type="button" class="admin-btn danger" onClick={resetLocalStorage}>Reset & reload</button>
              <button type="button" class="admin-btn" onClick={() => setConfirmReset(false)}>Cancel</button>
            </div>
          </div>
        }
      >
        <button type="button" class="admin-btn" onClick={() => setConfirmReset(true)}>
          <Icon name="x" size={14} /> Reset local storage…
        </button>
      </Show>

      <Show when={updateOpen()}>
        <OpenCodeUpdateDialog onClose={() => (setUpdateOpen(false), void refetchVer())} />
      </Show>
    </div>
  );
}
