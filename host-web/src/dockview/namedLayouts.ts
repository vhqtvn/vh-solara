// =============================================================================
// NAMED LAYOUTS — operator-saved layouts (vh-host:namedLayouts:v2).
//
// TWO scopes, one store:
//  - scope "tab": ONE workspace's arrangement. A save carries BOTH a layout
//    name AND a TAB TITLE (the workspace name applied when the layout is
//    loaded — the loaded workspace is titled after the save, not the layout's
//    label). Load = INSTANTIATE AS A NEW WORKSPACE (cold mount): the blob is
//    staged for the new workspace id (layoutPersistence.stageRuntimeWorkspace
//    Layout) and its DockviewHost cold-restores it AT MOUNT through the exact
//    same pipeline a reload-restored workspace uses — fromJSON is NEVER run
//    against a live workspace (the HARD RULE in layoutPersistence.ts; it
//    disposes + recreates every panel, reloading every iframe in it).
//  - scope "master": a SNAPSHOT OF ALL WORKSPACES (the whole session) — every
//    workspace's name + layout, plus the active workspace's NAME. Load is
//    DESTRUCTIVE (replaces the whole session): every existing workspace is
//    closed through the existing closeWorkspace path (explicit destroy — the
//    same semantics as the workspace-delete button) and each saved workspace
//    is re-created cold. The UI owns the two-step confirm; storage is
//    scope-agnostic.
//
// STORAGE SHAPE (v2): one flat name-keyed map, entries discriminated by
// `scope` (a name uniquely identifies a saved layout in EITHER scope — rename
// collision checks span both):
//   { [name]:
//       | { scope: "tab"; name; tabTitle: string;
//           layout: <fractional serialized workspace layout>; savedAt: number }
//       | { scope: "master"; name;
//           session: { activeWorkspaceName: string | null;
//                      workspaces: { name: string;
//                                    layout: <same serialized form> }[] };
//           savedAt: number } }
//
// `layout` is the SAME fractional v3 serialization the workspace-set
// persistence writes (fractionizeSavedLayout(api.toJSON()) — see
// layoutPersistence.serializeWorkspaceLayout). There is deliberately NO second
// serialization format: a saved layout is byte-compatible with a
// PersistedWorkspace.layout, so the cold-restore pipeline (url validation via
// isFleetEntry + real-fleet origin allowlist, repair walker, fraction
// materialization against the current container, pane-id re-minting) applies
// verbatim. The master session shape intentionally mirrors the persisted
// session shape MINUS ids — workspace ids re-mint on load anyway (addWorkspace
// mints fresh ids; pane ids are re-minted by reIdLayoutPanels at consume
// time), so only NAMES are durable.
//
// v1 → v2 MIGRATION (in-memory on read, like the layout persistence v2→v3
// precedent): the v1 store { [name]: {layout, savedAt} } maps each entry to
// {scope:"tab", name, tabTitle: name, layout, savedAt} — a v1 save predates
// tab titles, so the layout's own name is the best title. The legacy v1 key
// is removed on the FIRST v2 write (and never re-read once migrated).
//
// This module is PURE storage: it imports NOTHING from store.ts (ESM-cycle
// avoidance — store.ts may import FROM here, never the reverse). All reads
// are defensive: a corrupt store is treated as empty, never throws; a poison
// ENTRY is dropped, not the whole store.
// =============================================================================

import type { SerializedDockview } from "dockview-core";

/** Versioned + namespaced storage key (v2 adds the scope discrimination + the
 *  tab-title/master-session fields). Separate from the workspace-set key
 *  (vh-host:layout:v3) on purpose — named layouts are an independent artifact
 *  with their own lifecycle; the persistence format itself is untouched. */
export const NAMED_LAYOUTS_STORAGE_KEY = "vh-host:namedLayouts:v2";

/** The superseded v1 key (flat {name → {layout, savedAt}}) — read as a
 *  fallback when the v2 key is absent (each entry migrates in-memory to a
 *  tab-scope entry with tabTitle == name), and removed on the first v2 write. */
