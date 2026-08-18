// Terminal pointer→cell mapping under UI zoom (terminal cousin of fc2ef59d).
//
// xterm.js v6 mixes px spaces inside its own coordinate math
// (src/browser/input/Mouse.ts, getCoords/getCoordsRelativeToElement): the
// pointer offset numerator `event.clientX - element.getBoundingClientRect().left`
// is in VIEWPORT/visual px (both visual under CSS zoom, Chromium ≥128 spec
// model), but the divisor `dimensions.css.cell.width/height` comes from
// CharSizeService — OffscreenCanvas measureText / offsetWidth — i.e. LAYOUT px.
// The computed cell index is therefore off by exactly the zoom factor: absent
// at 100%, scaled by z otherwise. Every consumer (SelectionService, mouse
// reporting via bindMouse, Linkifier hover) subtracts the SAME screenElement
// rect, so one seam-level normalization covers all of them.
//
// The fix lives at OUR integration seam (TerminalPane rewrites the event's
// clientX/clientY in a capture listener before xterm's handlers read them —
// see rewriteMouseEvent); the cell indicator (dogfooding the same mapping)
// consumes pointerToCell. All helpers here are PURE: rects/zoom/cols/rows are
// parameters, so jsdom-free unit tests pin the arithmetic with hand-derived
// values (web/tests/unit/termPointer.zoom.test.ts).

/** Minimal rect shape (getBoundingClientRect() satisfies this). */
export interface TermRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** A snapped cell hit plus the overlay geometry (layout px) to draw it. */
export interface CellHit {
  /** Whether the pointer is inside the screen element's visual bounds. */
  inside: boolean;
  /** 0-based, clamped cell column/row. */
  col: number;
  row: number;
  /** Layout-px translate for a cell-snapped overlay anchored at the host's
   *  top-left (left/top 0 of an absolutely-positioned child). */
  left: number;
  top: number;
  /** Layout-px cell size (visual rect / zoom / grid — zoom-invariant). */
  cellW: number;
  cellH: number;
}

/**
 * Layout-px pointer offset within an element whose visual rect is `screen`:
 * the visual-space difference (clientX − left) divided by zoom. Identity at
 * zoom = 1. This is the ONCE conversion at the boundary where units mix.
 */
export function pointerOffsetLayout(
  clientX: number,
  clientY: number,
  screen: { left: number; top: number },
  zoom: number,
): { x: number; y: number } {
  const z = zoom > 0 ? zoom : 1;
  return { x: (clientX - screen.left) / z, y: (clientY - screen.top) / z };
}

/**
 * Layout-px cell size implied by the screen element's VISUAL rect, the grid
 * shape, and zoom: (visual / zoom) / count. Zoom-invariant by construction —
 * the same physical terminal yields the same cell at any UI zoom.
 */
export function cellSizeLayout(
  screen: TermRect,
  zoom: number,
  cols: number,
  rows: number,
): { w: number; h: number } {
  const z = zoom > 0 ? zoom : 1;
  return { w: screen.width / z / Math.max(cols, 1), h: screen.height / z / Math.max(rows, 1) };
}

/**
 * 0-based cell index of a layout-px offset, clamped to the grid. Uses xterm's
 * own ceil-then-subtract snapping (getCoords: ceil(offset/cell) − 1), so a
 * point exactly ON a cell boundary belongs to the cell ending there — the
 * indicator predicts exactly what xterm will select (for real pointers the
 * boundary is measure-zero; the alignment matters for the dogfood contract).
 */
export function cellFromOffset(
  x: number,
  y: number,
  cellW: number,
  cellH: number,
  cols: number,
  rows: number,
): { col: number; row: number } {
  const col = Math.min(Math.max(Math.ceil(x / cellW) - 1, 0), Math.max(cols - 1, 0));
  const row = Math.min(Math.max(Math.ceil(y / cellH) - 1, 0), Math.max(rows - 1, 0));
  return { col, row };
}

/**
 * Full mapping for the cell indicator: a visual-px pointer, the screen
 * element's visual rect, the overlay host's visual rect, zoom, and the grid
 * shape → snapped cell + layout-px overlay geometry. The overlay positions in
 * the host's LAYOUT space, so the screen's origin within the host converts
 * too ((screen.left − host.left) / zoom).
 */
export function pointerToCell(
  clientX: number,
  clientY: number,
  screen: TermRect,
  host: { left: number; top: number },
  zoom: number,
  cols: number,
  rows: number,
): CellHit {
  const z = zoom > 0 ? zoom : 1;
  const inside =
    clientX >= screen.left &&
    clientX <= screen.left + screen.width &&
    clientY >= screen.top &&
    clientY <= screen.top + screen.height;
  const { w: cellW, h: cellH } = cellSizeLayout(screen, z, cols, rows);
  const off = pointerOffsetLayout(clientX, clientY, screen, z);
  const { col, row } = cellFromOffset(off.x, off.y, cellW, cellH, cols, rows);
  return {
    inside,
    col,
    row,
    left: (screen.left - host.left) / z + col * cellW,
    top: (screen.top - host.top) / z + row * cellH,
    cellW,
    cellH,
  };
}

/**
 * The xterm seam fix: viewport-px client coords rewritten so xterm's own
 * `clientX − rect.left` arithmetic (visual px) yields the LAYOUT-px offset.
 * Keeping the element's visual origin fixed and shrinking the pointer's
 * offset within it by zoom makes xterm's subsequent division by the
 * layout-px cell size unit-consistent. Identity at zoom = 1.
 */
export function normalizedClient(
  clientX: number,
  clientY: number,
  screen: { left: number; top: number },
  zoom: number,
): { clientX: number; clientY: number } {
  const z = zoom > 0 ? zoom : 1;
  return {
    clientX: screen.left + (clientX - screen.left) / z,
    clientY: screen.top + (clientY - screen.top) / z,
  };
}

/**
 * Rewrite a live MouseEvent in place: defineProperty own getters for
 * clientX/clientY that return the normalized values, shadowing the prototype
 * accessors. Capture-phase listeners on the terminal host run before any of
 * xterm's bubble listeners (element- or document-level), so every xterm
 * consumer reads the corrected coords from the SAME event object. Returns
 * whether a rewrite happened (false at zoom = 1 — nothing to fix, skip the
 * own-property work; false if the event object refuses the override).
 * PointerEvents (hostGesture, the indicator) are NOT passed here: those
 * consumers expect visual px.
 */
export function rewriteMouseEvent(
  e: { clientX: number; clientY: number },
  screen: { left: number; top: number },
  zoom: number,
): boolean {
  if (!(zoom > 0) || zoom === 1) return false;
  const n = normalizedClient(e.clientX, e.clientY, screen, zoom);
  try {
    Object.defineProperty(e, "clientX", { configurable: true, get: () => n.clientX });
    Object.defineProperty(e, "clientY", { configurable: true, get: () => n.clientY });
  } catch {
    return false; // exotic/frozen event object — leave the event untouched
  }
  return true;
}
