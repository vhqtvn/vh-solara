// Server-owned session tree — CLIENT flat-map + op-apply layer.
// docs/design/server-owned-tree.md §7.
//
// The client holds a FLAT `Map<id, TreeNode>` and applies server ops VERBATIM.
// It NEVER infers parent→child, NEVER classifies orphans, NEVER reconciles
// ghosts. Every node always carries its own display data; "collapsed" is just a
// render attribute (`loaded:false`), NOT a node type. The tree is rendered by
// grouping the flat map on `parentId` (§7.3).
//
// This module is PURE logic: no network, no store, no Solid. It is the
// unit-testable core; `treeOps.ts` adds the envelope decoders + §8 expand fetch,
// and `stream.ts` wires them together.
import type { Activity, VerbFacet } from "../types";

// ---- Node schema (§3) ------------------------------------------------------
// Every field except `agent`, `verb`, `descendantCount` is required (a node is
// self-contained). `verb`/`flags.subtreeNeedsInput` semantics are defined by §3.
export interface TreeNodeFlags {
  pendingInput: boolean;
  // The ONE retained subtree-aggregate (§3 Q2): true iff this node OR any
  // descendant has pendingInput. SERVER-COMPUTED; the client only displays it.
  subtreeNeedsInput: boolean;
  // SERVER-COMPUTED subtree aggregate: self OR any descendant is busy/retry.
  // OR'd into TreeRow.isBusy so a collapsed ancestor of a busy descendant spins.
  // Optional so nodes constructed without it (existing tests) still typecheck;
  // undefined is falsy.
  subtreeBusy?: boolean;
  permission: boolean;
  archived: boolean;
  // SERVER-COMPUTED ONLY (§9). The client never sets this.
  orphan: boolean;
}

export interface TreeNode {
  id: string;
  parentId: string | null; // null = root. Always server-assigned.
  title: string;
  agent?: string; // absent = no chip yet
  verb?: VerbFacet | null; // tri-state in facet ops (null clears). See §4.6.
  activity: Activity; // SELF activity (not subtree aggregate)
  childCount: number; // DIRECT children (structural — what an expand fetches)
  descendantCount?: number; // TOTAL descendants — drives the "▸ N" badge on collapsed nodes
  loaded: boolean; // does THIS client currently hold this node's direct children?
  flags: TreeNodeFlags;
  updatedMs: number; // unix ms
}

// ---- Delta ops (§4) --------------------------------------------------------
// A single discriminated union over the five op kinds. The envelope (`dir`,
// `seq`, `sessionId`) lives at the stream layer (treeOps.ts); this type is the
// op payload the apply logic consumes.
export type TreeOp =
  | { op: "node.upsert"; data: { node: TreeNode } }
  | { op: "node.remove"; data: { id: string } }
  | { op: "node.move"; data: { id: string; newParentId: string | null } }
  | {
      op: "node.children";
      data: {
        parentId: string;
        nodes: TreeNode[];
        hasMore: boolean;
        cursor?: string | null;
      };
    }
  | {
      op: "node.facet";
      data: {
        id: string;
        // All fields below are OPTIONAL — presence drives the merge (§4.6/§7.2).
        // verb is tri-state: absent = untouched, null = clear, object = set.
        activity?: Activity;
        verb?: VerbFacet | null;
        flags?: Partial<TreeNodeFlags>;
      };
    };

// The flat map is a plain Map so the apply layer stays framework-free.
export type TreeFlatMap = Map<string, TreeNode>;

// ---- §7.1 seed from initial snapshot ---------------------------------------
export function seedTree(nodes: TreeNode[]): TreeFlatMap {
  const m: TreeFlatMap = new Map();
  for (const n of nodes) m.set(n.id, n);
  return m;
}

// ---- §7.2 per-op mutation --------------------------------------------------
export function applyOps(map: TreeFlatMap, ops: TreeOp[]): void {
  for (const op of ops) applyOp(map, op);
}

