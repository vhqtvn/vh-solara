// treeState — reactive flat-map store unit tests.
// docs/design/server-owned-tree.md §7, §8.
//
// Two layers: (1) the LOGIC (mutators delegate correctly to treeMap.ts pure fns
// and the accessors read the live map), and (2) the REACTIVITY (a Solid memo
// that reads a tracked accessor re-runs when a mutator bumps the version). The
// reactivity check uses createRoot + createMemo (no DOM) so it runs in the node
// environment.
//
// Persistence + migration (localStorage) are covered by treeExpandPersistence.test.ts
// (jsdom); this node-env file covers the in-memory mode API + reactivity.
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
  treeMap,
  modeOf,
  setNodeMode,
  setNodesMode,
  hasUserToggled,
  markUserToggled,
  clearUserToggled,
  resetExpandedForTest,
  treeModeMapSignal,
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

// REGRESSION P0-WEB-001 (SEED recency only): the deleted proj=1 client sorted
// every group by time.updated DESC in reduce.ts buildChildrenIndex; that sort
// was deleted with reduce.ts and never re-implemented in the thin client, so
// tree=2 roots and children rendered in the server's depth/hydration emit order
// (looked random). That recency order is now applied ONLY AT SEED
// (seedTreeStore rebuilds presentation rank from updatedMs-DESC); the LIVE
// re-sort on every updatedMs tick was REMOVED so an actively-streaming session
// no longer jumps position. Live ordering is driven by the stable activity-edge
// promotion policy (new insertion -> front; non-working->working -> promote
// once; reparent -> front; updatedMs-only and working->idle settle hold). The
// exhaustive crux coverage lives in the "stable activity-edge promotion
// ordering" block below. (The pure rootNodes/childrenIndex in treeMap.ts keep
// their order-preserving contract; the recency/promotion sort lives here in the
// reactive accessors.)
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

  it("an updatedMs-only upsert does NOT re-order (stable promotion policy — live recency re-sort removed)", () => {
    // Formerly this asserted a CONTINUOUS recency re-sort: upserting an existing
    // root with a newer updatedMs hoisted it to the front. The new stable
    // activity-edge promotion policy deliberately does NOT re-sort on
    // updatedMs-only changes for an existing node — only a new insertion / a
    // working edge / a reparent re-rank. Full crux coverage is in the
    // "stable activity-edge promotion ordering" block below.
    seedTreeStore([
      node({ id: "a", updatedMs: 100 }),
      node({ id: "b", updatedMs: 200 }),
    ]);
    expect(treeRoots().map((n) => n.id)).toEqual(["b", "a"]); // seed recency
    applyTreeOpStore({ op: "node.upsert", data: { node: node({ id: "a", updatedMs: 300 }) } });
    expect(treeRoots().map((n) => n.id)).toEqual(["b", "a"]); // a does NOT jump — stable
  });
});

