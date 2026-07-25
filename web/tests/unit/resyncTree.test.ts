// @vitest-environment jsdom
//
// Issue 2 — periodic / on-focus tree resync (drift self-heal).
//
// The O1 collapsed-frontier optimization removed the frequent full
// re-projections that used to continuously self-heal client/daemon state, so a
// long-lived stream accumulates drift until restart. resyncTree() requests ONE
// fresh projected snapshot via connect(true) (the existing full-rebuild
// reconcile path), throttled so the periodic + focus triggers can't burst.
//
// These tests pin the resync contract directly against the real stream module
// with a mock EventSource (jsdom has none): a healthy tree reconnects with a
// cursorless (fresh) EventSource; the throttle window dedups; no-project and
// closed-stream are no-ops (the watchdog owns recovery of a closed tree).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  connect,
  closeSessionStream,
  resyncTree,
  _resetResyncGateForTest,
  TREE_RESYNC_MIN_GAP_MS,
} from "../../src/sync/stream";
import { setProjectDirRaw } from "../../src/sync/store";
import {
  seedTreeStore,
  setNodeMode,
  modeOf,
  treeMap,
  resetTreeStore,
  applyTreeOpStore,
  treeModeMapSignal,
} from "../../src/sync/treeState";
import { switchProject } from "../../src/sync/actions";
import type { TreeNode } from "../../src/sync/treeMap";

// --- Mock EventSource (mirrors reconcileBusy.test.ts) ---
// jsdom doesn't implement EventSource. Track construction so we can assert a
// fresh ES was created, and expose helpers to drive readyState. The static
// CLOSED constant is what stream.ts reads via EventSource.CLOSED.
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
}

let instances: MockEventSource[] = [];

// Tree stream URL carries sessions=& (empty); session stream carries sessions=<id>.
const treeESes = (): MockEventSource[] =>
  instances.filter((e) => !/sessions=[^&]/.test(e.url));

beforeEach(() => {
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  setProjectDirRaw("/test");
  _resetResyncGateForTest();
  // The P0-E tests below seed treeState directly; start each test from a clean
  // flat map + userExpanded so a prior test's seed can't leak (mirrors
  // treeState.test.ts). The existing EventSource-only tests don't read treeState.
  resetTreeStore();
});

