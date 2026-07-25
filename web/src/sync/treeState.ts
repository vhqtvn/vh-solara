// Server-owned session tree — CLIENT reactive flat-map store.
// docs/design/server-owned-tree.md §7, §8.
//
// This is the Solid-reactive wrapper over the PURE `treeMap.ts` logic. It owns
// the single module-authority `Map<id,TreeNode>` and exposes:
//   - TRACKED accessors (`treeMap`, `treeNode`, `treeRoots`, `treeChildrenOf`)
//     that subscribe a Solid memo/effect to ANY tree mutation; and
//   - MUTATORS (`seedTreeStore`, `applyTreeOpStore`, `removeTreeNode`,
//     `collapseTreeNode`, `resetTreeStore`) that apply a server op (or a
//     client-only collapse/archive) via the pure `treeMap.ts` fns and then bump
//   a version signal so every tracked reader re-runs.
//
// The flat map is the SOLE tree-structure source in tree=2 mode. The client
// NEVER infers parent→child, classifies orphans, or reconciles ghosts (§7.3):
// every mutator is a verbatim application of a server op (or, for collapse, the
// §8.4 client-only descendant drop). treeMap.ts stays the pure, unit-tested
// core; this module is the thin reactive shell stream.ts/SessionTree/selectors
// consume.
import { createSignal } from "solid-js";
import {
  applyOp,
  childrenIndex,
  collapseNode,
  rootNodes,
  seedTree,
  type TreeNode,
  type TreeFlatMap,
  type TreeOp,
} from "./treeMap";
import { loadVersioned, saveVersioned } from "../lib/store";
// VALUE imports from treeSelectors are SAFE here: treeSelectors imports from
// treeState only as TYPE (`import type { TreeMode }`), so there is no runtime
// circular dependency. We pull the single working() predicate + the pure
// transition helper so ingestion can detect working edges.
import { working, autoTreeModeForWorkingTransition } from "./treeSelectors";

// Module-authority flat map. Mutated IN PLACE by the mutators; the `version`
// signal is what notifies Solid (the "mutable + version" pattern). Readers MUST
// go through the tracked accessors below — never touch `map` directly.
let map: TreeFlatMap = new Map();

// The version signal. Reading it inside a tracked scope subscribes to all tree
// mutations; mutators `bump()` it. A monotonic counter (capped to a safe int).
const [version, setVersion] = createSignal(0);
const bump = (): void => {
  setVersion((v) => (v + 1) & 0x3fffffff);
};

// ---- tree mode (persisted) — collapsed | filtered | expanded ----------------
// Restores the proj=1 4-state twisty MODEL (not the old glyphs): three PERSISTED
// modes plus a transient "temp" overlay computed at render time
// (treeSelectors.effectiveTreeMode). The implicit default is "filtered": a node
// never touched renders its WORKING children only, so a cold-load hides idle
// children behind the twisty. The modes:
//   collapsed — renders no children (even working ones).
//   filtered  — renders only working children (the default).
//   expanded  — renders ALL children, working-first (stable partition).
// "temp" is NEVER persisted: it is the effective overlay applied to a non-
// expanded strict ancestor of the selected session (revealing exactly ONE path
// child) so a selected idle nested node is reachable without a manual expand.
//
// PERSISTENCE: the mode map is persisted to localStorage (UI state, §11-
// sanctioned) so a reload keeps manual mode changes. The flat tree MAP is NEVER
// persisted (§11 keeps structure unpersisted — that is what keeps "reload does
// not flatten" true: seedTreeStore REPLACES the whole map on every tree.snapshot,
// so structure is always re-fetched from the server). Only this mode map is
// persisted, rehydrated on load, and backfilled after the frontier seed.
//
// The half-state trap (why persistence needs BACKFILL): on a cold reload the §5
// frontier ships an idle persisted-EXPANDED node COLLAPSED — its children are
// NOT resident (the server's per-connection expanded-set resets). A persisted
// mode "expanded" whose children aren't resident would be a confusing half-state
// (expanded but nothing renders). The fix is PERSISTENCE + BACKFILL: stream.ts
// reads `expandedButUnloadedIds()` right after the frontier seed and fires
// expandTreeNode for each, so a persisted-expanded node's children are fetched
// and land via subsequent node.children ops.
//
// Persistence key: `vh.tree.mode.v2` (the deleted proj=1 client's precedent key,
// unused in tree=2 until now — NO collision with the legacy `vh.tree.expanded.v1`
// Set<string>, which is retained read-only for one-time migration + rollback).
export type TreeMode = "collapsed" | "filtered" | "expanded";
export type TreeModeMap = Record<string, TreeMode>;

