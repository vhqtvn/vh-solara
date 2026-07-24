// treeState — reactive flat-map store unit tests.
// docs/design/server-owned-tree.md §7, §8.
//
// Two layers: (1) the LOGIC (mutators delegate correctly to treeMap.ts pure fns
// and the accessors read the live map), and (2) the REACTIVITY (a Solid memo
// that reads a tracked accessor re-runs when a mutator bumps the version). The
// reactivity check uses createRoot + createMemo (no DOM) so it runs in the node
// environment.
import { describe, expect, it, beforeEach } from "vitest";
import { createMemo, createRoot } from "solid-js";
import {
  applyTreeOpStore,
  collapseTreeNode,
  removeTreeNode,
  resetTreeStore,
  seedTreeStore,
  treeChildrenOf,
  treeNode,
  treeRoots,
} from "../../src/sync/treeState";
import type { TreeNode } from "../../src/sync/treeMap";

beforeEach(() => {
  resetTreeStore();
});

function node(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: "n",
    parentId: null,
    title: "N",
    activity: "idle",
    childCount: 0,
    loaded: true,
    flags: {
      pendingInput: false,
      subtreeNeedsInput: false,
      permission: false,
      archived: false,
      orphan: false,
    },
    updatedMs: 1,
    ...overrides,
  };
}

describe("treeState accessors + seed", () => {
  it("starts empty", () => {
    expect(treeRoots()).toEqual([]);
    expect(treeNode("missing")).toBeUndefined();
  });

  it("seed replaces the whole map", () => {
    seedTreeStore([node({ id: "a" }), node({ id: "b", parentId: "a" })]);
    expect(treeNode("a")).toBeDefined();
    expect(treeNode("b")).toBeDefined();
    expect(treeRoots().map((n) => n.id)).toEqual(["a"]);
    expect(treeChildrenOf("a").map((n) => n.id)).toEqual(["b"]);
  });

  it("reset clears the map", () => {
    seedTreeStore([node({ id: "a" })]);
    resetTreeStore();
    expect(treeRoots()).toEqual([]);
    expect(treeNode("a")).toBeUndefined();
  });
});

describe("treeState applyTreeOpStore (delegates to treeMap §7.2)", () => {
  it("upsert adds/fully-replaces a node", () => {
    seedTreeStore([node({ id: "a", title: "old" })]);
    applyTreeOpStore({ op: "node.upsert", data: { node: node({ id: "a", title: "new" }) } });
    expect(treeNode("a")?.title).toBe("new");
  });

  it("remove drops a node + its loaded descendants (eager archive path)", () => {
    seedTreeStore([
      node({ id: "root" }),
      node({ id: "child", parentId: "root" }),
      node({ id: "grand", parentId: "child" }),
      node({ id: "other" }),
    ]);
    removeTreeNode("root");
    expect(treeNode("root")).toBeUndefined();
    expect(treeNode("child")).toBeUndefined();
    expect(treeNode("grand")).toBeUndefined();
    expect(treeNode("other")).toBeDefined();
  });

  it("move reparents a node", () => {
    seedTreeStore([node({ id: "a" }), node({ id: "b" }), node({ id: "c", parentId: "a" })]);
    applyTreeOpStore({ op: "node.move", data: { id: "c", newParentId: "b" } });
    expect(treeNode("c")?.parentId).toBe("b");
    expect(treeChildrenOf("a")).toEqual([]);
    expect(treeChildrenOf("b").map((n) => n.id)).toEqual(["c"]);
  });

  it("children merges a batch + flips parent loaded on terminal page", () => {
    seedTreeStore([node({ id: "p", childCount: 2, loaded: false })]);
    applyTreeOpStore({
      op: "node.children",
      data: {
        parentId: "p",
        nodes: [node({ id: "c1", parentId: "p" }), node({ id: "c2", parentId: "p" })],
        hasMore: false,
      },
    });
    expect(treeChildrenOf("p").map((n) => n.id)).toEqual(["c1", "c2"]);
    expect(treeNode("p")?.loaded).toBe(true);
  });

  it("facet partial-merges present fields (verb null clears)", () => {
    seedTreeStore([node({ id: "a", verb: { tool: "x" } })]);
    applyTreeOpStore({ op: "node.facet", data: { id: "a", verb: null } });
    expect(treeNode("a")?.verb).toBeNull();
  });
});

describe("treeState collapseTreeNode (§8.4 client-only)", () => {
  it("drops loaded descendants, keeps the placeholder, flips loaded:false", () => {
    seedTreeStore([
      node({ id: "p", childCount: 1, loaded: true }),
      node({ id: "c", parentId: "p" }),
      node({ id: "g", parentId: "c" }),
    ]);
    collapseTreeNode("p");
    expect(treeNode("p")).toBeDefined();
    expect(treeNode("p")?.loaded).toBe(false);
    expect(treeNode("c")).toBeUndefined();
    expect(treeNode("g")).toBeUndefined();
  });
});

