// HOST-SHELL theme system — independent from the embedded SPA's theme.
//
// Scope: the host chrome ONLY (tabstrip, popovers, dockview chrome, the pane
// surface behind iframes). Each embedded SPA keeps its own theme (its own
// picker inside the iframe); NO host↔iframe sync of any kind is intended —
// that is an explicit non-goal, and the storage-key split below is what
// enforces it: the SPA persists under `vh.theme.v1` / `vh.theme.custom.v1`
// (web/src/theme.ts), the host under `vh-host:theme:v1` (this module). In the
// folded production posture both documents share ONE origin, so distinct keys
// are load-bearing: neither document's `storage` listener can fire for the
// other's theme writes.
//
// Catalog: reuses the SPA's curated THEMES via the shared pure-data module
// web/src/themeCatalog.ts (see that file for why the host must NOT import the
// full web/src/theme.ts runtime). "custom" (the SPA's user-built theme) is
// deliberately NOT offered in the host v1 picker — curated catalog only.
//
// Application model mirrors the SPA's: `.theme-<id>` class on <html>; the
// palette var blocks live in styles/tokens.css. Light themes additionally get
// the `host-theme-light` marker class (the host analogue of the SPA's
// `.theme-light-scoped`), which tokens.css uses for light-only adjustments
// (shadow softening) and which flips `color-scheme` via the theme block.

import { createSignal } from "solid-js";
import { THEMES, type ThemeDef } from "../../web/src/themeCatalog";

/** Storage key — follows the host's `vh-host:*` convention; MUST NOT collide
 * with the SPA's `vh.theme.v1` / `vh.theme.custom.v1` (same origin when folded). */
const LS_KEY = "vh-host:theme:v1";
const DEFAULT_THEME = "dark";

/** The host's offerable themes: the full curated catalog minus "custom". */
export const HOST_THEMES: ThemeDef[] = THEMES.filter((t) => t.id !== "custom");

export function isHostThemeId(id: string): boolean {
  return HOST_THEMES.some((t) => t.id === id);
}

// Versioned envelope {v, data} — the same shape the SPA's persistedSignal
// uses — read back with strict validation: garbage, foreign payloads, or an
// id that left the catalog all fall back to the default.
function readStored(): string {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw == null) return DEFAULT_THEME;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as { v?: unknown }).v === 1 &&
      typeof (parsed as { data?: unknown }).data === "string" &&
      isHostThemeId((parsed as { data: string }).data)
    ) {
      return (parsed as { data: string }).data;
    }
  } catch {
    /* unreadable/private-mode — default */
  }
  return DEFAULT_THEME;
}

const [hostTheme, setHostThemeState] = createSignal<string>(readStored());
export { hostTheme };

/** Apply the current theme to this document (idempotent). Removes ALL
 * `theme-*` classes first so a stray pre-paint class (see index.html — the
 * inline script applies the stored id unvalidated) cannot linger. */
export function applyHostTheme(): void {
  const el = document.documentElement;
  for (const cls of Array.from(el.classList)) {
    if (cls.startsWith("theme-")) el.classList.remove(cls);
  }
  el.classList.remove("host-theme-light");
  const id = hostTheme();
  const def = HOST_THEMES.find((t) => t.id === id);
  if (def) {
    // "dark" IS the :root palette in tokens.css — no class needed for it
    // (and the pre-paint script in index.html applies the same convention),
    // so the default boot keeps <html> class-free.
    if (def.id !== "dark") el.classList.add("theme-" + def.id);
    if (def.light) el.classList.add("host-theme-light");
  }
}

/** Pick + persist a theme (validated against the catalog; unknown ids no-op). */
export function setHostTheme(id: string): void {
  if (!isHostThemeId(id)) return;
  setHostThemeState(id);
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({ v: 1, data: id }));
  } catch {
    /* private mode / quota — in-memory theme still applies */
  }
  applyHostTheme();
}

// Cross-WINDOW sync: a second host document (another browser tab on this
// origin) writing the HOST key re-applies here. The SPA's keys are different
// strings, so the SPA changing ITS theme never reaches this listener — and
// the host writing its key never reaches the SPA's.
if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key !== LS_KEY) return;
    const next = readStored();
    if (next !== hostTheme()) {
      setHostThemeState(next);
      applyHostTheme();
    }
  });
}
