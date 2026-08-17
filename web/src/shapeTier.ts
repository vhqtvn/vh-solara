// Height-tier responsiveness (Phase 3 S2a): the short-pane defense signal.
//
// The SPA had zero height awareness: in short panes (a 1200x300 landscape
// half, a 400x320 phone split) the chat scroll area is squeezed to ~68px while
// the hero, status row, and full-height composer keep their normal budgets
// (see the .jump clamp comment in 50-chat-overlays.css). This module derives a
// DISCRETE tier from the app element's height and publishes it as a
// `data-h-tier` attribute on `.app`, which the short-pane CSS defenses key off
// (`[data-h-tier="short"]` / `[data-h-tier="tiny"]` in the legacy shards).
//
// Visual-px normalization (the S0 containment constraint): `.app` height is
// `calc(var(--app-h,100dvh)/var(--ui-zoom,1))` (00-app-globals.css), so under
// desktop UI zoom a ResizeObserver on `.app` reports the LOCAL (zoom-divided)
// box. Tier thresholds are defined in VISUAL px, so the measured local height
// is multiplied by uiZoom() (lib/zoom.ts — the canonical accessor for the
// inline `--ui-zoom` on :root) before classification. Without this, zoom > 1
// over-reports "short" by exactly the zoom factor.
//
// The tier is shape-driven, not embed-driven: it applies to the real viewport
// everywhere (a short standalone /app window benefits the same as a short host
// pane). Width behavior is untouched (S2a is height-only; the 721px breakpoint
// and everything it drives stays exactly as-is).
//
// Kill-switch: the whole module is gated on a versioned persisted pref
// (`vh.prefs.shapeTier.v1`, default "on"). Only exactly "on" enables — any
// other stored value (an explicit "off", or a corrupted/foreign payload)
// keeps the module off: no attribute is ever set, no observer runs (and any
// stale attribute is cleared at install).
import { uiZoom } from "./lib/zoom";
import { persistedSignal } from "./lib/store";

export type HeightTier = "normal" | "short" | "tiny";

// --- TUNABLES (operator dials — starting values from the S2a debate) -------
// All values are VISUAL px (post zoom-normalization).
//
// TUNABLE: enter the "short" tier at (or below) this visual height.
export const SHORT_TIER_PX = 520;
// TUNABLE: enter the "tiny" tier at (or below) this visual height.
export const TINY_TIER_PX = 400;
// TUNABLE: hysteresis buffer applied when LEAVING a tier, so a pane hovering
// at a boundary doesn't flap (short is entered at <=520 but only left at
// >=536; tiny is entered at <=400 but only left at >=416). Entering a MORE
// defensive tier is immediate (no buffer); only the relaxation is buffered.
export const TIER_HYST_PX = 16;

const FLAG_KEY = "vh.prefs.shapeTier.v1";
const [shapeTierFlag] = persistedSignal(FLAG_KEY, 1, "on");

/**
 * Pure tier classification with hysteresis.
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

// Module-level current tier so JS consumers have a read accessor without
// touching the DOM attribute. CSS consumes only the data attribute.
let currentTier: HeightTier = "normal";

/** The current height tier ("normal" until the first observation lands). */
export function heightTier(): HeightTier {
  return currentTier;
}

/**
 * Install the height-tier observer on the app root (`.app`). Returns a cleanup
 * that disconnects the observer and resets the module tier. When the persisted
 * flag is "off", nothing is observed and any stale `data-h-tier` attribute is
 * removed (the operator kill-switch).
 *
 * RO callbacks are coalesced within one frame via rAF: a viewport drag can
 * deliver several observations per frame; only the latest height is applied,
 * once per frame. No debounce beyond that — RO already fires on settled
 * resize, and hysteresis covers boundary flapping.
 */
export function installShapeTier(appEl: HTMLElement): () => void {
  if (shapeTierFlag() !== "on") {
    appEl.removeAttribute("data-h-tier");
    return () => {};
  }
  const apply = (localH: number) => {
    // RO reports the LOCAL (zoom-divided) box; thresholds are VISUAL px.
    const visualH = localH * uiZoom();
    const next = classifyHeightTier(visualH, currentTier);
    currentTier = next;
    // Always set (not only on change) so the attribute exists after the first
    // observation — an explicit `data-h-tier="normal"` rather than absence.
    appEl.setAttribute("data-h-tier", next);
  };
  let pendingH: number | null = null;
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (pendingH != null) apply(pendingH);
  };
  const onObserve = (entries: ResizeObserverEntry[]) => {
    const last = entries[entries.length - 1];
    if (last) pendingH = last.contentRect.height;
    if (pendingH == null || scheduled) return;
    scheduled = true;
    requestAnimationFrame(flush);
  };
  const ro = new ResizeObserver(onObserve);
  ro.observe(appEl); // real browsers fire once immediately with the initial box
  return () => {
    ro.disconnect();
    scheduled = false;
    pendingH = null;
    currentTier = "normal";
    appEl.removeAttribute("data-h-tier");
  };
}
