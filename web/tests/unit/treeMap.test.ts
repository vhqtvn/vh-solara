// Pure-logic tests for the server-owned tree flat-map + op-apply layer
// (web/src/sync/treeMap.ts). This is the CLIENT half of the tree=2 design
// (docs/design/server-owned-tree.md §7). The client is a DUMB OP-APPLIER:
// it NEVER infers parent→child, never classifies orphans, never reconciles
// ghosts. Every node always carries its own display data. "Collapsed" is a
// render attribute (loaded:false), not a node type.
//
// These tests assert the exact §7.2 per-op mutation semantics, plus the
// success-criteria cases: loaded-descendant drop on remove, parent-before-child
// ordering within a flush, and the loaded flip on terminal children.
//
// Node env (pure logic — no DOM). Mirrors the existing reduce.test.ts convention.
import { describe, expect, it } from "vitest";
import {
  applyOp,
  applyOps,
  childrenIndex,
  collapseNode,
  loadedDescendants,
  rootNodes,
  seedTree,
  toggleDecision,
} from "../../src/sync/treeMap";
import type { TreeNode, TreeOp, TreeFlatMap } from "../../src/sync/treeMap";

// ---- helpers ---------------------------------------------------------------
const noFlags = {
  pendingInput: false,
  subtreeNeedsInput: false,
  permission: false,
  archived: false,
  orphan: false,
};

/** Minimal self-contained node. Override fields per-case. */
function node(over: Partial<TreeNode> & Pick<TreeNode, "id">): TreeNode {
  return {
    parentId: null,
    title: over.title ?? "",
    activity: "idle",
    childCount: 0,
    loaded: false,
    flags: { ...noFlags },
    updatedMs: 0,
    ...over,
  };
}

const upsert = (n: TreeNode): TreeOp => ({ op: "node.upsert", data: { node: n } });
const remove = (id: string): TreeOp => ({ op: "node.remove", data: { id } });
const move = (id: string, newParentId: string | null): TreeOp => ({
  op: "node.move",
  data: { id, newParentId },
});
const children = (
  parentId: string,
  nodes: TreeNode[],
  hasMore = false,
  cursor: string | null = null,
): TreeOp => ({ op: "node.children", data: { parentId, nodes, hasMore, cursor } });
const facet = (data: {
  id: string;
  activity?: TreeNode["activity"];
  verb?: TreeNode["verb"];
  flags?: Partial<TreeNode["flags"]>;
}): TreeOp => ({ op: "node.facet", data });

// ---- §7.1 seed from snapshot -----------------------------------------------
describe("seedTree — §7.1 initial snapshot", () => {
  it("clears and seeds the flat map from the snapshot node list", () => {
    const m = seedTree([node({ id: "a" }), node({ id: "b", parentId: "a" })]);
    expect([...m.keys()].sort()).toEqual(["a", "b"]);
  });

  it("returns a fresh empty map for an empty snapshot", () => {
    const m = seedTree([]);
    expect(m.size).toBe(0);
  });

  it("treats a null parentId as a root", () => {
    const m = seedTree([node({ id: "root", parentId: null })]);
    expect(rootNodes(m).map((n) => n.id)).toEqual(["root"]);
  });
});

// ---- §7.2 node.upsert (full replace) ---------------------------------------
describe("node.upsert — §7.2 full replace", () => {
  it("inserts a new node", () => {
    const m = seedTree([]);
    applyOp(m, upsert(node({ id: "a", title: "first", activity: "busy" })));
    expect(m.get("a")?.title).toBe("first");
    expect(m.get("a")?.activity).toBe("busy");
  });

  it("FULLY replaces an existing node (idempotent — no merge, no carry-over)", () => {
    const m = seedTree([
      node({
        id: "a",
        title: "old",
        activity: "busy",
        agent: "build",
        flags: { ...noFlags, pendingInput: true },
      }),
    ]);
    // New node drops agent + pendingInput entirely (full replace, not merge).
    applyOp(m, upsert(node({ id: "a", title: "new", activity: "idle" })));
    const got = m.get("a")!;
    expect(got.title).toBe("new");
    expect(got.activity).toBe("idle");
    expect(got.agent).toBeUndefined();
    expect(got.flags.pendingInput).toBe(false);
  });
});

