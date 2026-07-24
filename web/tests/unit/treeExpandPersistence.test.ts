// @vitest-environment jsdom
//
// P1-A — expand-state persistence (tree=2 UI-parity batch).
//
// The user expand-state (`userExpanded`) is the IN-MEMORY UI toggle that decides
// whether a node renders its resident children. Before P1-A it lived only in a
// Solid signal: every page reload collapsed the tree to the active path. P1-A
// persists it to localStorage (versioned envelope) and rehydrates on load, plus
// backfills any persisted-expanded node whose children aren't resident yet (the
// cold-load frontier ships an idle user-expanded node COLLAPSED — its children
// are not resident — so a naive persistence would leave a half-state).
//
// These tests pin: (1) persist/rehydrate round-trip, (2) the pure
// expandedButUnloadedIds helper, (3) the stream backfill actually firing a
// children fetch after the frontier seed, and (4) the "reload does not flatten"
// invariant is NOT regressed (the flat map is still replaced by the server
// snapshot while userExpanded survives).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  seedTreeStore,
  setUserNodeExpanded,
  isUserExpanded,
  resetExpandedForTest,
  resetTreeStore,
  treeMap,
  expandedButUnloadedIds,
  rehydrateExpandedForTest,
} from "../../src/sync/treeState";
import { connect, closeSessionStream } from "../../src/sync/stream";
import { setProjectDirRaw } from "../../src/sync/store";
import type { TreeNode } from "../../src/sync/treeMap";

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
// P1-A-1 / P1-A-2 / P1-A-4 — pure store + persistence (no EventSource).
// ---------------------------------------------------------------------------
describe("P1-A-1 userExpanded persist/rehydrate round-trip", () => {
  beforeEach(() => {
    localStorage.clear();
    resetTreeStore();
    resetExpandedForTest();
  });

  it("setUserNodeExpanded(true) persists the id to localStorage (vh.tree.expanded.v1)", () => {
    setUserNodeExpanded("X", true);
    const raw = localStorage.getItem("vh.tree.expanded.v1");
    expect(raw).not.toBeNull();
    const env = JSON.parse(raw as string) as { v: number; data: string[] };
    expect(env.v).toBe(1);
    expect(env.data).toContain("X");
  });

  it("setUserNodeExpanded(false) removes the id from localStorage", () => {
    setUserNodeExpanded("X", true);
    setUserNodeExpanded("X", false);
    const raw = localStorage.getItem("vh.tree.expanded.v1") as string;
    const env = JSON.parse(raw) as { data: string[] };
    expect(env.data).not.toContain("X");
  });

  it("rehydrateExpandedForTest restores the in-memory set from localStorage after in-memory is cleared (reload simulation)", () => {
    setUserNodeExpanded("X", true);
    expect(isUserExpanded("X")).toBe(true);

    // Simulate a page reload: in-memory signal is cleared, but localStorage
    // survives (resetExpandedForTest clears in-memory only — a reload loses the
    // session's Solid signals but keeps persisted UI state).
    resetExpandedForTest();
    expect(isUserExpanded("X")).toBe(false);

    // Rehydrate from localStorage: the persisted toggle comes back.
    rehydrateExpandedForTest();
    expect(isUserExpanded("X")).toBe(true);
  });

  it("resetTreeStore (true project switch / epoch change) clears the persisted key", () => {
    setUserNodeExpanded("X", true);
    expect(localStorage.getItem("vh.tree.expanded.v1")).toContain("X");
    resetTreeStore();
    const raw = localStorage.getItem("vh.tree.expanded.v1");
    expect(raw).not.toBeNull();
    const env = JSON.parse(raw as string) as { data: string[] };
    expect(env.data).toEqual([]);
    expect(isUserExpanded("X")).toBe(false);
  });
});

