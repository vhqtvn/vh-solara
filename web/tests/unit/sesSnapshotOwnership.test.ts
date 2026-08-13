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
// by all three scenarios. Tests 1-2 observe it INDIRECTLY through end-state
// assertions (a broken clear could let a message bypass the gate) and drain
// with `await tick(2)`; they do not separate the two decodes' resolutions in
// time. Test 3 ("survives a cross-switch burst") goes further: it installs a
// test-local CONTROLLED DecompressionStream (mirroring sessionLiveness.test.ts
// Gate I) where each stream (A and B) gets its OWN deferred first-read barrier,
// so the test can deterministically drive the ownership-critical window —
// release A's decode while B's stays held, fire a B live event in that window,
// and prove it stays GATED (stale A's completion did NOT clear B's
// sesSnapshotDecoding flag). This isolates the finally-guard from the
// post-await apply-guard WITHOUT needing a module accessor, and removes the
// load-dependent tick(2) oracle that flaked under full-suite concurrency.
//
// Real timers (NOT fake): DecompressionStream's reader.read chain is a real
// async source. Node 18+ ships it as a global (undici). Tests 1-2 use the real
// global; test 3 replaces it with a controlled substitute for the duration of
// that one test (restored in finally). Mirrors coherentBarrier.test.ts /
// streamIntegration.test.ts (real) + sessionLiveness.test.ts Gate I (controlled).
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
    // === Controlled DecompressionStream fixture (mirrors sessionLiveness.test.ts Gate I) ===
    //
    // ROOT CAUSE OF THE ORIGINAL FLAKE: the test pumped a fixed `tick(2)` (two
    // setTimeout(0) turns) and HOPED both gzip64 decodes finished within that
    // window. But decodeGzip64 completes via a DecompressionStream reader.read()
    // loop whose resolutions are macrotask-bounded under the REAL global; under
    // full-suite load B's decode can still be pending at assertion time → b1
    // absent → flake. Full-suite load is an AMPLIFIER, not the root.
    //
    // FIX: install a test-local controlled DecompressionStream where EACH stream
    // (A and B) gets its OWN deferred first-read barrier (independent controls —
    // a single shared barrier could not prove the ownership ordering). The
    // controlled reader emits the known decompressed snapshot bytes for its
    // session, so a1/b1 resolve correctly. Every read resolution is a plain
    // promise resolution (a microtask), so the completion chain is deterministic
    // regardless of suite concurrency — no timer pump, no load-dependent turn
    // count. Progress is driven by barrier release + read-lifecycle signals, not
    // elapsed time.
    const snapABytes = Buffer.from(
      JSON.stringify({
        seq: 1,
        gate: { A: { messagesLoaded: true } },
        messages: { A: [{ info: { id: "a1", sessionID: "A", role: "user" }, parts: [] }] },
      }),
      "utf-8",
    );
    const snapBBytes = Buffer.from(
      JSON.stringify({
        seq: 1,
        gate: { B: { messagesLoaded: true } },
        messages: { B: [{ info: { id: "b1", sessionID: "B", role: "user" }, parts: [] }] },
      }),
      "utf-8",
    );

    interface DecodeControl {
      bytes: Uint8Array;
      // Barrier: the decode loop's FIRST read() suspends here until the test
      // releases it. This is the lever that deterministically orders A vs B.
      firstRead: Promise<{ done: boolean; value?: Uint8Array }>;
      resolveFirstRead: (v: { done: boolean; value?: Uint8Array }) => void;
      readCount: number;
      // Synchronous signal set in the DS constructor = "decode started" (no
      // timer turn needed to detect it: decodeGzip64 runs `new
      // DecompressionStream` before its first await, inside the fire() call).
      constructed: boolean;
      // Read-lifecycle signal: resolves when the terminating {done:true} read is
      // consumed → the decode loop has exited. Awaited as the deterministic
      // "decode progressed to completion" checkpoint (tied to read() lifecycle,
      // not timer turns).
      loopExited: Promise<void>;
      resolveLoopExited: () => void;
    }
    const makeCtrl = (bytes: Uint8Array): DecodeControl => {
      let resolveFirstRead: (v: { done: boolean; value?: Uint8Array }) => void = () => {};
      const firstRead = new Promise<{ done: boolean; value?: Uint8Array }>(
        (r) => (resolveFirstRead = r),
      );
      let resolveLoopExited: () => void = () => {};
      const loopExited = new Promise<void>((r) => (resolveLoopExited = r));
      return { bytes, firstRead, resolveFirstRead, readCount: 0, constructed: false, loopExited, resolveLoopExited };
    };
    const ctrlA = makeCtrl(snapABytes);
    const ctrlB = makeCtrl(snapBBytes);
    // Assigned by construction order: A's snapshot fires first, B's second.
    const queue: DecodeControl[] = [ctrlA, ctrlB];
    let dsConstructCount = 0;

    class ControlledDS {
      readable: { getReader: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } };
      writable: { getWriter: () => { write: () => Promise<void>; close: () => Promise<void> } };
      constructor(_format?: string) {
        // Capture THIS instance's control via the construction counter (closure
        // capture — no `this` in the read path, so field-init order is moot).
        // 1st construction = A, 2nd = B.
        const c = queue[dsConstructCount] ?? queue[queue.length - 1];
        c.constructed = true;
        dsConstructCount++;
        this.readable = {
          getReader: () => ({
            read: () => {
              if (c.readCount++ === 0) return c.firstRead; // 1st read: suspend on barrier
              c.resolveLoopExited(); // 2nd read: terminating → loop exits
              return Promise.resolve({ done: true } as { done: boolean; value?: Uint8Array });
            },
          }),
        };
        this.writable = {
          getWriter: () => ({
            write: () => Promise.resolve(),
            close: () => Promise.resolve(),
          }),
        };
      }
    }

    const g = globalThis as unknown as { DecompressionStream?: unknown };
    const origDS = g.DecompressionStream;
    g.DecompressionStream = ControlledDS;

    // Pure-microtask drain for the post-loop chain (TextDecoder → JSON.parse →
    // IIFE body + finally; for B, also the gated listener's resumption). NO
    // setTimeout / macrotask turns — deterministic regardless of suite load.
    const drain = async (): Promise<void> => {
      for (let i = 0; i < 16; i++) await Promise.resolve();
    };

    try {
      stream.connect();
      const treeES = treeESes()[0];
      treeES.simulateOpen();

      // --- Step 1: start A's decode (gen=G_A). The controlled DS is constructed
      // synchronously inside fire() — decodeGzip64 reaches `new
      // DecompressionStream` before its first await — so decode-started needs no
      // timer turn. The IIFE suspends at A's first-read barrier. ---
      stream.openSessionStream("A");
      const esA = sessionESes()[0];
      esA.simulateOpen();
      esA.fire("snapshot", { encoding: "gzip64", data: "AAAA" }, "1");
      expect(ctrlA.constructed).toBe(true); // decode started (synchronous proof)

      // --- Step 2: switch active session to B. closeSessionStream() bumps
      // sesGen (A's captured gen is now stale); open() bumps it again and resets
      // the decode gate (sesSnapshotDecoding=false, sesSnapshotDecode=resolved).
      // A's IIFE is still suspended in the background with its captured gen=G_A. ---
      stream.openSessionStream("B");
      const esB = sessionESes()[0];
      esB.simulateOpen();

      // --- Step 3: start B's decode (gen=G_B). The 2nd DS construction is B's;
      // its IIFE suspends at B's first-read barrier. ---
      esB.fire("snapshot", { encoding: "gzip64", data: "AAAA" }, "1");
      expect(ctrlB.constructed).toBe(true);

      // --- Step 4: RELEASE A while B stays deliberately HELD. A's completion
      // chain runs: decode loop → JSON.parse → IIFE body (`if (gen !== sesGen)
      // return` — G_A !== G_B → discards applySnap, so a1 never seeds) → finally
      // (`if (gen === sesGen) sesSnapshotDecoding = false` — G_A !== G_B → does
      // NOT clear). sesSnapshotDecoding STAYS true: B owns the gate. ---
      ctrlA.resolveFirstRead({ done: false, value: snapABytes });
      await ctrlA.loopExited; // read loop consumed the terminating {done:true}
      await drain(); // post-loop chain incl. the gen-owned finally

      // --- Step 5: A-complete / B-held window — the ownership crux. Fire a B
      // live event and prove it stays GATED. The message listener reaches `if
      // (sesSnapshotDecoding) await sesSnapshotDecode`: if A's stale finally had
      // WRONGLY cleared the flag, the listener would run synchronously, find
      // messages["B"] unseeded, and SILENTLY DROP b_live (reducers.ts
      // message.upsert: `if (sm) upsertMessage(...)` — sm undefined → skip).
      // Instead the flag is still true → the listener suspends → b_live is
      // absent NOW but will land once B releases (step 7). The synchronous
      // absence here + presence after B-release together prove the gate held. ---
      esB.fire("message.upsert", { id: "b_live", sessionID: "B", role: "user" }, "2");
      expect(store.state.messages["B"]?.byId?.["b_live"]).toBeUndefined();

      // --- Step 6: RELEASE B. B's decode completes (gen===sesGen → applySnap
      // seeds messages["B"] with b1; finally clears sesSnapshotDecoding). The
      // suspended listener resumes — its awaited sesSnapshotDecode was B's IIFE,
      // now resolved — and applies b_live AFTER b1 is seeded (not dropped). ---
      ctrlB.resolveFirstRead({ done: false, value: snapBBytes });
      await ctrlB.loopExited;
      await drain();

      // --- Step 7: assertions. ---
      // Stale A discarded (post-await gen guard returned before applySnap).
      expect(store.state.messages["A"]?.byId?.["a1"]).toBeUndefined();
      // Replacement B seeded b1 from its snapshot.
      expect(store.state.messages["B"]?.byId?.["b1"]).toBeDefined();
      // The gated live message landed AFTER B seeded messages["B"] — NOT
      // silently dropped. Its presence is the direct proof that A's completion
      // did NOT clear B's decode gate (a broken guard would have dropped it).
      expect(store.state.messages["B"]?.byId?.["b_live"]).toBeDefined();
      expect(store.state.messages["B"]?.order ?? []).toEqual(expect.arrayContaining(["b1", "b_live"]));
    } finally {
      // Restore the real global so the controlled DS never leaks to other tests.
      g.DecompressionStream = origDS;
    }
  });
});