const LEGACY_V1_STORAGE_KEY = "vh-host:namedLayouts:v1";

/** Max layout-name length AFTER trim (the workspace-name UI caps at 80; named
 *  layouts cap tighter at 60 — a layout name is a short label, not a
 *  sentence. The input carries maxlength=60 so the UI cannot exceed it; the
 *  savers truncate defensively for any other caller). */
export const NAMED_LAYOUT_NAME_MAX = 60;

/** Max TAB TITLE length after trim — deliberately the same 80-char cap the
 *  workspace-name input enforces (the title BECOMES a workspace name on
 *  load, so it must obey the same bound). */
export const TAB_TITLE_MAX = 80;

/** One workspace's entry inside a master (session) snapshot: the workspace's
 *  durable NAME plus its layout in the same fractional serialized form a
 *  tab-scope entry stores. Ids are deliberately absent (they re-mint). */
export interface NamedMasterWorkspace {
  name: string;
  layout: SerializedDockview;
}

/** The master snapshot payload: every workspace + the active workspace's NAME
 *  (null-tolerant — a missing/unknown active falls back to "activate the
 *  first workspace" at load time). */
export interface NamedMasterSession {
  activeWorkspaceName: string | null;
  workspaces: NamedMasterWorkspace[];
}

/** A saved THIS-TAB layout. `layout` is opaque here (validated + repaired by
 *  the cold-restore pipeline at consume time, exactly like a persisted
 *  workspace). `tabTitle` is the workspace name applied on load. */
export interface TabLayoutEntry {
  scope: "tab";
  name: string;
  tabTitle: string;
  layout: SerializedDockview;
  savedAt: number;
}

/** A saved ALL-TABS (master) snapshot. */
export interface MasterLayoutEntry {
  scope: "master";
  name: string;
  session: NamedMasterSession;
  savedAt: number;
}

export type NamedLayoutEntry = TabLayoutEntry | MasterLayoutEntry;

/** The on-disk store shape: name → entry (both scopes share the namespace). */
type NamedLayoutStore = Record<string, NamedLayoutEntry>;

/** Read + defensively parse the v2 store, migrating a legacy v1 store
 *  in-memory when the v2 key is absent. NEVER throws: unavailable
 *  localStorage, corrupt JSON, or structurally invalid values all yield {}
 *  (start empty). A structurally invalid ENTRY is dropped, not the store. */
function readStore(): NamedLayoutStore {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(NAMED_LAYOUTS_STORAGE_KEY);
    if (raw === null) {
      // No v2 blob — try the legacy v1 key (migrate in-memory; the on-disk v1
      // key stays until the first v2 write removes it).
      raw = localStorage.getItem(LEGACY_V1_STORAGE_KEY);
      if (raw === null) return {};
      return migrateV1(parseJsonObject(raw));
    }
  } catch {
    return {};
  }
  const parsed = parseJsonObject(raw);
  if (parsed === null) return {};
  const out: NamedLayoutStore = {};
  for (const [name, v] of Object.entries(parsed)) {
    const entry = coerceEntry(name, v);
    if (entry) out[name] = entry;
  }
  return out;
}

