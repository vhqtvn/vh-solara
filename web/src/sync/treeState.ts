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
  return rootNodes(map);
}

// Direct children of `parentId` (grouped by parentId, §7.3 render grouping).
export function treeChildrenOf(parentId: string): TreeNode[] {
  void version();
  return childrenIndex(map).get(parentId) ?? [];
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
export function collapseTreeNode(id: string): void {
  collapseNode(map, id);
  bump();
}

// Clear the whole tree (project switch / epoch change / test reset).
export function resetTreeStore(): void {
  map = new Map();
  bump();
}
