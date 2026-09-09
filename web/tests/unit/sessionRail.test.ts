// @vitest-environment jsdom
//
// sessionRail — derivation unit tests (P1 portrait session monitor).
//
// Pins the four hard invariants of the rail's model:
//   1. STABLE ORDER — rail order follows the tree store's ARRIVAL order
//      (rootNodes(treeMap()) — insertion/emit order), never attention state
//      and never the rank-sorted treeRoots() the sidebar tree uses (that
//      accessor front-promotes on working edges; rail positions are fixed
//      muscle memory — see the sessionRail.ts module header);
//   2. ROOT GRANULARITY + selected-inclusion — only roots enumerate, and the
//      selected session's root is always among them;
//   3. AGGREGATE DEDUPE — a root with BOTH needs-input AND unread counts
//      ONCE in the needs-you aggregate;
//   4. IDENTITY STABILITY — initials + hue are pure functions of
//      (title, id): same inputs, same outputs, every call.
//
// Drives the real tree store (seedTreeStore/applyTreeOpStore) and the real
// sync store maps — no SSE, deterministic. jsdom because the import graph
// (sync/store → lib/store) touches localStorage at module init.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcile } from "solid-js/store";
import { render } from "@solidjs/testing-library";
import {
  seedTreeStore,
  resetTreeStore,
  resetExpandedForTest,
  applyTreeOpStore,
} from "../../src/sync/treeState";
import { selectedId, setSelectedIdRaw, setState, state } from "../../src/sync/store";
import SessionRail from "../../src/components/SessionRail";
import type { TreeNode } from "../../src/sync/treeMap";
import {
  RAIL_HUES,
  hueOf,
  initialsOf,
  railNeedsYou,
  railSessions,
  ringOf,
} from "../../src/sessionRail";

