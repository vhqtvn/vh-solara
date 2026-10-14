// Pure viewport-paging geometry for the e-ink chat profile (UX Slice 1).
//
// The e-ink interaction model replaces continuous dragging with DISCRETE
// viewport steps over the existing mounted DOM: at each action we measure the
// CURRENT usable viewport height, advance by that height minus a bounded
// overlap (so the reader keeps context lines across the fold), and clamp to
// the current scroll extent. No CSS scroll-snap, no fragmented reader layout,
// no smooth interpolation — callers write scrollTop directly and instantly.
//
// Everything here is PURE: no DOM, no signals, no side effects — fully unit
// testable in isolation (web/tests/unit/paging.test.ts). The caller (ChatView)
// owns measurement-at-action-time and the follow-machine integration.
//
// Numeric constants are DESIGN CHOICES from the e-ink UX brief (§2: "a
// proposed 44 CSS px target … is a design choice, not a measured device
// fact"), not measured physical-device facts:
//   - overlap: 15% of the usable viewport height, clamped to [24, 96] px —
//     enough to keep ~1–3 text lines of context across a page boundary
//     without wasting a large fraction of a small viewport;
//   - minimum step: 24 px — paging must ALWAYS make progress (a non-moving
//     page button is unreachable content), even when the usable height
//     collapses below the overlap (tiny viewports, keyboard squeeze). A step
//     may exceed the viewport in that regime; it may never be ≤ 0.

export interface PagingGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

// Bounded overlap: fraction of usable height, clamped to an absolute band.
export const PAGE_OVERLAP_FRACTION = 0.15;
export const PAGE_OVERLAP_MIN_PX = 24;
export const PAGE_OVERLAP_MAX_PX = 96;
// Floor on the per-action advance: paging never degenerates to a no-op.
export const MIN_PAGE_STEP_PX = 24;

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

// The overlap retained between two consecutive page positions for a given
// usable (client) height. Non-finite / non-positive heights fall back to the
// minimum band value (the step floor keeps the action effective regardless).
export function pageOverlap(clientHeight: number): number {
  if (!Number.isFinite(clientHeight) || clientHeight <= 0) return PAGE_OVERLAP_MIN_PX;
  return clamp(clientHeight * PAGE_OVERLAP_FRACTION, PAGE_OVERLAP_MIN_PX, PAGE_OVERLAP_MAX_PX);
}

// The per-action advance for a given usable height: usable minus overlap,
// floored at a positive minimum so tiny viewports still page.
export function pageStep(clientHeight: number): number {
  return Math.max(MIN_PAGE_STEP_PX, clientHeight - pageOverlap(clientHeight));
}

// The maximum representable scrollTop for a geometry (>= 0).
export function maxScrollTop(g: PagingGeometry): number {
  return Math.max(0, g.scrollHeight - g.clientHeight);
}

// Clamp a scrollTop candidate into [0, extent].
export function clampScrollTop(value: number, g: PagingGeometry): number {
  return clamp(value, 0, maxScrollTop(g));
}

// Next-page target: advance one step toward the extent, clamped. At (or
// within a step of) the tail this equals the current scrollTop — the caller
// treats that as a no-op which preserves the reader's prior mode.
export function pageForward(g: PagingGeometry): number {
  return clampScrollTop(g.scrollTop + pageStep(g.clientHeight), g);
}

// Prev-page target: retreat one step toward the top, clamped. At (or within a
// step of) the top this equals the current scrollTop (no-op).
export function pageBackward(g: PagingGeometry): number {
  return clampScrollTop(g.scrollTop - pageStep(g.clientHeight), g);
}

// Did the action actually move the viewport? Only an EFFECTIVE page/turn
// action establishes reading intent; a no-op (already at the extent in the
// requested direction) preserves whatever mode the reader was in.
export function isEffectivePageMove(from: number, to: number, epsilon = 1): boolean {
  return Math.abs(to - from) > epsilon;
}
