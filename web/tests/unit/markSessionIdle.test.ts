// @vitest-environment jsdom
//
// Unit tests for markSessionIdle's TWO-SLICE clear (the abort-path fix for the
// `.tree-twisty.running` ring-clear flake).
//
// The abort e2e (ux.spec.ts "Stop clears the working indicator immediately")
// was flaky because markSessionIdle cleared state.activity (→ .working-text)
// but NOT the tree node's activity/flags.subtreeBusy (→ .tree-twisty.running).
// The ring persisted until the tree stream delivered node.facet(idle) after the
// /vh/abort round-trip, which can exceed a caller's timeout. These tests pin
// the guarantee that markSessionIdle clears BOTH slices synchronously.
import { describe, expect, it, beforeEach } from "vitest";
import { markSessionIdle } from "../../src/sync/actions";
import { state, setState } from "../../src/sync/store";
import { seedTreeStore, treeNode, resetTreeStore } from "../../src/sync/treeState";
import { working } from "../../src/sync/treeSelectors";
import type { TreeNode } from "../../src/sync/treeMap";

function busyNode(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: "n",
    parentId: null,
    title: "N",
    activity: "busy",
    childCount: 0,
    loaded: true,
    flags: {
      pendingInput: false,
      subtreeNeedsInput: false,
      subtreeBusy: true,
      permission: false,
      archived: false,
      orphan: false,
    },
    updatedMs: 1,
    ...overrides,
  };
}

beforeEach(() => {
  resetTreeStore();
  setState("activity", {});
});

describe("markSessionIdle — two-slice clear (abort path)", () => {
  it("clears BOTH state.activity AND the tree node's activity+subtreeBusy", () => {
    // Set up: a busy session with both slices showing busy.
    seedTreeStore([busyNode({ id: "s1" })]);
    setState("activity", "s1", "busy");

    // Sanity: both indicators show busy before the call.
    expect(state.activity["s1"]).toBe("busy");
    expect(working(treeNode("s1")!)).toBe(true);

    markSessionIdle("s1");

    // Slice 1 (.working-text ← state.activity): cleared.
    expect(state.activity["s1"]).toBe("idle");
    // Slice 2 (.tree-twisty.running ← working(node)): cleared.
    const node = treeNode("s1")!;
    expect(node.activity).toBe("idle");
    expect(node.flags.subtreeBusy).toBe(false);
    expect(working(node)).toBe(false);
  });

  it("does NOT clear subtreeNeedsInput (abort kills the busy turn, not a pending input)", () => {
    // A session that is BOTH busy AND waiting for input. Aborting the busy turn
    // should NOT hide the input-waiting indicator (subtreeNeedsInput is a
    // separate concern the abort does not resolve; the server reconciles it).
    const base = busyNode({ id: "s2" });
    seedTreeStore([{ ...base, flags: { ...base.flags, subtreeNeedsInput: true } }]);
    setState("activity", "s2", "busy");

    markSessionIdle("s2");

    const n = treeNode("s2")!;
    expect(n.activity).toBe("idle");
    expect(n.flags.subtreeBusy).toBe(false);
    // subtreeNeedsInput is INTENTIONALLY left untouched.
    expect(n.flags.subtreeNeedsInput).toBe(true);
  });

  it("is a no-op on the tree when the node is not resident (no ghost created)", () => {
    setState("activity", "s3", "busy");
    expect(treeNode("s3")).toBeUndefined();

    markSessionIdle("s3");

    // state.activity still clears (that slice is independent of the tree).
    expect(state.activity["s3"]).toBe("idle");
    // Tree node remains absent — no ghost node manufactured by the facet.
    expect(treeNode("s3")).toBeUndefined();
  });

  it("clears a retry-activity node too (working() ORs busy|retry|subtreeBusy)", () => {
    // activity:"retry" also makes working() true. markSessionIdle must clear it.
    seedTreeStore([busyNode({ id: "s4", activity: "retry" })]);
    setState("activity", "s4", "busy");
    expect(working(treeNode("s4")!)).toBe(true);

    markSessionIdle("s4");

    const node = treeNode("s4")!;
    expect(node.activity).toBe("idle");
    expect(node.flags.subtreeBusy).toBe(false);
    expect(working(node)).toBe(false);
  });

  it("clearing subtreeBusy alone is NOT enough if activity stays busy (pins why both are cleared)", () => {
    // This test documents WHY markSessionIdle must clear BOTH activity AND
    // subtreeBusy: working() ORs them. If only one is cleared, the other keeps
    // the ring alive. Here we verify that a busy activity + cleared subtreeBusy
    // still yields working()===true — confirming the facet op must carry BOTH.
    const base = busyNode({ id: "s5" });
    seedTreeStore([base]);
    // Simulate a facet that clears ONLY subtreeBusy (NOT activity):
    const node = treeNode("s5")!;
    expect(working(node)).toBe(true); // busy activity + subtreeBusy
    // After clearing subtreeBusy alone:
    const partial = { ...node, flags: { ...node.flags, subtreeBusy: false } };
    expect(partial.activity).toBe("busy"); // activity NOT cleared
    expect(working(partial)).toBe(true); // STILL working via activity==="busy"
  });
});
