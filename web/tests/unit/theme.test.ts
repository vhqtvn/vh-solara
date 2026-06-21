// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { applyTheme, CUSTOM_FIELDS, setCustomTheme, setThemeId, THEMES } from "../../src/theme";

describe("themes", () => {
  it("ships the expanded preset set plus a custom slot", () => {
    const ids = THEMES.map((t) => t.id);
    for (const id of ["rose-pine", "one-dark", "everforest", "ayu", "solarized-dark", "solarized-light", "custom"]) {
      expect(ids).toContain(id);
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
});
