// @vitest-environment jsdom
//
// Terminal pointer→cell mapping under UI zoom (terminal cousin of fc2ef59d).
// xterm.js v6 mixes px spaces inside getCoords (src/browser/input/Mouse.ts):
// the offset numerator clientX − screenRect.left is VISUAL px, the cell-size
// divisor (CharSizeService → dimensions.css.cell) is LAYOUT px, so the
// computed cell index is off by exactly the zoom factor. lib/termPointer is
// the seam: rewriteMouseEvent fixes the events xterm sees;
// pointerToCell drives the cell indicator from the same mapping.
//
// These tests pin the arithmetic with hand-derived values (jsdom cannot apply
// CSS zoom). The dogfood assertions simulate xterm's own ceil-based math on
// the REWRITTEN coords and must reproduce pointerToCell's cell — that is the
// exact contract the seam exists for.
import { describe, expect, it } from "vitest";
import {
  cellFromOffset,
  cellSizeLayout,
  normalizedClient,
  pointerOffsetLayout,
  pointerToCell,
  rewriteMouseEvent,
} from "../../src/lib/termPointer";

// Fixture (all VISUAL px unless noted): an 80×24 terminal of 9×20 LAYOUT-px
// cells → screen visual size 720·z × 480·z; screen visual origin (24, 100);
// overlay host visual origin (16, 90); pointer at client (118, 210) — i.e.
// visual offset (94, 110) inside the screen.
const HOST = { left: 16, top: 90 };
const COLS = 80;
const ROWS = 24;
const screenAt = (z: number) => ({ left: 24, top: 100, width: 720 * z, height: 480 * z });

// xterm's own getCoords arithmetic (1-based ceil against the screen rect,
// then the consumer's −1; padding is 0 on .xterm-screen) — used to prove the
// rewritten coords land the cell pointerToCell says they should.
const xtermCell = (clientX: number, clientY: number, left: number, top: number, cellW: number, cellH: number) => ({
  col: Math.ceil((clientX - left) / cellW) - 1,
  row: Math.ceil((clientY - top) / cellH) - 1,
});

describe("pointerOffsetLayout", () => {
  it("zoom 1 is the identity", () => {
    expect(pointerOffsetLayout(118, 210, screenAt(1), 1)).toEqual({ x: 94, y: 110 });
  });
  it("125%: visual offsets shrink by 1.25 (94/1.25=75.2, 110/1.25=88)", () => {
    expect(pointerOffsetLayout(118, 210, screenAt(1.25), 1.25)).toEqual({ x: 75.2, y: 88 });
  });
  it("80%: visual offsets grow by 1/0.8 (94/0.8=117.5, 110/0.8=137.5)", () => {
    expect(pointerOffsetLayout(118, 210, screenAt(0.8), 0.8)).toEqual({ x: 117.5, y: 137.5 });
  });
});

describe("cellSizeLayout (zoom-invariant cell size)", () => {
  it("derives the 9×20 layout-px cell at every zoom", () => {
    for (const z of [1, 1.25, 0.8]) {
      expect(cellSizeLayout(screenAt(z), z, COLS, ROWS)).toEqual({ w: 9, h: 20 });
    }
  });
});

describe("cellFromOffset clamping", () => {
  it("snaps mid-cell offsets to the containing cell (xterm ceil semantics)", () => {
    expect(cellFromOffset(94, 110, 9, 20, COLS, ROWS)).toEqual({ col: 10, row: 5 });
  });
  it("an exact boundary belongs to the cell ending there (ceil−1), matching xterm", () => {
    // 240 = 12×20 exactly → xterm's ceil(240/20)−1 = 11, not floor's 12.
    expect(cellFromOffset(94, 240, 9, 20, COLS, ROWS)).toEqual({ col: 10, row: 11 });
  });
  it("clamps to the last cell (79, 23) at the far edge", () => {
    expect(cellFromOffset(719.9, 479.9, 9, 20, COLS, ROWS)).toEqual({ col: 79, row: 23 });
  });
  it("clamps negatives to (0, 0)", () => {
    expect(cellFromOffset(-5, -5, 9, 20, COLS, ROWS)).toEqual({ col: 0, row: 0 });
  });
});

describe("normalizedClient (the xterm seam rewrite)", () => {
  it("zoom 1 is the identity", () => {
    expect(normalizedClient(118, 210, screenAt(1), 1)).toEqual({ clientX: 118, clientY: 210 });
  });
  it("125%: keeps the screen origin, shrinks the offset (24+75.2, 100+88)", () => {
    expect(normalizedClient(118, 210, screenAt(1.25), 1.25)).toEqual({ clientX: 99.2, clientY: 188 });
  });
  it("80%: (24+117.5, 100+137.5)", () => {
    expect(normalizedClient(118, 210, screenAt(0.8), 0.8)).toEqual({ clientX: 141.5, clientY: 237.5 });
  });
});

