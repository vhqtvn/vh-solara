// @vitest-environment jsdom
//
// TREE CONTENT-STALL liveness probe — the Stream1 mirror of Lane C's
// sessionLivenessContentStall.test.ts (the deferred half called out in Lane C's
// DESIGN DEBATE: "Mirror with a treeContentSeen clock if Stream1 freeze symptoms
// surface").
//
// sessionLiveness Gate B proves a tree that goes SILENT (no pings, no content)
// reconnects while session pings keep flowing. That works because treeLastSeen
// ages out past STALE_MS.
//
// THIS test probes the residual gap on Stream1: a tree whose TRANSPORT stays
// alive (server pings every 15s) but delivers ZERO content (no snapshot /
// tree.op / session.* / etc). Before the fix, the tree `ping` listener called
// markTreeSeen(), which refreshed treeLastSeen — the ONLY tree clock the
// watchdog's tree branch read (`Date.now() - treeLastSeen > STALE_MS`). So pings
// kept that clock fresh forever and a content-stall was INVISIBLE to the
// watchdog: no reconnect, and the operator-visible symptom — a completed
// subsession sticking "running" until reload (the stuck-running-node gap) — sat
// with no recovery signal.
//
// FIX (Stream1 mirror of Lane C): a second, content-only clock `treeContentSeen`
// refreshed by snapshot/tree.snapshot/tree.op/snapshot.complete/pins.*/session.*/
// TREE_STREAM_KINDS/notice/onopen but NEVER by ping (the tree ping listener now
// calls markTreeTransportSeen — transport only). The watchdog's tree branch
// reconnects when EITHER clock ages out: treeLastSeen past STALE_MS (transport
// dead) OR treeContentSeen past CONTENT_STALE_MS (content stalled, transport
// alive). Threshold REUSES CONTENT_STALE_MS=120s (no tree-specific threshold):
// the tree's normal content cadence is HIGHER than Stream2's (tree.snapshot +
// tree.op + session.upsert + activity.* flow frequently, AND runStatusReconcile
// SR60 emits a fresh tree content event every ≤60s as a server-side backstop),
// so 120s is, if anything, MORE conservative for the tree.
//
// The SESSION stream is the CONTROL here (content FLOWS — a snapshot each cycle —
// so sessionContentSeen stays fresh and it must NOT reconnect). This is the
// inverse of Lane C's test, where the tree was the ping-only control: now that
// BOTH streams carry a content clock, the control must have flowing content.
//
// Recovery-path note (deliberate difference from Lane C's session test): the
// tree watchdog calls connect() (NOT connect(true)) — the tree has no
// openSessionStream-style "already-open" guard to bypass, so a plain connect()
// always tears down (treeGen++, es.close()) and rebuilds. So the replacement
// tree URL is CURSORED (resumes from state.cursor), not cursorless — this test
// does NOT assert a cursorless URL (that is a Stream2-only property proven by
// Gate G); it asserts the reconnect happened (2nd tree ES, old one CLOSED).
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

// Minimal tree snapshot (RAW detail) to seed initial tree content + the
// treeContentSeen baseline (the snapshot listener calls markTreeSeen).
const treeSnapshot = (seq: number, sessionIds: string[] = ["s1"]) => ({
  seq,
  sessions: sessionIds.map((id) => ({ id })),
});
// Minimal session snapshot for the control stream.
const sessionSnapshot = (seq: number, id = "s1") => ({
  seq,
  gate: { [id]: { messagesLoaded: true } },
  messages: {},
});

describe("tree content-stall: pings keep treeLastSeen fresh but treeContentSeen ages out → reconnect", () => {
  it("a tree with healthy pings but ZERO content past CONTENT_STALE_MS reconnects (content-stall detected)", async () => {
    // Open both streams.
    stream.connect();
    treeESes()[0].simulateOpen();
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await flush();

    // ONE tree snapshot to seed the treeContentSeen content baseline (a
    // realistic tree that delivered initial content, then goes content-silent
    // while the transport keeps pinging).
    treeESes()[0].fire("snapshot", treeSnapshot(1), "1");
    // ONE session snapshot so the control stream has a content baseline too.
    sessionESes()[0].fire("snapshot", sessionSnapshot(1), "1");
    await flush();

    // Cycles of ONLY tree pings (transport alive) with ZERO tree content. The
    // tree ping refreshes treeLastSeen (transport clock) but NOT treeContentSeen
    // (content clock) → the content clock ages out and once it crosses
    // CONTENT_STALE_MS (120s) the watchdog forces a reconnect.
    //
    // The SESSION control gets a ping PLUS a fresh snapshot each cycle (content
    // FLOWS → sessionContentSeen stays fresh → it must NOT reconnect), proving
    // the tree detection is isolated.
    //
    // 9 cycles × 15s = 135s > CONTENT_STALE_MS(120s) → the tree reconnect fires
    // at cycle 8 (the first tick where the content clock is > 120s old).
    for (let cycle = 0; cycle < 9; cycle++) {
      vi.advanceTimersByTime(15_000);
      treeESes()[0].fire("ping"); // treeLastSeen fresh (transport alive)...
      // deliberately NO tree snapshot/tree.op/session.*/etc → content stall on the tree
      sessionESes()[0].fire("ping"); // session transport fresh
      sessionESes()[0].fire("snapshot", sessionSnapshot(cycle + 2), String(cycle + 2)); // session content flows
      stream.watchdogTick();
    }

    // A SECOND tree EventSource is created (the content-stall forced a reconnect
    // via connect(): treeGen++, old es.close(), fresh EventSource).
    expect(treeESes()).toHaveLength(2);
    expect(treeESes()[0].readyState).toBe(CLOSED);

    // Session control: content flowed each cycle → NO reconnect (reverse
    // isolation — the session detection is independent of the tree's).
    expect(sessionESes()).toHaveLength(1);
    expect(sessionESes()[0].readyState).toBe(OPEN);

    // No tight loop: the replacement seeded a fresh treeContentSeen at
    // construction (markTreeSeen in connect, right after `new EventSource`) →
    // an immediate re-tick creates no 3rd tree ES.
    stream.watchdogTick();
    expect(treeESes()).toHaveLength(2);
  });
});
