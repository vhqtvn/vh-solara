import { createResource, createSignal, Show } from "solid-js";
import { forceReload, resetLocalStorage, restartVhServer } from "../admin";
import { dismiss } from "../lib/a11y";
import { setDiagLogOpen } from "../ui";
import Icon from "./Icon";
import OpenCodeUpdateDialog from "./OpenCodeUpdateDialog";
import RestartOpenCodeDialog from "./RestartOpenCodeDialog";

// Server-admin popup (versions + update/reload/restart + diagnostics), opened by
// right-clicking / long-pressing the Settings button. Kept out of the Servers
// panel and Settings dialog so those stay focused on info/preferences.
//
// Organized into three labeled sections:
//   • OpenCode          — version readout + Update / Restart
//   • VH Solara Server  — version readout + Rebuild state / Restart server
//   • Diagnostics       — Diagnostic log / Reset local storage / Force reload
//
// Update opens the existing centered OpenCodeUpdateDialog (the streaming install
// flow). Restart opens RestartOpenCodeDialog, a centered portaled overlay that
// hosts the shared RestartOpenCode component (autoConfirm) — the SOLE caller of
// /vh/restart-opencode. Both dialogs are portaled to <body>, so the dismiss
// guard below keeps this menu open while either is showing (their clicks read as
// "outside" this menu otherwise).
export default function AdminMenu(props: { onClose: () => void }) {
  const [vhVer] = createResource(() =>
    fetch("/vh/version").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  );
  const [ocVer, { refetch: refetchVer }] = createResource(() =>
    fetch("/vh/opencode-version").then((r) => (r.ok ? r.json() : null)).catch(() => null),
  );

  const [updateOpen, setUpdateOpen] = createSignal(false);
  const [restartOpen, setRestartOpen] = createSignal(false);
  const [reloading, setReloading] = createSignal(false);
  const [reloadedAt, setReloadedAt] = createSignal(0);
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

  // Stay open while a portaled dialog owns the interaction (a click in either
  // reads as "outside" this menu; the dialogs handle their own Escape).
  return (
    <div
      class="admin-menu"
      role="dialog"
      aria-label="Server admin"
      use:dismiss={() => {
        if (!updateOpen() && !restartOpen()) props.onClose();
      }}
    >
      <div class="admin-head">Server admin</div>

      {/* --- OpenCode --- */}
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
      {/* Update OpenCode — opens the streaming-log dialog, which owns the
          install (update/reinstall). The menu entry keeps a STABLE label
          regardless of version state so it never flips identity while npm
          resolves (the dialog carries the update-vs-reinstall nuance + the
          loading state). */}
      <div class="admin-btn-row">
        <button
          type="button"
          class="admin-btn"
          classList={{ accent: !!ocVer()?.updateAvailable || !!ocVer()?.restartNeeded }}
          disabled={!ocVer()}
          onClick={() => setUpdateOpen(true)}
        >
          <Icon name="layers" size={14} />
          {ocVer() ? "Update" : "Checking…"}
        </button>
        {/* Restart OpenCode — opens a centered portaled dialog hosting the
            shared RestartOpenCode (autoConfirm), so the session-aware
            confirmation shows immediately. RestartOpenCode remains the SOLE
            caller of /vh/restart-opencode; this entry only frames it. */}
        <button type="button" class="admin-btn" onClick={() => setRestartOpen(true)}>
          <Icon name="retry" size={14} /> Restart
        </button>
      </div>

      {/* --- VH Solara Server --- */}
      <div class="admin-ver">
        <span>VH Solara</span>
        <span class="admin-ver-val">{vhVer()?.version ?? "…"}</span>
      </div>
      <div class="admin-btn-row">
        <button type="button" class="admin-btn" disabled={reloading()} onClick={reloadServer}>
          <Icon name="retry" size={14} /> {reloading() ? "Rebuilding…" : "Rebuild state"}
        </button>
        <button type="button" class="admin-btn" onClick={() => (props.onClose(), restartVhServer())}>
          <Icon name="retry" size={14} /> Restart server
        </button>
      </div>
      <Show when={reloadedAt() > 0 && !reloading()}>
        <span class="admin-ok">✓ rebuilt from OpenCode</span>
      </Show>

      {/* --- Diagnostics --- */}
      <div class="admin-section-head">Diagnostics</div>
      <button type="button" class="admin-btn" onClick={() => (props.onClose(), setDiagLogOpen(true))}>
        <Icon name="info" size={14} /> Diagnostic log
      </button>

      {/* Reset local storage (corruption recovery) — kept as the inline confirm
          (self-contained, low-risk; a third centered dialog is not warranted). */}
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
          <Icon name="x" size={14} /> Reset local storage
        </button>
      </Show>

      <button type="button" class="admin-btn" onClick={() => (props.onClose(), void forceReload())}>
        <Icon name="retry" size={14} /> Force reload (clear cache)
      </button>

      <Show when={updateOpen()}>
        <OpenCodeUpdateDialog onClose={() => (setUpdateOpen(false), void refetchVer())} />
      </Show>
      <Show when={restartOpen()}>
        <RestartOpenCodeDialog
          onClose={() => setRestartOpen(false)}
          onRestarted={() => void refetchVer()}
        />
      </Show>
    </div>
  );
}
