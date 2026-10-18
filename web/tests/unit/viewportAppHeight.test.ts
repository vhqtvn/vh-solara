// @vitest-environment jsdom
//
// --app-h drift contract (src/viewport.ts). Bug: "the input field keeps
// overflowing after a while" — a stale/too-large --app-h latched with no
// correction, so .app overflowed the iframe and clipped the composer below the
// screen. Pins: (1) the height is clamped to the frame's layout viewport and
// ignores 0 samples; (2) it re-syncs on non-resize signals (visibilitychange,
// pageshow, focus, explicit resyncViewport) instead of only on resize edges;
// (3) fractional-DPR geometry is FLOORED, never rounded past the viewport —
// the sampler may only make the app root shorter than the viewport, never
// taller (mirror of the host-shell fix, commit 82360d1).
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { computeAppHeight, installViewport, resyncViewport } from "../../src/viewport";

type FakeWin = { innerHeight: number; visualViewport?: { height: number } | null };
const win = (innerHeight: number, vvHeight?: number | null): Window =>
  ({
    innerHeight,
    visualViewport: vvHeight === undefined || vvHeight === null ? null : { height: vvHeight },
  }) as FakeWin as unknown as Window;

describe("computeAppHeight", () => {
  it("uses visualViewport.height when it is the smaller (keyboard) value", () => {
    expect(computeAppHeight(win(800, 420.4))).toBe(420);
  });
  it("clamps a stale/too-large vv sample to the layout viewport", () => {
    expect(computeAppHeight(win(600, 900))).toBe(600);
  });
  it("falls back to innerHeight without visualViewport", () => {
    expect(computeAppHeight(win(700))).toBe(700);
  });
  it("falls back to innerHeight when vv reports 0", () => {
    expect(computeAppHeight(win(700, 0))).toBe(700);
  });
  it("returns null for a collapsed frame (keep last good value)", () => {
    expect(computeAppHeight(win(0, 0))).toBeNull();
  });
  it("floors a fractional layout viewport (never rounds past it)", () => {
    // Fractional-DPR viewports (e.g. Android DPR 2.625) report innerHeight
    // N.6. Math.round produced N+1 → .app 1px taller than the frame's
    // viewport → scrollingElement.scrollHeight > clientHeight → a 1px scroll
    // range (the host-shell 82360d1 bug class). The sampler may only make
    // the app root SHORTER than the viewport, never taller.
    expect(computeAppHeight(win(740.6))).toBe(740);
  });
  it("floors a fractional visual-viewport (keyboard) sample", () => {
    // vv 421.6 with the keyboard open: round → 422 would sit 0.4px past the
    // visible band's bottom edge.
    expect(computeAppHeight(win(800, 421.6))).toBe(421);
  });
  it("floors after clamping a stale-large vv to a fractional layout viewport", () => {
    expect(computeAppHeight(win(740.6, 900))).toBe(740);
  });
});

describe("installViewport re-sync", () => {
  let vvHeight = 800;
  const appH = () => document.documentElement.style.getPropertyValue("--app-h");

  beforeAll(() => {
    Object.defineProperty(window, "innerHeight", { configurable: true, get: () => 800 });
    // defineProperty (not Object.assign, which would snapshot the getter).
    const vv = new EventTarget();
    Object.defineProperty(vv, "height", { configurable: true, get: () => vvHeight });
    Object.defineProperty(window, "visualViewport", { configurable: true, value: vv });
    installViewport();
  });
  beforeEach(() => {
    vvHeight = 800;
    resyncViewport();
  });

  it("sets --app-h at install", () => {
    expect(appH()).toBe("800px");
  });

  it("re-syncs on visibilitychange without any resize event", () => {
    vvHeight = 500;
    document.dispatchEvent(new Event("visibilitychange"));
    expect(appH()).toBe("500px");
  });

  it("re-syncs on pageshow and focus", () => {
    vvHeight = 450;
    window.dispatchEvent(new Event("pageshow"));
    expect(appH()).toBe("450px");
    vvHeight = 610;
    window.dispatchEvent(new Event("focus"));
    expect(appH()).toBe("610px");
  });

  it("resyncViewport() recovers from a latched too-tall value", () => {
    document.documentElement.style.setProperty("--app-h", "1200px");
    resyncViewport();
    expect(appH()).toBe("800px");
  });

  it("ignores a 0 sample (hidden frame) and keeps the last good value", () => {
    vvHeight = 300;
    resyncViewport();
    Object.defineProperty(window, "innerHeight", { configurable: true, get: () => 0 });
    vvHeight = 0;
    resyncViewport();
    expect(appH()).toBe("300px");
    Object.defineProperty(window, "innerHeight", { configurable: true, get: () => 800 });
  });

  it("writes a floored --app-h on fractional geometry (never N+1)", () => {
    Object.defineProperty(window, "innerHeight", { configurable: true, get: () => 740.6 });
    vvHeight = 740.6;
    resyncViewport();
    expect(appH()).toBe("740px");
    Object.defineProperty(window, "innerHeight", { configurable: true, get: () => 800 });
  });
});
