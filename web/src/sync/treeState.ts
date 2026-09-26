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
  loadedDescendants,
  rootNodes,
  seedTree,
  type TreeNode,
  type TreeFlatMap,
  type TreeOp,
} from "./treeMap";
import { loadVersioned, saveVersioned } from "../lib/store";
// VALUE imports from treeSelectors are SAFE here: treeSelectors imports from
// treeState only as TYPE (`import type { TreeMode }`), so there is no runtime
// circular dependency. We pull the single working() predicate, the
// activityEstablished payload-truth gate (demote decisions must not fire
// against a never-seeded "" observation), and the pure transition helper so
// ingestion can detect working edges.
import { working, autoTreeModeForWorkingTransition, activityEstablished } from "./treeSelectors";

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
// Persistence keys: `vh.tree.mode.v3` is the ACTIVE mode map. The
// `vh.tree.mode.v2` key (the deleted proj=1 client's precedent, reused by
// tree=2) is retained READ-ONLY as the one-time un-corruption-sweep source +
// rollback copy, exactly as the legacy `vh.tree.expanded.v1` Set<string> is
// retained read-only for its own migration + rollback — same precedent, one
// more hop.
export type TreeMode = "collapsed" | "filtered" | "expanded";
export type TreeModeMap = Record<string, TreeMode>;

const LS_MODE = "vh.tree.mode.v2"; // PRE-SWEEP map — read-only migration source (retained for rollback)
const LS_MODE_V3 = "vh.tree.mode.v3"; // ACTIVE mode map (post un-corruption sweep)
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

// ONE-TIME un-corruption sweep (v2 → v3 stock heal). For ~2 months before the
// 499e327/8754294 establishment gate, cold-load ingestion read the never-seeded
// activity "" as a settle and demoted persisted "filtered" entries to
// "collapsed" (and materialized "collapsed") for genuinely-running branches —
// spurious entries that never self-heal (a busy baseline seed fires no working
// edge, so nothing ever re-promotes them; collapsed+working renders nothing).
// The gate stopped NEW corruption generation; this sweep heals the accumulated
// stock, once, at module init.
//
// Why DROP entries instead of repairing them per-entry: the flat {id: mode}
// schema carries NO write provenance — a corrupted "collapsed" is byte-identical
// to a deliberate user collapse — so per-entry discrimination is impossible.
// Deletion is the only safe one-time surgery: an absent id resolves via the
// implicit "filtered" render (a working branch re-reveals its working children)
// or the UNGATED R4 absent-idle cold materialization (an idle branch re-collapses
// at seed). The sweep can only DELETE entries; it never demotes anything.
//
// Entry classes: KEEP "expanded" (a persisted-expanded node rehydrates through
// the existing backfill path — dropping it would re-trigger the P1-A backfill
// fetch storm). DROP "collapsed" (the corrupted class) and "filtered" (the
// stale accumulation, c-F1 — render-free either way: working → implicit
// filtered, the same render; idle → R4 collapsed at seed).
//
// Accepted one-time false positive: a user who DELIBERATELY collapsed a RUNNING
// branch sees it re-open ONCE after this migration; re-collapsing persists (the
// establishment gate never demotes, and collapsed+working is a stable persisted
// state — the user's re-collapse sticks).
//
// ROLLBACK: the v2 key is left byte-untouched in storage — a build that re-reads
// v2 restores the old map verbatim (the LS_EXPANDED_LEGACY precedent) — and the
// forward migration is idempotent on re-run (v3 present → direct read, no v2
// access at all).
function keepExpandedOnly(src: TreeModeMap): TreeModeMap {
  const out: TreeModeMap = {};
  for (const [id, mode] of Object.entries(src)) {
    if (mode === "expanded") out[id] = mode;
  }
  return out;
}

