// @vitest-environment jsdom
//
// REGRESSION GUARD for the Lane B merge-guard fix (14fa446 "merge-guard
// messages.batch to preserve live pre-batch upserts"). Originated as a
// C4-exoneration probe — the reload message-drop bug lives in the SESSION-
// stream messages.batch path, NOT the C4 coherent-snapshot barrier (no
// tree.snapshot is fired here, the strongest possible exoneration).
//
// SCENARIO: during a reload, a live message.upsert for a MIDDLE message lands
// on the session stream AFTER the snapshot but BEFORE messages.batch. The
// upsert applies (live tail). Then messages.batch (gzip64) decodes and its
// applyMessageEvent case runs. Pre-Lane-B that case did
// `s.messages[sid] = buildMessages(items)` — a WHOLESALE-REPLACE with no merge
// guard — clobbering the live middle message absent from the batch's (stale,
// snapshot-time) item list. Lane B switched it to prependMessagesIfAbsent
// (merge-if-absent: insert batch items that are ABSENT, never touch an
// existing byId entry — live always wins). Cold-load is unaffected (on first
// hydrate the slot is empty, every item is absent, merge ≡ wholesale-replace).
//
// WHY THE MID-DECODE TIMING WAS ADJUSTED: the operator's first-pass scenario
// fired the upsert DURING the batch decode. That race was already CLOSED: the
// shared session listener unconditionally does `if (pendingBatch.has(sid))
// await pendingBatch.get(sid)` (stream.ts ~2455/2468) for EVERY non-batch kind,
// so a message.upsert arriving mid-decode SUSPENDS until the batch resolves,
// then applies AFTER the batch (it survives either way). The residual gap —
// and the original bug — was a live message that applied BEFORE the batch
// fired (between snapshot and batch), which the pendingBatch gate cannot help
// with. This is the fallback timing the operator specified, and the one the
// merge-guard now closes.
//
// This test goes GREEN on the merge-guard: all 6 messages survive incl. the
// pre-batch m2.5 canary. Reverting messages.batch to a wholesale-replace makes
// it RED (m2.5 is dropped), so it pins the Lane B invariant.
//
// N=5 baseline messages {m1..m5}, all ≪ window (≪100 msgs, ≪1MiB), so the tail
// window is provably NOT the dropper. The live middle message m2.5 (created
// between m2 and m3) is the canary: it survives under the merge-guard; a
// wholesale-replace would drop it.
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
// message — so the canary is a true middle resident, not a tail-window artifact).
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

describe("messages.batch merge-guard preserves a live pre-batch message.upsert (C4-exoneration + Lane B regression)", () => {
  it("a live message.upsert for a MIDDLE message landing between snapshot and messages.batch SURVIVES the merge-guard", async () => {
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
    //    fired (so the pendingBatch gate at stream.ts ~2455/2468 is NOT yet armed —
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
    //    applyMessageEvent("messages.batch", ...) → prependMessagesIfAbsent
    //    (the Lane B merge-guard): insert batch items that are ABSENT, never
    //    touch an existing byId entry. items is the 5-message baseline (no
    //    m2.5), but m2.5 is ALREADY resident, so it is left untouched. A
    //    wholesale-replace (`s.messages[sid] = buildMessages(items)`) would
    //    have clobbered it — this test pins that the merge path is in place.
    await tick(20);

    // 5. THE INVARIANT (GREEN): the live middle canary m2.5 survives the
    //    batch — it was already resident, exactly the live-always-wins rule
    //    the snapshot merge path (applySessionSnapshot) enforces and Lane B
    //    extended to messages.batch. Reverting to a wholesale-replace drops
    //    m2.5 here (RED), so this is the Lane B regression guard.
    const order = [...store.state.messages.s1.order];
    expect(order).toContain("m2.5");
    expect(order.length).toBe(6);
  });
});
