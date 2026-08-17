// @vitest-environment jsdom
// lib/zoom — viewport-px → zoomed-layout-px conversion for drag/position math
// under UI zoom. prefs.ts applies the user's zoom as CSS `zoom` on :root and
// mirrors it as an inline `--ui-zoom` custom property (desktop + embedded
// mobile); mobile-standalone pins --ui-zoom to 1 (meta-scale path). These tests
// pin: the inline read, the computed-`zoom` fallback, the safe fallbacks
// (absent / unparseable / non-positive → 1), and the two conversion
// directions (>100% divides down, <100% scales up).
import { afterEach, describe, expect, it } from "vitest";
import { layoutPx, uiZoom } from "../../src/lib/zoom";

function setUiZoomVar(v: string) {
  document.documentElement.style.setProperty("--ui-zoom", v);
}

function clearZoom() {
  document.documentElement.style.removeProperty("--ui-zoom");
  (document.documentElement.style as { zoom?: string }).zoom = "";
}

describe("uiZoom", () => {
  afterEach(clearZoom);

  it("is 1 when no zoom is applied", () => {
    expect(uiZoom()).toBe(1);
  });

  it("reads the inline --ui-zoom prefs.ts sets on :root", () => {
    setUiZoomVar("1.25");
    expect(uiZoom()).toBe(1.25);
  });

  it("is 1 on the mobile-standalone meta path (--ui-zoom pinned to 1)", () => {
    setUiZoomVar("1");
    expect(uiZoom()).toBe(1);
  });

  it("falls back to computed `zoom` when --ui-zoom is absent", () => {
    // Simulates zoom set on :root by a means other than prefs.ts (which always
    // sets both). Stub getComputedStyle — jsdom itself doesn't resolve `zoom`.
    clearZoom();
    const real = (globalThis as { getComputedStyle: unknown }).getComputedStyle;
    (globalThis as { getComputedStyle: unknown }).getComputedStyle = () => ({
      zoom: "1.5",
      getPropertyValue: () => "",
    });
    try {
      expect(uiZoom()).toBe(1.5);
    } finally {
      (globalThis as { getComputedStyle: unknown }).getComputedStyle = real;
    }
  });

  it("treats unparseable/non-positive values as 1 (never divides by 0/negative)", () => {
    for (const bad of ["garbage", "0", "-2", " "]) {
      setUiZoomVar(bad);
      expect(uiZoom(), `--ui-zoom: "${bad}"`).toBe(1);
    }
  });
});

describe("layoutPx", () => {
  afterEach(clearZoom);

  it("divides viewport px by the zoom (125%: 250px drag → 200px width)", () => {
    setUiZoomVar("1.25");
    expect(layoutPx(250)).toBe(200);
  });

  it("scales up below 100% (80%: 80px → 100px)", () => {
    setUiZoomVar("0.8");
    expect(layoutPx(80)).toBe(100);
  });

  it("is the identity at zoom 1", () => {
    setUiZoomVar("1");
    expect(layoutPx(321)).toBe(321);
  });
});
