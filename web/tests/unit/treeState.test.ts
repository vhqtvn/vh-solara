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
  isNodeExpanded,
  setUserNodeExpanded,
  resetExpandedForTest,
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

// isNodeExpanded — the reactive render-gate accessor (flood fix). A node renders
// its resident children iff it is on the ACTIVE PATH (busy/pendingInput
// descendant) OR explicitly user-expanded. Children STAY in the flat map either
// way (instant expand, no round-trip); this only gates RENDER. node env (no
// localStorage) — persistence is covered by the jsdom render-gate test.
describe("treeState isNodeExpanded — reactive active-path ∪ userExpanded (flood fix)", () => {
  beforeEach(() => {
    resetTreeStore();
    resetExpandedForTest();
  });

  it("default: a freshly-seeded idle tree is fully collapsed (no node expanded)", () => {
    seedTreeStore([
      node({ id: "root", childCount: 2, descendantCount: 2 }),
      node({ id: "c1", parentId: "root" }),
      node({ id: "c2", parentId: "root" }),
    ]);
    expect(isNodeExpanded("root")).toBe(false);
    expect(isNodeExpanded("c1")).toBe(false);
  });

  it("a node on the active path (busy descendant) IS expanded; idle siblings are NOT", () => {
    seedTreeStore([
      node({ id: "R", childCount: 3, descendantCount: 3 }),
      node({ id: "A", parentId: "R" }),
      node({ id: "BUSY", parentId: "A", activity: "busy" }),
      node({ id: "SIB", parentId: "R" }),
    ]);
    expect(isNodeExpanded("R")).toBe(true); // ancestor of BUSY
    expect(isNodeExpanded("A")).toBe(true); // ancestor of BUSY
    expect(isNodeExpanded("BUSY")).toBe(true); // active itself (it has no children but the gate is inclusive)
    expect(isNodeExpanded("SIB")).toBe(false); // idle sibling, not on the chain
  });

  it("a pendingInput descendant puts its ancestor chain on the active path", () => {
    seedTreeStore([
      node({ id: "R" }),
      node({ id: "X", parentId: "R" }),
      node({ id: "PIN", parentId: "X", flags: { ...node().flags, pendingInput: true } }),
    ]);
    expect(isNodeExpanded("R")).toBe(true);
    expect(isNodeExpanded("X")).toBe(true);
  });

  it("setUserNodeExpanded(true) opens an idle node; (false) closes it again", () => {
    seedTreeStore([
      node({ id: "root", childCount: 2, descendantCount: 2 }),
      node({ id: "c1", parentId: "root" }),
      node({ id: "c2", parentId: "root" }),
    ]);
    expect(isNodeExpanded("root")).toBe(false);
    setUserNodeExpanded("root", true);
    expect(isNodeExpanded("root")).toBe(true);
    setUserNodeExpanded("root", false);
    expect(isNodeExpanded("root")).toBe(false);
  });

  // CRUX (render gate, not map drop): collapsing an idle node via
  // setUserNodeExpanded(false) must NOT drop its children from the flat map.
  // (The OLD fetch-collapse did; the new UI toggle must not.) The children stay
  // resident so a re-expand is instant.
  it("user-collapse keeps resident children in the flat map (render gate, not map drop)", () => {
    seedTreeStore([
      node({ id: "root", childCount: 1, loaded: true }),
      node({ id: "child", parentId: "root" }),
    ]);
    setUserNodeExpanded("root", true);
    expect(isNodeExpanded("root")).toBe(true);
    expect(treeChildrenOf("root").map((n) => n.id)).toEqual(["child"]);

    setUserNodeExpanded("root", false);
    expect(isNodeExpanded("root")).toBe(false); // render-collapsed
    // But the child is STILL resident — the map was not touched.
    expect(treeNode("child")).toBeDefined();
    expect(treeChildrenOf("root").map((n) => n.id)).toEqual(["child"]);
  });

  // A node on the active path stays expanded even if the user "collapses" it:
  // collapsing an active-path node is a benign no-op render-wise (live work
  // stays visible). setUserNodeExpanded(false) removes the user toggle, but the
  // active-path union keeps it open.
  it("collapsing an active-path node is a benign no-op (stays expanded)", () => {
    seedTreeStore([
      node({ id: "R" }),
      node({ id: "BUSY", parentId: "R", activity: "busy" }),
    ]);
    expect(isNodeExpanded("R")).toBe(true); // active path
    setUserNodeExpanded("R", false); // user tries to collapse
    expect(isNodeExpanded("R")).toBe(true); // still expanded (active path wins)
  });

  it("reactivity: a memo over isNodeExpanded recomputes when the user toggles", () => {
    const dispose = createRoot((dispose) => {
      seedTreeStore([node({ id: "root", childCount: 1 }), node({ id: "c", parentId: "root" })]);
      const open = createMemo(() => isNodeExpanded("root"));
      expect(open()).toBe(false);
      setUserNodeExpanded("root", true);
      expect(open()).toBe(true);
      setUserNodeExpanded("root", false);
      expect(open()).toBe(false);
      return dispose;
    });
    dispose();
  });

  it("reactivity: a memo recomputes when a facet flips a descendant busy (active path appears)", () => {
    const dispose = createRoot((dispose) => {
      seedTreeStore([
        node({ id: "R", childCount: 1 }),
        node({ id: "C", parentId: "R", activity: "idle" }),
      ]);
      const open = createMemo(() => isNodeExpanded("R"));
      expect(open()).toBe(false); // idle
      applyTreeOpStore({ op: "node.facet", data: { id: "C", activity: "busy" } });
      expect(open()).toBe(true); // C now busy → R on active path
      return dispose;
    });
    dispose();
  });

  // CONFORMANCE (reviewer advisory tier1_a-F1/tier1_c-F2): resetTreeStore (project
  // switch / epoch change / test reset) MUST clear the in-memory userExpanded
  // toggle and invalidate the activePath memo, so a project switch does not carry
  // stale expand toggles and tests do not bleed. Before the fix, resetTreeStore
  // only wiped the map and left userExpanded intact, so a re-seed of the SAME
  // idle tree would still render the stale user toggle as expanded.
  it("resetTreeStore clears user expand state (no bleed across project switch / tests)", () => {
    // A non-active (idle) tree: only a USER toggle would expand root.
    seedTreeStore([
      node({ id: "root", childCount: 1 }),
      node({ id: "c", parentId: "root" }),
    ]);
    setUserNodeExpanded("root", true);
    expect(isNodeExpanded("root")).toBe(true); // user-expanded

    resetTreeStore(); // project switch / epoch change

    // resetTreeStore wipes the map, so re-seed the SAME minimal non-active tree
    // to probe the expand signal in isolation. The user toggle must NOT survive
    // the reset — root is idle (no active path) and the user toggle is gone, so
    // isNodeExpanded("root") is false again (the fresh-load collapsed default).
    seedTreeStore([
      node({ id: "root", childCount: 1 }),
      node({ id: "c", parentId: "root" }),
    ]);
    expect(isNodeExpanded("root")).toBe(false);
  });
});
