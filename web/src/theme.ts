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
  { id: "light", name: "Light", light: true },
  { id: "shire-light", name: "Shire (light)", light: true },
];

const LS_THEME = "vh.theme.v1";
const [theme, setThemeSig] = createSignal<string>(
  loadVersioned<string>(LS_THEME, 1, "dark", (old) => (typeof old === "string" && old ? old : "dark")),
);

export function applyTheme() {
  const el = document.documentElement;
  for (const t of THEMES) el.classList.remove("theme-" + t.id);
  el.classList.add("theme-" + theme());
  const def = THEMES.find((t) => t.id === theme());
  el.style.colorScheme = def?.light ? "light" : "dark";
}

export function setThemeId(id: string) {
  setThemeSig(id);
  saveVersioned(LS_THEME, 1, id);
  applyTheme();
}

export { theme };
