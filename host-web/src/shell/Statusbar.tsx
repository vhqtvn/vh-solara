import { createMemo, Show } from "solid-js";
import {
  connected,
  focusedId,
  isMaximized,
  livenessFor,
  needsYouCount,
  panes,
  runningCount,
} from "../dockview/store";
import { livenessLabel } from "../dockview/types";
import { resolveFleet } from "../state/mockData";
import { next } from "../attentionNext";
import s from "./Statusbar.module.css";

/**
 * Bottom statusbar: document-liveness dot+label (focused pane, Q1-C) · server
 * count · focus: server · view · [P3 attention hub: N need you · M running + the
 * NEXT hero button] · dockview renderer badge.
 *
 * Q1-C (load-bearing): the dot+label reflect the FOCUSED pane's DOCUMENT
 * liveness — "document alive" / "reloaded" / "no recent signal" — NEVER a
 * realtime/SSE/stream-health wording. A heartbeat fires independently of SSE,
 * so this indicator must not be read as connection/realtime health. The internal
 * `connected` signal (any heartbeat ever accepted) is still read for the dot's
 * initial color before a pane is focused, but the LABEL is always Q1-C.
 *
 * P3 ATTENTION HUB. The "N need you · M running" text + the NEXT hero button are
 * DISTINCT from both the Q1-C liveness dot (document health) and the P1 per-pane
 * attention badge (a pane indicator): the hub is a STATUSBAR-LEVEL operator
 * action surface. N/M reflect the ACTIVE workspace only (ws-scoped; background-
 * workspace needs-you is carried by the per-workspace-tab badge from P1 — do not
 * duplicate). The NEXT button appears only when the active workspace has at least
 * one needs-you pane; clicking it routes to the highest-priority needy pane
 * system-wide (see attentionNext.ts). No GPU-heavy CSS: the only animation is a
 * slow opacity pulse, honored under prefers-reduced-motion (AGENTS.md
 * "Firefox/WebRender GPU gotchas").
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

  // P3 attention hub: N needs-you + M running in the ACTIVE workspace (signals
  // recomputed in store.ts on every status store + active-ws pane-list change).
  const need = createMemo(() => needsYouCount());
  const running = createMemo(() => runningCount());
  // The NEXT hero button shows only when the active workspace has a needs-you
  // pane (ws-scoped visibility — the locked choice). It pulses to draw the eye.
  const showNext = createMemo(() => need() > 0);

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
      {/* P3 attention hub: distinct from the Q1-C dot + the P1 per-pane badge. */}
      <span class={s.sep}>·</span>
      <span class={s.hub} data-testid="attention-hub">
        <span class={s.hubNeed} data-need={need() > 0 ? "1" : "0"}>
          {need()} need you
        </span>
        <span class={s.sep}>·</span>
        <span class={s.hubRun}>{running()} running</span>
      </span>
      <Show when={showNext()}>
        <button
          type="button"
          class={`${s.nextBtn} ${s["is-pulsing"]}`}
          data-testid="attention-next"
          title="Focus the highest-priority session that needs you"
          onClick={() => next()}
        >
          NEXT
        </button>
      </Show>
      <span class={s.spacer} />
      <span class={s.badge} title="layout engine / render mode">
        dockview · renderer:always{isMaximized() ? " · maximized" : ""}
      </span>
    </div>
  );
}
