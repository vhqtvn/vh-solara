// Per-project UI settings read straight from .vh-solara/project.jsonc (served by
// /vh/project-settings — NOT trust-gated; these are display flags, not commands).
// `notes`: a tri-state per-project override of the global Notes pref.
// `agentStyles`: per-agent display treatment (label/color/style), sanitized here
// against fixed enums so a project can never inject a raw color or arbitrary CSS.
// Re-fetched whenever the active project changes (see App.tsx).
import { createSignal } from "solid-js";
import { projectDir } from "./sync";
import { notesEnabled } from "./prefs";

// null = the project didn't declare a value → fall back to the global pref.
const [projectNotes, setProjectNotes] = createSignal<boolean | null>(null);
export { projectNotes };

// A resolved, safe-to-render agent treatment. color is already a theme-token CSS
// var (or undefined); label is trimmed/capped; style is one of the known chips.
export type AgentChipStyle = "soft" | "outline" | "solid";
export interface AgentDisplay {
  label?: string;
  color?: string; // a `var(--token)` string, never a raw color
  style: AgentChipStyle;
}

// Project-declared agent name → raw treatment (whatever was in the file).
const [agentStylesRaw, setAgentStylesRaw] = createSignal<Record<string, any>>({});

// Theme-token enum: the ONLY colors a project may name. Anything else is dropped
// (→ undefined), so a hand-written hex or rgb() can never reach the DOM. Accepts
// OpenCode's own color spellings (warning/error/success) as aliases.
const COLOR_TOKENS: Record<string, string> = {
  accent: "var(--accent)",
  accent2: "var(--accent-2)",
  ok: "var(--ok)",
  success: "var(--ok)",
  warn: "var(--warn)",
  warning: "var(--warn)",
  danger: "var(--danger)",
  error: "var(--danger)",
  muted: "var(--fg-dim)",
};
const CHIP_STYLES: AgentChipStyle[] = ["soft", "outline", "solid"];

// The canonical color names the editor offers (and writes), each with its theme
// var for swatches. Read still accepts the OpenCode aliases above; we normalize
// to these on write.
export const AGENT_COLOR_OPTIONS: { name: string; var: string }[] = [
  { name: "accent", var: "var(--accent)" },
  { name: "accent2", var: "var(--accent-2)" },
  { name: "ok", var: "var(--ok)" },
  { name: "warn", var: "var(--warn)" },
  { name: "danger", var: "var(--danger)" },
  { name: "muted", var: "var(--fg-dim)" },
];
export const AGENT_CHIP_STYLES = CHIP_STYLES;
// colorVar maps a stored color name (canonical or alias) to its theme var, or ""
// when unknown — so the editor can swatch whatever is currently in the file.
export function colorVar(name?: string): string {
  return name ? COLOR_TOKENS[name.toLowerCase()] ?? "" : "";
}

// agentStylesRaw exposes the raw declared map for the editor (unsanitized, so it
// shows exactly what's in the file). refreshProjectSettings keeps it current.
export { agentStylesRaw };

// agentDisplay resolves the sanitized treatment for an agent name, or undefined
// when the project declared nothing usable for it. label is capped at 6 chars so
// a chip stays terse; color must be a known token; style defaults to "soft".
export function agentDisplay(name?: string): AgentDisplay | undefined {
  if (!name) return undefined;
  const raw = agentStylesRaw()[name];
  if (!raw || typeof raw !== "object") return undefined;
  const color = typeof raw.color === "string" ? COLOR_TOKENS[raw.color.toLowerCase()] : undefined;
  const label = typeof raw.label === "string" ? raw.label.trim().slice(0, 6) : undefined;
  const style: AgentChipStyle = CHIP_STYLES.includes(raw.style) ? raw.style : "soft";
  if (!color && !label) return undefined; // nothing renderable
  return { label: label || undefined, color, style };
}

export async function refreshProjectSettings() {
  try {
    const res = await fetch("/vh/project-settings?dir=" + encodeURIComponent(projectDir()));
    if (!res.ok) {
      setProjectNotes(null);
      setAgentStylesRaw({});
      return;
    }
    const s = (await res.json()) as { notes?: boolean; agentStyles?: Record<string, any> };
    setProjectNotes(typeof s.notes === "boolean" ? s.notes : null);
    setAgentStylesRaw(s.agentStyles && typeof s.agentStyles === "object" ? s.agentStyles : {});
  } catch {
    /* offline — keep the last value */
  }
}

// notesVisible is the effective Notes-tab visibility: a per-project declaration
// (if any) wins; otherwise the global pref. Default (both unset) is off.
export function notesVisible(): boolean {
  const p = projectNotes();
  return p === null ? notesEnabled() : p;
}
