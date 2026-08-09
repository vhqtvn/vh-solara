import type { DockviewApi, SerializedDockview } from "dockview-core";
import {
  hasRealFleetEnv,
  isFleetEntry,
  resolveBaseFleet,
  seedPaneSeq,
  type FleetEntry,
} from "../state/mockData";

// =============================================================================
// Layout persistence — multi-workspace edition.
//
// The host shell now models N workspaces, each its own Dockview layout tree of
// server panes. The persisted blob stores the workspace SET plus each
// workspace's serialized Dockview layout, so a reload restores every workspace
// AND its tiling. The active workspace is remembered too.
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │ HARD RULE (load-bearing — never violate):                                │
// │   api.fromJSON() is COLD-RESTORE ONLY. It disposes and recreates every   │
// │   panel in that workspace, which RELOADS every iframe in it (proven by   │
// │   the architecture's survival gate: the `jsonReswap` negative control     │
// │   reloads every iframe precisely because it calls fromJSON at runtime).  │
// │   Therefore:                                                              │
// │     • fromJSON() is called EXACTLY ONCE PER WORKSPACE, during that        │
// │       workspace host's cold init (DockviewHost.onMount), BEFORE any of    │
// │       its iframes have a live identity.                                   │
// │     • It is NEVER called as a runtime re-render step, never on a layout   │
// │       mutation, never after init. Runtime ops (split/swap/close/collapse/ │
// │       zoom/move/addServer) keep mutating the LIVE tree (hostController)   │
// │       exactly as today — NO persistence-driven re-render.                 │
// │     • Switching workspaces is CSS-visibility-only (the overlay stack in   │
// │       App.tsx) and NEVER touches fromJSON.                                │
// │   The save side uses api.toJSON() (a read-only snapshot) — safe anytime.  │
// │                                                                           │
// │   Structural one-shot: `restoredWorkspaceIds` makes a second fromJSON     │
// │   per workspace impossible — applyColdRestoreForWorkspace(wsId) is a      │
// │   cached no-op on any second call for that ws, so no code path can drive  │
// │   a second restore.                                                       │
// └─────────────────────────────────────────────────────────────────────────┘
//
// SCHEMA (v2 — bumped from v1's single-layout blob; v1 data will not parse and
// cleanly falls back to seed, so a stale v1 blob can never corrupt a restore):
//
//   {
//     activeWorkspaceId: string,
//     workspaces: Array<{
//       id: string,
//       name: string,
//       layout: SerializedDockview | null   // null = empty workspace
//     }>
//   }
//
// PRECEDENCE (defensible default — NOT settled canon): on cold start, for each
// workspace, SAVED-LAYOUT-WINS-WITH-VALIDATION; the fleet/mock seed is the
// fallback ONLY for the default workspace when there was no blob at all. A
// workspace created at runtime (addWorkspace) has no saved layout and is empty
// by design (the empty-workspace affordance prompts Add Server).
// =============================================================================

/** Versioned + namespaced storage key. Bumped to v2 for the multi-workspace
 *  schema (v1's single-layout blob will not parse → falls back to seed). */
export const LAYOUT_STORAGE_KEY = "vh-host:layout:v2";

/** Debounce window for saves. onDidLayoutChange fires in bursts (one drag fires
 *  many); coalescing into one write avoids hammering localStorage. ~450ms is a
 *  comfortable "user paused" cadence. */
const SAVE_DEBOUNCE_MS = 450;

// ---- persisted-state shape -------------------------------------------------

export interface WorkspaceSetEntry {
  id: string;
  name: string;
}
export interface PersistedWorkspace extends WorkspaceSetEntry {
  layout: SerializedDockview | null;
}
export interface PersistedState {
  activeWorkspaceId: string;
  workspaces: PersistedWorkspace[];
}

