import { For, Show } from "solid-js";
import { focusedId, panes, trayIds } from "../dockview/store";
import s from "./Tabstrip.module.css";

interface HostBridgeLike {
  split?: (id: string, dir: "right" | "down") => string | null;
  focus?: (id: string) => void;
}
function bridge(): HostBridgeLike | undefined {
  return (window as unknown as { __host?: HostBridgeLike }).__host;
}

/**
 * Top workspace tabstrip: brand + one tab per open pane + "+". Clicking a tab
 * focuses that pane — a survival-safe "switch tab" (just setActive, no layout
 * disposal). The "+" splits a new mock pane off the focused pane.
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
              onClick={() => bridge()?.focus?.(p.id)}
            >
              <span class={s.tabServer}>{p.server}</span>
              <span class={s.tabView}>{p.view}</span>
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
          if (id) bridge()?.split?.(id, "right");
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
