import { describe, expect, it } from "vitest";
// Pure paging geometry (node env — no DOM, no jsdom opt-in needed; these are
// the geometry/clamping/boundedness contracts of web/src/lib/paging.ts).
import {
  MIN_PAGE_STEP_PX,
  PAGE_OVERLAP_MAX_PX,
  PAGE_OVERLAP_MIN_PX,
  clampScrollTop,
  isEffectivePageMove,
  maxScrollTop,
  pageBackward,
  pageForward,
  pageOverlap,
  pageStep,
} from "../../src/lib/paging";

describe("pageOverlap — bounded overlap from usable height", () => {
  it("is the height fraction inside the absolute band", () => {
    // 600 * 0.15 = 90 — inside [24, 96].
    expect(pageOverlap(600)).toBe(90);
    // Large viewport: fraction exceeds the cap → capped at 96.
    expect(pageOverlap(1200)).toBe(PAGE_OVERLAP_MAX_PX);
    expect(pageOverlap(1200)).toBe(96);
  });

  it("never drops below the minimum band on small viewports", () => {
    // 100 * 0.15 = 15 — below the 24 floor.
    expect(pageOverlap(100)).toBe(PAGE_OVERLAP_MIN_PX);
    expect(pageOverlap(100)).toBe(24);
    expect(pageOverlap(160)).toBe(24); // 24 = exactly the floor
    expect(pageOverlap(161)).toBe(24.15); // just above the floor: fraction wins
  });

  it("falls back to the band minimum for non-finite / non-positive heights", () => {
    expect(pageOverlap(0)).toBe(24);
    expect(pageOverlap(-50)).toBe(24);
    expect(pageOverlap(Number.NaN)).toBe(24);
    expect(pageOverlap(Number.POSITIVE_INFINITY)).toBe(24);
  });
});

describe("pageStep — bounded positive advance", () => {
  it("is usable height minus overlap on ordinary viewports", () => {
    expect(pageStep(600)).toBe(600 - 90); // 510
    expect(pageStep(1200)).toBe(1200 - 96); // 1104 (overlap capped)
  });

  it("stays strictly positive when the usable height collapses below the overlap", () => {
    // The degenerate regime: tiny viewports, keyboard squeeze. The step may
    // exceed the viewport; it may NEVER be <= 0 (paging must always move).
    for (const h of [1, 4, 8, 10, 16, 23, 24, 40]) {
      expect(pageStep(h)).toBeGreaterThanOrEqual(MIN_PAGE_STEP_PX);
      expect(pageStep(h)).toBeGreaterThan(0);
    }
    expect(pageStep(10)).toBe(MIN_PAGE_STEP_PX); // 10 - 24 < 0 → floored
  });

  it("is always >= the minimum step for every plausible height", () => {
    for (let h = 1; h <= 2000; h += 7) {
      expect(pageStep(h)).toBeGreaterThanOrEqual(MIN_PAGE_STEP_PX);
    }
  });
});

describe("maxScrollTop / clampScrollTop — extent clamping", () => {
  it("computes a non-negative extent", () => {
    expect(maxScrollTop({ scrollTop: 0, scrollHeight: 1000, clientHeight: 300 })).toBe(700);
    // Content shorter than the viewport: no scrollable range at all.
    expect(maxScrollTop({ scrollTop: 0, scrollHeight: 100, clientHeight: 300 })).toBe(0);
  });

  it("clamps into [0, extent]", () => {
    const g = { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 };
    expect(clampScrollTop(-50, g)).toBe(0);
    expect(clampScrollTop(400, g)).toBe(400);
    expect(clampScrollTop(9999, g)).toBe(700);
    // Degenerate geometry: everything clamps to 0.
    const degenerate = { scrollTop: 0, scrollHeight: 0, clientHeight: 0 };
    expect(clampScrollTop(100, degenerate)).toBe(0);
  });
});

describe("pageForward / pageBackward — one discrete viewport step", () => {
  it("advances by exactly one step mid-transcript (both directions, round trip)", () => {
    const step = pageStep(600); // 510
    const g = { scrollTop: 800, scrollHeight: 2000, clientHeight: 600 };
    expect(pageForward(g)).toBe(800 + step);
    expect(pageBackward(g)).toBe(800 - step);
    // Round-tripping forward then backward returns to the origin (no drift).
    const fwd = pageForward(g);
    expect(pageBackward({ ...g, scrollTop: fwd })).toBe(800);
  });

  it("clamps at the extent: Next at (or past) the tail resolves to the tail", () => {
    const g = { scrollTop: 1300, scrollHeight: 2000, clientHeight: 600 };
    expect(maxScrollTop(g)).toBe(1400);
    // 1300 + 510 = 1810 → clamped to 1400.
    expect(pageForward(g)).toBe(1400);
    // Already AT the extent: forward is a NO-OP target (== current).
    const atTail = { ...g, scrollTop: 1400 };
    expect(pageForward(atTail)).toBe(1400);
    expect(isEffectivePageMove(atTail.scrollTop, pageForward(atTail))).toBe(false);
  });

  it("clamps at the top: Prev at scrollTop 0 is a no-op target", () => {
    const g = { scrollTop: 0, scrollHeight: 2000, clientHeight: 600 };
    expect(pageBackward(g)).toBe(0);
    expect(isEffectivePageMove(g.scrollTop, pageBackward(g))).toBe(false);
    // Just above 0: clamped to 0, still effective (moved).
    const near = { scrollTop: 100, scrollHeight: 2000, clientHeight: 600 };
    expect(pageBackward(near)).toBe(0);
    expect(isEffectivePageMove(near.scrollTop, 0)).toBe(true);
  });

  it("keeps a bounded positive advance on a degenerate tiny viewport", () => {
    // clientHeight 8: step floors at MIN_PAGE_STEP_PX despite the overlap.
    const g = { scrollTop: 0, scrollHeight: 400, clientHeight: 8 };
    expect(pageForward(g)).toBe(MIN_PAGE_STEP_PX);
    const g2 = { scrollTop: 380, scrollHeight: 400, clientHeight: 8 };
    expect(pageForward(g2)).toBe(392); // 380 + 24, still inside the extent
  });
});

describe("isEffectivePageMove — the reading-intent discriminator", () => {
  it("marks real movement effective", () => {
    expect(isEffectivePageMove(100, 610)).toBe(true);
    expect(isEffectivePageMove(610, 100)).toBe(true);
  });

  it("marks no-ops (at the extent) ineffective so they preserve prior mode", () => {
    expect(isEffectivePageMove(1400, 1400)).toBe(false);
    expect(isEffectivePageMove(0, 0)).toBe(false);
  });

  it("absorbs sub-pixel drift within the epsilon", () => {
    expect(isEffectivePageMove(1400, 1400.5)).toBe(false);
    expect(isEffectivePageMove(1400, 1401)).toBe(false); // == epsilon
    expect(isEffectivePageMove(1400, 1401.5)).toBe(true);
  });
});
