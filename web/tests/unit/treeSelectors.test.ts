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
import {
  selectPinnedNodes,
  selectSearchResults,
  activePathIds,
  selectedPathIds,
  visiblePathIds,
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
    // SIBLING roots (no ancestor relationship) so the d_F1 nested-pin dedup does
    // not apply — this isolates the order-preservation + stale-drop intent.
    const siblings = seedTree([
      node({ id: "R1", title: "Root1", updatedMs: 10 }),
      node({ id: "R2", title: "Root2", updatedMs: 20 }),
      node({ id: "R3", title: "Root3", updatedMs: 30 }),
    ]);
    const out = selectPinnedNodes(siblings, ["R3", "missing", "R1", "R2"]).map((n) => n.id);
    expect(out).toEqual(["R3", "R1", "R2"]);
  });

  // REGRESSION guard for P0-WEB-001: the pinned group must NEVER be recency-
  // sorted. It renders from selectPinnedNodes (SessionTree.tsx:78), which does
  // NOT call treeRoots()/treeChildrenOf() (the accessors that now sort newest-
  // first). Construct a pinnedOrder that is the EXACT REVERSE of recency and
  // assert it is preserved — this pins the invariant even as the treeState
  // accessors gain a recency sort.
  it("never recency-sorts pins: a pinned order that is the REVERSE of recency is preserved", () => {
    const siblings = seedTree([
      node({ id: "old", title: "Old", updatedMs: 10 }),
      node({ id: "mid", title: "Mid", updatedMs: 20 }),
      node({ id: "new", title: "New", updatedMs: 30 }),
    ]);
    // Recency would be [new, mid, old]. Pin in the EXACT reverse so any leak of
    // the treeState recency sort into pins would flip the assertion.
    const out = selectPinnedNodes(siblings, ["old", "mid", "new"]).map((n) => n.id);
    expect(out).toEqual(["old", "mid", "new"]);
  });

  // CRUX d_F1 (nested-pin double render): pinning BOTH an ancestor AND a
  // descendant must render the descendant EXACTLY ONCE. The pinned-group
  // TreeBranch recurses with an empty dedup set, so a pinned descendant would
  // render TWICE — once nested under its pinned ancestor's recursion, once as a
  // top-level pinned row. The fix: selectPinnedNodes EXCLUDES any pinned id that
  // has a pinned ancestor (it renders nested under that ancestor instead).
  it("excludes a pinned descendant of another pinned node — no double render (d_F1)", () => {
    // deepMap chain: R → A → B → C. Pin ancestor R + deep descendant C.
    // C is nested under R in the pinned group, so it must NOT also appear at the
    // top level. Only R (the top-most pinned ancestor) surfaces.
    const out = selectPinnedNodes(deepMap(), ["R", "C"]).map((n) => n.id);
    expect(out).toEqual(["R"]);

    // Pin a MID ancestor (A) + its descendant (C): only A surfaces (C is nested
    // under A; R is not pinned so it does not appear).
    const out2 = selectPinnedNodes(deepMap(), ["A", "C"]).map((n) => n.id);
    expect(out2).toEqual(["A"]);

    // Order-independent: even if the descendant is listed FIRST, it is still
    // excluded (the dedup considers the full pinned membership).
    const out3 = selectPinnedNodes(deepMap(), ["C", "R"]).map((n) => n.id);
    expect(out3).toEqual(["R"]);

    // The crux — each pinned id appears EXACTLY ONCE in the returned list (no
    // duplicate top-level rows), and the excluded descendant is absent.
    expect(new Set(out).size).toBe(out.length);
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
    const out = selectSearchResults(deepMap(), "zzzznotasession", () => false);
    expect(out).toEqual([]);
  });
});

