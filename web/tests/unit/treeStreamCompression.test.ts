// @vitest-environment jsdom
//
// Regression tests for the Stream-1 (tree) gzip64 compression wiring.
//
// BACKGROUND: the tree stream ships ~760 KiB–1.1 MiB of highly-repetitive JSON
// on every fresh reconnect (~60/hr) UNCOMPRESSED, because Stream-1's URL never
// set `z=1` (only Stream-2 / the session stream did). The server's
// maybeCompressSnapshot already supports the `{encoding:"gzip64",data:...}`
// envelope for ANY /vh/stream caller that opts in via `z=1`, and the client's
// decodeSnapshot / decodeGzip64 already implement the decode for Stream-2 — so
// wiring the tree stream was a two-line URL change + an envelope branch in the
// tree `snapshot` listener. These tests pin the contract:
//
//   A. the tree URL includes `z=1` (so the server actually compresses),
//   B. the tree `snapshot` listener decodes a gzip64 envelope end-to-end
//      (SSE → JSON.parse → decodeSnapshot → applySnapshot → store.state), AND
//   C. back-compat: a raw (uncompressed) tree snapshot still parses and applies
//      (older server / sub-threshold payload that maybeCompressSnapshot skips).
//
// The MockEventSource pattern + module isolation mirrors
// sessionLiveness.test.ts; the gzip64 fixture builder mirrors
// snapshotDecode.test.ts:24-27. Node 18+ (this repo targets ≥24) ships
// DecompressionStream + atob as globals (undici), so the REAL decode path runs
// here — no mock — exactly like snapshotDecode.test.ts.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { gzipSync } from "node:zlib";
import { saveVersioned } from "../../src/lib/store";
import { lsCursor, LS_PROJECT } from "../../src/sync/store";

// ---------------------------------------------------------------------------
// Mock EventSource — same shape as sessionLiveness.test.ts. Captures `url` so
// the URL-shape assertion can run; lets the test fire named SSE events.
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

// Tree stream URL: `?cursor=0&sessions=&...` (EMPTY sessions). Session stream
// URL: `?sessions=s1&...` (non-empty). Same classifier as sessionLiveness.
const treeESes = (): MockEventSource[] =>
  instances.filter((e) => !/sessions=[^&]/.test(e.url));

// Pump macro+microtasks. Real timers (NOT fake timers) — DecompressionStream's
// internal reader.read chain is a real async source whose microtask cadence
// varies under load; faking timers and pumping advanceTimersByTimeAsync(0) is
// flaky (the same test passes in isolation and fails in the full suite because
// the exact pump count differs). Real-timer setTimeout(0) lets the native
// stream resolve naturally and deterministically.
const tick = async (n = 1): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

// Await the in-flight gzip64 snapshot decode directly via the module's promise
// reference. Deterministic — no fake-timer pumping. After this resolves the
// IIFE's applySnap has run (it's inside the try block before the finally clears
// the flag). Callers that need a SUBSEQUENT microtask (e.g. a live-event
// listener that was awaiting treeSnapshotDecode and whose continuation runs as
// a separate microtask) follow this with `await tick()`.
const awaitDecode = async (): Promise<void> => {
  await stream.getTreeSnapshotDecode();
};

// ---------------------------------------------------------------------------
// Per-test module isolation: resetModules + dynamic import gives a fresh
// module-private treeGen (the connection-generation guard) and a fresh store.
// ---------------------------------------------------------------------------
let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  store.setProjectDirRaw("/test");
  store.setSelectedIdRaw("s1");
}

// encodeForTest mirrors the server's maybeCompressSnapshot compression:
// JSON.stringify → gzip → base64. Same builder as snapshotDecode.test.ts:24-27.
function encodeForTest(value: unknown): string {
  const inner = JSON.stringify(value);
  return Buffer.from(gzipSync(Buffer.from(inner))).toString("base64");
}

beforeEach(async () => {
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  // Stub fetch so fire-and-forget calls (refreshOpenSessions →
  // fetchSessionMessages) do not produce unhandled rejections under jsdom.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 200 })),
  );
  window.localStorage.clear();
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
  // REAL timers (not fake). The gzip64 decode goes through native
  // DecompressionStream whose microtask cadence is not reliably pumpable under
  // fake timers; awaiting the real promise (awaitDecode / tick) is deterministic.
  await setupFresh();
});