describe("pointerToCell (indicator geometry) — identity, both directions, snap", () => {
  it("zoom 1: cell (10,5), translate (98,110) = screen-origin-in-host (8,10) + col·9/row·20", () => {
    const hit = pointerToCell(118, 210, screenAt(1), HOST, 1, COLS, ROWS);
    expect(hit.inside).toBe(true);
    expect(hit.col).toBe(10);
    expect(hit.row).toBe(5);
    expect(hit.left).toBeCloseTo(98, 6);
    expect(hit.top).toBeCloseTo(110, 6);
    expect(hit.cellW).toBe(9);
    expect(hit.cellH).toBe(20);
  });
  it("125%: cell (8,4), translate (6.4+72, 8+80) = (78.4, 88)", () => {
    const hit = pointerToCell(118, 210, screenAt(1.25), HOST, 1.25, COLS, ROWS);
    expect(hit.inside).toBe(true);
    expect(hit.col).toBe(8); // 75.2/9 = 8.355 → 8
    expect(hit.row).toBe(4); // 88/20 = 4.4 → 4
    expect(hit.left).toBeCloseTo(78.4, 6);
    expect(hit.top).toBeCloseTo(88, 6);
  });
  it("80%: cell (13,6), translate (10+117, 12.5+120) = (127, 132.5)", () => {
    const hit = pointerToCell(118, 210, screenAt(0.8), HOST, 0.8, COLS, ROWS);
    expect(hit.inside).toBe(true);
    expect(hit.col).toBe(13); // 117.5/9 = 13.055 → 13
    expect(hit.row).toBe(6); // 137.5/20 = 6.875 → 6
    expect(hit.left).toBeCloseTo(127, 6);
    expect(hit.top).toBeCloseTo(132.5, 6);
  });
  it("marks pointers outside the screen's visual bounds inside=false", () => {
    const hit = pointerToCell(500, 50, screenAt(1), HOST, 1, COLS, ROWS);
    expect(hit.inside).toBe(false);
  });
});

describe("dogfood: xterm's own math on the rewritten coords reproduces the cell", () => {
  // The contract of the seam: after rewriteMouseEvent, xterm's
  // ceil((clientX' − rect.left)/cellW) − 1 arithmetic must land exactly the
  // cell pointerToCell (the indicator, and the truth) says the pointer hit.
  it("holds at 1, 1.25 and 0.8", () => {
    for (const z of [1, 1.25, 0.8]) {
      const screen = screenAt(z);
      const hit = pointerToCell(118, 210, screen, HOST, z, COLS, ROWS);
      const n = normalizedClient(118, 210, screen, z);
      const xt = xtermCell(n.clientX, n.clientY, screen.left, screen.top, hit.cellW, hit.cellH);
      expect(xt.col).toBe(hit.col);
      expect(xt.row).toBe(hit.row);
    }
  });

  it("the diagnosis oracle: without the rewrite xterm is off by the zoom factor", () => {
    // Mission's worked example — 40-row terminal at the viewport origin
    // (screen visual top 0), 20 layout-px cells, touch at visual y=300, z=1.25.
    const z = 1.25;
    const screen = { left: 0, top: 0, width: 720 * z, height: 800 * z }; // 40 rows
    const truth = pointerToCell(0, 300, screen, { left: 0, top: 0 }, z, COLS, 40);
    // 300/1.25 = 240 layout px — exactly row-12's top boundary; xterm's
    // ceil−1 semantics assign it to row 11 (the cell ending at 240).
    expect(truth.row).toBe(11);
    // xterm on RAW visual coords: ceil(300/20) − 1 = 14 — three rows low.
    const raw = xtermCell(0, 300, screen.left, screen.top, truth.cellW, truth.cellH);
    expect(raw.row).toBe(14);
    // ...and on rewritten coords it matches the truth.
    const n = normalizedClient(0, 300, screen, z);
    const fixed = xtermCell(n.clientX, n.clientY, screen.left, screen.top, truth.cellW, truth.cellH);
    expect(fixed.row).toBe(truth.row);
  });
});

describe("rewriteMouseEvent (in-place event rewrite)", () => {
  it("defines own getters returning the normalized coords", () => {
    const e = new MouseEvent("mousedown", { clientX: 118, clientY: 210 });
    const rewrote = rewriteMouseEvent(e, screenAt(1.25), 1.25);
    expect(rewrote).toBe(true);
    expect(e.clientX).toBeCloseTo(99.2, 6);
    expect(e.clientY).toBeCloseTo(188, 6);
  });
  it("is a no-op at zoom 1 (returns false, event untouched)", () => {
    const e = new MouseEvent("mousedown", { clientX: 118, clientY: 210 });
    expect(rewriteMouseEvent(e, screenAt(1), 1)).toBe(false);
    expect(e.clientX).toBe(118);
    expect(Object.prototype.hasOwnProperty.call(e, "clientX")).toBe(false);
  });
});