// ---- stable activity-edge promotion ordering --------------------------------
// Replaces the former CONTINUOUS updatedMs-DESC re-sort. An actively-streaming
// session no longer jumps position on every updatedMs tick: a node is promoted
// to the front of its sibling group EXACTLY ONCE (on the non-working -> working
// edge) and then HOLDS through continued streaming and the working -> idle
// settle. New insertions enter at the front; reparents reconcile to the front of
// the new group; seed rebuilds from recency (updatedMs DESC) with NO synthetic
// activity edge. The pure core treeMap.ts is untouched — the shell accessors
// sort fresh arrays in place and never mutate the map.
describe("treeState stable activity-edge promotion ordering", () => {
  beforeEach(() => {
    resetTreeStore();
    resetExpandedForTest();
  });

  // Helper: sibling index of `id` within its group (roots or a parent's children).
  function siblingIndexRoots(id: string): number {
    return treeRoots().findIndex((n) => n.id === id);
  }

  it("new node inserts at the FRONT of its sibling group (roots)", () => {
    seedTreeStore([node({ id: "old", updatedMs: 200 }), node({ id: "newer", updatedMs: 100 })]);
    // Seed recency: old(200) before newer(100).
    expect(treeRoots().map((n) => n.id)).toEqual(["old", "newer"]);
    // Upsert a BRAND-NEW root -> enters at the front (despite the lowest updatedMs).
    applyTreeOpStore({ op: "node.upsert", data: { node: node({ id: "fresh", updatedMs: 50 }) } });
    expect(treeRoots().map((n) => n.id)).toEqual(["fresh", "old", "newer"]);
  });

  it("new child inserts at the FRONT of its parent's child group", () => {
    seedTreeStore([
      node({ id: "p", childCount: 2 }),
      node({ id: "c1", parentId: "p", updatedMs: 200 }),
      node({ id: "c2", parentId: "p", updatedMs: 100 }),
    ]);
    expect(treeChildrenOf("p").map((n) => n.id)).toEqual(["c1", "c2"]);
    applyTreeOpStore({
      op: "node.children",
      data: {
        parentId: "p",
        nodes: [node({ id: "c3", parentId: "p", updatedMs: 5 })],
        hasMore: false,
      },
    });
    expect(treeChildrenOf("p").map((n) => n.id)).toEqual(["c3", "c1", "c2"]);
  });

  it("a children batch inserts at the front PRESERVING arrival order", () => {
    seedTreeStore([
      node({ id: "p", childCount: 2 }),
      node({ id: "old", parentId: "p", updatedMs: 200 }),
    ]);
    applyTreeOpStore({
      op: "node.children",
      data: {
        parentId: "p",
        nodes: [
          node({ id: "a", parentId: "p", updatedMs: 5 }),
          node({ id: "b", parentId: "p", updatedMs: 5 }),
        ],
        hasMore: false,
      },
    });
    // Batch [a, b] enters at the front in arrival order: a most-front.
    expect(treeChildrenOf("p").map((n) => n.id)).toEqual(["a", "b", "old"]);
  });

  it("existing node promotes EXACTLY ONCE on non-working -> working", () => {
    seedTreeStore([node({ id: "a", updatedMs: 100 }), node({ id: "b", updatedMs: 200 })]);
    expect(treeRoots().map((n) => n.id)).toEqual(["b", "a"]); // recency baseline
    // a crosses idle -> busy: promoted to the front (despite the lower updatedMs).
    applyTreeOpStore({ op: "node.facet", data: { id: "a", activity: "busy" } });
    expect(treeRoots().map((n) => n.id)).toEqual(["a", "b"]);
    expect(siblingIndexRoots("a")).toBe(0);
  });

  // ── THE CRUX ──────────────────────────────────────────────────────────────
  // An existing session that became working is promoted once, then REPEATED
  // updatedMs upserts while it remains working do NOT change its sibling index,
  // and the working -> idle settle does NOT trigger a delayed jump. This is the
  // load-bearing path the whole change exists to prove.
  it("CRUX: repeated updatedMs upserts while working keep sibling index STABLE; settle does NOT jump", async () => {
    // b has the HIGHER updatedMs so the OLD continuous sort would put b front.
    seedTreeStore([node({ id: "a", updatedMs: 100 }), node({ id: "b", updatedMs: 200 })]);
    expect(treeRoots().map((n) => n.id)).toEqual(["b", "a"]);
    // Promote a -> working (front). Now a is front DESPITE a lower updatedMs.
    applyTreeOpStore({ op: "node.facet", data: { id: "a", activity: "busy" } });
    await flush();
    expect(treeRoots().map((n) => n.id)).toEqual(["a", "b"]);
    expect(siblingIndexRoots("a")).toBe(0);

    // Repeated updatedMs upserts while a STAYS working. Each value below is under
    // b's 200, so the OLD continuous sort would flip back to [b, a] every time.
    // Under the new policy a holds its front position — no jump per updatedMs tick.
    for (const ms of [120, 150, 180, 199]) {
      applyTreeOpStore({ op: "node.upsert", data: { node: busyNode({ id: "a", updatedMs: ms }) } });
      expect(treeRoots().map((n) => n.id)).toEqual(["a", "b"]);
      expect(siblingIndexRoots("a")).toBe(0);
    }
    // Settle: a -> idle. The working -> idle edge does NOT re-rank (position holds
    // — no completion-time jump). a's updatedMs is STILL LESS than b's: the loop
    // above capped at 199 < b's 200, so a is OLDER than b at settle. Under the OLD
    // continuous updatedMs-DESC sort the order would have flipped to [b, a]; under
    // the new stable policy a holds its front position. This makes the SETTLE half
    // of the crux independently discriminating against the old sort.
    applyTreeOpStore({ op: "node.facet", data: { id: "a", activity: "idle" } });
    await flush();
    expect(treeRoots().map((n) => n.id)).toEqual(["a", "b"]);
    expect(siblingIndexRoots("a")).toBe(0);
  });

  it("working -> idle settle -> NO delayed jump (index stable) — standalone", async () => {
    seedTreeStore([node({ id: "a", updatedMs: 100 }), node({ id: "b", updatedMs: 200 })]);
    applyTreeOpStore({ op: "node.facet", data: { id: "a", activity: "busy" } });
    await flush();
    expect(treeRoots().map((n) => n.id)).toEqual(["a", "b"]);
    applyTreeOpStore({ op: "node.facet", data: { id: "a", activity: "idle" } });
    await flush();
    // a stays front — no completion-time jump.
    expect(treeRoots().map((n) => n.id)).toEqual(["a", "b"]);
    expect(siblingIndexRoots("a")).toBe(0);
  });

  it("idle metadata-only updatedMs change does NOT restore continuous timestamp sort", () => {
    // Two idle roots; b is front by recency. a is idle the whole time.
    seedTreeStore([node({ id: "a", updatedMs: 100 }), node({ id: "b", updatedMs: 200 })]);
    expect(treeRoots().map((n) => n.id)).toEqual(["b", "a"]);
    // Upsert a (still idle) with a MUCH newer updatedMs + a title change — under
    // the OLD continuous sort a would jump to front ([a, b]); under the new policy
    // an idle updatedMs-only change does NOT reorder.
    applyTreeOpStore({
      op: "node.upsert",
      data: { node: node({ id: "a", updatedMs: 999, title: "renamed" }) },
    });
    expect(treeRoots().map((n) => n.id)).toEqual(["b", "a"]);
    expect(siblingIndexRoots("a")).toBe(1);
  });

  it("roots and child groups order INDEPENDENTLY", () => {
    seedTreeStore([
      node({ id: "r1", updatedMs: 10 }),
      node({ id: "r2", updatedMs: 20 }),
      node({ id: "ca", parentId: "r1", updatedMs: 100 }),
      node({ id: "cb", parentId: "r1", updatedMs: 200 }),
      node({ id: "cc", parentId: "r2", updatedMs: 300 }),
    ]);
    // Baselines: roots [r2(20), r1(10)]; r1 kids [cb(200), ca(100)]; r2 kids [cc].
    expect(treeRoots().map((n) => n.id)).toEqual(["r2", "r1"]);
    expect(treeChildrenOf("r1").map((n) => n.id)).toEqual(["cb", "ca"]);
    expect(treeChildrenOf("r2").map((n) => n.id)).toEqual(["cc"]);
    // Promote ca (within r1's group). Only r1's child group reorders; roots and
    // r2's child group are untouched.
    applyTreeOpStore({ op: "node.facet", data: { id: "ca", activity: "busy" } });
    expect(treeChildrenOf("r1").map((n) => n.id)).toEqual(["ca", "cb"]);
    expect(treeRoots().map((n) => n.id)).toEqual(["r2", "r1"]); // unchanged
    expect(treeChildrenOf("r2").map((n) => n.id)).toEqual(["cc"]); // unchanged
  });

  it("deletion removes rank state; re-introduction is treated as NEW (front)", () => {
    seedTreeStore([node({ id: "a", updatedMs: 100 }), node({ id: "b", updatedMs: 200 })]);
    applyTreeOpStore({ op: "node.facet", data: { id: "a", activity: "busy" } }); // a promoted -> front
    expect(treeRoots().map((n) => n.id)).toEqual(["a", "b"]);
    // Remove a (and its rank).
    removeTreeNode("a");
    expect(treeRoots().map((n) => n.id)).toEqual(["b"]);
    // Re-introduce a as a NEW upsert -> front (its stale rank was cleared, so it
    // is not stuck in an old position).
    applyTreeOpStore({ op: "node.upsert", data: { node: node({ id: "a", updatedMs: 100 }) } });
    expect(treeRoots().map((n) => n.id)).toEqual(["a", "b"]);
  });

  it("reparenting (node.move) reconciles to the front of the new group; unrelated groups intact", () => {
    seedTreeStore([
      node({ id: "a", updatedMs: 10 }),
      node({ id: "b", updatedMs: 20 }),
      node({ id: "c", parentId: "a", updatedMs: 5 }),
      node({ id: "d", parentId: "b", updatedMs: 500 }),
    ]);
    // Baselines: a's kids [c]; b's kids [d].
    expect(treeChildrenOf("a").map((n) => n.id)).toEqual(["c"]);
    expect(treeChildrenOf("b").map((n) => n.id)).toEqual(["d"]);
    // Move c from a -> b. c reconciles to the FRONT of b's group.
    applyTreeOpStore({ op: "node.move", data: { id: "c", newParentId: "b" } });
    expect(treeChildrenOf("a").map((n) => n.id)).toEqual([]);
    expect(treeChildrenOf("b").map((n) => n.id)).toEqual(["c", "d"]); // c front, d preserved
    // Unrelated roots intact.
    expect(treeRoots().map((n) => n.id)).toEqual(["b", "a"]);
  });

  it("snapshot seed of an already-working node -> seeded from recency (NO manufactured edge)", () => {
    // a is WORKING at seed but has the LOWER updatedMs. Under the new policy it is
    // ordered by recency (NOT promoted to front).
    seedTreeStore([busyNode({ id: "a", updatedMs: 100 }), node({ id: "b", updatedMs: 200 })]);
    expect(treeRoots().map((n) => n.id)).toEqual(["b", "a"]); // recency, not working-front
    expect(siblingIndexRoots("a")).toBe(1);
  });

  it("deterministic tie-breaking: initial-load ties keep emit order", () => {
    seedTreeStore([
      node({ id: "a", updatedMs: 500 }),
      node({ id: "b", updatedMs: 500 }),
      node({ id: "c", updatedMs: 500 }),
    ]);
    expect(treeRoots().map((n) => n.id)).toEqual(["a", "b", "c"]); // emit order, deterministically
  });

  it("deterministic tie-breaking: sequential promotions form a deterministic stack (last-promoted most-front)", async () => {
    seedTreeStore([
      node({ id: "a", updatedMs: 1 }),
      node({ id: "b", updatedMs: 1 }),
      node({ id: "c", updatedMs: 1 }),
    ]);
    // Baseline (ties): [a, b, c].
    expect(treeRoots().map((n) => n.id)).toEqual(["a", "b", "c"]);
    applyTreeOpStore({ op: "node.facet", data: { id: "a", activity: "busy" } });
    await flush();
    expect(treeRoots().map((n) => n.id)).toEqual(["a", "b", "c"]); // a promoted -> front (already front)
    applyTreeOpStore({ op: "node.facet", data: { id: "b", activity: "busy" } });
    await flush();
    expect(treeRoots().map((n) => n.id)).toEqual(["b", "a", "c"]); // b promoted -> front, a second
    applyTreeOpStore({ op: "node.facet", data: { id: "c", activity: "busy" } });
    await flush();
    expect(treeRoots().map((n) => n.id)).toEqual(["c", "b", "a"]); // c front, then b, then a
  });

  it("returned arrays are fresh each call; sorting does NOT mutate the pure map", () => {
    seedTreeStore([
      node({ id: "r1", updatedMs: 10 }),
      node({ id: "r2", updatedMs: 20 }),
      node({ id: "c1", parentId: "r1", updatedMs: 100 }),
      node({ id: "c2", parentId: "r1", updatedMs: 200 }),
    ]);
    // Fresh arrays: two calls return DIFFERENT array objects.
    const roots1 = treeRoots();
    const roots2 = treeRoots();
    expect(roots1).not.toBe(roots2);
    expect(roots1.map((n) => n.id)).toEqual(roots2.map((n) => n.id));
    const kids1 = treeChildrenOf("r1");
    const kids2 = treeChildrenOf("r1");
    expect(kids1).not.toBe(kids2);

    // The pure map's insertion order is unchanged by accessor calls. The shell
    // sorts FRESH arrays; the map itself is never reordered/mutated.
    const mapInsertionBefore = [...treeMap().values()].map((n) => n.id);
    void treeRoots();
    void treeChildrenOf("r1");
    void treeRoots();
    const mapInsertionAfter = [...treeMap().values()].map((n) => n.id);
    expect(mapInsertionAfter).toEqual(mapInsertionBefore);
    // And the map still resolves each node by id.
    expect(treeNode("r1")).toBeDefined();
    expect(treeNode("c2")?.parentId).toBe("r1");
  });
});