/** Parse a JSON object payload (null on any failure — never throws). */
function parseJsonObject(raw: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/** v1 shape: { [name]: { layout: object, savedAt: number } } → tab entries
 *  with tabTitle == name. Per-entry guard mirrors the v2 one; a poison entry
 *  is dropped, not the store. */
function migrateV1(parsed: Record<string, unknown> | null): NamedLayoutStore {
  if (parsed === null) return {};
  const out: NamedLayoutStore = {};
  for (const [name, v] of Object.entries(parsed)) {
    if (typeof v !== "object" || v === null) continue;
    const e = v as Record<string, unknown>;
    if (typeof e.layout !== "object" || e.layout === null) continue;
    if (typeof e.savedAt !== "number" || !Number.isFinite(e.savedAt)) continue;
    out[name] = {
      scope: "tab",
      name,
      tabTitle: name, // v1 predates tab titles — the layout's own name is it
      layout: e.layout as SerializedDockview,
      savedAt: e.savedAt,
    };
  }
  return out;
}

/** Structural guard for ONE v2 store value. Returns the coerced entry or null
 *  (the caller drops the entry). The layout blobs stay opaque objects — the
 *  cold-restore pipeline re-validates them at consume time. */
function coerceEntry(name: string, v: unknown): NamedLayoutEntry | null {
  if (typeof v !== "object" || v === null) return null;
  const e = v as Record<string, unknown>;
  if (typeof e.savedAt !== "number" || !Number.isFinite(e.savedAt)) return null;
  if (e.scope === "tab") {
    if (typeof e.layout !== "object" || e.layout === null) return null;
    // tabTitle falls back to the name when absent/malformed (a v2 blob from a
    // future variant that dropped it still loads sensibly).
    const tabTitle =
      typeof e.tabTitle === "string" && e.tabTitle.trim() !== ""
        ? e.tabTitle
        : name;
    return {
      scope: "tab",
      name,
      tabTitle,
      layout: e.layout as SerializedDockview,
      savedAt: e.savedAt,
    };
  }
  if (e.scope === "master") {
    if (typeof e.session !== "object" || e.session === null) return null;
    const s = e.session as Record<string, unknown>;
    if (!Array.isArray(s.workspaces)) return null;
    const workspaces: NamedMasterWorkspace[] = [];
    for (const w of s.workspaces) {
      if (typeof w !== "object" || w === null) return null;
      const rec = w as Record<string, unknown>;
      if (typeof rec.name !== "string" || rec.name.trim() === "") return null;
      if (typeof rec.layout !== "object" || rec.layout === null) return null;
      workspaces.push({
        name: rec.name,
        layout: rec.layout as SerializedDockview,
      });
    }
    const activeWorkspaceName =
      typeof s.activeWorkspaceName === "string" ? s.activeWorkspaceName : null;
    return { scope: "master", name, session: { activeWorkspaceName, workspaces }, savedAt: e.savedAt };
  }
  return null;
}

/** Never throws: quota exceeded / private mode just drops the write. Always
 *  removes the legacy v1 key — a v2 write supersedes any v1 blob (its
 *  entries were migrated in-memory on read). */
function writeStore(store: NamedLayoutStore): void {
  try {
    const keys = Object.keys(store);
    if (keys.length === 0) {
      localStorage.removeItem(NAMED_LAYOUTS_STORAGE_KEY);
    } else {
      localStorage.setItem(NAMED_LAYOUTS_STORAGE_KEY, JSON.stringify(store));
    }
    localStorage.removeItem(LEGACY_V1_STORAGE_KEY);
  } catch {
    // localStorage unavailable — swallow (best-effort persistence).
  }
}

/** Normalize a candidate layout name: trim + cap. An EMPTY result is invalid
 *  (the caller refuses the save/rename). */
export function normalizeLayoutName(name: string): string {
  return name.trim().slice(0, NAMED_LAYOUT_NAME_MAX);
}

/** Normalize a candidate tab title: trim + cap at the workspace-name bound.
 *  An EMPTY result tells the caller to fall back (the saver substitutes the
 *  layout name — a loaded workspace should always get a sensible title). */
export function normalizeTabTitle(title: string): string {
  return title.trim().slice(0, TAB_TITLE_MAX);
}

/** Sort helper: most-recent-first (savedAt desc; name asc as the tiebreak so
 *  the order is deterministic). */
function byRecency(a: { name: string; savedAt: number }, b: { name: string; savedAt: number }): number {
  return b.savedAt !== a.savedAt
    ? b.savedAt - a.savedAt
    : a.name.localeCompare(b.name);
}

/** The saved THIS-TAB layouts, most-recent-first. */
export function listTabLayouts(): { name: string; tabTitle: string; savedAt: number }[] {
  return Object.values(readStore())
    .filter((e): e is TabLayoutEntry => e.scope === "tab")
    .map((e) => ({ name: e.name, tabTitle: e.tabTitle, savedAt: e.savedAt }))
    .sort(byRecency);
}

/** The saved ALL-TABS (master) snapshots, most-recent-first. `tabs` is the
 *  workspace count carried in the snapshot's session (the list-row subtitle). */
export function listMasterLayouts(): { name: string; tabs: number; savedAt: number }[] {
  return Object.values(readStore())
    .filter((e): e is MasterLayoutEntry => e.scope === "master")
    .map((e) => ({ name: e.name, tabs: e.session.workspaces.length, savedAt: e.savedAt }))
    .sort(byRecency);
}

/**
 * Save ONE workspace's layout under `name` (scope "tab"). `tabTitle` is the
 * workspace title applied when the layout is loaded; an EMPTY (after trim)
 * title falls back to the layout name. SAME NAME = OVERWRITE (documented,
 * deliberate: "Save current" on an existing name updates the arrangement and
 * refreshes savedAt). The name is trimmed + capped; an empty name after trim
 * is refused (false). Returns true when written.
 */
export function saveTabLayout(
  name: string,
  tabTitle: string,
  layout: SerializedDockview,
): boolean {
  const n = normalizeLayoutName(name);
  if (!n) return false;
  const t = normalizeTabTitle(tabTitle) || n;
  const store = readStore();
  store[n] = { scope: "tab", name: n, tabTitle: t, layout, savedAt: Date.now() };
  writeStore(store);
  return true;
}

/**
 * Save a WHOLE-SESSION snapshot under `name` (scope "master"). The session
 * carries workspace NAMES + layouts and the active workspace's name (ids are
 * deliberately absent — they re-mint on load). SAME NAME = OVERWRITE (same
 * policy as the tab scope). Returns true when written.
 */
export function saveMasterLayout(
  name: string,
  session: NamedMasterSession,
): boolean {
  const n = normalizeLayoutName(name);
  if (!n) return false;
  const store = readStore();
  store[n] = { scope: "master", name: n, session, savedAt: Date.now() };
  writeStore(store);
  return true;
}

/** One saved entry (either scope), or null when nothing is saved under (the
 *  trimmed) name. */
export function loadNamedLayout(name: string): NamedLayoutEntry | null {
  const n = normalizeLayoutName(name);
  if (!n) return null;
  return readStore()[n] ?? null;
}

/** Delete the entry saved under (the trimmed) name — either scope. Returns
 *  true when an entry was actually removed. */
export function deleteNamedLayout(name: string): boolean {
  const n = normalizeLayoutName(name);
  if (!n) return false;
  const store = readStore();
  if (!(n in store)) return false;
  delete store[n];
  writeStore(store);
  return true;
}

/**
 * Rename the entry saved under `name` to `newName` (re-key). The entry itself
 * is preserved verbatim — scope, payload, and the ORIGINAL savedAt (a rename
 * is not a re-save). Validation: `newName` is trimmed + capped (60); an empty
 * result is refused; a COLLISION (any entry — either scope — already saved
 * under `newName`) is REJECTED (documented deliberate default: renaming onto
 * an existing name is ambiguous, and silently overwriting would destroy the
 * target — the UI surfaces an inline error instead). Renaming to the SAME
 * (trimmed) name is a no-op success. Returns true when the store now carries
 * the entry under `newName`.
 */
export function renameNamedLayout(name: string, newName: string): boolean {
  const oldKey = normalizeLayoutName(name);
  const newKey = normalizeLayoutName(newName);
  if (!oldKey || !newKey) return false;
  const store = readStore();
  const entry = store[oldKey];
  if (!entry) return false;
  if (newKey === oldKey) return true; // same name after trim — nothing to do
  if (newKey in store) return false; // collision — REJECT (no overwrite)
  delete store[oldKey];
  store[newKey] = { ...entry, name: newKey };
  writeStore(store);
  return true;
}
