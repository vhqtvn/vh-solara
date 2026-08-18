// Shape-tier responsiveness (Phase 3 S2a heights + S2b widths).
//
// HEIGHT (S2a): the SPA had zero height awareness — in short panes (a 1200x300
// landscape half, a 400x320 phone split) the chat scroll area was squeezed to
// ~68px while the hero, status row, and full-height composer kept their normal
// budgets. This module derives a DISCRETE height tier from the app element's
// height and publishes it as a `data-h-tier` attribute on `.app`, which the
// short-pane CSS defenses key off (`[data-h-tier="short"]` / `[data-h-tier=
// "tiny"]` in the legacy shards).
//
// WIDTH (S2b): between 560–720 visual px — the common host-pane width — the
// SPA used to fall into the phone drawer mode (the legacy 721px breakpoint),
// hiding the session tree behind a toggle. That is wrong for monitoring panes.
// The width tier adds a middle mode: `narrow` (<560, phone drawer), `rail`
// (560–720, a compact always-visible rail sidebar so tree + chat coexist), and
// `wide` (>720, the full inline sidebar). Published as `data-w-tier` on `.app`;
// the rail presentation CSS keys off `[data-w-tier="rail"]` and the drawer off
// `[data-w-tier="narrow"]`. Sidebar MODE consumers (App's nav-toggle/back
// dismiss, Sidebar's rail conditionals) read `widthTier()` + `sidebarMode()`
// (layout.ts), NOT the legacy matchMedia.
//
// Visual-px normalization (the S0 containment constraint): `.app` height is
// `calc(var(--app-h,100dvh)/var(--ui-zoom,1))` (00-app-globals.css), so under
// desktop UI zoom a ResizeObserver on `.app` reports the LOCAL (zoom-divided)
// box — width likewise. Tier thresholds are defined in VISUAL px, so each
// measured local dimension is multiplied by uiZoom() (lib/zoom.ts — the
// canonical accessor for the inline `--ui-zoom` on :root) before
// classification. Without this, zoom > 1 over-reports tiers by exactly the
// zoom factor.
//
// The tiers are shape-driven, not embed-driven: they apply to the real
// viewport everywhere (a short/narrow standalone /app window benefits the same
// as a short/narrow host pane). ONE ResizeObserver on `.app` feeds BOTH axes:
// each observation carries a full contentRect, one rAF-coalesced flush
// classifies height AND width together (no second observer).
//
// Kill-switch: the whole module — BOTH axes — is gated on a versioned
// persisted pref (`vh.prefs.shapeTier.v1`, default "on"). Only exactly "on"
// enables — any other stored value (an explicit "off", or a corrupted/foreign
// payload) keeps the module off: NO attribute is ever set (neither
// data-h-tier nor data-w-tier), no observer runs, and any stale attributes are
// cleared at install. Flag-off is the exact pre-S2a/S2b revert: heights get no
// defenses and the width decision falls back to the legacy 721px matchMedia
// drawer/inline behavior (see sidebarMode in layout.ts).
import { createSignal } from "solid-js";
import { uiZoom } from "./lib/zoom";
import { persistedSignal } from "./lib/store";

export type HeightTier = "normal" | "short" | "tiny";
export type WidthTier = "narrow" | "rail" | "wide";

// --- TUNABLES (operator dials — starting values from the S2a/S2b debates) ---
// All values are VISUAL px (post zoom-normalization).
//
// TUNABLE: enter the "short" tier at (or below) this visual height.
export const SHORT_TIER_PX = 520;
// TUNABLE: enter the "tiny" tier at (or below) this visual height.
export const TINY_TIER_PX = 400;
// TUNABLE: the rail band starts at this visual width (narrow is anything
// strictly below it — 559 is narrow, 560 is rail).
export const W_TIER_RAIL_MIN = 560;
// TUNABLE: the rail band ends at (inclusive) this visual width; "wide" is
// anything strictly above it. 720 so that wide (>720) coincides with the
// legacy (min-width: 721px) desktop breakpoint at zoom 1 — the tier split
// never changes behavior for legacy-width panes, it only carves the new
// middle band out of what used to be drawer territory.
export const W_TIER_WIDE = 720;
// TUNABLE: hysteresis buffer applied when LEAVING a tier, so a pane hovering
// at a boundary doesn't flap (short is entered at <=520 but only left at
// >=536; tiny at <=400 / >=416; narrow left at >=576; rail left at >736).
// Entering a MORE compact tier is immediate (no buffer); only the relaxation
// is buffered.
export const TIER_HYST_PX = 16;

const FLAG_KEY = "vh.prefs.shapeTier.v1";
const [shapeTierFlag] = persistedSignal(FLAG_KEY, 1, "on");

/**
 * Pure height-tier classification with hysteresis.
 *
 * Entering a more defensive tier is immediate (visualH <= threshold); leaving
 * one requires clearing the threshold by TIER_HYST_PX (visualH >= threshold +
 * buffer). A jump that skips a tier (e.g. tiny -> normal on a big grow) leaves
 * directly — the buffer only holds the CURRENT tier, never an intermediate.
 */