// ---- collapseTreeNode presentation-rank cleanup ------------------------------
// collapseTreeNode (§8.4) drops the loaded descendants from the map AND must
// reconcile their shell-owned presentation ranks: the placeholder id and any
// protected/pinned descendants stay resident (so keep their ranks), every OTHER
// dropped descendant loses its rank so a later re-introduction is treated as a
// fresh front insertion (not a stale rank). Mirrors the deletion rank-reconcile
// contract ("deletion removes rank state; re-introduction is treated as NEW
// (front)") above, but exercises the COLLAPSE path + the protected/pinned
// exemption (treeState.ts:697-708).
describe("treeState collapseTreeNode rank cleanup", () => {
  beforeEach(() => {
    resetTreeStore();
    resetExpandedForTest();
  });

  it("placeholder + protected descendants KEEP their ranks; a non-protected dropped descendant loses its rank (re-intro is NEW/front)", async () => {
    // Layout: sibling root S anchors P's own root position; P has three
    // children — D1 + D3 are PROTECTED/pinned (stay resident through collapse),
    // D2 is NOT protected (dropped by collapse). D3 (a second protected child)
    // is needed so a protected descendant's SURVIVING rank is observable: with
    // only one protected child it renders alone behind any fresh front-inserted
    // sibling, so its rank value could not be told apart from the -Infinity
    // fallback. Two protected children let their relative rank order prove the
    // ranks survived.
    //
    // P and D1 are PROMOTED via working edges before collapse so each one's
    // rank puts it AHEAD of a higher-updatedMs sibling. That rank-vs-recency
    // mismatch is what makes "rank survives" genuinely observable: if collapse
    // deleted a surviving rank, the node would fall back to updatedMs and
    // REORDER.
    seedTreeStore([
      node({ id: "S", updatedMs: 1000 }),
      node({ id: "P", updatedMs: 500, childCount: 3, loaded: true }),
      node({ id: "D3", parentId: "P", updatedMs: 300 }), // protected
      node({ id: "D2", parentId: "P", updatedMs: 200 }), // NOT protected (dropped)
      node({ id: "D1", parentId: "P", updatedMs: 100 }), // protected
    ]);
    // Seed recency baselines (updatedMs DESC): roots [S, P]; P's kids [D3, D2, D1].
    expect(treeRoots().map((n) => n.id)).toEqual(["S", "P"]);
    expect(treeChildrenOf("P").map((n) => n.id)).toEqual(["D3", "D2", "D1"]);

    // Promote P (root) and D1 (protected child) via working edges -> each jumps
    // to the FRONT of its group DESPITE a lower updatedMs.
    applyTreeOpStore({ op: "node.facet", data: { id: "P", activity: "busy" } });
    applyTreeOpStore({ op: "node.facet", data: { id: "D1", activity: "busy" } });
    await flush();
    expect(treeRoots().map((n) => n.id)).toEqual(["P", "S"]); // P over S (rank, not recency)
    expect(treeChildrenOf("P").map((n) => n.id)).toEqual(["D1", "D3", "D2"]); // D1 over D3/D2

    // Collapse P, protecting D1 + D3 (pinned descendants stay resident). D2 is
    // dropped from the map; its presentation rank must be cleaned up.
    collapseTreeNode("P", new Set(["D1", "D3"]));

    // (3) P -- the placeholder -- stays resident AND keeps its (promoted) rank,
    // so it REMAINS ahead of S despite P.updatedMs(500) < S.updatedMs(1000). If
    // collapse had deleted P's rank (the `if (rid === id) continue` branch), P
    // would fall back to updatedMs -> [S, P].
    expect(treeNode("P")).toBeDefined();
    expect(treeNode("P")?.loaded).toBe(false);
    expect(treeRoots().map((n) => n.id)).toEqual(["P", "S"]);

    // (4) D1 + D3 -- protected -- stay resident AND keep their ranks. Their
    // rank-order ([D1 promoted, D3 seed]) PERSISTS; if collapse had deleted a
    // protected rank (the `if (protectedIds?.has(rid)) continue` branch), they
    // would fall back to updatedMs -> [D3(300), D1(100)].
    expect(treeNode("D1")).toBeDefined();
    expect(treeNode("D3")).toBeDefined();
    expect(treeNode("D2")).toBeUndefined(); // dropped (not protected)
    expect(treeChildrenOf("P").map((n) => n.id)).toEqual(["D1", "D3"]);

    // (5) D2 -- not protected -- was DROPPED and its rank cleaned up, so
    // re-introducing it via a fresh upsert lands it at the FRONT of P's child
    // group (a NEW front insertion). D2's pre-collapse rank placed it BEHIND D1
    // and D3; the fresh front-insertion rank puts it AHEAD of both -> [D2, D1, D3].
    applyTreeOpStore({
      op: "node.upsert",
      data: { node: node({ id: "D2", parentId: "P", updatedMs: 200 }) },
    });
    expect(treeChildrenOf("P").map((n) => n.id)).toEqual(["D2", "D1", "D3"]);
  });
});

