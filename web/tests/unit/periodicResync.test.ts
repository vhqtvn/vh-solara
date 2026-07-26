// @vitest-environment jsdom
//
// Q6 — conditional periodic tree resync (drift self-heal for a continuously-
// foregrounded tab).
//
// The on-focus trigger (visibilitychange → resyncTree) heals drift a
// backgrounded tab accumulated. It CANNOT see the drift class where a tab is
// continuously foregrounded but the live tree stream silently missed a tree.op
// (an emitter gap) — no visibilitychange ever fires. The periodic trigger
// bounds that exposure at ~10min + jitter, gated so it runs ONLY when every
// precondition holds, and resets after any successful authoritative recovery.
//
// These tests pin:
// 1. periodicResyncShouldRun() — each precondition independently suppresses the
//    periodic resync (doc hidden / offline / no project / closed stream /
//    stale stream / decode in flight / reconcile+busy in flight / recent
//    recovery).
// 2. The timer actually fires connect(true) when all preconditions hold, and
//    reschedules only (no connect) when a gate fails.
// 3. Reset-after-recovery: a focus resync (resyncTree) and a snapshot.complete
//    boundary both push the next periodic tick out by a full interval.
// 4. Diffs-found vs no-op instrumentation: a periodic resync whose fresh
//    snapshot matched the prior state counts as a no-op; one that differs
//    counts as diffs-found (an emitter gap was caught).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { gzipSync } from "node:zlib";
import {
  connect,
  closeSessionStream,
  resyncTree,
  startPeriodicResync,
  periodicResyncShouldRun,
  getTreeSnapshotDecode,
  _resetResyncGateForTest,
  _resetPeriodicStateForTest,
  _markTreeSeenForTest,
  _setLastAuthoritativeRecoveryForTest,
  _getPeriodicResyncStatsForTest,
  TREE_RESYNC_PERIODIC_INTERVAL_MS,
  STALE_MS,
} from "../../src/sync/stream";
import { setProjectDirRaw } from "../../src/sync/store";
import { seedTreeStore, resetTreeStore } from "../../src/sync/treeState";
import { withGlobalBusy } from "../../src/busy";
import type { TreeNode } from "../../src/sync/treeMap";

// --- Mock EventSource (mirrors snapshotComplete.test.ts) ---
// jsdom doesn't implement EventSource. The mock supports lastEventId + a fire()
// helper so the diffs-found tests can drive tree.snapshot + snapshot.complete.
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

  fire(type: string, data: unknown, lastEventId = ""): void {
    const ev = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
      lastEventId,
    });
    const arr = this.listeners.get(type);
    if (arr) for (const fn of arr) fn(ev);
  }

  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }
}

let instances: MockEventSource[] = [];

const treeESes = (): MockEventSource[] =>
  instances.filter((e) => !/sessions=[^&]/.test(e.url));

const lastTreeES = (): MockEventSource => treeESes()[treeESes().length - 1];

// jsdom defaults document.visibilityState to "visible"; override per-test.
const setVisibility = (v: "hidden" | "visible"): void => {
  Object.defineProperty(document, "visibilityState", {
    value: v,
    configurable: true,
  });
};
const setOnline = (v: boolean): void => {
  Object.defineProperty(navigator, "onLine", { value: v, configurable: true });
};

// Pin Math.random so the jittered schedule is deterministic (jitter factor
// 0.5 → (0.5*2-1) = 0 → delay == interval exactly).
const pinJitterZero = (): void => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
};

// Build a VALID gzip64 envelope (real DecompressionStream decodes it cleanly,
// so no Z_DATA_ERROR leaks — unlike a hand-typed bogus payload).
const validGzip = (payload: unknown): string =>
  gzipSync(JSON.stringify(payload)).toString("base64");

// Full TreeNode seed (type-safe; mirrors resyncTree.test.ts node() helper).
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

beforeEach(() => {
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  setProjectDirRaw("/test");
  _resetResyncGateForTest();
  _resetPeriodicStateForTest();
  setVisibility("visible");
  setOnline(true);
  resetTreeStore();
});

