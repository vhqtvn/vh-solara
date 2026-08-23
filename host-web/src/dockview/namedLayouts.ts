// =============================================================================
// NAMED LAYOUTS — operator-saved workspace layouts (vh-host:namedLayouts:v1).
//
// The operator saves the ACTIVE workspace's layout under a name, then loads it
// later. Load = INSTANTIATE AS A NEW WORKSPACE (cold mount): the blob is staged
// for the new workspace id (layoutPersistence.stageRuntimeWorkspaceLayout) and
// its DockviewHost cold-restores it AT MOUNT through the exact same pipeline a
// reload-restored workspace uses — fromJSON is NEVER run against a live
// workspace (the HARD RULE in layoutPersistence.ts; it disposes + recreates
// every panel, reloading every iframe in that workspace).
//
// STORAGE SHAPE (v1):
//   { [name]: { layout: <fractional serialized workspace layout>, savedAt: number } }
//
// `layout` is the SAME fractional v3 serialization the workspace-set
// persistence writes (fractionizeSavedLayout(api.toJSON()) — see
// layoutPersistence.serializeWorkspaceLayout). There is deliberately NO second
// serialization format: a saved named layout is byte-compatible with a
// PersistedWorkspace.layout, so the cold-restore pipeline (url validation via
// isFleetEntry + real-fleet origin allowlist, repair walker, fraction
// materialization against the current container) applies verbatim.
//
// This module is PURE storage: it imports NOTHING from store.ts (ESM-cycle
// avoidance — the same class of bug the proportions slice hit; store.ts may
// import FROM here, never the reverse). All reads are defensive: a corrupt
// store is treated as empty, never throws.
// =============================================================================

import type { SerializedDockview } from "dockview-core";

/** Versioned + namespaced storage key. Separate from the workspace-set key
 *  (vh-host:layout:v3) on purpose — named layouts are an independent artifact
 *  with their own lifecycle; the persistence format itself is untouched. */
export const NAMED_LAYOUTS_STORAGE_KEY = "vh-host:namedLayouts:v1";

/** Max name length AFTER trim (the workspace-name UI caps at 80; named layouts
 *  cap tighter at 60 — a layout name is a short label, not a sentence. The
 *  input carries maxlength=60 so the UI cannot exceed it; saveNamedLayout
 *  truncates defensively for any other caller). */
export const NAMED_LAYOUT_NAME_MAX = 60;

/** One saved layout. `layout` is opaque here (validated + repaired by the
 *  cold-restore pipeline at consume time, exactly like a persisted workspace). */
export interface NamedLayoutEntry {
  layout: SerializedDockview;
  savedAt: number;
}

/** The on-disk store shape: name → entry. */
type NamedLayoutStore = Record<string, NamedLayoutEntry>;

/** Read + defensively parse the store. NEVER throws: unavailable localStorage,
 * corrupt JSON, or a structurally invalid value all yield {} (start empty). */
function readStore(): NamedLayoutStore {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(NAMED_LAYOUTS_STORAGE_KEY);
  } catch {
    return {};
  }
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  const out: NamedLayoutStore = {};
  for (const [name, v] of Object.entries(parsed as Record<string, unknown>)) {
    // Per-entry guard: only {layout: object, savedAt: finite number} survives.
    // A poison entry is dropped, not the whole store (the cold-restore
    // pipeline re-validates `layout` itself at consume time).
    if (typeof v !== "object" || v === null) continue;
    const e = v as Record<string, unknown>;
    if (typeof e.layout !== "object" || e.layout === null) continue;
    if (typeof e.savedAt !== "number" || !Number.isFinite(e.savedAt)) continue;
    out[name] = { layout: e.layout as SerializedDockview, savedAt: e.savedAt };
  }
  return out;
}

/** Never throws: quota exceeded / private mode just drops the write. */
function writeStore(store: NamedLayoutStore): void {
  try {
    const keys = Object.keys(store);
    if (keys.length === 0) {
      localStorage.removeItem(NAMED_LAYOUTS_STORAGE_KEY);
    } else {
      localStorage.setItem(NAMED_LAYOUTS_STORAGE_KEY, JSON.stringify(store));
    }
  } catch {
    // localStorage unavailable — swallow (best-effort persistence).
  }
}

/** Normalize a candidate name: trim + cap. An EMPTY result is invalid (the
 *  caller refuses the save). */
export function normalizeLayoutName(name: string): string {
  return name.trim().slice(0, NAMED_LAYOUT_NAME_MAX);
}

/** The saved layouts, most-recent-first (savedAt desc; name asc as the
 *  tiebreak so the order is deterministic). */
export function listNamedLayouts(): { name: string; savedAt: number }[] {
  return Object.entries(readStore())
    .map(([name, e]) => ({ name, savedAt: e.savedAt }))
    .sort((a, b) =>
      b.savedAt !== a.savedAt
        ? b.savedAt - a.savedAt
        : a.name.localeCompare(b.name),
    );
}

/**
 * Save `layout` under `name`. SAME NAME = OVERWRITE (documented, deliberate:
 * the manager's "Save current" on an existing name updates the arrangement and
 * refreshes savedAt — an explicit "update" affordance is v2 territory). The
 * name is trimmed + capped; an empty name after trim is refused (false).
 * Returns true when written.
 */
export function saveNamedLayout(name: string, layout: SerializedDockview): boolean {
  const n = normalizeLayoutName(name);
  if (!n) return false;
  const store = readStore();
  store[n] = { layout, savedAt: Date.now() };
  writeStore(store);
  return true;
}

/** One saved entry, or null when no layout is saved under (the trimmed) name. */
export function loadNamedLayout(name: string): NamedLayoutEntry | null {
  const n = normalizeLayoutName(name);
  if (!n) return null;
  return readStore()[n] ?? null;
}

/** Delete the entry saved under (the trimmed) name. Returns true when an
 *  entry was actually removed. */
export function deleteNamedLayout(name: string): boolean {
  const n = normalizeLayoutName(name);
  if (!n) return false;
  const store = readStore();
  if (!(n in store)) return false;
  delete store[n];
  writeStore(store);
  return true;
}