// ---- §7.2 node.remove (drop node + LOADED descendants) ---------------------
describe("node.remove — §7.2 drop node + loaded descendants (BFS by parentId)", () => {
  it("drops the node itself", () => {
    const m = seedTree([node({ id: "a" })]);
    applyOp(m, remove("a"));
    expect(m.has("a")).toBe(false);
  });

  it("is a no-op when the id is absent (no inference from absence)", () => {
    const m = seedTree([node({ id: "a" })]);
    applyOp(m, remove("ghost"));
    expect(m.has("a")).toBe(true);
  });

  it("drops every LOADED descendant rooted at the id, by parentId BFS", () => {
    const m = seedTree([
      node({ id: "root" }),
      node({ id: "c1", parentId: "root" }),
      node({ id: "c1a", parentId: "c1" }),
      node({ id: "c1b", parentId: "c1" }),
      node({ id: "c2", parentId: "root" }),
      // an UNRELATED subtree stays put
      node({ id: "other", parentId: null }),
      node({ id: "o1", parentId: "other" }),
    ]);
    applyOp(m, remove("root"));
    expect([...m.keys()].sort()).toEqual(["o1", "other"]); // lexicographic sort
  });

  it("loadedDescendants lists the full loaded subtree (excluding the root itself's parent, including root)", () => {
    const m = seedTree([
      node({ id: "r" }),
      node({ id: "x", parentId: "r" }),
      node({ id: "y", parentId: "x" }),
      node({ id: "z", parentId: "y" }),
    ]);
    // BFS by parentId across the loaded set: r + x + y + z
    expect(loadedDescendants(m, "r").sort()).toEqual(["r", "x", "y", "z"]);
  });

  it("does NOT drop unloaded siblings of the removed node (server moves/removes them via their own ops)", () => {
    // root has two children; one (c1) is loaded with descendants, the other
    // (c2) is a collapsed placeholder (loaded:false). Removing root drops the
    // whole loaded set; the placeholder is gone too because it is a loaded
    // descendant. But a SEPARATE root's collapsed child must survive.
    const m = seedTree([
      node({ id: "r1" }),
      node({ id: "r1c", parentId: "r1", loaded: false }),
      node({ id: "r2" }),
      node({ id: "r2c", parentId: "r2", loaded: false }),
    ]);
    applyOp(m, remove("r1"));
    expect(m.has("r1")).toBe(false);
    expect(m.has("r1c")).toBe(false);
    // r2's subtree untouched
    expect(m.has("r2")).toBe(true);
    expect(m.has("r2c")).toBe(true);
  });
});

// ---- §7.2 node.move (reparent) ---------------------------------------------
describe("node.move — §7.2 reparent; loaded descendants travel", () => {
  it("updates parentId to a new parent", () => {
    const m = seedTree([
      node({ id: "newroot" }),
      node({ id: "mover", parentId: "oldroot" }),
      // oldroot is absent on the client (INV-B guarantees the NEW parent is present)
    ]);
    applyOp(m, move("mover", "newroot"));
    expect(m.get("mover")?.parentId).toBe("newroot");
  });

  it("moves to root when newParentId is null", () => {
    const m = seedTree([node({ id: "r" }), node({ id: "m", parentId: "r" })]);
    applyOp(m, move("m", null));
    expect(m.get("m")?.parentId).toBeNull();
    expect(rootNodes(m).map((n) => n.id)).toContain("m");
  });

  it("loaded descendants travel with the node implicitly (their parentId still resolves)", () => {
    const m = seedTree([
      node({ id: "dest" }),
      node({ id: "mover", parentId: "src" }),
      node({ id: "child", parentId: "mover" }),
      node({ id: "grand", parentId: "child" }),
    ]);
    applyOp(m, move("mover", "dest"));
    expect(m.get("mover")?.parentId).toBe("dest");
    // descendants keep their parentId (no mutation of them)
    expect(m.get("child")?.parentId).toBe("mover");
    expect(m.get("grand")?.parentId).toBe("child");
    // re-grouping by parentId now nests them under dest
    const idx = childrenIndex(m);
    expect(idx.get("dest")?.map((n) => n.id)).toEqual(["mover"]);
  });

  it("is a no-op when the node is absent (server's record said it exists; absence is a transient)", () => {
    const m = seedTree([node({ id: "a" })]);
    applyOp(m, move("ghost", "a")); // must not throw
    expect(m.has("ghost")).toBe(false);
  });
});

