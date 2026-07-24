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
//     a version signal so every tracked reader re-runs.
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
import { activePathIds } from "./treeSelectors";
import { loadVersioned, saveVersioned } from "../lib/store";

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

// ---- user expand-state (persisted UI toggle) — P1-A -------------------------
// Separate UI expand-state from map-presence: a node's children STAY in the
// flat map (instant expand, no round-trip) but only RENDER when (a) the node is
// on an ACTIVE PATH (auto-expanded via activePathIds), or (b) the user explicitly
// expanded it (this `userExpanded` set).
//
// P1-A: persisted to localStorage (UI state only, §11-sanctioned) so a page
// reload keeps manual expansions. The flat tree MAP is NEVER persisted (§11 keeps
// structure unpersisted — that is what keeps "reload does not flatten" true:
// seedTreeStore REPLACES the whole map on every tree.snapshot, so the structure
// is always re-fetched from the server). Only this `userExpanded` Set of node
// ids is persisted, rehydrated on load, and backfilled after the frontier seed.
//
// The half-state trap (why persistence needs BACKFILL): on a cold reload the §5
// frontier ships an idle user-expanded node COLLAPSED — its children are NOT
// resident (the server's per-connection expanded-set resets). A persisted
// `userExpanded={X}` whose children aren't resident would be a confusing
// half-state (isUserExpanded true but nothing renders; the first twisty click
// inverts to collapse). The fix is PERSISTENCE + BACKFILL: stream.ts reads
// `expandedButUnloadedIds()` right after the frontier seed and fires
// expandTreeNode for each, so a persisted-expanded node's children are fetched
// and land via subsequent node.children ops (the TreeRow's
// `expanded={open() && children().length>0}` shows the collapsed ▸N badge until
// the fetch lands, then flips open — a clean transition, no half-state).
//
// Single global key (mirrors the deleted proj=1 client's `vh.tree.mode.v2`
// precedent). Stale non-resident ids are harmless: rehydrate, render, and
// expandedButUnloadedIds all skip ids not present in the map.
const LS_EXPANDED = "vh.tree.expanded.v1";

// Rehydrate at module init (page load). The very first signal value is seeded
// from localStorage so a reload starts with the persisted expansions. coerce is
// a safety net for legacy/foreign payloads (a version-matched read returns the
// stored array directly without invoking it).
const initialExpanded = new Set<string>(
  loadVersioned<string[]>(LS_EXPANDED, 1, [], (o) => (Array.isArray(o) ? o : [])),
);
const [userExpanded, setUserExpandedSig] = createSignal<Set<string>>(initialExpanded);

// Version-keyed cache: activePathIds scans the whole map, so memoize it per tree
// version (once per mutation) rather than recomputing on every isNodeExpanded()
// call across all rendered rows. Reading `version()` inside isNodeExpanded
// subscribes the caller's reactive scope to tree mutations — the same
// tracked-accessor pattern as treeMap()/treeNode() (which also `void version()`).
let activePathCache: { v: number; set: Set<string> } | null = null;

// Reactive: is `id` currently expanded in the RENDER (children rendered)?
// True iff on the active path OR user-expanded. Collapsing an active-path node
// is a benign no-op here (it stays expanded) — live work must stay visible.
//
// @deprecated for the RENDER gate — SessionTree.TreeBranch now uses the per-child
// gate (`visiblePathIds` ∪ per-child filter + `isUserExpanded`). This fn is
// retained because the unit suite (treeState.test.ts) asserts its active-path ∪
// userExpanded contract directly; new render code should NOT call it.
export function isNodeExpanded(id: string): boolean {
  const v = version();
  if (activePathCache === null || activePathCache.v !== v) {
    activePathCache = { v, set: activePathIds(map) };
  }
  return activePathCache.set.has(id) || userExpanded().has(id);
}

// Reactive: is `id` explicitly USER-expanded (the IN-MEMORY UI toggle ONLY)?
// This is just the user toggle — it does NOT include the active-path auto-expand.
// The per-child render gate (SessionTree.TreeBranch) reads this to decide
// whether a parent renders ALL its children (user-expanded) vs only the
// keep-visible-path ones (visiblePathIds). Reading the `userExpanded` signal
// subscribes the caller's reactive scope to user toggles.
export function isUserExpanded(id: string): boolean {
  return userExpanded().has(id);
}

