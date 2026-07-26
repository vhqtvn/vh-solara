// @vitest-environment jsdom
//
// C4 — O1-R1: the FE coherent-snapshot staging barrier (generation-owned
// PendingCaptureOwner). The server emits tree.snapshot + detail `snapshot` +
// snapshot.complete from ONE coherent capture identified by {epoch, seq} (Q5).
// C4 makes that truthful boundary enforceable on the FE: a capture becomes
// authoritative only when its matching detail snapshot, decoded tree snapshot,
// and snapshot.complete boundary are ALL present; the FE installs BOTH
// projections atomically (one Solid batch) before releasing newer live events.
//
// This file holds the 13-case acceptance suite. Case 12 (heterogeneous release
// burst) is the decisive pre-production fixture and was written FIRST as the
// red test driving the implementation.
//
// MockEventSource + real-timer gzip64 decode mirror treeStreamCompression.test.
// Node 18+ ships DecompressionStream + atob as globals (undici), so the REAL
// decode path runs here — no mock — exactly like snapshotDecode.test.ts.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { gzipSync } from "node:zlib";

// ---------------------------------------------------------------------------
// Mock EventSource — same shape as treeStreamCompression.test.ts. The tree
// stream URL has sessions=& (empty); supports lastEventId for cursor seqs (F4).
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

// Pump macro+microtasks. Real timers (NOT fake) — DecompressionStream's
// internal reader.read chain is a real async source whose cadence varies.
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

// ---------------------------------------------------------------------------
// Fixture builders.
// ---------------------------------------------------------------------------

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

// A tree.snapshot body (Q5: carries epoch + seq).
function treeSnapBody(seq: number, epoch: string, ids: string[]): any {
  return {
    tree: "2",
    epoch,
    seq,
    nodes: ids.map((id) => node(id)),
  };
}

// A detail `snapshot` body (Snapshot type; ships RAW in tree=2).
function detailSnap(seq: number, epoch: string, ids: string[]): any {
  return {
    seq,
    epoch,
    sessions: ids.map((id) => ({ id, title: `d-${id}` })),
  };
}