afterEach(() => {
  closeSessionStream();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

// Establish the "all preconditions hold" baseline: an open + healthy tree
// stream, no decode/reconcile/busy in flight, and a recovery old enough that
// the "no recovery in the previous interval" gate passes.
function establishHealthyStream(): MockEventSource {
  connect(true);
  const es = lastTreeES();
  es.simulateOpen();
  _markTreeSeenForTest(); // treeLastSeen fresh → stream healthy (not stale)
  // No recovery within the previous interval.
  _setLastAuthoritativeRecoveryForTest(0);
  return es;
}

describe("periodicResyncShouldRun — precondition gates", () => {
  it("returns true when ALL preconditions hold", () => {
    establishHealthyStream();
    expect(periodicResyncShouldRun()).toBe(true);
  });

  it("suppresses when the document is hidden", () => {
    establishHealthyStream();
    setVisibility("hidden");
    expect(periodicResyncShouldRun()).toBe(false);
  });

  it("suppresses when the network is offline", () => {
    establishHealthyStream();
    setOnline(false);
    expect(periodicResyncShouldRun()).toBe(false);
  });

  it("suppresses when no project is selected", () => {
    establishHealthyStream();
    setProjectDirRaw("");
    expect(periodicResyncShouldRun()).toBe(false);
  });

  it("suppresses when the tree stream is CLOSED (watchdog owns recovery)", () => {
    const es = establishHealthyStream();
    es.close();
    expect(es.readyState).toBe(CLOSED);
    expect(periodicResyncShouldRun()).toBe(false);
  });

  it("suppresses when the tree stream is stale (silent past STALE_MS)", () => {
    vi.useFakeTimers();
    establishHealthyStream();
    // A tree silent past STALE_MS is the watchdog's signal to force a reconnect,
    // not the periodic's. Advance fake time so treeLastSeen ages out.
    vi.setSystemTime(Date.now() + STALE_MS + 1);
    expect(periodicResyncShouldRun()).toBe(false);
  });

  it("suppresses when a snapshot decode is in flight", async () => {
    establishHealthyStream();
    // Fire a gzip64 tree.snapshot: the listener creates the pending coherent
    // owner synchronously (before the async decode completes), so
    // isTreeSnapshotDecoding() — which ORs the owner with the decode flag —
    // sees a capture in flight and the predicate stands down. Valid gzip →
    // clean decode (or legacy settle), no leak.
    lastTreeES().fire(
      "tree.snapshot",
      { encoding: "gzip64", data: validGzip({ nodes: [] }) },
      "1",
    );
    expect(periodicResyncShouldRun()).toBe(false);
    // Let the real async decode finish cleanly (avoids any leaked rejection).
    await new Promise((r) => setTimeout(r, 50));
  });

  it("suppresses when a global busy scope / reconcile is in flight", async () => {
    // withGlobalBusy holds the gate active (refCount>0) inside the callback and
    // runs reconcileBusy on release (which sets expectTreeSnap + reconciling).
    // The isGateActive() check is the live suppression signal in BOTH phases;
    // expectTreeSnap is defense-in-depth shadowed by it (expectTreeSnap-true ⟹
    // gate-active). Fake timers let us advance past reconcileBusy's 15s safety
    // timeout so withGlobalBusy resolves within the test window.
    vi.useFakeTimers();
    establishHealthyStream();
    let checked = false;
    const done = withGlobalBusy(async () => {
      expect(periodicResyncShouldRun()).toBe(false);
      checked = true;
    });
    await vi.advanceTimersByTimeAsync(16_000);
    await done;
    expect(checked).toBe(true);
  });

  it("suppresses when a recovery completed within the previous interval", () => {
    establishHealthyStream();
    // A recovery just completed (e.g. a focus resync or watchdog reconnect) —
    // the periodic must defer a full interval.
    _setLastAuthoritativeRecoveryForTest(Date.now() - 1000);
    expect(periodicResyncShouldRun()).toBe(false);
  });
});

describe("periodic resync timer — firing + reset-after-recovery", () => {
  it("fires connect(true) when all preconditions hold after the interval", () => {
    vi.useFakeTimers();
    pinJitterZero(); // delay == interval exactly
    establishHealthyStream();
    const countBefore = treeESes().length;
    startPeriodicResync();

    // Advance to just before the scheduled tick (interval). No fire yet.
    vi.advanceTimersByTime(TREE_RESYNC_PERIODIC_INTERVAL_MS - 1);
    expect(treeESes().length).toBe(countBefore);
    // Simulate a recent server ping keeping the stream healthy (a foregrounded
    // tab receives 15s pings), then cross the tick boundary.
    _markTreeSeenForTest();
    vi.advanceTimersByTime(2);

    // The periodic tick fired → periodicResyncShouldRun passed → resyncTree →
    // connect(true) opened a NEW cursorless tree EventSource.
    expect(treeESes().length).toBeGreaterThan(countBefore);
    expect(lastTreeES().url).not.toContain("cursor=");
  });

  it("does NOT connect when a precondition fails (reschedules only)", () => {
    vi.useFakeTimers();
    pinJitterZero();
    establishHealthyStream();
    const countBefore = treeESes().length;
    // Hide the tab so periodicResyncShouldRun returns false at every tick.
    setVisibility("hidden");
    startPeriodicResync();

    // Advance well past several intervals — every tick no-ops (hidden gate).
    _markTreeSeenForTest();
    vi.advanceTimersByTime(TREE_RESYNC_PERIODIC_INTERVAL_MS * 3);
    expect(treeESes().length).toBe(countBefore);
  });

  it("a focus resync (resyncTree) resets the periodic timer", () => {
    vi.useFakeTimers();
    pinJitterZero();
    establishHealthyStream();
    startPeriodicResync();

    // Advance most of the interval, then trigger a focus resync. resyncTree
    // calls markAuthoritativeRecovery → reschedules the periodic for a FULL
    // interval out (the partial progress is discarded).
    vi.advanceTimersByTime(TREE_RESYNC_PERIODIC_INTERVAL_MS - 5_000);
    _markTreeSeenForTest();
    const countAtFocus = treeESes().length;
    setVisibility("visible");
    resyncTree(); // focus resync: connect(true) + markAuthoritativeRecovery
    expect(treeESes().length).toBe(countAtFocus + 1);

    // Advance past where the ORIGINAL schedule would have fired (5s out). The
    // periodic must NOT have fired yet — the focus resync pushed it out.
    _markTreeSeenForTest();
    vi.advanceTimersByTime(10_000);
    expect(treeESes().length).toBe(countAtFocus + 1);
  });

  it("a coherent capture boundary resets the periodic timer", () => {
    vi.useFakeTimers();
    pinJitterZero();
    const es = establishHealthyStream();
    startPeriodicResync();

    // Advance most of the interval, then deliver a coherent capture boundary
    // (e.g. a watchdog reconnect's snapshot landed). C4: the boundary is the
    // atomic install of BOTH projections, which calls markAuthoritativeRecovery
    // → reschedules the periodic for a full interval. Driving the full capture
    // (tree.snapshot with epoch + detail snapshot + snapshot.complete) so the
    // owner installs truthfully.
    vi.advanceTimersByTime(TREE_RESYNC_PERIODIC_INTERVAL_MS - 5_000);
    _markTreeSeenForTest();
    es.fire(
      "tree.snapshot",
      { tree: "2", epoch: "e1", seq: 1, nodes: [node({ id: "a" })] },
      "1",
    );
    es.fire("snapshot", { seq: 1, epoch: "e1", sessions: [{ id: "a" }] }, "1");
    es.fire(
      "snapshot.complete",
      { epoch: "e1", revision: 1, projections: ["tree", "detail"] },
      "1",
    );

    // Advance past where the ORIGINAL schedule would have fired — no periodic
    // connect fires (the boundary reset pushed the next tick out).
    const countAfterBoundary = treeESes().length;
    _markTreeSeenForTest();
    vi.advanceTimersByTime(10_000);
    expect(treeESes().length).toBe(countAfterBoundary);
  });
});

describe("periodic resync — diffs-found vs no-op instrumentation", () => {
  it("counts a no-op when the fresh snapshot matched the prior state", () => {
    vi.useFakeTimers();
    pinJitterZero();
    establishHealthyStream();
    // Seed the resident tree map with the pre-resync state.
    seedTreeStore([node({ id: "a" })]);
    startPeriodicResync();

    // Advance to the tick, keeping the stream healthy + recovery old.
    vi.advanceTimersByTime(TREE_RESYNC_PERIODIC_INTERVAL_MS - 1);
    _markTreeSeenForTest();
    vi.advanceTimersByTime(2);

    // The periodic opened a new tree ES; land its tree.snapshot with the SAME
    // state (node "a" idle) → fingerprint unchanged → no-op. Then deliver the
    // completion boundary so resolvePeriodicDiff runs.
    const fresh = lastTreeES();
    fresh.simulateOpen();
    fresh.fire("tree.snapshot", { nodes: [node({ id: "a" })] }, "10");
    fresh.fire(
      "snapshot.complete",
      { epoch: "e1", revision: 10, projections: ["tree", "detail"] },
      "10",
    );

    const stats = _getPeriodicResyncStatsForTest();
    expect(stats.noOps).toBe(1);
    expect(stats.diffsFound).toBe(0);
  });

  it("counts diffs-found when the fresh snapshot differs (emitter gap caught)", () => {
    vi.useFakeTimers();
    pinJitterZero();
    establishHealthyStream();
    // Pre-resync: a single idle node.
    seedTreeStore([node({ id: "a" })]);
    startPeriodicResync();

    vi.advanceTimersByTime(TREE_RESYNC_PERIODIC_INTERVAL_MS - 1);
    _markTreeSeenForTest();
    vi.advanceTimersByTime(2);

    // The fresh authoritative snapshot disagrees: "a" became busy (an emitter
    // gap the live stream missed). Fingerprint differs → diffs-found.
    const fresh = lastTreeES();
    fresh.simulateOpen();
    fresh.fire(
      "tree.snapshot",
      { nodes: [node({ id: "a", flags: { ...node().flags, subtreeBusy: true } })] },
      "10",
    );
    fresh.fire(
      "snapshot.complete",
      { epoch: "e1", revision: 10, projections: ["tree", "detail"] },
      "10",
    );

    const stats = _getPeriodicResyncStatsForTest();
    expect(stats.diffsFound).toBe(1);
    expect(stats.noOps).toBe(0);
  });

  it("counts diffs-found even when snapshot.complete lands before the gzip64 decode settles", async () => {
    // Regression guard for the gzip64 async-decode race: production
    // tree.snapshot ships gzip64-decoded ASYNC, while snapshot.complete is the
    // back-to-back completion boundary. If the diff were resolved at
    // snapshot.complete, treeMap would still hold pre-resync state and a real
    // drift recovery would be systematically mis-counted as a no-op. The fix
    // resolves at the tree.snapshot APPLY path (post-decode), so the count is
    // correct regardless of when snapshot.complete lands relative to the decode.
    vi.useFakeTimers();
    pinJitterZero();
    establishHealthyStream();
    seedTreeStore([node({ id: "a" })]); // pre-resync: a idle
    startPeriodicResync();

    vi.advanceTimersByTime(TREE_RESYNC_PERIODIC_INTERVAL_MS - 1);
    _markTreeSeenForTest();
    vi.advanceTimersByTime(2); // periodic tick fires → resyncTree → new ES

    const fresh = lastTreeES();
    fresh.simulateOpen();
    // Hand the decode path a REAL DecompressionStream pipeline by switching to
    // real timers (fake timers don't drive the native webstream reader).
    vi.useRealTimers();

    // Fire a gzip64 tree.snapshot whose authoritative state DISAGREES (a busy).
    fresh.fire(
      "tree.snapshot",
      { encoding: "gzip64", data: validGzip({ nodes: [node({ id: "a", flags: { ...node().flags, subtreeBusy: true } })] }) },
      "10",
    );
    // Capture the NEW decode IIFE (reading before the fire returns the prior
    // connection's already-resolved Promise.resolve()).
    const decodeP = getTreeSnapshotDecode();
    // While the decode is still in flight, deliver the completion boundary —
    // the exact ordering that would mis-count if resolution happened here.
    fresh.fire(
      "snapshot.complete",
      { epoch: "e1", revision: 10, projections: ["tree", "detail"] },
      "10",
    );
    // Not yet counted: the decode hasn't applied seedTreeStore.
    expect(_getPeriodicResyncStatsForTest().diffsFound).toBe(0);

    // Once the gzip64 decode settles → applyTreeSnap → seedTreeStore installs
    // the busy node → resolvePeriodicDiff (at the APPLY path, not the boundary)
    // compares against the pre-resync idle fingerprint → diffs-found.
    await decodeP;

    const stats = _getPeriodicResyncStatsForTest();
    expect(stats.diffsFound).toBe(1);
    expect(stats.noOps).toBe(0);
  });
});