// User toggled a node open/closed. Adds/removes from the UI set; does NOT touch
// the flat map and does NOT flip `loaded` (that is the §8.4 fetch-collapse's job,
// a different mechanism). P1-A: also persists the new set to localStorage so the
// toggle survives a reload.
export function setUserNodeExpanded(id: string, open: boolean): void {
  const next = new Set(userExpanded());
  if (open) next.add(id);
  else next.delete(id);
  setUserExpandedSig(next);
  saveVersioned(LS_EXPANDED, 1, [...next]);
}

// Pure helper (P1-A backfill source): the ids in `userExpanded` that are
// RESIDENT but have NO resident direct children AND still have descendants to
// fetch — i.e. persisted-expanded nodes the cold-load frontier left collapsed.
// stream.ts fires expandTreeNode for each after the frontier seed so their
// children land via subsequent node.children ops (resolving the half-state
// trap). Reads `version()` so a caller in a reactive scope subscribes to tree
// mutations (harmless when called imperatively post-seed).
//
// - skip ids not in the map (non-resident — stale persisted id, never seeded);
// - skip ids whose direct children are already resident (nothing to fetch);
// - skip ids with nothing to fetch (childCount 0 AND descendantCount 0).
export function expandedButUnloadedIds(): string[] {
  void version();
  const idx = childrenIndex(map);
  const out: string[] = [];
  for (const id of userExpanded()) {
    const n = map.get(id);
    if (!n) continue; // non-resident
    if ((idx.get(id)?.length ?? 0) > 0) continue; // resident children present
    if (n.childCount === 0 && (n.descendantCount ?? 0) === 0) continue; // nothing to fetch
    out.push(id);
  }
  return out;
}

// Test reset: clear the in-memory toggle (mirrors the fresh-load default). P1-A:
// clears in-memory ONLY — persisted localStorage is left untouched so this doubles
// as the "simulate page reload" primitive (a reload loses the Solid signals but
// keeps persisted UI state; rehydrateExpandedForTest then re-seeds from disk).
// resetTreeStore (true project switch) clears BOTH.
export function resetExpandedForTest(): void {
  setUserExpandedSig(new Set<string>());
  activePathCache = null;
}

// Test helper: re-run the module-init loadVersioned seed against the current
// localStorage. Lets a unit test exercise the rehydrate path without a real
// module reload (the module initializes once per test file).
export function rehydrateExpandedForTest(): void {
  const stored = loadVersioned<string[]>(LS_EXPANDED, 1, [], (o) =>
    Array.isArray(o) ? o : [],
  );
  setUserExpandedSig(new Set(stored));
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
  // future caller can still get emit order; the recency sort lives in these
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
  // filtered out by the caller (SessionTree.tsx:46) before render, so this does
  // NOT touch pin order (pins come from selectPinnedNodes, not this accessor).
  return (childrenIndex(map).get(parentId) ?? []).sort((a, b) => b.updatedMs - a.updatedMs);
}

// ---- mutators ---------------------------------------------------------------
// Each delegates to a pure `treeMap.ts` fn (the tested core) and then bumps the
// version so tracked readers re-run. No inference, no reconciliation.

// §7.1 seed from the initial snapshot: replace the whole map.
export function seedTreeStore(nodes: TreeNode[]): void {
  map = seedTree(nodes);
  bump();
}

// §7.2 apply a single server op verbatim (upsert/remove/move/children/facet).
export function applyTreeOpStore(op: TreeOp): void {
  applyOp(map, op);
  bump();
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
// the user expand/collapse render gate (isNodeExpanded/setUserNodeExpanded
// above). The UI onToggle no longer routes through here — it toggles the
// `userExpanded` UI state and the render gate decides whether children render.
// This fn stays as the library primitive (e.g. server-driven collapse, tests).
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
// clears the in-memory expand state so a project switch does NOT carry stale
// user toggles forward and tests do not bleed across cases (reviewer advisory
// tier1_a-F1/tier1_c-F2): `userExpanded` is now persisted (P1-A), so a plain
// reset of in-memory is NOT enough on a true project switch — the persisted key
// is cleared too so the next reload of the new project does not rehydrate the
// old project's expansions. The activePath memo is invalidated so the next
// isNodeExpanded() read recomputes against the new map.
export function resetTreeStore(): void {
  map = new Map();
  setUserExpandedSig(new Set<string>());
  saveVersioned(LS_EXPANDED, 1, []);
  activePathCache = null;
  bump();
}