// Module-init load (runs once at first import):
//   1. If LS_MODE_V3 holds ANY value (even an empty map) → coerce + use it;
//      do NOT read or write v2 (the idempotent forward path — a second load
//      is a direct v3 hit).
//   2. Else if LS_MODE (v2) holds ANY value (even an empty map) → coerce, run
//      the ONE-TIME un-corruption sweep (keepExpandedOnly — see its docblock),
//      persist the result under LS_MODE_V3, and leave the v2 key byte-untouched
//      in storage (rollback copy).
//   3. Else (both absent) read the LEGACY LS_EXPANDED_LEGACY Set → migrate to
//      "expanded" modes → compose through the same sweep (identity on a v1 set
//      — every entry is "expanded") → persist under LS_MODE_V3. v2 is never
//      manufactured on this path; a rollback build falls back to its own v1
//      migration, which reconstructs the same expanded set.
//   The legacy keys (v1 AND v2) are RETAINED (never deleted) for rollback
//   safety.
// Direct `localStorage.getItem` reads distinguish "key absent" (→ migrate)
// from "key present but empty" (→ use as-is), which a bare `loadVersioned`
// fallback cannot tell apart.
function loadInitialTreeModes(): TreeModeMap {
  let raw3: string | null = null;
  try {
    raw3 = localStorage.getItem(LS_MODE_V3);
  } catch {
    raw3 = null;
  }
  if (raw3 != null) {
    const loaded = loadVersioned<unknown>(LS_MODE_V3, 1, {}, (o) => o);
    return coerceModeMap(loaded);
  }
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(LS_MODE);
  } catch {
    raw = null;
  }
  if (raw != null) {
    const loaded = loadVersioned<unknown>(LS_MODE, 1, {}, (o) => o);
    const swept = keepExpandedOnly(coerceModeMap(loaded));
    saveVersioned(LS_MODE_V3, 1, swept);
    return swept;
  }
  const legacy = loadVersioned<string[]>(LS_EXPANDED_LEGACY, 1, [], (o) =>
    Array.isArray(o) ? o : [],
  );
  const migrated = keepExpandedOnly(migrateFromExpandedSet(legacy));
  saveVersioned(LS_MODE_V3, 1, migrated);
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
  saveVersioned(LS_MODE_V3, 1, next);
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
  saveVersioned(LS_MODE_V3, 1, next);
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
  saveVersioned(LS_MODE_V3, 1, next);
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
  clearRankState(); // mirror invalidateAutoQueue: drop stale ranks on test reset
}

// Test helper: re-run the module-init load against the current localStorage.
// Lets a unit test exercise the rehydrate/migrate path without a real module
// reload (the module initializes once per test file).
export function rehydrateExpandedForTest(): void {
  setTreeModeMap(loadInitialTreeModes());
}

// ---- presentation rank (stable activity-edge promotion ordering) ------------
// Shell-owned ordering key that REPLACES the former continuous updatedMs-DESC
// re-sort in treeRoots()/treeChildrenOf(). Within a sibling group, nodes are
// ordered by rank DESC (higher rank => closer to the front). Rank changes ONLY
// on a small set of meaningful edges:
//   - seed (seedTreeStore): rebuilt from the snapshot's updatedMs-DESC order —
//     the recency baseline. A node already working at seed is ordered by
//     updatedMs like every other node; NO synthetic activity edge is
//     manufactured (a later op-driven false->true edge still promotes it once).
//   - new insertion (node.upsert / node.children of a not-yet-resident id): the
//     node enters at the FRONT of its sibling group.
//   - a non-working -> working edge (applyTreeOpStore): promoted to the front
//     EXACTLY ONCE (the branch fires only on the edge itself).
//   - node.move (reparent): (re)placed at the front of its NEW sibling group.
// updatedMs-only upserts and the working -> idle settle do NOT change rank, so
// an actively-streaming session no longer jumps position on every updatedMs
// tick while still keeping "recent on top" for meaningful activity edges.
//
// LIFECYCLE: mirrors invalidateAutoQueue() exactly — rebuilt on seed, cleared on
// reset (project switch) and test reset — so stale ranks never leak across a
// snapshot replacement. The pure core treeMap.ts is untouched: rootNodes() /
// childrenIndex() still return fresh, order-preserving arrays; the shell
// accessors sort those fresh arrays in place and NEVER mutate the map.
let rankSeq = new Map<string, number>();
let rankCounter = 0;

function clearRankState(): void {
  rankSeq = new Map();
  rankCounter = 0;
}

// Rebuild ranks for a freshly-seeded map from its current recency (updatedMs
// DESC) order. Purely timestamp-driven — working() is deliberately NOT
// consulted, so a node already working at seed is NOT promoted to the front
// (no synthetic activity edge). Within every sibling group the resulting
// rank-DESC order equals updatedMs-DESC with stable (emit-order) tie-breaking,
// i.e. identical to the former continuous sort AT SEED TIME.
function rebuildRankState(newMap: TreeFlatMap): void {
  rankSeq = new Map();
  rankCounter = 0;
  // Front-first (updatedMs DESC; Array.prototype.sort is stable so ties keep
  // emit/insertion order). Assign rank back-to-front so the front node receives
  // the highest rank (rank-DESC => front-first), reproducing the seed recency
  // order exactly.
  const frontFirst = [...newMap.values()].sort((a, b) => b.updatedMs - a.updatedMs);
  for (let i = frontFirst.length - 1; i >= 0; i--) {
    rankSeq.set(frontFirst[i].id, ++rankCounter);
  }
}

