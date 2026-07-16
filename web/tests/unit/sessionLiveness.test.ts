// @vitest-environment jsdom
//
// Regression tests for the dead-but-OPEN Stream-2 masking bug.
//
// BUG: stream.ts used ONE shared `lastSeen` clock updated by BOTH SSE streams.
// The tree stream (Stream-1) receives a server `ping` every 15s, keeping the
// shared timestamp fresh forever — so the watchdog's `Date.now() - lastSeen >
// STALE_MS` (45s) could NEVER age out a dead Stream-2 while the tree was
// healthy. The result: a frozen transcript with the `updating` pulse lit, no
// reconnect, no signal.
//
// FIX: two independent liveness clocks (`treeLastSeen` / `sessionLastSeen`),
// each updated ONLY by its own stream's callbacks, plus a connection-generation
// guard (`sesGen`) so a stale Stream-2 callback cannot refresh the replacement's
// clock. The watchdog evaluates each stream independently and reconnects a
// stale/closed Stream-2 via the existing forced fresh-snapshot path
// (`openSessionStream(id, true)`).
//
// These tests cover acceptance gates A–H from the task contract. Each test uses
// `vi.resetModules()` + dynamic import to get a FRESH set of module-private
// clocks (treeLastSeen/sessionLastSeen/sesGen) and a fresh store, so they are
// fully isolated from each other.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock EventSource — mirrors the real EventSource's readyState enum and lets
// the test fire named SSE events (snapshot/ping/message.*) + lastEventId.
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

  // --- test helpers (not part of the EventSource API) ---

  /** Fire a named SSE event with a JSON-serializable payload + optional SSE id. */
  fire(type: string, data: unknown, lastEventId?: string): void {
    const ev = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
    // jsdom's MessageEvent constructor drops lastEventId from init; set it on the
    // instance so `ev.lastEventId` reads correctly (stream.ts reads it for cursor
    // advancement on tree frames and seq-stamping on session frames).
    if (lastEventId !== undefined) {
      Object.defineProperty(ev, "lastEventId", { value: lastEventId });
    }
    const arr = this.listeners.get(type);
    if (arr) for (const fn of arr) fn(ev);
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

// All MockEventSource instances ever constructed (across all connect/reconnect
// calls within one test). A CLOSED instance stays in the list so the test can
// assert "the OLD one was closed and exactly ONE replacement was created".
let instances: MockEventSource[] = [];

// Session stream URL: `?sessions=s1&...` (non-empty). Tree stream URL:
// `?cursor=0&sessions=&...` (empty sessions). Classify by that.
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => /sessions=[^&]/.test(e.url));
const treeESes = (): MockEventSource[] =>
  instances.filter((e) => !/sessions=[^&]/.test(e.url));

// jsdom defaults document.visibilityState to "visible"; override per-test for
// the background/mobile-return gate.
const setVisibility = (v: "hidden" | "visible"): void => {
  Object.defineProperty(document, "visibilityState", {
    value: v,
    configurable: true,
  });
};

// Flush microtasks from fire-and-forget async paths (refreshOpenSessions etc.).
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

// ---------------------------------------------------------------------------
// Per-test module isolation: resetModules + dynamic import gives fresh
// module-private vars (treeLastSeen/sessionLastSeen/sesGen) + a fresh store.
// stream.ts and store.ts share the same module-registry entry for store, so
// `stream`'s imports of `state`/`setState` reference the SAME store instance.
// ---------------------------------------------------------------------------
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
  // Stub fetch: stream.ts fire-and-forget calls (refreshOpenSessions →
  // fetchSessionMessages, checkVersionNow on 2nd+ tree open) must not produce
  // unhandled rejections or real network attempts under jsdom.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
  );
  // Clear persisted cursor/sessions so each test starts from a clean store.
  window.localStorage.clear();
  setVisibility("visible");
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

// ---------------------------------------------------------------------------
// Minimal valid payloads (verified against stream.ts snapshot/message handlers)
// ---------------------------------------------------------------------------
const treeSnapshot = (seq: number, sessionIds: string[] = ["s1"]) => ({
  seq,
  sessions: sessionIds.map((id) => ({ id })),
});
const sessionSnapshot = (seq: number, id = "s1") => ({
  seq,
  gate: { [id]: { messagesLoaded: true } },
  messages: {},
});