describe("P1-A-2 expandedButUnloadedIds (pure)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetTreeStore();
    resetExpandedForTest();
  });

  it("resident node with unloaded children + descendants to fetch → included", () => {
    seedTreeStore([node({ id: "A", childCount: 2, descendantCount: 2, loaded: false })]);
    setUserNodeExpanded("A", true);
    expect(expandedButUnloadedIds()).toEqual(["A"]);
  });

  it("resident node WITH a resident direct child → excluded (already loaded)", () => {
    seedTreeStore([
      node({ id: "A", childCount: 1, descendantCount: 1, loaded: true }),
      node({ id: "c", parentId: "A" }),
    ]);
    setUserNodeExpanded("A", true);
    expect(expandedButUnloadedIds()).toEqual([]);
  });

  it("a non-resident id in userExpanded (not in map) → excluded", () => {
    setUserNodeExpanded("GHOST", true); // never seeded into the map
    seedTreeStore([node({ id: "A", childCount: 2, descendantCount: 2, loaded: false })]);
    setUserNodeExpanded("A", true);
    expect(expandedButUnloadedIds()).toEqual(["A"]); // GHOST absent
  });

  it("resident node with NO descendants (childCount 0, descendantCount 0) → excluded (nothing to fetch)", () => {
    seedTreeStore([node({ id: "A", childCount: 0, descendantCount: 0, loaded: false })]);
    setUserNodeExpanded("A", true);
    expect(expandedButUnloadedIds()).toEqual([]);
  });

  it("empty when nothing is user-expanded", () => {
    seedTreeStore([node({ id: "A", childCount: 2, descendantCount: 2, loaded: false })]);
    expect(expandedButUnloadedIds()).toEqual([]);
  });
});

describe("P1-A-4 reload does NOT flatten the tree (regression guard)", () => {
  beforeEach(() => {
    localStorage.clear();
    resetTreeStore();
    resetExpandedForTest();
  });

  it("reseed replaces the flat map (structure re-fetched) while userExpanded survives", () => {
    seedTreeStore([node({ id: "X", childCount: 1, loaded: true }), node({ id: "c1", parentId: "X" })]);
    setUserNodeExpanded("X", true);
    const mapBefore = treeMap();
    expect(isUserExpanded("X")).toBe(true);

    // The server snapshot REPLACES the whole map on every tree.snapshot
    // (seedTreeStore → map = seedTree(...)). This is what keeps "reload does not
    // flatten" true: the map is always re-fetched from the server, never
    // persisted-and-stale.
    seedTreeStore([node({ id: "X", childCount: 1, loaded: true }), node({ id: "c2", parentId: "X" })]);
    const mapAfter = treeMap();

    expect(mapAfter).not.toBe(mapBefore); // a NEW map object (structure re-fetched)
    expect(isUserExpanded("X")).toBe(true); // but the user toggle survived
  });
});

// ---------------------------------------------------------------------------
// P1-A-3 — stream backfill fires a children fetch after the frontier seed.
// Mock EventSource (mirrors resyncTree.test.ts), drive a tree.snapshot for a
// node that is user-expanded + resident-but-no-resident-children + has
// descendants, and assert GET /vh/tree/children?id=<that node> is observed.
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

describe("P1-A-3 stream backfill fires GET /vh/tree/children after the frontier seed", () => {
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
    // The node X is user-expanded, resident (in the snapshot), has descendants
    // but NO resident direct children — exactly the cold-load half-state the
    // backfill resolves.
    setUserNodeExpanded("X", true);

    connect(true);
    expect(treeESes()).toHaveLength(1);
    treeESes()[0].simulateOpen();

    // Dispatch the frontier tree.snapshot. The applyTreeSnap closure seeds the
    // store, then (NEW) backfills expandedButUnloadedIds() by firing
    // expandTreeNode for each → GET /vh/tree/children?id=X.
    treeESes()[0].simulateMessage("tree.snapshot", {
      nodes: [node({ id: "X", childCount: 2, descendantCount: 2, loaded: false })],
    });

    // expandTreeNode is async (await fetch); let the microtask queue drain.
    await new Promise((r) => setTimeout(r, 0));

    // connect() also calls GET /vh/version (PWA update check); scope the
    // assertion to the tree-children endpoint — that is the backfill signal.
    const treeFetches = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/vh/tree/children"));
    expect(treeFetches).toHaveLength(1);
    expect(treeFetches[0]).toContain("id=X");
  });

  it("a node NOT user-expanded does NOT trigger a backfill fetch", async () => {
    connect(true);
    treeESes()[0].simulateOpen();
    // X is resident with unloaded children but NOT user-expanded → no backfill.
    treeESes()[0].simulateMessage("tree.snapshot", {
      nodes: [node({ id: "X", childCount: 2, descendantCount: 2, loaded: false })],
    });
    await new Promise((r) => setTimeout(r, 0));
    const treeFetches = fetchMock.mock.calls
      .map((c) => String(c[0]))
      .filter((u) => u.includes("/vh/tree/children"));
    expect(treeFetches).toHaveLength(0);
  });

  it("a user-expanded node that already HAS resident children does NOT trigger a backfill", async () => {
    setUserNodeExpanded("X", true);
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