// ---- §7.2 node.children (merge batch + loaded flip) ------------------------
describe("node.children — §7.2 merge batch; loaded flip on terminal", () => {
  it("merges each child node into the flat map", () => {
    const m = seedTree([node({ id: "p" })]);
    applyOp(
      m,
      children("p", [node({ id: "c1", parentId: "p" }), node({ id: "c2", parentId: "p" })], false),
    );
    expect(m.get("c1")?.parentId).toBe("p");
    expect(m.get("c2")?.parentId).toBe("p");
  });

  it("sets parent loaded:true when hasMore is false (terminal batch)", () => {
    const m = seedTree([node({ id: "p", loaded: false })]);
    applyOp(m, children("p", [node({ id: "c1", parentId: "p" })], false));
    expect(m.get("p")?.loaded).toBe(true);
  });

  it("does NOT set loaded:true when hasMore is true (more pages coming)", () => {
    const m = seedTree([node({ id: "p", loaded: false })]);
    applyOp(m, children("p", [node({ id: "c1", parentId: "p" })], true, "c1"));
    expect(m.get("p")?.loaded).toBe(false);
  });

  it("leaves loaded untouched when the parent is not in the map (children without a known parent are still merged)", () => {
    const m = seedTree([]);
    applyOp(m, children("absent", [node({ id: "c1", parentId: "absent" })], false));
    expect(m.get("c1")?.id).toBe("c1");
    expect(m.has("absent")).toBe(false);
  });
});

// ---- §7.2 node.facet (partial merge) ---------------------------------------
describe("node.facet — §7.2 partial merge (tri-state verb + partial flags)", () => {
  it("merges activity when present", () => {
    const m = seedTree([node({ id: "a", activity: "idle" })]);
    applyOp(m, facet({ id: "a", activity: "retry" }));
    expect(m.get("a")?.activity).toBe("retry");
  });

  it("leaves activity untouched when the field is absent", () => {
    const m = seedTree([node({ id: "a", activity: "busy" })]);
    applyOp(m, facet({ id: "a", flags: { pendingInput: true } }));
    expect(m.get("a")?.activity).toBe("busy");
  });

  it("sets verb to a value when present", () => {
    const m = seedTree([node({ id: "a" })]);
    const vf = { tool: "read", state: { status: "in_progress" } };
    applyOp(m, facet({ id: "a", verb: vf }));
    expect(m.get("a")?.verb).toEqual(vf);
  });

  it("CLEARS verb when the field is present and null (tri-state: null = clear)", () => {
    const m = seedTree([
      node({ id: "a", verb: { tool: "read", state: { status: "in_progress" } } }),
    ]);
    applyOp(m, facet({ id: "a", verb: null }));
    expect(m.get("a")?.verb).toBeNull();
  });

  it("leaves verb untouched when the field is absent", () => {
    const m = seedTree([node({ id: "a", verb: { tool: "read" } })]);
    applyOp(m, facet({ id: "a", activity: "busy" }));
    expect(m.get("a")?.verb).toEqual({ tool: "read" });
  });

  it("merges only the listed flags (partial flags merge)", () => {
    const m = seedTree([
      node({ id: "a", flags: { ...noFlags, permission: true, archived: true } }),
    ]);
    applyOp(m, facet({ id: "a", flags: { pendingInput: true } }));
    const f = m.get("a")!.flags;
    expect(f.pendingInput).toBe(true); // changed
    expect(f.permission).toBe(true); // untouched
    expect(f.archived).toBe(true); // untouched
  });

  it("is ignored when the node is unknown (no inference, no ghost creation)", () => {
    const m = seedTree([]);
    applyOp(m, facet({ id: "ghost", activity: "busy", flags: { orphan: true } }));
    expect(m.size).toBe(0);
  });
});

