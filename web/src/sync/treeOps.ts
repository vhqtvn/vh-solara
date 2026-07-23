// Server-owned session tree — op-layer helpers (decoders + §8 expand fetch).
// docs/design/server-owned-tree.md §4 (envelope/ops), §5/§7.1 (snapshot),
// §8 (expand), §8.3 (stale-cursor restart).
//
// This module sits between the raw SSE/HTTP wire (stream.ts) and the pure
// op-apply core (treeMap.ts). It turns raw JSON into typed TreeOps and owns the
// paginated expand fetch. It holds NO tree state of its own.
import type { TreeOp, TreeNode } from "./treeMap";

// ---- §4.1 envelope ---------------------------------------------------------
// The stream wraps each op in `{ dir?, seq, sessionId?, op, data }`. Only `op`
// and `data` are structurally authoritative to the client; `seq` is the
// per-connection emitter counter (see F4: the resume key is the SSE id /
// Last-Event-ID, NOT this body seq), and `dir`/`sessionId` are scope hints.
export interface TreeOpEnvelope {
  dir?: string;
  seq?: number;
  sessionId?: string;
  op: string;
  data: unknown;
}

const NODE_OPS = new Set([
  "node.upsert",
  "node.remove",
  "node.move",
  "node.children",
  "node.facet",
]);

// Decode a raw envelope payload into a typed TreeOp, or null if it is not a
// recognized node.* op. Returning null (rather than throwing) lets the stream
// layer log and drop unknown/legacy ops without killing the connection —
// important because the server may emit new op kinds before a client upgrade.
export function decodeTreeOp(raw: unknown): TreeOp | null {
  if (!raw || typeof raw !== "object") return null;
  const env = raw as Partial<TreeOpEnvelope>;
  if (typeof env.op !== "string" || !NODE_OPS.has(env.op)) return null;
  const data = env.data;
  if (!data || typeof data !== "object") return null;
  switch (env.op) {
    case "node.upsert": {
      const node = (data as { node?: unknown }).node;
      if (!isTreeNode(node)) return null;
      return { op: "node.upsert", data: { node } };
    }
    case "node.remove": {
      const id = (data as { id?: unknown }).id;
      if (typeof id !== "string") return null;
      return { op: "node.remove", data: { id } };
    }
    case "node.move": {
      const id = (data as { id?: unknown }).id;
      const npid = (data as { newParentId?: unknown }).newParentId;
      if (typeof id !== "string") return null;
      if (npid !== null && typeof npid !== "string") return null;
      return { op: "node.move", data: { id, newParentId: npid as string | null } };
    }
    case "node.children": {
      const parentId = (data as { parentId?: unknown }).parentId;
      const nodes = (data as { nodes?: unknown }).nodes;
      const hasMore = (data as { hasMore?: unknown }).hasMore;
      const cursor = (data as { cursor?: unknown }).cursor;
      if (typeof parentId !== "string") return null;
      if (!Array.isArray(nodes) || !nodes.every(isTreeNode)) return null;
      if (typeof hasMore !== "boolean") return null;
      return {
        op: "node.children",
        data: {
          parentId,
          nodes: nodes as TreeNode[],
          hasMore,
          cursor: typeof cursor === "string" ? cursor : null,
        },
      };
    }
    case "node.facet": {
      const id = (data as { id?: unknown }).id;
      if (typeof id !== "string") return null;
      // activity / verb / flags are all OPTIONAL — presence drives the merge
      // (§4.6). We pass them through verbatim; the apply layer checks presence.
      const out: Extract<TreeOp, { op: "node.facet" }> = { op: "node.facet", data: { id } };
      if ("activity" in (data as object)) out.data.activity = (data as { activity?: unknown }).activity as TreeNode["activity"];
      if ("verb" in (data as object)) out.data.verb = (data as { verb?: unknown }).verb as TreeNode["verb"];
      if ("flags" in (data as object)) out.data.flags = (data as { flags?: unknown }).flags as Partial<TreeNode["flags"]>;
      return out;
    }
  }
  return null;
}

// ---- §5/§7.1 snapshot ------------------------------------------------------
export interface TreeSnapshot {
  nodes: TreeNode[];
  focusedSessionId?: string;
}

