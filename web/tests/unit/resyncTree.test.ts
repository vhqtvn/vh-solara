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
  setUserNodeExpanded,
  isUserExpanded,
  treeMap,
  resetTreeStore,
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

  it("P0-E-2: connect(true) preserves the in-memory userExpanded set", () => {
    seedTreeStore([node({ id: "a" })]);
    setUserNodeExpanded("a", true);
    expect(isUserExpanded("a")).toBe(true);

    connect(true);

    // OLD (buggy): resetTreeStore() wiped userExpanded → all manual expansions
    // collapsed on every tab-return / resync. NEW: userExpanded survives; only
    // a true project switch clears it.
    expect(isUserExpanded("a")).toBe(true);
  });

  it("P0-E-3: a TRUE project switch still clears the map + userExpanded (regression guard)", () => {
    seedTreeStore([node({ id: "a" })]);
    setUserNodeExpanded("a", true);
    expect(treeMap().size).toBe(1);
    expect(isUserExpanded("a")).toBe(true);

    // switchProject early-returns when dir === projectDir(), so use a DIFFERENT
    // dir than the beforeEach "/test". After the fix switchProject itself calls
    // resetTreeStore() explicitly (project switch clears; same-project resync
    // does NOT — atomic swap preserves userExpanded). GREEN on both old and new.
    switchProject("/other-dir");

    expect(treeMap().size).toBe(0);
    expect(isUserExpanded("a")).toBe(false);
  });
});
