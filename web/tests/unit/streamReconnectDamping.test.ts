// @vitest-environment jsdom
//
// F3 (remote-latency brief, 2026-10-12) — reconnect-storm damping, SPA side:
// the CONNECTING-streak takeover. Native EventSource auto-retry loops forever
// on the server-advertised `retry:` cadence and NEVER reaches CLOSED on its
// own — during a tunnel-down window every attempt 502s at the controller
// instantly (2,254 measured rejections, 11.3% of stream opens), so a fixed
// 2s hint meant N panes hammering the edge in lockstep forever.
//
// CONTRACT under test (both Stream1 tree-transport and Stream2
// session-stream):
//   1. Fewer than GIVEUP (3) consecutive CONNECTING onerrors: NO takeover —
//      the native retry loop owns recovery (a blip self-heals natively).
//   2. The GIVEUP-th consecutive CONNECTING onerror: the ES is closed and
//      the reopen is scheduled on the bounded manual backoff (tree 1s×2→15s
//      cap; session 1.5s×2→15s cap) — the storm cadence collapses.
//   3. Takeover backoff escalates: a second full streak waits 2× the first
//      wait before reopening.
//   4. A healthy open resets the streak (and the backoff).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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

  fire(type: string, data?: unknown, lastEventId?: string): void {
    const ev = new MessageEvent(type, {
      data:
        data === undefined
          ? undefined
          : typeof data === "string"
            ? data
            : JSON.stringify(data),
    });
    if (lastEventId !== undefined) {
      Object.defineProperty(ev, "lastEventId", { value: lastEventId });
    }
    const arr = this.listeners.get(type);
    if (arr) for (const fn of arr) fn(ev);
  }

  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  /** A failed connect attempt: still CONNECTING (native retry will follow),
   *  and the error callback fired — what a 502 at the edge looks like. */
  simulateConnectingError(): void {
    this.readyState = CONNECTING;
    this.onerror?.();
  }
}

let instances: MockEventSource[] = [];
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => /sessions=[^&]/.test(e.url));
const treeESes = (): MockEventSource[] =>
  instances.filter((e) => !/sessions=[^&]/.test(e.url));

let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  instances = [];
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  store.setProjectDirRaw("/test");
  store.setSelectedIdRaw("s1");
}

beforeEach(async () => {
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
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe("Stream1 (tree): CONNECTING-streak takeover", () => {
  it("under the streak threshold the native loop is left alone", () => {
    stream.connect();
    const es = treeESes()[0];
    es.simulateConnectingError();
    es.simulateConnectingError();
    expect(es.readyState, "no takeover below 3").toBe(CONNECTING);
    expect(treeESes(), "no manual reopen scheduled").toHaveLength(1);
  });

  it("the 3rd consecutive CONNECTING failure closes the ES and reopens on manual backoff", () => {
    stream.connect();
    const es = treeESes()[0];
    es.simulateConnectingError();
    es.simulateConnectingError();
    es.simulateConnectingError();
    expect(es.readyState, "takeover closed the looping ES").toBe(CLOSED);
    expect(treeESes(), "reopen not immediate").toHaveLength(1);
    vi.advanceTimersByTime(1000); // initial tree backoff
    expect(treeESes(), "manual-backoff reopen").toHaveLength(2);
  });

  it("takeover backoff escalates ×2 on a repeated full streak", () => {
    stream.connect();
    let es = treeESes()[0];
    for (let i = 0; i < 3; i++) es.simulateConnectingError();
    vi.advanceTimersByTime(1000);
    expect(treeESes()).toHaveLength(2);

    es = treeESes()[1];
    for (let i = 0; i < 3; i++) es.simulateConnectingError();
    vi.advanceTimersByTime(1999); // second wait is 2000ms (1s × 2)
    expect(treeESes(), "escalated backoff still pending at 1999ms").toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(treeESes(), "reopen after full 2000ms").toHaveLength(3);
  });

  it("a healthy open resets the streak AND the escalated backoff", () => {
    stream.connect();
    let es = treeESes()[0];
    // First full streak: escalates backoff to 2000 for the NEXT cycle.
    for (let i = 0; i < 3; i++) es.simulateConnectingError();
    vi.advanceTimersByTime(1000);
    expect(treeESes()).toHaveLength(2);

    // Partial streak (1 failure), then a HEALTHY open: the partial streak
    // must NOT count toward a later takeover, and the backoff resets to 1s.
    es = treeESes()[1];
    es.simulateConnectingError();
    es.simulateOpen();
    for (let i = 0; i < 2; i++) es.simulateConnectingError();
    expect(es.readyState, "1 pre-open + 2 post-open failures: still native").toBe(CONNECTING);
    es.simulateConnectingError();
    expect(es.readyState, "3 post-open failures: takeover").toBe(CLOSED);
    // Backoff was RESET by the healthy open — the reopen waits 1000ms, not 2000.
    vi.advanceTimersByTime(999);
    expect(treeESes(), "reset backoff still pending at 999ms").toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(treeESes(), "reopen after reset 1000ms backoff").toHaveLength(3);
  });
});

describe("Stream2 (session): CONNECTING-streak takeover", () => {
  it("the 3rd consecutive CONNECTING failure takes over; fewer do not", () => {
    stream.openSessionStream("s1");
    const es = sessionESes()[0];
    es.simulateConnectingError();
    es.simulateConnectingError();
    expect(es.readyState, "no takeover below 3").toBe(CONNECTING);
    es.simulateConnectingError();
    expect(es.readyState, "takeover closed the looping ES").toBe(CLOSED);
    expect(sessionESes(), "reopen not immediate").toHaveLength(1);
    vi.advanceTimersByTime(1500); // initial session backoff
    expect(sessionESes(), "manual-backoff reopen").toHaveLength(2);
  });

  it("a second streak with NO intervening open escalates to 3000ms", () => {
    stream.openSessionStream("s1");
    let es = sessionESes()[0];
    for (let i = 0; i < 3; i++) es.simulateConnectingError();
    vi.advanceTimersByTime(1500);
    expect(sessionESes()).toHaveLength(2);

    // Second full streak with no healthy open in between: 1500 × 2 = 3000ms.
    es = sessionESes()[1];
    for (let i = 0; i < 3; i++) es.simulateConnectingError();
    vi.advanceTimersByTime(2999);
    expect(sessionESes(), "escalated backoff still pending at 2999ms").toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sessionESes(), "reopen after full 3000ms").toHaveLength(3);
  });
});