// ---- mode store (proj=1 4-state twisty model) -------------------------------
// Three PERSISTED modes (collapsed | filtered | expanded) with an implicit
// "filtered" default for any absent id, plus a transient userToggled overlay
// (not persisted). Persistence/migration live in treeExpandPersistence.test.ts;
// these pin the in-memory API + reactivity.
describe("treeState mode store (collapsed | filtered | expanded, default filtered)", () => {
  beforeEach(() => {
    resetTreeStore();
    resetExpandedForTest();
  });

  it("modeOf defaults to 'filtered' for an unknown/untouched id", () => {
    expect(modeOf("anything")).toBe("filtered");
    expect(modeOf("")).toBe("filtered");
  });

  it("setNodeMode round-trips all three modes in-memory", () => {
    setNodeMode("X", "expanded");
    expect(modeOf("X")).toBe("expanded");
    setNodeMode("X", "collapsed");
    expect(modeOf("X")).toBe("collapsed");
    setNodeMode("X", "filtered");
    expect(modeOf("X")).toBe("filtered");
  });

  it("setNodesMode sets many ids in one batched call; untouched ids stay default", () => {
    setNodesMode(["a", "b", "c"], "expanded");
    expect(modeOf("a")).toBe("expanded");
    expect(modeOf("b")).toBe("expanded");
    expect(modeOf("c")).toBe("expanded");
    expect(modeOf("d")).toBe("filtered"); // untouched
  });

  it("setNodeMode on one id does not change another id's mode", () => {
    setNodeMode("a", "expanded");
    setNodeMode("b", "collapsed");
    expect(modeOf("a")).toBe("expanded");
    expect(modeOf("b")).toBe("collapsed");
  });

  it("resetExpandedForTest clears modes back to the filtered default", () => {
    setNodeMode("X", "expanded");
    resetExpandedForTest();
    expect(modeOf("X")).toBe("filtered");
  });

  it("resetTreeStore clears modes (no bleed across project switch / tests)", () => {
    setNodeMode("root", "expanded");
    resetTreeStore();
    expect(modeOf("root")).toBe("filtered");
  });

  it("reactivity: a memo over modeOf recomputes when the mode changes", () => {
    const dispose = createRoot((dispose) => {
      const m = createMemo(() => modeOf("root"));
      expect(m()).toBe("filtered");
      setNodeMode("root", "expanded");
      expect(m()).toBe("expanded");
      setNodeMode("root", "collapsed");
      expect(m()).toBe("collapsed");
      return dispose;
    });
    dispose();
  });

  it("reactivity: setNodesMode is observable as one coherent transition", () => {
    const dispose = createRoot((dispose) => {
      const both = createMemo(() => `${modeOf("a")}/${modeOf("b")}`);
      expect(both()).toBe("filtered/filtered");
      setNodesMode(["a", "b"], "expanded");
      expect(both()).toBe("expanded/expanded"); // both flipped together
      return dispose;
    });
    dispose();
  });
});