// ---- §7.3 no-inference guarantees ------------------------------------------
describe("§7.3 client never infers", () => {
  it("never promotes a child whose parent is absent to a root (renders hidden, not orphan-promoted)", () => {
    const m = seedTree([node({ id: "c", parentId: "absent" })]);
    const roots = rootNodes(m);
    expect(roots.map((n) => n.id)).toEqual([]); // c is NOT a root
  });

  it("childrenIndex groups strictly by parentId (no orphan classification)", () => {
    const m = seedTree([
      node({ id: "r" }), // r is the SOLE root (parentId null)
      node({ id: "c", parentId: "r" }),
      node({ id: "ghostchild", parentId: "nope" }), // absent parent
    ]);
    const idx = childrenIndex(m);
    expect(idx.get("r")?.map((n) => n.id)).toEqual(["c"]);
    // ghostchild is grouped under "nope" — NOT promoted to a root
    expect(idx.get("nope")?.map((n) => n.id)).toEqual(["ghostchild"]);
    // the only root is r; ghostchild did NOT leak into the root list
    expect(idx.get(null)?.map((n) => n.id)).toEqual(["r"]);
  });
});

// ---- parent-before-child ordering within a flush (§4.7 INV-B assumed) -------
describe("parent-before-child flush ordering (§4.7 INV-B)", () => {
  it("a flush where the parent upsert precedes its child references applies cleanly", () => {
    const m = seedTree([]);
    applyOps(m, [
      upsert(node({ id: "parent" })), // parent first
      upsert(node({ id: "child", parentId: "parent" })), // child references just-introduced parent
      children("parent", [node({ id: "c1", parentId: "parent" })], false),
    ]);
    // after the flush, the tree renders parent → [child, c1], parent loaded
    const idx = childrenIndex(m);
    expect(idx.get("parent")?.map((n) => n.id).sort()).toEqual(["c1", "child"]);
    expect(m.get("parent")?.loaded).toBe(true);
  });
});

// ---- §8.4 collapse (client-only) -------------------------------------------
describe("collapseNode — §8.4 client-only collapse", () => {
  it("drops loaded descendants but keeps the placeholder node with loaded:false", () => {
    const m = seedTree([
      node({ id: "p", loaded: true, childCount: 2, descendantCount: 5, agent: "build" }),
      node({ id: "c1", parentId: "p", agent: "research" }),
      node({ id: "c1a", parentId: "c1" }),
      node({ id: "c2", parentId: "p" }),
    ]);
    collapseNode(m, "p");
    expect(m.has("p")).toBe(true); // placeholder kept
    expect(m.get("p")?.loaded).toBe(false); // flipped
    expect(m.get("p")?.agent).toBe("build"); // own data preserved (self-contained)
    expect(m.get("p")?.descendantCount).toBe(5); // badge survives
    // descendants dropped from view
    expect(m.has("c1")).toBe(false);
    expect(m.has("c1a")).toBe(false);
    expect(m.has("c2")).toBe(false);
  });

  it("is a no-op on an absent node", () => {
    const m = seedTree([]);
    collapseNode(m, "ghost");
    expect(m.size).toBe(0);
  });

  // Parity fix: a PINNED descendant must survive an ancestor collapse. The flat
  // map normally drops loaded descendants on collapse (§8.4) to save memory, but
  // a pinned node is hoisted into the Pinned group and must stay resident so the
  // pinned group keeps rendering it after the parent collapses. `protectedIds`
  // is the pinned membership; protected descendants are skipped by the drop.
  it("keeps protected (pinned) descendants when collapsing a parent", () => {
    const m = seedTree([
      node({ id: "p", loaded: true, childCount: 2, descendantCount: 5 }),
      node({ id: "c1", parentId: "p" }),
      node({ id: "c1a", parentId: "c1" }),
      node({ id: "c2", parentId: "p" }),
    ]);
    // Pin c1a (a deep descendant). Collapse p with c1a protected.
    collapseNode(m, "p", new Set(["c1a"]));
    expect(m.has("p")).toBe(true); // placeholder kept
    expect(m.get("p")?.loaded).toBe(false); // flipped
    // The protected descendant stays resident (the pinned group can still resolve it).
    expect(m.has("c1a")).toBe(true);
    expect(m.get("c1a")?.id).toBe("c1a"); // own data intact
    // Non-protected descendants are still dropped as before.
    expect(m.has("c1")).toBe(false);
    expect(m.has("c2")).toBe(false);
  });
});

