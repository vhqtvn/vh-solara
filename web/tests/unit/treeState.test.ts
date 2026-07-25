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

  it("(3) explicit 'filtered'-idle survives cold load (explicit preserved)", () => {
    setNodeMode("a", "filtered");
    seedTreeStore([node({ id: "a" })]);
    expect(modeOf("a")).toBe("filtered");
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

  it("(6) known filtered+working → idle becomes 'collapsed' (op-driven edge)", async () => {
    setNodeMode("a", "filtered");
    seedTreeStore([busyNode({ id: "a" })]); // baseline, explicit filtered preserved
    expect(modeOf("a")).toBe("filtered");
    applyTreeOpStore({ op: "node.facet", data: { id: "a", activity: "idle" } });
    await flush();
    expect(modeOf("a")).toBe("collapsed");
  });

  it("(6a) IMPLICIT-filtered (absent) working → idle becomes explicit 'collapsed' (op-driven edge)", async () => {
    // NO setNodeMode("a", "filtered"): a stays ABSENT, so modeOf("a") ===
    // "filtered" purely via the absent-fallback. This pins the case the op path
    // used to DROP — flush revalidation read raw treeModeMap()[a]===undefined,
    // which !== "filtered" (the expectedSourceMode) and silently dropped the
    // demote candidate, leaking the "no non-running filtered" invariant on the
    // op path while the seed path demoted correctly.
    seedTreeStore([busyNode({ id: "a" })]); // baseline: absent+working stays absent
    expect(modeOf("a")).toBe("filtered");
    expect(Object.prototype.hasOwnProperty.call(treeModeMapSignal(), "a")).toBe(false);
    applyTreeOpStore({ op: "node.facet", data: { id: "a", activity: "idle" } });
    await flush();
    expect(modeOf("a")).toBe("collapsed");
    expect(treeModeMapSignal()["a"]).toBe("collapsed"); // materialized explicit, NOT left absent
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