// ===========================================================================
// Case 12 — heterogeneous release burst (THE decisive pre-production fixture).
//
// Hold one barrier (owner pending via tree.snapshot gzip64 decode); dispatch
// 10+ MIXED covered events (multiple handler classes, NOT 10 of one) in a
// known order; fire detail + completion; install + release; prove the live
// tail applies in arrival order with no stale-baseline overwrite.
// ===========================================================================
describe("C4 coherent barrier — Case 12: heterogeneous release burst", () => {
  it("defers a mixed live-event burst until after coherent install; applies in arrival order; no baseline clobber", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // --- Atomicity observer: record every [authoritativeReady, treeCount,
    // sessionCount] tuple Solid flushes. The C4 invariant (Case 1) is that NO
    // observed tuple has authoritativeReady===true while either projection is
    // empty — readiness is truthful. Under the prior code, readiness flipped at
    // snapshot.complete BEFORE the tree decode seeded treeMap, so this would
    // capture (true, 0, 2) — a mixed pair an observer could see. ---
    const { createRoot, createEffect } = await import("solid-js");
    const tuples: Array<[boolean, number, number]> = [];
    const stopObs = createRoot((dispose) => {
      createEffect(() => {
        const auth = store.state.authoritativeReady;
        const treeCount = treeState.treeMap().size;
        const sessCount = Object.keys(store.state.sessions).length;
        tuples.push([auth, treeCount, sessCount]);
      });
      return dispose;
    });

    // --- 1. BASELINE tree.snapshot (gzip64). Owner created BEFORE decode
    // yields; the decode IIFE suspends at DecompressionStream await. ---
    const baseTree = treeSnapBody(100, "e1", ["base1", "base2"]);
    treeES.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest(baseTree),
    }), "100");

    // --- 2. SYNCHRONOUSLY dispatch 10 MIXED covered events (increasing seqs).
    // Every covered handler captures the owner ref and awaits it; the owner is
    // still pending (decode not flushed), so each continuation defers. ---
    // (a) tree.op — node.upsert adds a live tree node (structural, cursor-bearing)
    treeES.fire("tree.op", { op: "node.upsert", data: { node: node("liveNode") } }, "101");
    // (b) session.upsert — adds a live detail session
    treeES.fire("session.upsert", { id: "liveSess", title: "live" }, "102");
    // (c) activity — sets a live activity facet (busy, NOT idle → skips the
    // cross-stream completion bridge)
    treeES.fire("activity", { sessionID: "liveSess", state: "busy" }, "103");
    // (d) activity.verb — Tier-A rich-activity facet
    treeES.fire("activity.verb", { sessionID: "liveSess", tool: "Read", state: "x.go" }, "104");
    // (e) lastAgent.set — cross-projection bridge (detail + tree node agent)
    treeES.fire("lastAgent.set", { sessionID: "liveSess", agent: "agentX" }, "105");
    // (f) permission.upsert
    treeES.fire("permission.upsert", { sessionID: "liveSess", id: "perm1", tool: "Bash" }, "106");
    // (g) question.upsert
    treeES.fire("question.upsert", { sessionID: "liveSess", id: "q1", text: "ok?" }, "107");
    // (h) unread.set
    treeES.fire("unread.set", { sessionID: "liveSess" }, "108");
    // (i) permission.delete — observable: removes perm1 (order-dependent)
    treeES.fire("permission.delete", { sessionID: "liveSess", permissionID: "perm1" }, "109");
    // (j) status (cursor-bearing, error path is a no-op without payload.error)
    treeES.fire("status", { sessionID: "liveSess" }, "110");
    // (k) final session.upsert — highest seq, wins the cursor
    treeES.fire("session.upsert", { id: "liveLast", title: "last" }, "111");

    // --- 3. DETAIL `snapshot` (RAW synchronous) + snapshot.complete. Both
    // stage into the pending owner (identity {e1, 100}). Neither can install
    // alone (tree decode still in flight → stagedTree null). ---
    treeES.fire("snapshot", detailSnap(100, "e1", ["base1", "base2"]), "100");
    treeES.fire(
      "snapshot.complete",
      { epoch: "e1", revision: 100, projections: ["tree", "detail"] },
      "100",
    );

    // --- 4. Flush: tree decode completes → stage tree → tryInstall sees all
    // three staged + identity valid → ATOMIC install (batch) → detach + settle
    // → deferred live handlers resume in arrival order, each rechecking gen
    // and running reducer + cursor synchronously. ---
    await awaitOwner();
    await tick(2);

    // --- 5a. Atomic observability: BOTH projections installed. Baseline tree
    // nodes seeded (tree projection), baseline detail sessions present (detail
    // projection), authoritativeReady flipped AFTER both. ---
    expect(store.state.authoritativeReady).toBe(true);
    const tm = treeState.treeMap();
    expect(tm.get("base1")).toBeTruthy();
    expect(tm.get("base2")).toBeTruthy();
    expect(Object.keys(store.state.sessions).sort()).toEqual(
      ["base1", "base2", "liveLast", "liveSess"],
    );

    // --- 5b. No stale-baseline overwrite: live tail all applied AFTER install.
    // (cursor monotonicity — the crux) The baseline installs at cursor=100; the
    // deferred burst then advances 101..111 in order. Final cursor === 111. If
    // the barrier had failed (live applied during staging, then install's
    // applySnapshot regressed cursor to 100), cursor would be 100. ---
    expect(store.state.cursor).toBe(111);

    // --- 5c. Each live reducer applied (heterogeneous coverage). ---
    // (b) session.upsert liveSess + (k) liveLast
    expect(store.state.sessions.liveSess).toEqual({ id: "liveSess", title: "live" });
    expect(store.state.sessions.liveLast).toEqual({ id: "liveLast", title: "last" });
    // (c) activity busy
    expect(store.state.activity.liveSess).toBe("busy");
    // (d) activity.verb
    expect(store.state.currentVerbs.liveSess).toEqual({ tool: "Read", state: "x.go" });
    // (e) lastAgent.set + tree-node bridge
    expect(store.state.lastAgents.liveSess).toBe("agentX");
    // (f)+(i) permission upsert then delete — perm1 absent (order proven:
    // delete applied after upsert)
    expect(store.state.permissions.liveSess).toEqual({});
    // (g) question
    expect(store.state.questions.liveSess?.q1).toBeTruthy();
    // (h) unread
    expect(store.state.unread.liveSess).toBe(true);
    // (a) tree.op node.upsert — live node present (not clobbered by seed)
    expect(tm.get("liveNode")).toBeTruthy();

    // --- 5d. Baseline detail sessions survived (live tail did NOT clobber the
    // baseline wholesale replace). ---
    expect(store.state.sessions.base1).toEqual({ id: "base1", title: "d-base1" });
    expect(store.state.sessions.base2).toEqual({ id: "base2", title: "d-base2" });

    // --- 5e. Atomic observability (Case 1, folded into the decisive fixture):
    // at NO observed point was authoritativeReady true while either projection
    // was empty. The prior code flipped readiness at snapshot.complete before
    // the tree decode seeded treeMap → would have captured (true, 0, *). ---
    const mixedReady = tuples.filter(
      ([auth, treeCount, sessCount]) => auth && (treeCount === 0 || sessCount === 0),
    );
    expect(mixedReady).toEqual([]);
    // And readiness WAS reached (not stuck false).
    expect(tuples.some(([auth, treeCount, sessCount]) => auth && treeCount > 0 && sessCount > 0)).toBe(true);

    stopObs();
  });
});

