// treeSelectors — pure pinned/search/mode selectors over the tree=2 flat map.
//
// These are the anti-regression tests for the Phase 3 parity flip (pinned
// deep-node hoist + flat search) PLUS the proj=1 4-state twisty model helpers
// (working / strictAncestors / effectiveTreeMode / hasKnownDescendants).
//
// Pure: no Solid, no store, no localStorage. The selectors take a TreeFlatMap
// (and selected-ancestor/toggle sets) directly.
import { describe, expect, it } from "vitest";
import { seedTree } from "../../src/sync/treeMap";
import type { TreeNode, TreeFlatMap } from "../../src/sync/treeMap";
import type { TreeMode } from "../../src/sync/treeState";
import {
  selectPinnedNodes,
  selectSearchResults,
  selectedPathIds,
  strictAncestors,
  working,
  effectiveTreeMode,
  hasKnownDescendants,
  autoTreeModeForWorkingTransition,
} from "../../src/sync/treeSelectors";

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

  it("surfaces a pinned DEEP COLLAPSED node (the old roots-only bug)", () => {
    const map = deepMap();
    expect([...map.values()].find((n) => n.parentId === null && n.id === "C")).toBeUndefined();
    expect(map.get("C")?.loaded).toBe(false);

    const out = selectPinnedNodes(map, ["C"]);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe("C");
    expect(out[0].title).toBe("C-deep-collapsed");
    expect(out[0].agent).toBe("planner");
    expect(out[0].descendantCount).toBe(5);
  });

  it("preserves the pinned order verbatim and drops stale (missing) ids", () => {
    const siblings = seedTree([
      node({ id: "R1", title: "Root1", updatedMs: 10 }),
      node({ id: "R2", title: "Root2", updatedMs: 20 }),
      node({ id: "R3", title: "Root3", updatedMs: 30 }),
    ]);
    const out = selectPinnedNodes(siblings, ["R3", "missing", "R1", "R2"]).map((n) => n.id);
    expect(out).toEqual(["R3", "R1", "R2"]);
  });

  it("never recency-sorts pins: a pinned order that is the REVERSE of recency is preserved", () => {
    const siblings = seedTree([
      node({ id: "old", title: "Old", updatedMs: 10 }),
      node({ id: "mid", title: "Mid", updatedMs: 20 }),
      node({ id: "new", title: "New", updatedMs: 30 }),
    ]);
    const out = selectPinnedNodes(siblings, ["old", "mid", "new"]).map((n) => n.id);
    expect(out).toEqual(["old", "mid", "new"]);
  });

  it("excludes a pinned descendant of another pinned node — no double render (d_F1)", () => {
    const out = selectPinnedNodes(deepMap(), ["R", "C"]).map((n) => n.id);
    expect(out).toEqual(["R"]);
    const out2 = selectPinnedNodes(deepMap(), ["A", "C"]).map((n) => n.id);
    expect(out2).toEqual(["A"]);
    const out3 = selectPinnedNodes(deepMap(), ["C", "R"]).map((n) => n.id);
    expect(out3).toEqual(["R"]);
    expect(new Set(out).size).toBe(out.length);
  });
});

describe("selectSearchResults (flatten-to-matches)", () => {
  it("returns null for an empty/blank query (no filter active)", () => {
    expect(selectSearchResults(deepMap(), "", () => false)).toBeNull();
    expect(selectSearchResults(deepMap(), "   ", () => false)).toBeNull();
  });

  it("surfaces a DEEP COLLAPSED descendant match by title", () => {
    const out = selectSearchResults(deepMap(), "c-deep", () => false);
    expect(out).not.toBeNull();
    expect(out!.map((n) => n.id)).toContain("C");
  });

  it("matches on id substring (case-insensitive)", () => {
    const out = selectSearchResults(deepMap(), "B", () => false);
    expect(out!.map((n) => n.id)).toEqual(["B"]);
  });

  it("matches on agent substring (case-insensitive)", () => {
    const out = selectSearchResults(deepMap(), "planner", () => false);
    expect(out!.map((n) => n.id)).toEqual(["C"]);
  });

  it("pinned-first ordering: a pinned older node precedes a newer unpinned one", () => {
    const out = selectSearchResults(deepMap(), "er", (id) => id === "B");
    expect(out!.map((n) => n.id)).toEqual(["B", "C"]);
  });

  it("recency tiebreak among unpinned matches (updatedMs desc)", () => {
    const out = selectSearchResults(deepMap(), "er", () => false);
    expect(out!.map((n) => n.id)).toEqual(["C", "B"]);
  });

  it("returns [] when nothing matches (caller renders the empty state)", () => {
    const out = selectSearchResults(deepMap(), "zzzznotasession", () => false);
    expect(out).toEqual([]);
  });
});

