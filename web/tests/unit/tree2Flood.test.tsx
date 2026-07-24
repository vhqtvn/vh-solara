// @vitest-environment jsdom
// tree2Flood — the LOAD-BEARING render-gate crux for the sidebar "flood" fix.
//
// BEFORE: an active (loaded) parent dumped ALL its resident children into the
// sidebar (TreeBranch rendered treeChildrenOf unconditionally). AFTER: a node's
// children STAY resident in the flat map (instant expand, no round-trip) but
// render ONLY when the node is on the ACTIVE PATH (busy/pendingInput descendant)
// OR explicitly user-expanded. Everything else renders COLLAPSED (▸ N twisty).
//
// These tests mount the REAL <SessionTree/> and control the flat map directly
// (deterministic — no SSE timing, unlike the Playwright fork path). expandTreeNode
// (the fetch entrypoint) is mocked so we assert the fetch-skip vs fetch-invoke
// routing decision without a real network round-trip.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import SessionTree from "../../src/components/SessionTree";
import {
  seedTreeStore,
  applyTreeOpStore,
  resetTreeStore,
  resetExpandedForTest,
  setUserNodeExpanded,
  isNodeExpanded,
  treeNode,
} from "../../src/sync/treeState";
import type { TreeNode } from "../../src/sync/treeMap";

// Mock ONLY expandTreeNode (the fetch entrypoint) on the barrel; everything else
// (selectedId/state, the real treeState store, selectors) stays live. Spreading
// `...actual` preserves function-reference exports (signals read live state).
// vi.hoisted() declares the spy so it is available to the hoisted vi.mock
// factory (vi.mock is hoisted above top-level consts — a bare `const` would be
// uninitialized inside the factory).
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

// N resident idle children under `demo` — the flood scenario. demo is a LOADED
// root (the §5 frontier ships direct children of every loaded node), so all N
// children are resident in the map. BEFORE the fix this dumped N+1 rows.
function manyChildRoot(n: number): TreeNode[] {
  const kids: TreeNode[] = [];
  for (let i = 0; i < n; i++) {
    kids.push(node({ id: `c${i}`, parentId: "demo", title: `child ${i}`, updatedMs: 100 + i }));
  }
  return [
    node({ id: "demo", title: "Demo", childCount: n, descendantCount: n, loaded: true, updatedMs: 1000 }),
    ...kids,
  ];
}

function renderedIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".tree-node[data-session-id]")].map((el) =>
    el.getAttribute("data-session-id")!,
  );
}

function twistyFor(container: HTMLElement, id: string): HTMLElement {
  const nodeEl = container.querySelector(`.tree-node[data-session-id="${id}"]`);
  if (!nodeEl) throw new Error(`no rendered node for ${id}`);
  const row = nodeEl.closest(".tree-row");
  const tw = row?.querySelector(".tree-twisty");
  if (!tw) throw new Error(`no twisty for ${id}`);
  return tw as HTMLElement;
}

