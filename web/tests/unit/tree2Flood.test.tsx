// @vitest-environment jsdom
// tree2Flood — the 4-state twisty model crux for the sidebar flood fix +
// click transitions + cascade + lazy frontier.
//
// The DEFAULT mode is "filtered": a node renders only its WORKING children
// (busy/retry/subtreeBusy/subtreeNeedsInput). An idle many-child parent renders
// collapsed (▸ N) by default — NOT all N children. Children STAY resident in the
// flat map (instant expand, no round-trip) but render only per the effective
// display mode. The server-computed `subtreeBusy` rollup is what reveals a busy
// branch under an idle ancestor in filtered mode (the test fixtures set it,
// mirroring real server data).
//
// These mount the REAL <SessionTree/> and drive the flat map + modes directly
// (deterministic — no SSE timing). expandTreeNode (the fetch entrypoint) is
// mocked so we assert the lazy-frontier fetch decision without a real round-trip.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import SessionTree from "../../src/components/SessionTree";
import {
  seedTreeStore,
  resetTreeStore,
  resetExpandedForTest,
  modeOf,
  setNodeMode,
  hasUserToggled,
  treeNode,
} from "../../src/sync/treeState";
import { setSelectedIdRaw } from "../../src/sync/store";
import type { TreeNode } from "../../src/sync/treeMap";

// Mock ONLY expandTreeNode (the fetch entrypoint) on the barrel; everything else
// (selectedId/state, the real treeState store, selectors) stays live.
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
      subtreeBusy: false,
      permission: false,
      archived: false,
      orphan: false,
    },
    updatedMs: 1,
    ...overrides,
  };
}

// N resident idle children under `demo` — the flood scenario. demo is a LOADED
// root, so all N children are resident. BEFORE the fix this dumped N+1 rows.
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
  setSelectedIdRaw(null);
  expandSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("flood fix — filtered default hides idle children (render gate over the resident flat map)", () => {
  // HEADLINE: an idle loaded root with N resident children renders ONLY itself
  // (filtered shows no working children) — NOT all N children. The children
  // stay resident (instant expand, no fetch).
  it("an idle loaded root with N resident children renders collapsed (1 row, not N+1)", () => {
    const N = 8;
    seedTreeStore(manyChildRoot(N));
    const { container } = render(() => <SessionTree />);

    const ids = renderedIds(container as unknown as HTMLElement);
    expect(ids).toEqual(["demo"]);
    expect(ids).not.toContain("c0");
    // The children ARE resident in the flat map (the gate is render-only).
    for (let i = 0; i < N; i++) expect(treeNode(`c${i}`)).toBeDefined();
    // demo shows the collapsed twisty (Expand) + a ▸ N badge (filtered state).
    const demoRow = (container as unknown as HTMLElement).querySelector(
      `.tree-node[data-session-id="demo"]`,
    )!;
    expect(demoRow.querySelector(".tree-count")?.textContent).toContain("▸");
    expect(demoRow.closest(".tree-row")?.querySelector(".tree-twisty")?.getAttribute("aria-label")).toBe("Expand");
    // demo is loaded → no lazy-frontier fetch.
    expect(expandSpy).not.toHaveBeenCalled();
  });

  // Roots render regardless of their mode (the top-level list always shows every
  // root row). Default state: a freshly-seeded idle tree renders all roots.
  it("default state: a freshly-seeded idle tree renders all roots collapsed", () => {
    seedTreeStore([
      node({ id: "r1", title: "R1", childCount: 2, loaded: true }),
      node({ id: "r1c", parentId: "r1", title: "r1c" }),
      node({ id: "r2", title: "R2", childCount: 0, loaded: true }),
    ]);
    const { container } = render(() => <SessionTree />);
    expect(renderedIds(container as unknown as HTMLElement).sort()).toEqual(["r1", "r2"]);
  });

  // A busy branch is revealed under filtered mode ONLY when the ancestor carries
  // the server-computed subtreeBusy rollup (the rollup an idle ancestor of a
  // busy descendant has in real data). Without it, filtered hides the idle
  // ancestor too.
  it("a busy branch renders under filtered mode when ancestors carry subtreeBusy", () => {
    seedTreeStore([
      node({ id: "root", title: "Root", childCount: 1, descendantCount: 2, loaded: true, flags: { ...node().flags, subtreeBusy: true } }),
      node({ id: "a", parentId: "root", title: "A", childCount: 1, loaded: true, flags: { ...node().flags, subtreeBusy: true } }),
      node({ id: "busy1", parentId: "a", title: "busy", activity: "busy" }),
      // idle sibling of `a` — not working, not revealed by filtered.
      node({ id: "b", parentId: "root", title: "B", childCount: 1, loaded: true }),
      node({ id: "deepb", parentId: "b", title: "deep-b" }),
    ]);
    const { container } = render(() => <SessionTree />);
    const ids = renderedIds(container as unknown as HTMLElement);
    expect(ids).toContain("root");
    expect(ids).toContain("a");
    expect(ids).toContain("busy1");
    // idle siblings stay collapsed behind filtered (no flood).
    expect(ids).not.toContain("b");
    expect(ids).not.toContain("deepb");
    expect(treeNode("b")).toBeDefined(); // still resident
    expect(expandSpy).not.toHaveBeenCalled();
  });
});

