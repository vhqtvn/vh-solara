// treeSelectors — pure pinned/search selectors over the tree=2 flat map.
//
// These are the anti-regression tests for the Phase 3 parity flip: the deleted
// proj=1 client only pinned ROOTS (the bug). tree=2 hoists a pinned node into
// the pinned group REGARDLESS of depth or collapse state, because every node
// in the flat map carries its own display data. And search is a flatten-to-
// matches pass over the whole flat map, so a deep descendant match is always
// surfaced (the old roots-only walk never reached it).
//
// Pure: no Solid, no store. The selectors take a TreeFlatMap directly.
import { describe, expect, it } from "vitest";
import { seedTree } from "../../src/sync/treeMap";
import type { TreeNode, TreeFlatMap } from "../../src/sync/treeMap";
import { selectPinnedNodes, selectSearchResults } from "../../src/sync/treeSelectors";

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

// A deep collapsed node + a root + a mid node. The flat map:
//   R (root)
//   └─ A (depth 1)
//      └─ B (depth 2)
//         └─ C (depth 3, loaded:false = COLLAPSED placeholder, descendantCount 5)
// `C` is the crux node: it is neither a root nor loaded. The OLD proj=1 client
// never surfaced it when pinned (roots-only `byId`). tree=2 must.
function deepMap(): TreeFlatMap {
  return seedTree([
    node({ id: "R", title: "Root", updatedMs: 10 }),
    node({ id: "A", parentId: "R", title: "A-child", updatedMs: 20 }),
    node({ id: "B", parentId: "A", title: "B-grand", agent: "builder", updatedMs: 30 }),
    node({
      id: "C",
      parentId: "B",
      title: "C-deep-collapsed",
      agent: "planner",
      // Collapsed placeholder: descendants not loaded, but the node is real and
      // carries its own title/agent/badge.
      loaded: false,
      childCount: 1,
      descendantCount: 5,
      updatedMs: 40,
    }),
  ]);
}

describe("selectPinnedNodes (flat-map, depth-agnostic)", () => {
  it("returns [] for an empty pinned order", () => {
    expect(selectPinnedNodes(deepMap(), [])).toEqual([]);
  });

  it("surfaces a pinned ROOT", () => {
    const out = selectPinnedNodes(deepMap(), ["R"]).map((n) => n.id);
    expect(out).toEqual(["R"]);
  });

  // CRUX anti-regression: the deleted proj=1 client built the pinned group from
  // roots() only, so a pinned DEEP node vanished. tree=2 reads the flat map,
  // so a pinned collapsed node at depth 3 is hoisted into the pinned group with
  // its own chip + badge intact.
  it("surfaces a pinned DEEP COLLAPSED node (the old roots-only bug)", () => {
    const map = deepMap();
    // Sanity: C is real but NOT a root and NOT loaded.
    expect([...map.values()].find((n) => n.parentId === null && n.id === "C")).toBeUndefined();
    expect(map.get("C")?.loaded).toBe(false);

    const out = selectPinnedNodes(map, ["C"]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("C");
    // The hoisted node keeps its self-contained display data.
    expect(out[0].title).toBe("C-deep-collapsed");
    expect(out[0].agent).toBe("planner");
    expect(out[0].descendantCount).toBe(5);
  });

  it("preserves the pinned order verbatim and drops stale (missing) ids", () => {
    const out = selectPinnedNodes(deepMap(), ["C", "missing", "R", "A"]).map((n) => n.id);
    expect(out).toEqual(["C", "R", "A"]);
  });
});

describe("selectSearchResults (flatten-to-matches)", () => {
  it("returns null for an empty/blank query (no filter active)", () => {
    expect(selectSearchResults(deepMap(), "", () => false)).toBeNull();
    expect(selectSearchResults(deepMap(), "   ", () => false)).toBeNull();
  });

  // CRUX: a match deep in a collapsed subtree MUST be surfaced. The old roots-
  // only walk never reached C; the flat-map search finds it directly.
  it("surfaces a DEEP COLLAPSED descendant match by title", () => {
    const out = selectSearchResults(deepMap(), "c-deep", () => false);
    expect(out).not.toBeNull();
    expect(out!.map((n) => n.id)).toContain("C");
  });

  it("matches on id substring (case-insensitive)", () => {
    const out = selectSearchResults(deepMap(), "B", () => false);
    expect(out!.map((n) => n.id)).toEqual(["B"]);
  });

  it("matches on agent substring (case-insensitive) — superset of old title||id", () => {
    const out = selectSearchResults(deepMap(), "planner", () => false);
    expect(out!.map((n) => n.id)).toEqual(["C"]);
  });

  it("pinned-first ordering: a pinned older node precedes a newer unpinned one", () => {
    // Pin B (updatedMs 30). Query 'er' matches both B's agent 'builder' and C's
    // agent 'planner'. C is newer (40) so recency would put it first; pin-first
    // must hoist B to the front.
    const out = selectSearchResults(deepMap(), "er", (id) => id === "B");
    expect(out!.map((n) => n.id)).toEqual(["B", "C"]);
  });

  it("recency tiebreak among unpinned matches (updatedMs desc)", () => {
    // Nothing pinned; 'er' matches B (builder, 30) and C (planner, 40). C is
    // newer → C first, then B.
    const out = selectSearchResults(deepMap(), "er", () => false);
    expect(out!.map((n) => n.id)).toEqual(["C", "B"]);
  });

  it("returns [] when nothing matches (caller renders the empty state)", () => {
    const out = selectSearchResults(deepMap(), "zzzznotfound", () => false);
    expect(out).toEqual([]);
  });
});
