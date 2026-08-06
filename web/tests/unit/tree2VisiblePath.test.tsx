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

// ── eye derivation — children-diff semantics (the fix) ─────────────────────────
// The eye shows on a node iff the current selection ALTERS its displayed
// children-list vs its no-selection baseline (childrenForState(displayState) ≠
// childrenForState(persistedMode) by id-set). This REPLACES the old pure-ancestry
// rule (eye ⟺ strict ancestor), which wrongly showed the eye on a filtered
// ancestor whose only working child was the path child (its children-list was
// UNCHANGED by selection). These mount the REAL <SessionTree/> and assert the
// eye on the integrated SessionTree → TreeBranch → showEye → TreeRow path.
//
// Glyph paths (from Icon.tsx) for asserting the rendered glyph, not just "eye
// absent":
//   eye     → M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z   (inside .twisty-temp)
//   filtered → M6 5v14M6 8h11M6 12h5M6 16h11                       (rail-and-bars, bare)
const EYE_PATH = "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z";
const FILTERED_PATH = "M6 5v14M6 8h11M6 12h5M6 16h11";

function glyphPath(twisty: HTMLElement): string | null {
  return twisty.querySelector("svg.icon path")?.getAttribute("d") ?? null;
}

describe("eye derivation — children-diff (not pure ancestry)", () => {
  // CRITERION 1 (the bug case): a filtered ancestor whose ONLY working child is
  // the selected path child → NO eye. Its temp reveal [pathChild] equals its
  // filtered baseline [pathChild]; the selection changed nothing about what it
  // displays. Under the OLD pure-ancestry rule this wrongly showed the eye.
  it("filtered ancestor whose only working child is the path child → NO eye (the fix)", () => {
    seedTreeStore([
      node({ id: "PARENT", title: "parent", childCount: 2, descendantCount: 2, loaded: true, activity: "busy" }),
      node({ id: "PATHCHILD", parentId: "PARENT", title: "path", activity: "busy", updatedMs: 50 }),
      node({ id: "IDLE1", parentId: "PARENT", title: "idle", updatedMs: 10 }),
    ]);
    setSelectedIdRaw("PATHCHILD");
    const { container } = render(() => <SessionTree />);
    // PARENT is a strict ancestor of PATHCHILD, persisted filtered (implicit,
    // working), not toggled → displayState "temp". Its temp reveal is exactly
    // [PATHCHILD], which equals its filtered baseline (PATHCHILD is the only
    // working child) → the selection did NOT alter its children-list → no eye.
    const tw = twistyFor(container as unknown as HTMLElement, "PARENT");
    expect(tw.querySelector("span.twisty-temp")).toBeNull();
    // CRITERION 7: the temp-without-eye node renders the filtered glyph (its
    // persisted-mode glyph), NOT a blank twisty.
    expect(glyphPath(tw)).toBe(FILTERED_PATH);
    // The path child still renders under temp (visibleKids unchanged); the idle
    // sibling does not.
    const ids = renderedIds(container as unknown as HTMLElement);
    expect(ids).toContain("PATHCHILD");
    expect(ids).not.toContain("IDLE1");
  });

  // CRITERION 3: a filtered ancestor with SEVERAL working children, one on the
  // path → eye. Its temp reveal [pathChild] is a strict subset of its filtered
  // baseline [pathChild, otherWorking] → the selection HID a working child.
  it("filtered ancestor with several working children (one on path) → eye", () => {
    seedTreeStore([
      node({ id: "PARENT", title: "parent", childCount: 3, descendantCount: 3, loaded: true, activity: "busy" }),
      node({ id: "WORK_A", parentId: "PARENT", title: "a", activity: "busy", updatedMs: 50 }),
      node({ id: "WORK_B", parentId: "PARENT", title: "b", activity: "busy", updatedMs: 40 }),
      node({ id: "IDLE1", parentId: "PARENT", title: "idle", updatedMs: 10 }),
    ]);
    setSelectedIdRaw("WORK_A");
    const { container } = render(() => <SessionTree />);
    const tw = twistyFor(container as unknown as HTMLElement, "PARENT");
    expect(tw.querySelector("span.twisty-temp")).not.toBeNull();
    expect(glyphPath(tw)).toBe(EYE_PATH);
  });

  // CRITERION 2: a collapsed ancestor on the active path → eye. Its temp reveal
  // [pathChild] differs from its collapsed baseline [] (children went hidden →
  // revealed).
  it("collapsed ancestor on the active path → eye", () => {
    seedTreeStore([
      node({ id: "PARENT", title: "parent", childCount: 1, descendantCount: 1, loaded: true }),
      node({ id: "CHILD", parentId: "PARENT", title: "child", updatedMs: 10 }),
    ]);
    // PARENT is idle; cold-norm materializes it collapsed. Make it explicit so
    // the persisted mode is unambiguous.
    setNodeMode("PARENT", "collapsed");
    setSelectedIdRaw("CHILD");
    const { container } = render(() => <SessionTree />);
    const tw = twistyFor(container as unknown as HTMLElement, "PARENT");
    expect(tw.querySelector("span.twisty-temp")).not.toBeNull();
    expect(glyphPath(tw)).toBe(EYE_PATH);
  });

  // CRITERION 4: an expanded ancestor → never temp, children unchanged → no eye.
  it("expanded ancestor → NO eye (expanded is never overridden to temp)", () => {
    seedTreeStore([
      node({ id: "PARENT", title: "parent", childCount: 2, descendantCount: 2, loaded: true }),
      node({ id: "CHILD", parentId: "PARENT", title: "child", updatedMs: 50 }),
      node({ id: "SIB", parentId: "PARENT", title: "sib", updatedMs: 10 }),
    ]);
    setNodeMode("PARENT", "expanded");
    setSelectedIdRaw("CHILD");
    const { container } = render(() => <SessionTree />);
    const tw = twistyFor(container as unknown as HTMLElement, "PARENT");
    expect(tw.querySelector("span.twisty-temp")).toBeNull();
  });

  // CRITERION 5: with NO session selected there are zero eye icons anywhere
  // (even on collapsed nodes) — nothing differs from the no-selection baseline.
  it("no session selected → NO eye anywhere (including collapsed nodes)", () => {
    seedTreeStore([
      node({ id: "PARENT", title: "parent", childCount: 1, descendantCount: 1, loaded: true }),
      node({ id: "CHILD", parentId: "PARENT", title: "child", activity: "busy", updatedMs: 10 }),
    ]);
    setNodeMode("PARENT", "collapsed"); // a collapsed node with a resident child
    setSelectedIdRaw(null);
    const { container } = render(() => <SessionTree />);
    expect(
      (container as unknown as HTMLElement).querySelectorAll("span.twisty-temp").length,
    ).toBe(0);
  });

  // CRITERION 6 (guard): visibleKids output is identical to before for all four
  // states — the refactor to childrenForState changed nothing about WHAT renders.
  // (The per-state visibility matrix above already pins this; here we re-state
  // the temp single-path-child reveal under the new helper for completeness.)
  it("temp still reveals exactly the one path child (visibleKids parity)", () => {
    seedTreeStore([
      node({ id: "PARENT", title: "parent", childCount: 3, descendantCount: 3, loaded: true, activity: "busy" }),
      node({ id: "WORK_A", parentId: "PARENT", title: "a", activity: "busy", updatedMs: 50 }),
      node({ id: "WORK_B", parentId: "PARENT", title: "b", activity: "busy", updatedMs: 40 }),
      node({ id: "IDLE1", parentId: "PARENT", title: "idle", updatedMs: 10 }),
    ]);
    setSelectedIdRaw("WORK_B");
    const { container } = render(() => <SessionTree />);
    const ids = renderedIds(container as unknown as HTMLElement);
    // PARENT (temp) reveals exactly WORK_B — not WORK_A, not IDLE1.
    expect(ids).toContain("WORK_B");
    expect(ids).not.toContain("WORK_A");
    expect(ids).not.toContain("IDLE1");
  });
});