afterEach(() => {
  closeSessionStream();
  vi.clearAllTimers();
  vi.useRealTimers();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe("resyncTree — Issue 2 periodic/on-focus tree resync", () => {
  it("reconnects a healthy tree with a fresh cursorless EventSource", () => {
    // 1. Open the tree stream (connect(true) → first tree ES) and mark it
    //    healthy (OPEN). This is the drift precondition: the tree is alive but
    //    its projected state may have drifted.
    connect(true);
    expect(treeESes()).toHaveLength(1);
    treeESes()[0].simulateOpen();

    // 2. resyncTree → connect(true) drops + recreates the tree ES.
    resyncTree();

    // A second tree ES was created and the first was closed.
    expect(treeESes()).toHaveLength(2);
    expect(treeESes()[0].readyState).toBe(CLOSED);
    // connect(true) passes NO cursor → the URL has no `cursor=` (fresh snapshot
    // request, not a resume). This is what makes the server emit a full-rebuild
    // (cause initial/reconnect) snapshot that reconciles drift.
    expect(treeESes()[1].url).not.toContain("cursor=");
  });

  it("throttles repeated resyncs within TREE_RESYNC_MIN_GAP_MS, then allows after", () => {
    // Fake timers so Date.now() advances deterministically with the throttle.
    vi.useFakeTimers();

    connect(true);
    treeESes()[0].simulateOpen();
    expect(treeESes()).toHaveLength(1);

    // First resync fires immediately (gate at 0).
    resyncTree();
    expect(treeESes()).toHaveLength(2);

    // Within the min-gap window → throttled (no new ES).
    vi.advanceTimersByTime(TREE_RESYNC_MIN_GAP_MS - 1);
    resyncTree();
    expect(treeESes()).toHaveLength(2);

    // Advance past the window → allowed again (new ES).
    vi.advanceTimersByTime(2);
    resyncTree();
    expect(treeESes()).toHaveLength(3);
    expect(treeESes()[1].readyState).toBe(CLOSED);
  });

  it("is a no-op when no project is selected", () => {
    setProjectDirRaw("");
    connect(true); // connect() early-returns with no project → no ES created
    expect(treeESes()).toHaveLength(0);

    resyncTree();
    // No reconnect attempted (the watchdog/connect owns the no-project stand-down).
    expect(treeESes()).toHaveLength(0);
  });

  it("is a no-op when the tree stream is closed (watchdog owns recovery)", () => {
    connect(true);
    const first = treeESes()[0];
    // Simulate the tree going CLOSED (the watchdog/maybeReconnect reconnects it;
    // a resync here would only race that path).
    first.close();
    expect(first.readyState).toBe(CLOSED);

    resyncTree();
    // No NEW tree ES created by resyncTree (the closed tree is left to the
    // watchdog). treeESes() still has the one closed instance.
    expect(treeESes()).toHaveLength(1);
    expect(treeESes()[0]).toBe(first);
  });
});

// P0-E — resync flash + lost expand state.
//
// On every tab-return (visibilitychange) and (formerly) on a 90s periodic timer,
// resyncTree() → connect(true) used to call resetTreeStore() BEFORE the new
// snapshot arrived. That WIPED the flat map (empty-frame flash between wipe and
// the snapshot landing) AND wiped the in-memory userExpanded set (every manual
// expansion collapsed on each tab-return). The fix: a same-project fresh resync
// swaps the snapshot ATOMICALLY — seedTreeStore replaces the map in one step
// (no empty frame) and never touches userExpanded. Only a TRUE project switch
// (switchProject) clears explicitly.
describe("resyncTree — P0-E atomic swap (no empty frame, preserve userExpanded)", () => {
  // Full TreeNode seed (type-safe; mirrors treeState.test.ts node() helper).
  function node(overrides: Partial<TreeNode> = {}): TreeNode {
    return {
      id: "a",
      parentId: null,
      title: "A",
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

  it("P0-E-1: connect(true) does NOT wipe the flat map (old snapshot survives until the new one lands)", () => {
    // Pre-seed the store with the prior snapshot's state.
    seedTreeStore([node({ id: "a" })]);
    expect(treeMap().size).toBe(1);

    // A same-project fresh resync (connect(true), as resyncTree fires on tab
    // return) must swap ATOMICALLY: the old map stays visible until the new
    // tree.snapshot lands via seedTreeStore.
    connect(true);

    // OLD (buggy): resetTreeStore() wiped the map → size 0 (empty-frame flash
    // between the wipe and the snapshot arriving). NEW: the map survives
    // connect(true); only the arriving snapshot replaces it.
    expect(treeMap().size).toBeGreaterThan(0);
  });

  it("P0-E-2: connect(true) preserves the in-memory mode map (user expand modes)", () => {
    seedTreeStore([node({ id: "a" })]);
    setNodeMode("a", "expanded");
    expect(modeOf("a")).toBe("expanded");

    connect(true);

    // OLD (buggy): resetTreeStore() wiped the modes → all manual expansions
    // collapsed on every tab-return / resync. NEW: modes survive; only a true
    // project switch clears them.
    expect(modeOf("a")).toBe("expanded");
  });

  it("P0-E-3: a TRUE project switch still clears the map + mode map (regression guard)", () => {
    seedTreeStore([node({ id: "a" })]);
    setNodeMode("a", "expanded");
    expect(treeMap().size).toBe(1);
    expect(modeOf("a")).toBe("expanded");

    // switchProject early-returns when dir === projectDir(), so use a DIFFERENT
    // dir than the beforeEach "/test". After the fix switchProject itself calls
    // resetTreeStore() explicitly (project switch clears; same-project resync
    // does NOT — atomic swap preserves modes). GREEN on both old and new.
    switchProject("/other-dir");

    expect(treeMap().size).toBe(0);
    expect(modeOf("a")).toBe("filtered");
  });
});

// P0-F — auto-mutation across same-project snapshot resync.
//
// seedTreeStore replaces the whole flat map on every tree.snapshot (the resync
// path). For ids present in BOTH the old and new resident maps, the old→new
// working() transition drives the auto-mutation (collapsed+idle→working promoted
// to filtered; filtered+working→idle demoted to collapsed). First-appearance
// ids are baselines (no edge). Ids absent from the replacement are not mutated.
// A project reset clears the map so the next seed does NOT compare against the
// previous project. And a pending pre-resync op candidate is invalidated
// (generation bump) so it cannot overwrite the post-resync state.
describe("resyncTree — auto-mutation across snapshot replacement", () => {
  function node(overrides: Partial<TreeNode> = {}): TreeNode {
    return {
      id: "a",
      parentId: null,
      title: "A",
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

  it("same-project resync promotes a collapsed+idle node that became working (false→true)", () => {
    // First snapshot: a is idle → cold-normalized to explicit collapsed.
    seedTreeStore([node({ id: "a" })]);
    expect(modeOf("a")).toBe("collapsed");
    // Resync snapshot: a is now working (subtreeBusy rollup). a was resident in
    // the old map → the false→true edge fires against its persisted collapsed →
    // promoted to filtered, synchronously (before the version is exposed).
    seedTreeStore([node({ id: "a", flags: { ...node().flags, subtreeBusy: true } })]);
    expect(modeOf("a")).toBe("filtered");
  });

  it("same-project resync collapses a filtered+working node that became idle (true→false)", () => {
    // First snapshot: a is working; set explicit filtered so the demotion edge
    // can fire against it.
    seedTreeStore([node({ id: "a", flags: { ...node().flags, subtreeBusy: true } })]);
    setNodeMode("a", "filtered");
    expect(modeOf("a")).toBe("filtered");
    // Resync snapshot: a is now idle. a was resident → true→false edge on
    // persisted filtered → demoted to collapsed.
    seedTreeStore([node({ id: "a" })]);
    expect(modeOf("a")).toBe("collapsed");
  });

  it("first-appearance ids in the replacement are baselines (no transition)", () => {
    // First snapshot: only a.
    seedTreeStore([node({ id: "a" })]);
    // Resync introduces a NEW working id "b" (not in the old map). It is a
    // baseline → no false→true edge fires → left absent (working+absent stays
    // absent so modeOf returns the filtered fallback, NOT an explicit entry).
    seedTreeStore([
      node({ id: "a" }),
      node({ id: "b", flags: { ...node().flags, subtreeBusy: true } }),
    ]);
    expect(modeOf("b")).toBe("filtered"); // absent-fallback, not an explicit write
    expect(Object.prototype.hasOwnProperty.call(treeModeMapSignal(), "b")).toBe(false);
  });

  it("ids absent from the replacement are not mutated (persisted entry survives)", () => {
    // a and b both resident; give b an explicit persisted entry.
    seedTreeStore([node({ id: "a" }), node({ id: "b" })]);
    setNodeMode("b", "expanded");
    // Resync snapshot drops b (not resident in the replacement). b's persisted
    // expanded entry is NOT mutated — non-resident entries are ignored by the
    // resync (preserved for when b reappears).
    seedTreeStore([node({ id: "a" })]);
    expect(modeOf("b")).toBe("expanded");
  });

  it("a project reset does NOT compare nodes against the previous project", () => {
    // Project A: "shared" is idle → collapsed, then manually promoted to filtered.
    seedTreeStore([node({ id: "shared" })]);
    expect(modeOf("shared")).toBe("collapsed");
    setNodeMode("shared", "filtered");
    // Project switch: resetTreeStore clears the map + modes + invalidates the
    // queue (generation bump).
    resetTreeStore();
    // Project B: re-introduce "shared" as WORKING. Because the map was cleared,
    // "shared" is NOT in oldMap → baseline (no transition). It is left absent
    // (filtered fallback), NOT auto-promoted from the prior project's filtered.
    seedTreeStore([node({ id: "shared", flags: { ...node().flags, subtreeBusy: true } })]);
    expect(Object.prototype.hasOwnProperty.call(treeModeMapSignal(), "shared")).toBe(false);
    expect(modeOf("shared")).toBe("filtered"); // absent-fallback, not a write
  });

  it("a pending pre-resync op candidate cannot overwrite the post-resync state", async () => {
    // Snapshot: a idle → collapsed.
    seedTreeStore([node({ id: "a" })]);
    expect(modeOf("a")).toBe("collapsed");
    // An op flips a working false→true → enqueues a candidate (a: collapsed→
    // filtered) at generation G. The microtask flush is pending.
    applyTreeOpStore({ op: "node.facet", data: { id: "a", flags: { subtreeBusy: true } } });
    // Resync with a snapshot where a is IDLE: seedTreeStore invalidates the queue
    // (bumps generation to G+1, clears the candidate map) and, since a was busy
    // in oldMap but idle in the replacement (true→false on persisted collapsed is
    // a no-op), produces no change for a.
    seedTreeStore([node({ id: "a" })]);
    // Let the pending microtask run: the candidate map is empty (cleared by the
    // invalidate) → flush writes nothing → the stale candidate does NOT promote a.
    await Promise.resolve();
    expect(modeOf("a")).toBe("collapsed");
  });
});
