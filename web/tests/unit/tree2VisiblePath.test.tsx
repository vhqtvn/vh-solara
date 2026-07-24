// @vitest-environment jsdom
// tree2VisiblePath — the per-mode visibility matrix + the P0-D selection reveal
// (temp overlay) for the proj=1 4-state twisty model.
//
// visibleKids has EXACTLY four branches:
//   collapsed — renders no children (even working ones).
//   filtered  — renders only working children (busy/retry/subtreeBusy/
//               subtreeNeedsInput). This is the DEFAULT.
//   temp      — renders exactly ONE child: the next step toward the selection.
//   expanded  — renders ALL children, working-first (stable partition).
// Roots render regardless of their mode (the top-level list always shows roots).
//
// These mount the REAL <SessionTree/> and drive the flat map + selection + modes
// directly (deterministic — no SSE timing). expandTreeNode is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import SessionTree from "../../src/components/SessionTree";
import {
  seedTreeStore,
  resetTreeStore,
  resetExpandedForTest,
  modeOf,
  setNodeMode,
} from "../../src/sync/treeState";
import { setSelectedIdRaw } from "../../src/sync/store";
import { setSelectedId } from "../../src/sync/actions";
import type { TreeNode } from "../../src/sync/treeMap";

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

describe("visibleKids — per-mode visibility matrix", () => {
  //   PARENT (the node under test)
  //   ├─ BUSY   (activity busy)            ← working
  //   ├─ RETRY  (activity retry)           ← working
  //   ├─ SUBBUSY (subtreeBusy)             ← working
  //   ├─ IDLE1  (idle)                     ← not working
  //   └─ IDLE2  (idle)                     ← not working
  function parentWithMix(): TreeNode[] {
    return [
      node({ id: "PARENT", title: "parent", childCount: 5, descendantCount: 5, loaded: true }),
      node({ id: "BUSY", parentId: "PARENT", title: "busy", activity: "busy", updatedMs: 50 }),
      node({ id: "RETRY", parentId: "PARENT", title: "retry", activity: "retry", updatedMs: 40 }),
      node({ id: "SUBBUSY", parentId: "PARENT", title: "subbusy", flags: { ...node().flags, subtreeBusy: true }, updatedMs: 30 }),
      node({ id: "IDLE1", parentId: "PARENT", title: "idle1", updatedMs: 20 }),
      node({ id: "IDLE2", parentId: "PARENT", title: "idle2", updatedMs: 10 }),
    ];
  }

  it("collapsed → renders NO children (even working ones)", () => {
    seedTreeStore(parentWithMix());
    setNodeMode("PARENT", "collapsed");
    const { container } = render(() => <SessionTree />);
    expect(renderedIds(container as unknown as HTMLElement)).toEqual(["PARENT"]);
  });

  it("filtered → renders ONLY working children (busy/retry/subtreeBusy)", () => {
    seedTreeStore(parentWithMix());
    // filtered is the default, but set it explicitly for clarity.
    setNodeMode("PARENT", "filtered");
    const { container } = render(() => <SessionTree />);
    const ids = renderedIds(container as unknown as HTMLElement);
    expect(ids).toContain("PARENT");
    expect(ids).toContain("BUSY");
    expect(ids).toContain("RETRY");
    expect(ids).toContain("SUBBUSY");
    expect(ids).not.toContain("IDLE1");
    expect(ids).not.toContain("IDLE2");
  });

  it("expanded → renders ALL children, working-first (stable partition)", () => {
    seedTreeStore(parentWithMix());
    setNodeMode("PARENT", "expanded");
    const { container } = render(() => <SessionTree />);
    const ids = renderedIds(container as unknown as HTMLElement);
    expect(ids).toContain("PARENT");
    // All five children render.
    expect(ids).toContain("BUSY");
    expect(ids).toContain("RETRY");
    expect(ids).toContain("SUBBUSY");
    expect(ids).toContain("IDLE1");
    expect(ids).toContain("IDLE2");
    // Working-first ordering: BUSY/RETRY/SUBBUSY precede IDLE1/IDLE2. Sibling
    // order is preserved within each group (recency: RETRY before SUBBUSY? no —
    // recency is the resident-child sort, applied BEFORE the partition, so the
    // working group keeps recency order among themselves).
    const workingGroup = ids.slice(ids.indexOf("PARENT") + 1, ids.indexOf("PARENT") + 1 + 3);
    const idleGroup = ids.slice(ids.indexOf("PARENT") + 1 + 3);
    expect(new Set(workingGroup)).toEqual(new Set(["BUSY", "RETRY", "SUBBUSY"]));
    expect(new Set(idleGroup)).toEqual(new Set(["IDLE1", "IDLE2"]));
  });

  it("temp → renders EXACTLY ONE child: the next step toward the selection", () => {
    // Make PARENT a strict ancestor of a selected node. Select RETRY (a direct
    // child of PARENT) — PARENT becomes temp and reveals exactly RETRY.
    seedTreeStore(parentWithMix());
    setSelectedIdRaw("RETRY");
    const { container } = render(() => <SessionTree />);
    const ids = renderedIds(container as unknown as HTMLElement);
    expect(ids).toContain("PARENT");
    expect(ids).toContain("RETRY"); // the one path child
    // The other children (working OR idle) do NOT render under temp — temp
    // reveals exactly ONE path child, not all working children.
    expect(ids).not.toContain("BUSY");
    expect(ids).not.toContain("SUBBUSY");
    expect(ids).not.toContain("IDLE1");
    expect(ids).not.toContain("IDLE2");
  });

  it("roots render regardless of their mode (collapsed root still shows its row)", () => {
    seedTreeStore(parentWithMix());
    setNodeMode("PARENT", "collapsed");
    const { container } = render(() => <SessionTree />);
    // PARENT is a root and renders even though collapsed.
    expect(renderedIds(container as unknown as HTMLElement)).toContain("PARENT");
  });
});