// Place one id at the front of its sibling group (highest rank so far).
function pushFrontRank(id: string): void {
  rankSeq.set(id, ++rankCounter);
}

// Place a batch of ids at the front PRESERVING their forward order (the first id
// ends up most-front). Used by applyTreeOpStore for the set of new / promoted /
// reparented ids within a single op. Reverse-iterates so forward order maps to
// rank-DESC front-to-back.
function pushFrontRankBatch(ids: string[]): void {
  for (let i = ids.length - 1; i >= 0; i--) pushFrontRank(ids[i]);
}

// Sort comparator for the shell accessors: rank DESC, then (defensively, for a
// node that somehow has no rank) updatedMs DESC, then stable. Ranked nodes
// always sort ahead of unranked ones.
function rankCompareDesc(a: TreeNode, b: TreeNode): number {
  const ra = rankSeq.get(a.id) ?? Number.NEGATIVE_INFINITY;
  const rb = rankSeq.get(b.id) ?? Number.NEGATIVE_INFINITY;
  if (ra !== rb) return rb - ra;
  return b.updatedMs - a.updatedMs;
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
  // Stable activity-edge promotion ordering: roots are ordered by shell-owned
  // presentation rank (rank DESC) instead of a continuous updatedMs-DESC
  // re-sort. Rank changes only on meaningful edges (new insertion -> front,
  // non-working->working promote once, reparent -> front) and is rebuilt from
  // recency on seed — see the "presentation rank" section above. This keeps
  // "recent on top" for meaningful activity edges while an actively-streaming
  // session no longer jumps on every updatedMs tick. rootNodes() returns a fresh
  // array each call, so this in-place sort does NOT mutate the map; the pure
  // `rootNodes`/`childrenIndex` in treeMap.ts keep their order-preserving
  // (insertion/emit) contract so any future caller can still get emit order.
  return rootNodes(map).sort(rankCompareDesc);
}

