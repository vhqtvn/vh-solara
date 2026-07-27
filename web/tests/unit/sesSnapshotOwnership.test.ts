// @vitest-environment jsdom
//
// Gap #4 (stream-invariant-audit §7b) — sesSnapshotDecode ownership-aware
// clear across a session switch.
//
// INVARIANT: when switching sessions mid-decode, a stale gzip64 snapshot
// decode (captured against the outgoing connection's sesGen) must NOT clear
// `sesSnapshotDecoding` while the replacement session's decode is gating. The
// ownership-aware clear (`if (gen === sesGen) sesSnapshotDecoding = false` in
// the decode's `finally`) ensures only the CURRENT generation owns the flag.
//
// WHY IT MATTERS: Stream 2's message listener serializes live message frames
// behind an in-flight gzip64 snapshot decode via `if (sesSnapshotDecoding)
// await sesSnapshotDecode`. The decode's finally clears the flag so the next
// message flood is zero-latency. But if a session switch bumps sesGen during
// the decode, the stale decode's finally MUST NOT clear the flag — the
// replacement connection has started its OWN decode (flag=true), and a stale
// clear would let a subsequent message bypass the gate and apply before the
// replacement snapshot seeded `messages[id]`, silently dropping the message
// (applyMessageEvent's message.upsert path does `if (sm) upsertMessage(...)` —
// sm undefined → skip).
//
// OBSERVABILITY LIMITATION (honest): there is no test accessor for
// sesSnapshotDecoding / sesSnapshotDecode (unlike the tree stream's
// isTreeSnapshotDecoding / getTreeSnapshotDecode). The flag is module-private.
// We therefore observe the invariant INDIRECTLY through its observable
// consequences:
//   (1) the stale decode's APPLY is discarded by the post-await gen guard
//       (`if (gen !== sesGen) return`) → the stale session's snapshot messages
//       never reach the store;
//   (2) the replacement decode GATES a live message frame → the message is
//       applied only AFTER the replacement snapshot seeds messages[id], so it
//       is NOT silently dropped.
// The ownership-aware CLEAR specifically (the `finally` gen guard) is EXERCISED
// by these scenarios (decode1's finally runs during the flush while decode2 is
// in flight) but is NOT precisely pinned: real timers drain ALL microtasks in
// a single `await tick(1)`, so decode1 and decode2 both finish within one
// macrotask boundary and cannot be separated without a test accessor or fake
// timers. The end-state assertions below ARE sensitive to a broken clear — if
// the clear were broken, a message fired between the two decodes' resolutions
// could bypass the gate — but they do not isolate the finally-guard from the
// post-await apply-guard. That isolation is deferred until an accessor exists.
//
// Real timers (NOT fake): DecompressionStream's reader.read chain is a real
// async source. Node 18+ ships it as a global (undici). Mirrors
// coherentBarrier.test.ts / streamIntegration.test.ts.
//
// Mock EventSource + encodeForTest + tick mirror the established harness.
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

// Session stream URL carries sessions=<id> (non-empty). Filter CLOSED out so
// the "current" session ES is always the live one (a switched-away ES is
// closed by closeSessionStream and must not be selected).
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => e.readyState !== CLOSED && /sessions=[^&]/.test(e.url));
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
// internal reader.read chain is a real async source. One tick drains all
// pending microtasks, which finishes ALL in-flight gzip64 decodes.
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

// A gzip64 session-snapshot envelope carrying one user message for `id`.
// Shape: { seq, gate:{[id]:{messagesLoaded:true}}, messages:{[id]:[{info,parts}]} }.
function gzip64SessionSnap(seq: number, id: string, msgID: string): string {
  const snap = {
    seq,
    gate: { [id]: { messagesLoaded: true } },
    messages: {
      [id]: [{ info: { id: msgID, sessionID: id, role: "user" }, parts: [] }],
    },
  };
  return JSON.stringify({ encoding: "gzip64", data: encodeForTest(snap) });
}