// Helper: fire a RAW (synchronous) coherent capture — owner installs atomically
// when completion arrives (no async decode). Used by cases that don't need to
// hold the decode window.
function fireCoherentRaw(
  es: MockEventSource,
  epoch: string,
  seq: number,
  treeIds: string[] = ["s1", "s2"],
  detailIds?: string[],
): void {
  es.fire(
    "tree.snapshot",
    { tree: "2", epoch, seq, nodes: treeIds.map((id) => node(id)) },
    String(seq),
  );
  es.fire(
    "snapshot",
    { seq, epoch, sessions: (detailIds ?? treeIds).map((id) => ({ id, title: `d-${id}` })) },
    String(seq),
  );
  es.fire(
    "snapshot.complete",
    { epoch, revision: seq, projections: ["tree", "detail"] },
    String(seq),
  );
}

// ===========================================================================
// Case 1 — atomic observability (dedicated; the observer is also folded into
// Case 12). No Solid observer ever sees a mixed old/new projection pair, and
// authoritativeReady is true ONLY with both projections installed.
// ===========================================================================
describe("C4 coherent barrier — Case 1: atomic observability", () => {
  it("never shows authoritativeReady true with only one projection; both land in one flush", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    const { createRoot, createEffect } = await import("solid-js");
    const tuples: Array<[boolean, number, number]> = [];
    const stop = createRoot((dispose) => {
      createEffect(() => {
        tuples.push([
          store.state.authoritativeReady,
          treeState.treeMap().size,
          Object.keys(store.state.sessions).length,
        ]);
      });
      return dispose;
    });

    // Coherent gzip64 capture; the decode window holds, so detail + completion
    // stage without installing.
    treeES.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest(treeSnapBody(50, "e1", ["a", "b"])),
    }), "50");
    treeES.fire("snapshot", detailSnap(50, "e1", ["a", "b"]), "50");
    treeES.fire("snapshot.complete", { epoch: "e1", revision: 50, projections: ["tree", "detail"] }, "50");

    await awaitOwner();
    await tick();

    // No observed tuple had readiness without BOTH projections populated.
    expect(tuples.filter(([a, t, s]) => a && (t === 0 || s === 0))).toEqual([]);
    expect(store.state.authoritativeReady).toBe(true);
    stop();
  });
});

// ===========================================================================
// Case 2 — completion before decode. completion + detail arrive while the tree
// decode is held; no install/release until the decode + identity validation
// finish.
// ===========================================================================
describe("C4 coherent barrier — Case 2: completion before decode", () => {
  it("does not install while the tree decode is in flight; installs after decode + identity", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // tree.snapshot gzip64 — owner created, decode suspended.
    treeES.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest(treeSnapBody(30, "e1", ["x"])),
    }), "30");

    // While the decode is held, deliver BOTH the detail and the completion.
    // They stage; install MUST NOT fire (stagedTree still null).
    treeES.fire("snapshot", detailSnap(30, "e1", ["x"]), "30");
    treeES.fire("snapshot.complete", { epoch: "e1", revision: 30, projections: ["tree", "detail"] }, "30");
    // No microtask has flushed — decode still in flight.
    expect(store.state.authoritativeReady).toBe(false);
    expect(treeState.treeMap().size).toBe(0);

    // Now flush the decode → stage tree → tryInstall sees all three → install.
    await awaitOwner();
    expect(store.state.authoritativeReady).toBe(true);
    expect(treeState.treeMap().get("x")).toBeTruthy();
  });
});

// ===========================================================================
// Case 3 — live-tail preservation. A live mutation dispatched during staging
// applies AFTER the baseline install, not erased by the wholesale replace.
// ===========================================================================
describe("C4 coherent barrier — Case 3: live-tail preservation", () => {
  it("a session.upsert during staging survives the baseline wholesale-replace", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    treeES.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest(treeSnapBody(20, "e1", ["base"])),
    }), "20");
    // Live session.upsert dispatched while the owner is pending → deferred.
    treeES.fire("session.upsert", { id: "live", title: "L" }, "21");
    treeES.fire("snapshot", detailSnap(20, "e1", ["base"]), "20");
    treeES.fire("snapshot.complete", { epoch: "e1", revision: 20, projections: ["tree", "detail"] }, "20");

    await awaitOwner();
    await tick();

    // Both baseline AND live survived (live NOT erased by the detail's
    // wholesale-replace, because the live event applied AFTER install).
    expect(Object.keys(store.state.sessions).sort()).toEqual(["base", "live"]);
    expect(store.state.sessions.live).toEqual({ id: "live", title: "L" });
  });
});

