// EinkSurfacePaging — pure axis-mapping helpers (UX Slice 3), split from the
// EinkSurfacePaging.tsx component so they carry NO solid-js/web import and
// stay importable from the node-env unit suite (web/tests/unit/paging.test.ts
// — the same pure-geometry discipline as lib/paging.ts itself).
//
// This is the ONLY geometry the Slice-3 adapters add: the horizontal axis is
// a FIELD RENAME onto the same pure lib/paging.ts functions (scrollTop/
// scrollHeight/clientHeight in, a clamped target out). There is no second
// paging engine.

import type { PagingGeometry } from "../lib/paging";

export type PagingAxis = "x" | "y";

// The structural shape axisGeometry reads. An interface (not HTMLElement) so
// the mapping is unit-testable in the node environment with plain objects —
// no DOM element construction needed.
export interface SurfaceScroller {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  scrollLeft: number;
  scrollWidth: number;
  clientWidth: number;
}

// Map a scroller onto the pure PagingGeometry for one axis.
export function axisGeometry(el: SurfaceScroller, axis: PagingAxis): PagingGeometry {
  return axis === "x"
    ? { scrollTop: el.scrollLeft, scrollHeight: el.scrollWidth, clientHeight: el.clientWidth }
    : { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
}

// Does the scroller overflow along the axis at all? (>1px absorbs subpixel
// rounding; a fitting surface renders no pager.)
export function axisOverflows(el: SurfaceScroller, axis: PagingAxis): boolean {
  return axis === "x" ? el.scrollWidth - el.clientWidth > 1 : el.scrollHeight - el.clientHeight > 1;
}
