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
  // Representative colors for the selection-list preview swatch. Mirrors the
  // theme's CSS (preview only — the CSS .theme-<id> block stays authoritative).
  // For "custom" these are placeholders; the picker reads the live customTheme().
  swatch: { bg: string; fg: string; accent: string; accent2: string };
}

export const THEMES: ThemeDef[] = [
  { id: "dark", name: "Dark", swatch: { bg: "#0d1117", fg: "#c9d1d9", accent: "#58a6ff", accent2: "#d2a8ff" } },
  { id: "dim", name: "Dim", swatch: { bg: "#1c2128", fg: "#adbac7", accent: "#539bf5", accent2: "#dcbdfb" } },
  { id: "midnight", name: "Midnight", swatch: { bg: "#06080d", fg: "#c9d1d9", accent: "#6cb6ff", accent2: "#b39dff" } },
  { id: "hc", name: "High contrast", swatch: { bg: "#000000", fg: "#ffffff", accent: "#4cc2ff", accent2: "#e0a3ff" } },
  { id: "shire-dark", name: "Shire (dark)", swatch: { bg: "#1b1815", fg: "#ebe0d1", accent: "#7a8a5a", accent2: "#c47a3a" } },
  { id: "tokyonight", name: "Tokyo Night", swatch: { bg: "#1a1b26", fg: "#c0caf5", accent: "#7aa2f7", accent2: "#bb9af7" } },
  { id: "dracula", name: "Dracula", swatch: { bg: "#282a36", fg: "#f8f8f2", accent: "#bd93f9", accent2: "#ff79c6" } },
  { id: "nord", name: "Nord", swatch: { bg: "#2e3440", fg: "#e5e9f0", accent: "#88c0d0", accent2: "#b48ead" } },
  { id: "catppuccin", name: "Catppuccin", swatch: { bg: "#1e1e2e", fg: "#cdd6f4", accent: "#89b4fa", accent2: "#cba6f7" } },
  { id: "gruvbox", name: "Gruvbox", swatch: { bg: "#282828", fg: "#ebdbb2", accent: "#83a598", accent2: "#d3869b" } },
  { id: "rose-pine", name: "Rosé Pine", swatch: { bg: "#191724", fg: "#e0def4", accent: "#9ccfd8", accent2: "#c4a7e7" } },
  { id: "one-dark", name: "One Dark", swatch: { bg: "#282c34", fg: "#abb2bf", accent: "#61afef", accent2: "#c678dd" } },
  { id: "everforest", name: "Everforest", swatch: { bg: "#2d353b", fg: "#d3c6aa", accent: "#a7c080", accent2: "#d699b6" } },
  { id: "ayu", name: "Ayu Mirage", swatch: { bg: "#1f2430", fg: "#cccac2", accent: "#ffcc66", accent2: "#73d0ff" } },
  { id: "solarized-dark", name: "Solarized (dark)", swatch: { bg: "#002b36", fg: "#93a1a1", accent: "#268bd2", accent2: "#d33682" } },
  { id: "monokai", name: "Monokai", swatch: { bg: "#272822", fg: "#f8f8f2", accent: "#66d9ef", accent2: "#f92672" } },
  { id: "kanagawa", name: "Kanagawa", swatch: { bg: "#1f1f28", fg: "#dcd7ba", accent: "#7e9cd8", accent2: "#957fb8" } },
  { id: "material", name: "Material Ocean", swatch: { bg: "#263238", fg: "#eeffff", accent: "#82aaff", accent2: "#c792ea" } },
  { id: "light", name: "Light", light: true, swatch: { bg: "#ffffff", fg: "#1f2328", accent: "#0969da", accent2: "#8250df" } },
  { id: "shire-light", name: "Shire (light)", light: true, swatch: { bg: "#f9f5eb", fg: "#1a1612", accent: "#5d6e3f", accent2: "#8c5520" } },
  { id: "solarized-light", name: "Solarized (light)", light: true, swatch: { bg: "#fdf6e3", fg: "#586e75", accent: "#268bd2", accent2: "#d33682" } },
  { id: "catppuccin-latte", name: "Catppuccin Latte", light: true, swatch: { bg: "#eff1f5", fg: "#4c4f69", accent: "#1e66f5", accent2: "#8839ef" } },
  { id: "rose-pine-dawn", name: "Rosé Pine Dawn", light: true, swatch: { bg: "#faf4ed", fg: "#575279", accent: "#56949f", accent2: "#907aa9" } },
  { id: "custom", name: "Custom…", swatch: { bg: "#0d1117", fg: "#c9d1d9", accent: "#58a6ff", accent2: "#d2a8ff" } },
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

// Reset the custom theme to the built-in default.
export function resetCustomTheme() {
  setCustomTheme(DEFAULT_CUSTOM);
}

// --- tiny hex color mixing (for deriving surface/border/dim when seeding) ---
function parseHex(h: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex(r: number, g: number, b: number): string {
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0");
  return "#" + c(r) + c(g) + c(b);
}
function mix(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  if (!ca || !cb) return a;
  return toHex(ca[0] + (cb[0] - ca[0]) * t, ca[1] + (cb[1] - ca[1]) * t, ca[2] + (cb[2] - ca[2]) * t);
}

// Seed the custom theme from an existing preset (fork-to-edit). The preset's
// swatch gives 4 of the 7 vars; surface/border/dim are derived so the result is
// coherent and the user tweaks from there.
export function seedCustomFromTheme(id: string) {
  const def = THEMES.find((t) => t.id === id && t.id !== "custom");
  if (!def) return;
  const s = def.swatch;
  setCustomTheme({
    bg: s.bg,
    fg: s.fg,
    accent: s.accent,
    accent2: s.accent2,
    bg2: mix(s.bg, s.fg, 0.06),
    border: mix(s.bg, s.fg, 0.18),
    fgDim: mix(s.fg, s.bg, 0.45),
    light: !!def.light,
  });
}

// Export the custom theme as a portable JSON string (share / move machines).
export function exportCustomTheme(): string {
  return JSON.stringify(customTheme());
}

// Import a custom theme from a JSON string (validated: known fields, #rrggbb
// colors, boolean light). Returns false on garbage. Applies live if accepted.
export function importCustomTheme(text: string): boolean {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return false;
  }
  if (!o || typeof o !== "object") return false;
  const src = o as Record<string, unknown>;
  const patch: Partial<CustomTheme> = {};
  for (const f of CUSTOM_FIELDS) {
    const v = src[f.key];
    if (typeof v === "string" && /^#[0-9a-fA-F]{6}$/.test(v)) patch[f.key] = v;
  }
  if (typeof src.light === "boolean") patch.light = src.light;
  if (Object.keys(patch).length === 0) return false;
  setCustomTheme(patch);
  return true;
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
