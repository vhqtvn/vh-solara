// Theme CATALOG — pure data, no imports, no side effects.
//
// Single source of truth for the curated theme list, shared by BOTH SPAs:
//   - web/src/theme.ts       (the single-server SPA's theme runtime; re-exports this)
//   - host-web/src/theme.ts  (the host shell's INDEPENDENT theme runtime)
// The host deliberately imports ONLY this catalog module (never the full
// web/src/theme.ts): that module registers localStorage `storage` listeners
// for the SPA's keys and mutates <html> on remote writes — importing it into
// the host document would accidentally couple the host theme to the SPA theme
// (an explicit non-goal in the folded same-origin posture). Keeping this file
// free of imports is what makes that safe: bundling it pulls in nothing else.
//
// Do not add runtime behavior here — data only.

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
  { id: "oled", name: "OLED", swatch: { bg: "#000000", fg: "#d0d7e2", accent: "#4c9cff", accent2: "#b388ff" } },
  { id: "oled-violet", name: "OLED Violet", swatch: { bg: "#000000", fg: "#d8d2e8", accent: "#a277ff", accent2: "#ff7edb" } },
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
  { id: "synthwave-84", name: "Synthwave '84", swatch: { bg: "#262335", fg: "#ffffff", accent: "#f92aad", accent2: "#36f9f6" } },
  { id: "night-owl", name: "Night Owl", swatch: { bg: "#011627", fg: "#d6deeb", accent: "#82aaff", accent2: "#c792ea" } },
  { id: "cobalt2", name: "Cobalt2", swatch: { bg: "#193549", fg: "#ffffff", accent: "#ffc600", accent2: "#ff628c" } },
  { id: "catppuccin-macchiato", name: "Catppuccin Macchiato", swatch: { bg: "#24273a", fg: "#cad3f5", accent: "#8aadf4", accent2: "#c6a0f6" } },
  { id: "catppuccin-frappe", name: "Catppuccin Frappé", swatch: { bg: "#303446", fg: "#c6d0f5", accent: "#8caaee", accent2: "#ca9ee6" } },
  { id: "kanagawa-dragon", name: "Kanagawa Dragon", swatch: { bg: "#181616", fg: "#c5c9c5", accent: "#7e9cd8", accent2: "#957fb8" } },
  { id: "gruvbox-material", name: "Gruvbox Material", swatch: { bg: "#1d2021", fg: "#d4be98", accent: "#7daea3", accent2: "#d3869b" } },
  { id: "light", name: "Light", light: true, swatch: { bg: "#ffffff", fg: "#1f2328", accent: "#0969da", accent2: "#8250df" } },
  { id: "shire-light", name: "Shire (light)", light: true, swatch: { bg: "#f9f5eb", fg: "#1a1612", accent: "#5d6e3f", accent2: "#8c5520" } },
  { id: "solarized-light", name: "Solarized (light)", light: true, swatch: { bg: "#fdf6e3", fg: "#586e75", accent: "#268bd2", accent2: "#d33682" } },
  { id: "catppuccin-latte", name: "Catppuccin Latte", light: true, swatch: { bg: "#eff1f5", fg: "#4c4f69", accent: "#1e66f5", accent2: "#8839ef" } },
  { id: "rose-pine-dawn", name: "Rosé Pine Dawn", light: true, swatch: { bg: "#faf4ed", fg: "#575279", accent: "#56949f", accent2: "#907aa9" } },
  { id: "paper", name: "Paper", light: true, swatch: { bg: "#f4f4f2", fg: "#161616", accent: "#2b2b2b", accent2: "#4d4d4d" } },
  { id: "paper-color", name: "Paper Color", light: true, swatch: { bg: "#eceae2", fg: "#24231f", accent: "#4f7a8f", accent2: "#9c6b52" } },
  { id: "eink", name: "E Ink", light: true, swatch: { bg: "#ffffff", fg: "#000000", accent: "#000000", accent2: "#000000" } },
  { id: "eink-color", name: "E Ink Color", light: true, swatch: { bg: "#ffffff", fg: "#000000", accent: "#0b5cad", accent2: "#b3431a" } },
  { id: "one-light", name: "One Light", light: true, swatch: { bg: "#fafafa", fg: "#383a42", accent: "#4078f2", accent2: "#a626a4" } },
  { id: "ayu-light", name: "Ayu Light", light: true, swatch: { bg: "#fafafa", fg: "#5b6773", accent: "#399ee6", accent2: "#f9ae58" } },
  { id: "custom", name: "Custom…", swatch: { bg: "#0d1117", fg: "#c9d1d9", accent: "#58a6ff", accent2: "#d2a8ff" } },
];
