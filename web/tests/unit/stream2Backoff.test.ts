// @vitest-environment jsdom
//
// Phase 3-F proving tests: Stream2 (active-session stream) CLOSED-reopen
// exponential backoff.
//
// BUG: on a fatal CLOSED, the native EventSource does NOT honor `retry:` (that
// governs only the internal CONNECTING reconnect). The manual reopen path used a
// FIXED 1500ms timer with NO backoff, so a genuine CLOSED storm reopened every
// 1.5s — unlike Stream1's exponential backoff to 15s (stream.ts ~1862).
//
// FIX: add `sesBackoff` mirroring Stream1's backoff — doubles per consecutive
// CLOSED failure, capped at 15s, reset to 1500ms on a healthy open.
//
// These tests prove: (1) consecutive CLOSED errors increase the reopen delay;
// (2) the delay is capped at 15s; (3) a successful open resets the backoff.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock EventSource — same shape as sessionLiveness.test.ts.
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
}

let instances: MockEventSource[] = [];
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => /sessions=[^&]/.test(e.url));

let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
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

describe("Stream2 CLOSED-reopen backoff (Phase 3-F)", () => {
  it("increases the reopen delay on consecutive CLOSED errors", () => {
    stream.openSessionStream("s1");
    // openSessionStream creates the first EventSource immediately.
    expect(sessionESes()).toHaveLength(1);
    const first = sessionESes()[0];

    // --- 1st CLOSED: backoff starts at 1500ms ---
    first.simulateError();
    // Advance just before 1500ms → no reopen yet.
    vi.advanceTimersByTime(1499);
    expect(sessionESes()).toHaveLength(1);
    // Cross 1500ms → reopen fires.
    vi.advanceTimersByTime(1);
    expect(sessionESes()).toHaveLength(2);

    // --- 2nd CLOSED: backoff doubled to 3000ms ---
    const second = sessionESes()[1];
    second.simulateError();
    vi.advanceTimersByTime(2999);
    expect(sessionESes()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sessionESes()).toHaveLength(3);

    // --- 3rd CLOSED: backoff doubled to 6000ms ---
    const third = sessionESes()[2];
    third.simulateError();
    vi.advanceTimersByTime(5999);
    expect(sessionESes()).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sessionESes()).toHaveLength(4);
  });

  it("caps the reopen delay at 15s", () => {
    stream.openSessionStream("s1");
    // Fire enough CLOSED errors to saturate the 15s cap.
    // Backoff sequence: 1500, 3000, 6000, 12000, 15000(capped), 15000(capped)...
    for (let i = 0; i < 6; i++) {
      const es = sessionESes()[sessionESes().length - 1];
      es.simulateError();
      // Advance by a very large amount to guarantee the timer fires regardless
      // of the current backoff value.
      vi.advanceTimersByTime(20_000);
    }
    // 1 initial + 6 reopens = 7 total.
    expect(sessionESes()).toHaveLength(7);

    // After saturating, the next delay must still be 15s (not larger). Advance
    // 14s → no reopen. Advance to 15s → reopen.
    const saturated = sessionESes()[sessionESes().length - 1];
    saturated.simulateError();
    vi.advanceTimersByTime(14_999);
    expect(sessionESes()).toHaveLength(7);
    vi.advanceTimersByTime(1);
    expect(sessionESes()).toHaveLength(8);
  });

  it("resets the backoff to 1500ms on a successful open", () => {
    stream.openSessionStream("s1");
    const first = sessionESes()[0];

    // Accumulate backoff via 2 CLOSED errors (→ 3000ms).
    first.simulateError();
    vi.advanceTimersByTime(1500);
    const second = sessionESes()[1];
    second.simulateError();
    vi.advanceTimersByTime(3000);
    const third = sessionESes()[2];

    // Now simulate a HEALTHY open: the backoff should reset to 1500ms.
    third.simulateOpen();

    // Fire another CLOSED — the reopen delay must be 1500ms (reset), not 6000ms.
    third.simulateError();
    vi.advanceTimersByTime(1499);
    expect(sessionESes()).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(sessionESes()).toHaveLength(4);
  });
});