// ===========================================================================
// Gate A: dead-but-OPEN Stream-2 — tree pings must NOT mask session death.
// ===========================================================================
describe("A — dead-but-OPEN Stream-2", () => {
  it("reconnects ONLY the session stream when tree pings keep flowing but session goes silent", async () => {
    // Open both streams and bring them OPEN.
    stream.connect();
    treeESes()[0].simulateOpen();
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await flush();

    // Both clocks seeded at construction. Advance time and keep the TREE fresh
    // with regular pings while delivering NO session events.
    vi.advanceTimersByTime(20_000);
    treeESes()[0].fire("ping"); // treeLastSeen = T+20s
    vi.advanceTimersByTime(20_000);
    treeESes()[0].fire("ping"); // treeLastSeen = T+40s
    vi.advanceTimersByTime(6_000); // now T+46s

    // sessionLastSeen is still T0 (46s old) > STALE_MS; treeLastSeen is 6s fresh.
    stream.watchdogTick();

    // Old session ES closed; exactly ONE replacement created; tree untouched.
    expect(sessionESes()).toHaveLength(2);
    expect(sessionESes()[0].readyState).toBe(CLOSED);
    expect(sessionESes()[1].readyState).toBe(CONNECTING);
    expect(treeESes()).toHaveLength(1);
    expect(treeESes()[0].readyState).toBe(OPEN);

    // No tight loop: immediately re-ticking does NOT create a 3rd session ES
    // (the replacement seeded a fresh deadline via markSessionSeen in open()).
    stream.watchdogTick();
    expect(sessionESes()).toHaveLength(2);
  });
});

// ===========================================================================
// Gate B: reverse isolation — session healthy, tree dead → tree reconnects.
// ===========================================================================
describe("B — reverse isolation", () => {
  it("reconnects ONLY the tree stream when session pings keep flowing but tree goes silent", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await flush();

    // Deliver pings ONLY to the session stream.
    vi.advanceTimersByTime(20_000);
    sessionESes()[0].fire("ping"); // sessionLastSeen = T+20s
    vi.advanceTimersByTime(26_000); // now T+46s

    // treeLastSeen is T0 (46s old) > STALE_MS; sessionLastSeen is 26s fresh.
    stream.watchdogTick();

    expect(treeESes()).toHaveLength(2);
    expect(treeESes()[0].readyState).toBe(CLOSED);
    expect(sessionESes()).toHaveLength(1);
    expect(sessionESes()[0].readyState).toBe(OPEN);
  });
});

// ===========================================================================
// Gate C: idle-session stability — regular session pings keep it alive; then
// suppressing pings (while staying OPEN) triggers reconnect.
// ===========================================================================
describe("C — idle-session stability", () => {
  it("does NOT reconnect while session pings arrive at server cadence, then DOES when they stop", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await flush();

    // Server pings every 15s on BOTH streams (tree stays healthy too, to avoid
    // tree-reconnect noise polluting the session assertion). Cross multiple
    // STALE_MS windows — a healthy idle session must NOT be churned.
    for (let t = 0; t < 4; t++) {
      vi.advanceTimersByTime(15_000);
      treeESes()[0].fire("ping");
      sessionESes()[0].fire("ping");
      stream.watchdogTick();
    }
    // 60s elapsed, 4 watchdog ticks, session pinged every 15s → no reconnect.
    expect(sessionESes()).toHaveLength(1);
    expect(treeESes()).toHaveLength(1);

    // Now STOP session pings (keep tree pings flowing). After STALE_MS the
    // session (still OPEN) must be forcibly reconnected, but the tree must NOT.
    vi.advanceTimersByTime(46_000);
    treeESes()[0].fire("ping"); // keep tree fresh at the watchdog tick boundary
    stream.watchdogTick();

    expect(sessionESes()).toHaveLength(2);
    expect(sessionESes()[0].readyState).toBe(CLOSED);
    // Tree was NOT reconnected (it got pings throughout).
    expect(treeESes().filter((e) => e.readyState !== CLOSED)).toHaveLength(1);
  });
});

