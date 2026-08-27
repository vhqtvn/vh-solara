import type { DockviewApi, SerializedDockview } from "dockview-core";
import {
  hasRealFleetEnv,
  isFleetEntry,
  nextPaneId,
  resolveBaseFleet,
  seedPaneSeq,
  type FleetEntry,
} from "../state/mockData";
import { fractionsToSizes, sizesToFractions } from "./fractionMath";

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
// SCHEMA (v3 — FRACTIONAL split geometry; operator directive 2026-08-23: "the
// layout is bad when there are window resizing — store split offsets as
// global percentage instead of pixels"):
//
//   {
//     v: 3,                        // schema marker (v2 blobs lack it → migrate)
//     activeWorkspaceId: string,
//     workspaces: Array<{
//       id: string,
//       name: string,
//       layout: FractionalLayout | null   // null = empty workspace
//     }>
//   }
//
// A FractionalLayout is dockview's serialized shape EXCEPT every grid-tree
// child carries `fraction` (its share of the PARENT branch's extent, siblings
// summing to ~1) instead of a pixel `size`. Per-branch fractions compose into
// viewport-independent "global percentages": restoring at ANY container size
// recomputes px = fraction × the branch's extent (root extent = the CURRENT
// container, measured at cold-restore time), largest-remainder distributed so
// siblings sum exactly to the extent. Dockview then re-derives its own
// splitview proportions from those px, so the restore is proportional by
// construction (probe-verified: px blobs restored proportionally too, via
// ctor-time saveProportions — but the STORED artifact is now size-free).
//
// v2 → v3 MIGRATION (lossless, in-memory on read): a v2 px blob (localStorage
// key vh-host:layout:v2 OR an old #state= hash payload) fractionizes with
// fraction = size / siblingSum — viewport-independent math — and restores the
// same way. No forced re-seed; the next save writes the v3 key. v1
// (pre-workspace single-layout) blobs still fail the envelope parse → seed.
//
// ZERO-SIZE GUARD: a branch whose sibling px sum is 0/missing/non-finite (or
// whose fractions are degenerate) restores to EQUAL fractions (documented in
// fractionMath.ts sizesToFractions) — never NaN, never a crash.
//
// PRECEDENCE (defensible default — NOT settled canon): on cold start, for each
// workspace, SAVED-LAYOUT-WINS-WITH-VALIDATION; the fleet/mock seed is the
// fallback ONLY for the default workspace when there was no blob at all. A
// workspace created at runtime (addWorkspace) has no saved layout and is empty
// by design (the empty-workspace affordance prompts Add Server).
// =============================================================================

/** Versioned + namespaced storage key. Bumped v2→v3 for FRACTIONAL split
 *  geometry (v2 stored dockview's serialized px sizes). Legacy v2 blobs are
 *  migrated losslessly on read (px→fraction is viewport-independent); v1
 *  blobs fall back to seed. */
export const LAYOUT_STORAGE_KEY = "vh-host:layout:v3";

/** The superseded v2 key — read as a fallback when the v3 key is absent (the
 *  operator's existing px blob migrates instead of re-seeding), and removed
 *  on the first v3 write AND on a full clear (it is superseded). */
const LEGACY_V2_STORAGE_KEY = "vh-host:layout:v2";

/** Debounce window for saves. onDidLayoutChange fires in bursts (one drag fires
 *  many); coalescing into one write avoids hammering localStorage. ~450ms is a
 *  comfortable "user paused" cadence. */
const SAVE_DEBOUNCE_MS = 450;

// ---- persisted-state shape -------------------------------------------------

/** Schema marker. v3 = fractional grid trees (written since the split-offset
 *  directive). Absent = a legacy v2 px blob — migrated in-memory on read. */
export type PersistedStateVersion = 3;

