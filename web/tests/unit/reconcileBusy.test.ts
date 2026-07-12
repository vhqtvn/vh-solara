// @vitest-environment jsdom
//
// Regression test for T1B-F1: reconcileBusy() must force a genuinely fresh
// selected-session snapshot when a session is selected, even if the Stream-2
// EventSource is already healthy/open. Without the fix (openSessionStream
// `force` param), the early-return at the top of openSessionStream skipped the
// reconnect, expectSessionSnap stayed true, and the overlay only cleared via
// the 15s safety timeout — the exact UX this feature exists to fix.
//
// This test drives the REAL reconcileBusy (registered by stream.ts at module
// load) through withGlobalBusy, so it exercises connect(true) +
// openSessionStream(sel, true) end-to-end. A mock EventSource replaces jsdom's
// (absent) implementation so we can assert the ES was recreated and fire the
// authoritative snapshots that resolve reconciliation.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { withGlobalBusy, globalBusy } from "../../src/busy";
import { openSessionStream, closeSessionStream } from "../../src/sync/stream";
import { setSelectedIdRaw, setProjectDirRaw } from "../../src/sync/store";

// --- Mock EventSource ---
// jsdom doesn't implement EventSource. This mock tracks construction (so the
// test can assert a fresh ES was created) and lets the test fire named SSE
// events (snapshot/ping) to drive the stream listeners exactly like the real
// EventSource would. The static CLOSED/OPEN/CONNECTING constants mirror the
// real EventSource's readyState enum — stream.ts reads EventSource.CLOSED.
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

  // --- test helpers (not part of the EventSource API) ---
  /** Fire a named SSE event with a JSON-serializable payload. */
  fire(type: string, data: unknown): void {
    const ev = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
    const arr = this.listeners.get(type);
    if (arr) for (const fn of arr) fn(ev);
  }

  /** Simulate the EventSource transitioning to OPEN (fires onopen). */
  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }
}

let instances: MockEventSource[] = [];

// Session stream URL carries sessions=<id> (non-empty); tree stream has
// sessions=& (empty) — see connect() and openSessionStream() in stream.ts.
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => /sessions=[^&]/.test(e.url));
const treeESes = (): MockEventSource[] =>
  instances.filter((e) => !/sessions=[^&]/.test(e.url));

beforeEach(() => {
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  setProjectDirRaw("/test");
  setSelectedIdRaw("s1");
});

afterEach(() => {
  closeSessionStream();
  vi.clearAllTimers();
  vi.useRealTimers();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe("reconcileBusy — force fresh selected-session snapshot (T1B-F1)", () => {
  it("recreates the Stream-2 EventSource when already healthy/open and resolves without the 15s safety timeout", async () => {
    // Fake timers: the 15s safety timeout is a faked setTimeout that must NOT
    // fire for the reconcile to be considered "prompt". If the fix were absent,
    // expectSessionSnap would stay true and `op` would only resolve after
    // vi.advanceTimersByTime(15_000) — which we never call.
    vi.useFakeTimers();

    // 1. Open the session stream — creates the first session ES.
    openSessionStream("s1");
    expect(sessionESes()).toHaveLength(1);
    // Simulate it being healthy (onopen fired, readyState=OPEN). This is the
    // precondition that triggered T1B-F1: without force, reconcileBusy's
    // openSessionStream(sel) early-returns because sesId==="s1" &&
    // ses.readyState !== CLOSED.
    sessionESes()[0].simulateOpen();

    // 2. withGlobalBusy releases → reconcileBusy runs (the real one registered
    //    by stream.ts at module load).
    const op = withGlobalBusy(async () => {});

    // Flush microtasks so reconcileBusy executes: connect(true) creates the
    // tree ES, openSessionStream(sel, true) forces a fresh session ES.
    await vi.advanceTimersByTimeAsync(0);

    // 3. THE FIX: openSessionStream(sel, true) bypassed the early-return and
    //    recreated the session ES even though it was already healthy/open.
    expect(sessionESes()).toHaveLength(2);
    // The first session ES was closed (recreated, not reused).
    expect(sessionESes()[0].readyState).toBe(CLOSED);
    // A tree ES was also created by connect(true).
    expect(treeESes()).toHaveLength(1);

    // 4. Fire the tree snapshot → clears expectTreeSnap.
    treeESes()[0].fire("snapshot", { seq: 1, sessions: [{ id: "s1" }] });

    // 5. Fire the session snapshot on the FRESH (second) ES → clears
    //    expectSessionSnap → maybeResolveReconcile resolves the promise.
    sessionESes()[1].fire("snapshot", {
      seq: 1,
      gate: { s1: { messagesLoaded: true } },
      messages: {},
    });

    // 6. The reconcile promise resolves WITHOUT advancing the 15s fake timer.
    //    If the fix were absent, the forced reconnect would not have happened,
    //    expectSessionSnap would still be true, and `op` would hang until the
    //    15s safety timeout — which under fake timers never fires unless we
    //    explicitly advance time. The vitest test timeout (5s) would fail first.
    await op;

    expect(globalBusy()).toBe(false);
  });
});
