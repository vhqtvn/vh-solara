// @vitest-environment jsdom
//
// C4 coherent-capture barrier — expandTreeNode (HTTP tree=2 expand) deferral +
// generation-drop characterization. Two ADDITIONAL prerequisite tests called out
// by the stream.ts C4 solution-brief BEFORE any tree-transport extraction:
// expandTreeNode must defer its APPLY (not its request) behind a pending C4
// PendingCaptureOwner, and must DROP the deferred apply entirely once the
// generation token (treeGen) bumps (reconnect / resync).
//
// The mechanism under test is `expandTreeNode`'s `ownerAwareApply` closure
// (stream.ts:2298-2314): immediately before applying each fetched `node.children`
// op it captures `pendingOwner`; if a coherent capture is in flight
// (non-legacy, non-settled, same generation) it CHAINS the apply on
// `ownerNow.promise.then(...)` instead of running it synchronously, and the
// chained callback rechecks `ownerNow.generation !== treeGen` before applying.
// This prevents a coherent seedTreeStore (wholesale treeMap replace inside the
// install batch) from wiping just-applied expand children; the children land on
// the seeded coherent map as the live tail. If a reconnect bumps treeGen first,
// the deferred apply is dropped (the superseded expand's children would attach
// to a stale baseline).
//
// Pure test investment: NO source changes. The existing characterization suite
// (coherentBarrier, streamIntegration, stream1Backoff) covers the SSE covered-
// handler path (coveredAwait). This file pins the ANALOGOUS contract for the
// point-HTTP expand path, which `ownerAwareApply` implements separately from
// `coveredAwait` (it does NOT route through coveredAwait — it captures
// pendingOwner directly and hand-rolls the defer + gen recheck).
//
// Real timers (NOT fake): mirrors coherentBarrier.test.ts. We use a RAW
// tree.snapshot (no gzip64) to hold the owner pending via the staging path
// (finishDecode runs sync, owner stays non-settled until detail+completion
// install or a gen bump cancels) — so no DecompressionStream real-decode is
// needed. The only real async source is the expand fetch mock, which flushes
// through microtask hops via tick().
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock EventSource — same shape as coherentBarrier.test.ts / streamIntegration.
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

// Pump macro+microtasks. Real timers — the expand fetch mock resolves through
// the microtask queue; each setTimeout(0) round flushes all queued microtasks.
const tick = async (n = 1): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

// Await the in-flight owner/decode directly via the module accessor (mirrors
// coherentBarrier). For a RAW tree.snapshot with no detail/completion, this
// returns the pending owner's promise and resolves when the owner settles
// (install OR cancel).
const awaitOwner = async (): Promise<void> => {
  await stream.getTreeSnapshotDecode();
};

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

// A RAW (synchronous) tree.snapshot body carrying a valid epoch so the owner is
// created and held pending via the staging path (no gzip64 → no real decode).
function treeSnapBody(seq: number, epoch: string, ids: string[]): any {
  return { tree: "2", epoch, seq, nodes: ids.map((id) => node(id)) };
}

// A detail `snapshot` body (Snapshot type; ships RAW in tree=2).
function detailSnap(seq: number, epoch: string, ids: string[]): any {
  return {
    seq,
    epoch,
    sessions: ids.map((id) => ({ id, title: `d-${id}` })),
  };
}

// The JSON body the expand HTTP fetcher expects (the server's ChildrenResponse,
// possibly gzip64-wrapped when ≥ 2 KiB; we return it RAW so decodeSnapshot is a
// pass-through and the only async hops are the fetch + res.json() + decode).
function childrenBody(parentId: string, childIds: string[]): unknown {
  return {
    parentId,
    nodes: childIds.map((id) => node(id, parentId)),
    hasMore: false,
  };
}

// A page-scoped detail bundle (the ExpandChildrenWithDetail payload) — a partial
// Snapshot with mode "expand-page", scope = page ids, and the full authority map.
function expandDetailBundle(seq: number, scope: string[], sessions: { id: string; title: string }[]): unknown {
  return {
    seq,
    epoch: "e1",
    sessions,
    partial: {
      mode: "expand-page",
      scope,
      authority: {
        sessions: "frontier", activity: "frontier", gate: "frontier",
        lastAgents: "frontier", currentVerbs: "frontier",
        questions: "global", permissions: "global", unread: "global",
        todos: "omitted", statuses: "omitted", messages: "omitted",
      },
    },
  };
}