const LS_MODE = "vh.tree.mode.v2";
const LS_EXPANDED_LEGACY = "vh.tree.expanded.v1"; // pre-mode Set<string> (retained for rollback)

function isValidMode(v: unknown): v is TreeMode {
  return v === "collapsed" || v === "filtered" || v === "expanded";
}

// Coerce an unknown persisted payload into a clean mode map: keep ONLY
// {nonEmptyStringId: validMode} entries. Malformed keys/values are dropped.
function coerceModeMap(o: unknown): TreeModeMap {
  if (!o || typeof o !== "object") return {};
  const src = o as Record<string, unknown>;
  const out: TreeModeMap = {};
  for (const [k, v] of Object.entries(src)) {
    if (typeof k === "string" && k.length > 0 && isValidMode(v)) out[k] = v;
  }
  return out;
}

// Migrate the legacy vh.tree.expanded.v1 (a Set<string> serialized as string[])
// into a mode map: every VALID legacy expanded id → "expanded". Absent ids
// resolve via modeOf() to the implicit "filtered" default, so they are NOT
// manufactured here. Malformed (non-string/empty) entries are skipped.
function migrateFromExpandedSet(arr: unknown): TreeModeMap {
  const out: TreeModeMap = {};
  if (!Array.isArray(arr)) return out;
  for (const id of arr) {
    if (typeof id === "string" && id.length > 0) out[id] = "expanded";
  }
  return out;
}

// Module-init load (runs once at first import):
//   1. If LS_MODE holds ANY value (even an empty map) → coerce + use it; do NOT
//      re-migrate (an empty v2 is a valid "everything filtered" state).
//   2. Else (LS_MODE absent) read the LEGACY LS_EXPANDED_LEGACY Set → migrate to
//      "expanded" modes, persist the result under LS_MODE.
//   3. The legacy key is RETAINED (never deleted) for rollback safety.
// `treeModeMap` reads `localStorage.getItem` directly first to distinguish
// "key absent" (→ migrate) from "key present but empty" (→ use as-is), which a
// bare `loadVersioned` fallback cannot tell apart.
function loadInitialTreeModes(): TreeModeMap {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LS_MODE);
  } catch {
    raw = null;
  }
  if (raw != null) {
    const loaded = loadVersioned<unknown>(LS_MODE, 1, {}, (o) => o);
    return coerceModeMap(loaded);
  }
  const legacy = loadVersioned<string[]>(LS_EXPANDED_LEGACY, 1, [], (o) =>
    Array.isArray(o) ? o : [],
  );
  const migrated = migrateFromExpandedSet(legacy);
  saveVersioned(LS_MODE, 1, migrated);
  return migrated;
}

const [treeModeMap, setTreeModeMap] = createSignal<TreeModeMap>(loadInitialTreeModes());

// Read-only signal accessor (tests + internal backfill). The controlled setters
// below are the only writers.
export function treeModeMapSignal(): TreeModeMap {
  return treeModeMap();
}

// Implicit default "filtered": a node with no persisted entry renders its
// working children only. Reading `treeModeMap()` subscribes a caller's reactive
// scope to mode changes.
export function modeOf(id: string): TreeMode {
  return treeModeMap()[id] ?? "filtered";
}

// Single-node mode set: ONE immutable signal update + ONE localStorage write.
export function setNodeMode(id: string, mode: TreeMode): void {
  const next = { ...treeModeMap(), [id]: mode };
  setTreeModeMap(next);
  saveVersioned(LS_MODE, 1, next);
}

// BATCHED multi-node mode set: accumulates into ONE new map, ONE signal update,
// ONE localStorage write. Used by batched callers that need to set many ids to
// the SAME mode in one immutable replacement. Do NOT call setNodeMode in a loop
// here — that would cause N writes + N signal emissions. The invariant: one
// immutable update + one write per call.
export function setNodesMode(ids: Iterable<string>, mode: TreeMode): void {
  const next = { ...treeModeMap() };
  for (const id of ids) next[id] = mode;
  setTreeModeMap(next);
  saveVersioned(LS_MODE, 1, next);
}

