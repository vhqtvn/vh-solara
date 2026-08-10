import { For, Show, createEffect, onCleanup, onMount } from "solid-js";
import { DockviewHost } from "./dockview/DockviewHost";
import { Tabstrip } from "./shell/Tabstrip";
import { Statusbar } from "./shell/Statusbar";
import {
  activeWorkspaceId,
  hostOps,
  panes,
  trayIds,
  workspaces,
} from "./dockview/store";
import { AddServer } from "./shell/AddServer";
import {
  installKeyboardFocus,
  onWorkspaceActivated,
  uninstallKeyboardFocus,
} from "./keyboardFocus";
import s from "./App.module.css";

/**
 * Host shell: top WORKSPACE tabstrip, a CSS-overlay stack of one DockviewHost
 * per workspace (all permanently mounted; switching is visibility-only so no
 * iframe ever reloads), an optional collapse-to-tray chip rail scoped to the
 * active workspace, and a bottom statusbar.
 *
 * SURVIVAL-SAFE OVERLAY STACK (load-bearing): every workspace's host is always
 * mounted and positioned absolutely (inset:0). Inactive hosts are
 * visibility:hidden + pointer-events:none + opacity:0; the active host is
 * visibility:visible + pointer-events:auto + opacity:1. This is NOT <Show> and
 * NOT display:none — both of those break Dockview's ResizeObserver bounding
 * boxes / unmount the host (proven: Dockview's auto-resize skips elements with
 * offsetParent===null, i.e. display:none; visibility:hidden keeps the box, so
 * Dockview sizes every host correctly even while hidden). Switching = CSS only;
 * every iframe survives every switch.
 *
 * The tray rail is host chrome AROUND a keep-mounted floating group: collapse
 * parks a pane (addFloatingGroup, never removePanel — rule #1) and the chip
 * restores it (moveTo back into the grid). The iframe survives both. Layout ops
 * are called through the typed HostOps controller surface (store.hostOps), not
 * the DEV-only window.__host test bridge — so this shell works in production.
 */
export function App() {
  // Ref to the host root (`.app`). Keyboard focus-mode overrides its inline
  // height on keyboard-open so the focused pane's iframe element shrinks to the
  // visible area (the host owns keyboard behavior — see keyboardFocus.ts).
  let appRoot!: HTMLDivElement;
  const trayPanes = () => {
    const ids = trayIds();
    return panes().filter((p) => ids.includes(p.id));
  };
  // The active workspace's grid is empty (e.g. a freshly-created workspace) →
  // show a centered Add-Server affordance instead of a blank grid.
  const activeEmpty = () => panes().length === 0;

  // Install keyboard focus-mode once the root element exists. The module
  // self-gates on touch-capability (no-op on desktop) and on a browser
  // visualViewport. onMount runs after the root div is mounted, so appRoot is
  // bound by the time the accessor fires.
  onMount(() => {
    installKeyboardFocus(() => appRoot);
  });
  onCleanup(() => {
    uninstallKeyboardFocus();
  });

  // While the keyboard is open and the operator switches workspace, re-point
  // focus-mode at the newly-active workspace's focused pane (exit the old
  // owned maximize, maximize the new one). No-op when the keyboard is closed.
  createEffect(() => {
    // track the active workspace signal so this fires on a switch.
    void activeWorkspaceId();
    onWorkspaceActivated();
  });

  return (
    <div class={s.app} ref={appRoot} data-testid="host-app-root">
      <Tabstrip />
      <main class={s.main}>
        {/* The overlay stack: one permanently-mounted host per workspace.
            SolidJS <For> preserves each host by referential identity of the
            workspace object. The store (a SolidJS store array, not a plain
            signal) NEVER recreates a Workspace object: addWorkspace appends,
            closeWorkspace splices, and renameWorkspace mutates ONLY the name
            field (setStore path-setter) — so a tab reorder, add, remove, or
            rename never recreates an existing host. A rename that spread a new
            object would remount the host → cold fromJSON → every iframe
            reloads; the field-only mutation is what keeps rename survival-safe. */}
        <For each={workspaces()}>
          {(ws) => (
            <div
              class={s.hostLayer}
              data-workspace={ws.id}
              data-active={ws.id === activeWorkspaceId() ? "1" : "0"}
              classList={{ [s.hostLayerActive]: ws.id === activeWorkspaceId() }}
            >
              <DockviewHost workspaceId={ws.id} />
            </div>
          )}
        </For>
        <Show when={activeEmpty()}>
          <div class={s.emptyOverlay} data-testid="empty-workspace">
            <div class={s.emptyCard}>
              <div class={s.emptyTitle}>This workspace is empty</div>
              <div class={s.emptyHint}>Add a server to get started.</div>
              <div class={s.emptyAction}>
                <AddServer />
              </div>
            </div>
          </div>
        </Show>
      </main>
      <Show when={trayPanes().length > 0}>
        <div class={s.trayRail}>
          <span class={s.trayLabel}>tray</span>
          <For each={trayPanes()}>
            {(p) => (
              <button
                type="button"
                class={s.trayChip}
                title={`Restore ${p.title}`}
                data-testid="tray-chip"
                data-pane={p.id}
                onClick={() => hostOps()?.restore?.(p.id)}
              >
                <span class={s.trayChipLabel}>{p.label}</span>
                <span class={s.trayChipRestore}>↩</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Statusbar />
    </div>
  );
}
