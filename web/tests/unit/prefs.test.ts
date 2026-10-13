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

// The operator's intent for perfDiagEnabled is "diagnostic logs should be global,
// not per project" — the setting MUST survive both a browser process restart
// AND a project switch. These tests lock in that contract: the storage key is a
// fixed global constant (not derived from any project), the value re-hydrates
// from localStorage on module re-init (browser restart analog), and the signal
// is a module-level singleton so an in-app project switch — which never
// re-imports the prefs module — cannot reset it.
describe("perfDiagEnabled is global and durable", () => {
  const KEY = "vh.prefs.perfDiagEnabled.v1";

  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("writes to a fixed (non-project-scoped) localStorage key on enable", async () => {
    const { setPerfDiagEnabled } = await import("../../src/prefs");
    setPerfDiagEnabled(true);
    // The key must be a constant global string — it must NOT embed a project
    // directory/id that would change when the user selects a different project.
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify({ v: 1, data: true }));
    // And it is the ONLY vh.prefs key written for this pref (no project-suffixed
    // variant exists alongside it).
    const allKeys = Object.keys(localStorage).filter((k) => k.startsWith("vh.prefs."));
    expect(allKeys).toContain(KEY);
    expect(allKeys.filter((k) => k.includes("perfDiag"))).toEqual([KEY]);
  });

  it("survives a browser restart (module re-import re-hydrates from storage)", async () => {
    const { setPerfDiagEnabled } = await import("../../src/prefs");
    setPerfDiagEnabled(true);
    // Simulate a browser process restart: drop the module cache so the signal's
    // initial hydration runs again against the persisted localStorage value.
    // localStorage persists across page loads (same origin); only the in-memory
    // JS module state is gone.
    vi.resetModules();
    const fresh = await import("../../src/prefs");
    expect(fresh.perfDiagEnabled()).toBe(true);
  });

  it("survives a project switch (the signal is a module-level singleton, not re-hydrated per project)", async () => {
    // Enable the setting while "project A" is active.
    const mod1 = await import("../../src/prefs");
    mod1.setPerfDiagEnabled(true);
    expect(mod1.perfDiagEnabled()).toBe(true);

    // A project switch in the app is an in-app SPA navigation — it does NOT
    // reload the page and does NOT re-import the prefs module (ESM caches it).
    // So the same in-memory signal is still in scope. Simulate that by importing
    // the module a second time WITHOUT resetModules: ESM returns the cached
    // module namespace, so both import sites share one signal.
    const mod2 = await import("../../src/prefs");
    expect(mod2.perfDiagEnabled()).toBe(true);
    // Prove they are the same signal: toggling via one site is visible at the
    // other, and the underlying storage key is unchanged (still no project
    // component).
    mod2.setPerfDiagEnabled(false);
    expect(mod1.perfDiagEnabled()).toBe(false);
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify({ v: 1, data: false }));
  });
});

// The e-ink display profile preference: manual, default-OFF, detection-free.
// These tests pin the preference-layer contract: fresh storage defaults OFF,
// nothing but the explicit setter can turn it on (in particular selecting an
// e-ink THEME), the toggle persists, and enabling it leaves every other saved
// preference byte-identical.
describe("einkProfile preference", () => {
  const KEY = "vh.prefs.einkProfile.v1";
  const THEME_KEY = "vh.theme.v1";
  const SCALE_KEY = "vh.prefs.uiScale.v1";
  const STREAM_KEY = "vh.prefs.streamLive.v1";

  beforeEach(() => {
    localStorage.clear();
    vi.resetModules();
  });

  it("defaults to OFF from cleared storage and writes nothing on read", async () => {
    const { einkProfile } = await import("../../src/prefs");
    expect(einkProfile()).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it("is enabled only by the explicit setter — selecting an e-ink theme never enables it", async () => {
    const prefs = await import("../../src/prefs");
    const themeMod = await import("../../src/theme");
    // Picking each e-ink theme as the SAVED theme (the full user path)…
    themeMod.setThemeId("eink");
    expect(themeMod.theme()).toBe("eink");
    themeMod.setThemeId("eink-color");
    expect(themeMod.theme()).toBe("eink-color");
    // …leaves the profile OFF and its storage key unwritten.
    expect(prefs.einkProfile()).toBe(false);
    expect(localStorage.getItem(KEY)).toBeNull();

    // The manual setter is the only activator, and it persists both ways.
    prefs.setEinkProfile(true);
    expect(prefs.einkProfile()).toBe(true);
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify({ v: 1, data: true }));
    prefs.setEinkProfile(false);
    expect(localStorage.getItem(KEY)).toBe(JSON.stringify({ v: 1, data: false }));
  });

  it("works with zero detection signals available (no matchMedia, no client hints)", async () => {
    // jsdom exposes neither window.matchMedia nor navigator.userAgentData —
    // a maximally signal-free environment. If the profile consulted ANY
    // detection signal this would be impossible to satisfy: the manual toggle
    // alone must apply the effective e-ink theme.
    expect(typeof matchMedia).toBe("undefined");
    expect((navigator as any).userAgentData).toBeUndefined();
    const prefs = await import("../../src/prefs");
    const themeMod = await import("../../src/theme");
    themeMod.setThemeId("dark");
    prefs.setEinkProfile(true);
    themeMod.applyTheme();
    expect(document.documentElement.classList.contains("theme-eink")).toBe(true);
    expect(themeMod.effectiveThemeId()).toBe("eink");
  });

  it("leaves the saved theme, scale, and streaming preferences byte-identical while ON", async () => {
    const prefs = await import("../../src/prefs");
    const themeMod = await import("../../src/theme");
    themeMod.setThemeId("nord");
    prefs.setUiScale(1.25);
    prefs.setStreamLive(false);
    const before = {
      theme: localStorage.getItem(THEME_KEY),
      scale: localStorage.getItem(SCALE_KEY),
      stream: localStorage.getItem(STREAM_KEY),
    };

    prefs.setEinkProfile(true);
    themeMod.applyTheme();
    expect({
      theme: localStorage.getItem(THEME_KEY),
      scale: localStorage.getItem(SCALE_KEY),
      stream: localStorage.getItem(STREAM_KEY),
    }).toEqual(before);
    // …and the in-memory signals too.
    expect(themeMod.theme()).toBe("nord");
    expect(prefs.uiScale()).toBe(1.25);
    expect(prefs.streamLive()).toBe(false);

    prefs.setEinkProfile(false);
    themeMod.applyTheme();
    expect({
      theme: localStorage.getItem(THEME_KEY),
      scale: localStorage.getItem(SCALE_KEY),
      stream: localStorage.getItem(STREAM_KEY),
    }).toEqual(before);
  });
});
