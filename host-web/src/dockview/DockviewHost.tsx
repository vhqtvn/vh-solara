import { createEffect, onCleanup, onMount } from "solid-js";
import { createDockview, type DockviewApi } from "dockview-core";
import { IframeRenderer } from "./iframeRenderer";
import { HostController } from "./hostController";
import {
  applyColdRestoreForWorkspace,
  installLayoutSaver,
} from "./layoutPersistence";
import type { HostOps } from "./types";
import {
  activeWorkspaceId,
  clearDisplayFor,
  registerWorkspaceApi,
  registerWorkspaceOps,
  registerWorkspaceSync,
  setHostOps,
  shouldSeedWorkspace,
} from "./store";
import { nextPaneId, resolveFleet } from "../state/mockData";

/**
 * SolidJS adapter around the imperative Dockview widget — ONE INSTANCE PER
 * WORKSPACE.
 *
 * PATTERN (proven by the Phase-0 spike): onMount → createDockview with an
 * imperative widget model + a component factory + `defaultRenderer: 'always'`.
 * There is NO reactive two-way binding: SolidJS signals mirror the dockview
 * state for the shell (tabstrip + layout overlay); all layout mutations go
 * through the HostController, which calls the DockviewApi directly.
 *
 * `renderer: 'always'` (set both as the default AND per-panel) is the mechanism
 * that keeps each cross-origin <iframe> permanently mounted — only its
 * geometry/visibility changes. Removing it reloads iframes.
 *
 * MULTI-WORKSPACE (survival-safe overlay stack): App.tsx renders a `<For>` of
 * these hosts, one per workspace, stacked via CSS visibility (see App.module
 * .hostLayer). Every host stays permanently mounted; switching workspaces is
 * CSS-visibility-only and never touches any api/fromJSON, so no iframe ever
 * reloads on a switch. On becoming active, the host calls api.layout() so a
 * previously-hidden host recomputes its dimensions after becoming visible
 * (belt-and-suspenders: visibility:hidden keeps the layout box, so Dockview's
 * ResizeObserver already has the right size, but this forces a recompute).
 */