export interface WorkspaceSetEntry {
  id: string;
  name: string;
}
export interface PersistedWorkspace extends WorkspaceSetEntry {
  layout: SerializedDockview | null;
}
export interface PersistedState {
  v?: PersistedStateVersion;
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

// ---- flush-on-hide (mobile kill mitigation) ---------------------------------
// The debounced save assumes the page lives ≥ SAVE_DEBOUNCE_MS after the last
// mutation. Android PWAs break that assumption: a backgrounded standalone app
// is frozen (timers suspended) and later killed WITHOUT firing unload-family
// events at kill time, so a save scheduled inside that window dies with the
// process — the relaunch (clean start_url, NO hash) falls back to the
// localStorage mirror, which is still the PREVIOUS flush (on a fresh PWA
// context: the boot-time seed write) → "PWA relaunch resets workspaces". The
// LAST event the page is guaranteed to see before such a kill is the
// transition to HIDDEN (visibilitychange → hidden — screen off / home /
// app-switch / swipe-away all fire it), plus pagehide for navigations and
// graceful closes. Both flush SYNCHRONOUSLY below: localStorage.setItem and
// history.replaceState are sync and unload-safe, while ANY async deferral
// (promise/setTimeout) would itself die with the process.
//
// Both hooks are guarded by `saveTimer !== null`: a hide with NOTHING pending
// performs NO write (no spurious mirror churn — pinned by the kill/relaunch
// e2e's byte-identical-blob test). Double-firing is impossible: the first
// flush clears the timer. Installed ONCE at module init, right after the
// init-blob read; listeners live for the page lifetime (no uninstall needed —
// the module is page-scoped and tests get a fresh page/document each).
function flushPendingSaveNow(): void {
  if (saveTimer === null) return; // nothing pending — no spurious writes
  clearTimeout(saveTimer);
  flushSave();
}

/** Install the visibilitychange(hidden) + pagehide listeners that flush a
 *  pending debounced save synchronously before the page can be killed.
 *  Idempotent; browser-guarded (SSR/no-window safety, mirroring writeHashState). */
export function installFlushOnHide(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  if ((window as FlushOnHideFlag).__vhFlushOnHideInstalled) return;
  (window as FlushOnHideFlag).__vhFlushOnHideInstalled = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushPendingSaveNow();
  });
  window.addEventListener("pagehide", () => flushPendingSaveNow());
}
/** Marker-interface for the idempotence flag above (window stays untyped). */
interface FlushOnHideFlag {
  __vhFlushOnHideInstalled?: boolean;
}

installFlushOnHide();

// =============================================================================
// SAVE SIDE — read-only serialization, debounced, on any workspace's layout-
// change event OR on a workspace-set/active change. Hooked per workspace via
// installLayoutSaver(api); the store calls scheduleSave() on add/close/switch.
// =============================================================================

/** Register the serializer the debounced writer calls on flush. The store owns
 *  this (it has the workspace list + the per-workspace DockviewApi registry). */
export function setSerializeAllFn(fn: (() => PersistedState | null) | null): void {
  serializeAllFn = fn;
}

/**
 * Serialize ONE workspace's live api into the SAVED (fractional v3) shape —
 * the exact transform flushSave applies to every workspace on save
 * (api.toJSON() → fractionizeSavedLayout). Read-only + never throws. The
 * named-layouts save path uses this so a saved named layout is
 * byte-compatible with a PersistedWorkspace.layout (no second serialization
 * format); the cold-restore pipeline consumes it verbatim.
 */
export function serializeWorkspaceLayout(api: DockviewApi): SerializedDockview {
  return fractionizeSavedLayout(
    api.toJSON() as unknown as SavedLayout,
  ) as unknown as SerializedDockview;
}

