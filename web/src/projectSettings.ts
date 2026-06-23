// Per-project UI settings read straight from .vh-solara/project.jsonc (served by
// /vh/project-settings — NOT trust-gated; these are display flags, not commands).
// Currently just `notes`: a tri-state per-project override of the global Notes
// pref. Re-fetched whenever the active project changes (see App.tsx).
import { createSignal } from "solid-js";
import { projectDir } from "./sync";
import { notesEnabled } from "./prefs";

// null = the project didn't declare a value → fall back to the global pref.
const [projectNotes, setProjectNotes] = createSignal<boolean | null>(null);
export { projectNotes };

export async function refreshProjectSettings() {
  try {
    const res = await fetch("/vh/project-settings?dir=" + encodeURIComponent(projectDir()));
    if (!res.ok) {
      setProjectNotes(null);
      return;
    }
    const s = (await res.json()) as { notes?: boolean };
    setProjectNotes(typeof s.notes === "boolean" ? s.notes : null);
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
