import { createMemo } from "solid-js";
import { connected, focusedId, isMaximized, panes } from "../dockview/store";
import { SERVERS } from "../state/mockData";
import s from "./Statusbar.module.css";

/**
 * Bottom statusbar: connection dot · server count · focus: server · view ·
 * dockview renderer badge.
 */
export function Statusbar() {
  const focusPane = createMemo(() => {
    const id = focusedId();
    return panes().find((p) => p.id === id);
  });

  return (
    <div class={s.statusbar} data-testid="statusbar">
      <span class={s.dot} data-on={connected() ? "1" : "0"} title="host ⇄ pane heartbeats" />
      <span class={s.item}>
        {connected() ? "connected" : "connecting"}
      </span>
      <span class={s.sep}>·</span>
      <span class={s.item}>{SERVERS.length} servers</span>
      <span class={s.sep}>·</span>
      <span class={s.item}>
        focus:{" "}
        {focusPane()
          ? `${focusPane()!.server} · ${focusPane()!.view}`
          : "—"}
      </span>
      <span class={s.spacer} />
      <span class={s.badge} title="layout engine / render mode">
        dockview · renderer:always{isMaximized() ? " · maximized" : ""}
      </span>
    </div>
  );
}