// ---- staged runtime-layout slot (named-layout load path) --------------------
// A workspace created AT RUNTIME (addWorkspace) has no entry in the init blob
// (read once at module init), so its cold restore would find nothing and it
// would mount empty. The named-layout LOAD path instead instantiates the saved
// layout as a NEW workspace: addWorkspace(name, layout) stages the saved-shape
// blob here keyed by the fresh workspace id BEFORE the store push, and that
// workspace's DockviewHost cold-restores it at mount through the SAME
// loadRepairedWorkspaceLayout pipeline an initBlob entry gets (url validation,
// repair, fraction materialization, one-shot fromJSON). This reuses the
// existing cold-restore path verbatim — there is no second restore
// implementation, and fromJSON still runs exactly once per workspace, at mount,
// before any of its iframes exist (the HARD RULE above is preserved).
//
// CONSUMED ON READ (one-shot): the entry is taken — not peeked — by
// loadRepairedWorkspaceLayout, so one load = one instantiation and a staged
// blob can never restore twice. Pane ids are RE-ASSIGNED at consume time
// (reIdLayoutPanels): fromJSON recreates panels with their saved ids verbatim,
// but pane ids are GLOBAL keys in the host store (survivalMap, sourceMap,
// statusByPane, …) — reusing the saved ids while the source workspace is still
// live (or loading the same named layout twice) would alias two live iframes
// to one paneId and thrash their heartbeat identities. Group ids are left
// verbatim: they are PER-DOCKVIEW-INSTANCE namespaces (verified in
// dockview-core: nextGroupId is an instance field, getNextGroupId skips ids
// already in the instance's _groups, and createGroup reassigns duplicates).
const stagedRuntimeLayouts = new Map<string, SerializedDockview>();

/** Stage a saved-shape layout for a workspace that does not exist yet. The
 *  next applyColdRestoreForWorkspace for `wsId` consumes it at cold mount. */
export function stageRuntimeWorkspaceLayout(
  wsId: string,
  layout: SerializedDockview,
): void {
  stagedRuntimeLayouts.set(wsId, layout);
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
  // Fork 1: a single JSON string feeds BOTH mirrors (URL hash + localStorage)
  // so they can never drift. An empty/absent state clears both.
  const json =
    state && state.workspaces.length > 0
      ? JSON.stringify(fractionizePersistedState(state))
      : null;

  // localStorage mirror — keeps the bare-`/` reopen working (inherits last
  // state when there is no hash).
  try {
    if (json === null) {
      localStorage.removeItem(LAYOUT_STORAGE_KEY);
      // State cleared (no workspaces left) — remove the legacy v2 blob TOO:
      // readBlob() falls back to the v2 key when the v3 key is absent, so a
      // surviving v2 blob would RESURRECT stale px geometry on the next load
      // right after the user cleared everything.
      localStorage.removeItem(LEGACY_V2_STORAGE_KEY);
    } else {
      localStorage.setItem(LAYOUT_STORAGE_KEY, json);
      // The legacy v2 px blob is superseded by this v3 write — remove it so a
      // later v3-key clear can never resurrect stale px geometry.
      localStorage.removeItem(LEGACY_V2_STORAGE_KEY);
    }
  } catch {
    // localStorage unavailable / quota exceeded / private mode — swallow.
  }

  // URL hash mirror — the per-tab source of truth. history.replaceState does
  // NOT fire hashchange → no re-render / fromJSON (survival-safe: the only
  // fromJSON is the cold restore on page load, which reads the hash via
  // readBlob at module init, never on a runtime save).
  writeHashState(json);
}

/** v3 save transform: stamp the schema marker and convert every workspace
 *  layout's grid trees from dockview px sizes to per-branch fractions
 *  (`fraction` = child share of its parent branch extent; px `size` stripped).
 *  Floating/popout groups keep their own width/height/position (overlay
 *  geometry, not container splits) but their INNER grid trees fractionize
 *  against the floating group's own extent. Never throws; a layout that
 *  fails the walk is passed through untouched (validation owns rejection). */
