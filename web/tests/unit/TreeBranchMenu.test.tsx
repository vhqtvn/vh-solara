// @vitest-environment jsdom
//
// Phase 3 Step A.5 — GAP 2: TreeRow right-click / long-press context menu in the
// tree=2 path.
//
// TreeRow already accepts + spreads menuProps onto its .tree-node button (tested
// in TreeRow.test.tsx). The gap was that the tree=2 TreeBranch component (the
// caller) never PASSED menuProps to <TreeRow>, so tree=2 rows had no context
// menu. The fix wires menuProps={menuTriggers(...)} in TreeBranch, mirroring the
// legacy Node component (SessionTree.tsx ~line 391).
//
// This test renders the REAL <SessionTree/> in tree=2 mode (which early-returns
// TreeStateView → TreeBranch) with a seeded collapsed node, dispatches a
// contextmenu event on the collapsed row, and asserts the session context-menu
// signal (menuTarget) opens with the correct id + title.
//
// RED (pre-fix): TreeBranch rendered <TreeRow> without menuProps → the row had no
// onContextMenu handler → dispatching contextmenu left menuTarget() null.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import SessionTree, { __resetTreeForTest } from "../../src/components/SessionTree";
import { seedTreeStore, resetTreeStore } from "../../src/sync/treeState";
import { menuTarget, closeSessionMenu } from "../../src/sessionMenu";
import { setSelectedIdRaw } from "../../src/sync/store";
import type { TreeNode } from "../../src/sync/treeMap";

function collapsedNode(overrides: Partial<TreeNode> = {}): TreeNode {
  return {
    id: "collapsed-root",
    parentId: null,
    title: "Collapsed Branch",
    activity: "idle",
    childCount: 3,
    loaded: false, // collapsed: children not loaded
    descendantCount: 9,
    updatedMs: 1_700_000_000_000,
    flags: {
      pendingInput: false,
      subtreeNeedsInput: false,
      permission: false,
      archived: false,
      orphan: false,
    },
    ...overrides,
  };
}

function rowButton(container: HTMLElement, id: string): HTMLElement {
  const el = container.querySelector(`.tree-node[data-node-id="${id}"]`);
  if (!el) throw new Error(`no tree-node button for ${id}`);
  return el as HTMLElement;
}

beforeEach(() => {
  // Enable tree=2 so SessionTree early-returns TreeStateView → TreeBranch.
  window.history.replaceState({}, "", "/?tree=2");
  resetTreeStore();
  setSelectedIdRaw(null);
  __resetTreeForTest();
  closeSessionMenu();
});

afterEach(() => {
  cleanup();
  resetTreeStore();
  closeSessionMenu();
  window.history.replaceState({}, "", "/");
});

describe("TreeBranch context-menu wiring (Step A.5 GAP 2)", () => {
  it("opens the session context menu on right-click of a collapsed (loaded:false) TreeRow", () => {
    seedTreeStore([collapsedNode()]);

    const { container } = render(() => <SessionTree />);

    // The collapsed row renders (TreeStateView → TreeBranch → TreeRow).
    const btn = rowButton(container as unknown as HTMLElement, "collapsed-root");

    // Right-click the collapsed row. Pre-fix this did nothing (no onContextMenu).
    btn.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 42, clientY: 7 }),
    );

    // menuTriggers → openSessionMenu(id, title, x, y) sets the menuTarget signal.
    const target = menuTarget();
    expect(target).not.toBeNull();
    expect(target?.id).toBe("collapsed-root");
    expect(target?.title).toBe("Collapsed Branch");
    // Positioned menu (mouse), not centered dialog (touch).
    expect(target?.x).toBe(42);
    expect(target?.y).toBe(7);
  });

  it("opens the context menu for an expanded (loaded:true) TreeRow too", () => {
    seedTreeStore([
      collapsedNode({ id: "open-root", loaded: true, childCount: 0, descendantCount: 0 }),
    ]);

    const { container } = render(() => <SessionTree />);
    const btn = rowButton(container as unknown as HTMLElement, "open-root");

    btn.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, clientX: 1, clientY: 2 }),
    );

    expect(menuTarget()?.id).toBe("open-root");
  });
});