// Direct children of `parentId` (grouped by parentId, §7.3 render grouping).
export function treeChildrenOf(parentId: string): TreeNode[] {
  void version();
  // Stable activity-edge promotion ordering — see treeRoots() above. Applies
  // INDEPENDENTLY to each parent's child group. childrenIndex() builds a fresh
  // array per call, so sorting it in place is safe and does NOT mutate the map.
  // Pinned children are filtered out by the caller (SessionTree.tsx) before
  // render, so this does NOT touch pin order (pins come from selectPinnedNodes,
  // not this accessor).
  return (childrenIndex(map).get(parentId) ?? []).sort(rankCompareDesc);
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
//     true→false+filtered→collapsed); any other combination is a no-op. A
//     DEMOTE edge computed from an UNESTABLISHED observation is suppressed
//     (ESTABLISHMENT GATE below).
//   - if the id is NEW (not in the previous map → a baseline, no edge fires):
//     a working node is left ABSENT so modeOf() returns the implicit "filtered"
//     fallback (so its working children reveal immediately); an idle node with
//     NO explicit entry is materialized as explicit "collapsed" (the cold rule
//     that keeps the lazy-frontier effect from fetching children of every idle
//     unloaded node at load — UNGATED: fetch suppression must not depend on
//     establishment).
//   - ABSOLUTE INVARIANT (established observations only): an idle node is never
//     left in "filtered" — it is repaired/materialized to explicit "collapsed".
//     ESTABLISHMENT GATE (payload truth; generalizes 499e327's
//     coldBaselineExplicitFiltered oldMap heuristic): the repair/demote of an
//     EXPLICIT persisted "filtered" fires ONLY when the observation is
//     ESTABLISHED (activityEstablished — the payload's activity is a real
//     idle|busy|retry|error, not the never-seeded "" the wire ships for a
//     mid-hydrate frontier or a rebuilt node). working() CONFLATES "" with
//     "idle" (both read non-working) — that conflation is exactly what made a
//     pre-hydration observation look like a settle. The frontier snapshot can
//     ship a genuinely-running node unestablished: the server's activity seed
//     (SetActivityFromStatuses) is fanned out CONCURRENTLY with the capture by
//     the aggregator's hydrate, so the snapshot may predate it — the payload
//     ships activity:"", whose EFFECT through working() is indistinguishable
//     from genuine idleness. A demotion from such an observation is UNHEALABLE
//     on a cold baseline: the next busy observation after a reload is another
//     baseline (no edge fires), so a demoted "collapsed" sticks forever while
//     collapsed+working renders nothing — the "persisted filtered randomly
//     demotes to collapsed on resume" bug. The gate covers EVERY path (cold
//     baseline, daemon-restart re-seed of a KNOWN node, mid-hydrate op-path
//     rebuild), and the deferred demote fires naturally once establishment
//     lands (""→activity emits node.facet{activity} — an established
//     observation). Keeping an explicit "filtered" under an unestablished
//     observation is RENDER-safe but not FETCH-neutral: a mounted filtered
//     branch with unloaded known descendants still lazy-fetches children once
//     per mount — a bounded cost accepted over unhealable demotion. Working
//     nodes in "filtered" (absent or explicit) are left as-is
//     (working+filtered valid).
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
  const modeMapNow = treeModeMap();
  for (const [id, newNode] of newMap) {
    // Compute any genuine working() transition edge target first (may be
    // undefined for baselines / no-edge / expanded cases).
    let target: TreeMode | undefined;
    if (oldMap.has(id)) {
      const prevWorking = working(oldMap.get(id)!);
      const curWorking = working(newNode);
      const persisted = modeOf(id);
      target = autoTreeModeForWorkingTransition(prevWorking, curWorking, persisted);
      // ESTABLISHMENT GATE (demote only): a demote edge (true→false +
      // filtered→collapsed) computed from an UNESTABLISHED observation
      // (activity === "") is not a real settle — the re-seed may predate the
      // server's activity seed (daemon restart / reconnect). Suppress it; the
      // deferred demote fires when establishment lands (""→activity emits
      // node.facet{activity}). PROMOTE edges stay ungated (working implies the
      // reveal is wanted, and a promote is healable by a later settle).
      // SCOPE: this gate protects EXPLICIT persisted entries only (a demote
      // edge, or the explicit-"filtered" repair below). An ABSENT-mode idle
      // node is NOT gated — it materializes "collapsed" via the ungated cold
      // rule below regardless of establishment (fetch suppression must not
      // depend on it; a collapsed absent node is healable by a later promote
      // edge either way).
      if (target === "collapsed" && !activityEstablished(newNode)) target = undefined;
    }
    // The effective mode this node will hold AFTER applying the edge target (or
    // its current persisted mode / absent-fallback if no edge fires).
    const effective = target ?? modeOf(id);
    if (!working(newNode) && effective === "filtered") {
      // ABSOLUTE invariant: idle + filtered → collapsed. Covers absent-idle
      // (materialize collapsed — UNGATED: cold-load lazy-frontier fetch
      // suppression must not depend on establishment) AND
      // explicit-filtered-idle (repair to collapsed). ESTABLISHMENT GATE
      // (replaces 499e327's coldBaselineExplicitFiltered oldMap heuristic with
      // payload truth): an EXPLICIT persisted "filtered" observed UNESTABLISHED
      // (activity === "" — a mid-hydrate frontier OR a daemon-restart re-seed
      // of a KNOWN node) is left UNTOUCHED; see the header. Once establishment
      // lands, busy+filtered needs no write at all and idle+filtered repairs
      // then — an explicit "idle" payload on a cold baseline IS established
      // and repairs (the stale-filtered tradeoff c-F1 ages out).
      const explicitFiltered = modeMapNow[id] === "filtered";
      if (!explicitFiltered || activityEstablished(newNode)) {
        changes.set(id, "collapsed");
      }
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
  rebuildRankState(newMap); // rebuild presentation rank from recency (no synthetic edge)
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
//     ESTABLISHMENT GATE: the EXPLICIT-"filtered" repair (and the demote edge
//     it applies) is skipped when the post-op node is UNESTABLISHED
//     (activity === ""); the absent-fallback materialization stays UNGATED
//     (cold-load fetch suppression must not depend on establishment).
//     ASYMMETRY NOTE (why an op can even carry an unestablished node): facet
//     ops carry EXPLICIT activity strings (presence drives the merge, and the
//     server only emits a real idle|busy|retry|error — "" is never a facet
//     value), so a facet observation is always established. node.upsert and
//     node.children REBUILD the node from server state and CAN ship
//     activity:"" mid-hydrate (the same aggregator race as the seed path) —
//     those are the rebuild ops the establishment gate here protects.
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
  // Snapshot the persisted mode map BEFORE the loop: the establishment gate
  // below must distinguish an EXPLICIT "filtered" (repair candidate) from the
  // absent-fallback (materialization candidate). setNodeModes runs only after
  // the loop, so this snapshot stays accurate throughout.
  const modeMapNow = treeModeMap();
  // Capture the ids a node.remove will drop (the node + its loaded descendants)
  // BEFORE applyOp so presentation ranks can be cleaned up afterwards (deletion
  // reconcile). For every other op this is empty.
  const removeIds: string[] = op.op === "node.remove" ? loadedDescendants(map, op.data.id) : [];
  applyOp(map, op);
  const syncChanges = new Map<string, TreeMode>();
  // Collect ids that (re)enter at the FRONT of their sibling group this op: new
  // insertions and non-working->working promotion edges. Reparent (node.move) is
  // reconciled below. Assigned in one batch after the loop so a multi-id op
  // (e.g. node.children) preserves arrival order at the front.
  const frontPromotions: string[] = [];
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
        // RANK: a non-working -> working edge promotes the node to the front of
        // its group EXACTLY ONCE (this branch fires only on the edge itself).
        // The working -> idle settle deliberately does NOT re-rank here, so the
        // node's position HOLDS through the settle (no completion-time jump).
        if (!prevWorking && curWorking) {
          frontPromotions.push(id);
        }
      }
    } else {
      // RANK: a newly-inserted node (not resident before this op) enters at the
      // FRONT of its sibling group.
      frontPromotions.push(id);
    }
    // ABSOLUTE invariant: an idle resident node is NEVER in "filtered".
    // Synchronously collapse before callers observe post-op state. Covers
    // absent+idle (→ explicit collapsed), explicit-filtered+idle (→ repaired),
    // and the demotion edge (true→false + filtered → collapsed, applied here
    // rather than via a queued candidate). A promotion candidate enqueued above
    // is for a WORKING node, so this check does not conflict with it.
    // ESTABLISHMENT GATE: the absent-fallback materialization is UNGATED
    // (cold-load fetch suppression must not depend on establishment — a
    // collapsed absent node is healable by a later promote edge either way);
    // the EXPLICIT-"filtered" repair (and the demote edge it applies) fires
    // only for an ESTABLISHED observation — node.upsert/node.children rebuild
    // from server state and can ship activity:"" mid-hydrate (ASYMMETRY NOTE
    // above). The suppressed demote is deferred, never lost: establishment
    // lands as node.facet{activity} (always explicit) and reconciles here.
    if (!working(after) && modeOf(id) === "filtered") {
      const explicitFiltered = modeMapNow[id] === "filtered";
      if (!explicitFiltered || activityEstablished(after)) {
        syncChanges.set(id, "collapsed");
      }
    }
  }
  // RANK: reparent (node.move) reconciles by (re)placing the moved node at the
  // front of its new sibling group. (A node.move does not change the node's own
  // working(), so it is never caught by the edge branch above.)
  if (op.op === "node.move" && map.has(op.data.id)) {
    frontPromotions.push(op.data.id);
  }
  if (frontPromotions.length > 0) pushFrontRankBatch(frontPromotions);
  // RANK: clean up presentation ranks for ids dropped by node.remove (deletion
  // reconcile) so a later re-introduction is treated as a fresh front insertion.
  for (const id of removeIds) rankSeq.delete(id);
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
  const removeIds = loadedDescendants(map, id); // node + loaded descendants
  applyOp(map, { op: "node.remove", data: { id } });
  for (const rid of removeIds) rankSeq.delete(rid); // deletion rank reconcile
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
  const all = loadedDescendants(map, id); // [id, ...loaded descendants]
  collapseNode(map, id, protectedIds);
  // Clean up presentation ranks for the dropped descendants (the placeholder id
  // and protected/pinned descendants stay resident, so keep their ranks).
  for (const rid of all) {
    if (rid === id) continue;
    if (protectedIds?.has(rid)) continue;
    rankSeq.delete(rid);
  }
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
// clears the in-memory mode map + userToggled AND the persisted ACTIVE mode key
// (v3) so a project switch does NOT carry stale mode toggles forward and tests
// do not bleed across cases (reviewer advisory tier1_a-F1/tier1_c-F2): the mode
// map is persisted, so a plain reset of in-memory is NOT enough on a true
// project switch — the persisted key is cleared too so the next reload of the
// new project does not rehydrate the old project's modes. The v2 and legacy v1
// keys are left untouched (dead read-only rollback copies).
export function resetTreeStore(): void {
  map = new Map();
  setTreeModeMap({});
  saveVersioned(LS_MODE_V3, 1, {});
  setUserToggled(new Set<string>());
  invalidateAutoQueue(); // drop any candidates from the prior project/session-tree
  clearRankState(); // drop stale ranks from the prior project/session-tree
  bump();
}
