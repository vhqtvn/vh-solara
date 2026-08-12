// @vitest-environment jsdom
//
// Stream2 (active-session messages) openSessionStream() listener-registration
// MANIFEST — the prerequisite gate for the upcoming openSessionStream() cohort
// decomposition, mirroring stream1Registration.test.ts for Stream1's connect().
// openSessionStream() registers every Stream2 event listener on the session
// EventSource; the session-transport extraction will MOVE openSessionStream()
// (and its listener registrations). This test is the manifest that FAILS the
// moment any listener is left behind: it pins the EXACT set of addEventListener
// kinds + onopen/onerror, and dispatches one real event per kind to prove each
// reaches its handler with an observable side effect.
//
// EventSource delivers a NAMED event solely to a matching addEventListener call,
// so a kind that the extraction forgets to register is silently dead on the wire.
// This file inspects the live session EventSource's listener map after a real
// openSessionStream() to close that gap.
//
// Pure test investment: NO source changes. Fake timers (like stream1Backoff /
// stream1Registration) — every assertion is synchronous on the fast path (no
// busy gate, RAW snapshot so no gzip64 decode in flight). The ONE async kind,
// messages.batch, is driven with a pass-through (non-compressed) payload so its
// decode resolves on the microtask queue without DecompressionStream, and is
// flushed with a microtask pump.
//
// HONESTY NOTE — what the manifest pins vs. what it does NOT prove:
//   The manifest's job is to pin the SET of registered kinds (no missing, no
//   extra). It does NOT prove every callback's INTERNAL invariants. Several
//   Stream2 listeners carry decode-gating (sesSnapshotDecoding / pendingBatch
//   awaits) and generation-token rechecks (sesGen) that are exercised by sibling
//   suites:
//     - sesSnapshotDecode ownership + gen guards → sesSnapshotOwnership.test.ts
//     - CLOSED-reopen exponential backoff (onerror) → stream2Backoff.test.ts
//     - dead-but-OPEN liveness + content/transport clock split → sessionLiveness.test.ts
//     - trackCursor=false (sesCursor vs shared cursor) → sessionStreamCursor.test.ts
//   Here we only assert each listener is WIRED and reaches its reducer/clock
//   mutation on the fast path. The per-kind observables below are deliberately
//   chosen to fire BEFORE any gen/decode branch can drop the frame (gen matches
//   the just-opened connection; no snapshot decode is in flight).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock EventSource — stream1Backoff / sessionLiveness shape, plus a public
// listenerTypes() so the manifest can inspect the exact registered kinds after
// openSessionStream().
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

  /** The exact set of named events this ES has listeners for (the manifest). */
  listenerTypes(): string[] {
    return Array.from(this.listeners.keys()).sort();
  }

  fire(type: string, data: unknown, lastEventId = ""): void {
    const ev = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
    // jsdom's MessageEvent constructor drops lastEventId from init; set it on the
    // instance so `ev.lastEventId` reads correctly (session-stream reads it for
    // the per-Stream2 sesCursor tracker).
    Object.defineProperty(ev, "lastEventId", { value: lastEventId });
    const arr = this.listeners.get(type);
    if (arr) for (const fn of arr) fn(ev);
  }

  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  simulateErrorClosed(): void {
    // Fatal: readyState→CLOSED, then fire onerror (mirrors stream2Backoff's
    // simulateError so the CLOSED branch of ses.onerror runs).
    this.readyState = CLOSED;
    this.onerror?.();
  }
}

let instances: MockEventSource[] = [];

// Session stream URL carries sessions=<id> (non-empty). Filter CLOSED out so the
// "current" session ES is always the live one (a switched-away / replaced ES is
// closed by closeSessionStream and must not be selected).
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => e.readyState !== CLOSED && /sessions=[^&]/.test(e.url));

