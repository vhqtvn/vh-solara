// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  applyTheme,
  CUSTOM_FIELDS,
  customTheme,
  exportCustomTheme,
  importCustomTheme,
  resetCustomTheme,
  seedCustomFromTheme,
  setCustomTheme,
  setThemeId,
  THEMES,
} from "../../src/theme";

describe("themes", () => {
  it("ships the expanded preset set plus a custom slot", () => {
    const ids = THEMES.map((t) => t.id);
    for (const id of [
      "rose-pine", "one-dark", "everforest", "ayu", "solarized-dark", "solarized-light",
      "monokai", "kanagawa", "material", "catppuccin-latte", "rose-pine-dawn", "custom",
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