export function decodeTreeSnapshot(raw: unknown): TreeSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as { nodes?: unknown; focusedSessionId?: unknown };
  if (!Array.isArray(obj.nodes) || !obj.nodes.every(isTreeNode)) return null;
  const snap: TreeSnapshot = { nodes: obj.nodes as TreeNode[] };
  if (typeof obj.focusedSessionId === "string") snap.focusedSessionId = obj.focusedSessionId;
  return snap;
}

// ---- node shape guard ------------------------------------------------------
// Light validation — the server is the authority, so we only assert the
// structurally-required fields exist with the right primitive types. Optional
// fields (agent/verb/descendantCount) are passed through untouched.
function isTreeNode(v: unknown): v is TreeNode {
  if (!v || typeof v !== "object") return false;
  const n = v as Record<string, unknown>;
  return (
    typeof n.id === "string" &&
    (n.parentId === null || typeof n.parentId === "string") &&
    typeof n.title === "string" &&
    typeof n.activity === "string" &&
    typeof n.childCount === "number" &&
    typeof n.loaded === "boolean" &&
    typeof n.updatedMs === "number" &&
    !!n.flags &&
    typeof n.flags === "object"
  );
}

// ---- §8 expand fetch (pagination + stale-cursor restart) ------------------
export interface ChildrenResponse {
  parentId: string;
  nodes: TreeNode[];
  hasMore: boolean;
  cursor?: string | null;
  // §8.3: set ONLY when a non-empty pagination cursor child was deleted/
  // reparented between page requests. The client restarts ONCE from page 0.
  staleCursor?: boolean;
}

// Dependency-injected fetcher so the expand logic is unit-testable without a
// real network. The real wiring (stream.ts) passes a function that performs
// `GET /vh/tree/children?dir=<dir>&id=<id>&cursor=<cursor>`.
export type TreeFetcher = (
  dir: string,
  id: string,
  cursor: string | null,
) => Promise<ChildrenResponse>;

// Fetch all pages of a node's direct children, emitting a `node.children` op per
// page (the terminal page carries hasMore:false so the apply layer flips the
// parent's `loaded` flag, §7.2). Handles the §8.3 stale-cursor restart: on a
// `staleCursor:true` response, restarts ONCE from page 0 rather than treating
// the empty batch as terminal pagination (which would permanently omit later
// siblings).
//
// F1 (carry-forward, fixed here): the previous implementation applied the
// stale-cursor batch BEFORE detecting staleCursor and restarting. Because
// `node.children` MERGES (never removes), a child introduced on an earlier page
// that was deleted server-side before the stale page lingered as an obsolete
// resident node through the restart's fresh page-0 merge. The fix detects
// staleCursor BEFORE applying the (unreliable) batch, drops the in-progress
// loaded subtree (the direct children THIS expand has applied so far, via
// `node.remove` — which also drops each removed child's own loaded descendants),
// and THEN restarts from page 0 so the fresh batch re-seeds the correct set.
export async function fetchChildren(
  apply: (op: TreeOp) => void,
  fetcher: TreeFetcher,
  dir: string,
  id: string,
): Promise<void> {
  let cursor: string | null = null;
  let restarted = false;
  // F1: direct-child ids THIS expand has applied so far. On a staleCursor
  // restart we emit `node.remove` for each so they don't merge-linger as
  // obsolete residents under the fresh page-0 re-apply.
  let appliedIds: Set<string> = new Set();
  for (;;) {
    const res = await fetcher(dir, id, cursor);
    // F1 fix: detect staleCursor BEFORE applying the batch. The stale batch is
    // unreliable (the cursor child vanished mid-pagination); applying it first
    // would either merge obsolete nodes or, on the restart, leave earlier-page
    // children lingering. Instead drop what THIS expand loaded so far and
    // restart from page 0.
    if (res.staleCursor && !restarted) {
      for (const childId of appliedIds) {
        apply({ op: "node.remove", data: { id: childId } });
      }
      appliedIds = new Set();
      restarted = true;
      cursor = null;
      continue;
    }
    apply({
      op: "node.children",
      data: {
        parentId: id,
        nodes: res.nodes,
        hasMore: res.hasMore,
        cursor: typeof res.cursor === "string" ? res.cursor : null,
      },
    });
    for (const child of res.nodes) appliedIds.add(child.id);
    if (!res.hasMore) return;
    if (typeof res.cursor !== "string") {
      // Defensive: server said hasMore but gave no cursor — stop to avoid a
      // tight loop. (The server contract always pairs hasMore with a cursor.)
      return;
    }
    cursor = res.cursor;
  }
}