// ===========================================================================
// Gap #4 — sesSnapshotDecode ownership-aware clear across a session switch.
//
// Three tests, each targeting a distinct regression in the gen-owned decode
// path. The end-state observations ARE sensitive to a broken ownership clear
// (a message could bypass the gate), though they do not isolate the
// finally-guard from the post-await apply-guard — see the file header.
// ===========================================================================
describe("Gap #4 — sesSnapshotDecode ownership-aware clear across session switch", () => {
  it("discards a stale decode's snapshot when the session is switched mid-decode (post-await gen guard: stale apply never reaches the store)", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // Open session A. The snapshot listener captures gen=G_A; sesId="A".
    stream.openSessionStream("A");
    const esA = sessionESes()[0];
    esA.simulateOpen();

    // Fire a gzip64 snapshot for A — starts decode1 (gen=G_A), which suspends
    // at the DecompressionStream await. applySnap (targeting "A") has NOT run.
    esA.fire("snapshot", gzip64SessionSnap(1, "A", "a1"), "1");

    // Switch to session B WHILE decode1 is in flight. closeSessionStream()
    // bumps sesGen (→ G_B); open() bumps it again (→ G_B2), resets
    // sesSnapshotDecoding=false and sesSnapshotDecode=Promise.resolve().
    // decode1 is still pending in the background with its captured gen=G_A.
    const genAfterA = stream.getSesGen();
    stream.openSessionStream("B");
    const esB = sessionESes()[0];
    esB.simulateOpen();
    // Prove the switch actually bumped the generation (the trigger under test).
    expect(stream.getSesGen()).toBeGreaterThan(genAfterA);

    // Drain all microtasks: decode1 finishes, hits `if (gen !== sesGen)
    // return` (G_A !== G_B2), and is discarded — applySnap("A", ...) never
    // runs, so messages["A"] is never seeded from snap A.
    await tick(2);

    // THE ASSERTION: the stale decode's snapshot messages did NOT reach the
    // store. If the post-await gen guard were broken, messages["A"] would
    // contain a1 (a stale-baseline clobber of whatever B's UI is showing).
    const aMsgs = store.state.messages["A"];
    expect(aMsgs?.byId?.["a1"]).toBeUndefined();
    expect(aMsgs?.order ?? []).not.toContain("a1");
  });

  it("gates a live message.upsert behind the replacement session's in-flight decode (message applies only after the snapshot seeds messages[id])", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    stream.openSessionStream("B");
    const esB = sessionESes()[0];
    esB.simulateOpen();

    // Fire a gzip64 snapshot for B — decode2 (gen=G_B) starts, flag=true.
    esB.fire("snapshot", gzip64SessionSnap(1, "B", "b1"), "1");

    // Fire a live message.upsert on B. The listener runs synchronously up to
    // `if (sesSnapshotDecoding) await sesSnapshotDecode` and SUSPENDS — the
    // message has NOT been applied yet, and messages["B"] is not yet seeded
    // (decode2 has not run applySnap). This is the synchronous proof that the
    // listener gated the frame.
    esB.fire("message.upsert", { id: "b_live", sessionID: "B", role: "user" }, "2");
    expect(store.state.messages["B"]?.byId?.["b_live"]).toBeUndefined();

    // Drain: decode2 applies snap (seeds messages["B"] with b1), then the
    // suspended message listener resumes and upserts b_live. BOTH are present.
    await tick(2);

    // THE ASSERTION: the live message was NOT silently dropped. If the gate
    // were broken (message not awaiting decode2), the listener would have run
    // synchronously, found messages["B"] undefined, skipped the upsert
    // (applyMessageEvent: `if (sm) upsertMessage(...)`), and b_live would be
    // lost forever — only b1 would be present.
    expect(store.state.messages["B"]?.byId?.["b1"]).toBeDefined();
    expect(store.state.messages["B"]?.byId?.["b_live"]).toBeDefined();
    expect(store.state.messages["B"]?.order ?? []).toEqual(expect.arrayContaining(["b1", "b_live"]));
  });

  it("survives a cross-switch burst: stale A decode discarded + replacement B decode gates a live message (end-to-end gen ownership)", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // Open A, start decode1 (gen=G_A) with snap A.
    stream.openSessionStream("A");
    const esA = sessionESes()[0];
    esA.simulateOpen();
    esA.fire("snapshot", gzip64SessionSnap(1, "A", "a1"), "1");

    // Switch to B (sesGen bumped twice; flag reset by open()), start decode2
    // (gen=G_B2) with snap B. decode1 is still in flight against gen=G_A.
    stream.openSessionStream("B");
    const esB = sessionESes()[0];
    esB.simulateOpen();
    esB.fire("snapshot", gzip64SessionSnap(1, "B", "b1"), "1");

    // Fire a live message on B's connection. The listener (gen=G_B2) gates
    // behind decode2 (flag=true from snap B). Synchronously NOT applied.
    esB.fire("message.upsert", { id: "b_live", sessionID: "B", role: "user" }, "2");
    expect(store.state.messages["B"]?.byId?.["b_live"]).toBeUndefined();

    // Drain all microtasks. Both decodes finish within this one macrotask
    // boundary (real-timer limitation — see file header): decode1's finally
    // runs while decode2 was/is in flight, exercising the ownership-aware
    // clear path; decode1's apply is gen-discarded; decode2's apply seeds B;
    // the gated message resumes and upserts b_live.
    await tick(2);

    // Stale A discarded.
    expect(store.state.messages["A"]?.byId?.["a1"]).toBeUndefined();
    // Replacement B seeded + live message gated through (NOT dropped).
    expect(store.state.messages["B"]?.byId?.["b1"]).toBeDefined();
    expect(store.state.messages["B"]?.byId?.["b_live"]).toBeDefined();
    expect(store.state.messages["B"]?.order ?? []).toEqual(expect.arrayContaining(["b1", "b_live"]));
  });
});
