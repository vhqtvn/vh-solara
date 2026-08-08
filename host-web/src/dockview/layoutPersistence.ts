import type { DockviewApi, SerializedDockview } from "dockview-core";
import {
  isFleetEntry,
  isRealFleet,
  resolveFleet,
  seedPaneSeq,
  type FleetEntry,
} from "../state/mockData";

// =============================================================================
// Layout persistence — save the Dockview tiling to localStorage and cold-restore
// it on a fresh page load. This is core to vh-solara's "resumable" promise: an
// operator's tiled arrangement survives a reload.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ HARD RULE (load-bearing — never violate):                                │
// │   api.fromJSON() is COLD-RESTORE ONLY. It disposes and recreates every   │
// │   panel, which RELOADS every iframe (proven by the architecture's         │
// │   survival gate: the `jsonReswap` negative control reloads every iframe   │
// │   precisely because it calls fromJSON at runtime). Therefore:            │
// │     • fromJSON() is called EXACTLY ONCE, during cold init in              │
// │       DockviewHost.onMount, BEFORE any iframe has a live identity.        │
// │     • It is NEVER called as a runtime re-render step, never on a layout   │
// │       mutation, never after init. Runtime ops (split/swap/close/collapse/ │
// │       zoom/move) keep mutating the LIVE tree (hostController) exactly as  │
// │       today — NO persistence-driven re-render.                            │
// │   The save side uses api.toJSON() (a read-only snapshot) — safe anytime.  │
// │                                                                           │
// │   Structural one-shot: `coldRestoreDone` makes a second fromJSON          │
// │   impossible — applyColdRestore() is a cached no-op on any second call,   │
// │   so no code path can ever drive a second restore.                        │
// └─────────────────────────────────────────────────────────────────────────┘
//
// PRECEDENCE (defensible default — NOT settled canon):
//   On cold start, SAVED-LAYOUT-WINS-WITH-VALIDATION; the fleet/mock seed is
//   the fallback when there is no valid saved layout. A future operator may
//   prefer "fleet config always wins" — this default is captured as a DEFER
//   candidate for operator review (see the task card this slice ships with).
// =============================================================================

/** Versioned + namespaced storage key. Bump the version to invalidate a schema
 *  change cleanly (a future format change ships a new key and reads no old data,
 *  so a stale/incompatible blob can never corrupt a restore). */
const LAYOUT_STORAGE_KEY = "vh-host:layout:v1";

/** Debounce window for saves. onDidLayoutChange fires in bursts (one drag fires
 *  many); coalescing into one write avoids hammering localStorage. ~450ms is a
 *  comfortable "user paused" cadence. */
const SAVE_DEBOUNCE_MS = 450;

// ---- one-shot guard for the single cold fromJSON ---------------------------
// Set true the moment applyColdRestore() runs; any later call returns the cached
// result and NEVER touches fromJSON again. This is the structural guarantee that
// the HARD RULE holds regardless of future callers.
let coldRestoreDone = false;
let coldRestoreRestored = false;

// ---- debounced save state --------------------------------------------------
let saveTimer: ReturnType<typeof setTimeout> | null = null;

// =============================================================================
// SAVE SIDE — read-only serialization, debounced, on Dockview's layout-change
// event. Hooked ONCE (installLayoutSaver); runtime ops do NOT each save — they
// mutate the live tree and Dockview aggregates the change into onDidLayoutChange.
// =============================================================================

/**
 * Hook the debounced save onto the Dockview api's layout-change event. Install
 * ONCE, during cold init, AFTER the cold restore / seed has run (so the initial
 * seed itself does not trigger a save — only subsequent user mutations do).
 */
export function installLayoutSaver(api: DockviewApi): void {
  api.onDidLayoutChange(() => scheduleSave(api));
}

function scheduleSave(api: DockviewApi): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persist(api);
  }, SAVE_DEBOUNCE_MS);
}

/** Serialize + write the current layout. Never throws: localStorage may be
 *  unavailable (private mode), over quota, or the serialize may fail — all are
 *  swallowed (persistence is best-effort). A degenerate/empty layout (zero
 *  panels) CLEARS the key so a reload re-seeds the fleet instead of restoring a
 *  blank workspace. */