// ===========================================================================
// Gate D: background/mobile return — hidden tab stands down; on return the
// stale session reconnects while the healthy tree is untouched.
// ===========================================================================
describe("D — background/mobile return", () => {
  it("does NOT reconnect while hidden, then reconnects the session on foreground", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await flush();

    // Go hidden, age past STALE_MS, keep tree fresh via a ping right before the
    // (suppressed) tick.
    setVisibility("hidden");
    vi.advanceTimersByTime(46_000);
    treeESes()[0].fire("ping"); // treeLastSeen fresh; sessionLastSeen 46s stale
    stream.watchdogTick(); // hidden → early-return, NO reconnect
    expect(sessionESes()).toHaveLength(1);

    // Foreground: maybeReconnect → tree OPEN → watchdogTick → session stale.
    setVisibility("visible");
    stream.maybeReconnect();
    await flush();

    expect(sessionESes()).toHaveLength(2);
    expect(sessionESes()[0].readyState).toBe(CLOSED);
    // Tree untouched (it was healthy via its ping).
    expect(treeESes().filter((e) => e.readyState !== CLOSED)).toHaveLength(1);
  });
});

// ===========================================================================
// Gate E: slow connection init — a CONNECTING (not-yet-open) Stream-2 is given
// a fresh deadline; no premature recreation; bounded recovery past the deadline.
// ===========================================================================
describe("E — slow connection init", () => {
  it("does NOT recreate a CONNECTING Stream-2 before the deadline, then recovers past it", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();
    // Keep the tree healthy throughout (fire a ping every 15s) so tree-reconnect
    // noise does not pollute the session-focused assertion.
    // Open the session stream but do NOT simulateOpen — it stays CONNECTING.
    stream.openSessionStream("s1");
    await flush();
    expect(sessionESes()[0].readyState).toBe(CONNECTING);

    // open() seeds sessionLastSeen at construction → 30s in is still < STALE_MS.
    vi.advanceTimersByTime(15_000);
    treeESes()[0].fire("ping");
    vi.advanceTimersByTime(15_000); // 30s total
    treeESes()[0].fire("ping");
    stream.watchdogTick();
    expect(sessionESes()).toHaveLength(1);

    // Cross the deadline: CONNECTING is not CLOSED, but sessionLastSeen is now
    // > STALE_MS old → forced fresh-snapshot reconnect.
    vi.advanceTimersByTime(20_000); // 50s total > 45s
    treeESes()[0].fire("ping"); // keep tree fresh at the tick boundary
    stream.watchdogTick();
    expect(sessionESes()).toHaveLength(2);
    expect(sessionESes()[0].readyState).toBe(CLOSED);
    expect(sessionESes()[1].readyState).toBe(CONNECTING);
  });
});

// ===========================================================================
// Gate F: selection race — switching selection before the watchdog decision
// must NOT create a replacement for the stale old session.
// ===========================================================================
describe("F — selection race", () => {
  it("does NOT replace the stale old session when selection switches before the watchdog tick", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await flush();

    // Age near-stale but not yet past STALE_MS, then switch selection to s2.
    vi.advanceTimersByTime(40_000);
    store.setSelectedIdRaw("s2");
    stream.openSessionStream("s2"); // closes s1 ES (sesGen++, sessionLastSeen=0)
    await flush();

    // s1 ES is CLOSED; s2 ES is CONNECTING. No replacement for s1 should appear.
    stream.watchdogTick();

    const live = sessionESes().filter((e) => e.readyState !== CLOSED);
    expect(live).toHaveLength(1);
    expect(live[0].url).toContain("sessions=s2");
    // The closed s1 ES is still in history but no THIRD session ES was created.
    expect(sessionESes()).toHaveLength(2);
    expect(sessionESes()[0].url).toContain("sessions=s1");
    expect(sessionESes()[0].readyState).toBe(CLOSED);
  });
});

