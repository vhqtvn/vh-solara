// @vitest-environment jsdom
//
// Slice B (send-net-resilience) — F3 fold: the transport-facing composition
// regression the Slice-A review deferred. BINDING CONTRACT:
// researches/decisions/2026-10-10-send-convergence-cascade-and-connstatus.md
// (Slice-B-for-B items).
//
// DEFECT (RED first): tree-transport's applyDetailIndependent + tryInstall call
// noteTreeConverged() after applySnapshot/applyScopedSnapshot REGARDLESS of the
// cascade guard's discard verdict — a STALE same-epoch detail snapshot (seq
// below the accepted cursor) could falsely satisfy a pending cascade pass's
// tree step and fire the unified queue-reconcile trigger with NO authoritative
// baseline having landed.
//
// CONTRACT (GREEN after the fold): noteTreeConverged fires ONLY when the
// snapshot installer actually APPLIED (installer returns applied=true). A
// stale discard while a cascade tree step is pending leaves the pass in
// flight (no queue trigger); the NEXT valid baseline satisfies it.
//
// Harness: stream1Registration.test.ts shape (MockEventSource + fresh module
// graph per test) so the frames travel the REAL connect() listener path.
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

async function setupFresh(): Promise<void> {
  vi.resetModules();
  tt = await import("../../src/sync/tree-transport");
  cascade = await import("../../src/sync/cascade");
  store = await import("../../src/sync/store");
  store.setProjectDirRaw("/test");
}

// Flush the pass-completion microtask (maybeComplete fires the queue trigger
// on a queueMicrotask with a generation check).
const flushMicro = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

// A frontier-scoped partial detail frame (cascade.test.ts scopedPartial
// shape) — travels the REAL `snapshot` listener → applyDetailIndependent →
// applyScopedSnapshot(guard) path.
const partialFrame = (seq: number, epoch: string, scope: string[]) => ({
  seq,
  epoch,
  sessions: scope.map((id) => ({ id, title: `p-${id}` })),
  partial: {
    mode: "tree-stream-1-frontier",
    scope,
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
    } as Record<string, "global" | "frontier" | "omitted">,
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

describe("F3 fold — noteTreeConverged gates on the guard's applied verdict", () => {
  it("a STALE same-epoch detail discard does NOT satisfy a pending cascade tree step; the next valid baseline does", async () => {
    tt.connect();
    const es = treeES();
    es.simulateOpen();

    // Queue-trigger spy (the unified Slice-A trigger surface).
    let triggers = 0;
    cascade.setQueueReconcileTrigger(() => {
      triggers++;
    });

    // Boot: a valid partial baseline at seq 100 / epoch "e1" applies and
    // re-baselines (state epoch empty → cross-epoch stream = trusted rebuild).
    es.fire("snapshot", partialFrame(100, "e1", ["demo"]));
    await flushMicro();
    expect(store.state.cursor).toBe(100);
    expect(store.state.epoch).toBe("e1");
    // No cascade was armed by the boot frame itself.
    expect(triggers).toBe(0);

    // Arm a cascade with an unconverged tree step (any Slice-A loss reason;
    // tree:"await" — the same step class noteServerRingGap arms).
    cascade.requestRecovery("tree-seq-gap", undefined, { tree: "await" });
    expect(cascade._getCascadeStateForTest().inFlight).toBe(true);

    // THE DEFECT FRAME: a stale same-epoch detail snapshot (seq 50 < accepted
    // cursor 100, epoch "e1") — the cascade guard DISCARDS it (stale-seq).
    // Pre-fold, applyDetailIndependent still called noteTreeConverged() and
    // the pass completed with NO authoritative baseline applied.
    es.fire("snapshot", partialFrame(50, "e1", ["demo"]));
    await flushMicro();
    // RED assertion (fails pre-fold, passes post-fold):
    expect(triggers).toBe(0);
    expect(cascade._getCascadeStateForTest().inFlight).toBe(true);
    // The discard must not have rewound the cursor either.
    expect(store.state.cursor).toBe(100);

    // A VALID baseline lands (seq 200, same epoch): applies → the pass's tree
    // step is satisfied TRUTHFULLY → exactly one unified queue trigger fires.
    es.fire("snapshot", partialFrame(200, "e1", ["demo"]));
    await flushMicro();
    expect(store.state.cursor).toBe(200);
    expect(triggers).toBe(1);
    expect(cascade._getCascadeStateForTest().inFlight).toBe(false);
  });

  it("a stale discard inside the COHERENT install path (tryInstall) also does not satisfy the pending tree step", async () => {
    tt.connect();
    const es = treeES();
    es.simulateOpen();

    let triggers = 0;
    cascade.setQueueReconcileTrigger(() => {
      triggers++;
    });

    // Arm the pass FIRST (tree step pending).
    cascade.requestRecovery("tree-seq-gap", undefined, { tree: "await" });
    expect(cascade._getCascadeStateForTest().inFlight).toBe(true);

    // Coherent capture: tree.snapshot + snapshot + snapshot.complete all at
    // {epoch:"e1", seq:42}, but the DETAIL participant is the one the guard
    // sees — after a first boot baseline above it. Boot first:
    es.fire("snapshot", partialFrame(300, "e1", ["demo"]));
    await flushMicro();
    expect(store.state.cursor).toBe(300);
    // (Boot frame applied while the pass was in flight — that is the LEGIT
    // satisfaction: applied baselines DO converge the tree step. Re-arm.)
    expect(triggers).toBe(1);
    cascade.requestRecovery("tree-seq-gap", undefined, { tree: "await" });

    // Now the coherent trio with a STALE detail seq (42 < 300) — the tree
    // projection seeds (unconditional, by design) but the detail discard must
    // NOT converge the pass. Note: the completion participant's seq is carried
    // by `revision` (tree-transport reads p.revision), and must match the bound
    // capture {epoch, seq} or the capture is judged incoherent (legacy flush).
    es.fire(
      "tree.snapshot",
      { tree: "2", epoch: "e1", seq: 42, nodes: [node("demo")] },
      "42.0",
    );
    es.fire("snapshot", partialFrame(42, "e1", ["demo"]), "42.0");
    es.fire("snapshot.complete", { epoch: "e1", revision: 42, projections: ["tree", "detail"] }, "42.0");
    await flushMicro();
    // RED assertion: no queue trigger from the stale coherent capture.
    expect(triggers).toBe(1);
    expect(cascade._getCascadeStateForTest().inFlight).toBe(true);
  });
});

// A valid TreeNode (per isTreeNode guard in treeOps.ts).
function node(id: string, parentId: string | null = null): any {
  return {
    id,
    parentId,
    title: `t-${id}`,
    activity: "idle",
    childCount: 0,
    loaded: true,
    updatedMs: 1,
    flags: {},
  };
}