describe("treeState reactivity (Solid tracking)", () => {
  // A memo reading a tracked accessor must re-run when any mutator bumps the
  // version signal. This is the contract SessionTree/selectors rely on.
  it("a memo over treeRoots recomputes after seedTreeStore", () => {
    const dispose = createRoot((dispose) => {
      const roots = createMemo(() => treeRoots().map((n) => n.id));
      expect(roots()).toEqual([]);
      seedTreeStore([node({ id: "r1" }), node({ id: "r2" })]);
      expect(roots()).toEqual(["r1", "r2"]);
      return dispose;
    });
    dispose();
  });

  it("a memo over treeNode(id) recomputes after an upsert changes it", () => {
    const dispose = createRoot((dispose) => {
      seedTreeStore([node({ id: "a", title: "v1" })]);
      const title = createMemo(() => treeNode("a")?.title);
      expect(title()).toBe("v1");
      applyTreeOpStore({ op: "node.upsert", data: { node: node({ id: "a", title: "v2" }) } });
      expect(title()).toBe("v2");
      return dispose;
    });
    dispose();
  });

  it("a memo recomputes after removeTreeNode", () => {
    const dispose = createRoot((dispose) => {
      seedTreeStore([node({ id: "a" })]);
      const present = createMemo(() => treeNode("a") !== undefined);
      expect(present()).toBe(true);
      removeTreeNode("a");
      expect(present()).toBe(false);
      return dispose;
    });
    dispose();
  });

  it("a memo recomputes after resetTreeStore", () => {
    const dispose = createRoot((dispose) => {
      seedTreeStore([node({ id: "a" })]);
      const count = createMemo(() => treeRoots().length);
      expect(count()).toBe(1);
      resetTreeStore();
      expect(count()).toBe(0);
      return dispose;
    });
    dispose();
  });
});

// REGRESSION P0-WEB-001: the deleted proj=1 client sorted every group by
// time.updated DESC in reduce.ts buildChildrenIndex; that sort was deleted with
// reduce.ts and never re-implemented in the thin client, so tree=2 roots and
// children rendered in the server's depth/hydration emit order (looked random).
// treeRoots()/treeChildrenOf() MUST return newest-updatedMs first. updatedMs is
// on every TreeNode (treeMap.ts:40), so this is a pure client-side sort with no
// server change. (The pure rootNodes/childrenIndex in treeMap.ts keep their
// order-preserving contract; the sort lives here in the reactive accessors.)
describe("treeState recency ordering (newest updatedMs first) — P0-WEB-001", () => {
  it("treeRoots() returns root nodes newest-updatedMs first", () => {
    // Seed in a DELIBERATELY NON-recency order so the test fails for the right
    // reason (server emit/insertion order) if the sort is absent.
    seedTreeStore([
      node({ id: "oldest", updatedMs: 100 }),
      node({ id: "newest", updatedMs: 300 }),
      node({ id: "middle", updatedMs: 200 }),
    ]);
    expect(treeRoots().map((n) => n.id)).toEqual(["newest", "middle", "oldest"]);
  });

  it("treeChildrenOf(parentId) returns that group's children newest-updatedMs first", () => {
    seedTreeStore([
      node({ id: "root", updatedMs: 1000 }),
      node({ id: "c1", parentId: "root", updatedMs: 100 }),
      node({ id: "c2", parentId: "root", updatedMs: 300 }),
      node({ id: "c3", parentId: "root", updatedMs: 200 }),
      // An unrelated root to confirm parent grouping is unaffected.
      node({ id: "other", updatedMs: 5 }),
    ]);
    expect(treeChildrenOf("root").map((n) => n.id)).toEqual(["c2", "c3", "c1"]);
  });

  it("does not assert a specific order between nodes sharing an updatedMs (tie-stable)", () => {
    // Ties must not crash and must keep every node present exactly once. The
    // contract is: do not assert order between ties, just presence + dedup.
    seedTreeStore([
      node({ id: "a", updatedMs: 500 }),
      node({ id: "b", updatedMs: 500 }),
      node({ id: "c", updatedMs: 500 }),
    ]);
    const ids = treeRoots().map((n) => n.id);
    expect(ids).toContain("a");
    expect(ids).toContain("b");
    expect(ids).toContain("c");
    expect(new Set(ids).size).toBe(3);
  });

  it("recency re-orders live after an upsert bumps a node to newest", () => {
    // The sort must reflect the live map (version-tracked), not a stale
    // snapshot: upserting an existing root with a newer updatedMs hoists it.
    seedTreeStore([
      node({ id: "a", updatedMs: 100 }),
      node({ id: "b", updatedMs: 200 }),
    ]);
    expect(treeRoots().map((n) => n.id)).toEqual(["b", "a"]);
    applyTreeOpStore({ op: "node.upsert", data: { node: node({ id: "a", updatedMs: 300 }) } });
    expect(treeRoots().map((n) => n.id)).toEqual(["a", "b"]);
  });
});
