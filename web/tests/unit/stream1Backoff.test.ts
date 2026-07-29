// @vitest-environment jsdom
//
// Stream1 (tree stream) CLOSED-reopen exponential backoff + generation
// invalidation — audit gap #1 (tree-transport split prerequisite).
//
// stream2Backoff.test.ts covers Stream2's manual CLOSED-reopen backoff; the
// analogous Stream1 path (es.onerror → treeGen++ → cancelPendingOwner →
// setTimeout(connect, backoff) → backoff*=2 cap 15s) had NO dedicated test.
// This file closes that gap and ALSO pins the C-F2 gen-token-bump invariant:
// after onerror, every entry-guarded listener (tree.snapshot + detail-snapshot)
// registered on the pre-error ES is inert (the entry-guard
// `if (gen !== treeGen) return;` drops the stale callback BEFORE any state
// effect — no decode starts, no clock refresh, no store mutation).
//
// Stream1 backoff starts at 1000ms (tree-transport.ts, the `backoff`
// initializer) — NOT 1500ms like Stream2. onopen resets it to 1000
// (tree-transport.ts, `es.onopen`); onerror reads the current value for the
// reconnect timer, then doubles it (capped at 15s, tree-transport.ts,
// `es.onerror`).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock EventSource — same shape as stream2Backoff.test.ts.
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

  /** Simulate the EventSource transitioning to OPEN (fires onopen). */
  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  /** Simulate a fatal error (readyState→CLOSED, fires onerror). */
  simulateError(): void {
    this.readyState = CLOSED;
    this.onerror?.();
  }

  /** Dispatch a named event to registered listeners regardless of readyState. */
  fire(type: string, data: unknown, lastEventId = ""): void {
    const ev = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
      lastEventId,
    });
    const arr = this.listeners.get(type);
    if (arr) for (const fn of arr) fn(ev);
  }
}

let instances: MockEventSource[] = [];

// Tree-stream ESes have `sessions=&` (empty); session-stream ESes have
// `sessions=<id>&`. Count ALL tree ESes ever created (incl. CLOSED) so a
// reconnect is observable as a length increment — mirrors stream2Backoff's
// sessionESes (which does not filter on readyState either).
const treeESesAll = (): MockEventSource[] =>
  instances.filter((e) => !/sessions=[^&]/.test(e.url));

let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
let treeState: typeof import("../../src/sync/treeState") = null as unknown as typeof import("../../src/sync/treeState");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  treeState = await import("../../src/sync/treeState");
  store.setProjectDirRaw("/test");
  store.setSelectedIdRaw("s1");
}

beforeEach(async () => {
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
  );
  window.localStorage.clear();
  vi.useFakeTimers();
  await setupFresh();
});