function persist(api: DockviewApi): void {
  if (api.panels.length === 0) {
    try {
      localStorage.removeItem(LAYOUT_STORAGE_KEY);
    } catch {
      // localStorage unavailable — nothing to clear.
    }
    return;
  }
  let state: SerializedDockview;
  try {
    state = api.toJSON();
  } catch {
    return; // serialize failure — never throw
  }
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable / quota exceeded / private mode, OR a JSON
    // serialize failure (a non-cloneable value inside api.toJSON) — swallow.
  }
}

// =============================================================================
// RESTORE SIDE — read, parse, VALIDATE every pane url, REPAIR (drop invalid
// panes), then call fromJSON exactly once if ≥1 valid pane survives.
// =============================================================================

/**
 * COLD-RESTORE ONLY (HARD RULE). Read the saved layout from localStorage,
 * validate every pane url via the SAME isFleetEntry guard the fleet resolver
 * uses, repair (drop invalid panes from the tree), and — if ≥1 valid pane
 * survives — call api.fromJSON() EXACTLY ONCE, before any iframe has a live
 * identity.
 *
 * Returns true when a saved layout was restored (caller skips the seed); false
 * when there was no valid saved layout (caller falls back to seedInitialPanes).
 *
 * One-shot: the `coldRestoreDone` guard makes a second fromJSON structurally
 * impossible — any second call is a cached no-op.
 */
export function applyColdRestore(api: DockviewApi): boolean {
  if (coldRestoreDone) return coldRestoreRestored; // one-shot: never fromJSON twice
  coldRestoreDone = true;
  try {
    const repaired = loadRepairedLayout();
    if (!repaired) {
      coldRestoreRestored = false;
      return false;
    }
    // COLD ONLY — the single fromJSON call in the whole app (outside the DEV-only
    // jsonReswap negative control, which exists to PROVE this reloads iframes).
    api.fromJSON(repaired);
    // Advance the pane-id counter past the restored ids so a post-reload split
    // does not collide with a restored pane-N (fromJSON reuses saved ids verbatim
    // while the module counter resets to 0 on a cold load).
    seedPaneSeq(maxPaneSeqSuffix(Object.keys(repaired.panels)));
    coldRestoreRestored = true;
  } catch {
    // ANY failure — a malformed layout that slipped past validation, an
    // unexpected throw in the repair walker, or fromJSON rejecting the repaired
    // tree — falls back to seed. Cold init must NEVER crash; persistence is
    // best-effort (mirrors resolveFleet's never-throw-on-bad-config stance).
    // (fromJSON's clear()-on-throw most likely left the api empty; clear() again
    //  is belt-and-suspenders so seedInitialPanes starts from a clean slate.)
    coldRestoreRestored = false;
    try {
      api.clear();
    } catch {
      // ignore — seed will addPanels regardless
    }
  }
  return coldRestoreRestored;
}

/**
 * Read + parse + validate + repair the saved layout. Returns the repaired
 * SerializedDockview (only valid panes), or null when there is no valid saved
 * layout (absent / corrupt JSON / wrong shape / zero valid panes). Never throws.
 */
export function loadRepairedLayout(): SerializedDockview | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
  } catch {
    return null; // localStorage unavailable
  }
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null; // corrupt JSON → treat as no layout → fall back to seed
  }
  if (!isSavedLayout(parsed)) return null;
  const validIds = validRestoreIds(parsed.panels);
  if (validIds.size === 0) return null;
  const repaired = repairLayout(parsed, validIds);
  return repaired ? (repaired as unknown as SerializedDockview) : null;
}