// activePathIds — the CLIENT-side active-path render-gate set (the "flood fix").
//
// A node's children STAY in the flat map (instant expand, no round-trip) but
// render ONLY when the node is on an ACTIVE PATH (chain root→busy/pending-input
// descendant) OR explicitly user-expanded. activePathIds returns the inclusive
// ancestor set of every node where `activity !== "idle" || flags.pendingInput`,
// computed PURELY from the flat map (the §5 frontier guarantees the active path
// is shipped fully resident, so this needs no fetch). Idle subtrees with no live
// work are NOT in the set → they render collapsed (▸ N) by default.
describe("activePathIds — client-side active-path render gate (flood fix)", () => {
  //   R (root, idle)
  //   ├─ A (child, idle)
  //   │   └─ BUSY (grandchild, activity:"busy")   ← the one active descendant
  //   ├─ SIB1 (child, idle)
  //   └─ SIB2 (child, idle)
  //   OTHER (separate root, idle, no active descendant)
  function busyDescendantMap(): TreeFlatMap {
    return seedTree([
      node({ id: "R", title: "Root", updatedMs: 10 }),
      node({ id: "A", parentId: "R", title: "A", updatedMs: 20 }),
      node({ id: "BUSY", parentId: "A", title: "busy-grand", activity: "busy", updatedMs: 30 }),
      node({ id: "SIB1", parentId: "R", title: "sib1", updatedMs: 5 }),
      node({ id: "SIB2", parentId: "R", title: "sib2", updatedMs: 6 }),
      node({ id: "OTHER", title: "other-root", updatedMs: 1 }),
    ]);
  }

  it("contains the root + the chain to the ONE busy descendant, NOT idle siblings", () => {
    const set = activePathIds(busyDescendantMap());
    expect(set.has("R")).toBe(true); // ancestor of BUSY
    expect(set.has("A")).toBe(true); // ancestor of BUSY
    expect(set.has("BUSY")).toBe(true); // the active node itself (inclusive)
    // Idle siblings of the active chain are NOT in the set.
    expect(set.has("SIB1")).toBe(false);
    expect(set.has("SIB2")).toBe(false);
  });

  it("does NOT contain an idle root with no active descendant", () => {
    const set = activePathIds(busyDescendantMap());
    expect(set.has("OTHER")).toBe(false);
  });

  // A pendingInput leaf drives its WHOLE ancestor chain into the set (live work
  // needing input stays visible), while idle siblings stay out.
  it("contains the ancestor chain of a pendingInput leaf; idle siblings are excluded", () => {
    const map = seedTree([
      node({ id: "R2", title: "root2", updatedMs: 1 }),
      node({ id: "X", parentId: "R2", title: "x", updatedMs: 2 }),
      node({ id: "Y", parentId: "X", title: "y-pending", updatedMs: 3 }),
      node({ id: "Z", parentId: "R2", title: "idle-sib", updatedMs: 4 }),
    ]);
    // Apply pendingInput on the deep leaf Y via the op applier is overkill here;
    // build the flag directly.
    const y = map.get("Y")!;
    map.set("Y", { ...y, flags: { ...y.flags, pendingInput: true } });
    const set = activePathIds(map);
    expect(set.has("R2")).toBe(true);
    expect(set.has("X")).toBe(true);
    expect(set.has("Y")).toBe(true);
    expect(set.has("Z")).toBe(false); // idle sibling
  });

  it("treats retry and error activity as active (anything !== idle)", () => {
    const map = seedTree([
      node({ id: "root", title: "r", updatedMs: 1 }),
      node({ id: "retryLeaf", parentId: "root", title: "retry", activity: "retry", updatedMs: 2 }),
      node({ id: "root2", title: "r2", updatedMs: 1 }),
      node({ id: "errorLeaf", parentId: "root2", title: "err", activity: "error", updatedMs: 2 }),
      node({ id: "idleRoot", title: "idle", updatedMs: 1 }),
    ]);
    const set = activePathIds(map);
    expect(set.has("root")).toBe(true);
    expect(set.has("retryLeaf")).toBe(true);
    expect(set.has("root2")).toBe(true);
    expect(set.has("errorLeaf")).toBe(true);
    expect(set.has("idleRoot")).toBe(false);
  });

  // CONFORMANCE (commit-reviewer tier1_b-F1): the client activePathIds seed
  // predicate must MIRROR the server's authoritative isActiveLocked
  // (pkg/state/tree_emitter.go:200-212, §5.1) line-for-line. Two arms were
  // missing from the original predicate:
  //   - flags.permission (REDUNDANT today — Permission:true ⟹ PendingInput:true
  //     via pendingInputSelfLocked counting perms — so this is unreachable in
  //     live data, but locks the predicate textually).
  //   - flags.archived exclusion (MOOT today — archived nodes are not resident
  //     client-side — but §5.1 Q1 mandates archived NEVER seeds).
  it("seeds the active path for a permission-ONLY node (idle, permission:true, pendingInput:false) — §5.1 mirror of isActiveLocked", () => {
    //   ROOT (root, idle, not archived)
    //   ├─ MID (child, idle)
    //   │   └─ PERM (leaf, idle, permission:true, pendingInput:false) ← seeds
    //   └─ SIB (child, idle — must stay out)
    const map = seedTree([
      node({ id: "ROOT", title: "root", updatedMs: 1 }),
      node({ id: "MID", parentId: "ROOT", title: "mid", updatedMs: 2 }),
      node({
        id: "PERM",
        parentId: "MID",
        title: "perm-leaf",
        activity: "idle",
        flags: { ...node().flags, permission: true, pendingInput: false },
        updatedMs: 3,
      }),
      node({ id: "SIB", parentId: "ROOT", title: "sib", updatedMs: 4 }),
    ]);
    const set = activePathIds(map);
    expect(set.has("PERM")).toBe(true); // seeds (the permission arm)
    expect(set.has("MID")).toBe(true); // ancestor pulled in
    expect(set.has("ROOT")).toBe(true); // ancestor pulled in
    expect(set.has("SIB")).toBe(false); // idle sibling excluded
  });

  it("does NOT seed for an archived node even when activity is busy (§5.1 Q1: archived NEVER seeds; chain not opened by it)", () => {
    //   ROOT (root, idle)
    //   └─ MID (child, idle)
    //      └─ ARCH (leaf, activity:busy BUT flags.archived:true) ← excluded
    // Because ARCH is excluded, its ancestor walk never runs, so MID/ROOT are
    // NOT pulled in either (mirrors isActiveLocked's archived short-circuit).
    const map = seedTree([
      node({ id: "ROOT", title: "root", updatedMs: 1 }),
      node({ id: "MID", parentId: "ROOT", title: "mid", updatedMs: 2 }),
      node({
        id: "ARCH",
        parentId: "MID",
        title: "archived-but-busy",
        activity: "busy",
        flags: { ...node().flags, archived: true },
        updatedMs: 3,
      }),
    ]);
    const set = activePathIds(map);
    expect(set.has("ARCH")).toBe(false); // archived excludes it (even though busy)
    expect(set.has("MID")).toBe(false); // chain NOT opened by ARCH
    expect(set.has("ROOT")).toBe(false); // chain NOT opened by ARCH
    // Nothing else is active → the set is empty.
    expect(set.size).toBe(0);
  });

  it("returns an empty set when no node is active and none need input", () => {
    const map = seedTree([
      node({ id: "r", title: "r", updatedMs: 1 }),
      node({ id: "c", parentId: "r", title: "c", updatedMs: 2 }),
    ]);
    expect(activePathIds(map).size).toBe(0);
  });

  // A corrupt parentId cycle must NOT infinite-loop the ancestor walk. The depth
  // cap (mirrors hasPinnedAncestor's 10000 guard) terminates it. The two cycle
  // nodes are themselves active, so they are in the set (inclusive) — the guard
  // is only about termination, not membership semantics.
  it("does not infinite-loop on a corrupt parentId cycle (depth-capped)", () => {
    const map = seedTree([
      node({ id: "cyc1", parentId: "cyc2", title: "c1", activity: "busy", updatedMs: 1 }),
      node({ id: "cyc2", parentId: "cyc1", title: "c2", activity: "idle", updatedMs: 2 }),
    ]);
    // Should return (not hang). Both cycle nodes are reachable as the active
    // node's ancestors; the cap stops the walk.
    const set = activePathIds(map);
    expect(set.has("cyc1")).toBe(true); // active itself
    expect(set.has("cyc2")).toBe(true); // ancestor of cyc1 via the cycle
  });
});

