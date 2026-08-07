import { createSignal } from "solid-js";
import type { HostOps, PaneVm, PaneToHost, Survival, SurvivalBaseline } from "./types";

// Module-level singleton store. Signals created at module scope are fine in
// SolidJS: components that read them inside a tracking scope re-render on
// change. (Effects need a root — those live in the adapter component.)

const [panes, setPanes] = createSignal<PaneVm[]>([]);
const [focusedId, setFocusedId] = createSignal<string | null>(null);
const [trayIds, setTrayIds] = createSignal<string[]>([]);
const [isMaximized, setIsMaximized] = createSignal<boolean>(false);
const [connected, setConnected] = createSignal<boolean>(false);

export { panes, focusedId, trayIds, isMaximized, connected };

// ---- host imperative ops registry (set by DockviewHost, read by the shell) ----
// The shell (App, Tabstrip) calls layout ops through this typed HostOps surface
// instead of window.__host, so the shell never depends on the DEV-only test
// bridge. DockviewHost registers the same mutable `ops` object the
// HostController fills (installOps, onMount); the shell reads it with optional
// chaining — user clicks always land post-mount, so the methods are populated by
// then. This is the established shell⇄dockview sharing pattern (it mirrors the
// state mutators below): it is NOT DEV-gated and it is NOT the test bridge.
let hostOpsRef: HostOps | null = null;
export function setHostOps(ops: HostOps): void {
  hostOpsRef = ops;
}
export function hostOps(): HostOps | null {
  return hostOpsRef;
}

// ---- per-pane survival tracking (polled by the gate, not reactive) --------

const survivalMap = new Map<string, Survival>();
const baselineMap = new Map<string, SurvivalBaseline>();
// contentWindow → paneId, so the single message listener can route heartbeats.
const sourceMap = new WeakMap<Window, string>();

export function survivalFor(id: string): Survival | undefined {
  return survivalMap.get(id);
}
export function baselineFor(id: string): SurvivalBaseline | undefined {
  return baselineMap.get(id);
}
export function resetBaseline(id: string): void {
  // Force a fresh baseline from the current heartbeat (used after a known
  // reload, e.g. a negative control, so the NEXT assertion compares against
  // the post-reload identity).
  const s = survivalMap.get(id);
  if (s) baselineMap.set(id, { mountTs: s.mountTs, nonce: s.nonce, connId: s.connId });
  else baselineMap.delete(id);
}

export function unregisterPane(id: string): void {
  survivalMap.delete(id);
  baselineMap.delete(id);
  setPanes((list) => list.filter((p) => p.id !== id));
  setTrayIds((list) => list.filter((t) => t !== id));
  setFocusedId((cur) => (cur === id ? null : cur));
}

// ---- shell view-model mutators (called by the controller from dockview) ----

export function upsertPaneVm(vm: PaneVm): void {
  setPanes((list) => {
    const i = list.findIndex((p) => p.id === vm.id);
    if (i === -1) return [...list, vm];
    const copy = list.slice();
    copy[i] = vm;
    return copy;
  });
}

export function setFocused(id: string | null): void {
  setFocusedId(id);
}

export function setTray(ids: string[]): void {
  setTrayIds(ids);
}

export function addTray(id: string): void {
  setTrayIds((list) => (list.includes(id) ? list : [...list, id]));
}

export function removeTray(id: string): void {
  setTrayIds((list) => list.filter((t) => t !== id));
}

export function setMaximized(v: boolean): void {
  setIsMaximized(v);
}

// ---- central message router (ONE listener for all panes) ------------------

function onMessage(ev: MessageEvent): void {
  const data = ev.data as Partial<PaneToHost>;
  if (!data || typeof data !== "object" || typeof data.type !== "string") return;
  const paneId = sourceMap.get(ev.source as Window);
  if (!paneId) return; // not from a known pane iframe

  switch (data.type) {
    case "heartbeat": {
      const s: Survival = {
        mountTs: data.mountTs!,
        nonce: data.nonce!,
        uptime: data.uptime!,
        connId: data.connId ?? null,
        src: data.src ?? "",
        lastSeen: Date.now(),
      };
      survivalMap.set(paneId, s);
      if (!baselineMap.has(paneId)) {
        baselineMap.set(paneId, { mountTs: s.mountTs, nonce: s.nonce, connId: s.connId });
      }
      setConnected(true);
      break;
    }
    case "title": {
      setPanes((list) =>
        list.map((p) => (p.id === paneId ? { ...p, title: data.title! } : p)),
      );
      break;
    }
    case "route": {
      // route changes are accepted but not surfaced beyond the title for Phase 1
      break;
    }
    default:
      break;
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("message", onMessage);
}

// id → contentWindow reverse map (populated by the controller, used for
// host→pane focus/blur delivery). Kept here next to the forward map.
const cwById = new Map<string, Window>();
export function bindContentWindow(id: string, cw: Window): void {
  cwById.set(id, cw);
  sourceMap.set(cw, id);
}
export function lookupContentWindow(id: string): Window | null {
  return cwById.get(id) ?? null;
}
export function unbindContentWindow(id: string): void {
  cwById.delete(id);
}