describe("click transitions — the proj=1 4-state table", () => {
  // Every click marks the CLICKED id in userToggled; the transition does NOT
  // depend on visibleKids().length.
  it("filtered (default) → click → expanded (no fetch, children already resident)", () => {
    seedTreeStore(manyChildRoot(3));
    const { container } = render(() => <SessionTree />);
    expect(modeOf("demo")).toBe("filtered");

    clickTwisty(container as unknown as HTMLElement, "demo");

    expect(modeOf("demo")).toBe("expanded");
    // All children now render (working-first, but all idle → original order).
    const ids = renderedIds(container as unknown as HTMLElement);
    expect(ids).toContain("demo");
    for (let i = 0; i < 3; i++) expect(ids).toContain(`c${i}`);
    expect(expandSpy).not.toHaveBeenCalled(); // resident, no fetch
  });

  it("expanded → click → collapsed (children hidden from render, kept in map)", () => {
    seedTreeStore(manyChildRoot(3));
    setNodeMode("demo", "expanded");
    const { container } = render(() => <SessionTree />);
    expect(modeOf("demo")).toBe("expanded");

    clickTwisty(container as unknown as HTMLElement, "demo");

    expect(modeOf("demo")).toBe("collapsed");
    // collapsed renders no children.
    expect(renderedIds(container as unknown as HTMLElement)).toEqual(["demo"]);
    // children still resident in the map.
    for (let i = 0; i < 3; i++) expect(treeNode(`c${i}`)).toBeDefined();
  });

  it("collapsed → click → filtered + cascadeFiltered (resident subtree → filtered)", () => {
    seedTreeStore([
      node({ id: "root", title: "Root", childCount: 1, descendantCount: 2, loaded: true }),
      node({ id: "mid", parentId: "root", title: "Mid", childCount: 1, loaded: true }),
      node({ id: "leaf", parentId: "mid", title: "Leaf" }),
    ]);
    setNodeMode("root", "collapsed");
    setNodeMode("mid", "expanded"); // will be overwritten by the cascade
    const { container } = render(() => <SessionTree />);

    clickTwisty(container as unknown as HTMLElement, "root");

    expect(modeOf("root")).toBe("filtered");
    // cascade: the whole resident subtree is now filtered.
    expect(modeOf("mid")).toBe("filtered");
    expect(modeOf("leaf")).toBe("filtered");
  });

  it("temp → click → filtered + cascadeFiltered (selected-session ancestor promoted)", () => {
    //   ROOT (filtered default)
    //   └─ MID (filtered default)       ← ancestor of the selection → temp
    //      └─ LEAF (filtered default)   ← selected
    seedTreeStore([
      node({ id: "ROOT", title: "Root", childCount: 1, descendantCount: 2, loaded: true }),
      node({ id: "MID", parentId: "ROOT", title: "Mid", childCount: 1, loaded: true }),
      node({ id: "LEAF", parentId: "MID", title: "Leaf" }),
    ]);
    setSelectedIdRaw("LEAF");
    const { container } = render(() => <SessionTree />);

    // ROOT is a strict ancestor of LEAF, persisted filtered, not toggled → temp.
    // (Sanity: the eye glyph renders before the click.)
    expect(twistyFor(container as unknown as HTMLElement, "ROOT").querySelector("span.twisty-temp")).not.toBeNull();

    clickTwisty(container as unknown as HTMLElement, "ROOT");

    expect(modeOf("ROOT")).toBe("filtered");
    // cascade: resident subtree → filtered.
    expect(modeOf("MID")).toBe("filtered");
    expect(modeOf("LEAF")).toBe("filtered");
  });

  it("every click marks ONLY the clicked id in userToggled (cascade marks modes, not toggled)", () => {
    seedTreeStore([
      node({ id: "root", title: "Root", childCount: 1, descendantCount: 1, loaded: true }),
      node({ id: "child", parentId: "root", title: "Child" }),
    ]);
    const { container } = render(() => <SessionTree />);

    clickTwisty(container as unknown as HTMLElement, "root");

    expect(hasUserToggled("root")).toBe(true);
    expect(hasUserToggled("child")).toBe(false); // cascade did NOT mark the child
  });
});