// ---- userToggled (transient click overlay, NOT persisted) -------------------
// The set of ids the user clicked since the last real selection change. It
// suppresses the "temp" overlay on a clicked ancestor. Cleared synchronously in
// the canonical selection setter (actions.setSelectedId) when the id changes.
describe("treeState userToggled (transient overlay)", () => {
  beforeEach(() => {
    resetTreeStore();
    resetExpandedForTest();
  });

  it("markUserToggled adds the clicked id; hasUserToggled reflects it", () => {
    expect(hasUserToggled("X")).toBe(false);
    markUserToggled("X");
    expect(hasUserToggled("X")).toBe(true);
    expect(hasUserToggled("Y")).toBe(false); // only the clicked id
  });

  it("clearUserToggled empties the whole set", () => {
    markUserToggled("X");
    markUserToggled("Y");
    clearUserToggled();
    expect(hasUserToggled("X")).toBe(false);
    expect(hasUserToggled("Y")).toBe(false);
  });

  it("markUserToggled does NOT touch persisted modes", () => {
    setNodeMode("X", "expanded");
    markUserToggled("X");
    expect(modeOf("X")).toBe("expanded");
  });

  it("clearUserToggled does NOT touch persisted modes (modes survive the clear)", () => {
    setNodeMode("X", "expanded");
    markUserToggled("X");
    clearUserToggled();
    expect(modeOf("X")).toBe("expanded");
  });

  it("reactivity: a memo over hasUserToggled recomputes on mark/clear", () => {
    const dispose = createRoot((dispose) => {
      const m = createMemo(() => hasUserToggled("X"));
      expect(m()).toBe(false);
      markUserToggled("X");
      expect(m()).toBe(true);
      clearUserToggled();
      expect(m()).toBe(false);
      return dispose;
    });
    dispose();
  });
});