// ===========================================================================
// Gate G: cursor invariants — forced Stream-2 reconnect is cursorless; Stream-2
// frames never advance the shared cursor; Stream-1 retains cursor-resume.
// ===========================================================================
describe("G — cursor invariants", () => {
  it("forced Stream-2 reconnect URL has no cursor; Stream-2 frames do not advance it; tree retains resume cursor", async () => {
    // Tree snapshot advances the shared cursor to 42.
    stream.connect();
    treeESes()[0].simulateOpen();
    treeESes()[0].fire("snapshot", treeSnapshot(42));
    await flush();
    expect(store.state.cursor).toBe(42);

    // Open session stream, age it stale (keep tree healthy via a ping).
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    vi.advanceTimersByTime(46_000);
    treeESes()[0].fire("ping"); // keep tree fresh so only the session reconnects
    stream.watchdogTick();
    await flush();

    const replacement = sessionESes()[1];
    // Stream-2 URL is cursorless by construction (trackCursor:false end-to-end).
    expect(replacement.url).not.toMatch(/cursor=/);

    // Seed messages[s1] via the replacement's snapshot, then fire a message
    // frame whose SSE id is 999 — Stream-2 must NOT stamp it into state.cursor.
    replacement.simulateOpen();
    replacement.fire("snapshot", sessionSnapshot(1));
    replacement.fire("message.upsert", { sessionID: "s1", id: "m1" }, "999");
    await flush();
    expect(store.state.cursor).toBe(42); // unchanged

    // Tree reconnect (non-fresh connect) must resume from cursor=42.
    stream.connect();
    const newTreeES = treeESes().filter((e) => e.readyState !== CLOSED)[0];
    expect(newTreeES.url).toMatch(/cursor=42&/);
  });
});

// ===========================================================================
// Gate H: reconnect boundedness — a permanently silent-but-OPEN Stream-2
// reconnects at ~STALE_MS cadence (NOT every 10s watchdog tick), and each new
// connection gets a fresh deadline (no tight construction/close loop).
// ===========================================================================
describe("H — reconnect boundedness", () => {
  it("reconnects at STALE_MS cadence, not every watchdog tick; fresh deadline per connection", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await flush();

    // Silence the session (OPEN, no events). Past STALE_MS → one reconnect.
    // Keep tree healthy throughout so assertions focus purely on session cadence.
    vi.advanceTimersByTime(46_000);
    treeESes()[0].fire("ping");
    stream.watchdogTick();
    expect(sessionESes()).toHaveLength(2);

    // Immediate re-tick: the replacement seeded a fresh deadline → no reconnect.
    stream.watchdogTick();
    expect(sessionESes()).toHaveLength(2);

    // A 10s-tick cadence must NOT reconnect (well within the fresh deadline).
    vi.advanceTimersByTime(10_000);
    treeESes()[0].fire("ping");
    stream.watchdogTick();
    expect(sessionESes()).toHaveLength(2);

    // Only after another full STALE_MS window does the next reconnect happen.
    vi.advanceTimersByTime(36_000); // 46s total since the replacement
    treeESes()[0].fire("ping");
    stream.watchdogTick();
    expect(sessionESes()).toHaveLength(3);
    expect(sessionESes()[1].readyState).toBe(CLOSED);
  });
});