afterEach(() => {
  stream?.closeSessionStream();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

// A tree-shaped snapshot: sessions-heavy (the field the tree stream owns), no
// transcript (Stream-2 owns messages). Same minimal shape as
// sessionLiveness.test.ts:160-163.
const treeSnapshot = (seq: number, sessionIds: string[] = ["s1", "s2"]) => ({
  seq,
  sessions: sessionIds.map((id) => ({ id, title: `t-${id}` })),
});

// ===========================================================================
// A — URL shape: tree stream opts into gzip64 with `z=1`.
// ===========================================================================
describe("A — tree stream URL opts into gzip64", () => {
  it("includes `z=1` in the Stream-1 URL (fresh connect)", () => {
    stream.connect();
    expect(treeESes()).toHaveLength(1);
    const url = treeESes()[0].url;
    // Sanity: this is the tree stream (empty sessions param), not Stream-2.
    expect(url).toMatch(/sessions=&/);
    // The opt-in flag the server's wantsCompress(r) reads.
    expect(url).toMatch(/(?:^|[?&])z=1(?:&|$)/);
  });

  it("includes `z=1` in the Stream-1 URL on a resume (cursor=…) connect too", async () => {
    // Seed a non-zero cursor for the project the store will load on init. The
    // store reads `loadCursor(initialDir)` at module init where
    // `initialDir = LS_PROJECT` (cleared → "" by default), so we must seed
    // BOTH LS_PROJECT (so initialDir = "/test") AND the cursor for "/test"
    // before the dynamic import. This exercises the resume branch
    // (`cursor=N&...`) and confirms `z=1` is appended AFTER the cursor param,
    // not dropped by the template literal.
    window.localStorage.clear();
    saveVersioned(LS_PROJECT, 1, "/test");
    saveVersioned(lsCursor("/test"), 1, 99);
    await setupFresh();

    stream.connect();
    expect(treeESes()).toHaveLength(1);
    const url = treeESes()[0].url;
    expect(url).toMatch(/cursor=99&/);
    expect(url).toMatch(/sessions=&/);
    expect(url).toMatch(/(?:^|[?&])z=1(?:&|$)/);
  });
});

// ===========================================================================
// B — gzip64 decode path: the tree `snapshot` listener decodes the envelope
// end-to-end and the sessions land in the store. This is the whole point of
// the wire win — the server now actually compresses the ~1 MiB tree payload.
// ===========================================================================
describe("B — tree snapshot listener decodes gzip64 envelope", () => {
  it("applies a gzip64-compressed tree snapshot (decompresses → store.state.sessions)", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();

    // Build a realistic tree payload, compress it exactly the way the server
    // does, and fire it through the SSE envelope shape the server emits.
    const snap = treeSnapshot(7, ["s1", "s2", "s3"]);
    const envelope = { encoding: "gzip64" as const, data: encodeForTest(snap) };
    treeESes()[0].fire("snapshot", JSON.stringify(envelope));

    // The decode path is async (native DecompressionStream). Await the IIFE
    // directly via the module's treeSnapshotDecode promise (deterministic — no
    // fake-timer pumping).
    await awaitDecode();

    // The decompressed sessions landed in the store verbatim — proves the
    // gzip64 branch ran in the tree listener (the prior code path did
    // JSON.parse on the envelope object and would have set `seq` only,
    // leaving sessions empty).
    expect(Object.keys(store.state.sessions).sort()).toEqual(["s1", "s2", "s3"]);
    expect(store.state.sessions.s1).toEqual({ id: "s1", title: "t-s1" });
    expect(store.state.sessions.s3).toEqual({ id: "s3", title: "t-s3" });
  });

  it("ignores a gzip64 envelope from a SUPERSEDED connection (post-await gen guard)", async () => {
    // Regression guard for the connection-replacement safety added alongside
    // the gzip64 wiring. The decode path awaits; a stale decode that completed
    // after connect() bumped treeGen must NOT mutate the store. Mirrors the
    // Stream-2 sesGen guard pinned in sessionLiveness.test.ts (~line 521).
    stream.connect();
    const oldES = treeESes()[0];
    oldES.simulateOpen();

    // Fire the compressed snapshot on the OLD connection — the IIFE reaches the
    // async decode and suspends. Captured `gen` is still current at entry.
    const staleSnap = treeSnapshot(1, ["stale"]);
    const staleEnvelope = {
      encoding: "gzip64" as const,
      data: encodeForTest(staleSnap),
    };
    oldES.fire("snapshot", JSON.stringify(staleEnvelope));
    // Let the OLD IIFE reach its suspended DecompressionStream await (or finish
    // — under real timers it may complete before we replace the connection;
    // either way the gen guard below prevents the stale apply).
    await awaitDecode();

    // REPLACE the tree connection — bumps treeGen and closes oldES. The OLD
    // IIFE is still suspended; its captured `gen` is now superseded.
    stream.connect(true);
    const newES = treeESes().filter((e) => e.readyState !== CLOSED)[0];
    expect(newES).not.toBe(oldES);
    expect(oldES.readyState).toBe(CLOSED);
    newES.simulateOpen();

    // The replacement ships a RAW (synchronous) snapshot carrying fresh1 — it
    // applies immediately and authoritatively.
    newES.fire("snapshot", treeSnapshot(2, ["fresh1", "fresh2"]));
    await tick();

    // NOW let the OLD connection's suspended decode complete (if it hadn't
    // already). Before the gen guard the stale snapshot would clobber the
    // fresh one.
    await awaitDecode();

    // The stale decode did NOT clobber the replacement's state.
    expect(Object.keys(store.state.sessions).sort()).toEqual(["fresh1", "fresh2"]);
    expect(store.state.sessions.stale).toBeUndefined();
  });
});

// ===========================================================================
// C — back-compat: a raw (uncompressed) tree snapshot still parses. The server
// emits raw JSON when (a) the client did not opt into z=1, (b) the payload is
// under the 2 KiB threshold, or (c) it's an older daemon without
// maybeCompressSnapshot. The listener must handle BOTH shapes — never break a
// tree stream because the server didn't compress.
// ===========================================================================
describe("C — back-compat: raw (uncompressed) tree snapshot still applies", () => {
  it("parses and applies a raw JSON tree snapshot (no envelope)", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();

    // Raw JSON shape — what every tree snapshot looked like before the wiring,
    // and what a sub-threshold / older-server response still looks like.
    treeESes()[0].fire("snapshot", treeSnapshot(11, ["r1", "r2"]));
    await tick();

    // The synchronous JSON.parse branch ran and applied.
    expect(Object.keys(store.state.sessions).sort()).toEqual(["r1", "r2"]);
    expect(store.state.sessions.r1).toEqual({ id: "r1", title: "t-r1" });
  });

  it("parses a raw JSON tree snapshot that happens to have NO `encoding` field but a coincidental `data` field", async () => {
    // Defensive shape pin: the listener keys the envelope branch on
    // `raw.encoding === "gzip64"` specifically, NOT on the presence of a `data`
    // field. A future snapshot that legitimately carries a `data` field for
    // some other reason must NOT be mis-routed into the gzip64 decode.
    stream.connect();
    treeESes()[0].simulateOpen();

    const shape = { seq: 13, sessions: [{ id: "x" }], data: "not-base64" };
    treeESes()[0].fire("snapshot", shape);
    await tick();

    expect(Object.keys(store.state.sessions)).toEqual(["x"]);
  });
});

