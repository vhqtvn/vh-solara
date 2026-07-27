// @vitest-environment jsdom
//
// C4-EXONERATION PROBE — the definitive test of whether the reload message-drop
// bug lives in the C4 coherent-snapshot barrier (tree/detail projections) or in
// the SESSION-stream messages.batch wholesale-replace.
//
// SCENARIO: during a reload, a live message.upsert for a MIDDLE message lands
// on the session stream AFTER the snapshot but BEFORE messages.batch. The
// upsert applies (live tail). Then messages.batch (gzip64) decodes and its
// applyMessageEvent case runs `s.messages[sid] = buildMessages(items)` — a
// WHOLESALE-REPLACE with no merge guard — clobbering the live middle message
// that is absent from the batch's (stale, snapshot-time) item list.
//
// WHY THE MID-DECODE TIMING WAS ADJUSTED: the operator's first-pass scenario
// fired the upsert DURING the batch decode. That race is already CLOSED: the
// shared session listener unconditionally does `if (pendingBatch.has(sid))
// await pendingBatch.get(sid)` (stream.ts ~line 2793) for EVERY non-batch kind,
// so a message.upsert arriving mid-decode SUSPENDS until the batch resolves,
// then applies AFTER the wholesale-replace (it survives). The residual gap —
// and the actual bug — is the wholesale-replace clobbering a live message that
// applied BEFORE the batch fired (between snapshot and batch), which the
// pendingBatch gate cannot help with. This is the fallback timing the operator
// specified.
//
// If this test goes RED at the wholesale-replace, C4 is EXONERATED: the bug is
// in the session-stream batch path (stream.ts messages.batch case), which has
// NO merge guard (unlike applySessionSnapshot's prependMessagesIfAbsent). C4's
// tree/detail barrier is not even invoked here (no tree.snapshot is fired),
// which is the strongest possible exoneration.
//
// N=5 baseline messages {m1..m5}, all ≪ window (≪100 msgs, ≪1MiB), so the tail
// window is provably NOT the dropper. The live middle message m2.5 (created
// between m2 and m3) is the canary: if it survives, no bug; if it is dropped,
// the wholesale-replace clobbered it.
//
// Self-contained harness (MockEventSource + setupFresh + encodeForTest + tick
// duplicated from coherentBarrier.test.ts / sessionLiveness.test.ts because
// those files do not export their helpers). Real timers — the gzip64 decode
// uses native DecompressionStream, a real async source.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { gzipSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Mock EventSource — same shape as coherentBarrier.test.ts.
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

// Session ES URL: `?sessions=s1&...` (non-empty sessions=). Tree ES URL:
// `?sessions=&...` (empty). Classify by that (mirrors sessionLiveness.test.ts).
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => /sessions=[^&]/.test(e.url));
const treeESes = (): MockEventSource[] =>
  instances.filter((e) => e.readyState !== CLOSED && !/sessions=[^&]/.test(e.url));

let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  store.setProjectDirRaw("/test");
  store.setSelectedIdRaw("s1");
}

// Pump macro+microtasks. Real timers (NOT fake) — DecompressionStream's
// internal reader.read chain is a real async source whose cadence varies.
const tick = async (n = 1): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

// encodeForTest mirrors the server's maybeCompressSnapshot: JSON → gzip → base64.
function encodeForTest(value: unknown): string {
  const inner = JSON.stringify(value);
  return Buffer.from(gzipSync(Buffer.from(inner))).toString("base64");
}

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
  await setupFresh();
});

afterEach(() => {
  stream?.closeSessionStream();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

// ---------------------------------------------------------------------------
// Message item builders. Items carry info.time.created so sortMessages orders
// them deterministically; m2.5's created sits between m2 and m3 (a true MIDDLE
// message — proving the drop is the wholesale-replace, not tail-windowing).
// ---------------------------------------------------------------------------
function msg(id: string, created: number): any {
  return {
    info: { id, sessionID: "s1", role: "user", time: { created } },
    parts: [],
  };
}

const BASE_ITEMS = [
  msg("m1", 1),
  msg("m2", 2),
  msg("m3", 3),
  msg("m4", 4),
  msg("m5", 5),
];
// The live middle canary: created between m2 and m3.
const MIDDLE_INFO = { id: "m2.5", sessionID: "s1", role: "user", time: { created: 2.5 } };

describe("messages.batch wholesale-replace clobbers a live pre-batch message.upsert (C4-exoneration)", () => {
  it("a live message.upsert for a MIDDLE message landing between snapshot and messages.batch is dropped by the wholesale-replace", async () => {
    // Open both streams. Tree ES stays healthy but fires NO tree.snapshot —
    // the C4 barrier is never invoked, which is the strongest exoneration
    // (the bug reproduces purely on the session-stream batch path).
    stream.connect();
    treeESes()[0].simulateOpen();
    stream.openSessionStream("s1");
    const ses = sessionESes()[0];
    ses.simulateOpen();
    await tick(2);

    // 1. RAW session snapshot carrying the 5-message baseline (MERGE path —
    //    applySessionSnapshot → prependMessagesIfAbsent). All 5 land.
    ses.fire(
      "snapshot",
      {
        seq: 1,
        gate: { s1: { messagesLoaded: true } },
        messages: { s1: BASE_ITEMS },
      },
      "1",
    );
    await tick(2);
    expect([...store.state.messages.s1.order].sort()).toEqual(
      ["m1", "m2", "m3", "m4", "m5"],
    );

    // 2. Live message.upsert for the MIDDLE canary m2.5, BEFORE the batch is
    //    fired (so the pendingBatch gate at stream.ts ~2793 is NOT yet armed —
    //    the upsert applies synchronously with no decode to wait on). This
    //    models a live event that lands on the session stream between the
    //    snapshot and the cold-load batch during a reload.
    ses.fire("message.upsert", MIDDLE_INFO, "2");
    await tick(1);

    // Sanity: m2.5 is present immediately after the live upsert (before the
    // batch fires). 6 messages now resident.
    expect(store.state.messages.s1.byId["m2.5"]).toBeTruthy();
    expect(store.state.messages.s1.order).toContain("m2.5");
    expect(store.state.messages.s1.order.length).toBe(6);

    // 3. messages.batch (gzip64) — the SAME 5-message baseline (server's
    //    snapshot-time view, which does NOT include the just-arrived live
    //    m2.5), compressed. The shared listener hits the batch branch,
    //    creates the async decode promise, and SUSPENDS at `await p`. fire()
    //    returns synchronously with the decode still in flight.
    ses.fire(
      "messages.batch",
      {
        sessionID: "s1",
        encoding: "gzip64",
        data: encodeForTest({ messages: BASE_ITEMS }),
      },
      "3",
    );

    // 4. Let the batch decode resolve. The decode continuation runs
    //    applyMessageEvent("messages.batch", ...) →
    //    `s.messages["s1"] = buildMessages(items)` — the WHOLESALE-REPLACE.
    //    items is the 5-message baseline (no m2.5), so m2.5 is CLOBBERED.
    //    There is NO merge guard here (unlike applySessionSnapshot's
    //    prependMessagesIfAbsent).
    await tick(20);

    // 5. THE BUG (RED): the live middle canary m2.5 should survive the batch
    //    (it was already resident, exactly the live-always-wins invariant the
    //    snapshot merge path enforces). Current HEAD wholesale-replaces, so
    //    m2.5 is dropped. Asserting survival → FAILS (RED).
    const order = [...store.state.messages.s1.order];
    expect(order).toContain("m2.5");
    expect(order.length).toBe(6);
  });
});
