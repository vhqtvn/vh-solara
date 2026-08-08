import { createMemo } from "solid-js";
import { connected, focusedId, isMaximized, panes } from "../dockview/store";
import { resolveFleet } from "../state/mockData";
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

  // resolveFleet() reads the runtimeServers() signal, so wrapping it in a memo
  // makes the count reactive: it updates when the operator adds/removes a server.
  // On a fresh mock context the catalog is empty → resolveFleet() returns the
  // mock fleet (4), matching the prior behavior.
  const fleet = createMemo(() => resolveFleet());

  return (
    <div class={s.statusbar} data-testid="statusbar">
      <span class={s.dot} data-on={connected() ? "1" : "0"} title="host ⇄ pane heartbeats" />
      <span class={s.item}>
        {connected() ? "connected" : "connecting"}
      </span>
      <span class={s.sep}>·</span>
      <span class={s.item}>{fleet().length} servers</span>
      <span class={s.sep}>·</span>
      <span class={s.item}>
        focus:{" "}
        {focusPane() ? focusPane()!.label : "—"}
      </span>
      <span class={s.spacer} />
      <span class={s.badge} title="layout engine / render mode">
        dockview · renderer:always{isMaximized() ? " · maximized" : ""}
      </span>
    </div>
  );
}
