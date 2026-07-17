// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyScale, setUiScale } from "../../src/prefs";

// Pinch-zoom is intentionally disabled (it shrank visualViewport.height and broke
// the --app-h height model — see prefs.ts setViewportScale). These tests assert
// the DOM effect: after applying a UI-zoom value, the viewport meta must be
// locked (min=max=baseline) and carry user-scalable=no, on both the default and a
// non-default scale. Playwright can't emulate a real pinch gesture, so we assert
// on the meta state, not gesture behavior.

function viewportContent(): string {
  return document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "";
}

describe("setViewportScale disables pinch-zoom", () => {
  beforeEach(() => {
    // prefs.ts applies reactively on import; ensure a fresh meta exists each run
    // so applyScale() has a target to write to.
    document.head.innerHTML = '<meta name="viewport" content="" />';
  });

  it("locks the viewport to the default baseline (1.0) and disables user scaling", () => {
    setUiScale(1);
    applyScale();
    const c = viewportContent();
    expect(c).toContain("user-scalable=no");
    expect(c).toContain("initial-scale=1.00");
    expect(c).toContain("minimum-scale=1.00");
    expect(c).toContain("maximum-scale=1.00");
    // No wide pinch range is exposed.
    expect(c).not.toContain("maximum-scale=10");
  });

  it("re-locks to the chosen baseline when the slider changes (e.g. 1.2)", () => {
    setUiScale(1.2);
    applyScale();
    const c = viewportContent();
    expect(c).toContain("user-scalable=no");
    expect(c).toContain("initial-scale=1.20");
    expect(c).toContain("minimum-scale=1.20");
    expect(c).toContain("maximum-scale=1.20");
  });

  it("accepts the 200% ceiling (WCAG 1.4.4) without clamping to the old 1.6", () => {
    setUiScale(2);
    applyScale();
    const c = viewportContent();
    expect(c).toContain("initial-scale=2.00");
    expect(c).toContain("minimum-scale=2.00");
    expect(c).toContain("maximum-scale=2.00");
    expect(c).toContain("user-scalable=no");
  });
});

// The Performance diagnostics viewer must be DEFAULT-OFF so a normal user never
// sees the surface. The AdminMenu gating test calls setPerfDiagEnabled(false)
// before asserting (which doesn't prove the from-storage default); this block
// starts from CLEARED storage and asserts the persisted signal hydrates false
// without any prior set. It re-imports the module fresh so the signal's initial
// hydration runs against an empty store.
describe("perfDiagEnabled defaults to OFF from cleared storage", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("hydrates false when storage has no prior value", async () => {
    const { perfDiagEnabled } = await import("../../src/prefs");
    expect(perfDiagEnabled()).toBe(false);
    // And nothing was written to storage on read.
    expect(localStorage.getItem("vh.prefs.perfDiagEnabled.v1")).toBeNull();
  });
});