function fractionizePersistedState(state: PersistedState): PersistedState {
  return {
    v: 3,
    activeWorkspaceId: state.activeWorkspaceId,
    workspaces: state.workspaces.map((ws) => ({
      ...ws,
      layout: ws.layout
        ? (fractionizeSavedLayout(ws.layout as unknown as SavedLayout) as unknown as SerializedDockview)
        : null,
    })),
  };
}

/**
 * Write the full PersistedState JSON into the URL hash as `#state=<encoded>`,
 * or clear the hash when there is no state. Uses history.replaceState so NO
 * hashchange event fires — this is the survival guarantee: a runtime save
 * updates the URL + localStorage mirror without re-reading the state or
 * touching any iframe. Never throws.
 */
function writeHashState(json: string | null): void {
  if (typeof window === "undefined" || typeof window.history === "undefined") return;
  try {
    const path = window.location.pathname + window.location.search;
    const hash = json === null ? "" : `#state=${encodeURIComponent(json)}`;
    // replaceState with the SAME path + the new/cleared hash. No hashchange
    // fires → no fromJSON → survival-safe.
    window.history.replaceState(null, "", path + hash);
  } catch {
    // replaceState can throw on cross-origin or extremely long URLs — swallow
    // (the localStorage mirror is the fallback). Note: if URL-length becomes a
    // real problem for realistic layouts, report it (STOP condition (c)).
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

/** The container extent a cold restore materializes fractions against: the
 *  workspace element's content box, measured by DockviewHost at mount. */
export interface RestoreExtent {
  width: number;
  height: number;
}

/**
 * COLD-RESTORE ONLY (HARD RULE). Read the saved layout for ONE workspace from
 * the init blob, validate every pane url via the SAME isFleetEntry guard the
 * fleet resolver uses, repair (drop invalid panes from that workspace's tree),
 * MATERIALIZIZE the fractional split geometry against `extent` (px = fraction
 * × branch extent, recomputed for the CURRENT container — the v3 semantics),
 * and — if ≥1 valid pane survives — call api.fromJSON() EXACTLY ONCE for this
 * workspace, before any of its iframes has a live identity.
 *
 * `extent` is the workspace element's content box at cold-restore time (the
 * caller measures it). A degenerate extent (0×0) is tolerated: fractions
 * materialize to zeros and dockview's ResizeObserver redistributes
 * proportionally once the element gains its real size (the injected px define
 * the splitview's ctor-time proportions).
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
  extent?: RestoreExtent,
): boolean {
  if (restoredWorkspaceIds.has(workspaceId)) {
    return restoredWorkspaceResult.get(workspaceId) ?? false;
  }
  restoredWorkspaceIds.add(workspaceId);
  try {
    const repaired = loadRepairedWorkspaceLayout(workspaceId, extent);
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
 * Read + repair + MATERIALIZIZE ONE workspace's saved layout. Returns the
 * px-serialized SerializedDockview (only valid panes, sizes recomputed from
 * fractions × the CURRENT extent), or null when this workspace has no entry /
 * no layout / a layout with zero valid panes. Never throws.
 *
 * SOURCE ORDER: a STAGED runtime layout (the named-layout load path) is taken
 * first — one-shot, consumed on read — then the init blob. Both sources run
 * the same validation + repair + materialization pipeline. A staged layout is
 * additionally RE-IDDDED (fresh pane ids per instantiation) so its panels
 * never alias live panes in the source workspace or a sibling instantiation
 * (pane ids are global store keys — see the staged-slot block above). */
export function loadRepairedWorkspaceLayout(
  workspaceId: string,
  extent?: RestoreExtent,
): SerializedDockview | null {
  const staged = stagedRuntimeLayouts.get(workspaceId);
  if (staged !== undefined) stagedRuntimeLayouts.delete(workspaceId); // consume
  const saved =
    staged !== undefined
      ? staged
      : (initBlob?.workspaces.find((w) => w.id === workspaceId)?.layout ?? null);
  if (!saved || !isSavedLayout(saved)) return null;
  const validIds = validRestoreIds(saved.panels);
  if (validIds.size === 0) return null;
  let repaired = repairLayout(saved, validIds);
  if (!repaired) return null;
  if (staged !== undefined) {
    repaired = reIdLayoutPanels(repaired);
  }
  // v3 semantics: fractions → px against the CURRENT container extent.
  return materializeSavedLayout(repaired, extent) as unknown as SerializedDockview;
}

/**
 * Re-assign every PANEL id in a repaired saved layout to a fresh `pane-N`
 * (nextPaneId), rewriting the panels map keys, the INNER `id` field of each
 * serialized panel value (dockview's deserializer names the recreated panel
 * from `panelData.id` — the map key alone is NOT authoritative), and every
 * grid/floating/popout leaf's views + activeView. Group ids, geometry, and
 * params are untouched. Called ONLY on the staged (named-layout) path, at
 * consume time, so each instantiation mints its own ids — fromJSON reuses
 * saved panel ids verbatim, and pane ids are GLOBAL keys in the host store
 * (survivalMap, sourceMap, statusByPane, cwById…): reusing them would alias
 * two live iframes to one paneId (heartbeat identity thrash). Structurally a
 * pure tree walk over the SAME local SavedLayout shapes the repair walker
 * uses; never throws. */
function reIdLayoutPanels(layout: SavedLayout): SavedLayout {
  const idMap = new Map<string, string>();
  for (const id of Object.keys(layout.panels)) idMap.set(id, nextPaneId());
  const mapId = (v: string): string => idMap.get(v) ?? v;
  const panels: SavedLayout["panels"] = {};
  for (const [id, st] of Object.entries(layout.panels)) {
    // Rewrite BOTH the map key and the inner id (the deserializer's source).
    panels[mapId(id)] = { ...st, id: mapId(id) } as typeof st;
  }
  const mapNode = (node: GridNode): GridNode => {
    if (node.type === "leaf") {
      return {
        ...node,
        data: {
          ...node.data,
          views: node.data.views.map(mapId),
          activeView: node.data.activeView !== undefined
            ? mapId(node.data.activeView)
            : undefined,
        },
      };
    }
    return { ...node, data: node.data.map(mapNode) };
  };
  const mapGroup = (fg: FloatingGroup): FloatingGroup => {
    if (fg.data) {
      return {
        ...fg,
        data: {
          ...fg.data,
          views: fg.data.views.map(mapId),
          activeView: fg.data.activeView !== undefined
            ? mapId(fg.data.activeView)
            : undefined,
        },
      };
    }
    if (fg.grid) return { ...fg, grid: { ...fg.grid, root: mapNode(fg.grid.root) } };
    return fg;
  };
  const out: SavedLayout = {
    ...layout,
    grid: { ...layout.grid, root: mapNode(layout.grid.root) },
    panels,
  };
  if (layout.floatingGroups) {
    out.floatingGroups = layout.floatingGroups.map(mapGroup);
  }
  if (layout.popoutGroups) {
    out.popoutGroups = layout.popoutGroups.map(mapGroup);
  }
  return out;
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

/** Read + parse + structurally validate the persisted state. Called ONCE at
 *  module init. Never throws.
 *
 *  Fork 1 — HYBRID URL state: the URL hash is the source of truth for PER-TAB
 *  state (two same-origin tabs stay independent — each carries its own
 *  `#state=` hash). localStorage is the write-through mirror so a bare `/`
 *  reopen inherits the last-saved state. Read the hash FIRST; if absent or
 *  invalid, fall back to the v3 localStorage key, then to the LEGACY v2 key
 *  (px blob — migrated losslessly to fractions in-memory; never re-seeds).
 *  This per-tab independence is the whole point of the hash: localStorage is
 *  shared across tabs, so two tabs at `/` would otherwise clobber each
 *  other. */
function readBlob(): PersistedState | null {
  const fromHash = readHashState();
  if (fromHash !== null) return fromHash;
  const v3 = readLocalStorageState(LAYOUT_STORAGE_KEY);
  if (v3 !== null) return v3;
  return readLocalStorageState(LEGACY_V2_STORAGE_KEY);
}

/**
 * Read + decode + validate the `#state=<encoded>` URL hash. Returns null when
 * there is no hash, the hash is malformed, or the decoded JSON is structurally
 * invalid. Never throws — a corrupt hash falls through to the localStorage
 * fallback (the caller) rather than poisoning the restore.
 */
function readHashState(): PersistedState | null {
  if (typeof window === "undefined" || typeof window.location === "undefined") return null;
  const hash = window.location.hash;
  if (!hash || !hash.startsWith("#state=")) return null;
  const encoded = hash.slice("#state=".length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(encoded));
  } catch {
    return null; // corrupt hash → fall back to localStorage
  }
  return validatePersistedState(parsed);
}

/** The localStorage read path for ONE key (v3 primary, legacy v2 fallback).
 *  Returns null on a miss / corrupt JSON — the caller chains the fallback. */
function readLocalStorageState(key: string): PersistedState | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(key);
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

/** Structural guard for the persisted envelope (v2 px or v3 fractional).
 *  Per-workspace layout blobs are validated separately by isSavedLayout()
 *  inside loadRepairedWorkspaceLayout.
 *
 *  MIGRATION: a payload without `v: 3` is a legacy v2 px blob (localStorage
 *  key vh-host:layout:v2, or an old #state= hash) — each layout is
 *  fractionized IN-MEMORY (fraction = size / siblingSum, viewport-independent)
 *  and the state is stamped v3. The on-disk key/hash stays untouched until the
 *  next save writes v3; restoring is unaffected either way.
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
  // v3 fractional already; anything else (v2 px, marker-less) → migrate.
  if (o.v === 3) return { v: 3, activeWorkspaceId: o.activeWorkspaceId, workspaces };
  return {
    v: 3,
    activeWorkspaceId: o.activeWorkspaceId,
    workspaces: workspaces.map((ws) => ({
      ...ws,
      layout: ws.layout
        ? (fractionizeSavedLayout(ws.layout as unknown as SavedLayout) as unknown as SerializedDockview)
        : null,
    })),
  };
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
 *  pruned node, or null when the node has no valid pane left.
 *
 *  ORIENTATION-PRESERVING (load-bearing, Item 6 fix): dockview-core derives
 *  each branch's orientation from its TREE DEPTH (root.orientation alternates
 *  orthogonal per level — see gridview.js serializeBranchNode). A single-child
 *  branch is therefore NOT degenerate — it carries a depth level that encodes
 *  orientation. The prior `if (children.length === 1) return children[0]`
 *  collapse flattened the tree by one level, flipping the derived orientation
 *  of every descendant (the "vertical split → horizontal on reload" bug). The
 *  collapse is removed: a branch with one surviving child is kept as-is so the
 *  depth-derived orientation round-trips. dockview fromJSON accepts a branch
 *  with one child (a split with one survivor). */
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
  // DO NOT collapse a single-child branch — it carries a depth level that
  // encodes orientation (dockview derives orientation by depth). Collapsing
  // flips the derived orientation of the subtree (the Item-6 bug). Keep the
  // branch with its surviving children so the structure round-trips.
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

// =============================================================================
// FRACTIONAL GEOMETRY TRANSFORMS (v3 core).
//
// Dockview's serialized child `size` is the child's extent ALONG ITS PARENT
// BRANCH'S SPLIT AXIS (siblings sum to the branch's extent on that axis; the
// orth axis propagates unchanged down the tree). The v3 blob replaces that px
// with `fraction` = size / siblingSum — the child's share of its parent. The
// transforms:
//
//   SAVE       api.toJSON() px tree ──fractionizeSavedLayout──▶ fractional tree
//   v2 READ    px blob          ──fractionizeSavedLayout──▶ fractional tree
//   RESTORE    fractional tree  ──materializeSavedLayout(ext)──▶ px tree for
//              fromJSON, with px = fraction × the branch's extent recomputed
//              against the CURRENT container size (largest-remainder so
//              siblings sum EXACTLY to the extent).
//
// The recursion invariant: materialize(node, splitExtent, orthExtent) — a
// branch's children split `splitExtent`; each child i's ORTHOGONAL extent is
// its computed target (which becomes the split extent for a child branch).
// =============================================================================

/** Fractional tree walk: strip px `size` from every node, and on each branch
 *  compute per-child `fraction` from the children's px sizes (equal fallback
 *  when the sibling sum is 0/missing — see sizesToFractions). Already-
 *  fractional nodes (every child fraction, no child px) pass through
 *  unchanged, making the walk idempotent. `visible` and leaf `data` are
 *  untouched; branch structure (incl. single-child branches — the
 *  orientation-preserving invariant) is preserved verbatim. Never throws. */
function fractionizeSavedLayout(layout: SavedLayout): SavedLayout {
  const out: SavedLayout = {
    ...layout,
    grid: { ...layout.grid, root: fractionizeNode(layout.grid.root) },
  };
  if (layout.floatingGroups) {
    out.floatingGroups = layout.floatingGroups.map(fractionizeFloatingGroup);
  }
  if (layout.popoutGroups) {
    out.popoutGroups = layout.popoutGroups.map(fractionizeFloatingGroup);
  }
  return out;
}

function fractionizeFloatingGroup(fg: FloatingGroup): FloatingGroup {
  if (!fg.grid) return fg; // single-group floating overlay — no inner split
  return { ...fg, grid: { ...fg.grid, root: fractionizeNode(fg.grid.root) } };
}

function fractionizeNode(node: GridNode): GridNode {
  if (node.type === "leaf") {
    if (node.size === undefined) return node;
    const { size: _drop, ...rest } = node;
    void _drop;
    return rest as GridNode;
  }
  const children = node.data;
  const hasPx = children.some((c) => typeof c.size === "number");
  const allFrac = children.every((c) => typeof c.fraction === "number");
  const fractions = !hasPx && allFrac
    ? children.map((c) => c.fraction as number) // idempotent pass-through
    : sizesToFractions(
        children.map((c) => (typeof c.size === "number" ? c.size : 0)),
      );
  const out: GridBranch = { ...node, data: [] };
  delete out.size; // the branch's own px belongs to its PARENT's axis — stripped
  out.data = children.map((c, i) => {
    const fc = fractionizeNode(c);
    (fc as GridLeaf & { fraction?: number }).fraction = fractions[i];
    return fc;
  });
  return out;
}

/** Px tree walk for fromJSON: recompute every child's px `size` from its
 *  `fraction` × the branch's extent, where the ROOT extent comes from the
 *  CURRENT container (`extent` — measured by the caller at cold-restore time;
 *  falls back to the saved grid width/height, then 1024×768 so proportions
 *  always exist for dockview's ctor-time saveProportions). Degenerate/missing
 *  fractions restore to equal shares. Writes grid.width/height = the extent
 *  used (self-consistent blob). Never mutates the input; never throws. */
function materializeSavedLayout(
  layout: SavedLayout,
  extent?: RestoreExtent,
): SavedLayout {
  const width =
    extent && extent.width > 0
      ? extent.width
      : typeof layout.grid.width === "number" && layout.grid.width > 0
        ? layout.grid.width
        : 1024;
  const height =
    extent && extent.height > 0
      ? extent.height
      : typeof layout.grid.height === "number" && layout.grid.height > 0
        ? layout.grid.height
        : 768;
  const orientation =
    layout.grid.orientation === "VERTICAL" ? "VERTICAL" : "HORIZONTAL";
  const rootSplit = orientation === "HORIZONTAL" ? width : height;
  const rootOrth = orientation === "HORIZONTAL" ? height : width;
  const root = materializeNode(layout.grid.root, rootSplit, rootOrth);
  const out: SavedLayout = {
    ...layout,
    grid: { ...layout.grid, root, width, height, orientation },
  };
  if (layout.floatingGroups) {
    out.floatingGroups = layout.floatingGroups.map((fg) =>
      materializeFloatingGroup(fg, extent),
    );
  }
  if (layout.popoutGroups) {
    out.popoutGroups = layout.popoutGroups.map((fg) =>
      materializeFloatingGroup(fg, extent),
    );
  }
  return out;
}

function materializeFloatingGroup(
  fg: FloatingGroup,
  extent: RestoreExtent | undefined,
): FloatingGroup {
  if (!fg.grid) return fg; // single-group floating overlay — no inner split
  // A floating group's grid lays out inside the OVERLAY's width/height (px,
  // persisted as overlay geometry), NOT the container — prefer its own extent.
  const width =
    typeof fg.grid.width === "number" && fg.grid.width > 0
      ? fg.grid.width
      : extent && extent.width > 0
        ? extent.width
        : 1024;
  const height =
    typeof fg.grid.height === "number" && fg.grid.height > 0
      ? fg.grid.height
      : extent && extent.height > 0
        ? extent.height
        : 768;
  const orientation =
    fg.grid.orientation === "VERTICAL" ? "VERTICAL" : "HORIZONTAL";
  const rootSplit = orientation === "HORIZONTAL" ? width : height;
  const rootOrth = orientation === "HORIZONTAL" ? height : width;
  return {
    ...fg,
    grid: {
      ...fg.grid,
      root: materializeNode(fg.grid.root, rootSplit, rootOrth),
      width,
      height,
      orientation,
    },
  };
}

function materializeNode(
  node: GridNode,
  splitExtent: number,
  orthExtent: number,
): GridNode {
  if (node.type === "leaf") {
    // The parent writes this leaf's px size; just strip the stored fraction so
    // fromJSON sees dockview's exact serialized shape.
    if (node.fraction === undefined && node.size === undefined) return node;
    const { fraction: _drop, ...rest } = node;
    void _drop;
    return rest as GridNode;
  }
  const children = node.data;
  const fractions = children.map((c) =>
    typeof c.fraction === "number" ? c.fraction : NaN,
  );
  const safe = fractions.every((f) => Number.isFinite(f))
    ? fractions
    : children.map(() => 1 / children.length);
  const targets = fractionsToSizes(safe, Math.max(splitExtent, 0));
  const out: GridBranch = { ...node, data: [] };
  delete out.fraction; // strip any fraction the branch itself carries
  out.data = children.map((c, i) => {
    const mc = materializeNode(c, orthExtent, targets[i]);
    return { ...mc, size: targets[i] } as GridNode;
  });
  return out;
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
/** v3 grid node: a NON-ROOT node carries `fraction` (its share of the parent
 *  branch's extent) instead of dockview's px `size`. In-memory states may
 *  carry either (px before fractionize / after materialize; fraction in the
 *  stored blob), so both are optional here. */
interface GridLeaf {
  type: "leaf";
  data: GroupView;
  size?: number;
  fraction?: number;
  visible?: boolean;
}
interface GridBranch {
  type: "branch";
  data: GridNode[];
  size?: number;
  fraction?: number;
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
  // The serialized panel value carries its own `id` — dockview's deserializer
  // names the recreated panel from it (the map key is a parallel index; the
  // repair/reId walkers keep both in sync).
  panels: Record<string, { id?: string; params?: unknown }>;
  activeGroup?: string;
  floatingGroups?: FloatingGroup[];
  popoutGroups?: FloatingGroup[];
}
