import { createMemo } from "solid-js";
import {
  connected,
  focusedId,
  isMaximized,
  livenessFor,
  panes,
} from "../dockview/store";
import { livenessLabel } from "../dockview/types";
import { resolveFleet } from "../state/mockData";
import s from "./Statusbar.module.css";

/**
 * Bottom statusbar: document-liveness dot+label (focused pane, Q1-C) · server
 * count · focus: server · view · dockview renderer badge.
 *
 * Q1-C (load-bearing): the dot+label reflect the FOCUSED pane's DOCUMENT
 * liveness — "document alive" / "reloaded" / "no recent signal" — NEVER a
 * realtime/SSE/stream-health wording. A heartbeat fires independently of SSE,
 * so this indicator must not be read as connection/realtime health. The internal
 * `connected` signal (any heartbeat ever accepted) is still read for the dot's
 * initial color before a pane is focused, but the LABEL is always Q1-C.
 */
export function Statusbar() {
  const focusPane = createMemo(() => {
    const id = focusedId();
    return panes().find((p) => p.id === id);
  });
  const focusLiveness = createMemo(() => {
    const id = focusedId();
    return id ? livenessFor(id) : null;
  });

  // resolveFleet() reads the runtimeServers() signal, so wrapping it in a memo
  // makes the count reactive: it updates when the operator adds/removes a server.
  // On a fresh mock context the catalog is empty → resolveFleet() returns the
  // mock fleet (4), matching the prior behavior.
  const fleet = createMemo(() => resolveFleet());

  // Dot state: prefer the focused pane's Q1-C liveness; fall back to the global
  // `connected` flag (any heartbeat ever) only when no pane is focused.
  const dotState = createMemo<"alive" | "reloaded" | "no-signal">(() => {
    const live = focusLiveness();
    if (live) return live;
    return connected() ? "alive" : "no-signal";
  });
  const labelText = createMemo(() => {
    const live = focusLiveness();
    return live ? livenessLabel(live) : connected() ? "document alive" : "no recent signal";
  });

  return (
    <div class={s.statusbar} data-testid="statusbar">
      <span
        class={s.dot}
        data-state={dotState()}
        title="focused pane document liveness"
      />
      <span class={s.item}>{labelText()}</span>
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
