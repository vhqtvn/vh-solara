// @vitest-environment jsdom
// tree2VisiblePath — the per-child render gate crux for P0-C (active-parent
// flood) + P0-D (select/deep-link ancestor reveal).
//
// P0-C: under the OLD render gate, once a parent was on the active path it
// dumped ALL its resident children (busy AND idle) — the flood, just limited to
// active-path parents. The NEW per-child gate renders under a parent P:
//   - ALL children when the user expanded P; else
//   - ONLY children on the keep-visible path (activePathIds ∪ selectedPathIds).
// So an active parent with 1 busy + N idle children auto-shows ONLY the busy
// branch; idle siblings stay collapsed behind `▸ N`. User-expanding P shows all.
//
// P0-D: activePathIds seeded only on activity/permission/pendingInput, so
// selecting or deep-linking an idle NESTED session left its row hidden inside a
// collapsed parent. The NEW selectedPathIds (visiblePathIds union) opens the
// selected node's ancestor chain, so selecting an idle nested session reveals it.
//
// These mount the REAL <SessionTree/> and drive the flat map + selection
// directly (deterministic — no SSE timing). expandTreeNode (the fetch
// entrypoint) is mocked so we assert no stray fetch fires on the reveal path.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import SessionTree from "../../src/components/SessionTree";
import {
  seedTreeStore,
  resetTreeStore,
  resetExpandedForTest,
  setUserNodeExpanded,
} from "../../src/sync/treeState";
import { selectedId as selectedIdSig, setSelectedIdRaw } from "../../src/sync/store";
import type { TreeNode } from "../../src/sync/treeMap";

// Mock ONLY expandTreeNode (the fetch entrypoint) on the barrel; everything else
// (selectedId/state, the real treeState store, selectors) stays live. Mirrors
// tree2Flood.test.tsx so the assert-no-fetch guarantee holds.
const { expandSpy } = vi.hoisted(() => ({ expandSpy: vi.fn() }));
vi.mock("../../src/sync", async (importActual) => {
  const actual = await importActual();
  return { ...actual, expandTreeNode: expandSpy };
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

function renderedIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".tree-node[data-session-id]")].map((el) =>
    el.getAttribute("data-session-id")!,
  );
}