// selectedPathIds — the inclusive ancestor chain of the selected node (P0-D).
describe("selectedPathIds — inclusive ancestor chain of the selected node (P0-D)", () => {
  it("includes a selected IDLE node + all its ancestors even when NOTHING is active", () => {
    const map = seedTree([
      node({ id: "R", title: "r", updatedMs: 10 }),
      node({ id: "MID", parentId: "R", title: "mid", updatedMs: 20 }),
      node({ id: "LEAF", parentId: "MID", title: "leaf", updatedMs: 30 }),
    ]);
    const set = selectedPathIds(map, "LEAF");
    expect(set.has("LEAF")).toBe(true);
    expect(set.has("MID")).toBe(true);
    expect(set.has("R")).toBe(true);
  });

  it("is empty when selectedId is null (no selection → nothing to reveal)", () => {
    const map = seedTree([node({ id: "R", title: "r" }), node({ id: "C", parentId: "R" })]);
    expect(selectedPathIds(map, null).size).toBe(0);
    expect(selectedPathIds(map, "").size).toBe(0);
  });

  it("is empty when the selected id is not resident in the map (stale deep link)", () => {
    const map = seedTree([node({ id: "R", title: "r" })]);
    expect(selectedPathIds(map, "ghost").size).toBe(0);
  });

  it("does NOT include idle siblings of the selected chain", () => {
    const map = seedTree([
      node({ id: "R", title: "r" }),
      node({ id: "MID", parentId: "R" }),
      node({ id: "LEAF", parentId: "MID" }),
      node({ id: "SIB", parentId: "R" }),
    ]);
    const set = selectedPathIds(map, "LEAF");
    expect(set.has("SIB")).toBe(false);
  });

  it("does not infinite-loop on a corrupt parentId cycle (depth-capped)", () => {
    const map = seedTree([
      node({ id: "cyc1", parentId: "cyc2", title: "c1", updatedMs: 1 }),
      node({ id: "cyc2", parentId: "cyc1", title: "c2", updatedMs: 2 }),
    ]);
    const set = selectedPathIds(map, "cyc1");
    expect(set.has("cyc1")).toBe(true);
    expect(set.has("cyc2")).toBe(true);
  });
});

// ---- proj=1 4-state twisty model helpers ------------------------------------

// working — the SINGLE working predicate (busy/retry/subtreeBusy/
// subtreeNeedsInput → true; error/idle → false). No client-side subtree walk.
describe("working — single working predicate (server rollups + self activity)", () => {
  it("true for activity busy", () => {
    expect(working(node({ activity: "busy" }))).toBe(true);
  });
  it("true for activity retry", () => {
    expect(working(node({ activity: "retry" }))).toBe(true);
  });
  it("true for flags.subtreeBusy (collapsed ancestor of a busy descendant)", () => {
    expect(working(node({ activity: "idle", flags: { ...node().flags, subtreeBusy: true } }))).toBe(true);
  });
  it("true for flags.subtreeNeedsInput (input-ancestry rollup)", () => {
    expect(working(node({ activity: "idle", flags: { ...node().flags, subtreeNeedsInput: true } }))).toBe(true);
  });
  it("false for activity error", () => {
    expect(working(node({ activity: "error" }))).toBe(false);
  });
  it("false for idle with no rollups", () => {
    expect(working(node({ activity: "idle" }))).toBe(false);
  });
  it("false for pendingInput SELF only (not subtreeBusy/subtreeNeedsInput)", () => {
    // working does NOT include self pendingInput — input-ancestry is represented
    // by the subtreeNeedsInput rollup. A self-pendingInput idle node is not
    // "working" by this predicate (it shows a needs-input dot, not a ring).
    expect(working(node({ activity: "idle", flags: { ...node().flags, pendingInput: true } }))).toBe(false);
  });
});

// strictAncestors — the selected node's ancestors EXCLUDING the selected node.
describe("strictAncestors — selected ancestors excluding the selected node", () => {
  it("includes all ancestors of the selected node, excludes the selected node itself", () => {
    const map = seedTree([
      node({ id: "R" }),
      node({ id: "MID", parentId: "R" }),
      node({ id: "LEAF", parentId: "MID" }),
    ]);
    const set = strictAncestors(map, "LEAF");
    expect(set.has("R")).toBe(true);
    expect(set.has("MID")).toBe(true);
    expect(set.has("LEAF")).toBe(false); // the selected node is excluded
  });

  it("is empty when selectedId is null", () => {
    const map = seedTree([node({ id: "R" }), node({ id: "C", parentId: "R" })]);
    expect(strictAncestors(map, null).size).toBe(0);
  });

  it("is empty when the selected id is not resident (stale deep link)", () => {
    const map = seedTree([node({ id: "R" })]);
    expect(strictAncestors(map, "ghost").size).toBe(0);
  });

  it("does NOT mutate the selectedPathIds result (returns a copy)", () => {
    const map = seedTree([
      node({ id: "R" }),
      node({ id: "C", parentId: "R" }),
    ]);
    const path = selectedPathIds(map, "C");
    strictAncestors(map, "C");
    expect(path.has("C")).toBe(true); // the original inclusive set is untouched
  });
});

