// @vitest-environment jsdom
//
// Phase 3 Step A.5 — GAP 1: busy-scope handshake in the tree=2 path.
//
// In tree=2 mode (?tree=2), reconcileBusy() sets expectTreeSnap=true and calls
// connect(true) to force a fresh tree.snapshot. Before the fix, the tree.snapshot
// listener's applyTreeSnap closure NEVER checked/cleared expectTreeSnap nor called
// maybeResolveReconcile() — so the reconcile-busy overlay only cleared via the
// 15s safety timeout (reconcileBusy → window.setTimeout(..., 15_000)).
//
// The fix mirrors the legacy proj=1 snapshot listener's handshake: when a
// tree.snapshot arrives and expectTreeSnap is true, clear it and call
// maybeResolveReconcile() so the busy scope releases PROMPTLY.
//
// This test drives the REAL reconcileBusy (registered by stream.ts at module
// load) through withGlobalBusy in tree=2 mode with NO session selected (so only
// the tree side gates reconciliation — expectSessionSnap is false). It fires a
// tree.snapshot (NOT a legacy snapshot) on the tree EventSource and asserts the
// reconcile promise resolves WITHOUT advancing the 15s fake timer.
//
// RED (pre-fix): the tree.snapshot listener would seedTreeStore but never clear
// expectTreeSnap / call maybeResolveReconcile → `op` hangs until the vitest test
// timeout (the 15s fake timer is never advanced in the GREEN path).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { withGlobalBusy, globalBusy } from "../../src/busy";
import { closeSessionStream } from "../../src/sync/stream";
import { setSelectedIdRaw, setProjectDirRaw } from "../../src/sync/store";

// --- Mock EventSource (mirrors reconcileBusy.test.ts, +lastEventId support) ---
// jsdom doesn't implement EventSource. The tree.snapshot listener reads
// Number(ev.lastEventId) for the resume cursor (F4: store seq from SSE id), so
// the mock must support a lastEventId field on fired events.
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

  /** Fire a named SSE event. lastEventId carries the store seq (F4). */
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

// The tree (Stream-1) EventSource has sessions=& (empty); a session Stream-2 ES
// has sessions=<id> (non-empty).
const treeESes = (): MockEventSource[] =>
  instances.filter((e) => !/sessions=[^&]/.test(e.url));

beforeEach(() => {
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  setProjectDirRaw("/test");
  // No session selected → reconcileBusy only sets expectTreeSnap (not
  // expectSessionSnap), isolating the tree-snapshot handshake under test.
  setSelectedIdRaw(null);
  // Enable tree=2 so connect() opens the tree.* stream path.
  window.history.replaceState({}, "", "/?tree=2");
});

afterEach(() => {
  closeSessionStream();
  vi.clearAllTimers();
  vi.useRealTimers();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
  window.history.replaceState({}, "", "/");
});

describe("reconcileBusy — prompt tree-snapshot handshake in tree=2 (Step A.5 GAP 1)", () => {
  it("resolves on tree.snapshot WITHOUT the 15s safety timeout (no expectTreeSnap leak)", async () => {
    // Fake timers: the 15s safety timeout is a faked setTimeout that must NOT
    // fire for the reconcile to be considered "prompt". If the fix were absent,
    // expectTreeSnap would stay true after tree.snapshot lands and `op` would
    // hang until vi.advanceTimersByTime(15_000) — which we never call.
    vi.useFakeTimers();

    // 1. withGlobalBusy releases → reconcileBusy runs (real, registered at load).
    //    No session selected → only connect(true) (creates tree ES); no
    //    openSessionStream call.
    const op = withGlobalBusy(async () => {});

    // Flush microtasks so reconcileBusy executes: connect(true) creates the
    // tree ES with the tree=2 URL.
    await vi.advanceTimersByTimeAsync(0);
    expect(treeESes()).toHaveLength(1);

    // 2. Fire the authoritative tree.snapshot → the fix clears expectTreeSnap
    //    and calls maybeResolveReconcile(), resolving the promise promptly.
    treeESes()[0].fire("tree.snapshot", { nodes: [] }, "1");

    // 3. The reconcile promise resolves WITHOUT advancing the 15s fake timer.
    //    Pre-fix this would hang (expectTreeSnap never cleared by tree.snapshot).
    await op;

    expect(globalBusy()).toBe(false);
  });
});
