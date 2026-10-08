// Theme selection. A curated set (best of opencode's many themes + openchamber's
// custom-theme idea, kept lean): chrome palettes via CSS-variable classes on
// <html>. Code syntax uses the dark chroma sheet by default and the
// .theme-light-scoped light sheet for light themes (see /vh/highlight.css).
import { persistedSignal } from "./lib/store";
// The theme CATALOG (ThemeDef + THEMES) now lives in ./themeCatalog — a pure
// data module shared with the host shell (host-web/src/theme.ts imports it
// across the tree boundary). Re-exported here so every SPA consumer of
// "./theme" keeps working unchanged; the SPA's theme runtime itself is
// untouched by the extraction.
import { THEMES } from "./themeCatalog";
import type { ThemeDef } from "./themeCatalog";

export { THEMES };
export type { ThemeDef };

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
// persistedSignal: hydrated from localStorage, persisted on set, and re-read
// when another same-origin document (browser tab / host pane iframe) writes the
// key. onRemoteChange mirrors setCustomTheme's local conditional apply: a
// remote custom-field edit re-applies live only while the custom theme is the
// ACTIVE one. (`theme` is referenced before its declaration below — safe: the
// callback runs on storage events, long after module init.)
const [customTheme, setCustomThemeSaved] = persistedSignal<CustomTheme>(
  LS_CUSTOM,
  1,
  DEFAULT_CUSTOM,
  (old) => ({
    ...DEFAULT_CUSTOM,
    ...(old && typeof old === "object" ? (old as Partial<CustomTheme>) : {}),
  }),
  { onRemoteChange: () => { if (theme() === "custom") applyTheme(); } },
);
export { customTheme };

// Update one or more custom-theme fields, persist, and (if custom is active)
// re-apply live.
export function setCustomTheme(patch: Partial<CustomTheme>) {
  const next = { ...customTheme(), ...patch };
  setCustomThemeSaved(next);
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
// persistedSignal + remote-change hook: when another same-origin document
// (browser tab / host pane iframe) changes the shared theme, re-apply it HERE
// live — applyTheme is imperative (classes + inline vars on <html>), so a
// signal-only update would leave this document rendering the old theme until
// reload (the reported cross-tab sync bug).
const [theme, setThemeSaved] = persistedSignal<string>(
  LS_THEME,
  1,
  "dark",
  (old) => (typeof old === "string" && old ? old : "dark"),
  { onRemoteChange: () => applyTheme() },
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
  notifyThemeApplied();
}

// Downstream theme-applied hooks. applyTheme is imperative, and two of its
// consumers live OUTSIDE this module's dependency graph: the embedded-view
// token broadcast (themeTokens.ts) and the code-frame theme nudge
// (code/frame.ts — pulls the UI/layout graph and must not become a static
// import of this leaf module; layout.ts reads window.matchMedia at module
// load). Instead of importing them, expose a registry: the app entry
// (index.tsx) registers the pushes once at boot, and EVERY apply route —
// local setThemeId/setCustomTheme, the cross-document `storage` path, and the
// visibility catch-up below — fans out through the same listeners. Returns an
// unregister. Callback-based on purpose: a module-level createEffect would
// need a reactive root to run at this scope.
const themeAppliedListeners = new Set<() => void>();
export function onThemeApplied(cb: () => void): () => void {
  themeAppliedListeners.add(cb);
  return () => {
    themeAppliedListeners.delete(cb);
  };
}
function notifyThemeApplied() {
  for (const cb of themeAppliedListeners) {
    try {
      cb();
    } catch {
      /* one throwing consumer must not break the apply loop */
    }
  }
}

export function setThemeId(id: string) {
  setThemeSaved(id);
  applyTheme();
}

export { theme };

// Frozen-tab catch-up. The `storage` event IS delivered to ordinary background
// tabs, but a fully FROZEN tab (browsers freeze heavy background tabs; mobile
// backgrounded views) may never run the listener — it thaws with stale
// in-memory signals while the shared localStorage already holds the newer
// value. On becoming visible, re-run the exact storage-event path for both
// theme keys: dispatch a synthetic `storage` event, which the persistedSignal
// listeners treat identically to a real one (re-read, update signal, re-apply
// via onRemoteChange). Idempotent — if nothing was missed, the re-read yields
// the same values and applyTheme() rewrites identical classes/vars.
if (
  typeof document !== "undefined" &&
  typeof document.addEventListener === "function" &&
  typeof StorageEvent !== "undefined"
) {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    for (const key of [LS_THEME, LS_CUSTOM]) {
      window.dispatchEvent(new StorageEvent("storage", { key }));
    }
  });
}
