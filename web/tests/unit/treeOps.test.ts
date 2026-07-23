// Tests for the tree=2 op-layer helpers (web/src/sync/treeOps.ts):
//  - envelope/op DECODERS (pure — turn raw SSE JSON into typed TreeOp/snapshot)
//  - §8 expand fetch with pagination + stale-cursor restart (§8.3)
//
// The expand fetch takes an injected `TreeFetcher` so it is unit-testable with
// no real network. Node env (pure logic).
import { describe, expect, it, vi } from "vitest";
import {
  decodeTreeOp,
  decodeTreeSnapshot,
  fetchChildren,
} from "../../src/sync/treeOps";
import type { ChildrenResponse, TreeFetcher } from "../../src/sync/treeOps";
import type { TreeOp } from "../../src/sync/treeMap";

const baseNode = {
  parentId: null,
  title: "",
  activity: "idle",
  childCount: 0,
  loaded: false,
  flags: {
    pendingInput: false,
    subtreeNeedsInput: false,
    permission: false,
    archived: false,
    orphan: false,
  },
  updatedMs: 0,
} as const;

// ---- decoders --------------------------------------------------------------
describe("decodeTreeOp — envelope/op decoders (§4)", () => {
  it("decodes a node.upsert envelope", () => {
    const raw = {
      dir: "/repo",
      seq: 7,
      sessionId: "S_x",
      op: "node.upsert",
      data: { node: { id: "S_x", ...baseNode, title: "hi" } },
    };
    const op = decodeTreeOp(raw);
    expect(op).toEqual({
      op: "node.upsert",
      data: { node: { id: "S_x", ...baseNode, title: "hi" } },
    } as TreeOp);
  });

  it("decodes node.remove / node.move / node.children / node.facet", () => {
    expect(decodeTreeOp({ op: "node.remove", data: { id: "a" } })?.op).toBe("node.remove");
    expect(
      decodeTreeOp({ op: "node.move", data: { id: "a", newParentId: "b" } })?.op,
    ).toBe("node.move");
    expect(
      decodeTreeOp({
        op: "node.children",
        data: { parentId: "p", nodes: [], hasMore: false },
      })?.op,
    ).toBe("node.children");
    expect(
      decodeTreeOp({ op: "node.facet", data: { id: "a", activity: "busy" } })?.op,
    ).toBe("node.facet");
  });

  it("preserves a null newParentId on node.move (move to root)", () => {
    const op = decodeTreeOp({ op: "node.move", data: { id: "a", newParentId: null } });
    expect(op).toEqual({ op: "node.move", data: { id: "a", newParentId: null } });
  });

  it("preserves a null verb on node.facet (tri-state: null clears)", () => {
    const op = decodeTreeOp({ op: "node.facet", data: { id: "a", verb: null } });
    expect(op && "verb" in op.data && op.data.verb).toBeNull();
  });

  it("returns null for an unrecognized op kind (dropped, not mis-applied)", () => {
    expect(decodeTreeOp({ op: "node.bogus", data: {} })).toBeNull();
    expect(decodeTreeOp({ op: "session.upsert", data: {} })).toBeNull(); // old proj=1 op
    expect(decodeTreeOp({ data: {} })).toBeNull(); // missing op field
    expect(decodeTreeOp(null)).toBeNull();
  });
});

describe("decodeTreeSnapshot — §5/§7.1 snapshot", () => {
  it("decodes nodes + focusedSessionId", () => {
    const snap = decodeTreeSnapshot({
      nodes: [{ id: "a", ...baseNode }, { id: "b", ...baseNode, parentId: "a" }],
      focusedSessionId: "a",
    });
    expect(snap?.nodes.map((n) => n.id)).toEqual(["a", "b"]);
    expect(snap?.focusedSessionId).toBe("a");
  });

  it("returns null for a malformed snapshot (no nodes array)", () => {
    expect(decodeTreeSnapshot({})).toBeNull();
    expect(decodeTreeSnapshot(null)).toBeNull();
  });
});