function clickTwisty(container: HTMLElement, id: string): void {
  twistyFor(container, id).dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

beforeEach(() => {
  localStorage.clear();
  resetTreeStore();
  resetExpandedForTest();
  expandSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("tree2 flood fix — render gate over the resident flat map", () => {
  // HEADLINE: an idle loaded root with N resident children renders ONLY itself
  // (collapsed ▸ N) by default — NOT all N children. BEFORE the fix this was the
  // flood (N+1 rows). The children stay resident (instant expand, no fetch).
  it("an idle loaded root with N resident children renders collapsed (1 row, not N+1)", () => {
    const N = 8;
    seedTreeStore(manyChildRoot(N));
    const { container } = render(() => <SessionTree />);

    const ids = renderedIds(container as unknown as HTMLElement);
    // Only `demo` renders (collapsed). None of its 8 resident children render.
    expect(ids).toEqual(["demo"]);
    expect(ids).not.toContain("c0");
    // The children ARE resident in the flat map (the gate is render-only).
    for (let i = 0; i < N; i++) expect(treeNode(`c${i}`)).toBeDefined();
    // demo shows the collapsed twisty (Expand, not Collapse) + a ▸ N badge.
    const demoRow = (container as unknown as HTMLElement).querySelector(
      `.tree-node[data-session-id="demo"]`,
    )!;
    expect(demoRow.querySelector(".tree-count")?.textContent).toContain("▸");
    expect(demoRow.closest(".tree-row")?.querySelector(".tree-twisty")?.getAttribute("aria-label")).toBe("Expand");
  });

  // User-expanding an idle root with ALREADY-RESIDENT children shows them with NO
  // server round-trip (expandTreeNode must NOT be invoked — the children are in
  // the map). This is the "instant expand" half of the contract.
  it("user-expanding an idle root with resident children shows them with NO fetch", () => {
    const N = 5;
    seedTreeStore(manyChildRoot(N));
    const { container } = render(() => <SessionTree />);

    // Initially collapsed.
    expect(renderedIds(container as unknown as HTMLElement)).toEqual(["demo"]);

    // Expand via the twisty (exercises the real onToggle routing).
    clickTwisty(container as unknown as HTMLElement, "demo");

    // All N children now render.
    const ids = renderedIds(container as unknown as HTMLElement);
    expect(ids).toContain("demo");
    for (let i = 0; i < N; i++) expect(ids).toContain(`c${i}`);
    // CRUX: NO fetch — the children were already resident.
    expect(expandSpy).not.toHaveBeenCalled();
  });

  // Expanding a genuinely-UNLOADED node (loaded:false, no resident children, but
  // descendantCount>0) DOES invoke the fetch entrypoint — the only case that
  // needs a server round-trip.
  it("user-expanding an unloaded root with descendants invokes the fetch", () => {
    seedTreeStore([
      node({ id: "demo", title: "Demo", loaded: false, childCount: 2, descendantCount: 2 }),
    ]);
    const { container } = render(() => <SessionTree />);

    clickTwisty(container as unknown as HTMLElement, "demo");
    expect(expandSpy).toHaveBeenCalledTimes(1);
    expect(expandSpy).toHaveBeenCalledWith("demo");
  });

  // CRUX of "render gate, not map drop": user-collapsing an expanded idle root
  // hides its children from RENDER but they REMAIN in the flat map. The OLD
  // fetch-collapse dropped them + flipped loaded:false; the new UI toggle must
  // not touch the map (so a re-expand is instant).
  it("user-collapse hides children from render but KEEPS them in the flat map", () => {
    const N = 3;
    seedTreeStore(manyChildRoot(N));
    const { container } = render(() => <SessionTree />);

    // Expand, then collapse again.
    clickTwisty(container as unknown as HTMLElement, "demo");
    expect(renderedIds(container as unknown as HTMLElement)).toContain("c0");
    clickTwisty(container as unknown as HTMLElement, "demo"); // collapse

    // Children DISAPPEAR from render...
    const ids = renderedIds(container as unknown as HTMLElement);
    expect(ids).toEqual(["demo"]);
    // ...but REMAIN resident in the flat map.
    for (let i = 0; i < N; i++) {
      expect(treeNode(`c${i}`)).toBeDefined();
      expect(treeNode(`c${i}`)?.loaded).toBe(true); // loaded flag untouched
    }
  });

  // Active-path auto-expand: a root with a busy descendant renders expanded
  // (the chain to live work stays visible) WITHOUT the user toggling anything,
  // and WITHOUT a fetch (§5 guarantees the active path is shipped resident).
  //
  // BEHAVIOR (P0-C per-child gate): an active-path parent renders ONLY its
  // keep-visible children (the busy branch). Idle SIBLINGS of the chain (b, c)
  // do NOT render either — they collapse behind the active root's "▸ N" twisty.
  // (Under the OLD per-parent gate an active root dumped ALL its direct children
  // as collapsed rows; the per-child gate stops the flood at idle siblings too,
  // not just idle subtrees.) User-expanding the root would show b + c as well.
  it("active path auto-expands the chain to a busy descendant; idle siblings + subtrees stay collapsed", () => {
    seedTreeStore([
      node({ id: "root", title: "Root", childCount: 3, descendantCount: 5, loaded: true }),
      // active chain branch
      node({ id: "a", parentId: "root", title: "A", childCount: 2, loaded: true }),
      node({ id: "busy1", parentId: "a", title: "busy", activity: "busy" }),
      // idle branch with its OWN resident children (would flood under the old model)
      node({ id: "b", parentId: "root", title: "B", childCount: 1, loaded: true }),
      node({ id: "deepb", parentId: "b", title: "deep-b" }),
      // idle leaf sibling
      node({ id: "c", parentId: "root", title: "C" }),
    ]);
    const { container } = render(() => <SessionTree />);

    const ids = renderedIds(container as unknown as HTMLElement);
    // root + a + busy1: the active chain. The per-child gate renders ONLY the
    // busy branch under the active-path root.
    expect(ids).toContain("root");
    expect(ids).toContain("a");
    expect(ids).toContain("busy1");
    // P0-C CRUX: b and c (idle DIRECT children of the active root) are off the
    // keep-visible path and root is NOT user-expanded → they do NOT render.
    // They collapse behind root's "▸ N" twisty (the flood stops at idle
    // siblings, not just idle subtrees).
    expect(ids).not.toContain("b");
    expect(ids).not.toContain("c");
    // deepb is resident but NOT rendered — b (its parent) does not even render.
    expect(ids).not.toContain("deepb");
    // All three idle nodes ARE still resident in the flat map (render-only gate).
    expect(treeNode("b")).toBeDefined();
    expect(treeNode("c")).toBeDefined();
    expect(treeNode("deepb")).toBeDefined();
    // No fetch fired (the active path is already resident).
    expect(expandSpy).not.toHaveBeenCalled();
  });

  // Default state: a freshly-seeded tree with no userExpanded and no active
  // nodes → every root collapsed (children resident but not rendered).
  it("default state: a freshly-seeded idle tree renders all roots collapsed", () => {
    seedTreeStore([
      node({ id: "r1", title: "R1", childCount: 2, loaded: true }),
      node({ id: "r1c", parentId: "r1", title: "r1c" }),
      node({ id: "r2", title: "R2", childCount: 0, loaded: true }),
    ]);
    const { container } = render(() => <SessionTree />);
    // Only the roots render; r1's child does not.
    expect(renderedIds(container as unknown as HTMLElement).sort()).toEqual(["r1", "r2"]);
  });
});

describe("tree2 flood fix — userExpanded (in-memory UI state)", () => {
  // The user expand-toggle is IN-MEMORY session state (not persisted to
  // localStorage): it survives every tree mutation within a session but a fresh
  // load starts collapsed. This keeps it compatible with the cold-load frontier
  // (§5 ships a node collapsed; a persisted "open" would claim it open with no
  // resident children — a broken half-state that inverts the first toggle).
  it("survives an incremental tree op (separate signal) and is cleared by resetExpandedForTest", () => {
    seedTreeStore(manyChildRoot(3));
    setUserNodeExpanded("demo", true);
    expect(isNodeExpanded("demo")).toBe(true);

    // An unrelated tree mutation must NOT clear the user toggle.
    applyTreeOpStore({
      op: "node.upsert",
      data: { node: node({ id: "c0", parentId: "demo", title: "child 0 patched", updatedMs: 999 }) },
    });
    expect(isNodeExpanded("demo")).toBe(true);

    // resetExpandedForTest clears it (mirrors the fresh-load default).
    resetExpandedForTest();
    expect(isNodeExpanded("demo")).toBe(false);
  });

  it("a stale expanded id (not resident in the map) is silently ignored on render", () => {
    // Toggle a node that is NOT in the map; do NOT reset (so it stays expanded
    // in-memory — the real contract for a stale id post-toggle).
    setUserNodeExpanded("ghost", true);
    expect(isNodeExpanded("ghost")).toBe(true);
    // Seed a tree WITHOUT ghost.
    seedTreeStore(manyChildRoot(2));
    const { container } = render(() => <SessionTree />);

    // ghost renders no row (it's not resident); no crash; the live tree is
    // unaffected (demo still collapsed by default).
    const ids = renderedIds(container as unknown as HTMLElement);
    expect(ids).not.toContain("ghost");
    expect(ids).toContain("demo");
  });
});
