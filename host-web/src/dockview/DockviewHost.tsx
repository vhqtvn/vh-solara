import { onCleanup, onMount } from "solid-js";
import { createDockview, type DockviewApi } from "dockview-core";
import { IframeRenderer } from "./iframeRenderer";
import { HostController } from "./hostController";
import { applyColdRestore, installLayoutSaver } from "./layoutPersistence";
import type { HostOps } from "./types";
import { setHostOps } from "./store";
import { nextPaneId, resolveFleet } from "../state/mockData";

/**
 * SolidJS adapter around the imperative Dockview widget.
 *
 * PATTERN (proven by the Phase-0 spike): onMount → createDockview with an
 * imperative widget model + a component factory + `defaultRenderer: 'always'`.
 * There is NO reactive two-way binding: SolidJS signals mirror the dockview
 * state for the shell (tabstrip/statusbar); all layout mutations go through the
 * HostController, which calls the DockviewApi directly.
 *
 * `renderer: 'always'` (set both as the default AND per-panel) is the mechanism
 * that keeps each cross-origin <iframe> permanently mounted — only its
 * geometry/visibility changes. Removing it reloads iframes.
 */
export function DockviewHost() {
  let container!: HTMLDivElement;
  let api: DockviewApi | undefined;

  // Mutable ops object breaks the dockview↔controller creation cycle: the
  // factory captures it; the controller fills it after the api exists.
  const ops: HostOps = {};
  // Register the ops object so the shell (App, Tabstrip) can call layout ops
  // through the typed HostOps surface — NOT through the DEV-only test bridge.
  setHostOps(ops);
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

    // Controller wires events, installs HostOps (shell reads via store.hostOps),
    // and exposes window.__host as a DEV-only test bridge.
    new HostController(api, renderers, ops);

    // ---- COLD INIT: restore the saved layout exactly once, else seed. --------
    // HARD RULE: api.fromJSON() is COLD-RESTORE ONLY — it disposes + recreates
    // every panel, RELOADING every iframe (proven by the jsonReswap negative
    // control). It runs EXACTLY ONCE here, before any iframe has a live
    // identity. Runtime ops never call fromJSON; they mutate the live tree.
    // applyColdRestore is structurally one-shot (a second call is a cached
    // no-op), so no code path can drive a second restore.
    //
    // PRECEDENCE (defensible default, NOT canon): saved-layout-wins-with-
    // validation; fleet/mock seed is the fallback when no valid layout exists.
    const restored = applyColdRestore(api);
    if (!restored) seedInitialPanes(api);

    // Hook the debounced save AFTER cold init so the initial seed/restore does
    // not itself trigger a save — only subsequent user mutations persist.
    installLayoutSaver(api);
  });

  onCleanup(() => {
    api?.dispose();
  });

  return (
    <div class="dockview-root" ref={container}>
      {/* Dockview mounts its DOM here. Each pane's custom header + iframe are
          rendered by IframeRenderer inside the always-render overlay. */}
    </div>
  );
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