let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
// Liveness/generation accessors that stream.ts does NOT re-export (it re-exports
// only getSesGen). Imported directly from the module under test; ESM dedups this
// to the SAME module instance openSessionStream() mutates (both resolve to
// src/sync/session-stream.ts).
let sesMod: typeof import("../../src/sync/session-stream") = null as unknown as typeof import("../../src/sync/session-stream");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  sesMod = await import("../../src/sync/session-stream");
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

// Pump the microtask queue for the ONE async kind (messages.batch). Microtasks
// are NOT faked by vi.useFakeTimers (only macrotasks are), so a Promise chain
// drain resolves the pass-through batch decode regardless of the fake clock.
const flushMicro = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

// A RAW (un-compressed) Stream-2 session snapshot for `id` carrying one user
// message `msgID`. RAW → synchronous apply (no gzip64 decode await). gate.
// messagesLoaded=true → applySessionSnapshot marks the session delivered.
function rawSessionSnap(seq: number, id: string, msgID: string): any {
  return {
    seq,
    gate: { [id]: { messagesLoaded: true } },
    messages: {
      [id]: [{ info: { id: msgID, sessionID: id, role: "user", time: { created: 1 } }, parts: [] }],
    },
  };
}

// The complete expected listener manifest: every addEventListener kind
// openSessionStream() registers on the session EventSource (session-stream.ts
// open() lines 445–771), in alphabetical order (matching Array.sort() on the
// registered keys) for a stable set diff. Note the lexicographic groups:
//   "message.*"  < "messages.*"   ('.' 0x2e < 's' 0x73 at index 7)
//   "message.delete" < "message.upsert"  ('d' < 'u')
//   "part.append" < "part.delete" < "part.upsert"  ('a' < 'd' < 'u')
//   "messages.batch" < "messages.error" < "messages.loaded"
// Slice 3 added "part.append" (message-class per IsMessageClassKind, ordinal-
// counted by the server); it shares the listener loop but is buffered for
// frame-batched flush rather than reaching applyMessageEvent synchronously
// (covered by partAppendStreaming.test.ts).
// onopen/onerror are asserted separately (they are property assignments, not
// addEventListener calls).
const EXPECTED_SESSION_LISTENER_KINDS = [
  "message.delete",
  "message.upsert",
  "messages.batch",
  "messages.error",
  "messages.loaded",
  "part.append",
  "part.delete",
  "part.upsert",
  "ping",
  "snapshot",
];

const SID = "s1";