// ---- one-shot guard for cold fromJSON, per workspace -----------------------
// A workspace id enters this set the moment applyColdRestoreForWorkspace runs
// for it; any later call for the same ws returns the cached result and NEVER
// touches fromJSON again. This is the structural guarantee that the HARD RULE
// holds per workspace regardless of future callers.
const restoredWorkspaceIds = new Set<string>();
const restoredWorkspaceResult = new Map<string, boolean>();

// ---- debounced save state --------------------------------------------------
let saveTimer: ReturnType<typeof setTimeout> | null = null;
// The serializer is registered by the store at init (it owns the workspace
// list + the per-workspace DockviewApi registry). Kept as a registered callback
// so this module stays decoupled from the store (no import cycle).
let serializeAllFn: (() => PersistedState | null) | null = null;

// ---- the parsed blob, read ONCE at module init -----------------------------
// Reading once keeps cold init deterministic: loadWorkspaceSet(),
// loadRepairedWorkspaceLayout(wsId), and hadSavedStateAtInit() all consult the
// SAME parsed snapshot rather than re-reading localStorage mid-init.
const initBlob: PersistedState | null = readBlob();

// =============================================================================
// SAVE SIDE — read-only serialization, debounced, on any workspace's layout-
// change event OR on a workspace-set/active change. Hooked per workspace via
// installLayoutSaver(api); the store calls scheduleSave() on add/close/switch.
// =============================================================================

/** Register the serializer the debounced writer calls on flush. The store owns
 *  this (it has the workspace list + the DockviewApi registry). */
export function setSerializeAllFn(fn: (() => PersistedState | null) | null): void {
  serializeAllFn = fn;
}

/** Request a debounced save of the full multi-workspace state. Idempotent under
 *  rapid calls (coalesces into one write). Safe to call from any layout change,
 *  workspace add/remove, or active-workspace switch. */
export function scheduleSave(): void {
  if (saveTimer !== null) clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DEBOUNCE_MS);
}

function flushSave(): void {
  saveTimer = null;
  if (!serializeAllFn) return;
  let state: PersistedState | null;
  try {
    state = serializeAllFn();
  } catch {
    return; // serialize failure — never throw
  }
  if (!state || state.workspaces.length === 0) {
    // No workspaces (should not happen — there is always ≥1). Clear so a reload
    // re-seeds rather than restoring a degenerate empty blob.
    try {
      localStorage.removeItem(LAYOUT_STORAGE_KEY);
    } catch {
      // localStorage unavailable — nothing to clear.
    }
    return;
  }
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage unavailable / quota exceeded / private mode, OR a JSON
    // serialize failure (a non-cloneable value inside api.toJSON) — swallow.
  }
}

/**
 * Hook the debounced save onto ONE workspace's Dockview api layout-change
 * event. Called per workspace host during cold init, AFTER that workspace's
 * cold restore / seed has run (so the initial restore itself does not trigger a
 * save — only subsequent user mutations do). Any workspace's layout change
 * schedules a save of the WHOLE state (the writer serializes every workspace).
 */
export function installLayoutSaver(api: DockviewApi): void {
  api.onDidLayoutChange(() => scheduleSave());
}

// =============================================================================
// RESTORE SIDE — read, parse, VALIDATE every workspace + every pane url, REPAIR
// (drop invalid panes per workspace), then call fromJSON exactly once per
// workspace inside that workspace host's onReady.
// =============================================================================

/** Was there a valid v2 blob at module init? When false, the store creates the
 *  default workspace and the default workspace seeds the fleet/mock. When true,
 *  the workspace SET + each workspace's layout are restored from the blob. */
export function hadSavedStateAtInit(): boolean {
  return initBlob !== null;
}

/**
 * The workspace SET (ids + names) persisted in the blob, or null when there was
 * no valid blob. The store uses this to initialize its workspaces() signal. The
 * per-workspace LAYOUT is read separately by each host via
 * loadRepairedWorkspaceLayout(wsId) — the set is read once at init so every host
 * sees a stable snapshot.
 */
