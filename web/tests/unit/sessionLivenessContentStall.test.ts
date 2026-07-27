// @vitest-environment jsdom
//
// CONTENT-STALL liveness probe — the inverse of sessionLiveness.test.ts Gate A.
//
// Gate A proves a session that goes SILENT (no pings, no content) reconnects
// while tree pings keep flowing. That works because sessionLastSeen ages out.
//
// THIS test probes the residual gap: a session whose TRANSPORT stays alive
// (server pings every 15s) but delivers ZERO content (no snapshot / message /
// part). Before the fix, the session `ping` listener called markSessionSeen(),
// which refreshed sessionLastSeen — the SAME clock the watchdog's staleness
// check (`Date.now() - sessionLastSeen > STALE_MS`) read. So pings kept that
// clock fresh forever and a content-stall was INVISIBLE to the watchdog: no
// reconnect, the frozen transcript sat with no recovery signal.
//
// FIX (Lane C): a second, content-only clock `sessionContentSeen` refreshed by
// snapshot/message.*/onopen but NEVER by ping (the ping listener now calls
// markSessionTransportSeen — transport only). The watchdog reconnects when
// EITHER clock ages out: sessionLastSeen past STALE_MS (transport dead) OR
// sessionContentSeen past CONTENT_STALE_MS (content stalled, transport alive).
// Threshold is deliberately conservative (CONTENT_STALE_MS = 120s): during
// active reasoning tokens stream as message.part.delta (content flows), so a
// genuine 120s content gap is abnormal; but tool-execution / between-turn gaps
// can legitimately silence content for tens of seconds, and a lower threshold
// would churn the connection during normal deep-reasoning silences.
//
// The tree stream is the CONTROL here (ping-only, no tree content clock —
// Stream1's equivalent conflation is a documented latent gap backstopped by
// runStatusReconcile; see stream.ts). So tree pings alone keep it healthy and
// it must NOT reconnect — proving the session detection is isolated.
//
// Self-contained harness (MockEventSource + setupFresh duplicated from
// sessionLiveness.test.ts because that file does not export its helpers).
// Fake timers — the watchdog is wall-clock driven.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock EventSource — mirrors sessionLiveness.test.ts.
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

  fire(type: string, data: unknown, lastEventId?: string): void {
    const ev = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
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
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  store.setProjectDirRaw("/test");
  store.setSelectedIdRaw("s1");
}

// Flush microtasks from fire-and-forget async paths.
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(async () => {
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
  );
  window.localStorage.clear();
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
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

// Minimal session snapshot (RAW) to seed initial content + the sessionLastSeen
// baseline (the snapshot listener calls markSessionSeen).
const sessionSnapshot = (seq: number, id = "s1") => ({
  seq,
  gate: { [id]: { messagesLoaded: true } },
  messages: {},
});

describe("content-stall: pings keep sessionLastSeen fresh but sessionContentSeen ages out → reconnect", () => {
  it("a session with healthy pings but ZERO content past CONTENT_STALE_MS reconnects (content-stall detected)", async () => {
    // Open both streams.
    stream.connect();
    treeESes()[0].simulateOpen();
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await flush();

    // ONE snapshot to seed the sessionContentSeen content baseline (a realistic
    // session that delivered initial content, then goes content-silent while
    // the transport keeps pinging).
    sessionESes()[0].fire("snapshot", sessionSnapshot(1), "1");
    await flush();

    // Cycles of ONLY pings (transport alive) with ZERO content events. Both
    // streams receive a server ping every 15s; the watchdog runs each cycle.
    // The session ping refreshes sessionLastSeen (transport clock) but NOT
    // sessionContentSeen (content clock) → the content clock ages out and once
    // it crosses CONTENT_STALE_MS (120s) the watchdog forces a reconnect.
    //
    // 9 cycles × 15s = 135s > CONTENT_STALE_MS(120s) → the reconnect fires at
    // cycle 8 (the first tick where the content clock is > 120s old). The tree
    // is the CONTROL (ping-only; Stream1 has no content clock) so it stays
    // healthy throughout and must NOT reconnect.
    for (let cycle = 0; cycle < 9; cycle++) {
      vi.advanceTimersByTime(15_000);
      treeESes()[0].fire("ping"); // treeLastSeen fresh (tree control stays healthy)
      sessionESes()[0].fire("ping"); // sessionLastSeen fresh (transport alive)...
      // deliberately NO snapshot/message/part → content stall on the session
      stream.watchdogTick();
    }

    // A SECOND session EventSource is created (the content-stall forced a
    // fresh-snapshot reconnect via openSessionStream(id, true)).
    expect(sessionESes()).toHaveLength(2);

    // The replacement URL is cursorless (force=true re-sync path).
    expect(sessionESes()[1].url).not.toMatch(/cursor=/);

    // Tree ES unchanged (reverse isolation — the tree control was healthy via
    // its pings; Stream1 has no content clock so it is unaffected).
    expect(treeESes()).toHaveLength(1);
    expect(treeESes()[0].readyState).toBe(OPEN);

    // No tight loop: the replacement seeded a fresh sessionContentSeen at
    // construction (markSessionSeen in open) → an immediate re-tick creates no
    // 3rd session ES.
    stream.watchdogTick();
    expect(sessionESes()).toHaveLength(2);
  });
});