// MIXED-MODE multi-node set: like setNodesMode but each id carries its OWN target
// mode. This is the primitive for the auto-mutation flush + the cold-load
// normalization merge, where one batch may set some ids to "collapsed" and others
// to "filtered" in a SINGLE immutable replacement. Starts from the current record,
// applies every non-stale actual change (skips an id already holding the requested
// explicit value), and — if at least one id actually changed — performs ONE
// setTreeModeMap + ONE saveVersioned. If nothing changed, it neither writes the
// signal NOR localStorage (no-op batch produces no persistence write).
//
// Do NOT loop over setNodeMode here — that would be N writes + N signal emissions.
// This is the ONE-write primitive the auto-mutation flush routes through.
export function setNodeModes(changes: ReadonlyMap<string, TreeMode>): void {
  if (changes.size === 0) return;
  const cur = treeModeMap();
  let next: TreeModeMap | null = null;
  for (const [id, mode] of changes) {
    if (cur[id] === mode) continue; // already holds the explicit value — stale
    if (!next) next = { ...cur };
    next[id] = mode;
  }
  if (!next) return; // every entry was already current — no write, no notify
  setTreeModeMap(next);
  saveVersioned(LS_MODE, 1, next);
}

// ---- transient userToggled (NOT persisted) ----------------------------------
// The set of node ids the user CLICKED (the twisty) since the last real
// selection change. It suppresses the "temp" overlay on a clicked ancestor so a
// manual twisty click on a selected-session ancestor promotes it from temp to
// its persisted mode (proj=1 temp→filtered transition) instead of re-clamping
// to temp. Cleared synchronously in the canonical selection setter when the id
// actually changes (actions.setSelectedId), in the project/tree reset, and in
// the test reset helper — NEVER in a delayed effect (that would race a twisty
// click that leaves selection unchanged).
const [userToggled, setUserToggled] = createSignal<ReadonlySet<string>>(new Set<string>());

export function userToggledSignal(): ReadonlySet<string> {
  return userToggled();
}
export function hasUserToggled(id: string): boolean {
  return userToggled().has(id);
}
// Mark ONLY the clicked node (NOT its descendants — there is no subtree cascade
// anymore; each node's mode is toggled independently). A later selection change
// still clears the overlay uniformly.
export function markUserToggled(id: string): void {
  const next = new Set<string>(userToggled());
  next.add(id);
  setUserToggled(next);
}
export function clearUserToggled(): void {
  setUserToggled(new Set<string>());
}

// Pure helper (backfill source): the ids explicitly persisted as "expanded" that
// are RESIDENT but have NO resident direct children AND still have descendants to
// fetch — i.e. persisted-expanded nodes the cold-load frontier left collapsed.
// stream.ts fires expandTreeNode for each after the frontier seed so their
// children land via subsequent node.children ops (resolving the half-state
// trap). Reads `version()` so a caller in a reactive scope subscribes to tree
// mutations (harmless when called imperatively post-seed).
//
// Enumerates ONLY explicitly-persisted-expanded ids (mode === "expanded") with
// known descendants that are unloaded — NOT default-filtered ids (mounted
// filtered/temp branches are handled by the render-time lazy-frontier effect in
// SessionTree, not this backfill).
//
//   - skip ids not in the map (non-resident — stale persisted id, never seeded);
//   - skip ids whose direct children are already resident (nothing to fetch);
//   - skip ids with nothing to fetch (childCount 0 AND descendantCount 0).
export function expandedButUnloadedIds(): string[] {
  void version();
  const idx = childrenIndex(map);
  const out: string[] = [];
  for (const [id, mode] of Object.entries(treeModeMap())) {
    if (mode !== "expanded") continue;
    const n = map.get(id);
    if (!n) continue; // non-resident
    if ((idx.get(id)?.length ?? 0) > 0) continue; // resident children present
    if (n.childCount === 0 && (n.descendantCount ?? 0) === 0) continue; // nothing to fetch
    out.push(id);
  }
  return out;
}