beforeEach(() => {
  localStorage.clear();
  resetTreeStore();
  resetExpandedForTest();
  // Clear any selection left by a prior case so the reveal signal is clean.
  setSelectedIdRaw(null);
  expandSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("P0-C — active parent renders only its busy child (per-child gate, not the flood)", () => {
  //   ROOT (idle, root)              ← on active path (has busy grandchild)
  //   └─ PARENT (idle)               ← ACTIVE-PARENT CRUX: on active path (has busy child)
  //      ├─ BUSY (activity busy)     ← the one active descendant (seeds the path)
  //      ├─ IDLE1 (idle)             ← idle sibling of the busy branch
  //      └─ IDLE2 (idle)             ← idle sibling of the busy branch
  // PARENT is on the active path (BUSY is its descendant). Under the OLD gate
  // PARENT dumped ALL 3 children (the flood). Under the per-child gate only BUSY
  // renders; IDLE1/IDLE2 stay collapsed behind PARENT's `▸ N`.
  function activeParentMap(): TreeNode[] {
    return [
      node({ id: "ROOT", title: "root", childCount: 1, descendantCount: 4 }),
      node({
        id: "PARENT",
        parentId: "ROOT",
        title: "parent",
        childCount: 3,
        descendantCount: 3,
      }),
      node({ id: "BUSY", parentId: "PARENT", title: "busy", activity: "busy", updatedMs: 30 }),
      node({ id: "IDLE1", parentId: "PARENT", title: "idle1", updatedMs: 20 }),
      node({ id: "IDLE2", parentId: "PARENT", title: "idle2", updatedMs: 10 }),
    ];
  }

  it("an active parent with 1 busy + 2 idle children renders ONLY the busy child (P0-C)", () => {
    seedTreeStore(activeParentMap());
    const { container } = render(() => <SessionTree />);

    const ids = renderedIds(container as unknown as HTMLElement);
    // The active chain (ROOT → PARENT → BUSY) renders.
    expect(ids).toContain("ROOT");
    expect(ids).toContain("PARENT");
    expect(ids).toContain("BUSY");
    // CRUX: the idle siblings of the busy branch do NOT render — the flood is
    // gated per-child, not just per-parent.
    expect(ids).not.toContain("IDLE1");
    expect(ids).not.toContain("IDLE2");
    // No fetch: the active path is already resident (§5 guarantees it).
    expect(expandSpy).not.toHaveBeenCalled();
  });

  it("user-expanding the active parent shows ALL its children (idle siblings included)", () => {
    seedTreeStore(activeParentMap());
    const { container } = render(() => <SessionTree />);

    // Before the user toggle: only BUSY renders (per the previous case).
    let ids = renderedIds(container as unknown as HTMLElement);
    expect(ids).not.toContain("IDLE1");
    expect(ids).not.toContain("IDLE2");

    // User expands PARENT explicitly → the per-child gate shows ALL children.
    setUserNodeExpanded("PARENT", true);

    ids = renderedIds(container as unknown as HTMLElement);
    expect(ids).toContain("BUSY");
    expect(ids).toContain("IDLE1"); // now visible
    expect(ids).toContain("IDLE2"); // now visible
    // Still no fetch: the children were already resident.
    expect(expandSpy).not.toHaveBeenCalled();
  });
});

describe("P0-D — selecting an idle nested session reveals it (ancestor chain opens)", () => {
  //   ROOT (idle, root)
  //   └─ MID (idle)
  //      └─ LEAF (idle)   ← selected
  // Nothing is active. Under the OLD gate neither MID nor LEAF rendered (ROOT
  // collapsed by default; selection never seeded the reveal path). Selecting
  // LEAF must open ROOT → MID so LEAF's row is visible.
  function idleChainMap(): TreeNode[] {
    return [
      node({ id: "ROOT", title: "root", childCount: 1, descendantCount: 2 }),
      node({ id: "MID", parentId: "ROOT", title: "mid", childCount: 1, descendantCount: 1 }),
      node({ id: "LEAF", parentId: "MID", title: "leaf" }),
    ];
  }

  it("selecting an idle nested leaf reveals it (collapsed ancestors open) even with NOTHING active (P0-D)", () => {
    seedTreeStore(idleChainMap());
    // Sanity: with no selection, only the collapsed root renders.
    let { container } = render(() => <SessionTree />);
    expect(renderedIds(container as unknown as HTMLElement)).toEqual(["ROOT"]);

    // Select the idle nested leaf. This must open ROOT → MID so LEAF renders.
    setSelectedIdRaw("LEAF");

    const ids = renderedIds(container as unknown as HTMLElement);
    expect(ids).toContain("ROOT");
    expect(ids).toContain("MID"); // ancestor opened to reveal the selection
    expect(ids).toContain("LEAF"); // the selected leaf is now visible
    // No fetch: the chain was already resident; this is a render-gate reveal.
    expect(expandSpy).not.toHaveBeenCalled();
  });

  it("clearing the selection collapses the revealed idle chain back to the root", () => {
    seedTreeStore(idleChainMap());
    const { container } = render(() => <SessionTree />);

    setSelectedIdRaw("LEAF");
    expect(renderedIds(container as unknown as HTMLElement)).toContain("LEAF");

    // Clear the selection → the idle chain is no longer on any keep-visible
    // path, so it collapses back to just the root (mirrors the un-selected
    // default; nothing is active to keep it open).
    setSelectedIdRaw(null);
    expect(renderedIds(container as unknown as HTMLElement)).toEqual(["ROOT"]);
  });
});
