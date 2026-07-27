// @vitest-environment jsdom
//
// coveredAwait mid-wait generation bump — audit gap #2 (tree-transport split
// prerequisite). Pins §5d#7 directly: a covered live handler that captured
// owner.promise and suspended MUST, on resumption, re-check treeGen and DROP
// its reducer if the generation advanced during the wait. The post-await gen
// re-check (stream.ts:2040 `if (gen !== treeGen) return;`) runs BEFORE
// advanceCursor and BEFORE the reducer — no partial application.
//
// This is distinct from coherentBarrier's C-F2 case (which fires onerror to
// bump the gen) and Case 6 (which proves a stale DECODE is dropped post-await).
// Here the gen-bump trigger is `connect(true)` — the OTHER bump site
// (stream.ts:1709, the resync/reconnect path) — and the suspended party is a
// COVERED LIVE HANDLER (tree.op), not a decode. This proves the post-await
// re-check is not specific to the decode path or to onerror; it is the uniform
// contract every covered-await caller enforces.
//
// Real timers (NOT fake): the gzip64 decode runs through DecompressionStream's
// real async reader chain (mirrors coherentBarrier.test.ts).
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

// Pump macro+microtasks. Real timers — DecompressionStream's reader.read chain
// is a real async source (mirrors coherentBarrier.test.ts).
const tick = async (n = 1): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

// Await the in-flight owner/decode directly via the module accessor.
const awaitOwner = async (): Promise<void> => {
  await stream.getTreeSnapshotDecode();
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

// Fixture: a valid TreeNode (per isTreeNode guard in treeOps.ts).
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
// coveredAwait + connect(true) mid-wait gen bump.
//
// The tree.op listener (stream.ts:2025-2055) captures `wait = coveredAwait(gen)`
// and awaits it. connect(true) bumps treeGen (stream.ts:1709) and calls
// cancelPendingOwner (stream.ts:1713), which resolves owner.promise via
// releaseOwner(waitForTree=false) — IMMEDIATE release, no tree-chaining,
// because the waiters are expected to fail their gen check and never apply.
// The suspended handler resumes; the post-await `if (gen !== treeGen) return;`
// (stream.ts:2040) drops it BEFORE applyTreeOpStore / advanceCursor.
// ===========================================================================
describe("coveredAwait — mid-wait treeGen bump drops the reducer (§5d#7)", () => {
  it("a covered tree.op handler suspended on owner.promise drops its reducer when connect(true) bumps the generation mid-wait", async () => {
    stream.connect();
    const es1 = treeESes()[0];
    es1.simulateOpen();
    const cursorBefore = store.state.cursor;

    // 1. tree.snapshot gzip64 (epoch e1, seq 10) → owner created, decode HELD.
    //    owner.promise is pending; covered handlers that arrive now will suspend.
    es1.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest({ tree: "2", epoch: "e1", seq: 10, nodes: [node("base")] }),
    }), "10");
    // The owner is pending (decode in flight) → a covered handler has something
    // to await. This is the load-bearing precondition for the test: if the
    // owner were not pending, coveredAwait would return null and the handler
    // would apply synchronously (no await, no gen-bump window to test).
    expect(stream.isTreeSnapshotDecoding()).toBe(true);

    // 2. Covered tree.op (node.upsert, seq 11) → the listener calls
    //    coveredAwait(gen=1), gets owner.promise back, and suspends at
    //    `if (wait) await wait;` (stream.ts:2039). The reducer has NOT run.
    es1.fire("tree.op", { op: "node.upsert", data: { node: node("liveNode") } }, "11");

    // 3. Mid-wait generation bump via connect(true) — the resync/reconnect
    //    path (the OTHER gen-bump site besides onerror). connect(true):
    //      treeGen++           (1 → 2; es1's listeners captured gen=1, now stale)
    //      cancelPendingOwner  (owner.promise resolves via releaseOwner(false))
    //      treeSnapshotDecode reset, treeSnapshotDecoding=false
    //      es1.close()
    //      new EventSource constructed (es2)
    //    The suspended tree.op handler's continuation is now scheduled.
    stream.connect(true);
    // es1 is now CLOSED (connect closed it); the new ES exists.
    expect(es1.readyState).toBe(MockEventSource.CLOSED);

    // 4. Flush: the OLD decode IIFE completes → its gen check fails (no seed);
    //    the tree.op handler resumes → its gen check fails (no reducer, no
    //    cursor advance). tick(3) drains the DecompressionStream chain + the
    //    handler continuation.
    await tick(3);

    // 5a. The covered handler's reducer did NOT run: liveNode absent.
    expect(treeState.treeMap().get("liveNode")).toBeUndefined();
    // 5b. The baseline decode was also invalidated by the gen bump: base absent.
    //    (Corroborates Case 6's decode-drop finding via a different trigger.)
    expect(treeState.treeMap().get("base")).toBeUndefined();
    // 5c. advanceCursor was NOT called by the dropped handler: cursor unchanged.
    //    The post-await gen check returns BEFORE the `advanceCursor(seq)` at
    //    stream.ts:2050, so no cursor side-effect leaks from the stale handler.
    expect(store.state.cursor).toBe(cursorBefore);
    // 5d. No coherent install fired (the owner was canceled, not installed).
    expect(store.state.authoritativeReady).toBe(false);
  });
});