// ---- auto-mutation candidate queue (guarded microtask aggregator) ------------
// Tree-op application enqueues GENUINE working() edges here instead of mutating
// modes inline. The flush is deferred to a single microtask so that:
//   - a batch of ops in one stream tick coalesces into ONE setNodeModes call
//     (ONE signal update + ONE localStorage write, regardless of candidate count);
//   - rapid reversals (false→true→false in one tick) dedupe to the LATEST
//     validated candidate per id (Map keyed by id, last write wins); and
//   - a manual click / opposite edge / reset / removal that lands BETWEEN queue
//     and flush can INVALIDATE a stale candidate at revalidation time.
//
// GENERATION: a monotonic counter bumped by every seed/reset (snapshot
// replacement or project switch). A candidate records the generation it was
// enqueued under; flush drops any candidate whose generation no longer matches
// the current store generation, so an op queued against a stale snapshot can
// never mutate the replacement snapshot.
interface AutoModeCandidate {
  id: string;
  expectedSourceMode: TreeMode; // the persisted mode the decision was based on
  expectedWorking: boolean; // the destination working() state it must still hold
  targetMode: TreeMode; // the auto-mutation target ("filtered" | "collapsed")
  generation: number; // store generation at enqueue time
}
let queueGeneration = 0;
let pendingCandidates = new Map<string, AutoModeCandidate>();
let flushScheduled = false;

// Bump generation + clear the candidate map. Leaves `flushScheduled` as-is: an
// already-scheduled microtask becomes a harmless no-op (it sees an empty map at
// the bumped generation and writes nothing), while new post-invalidation
// candidates reuse the scheduled flush. Called by seedTreeStore (snapshot
// replacement) and the reset hooks (project switch / test reset) so a stale
// queued op can never mutate a fresh snapshot / a different project's tree.
function invalidateAutoQueue(): void {
  queueGeneration = (queueGeneration + 1) & 0x3fffffff;
  pendingCandidates = new Map();
}

// Enqueue (or replace) a candidate keyed by id. The Map keeps the LATEST entry
// per id, so a rapid false→true→false in one tick reduces to the final validated
// state (never applies a stale first edge). Schedules a single microtask flush
// if one is not already pending. Revalidation happens at flush time, so enqueuing
// is unconditional — a candidate that will be stale by flush is dropped there.
function enqueueAutoModeCandidate(
  id: string,
  expectedSourceMode: TreeMode,
  expectedWorking: boolean,
  targetMode: TreeMode,
): void {
  pendingCandidates.set(id, {
    id,
    expectedSourceMode,
    expectedWorking,
    targetMode,
    generation: queueGeneration,
  });
  if (!flushScheduled) {
    flushScheduled = true;
    queueMicrotask(flushAutoModeQueue);
  }
}

// Flush: revalidate every candidate against current ground truth, then route
// survivors through ONE setNodeModes. A candidate is dropped if ANY of:
//   - its generation no longer matches (a seed/reset replaced the snapshot);
//   - the node is no longer resident (a remove/archive landed between queue+flush);
//   - working(node) no longer equals expectedWorking (the edge reversed again, or
//     a subsequent op changed the rollup);
//   - the persisted mode no longer equals expectedSourceMode (a manual click or
//     an opposite-edge flush already changed it).
function flushAutoModeQueue(): void {
  flushScheduled = false;
  const gen = queueGeneration;
  const survivors = new Map<string, TreeMode>();
  for (const c of pendingCandidates.values()) {
    if (c.generation !== gen) continue; // stale snapshot
    const node = map.get(c.id);
    if (!node) continue; // removed between queue+flush
    if (working(node) !== c.expectedWorking) continue; // edge reversed / changed
    // Read source mode via modeOf (absent → "filtered" fallback), NOT raw
    // treeModeMap()[c.id], so the read MATCHES candidate formation in
    // applyTreeOpStore (which stored expectedSourceMode from modeOf(id)). A raw
    // read returns undefined for an absent-mode (implicit filtered) id, which
    // would fail the !== expectedSourceMode check ("filtered") and DROP a
    // genuine working→idle demote — leaking the "no non-running filtered"
    // invariant on the op path. Symmetric with seedTreeStore's modeOf read.
    if (modeOf(c.id) !== c.expectedSourceMode) continue; // manual click / opp edge
    survivors.set(c.id, c.targetMode);
  }
  pendingCandidates = new Map();
  if (survivors.size > 0) setNodeModes(survivors);
}

// Test reset: clear the in-memory mode map + userToggled (mirrors the fresh-load
// default). Persists NOTHING — localStorage is left untouched so this doubles as
// the "simulate page reload" primitive (a reload loses the Solid signals but
// keeps persisted UI state; rehydrateExpandedForTest then re-seeds from disk).
// resetTreeStore (true project switch) clears BOTH.
export function resetExpandedForTest(): void {
  setTreeModeMap({});
  setUserToggled(new Set<string>());
  invalidateAutoQueue();
}