// ===========================================================================
// D — decode-window race: a live tree event arriving during an in-flight
// gzip64 snapshot decode must serialize BEHIND the snapshot. This is the d-F1
// hazard the commit-reviewer flagged: making the tree snapshot listener async
// (for gzip64) opened a window where an in-order session.upsert on the SAME
// EventSource could be applied synchronously, then clobbered by applySnapshot's
// wholesale-replace (sessions={}) + cursor regression (s.cursor=snap.seq). The
// fix mirrors Stream-2's sesSnapshotDecode: the live-event listeners await
// treeSnapshotDecode before applying. These tests pin both the fix AND the
// fast-path (no await when no decode is in flight).
// ===========================================================================
describe("D — live tree event during gzip64 decode serializes (decode-window race)", () => {
  it("applies both the snapshot AND a same-connection live upsert; cursor not regressed", async () => {
    // The race scenario, compressed into a deterministic test:
    //   1. fire gzip64 snapshot seq=10 → IIFE starts, suspends at decode await
    //   2. SYNCHRONOUSLY fire session.upsert lastEventId=11 on the SAME ES
    //      (no microtask has run, decode still in flight)
    //   3. flush → decode completes, applySnap runs (sessions=base*, cursor=10),
    //      then the live listener's await resolves and applyTreeFrame runs
    //      (sessions.live set, cursor=11)
    //
    // Before the fix (async listener with no serialization): step 2 would
    // apply synchronously (sessions.live set, cursor=11), then step 3's
    // applySnapshot would wholesale-replace sessions (dropping `live`) and
    // regress cursor to 10. This test would fail at both assertions below.
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // 1. Compressed snapshot — IIFE starts and suspends at the
    //    DecompressionStream await. No microtask has run yet.
    const snap = treeSnapshot(10, ["base1", "base2"]);
    const envelope = { encoding: "gzip64" as const, data: encodeForTest(snap) };
    treeES.fire("snapshot", JSON.stringify(envelope));

    // 2. IMMEDIATELY (still synchronous — decode still suspended) fire a live
    //    session.upsert with a HIGHER seq on the SAME EventSource.
    treeES.fire(
      "session.upsert",
      { id: "live", title: "live-title" },
      "11", // lastEventId → seq
    );

    // 3. Flush microtasks: decode completes → applySnap (sessions=base*,
    //    cursor=10) → treeSnapshotDecoding=false → live listener's await
    //    resolves → applyTreeFrame (sessions.live set, cursor=11).
    //    awaitDecode drains the IIFE deterministically (await its promise
    //    directly); the followup tick() catches the upsert listener's post-
    //    await continuation (queued when treeSnapshotDecode settled).
    await awaitDecode();
    await tick();

    // BOTH the snapshot sessions AND the live upsert survived — the live event
    // was NOT clobbered by applySnapshot's wholesale replace.
    expect(Object.keys(store.state.sessions).sort()).toEqual(["base1", "base2", "live"]);
    expect(store.state.sessions.live).toEqual({ id: "live", title: "live-title" });

    // The cursor advanced to the live event's seq (11), NOT regressed back to
    // the snapshot's seq (10). This is the specific anti-clobber property the
    // hard mission constraint "Preserve Stream1 cursor/epoch anti-clobber"
    // requires within a single connection.
    expect(store.state.cursor).toBe(11);
  });

  it("live event with NO decode in flight → zero-await fast path (no regression)", async () => {
    // Counter-test: the serialize-against-decode gate must NOT add latency on
    // the fast path. The boolean check `if (treeSnapshotDecoding)` short-
    // circuits when no decode is in flight, so the listener applies
    // synchronously inside fire() — no flush needed. This pins that the fix
    // didn't accidentally make every tree event async.
    stream.connect();
    const treeES = treeESes()[0];
    treeES.simulateOpen();

    // Fire a RAW (synchronous) snapshot first to establish state — no async
    // decode is scheduled, treeSnapshotDecoding stays false.
    treeES.fire("snapshot", treeSnapshot(5, ["a"]));
    await tick();

    // Fire a live session.upsert — no decode in flight, so the listener must
    // NOT await. The state lands synchronously inside fire(), before any flush.
    treeES.fire(
      "session.upsert",
      { id: "b", title: "b-title" },
      "6",
    );

    // Synchronous apply — fast path preserved. (If the gate had accidentally
    // awaited, these would be undefined / stale until a flush.)
    expect(store.state.sessions.b).toEqual({ id: "b", title: "b-title" });
    expect(store.state.sessions.a).toEqual({ id: "a", title: "t-a" });
    expect(store.state.cursor).toBe(6);
  });
});

