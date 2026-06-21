// Theme selection. A curated set (best of opencode's many themes + openchamber's
// custom-theme idea, kept lean): chrome palettes via CSS-variable classes on
// <html>. Code syntax uses the dark chroma sheet by default and the
// .theme-light-scoped light sheet for light themes (see /vh/highlight.css).
import { createSignal } from "solid-js";
import { loadVersioned, saveVersioned } from "./lib/store";

export interface ThemeDef {
  id: string;
  name: string;
  light?: boolean;
}

export const THEMES: ThemeDef[] = [
  { id: "dark", name: "Dark" },
  { id: "dim", name: "Dim" },
  { id: "midnight", name: "Midnight" },
  { id: "hc", name: "High contrast" },
  { id: "shire-dark", name: "Shire (dark)" },
  { id: "tokyonight", name: "Tokyo Night" },
  { id: "dracula", name: "Dracula" },
  { id: "nord", name: "Nord" },
  { id: "catppuccin", name: "Catppuccin" },
  { id: "gruvbox", name: "Gruvbox" },
  { id: "rose-pine", name: "Rosé Pine" },
  { id: "one-dark", name: "One Dark" },
  { id: "everforest", name: "Everforest" },
  { id: "ayu", name: "Ayu Mirage" },
  { id: "solarized-dark", name: "Solarized (dark)" },
  { id: "light", name: "Light", light: true },
  { id: "shire-light", name: "Shire (light)", light: true },
  { id: "solarized-light", name: "Solarized (light)", light: true },
  { id: "custom", name: "Custom…" },
];

// A user-built theme is just the 7 core vars + a light flag; every other token
// derives from these via the base :root (color-mix/var), so this is all a custom
// theme needs. The light flag drives colorScheme + the light syntax sheet.
export interface CustomTheme {
  bg: string;
  bg2: string;
  border: string;
  fg: string;
  fgDim: string;
  accent: string;
  accent2: string;
  light: boolean;
}

export type CustomColorKey = "bg" | "bg2" | "border" | "fg" | "fgDim" | "accent" | "accent2";

// Editable fields for the custom-theme UI (color key → CSS var → label).
export const CUSTOM_FIELDS: { key: CustomColorKey; cssVar: string; label: string }[] = [
  { key: "bg", cssVar: "--bg", label: "Background" },
  { key: "bg2", cssVar: "--bg-2", label: "Surface" },
  { key: "border", cssVar: "--border", label: "Border" },
  { key: "fg", cssVar: "--fg", label: "Text" },
  { key: "fgDim", cssVar: "--fg-dim", label: "Dim text" },
  { key: "accent", cssVar: "--accent", label: "Accent" },
  { key: "accent2", cssVar: "--accent-2", label: "Accent 2" },
];

const DEFAULT_CUSTOM: CustomTheme = {
  bg: "#0d1117",
  bg2: "#11161d",
  border: "#21262d",
  fg: "#c9d1d9",
  fgDim: "#8b949e",
  accent: "#58a6ff",
  accent2: "#d2a8ff",
  light: false,
};
const LS_CUSTOM = "vh.theme.custom.v1";
const [customTheme, setCustomThemeSig] = createSignal<CustomTheme>(
  loadVersioned<CustomTheme>(LS_CUSTOM, 1, DEFAULT_CUSTOM, (old) => ({
    ...DEFAULT_CUSTOM,
    ...(old && typeof old === "object" ? (old as Partial<CustomTheme>) : {}),
  })),
);
export { customTheme };

// Update one or more custom-theme fields, persist, and (if custom is active)
// re-apply live.
export function setCustomTheme(patch: Partial<CustomTheme>) {
  const next = { ...customTheme(), ...patch };
  setCustomThemeSig(next);
  saveVersioned(LS_CUSTOM, 1, next);
  if (theme() === "custom") applyTheme();
}

const LS_THEME = "vh.theme.v1";
const [theme, setThemeSig] = createSignal<string>(
  loadVersioned<string>(LS_THEME, 1, "dark", (old) => (typeof old === "string" && old ? old : "dark")),
);

export function applyTheme() {
  const el = document.documentElement;
  for (const t of THEMES) el.classList.remove("theme-" + t.id);
  const id = theme();
  el.classList.add("theme-" + id);

  let light: boolean;
  if (id === "custom") {
    // No .theme-custom CSS block; write the 7 core vars inline (they override the
    // base :root, and everything else derives from them).
    const c = customTheme();
    for (const f of CUSTOM_FIELDS) el.style.setProperty(f.cssVar, c[f.key]);
    light = c.light;
  } else {
    // Clear any inline custom vars so a non-custom theme isn't polluted.
    for (const f of CUSTOM_FIELDS) el.style.removeProperty(f.cssVar);
    light = !!THEMES.find((t) => t.id === id)?.light;
  }
  // Generic marker for ALL light themes so light-specific overrides — CSS diff
  // colors AND the server's light syntax sheet scoped under it (GET
  // /vh/highlight.css) — apply to every light theme, including a light custom one.
  el.classList.toggle("theme-light-scoped", light);
  el.style.colorScheme = light ? "light" : "dark";
}

export function setThemeId(id: string) {
  setThemeSig(id);
  saveVersioned(LS_THEME, 1, id);
  applyTheme();
}

export { theme };