// ---- auto-mutation (working() transition → persisted mode) -------------------
// Tree-state ingestion auto-promotes/demotes a node's PERSISTED tree mode on a
// genuine working() edge, while cold-load normalization materializes "collapsed"
// for resident idle absent-mode ids. The manual 3-state click cycle is preserved
// (manual override is not a transition). Detection lives at ingestion
// (seedTreeStore + applyTreeOpStore), NOT in a per-branch render effect.
//
// The op-driven candidates flush via a microtask; `flush()` yields once so the
// queued microtask runs before the assertion.
function flush(): Promise<void> {
  return Promise.resolve();
}
// A busy node (activity busy → working true). idle node helper is the default
// `node()` above (activity idle, no rollups → working false).
function busyNode(overrides: Partial<TreeNode> = {}): TreeNode {
  return node({ activity: "busy", ...overrides });
}

describe("auto-mutation: cold-load normalization + working edges", () => {
  beforeEach(() => {
    resetTreeStore();
    resetExpandedForTest();
  });

  it("(1) newly-seeded absent-idle id is materialized as explicit 'collapsed'", () => {
    seedTreeStore([node({ id: "a" })]);
    expect(modeOf("a")).toBe("collapsed");
  });

  it("(2) newly-seeded absent-WORKING id stays implicit 'filtered' (left absent)", () => {
    seedTreeStore([busyNode({ id: "a" })]);
    expect(modeOf("a")).toBe("filtered"); // absent → filtered fallback
    expect(Object.prototype.hasOwnProperty.call(treeModeMapSignal(), "a")).toBe(false);
  });

  it("(3) explicit 'filtered'-idle is REPAIRED to 'collapsed' on cold load (absolute invariant)", () => {
    // Under the ABSOLUTE invariant, an idle node is NEVER in "filtered". A stale
    // explicit persisted "filtered"+idle entry is repaired to "collapsed" at seed
    // time (merged into the same batched setNodeModes as the absent-idle rule).
    setNodeMode("a", "filtered");
    seedTreeStore([node({ id: "a" })]);
    expect(modeOf("a")).toBe("collapsed");
    expect(treeModeMapSignal()["a"]).toBe("collapsed"); // materialized explicit
  });

  it("(4) explicit 'collapsed'+working on FIRST observation stays collapsed (not an edge)", () => {
    setNodeMode("a", "collapsed");
    seedTreeStore([busyNode({ id: "a" })]);
    // First observation is a baseline (not in old map) → no false→true edge fires.
    expect(modeOf("a")).toBe("collapsed");
  });

  it("(5) known collapsed+idle → working becomes 'filtered' (op-driven edge)", async () => {
    seedTreeStore([node({ id: "a" })]); // cold → collapsed
    expect(modeOf("a")).toBe("collapsed");
    applyTreeOpStore({ op: "node.facet", data: { id: "a", activity: "busy" } });
    await flush();
    expect(modeOf("a")).toBe("filtered");
  });

  it("(6) known filtered+working → idle becomes 'collapsed' (op-driven edge, SYNCHRONOUS)", async () => {
    setNodeMode("a", "filtered");
    seedTreeStore([busyNode({ id: "a" })]); // baseline, explicit filtered preserved (working)
    expect(modeOf("a")).toBe("filtered");
    applyTreeOpStore({ op: "node.facet", data: { id: "a", activity: "idle" } });
    // The demotion edge (true→false + filtered) now collapses SYNCHRONOUSLY at
    // ingestion via the absolute-invariant normalization — no microtask flush
    // needed. The await is harmless (no candidate was enqueued for the demotion).
    expect(modeOf("a")).toBe("collapsed");
    await flush();
    expect(modeOf("a")).toBe("collapsed"); // stays collapsed after flush (no-op)
  });

  it("(6a) IMPLICIT-filtered (absent) working → idle becomes explicit 'collapsed' (op-driven edge, SYNCHRONOUS)", async () => {
    // NO setNodeMode("a", "filtered"): a stays ABSENT, so modeOf("a") ===
    // "filtered" purely via the absent-fallback. This pins the case the op path
    // used to DROP — flush revalidation read raw treeModeMap()[a]===undefined,
    // which !== "filtered" (the expectedSourceMode) and silently dropped the
    // demote candidate, leaking the "no non-running filtered" invariant on the
    // op path while the seed path demoted correctly.
    //
    // Under the absolute invariant, the demotion is now SYNCHRONOUS at ingestion
    // (not enqueued), so it fires regardless of the queue revalidation bug.
    seedTreeStore([busyNode({ id: "a" })]); // baseline: absent+working stays absent
    expect(modeOf("a")).toBe("filtered");
    expect(Object.prototype.hasOwnProperty.call(treeModeMapSignal(), "a")).toBe(false);
    applyTreeOpStore({ op: "node.facet", data: { id: "a", activity: "idle" } });
    expect(modeOf("a")).toBe("collapsed"); // collapsed SYNCHRONOUSLY, before flush
    expect(treeModeMapSignal()["a"]).toBe("collapsed"); // materialized explicit, NOT left absent
    await flush();
    expect(modeOf("a")).toBe("collapsed"); // stays collapsed after flush
  });

  it("(6c) explicit filtered+idle is repaired SYNCHRONOUSLY on op application (absolute invariant, before flush)", () => {
    setNodeMode("a", "filtered"); // explicit filtered (valid while working)
    seedTreeStore([busyNode({ id: "a" })]); // working → filtered preserved
    expect(modeOf("a")).toBe("filtered");
    // Facet a → idle. The demotion edge collapses SYNCHRONOUSLY at ingestion —
    // no invalid filtered+idle interval, no microtask flush needed.
    applyTreeOpStore({ op: "node.facet", data: { id: "a", activity: "idle" } });
    expect(modeOf("a")).toBe("collapsed"); // collapsed BEFORE any flush
  });

  it("(6d) a stale idle+filtered entry is repaired synchronously by ANY op touching the node (no edge needed)", () => {
    // Simulate a stale v2 re-entry: manually set an invalid idle+filtered state.
    setNodeMode("a", "filtered");
    seedTreeStore([node({ id: "a" })]); // cold-load REPAIRS it to collapsed
    expect(modeOf("a")).toBe("collapsed");
    // Re-introduce the invalid state (simulating stale localStorage rehydration):
    setNodeMode("a", "filtered");
    expect(modeOf("a")).toBe("filtered"); // invalid idle+filtered
    // A title-only facet (no working change, no edge) still triggers the sync
    // absolute-invariant normalization on the affected node:
    applyTreeOpStore({ op: "node.facet", data: { id: "a", title: "x" } });
    expect(modeOf("a")).toBe("collapsed"); // repaired synchronously
  });

  it("(6b) IMPLICIT-filtered (absent) working → idle becomes explicit 'collapsed' (snapshot seed path)", async () => {
    // Symmetric pin on seedTreeStore (which already demotes correctly) to lock
    // cross-path consistency: a working→idle edge on a KNOWN absent-mode node
    // demotes implicit-filtered → explicit collapsed via the SYNCHRONOUS seed
    // path (no microtask flush). Pinned so a future change to either path keeps
    // the two ingestion paths symmetric for the implicit case.
    seedTreeStore([busyNode({ id: "a" })]); // absent+working baseline
    expect(Object.prototype.hasOwnProperty.call(treeModeMapSignal(), "a")).toBe(false);
    seedTreeStore([node({ id: "a" })]); // re-seed: same node now idle (known → edge)
    expect(modeOf("a")).toBe("collapsed");
    expect(treeModeMapSignal()["a"]).toBe("collapsed"); // materialized explicit
  });

  it("(7) expanded nodes are NEVER auto-mutated (both working transitions)", async () => {
    setNodeMode("a", "expanded");
    seedTreeStore([node({ id: "a" })]); // idle, explicit expanded
    applyTreeOpStore({ op: "node.facet", data: { id: "a", activity: "busy" } });
    await flush();
    expect(modeOf("a")).toBe("expanded");
    applyTreeOpStore({ op: "node.facet", data: { id: "a", activity: "idle" } });
    await flush();
    expect(modeOf("a")).toBe("expanded");
  });

  it("(8) no cascade to descendants/ancestors: only the faceted node transitions", async () => {
    seedTreeStore([node({ id: "p", childCount: 1 }), node({ id: "c", parentId: "p" })]);
    // Both cold-normalized to collapsed.
    expect(modeOf("p")).toBe("collapsed");
    expect(modeOf("c")).toBe("collapsed");
    // Facet ONLY c → busy. p's own working() is unchanged (no rollup change).
    applyTreeOpStore({ op: "node.facet", data: { id: "c", activity: "busy" } });
    await flush();
    expect(modeOf("c")).toBe("filtered"); // c transitioned
    expect(modeOf("p")).toBe("collapsed"); // p untouched — no ancestor cascade
  });

  it("(9) an ancestor whose OWN rollup changes gets its own independent transition", async () => {
    seedTreeStore([node({ id: "p", childCount: 1 }), node({ id: "c", parentId: "p" })]);
    expect(modeOf("p")).toBe("collapsed");
    // Flip p's OWN subtreeBusy rollup (a facet on p, not on c). working(p) goes
    // false→true via its own flags → independent edge on p. c is unaffected.
    applyTreeOpStore({
      op: "node.facet",
      data: { id: "p", flags: { subtreeBusy: true } },
    });
    await flush();
    expect(modeOf("p")).toBe("filtered"); // p promoted by its own rollup edge
    expect(modeOf("c")).toBe("collapsed"); // c's own working() did not change
  });

  it("(10) removed+reintroduced id is a NEW baseline (no edge fires)", () => {
    seedTreeStore([node({ id: "a" })]); // cold → collapsed
    expect(modeOf("a")).toBe("collapsed");
    removeTreeNode("a"); // dropped from map; persisted 'collapsed' entry survives
    // Re-seed a as WORKING. It is not in oldMap → baseline. Even though it is now
    // working, no false→true edge fires (reintroduction ≠ transition), so it is
    // NOT auto-promoted to filtered.
    seedTreeStore([busyNode({ id: "a" })]);
    expect(modeOf("a")).toBe("collapsed");
  });

  it("(11) reset/project-switch invalidates queued candidates (no post-reset write)", async () => {
    seedTreeStore([node({ id: "a" })]); // cold → collapsed
    applyTreeOpStore({ op: "node.facet", data: { id: "a", activity: "busy" } });
    // A candidate (a: collapsed→filtered) is now queued. Reset before flush.
    resetTreeStore(); // bumps generation + clears candidates + empties mode map
    await flush(); // the scheduled microtask runs but the queue is empty/stale
    expect(treeModeMapSignal()).toEqual({}); // candidate did NOT re-add "a"
  });

  it("(12) a no-op batch produces NO mode-signal notify (no persistence write)", () => {
    // Seed once: a is cold-normalized to collapsed.
    seedTreeStore([node({ id: "a" })]);
    let runs = 0;
    const dispose = createRoot((dispose) => {
      const memo = createMemo(() => {
        runs++;
        return treeModeMapSignal();
      });
      void memo();
      const runsAfterFirst = runs;
      // Re-seed the SAME idle node: it is known (in oldMap), idle→idle (no edge),
      // and already explicit collapsed → no cold-norm change. changes is empty →
      // setNodeModes early-returns without notifying the mode signal.
      seedTreeStore([node({ id: "a" })]);
      expect(runs).toBe(runsAfterFirst); // memo did NOT recompute
      expect(modeOf("a")).toBe("collapsed");
      return dispose;
    });
    dispose();
  });
});
