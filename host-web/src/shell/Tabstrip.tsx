import { For, Show } from "solid-js";
import { focusedId, hostOps, panes, trayIds } from "../dockview/store";
import s from "./Tabstrip.module.css";

/**
 * Top workspace tabstrip: brand + one tab per open pane + "+". Clicking a tab
 * focuses that pane — a survival-safe "switch tab" (just setActive, no layout
 * disposal). The "+" splits a new pane off the focused one: in MOCK mode it
 * cycles the next mock (server, view); in REAL-fleet mode (VITE_SERVERS) it
 * clones the focused pane's {url,label} (another view of the same server).
 * Layout ops go through the typed HostOps controller surface (store.hostOps),
 * not the DEV-only window.__host test bridge, so this shell works in production
 * builds.
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
        <For each={panes()}>
          {(p) => (
            <button
              type="button"
              class={`${s.tab} ${focusedId() === p.id ? s.tabActive : ""}`}
              title={p.title}
              data-testid="ws-tab"
              data-pane={p.id}
              onClick={() => hostOps()?.focusPane?.(p.id)}
            >
              <span class={s.tabLabel}>{p.label}</span>
            </button>
          )}
        </For>
      </div>
      <button
        type="button"
        class={s.plus}
        title="Add pane (split focused)"
        data-testid="ws-add"
        onClick={() => {
          const id = focusedId();
          if (id) hostOps()?.split?.(id, "right");
        }}
      >
        +
      </button>
      <Show when={trayIds().length > 0}>
        <span class={s.trayBadge} title="Collapsed panes">
          tray: {trayIds().length}
        </span>
      </Show>
    </div>
  );
}