afterEach(() => {
  stream?.closeSessionStream();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

// ===========================================================================
// Backoff timing — mirrors stream2Backoff's three-test structure, adapted for
// Stream1's 1000ms base (vs Stream2's 1500ms) and 15s cap.
// ===========================================================================
describe("Stream1 CLOSED-reopen backoff (C-F2 timing)", () => {
  it("increases the reopen delay on consecutive CLOSED errors", () => {
    stream.connect();
    expect(treeESesAll()).toHaveLength(1);
    const first = treeESesAll()[0];
    // Establish a healthy baseline so backoff is reset to 1000ms (its init
    // value, but onopen makes it explicit and robust to prior-test state).
    first.simulateOpen();

    // --- 1st CLOSED: backoff reads 1000ms for the timer, then doubles to 2000.
    first.simulateError();
    vi.advanceTimersByTime(999);
    expect(treeESesAll()).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(treeESesAll()).toHaveLength(2);

    // --- 2nd CLOSED: timer reads 2000ms, then doubles to 4000. NO simulateOpen
    //     in between (a healthy open would reset backoff to 1000). ---
    const second = treeESesAll()[1];
    second.simulateError();
    vi.advanceTimersByTime(1999);
    expect(treeESesAll()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(treeESesAll()).toHaveLength(3);

    // --- 3rd CLOSED: timer reads 4000ms, then doubles to 8000. ---
    const third = treeESesAll()[2];
    third.simulateError();
    vi.advanceTimersByTime(3999);
    expect(treeESesAll()).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(treeESesAll()).toHaveLength(4);
  });

  it("caps the reopen delay at 15s", () => {
    stream.connect();
    // Backoff sequence (no healthy open between errors):
    //   timer: 1000, 2000, 4000, 8000, 15000(cap), 15000(cap), ...
    //   after: 2000, 4000, 8000, 15000, 15000, 15000
    treeESesAll()[0].simulateOpen();
    for (let i = 0; i < 6; i++) {
      const es = treeESesAll()[treeESesAll().length - 1];
      es.simulateError();
      // Advance well past any current backoff so the reconnect fires.
      vi.advanceTimersByTime(20_000);
    }
    // 1 initial + 6 reconnects = 7 total.
    expect(treeESesAll()).toHaveLength(7);

    // After saturating, the delay must still be 15s (not larger). Advance
    // 14_999ms → no reconnect; cross to 15s → reconnect.
    const saturated = treeESesAll()[treeESesAll().length - 1];
    saturated.simulateError();
    vi.advanceTimersByTime(14_999);
    expect(treeESesAll()).toHaveLength(7);
    vi.advanceTimersByTime(1);
    expect(treeESesAll()).toHaveLength(8);
  });

  it("resets the backoff to 1000ms on a successful open", () => {
    stream.connect();
    const first = treeESesAll()[0];
    first.simulateOpen();

    // Accumulate backoff via 2 CLOSED errors (timer 1000 then 2000).
    first.simulateError();
    vi.advanceTimersByTime(1000);
    const second = treeESesAll()[1];
    second.simulateError();
    vi.advanceTimersByTime(2000);
    const third = treeESesAll()[2];

    // Healthy open → onopen resets backoff to 1000ms.
    third.simulateOpen();

    // Another CLOSED must now use 1000ms (reset), not 8000ms (escalated).
    third.simulateError();
    vi.advanceTimersByTime(999);
    expect(treeESesAll()).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(treeESesAll()).toHaveLength(4);
  });
});

// ===========================================================================
// C-F2 gen-token invalidation. onerror bumps treeGen BEFORE cancelPendingOwner
// (stream.ts:2278-2280). After the bump, every listener registered on the
// pre-error ES captures a stale `gen`; its ENTRY guard (`if (gen !== treeGen)
// return;`) drops the callback before any state effect. This is the
// synchronous complement to coherentBarrier Case 6 (which proves the
// POST-AWAIT gen check drops a stale decode that started before the bump).
// Together they bracket the gen-guard surface: entry + post-await.
// ===========================================================================
describe("Stream1 onerror generation invalidation (C-F2 entry guard)", () => {
  it("a stale tree.snapshot on the pre-error ES does NOT start a decode or seed the tree", () => {
    stream.connect();
    const es = treeESesAll()[0];
    es.simulateOpen();
    const cursorBefore = store.state.cursor;

    // CLOSED → onerror → treeGen++ (the gen captured by es's listeners is now
    // stale). The reconnect timer is scheduled but NOT advanced here (we want
    // to probe the OLD es's listeners while no new connection exists).
    es.simulateError();
    expect(es.readyState).toBe(MockEventSource.CLOSED);
    expect(store.state.status).toBe("reconnecting");

    // Fire a gzip64 tree.snapshot on the pre-error ES. The tree.snapshot
    // listener's entry guard (stream.ts:1891 `if (gen !== treeGen) return;`)
    // must drop it BEFORE ensureOwner / the decode IIFE / markTreeSeen. No
    // owner is created, no decode starts, no clock refresh.
    es.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: "WOULD-NOT-DECODE-ANYWAY",
    }), "100");

    // Fire a detail `snapshot` on the same stale ES — same entry guard
    // (stream.ts:1780). No applySnapshot, no cursor advance.
    es.fire("snapshot", { seq: 100, epoch: "e1", sessions: [{ id: "sX" }] }, "100");

    // Nothing applied: tree empty, no detail sessions, no cursor movement, no
    // decode gate latched, readiness stays false.
    expect(treeState.treeMap().size).toBe(0);
    expect(Object.keys(store.state.sessions)).toHaveLength(0);
    expect(store.state.cursor).toBe(cursorBefore);
    expect(store.state.authoritativeReady).toBe(false);
    // The decode never started (entry guard returned before the IIFE).
    expect(stream.isTreeSnapshotDecoding()).toBe(false);
  });
});