// ---- per-pane url validation (defense-in-depth: never trust stored data) ----
// The restored url is assigned to an UNSANDBOXED iframe.src, so a javascript: /
// data: / opaque value written into a compromised localStorage would execute
// same-origin against the host shell. Every restored pane url is re-run through
// the SAME isFleetEntry http/https guard the fleet resolver uses (never weaken
// it). In real-fleet mode the url origin is ADDITIONALLY required to be a member
// of the configured fleet (a stale pane pointing at a server no longer declared
// is dropped too). Invalid panes are dropped from the restore set (mirrors the
// F1 fleet-guard pattern: drop bad entries, fall back only if that empties it).
//
// MODE ASYMMETRY (deliberate): in MOCK mode only the http/https protocol guard
// runs (fleetOrigins is null), so a compromised mock-mode localStorage could
// restore a pane pointing at an arbitrary third-party http origin. The threat
// model stays closed because the iframe keeps its real cross-origin (it cannot
// script the host); and mock mode is a dev/test posture, not a production fleet.
// Real-fleet mode tightens this with the origin-membership allowlist above.
function validRestoreIds(panels: SavedLayout["panels"]): Set<string> {
  const fleetOrigins = isRealFleet()
    ? new Set(
        resolveFleet()
          .map((e) => safeOrigin(e.url))
          .filter((o): o is string => o !== null),
      )
    : null;
  const valid = new Set<string>();
  for (const [id, st] of Object.entries(panels)) {
    const params = st?.params;
    if (!isFleetEntry(params)) continue; // not {url,label} or not http/https
    if (fleetOrigins) {
      const origin = safeOrigin((params as FleetEntry).url);
      if (!origin || !fleetOrigins.has(origin)) continue; // not a configured server
    }
    valid.add(id);
  }
  return valid;
}

function safeOrigin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Largest numeric suffix among ids shaped `pane-<n>`; 0 when none match. Used
 *  to seed the pane-id counter past the restored range. */