// Test helper: re-run the module-init load against the current localStorage.
// Lets a unit test exercise the rehydrate/migrate path without a real module
// reload (the module initializes once per test file).
export function rehydrateExpandedForTest(): void {
  setTreeModeMap(loadInitialTreeModes());
}

// ---- tracked accessors ------------------------------------------------------
// Each reads `version()` first to subscribe, then reads the live map. Because
// the map is mutated in place, only the version bump causes a re-run — but that
// is exactly what we want (coalesced per mutation, not per node).

// The authoritative flat map. Subscribe via a memo/effect; do NOT mutate the
// returned map directly (use the mutators). Returns the same Map reference
// across mutations; callers that need a stable snapshot should copy.
export function treeMap(): TreeFlatMap {
  void version();
  return map;
}

export function treeNode(id: string): TreeNode | undefined {
  void version();
  return map.get(id);
}

export function treeRoots(): TreeNode[] {
  void version();
  // Newest-first (P0-WEB-001): the deleted proj=1 client sorted every group by
  // time.updated DESC in reduce.ts buildChildrenIndex; that sort was lost when
  // reduce.ts was removed. Re-implement it here on the reactive accessor so the
  // sidebar renders newest-first. The pure `rootNodes`/`childrenIndex` in
  // treeMap.ts keep their order-preserving (insertion/emit) contract so any
  // future caller can still get emit order; the recency sort lives here in these
  // shell accessors only. rootNodes() returns a fresh array each call, so this
  // sorts in place without mutating the map. updatedMs is on every TreeNode
  // (treeMap.ts:40). Stable sort: ties keep emit/insertion order.
  return rootNodes(map).sort((a, b) => b.updatedMs - a.updatedMs);
}

// Direct children of `parentId` (grouped by parentId, §7.3 render grouping).
export function treeChildrenOf(parentId: string): TreeNode[] {
  void version();
  // Newest-first — see treeRoots() above (P0-WEB-001). childrenIndex() builds a
  // fresh array per call, so sorting it in place is safe. Pinned children are
  // filtered out by the caller (SessionTree.tsx) before render, so this does
  // NOT touch pin order (pins come from selectPinnedNodes, not this accessor).
  return (childrenIndex(map).get(parentId) ?? []).sort((a, b) => b.updatedMs - a.updatedMs);
}

// ---- mutators ---------------------------------------------------------------
// Each delegates to a pure `treeMap.ts` fn (the tested core) and then bumps the
// version so tracked readers re-run. No inference, no reconciliation.

