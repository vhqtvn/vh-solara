import { For, Show } from "solid-js";
import {
  activeWorkspaceId,
  addWorkspace,
  setActiveWorkspace,
  trayIds,
  workspaces,
} from "../dockview/store";
import { AddServer } from "./AddServer";
import s from "./Tabstrip.module.css";

/**
 * Top WORKSPACE tabstrip: brand + one tab per workspace + "+". Clicking a tab
 * switches the active workspace — a SURVIVAL-SAFE CSS-visibility-only switch
 * (App.tsx's overlay stack; no host is disposed, no iframe reloads). The "+"
 * creates a new empty workspace. Within the active workspace, panes are
 * represented by their own custom headers (iframeRenderer's per-pane header
 * with split/collapse/zoom/close), so the top bar no longer carries a per-pane
 * strip. Layout ops go through the typed HostOps controller surface
 * (store.hostOps), not the DEV-only window.__host test bridge, so this shell
 * works in production builds.
 */
export function Tabstrip() {
  return (
    <div class={s.tabstrip}>
      <div class={s.brand}>
        <span class={s.brandMark}>◈</span>
        <span class={s.brandText}>VHSolara</span>
        <span class={s.brandSub}>host</span>
      </div>
      <div class={s.tabs}>
        <For each={workspaces()}>
          {(ws) => (
            <button
              type="button"
              class={`${s.tab} ${activeWorkspaceId() === ws.id ? s.tabActive : ""}`}
              title={ws.name}
              data-testid="ws-tab"
              data-workspace={ws.id}
              onClick={() => setActiveWorkspace(ws.id)}
            >
              <span class={s.tabLabel}>{ws.name}</span>
            </button>
          )}
        </For>
      </div>
      <button
        type="button"
        class={s.plus}
        title="Add workspace"
        data-testid="ws-add"
        onClick={() => addWorkspace()}
      >
        +
      </button>
      <AddServer />
      <Show when={trayIds().length > 0}>
        <span class={s.trayBadge} title="Collapsed panes (active workspace)">
          tray: {trayIds().length}
        </span>
      </Show>
    </div>
  );
}