function maxPaneSeqSuffix(ids: Iterable<string>): number {
  let max = 0;
  for (const id of ids) {
    const m = /^pane-(\d+)$/.exec(id);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

// =============================================================================
// REPAIR — drop invalid panels from the serialized tree so fromJSON never sees a
// poisoned url. Walks the grid tree (filtering each group's views), prunes empty
// groups, repairs floating/popout groups, and cleans a stale activeGroup.
// =============================================================================

function repairLayout(
  layout: SavedLayout,
  validIds: Set<string>,
): SavedLayout | null {
  // 1. Drop invalid panel entries from the panels map.
  const panels: SavedLayout["panels"] = {};
  for (const [id, st] of Object.entries(layout.panels)) {
    if (validIds.has(id)) panels[id] = st;
  }

  // 2. Prune the grid tree; collect surviving group ids (to clean activeGroup).
  const survivingGroups = new Set<string>();
  const root = pruneGridNode(layout.grid.root, validIds, survivingGroups);
  if (!root) return null; // no valid pane anywhere in the grid

  // 3. Repair floating + popout groups (collapse-to-tray / popout panes).
  const floatingGroups = repairGroups(
    layout.floatingGroups,
    validIds,
    survivingGroups,
  );
  const popoutGroups = repairGroups(
    layout.popoutGroups,
    validIds,
    survivingGroups,
  );

  // 4. Clean activeGroup if it references a now-removed group.
  const activeGroup =
    layout.activeGroup && survivingGroups.has(layout.activeGroup)
      ? layout.activeGroup
      : undefined;

  const result: SavedLayout = {
    ...layout,
    grid: { ...layout.grid, root },
    panels,
    activeGroup,
  };
  if (floatingGroups !== undefined) result.floatingGroups = floatingGroups;
  else delete result.floatingGroups;
  if (popoutGroups !== undefined) result.popoutGroups = popoutGroups;
  else delete result.popoutGroups;
  return result;
}

/** Prune one grid node: filter a leaf's views to valid ids (drop the leaf when
 *  empty); recurse a branch and collapse it when it loses children. Returns the
 *  pruned node, or null when the node has no valid pane left. */
function pruneGridNode(
  node: GridNode,
  validIds: Set<string>,
  survivingGroups: Set<string>,
): GridNode | null {
  if (node.type === "leaf") {
    const views = node.data.views.filter((v) => validIds.has(v));
    if (views.length === 0) return null;
    survivingGroups.add(node.data.id);
    return {
      ...node,
      data: {
        ...node.data,
        views,
        activeView: pickActive(node.data.activeView, views),
      },
    };
  }
  const children = node.data
    .map((c) => pruneGridNode(c, validIds, survivingGroups))
    .filter((c): c is GridNode => c !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]; // collapse single-child branch
  return { ...node, data: children };
}

/** Repair the floating/popout group list: filter each group's views, drop groups
 *  that become empty. Returns the repaired list, or undefined when the original
 *  had none. */
function repairGroups(
  groups: FloatingGroup[] | undefined,
  validIds: Set<string>,
  survivingGroups: Set<string>,
): FloatingGroup[] | undefined {
  if (!groups || groups.length === 0) return groups;
  const out: FloatingGroup[] = [];
  for (const fg of groups) {
    if (fg.data) {
      const views = fg.data.views.filter((v) => validIds.has(v));
      if (views.length === 0) continue; // drop the empty floating group
      survivingGroups.add(fg.data.id);
      out.push({
        ...fg,
        data: { ...fg.data, views, activeView: pickActive(fg.data.activeView, views) },
      });
    } else if (fg.grid) {
      const root = pruneGridNode(fg.grid.root, validIds, survivingGroups);
      if (root) out.push({ ...fg, grid: { ...fg.grid, root } });
    }
  }
  return out;
}

function pickActive(
  activeView: string | undefined,
  views: string[],
): string | undefined {
  if (activeView && views.includes(activeView)) return activeView;
  return undefined; // let dockview pick the first view
}

// ---- structural shape guards (so the walker is safe; fromJSON is the final
//      authority on full validity, and applyColdRestore catches any throw) -----

function isSavedLayout(v: unknown): v is SavedLayout {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o.grid !== "object" || o.grid === null) return false;
  const g = o.grid as Record<string, unknown>;
  if (!isGridNode(g.root)) return false;
  if (typeof o.panels !== "object" || o.panels === null || Array.isArray(o.panels)) {
    return false;
  }
  // floatingGroups / popoutGroups are OPTIONAL, but when present they MUST be
  // arrays of non-null objects — otherwise the repair walker's `for…of` +
  // property access would throw (violating loadRepairedLayout's "Never throws"
  // contract). A malformed value here rejects the whole blob → fall back to seed.
  if (!isOptionalGroupArray(o.floatingGroups)) return false;
  if (!isOptionalGroupArray(o.popoutGroups)) return false;
  return true;
}

function isOptionalGroupArray(v: unknown): boolean {
  if (v === undefined) return true;
  if (!Array.isArray(v)) return false;
  return v.every((x) => typeof x === "object" && x !== null);
}

function isGridNode(v: unknown): v is GridNode {
  if (typeof v !== "object" || v === null) return false;
  const n = v as Record<string, unknown>;
  if (n.type === "leaf") return isGroupView(n.data);
  if (n.type === "branch") {
    return Array.isArray(n.data) && (n.data as unknown[]).every(isGridNode);
  }
  return false;
}

function isGroupView(v: unknown): v is GroupView {
  if (typeof v !== "object" || v === null) return false;
  const g = v as Record<string, unknown>;
  return (
    typeof g.id === "string" &&
    Array.isArray(g.views) &&
    g.views.every((x) => typeof x === "string")
  );
}

// =============================================================================
// Local structural mirror of Dockview's serialized shape.
//
// The upstream `SerializedGridObject<T>` declares `data: T | SerializedGridObject<T>[]`
// as a bare union NOT tied to the `type` discriminant, so TypeScript cannot narrow
// `data` on `type` — making type-safe tree mutation awkward. These local types are
// a proper discriminated union (leaf→GroupView, branch→GridNode[]) with the SAME
// field shape, cast to/from `SerializedDockview` at the module boundary. Only the
// fields persistence touches are modeled; `params` stays opaque (validated by
// isFleetEntry, not by these structural types).
// =============================================================================

interface GroupView {
  id: string;
  views: string[];
  activeView?: string;
}
interface GridLeaf {
  type: "leaf";
  data: GroupView;
  size?: number;
  visible?: boolean;
}
interface GridBranch {
  type: "branch";
  data: GridNode[];
  size?: number;
  visible?: boolean;
}
type GridNode = GridLeaf | GridBranch;
interface FloatingGroup {
  data?: GroupView;
  grid?: { root: GridNode; width?: number; height?: number; orientation?: string };
  position?: unknown;
}
interface SavedLayout {
  grid: { root: GridNode; width?: number; height?: number; orientation?: string };
  panels: Record<string, { params?: unknown }>;
  activeGroup?: string;
  floatingGroups?: FloatingGroup[];
  popoutGroups?: FloatingGroup[];
}
