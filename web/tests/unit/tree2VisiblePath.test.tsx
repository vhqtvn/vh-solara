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
  applyTreeOpStore,
  hasUserToggled,
  treeModeMapSignal,
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

describe("userToggled — clicking a temp ancestor promotes it (idle temp→expanded, working temp→filtered)", () => {
  //   ROOT (collapsed, cold-norm) ← ancestor of selection → temp
  //   └─ LEAF ← selected
  it("an IDLE temp ancestor clicked becomes persisted-expanded + toggled (temp → expanded, NOT filtered)", () => {
    seedTreeStore([
      node({ id: "ROOT", title: "root", childCount: 1, descendantCount: 1, loaded: true }),
      node({ id: "LEAF", parentId: "ROOT", title: "leaf" }),
    ]);
    setSelectedIdRaw("LEAF");
    let { container } = render(() => <SessionTree />);
    // Before click: ROOT is temp (eye glyph). Its persisted mode is cold-normalized
    // to collapsed (idle root, no explicit entry); the temp overlay is computed
    // from the selection path and shows the eye regardless of the persisted mode.
    expect(twistyFor(container as unknown as HTMLElement, "ROOT").querySelector("span.twisty-temp")).not.toBeNull();
    expect(modeOf("ROOT")).toBe("collapsed"); // cold-norm materialized the idle root

    clickTwisty(container as unknown as HTMLElement, "ROOT");

    // After click: an idle temp node promotes to EXPANDED (status-sensitive
    // 2-state cycle — idle never enters "filtered"). ROOT's persisted mode goes
    // collapsed → expanded; the click also marks it toggled, so effectiveTreeMode
    // returns the persisted "expanded" instead of temp → the eye is gone.
    expect(modeOf("ROOT")).toBe("expanded");
    expect(twistyFor(container as unknown as HTMLElement, "ROOT").querySelector("span.twisty-temp")).toBeNull();
    cleanup();
  });

  it("a WORKING temp ancestor clicked becomes persisted-filtered + toggled (temp → filtered, 3-state)", () => {
    // A working node keeps the 3-state cycle: temp → filtered (not expanded).
    seedTreeStore([
      node({ id: "ROOT", title: "root", childCount: 1, descendantCount: 1, loaded: true, activity: "busy" }),
      node({ id: "LEAF", parentId: "ROOT", title: "leaf" }),
    ]);
    setSelectedIdRaw("LEAF");
    const { container } = render(() => <SessionTree />);
    // ROOT is a strict ancestor of LEAF, persisted filtered (absent+working
    // implicit fallback), not toggled → temp (eye).
    expect(twistyFor(container as unknown as HTMLElement, "ROOT").querySelector("span.twisty-temp")).not.toBeNull();
    expect(modeOf("ROOT")).toBe("filtered"); // absent+working → implicit filtered

    clickTwisty(container as unknown as HTMLElement, "ROOT");

    // A working temp click promotes to FILTERED (3-state cycle). ROOT was
    // implicit-filtered; the click materializes it explicitly + marks toggled.
    expect(modeOf("ROOT")).toBe("filtered");
    expect(Object.prototype.hasOwnProperty.call(treeModeMapSignal(), "ROOT")).toBe(true); // now explicit
    expect(twistyFor(container as unknown as HTMLElement, "ROOT").querySelector("span.twisty-temp")).toBeNull();
  });

  it("a real selection change clears userToggled so a temp node re-evaluates from scratch", () => {
    // ROOT must be WORKING so a click promotes temp→filtered (3-state cycle),
    // keeping the persisted mode non-expanded — temp CAN return after userToggled
    // clears. Under the absolute invariant, an idle click goes temp→expanded, and
    // expanded can never be temp again, so this test exercises the working case.
    seedTreeStore([
      node({ id: "ROOT", title: "root", childCount: 1, descendantCount: 2, loaded: true, activity: "busy" }),
      node({ id: "MID", parentId: "ROOT", title: "mid", childCount: 1 }),
      node({ id: "LEAF", parentId: "MID", title: "leaf" }),
      node({ id: "OTHER", title: "other" }),
    ]);
    setSelectedIdRaw("LEAF");
    const { container } = render(() => <SessionTree />);
    // ROOT is temp (eye) — strict ancestor of LEAF, implicit filtered (working),
    // not toggled. Click it → promoted (working temp→filtered, toggled, no eye).
    clickTwisty(container as unknown as HTMLElement, "ROOT");
    expect(twistyFor(container as unknown as HTMLElement, "ROOT").querySelector("span.twisty-temp")).toBeNull();

    // A real selection change via the CANONICAL setter (setSelectedId) clears
    // userToggled synchronously. Re-select LEAF → ROOT is again a strict
    // ancestor, not toggled, persisted non-expanded (filtered) → temp returns.
    setSelectedId("OTHER");
    setSelectedId("LEAF");
    expect(twistyFor(container as unknown as HTMLElement, "ROOT").querySelector("span.twisty-temp")).not.toBeNull();
  });
});