export function applyOp(map: TreeFlatMap, op: TreeOp): void {
  switch (op.op) {
    case "node.upsert": {
      // FULL replace (idempotent — no merge, no carry-over of dropped fields).
      map.set(op.data.node.id, op.data.node);
      return;
    }
    case "node.remove": {
      // Drop the node AND every LOADED descendant rooted at it (§7.2). No
      // inference from absence: only this op removes a node.
      for (const id of loadedDescendants(map, op.data.id)) map.delete(id);
      map.delete(op.data.id);
      return;
    }
    case "node.move": {
      // Reparent. Loaded descendants travel implicitly (they point at this
      // node); re-render re-groups by parentId automatically.
      const n = map.get(op.data.id);
      if (n) map.set(op.data.id, { ...n, parentId: op.data.newParentId });
      return;
    }
    case "node.children": {
      // Merge each child into the flat map (replace each).
      for (const child of op.data.nodes) map.set(child.id, child);
      // On the terminal page, mark the parent's direct children as loaded.
      const parent = map.get(op.data.parentId);
      if (parent && !op.data.hasMore) {
        map.set(op.data.parentId, { ...parent, loaded: true });
      }
      // (cursor stash for the next page is owned by treeOps.ts / the caller.)
      return;
    }
    case "node.facet": {
      // Partial merge — field PRESENCE drives which facets change (§4.6/§7.2).
      // A facet for an unknown node is ignored (no inference, no ghost).
      const n = map.get(op.data.id);
      if (!n) return;
      const merged: TreeNode = { ...n };
      if ("activity" in op.data) merged.activity = op.data.activity as Activity;
      if ("verb" in op.data) merged.verb = op.data.verb; // null clears
      if ("flags" in op.data && op.data.flags) {
        merged.flags = { ...merged.flags, ...op.data.flags };
      }
      map.set(op.data.id, merged);
      return;
    }
  }
}

// ---- loadedDescendants (BFS by parentId within the loaded set) -------------
// Returns the ids of `id` and every node whose ancestor chain (following
// parentId) leads to `id` and is currently resident in the map. This is the
// shared primitive for `node.remove` (§7.2) and `collapse` (§8.4): both drop
// the loaded subtree rooted at a node.
export function loadedDescendants(map: TreeFlatMap, id: string): string[] {
  if (!map.has(id)) return [];
  // Build a parent→children adjacency once, then BFS from `id`.
  const childrenOf: Map<string, string[]> = new Map();
  for (const n of map.values()) {
    const key = n.parentId;
    if (key === null) continue; // roots have no parent bucket
    const bucket = childrenOf.get(key);
    if (bucket) bucket.push(n.id);
    else childrenOf.set(key, [n.id]);
  }
  const out: string[] = [];
  const queue: string[] = [id];
  while (queue.length) {
    const cur = queue.shift()!;
    out.push(cur);
    const kids = childrenOf.get(cur);
    if (kids) queue.push(...kids);
  }
  return out;
}

// ---- §8.4 client-only collapse ---------------------------------------------
// Drops the loaded descendants from VIEW (keeps the placeholder node, flips
// loaded:false). The placeholder keeps its own display data (self-contained,
// §3), so collapsing never loses the node's own row/agent/badge. Does NOT
// round-trip to the server.
//
// `protectedIds` (optional): ids that must NOT be dropped even though they are
// loaded descendants of `id`. This is the PIN-parity hook: a pinned descendant
// is hoisted into the Pinned group and must stay resident when an ancestor
// collapses, otherwise the pinned group would lose it (the flat map is the
// pinned group's only source). Callers pass the current pinned membership
// (sidebar.ts); absent it, all descendants drop as before (unchanged §8.4).
export function collapseNode(map: TreeFlatMap, id: string, protectedIds?: ReadonlySet<string>): void {
  const node = map.get(id);
  if (!node) return;
  const [first, ...rest] = loadedDescendants(map, id);
  // `first` === id; drop only the descendants, keep the placeholder.
  void first;
  for (const desc of rest) {
    if (protectedIds?.has(desc)) continue; // pinned node stays resident
    map.delete(desc);
  }
  map.set(id, { ...node, loaded: false });
}

// ---- render helpers (group the flat map on parentId) -----------------------
// The tree renders by grouping the flat map on parentId. The server is the sole
// authority for parentId (§7.3); the client never promotes an orphan to a root.
export function childrenIndex(map: TreeFlatMap): Map<string | null, TreeNode[]> {
  const idx: Map<string | null, TreeNode[]> = new Map();
  for (const n of map.values()) {
    const key = n.parentId; // null OR string — both valid keys
    const bucket = idx.get(key);
    if (bucket) bucket.push(n);
    else idx.set(key, [n]);
  }
  return idx;
}

export function rootNodes(map: TreeFlatMap): TreeNode[] {
  const out: TreeNode[] = [];
  for (const n of map.values()) if (n.parentId === null) out.push(n);
  return out;
}
