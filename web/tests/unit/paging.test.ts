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

// UX Slice 3 — the shared surface adapter's axis mapping (node env; plain
// structural objects stand in for scroller elements — SurfaceScroller is an
// interface on exactly the six fields the adapter reads, so no DOM/jsdom is
// needed). This is the ONLY geometry the adapters add: the x axis is a field
// rename onto the same pure functions above (no second paging engine).
import {
  axisGeometry,
  axisOverflows,
  type SurfaceScroller,
} from "../../src/components/einkSurfacePagingAxis";

const scroller = (o: Partial<SurfaceScroller>): SurfaceScroller => ({
  scrollTop: 0,
  scrollHeight: 0,
  clientHeight: 0,
  scrollLeft: 0,
  scrollWidth: 0,
  clientWidth: 0,
  ...o,
});

describe("axisGeometry — mapping a scroller onto PagingGeometry per axis", () => {
  it("maps the vertical axis 1:1", () => {
    const el = scroller({ scrollTop: 120, scrollHeight: 1500, clientHeight: 400 });
    expect(axisGeometry(el, "y")).toEqual({ scrollTop: 120, scrollHeight: 1500, clientHeight: 400 });
  });

  it("maps the horizontal axis onto the same numbers (field rename)", () => {
    const el = scroller({ scrollLeft: 80, scrollWidth: 2400, clientWidth: 360 });
    expect(axisGeometry(el, "x")).toEqual({ scrollTop: 80, scrollHeight: 2400, clientHeight: 360 });
  });

  it("feeds the pure stepper: one x page = clientWidth minus bounded overlap, clamped", () => {
    // 360px-wide pane, 2400px-wide code: overlap 54 (15% of 360), step 306.
    const el = scroller({ scrollLeft: 0, scrollWidth: 2400, clientWidth: 360 });
    const g = axisGeometry(el, "x");
    expect(pageForward(g)).toBe(360 - pageOverlap(360));
    // At the extent (2400 - 360 = 2040): forward is a no-op target.
    const atEnd = scroller({ scrollLeft: 2040, scrollWidth: 2400, clientWidth: 360 });
    const gEnd = axisGeometry(atEnd, "x");
    expect(pageForward(gEnd)).toBe(2040);
    expect(isEffectivePageMove(gEnd.scrollTop, pageForward(gEnd))).toBe(false);
  });

  it("keeps a bounded positive x step on a degenerate narrow pane", () => {
    const el = scroller({ scrollLeft: 0, scrollWidth: 900, clientWidth: 10 });
    expect(pageForward(axisGeometry(el, "x"))).toBe(MIN_PAGE_STEP_PX);
  });
});

describe("axisOverflows — the adapter's overflow gate", () => {
  it("is true only when the axis actually overflows (>1px, absorbing rounding)", () => {
    expect(axisOverflows(scroller({ scrollHeight: 1000, clientHeight: 300 }), "y")).toBe(true);
    expect(axisOverflows(scroller({ scrollHeight: 300, clientHeight: 300 }), "y")).toBe(false);
    expect(axisOverflows(scroller({ scrollHeight: 301, clientHeight: 300 }), "y")).toBe(false); // 1px = rounding
    expect(axisOverflows(scroller({ scrollHeight: 302.5, clientHeight: 300 }), "y")).toBe(true);
    expect(axisOverflows(scroller({ scrollWidth: 800, clientWidth: 300 }), "x")).toBe(true);
    expect(axisOverflows(scroller({ scrollWidth: 300, clientWidth: 300 }), "x")).toBe(false);
  });

  it("never gates ON for a fitting surface on the OTHER axis", () => {
    // Tall-but-narrow surface: vertical pager shows, horizontal does not.
    const el = scroller({ scrollHeight: 2000, clientHeight: 400, scrollWidth: 380, clientWidth: 400 });
    expect(axisOverflows(el, "y")).toBe(true);
    expect(axisOverflows(el, "x")).toBe(false);
  });
});