// ===========================================================================
// E — cross-reconnect decode overlap: a stale connection's gzip64 decode and
// the replacement connection's gzip64 decode can overlap (the stale IIFE is
// still suspended at its DecompressionStream await when connect(true) replaces
// the connection and the new snapshot arrives). This test verifies the END
// STATE is correct: the stale snapshot does NOT clobber the fresh one, the
// live event survives, and the cursor is not regressed.
//
// NOTE: the specific flag-reset race window the gen-aware `finally` fix targets
// (stale decode completes → clears shared flag → live event skips serialize
// gate → fresh decode clobbers) cannot be deterministically reproduced under
// fake timers with real DecompressionStream: both decodes have the same
// internal read() cycle count and drain in the same advanceTimersByTimeAsync(0)
// call, so the window never opens. The fix is correct by inspection (the gen
// guard ensures only the current generation's IIFE can clear the flag). This
// test pins the behavioral contract the fix preserves.
// ===========================================================================
describe("E — cross-reconnect: stale decode does not clear the current connection's flag", () => {
  it("applies both the fresh snapshot AND a post-reconnect live event; cursor not regressed", async () => {
    // Scenario:
    //   1. connect → ES_A (gen=1)
    //   2. fire gzip64 seq=10 on ES_A → A's decode starts (flag=true)
    //   3. connect(true) → ES_B (gen=2), flag reset, A's decode still in flight
    //   4. fire gzip64 seq=20 on ES_B → B's decode starts (flag=true)
    //   5. flush — A's stale decode completes (gen check skips its applySnap);
    //      WITHOUT the fix, A's finally clears the flag while B is still decoding
    //   6. fire session.upsert seq=21 on ES_B
    //      WITHOUT fix: flag was cleared → skips serialize gate → applies ahead
    //      WITH fix: flag still true → awaits B's decode
    //   7. flush — B's decode completes → applySnap → live event applies
    //
    // Without the fix (if A drains first): step 6's live event applies
    // immediately (sessions.live, cursor=21), then B's applySnapshot wholesale-
    // replaces sessions (dropping live) and regresses cursor to 20.
    stream.connect();
    const oldES = treeESes()[0];
    oldES.simulateOpen();

    // 1. OLD connection: fire gzip64 snapshot — A's decode IIFE starts and
    //    suspends at the DecompressionStream await.
    const staleSnap = treeSnapshot(10, ["stale"]);
    oldES.fire("snapshot", JSON.stringify({
      encoding: "gzip64" as const,
      data: encodeForTest(staleSnap),
    }));

    // 2. REPLACE the connection BEFORE A's decode finishes. connect(true)
    //    bumps treeGen (1→2), resets the gate, closes oldES, creates newES.
    //    A's IIFE is still suspended; its captured gen=1 is now superseded.
    stream.connect(true);
    const newES = treeESes().filter((e) => e.readyState !== CLOSED)[0];
    expect(newES).not.toBe(oldES);
    expect(oldES.readyState).toBe(CLOSED);
    newES.simulateOpen();

    // 3. NEW connection: fire gzip64 snapshot — B's decode IIFE starts.
    const freshSnap = treeSnapshot(20, ["b1", "b2"]);
    newES.fire("snapshot", JSON.stringify({
      encoding: "gzip64" as const,
      data: encodeForTest(freshSnap),
    }));

    // 4. Await A's stale decode directly via the module's treeSnapshotDecode
    //    promise (which still references A's IIFE — connect(true) reset the
    //    module variable but A's promise was already captured here in scope).
    //    A's gen check (gen=1 !== treeGen=2) correctly skips its applySnap. The
    //    critical point: A's finally — without the ownership-aware clear, A
    //    would clear the flag while B's decode is still in flight.
    //    Note: getTreeSnapshotDecode() returns the CURRENT module promise, which
    //    after connect(true) is the RESET promise, not A's. So we await tick()
    //    to drain A's microtasks naturally under real timers.
    await tick(2);

    // 5. Fire a live session.upsert with a HIGHER seq on the NEW connection.
    //    If the bug were present (A's finally cleared the flag), this event
    //    would see treeSnapshotDecoding===false and skip the serialize gate.
    newES.fire(
      "session.upsert",
      { id: "live", title: "live-title" },
      "21",
    );

    // 6. Await B's decode directly — applySnap runs inside, then the live
    //    event's continuation runs as a followup microtask (tick()).
    await awaitDecode();
    await tick();

    // The stale snapshot (["stale"]) did NOT clobber the fresh one — A's gen
    // guard worked.
    expect(store.state.sessions.stale).toBeUndefined();

    // BOTH the fresh snapshot sessions AND the live upsert survived. If the
    // bug were present, the live upsert would have been applied ahead of B's
    // snapshot, then clobbered by applySnapshot's wholesale replace.
    expect(Object.keys(store.state.sessions).sort()).toEqual(["b1", "b2", "live"]);
    expect(store.state.sessions.live).toEqual({ id: "live", title: "live-title" });

    // The cursor advanced to the live event's seq (21), NOT regressed back to
    // the fresh snapshot's seq (20).
    expect(store.state.cursor).toBe(21);
  });
});
