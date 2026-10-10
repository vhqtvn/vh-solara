// @vitest-environment jsdom
//
// Slice B (send-net-resilience) — the ringGap PRECISE-SIGNAL switch, at the
// transport seam. BINDING CONTRACT:
// researches/decisions/2026-10-10-send-convergence-cascade-and-connstatus.md.
//
// Server truth (pkg/web/server.go): cause:"reconnect" is stamped on EVERY
// cursor-resume reconnect (the replay-success branch HARDCODES it on its
// post-replay re-seed snapshots; the fresh-snapshot branch derives it from
// the hasCursor && !replayOK gate). The ONLY true-gap stamp is the detail
// snapshot's partial.ringGap=true (`detailSnap.Partial.RingGap` in
// handleStream's fresh-snapshot fallback, hasCursor && !replayOK — the sole
// stamping site; field semantics: PartialMeta.RingGap in
// pkg/state/store.go).
//
// FE contract after the switch:
//  - detail `snapshot` frame with partial.ringGap=true → noteServerRingGap()
//    (server-ring-gap counter + a tree-await cascade pass).
//  - tree.snapshot with cause:"reconnect" (no ringGap) → benign telemetry
//    ONLY (server-reconnect-resume counter; NO cascade arming).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

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

  fire(type: string, data: unknown, lastEventId = ""): void {
    const ev = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
      lastEventId,
    });
    const arr = this.listeners.get(type);
    if (arr) for (const fn of arr) fn(ev);
  }

  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }
}

let instances: MockEventSource[] = [];

const treeES = (): MockEventSource => {
  const es = instances.find((e) => e.readyState !== CLOSED && !/sessions=[^&]/.test(e.url));
  if (!es) throw new Error("no tree EventSource connected");
  return es;
};

let tt: typeof import("../../src/sync/tree-transport") = null as unknown as typeof import("../../src/sync/tree-transport");
let cascade: typeof import("../../src/sync/cascade") = null as unknown as typeof import("../../src/sync/cascade");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
let rr: typeof import("../../src/sync/recovery-reasons") = null as unknown as typeof import("../../src/sync/recovery-reasons");
let treeOps: typeof import("../../src/sync/treeOps") = null as unknown as typeof import("../../src/sync/treeOps");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  tt = await import("../../src/sync/tree-transport");
  cascade = await import("../../src/sync/cascade");
  store = await import("../../src/sync/store");
  rr = await import("../../src/sync/recovery-reasons");
  treeOps = await import("../../src/sync/treeOps");
  store.setProjectDirRaw("/test");
}

const flushMicro = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const partialFrame = (seq: number, epoch: string, scope: string[], ringGap?: boolean) => ({
  seq,
  epoch,
  sessions: scope.map((id) => ({ id, title: `p-${id}` })),
  partial: {
    mode: "tree-stream-1-frontier",
    scope,
    ringGap,
    authority: {
      sessions: "frontier",
      activity: "frontier",
      gate: "frontier",
      lastAgents: "frontier",
      currentVerbs: "frontier",
      questions: "global",
      permissions: "global",
      unread: "global",
      todos: "omitted",
      statuses: "omitted",
      messages: "omitted",
    } as Record<string, unknown>,
  },
});

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
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

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

describe("ringGap precise-signal switch (Slice B)", () => {
  it("partial.ringGap=true on the detail snapshot arms the cascade + counts server-ring-gap", async () => {
    tt.connect();
    const es = treeES();
    es.simulateOpen();

    // Boot baseline first (epoch "e1", cursor 100) so the guard state is warm.
    es.fire("snapshot", partialFrame(100, "e1", ["demo"]));
    await flushMicro();
    expect(rr.readSyncDiag().recovery["server-ring-gap"]).toBeUndefined();

    // The true-gap frame: partial.ringGap=true. Even when the frame itself
    // stale-discards (seq 50 < cursor 100), the server DID fall back — the
    // signal is consumed at frame-in-hand, not conditional on the apply.
    es.fire("snapshot", partialFrame(50, "e1", ["demo"], true));
    await flushMicro();

    expect(rr.readSyncDiag().recovery["server-ring-gap"]?.count).toBe(1);
    expect(cascade._getCascadeStateForTest().inFlight).toBe(true);
    // And per the F3 fold, the stale frame must NOT have converged the pass
    // (no queue trigger, still in flight).
    expect(cascade._getCascadeStateForTest().queueTriggers).toBe(0);
  });

  it("a fresh ringGap frame both applies AND arms (applied baseline then converges the pass)", async () => {
    tt.connect();
    const es = treeES();
    es.simulateOpen();

    let triggers = 0;
    cascade.setQueueReconcileTrigger(() => {
      triggers++;
    });

    // First frame IS the ring-gap fallback (fresh boot: epoch empty → the
    // cross-epoch stream verdict applies + re-baselines).
    es.fire("snapshot", partialFrame(70, "e2", ["demo"], true));
    await flushMicro();

    expect(rr.readSyncDiag().recovery["server-ring-gap"]?.count).toBe(1);
    // Applied baseline converges the armed pass → one unified trigger.
    expect(triggers).toBe(1);
    expect(cascade._getCascadeStateForTest().inFlight).toBe(false);
  });

  it("cause:\"reconnect\" on tree.snapshot WITHOUT ringGap counts benign telemetry and arms NOTHING", async () => {
    tt.connect();
    const es = treeES();
    es.simulateOpen();

    es.fire("snapshot", partialFrame(100, "e1", ["demo"]));
    await flushMicro();

    // A replay-success resume: cause "reconnect", no ringGap flag anywhere.
    es.fire("tree.snapshot", { tree: "2", epoch: "e1", seq: 120, cause: "reconnect", nodes: [node("demo")] }, "120.0");
    await flushMicro();

    expect(rr.readSyncDiag().recovery["server-reconnect-resume"]?.count).toBe(1);
    expect(rr.readSyncDiag().recovery["server-ring-gap"]).toBeUndefined();
    expect(cascade._getCascadeStateForTest().inFlight).toBe(false);
  });

  it("decodeTreeSnapshot retains cause through the tree decoder (back-compat pin)", () => {
    const snap = treeOps.decodeTreeSnapshot({
      nodes: [node("demo")],
      epoch: "e1",
      seq: 42,
      cause: "reconnect",
    });
    expect(snap).not.toBeNull();
    expect(snap?.cause).toBe("reconnect");
    expect(snap?.epoch).toBe("e1");
    expect(snap?.seq).toBe(42);
  });
});
