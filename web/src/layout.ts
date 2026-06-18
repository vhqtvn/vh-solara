// Sidebar layout: width (resizable, persisted) + collapsed (toggle, persisted).
// On desktop the sidebar is a resizable, collapsible flex column; on mobile it
// stays a slide-over driven by navOpen (collapse doesn't apply there).
import { createSignal } from "solid-js";
import { loadVersioned, saveVersioned } from "./lib/store";

const LS_W = "vh.sidebar.w.v1";
const LS_C = "vh.sidebar.collapsed.v1";
export const MIN_W = 200;
export const MAX_W = 480;

const clampW = (w: number) => Math.max(MIN_W, Math.min(MAX_W, Math.round(w)));

const [sidebarWidth, setW] = createSignal(
  clampW(loadVersioned<number>(LS_W, 1, 280, (o) => Number(o) || 280)),
);
const [sidebarCollapsed, setC] = createSignal(
  loadVersioned<boolean>(LS_C, 1, false, (o) => o === 1 || o === "1" || o === true),
);

export function setSidebarWidth(w: number) {
  const c = clampW(w);
  setW(c);
  saveVersioned(LS_W, 1, c);
}
export function toggleSidebar() {
  const v = !sidebarCollapsed();
  setC(v);
  saveVersioned(LS_C, 1, v);
}

// Reactive desktop/mobile flag (mobile = slide-over, desktop = inline column).
const mq = window.matchMedia("(min-width: 721px)");
const [isDesktop, setDesktop] = createSignal(mq.matches);
mq.addEventListener?.("change", (e) => setDesktop(e.matches));

export { sidebarWidth, sidebarCollapsed, isDesktop };