// childrenBody + a detail bundle (the server ships both under one response).
function childrenBodyWithDetail(parentId: string, childIds: string[], detail: unknown): unknown {
  return { ...(childrenBody(parentId, childIds) as object), detail };
}

beforeEach(async () => {
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  // expandTreeNode's fetcher GETs /vh/tree/children?dir=&id=&z=1 — return a
  // ChildrenResponse for that URL so fetchChildren emits one node.children op.
  // All other URLs get an inert 200 (connect() does not fetch; loadOlder is not
  // exercised here).
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (typeof url === "string" && url.startsWith("/vh/tree/children")) {
        return new Response(JSON.stringify(childrenBody("parent", ["c1"])), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("{}", { status: 200 });
    }),
  );
  window.localStorage.clear();
  await setupFresh();
});

afterEach(() => {
  stream?.closeSessionStream();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

// ===========================================================================
// Case A — DEFER behind a pending C4 owner, then APPLY after the coherent
// install settles. Proves ownerAwareApply sees pendingOwner mid-flight, chains
// the apply on ownerNow.promise, and the chained callback's gen recheck PASSES
// (treeGen unchanged) so applyTreeOpStore runs once the owner settles via the
// install path.
//
// Mutation-observability: the fetched child node ("c1") appears in treeMap ONLY
// after awaitOwner(). If ownerAwareApply applied synchronously (no defer), c1
// would appear BEFORE the install — and then be WIPED by the coherent install's
// seedTreeStore (wholesale treeMap replace) — the exact data-loss race this
// invariant prevents. So the "c1 absent pre-install, present post-install"
// sequence is the crux.
// ===========================================================================
describe("expandTreeNode C4 deferral — Case A: defer then apply after settle", () => {
  it("defers the node.children apply behind a pending owner; applies after the coherent install settles", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // 1. Open a coherent capture: a RAW tree.snapshot with a valid epoch. The
    //    owner is created (ensureOwner) and stays pending — finishDecode runs
    //    synchronously and stages the tree, but tryInstall cannot fire without
    //    detail + completion. isTreeSnapshotDecoding() is true (pending owner).
    treeES.fire("tree.snapshot", treeSnapBody(100, "e1", ["base"]), "100");
    expect(stream.isTreeSnapshotDecoding()).toBe(true);

    // 2. Fire expandTreeNode during the pending window. The HTTP fetch resolves
    //    fast; ownerAwareApply runs AFTER the fetch resolves, sees pendingOwner
    //    (non-legacy, non-settled, same generation) and CHAINS the apply on
    //    ownerNow.promise instead of applying synchronously. We do NOT await
    //    expandTreeNode yet — capture it to await after the settle.
    const expandP = stream.expandTreeNode("parent");
    // Flush the fetch + res.json() + decodeSnapshot microtask chain so
    // ownerAwareApply has run (and deferred).
    await tick(5);

    // 3. CRUX — deferred: the fetched child is NOT in treeMap. The owner is
    //    STILL pending (decode/owner unsettled). If ownerAwareApply had applied
    //    synchronously, c1 would already be present (and then wiped by the
    //    install's seed below — silent data loss).
    expect(treeState.treeMap().get("c1")).toBeUndefined();
    expect(stream.isTreeSnapshotDecoding()).toBe(true);

    // 4. Complete the coherent capture: detail `snapshot` + `snapshot.complete`.
    //    Both stage into the pending owner (identity {e1, 100}); tryInstall now
    //    sees all three participants staged + identity valid → installs BOTH
    //    projections in one batch → settles the owner → ownerNow.promise
    //    resolves → the chained apply fires.
    treeES.fire("snapshot", detailSnap(100, "e1", ["base"]), "100");
    treeES.fire(
      "snapshot.complete",
      { epoch: "e1", revision: 100, projections: ["tree", "detail"] },
      "100",
    );

    // 5. Await the owner settle + the chained apply (registered earlier, so it
    //    fires before this await resolves) + any trailing microtasks.
    await awaitOwner();
    await expandP;
    await tick(2);

    // 6. CRUX — applied: the deferred child now landed on the SEEDED coherent
    //    map (the live tail). c1 is present; the seed's "base" also survived.
    expect(treeState.treeMap().get("c1")).toBeTruthy();
    expect(treeState.treeMap().get("base")).toBeTruthy();
    // The owner is fully settled (no lingering pending owner).
    expect(stream.isTreeSnapshotDecoding()).toBe(false);
  });
});

// ===========================================================================
// Case B — DEFER then DROP after a generation bump. Proves the chained apply's
// gen recheck (`ownerNow.generation !== treeGen`) FAILS once treeGen advances,
// so applyTreeOpStore never runs and the fetched child NEVER lands — even though
// ownerNow.promise resolves (the gen bump's cancelPendingOwner settles it).
//
// We bump treeGen via connect(true) (the resync/reconnect entry). connect() does
// EXACTLY what onerror's CLOSED branch does for the owner invariant — treeGen++
// BEFORE cancelPendingOwner() (stream.ts:1380-1384) — so the deferred apply's
// recheck fails. Using connect(true) keeps the test deterministic with real
// timers (no dangling 1000ms reconnect setTimeout that onerror would schedule).
// The onerror CLOSED → treeGen++ path itself is characterized by
// stream1Backoff.test.ts and coherentBarrier's C-F2 case; this test exercises
// the same gen-bump-then-cancel effect on the EXPAND deferral specifically.
//
// Mutation-observability: if ownerAwareApply's gen recheck were removed, the
// deferred apply would run after the cancel and c1 would appear in treeMap
// (attached to the stale/superseded baseline). The "c1 absent even after
// awaitOwner" assertion fails in that case.
// ===========================================================================
describe("expandTreeNode C4 deferral — Case B: drop after generation bump", () => {
  it("DROPS the deferred node.children apply when treeGen bumps (connect(true) resync) during the pending window", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // 1. Open a coherent capture (RAW tree.snapshot) → owner pending.
    treeES.fire("tree.snapshot", treeSnapBody(100, "e1", ["base"]), "100");
    expect(stream.isTreeSnapshotDecoding()).toBe(true);

    // 2. Fire expandTreeNode → fetcher resolves → ownerAwareApply defers on
    //    ownerNow.promise (captured BEFORE the gen bump).
    const expandP = stream.expandTreeNode("parent");
    await tick(5);

    // 3. Deferred: child NOT in treeMap yet.
    expect(treeState.treeMap().get("c1")).toBeUndefined();

    // 4. Bump treeGen via connect(true). connect() does treeGen++ BEFORE
    //    cancelPendingOwner() (stream.ts:1380-1384), so the deferred apply's
    //    gen recheck (ownerNow.generation !== treeGen) will FAIL. The prior
    //    owner is canceled (settled) → ownerNow.promise resolves → the chained
    //    callback runs → recheck fails → return WITHOUT applying.
    stream.connect(true);
    // connect(true) constructed a fresh tree EventSource; mark it open so the
    // module is in a clean live state for the remainder.
    const freshES = treeESes()[treeESes().length - 1];
    freshES.simulateOpen();

    // 5. Await the cancel-settle + the chained callback + trailing microtasks.
    await awaitOwner();
    await expandP;
    await tick(2);

    // 6. CRUX — DROPPED: the deferred child NEVER landed. The gen recheck
    //    failed and applyTreeOpStore was not called. c1 stays absent.
    expect(treeState.treeMap().get("c1")).toBeUndefined();
    // The prior owner was canceled (not left wedged); no decode/owner pending
    // for the fresh generation.
    expect(stream.isTreeSnapshotDecoding()).toBe(false);
  });
});