// ===========================================================================
// THE MANIFEST — the core extraction-regression catcher. After
// openSessionStream(), the session EventSource must have a listener registered
// for EVERY Stream2 event kind. If the session-transport extraction moves
// openSessionStream() and forgets to register any kind, this assertion fails
// with a precise set diff. onopen/onerror must also be wired.
// ===========================================================================
describe("Stream2 openSessionStream() listener manifest", () => {
  it("registers a listener for every Stream2 event kind on the session EventSource (+ onopen/onerror)", () => {
    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    const registered = es.listenerTypes();

    // Exact-set assertion: no missing kinds, no extra kinds.
    expect(registered).toEqual(EXPECTED_SESSION_LISTENER_KINDS);
    // onopen / onerror are property assignments (not in the listener map).
    expect(typeof es.onopen).toBe("function");
    expect(typeof es.onerror).toBe("function");
  });

  // -------------------------------------------------------------------------
  // snapshot listener — the RAW (un-compressed) session snapshot seeds the
  // per-session message store, messageWindows, the delivered flag, and clears
  // refreshing. applySessionSnapshot's merge-if-absent + delivered-flag logic
  // is the surface the snapshot listener drives (reconciled synchronously for a
  // RAW frame). This also SEEDS messages[SID] so the message-kind listeners
  // below have a session store to mutate.
  // -------------------------------------------------------------------------
  it("snapshot listener applies a RAW snapshot synchronously (delivered flag flips, message seeds)", () => {
    stream.openSessionStream(SID);
    const es = sessionESes()[0];

    // Before the snapshot, nothing is seeded; open() armed refreshing[SID]=true.
    expect(store.state.messages[SID]).toBeUndefined();
    expect(store.state.refreshing[SID]).toBe(true);

    es.fire("snapshot", rawSessionSnap(1, SID, "m1"), "1");

    // Snapshot applied: message seeded, delivered, refreshing cleared.
    expect(store.state.messages[SID]?.byId?.m1).toBeDefined();
    expect(store.state.messages[SID]?.order).toContain("m1");
    expect(store.state.messagesDelivered[SID]).toBe(true);
    expect(store.state.refreshing[SID]).toBe(false);
  });

  // -------------------------------------------------------------------------
  // The legacy message/part kinds (not part.append) — all routed through the
  // SHARED listener (the `for (const kind of [...SESSION_MESSAGE_KINDS...])`
  // loop). Each must reach applyMessageEvent with trackCursor=false on the fast
  // path (no busy gate, no in-flight snapshot decode). Dispatched in dependency
  // order so delete/clear kinds have prior state; the async kind (messages.batch)
  // is flushed via microtask pump. part.append is tested separately
  // (partAppendStreaming.test.ts) because it buffers for frame-batched flush
  // rather than reaching applyMessageEvent synchronously.
  //   message.upsert → message appears
  //   part.upsert    → part appears on the message
  //   part.delete    → part removed
  //   message.delete → message removed
  //   messages.error → messagesError[SID] set
  //   messages.loaded → messagesError[SID] cleared (supersedes the failure)
  //   messages.batch  → (async) batch message merged into the store
  // -------------------------------------------------------------------------
  it("every message/part kind listener reaches applyMessageEvent (observable per kind, trackCursor=false)", async () => {
    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    // Seed messages[SID] with m1 via a RAW snapshot (the reducer needs a
    // resident session store before message.upsert/part.upsert can mutate).
    es.fire("snapshot", rawSessionSnap(1, SID, "m1"), "1");

    // message.upsert — a NEW assistant message m2 lands in the store.
    // (seqs are contiguous to avoid triggering the seq-gap forced resync.)
    es.fire("message.upsert", { id: "m2", sessionID: SID, role: "assistant", time: { created: 2 } }, "2");
    expect(store.state.messages[SID]?.byId?.m2).toBeDefined();
    expect(store.state.messages[SID]?.order).toEqual(expect.arrayContaining(["m1", "m2"]));
    // trackCursor=false: the shared cursor is NOT advanced by Stream2 frames.
    expect(store.state.cursor).toBe(0);

    // part.upsert — part p1 attaches to m2.
    es.fire("part.upsert", { id: "p1", sessionID: SID, messageID: "m2", type: "text", text: "hi" }, "3");
    expect(store.state.messages[SID]?.byId?.m2?.parts?.p1).toBeDefined();

    // part.delete — p1 removed.
    es.fire("part.delete", { sessionID: SID, messageID: "m2", partID: "p1" }, "4");
    expect(store.state.messages[SID]?.byId?.m2?.parts?.p1).toBeUndefined();

    // message.delete — m2 removed.
    es.fire("message.delete", { sessionID: SID, messageID: "m2" }, "5");
    expect(store.state.messages[SID]?.byId?.m2).toBeUndefined();
    expect(store.state.messages[SID]?.order).not.toContain("m2");

    // messages.error — background-hydration failure records the per-session error.
    es.fire("messages.error", { sessionID: SID, error: { message: "boom" } }, "6");
    expect(store.state.messagesError[SID]).toBe(true);

    // messages.loaded — a later successful load supersedes the failure: clears
    // messagesError and re-asserts delivered. Proves the kind is wired via its
    // DISTINCT observable (clearing what messages.error just set).
    es.fire("messages.loaded", { sessionID: SID }, "7");
    expect(store.state.messagesError[SID]).toBeUndefined();
    expect(store.state.messagesDelivered[SID]).toBe(true);

    // messages.batch — the ONE async kind. Driven with a pass-through
    // (non-compressed) payload so decodeMessagesBatch resolves on the microtask
    // queue (no DecompressionStream). After the flush, the batch message mB is
    // merged into the store.
    es.fire("messages.batch", {
      sessionID: SID,
      messages: [{ info: { id: "mB", sessionID: SID, role: "user", time: { created: 0 } }, parts: [] }],
    }, "8");
    expect(store.state.messages[SID]?.byId?.mB).toBeUndefined(); // not yet (decode awaits)
    await flushMicro();
    expect(store.state.messages[SID]?.byId?.mB).toBeDefined();
    expect(store.state.messages[SID]?.order).toContain("mB");
  });

  // -------------------------------------------------------------------------
  // ping listener — transport-only clock refresh. markSessionTransportSeen
  // refreshes sessionLastSeen but deliberately NOT sessionContentSeen, so a
  // ping-only stream (transport alive, zero content) lets the content clock
  // age out and the watchdog's content-stall branch fires. Asserting BOTH
  // clocks discriminates ping from content listeners (snapshot/message.*/onopen
  // all refresh BOTH). sessionLiveness.test.ts characterizes the watchdog
  // consequence; here we pin the clock split directly.
  // -------------------------------------------------------------------------
  it("ping listener refreshes the transport clock but NOT the content clock", () => {
    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    // open() seeds both clocks at construction (markSessionSeen). Advance fake
    // time so the post-ping transport clock reads strictly greater.
    const transportBefore = sesMod.getSessionLastSeen();
    const contentBefore = sesMod.getSessionContentSeen();
    vi.advanceTimersByTime(5_000);

    es.fire("ping", null);

    // Transport clock advanced...
    expect(sesMod.getSessionLastSeen()).toBeGreaterThan(transportBefore as number);
    // ...but the content clock is UNCHANGED (ping is transport-only).
    expect(sesMod.getSessionContentSeen()).toBe(contentBefore);
  });

  // -------------------------------------------------------------------------
  // onopen — the property-assignment handler. markSessionSeen refreshes BOTH
  // clocks (unlike ping), stamps the L1 open latency, and resets the CLOSED-
  // reopen backoff. The clock refresh is the observable; the backoff reset is
  // characterized in stream2Backoff.test.ts.
  // -------------------------------------------------------------------------
  it("onopen refreshes BOTH liveness clocks (content + transport)", () => {
    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    const transportBefore = sesMod.getSessionLastSeen();
    const contentBefore = sesMod.getSessionContentSeen();
    vi.advanceTimersByTime(5_000);

    es.simulateOpen();

    // onopen → markSessionSeen → both clocks advance.
    expect(sesMod.getSessionLastSeen()).toBeGreaterThan(transportBefore as number);
    expect(sesMod.getSessionContentSeen()).toBeGreaterThan(contentBefore as number);
  });

  // -------------------------------------------------------------------------
  // sesGen — Stream2 connection-generation token. closeSessionStream() bumps it
  // (bump-before-close) and open() bumps it again, so a force reopen advances
  // the generation. This is what lets every listener ignore frames from a
  // superseded connection. Proven on force=true (close+open) — the bump math is
  // exercised structurally by sesSnapshotOwnership / sessionLiveness; here we
  // pin that a reopen of the SAME session advances the token.
  // -------------------------------------------------------------------------
  it("sesGen advances on a forced reopen of the same session", () => {
    stream.openSessionStream(SID);
    const genBefore = sesMod.getSesGen();

    stream.openSessionStream(SID, true); // force=true → close + fresh open

    expect(sesMod.getSesGen()).toBeGreaterThan(genBefore);
    // A fresh session ES was constructed for the replacement connection.
    expect(sessionESes()).toHaveLength(1);
  });
});
