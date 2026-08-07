import { onCleanup, onMount } from "solid-js";
import { createDockview, type DockviewApi } from "dockview-core";
import { IframeRenderer } from "./iframeRenderer";
import { HostController } from "./hostController";
import type { HostOps } from "./types";
import { setHostOps } from "./store";
import { INITIAL_PANES, nextPaneId } from "../state/mockData";

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

    seedInitialPanes(api);
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

/** Seed the initial multi-server, multi-view tiled layout. */
function seedInitialPanes(api: DockviewApi): void {
  if (INITIAL_PANES.length === 0) return;
  // First pane is absolute; the rest split relative to it into a 2x2-ish grid.
  const first = INITIAL_PANES[0];
  api.addPanel({
    id: nextPaneId(),
    component: "iframe",
    renderer: "always",
    params: { server: first.server, view: first.view },
  });

  for (let i = 1; i < INITIAL_PANES.length; i++) {
    const p = INITIAL_PANES[i];
    const dir = i % 2 === 1 ? "right" : "below";
    const ref = api.panels[0];
    api.addPanel({
      id: nextPaneId(),
      component: "iframe",
      renderer: "always",
      params: { server: p.server, view: p.view },
      position: { referencePanel: ref, direction: dir },
    });
  }
  // Focus the first pane so focus routing has a starting point.
  api.panels[0]?.api.setActive();
}