export function DockviewHost(props: { workspaceId: string }) {
  let container!: HTMLDivElement;
  let api: DockviewApi | undefined;
  let controller: HostController | undefined;
  // Resize-smoothing drag toggle (assigned in onMount; detached in onCleanup).
  // See the onMount block for the rationale.
  let onGeometryDragStart: ((ev: PointerEvent) => void) | undefined;
  let onGeometryDragEnd: (() => void) | undefined;

  // Mutable ops object breaks the dockview↔controller creation cycle: the
  // factory captures it; the controller fills it after the api exists.
  const ops: HostOps = {};
  const renderers = new Map<string, IframeRenderer>();

  onMount(() => {
    api = createDockview(container, {
      createComponent: (opts) => {
        const r = new IframeRenderer(ops);
        renderers.set(opts.id, r);
        return r;
      },
      defaultRenderer: "always",
      // Keep dnd on so native sash + group drag-rearrange work; cross-origin
      // iframes are unaffected (they live in the overlay container).
      disableDnd: false,
    });

    // Register the api + ops + sync callback with the store BEFORE the
    // controller runs (the bridge + hostOps() resolve through these).
    registerWorkspaceApi(props.workspaceId, api);
    registerWorkspaceOps(props.workspaceId, ops);
    // Legacy single-facet fallback: the first host to mount registers its ops
    // so hostOps() works during the brief cold-init window before every
    // workspace has registered. The active-workspace facet takes precedence.
    registerLegacyHostOps(ops);

    // Controller wires events, installs HostOps (shell reads via store.hostOps),
    // and exposes window.__host as a DEV-only test bridge (singleton).
    controller = new HostController(props.workspaceId, api, renderers, ops);
    // Register the become-active re-sync so switching to this workspace re-
    // projects the display signals from this api.
    registerWorkspaceSync(props.workspaceId, () => controller?.syncAll());

    // ---- COLD INIT: restore the saved layout exactly once for THIS workspace,
    //      else seed (default ws only), else empty. ---------------------------
    // HARD RULE: api.fromJSON() is COLD-RESTORE ONLY — it disposes + recreates
    // every panel IN THIS WORKSPACE, RELOADING every iframe in it (proven by
    // the jsonReswap negative control). It runs EXACTLY ONCE here per workspace,
    // before any iframe has a live identity. Runtime ops never call fromJSON;
    // they mutate the live tree. applyColdRestoreForWorkspace is structurally
    // one-shot per workspace id (a second call is a cached no-op), so no code
    // path can drive a second restore.
    const restored = applyColdRestoreForWorkspace(api, props.workspaceId);
    if (!restored) {
      if (shouldSeedWorkspace(props.workspaceId)) {
        seedInitialPanes(api);
      }
      // else: empty workspace (e.g. a runtime-added workspace) — the
      // empty-workspace affordance prompts Add Server.
    }

    // Hook the debounced save AFTER cold init so the initial seed/restore does
    // not itself trigger a save — only subsequent user mutations persist.
    installLayoutSaver(api);

    // If this host is already active at mount (the default workspace on a cold
    // load, or a freshly-added workspace), project its display signals now.
    if (activeWorkspaceId() === props.workspaceId) {
      controller.syncAll();
    }

    // ---- resize-smoothing drag toggle ---------------------------------------
    // The pane-overlay geometry transition (dockviewOverrides.css) smooths
    // DISCRETE layout ops (split/swap/orientation-flip) but must NOT apply
    // during CONTINUOUS geometry drags — a 0.12s transition retargeted on every
    // pointermove frame makes a sash resize / floating-window drag feel laggy
    // and rubber-banded. Dockview core exposes no public sash-drag-start event
    // (only the internal Splitview onDidSashEnd), so toggle a marker class from
    // the DOM gesture itself: a CAPTURE-phase pointerdown on any continuous-drag
    // affordance (.dv-sash, .dv-floating-titlebar, .dv-resize-handle-*) adds
    // `.dv-geometry-dragging` to this host root; window-level pointerup /
    // pointercancel removes it (the same end-signal set Dockview's own sash
    // drag uses, plus pointercancel). Capture phase so an element-level handler
    // that stops propagation cannot hide a drag start from us. Discrete ops
    // (overlay split/swap buttons, drop-based rearrange) never touch these
    // affordances, so they keep the smoothing transition.
    const DRAG_AFFORDANCE_SEL =
      ".dv-sash, .dv-floating-titlebar, [class^='dv-resize-handle-'], [class*=' dv-resize-handle-']";
    onGeometryDragStart = (ev: PointerEvent): void => {
      if (ev.target instanceof Element && ev.target.closest(DRAG_AFFORDANCE_SEL)) {
        container.classList.add("dv-geometry-dragging");
      }
    };
    onGeometryDragEnd = (): void => {
      container.classList.remove("dv-geometry-dragging");
    };
    container.addEventListener("pointerdown", onGeometryDragStart, true);
    window.addEventListener("pointerup", onGeometryDragEnd, true);
    window.addEventListener("pointercancel", onGeometryDragEnd, true);
  });

  // On becoming active, recompute dimensions (a previously-hidden host may need
  // a layout() nudge) + re-project the display signals. createEffect tracks
  // activeWorkspaceId(); it fires whenever the active workspace changes.
  createEffect(() => {
    const isActive = activeWorkspaceId() === props.workspaceId;
    if (!api) return;
    if (isActive) {
      // Force Dockview to re-read its container size after becoming visible.
      // visibility:hidden keeps the box, so this is belt-and-suspenders, but it
      // guarantees correct geometry after a switch in every browser.
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w > 0 && h > 0) api.layout(w, h);
      controller?.syncAll();
    }
  });

  onCleanup(() => {
    if (onGeometryDragStart) {
      container.removeEventListener("pointerdown", onGeometryDragStart, true);
    }
    if (onGeometryDragEnd) {
      window.removeEventListener("pointerup", onGeometryDragEnd, true);
      window.removeEventListener("pointercancel", onGeometryDragEnd, true);
    }
    controller?.dispose();
    clearDisplayFor(props.workspaceId);
    api?.dispose();
  });

  return (
    <div class="dockview-root" ref={container}>
      {/* Dockview mounts its DOM here. Each pane's custom header + iframe are
          rendered by IframeRenderer inside the always-render overlay. */}
    </div>
  );
}

/** Legacy single-facet registration: the first host to mount wins. Kept so
 *  hostOps() works during the cold-init window before every workspace has
 *  registered its facet. The active-workspace facet (workspaceOpsByWs) takes
 *  precedence in store.hostOps(). */
let legacyOpsRegistered = false;
function registerLegacyHostOps(ops: HostOps): void {
  if (legacyOpsRegistered) return;
  legacyOpsRegistered = true;
  setHostOps(ops);
}

/**
 * Seed the initial tiled layout from the resolved fleet. resolveFleet() returns
 * REAL servers (VITE_SERVERS) when configured, else the mock fleet (DEFAULT).
 * Each entry becomes one pane carrying its full {url,label}; the url is the
 * iframe src (set once, never mutated) and the label is the single display
 * string. Behavior in mock mode is identical to the prior hardcoded seed (same
 * urls → mock content page → same heartbeats → survival gate stays green).
 */
function seedInitialPanes(api: DockviewApi): void {
  const fleet = resolveFleet();
  if (fleet.length === 0) return;
  // First pane is absolute; the rest split relative to it into a 2x2-ish grid.
  const first = fleet[0];
  api.addPanel({
    id: nextPaneId(),
    component: "iframe",
    renderer: "always",
    params: { url: first.url, label: first.label },
  });

  for (let i = 1; i < fleet.length; i++) {
    const p = fleet[i];
    const dir = i % 2 === 1 ? "right" : "below";
    const ref = api.panels[0];
    api.addPanel({
      id: nextPaneId(),
      component: "iframe",
      renderer: "always",
      params: { url: p.url, label: p.label },
      position: { referencePanel: ref, direction: dir },
    });
  }
  // Focus the first pane so focus routing has a starting point.
  api.panels[0]?.api.setActive();
}