// The rail's mount gate reads the LIVE width tier (shapeTier's RO-driven
// signal); jsdom has no observer, so mock the accessor per-case (the
// autoclose-test precedent). The hoisted mock applies file-wide but is inert
// for the derivation tests above — nothing in the sessionRail import graph
// imports shapeTier.
const { widthTierMock } = vi.hoisted(() => ({ widthTierMock: vi.fn() }));
vi.mock("../../src/shapeTier", async (importActual) => {
  const actual = await importActual<typeof import("../../src/shapeTier")>();
  return { ...actual, widthTier: (): "narrow" | "rail" | "wide" | null => widthTierMock() };
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

const ids = (rs: ReturnType<typeof railSessions>) => rs.map((s) => s.id);

beforeEach(() => {
  localStorage.clear();
  resetTreeStore();
  resetExpandedForTest();
  // reconcile (not a bare object) — setState(key, obj) MERGES in Solid stores,
  // so a plain {} would leave the previous test's keys alive.
  setState("permissions", reconcile({}));
  setState("questions", reconcile({}));
  setState("unread", reconcile({}));
  setState("activity", reconcile({}));
});

describe("stable order (invariant 1)", () => {
  it("rail order equals the store's root arrival order, not recency", () => {
    // Seed with arrival order [C, B, A] but recency A > B > C: the rail must
    // follow ARRIVAL (rootNodes — the store's order-preserving enumeration),
    // never an updatedMs sort. (The sidebar tree rank-sorts by recency; the
    // rail deliberately does not — see the sessionRail.ts module header.)
    seedTreeStore([
      node({ id: "C", title: "Gamma root", updatedMs: 10 }),
      node({ id: "B", title: "Beta root", updatedMs: 20 }),
      node({ id: "A", title: "Alpha root", updatedMs: 30 }),
    ]);
    expect(ids(railSessions())).toEqual(["C", "B", "A"]);
  });

  it("attention NEVER reorders: arming needs-input / busy on a root leaves positions intact", () => {
    seedTreeStore([
      node({ id: "A", title: "Alpha root", updatedMs: 30 }),
      node({ id: "B", title: "Beta root", updatedMs: 20 }),
      node({ id: "C", title: "Gamma root", updatedMs: 10 }),
    ]);
    expect(ids(railSessions())).toEqual(["A", "B", "C"]);
    // C becomes the most-attentioned session in the dir (needs-input armed)…
    applyTreeOpStore({
      op: "node.facet",
      data: { id: "C", flags: { pendingInput: true, subtreeNeedsInput: true } },
    });
    // …and stays LAST: the tree's rank accessor (treeRoots) would front-promote
    // C on this working() edge, but the rail's store-order enumeration must not
    // move. Rings express attention, position never does.
    expect(ids(railSessions())).toEqual(["A", "B", "C"]);
    const after = railSessions();
    expect(after[2].needsInput).toBe(true);
    expect(ringOf(after[2])).toBe("needs");
    // Same for a plain busy facet (running attention) on the FIRST root.
    applyTreeOpStore({ op: "node.facet", data: { id: "A", flags: { subtreeBusy: true } } });
    expect(ids(railSessions())).toEqual(["A", "B", "C"]);
    expect(railSessions()[0].running).toBe(true);
  });

  it("an upsert (title change) keeps a root's position; a new root appends", () => {
    seedTreeStore([
      node({ id: "A", title: "Alpha root", updatedMs: 30 }),
      node({ id: "B", title: "Beta root", updatedMs: 20 }),
    ]);
    applyTreeOpStore({
      op: "node.upsert",
      data: { node: node({ id: "B", title: "Renamed beta", updatedMs: 99 }) },
    });
    expect(ids(railSessions())).toEqual(["A", "B"]); // B held its slot
    applyTreeOpStore({
      op: "node.upsert",
      data: { node: node({ id: "N", title: "New root", updatedMs: 100 }) },
    });
    expect(ids(railSessions())).toEqual(["A", "B", "N"]); // arrivals append
  });
});

describe("root granularity + selected inclusion (invariant 8)", () => {
  it("subsessions never enumerate; the selected subsession's root is always present", () => {
    seedTreeStore([
      node({ id: "root1", title: "Root one", childCount: 1, updatedMs: 30 }),
      node({ id: "child1", parentId: "root1", title: "Child", updatedMs: 40 }),
      node({ id: "root2", title: "Root two", updatedMs: 20 }),
    ]);
    const rs = railSessions();
    expect(ids(rs)).toEqual(["root1", "root2"]); // child1 never appears
    // Selecting the SUBSESSION still leaves its root in the rail (the rail's
    // selection ring marks rootOf(selected) — root granularity).
    const withChild = railSessions();
    expect(withChild.find((s) => s.id === "root1")).toBeTruthy();
    // A busy subsession rolls up into its root's running ring (subtreeBusy
    // facet), not into a rail entry of its own.
    applyTreeOpStore({
      op: "node.facet",
      data: { id: "root1", flags: { subtreeBusy: true } },
    });
    const rolled = railSessions();
    expect(ids(rolled)).toEqual(["root1", "root2"]);
    expect(rolled[0].running).toBe(true);
  });
});

describe("aggregate dedupe (invariant 8)", () => {
  it("a root with BOTH needs-input and unread counts ONCE in needs-you", () => {
    seedTreeStore([
      node({ id: "A", title: "Alpha root", updatedMs: 30 }),
      node({ id: "B", title: "Beta root", updatedMs: 20 }),
    ]);
    setState("unread", reconcile({ A: true }));
    applyTreeOpStore({ op: "node.facet", data: { id: "A", flags: { pendingInput: true } } });
    // A: needs-input AND unread (counts once); B: nothing.
    expect(railNeedsYou()).toBe(1);
    // B unread-only → two distinct roots needing attention → 2 (not 3).
    setState("unread", reconcile({ A: true, B: true }));
    expect(railNeedsYou()).toBe(2);
    // Clearing A's pending input: A still unread → still counted once.
    applyTreeOpStore({ op: "node.facet", data: { id: "A", flags: { pendingInput: false } } });
    expect(railNeedsYou()).toBe(2);
    // Nothing armed → 0. (reconcile replaces; a bare {} would MERGE and keep
    // the previous map alive in the Solid store.)
    setState("unread", reconcile({}));
    applyTreeOpStore({ op: "node.facet", data: { id: "B", flags: { pendingInput: false } } });
    expect(railNeedsYou()).toBe(0);
  });

  it("a subsession's unread-eligible state never double-counts via the root", () => {
    seedTreeStore([
      node({ id: "root1", title: "Root one", childCount: 1, updatedMs: 30 }),
      node({ id: "child1", parentId: "root1", title: "Child", updatedMs: 40 }),
    ]);
    // unread is root-scoped server-side: only a root key can be armed.
    setState("unread", reconcile({ root1: true }));
    expect(railNeedsYou()).toBe(1);
    expect(railSessions().find((s) => s.id === "root1")!.unread).toBe(true);
  });
});

describe("identity derivation (stable hash + initials)", () => {
  it("hueOf is a pure function of the id: stable across calls, bounded range", () => {
    for (const id of ["demo", "other", "slow", "ses_1", "ses_2", ""]) {
      const first = hueOf(id);
      expect(first).toBeGreaterThanOrEqual(0);
      expect(first).toBeLessThan(RAIL_HUES);
      for (let i = 0; i < 5; i++) expect(hueOf(id)).toBe(first);
    }
    // Distribution sanity: 16 sample ids hit more than one hue (a broken
    // hash collapsing to a constant would fail this).
    expect(new Set(Array.from({ length: 16 }, (_, i) => hueOf(`ses_${i}`))).size).toBeGreaterThan(1);
  });

  it("initialsOf: two words → first letters; one word → first two; blanks → id fallback", () => {
    expect(initialsOf("Demo session", "demo")).toBe("DS");
    expect(initialsOf("Another root", "other")).toBe("AR");
    expect(initialsOf("Refactor", "r1")).toBe("RE");
    expect(initialsOf("  spaced   out  words ", "x")).toBe("SO");
    expect(initialsOf("", "ses_1234")).toBe("SE");
    expect(initialsOf("   ", "abc")).toBe("AB");
    expect(initialsOf("", "")).toBe("?");
  });

  it("railSessions carries initials + hue consistently for the same tree", () => {
    seedTreeStore([node({ id: "demo", title: "Demo session", updatedMs: 1 })]);
    const rs = railSessions();
    expect(rs[0].initials).toBe("DS");
    expect(rs[0].hue).toBe(hueOf("demo"));
  });
});

describe("ring precedence (one ring per avatar)", () => {
  it("needs > error > running > unread", () => {
    const base = {
      id: "x",
      title: "X",
      initials: "XX",
      hue: 0,
    };
    expect(ringOf({ ...base, needsInput: true, error: true, running: true, unread: true })).toBe("needs");
    expect(ringOf({ ...base, needsInput: false, error: true, running: true, unread: true })).toBe("error");
    expect(ringOf({ ...base, needsInput: false, error: false, running: true, unread: true })).toBe("running");
    expect(ringOf({ ...base, needsInput: false, error: false, running: false, unread: true })).toBe("unread");
    expect(ringOf({ ...base, needsInput: false, error: false, running: false, unread: false })).toBeNull();
  });

  it("error activity maps to the error ring", () => {
    seedTreeStore([node({ id: "E", title: "Err root", updatedMs: 1 })]);
    setState("activity", { E: "error" });
    const rs = railSessions();
    expect(rs[0].error).toBe(true);
    expect(ringOf(rs[0])).toBe("error");
  });

  it("own busy maps to the running ring (sessionWorking reads state.activity)", () => {
    seedTreeStore([node({ id: "W", title: "Work root", updatedMs: 1 })]);
    // sessionWorking's self-activity source is the DETAIL store map
    // (state.activity), not the tree node's activity field — mirror the live
    // event path that writes both.
    setState("activity", { W: "busy" });
    const rs = railSessions();
    expect(rs[0].running).toBe(true);
    expect(ringOf(rs[0])).toBe("running");
  });

  it("a busy subsession rolls up via subtreeBusy into the root's running ring", () => {
    seedTreeStore([
      node({ id: "root1", title: "Root one", childCount: 1, updatedMs: 30 }),
      node({ id: "child1", parentId: "root1", title: "Child", activity: "busy", updatedMs: 40 }),
    ]);
    applyTreeOpStore({ op: "node.facet", data: { id: "root1", flags: { subtreeBusy: true } } });
    const rs = railSessions();
    expect(ids(rs)).toEqual(["root1"]); // child never enumerates
    expect(rs[0].running).toBe(true);
    expect(ringOf(rs[0])).toBe("running");
  });

  it("state.unread maps to the unread ring", () => {
    seedTreeStore([node({ id: "U", title: "Unread root", updatedMs: 1 })]);
    setState("unread", { U: true });
    const rs = railSessions();
    expect(rs[0].unread).toBe(true);
    expect(ringOf(rs[0])).toBe("unread");
    expect(state.unread["U"]).toBe(true); // sanity: the seeded map is live
  });
});

describe("root-granular selection ring (the component marks rootOf(selected))", () => {
  it("selecting a SUBSESSION marks its PARENT root's avatar; no subsession avatar exists", () => {
    widthTierMock.mockReturnValue("narrow"); // the mount gate: the rail renders
    seedTreeStore([
      node({ id: "root1", title: "Root one", childCount: 1, updatedMs: 30 }),
      node({ id: "child1", parentId: "root1", title: "Child", updatedMs: 40 }),
      node({ id: "root2", title: "Root two", updatedMs: 20 }),
    ]);
    // The selRoot derivation reads selectedId() AND residency in
    // state.sessions (the DETAIL store — distinct from the tree map): a
    // resident SUBSESSION selection marks rootOf(child1) = root1.
    setState(
      "sessions",
      reconcile({
        root1: { id: "root1", title: "Root one" },
        child1: { id: "child1", parentID: "root1", title: "Child" },
        root2: { id: "root2", title: "Root two" },
      }),
    );
    setSelectedIdRaw("child1");

    const { container, unmount } = render(SessionRail);
    try {
      const root1 = container.querySelector(".rail-avatar[data-session-id='root1']");
      const root2 = container.querySelector(".rail-avatar[data-session-id='root2']");
      expect(root1).toBeTruthy();
      expect(root2).toBeTruthy();
      expect(selectedId()).toBe("child1"); // sanity: the selection IS the child
      expect(root1!.classList.contains("selected")).toBe(true); // the PARENT root wears the ring
      expect(root2!.classList.contains("selected")).toBe(false);
      // Root granularity: the subsession never gets an avatar of its own.
      expect(container.querySelector(".rail-avatar[data-session-id='child1']")).toBeNull();
    } finally {
      unmount();
      setSelectedIdRaw(null);
      setState("sessions", reconcile({}));
    }
  });

  it("a GHOST selection (id not resident in state.sessions) marks nothing", () => {
    widthTierMock.mockReturnValue("narrow");
    seedTreeStore([node({ id: "root1", title: "Root one", updatedMs: 30 })]);
    setState("sessions", reconcile({ root1: { id: "root1", title: "Root one" } }));
    setSelectedIdRaw("ghost-id"); // not in state.sessions → selRoot is null

    const { container, unmount } = render(SessionRail);
    try {
      const root1 = container.querySelector(".rail-avatar[data-session-id='root1']");
      expect(root1).toBeTruthy();
      expect(root1!.classList.contains("selected")).toBe(false);
    } finally {
      unmount();
      setSelectedIdRaw(null);
      setState("sessions", reconcile({}));
    }
  });
});
