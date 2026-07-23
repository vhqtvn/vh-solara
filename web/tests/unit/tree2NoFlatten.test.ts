// @vitest-environment jsdom
// tree2NoFlatten.test.ts — §11 immunity: tree structure is NEVER persisted to
// localStorage. The flatten-on-load bug (#2) came from restoring a PARTIAL
// persisted tree on reload. Phase 3 Step C removed the old session-tree
// persistence (loadSessions/lsSessions) entirely — the flat map
// (treeState.ts `map`) is module-level `new Map()`, starts EMPTY every page
// load, seeded ONLY by `seedTreeStore` from the server's tree.snapshot, and
// NEVER read from or written to localStorage.
import { describe, expect, it, beforeEach } from "vitest";
import {
  resetTreeStore,
  seedTreeStore,
  treeRoots,
  treeNode,
} from "../../src/sync/treeState";
import type { TreeNode } from "../../src/sync/treeMap";

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

describe("tree=2 §11 immunity: tree structure is never persisted to localStorage", () => {
  beforeEach(() => {
    localStorage.clear();
    resetTreeStore();
  });

  it("the flat map starts EMPTY on a fresh module load (no localStorage restore)", () => {
    // Stash an arbitrary value in localStorage under any key — the tree flat
    // map must ignore it. There is no session-tree persistence key at all.
    localStorage.setItem("vh.sessions", JSON.stringify({ staleRoot: {} }));
    resetTreeStore();
    expect(treeRoots()).toEqual([]);
    expect(treeNode("staleRoot")).toBeUndefined();
  });

  it("a reload re-fetches the frontier fresh from the server snapshot", () => {
    resetTreeStore();
    expect(treeRoots()).toEqual([]);

    seedTreeStore([
      node({ id: "freshRoot" }),
      node({ id: "freshChild", parentId: "freshRoot" }),
    ]);
    expect(treeRoots().map((n) => n.id)).toEqual(["freshRoot"]);
    expect(treeNode("freshChild")).toBeDefined();
  });

  it("resetTreeStore clears the map", () => {
    seedTreeStore([node({ id: "a" })]);
    expect(treeRoots().map((n) => n.id)).toEqual(["a"]);

    resetTreeStore();
    expect(treeRoots()).toEqual([]);
  });
});