export function loadWorkspaceSet(): {
  activeWorkspaceId: string;
  workspaces: WorkspaceSetEntry[];
} | null {
  if (!initBlob) return null;
  return {
    activeWorkspaceId: initBlob.activeWorkspaceId,
    workspaces: initBlob.workspaces.map((w) => ({ id: w.id, name: w.name })),
  };
}

/**
 * COLD-RESTORE ONLY (HARD RULE). Read the saved layout for ONE workspace from
 * the init blob, validate every pane url via the SAME isFleetEntry guard the
 * fleet resolver uses, repair (drop invalid panes from that workspace's tree),
 * and — if ≥1 valid pane survives — call api.fromJSON() EXACTLY ONCE for this
 * workspace, before any of its iframes has a live identity.
 *
 * Returns true when a saved layout was restored (caller skips seed); false when
 * there was no valid saved layout for this workspace (caller falls back to seed
 * for the default workspace, or leaves it empty for a runtime-added workspace).
 *
 * One-shot per workspace: the `restoredWorkspaceIds` guard makes a second
 * fromJSON for the same ws structurally impossible — any second call is a
 * cached no-op.
 */
export function applyColdRestoreForWorkspace(
  api: DockviewApi,
  workspaceId: string,
): boolean {
  if (restoredWorkspaceIds.has(workspaceId)) {
    return restoredWorkspaceResult.get(workspaceId) ?? false;
  }
  restoredWorkspaceIds.add(workspaceId);
  try {
    const repaired = loadRepairedWorkspaceLayout(workspaceId);
    if (!repaired) {
      restoredWorkspaceResult.set(workspaceId, false);
      return false;
    }
    // COLD ONLY — the single fromJSON call for THIS workspace (outside the
    // DEV-only jsonReswap negative control, which exists to PROVE this reloads
    // iframes).
    api.fromJSON(repaired);
    // Advance the pane-id counter past the restored ids so a post-reload split
    // does not collide with a restored pane-N (fromJSON reuses saved ids
    // verbatim while the module counter resets to 0 on a cold load).
    seedPaneSeq(maxPaneSeqSuffix(Object.keys(repaired.panels)));
    restoredWorkspaceResult.set(workspaceId, true);
  } catch {
    // ANY failure — a malformed layout that slipped past validation, an
    // unexpected throw in the repair walker, or fromJSON rejecting the repaired
    // tree — falls back to seed/empty. Cold init must NEVER crash; persistence
    // is best-effort (mirrors resolveFleet's never-throw-on-bad-config stance).
    restoredWorkspaceResult.set(workspaceId, false);
    try {
      api.clear();
    } catch {
      // ignore — seed/empty will addPanels regardless
    }
  }
  return restoredWorkspaceResult.get(workspaceId) ?? false;
}

/**
 * Read + repair ONE workspace's saved layout from the init blob. Returns the
 * repaired SerializedDockview (only valid panes), or null when this workspace
 * has no entry / no layout / a layout with zero valid panes. Never throws.
 */
