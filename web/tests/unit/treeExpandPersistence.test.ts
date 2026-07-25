// @vitest-environment jsdom
//
// tree mode persistence + migration + backfill (proj=1 4-state twisty model).
//
// The persisted mode map (vh.tree.mode.v2, Record<id, "collapsed"|"filtered"|
// "expanded">) replaces the legacy binary expanded Set (vh.tree.expanded.v1).
// These pin: (1) persist/rehydrate round-trip, (2) v1→v2 migration (members→
// expanded, non-members→filtered default, malformed ignored, existing valid v2
// wins over legacy, v1 key retained), (3) setNodesMode does ONE localStorage
// write, (4) expandedButUnloadedIds reads mode==="expanded", (5) the stream
// backfill fires a children fetch for a persisted-expanded unloaded node, (6)
// reload does NOT flatten the tree (map re-fetched, modes survive), and (7)
// clearUserToggled is wired into setSelectedId only on a real id change.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  seedTreeStore,
  setNodeMode,
  setNodesMode,
  modeOf,
  hasUserToggled,
  markUserToggled,
  resetExpandedForTest,
  resetTreeStore,
  treeMap,
  treeModeMapSignal,
  applyTreeOpStore,
  expandedButUnloadedIds,
  rehydrateExpandedForTest,
} from "../../src/sync/treeState";
import { connect, closeSessionStream } from "../../src/sync/stream";
import { setProjectDirRaw, setSelectedIdRaw } from "../../src/sync/store";
import { setSelectedId } from "../../src/sync/actions";
import { saveVersioned } from "../../src/lib/store";
import type { TreeNode } from "../../src/sync/treeMap";

const LS_MODE = "vh.tree.mode.v2";
const LS_LEGACY = "vh.tree.expanded.v1";

// Full TreeNode seed (type-safe; mirrors treeState.test.ts node() helper).
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

