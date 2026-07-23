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
