// @vitest-environment jsdom
//
// Full Stream1 coherent-capture happy path — audit gap #6 (recommended before
// any split). A single named integration test exercising the C4 barrier
// end-to-end: connect → tree.snapshot → snapshot → snapshot.complete →
// authoritativeReady=true. The three frames from one {epoch, seq} install
// atomically in one Solid batch(); authoritativeReady flips only AFTER both
// projections are populated.
//
// The individual invariants exist across coherentBarrier.test.ts (Case 1
// atomic observability, Case 2 completion-before-decode) and
// snapshotComplete.test.ts (boundary semantics). This file is the NAMED
// regression marker: when a decomposition breaks the happy path, this test's
// name ("full coherent capture happy path") makes the regression obvious in
// failure output without diff-mining the 13-case suite.
//
// Real timers (NOT fake): the gzip64 tree.snapshot decode runs through
// DecompressionStream's real async reader chain (mirrors coherentBarrier).
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

const treeESes = (): MockEventSource[] =>
  instances.filter((e) => e.readyState !== CLOSED && !/sessions=[^&]/.test(e.url));

let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
let treeState: typeof import("../../src/sync/treeState") = null as unknown as typeof import("../../src/sync/treeState");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  treeState = await import("../../src/sync/treeState");
  store.setProjectDirRaw("/test");
  store.setSelectedIdRaw("s1");
}

const tick = async (n = 1): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const awaitOwner = async (): Promise<void> => {
  await stream.getTreeSnapshotDecode();
};

function encodeForTest(value: unknown): string {
  const inner = JSON.stringify(value);
  return Buffer.from(gzipSync(Buffer.from(inner))).toString("base64");
}

// Captured before each override so afterEach can restore the original
// (prototype-inherited) descriptor — symmetric with the EventSource/fetch cleanup.
let origVisibilityDesc: PropertyDescriptor | undefined;

beforeEach(async () => {
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
  );
  window.localStorage.clear();
  origVisibilityDesc = Object.getOwnPropertyDescriptor(document, "visibilityState");
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
  if (origVisibilityDesc) {
    Object.defineProperty(document, "visibilityState", origVisibilityDesc);
  } else {
    // Originally inherited from Document.prototype (no own prop) — drop the override.
    delete (document as unknown as Record<string, unknown>).visibilityState;
  }
});

// Fixture builders (mirror coherentBarrier.test.ts).
function node(id: string): any {
  return {
    id,
    parentId: null,
    title: `t-${id}`,
    activity: "idle",
    childCount: 0,
    loaded: true,
    updatedMs: 1,
    flags: {},
  };
}

// ===========================================================================
// Full coherent-capture happy path — the named end-to-end regression marker.
//
// Proves the complete chain one observer-visible step at a time:
//   connect() resets authoritativeReady=false
//   → tree.snapshot (gzip64) creates the owner + starts the decode
//   → detail `snapshot` + `snapshot.complete` stage (cannot install alone)
//   → decode completes → tryInstall validates identity + installs BOTH
//     projections + cursor + authoritativeReady in ONE Solid batch()
//   → no observer ever saw authoritativeReady=true with an empty projection.
// ===========================================================================
describe("Stream1 coherent capture — full happy path (connect → install → authoritativeReady)", () => {
  it("installs tree + detail + completion from one {epoch, seq} atomically; authoritativeReady flips only after both projections land", async () => {
    // Atomicity observer: record every [authoritativeReady, treeCount,
    // sessionCount] tuple Solid flushes. The C4 atomic-install invariant is
    // that NO observed tuple has authoritativeReady===true while either
    // projection is empty — readiness is truthful.
    const { createRoot, createEffect } = await import("solid-js");

    // connect() — resets authoritativeReady=false (stream.ts:1742), constructs
    // the tree EventSource, registers all Stream1 listeners with gen=treeGen.
    stream.connect();
    const es = treeESes()[0];
    es.simulateOpen();
    expect(store.state.authoritativeReady).toBe(false);

    // Attach the observer AFTER connect so the initial false reading is the
    // first tuple. Every subsequent store mutation inside a Solid batch is
    // observed as one tuple (batching = atomic flush).
    const tuples: Array<[boolean, number, number]> = [];
    const stopObs = createRoot((dispose) => {
      createEffect(() => {
        tuples.push([
          store.state.authoritativeReady,
          treeState.treeMap().size,
          Object.keys(store.state.sessions).length,
        ]);
      });
      return dispose;
    });

    // --- 1. tree.snapshot (gzip64) — owner created BEFORE decode yields; the
    //     decode IIFE suspends at the DecompressionStream await. ---
    const EPOCH = "e1";
    const SEQ = 100;
    const treeIds = ["s1", "s2"];
    es.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest({ tree: "2", epoch: EPOCH, seq: SEQ, nodes: treeIds.map(node) }),
    }), String(SEQ));

    // --- 2. detail `snapshot` (RAW, synchronous) + 3. `snapshot.complete`.
    //     Both stage into the pending owner (identity {e1, 100}). Neither can
    //     install alone: tree decode still in flight → stagedTree null →
    //     tryInstall's `if (!tree || !detail || !completion) return;` (stream.ts:1502)
    //     short-circuits. authoritativeReady stays false. ---
    es.fire("snapshot", {
      seq: SEQ,
      epoch: EPOCH,
      sessions: treeIds.map((id) => ({ id, title: `d-${id}` })),
    }, String(SEQ));
    es.fire("snapshot.complete", {
      epoch: EPOCH,
      revision: SEQ,
      projections: ["tree", "detail"],
    }, String(SEQ));

    // Synchronous window: the three frames have been delivered but the decode
    // is still held. No install yet.
    expect(store.state.authoritativeReady).toBe(false);
    expect(treeState.treeMap().size).toBe(0);

    // --- 4. Flush the decode → finishDecode stages tree → tryInstall sees all
    //     three staged + identity valid → ATOMIC install in one batch():
    //       seedTreeStore (tree projection)
    //       applySnapshot (detail projection, wholesale sessions replace)
    //       cursor = SEQ
    //       authoritativeReady = true
    //     Detach + settle. ---
    await awaitOwner();
    await tick();

    // --- 5a. Both projections installed. ---
    expect(store.state.authoritativeReady).toBe(true);
    const tm = treeState.treeMap();
    expect(tm.get("s1")).toBeTruthy();
    expect(tm.get("s2")).toBeTruthy();
    expect(Object.keys(store.state.sessions).sort()).toEqual(["s1", "s2"]);
    expect(store.state.sessions.s1).toEqual({ id: "s1", title: "d-s1" });
    expect(store.state.sessions.s2).toEqual({ id: "s2", title: "d-s2" });

    // --- 5b. Cursor advanced to the coherent seq (applySnapshot's
    //     unconditional `state.cursor = snap.seq`, stream.ts:§4a). ---
    expect(store.state.cursor).toBe(SEQ);

    // --- 5c. Atomic observability: at NO observed point was authoritativeReady
    //     true while either projection was empty. Under a broken install (e.g.
    //     readiness flipped at snapshot.complete before the tree decode seeded
    //     treeMap), this would capture (true, 0, 2) — a mixed pair. ---
    const mixedReady = tuples.filter(
      ([auth, treeCount, sessCount]) => auth && (treeCount === 0 || sessCount === 0),
    );
    expect(mixedReady).toEqual([]);
    // And readiness WAS reached (not stuck false).
    expect(
      tuples.some(([auth, treeCount, sessCount]) => auth && treeCount > 0 && sessCount > 0),
    ).toBe(true);

    stopObs();
  });
});
