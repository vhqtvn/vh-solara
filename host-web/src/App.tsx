import { For, Show } from "solid-js";
import { DockviewHost } from "./dockview/DockviewHost";
import { Tabstrip } from "./shell/Tabstrip";
import { Statusbar } from "./shell/Statusbar";
import { panes, trayIds } from "./dockview/store";
import s from "./App.module.css";

interface HostBridgeLike {
  restore?: (id: string) => void;
}
function bridge(): HostBridgeLike | undefined {
  return (window as unknown as { __host?: HostBridgeLike }).__host;
}

/**
 * Host shell: top workspace tabstrip, main Dockview layout-view, optional
 * collapse-to-tray chip rail, bottom statusbar.
 *
 * The tray rail is host chrome AROUND a keep-mounted floating group: collapse
 * parks a pane (addFloatingGroup, never removePanel — rule #1) and the chip
 * restores it (moveTo back into the grid). The iframe survives both.
 */
export function App() {
  const trayPanes = () => {
    const ids = trayIds();
    return panes().filter((p) => ids.includes(p.id));
  };

  return (
    <div class={s.app}>
      <Tabstrip />
      <main class={s.main}>
        <DockviewHost />
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
                onClick={() => bridge()?.restore?.(p.id)}
              >
                <span class={s.trayChipServer}>{p.server}</span>
                <span class={s.trayChipView}>{p.view}</span>
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