// ===========================================================================
// Gate I: stale async decode — a superseded connection's late decode must NOT
// mutate messages, reveal, or refreshing state (finding #3).
//
// The connection-generation guard (`sesGen`) is checked at listener ENTRY, but
// the Stream-2 snapshot + message listeners perform ASYNCHRONOUS work (gzip64
// decode + batch-decode awaits) AFTER that entry check. If the stream is
// replaced while an old listener is mid-await, the old continuation could
// complete and apply its stale snapshot/batch, clobbering the replacement's
// state. The epoch guard does NOT close this gap — replacing a connection bumps
// sesGen but does NOT change the busy-gate epoch. This test drives a stale
// async continuation to completion and asserts it has NO state effect.
// ===========================================================================
describe("I — stale async decode", () => {
  it("a superseded connection's late snapshot decode does NOT clobber the replacement's state", async () => {
    // Deterministically SUSPEND the OLD connection's gzip64 snapshot decode
    // mid-flight with a controlled DecompressionStream: its first read() returns
    // a promise we resolve manually. This lets us (1) start the decode on the
    // OLD Stream2, (2) replace that stream, then (3) complete the OLD decode and
    // assert it has no state effect. The stale snapshot carries a distinct
    // message (m-stale) the assertions can detect; the replacement ships a RAW
    // (synchronous) snapshot carrying m-fresh.
    const staleJSON = JSON.stringify({
      seq: 5,
      gate: { s1: { messagesLoaded: true } },
      messages: {
        s1: [
          {
            info: { id: "m-stale", sessionID: "s1", role: "assistant", time: { created: 1 } },
            parts: [],
          },
        ],
      },
    });
    const staleBytes = Buffer.from(staleJSON, "utf-8");
    let resolveFirstRead: (v: { done: boolean; value?: Uint8Array }) => void = () => {};
    const firstRead = new Promise<{ done: boolean; value?: Uint8Array }>(
      (r) => (resolveFirstRead = r),
    );
    let readCount = 0;
    class ControlledDS {
      constructor(_format?: string) {}
      readable = {
        getReader: () => ({
          read: () => {
            // First read suspends (pending firstRead); the second read
            // terminates the decode loop ({done:true}).
            if (readCount++ === 0) return firstRead;
            return Promise.resolve({ done: true } as { done: boolean; value?: Uint8Array });
          },
        }),
      };
      writable = {
        getWriter: () => ({
          write: () => Promise.resolve(),
          close: () => Promise.resolve(),
        }),
      };
    }
    const g = globalThis as unknown as { DecompressionStream?: unknown };
    const origDS = g.DecompressionStream;
    g.DecompressionStream = ControlledDS;

    try {
      stream.connect();
      treeESes()[0].simulateOpen();
      stream.openSessionStream("s1");
      const oldES = sessionESes()[0];
      oldES.simulateOpen();

      // Start an ASYNC gzip64 snapshot decode on the OLD connection. The decode
      // IIFE runs synchronously up to `await reader.read()`, which returns our
      // pending firstRead → it suspends in flight. (Passes the entry gen guard
      // because sesGen has not changed yet.)
      oldES.fire("snapshot", { encoding: "gzip64", data: "AAAA" });
      await flush(); // let the IIFE reach the suspended read (still pending)

      // REPLACE the stream (same session, force) — bumps sesGen, closes oldES,
      // and constructs a fresh cursorless connection. The OLD IIFE is still
      // suspended; its captured `gen` is now superseded.
      stream.openSessionStream("s1", true);
      const newES = sessionESes().filter((e) => e.readyState !== CLOSED)[0];
      expect(newES).not.toBe(oldES);
      expect(oldES.readyState).toBe(CLOSED);
      newES.simulateOpen();

      // The replacement ships a RAW (synchronous) snapshot carrying m-fresh —
      // it applies immediately and authoritatively.
      newES.fire("snapshot", {
        seq: 7,
        gate: { s1: { messagesLoaded: true } },
        messages: {
          s1: [
            {
              info: { id: "m-fresh", sessionID: "s1", role: "user", time: { created: 2 } },
              parts: [],
            },
          ],
        },
      });
      await flush();
      // Fresh state landed: m-fresh present, refresh cleared, delivered.
      expect(store.state.messages.s1.order).toEqual(["m-fresh"]);
      expect(store.state.refreshing.s1).toBe(false);
      expect(store.state.messagesLoaded.s1).toBe(true);

      // NOW complete the OLD connection's suspended decode. Before the fix the
      // post-await code only ran the epoch guard (unchanged by a sesGen bump),
      // so applySnap would run and applySessionSnapshot would wholesale-replace
      // messages[s1] with [m-stale] — clobbering m-fresh and re-asserting the
      // stale snapshot's gate. After the fix the gen re-check after the await
      // drops the superseded continuation with no state effect.
      resolveFirstRead({ done: false, value: staleBytes });
      await flush();
      await flush(); // drain the decode loop's terminating {done:true} read + the gen re-check

      // The stale decode did NOT clobber the replacement's state.
      expect(store.state.messages.s1.order).toEqual(["m-fresh"]);
      expect(store.state.messages.s1.byId["m-stale"]).toBeUndefined();
      // Refreshing stays cleared and messagesLoaded stays true (the stale
      // continuation must not touch reveal/refreshing state either).
      expect(store.state.refreshing.s1).toBe(false);
      expect(store.state.messagesLoaded.s1).toBe(true);
    } finally {
      // Restore the real global so the controlled DS never leaks to other tests.
      g.DecompressionStream = origDS;
    }
  });
});
