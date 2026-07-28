// @vitest-environment jsdom
//
// Stream1 (tree stream) connect() listener-registration MANIFEST — the second
// prerequisite called out by the stream.ts C4 solution-brief before any tree-
// transport extraction. connect() registers every Stream1 event listener on the
// tree EventSource; the tree-transport extraction will MOVE connect() (and its
// listener registrations) into a new module. This test is the manifest that
// FAILS the moment any listener is left behind: it pins the EXACT set of
// addEventListener kinds + onopen/onerror, and dispatches one event per kind to
// prove each reaches its handler with an observable side effect.
//
// The existing streamRegistration.test.ts pins only the TREE_STREAM_KINDS array
// contents (a static export). It does NOT prove connect() actually wires those
// kinds (or any of the other 10 named kinds) onto the EventSource — EventSource
// delivers a NAMED event solely to a matching addEventListener call, so a kind
// present in the array but never registered is silently dead on the wire. This
// file closes that gap by inspecting the live EventSource's listener map after a
// real connect().
//
// Pure test investment: NO source changes. Fake timers (like stream1Backoff) —
// every assertion here is synchronous on the fast path (no pending C4 owner, so
// coveredAwait returns null and every covered listener applies immediately).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock EventSource — stream1Backoff shape, plus a public listenerTypes() so the
// manifest can inspect the exact registered kinds after connect().
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
      lastEventId,
    });
    const arr = this.listeners.get(type);
    if (arr) for (const fn of arr) fn(ev);
  }

  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }

  simulateErrorClosed(): void {
    // Fatal: readyState→CLOSED, then fire onerror (mirrors stream1Backoff's
    // simulateError so the CLOSED branch of es.onerror runs).
    this.readyState = CLOSED;
    this.onerror?.();
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

// The complete expected listener manifest: every addEventListener kind connect()
// registers on the tree EventSource (stream.ts:1438–1914), in alphabetical order
// (matching Array.sort() on the registered keys) for a stable set diff. Note
// "ping" < "pins.*" lexicographically ('g' < 's'). onopen/onerror are asserted
// separately (they are property assignments, not addEventListener calls).
const EXPECTED_TREE_LISTENER_KINDS = [
  "activity",
  "activity.verb",
  "lastAgent.set",
  "notice",
  "permission.delete",
  "permission.upsert",
  "ping",
  "pins.snapshot",
  "pins.updated",
  "question.delete",
  "question.upsert",
  "session.delete",
  "session.upsert",
  "snapshot",
  "snapshot.complete",
  "status",
  "tree.op",
  "tree.snapshot",
  "unread.clear",
  "unread.set",
];

// ===========================================================================
// THE MANIFEST — the core extraction-regression catcher. After connect(), the
// tree EventSource must have a listener registered for EVERY Stream1 event kind.
// If the tree-transport extraction moves connect() and forgets to register any
// kind, this assertion fails with a precise set diff. onopen/onerror must also
// be wired (property assignments, not addEventListener).
// ===========================================================================
describe("Stream1 connect() listener manifest", () => {
  it("registers a listener for every Stream1 event kind on the tree EventSource (+ onopen/onerror)", () => {
    stream.connect();
    const es = treeESes()[0];
    const registered = es.listenerTypes();

    // Exact-set assertion: no missing kinds, no extra kinds.
    expect(registered).toEqual(EXPECTED_TREE_LISTENER_KINDS);
    // onopen / onerror are property assignments (not in the listener map).
    expect(typeof es.onopen).toBe("function");
    expect(typeof es.onerror).toBe("function");
  });

  // -------------------------------------------------------------------------
  // onopen / onerror — the two property-assignment handlers. onopen marks the
  // stream live (status="live") and resets backoff; a fatal CLOSED onerror
  // marks it reconnecting (and schedules the backoff reopen, characterized in
  // stream1Backoff.test.ts — here we only assert the synchronous status flip).
  // -------------------------------------------------------------------------
  it("onopen sets status=live; fatal CLOSED onerror sets status=reconnecting", () => {
    stream.connect();
    const es = treeESes()[0];
    // Before open, status is the store initial ("connecting").
    expect(store.state.status).toBe("connecting");

    es.simulateOpen();
    expect(store.state.status).toBe("live");

    // Fatal error: readyState CLOSED → the onerror CLOSED branch flips status.
    es.simulateErrorClosed();
    expect(store.state.status).toBe("reconnecting");
  });

  // -------------------------------------------------------------------------
  // Structural live listeners — the covered kinds that route through
  // applySessionEvent / applyTreeOpStore. On the fast path (no pending C4
  // owner) coveredAwait returns null and they apply SYNCHRONOUSLY.
  //   session.upsert → state.sessions[id] upsert
  //   session.delete → state.sessions[id] prune
  //   tree.op (node.upsert) → treeMap node set
  // -------------------------------------------------------------------------
  it("session.upsert / session.delete / tree.op mutate the store synchronously on the fast path", () => {
    stream.connect();
    const es = treeESes()[0];
    es.simulateOpen();

    // session.upsert — adds a live detail session.
    es.fire("session.upsert", { id: "sX", title: "live" }, "10");
    expect(store.state.sessions.sX).toEqual({ id: "sX", title: "live" });
    // Cursor advanced (trackCursor=true; seq 10 > 0).
    expect(store.state.cursor).toBe(10);

    // session.delete — prunes the session.
    es.fire("session.delete", { id: "sX" }, "11");
    expect(store.state.sessions.sX).toBeUndefined();
    expect(store.state.cursor).toBe(11);

    // tree.op node.upsert — adds a live tree node (structural, separate from
    // the detail sessions map).
    es.fire("tree.op", { op: "node.upsert", data: { node: node("t1") } }, "12");
    expect(treeState.treeMap().get("t1")).toBeTruthy();
    expect(store.state.cursor).toBe(12);
  });

  // -------------------------------------------------------------------------
  // TREE_STREAM_KINDS — the 10 named events routed through applyMessageEvent.
  // Each must reach its handler case with an observable facet mutation. Done in
  // upsert-then-delete order so the delete/clear kinds have prior state.
  // -------------------------------------------------------------------------
  it("every TREE_STREAM_KINDS listener reaches applyMessageEvent (observable per facet)", async () => {
    stream.connect();
    const es = treeESes()[0];
    es.simulateOpen();
    const SID = "sK";
    // notify is imported (cached) by stream.ts at its module load; the same
    // instance is returned here so the pushNotification spy patches the live
    // binding the status handler captured.
    const notify = await import("../../src/notify");

    // activity (busy) → state.activity[SID]
    es.fire("activity", { sessionID: SID, state: "busy" }, "20");
    expect(store.state.activity[SID]).toBe("busy");

    // activity.verb → state.currentVerbs[SID]
    es.fire("activity.verb", { sessionID: SID, tool: "Read", state: "x.go" }, "21");
    expect(store.state.currentVerbs[SID]).toEqual({ tool: "Read", state: "x.go" });

    // lastAgent.set → state.lastAgents[SID] (+ tree-node bridge)
    es.fire("lastAgent.set", { sessionID: SID, agent: "agentK" }, "22");
    expect(store.state.lastAgents[SID]).toBe("agentK");

    // permission.upsert → state.permissions[SID][id]
    es.fire("permission.upsert", { sessionID: SID, id: "p1", tool: "Bash" }, "23");
    expect(store.state.permissions[SID]?.p1).toBeTruthy();

    // question.upsert → state.questions[SID][id]
    es.fire("question.upsert", { sessionID: SID, id: "q1", text: "ok?" }, "24");
    expect(store.state.questions[SID]?.q1).toBeTruthy();

    // unread.set → state.unread[SID]
    es.fire("unread.set", { sessionID: SID }, "25");
    expect(store.state.unread[SID]).toBe(true);

    // status (with error payload) → pushNotification (the only status side
    // effect; activity drives the indicator). Spy on the notify module export
    // the handler calls.
    const pushSpy = vi.spyOn(notify, "pushNotification");
    es.fire("status", { sessionID: SID, error: { message: "boom" } }, "26");
    expect(pushSpy).toHaveBeenCalled();
    pushSpy.mockRestore();

    // --- delete/clear kinds (need the prior upserts above) ---
    // permission.delete → removes p1
    es.fire("permission.delete", { sessionID: SID, permissionID: "p1" }, "27");
    expect(store.state.permissions[SID]?.p1).toBeUndefined();

    // question.delete → removes q1
    es.fire("question.delete", { sessionID: SID, questionID: "q1" }, "28");
    expect(store.state.questions[SID]?.q1).toBeUndefined();

    // unread.clear → removes SID
    es.fire("unread.clear", { sessionID: SID }, "29");
    expect(store.state.unread[SID]).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Fast-path listeners — notice / pins.snapshot / pins.updated / ping. These
  // are disjoint from tree/detail coherent state and never await the owner.
  //   notice      → alerts.handleNotice (spied)
  //   pins.*      → sidebar.applyPins{Snapshot,Updated} (spied)
  //   ping        → markTreeTransportSeen → state.lastSeen mirror (throttled)
  // -------------------------------------------------------------------------
  it("notice + pins.snapshot + pins.updated reach their handlers; ping refreshes the transport clock", async () => {
    stream.connect();
    const es = treeESes()[0];
    es.simulateOpen();

    // notice → alerts.handleNotice.
    const alerts = await import("../../src/alerts");
    const noticeSpy = vi.spyOn(alerts, "handleNotice");
    es.fire("notice", { title: "n", body: "b" });
    expect(noticeSpy).toHaveBeenCalled();
    noticeSpy.mockRestore();

    // pins.snapshot / pins.updated → sidebar facade (re-exported from ../pins).
    const sidebar = await import("../../src/sidebar");
    const pinsSnapSpy = vi.spyOn(sidebar, "applyPinsSnapshot");
    const pinsUpdSpy = vi.spyOn(sidebar, "applyPinsUpdated");
    es.fire("pins.snapshot", { initialized: true, revision: 1, orderedSessionIds: [] });
    es.fire("pins.updated", { sessionID: "sP", pinned: true });
    expect(pinsSnapSpy).toHaveBeenCalled();
    expect(pinsUpdSpy).toHaveBeenCalled();
    pinsSnapSpy.mockRestore();
    pinsUpdSpy.mockRestore();

    // ping → markTreeTransportSeen refreshes treeLastSeen, mirrored (throttled
    // to ~1/sec) into state.lastSeen. Bypass the throttle: connect()'s
    // construction-time markTreeSeen already wrote lastSeen, so advance fake
    // time past the 1s window so this ping's mirror write is admitted.
    const before = store.state.lastSeen;
    vi.advanceTimersByTime(1001);
    es.fire("ping", null);
    expect(store.state.lastSeen).toBeGreaterThan(before as number);
  });

  // -------------------------------------------------------------------------
  // Coherent-capture listeners — snapshot (detail) + tree.snapshot (tree) +
  // snapshot.complete (boundary). Fired as ONE coherent {epoch, seq} triple
  // (RAW, no gzip64 → synchronous install). If any of the three were missing
  // its listener, the install would not fire: authoritativeReady stays false
  // and/or the projections stay empty.
  // -------------------------------------------------------------------------
  it("coherent-capture listeners install atomically: snapshot + tree.snapshot + snapshot.complete", () => {
    stream.connect();
    const es = treeESes()[0];
    es.simulateOpen();
    const EPOCH = "e1";
    const SEQ = 100;

    // tree.snapshot (RAW, with epoch) → owner created, tree staged.
    es.fire("tree.snapshot", { tree: "2", epoch: EPOCH, seq: SEQ, nodes: [node("s1"), node("s2")] }, String(SEQ));
    // No install yet (detail + completion missing) — but the tree listener DID
    // run: a pending owner exists.
    expect(stream.isTreeSnapshotDecoding()).toBe(true);

    // detail `snapshot` → stages detail (identity {e1,100}).
    es.fire("snapshot", {
      seq: SEQ,
      epoch: EPOCH,
      sessions: [{ id: "s1", title: "d-s1" }, { id: "s2", title: "d-s2" }],
    }, String(SEQ));

    // snapshot.complete → completion staged → tryInstall sees all three →
    // atomic install in one batch → authoritativeReady=true. Synchronous for a
    // RAW triple (no decode await).
    es.fire("snapshot.complete", { epoch: EPOCH, revision: SEQ, projections: ["tree", "detail"] }, String(SEQ));

    expect(store.state.authoritativeReady).toBe(true);
    expect(treeState.treeMap().get("s1")).toBeTruthy();
    expect(treeState.treeMap().get("s2")).toBeTruthy();
    expect(Object.keys(store.state.sessions).sort()).toEqual(["s1", "s2"]);
  });
});