// §7.1 seed from the initial snapshot: replace the whole map.
//
// COLD-LOAD NORMALIZATION + TRANSITION-DRIVEN AUTO-MUTATION + ABSOLUTE INVARIANT
// (merged into ONE synchronous mixed-mode update BEFORE the tree version is
// exposed — no first-paint flash). For each resident node in the INCOMING
// snapshot:
//   - if the id was RESIDENT in the PREVIOUS map (a known node), compute the old
//     →new working() transition against its CURRENT persisted mode and collect
//     the qualifying edge decision (false→true+collapsed→filtered, or
//     true→false+filtered→collapsed); any other combination is a no-op.
//   - if the id is NEW (not in the previous map → a baseline, no edge fires):
//     a working node is left ABSENT so modeOf() returns the implicit "filtered"
//     fallback (so its working children reveal immediately).
//   - ABSOLUTE INVARIANT (every resident node, regardless of edge): an idle node
//     is NEVER in "filtered". Any resident node where !working(node) &&
//     modeOf(id)==="filtered" (covering BOTH absent-fallback-filtered-idle AND
//     explicit-persisted-filtered-idle) is materialized/repaired as explicit
//     "collapsed". This subsumes the former absent-idle→collapsed cold rule AND
//     repairs stale/reintroduced explicit filtered+idle entries. Working nodes
//     in "filtered" (absent or explicit) are left as-is (working+filtered valid).
// Explicit persisted entries are otherwise preserved (collapsed stays collapsed,
// expanded stays expanded), subject only to a genuine transition edge. IDs
// persisted but not resident in the snapshot are ignored. The complete change
// set is applied via ONE setNodeModes (ONE signal update + ONE localStorage
// write) BEFORE bump().
//
// Same-project resync compares against the retained pre-snapshot resident map
// (oldMap). The queue is invalidated (generation bumped + candidates cleared) so
// a pending pre-seed op candidate cannot mutate the replacement snapshot.
export function seedTreeStore(nodes: TreeNode[]): void {
  const oldMap = map;
  const newMap = seedTree(nodes);
  const changes = new Map<string, TreeMode>();
  for (const [id, newNode] of newMap) {
    // Compute any genuine working() transition edge target first (may be
    // undefined for baselines / no-edge / expanded cases).
    let target: TreeMode | undefined;
    if (oldMap.has(id)) {
      const prevWorking = working(oldMap.get(id)!);
      const curWorking = working(newNode);
      const persisted = modeOf(id);
      target = autoTreeModeForWorkingTransition(prevWorking, curWorking, persisted);
    }
    // The effective mode this node will hold AFTER applying the edge target (or
    // its current persisted mode / absent-fallback if no edge fires).
    const effective = target ?? modeOf(id);
    if (!working(newNode) && effective === "filtered") {
      // ABSOLUTE invariant: idle + filtered → collapsed. Covers absent-idle
      // (materialize collapsed) AND explicit-filtered-idle (repair to collapsed).
      changes.set(id, "collapsed");
    } else if (target) {
      // Genuine edge (false→true+collapsed→filtered): apply the promotion.
      changes.set(id, target);
    }
    // else: no edge, not idle+filtered → leave as-is (expanded, collapsed, or
    // absent+working implicit-filtered).
  }
  map = newMap;
  setNodeModes(changes); // no-op (no write, no notify) if changes is empty
  invalidateAutoQueue();
  bump();
}

// §7.2 apply a single server op verbatim (upsert/remove/move/children/facet).
//
// TRANSITION-DRIVEN AUTO-MUTATION + ABSOLUTE INVARIANT (synchronous). After
// applying the op, for each id it INTRODUCED/CHANGED (the op payload boundary —
// NOT a whole-map scan):
//   - compare before/after working() for ids present on BOTH sides; a genuine
//     PROMOTION edge (false→true+collapsed→filtered) is enqueued through the
//     guarded microtask aggregator (deferred promotion — coalesces, dedupes,
//     revalidates, flushes in ONE setNodeModes per tick). The node is now
//     working, so the synchronous idle-normalization below will NOT touch it
//     (no conflict between the queued promotion and the sync collapse).
//   - a DEMOTION edge (true→false+filtered→collapsed) is NOT enqueued: the
//     synchronous normalization collapses the now-idle node immediately,
//     avoiding an invalid filtered+idle interval between op application and
//     microtask flush.
//   - ABSOLUTE INVARIANT (synchronous, every affected resident node): an idle
//     node where modeOf(id)==="filtered" (absent-fallback OR explicit persisted)
//     is collapsed BEFORE callers observe post-op state. This subsumes the
//     former absent-idle→collapsed cold rule, repairs stale/reintroduced
//     explicit filtered+idle entries, and applies the demotion edge synchronously.
//
// affectedIdsOfOp extracts the op payload boundary: upsert→[node.id];
// remove→[] (removed ids drop, no transition possible — descendants removed by
// node.remove's loadedDescendants drop are also gone); move→[id];
// children→[parentId, ...child ids]; facet→[id]. A multi-node children op thus
// inspects the parent (loaded flip) AND each merged child.
export function applyTreeOpStore(op: TreeOp): void {
  const affectedIds = affectedIdsOfOp(op);
  const before = new Map<string, TreeNode | undefined>();
  for (const id of affectedIds) before.set(id, map.get(id));
  applyOp(map, op);
  const syncChanges = new Map<string, TreeMode>();
  for (const id of affectedIds) {
    const after = map.get(id);
    if (!after) continue; // removed by the op (e.g. node.remove) — no transition
    const prev = before.get(id);
    if (prev) {
      const prevWorking = working(prev);
      const curWorking = working(after);
      if (prevWorking !== curWorking) {
        const persisted = modeOf(id);
        const target = autoTreeModeForWorkingTransition(prevWorking, curWorking, persisted);
        // Only PROMOTION edges are queued (deferred, revalidated at flush). A
        // DEMOTION edge (target==="collapsed") is NOT enqueued — the sync
        // normalization below collapses the now-idle node before callers observe
        // an invalid filtered+idle interval.
        if (target === "filtered") {
          enqueueAutoModeCandidate(id, persisted, curWorking, target);
        }
      }
    }
    // ABSOLUTE invariant: an idle resident node is NEVER in "filtered".
    // Synchronously collapse before callers observe post-op state. Covers
    // absent+idle (→ explicit collapsed), explicit-filtered+idle (→ repaired),
    // and the demotion edge (true→false + filtered → collapsed, applied here
    // rather than via a queued candidate). A promotion candidate enqueued above
    // is for a WORKING node, so this check does not conflict with it.
    if (!working(after) && modeOf(id) === "filtered") {
      syncChanges.set(id, "collapsed");
    }
  }
  if (syncChanges.size > 0) setNodeModes(syncChanges); // ONE signal + ONE LS write
  bump();
}

