// Configurable display/UI font. System by default (zero cost, offline); other
// choices lazily load their webfont only when selected, so you pay only for what
// you pick. Drives the --font-ui CSS variable.
import { createSignal } from "solid-js";
import { loadVersioned, saveVersioned } from "./lib/store";

const SYS = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
// The baseline monospace stack (the default --font-mono). Used for the
// "system mono" entry in MONO_FONTS and as the fallback tail of every other
// mono font, mirroring how SYS backs every UI font.
const MONO_SYS = 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace';

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
  { id: "geist", name: "Geist", stack: `"Geist", ${SYS}`, google: "Geist:wght@400;500;600" },
  { id: "fira-sans", name: "Fira Sans", stack: `"Fira Sans", ${SYS}`, google: "Fira+Sans:wght@400;500;600" },
  { id: "source-sans", name: "Source Sans 3", stack: `"Source Sans 3", ${SYS}`, google: "Source+Sans+3:wght@400;600" },
  { id: "dm-sans", name: "DM Sans", stack: `"DM Sans", ${SYS}`, google: "DM+Sans:wght@400;500;600" },
  { id: "manrope", name: "Manrope", stack: `"Manrope", ${SYS}`, google: "Manrope:wght@400;500;600" },
  { id: "mono", name: "JetBrains Mono", stack: `"JetBrains Mono", ui-monospace, monospace`, google: "JetBrains+Mono:wght@400;500;700" },
  { id: "custom", name: "Custom (system font)", stack: SYS },
];

// Curated code/monospace fonts. "system-mono" mirrors the previous fixed
// default (so nothing changes out of the box); the rest load on demand from
// Google Fonts, exactly like the UI fonts. Drives --font-mono.
export const MONO_FONTS: FontDef[] = [
  { id: "system-mono", name: "System mono (default)", stack: MONO_SYS },
  { id: "fira-code", name: "Fira Code", stack: `"Fira Code", ${MONO_SYS}`, google: "Fira+Code:wght@400;500" },
  { id: "source-code-pro", name: "Source Code Pro", stack: `"Source Code Pro", ${MONO_SYS}`, google: "Source+Code+Pro:wght@400;600" },
  { id: "plex-mono", name: "IBM Plex Mono", stack: `"IBM Plex Mono", ${MONO_SYS}`, google: "IBM+Plex+Mono:wght@400;500" },
  { id: "cascadia-code", name: "Cascadia Code", stack: `"Cascadia Code", ${MONO_SYS}`, google: "Cascadia+Code:wght@400;500" },
  { id: "victor-mono", name: "Victor Mono", stack: `"Victor Mono", ${MONO_SYS}`, google: "Victor+Mono:wght@400;500" },
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

// --- Monospace ("code") font selection. Mirrors the UI-font plumbing: a
//     versioned signal, on-demand webfont loading via the shared `loaded` set,
//     and applyMonoFont() that writes --font-mono on <html>. ---
const LS_MONO = "vh.font.mono.v1";
const [monoFont, setMonoSig] = createSignal<string>(loadVersioned<string>(LS_MONO, 1, "system-mono", (o) => asStr(o) || "system-mono"));

export function applyMonoFont() {
  const def = MONO_FONTS.find((f) => f.id === monoFont()) || MONO_FONTS[0];
  ensureWebfont(def);
  document.documentElement.style.setProperty("--font-mono", def.stack);
}

export function setMonoFontId(id: string) {
  setMonoSig(id);
  saveVersioned(LS_MONO, 1, id);
  applyMonoFont();
}

// Resolve the active mono stack for ad-hoc consumers (e.g. the xterm terminal,
// which takes a literal fontFamily at creation rather than a CSS var).
export function monoFontStack(): string {
  const def = MONO_FONTS.find((f) => f.id === monoFont()) || MONO_FONTS[0];
  return def.stack;
}

export { monoFont };