// auto-mutation — temp/userToggled independence.
//
// Auto-mutation touches ONLY the persisted mode. A finishing selected-ancestor
// keeps showing temp/eye (overlay) until selection changes — auto-demoting its
// persisted filtered→collapsed does NOT collapse the eye, because temp is
// computed from the selection path, not the persisted mode. userToggled is never
// marked/cleared by auto-mutation. After selection changes, the new persisted
// collapsed becomes visible. A manually user-toggled ancestor follows the
// existing overlay rules independently of auto-mutation.
describe("auto-mutation — temp/userToggled independence", () => {
  //   ROOT (root, idle) — set explicit expanded so A renders even after the
  //   │     selection leaves A's subtree (otherwise ROOT collapses and A's row
  //   │     disappears, making the glyph unobservable).
  //   └─ A (starts WORKING + explicit filtered; the ancestor under test)
  //      └─ LEAF ← selected (A is a strict ancestor → A is effectively temp)
  //   OTHER (a separate root; the selection-change target)
  function ancestorChain(): TreeNode[] {
    return [
      node({ id: "ROOT", title: "root", childCount: 1, descendantCount: 2, loaded: true }),
      node({
        id: "A",
        parentId: "ROOT",
        title: "a",
        childCount: 1,
        descendantCount: 1,
        loaded: true,
        activity: "busy",
      }),
      node({ id: "LEAF", parentId: "A", title: "leaf" }),
      node({ id: "OTHER", title: "other", childCount: 0, loaded: true }),
    ];
  }

  it("a selected ancestor is effectively temp (eye) while working", () => {
    seedTreeStore(ancestorChain());
    // A starts working (busy); cold-norm leaves it absent (filtered fallback).
    // Set explicit filtered so the later demotion edge can fire against it.
    setNodeMode("ROOT", "expanded");
    setNodeMode("A", "filtered");
    setSelectedIdRaw("LEAF");
    const { container } = render(() => <SessionTree />);
    // A is a strict ancestor of LEAF, persisted filtered, not toggled → temp.
    expect(twistyFor(container as unknown as HTMLElement, "A").querySelector("span.twisty-temp")).not.toBeNull();
    expect(modeOf("A")).toBe("filtered");
  });

  it("a working→idle edge demotes persisted filtered→collapsed but the effective state stays temp (eye)", async () => {
    seedTreeStore(ancestorChain());
    setNodeMode("ROOT", "expanded");
    setNodeMode("A", "filtered");
    setSelectedIdRaw("LEAF");
    const { container } = render(() => <SessionTree />);
    // A is temp (eye) while working + filtered.
    expect(twistyFor(container as unknown as HTMLElement, "A").querySelector("span.twisty-temp")).not.toBeNull();

    // Store ingestion: A flips working true→false (activity busy→idle).
    applyTreeOpStore({ op: "node.facet", data: { id: "A", activity: "idle" } });
    await new Promise((r) => setTimeout(r, 0)); // flush the candidate

    // Persisted mode auto-demoted filtered→collapsed.
    expect(modeOf("A")).toBe("collapsed");
    // BUT A is still a strict ancestor of the selected LEAF → effectiveTreeMode
    // returns temp regardless of the persisted collapse. The eye stays (no flicker).
    expect(twistyFor(container as unknown as HTMLElement, "A").querySelector("span.twisty-temp")).not.toBeNull();
  });

  it("auto-mutation does NOT add/remove/clear userToggled", async () => {
    seedTreeStore(ancestorChain());
    setNodeMode("ROOT", "expanded");
    setNodeMode("A", "filtered");
    setSelectedIdRaw("LEAF");
    render(() => <SessionTree />);
    expect(hasUserToggled("A")).toBe(false);

    applyTreeOpStore({ op: "node.facet", data: { id: "A", activity: "idle" } });
    await new Promise((r) => setTimeout(r, 0));

    // The auto-demote touched ONLY the persisted mode — userToggled is untouched.
    expect(hasUserToggled("A")).toBe(false);
    expect(modeOf("A")).toBe("collapsed");
  });

  it("after selection changes, the new persisted collapsed becomes visible (eye gone)", async () => {
    seedTreeStore(ancestorChain());
    setNodeMode("ROOT", "expanded");
    setNodeMode("A", "filtered");
    setSelectedIdRaw("LEAF");
    const { container } = render(() => <SessionTree />);
    applyTreeOpStore({ op: "node.facet", data: { id: "A", activity: "idle" } });
    await new Promise((r) => setTimeout(r, 0));
    // While LEAF is selected, A is temp (eye) despite persisted collapsed.
    expect(twistyFor(container as unknown as HTMLElement, "A").querySelector("span.twisty-temp")).not.toBeNull();

    // Select a node NOT under A (OTHER is a separate root). A is no longer a
    // strict ancestor → effective = persisted collapsed → the eye is gone
    // (collapsed chevron). ROOT is expanded (persisted) so A's row still renders.
    setSelectedId("OTHER");
    expect(twistyFor(container as unknown as HTMLElement, "A").querySelector("span.twisty-temp")).toBeNull();
    expect(modeOf("A")).toBe("collapsed");
  });

  it("a manually user-toggled ancestor follows the existing overlay rules (auto-mutation independent)", async () => {
    seedTreeStore(ancestorChain());
    setNodeMode("ROOT", "expanded");
    setNodeMode("A", "filtered");
    setSelectedIdRaw("LEAF");
    const { container } = render(() => <SessionTree />);
    // Click A → temp→filtered (working 3-state); A is now toggled, so effective
    // reflects the persisted filtered (chevron), not temp (eye).
    clickTwisty(container as unknown as HTMLElement, "A");
    expect(hasUserToggled("A")).toBe(true);
    expect(modeOf("A")).toBe("filtered");
    expect(twistyFor(container as unknown as HTMLElement, "A").querySelector("span.twisty-temp")).toBeNull();

    // Now flip A working→idle. Persisted filtered→collapsed (auto-demote). The
    // toggled state survives (auto-mutation never clears it); effective reflects
    // the persisted collapsed (not temp).
    applyTreeOpStore({ op: "node.facet", data: { id: "A", activity: "idle" } });
    await new Promise((r) => setTimeout(r, 0));
    expect(modeOf("A")).toBe("collapsed");
    expect(hasUserToggled("A")).toBe(true); // survived the auto-demote
    expect(twistyFor(container as unknown as HTMLElement, "A").querySelector("span.twisty-temp")).toBeNull();
  });
});