// ===========================================================================
// Case 4 — cursor monotonicity. The baseline cursor installs first; deferred
// cursor-bearing events advance in order; the cursor never regresses to the
// baseline seq.
// ===========================================================================
describe("C4 coherent barrier — Case 4: cursor monotonicity", () => {
  it("baseline cursor installs first; deferred live events advance past it in order", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    treeES.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest(treeSnapBody(100, "e1", ["a"])),
    }), "100");
    // Three cursor-bearing events, ascending seqs, dispatched during staging.
    treeES.fire("session.upsert", { id: "n1" }, "101");
    treeES.fire("session.upsert", { id: "n2" }, "102");
    treeES.fire("session.upsert", { id: "n3" }, "103");
    treeES.fire("snapshot", detailSnap(100, "e1", ["a"]), "100");
    treeES.fire("snapshot.complete", { epoch: "e1", revision: 100, projections: ["tree", "detail"] }, "100");

    await awaitOwner();
    await tick();

    // Baseline installed at cursor=100; the deferred events advanced 101→102→103.
    // Final cursor === 103 (the last). If the baseline had regressed it, the
    // cursor would be 100.
    expect(store.state.cursor).toBe(103);
  });
});

// ===========================================================================
// Case 5 — identity mismatch. Mismatched epoch/seq across projections cannot
// install or mark readiness.
// ===========================================================================
describe("C4 coherent barrier — Case 5: identity mismatch", () => {
  it("mismatched epoch between tree and detail prevents install", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    treeES.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest(treeSnapBody(5, "epochA", ["a"])),
    }), "5");
    // detail carries a DIFFERENT epoch → identity mismatch on bind.
    treeES.fire("snapshot", detailSnap(5, "epochB", ["a"]), "5");
    treeES.fire("snapshot.complete", { epoch: "epochA", revision: 5, projections: ["tree", "detail"] }, "5");

    await awaitOwner();
    await tick();
    // No coherent install (the detail's mismatched epoch rejected the stage);
    // readiness stays false.
    expect(store.state.authoritativeReady).toBe(false);
  });

  it("mismatched seq (revision) between completion and projections prevents install", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    treeES.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest(treeSnapBody(5, "e1", ["a"])),
    }), "5");
    treeES.fire("snapshot", detailSnap(5, "e1", ["a"]), "5");
    // completion carries revision=99 (mismatched seq).
    treeES.fire("snapshot.complete", { epoch: "e1", revision: 99, projections: ["tree", "detail"] }, "99");

    await awaitOwner();
    await tick();
    expect(store.state.authoritativeReady).toBe(false);
  });

  // B-F1/B-F2 regression: a mismatch that fires markOwnerLegacy WHILE a tree
  // gzip64 decode is still in flight must NOT release covered tree ops into the
  // decode window — otherwise the late seedTreeStore (wholesale treeMap replace)
  // clobbers the op, and the already-advanced cursor means it is never replayed
  // (silent data loss). The owner's release is CHAINED behind the in-flight
  // decode (releaseOwner waitForTree), so a covered handler that captured
  // owner.promise BEFORE the mismatch resumes only AFTER finishDecode's tree
  // apply landed. This fires the op PRE-mismatch (the harder, pre-settle window
  // the first fix missed) and proves the op survives + cursor stays monotonic.
  it("pre-settle tree.op + session.upsert captured before a mismatch are not clobbered by the late seed", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // 1. tree.snapshot gzip64 (epoch A, seq 10) — owner created, decode HELD,
    //    owner.pendingTreeDecode set.
    treeES.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest(treeSnapBody(10, "A", ["base"])),
    }), "10");

    // 2. detail with a DIFFERENT epoch (B) → binds owner identity {B, 10}.
    treeES.fire("snapshot", detailSnap(10, "B", ["base"]), "10");

    // 3. PRE-MISMATCH: covered handlers capture owner.promise and suspend BEFORE
    //    the mismatch fires. Without the chained release these would resume on
    //    settle (gen unchanged) and apply ahead of the late seedTreeStore.
    treeES.fire("tree.op", { op: "node.upsert", data: { node: node("liveNode") } }, "11");
    treeES.fire("session.upsert", { id: "liveSess", title: "L" }, "12");

    // 4. completion with epoch A → mismatches the bound {B, 10} → markOwnerLegacy
    //    defers the owner release behind pendingTreeDecode (still in flight).
    treeES.fire("snapshot.complete", { epoch: "A", revision: 10, projections: ["tree", "detail"] }, "10");

    // 5. Flush the decode → finishDecode (owner.legacy) → applyTreeIndependent
    //    seeds "base" → the deferred release fires AFTER → covered handlers
    //    resume and apply their reducers on TOP of the seeded tree/detail.
    await awaitOwner();
    await tick();

    // The tree.op's node + the session.upsert's session SURVIVED (not clobbered
    // by the late seedTreeStore / applySnapshot wholesale replace). Baseline
    // also landed. Cursor monotonic at 12 (last live seq; not regressed by the
    // seed at 10). Readiness stays false (legacy — no coherent install).
    expect(treeState.treeMap().get("liveNode")).toBeTruthy();
    expect(treeState.treeMap().get("base")).toBeTruthy();
    expect(store.state.sessions.liveSess).toEqual({ id: "liveSess", title: "L" });
    expect(store.state.sessions.base).toBeTruthy();
    expect(store.state.cursor).toBe(12);
    expect(store.state.authoritativeReady).toBe(false);
  });
});