// ===========================================================================
// Case C (F4) — the expand-page DETAIL install (applyScopedSnapshot) must honor
// the SAME C4 deferral as ownerAwareApply (Cases A/B cover the tree-OP apply).
// Without the guard (tree-transport.ts:1467 pre-fix), an expand HTTP resolving
// while a coherent capture is pending runs applyScopedSnapshot UNGUARDED: its
// UNCONDITIONAL cursor set (reconcile.ts:239) lands BEFORE tryInstall's
// advanceCursor (:677, non-ratcheting) → cursor REGRESSES (expand N+5 → coherent
// N); and on scope overlap the older coherent data clobbers the newer expand
// data. The fix mirrors ownerAwareApply: defer the detail apply onto
// ownerNow.promise (+ gen recheck) so the coherent install lands FIRST and the
// deferred expand applies LAST (newer wins, cursor advances forward — no
// regression, no clobber).
// ===========================================================================
describe("expandTreeNode C4 deferral — Case C (F4): defer the expand-page DETAIL install", () => {
  it("defers applyScopedSnapshot behind the pending owner → no cursor regression; newer expand data wins on overlap", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // 1. Open a coherent capture (tree.snapshot seq=100, frontier {base, c1}).
    //    c1 is in the coherent frontier AND will be in the expand page → overlap.
    treeES.fire("tree.snapshot", treeSnapBody(100, "e1", ["base", "c1"]), "100");
    expect(stream.isTreeSnapshotDecoding()).toBe(true);

    // 2. Re-stub fetch so the expand returns a page-scoped DETAIL bundle at a
    //    NEWER seq (105) carrying NEWER data for the overlapping id c1.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (typeof url === "string" && url.startsWith("/vh/tree/children")) {
          return new Response(
            JSON.stringify(
              childrenBodyWithDetail(
                "base",
                ["c1"],
                expandDetailBundle(105, ["c1"], [{ id: "c1", title: "expand-c1-new" }]),
              ),
            ),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const beforeCursor = store.state.cursor;
    // 3. Fire expandTreeNode during the pending window → fetcher resolves →
    //    the F4 guard defers applyScopedSnapshot onto ownerNow.promise.
    const expandP = stream.expandTreeNode("base");
    await tick(5);

    // 4. CRUX — DEFERRED: the expand detail is NOT yet installed (c1 absent from
    //    state.sessions) and the cursor did NOT jump to 105. Without the guard,
    //    applyScopedSnapshot would have run synchronously (c1 present, cursor 105)
    //    and the later coherent install would then regress the cursor + clobber.
    expect(store.state.sessions.c1).toBeUndefined();
    expect(store.state.cursor).toBe(beforeCursor);

    // 5. Complete the coherent capture at the OLDER seq 100. tryInstall runs
    //    (coherent detail c1="d-c1" + advanceCursor(100)), settles the owner →
    //    the deferred expand apply fires (registered before the release) →
    //    c1="expand-c1-new" (newer wins) + cursor advances to 105.
    treeES.fire("snapshot", detailSnap(100, "e1", ["base", "c1"]), "100");
    treeES.fire(
      "snapshot.complete",
      { epoch: "e1", revision: 100, projections: ["tree", "detail"] },
      "100",
    );
    await awaitOwner();
    await expandP;
    await tick(2);

    // 6. CRUX — no regression + newer wins: cursor = 105 (forward, NOT regressed
    //    to 100); c1 carries the NEWER expand data (older coherent "d-c1" did NOT
    //    clobber it). base (coherent-only) also landed.
    expect(store.state.cursor).toBe(105);
    expect(store.state.sessions.c1?.title).toBe("expand-c1-new");
    expect(store.state.sessions.base?.title).toBe("d-base");
    expect(stream.isTreeSnapshotDecoding()).toBe(false);
  });

  it("reverse ordering (coherent capture settles BEFORE the expand fetch resolves) stays benign", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // 1. Open + COMPLETE the coherent capture FIRST (seq 100). No pending owner
    //    when the expand fires → the F4 guard takes the fast path (apply sync).
    treeES.fire("tree.snapshot", treeSnapBody(100, "e1", ["base", "c1"]), "100");
    treeES.fire("snapshot", detailSnap(100, "e1", ["base", "c1"]), "100");
    treeES.fire(
      "snapshot.complete",
      { epoch: "e1", revision: 100, projections: ["tree", "detail"] },
      "100",
    );
    await awaitOwner();
    await tick(2);
    expect(stream.isTreeSnapshotDecoding()).toBe(false);

    // 2. Re-stub fetch: expand detail at newer seq 105.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (typeof url === "string" && url.startsWith("/vh/tree/children")) {
          return new Response(
            JSON.stringify(
              childrenBodyWithDetail(
                "base",
                ["c1"],
                expandDetailBundle(105, ["c1"], [{ id: "c1", title: "expand-c1-new" }]),
              ),
            ),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response("{}", { status: 200 });
      }),
    );

    // 3. Fire expandTreeNode — no pending owner → apply runs synchronously.
    await stream.expandTreeNode("base");
    await tick(2);

    // 4. Benign: cursor advanced forward to 105; newer expand data won. No
    //    regression, no clobber (the coherent was already settled).
    expect(store.state.cursor).toBe(105);
    expect(store.state.sessions.c1?.title).toBe("expand-c1-new");
  });
});