describe("cascade boundaries — resident-only DFS, overwrites persisted, no fetch", () => {
  it("cascade marks the resident subtree (root + descendants) filtered, overwriting prior modes", () => {
    seedTreeStore([
      node({ id: "r", title: "R", childCount: 1, descendantCount: 2, loaded: true }),
      node({ id: "c1", parentId: "r", title: "C1", childCount: 1, loaded: true }),
      node({ id: "c2", parentId: "c1", title: "C2" }),
    ]);
    // Pre-set conflicting modes to prove the cascade overwrites them.
    setNodeMode("c1", "expanded");
    setNodeMode("c2", "collapsed");
    setNodeMode("r", "collapsed");
    const { container } = render(() => <SessionTree />);

    clickTwisty(container as unknown as HTMLElement, "r"); // collapsed → filtered + cascade

    expect(modeOf("r")).toBe("filtered");
    expect(modeOf("c1")).toBe("filtered"); // overwritten
    expect(modeOf("c2")).toBe("filtered"); // overwritten
    // No fetch: cascade performs NO fetch (lazy frontier is separate).
    expect(expandSpy).not.toHaveBeenCalled();
  });

  it("cascade is resident-only: a non-resident descendant is NOT enumerated (defaults filtered on later fetch)", () => {
    // r is unloaded (c1 not resident) but has descendants to fetch. Set r
    // collapsed, then click → filtered + cascade. The cascade enumerates ONLY r
    // (c1 is not resident). c1's mode is NOT set (absent → default filtered).
    seedTreeStore([node({ id: "r", title: "R", childCount: 1, descendantCount: 1, loaded: false })]);
    setNodeMode("r", "collapsed");
    const { container } = render(() => <SessionTree />);

    clickTwisty(container as unknown as HTMLElement, "r");

    expect(modeOf("r")).toBe("filtered");
    // c1 was never resident → not enumerated by the cascade → no mode entry.
    expect(treeNode("c1")).toBeUndefined();
  });
});

describe("lazy frontier — fetch trigger matrix", () => {
  // The per-branch createEffect fires expandTreeNode when displayState ∈
  // {filtered, expanded, temp} AND unloaded AND has-known-descendants. Collapsed
  // / leaf / loaded never fetch. expandTreeNode's single-flight is the dedup
  // authority (the mock does not implement it, so each render is one call).
  it("filtered + unloaded + descendants → fetch fires on mount", () => {
    seedTreeStore([node({ id: "x", title: "X", childCount: 2, descendantCount: 2, loaded: false })]);
    render(() => <SessionTree />);
    expect(expandSpy).toHaveBeenCalledWith("x");
  });

  it("expanded + unloaded + descendants → fetch fires", () => {
    seedTreeStore([node({ id: "x", title: "X", childCount: 2, descendantCount: 2, loaded: false })]);
    setNodeMode("x", "expanded");
    render(() => <SessionTree />);
    expect(expandSpy).toHaveBeenCalledWith("x");
  });

  it("collapsed + unloaded + descendants → NO fetch", () => {
    seedTreeStore([node({ id: "x", title: "X", childCount: 2, descendantCount: 2, loaded: false })]);
    setNodeMode("x", "collapsed");
    render(() => <SessionTree />);
    expect(expandSpy).not.toHaveBeenCalled();
  });

  it("loaded (resident children) → NO fetch even in filtered", () => {
    seedTreeStore([
      node({ id: "x", title: "X", childCount: 1, descendantCount: 1, loaded: true }),
      node({ id: "c", parentId: "x", title: "C" }),
    ]);
    render(() => <SessionTree />);
    expect(expandSpy).not.toHaveBeenCalled();
  });

  it("leaf (no known descendants) → NO fetch even when unloaded", () => {
    seedTreeStore([node({ id: "x", title: "X", childCount: 0, descendantCount: 0, loaded: false })]);
    render(() => <SessionTree />);
    expect(expandSpy).not.toHaveBeenCalled();
  });

  it("temp + unloaded + descendants → fetch fires (selection reveal fetches the path)", () => {
    //   R (unloaded, has descendants)
    //   └─ ... → selected LEAF somewhere below (not resident, but R is a strict
    //     ancestor of the selected id even if the selected node isn't resident).
    // Select a non-resident id whose chain includes R: strictAncestors walks
    // parentId upward only over RESIDENT nodes, so to make R a strict ancestor we
    // need the selected node resident under R. Use a resident chain.
    seedTreeStore([
      node({ id: "R", title: "R", childCount: 1, descendantCount: 1, loaded: false }),
    ]);
    // R is unloaded — but to be a strict ancestor of the selection, the selected
    // node must be resident and descend from R. R has no resident children here,
    // so selectedPathIds("LEAF") won't include R. Instead, seed R resident with a
    // child and mark R unloaded to trigger the frontier.
    seedTreeStore([
      node({ id: "R", title: "R", childCount: 1, descendantCount: 1, loaded: false }),
      node({ id: "LEAF", parentId: "R", title: "Leaf" }),
    ]);
    setSelectedIdRaw("LEAF");
    render(() => <SessionTree />);
    expect(expandSpy).toHaveBeenCalledWith("R");
  });
});