// ===========================================================================
// Case 6 — generation supersession. Reconnect cancels the old owner, releases
// waiters to fail their gen checks, and prevents a stale decode from clearing a
// newer owner.
// ===========================================================================
describe("C4 coherent barrier — Case 6: generation supersession", () => {
  it("a stale decode from a superseded connection does not install or clobber the fresh capture", async () => {
    stream.connect();
    const oldES = treeESes()[0];
    oldES.simulateOpen();

    // OLD connection: fire gzip64 tree.snapshot — owner A (gen 1) decode starts.
    oldES.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest(treeSnapBody(10, "old", ["stale"])),
    }), "10");

    // REPLACE the connection BEFORE A's decode finishes → gen bump → A canceled.
    stream.connect(true);
    const newES = treeESes().filter((e) => e.readyState !== CLOSED)[0];
    expect(newES).not.toBe(oldES);
    newES.simulateOpen();

    // NEW connection: drive a fresh coherent capture.
    fireCoherentRaw(newES, "fresh", 20, ["f1", "f2"]);

    // Let A's stale decode complete naturally. A's gen check fails → no install.
    await tick(3);

    expect(store.state.authoritativeReady).toBe(true);
    // The stale tree NEVER landed.
    expect(treeState.treeMap().get("stale")).toBeUndefined();
    // The fresh coherent tree DID land.
    expect(treeState.treeMap().get("f1")).toBeTruthy();
  });
});

// ===========================================================================
// Case 7 — legacy compatibility. A tree projection WITHOUT a valid epoch (a
// pre-Q5 daemon) takes the independent path: tree + detail apply independently,
// no indefinite wait, authoritativeReady stays false.
// ===========================================================================
describe("C4 coherent barrier — Case 7: legacy compatibility (pre-Q5 tree)", () => {
  it("tree without epoch → independent application, authoritativeReady stays false", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // tree.snapshot with NO epoch (pre-Q5). gzip64 to exercise the decode path.
    const legacyBody = { tree: "2", seq: 8, nodes: [node("a"), node("b")] };
    treeES.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest(legacyBody),
    }), "8");
    // Detail arrives (with an epoch, but the tree is legacy → no correlation).
    treeES.fire("snapshot", detailSnap(8, "someEpoch", ["a", "b"]), "8");

    await awaitOwner();
    await tick();

    // Tree applied independently (legacy path).
    expect(treeState.treeMap().get("a")).toBeTruthy();
    expect(treeState.treeMap().get("b")).toBeTruthy();
    // Detail applied independently.
    expect(Object.keys(store.state.sessions).sort()).toEqual(["a", "b"]);
    // Readiness stays false (no coherent install; pre-Q5 daemons never emit
    // snapshot.complete, and even if they did, the tree lacks the epoch to
    // correlate).
    expect(store.state.authoritativeReady).toBe(false);
    // No owner is left pending (would otherwise wedge behind a never-coming
    // completion — the no-timeout invariant).
    expect(stream.isTreeSnapshotDecoding()).toBe(false);
  });
});