// The ids an op INTRODUCES/CHANGES — the minimal set applyTreeOpStore must
// inspect for a working() transition or cold-normalization. Derived purely from
// the op payload shape (no map walk).
function affectedIdsOfOp(op: TreeOp): string[] {
  switch (op.op) {
    case "node.upsert":
      return [op.data.node.id];
    case "node.remove":
      return []; // removed ids (and their loaded descendants) drop — no transition
    case "node.move":
      return [op.data.id];
    case "node.children":
      return [op.data.parentId, ...op.data.nodes.map((n) => n.id)];
    case "node.facet":
      return [op.data.id];
  }
}

// Eager client-side archive drop: remove a node + its loaded descendants BEFORE
// the server's node.remove arrives, so the row disappears immediately instead
// of ghosting for a frame. Same semantics as node.remove (§7.2): drops the node
// and every loaded descendant rooted at it.
export function removeTreeNode(id: string): void {
  applyOp(map, { op: "node.remove", data: { id } });
  bump();
}

// §8.4 client-only collapse: drop the loaded descendants from view, keep the
// placeholder node (which still carries its own display data, §3), flip
// loaded:false. Does NOT round-trip to the server.
//
// NOTE: this is the FETCH-collapse primitive (§8.4), a DIFFERENT mechanism from
// the user mode toggle (modeOf/setNodeMode above). The UI onToggle flips the
// persisted MODE; the render gate decides whether children render. This fn stays
// as the library primitive (e.g. server-driven collapse, tests).
//
// `protectedIds` (optional): pinned-node membership — pinned descendants are
// kept resident so the Pinned group keeps rendering them after an ancestor
// collapse (pin-parity fix). Passed through to the pure collapseNode.
export function collapseTreeNode(id: string, protectedIds?: ReadonlySet<string>): void {
  collapseNode(map, id, protectedIds);
  bump();
}

// Cold-seed gap fill: the server's async seedColdLastAgents goroutine
// (aggregator.go) usually completes AFTER the client's first tree snapshot
// landed, so SnapshotFrontier shipped nodes with agent:"" for sessions whose
// message tail hadn't been fetched yet. The server emits a lastAgent.set event
// to fill this gap, but that event only updates the legacy lastAgents map — NOT
// the tree node. This mutator patches the tree node's agent so the chip renders
// on collapsed nodes without an expand/open round-trip. It only fills an EMPTY
// agent (never overwrites an authoritative one set by a tree op); the next
// node.upsert/expand fetch replaces it with the server's authoritative value.
export function patchTreeAgent(id: string, agent: string): void {
  const n = map.get(id);
  if (!n || n.agent) return; // unknown node, or already has authoritative agent
  map.set(id, { ...n, agent });
  bump();
}

// Clear the whole tree (project switch / epoch change / test reset). Also
// clears the in-memory mode map + userToggled AND the persisted mode key so a
// project switch does NOT carry stale mode toggles forward and tests do not
// bleed across cases (reviewer advisory tier1_a-F1/tier1_c-F2): the mode map is
// persisted, so a plain reset of in-memory is NOT enough on a true project
// switch — the persisted key is cleared too so the next reload of the new
// project does not rehydrate the old project's modes. The legacy v1 key is left
// untouched (dead after first v2 write; retained for rollback).
export function resetTreeStore(): void {
  map = new Map();
  setTreeModeMap({});
  saveVersioned(LS_MODE, 1, {});
  setUserToggled(new Set<string>());
  invalidateAutoQueue(); // drop any candidates from the prior project/session-tree
  bump();
}
