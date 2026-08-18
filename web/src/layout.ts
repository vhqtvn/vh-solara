// Sidebar layout: width (resizable, persisted) + collapsed (toggle, persisted).
// On desktop the sidebar is a resizable, collapsible flex column; on mobile it
// stays a slide-over driven by navOpen (collapse doesn't apply there).
import { createSignal } from "solid-js";
import { loadVersioned, saveVersioned } from "./lib/store";
import { widthTier } from "./shapeTier";

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

// ── Sidebar presentation mode (Phase 3 S2b) ──────────────────────────────────
// HOW the sidebar presents: "narrow" = the phone drawer (off-canvas, navOpen),
// "rail" = the compact always-visible rail band (560–720 visual px), "wide" =
// the full resizable inline column. When the width-tier signal is LIVE the
// tier IS the mode (visual px, zoom-normalized). When it is inert — kill-switch
// off, or the first observation hasn't landed yet (RO → rAF is async) — the
// legacy 721px matchMedia decision stands, making flag-off the EXACT pre-S2b
// revert. Note this is the sidebar PRESENTATION decision only; isDesktop()'s
// other consumers (CodeFrame overlay, ManagedPanel, ChatNavigator, code dock)
// are deliberately untouched and stay on the legacy breakpoint.
export type SidebarMode = "narrow" | "rail" | "wide";
export function sidebarMode(): SidebarMode {
  const t = widthTier();
  if (t !== null) return t;
  return isDesktop() ? "wide" : "narrow";
}