// ── eye derivation — dynamic reactivity ─────────────────────────────────────
// The static tests above prove the eye at INITIAL MOUNT only. These three prove
// it STAYS correct under live mutation, observing the real DOM after each
// mutation (not a selector call): the reactive propagation
// SessionTree → TreeBranch → showEye getter → TreeRow JSX must re-evaluate when
// (a) the activation changes, (b) a session's running/idle state flips, and
// (c) an ancestor's persisted mode is toggled. Each mounts FIRST, mutates AFTER,
// then asserts the DOM eye state per the rule.
describe("eye derivation — dynamic reactivity", () => {
  // (a) ACTIVATION CHANGE — selectedId flips. The eye follows the selection: it
  // lights on the new selection's ancestors (where temp alters the children-
  // list) and clears on the old branch's ancestors (no longer ancestors).
  //
  //   ROOT (idle root, EXPLICIT expanded so A/B rows stay observable across
  //   │     selection changes — expanded is never temp, never collapses)
  //   ├─ A (idle, cold-norm collapsed) — parent of LEAF_A
  //   │   └─ LEAF_A (idle)
  //   └─ B (idle, cold-norm collapsed) — parent of LEAF_B
  //       └─ LEAF_B (idle)
  it("activation change — selecting a nested session shows the eye on its collapsed ancestors; switching branches moves the eye", () => {
    seedTreeStore([
      node({ id: "ROOT", title: "root", childCount: 2, descendantCount: 4, loaded: true }),
      node({ id: "A", parentId: "ROOT", title: "a", childCount: 1, descendantCount: 1 }),
      node({ id: "LEAF_A", parentId: "A", title: "leafA" }),
      node({ id: "B", parentId: "ROOT", title: "b", childCount: 1, descendantCount: 1 }),
      node({ id: "LEAF_B", parentId: "B", title: "leafB" }),
    ]);
    // ROOT expanded so A/B rows always render (their twisties stay observable).
    setNodeMode("ROOT", "expanded");
    setSelectedIdRaw(null);
    const { container } = render(() => <SessionTree />);
    const c = container as unknown as HTMLElement;

    // No selection → no temp anywhere → no eyes.
    expect(c.querySelectorAll("span.twisty-temp").length).toBe(0);
    expect(renderedIds(c)).toContain("A");
    expect(renderedIds(c)).toContain("B");

    // Select LEAF_A via the CANONICAL setter (clears userToggled synchronously).
    // BEFORE: A persisted collapsed → kidsBaseline = []. Selection makes A a
    // strict ancestor → temp → kidsNow = [LEAF_A]. [] ≠ [LEAF_A] → eye ON.
    // B is not an ancestor of LEAF_A → stays collapsed → no eye. ROOT is
    // expanded → never temp → no eye.
    setSelectedId("LEAF_A");
    expect(twistyFor(c, "A").querySelector("span.twisty-temp")).not.toBeNull();
    expect(twistyFor(c, "B").querySelector("span.twisty-temp")).toBeNull();
    expect(twistyFor(c, "ROOT").querySelector("span.twisty-temp")).toBeNull();

    // Switch selection to the other branch. A is no longer an ancestor → not
    // temp → kidsNow = kidsBaseline = [] → eye CLEARS. B becomes a strict
    // ancestor → temp → kidsNow = [LEAF_B] ≠ [] → eye LIGHTS. The eye MOVED.
    setSelectedId("LEAF_B");
    expect(twistyFor(c, "A").querySelector("span.twisty-temp")).toBeNull();
    expect(twistyFor(c, "B").querySelector("span.twisty-temp")).not.toBeNull();
  });

  // (b) RUNNING/IDLE FLIP — a session's activity transitions busy↔idle, so the
  // working() predicate output changes for a resident child, which alters a
  // filtered ancestor's baseline children-list. The eye toggles live.
  //
  //   PARENT (working=busy, implicit filtered) — strict ancestor of PATHCHILD
  //   ├─ PATHCHILD (working=busy) ← selected (the temp path child)
  //   └─ OTHER (working=busy)
  //   BEFORE (OTHER busy): temp reveal [PATHCHILD] ≠ filtered baseline
  //     [PATHCHILD, OTHER] → eye ON.
  //   AFTER  (OTHER idle): temp reveal [PATHCHILD] = filtered baseline
  //     [PATHCHILD] (OTHER dropped from the working set) → eye OFF.
  it("running/idle flip — a child's busy→idle edge toggles the eye on its filtered ancestor", async () => {
    seedTreeStore([
      node({ id: "PARENT", title: "parent", childCount: 2, descendantCount: 2, loaded: true, activity: "busy" }),
      node({ id: "PATHCHILD", parentId: "PARENT", title: "path", activity: "busy", updatedMs: 50 }),
      node({ id: "OTHER", parentId: "PARENT", title: "other", activity: "busy", updatedMs: 40 }),
    ]);
    setSelectedIdRaw("PATHCHILD");
    const { container } = render(() => <SessionTree />);
    const c = container as unknown as HTMLElement;

    // BEFORE: eye ON. PARENT temp reveal = [PATHCHILD]; filtered baseline =
    // [PATHCHILD, OTHER] (both working). Lists differ → eye.
    const tw = twistyFor(c, "PARENT");
    expect(tw.querySelector("span.twisty-temp")).not.toBeNull();
    expect(glyphPath(tw)).toBe(EYE_PATH);

    // Flip OTHER busy→idle through the real store op path. PARENT's filtered
    // baseline loses OTHER (no longer working) → [PATHCHILD] == temp reveal →
    // eye OFF. (PARENT itself stays working+filtered: its own activity=busy is
    // untouched by a facet op on a child. The version bump propagates through
    // treeMap → residentChildren → showEye reactively.)
    applyTreeOpStore({ op: "node.facet", data: { id: "OTHER", activity: "idle" } });
    await new Promise((r) => setTimeout(r, 0)); // flush any auto-mutation microtask

    const tw2 = twistyFor(c, "PARENT");
    expect(tw2.querySelector("span.twisty-temp")).toBeNull();
  });

  // (c) ANCESTOR MODE TOGGLE — setNodeMode on an ancestor changes its
  // persistedMode/displayState, which re-derives the eye. Round-tripped both
  // directions to prove the eye re-evaluates on EACH persisted-mode change.
  //
  //   PARENT (working=busy, implicit filtered) — strict ancestor of PATHCHILD
  //   ├─ PATHCHILD (working=busy) ← selected
  //   └─ OTHERWORK (working=busy)
  //   filtered (temp):  reveal [PATHCHILD] ≠ baseline [PATHCHILD, OTHERWORK] → eye ON.
  //   expanded:         reveal [PATHCHILD, OTHERWORK] = baseline [PATHCHILD, OTHERWORK] → eye OFF.
  //   filtered again:   eye returns (temp again — setNodeMode does NOT mark userToggled).
  it("ancestor mode toggle — setNodeMode(filtered→expanded) clears the eye, and toggling back restores it", () => {
    seedTreeStore([
      node({ id: "PARENT", title: "parent", childCount: 2, descendantCount: 2, loaded: true, activity: "busy" }),
      node({ id: "PATHCHILD", parentId: "PARENT", title: "path", activity: "busy", updatedMs: 50 }),
      node({ id: "OTHERWORK", parentId: "PARENT", title: "otherwork", activity: "busy", updatedMs: 40 }),
    ]);
    setSelectedIdRaw("PATHCHILD");
    const { container } = render(() => <SessionTree />);
    const c = container as unknown as HTMLElement;

    // BEFORE: PARENT implicit filtered → temp (strict ancestor, not toggled).
    // reveal [PATHCHILD] ≠ baseline [PATHCHILD, OTHERWORK] → eye ON.
    let tw = twistyFor(c, "PARENT");
    expect(tw.querySelector("span.twisty-temp")).not.toBeNull();
    expect(glyphPath(tw)).toBe(EYE_PATH);

    // Toggle PARENT filtered→expanded via the real setNodeMode path.
    // effectiveTreeMode now returns expanded (expanded is NEVER temp), so
    // kidsNow = kidsBaseline = [PATHCHILD, OTHERWORK] → eye OFF.
    setNodeMode("PARENT", "expanded");
    tw = twistyFor(c, "PARENT");
    expect(tw.querySelector("span.twisty-temp")).toBeNull();

    // Toggle back to filtered. setNodeMode does NOT mark userToggled, so PARENT
    // is again a non-expanded strict ancestor → temp → eye returns. Proves the
    // eye re-evaluates on each persisted-mode change, in both directions.
    setNodeMode("PARENT", "filtered");
    tw = twistyFor(c, "PARENT");
    expect(tw.querySelector("span.twisty-temp")).not.toBeNull();
    expect(glyphPath(tw)).toBe(EYE_PATH);
  });
});
