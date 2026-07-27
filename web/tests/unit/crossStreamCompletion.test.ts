// @vitest-environment jsdom
//
// Gap #3 (stream-invariant-audit §7b) — the cross-stream completion bridge.
//
// INVARIANT: when Stream 1 (tree/structural) receives `activity=idle`, the
// reducer stamps `time.completed` on the session's last assistant message IN
// THE SAME `setState(produce(...))` draft that clears `activity`. Both writes
// land in one Solid batch, so `settled` (which reads `info.time.completed`)
// flips in the SAME reactive flush that unmounts `.working-text` (which reads
// `activity[id]`).
//
// WHY IT MATTERS: Stream 1 (activity=idle) and Stream 2 (message.upsert with
// time.completed) are independent connections whose delivery order is NOT
// guaranteed. When Stream 1 wins, `.working-text` unmounts BEFORE Stream 2's
// completed upsert has flipped `settled`, so the streaming view (`.md-stream`)
// briefly outlives the busy indicator — the session-completion flake. The
// bridge closes that window by stamping completed optimistically on the tree
// stream, atomically with the activity clear.
//
// The bridge lives in `applyMessageEvent`'s `case "activity"` branch
// (stream.ts ~line 350-382), reached synchronously via the tree-ES listener +
// coveredAwait fast path (no pending tree-snapshot owner). It is scoped to
// `state === "idle"` only: busy/retry are mid-turn and must NOT be stamped.
//
// Real timers (NOT fake): the gzip64 decode path (used by gap #4's sibling
// test) runs through DecompressionStream's real async reader chain. This file
// does not exercise a decode, but mirrors the established harness so the two
// gap files share a single mental model.
//
// Mock EventSource + atomic observer mirror coherentBarrier.test.ts /
// streamIntegration.test.ts.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { gzipSync } from "node:zlib";
import { buildMessages } from "../../src/lib/reduce";

// ---------------------------------------------------------------------------
// Mock EventSource — same shape as coherentBarrier.test.ts. The tree stream
// URL has sessions=& (empty); the session stream URL carries sessions=<id>.
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

async function setupFresh(): Promise<void> {
  vi.resetModules();
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  store.setProjectDirRaw("/test");
  store.setSelectedIdRaw("s1");
}

// Pump macro+microtasks. Real timers — kept for parity with the gap-#4 file
// (which does need it for the gzip64 decode drain).
const tick = async (n = 1): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

// encodeForTest mirrors the server's maybeCompressSnapshot: JSON → gzip →
// base64. Unused by the bridge tests directly, but kept so the fixture story
// matches the audit's gzip64 envelope description.
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
// Fixture: seed the store with a STREAMING assistant message (no
// time.completed) and a non-idle activity facet. This is the pre-bridge state
// the completion flake exhibits: the assistant turn is in flight, activity is
// busy, settled is false.
// ---------------------------------------------------------------------------
function seedStreamingAssistant(sessionID: string, msgID: string, activity: string): void {
  store.setState("sessions", sessionID, { id: sessionID });
  store.setState("messages", sessionID, buildMessages([
    { info: { id: msgID, sessionID, role: "assistant" }, parts: [] },
  ]));
  store.setState("activity", sessionID, activity);
}

describe("Gap #3 — cross-stream completion bridge (activity=idle ⇢ time.completed)", () => {
  it("stamps time.completed on the last assistant message in the SAME Solid flush that activity flips to idle (atomic — no idle-without-completed tuple)", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // Pre-bridge state: assistant turn streaming, activity=busy, no completed.
    seedStreamingAssistant("s1", "m1", "busy");

    // Atomicity observer: record every [activity, completed] tuple Solid
    // flushes. The bridge invariant is that NO observed tuple has
    // activity==="idle" while completed===false — the activity clear and the
    // completed stamp land in ONE produce() draft = ONE Solid batch = ONE
    // flush. Under the prior code (no bridge, or completed stamped in a later
    // flush), the observer would capture ("idle", false) — the flake window
    // where .working-text has unmounted but settled is still false.
    const { createRoot, createEffect } = await import("solid-js");
    const tuples: Array<[string, boolean]> = [];
    const stopObs = createRoot((dispose) => {
      createEffect(() => {
        const act = store.state.activity["s1"];
        const msg = store.state.messages["s1"]?.byId?.["m1"];
        const completed = !!msg?.info?.time?.completed;
        tuples.push([act, completed]);
      });
      return dispose;
    });

    // Fire activity=idle on the TREE stream (Stream 1). The listener reaches
    // applyMessageEvent synchronously via the coveredAwait fast path (no
    // pending tree-snapshot owner). The produce() draft clears activity AND
    // stamps completed together.
    treeES.fire("activity", { sessionID: "s1", state: "idle" }, "1");

    // (a) completed was stamped on the assistant message
    const completed = store.state.messages["s1"]?.byId?.["m1"]?.info?.time?.completed;
    expect(typeof completed).toBe("number");
    expect(completed).toBeGreaterThan(0);
    // (b) activity flipped to idle
    expect(store.state.activity["s1"]).toBe("idle");
    // (c) ATOMICITY: no observer tuple ever saw idle-without-completed. This
    // is the precise flake marker — the streaming view never outlives the
    // busy indicator because settled flips in the same flush as the unmount.
    const flakeTuples = tuples.filter(([a, c]) => a === "idle" && !c);
    expect(flakeTuples, `expected no idle-without-completed tuple, got ${JSON.stringify(flakeTuples)}`).toHaveLength(0);
    // And the post-bridge state IS observable: at least one tuple shows
    // idle-with-completed.
    expect(tuples.some(([a, c]) => a === "idle" && c)).toBe(true);

    stopObs();
  });

  it("does NOT stamp time.completed on activity=busy or activity=retry (bridge scoped to idle — mid-turn states must not be stamped)", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // Seed an assistant message that has ALREADY completed once (e.g. via a
    // prior idle, or via Stream 2's message.upsert). The scope guard must not
    // re-stamp / overwrite completed on a subsequent busy/retry, and must not
    // stamp at all when completed is absent (mid-turn).
    store.setState("sessions", "s1", { id: "s1" });
    store.setState("messages", "s1", buildMessages([
      { info: { id: "m1", sessionID: "s1", role: "assistant" }, parts: [] },
    ]));
    store.setState("activity", "s1", "idle");

    const completedBefore = store.state.messages["s1"]?.byId?.["m1"]?.info?.time?.completed;
    expect(completedBefore).toBeUndefined();

    // activity=busy: a mid-turn signal. The bridge is scoped to idle, so this
    // must NOT stamp completed (the last assistant is genuinely in-flight).
    treeES.fire("activity", { sessionID: "s1", state: "busy" }, "1");
    expect(store.state.messages["s1"]?.byId?.["m1"]?.info?.time?.completed).toBeUndefined();

    // activity=retry: another mid-turn signal. Same scope guard.
    treeES.fire("activity", { sessionID: "s1", state: "retry" }, "2");
    expect(store.state.messages["s1"]?.byId?.["m1"]?.info?.time?.completed).toBeUndefined();
    // activity facet itself DID update (proves the event was handled, not dropped).
    expect(store.state.activity["s1"]).toBe("retry");
  });
});
