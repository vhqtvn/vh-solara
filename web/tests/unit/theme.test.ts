// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  applyTheme,
  CUSTOM_FIELDS,
  customTheme,
  effectiveThemeId,
  exportCustomTheme,
  importCustomTheme,
  resetCustomTheme,
  seedCustomFromTheme,
  setCustomTheme,
  setThemeId,
  THEMES,
  theme,
} from "../../src/theme";
import { einkProfile, setEinkProfile } from "../../src/prefs";

describe("themes", () => {
  it("ships the expanded preset set plus a custom slot", () => {
    const ids = THEMES.map((t) => t.id);
    for (const id of [
      "rose-pine", "one-dark", "everforest", "ayu", "solarized-dark", "solarized-light",
      "monokai", "kanagawa", "material", "catppuccin-latte", "rose-pine-dawn", "custom",
      "oled", "oled-violet",
    ]) {
      expect(ids).toContain(id);
    }
  });

  it("every theme carries a preview swatch (4 colors) for the picker", () => {
    for (const t of THEMES) {
      for (const k of ["bg", "fg", "accent", "accent2"] as const) {
        expect(t.swatch[k]).toMatch(/^#[0-9a-fA-F]{6}$/);
      }
    }
  });

  it("custom theme writes the 7 core vars inline and clears them when switching away", () => {
    setCustomTheme({ bg: "#123456", accent: "#abcdef", light: false });
    setThemeId("custom"); // setThemeId → applyTheme
    const el = document.documentElement;
    expect(el.classList.contains("theme-custom")).toBe(true);
    expect(el.style.getPropertyValue("--bg").trim()).toBe("#123456");
    expect(el.style.getPropertyValue("--accent").trim()).toBe("#abcdef");
    // every editable field is applied
    for (const f of CUSTOM_FIELDS) expect(el.style.getPropertyValue(f.cssVar)).not.toBe("");

    setThemeId("dark");
    expect(el.classList.contains("theme-dark")).toBe(true);
    for (const f of CUSTOM_FIELDS) expect(el.style.getPropertyValue(f.cssVar)).toBe("");
  });

  it("a light custom theme toggles light-scoped + colorScheme", () => {
    setCustomTheme({ light: true });
    setThemeId("custom");
    applyTheme();
    const el = document.documentElement;
    expect(el.classList.contains("theme-light-scoped")).toBe(true);
    expect(el.style.colorScheme).toBe("light");
  });

  it("seeds custom from a preset: copies its swatch + light, derives the rest as #rrggbb", () => {
    const nord = THEMES.find((t) => t.id === "nord")!;
    seedCustomFromTheme("nord");
    const c = customTheme();
    expect(c.bg).toBe(nord.swatch.bg);
    expect(c.fg).toBe(nord.swatch.fg);
    expect(c.accent).toBe(nord.swatch.accent);
    expect(c.accent2).toBe(nord.swatch.accent2);
    expect(c.light).toBe(false);
    // derived vars are valid hex
    for (const k of ["bg2", "border", "fgDim"] as const) {
      expect(c[k]).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    // seeding a light preset carries the light flag
    seedCustomFromTheme("solarized-light");
    expect(customTheme().light).toBe(true);
    // unknown / the custom slot itself are no-ops (no throw, no change)
    const before = exportCustomTheme();
    seedCustomFromTheme("custom");
    seedCustomFromTheme("nope");
    expect(exportCustomTheme()).toBe(before);
  });

  it("reset restores the default custom palette", () => {
    setCustomTheme({ bg: "#000000", accent: "#ff0000", light: true });
    resetCustomTheme();
    const c = customTheme();
    expect(c.bg).toBe("#0d1117");
    expect(c.accent).toBe("#58a6ff");
    expect(c.light).toBe(false);
  });

  it("export → import round-trips and rejects garbage", () => {
    setCustomTheme({ bg: "#abcdef", fg: "#012345", accent: "#fedcba", light: true });
    const json = exportCustomTheme();
    resetCustomTheme();
    expect(importCustomTheme(json)).toBe(true);
    expect(customTheme().bg).toBe("#abcdef");
    expect(customTheme().light).toBe(true);

    // garbage / no usable fields → rejected, state unchanged
    const before = exportCustomTheme();
    expect(importCustomTheme("not json")).toBe(false);
    expect(importCustomTheme("{}")).toBe(false);
    expect(importCustomTheme(JSON.stringify({ bg: "red" }))).toBe(false);
    expect(exportCustomTheme()).toBe(before);

    // a partial but valid import applies only the recognized keys
    expect(importCustomTheme(JSON.stringify({ accent: "#123123", bogus: 1 }))).toBe(true);
    expect(customTheme().accent).toBe("#123123");
  });
});

// The e-ink display profile: a manual, default-OFF preference that composes an
// EFFECTIVE theme (an e-ink theme renders in place of the saved one while the
// saved preference stays untouched). These tests pin the resolution table, the
// DOM composition, and the exact OFF round-trip. The signals are module-level
// singletons shared across this file, so every test sets its state explicitly
// and the afterEach resets the profile so later describes never inherit ON.
describe("e ink profile — effective theme composition", () => {
  afterEach(() => {
    setEinkProfile(false);
  });

  it("resolves the saved theme unchanged while the profile is off", () => {
    setEinkProfile(false);
    for (const id of ["dark", "nord", "eink", "eink-color", "custom", "light"]) {
      setThemeId(id);
      expect(theme()).toBe(id); // saved preference is the source of truth
      expect(effectiveThemeId()).toBe(id); // …and renders as-is
    }
  });

  it("resolves an e-ink theme while on: color variant kept, everything else monochrome", () => {
    setEinkProfile(true);
    // The color variant is kept only when the user explicitly picked it.
    setThemeId("eink-color");
    expect(effectiveThemeId()).toBe("eink-color");
    // Every other saved theme maps to the monochrome e-ink theme…
    for (const id of ["dark", "nord", "eink", "light", "custom"]) {
      setThemeId(id);
      expect(effectiveThemeId()).toBe("eink");
    }
    // …and the saved preference itself is never rewritten by the profile.
    expect(theme()).toBe("custom");
  });

  it("applyTheme renders the effective e-ink theme and OFF restores the saved one exactly", () => {
    setEinkProfile(false);
    setThemeId("nord");
    const el = document.documentElement;
    expect(el.classList.contains("theme-nord")).toBe(true);

    setEinkProfile(true);
    applyTheme();
    expect(el.classList.contains("theme-eink")).toBe(true); // effective attached
    expect(el.classList.contains("theme-nord")).toBe(false); // saved class replaced
    expect(el.classList.contains("theme-light-scoped")).toBe(true); // e-ink is light
    expect(el.style.colorScheme).toBe("light");
    // The saved preference is untouched, in signal AND in storage.
    expect(theme()).toBe("nord");
    expect(localStorage.getItem("vh.theme.v1")).toBe(JSON.stringify({ v: 1, data: "nord" }));

    setEinkProfile(false);
    applyTheme();
    expect(el.classList.contains("theme-nord")).toBe(true);
    expect(el.classList.contains("theme-eink")).toBe(false);
    expect(el.classList.contains("theme-light-scoped")).toBe(false); // nord is dark
    expect(el.style.colorScheme).toBe("dark");
  });

  it("a custom saved theme round-trips: inline vars cleared while on, restored on OFF", () => {
    setEinkProfile(false);
    setCustomTheme({ bg: "#123456" });
    setThemeId("custom");
    const el = document.documentElement;
    expect(el.style.getPropertyValue("--bg").trim()).toBe("#123456");

    setEinkProfile(true);
    applyTheme();
    expect(el.classList.contains("theme-eink")).toBe(true);
    // Effective e-ink is not custom: the inline vars must not pollute it.
    for (const f of CUSTOM_FIELDS) expect(el.style.getPropertyValue(f.cssVar)).toBe("");

    setEinkProfile(false);
    applyTheme();
    expect(el.classList.contains("theme-custom")).toBe(true);
    expect(el.style.getPropertyValue("--bg").trim()).toBe("#123456");
  });

  it("re-applies reactively on the profile toggle alone (the Settings/cross-tab path)", () => {
    // No explicit applyTheme() calls here: toggling the profile signal must
    // re-run the composition by itself (theme.ts's reactive effect) — this is
    // the path the Settings checkbox and the cross-tab storage event rely on.
    setEinkProfile(false);
    setThemeId("nord");
    expect(document.documentElement.classList.contains("theme-nord")).toBe(true);

    setEinkProfile(true);
    expect(document.documentElement.classList.contains("theme-eink")).toBe(true);

    setEinkProfile(false);
    expect(document.documentElement.classList.contains("theme-nord")).toBe(true);
    expect(document.documentElement.classList.contains("theme-eink")).toBe(false);
  });
});
