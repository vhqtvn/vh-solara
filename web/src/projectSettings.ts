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

// --- Display-only session-title replacement layer -----------------------------
//
// An ordered array of regex text replacements a user applies to session titles
// for DISPLAY ONLY. Rules apply sequentially (rule n sees rule n-1's output).
// Operational boundaries — search filters, copy buffers, rename inputs, export
// filenames/headings, archive targets, terminal binding, persisted state — all
// keep the RAW title. Only render leaves call displayName(). See
// docs/ai/web-css-architecture.md et al. and the display-vs-raw matrix.
export interface NameReplacementRule {
  pattern: string; // JS regex source, e.g. `\[\[IMPORTANT\]\]`
  replacement: string; // JS replacement string ($&, $1, named captures supported)
  flags?: string; // JS regex flags, e.g. "g"; absent → single replace
}

export interface CompiledNameReplacement {
  regex: RegExp;
  replacement: string;
}

// A compiled set: the VALID rules to apply (invalid ones skipped, fail-soft) and
// a parallel errors array indexed by the ORIGINAL rule position so the editor
// can show per-row validation. `undefined` at index i = rule i compiled fine.
export interface CompiledNameReplacements {
  rules: CompiledNameReplacement[];
  errors: (string | undefined)[];
}

// compileNameReplacements compiles a draft/saved rules array once, fail-soft:
// each invalid pattern/flags is recorded in `errors` and skipped, so a later
// valid rule still applies. Never throws. (Accepted limitation: a valid-but-
// pathological regex can peg CPU — personal-pref risk, out of scope to prevent.)
export function compileNameReplacements(rules: NameReplacementRule[]): CompiledNameReplacements {
  const out: CompiledNameReplacement[] = [];
  const errors: (string | undefined)[] = [];
  for (let i = 0; i < rules.length; i++) {
    const r = rules[i] ?? {};
    const pattern = typeof r.pattern === "string" ? r.pattern : "";
    const replacement = typeof r.replacement === "string" ? r.replacement : "";
    const flags = typeof r.flags === "string" ? r.flags : "";
    try {
      out.push({ regex: new RegExp(pattern, flags), replacement });
      errors[i] = undefined;
    } catch (e) {
      errors[i] = e instanceof Error ? e.message : String(e);
    }
  }
  return { rules: out, errors };
}

// applyNameReplacements runs a compiled set sequentially over rawTitle (rule n
// sees rule n-1's output), with standard JS replacement semantics. Never throws
// — per-rule replacement failures are defensively caught and skipped. Do NOT
// trim/normalize the result; an intentionally empty result is valid.
export function applyNameReplacements(set: CompiledNameReplacements, rawTitle: string): string {
  if (typeof rawTitle !== "string") return "";
  let result = rawTitle;
  for (const r of set.rules) {
    try {
      result = result.replace(r.regex, r.replacement);
    } catch {
      /* defensively skip a failing replacement; continue with the rest */
    }
  }
  return result;
}

// compileNameReplacementErrors returns the per-rule validation errors for a
// DRAFT array (the editor calls this on each keystroke to flag invalid rows).
export function compileNameReplacementErrors(
  rules: NameReplacementRule[],
): (string | undefined)[] {
  return compileNameReplacements(rules).errors;
}

// Live watch: an SSE the daemon pushes on whenever .vh-solara/project.jsonc is
// created/modified/removed (it polls the file's mtime server-side). On each
// nudge we re-read settings, so the agent-style chips and the editor reflect an
// external edit with no manual reload. Re-pointed when the active project
// changes; EventSource auto-reconnects on a dropped connection.
let es: EventSource | null = null;
let watchDir: string | null = null;
export function watchProjectSettings() {
  const dir = projectDir();
  if (es && watchDir === dir) return;
  es?.close();
  watchDir = dir;
  try {
    es = new EventSource("/vh/project-settings/watch?dir=" + encodeURIComponent(dir));
    es.onmessage = () => void refreshProjectSettings();
  } catch {
    es = null; // SSE unavailable — the manual Reload button still works.
  }
}

export async function refreshProjectSettings() {
  try {
    const res = await fetch("/vh/project-settings?dir=" + encodeURIComponent(projectDir()));
    if (!res.ok) {
      setProjectNotes(null);
      setAgentStylesRaw({});
      setNameReplacements([]);
      return;
    }
    const s = (await res.json()) as {
      notes?: boolean;
      agentStyles?: Record<string, any>;
      nameReplacements?: NameReplacementRule[];
    };
    setProjectNotes(typeof s.notes === "boolean" ? s.notes : null);
    setAgentStylesRaw(s.agentStyles && typeof s.agentStyles === "object" ? s.agentStyles : {});
    setNameReplacements(Array.isArray(s.nameReplacements) ? s.nameReplacements : []);
  } catch {
    /* offline — keep the last value */
  }
}

// --- Signal-backed resolver (for DISPLAY leaves) ------------------------------
//
// nameReplacements is the saved overlay, populated by refreshProjectSettings +
// re-read on the SSE nudge. The display leaves (SessionTree, context-menu sheet,
// command-palette label, …) call displayName(); operational boundaries keep raw.
const [nameReplacements, setNameReplacements] = createSignal<NameReplacementRule[]>([]);
export { nameReplacements, setNameReplacements };

// Compiled-rule cache: recompile ONLY when the rules-array identity changes
// (refreshProjectSettings replaces the array wholesale), so a render storm of
// displayName() calls never recompiles. Keyed on array identity, not contents —
// a no-op refresh that allocates a new [] still recompiles, which is cheap and
// correct; the point is to avoid per-render/per-title compilation.
let compiledKey: NameReplacementRule[] | null = null;
let compiledSet: CompiledNameReplacements = { rules: [], errors: [] };
function compiledNameReplacements(): CompiledNameReplacements {
  const rules = nameReplacements();
  if (rules !== compiledKey) {
    compiledKey = rules;
    compiledSet = compileNameReplacements(rules);
  }
  return compiledSet;
}

// nameReplacementErrors exposes per-rule validation errors for the SAVED rules.
// The editor reads DRAFT errors via compileNameReplacementErrors directly.
export function nameReplacementErrors(): (string | undefined)[] {
  return compiledNameReplacements().errors;
}

// displayName applies the saved sequential fail-soft replacement pipeline to a
// raw session title for DISPLAY ONLY. Never throws; invalid rules are skipped +
// flagged, never fatal. Do NOT trim/normalize the result.
export function displayName(rawTitle: string): string {
  return applyNameReplacements(compiledNameReplacements(), rawTitle);
}

// notesVisible is the effective Notes-tab visibility: a per-project declaration
// (if any) wins; otherwise the global pref. Default (both unset) is off.
export function notesVisible(): boolean {
  const p = projectNotes();
  return p === null ? notesEnabled() : p;
}