// ---- §8 expand fetch (pagination + stale-cursor restart) ------------------
describe("fetchChildren — §8 expand fetch", () => {
  it("applies a single terminal page and flips loaded on the terminal batch", async () => {
    const fetcher: TreeFetcher = vi.fn(async () => ({
      parentId: "p",
      nodes: [{ id: "c1", ...baseNode, parentId: "p" }],
      hasMore: false,
      cursor: null,
    }));
    const applied: TreeOp[] = [];
    await fetchChildren((op) => applied.push(op), fetcher, "/repo", "p");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/repo", "p", null);
    expect(applied).toEqual([
      {
        op: "node.children",
        data: {
          parentId: "p",
          nodes: [{ id: "c1", ...baseNode, parentId: "p" }],
          hasMore: false, // terminal → caller's apply flips loaded:true
          cursor: null,
        },
      },
    ]);
  });

  it("paginates across multiple pages, threading the cursor", async () => {
    const script: ChildrenResponse[] = [
      { parentId: "p", nodes: [{ id: "c1", ...baseNode, parentId: "p" }], hasMore: true, cursor: "c1" },
      { parentId: "p", nodes: [{ id: "c2", ...baseNode, parentId: "p" }], hasMore: true, cursor: "c2" },
      { parentId: "p", nodes: [{ id: "c3", ...baseNode, parentId: "p" }], hasMore: false, cursor: null },
    ];
    const fetcher: TreeFetcher = vi.fn(async (_dir, _id, cursor) => script[(cursor ? Number(cursor.slice(1)) : 0) - 1 + 1] ?? script[0]);
    // simpler deterministic script popper:
    const queue = [...script];
    const f: TreeFetcher = async () => queue.shift()!;
    const applied: TreeOp[] = [];
    await fetchChildren((op) => applied.push(op), f, "/repo", "p");
    expect(applied.length).toBe(3);
    expect(applied.map((o) => (o.op === "node.children" ? o.data.hasMore : null))).toEqual([
      true,
      true,
      false,
    ]);
    expect(applied[2].op).toBe("node.children");
  });

  it("restarts ONCE from page 0 on a staleCursor (§8.3), then completes", async () => {
    const queue: ChildrenResponse[] = [
      { parentId: "p", nodes: [{ id: "c1", ...baseNode, parentId: "p" }], hasMore: true, cursor: "c1" },
      // stale mid-pagination: empty + hasMore:false + staleCursor:true
      { parentId: "p", nodes: [], hasMore: false, cursor: null, staleCursor: true },
      // restart from page 0 returns the full set, terminal
      { parentId: "p", nodes: [{ id: "c1", ...baseNode, parentId: "p" }], hasMore: false, cursor: null },
    ];
    const f: TreeFetcher = async () => queue.shift()!;
    const calls: { cursor: string | null }[] = [];
    const wrapped: TreeFetcher = async (dir, id, cursor) => {
      calls.push({ cursor: cursor ?? null });
      return f(dir, id, cursor);
    };
    const applied: TreeOp[] = [];
    await fetchChildren((op) => applied.push(op), wrapped, "/repo", "p");
    // cursor sequence: null (page0) → "c1" (page1, stale) → null (restart page0)
    expect(calls.map((c) => c.cursor)).toEqual([null, "c1", null]);
    // last applied batch is terminal
    const last = applied[applied.length - 1];
    expect(last.op === "node.children" && last.data.hasMore).toBe(false);
  });

  it("does NOT loop forever if staleCursor recurs after the one restart", async () => {
    const queue: ChildrenResponse[] = [
      { parentId: "p", nodes: [], hasMore: false, cursor: null, staleCursor: true }, // restart
      { parentId: "p", nodes: [], hasMore: false, cursor: null, staleCursor: true }, // give up
    ];
    const f: TreeFetcher = async () => queue.shift()!;
    const applied: TreeOp[] = [];
    await expect(fetchChildren((op) => applied.push(op), f, "/repo", "p")).resolves.toBeUndefined();
    // exactly two fetches (initial + one restart), no infinite loop
    expect(applied.length).toBe(2);
  });
});
