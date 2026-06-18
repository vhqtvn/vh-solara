import { describe, expect, it } from "vitest";
import { placeTooltip } from "../../src/tooltip";

const viewport = { width: 1000, height: 800 };

describe("placeTooltip", () => {
  it("centres the bubble on the anchor when there's room", () => {
    const rect = { left: 400, top: 300, bottom: 320, width: 40 };
    const p = placeTooltip(rect, viewport, { width: 120, height: 28 });
    expect(p.x).toBe(420); // 400 + 40/2
    expect(p.above).toBe(false);
    expect(p.y).toBe(326); // bottom + gap
  });

  it("clamps so a wide bubble near the left edge keeps its left edge on-screen", () => {
    const rect = { left: 0, top: 300, bottom: 320, width: 30 };
    const p = placeTooltip(rect, viewport, { width: 280, height: 28 });
    // unclamped centre would be 15, putting the left edge at 15-140 = -125
    expect(p.x).toBe(148); // margin(8) + half(140)
    expect(p.x - 140).toBeGreaterThanOrEqual(8); // left edge inside margin
  });

  it("clamps so a wide bubble near the right edge keeps its right edge on-screen", () => {
    const rect = { left: 970, top: 300, bottom: 320, width: 30 };
    const p = placeTooltip(rect, viewport, { width: 280, height: 28 });
    expect(p.x).toBe(852); // vw(1000) - margin(8) - half(140)
    expect(p.x + 140).toBeLessThanOrEqual(992); // right edge inside margin
  });

  it("flips above the anchor when it would overflow the bottom", () => {
    const rect = { left: 400, top: 760, bottom: 790, width: 40 };
    const p = placeTooltip(rect, viewport, { width: 120, height: 60 });
    expect(p.above).toBe(true);
    expect(p.y).toBe(754); // top - gap
  });

  it("centres a bubble that's wider than the usable viewport", () => {
    const narrow = { width: 100, height: 800 };
    const rect = { left: 10, top: 300, bottom: 320, width: 20 };
    const p = placeTooltip(rect, narrow, { width: 280, height: 28 });
    expect(p.x).toBe(50); // viewport.width / 2
  });
});