// ---- §8.5 toggle decision (c_F1: stuck re-expand) --------------------------
// onToggle must decide expand vs collapse from the node's `loaded` flag, NOT
// from whether children happen to be resident in the flat map. The protectedIds
// pin-parity hook keeps a pinned descendant RESIDENT through an ancestor
// collapse, so a presence-based guard would ALWAYS see "has children" and
// ALWAYS collapse — the user could collapse but never re-expand (bug c_F1).
// Keying off `loaded` (collapse flips it false; false means "expand / fetch")
// makes re-expand reachable. This is the pure, unit-testable core of the fix.
describe("toggleDecision — expand/collapse keyed off loaded (c_F1)", () => {
  it("collapse when the node IS loaded", () => {
    const n = node({ id: "p", loaded: true, childCount: 2, descendantCount: 3 });
    expect(toggleDecision(n)).toBe("collapse");
  });

  it("expand when the node is NOT loaded but has structural descendants", () => {
    const n = node({ id: "p", loaded: false, childCount: 2, descendantCount: 3 });
    expect(toggleDecision(n)).toBe("expand");
  });

  it("none for a structural leaf with nothing to toggle", () => {
    const n = node({ id: "leaf", loaded: false, childCount: 0, descendantCount: 0 });
    expect(toggleDecision(n)).toBe("none");
  });

  // CRUX (c_F1): a parent with a PINNED DIRECT CHILD. Collapse protects the
  // pinned child (it stays resident), so the flat map STILL reports it as a
  // direct child of p — a presence-based decision would re-collapse forever
  // (stuck). Keying off `loaded`: collapse flipped loaded:false, so the NEXT
  // toggle decision is EXPAND (re-expand is reachable).
  it("re-expand is reachable after collapsing a parent with a pinned direct child", () => {
    const m = seedTree([
      node({ id: "p", loaded: true, childCount: 2, descendantCount: 2 }),
      node({ id: "c1", parentId: "p" }), // dropped on collapse
      node({ id: "pin", parentId: "p" }), // PINNED direct child — protected
    ]);
    // Before collapse: loaded → collapse.
    expect(toggleDecision(m.get("p")!)).toBe("collapse");

    // Collapse p, protecting the pinned direct child.
    collapseNode(m, "p", new Set(["pin"]));
    const p2 = m.get("p")!;
    // The protected pinned child stays resident AND is still a direct child of p.
    expect(childrenIndex(m).get("p")?.map((n) => n.id)).toEqual(["pin"]);
    // loaded was flipped false...
    expect(p2.loaded).toBe(false);
    // ...so the toggle decision is now EXPAND, not collapse — re-expand works.
    // (A presence-based rule would see "pin" resident and re-collapse → stuck.)
    expect(toggleDecision(p2)).toBe("expand");
  });
});