export function classifyHeightTier(visualH: number, current: HeightTier): HeightTier {
  if (visualH <= TINY_TIER_PX) return "tiny";
  if (current === "tiny" && visualH < TINY_TIER_PX + TIER_HYST_PX) return "tiny";
  if (visualH <= SHORT_TIER_PX) return "short";
  if (current === "short" && visualH < SHORT_TIER_PX + TIER_HYST_PX) return "short";
  return "normal";
}

/**
 * Pure width-tier classification with hysteresis (the width twin of
 * classifyHeightTier). "Compact" is the defensive direction for width too:
 * entering narrow (from rail) or rail (from wide) is immediate; leaving needs
 * to clear the boundary by TIER_HYST_PX (narrow holds below 576; rail holds
 * through 736). A jump that skips a tier (narrow -> wide on a big grow) leaves
 * directly.
 *
 * Boundaries: narrow < 560; rail 560–720 (inclusive both ends); wide > 720.
 */
export function classifyWidthTier(visualW: number, current: WidthTier): WidthTier {
  if (visualW < W_TIER_RAIL_MIN) return "narrow";
  if (current === "narrow" && visualW < W_TIER_RAIL_MIN + TIER_HYST_PX) return "narrow";
  if (visualW <= W_TIER_WIDE) return "rail";
  if (current === "rail" && visualW <= W_TIER_WIDE + TIER_HYST_PX) return "rail";
  return "wide";
}

// Current tiers are Solid signals so JS consumers (sidebarMode in layout.ts,
// App's nav wiring, Sidebar's rail conditionals) re-derive REACTIVELY when an
// observation lands. CSS consumers never read these — they key off the
// data-h-tier / data-w-tier attributes below.
const [hTier, setHTier] = createSignal<HeightTier>("normal");
// Width starts NULL ("no live observation") rather than a tier: the null-ness
// is load-bearing for the flag-off / first-frame fallback in sidebarMode()
// (layout.ts), which must distinguish "signal live" from "signal inert".
// (heightTier() keeps its S2a "normal" default — no JS consumer ever needed
// inertness for heights; widths do, so the accessor is WidthTier | null.)
const [wTier, setWTier] = createSignal<WidthTier | null>(null);

/** The current height tier ("normal" until the first observation lands). */
export function heightTier(): HeightTier {
  return hTier();
}

/**
 * The current width tier, or null while the module is inert (kill-switch off)
 * or before the first observation has landed (RO -> rAF is async). Consumers
 * must treat null as "fall back to the legacy decision" — see sidebarMode().
 */
export function widthTier(): WidthTier | null {
  return wTier();
}

/**
 * Install the shape-tier observer (BOTH axes) on the app root (`.app`).
 * Returns a cleanup that disconnects the observer and resets the module
 * tiers. When the persisted flag is not exactly "on", nothing is observed and
 * any stale `data-h-tier` / `data-w-tier` attributes are removed (the
 * operator kill-switch — it governs BOTH axes at once).
 *
 * RO callbacks are coalesced within one frame via rAF: a viewport drag can
 * deliver several observations per frame; only the latest box is applied,
 * once per frame. No debounce beyond that — RO already fires on settled
 * resize, and hysteresis covers boundary flapping.
 */
export function installShapeTier(appEl: HTMLElement): () => void {
  if (shapeTierFlag() !== "on") {
    appEl.removeAttribute("data-h-tier");
    appEl.removeAttribute("data-w-tier");
    return () => {};
  }
  const apply = (localW: number, localH: number) => {
    // RO reports the LOCAL (zoom-divided) box; thresholds are VISUAL px.
    const zoom = uiZoom();
    const nextH = classifyHeightTier(localH * zoom, hTier());
    const nextW = classifyWidthTier(localW * zoom, wTier() ?? "wide");
    setHTier(nextH);
    setWTier(nextW);
    // Always set (not only on change) so the attributes exist after the first
    // observation — an explicit `data-h-tier="normal"` / `data-w-tier="wide"`
    // rather than absence (presence itself is what separates "signal live"
    // from "kill-switch off" in the CSS gating).
    appEl.setAttribute("data-h-tier", nextH);
    appEl.setAttribute("data-w-tier", nextW);
  };
  let pending: { w: number; h: number } | null = null;
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (pending != null) apply(pending.w, pending.h);
  };
  const onObserve = (entries: ResizeObserverEntry[]) => {
    const last = entries[entries.length - 1];
    if (last) pending = { w: last.contentRect.width, h: last.contentRect.height };
    if (pending == null || scheduled) return;
    scheduled = true;
    requestAnimationFrame(flush);
  };
  const ro = new ResizeObserver(onObserve);
  ro.observe(appEl); // real browsers fire once immediately with the initial box
  return () => {
    ro.disconnect();
    scheduled = false;
    pending = null;
    setHTier("normal");
    setWTier(null);
    appEl.removeAttribute("data-h-tier");
    appEl.removeAttribute("data-w-tier");
  };
}