// selectedPathIds — the selection-path reveal set (P0-D). Selecting or deep-
// linking an idle nested session must reveal it: its collapsed ancestors auto-
// expand to show it. activePathIds seeds ONLY on activity/permission/pendingInput,
// so an idle nested selected node is NOT in activePathIds — selectedPathIds is
// the missing piece. It returns the inclusive ancestor chain of the selected id
// (the node + every parentId up to a root), ancestor-closed.
describe("selectedPathIds — inclusive ancestor chain of the selected node (P0-D)", () => {
  it("includes a selected IDLE node + all its ancestors even when NOTHING is active", () => {
    //   R (root, idle)
    //   └─ MID (child, idle)
    //      └─ LEAF (grandchild, idle) ← selected
    // Nothing is active (activePathIds would be empty). selectedPathIds must
    // still open the whole chain R → MID → LEAF so the selected leaf renders.
    const map = seedTree([
      node({ id: "R", title: "r", updatedMs: 10 }),
      node({ id: "MID", parentId: "R", title: "mid", updatedMs: 20 }),
      node({ id: "LEAF", parentId: "MID", title: "leaf", updatedMs: 30 }),
    ]);
    const set = selectedPathIds(map, "LEAF");
    expect(set.has("LEAF")).toBe(true); // inclusive of the selected node
    expect(set.has("MID")).toBe(true); // ancestor
    expect(set.has("R")).toBe(true); // ancestor (chain to root)
  });

  it("is empty when selectedId is null (no selection → nothing to reveal)", () => {
    const map = seedTree([node({ id: "R", title: "r" }), node({ id: "C", parentId: "R" })]);
    expect(selectedPathIds(map, null).size).toBe(0);
    // An empty-string selection is treated as no selection too.
    expect(selectedPathIds(map, "").size).toBe(0);
  });

  it("is empty when the selected id is not resident in the map (stale deep link)", () => {
    const map = seedTree([node({ id: "R", title: "r" })]);
    // A selection pointing at a node the client does not hold reveals nothing
    // (no chain to walk). Defensive: never add an id that is not in the map.
    const set = selectedPathIds(map, "ghost");
    expect(set.size).toBe(0);
  });

  // The selected node's IDLE SIBLINGS must NOT be revealed — only the selected
  // node's own ancestor chain opens. This is the per-child gate crux.
  it("does NOT include idle siblings of the selected chain", () => {
    //   R
    //   ├─ MID
    //   │   └─ LEAF ← selected
    //   └─ SIB (idle sibling of MID)
    const map = seedTree([
      node({ id: "R", title: "r" }),
      node({ id: "MID", parentId: "R" }),
      node({ id: "LEAF", parentId: "MID" }),
      node({ id: "SIB", parentId: "R" }),
    ]);
    const set = selectedPathIds(map, "LEAF");
    expect(set.has("SIB")).toBe(false); // idle sibling, not on the selected chain
  });

  it("does not infinite-loop on a corrupt parentId cycle (depth-capped)", () => {
    const map = seedTree([
      node({ id: "cyc1", parentId: "cyc2", title: "c1", updatedMs: 1 }),
      node({ id: "cyc2", parentId: "cyc1", title: "c2", updatedMs: 2 }),
    ]);
    // Should return (not hang). The cap stops the cycle walk.
    const set = selectedPathIds(map, "cyc1");
    expect(set.has("cyc1")).toBe(true);
    expect(set.has("cyc2")).toBe(true);
  });
});