// effectiveTreeMode — the per-node display-mode state machine.
describe("effectiveTreeMode — temp overlay on non-expanded selected ancestors", () => {
  const ancestors = new Set(["R", "MID"]);
  const toggled = new Set<string>();

  it("a non-expanded strict ancestor (not toggled) → 'temp'", () => {
    expect(effectiveTreeMode("R", "filtered", ancestors, toggled)).toBe("temp");
    expect(effectiveTreeMode("MID", "collapsed", ancestors, toggled)).toBe("temp");
  });

  it("an EXPANDED ancestor stays 'expanded' (expanded is not overridden to temp)", () => {
    expect(effectiveTreeMode("R", "expanded", ancestors, toggled)).toBe("expanded");
  });

  it("a toggled ancestor reflects its persisted mode (temp suppressed by the click)", () => {
    const tog = new Set(["R"]);
    expect(effectiveTreeMode("R", "filtered", ancestors, tog)).toBe("filtered");
  });

  it("the selected node ITSELF is not temp (it is not a strict ancestor)", () => {
    // LEAF is not in the strict-ancestor set, so even filtered it stays filtered.
    expect(effectiveTreeMode("LEAF", "filtered", ancestors, toggled)).toBe("filtered");
  });

  it("a node unrelated to the selection reflects its persisted mode", () => {
    expect(effectiveTreeMode("OTHER", "collapsed", ancestors, toggled)).toBe("collapsed");
    expect(effectiveTreeMode("OTHER", "filtered", ancestors, toggled)).toBe("filtered");
    expect(effectiveTreeMode("OTHER", "expanded", ancestors, toggled)).toBe("expanded");
  });

  it("with no selection (empty ancestor set), nothing is temp", () => {
    const empty = new Set<string>();
    const modes: TreeMode[] = ["collapsed", "filtered", "expanded"];
    for (const m of modes) {
      expect(effectiveTreeMode("X", m, empty, toggled)).toBe(m);
    }
  });
});

// hasKnownDescendants — drives the lazy-frontier fetch gate.
describe("hasKnownDescendants — lazy-frontier fetch gate", () => {
  it("true when childCount > 0", () => {
    expect(hasKnownDescendants(node({ childCount: 3, descendantCount: 0 }))).toBe(true);
  });
  it("true when descendantCount > 0", () => {
    expect(hasKnownDescendants(node({ childCount: 0, descendantCount: 5 }))).toBe(true);
  });
  it("false when both are 0 (structural leaf)", () => {
    expect(hasKnownDescendants(node({ childCount: 0, descendantCount: 0 }))).toBe(false);
  });
  it("false when descendantCount is absent and childCount is 0", () => {
    const n = node({ childCount: 0 });
    delete (n as Partial<TreeNode>).descendantCount;
    expect(hasKnownDescendants(n)).toBe(false);
  });
});

// autoTreeModeForWorkingTransition — the qualified auto-mutation decision. PURE:
// takes only the transition + current PERSISTED mode, returns the target mode for
// the two qualifying edges or undefined (no-op) for everything else.
describe("autoTreeModeForWorkingTransition — qualified transition table", () => {
  // The two QUALIFYING edges (the only cases that auto-mutate the persisted mode):
  it("false→true on collapsed → 'filtered' (running reveals working children)", () => {
    expect(autoTreeModeForWorkingTransition(false, true, "collapsed")).toBe("filtered");
  });
  it("true→false on filtered → 'collapsed' (finished hides now-idle children)", () => {
    expect(autoTreeModeForWorkingTransition(true, false, "filtered")).toBe("collapsed");
  });

  // The SIX no-op combinations (return undefined):
  it("false→false on collapsed → undefined (steady idle, no edge)", () => {
    expect(autoTreeModeForWorkingTransition(false, false, "collapsed")).toBeUndefined();
  });
  it("false→false on filtered → undefined (manual filtered stays filtered)", () => {
    expect(autoTreeModeForWorkingTransition(false, false, "filtered")).toBeUndefined();
  });
  it("true→true on collapsed → undefined (already-stale, not an edge; explicit collapsed held)", () => {
    expect(autoTreeModeForWorkingTransition(true, true, "collapsed")).toBeUndefined();
  });
  it("true→true on filtered → undefined (steady working, no edge)", () => {
    expect(autoTreeModeForWorkingTransition(true, true, "filtered")).toBeUndefined();
  });
  it("false→true on filtered → undefined (already filtered, do not double-set)", () => {
    expect(autoTreeModeForWorkingTransition(false, true, "filtered")).toBeUndefined();
  });
  it("true→false on collapsed → undefined (already collapsed, do not double-set)", () => {
    expect(autoTreeModeForWorkingTransition(true, false, "collapsed")).toBeUndefined();
  });

  // expanded is NEVER auto-changed — every expanded combination returns undefined:
  it("expanded is NEVER auto-mutated (all four working transitions)", () => {
    expect(autoTreeModeForWorkingTransition(false, true, "expanded")).toBeUndefined();
    expect(autoTreeModeForWorkingTransition(true, false, "expanded")).toBeUndefined();
    expect(autoTreeModeForWorkingTransition(false, false, "expanded")).toBeUndefined();
    expect(autoTreeModeForWorkingTransition(true, true, "expanded")).toBeUndefined();
  });
});