// ===========================================================================
// Case 8 — busy reconciliation. expectTreeSnap does NOT clear after only the
// tree projection; it clears only after the coherent install (where the
// authoritative baseline actually landed).
// ===========================================================================
describe("C4 coherent barrier — Case 8: busy reconciliation", () => {
  it("expectTreeSnap clears only after the coherent install, not after the tree alone", async () => {
    // No session selected → reconcileBusy requests ONLY the tree refresh
    // (expectSessionSnap stays false), isolating the tree-side handshake.
    store.setSelectedIdRaw(null);
    const { withGlobalBusy, globalBusy } = await import("../../src/busy");

    // Fake timers: reconcileBusy's 15s safety timeout is a faked setTimeout
    // that must NOT fire for a prompt reconcile (mirrors reconcileBusy.test.ts).
    vi.useFakeTimers();

    stream.connect();
    treeESes()[0].simulateOpen();

    // Release a global busy scope → reconcileBusy sets expectTreeSnap + calls
    // connect(true) (recreating the tree ES).
    const op = withGlobalBusy(async () => {});
    await vi.advanceTimersByTimeAsync(0); // let reconcileBusy run + connect(true)

    // The fresh tree ES recreated by reconcileBusy's connect(true).
    const freshES = treeESes()[0];
    freshES.simulateOpen();

    // Deliver ONLY the tree projection (RAW — synchronous; avoids the
    // fake-timer+DecompressionStream hang). The coherent install has NOT
    // happened (detail + completion missing) → expectTreeSnap must STILL be
    // true → the reconcile promise must NOT resolve yet → global busy held.
    freshES.fire(
      "tree.snapshot",
      { tree: "2", epoch: "e1", seq: 40, nodes: [node("a")] },
      "40",
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(globalBusy()).toBe(true); // reconcile still in flight (tree alone)

    // Now complete the coherent capture → install → expectTreeSnap cleared →
    // reconcile resolves → global busy releases — WITHOUT advancing the 15s
    // safety timer.
    freshES.fire("snapshot", detailSnap(40, "e1", ["a"]), "40");
    freshES.fire("snapshot.complete", { epoch: "e1", revision: 40, projections: ["tree", "detail"] }, "40");
    await vi.advanceTimersByTimeAsync(0);

    await op;
    expect(globalBusy()).toBe(false);
    vi.useRealTimers();
  });
});

// ===========================================================================
// Case 9 — periodic-diff ordering. resolvePeriodicDiff observes the newly
// seeded coherent tree (runs inside the install batch AFTER seedTreeStore),
// not a mixed pair.
// ===========================================================================
describe("C4 coherent barrier — Case 9: periodic-diff ordering (resolvePeriodicDiff after seed)", () => {
  it("a coherent install resolves the pending periodic diff against the seeded tree (no-op when matched)", async () => {
    vi.useFakeTimers();
    // Pin Math.random so the jittered periodic schedule is deterministic
    // (factor 0.5 → (0.5*2-1)=0 → delay == interval exactly), mirroring
    // periodicResync.test.ts's pinJitterZero.
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    stream.connect();
    const es0 = treeESes()[0];
    es0.simulateOpen();
    stream._markTreeSeenForTest();
    stream._setLastAuthoritativeRecoveryForTest(0);
    // Pre-resync resident state: a single idle node "a".
    treeState.seedTreeStore([node("a")]);
    stream.startPeriodicResync();

    // Advance to the periodic tick (INTERVAL-1 then +2 so the scheduled timer
    // fires deterministically).
    vi.advanceTimersByTime(stream.TREE_RESYNC_PERIODIC_INTERVAL_MS - 1);
    stream._markTreeSeenForTest();
    await vi.advanceTimersByTimeAsync(2);

    // The periodic tick ran resyncTree → connect(true), creating a fresh tree
    // ES whose first coherent capture's install will resolve the diff.
    const fresh = treeESes()[treeESes().length - 1];
    fresh.simulateOpen();

    // Drive a Q5 coherent capture with the SAME state (node "a") → the periodic
    // diff resolves as a no-op INSIDE the install batch (after seedTreeStore).
    fireCoherentRaw(fresh, "e1", 10, ["a"]);
    stream._markTreeSeenForTest();
    await vi.advanceTimersByTimeAsync(0);

    const stats = stream._getPeriodicResyncStatsForTest();
    expect(stats.noOps).toBe(1);
    expect(stats.diffsFound).toBe(0);
    vi.useRealTimers();
  });
});

// ===========================================================================
// Case 10 — cross-projection bridge. A deferred lastAgent.set applies after
// install, updating BOTH the detail map AND the synchronous tree-node bridge
// (not overwritten by the seed).
// ===========================================================================
describe("C4 coherent barrier — Case 10: cross-projection bridge (lastAgent.set)", () => {
  it("deferred lastAgent.set patches the tree node AFTER the coherent seed", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    treeES.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest(treeSnapBody(60, "e1", ["s1"])),
    }), "60");
    // lastAgent.set during staging → deferred. It patches BOTH detail
    // (state.lastAgents) AND the tree node (patchTreeAgent).
    treeES.fire("lastAgent.set", { sessionID: "s1", agent: "agentZ" }, "61");
    treeES.fire("snapshot", detailSnap(60, "e1", ["s1"]), "60");
    treeES.fire("snapshot.complete", { epoch: "e1", revision: 60, projections: ["tree", "detail"] }, "60");

    await awaitOwner();
    await tick();

    // Detail bridge.
    expect(store.state.lastAgents.s1).toBe("agentZ");
    // Tree-node bridge: the deferred patch applied AFTER seedTreeStore, so the
    // node carries the agent (not wiped by the seed).
    expect(treeState.treeMap().get("s1")?.agent).toBe("agentZ");
  });
});