describe("P0-D — selecting an idle nested session reveals it (temp ancestor chain)", () => {
  //   ROOT (idle, root)
  //   └─ MID (idle)
  //      └─ LEAF (idle)   ← selected
  // Nothing is working. Under filtered mode nothing renders its children. The
  // temp overlay opens the selected chain so LEAF is reachable.
  function idleChainMap(): TreeNode[] {
    return [
      node({ id: "ROOT", title: "root", childCount: 1, descendantCount: 2 }),
      node({ id: "MID", parentId: "ROOT", title: "mid", childCount: 1, descendantCount: 1 }),
      node({ id: "LEAF", parentId: "MID", title: "leaf" }),
    ];
  }

  it("selecting an idle nested leaf reveals it (temp ancestors open) even with NOTHING working", () => {
    seedTreeStore(idleChainMap());
    // Sanity: with no selection, only the root renders (filtered, no working).
    let { container } = render(() => <SessionTree />);
    expect(renderedIds(container as unknown as HTMLElement)).toEqual(["ROOT"]);
    cleanup();

    // Select the idle nested leaf → ROOT and MID become temp, revealing LEAF.
    setSelectedIdRaw("LEAF");
    container = render(() => <SessionTree />).container as unknown as HTMLElement;
    const ids = renderedIds(container);
    expect(ids).toContain("ROOT");
    expect(ids).toContain("MID"); // temp → reveals LEAF
    expect(ids).toContain("LEAF");
    expect(expandSpy).not.toHaveBeenCalled(); // chain already resident
  });

  it("clearing the selection collapses the revealed idle chain back to the root", () => {
    seedTreeStore(idleChainMap());
    setSelectedIdRaw("LEAF");
    const { container } = render(() => <SessionTree />);
    expect(renderedIds(container as unknown as HTMLElement)).toContain("LEAF");

    setSelectedIdRaw(null);
    // No selection → no temp overlay → filtered shows no working children → root only.
    expect(renderedIds(container as unknown as HTMLElement)).toEqual(["ROOT"]);
  });

  it("temp ancestors show the eye glyph (.twisty-temp)", () => {
    seedTreeStore(idleChainMap());
    setSelectedIdRaw("LEAF");
    const { container } = render(() => <SessionTree />);
    // ROOT and MID are temp (strict ancestors of LEAF) → eye glyph.
    expect(twistyFor(container as unknown as HTMLElement, "ROOT").querySelector("span.twisty-temp")).not.toBeNull();
    expect(twistyFor(container as unknown as HTMLElement, "MID").querySelector("span.twisty-temp")).not.toBeNull();
    // LEAF is the selected node itself (not a strict ancestor) → NOT temp.
    expect(twistyFor(container as unknown as HTMLElement, "LEAF").querySelector("span.twisty-temp")).toBeNull();
  });
});

describe("userToggled — clicking a temp ancestor promotes it (temp → filtered)", () => {
  //   ROOT (filtered default) ← ancestor of selection → temp
  //   └─ LEAF ← selected
  it("a temp ancestor clicked becomes persisted-filtered + toggled (no longer temp)", () => {
    seedTreeStore([
      node({ id: "ROOT", title: "root", childCount: 1, descendantCount: 1, loaded: true }),
      node({ id: "LEAF", parentId: "ROOT", title: "leaf" }),
    ]);
    setSelectedIdRaw("LEAF");
    let { container } = render(() => <SessionTree />);
    // Before click: ROOT is temp (eye glyph).
    expect(twistyFor(container as unknown as HTMLElement, "ROOT").querySelector("span.twisty-temp")).not.toBeNull();
    expect(modeOf("ROOT")).toBe("filtered"); // persisted unchanged

    clickTwisty(container as unknown as HTMLElement, "ROOT");

    // After click: ROOT is persisted-filtered (unchanged value) BUT now toggled,
    // so effectiveTreeMode returns the persisted "filtered" instead of temp → the
    // eye is gone (chevron renders). The persisted mode survived; the overlay was
    // promoted by the click.
    expect(modeOf("ROOT")).toBe("filtered");
    expect(twistyFor(container as unknown as HTMLElement, "ROOT").querySelector("span.twisty-temp")).toBeNull();
    cleanup();
  });

  it("a real selection change clears userToggled so a temp node re-evaluates from scratch", () => {
    seedTreeStore([
      node({ id: "ROOT", title: "root", childCount: 1, descendantCount: 2, loaded: true }),
      node({ id: "MID", parentId: "ROOT", title: "mid", childCount: 1 }),
      node({ id: "LEAF", parentId: "MID", title: "leaf" }),
      node({ id: "OTHER", title: "other" }),
    ]);
    setSelectedIdRaw("LEAF");
    const { container } = render(() => <SessionTree />);
    // ROOT is temp (eye). Click it → promoted (toggled, no longer temp).
    clickTwisty(container as unknown as HTMLElement, "ROOT");
    expect(twistyFor(container as unknown as HTMLElement, "ROOT").querySelector("span.twisty-temp")).toBeNull();

    // A real selection change via the CANONICAL setter (setSelectedId) clears
    // userToggled synchronously. Re-select LEAF → ROOT is again a strict
    // ancestor, not toggled → temp returns (eye reappears).
    setSelectedId("OTHER");
    setSelectedId("LEAF");
    expect(twistyFor(container as unknown as HTMLElement, "ROOT").querySelector("span.twisty-temp")).not.toBeNull();
  });
});