// ---------------------------------------------------------------------------
// persist/rehydrate round-trip + setNodesMode one-write.
// ---------------------------------------------------------------------------
describe("mode map persist/rehydrate round-trip (vh.tree.mode.v2)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetTreeStore();
    resetExpandedForTest();
  });

  it("setNodeMode persists the mode to localStorage (vh.tree.mode.v2)", () => {
    setNodeMode("X", "expanded");
    const raw = localStorage.getItem(LS_MODE);
    expect(raw).not.toBeNull();
    const env = JSON.parse(raw as string) as { v: number; data: Record<string, string> };
    expect(env.v).toBe(1);
    expect(env.data.X).toBe("expanded");
  });

  it("setNodeMode overwrite persists the new mode", () => {
    setNodeMode("X", "expanded");
    setNodeMode("X", "collapsed");
    const env = JSON.parse(localStorage.getItem(LS_MODE) as string) as { data: Record<string, string> };
    expect(env.data.X).toBe("collapsed");
  });

  it("rehydrateExpandedForTest restores modes from localStorage after in-memory clear (reload sim)", () => {
    setNodeMode("X", "expanded");
    expect(modeOf("X")).toBe("expanded");
    resetExpandedForTest();
    expect(modeOf("X")).toBe("filtered"); // in-memory cleared
    rehydrateExpandedForTest();
    expect(modeOf("X")).toBe("expanded"); // rehydrated from disk
  });

  it("resetTreeStore (project switch) clears the persisted mode key", () => {
    setNodeMode("X", "expanded");
    expect(localStorage.getItem(LS_MODE)).toContain("expanded");
    resetTreeStore();
    const env = JSON.parse(localStorage.getItem(LS_MODE) as string) as { data: Record<string, string> };
    expect(env.data).toEqual({});
    expect(modeOf("X")).toBe("filtered");
  });

  it("setNodesMode does ONE localStorage write per call (batched, not N)", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    setNodesMode(["a", "b", "c"], "expanded");
    // A loop of setNodeMode would call setItem 3× for LS_MODE; the batched
    // setNodesMode accumulates then writes ONCE.
    const modeWrites = setItemSpy.mock.calls.filter((c) => c[0] === LS_MODE);
    expect(modeWrites).toHaveLength(1);
    setItemSpy.mockRestore();
  });

  it("setNodeMode does exactly one localStorage write per call", () => {
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    setNodeMode("solo", "expanded");
    const modeWrites = setItemSpy.mock.calls.filter((c) => c[0] === LS_MODE);
    expect(modeWrites).toHaveLength(1);
    setItemSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// v1 → v2 migration (legacy expanded Set → mode map).
// ---------------------------------------------------------------------------
describe("v1 → v2 migration (vh.tree.expanded.v1 → vh.tree.mode.v2)", () => {
  beforeEach(() => {
    // resetTreeStore writes an empty v2 map (its persisted-key clear). Clear
    // localStorage AFTER it so the migration tests start with v2 ABSENT —
    // otherwise loadInitialTreeModes sees an (empty) v2 key and skips migration.
    resetTreeStore();
    resetExpandedForTest();
    localStorage.clear();
  });

  it("legacy expanded-set members → 'expanded'; absent ids → default 'filtered'", () => {
    saveVersioned(LS_LEGACY, 1, ["A", "B"]);
    rehydrateExpandedForTest();
    expect(modeOf("A")).toBe("expanded");
    expect(modeOf("B")).toBe("expanded");
    expect(modeOf("C")).toBe("filtered"); // absent → default
  });

  it("malformed legacy entries (non-string / empty) are ignored", () => {
    saveVersioned(LS_LEGACY, 1, ["A", "", 123, null] as unknown as string[]);
    rehydrateExpandedForTest();
    expect(modeOf("A")).toBe("expanded");
    expect(modeOf("")).toBe("filtered"); // empty string skipped
    // numbers / nulls skipped (no crash, no manufactured entry)
  });

  it("an existing VALID v2 map wins over legacy migration (v2 not re-migrated)", () => {
    saveVersioned(LS_MODE, 1, { X: "collapsed" }); // v2 present
    saveVersioned(LS_LEGACY, 1, ["A"]); // legacy present
    rehydrateExpandedForTest();
    expect(modeOf("X")).toBe("collapsed"); // v2 content used
    expect(modeOf("A")).toBe("filtered"); // legacy IGNORED (v2 already present)
  });

  it("an EMPTY v2 map (present but {}) is used as-is — no re-migration from legacy", () => {
    saveVersioned(LS_MODE, 1, {}); // v2 present, empty
    saveVersioned(LS_LEGACY, 1, ["A"]);
    rehydrateExpandedForTest();
    expect(modeOf("A")).toBe("filtered"); // not migrated (v2 present)
  });

  it("the legacy v1 key is RETAINED after migration (rollback safety)", () => {
    saveVersioned(LS_LEGACY, 1, ["A"]);
    rehydrateExpandedForTest();
    expect(localStorage.getItem(LS_LEGACY)).not.toBeNull(); // retained
    expect(localStorage.getItem(LS_MODE)).not.toBeNull(); // v2 written
  });

  it("migration persists the result under v2 so the next load is a direct hit", () => {
    saveVersioned(LS_LEGACY, 1, ["A"]);
    rehydrateExpandedForTest(); // migrates + persists v2
    // Second rehydrate: v2 now present → direct read, legacy untouched.
    rehydrateExpandedForTest();
    expect(modeOf("A")).toBe("expanded");
  });

  it("a corrupted v2 payload is coerced to a clean map (invalid modes dropped)", () => {
    saveVersioned(LS_MODE, 1, { A: "expanded", B: "junk", C: 42 } as unknown as Record<string, never>);
    rehydrateExpandedForTest();
    expect(modeOf("A")).toBe("expanded");
    expect(modeOf("B")).toBe("filtered"); // invalid mode dropped
    expect(modeOf("C")).toBe("filtered"); // non-string dropped
  });
});

// ---------------------------------------------------------------------------
// expandedButUnloadedIds — backfill source (reads mode === "expanded").
// ---------------------------------------------------------------------------
describe("expandedButUnloadedIds (mode === 'expanded')", () => {
  beforeEach(() => {
    localStorage.clear();
    resetTreeStore();
    resetExpandedForTest();
  });

  it("resident node with unloaded children + descendants to fetch → included", () => {
    seedTreeStore([node({ id: "A", childCount: 2, descendantCount: 2, loaded: false })]);
    setNodeMode("A", "expanded");
    expect(expandedButUnloadedIds()).toEqual(["A"]);
  });

  it("resident node WITH a resident direct child → excluded (already loaded)", () => {
    seedTreeStore([
      node({ id: "A", childCount: 1, descendantCount: 1, loaded: true }),
      node({ id: "c", parentId: "A" }),
    ]);
    setNodeMode("A", "expanded");
    expect(expandedButUnloadedIds()).toEqual([]);
  });

  it("a non-resident id persisted as expanded (not in map) → excluded", () => {
    setNodeMode("GHOST", "expanded"); // never seeded into the map
    seedTreeStore([node({ id: "A", childCount: 2, descendantCount: 2, loaded: false })]);
    setNodeMode("A", "expanded");
    expect(expandedButUnloadedIds()).toEqual(["A"]); // GHOST absent
  });

  it("a node persisted as 'filtered' or 'collapsed' → excluded (only expanded is backfilled)", () => {
    seedTreeStore([node({ id: "A", childCount: 2, descendantCount: 2, loaded: false })]);
    setNodeMode("A", "filtered");
    expect(expandedButUnloadedIds()).toEqual([]);
    setNodeMode("A", "collapsed");
    expect(expandedButUnloadedIds()).toEqual([]);
  });

  it("resident node with NO descendants (childCount 0, descendantCount 0) → excluded", () => {
    seedTreeStore([node({ id: "A", childCount: 0, descendantCount: 0, loaded: false })]);
    setNodeMode("A", "expanded");
    expect(expandedButUnloadedIds()).toEqual([]);
  });

  it("empty when nothing is persisted-expanded", () => {
    seedTreeStore([node({ id: "A", childCount: 2, descendantCount: 2, loaded: false })]);
    expect(expandedButUnloadedIds()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// reload does NOT flatten the tree (regression guard).
// ---------------------------------------------------------------------------
describe("reload does NOT flatten the tree (regression guard)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetTreeStore();
    resetExpandedForTest();
  });

  it("reseed replaces the flat map (structure re-fetched) while modes survive", () => {
    seedTreeStore([node({ id: "X", childCount: 1, loaded: true }), node({ id: "c1", parentId: "X" })]);
    setNodeMode("X", "expanded");
    const mapBefore = treeMap();
    expect(modeOf("X")).toBe("expanded");

    // The server snapshot REPLACES the whole map on every tree.snapshot
    // (seedTreeStore → map = seedTree(...)). This is what keeps "reload does not
    // flatten" true: the map is always re-fetched, never persisted-and-stale.
    seedTreeStore([node({ id: "X", childCount: 1, loaded: true }), node({ id: "c2", parentId: "X" })]);
    const mapAfter = treeMap();

    expect(mapAfter).not.toBe(mapBefore); // a NEW map object (structure re-fetched)
    expect(modeOf("X")).toBe("expanded"); // but the mode survived
  });
});

// ---------------------------------------------------------------------------
// clearUserToggled wiring into setSelectedId (only on a real id change).
// ---------------------------------------------------------------------------
describe("clearUserToggled wired into the canonical selection setter", () => {
  beforeEach(() => {
    localStorage.clear();
    resetTreeStore();
    resetExpandedForTest();
    setSelectedIdRaw(null);
  });

  it("a twisty click (markUserToggled) survives a SAME-id re-select", () => {
    setSelectedIdRaw("A"); // baseline selection
    markUserToggled("X");
    expect(hasUserToggled("X")).toBe(true);
    setSelectedId("A"); // same id → no clear
    expect(hasUserToggled("X")).toBe(true);
  });

  it("a real selection CHANGE clears userToggled synchronously", () => {
    setSelectedIdRaw("A");
    markUserToggled("X");
    setSelectedId("B"); // different id → clear
    expect(hasUserToggled("X")).toBe(false);
  });

  it("persisted modes survive the selection-change clear", () => {
    setSelectedIdRaw("A");
    setNodeMode("Y", "expanded");
    markUserToggled("Y");
    setSelectedId("C"); // clears userToggled...
    expect(hasUserToggled("Y")).toBe(false);
    expect(modeOf("Y")).toBe("expanded"); // ...but the mode survived
  });
});

// ---------------------------------------------------------------------------
// stream backfill fires a children fetch after the frontier seed.
// Mock EventSource (mirrors the original P1-A-3 suite), drive a tree.snapshot
// for a node that is persisted-expanded + resident-but-no-resident-children +
// has descendants, and assert GET /vh/tree/children?id=<that node> is observed.
// ---------------------------------------------------------------------------
const CONNECTING = 0;
const OPEN = 1;
const CLOSED = 2;

class MockEventSource {
  static CLOSED = CLOSED;
  static OPEN = OPEN;
  static CONNECTING = CONNECTING;

  url: string;
  readyState = CONNECTING;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private listeners = new Map<string, Array<(e: MessageEvent) => void>>();

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  addEventListener(type: string, fn: (e: MessageEvent) => void): void {
    const arr = this.listeners.get(type);
    if (arr) arr.push(fn);
    else this.listeners.set(type, [fn]);
  }

  close(): void {
    this.readyState = CLOSED;
  }

  // test helpers
  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  simulateMessage(type: string, data: unknown, lastEventId = "1"): void {
    const ev = {
      data: typeof data === "string" ? data : JSON.stringify(data),
      lastEventId,
    } as MessageEvent;
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
  }
}

let instances: MockEventSource[] = [];
const treeESes = (): MockEventSource[] =>
  instances.filter((e) => !/sessions=[^&]/.test(e.url));

describe("stream backfill fires GET /vh/tree/children after the frontier seed", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    instances = [];
    (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
    setProjectDirRaw("/test");
    localStorage.clear();
    resetTreeStore();
    resetExpandedForTest();
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ parentId: "X", nodes: [], hasMore: false }),
    });
    (globalThis as unknown as { fetch: unknown }).fetch = fetchMock;
  });

  afterEach(() => {
    closeSessionStream();
    delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
    delete (globalThis as unknown as { fetch?: unknown }).fetch;
  });

  it("a persisted-expanded node with unloaded children is backfilled (fetch fires)", async () => {
    setNodeMode("X", "expanded");
    connect(true);
    expect(treeESes()).toHaveLength(1);
    treeESes()[0].simulateOpen();

    treeESes()[0].simulateMessage("tree.snapshot", {
      nodes: [node({ id: "X", childCount: 2, descendantCount: 2, loaded: false })],
    });

    await new Promise((r) => setTimeout(r, 0));

    const treeFetches = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/vh/tree/children"));
    expect(treeFetches).toHaveLength(1);
    expect(treeFetches[0]).toContain("id=X");
  });

  it("a node NOT persisted-expanded does NOT trigger a backfill fetch", async () => {
    connect(true);
    treeESes()[0].simulateOpen();
    treeESes()[0].simulateMessage("tree.snapshot", {
      nodes: [node({ id: "X", childCount: 2, descendantCount: 2, loaded: false })],
    });
    await new Promise((r) => setTimeout(r, 0));
    const treeFetches = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/vh/tree/children"));
    expect(treeFetches).toHaveLength(0);
  });

  it("a persisted-expanded node that already HAS resident children does NOT backfill", async () => {
    setNodeMode("X", "expanded");
    connect(true);
    treeESes()[0].simulateOpen();
    treeESes()[0].simulateMessage("tree.snapshot", {
      nodes: [
        node({ id: "X", childCount: 1, descendantCount: 1, loaded: true }),
        node({ id: "c", parentId: "X" }),
      ],
    });
    await new Promise((r) => setTimeout(r, 0));
    const treeFetches = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/vh/tree/children"));
    expect(treeFetches).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// auto-mutation cold-load normalization + write coalescing (persistence).
// Pins: (1) modeOf stays "filtered" for a genuinely-absent id; (2) cold
// normalization materializes collapsed ONLY for resident absent-idle ids;
// (3) nonresident persisted entries are ignored by cold-norm (preserved, not
// dropped); (4) explicit filtered-idle is preserved; (5) ONE localStorage write
// per seed regardless of how many mixed (cold + edge) target changes; (6) ONE
// write per microtask flush regardless of candidate count; (7) a no-op seed
// writes ZERO times.
// ---------------------------------------------------------------------------
describe("auto-mutation cold-load normalization + write coalescing", () => {
  beforeEach(() => {
    localStorage.clear();
    resetTreeStore();
    resetExpandedForTest();
  });

  it("modeOf returns 'filtered' for a genuinely-absent (never-seen) id", () => {
    seedTreeStore([node({ id: "A" })]);
    expect(modeOf("never-seen")).toBe("filtered");
  });

  it("cold normalization materializes collapsed ONLY for resident absent-idle ids", () => {
    seedTreeStore([
      node({ id: "idleA" }), // resident + idle + absent → collapsed
      node({ id: "busyB", activity: "busy" }), // resident + working + absent → stays implicit filtered
    ]);
    expect(modeOf("idleA")).toBe("collapsed");
    expect(modeOf("busyB")).toBe("filtered");
    expect(Object.prototype.hasOwnProperty.call(treeModeMapSignal(), "busyB")).toBe(false);
  });

  it("a NONRESIDENT persisted entry is ignored by cold-norm (preserved, not dropped)", () => {
    setNodeMode("GHOST", "expanded"); // persisted but never resident
    seedTreeStore([node({ id: "A" })]);
    expect(modeOf("A")).toBe("collapsed"); // resident absent-idle cold-normalized
    expect(modeOf("GHOST")).toBe("expanded"); // nonresident entry preserved untouched
  });

  it("an explicit 'filtered'-idle resident id is preserved (not cold-overridden)", () => {
    setNodeMode("A", "filtered");
    seedTreeStore([node({ id: "A" })]);
    expect(modeOf("A")).toBe("filtered");
  });

  it("ONE localStorage write per seed regardless of mixed cold + edge target changes", () => {
    // Establish a known node "k" first (cold → collapsed) BEFORE spying.
    seedTreeStore([node({ id: "k" })]);
    expect(modeOf("k")).toBe("collapsed");

    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    // Re-seed: k goes idle→busy (known collapsed → filtered edge) AND a new idle
    // node "n" is cold-normalized to collapsed. Two DIFFERENT target modes, but
    // ONE synchronous setNodeModes call → ONE LS_MODE write.
    seedTreeStore([node({ id: "k", activity: "busy" }), node({ id: "n" })]);
    const modeWrites = setItemSpy.mock.calls.filter((c) => c[0] === LS_MODE);
    expect(modeWrites).toHaveLength(1);
    expect(modeOf("k")).toBe("filtered");
    expect(modeOf("n")).toBe("collapsed");
    setItemSpy.mockRestore();
  });

  it("ONE localStorage write per microtask flush regardless of candidate count", async () => {
    seedTreeStore([node({ id: "a" }), node({ id: "b" }), node({ id: "c" })]); // all cold → collapsed
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    // Three independent facets → three candidates enqueued, ONE scheduled flush.
    applyTreeOpStore({ op: "node.facet", data: { id: "a", activity: "busy" } });
    applyTreeOpStore({ op: "node.facet", data: { id: "b", activity: "busy" } });
    applyTreeOpStore({ op: "node.facet", data: { id: "c", activity: "busy" } });
    await new Promise((r) => setTimeout(r, 0)); // flush
    const modeWrites = setItemSpy.mock.calls.filter((c) => c[0] === LS_MODE);
    expect(modeWrites).toHaveLength(1); // ONE write for all three survivors
    expect(modeOf("a")).toBe("filtered");
    expect(modeOf("b")).toBe("filtered");
    expect(modeOf("c")).toBe("filtered");
    setItemSpy.mockRestore();
  });

  it("a no-op seed (no qualifying changes) writes ZERO times to LS_MODE", () => {
    seedTreeStore([node({ id: "k" })]); // cold → collapsed
    const setItemSpy = vi.spyOn(Storage.prototype, "setItem");
    // Re-seed the SAME idle node: known + idle→idle (no edge) + already explicit
    // collapsed (no cold change) → empty change set → setNodeModes early-returns.
    seedTreeStore([node({ id: "k" })]);
    const modeWrites = setItemSpy.mock.calls.filter((c) => c[0] === LS_MODE);
    expect(modeWrites).toHaveLength(0);
    setItemSpy.mockRestore();
  });
});
