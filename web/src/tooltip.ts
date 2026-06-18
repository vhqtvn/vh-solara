// Tooltip coordination. On a hover-capable pointer (mouse) tooltips show on
// hover as usual; on touch (the Fold/phones) auto-tooltips are suppressed — they
// otherwise stick after a tap — and the draggable "?" inspector drives them
// instead: drag it over an element and inspectAt tracks the pointer so the
// tooltip for whatever is underneath shows.
import { createSignal } from "solid-js";

export const hoverCapable =
  typeof matchMedia !== "undefined" && matchMedia("(hover: hover) and (pointer: fine)").matches;

export const [inspectAt, setInspectAt] = createSignal<{ x: number; y: number } | null>(null);

export interface Rectish {
  left: number;
  top: number;
  bottom: number;
  width: number;
}
export interface Size {
  width: number;
  height: number;
}

// Place the tooltip bubble relative to its anchor, clamped to the viewport.
// `x` is the bubble's horizontal centre (the bubble is rendered with
// translateX(-50%)), so we clamp the centre such that both edges (centre ±
// half the measured width) stay `margin` px inside the viewport — this is what
// stops a long tooltip near a screen edge from clipping. Vertically we flip the
// bubble above the anchor when it wouldn't fit below.
export function placeTooltip(
  rect: Rectish,
  viewport: Size,
  tip: Size,
  margin = 8,
  gap = 6,
): { x: number; y: number; above: boolean } {
  const above = rect.bottom + gap + tip.height + margin > viewport.height;
  const half = tip.width / 2;
  const center = rect.left + rect.width / 2;
  const min = margin + half;
  const max = viewport.width - margin - half;
  // If the bubble is wider than the usable width, centre it (it can't fit, so
  // overflow symmetrically rather than pinning to one side).
  const x = max < min ? viewport.width / 2 : Math.min(Math.max(min, center), max);
  const y = above ? rect.top - gap : rect.bottom + gap;
  return { x, y, above };
}
