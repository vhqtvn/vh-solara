// Slice 5b fix (stale-ring repair, multiproject-latency A2/S5 regression):
// a cursor-preserving recovery reopen (watchdog CLOSED branch / sentinel
// timeout) whose resumed connection delivers NOTHING must fall back to ONE
// cursorless reopen so the server's fresh-snapshot branch confirms the
// repair. The bug: the 5b reopen can race the ring eviction — the replay is
// provably continuous at request time, but every event in range is
// interest-filtered (filler traffic on other sessions), so zero frames are
// ever written, refreshing[id] stays armed (only a snapshot clears it), and
// the repair is invisible forever.
//
// Cases:
//   (a) silent resume → fallback fires: new ES is CURSORLESS, counter
//       resume-silent-fallback = 1, the snapshot on it is accepted (fence 2
//       client half) and clears refreshing[id];
//   (b) delivered content (a snapshot ON the cursor connection) cancels the
//       fallback — no cursorless reopen;
//   (c) one-shot: the fallback's own connection does not re-arm;
//   (d) a full close (openSessionStream force) clears the armed timer.
//
// Harness mirrors sentinel.test.ts (MockEventSource + setupFresh with
// vi.resetModules).
// @vitest-environment jsdom
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

let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
let counters: typeof import("../../src/sync/recovery-reasons") = null as unknown as typeof import("../../src/sync/recovery-reasons");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  instances = [];
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  counters = await import("../../src/sync/recovery-reasons");
  store.setProjectDirRaw("/test");
  store.setSelectedIdRaw("s1");
}

beforeEach(async () => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
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
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

const sessionSnapshot = (seq: number, id = "s1") => ({
  seq,
  gate: { [id]: { messagesLoaded: true } },
  messages: {},
});

// openThenFatallyClose: open s1's Stream2, deliver one snapshot (seeds
// sesCursor=5), then close the ES the way the A2/S5 spec does (fatal close,
// no error dispatch) so the watchdog's 5b CLOSED branch is the only reopen
// actor. Returns the (now closed) connection.
async function openThenFatallyClose(): Promise<MockEventSource> {
  stream.openSessionStream("s1");
  const es = sessionESes()[0];
  es.simulateOpen();
  es.fire("snapshot", sessionSnapshot(5), "5");
  await flush();
  es.close();
  return es;
}

// runClosedWatchdog: one watchdog tick with the session stream fatally
// closed → the 5b branch reopens cursor-preserving. Returns the resumed
// connection.
function runClosedWatchdog(): MockEventSource {
  stream.watchdogTick();
  const resumed = sessionESes()[sessionESes().length - 1];
  expect(resumed.url).toContain("cursor=5"); // 5b: cursor PRESERVED
  return resumed;
}

describe("slice 5b fix: silent cursor-preserving resume → cursorless snapshot fallback", () => {
  it("(a) silent resume falls back cursorless once; snapshot on it is accepted and clears refreshing", async () => {
    await openThenFatallyClose();
    const resumed = runClosedWatchdog();
    expect(store.state.refreshing["s1"]).toBe(true); // armed by the reopen, only a snapshot clears it

    // Silence past the fallback window (ring replay interest-filtered →
    // nothing ever arrives on this connection).
    await vi.advanceTimersByTimeAsync(8_001);

    const sess = sessionESes();
    expect(sess).toHaveLength(3); // initial + cursor resume + cursorless fallback
    expect(sess[1]).toBe(resumed);
    expect(sess[2].url).not.toContain("cursor="); // CURSORLESS → server fresh-snapshot branch
    expect(counters.readSyncDiag().recovery["resume-silent-fallback"]?.count).toBe(1);

    // The fallback connection is still current; a snapshot delivered on it is
    // applied (fence 2 client half) and clears the refresh indicator.
    sess[2].simulateOpen();
    sess[2].fire("snapshot", sessionSnapshot(7), "7");
    await flush();
    expect(store.state.refreshing["s1"]).toBe(false);
  });

  it("(b) content on the resumed connection (snapshot ON the cursor conn) cancels the fallback", async () => {
    await openThenFatallyClose();
    const resumed = runClosedWatchdog();

    // The server's ring-gap answer arrives on the cursor connection itself
    // (hasCursor && !replayOK): a snapshot delivered mid-window.
    resumed.simulateOpen();
    resumed.fire("snapshot", sessionSnapshot(6), "6");
    await flush();

    await vi.advanceTimersByTimeAsync(20_000);
    expect(sessionESes()).toHaveLength(2); // no cursorless reopen — continuity was confirmed
    expect(counters.readSyncDiag().recovery["resume-silent-fallback"]).toBeUndefined();
    expect(store.state.refreshing["s1"]).toBe(false);
  });

  it("(c) one-shot: the fallback's own connection does not re-arm on further silence", async () => {
    await openThenFatallyClose();
    runClosedWatchdog();
    await vi.advanceTimersByTimeAsync(8_001);
    expect(sessionESes()).toHaveLength(3);

    // The fallback's cursorless connection stays silent (e.g. a server that
    // snapshotted then went quiet) — no further reconnects may be spawned.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sessionESes()).toHaveLength(3);
    expect(counters.readSyncDiag().recovery["resume-silent-fallback"]?.count).toBe(1);
  });

  it("(d) a full close (forced reopen) clears the armed fallback timer", async () => {
    await openThenFatallyClose();
    runClosedWatchdog();

    stream.openSessionStream("s1", true); // force → closeSessionStream clears the timer
    expect(sessionESes()).toHaveLength(3);

    await vi.advanceTimersByTimeAsync(20_000);
    expect(sessionESes()).toHaveLength(3); // the armed timer never fired
  });
});