// visiblePathIds — the ONE "keep-visible" set driving the per-child render gate
// (P0-C flood + P0-D selection reveal). It is the UNION of activePathIds (live-
// work chains) and selectedPathIds (the selected node's chain), so a child
// renders under a parent iff it is in this set OR the parent is user-expanded.
// Ancestor-closed because both operands are. Idle siblings of either path stay
// out → an active parent shows only its busy branch; a selected idle nested
// node is revealed by opening only its own chain.
describe("visiblePathIds — activePathIds ∪ selectedPathIds (the keep-visible set)", () => {
  it("includes the active path even with NO selection", () => {
    //   R
    //   └─ BUSY (activity busy) ← active
    const map = seedTree([
      node({ id: "R", title: "r" }),
      node({ id: "BUSY", parentId: "R", activity: "busy" }),
    ]);
    const set = visiblePathIds(map, null);
    expect(set.has("R")).toBe(true);
    expect(set.has("BUSY")).toBe(true);
  });

  it("includes a selected idle node + its ancestors even when NOTHING is active", () => {
    //   R (idle)
    //   └─ MID (idle)
    //      └─ LEAF (idle) ← selected
    const map = seedTree([
      node({ id: "R", title: "r" }),
      node({ id: "MID", parentId: "R" }),
      node({ id: "LEAF", parentId: "MID" }),
    ]);
    const set = visiblePathIds(map, "LEAF");
    expect(set.has("R")).toBe(true);
    expect(set.has("MID")).toBe(true);
    expect(set.has("LEAF")).toBe(true);
  });

  // CRUX: the union. A tree that has BOTH an active chain AND a (separate)
  // selected idle chain must keep-visible BOTH chains, while idle siblings of
  // each stay out.
  it("is the UNION of active and selected paths (active ∪ selected)", () => {
    //   ROOT
    //   ├─ A
    //   │   └─ BUSY   ← active (active path: ROOT, A, BUSY)
    //   └─ B
    //       └─ SEL    ← selected, idle (selected path: ROOT, B, SEL)
    //   IDLE_SIB (idle sibling of A under ROOT, on neither path)
    const map = seedTree([
      node({ id: "ROOT", title: "root", childCount: 3 }),
      node({ id: "A", parentId: "ROOT", title: "a" }),
      node({ id: "BUSY", parentId: "A", title: "busy", activity: "busy" }),
      node({ id: "B", parentId: "ROOT", title: "b" }),
      node({ id: "SEL", parentId: "B", title: "sel" }),
      node({ id: "IDLE_SIB", parentId: "ROOT", title: "idle-sib" }),
    ]);
    const set = visiblePathIds(map, "SEL");
    // Active path members.
    expect(set.has("ROOT")).toBe(true);
    expect(set.has("A")).toBe(true);
    expect(set.has("BUSY")).toBe(true);
    // Selected path members (ROOT already present via active).
    expect(set.has("B")).toBe(true);
    expect(set.has("SEL")).toBe(true);
    // Idle sibling of both paths stays OUT (no flood).
    expect(set.has("IDLE_SIB")).toBe(false);
  });

  it("returns an empty set when nothing is active and nothing is selected", () => {
    const map = seedTree([node({ id: "R", title: "r" }), node({ id: "C", parentId: "R" })]);
    expect(visiblePathIds(map, null).size).toBe(0);
  });
});
