// Configurable display/UI font. System by default (zero cost, offline); other
// choices lazily load their webfont only when selected, so you pay only for what
// you pick. Drives the --font-ui CSS variable.
import { createSignal } from "solid-js";
import { loadVersioned, saveVersioned } from "./lib/store";

const SYS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export interface FontDef {
  id: string;
  name: string;
  stack: string;
  google?: string; // Google Fonts family spec, loaded on demand
}

export const FONTS: FontDef[] = [
  { id: "system", name: "System (default)", stack: SYS },
  { id: "inter", name: "Inter", stack: `"Inter", ${SYS}`, google: "Inter:wght@400;500;600;650" },
  { id: "plex", name: "IBM Plex Sans", stack: `"IBM Plex Sans", ${SYS}`, google: "IBM+Plex+Sans:wght@400;500;600" },
  { id: "grotesk", name: "Space Grotesk", stack: `"Space Grotesk", ${SYS}`, google: "Space+Grotesk:wght@400;500;700" },
  { id: "mono", name: "JetBrains Mono", stack: `"JetBrains Mono", ui-monospace, monospace`, google: "JetBrains+Mono:wght@400;500;700" },
  { id: "custom", name: "Custom (system font)", stack: SYS },
];

const LS_FONT = "vh.font.v1";
const LS_CUSTOM = "vh.font.custom.v1";
const asStr = (old: unknown) => (typeof old === "string" ? old : "");
const [font, setF] = createSignal<string>(loadVersioned<string>(LS_FONT, 1, "system", (o) => asStr(o) || "system"));
// A locally-installed font family the user types in (CSP-safe: no external load).
const [customFont, setCustomSig] = createSignal<string>(loadVersioned<string>(LS_CUSTOM, 1, "", asStr));
const loaded = new Set<string>();

export function setCustomFont(family: string) {
  setCustomSig(family);
  saveVersioned(LS_CUSTOM, 1, family);
  if (font() === "custom") applyFont();
}
export { customFont };

function ensureWebfont(def: FontDef) {
  if (!def.google || loaded.has(def.id)) return;
  loaded.add(def.id);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${def.google}&display=swap`;
  document.head.appendChild(link);
}

export function applyFont() {
  const def = FONTS.find((f) => f.id === font()) || FONTS[0];
  ensureWebfont(def);
  const stack =
    def.id === "custom" && customFont().trim()
      ? `"${customFont().trim().replace(/"/g, "")}", ${SYS}`
      : def.stack;
  document.documentElement.style.setProperty("--font-ui", stack);
}

export function setFontId(id: string) {
  setF(id);
  saveVersioned(LS_FONT, 1, id);
  applyFont();
}

export { font };