export function loadRepairedWorkspaceLayout(
  workspaceId: string,
): SerializedDockview | null {
  if (!initBlob) return null;
  const ws = initBlob.workspaces.find((w) => w.id === workspaceId);
  if (!ws || !ws.layout) return null;
  if (!isSavedLayout(ws.layout)) return null;
  const validIds = validRestoreIds(ws.layout.panels);
  if (validIds.size === 0) return null;
  const repaired = repairLayout(ws.layout, validIds);
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
// Real-fleet mode tightens this with the origin-membership allowlist.
function validRestoreIds(panels: SavedLayout["panels"]): Set<string> {
  // The origin allowlist is anchored to the BUILD-TIME VITE_SERVERS config
  // (hasRealFleetEnv + resolveBaseFleet), NOT the runtime catalog. This keeps
  // layout restore ORTHOGONAL to the runtime server list: adding/removing a
  // runtime server never gates which panes restore. (Using isRealFleet()/
  // resolveFleet() here would let the runtime catalog reshape the allowlist and
  // drop restored panes that point at build-time-only servers — a behavior
  // change this slice must NOT introduce.)
  const fleetOrigins = hasRealFleetEnv()
    ? new Set(
        resolveBaseFleet()
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
// BLOB READ + structural validation of the v2 envelope.
// =============================================================================

/** Read + parse + structurally validate the v2 blob. Returns null when absent /
 *  corrupt JSON / wrong envelope shape. Never throws. Called ONCE at module
 *  init. */
function readBlob(): PersistedState | null {
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
    return null; // corrupt JSON → treat as no blob → fall back to seed
  }
  return validatePersistedState(parsed);
}

/** Structural guard for the v2 envelope. Per-workspace layout blobs are
 *  validated separately by isSavedLayout() inside loadRepairedWorkspaceLayout.
 *
 *  ENVELOPE POLICY (deliberate, conservative): if ANY workspace entry is
 *  structurally malformed (bad id/name, or a layout that fails isSavedLayout),
 *  the WHOLE blob is rejected → the store falls back to a single default
 *  workspace + seed. We do NOT attempt partial recovery (keeping valid sibling
 *  workspaces while nulling one bad entry): a poisoned/mangled envelope is
 *  treated as untrusted wholesale, and the safe recovery is the default seed.
 *  (Per-entry URL poisoning is still handled per-workspace by the repair walker
 *  inside loadRepairedWorkspaceLayout — that is a different, narrower concern.) */
function validatePersistedState(v: unknown): PersistedState | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.activeWorkspaceId !== "string") return null;
  if (!Array.isArray(o.workspaces)) return null;
  const workspaces: PersistedWorkspace[] = [];
  for (const entry of o.workspaces) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || typeof e.name !== "string") return null;
    // layout may be null (empty workspace) or a saved-layout object.
    if (e.layout !== null && (typeof e.layout !== "object" || !isSavedLayout(e.layout))) {
      return null;
    }
    workspaces.push({
      id: e.id,
      name: e.name,
      layout: e.layout as SerializedDockview | null,
    });
  }
  if (workspaces.length === 0) return null;
  // activeWorkspaceId must reference an existing workspace; otherwise the store
  // would activate a ghost. Drop the whole blob (fall back to seed) on mismatch
  // — a clean, conservative recovery.
  if (!workspaces.some((w) => w.id === o.activeWorkspaceId)) return null;
  return { activeWorkspaceId: o.activeWorkspaceId, workspaces };
}

// =============================================================================
// REPAIR — drop invalid panels from a serialized tree so fromJSON never sees a
// poisoned url. Walks the grid tree (filtering each group's views), prunes empty
// groups, repairs floating/popout groups, and cleans a stale activeGroup.
// (Unchanged from v1; applied per-workspace now.)
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
  const prunedRoot = pruneGridNode(layout.grid.root, validIds, survivingGroups);
  if (!prunedRoot) return null; // no valid pane anywhere in the grid
  // Dockview's fromJSON REQUIRES the grid root to be a BRANCH. pruneGridNode
  // collapses a single-child branch to its child (correct for nested branches),
  // so a layout with exactly ONE surviving group yields a LEAF root — which
  // fromJSON rejects with "root must be of type branch". Wrap a leaf root back
  // into a branch so single-pane workspaces restore correctly. (This was a
  // latent bug in v1 too, exposed by the multi-workspace single-pane case.)
  const root: GridNode =
    prunedRoot.type === "branch"
      ? prunedRoot
      : { type: "branch", data: [prunedRoot] };

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
//      authority on full validity, and applyColdRestoreForWorkspace catches any throw) ----

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
  // property access would throw (violating the "Never throws" contract). A
  // malformed value here rejects the whole layout → null → fall back.
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
