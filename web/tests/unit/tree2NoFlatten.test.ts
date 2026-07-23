// @vitest-environment jsdom
// tree2NoFlatten.test.ts — Phase 3 Step B (PART 2): confirm tree=2 is immune to
// the §11 localStorage flatten-on-load bug ahead of the default-flip.
//
// Design §11: "Tree structure is NEVER persisted to localStorage." The
// flatten-on-load bug (#2) came from restoring a PARTIAL persisted tree
// (branchStubs/expandedBranches) on reload. In tree=2 the flat map
// (treeState.ts `map`) is module-level `new Map()` — starts EMPTY every page
// load, seeded ONLY by `seedTreeStore` from the server's tree.snapshot, and
// NEVER read from localStorage. TreeStateView renders from `treeRoots()`
// (treeMap), NOT from `state.sessions` (which IS persisted but is detail-only
// in tree=2).
//
// This test LOCKS that immunity: even with a stale persisted sessions entry in
// localStorage (the key loadSessions reads), a fresh module load does NOT
// restore a tree structure — treeRoots() stays empty until the server snapshot
// seeds it. A reload re-fetches the frontier fresh; it cannot flatten-on-load.
import { describe, expect, it, beforeEach } from "vitest";
import {
  resetTreeStore,
  seedTreeStore,
  treeRoots,
  treeNode,
} from "../../src/sync/treeState";
import { lsSessions } from "../../src/sync/store";
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

describe("tree=2 §11 immunity: tree structure is never restored from localStorage", () => {
  beforeEach(() => {
    localStorage.clear();
    resetTreeStore();
  });

  it("a stale persisted sessions entry does NOT populate the tree flat map", () => {
    // Simulate a prior proj=1 session that persisted sessions to localStorage
    // (the exact key loadSessions reads). In the old path this stale set could
    // drive a flatten-on-load. In tree=2 this entry is DETAIL-only and the
    // tree flat map ignores it entirely.
    const staleKey = lsSessions(""); // default project dir
    localStorage.setItem(
      staleKey,
      JSON.stringify({
        v: 1,
        data: {
          staleRoot: { id: "staleRoot", title: "stale", model: "x" },
          staleChild: { id: "staleChild", title: "stale child", model: "x" },
        },
      }),
    );

    // Fresh module load: treeMap is module-level empty — NOT restored from the
    // stale localStorage entry. This is the §11 immunity.
    resetTreeStore();
    expect(treeRoots()).toEqual([]);
    expect(treeNode("staleRoot")).toBeUndefined();
    expect(treeNode("staleChild")).toBeUndefined();
  });

  it("a reload re-fetches the frontier fresh from the server snapshot", () => {
    // Stale persisted sessions present (would have flattened the old path).
    localStorage.setItem(
      lsSessions(""),
      JSON.stringify({
        v: 1,
        data: { staleRoot: { id: "staleRoot", title: "stale", model: "x" } },
      }),
    );

    // Fresh load: empty (no stale restore).
    resetTreeStore();
    expect(treeRoots()).toEqual([]);

    // Server tree.snapshot arrives → seedTreeStore populates from the SERVER,
    // not from localStorage. The stale entry is irrelevant.
    seedTreeStore([
      node({ id: "freshRoot" }),
      node({ id: "freshChild", parentId: "freshRoot" }),
    ]);
    expect(treeRoots().map((n) => n.id)).toEqual(["freshRoot"]);
    expect(treeNode("freshChild")).toBeDefined();
    expect(treeNode("staleRoot")).toBeUndefined();
  });

  it("resetTreeStore clears the map without touching localStorage", () => {
    seedTreeStore([node({ id: "a" })]);
    expect(treeRoots().map((n) => n.id)).toEqual(["a"]);

    // A reset (project switch / epoch change) drops the tree but leaves the
    // persisted sessions entry intact (it is orthogonal detail state).
    localStorage.setItem(
      lsSessions(""),
      JSON.stringify({ v: 1, data: { a: { id: "a", title: "a", model: "x" } } }),
    );
    resetTreeStore();
    expect(treeRoots()).toEqual([]);
    // localStorage sessions entry survives the tree reset (detail ≠ structure).
    expect(localStorage.getItem(lsSessions(""))).toBeTruthy();
  });
});