// ===========================================================================
// Case 11 — no-barrier fast path. notice / ping / pins remain UNBLOCKED while a
// capture is pending (they are demonstrably outside the barrier).
// ===========================================================================
describe("C4 coherent barrier — Case 11: no-barrier fast path", () => {
  it("notice / ping / pins apply while a capture is pending", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // Hold a coherent barrier.
    treeES.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest(treeSnapBody(70, "e1", ["a"])),
    }), "70");

    // pin / notice / ping carry no cursor and are disjoint from tree/detail
    // state. They MUST apply synchronously WITHOUT awaiting the owner.
    const alerts = await import("../../src/alerts");
    const spy = vi.spyOn(alerts, "handleNotice").mockImplementation(() => undefined);
    treeES.fire("notice", { title: "n", body: "b" });
    // pins.snapshot routes to the sidebar facade; assert no throw + the barrier
    // is still pending (these frames did not need to await it).
    treeES.fire("pins.snapshot", { sessions: [] });
    treeES.fire("pins.updated", { sessionID: "x", pinned: true });
    treeES.fire("ping", null);
    expect(spy).toHaveBeenCalled();
    // The barrier is still pending (no install yet) — fast-path frames did not
    // block on it.
    expect(stream.isTreeSnapshotDecoding()).toBe(true);

    // Restore + complete the capture so afterEach is clean.
    spy.mockRestore();
    treeES.fire("snapshot", detailSnap(70, "e1", ["a"]), "70");
    treeES.fire("snapshot.complete", { epoch: "e1", revision: 70, projections: ["tree", "detail"] }, "70");
    await awaitOwner();
  });
});

// ===========================================================================
// Case 13 — overlapping capture. While A's decode is held, introduce identity B
// (a same-generation second capture). The policy: resync, NOT in-band replace.
// A never installs/clears B; the generation advances and a fresh coherent
// capture is obtained.
// ===========================================================================
describe("C4 coherent barrier — Case 13: overlapping capture → resync", () => {
  it("a same-gen second tree.snapshot cancels A without install + forces a resync", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // Owner A: gzip64 tree.snapshot, decode held.
    treeES.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest(treeSnapBody(10, "A", ["a1"])),
    }), "10");

    const genBefore = stream.getTreeSnapshotDecode(); // capture A's owner promise
    // A's completion + detail stage into A (still no install — tree pending).
    treeES.fire("snapshot", detailSnap(10, "A", ["a1"]), "10");
    treeES.fire("snapshot.complete", { epoch: "A", revision: 10, projections: ["tree", "detail"] }, "10");

    // Fire a SECOND same-gen tree.snapshot (identity B) while A is pending → the
    // overlap policy cancels A without install and calls connect(true).
    treeES.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest(treeSnapBody(20, "B", ["b1"])),
    }), "20");

    // A's owner settled (canceled) — its waiter resumed.
    await genBefore;
    // A NEVER installed (readiness still false; A's tree never seeded).
    expect(store.state.authoritativeReady).toBe(false);
    expect(treeState.treeMap().get("a1")).toBeUndefined();

    // connect(true) created a fresh ES. Land a coherent capture on it.
    await tick(2);
    const freshES = treeESes().filter((e) => e.readyState !== CLOSED)[0];
    expect(freshES).not.toBe(treeES);
    freshES.simulateOpen();
    fireCoherentRaw(freshES, "C", 30, ["c1"]);

    expect(store.state.authoritativeReady).toBe(true);
    expect(treeState.treeMap().get("c1")).toBeTruthy();
  });
});

// ===========================================================================
// C-F1 regression — coveredAwait must NOT split same-gen waiters across resume
// lanes when the owner is legacy-but-unsettled (post-mismatch, pre-seed). A
// covered handler captured owner.promise PRE-mismatch; a handler arriving
// POST-mismatch must NOT be rerouted to treeSnapshotDecode (a different promise
// object → FIFO violation → cursor regression). Both must await the SAME
// owner.promise. The B-F1 regression (Case 5's third `it`) captures BOTH
// handlers pre-mismatch; this test fires B post-mismatch — the uncovered
// increment.
// ===========================================================================
describe("C4 — C-F1: coveredAwait keeps same-gen waiters on one resume lane", () => {
  it("a covered handler arriving after a mismatch resumes AFTER pre-mismatch handlers (no cursor regression)", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // 1. tree.snapshot gzip64 (epoch A, seq 10) — owner created, decode HELD,
    //    pendingTreeDecode = treeSnapshotDecode = decodeP.
    treeES.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest(treeSnapBody(10, "A", ["base"])),
    }), "10");

    // 2. detail epoch B (seq 10) → BINDS owner identity {B, 10} (first binding;
    //    no mismatch yet). Stages detail without installing (tree pending).
    treeES.fire("snapshot", detailSnap(10, "B", ["base"]), "10");

    // 3. PRE-MISMATCH covered handler A (seq 11) → captures owner.promise
    //    (owner non-legacy at this instant).
    treeES.fire("session.upsert", { id: "race", title: "A-first" }, "11");

    // 4. completion epoch A (revision 10) → mismatches bound {B, 10} →
    //    markOwnerLegacy: legacy=true, stagedDetail flushed independently
    //    (sessions={base}, cursor=10), release CHAINED behind decodeP (still
    //    in flight via releaseOwner(owner, true)).
    treeES.fire("snapshot.complete", { epoch: "A", revision: 10, projections: ["tree", "detail"] }, "10");

    // 5. POST-MISMATCH covered handler B (seq 12, HIGHER than A). Without the
    //    fix, coveredAwait sees owner.legacy and falls to treeSnapshotDecode
    //    (decodeP) — a different promise than A is awaiting → resume-lane
    //    split. With the fix, coveredAwait returns owner.promise for the
    //    legacy-but-unsettled owner → B shares A's resume lane.
    treeES.fire("session.upsert", { id: "race", title: "B-second" }, "12");

    // 6. Flush the decode → finishDecode (legacy branch) seeds "base" → the
    //    chained release fires → both waiters resume.
    await awaitOwner();
    await tick(2);

    // Decisive assertion. Without the fix: decodeP's .then queue runs
    // finish (→ settles owner.promise → schedules A) then B's continuation,
    // so B resumes before A → reducer order B(12) then A(11) → cursor
    // regresses to 11. With the fix: both A and B await owner.promise and
    // resume FIFO (A then B) → cursor monotonic at 12.
    expect(store.state.cursor).toBe(12);
    // Corroborating ordering witness: the LATER live event's title wins.
    expect(store.state.sessions.race).toEqual({ id: "race", title: "B-second" });
    // Legacy path: no coherent install (readiness stays false).
    expect(store.state.authoritativeReady).toBe(false);
    // Baseline survived the seed (markOwnerLegacy's independent detail flush
    // landed `base`; the late tree seed did not clobber the detail map).
    expect(store.state.sessions.base).toBeTruthy();
  });
});

// ===========================================================================
// C-F2 regression — onerror CLOSED must bump treeGen BEFORE canceling the
// pending owner so a suspended covered waiter FAILS its post-await gen check
// instead of applying a live reducer on the dead transport's pre-capture
// baseline. The live event is then replayed once on the fresh baseline after
// the deferred reconnect (the waiter returned before advanceCursor, so the
// cursor was not advanced).
// ===========================================================================
describe("C4 — C-F2: onerror CLOSED bumps gen before cancel", () => {
  it("a covered waiter suspended on the owner does NOT apply its reducer when the transport closes", async () => {
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();
    const cursorBefore = store.state.cursor;

    // 1. tree.snapshot gzip64 (epoch e1, seq 50) — owner pending, decode HELD.
    //    The covered handler below captures owner.promise and suspends.
    treeES.fire("tree.snapshot", JSON.stringify({
      encoding: "gzip64",
      data: encodeForTest(treeSnapBody(50, "e1", ["base"])),
    }), "50");

    // 2. Covered session.upsert (seq 51) → awaits owner.promise (decode held).
    treeES.fire("session.upsert", { id: "pendingLive", title: "L" }, "51");

    // 3. Transport gives up (CLOSED) BEFORE the decode flushes → onerror fires.
    //    Without the fix: cancelPendingOwner resolves owner.promise; the waiter
    //      resumes with treeGen unchanged → passes gen check → applies the
    //      reducer → sessions.pendingLive defined, cursor=51 (then the late
    //      decode's applyTreeIndependent regresses cursor to 50).
    //    With the fix: treeGen++ first → waiter's gen check fails → skip;
    //      sessions.pendingLive absent, cursor unchanged.
    (treeES as any).readyState = MockEventSource.CLOSED;
    (treeES as any).onerror?.();

    // Await the in-flight decode directly so the close-time invariant has
    // stabilized (the waiter's continuation has run; the decode's gen-check
    // early-return has run; the decode-gate flag has cleared). tick(2) then
    // flushes any trailing microtasks.
    await awaitOwner();
    await tick(2);

    // The waiter did NOT apply (failed the post-await gen check).
    expect(store.state.sessions.pendingLive).toBeUndefined();
    expect(store.state.cursor).toBe(cursorBefore);
    // The owner was canceled (not left wedged) and the decode gate cleared.
    expect(stream.isTreeSnapshotDecoding()).toBe(false);
  });
});
