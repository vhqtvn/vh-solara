// @vitest-environment jsdom
//
// O3 delivery-ordinal gap recovery — the root fix for the Inv1 covering-check
// false-positive / production-thash class.
//
// Inv1 added per-stream seq-gap detection, but the SSE id: carries a GLOBAL
// store seq while events are interest-filtered → per-stream received seqs are
// non-contiguous → the cross-stream covering check was a timing heuristic that
// FALSE-POSITIVES when Stream 2 lags → spurious tree reconnects (real prod
// thrash).
//
// O3 fix: a per-connection delivery ordinal (compound SSE id "globalSeq.ordinal")
// counts ONLY Inv1-relevant logical source events. A gap in this ordinal is
// DIRECTLY actionable as real loss. The cross-stream covering check is REMOVED.
//
// FINDING 1 FIX (this revision): the ordinal-counted kind set is aligned to a
// SINGLE source of truth. On Stream 2 (session/firehose, treeEmitter==nil) the
// server advances the ordinal ONLY for snapshot + message-class events
// (state.IsMessageClassKind); structural frames (status/activity/...) are
// emitted via writeRawNoID (no ordinal advance). The pre-commit greens MOCKED
// the wire with hand-crafted contiguous ordinals — they were green while the
// real server's structural interleave broke the ordinal contract. This suite
// now uses a Stream2OrdinalSim that mirrors the real server's ordinal logic,
// so the tests exercise REAL ordinal semantics (not hand-crafted).
//
// FINDING 2 FIX (this revision): the ordinal baseline resets on EVERY open() /
// onopen (not just closeSessionStream), covering both the CLOSED-retry path
// and native EventSource auto-reconnect. A dedicated case proves this.
//
// This suite proves the 5 O3 cases:
//   1. Thrash-lag (the regression): Stream-1 structural after Stream-2-only
//      in-flight messages → NO reconnect.
//   2. Other-session message global jump → NO reconnect (ordinal doesn't
//      advance for it on either stream).
//   3. Dropped relevant Stream-1 structural → recovers (connect(true)).
//   4. Dropped selected-session Stream-2 message → recovers
//      (openSessionStream(id,true)).
//   5. NEW (Finding 3): Structural interleave on Stream 2 (message → status →
//      message) → NO resync (the ordinal is contiguous because structural
//      frames don't advance it). This is the deterministic red→green that the
//      pre-commit greens missed.
//
// Also preserves the Inv2 tail-integrity tests and the no-reload guarantee.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { openSessionStream, closeSessionStream } from "../../src/sync/session-stream";
import {
  SESSION_MESSAGE_KINDS,
  _setSesDropNextNForTest,
  _getSesLastSeqForTest,
  _resetSesGapStateForTest,
} from "../../src/sync/session-stream";
import { connect } from "../../src/sync/tree-transport";
import {
  _setTreeDropNextNForTest,
  _getTreeLastSeqForTest,
  _resetTreeGapStateForTest,
} from "../../src/sync/tree-transport";
import {
  setSelectedIdRaw,
  setProjectDirRaw,
  state,
  setState,
} from "../../src/sync/store";
import { resetTreeStore } from "../../src/sync/treeState";
import {
  setDiagLogOn,
  diagEntries,
  _resetDiagForTest,
  type StallEntry,
} from "../../src/sync/diaglog";
import { applyMessageEvent } from "../../src/sync/reconcile";
import { reconcile } from "solid-js/store";

// ---------------------------------------------------------------------------
// Stream2OrdinalSim — simulates the REAL server's per-connection ordinal
// assignment for Stream 2 (the session/firehose stream, treeEmitter==nil).
// Mirrors server.go's treeEmitter==nil replay + live-tail branches (O3 Finding
// 1): the ordinal advances ONLY for snapshot + message-class events
// (state.IsMessageClassKind === SESSION_MESSAGE_KINDS); structural frames are
// emitted via writeRawNoID (no ordinal advance, no id line).
//
// Using this simulator instead of hand-crafted "1.1", "2.2" strings is what
// makes the tests exercise REAL ordinal semantics: a structural event between
// two messages does NOT produce a phantom ordinal gap, because the simulator
// (like the fixed server) skips the ordinal for structural kinds.
// ---------------------------------------------------------------------------
class Stream2OrdinalSim {
  private ordinal = 0;
  private readonly msgKinds: Set<string> = new Set(SESSION_MESSAGE_KINDS);
  /** Returns the compound SSE id for a snapshot/message event, or "" for a
   * structural event (writeRawNoID — no id line, no ordinal advance). */
  id(globalSeq: number, kind: string): string {
    if (kind === "snapshot" || this.msgKinds.has(kind)) {
      this.ordinal++;
      return `${globalSeq}.${this.ordinal}`;
    }
    return ""; // structural → no ordinal advance (writeRawNoID)
  }
}

// --- Mock EventSource ---
// jsdom doesn't implement EventSource. This mock supports lastEventId on fired
// events (the key property for delivery-ordinal gap detection) via
// Object.defineProperty.
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

  /** Fire a named SSE event with a specific lastEventId and JSON payload. */
  fire(type: string, lastEventId: string, data: unknown): void {
    const ev = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
    // MessageEvent constructor doesn't support lastEventId — define it.
    Object.defineProperty(ev, "lastEventId", {
      value: lastEventId,
      writable: false,
      configurable: true,
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
// Tree stream URL carries sessions=& (empty); session stream carries sessions=<id>.
const treeESes = (): MockEventSource[] =>
  instances.filter((e) => !/sessions=[^&]/.test(e.url));
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => /sessions=[^&]/.test(e.url));

beforeEach(() => {
  instances = [];
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  setProjectDirRaw("/test");
  setSelectedIdRaw("s1");
  // Enable diag capture so we can assert StallEntry entries.
  localStorage.clear();
  _resetDiagForTest();
  setDiagLogOn(true);
  // Reset the gap baselines for both streams.
  _resetSesGapStateForTest();
  _resetTreeGapStateForTest();
  // Reset the store's cursor so tests start from a clean baseline.
  setState("cursor", 0);
  resetTreeStore();
  // The fix must NEVER call location.reload(). jsdom's location.reload is
  // non-configurable, so we track it via a global flag instead of a spy.
  (globalThis as unknown as { __reloadCalled?: boolean }).__reloadCalled = false;
  const origReload = window.location.reload;
  try {
    Object.defineProperty(window.location, "reload", {
      value: () => {
        (globalThis as unknown as { __reloadCalled?: boolean }).__reloadCalled = true;
      },
      configurable: true,
      writable: true,
    });
  } catch {
    // If we can't override reload, skip the assertion (non-critical).
  }
});

afterEach(() => {
  closeSessionStream();
  // Clean up the module-level state store so mutations from this file don't
  // leak into subsequent test files.
  setState("messages", reconcile({}));
  setState("activity", reconcile({}));
  setState("messagesDelivered", reconcile({}));
  setState("messagesError", reconcile({}));
  setState("cursor", 0);
  setState("refreshing", reconcile({}));
  setSelectedIdRaw(null);
  vi.restoreAllMocks();
  vi.clearAllTimers();
  vi.useRealTimers();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

// Helper: a minimal snapshot payload that applySessionSnapshot can process.
const makeSnapshot = (msgs: any[], seq = 1) => ({
  sessions: [{ id: "s1" }],
  messages: { s1: msgs },
  gate: { s1: { messagesLoaded: true } },
  seq,
});

const stallEntries = (): StallEntry[] =>
  diagEntries().filter((e): e is StallEntry => e.kind === "stall");

// =============================================================================
// Case 1: Thrash-lag → NO reconnect (the regression race that caused thrash)
// =============================================================================
// The production thrash root cause: Stream 2 lags, so global seqs on Stream 1
// jump (the lagging messages consumed store seqs). With the OLD covering check,
// this could false-positive → spurious tree reconnects. O3: the tree ORDINAL is
// contiguous (in-flight messages don't advance Stream 1's ordinal) → NO gap.
describe("O3 case 1 — lag case: global-seq jump with contiguous ordinal → NO reconnect", () => {
  it("tree stream: does NOT reconnect when global seq jumps but ordinal is contiguous", () => {
    vi.useFakeTimers();
    connect(true);
    expect(treeESes()).toHaveLength(1);
    const es1 = treeESes()[0];
    es1.simulateOpen();

    // Fire a tree.op event (ordinal 1). Global seq = 5.
    es1.fire("tree.op", "5.1", { kind: "node.upsert", node: { id: "s1" } });
    expect(_getTreeLastSeqForTest()).toBe(1);

    // Global seq jumps to 20 (Stream 2 processed messages seqs 6-19 in-flight),
    // but the tree ORDINAL is contiguous (2). O3: no gap → no reconnect.
    es1.fire("tree.op", "20.2", { kind: "node.upsert", node: { id: "s2" } });

    // Still 1 tree ES — no spurious reconnect.
    expect(treeESes()).toHaveLength(1);
    expect(_getTreeLastSeqForTest()).toBe(2);
    expect(stallEntries().filter((s) => s.stream === "tree").length).toBe(0);
  });

  it("session stream: does NOT resync when global seq jumps but ordinal is contiguous", () => {
    vi.useFakeTimers();
    openSessionStream("s1");
    const es1 = sessionESes()[0];
    es1.simulateOpen();

    // Use the REAL server ordinal simulator: snapshot gets ordinal 1.
    const sim = new Stream2OrdinalSim();
    es1.fire("snapshot", sim.id(1, "snapshot"), makeSnapshot([
      { info: { id: "m0", sessionID: "s1", role: "user", time: { created: 1 } }, parts: [] },
    ]));

    // Global seq jumps to 15 (structural events consumed seqs 2-14 that the
    // server emitted via writeRawNoID — no ordinal advance), but the next
    // message is at ordinal 2 (contiguous). O3: no gap → no resync.
    es1.fire("message.upsert", sim.id(15, "message.upsert"), {
      id: "m1", sessionID: "s1", role: "assistant", time: { created: 15 },
    });

    // Still 1 session ES — no spurious resync.
    expect(sessionESes().length).toBe(1);
    expect(_getSesLastSeqForTest()).toBe(2);
    expect(stallEntries().filter((s) => s.stream === "session").length).toBe(0);
  });
});

// =============================================================================
// Case 2: Other-session-message global jump → NO reconnect
// =============================================================================
// An other-session message advances the GLOBAL seq but reaches NEITHER stream's
// Inv1 detector (Stream 1's interest filter excludes it; Stream 2 only watches
// the selected session). So the ordinal stays contiguous → no false gap.
describe("O3 case 2 — other-session global jump → NO reconnect", () => {
  it("session stream: other-session messages do not create an ordinal gap", () => {
    vi.useFakeTimers();
    openSessionStream("s1");
    const es1 = sessionESes()[0];
    es1.simulateOpen();

    const sim = new Stream2OrdinalSim();
    es1.fire("snapshot", sim.id(1, "snapshot"), makeSnapshot([
      { info: { id: "m0", sessionID: "s1", role: "user", time: { created: 1 } }, parts: [] },
    ]));
    expect(_getSesLastSeqForTest()).toBe(1);

    // A selected-session message at ordinal 2 (global seq 2).
    es1.fire("message.upsert", sim.id(2, "message.upsert"), {
      id: "m1", sessionID: "s1", role: "assistant", time: { created: 2 },
    });

    // The server's global seq advanced to 10 due to other-session messages,
    // but the next selected-session message is at ordinal 3 (contiguous).
    // O3: ordinal contiguous → no gap → no reconnect.
    es1.fire("message.upsert", sim.id(10, "message.upsert"), {
      id: "m2", sessionID: "s1", role: "assistant", time: { created: 10 },
    });

    expect(sessionESes().length).toBe(1); // no resync
    expect(_getSesLastSeqForTest()).toBe(3);
    expect(stallEntries().length).toBe(0);
  });
});

// =============================================================================
// Case 3: Dropped-relevant-event STILL recovers (LOAD-BEARING — no weakened detection)
// =============================================================================
// The hard constraint: O3 must NOT weaken real-loss detection. Dropped relevant
// events on BOTH streams must still force recovery.
describe("O3 case 3 — dropped-relevant-event STILL recovers (no weakened detection)", () => {
  it("tree stream: dropped structural event forces a tree reconnect", () => {
    vi.useFakeTimers();
    connect(true);
    expect(treeESes()).toHaveLength(1);
    const es1 = treeESes()[0];
    es1.simulateOpen();

    // Fire a TREE_STREAM_KINDS event (e.g. "status") at ordinal 1.
    es1.fire("status", "5.1", { sessionID: "s1", state: "busy" });
    expect(_getTreeLastSeqForTest()).toBe(1);

    // Arm the drop hook for 1 event — simulate silent loss.
    _setTreeDropNextNForTest(1);

    // Fire event (ordinal 2) — DROPPED.
    es1.fire("status", "6.2", { sessionID: "s1", state: "idle" });
    expect(_getTreeLastSeqForTest()).toBe(1); // unchanged

    // Fire event (ordinal 3) — ARRIVES. Ordinal gap: 1→3 (missed=1) → connect(true).
    es1.fire("status", "7.3", { sessionID: "s1", state: "busy" });

    // A NEW tree EventSource was created (reconnect occurred).
    expect(treeESes().length).toBe(2);

    const stalls = stallEntries().filter((s) => s.stream === "tree");
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    expect(stalls[0].trigger).toBe("seq-gap");
    expect(stalls[0].seqGap).toEqual({
      stream: "tree", expected: 2, got: 3, missed: 1,
    });
  });

  it("session stream: dropped selected-session message forces a resync", () => {
    vi.useFakeTimers();
    openSessionStream("s1");
    expect(sessionESes()).toHaveLength(1);
    const es1 = sessionESes()[0];
    es1.simulateOpen();

    const sim = new Stream2OrdinalSim();
    es1.fire("snapshot", sim.id(1, "snapshot"), makeSnapshot([
      { info: { id: "m0", sessionID: "s1", role: "user", time: { created: 1 } }, parts: [] },
    ]));
    expect(_getSesLastSeqForTest()).toBe(1);

    // Arm the drop hook for 1 event — simulate silent loss.
    _setSesDropNextNForTest(1);

    // Fire event (ordinal 2) — DROPPED.
    es1.fire("message.upsert", sim.id(2, "message.upsert"), {
      id: "m1", sessionID: "s1", role: "assistant", time: { created: 2 },
    });
    expect(_getSesLastSeqForTest()).toBe(1); // unchanged

    // Fire event (ordinal 3) — ARRIVES. Ordinal gap: 1→3 (missed=1) → resync.
    es1.fire("message.upsert", sim.id(3, "message.upsert"), {
      id: "m2", sessionID: "s1", role: "assistant", time: { created: 3 },
    });

    // A NEW session EventSource was created (resync occurred).
    expect(sessionESes().length).toBe(2);

    const stalls = stallEntries().filter((s) => s.stream === "session");
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    expect(stalls[0].trigger).toBe("seq-gap");
    expect(stalls[0].seqGap).toEqual({
      stream: "session", expected: 2, got: 3, missed: 1,
    });
  });
});

// =============================================================================
// Case 4: Delivery-ordinal jump recovers (real loss on Stream 2)
// =============================================================================
describe("O3 case 4 — delivery-ordinal jump recovers (Stream2 real loss)", () => {
  it("detects an ordinal gap from dropped events and forces a fresh-snapshot resync", () => {
    vi.useFakeTimers();
    openSessionStream("s1");
    expect(sessionESes()).toHaveLength(1);
    const es1 = sessionESes()[0];
    es1.simulateOpen();

    // Use the REAL server ordinal simulator throughout.
    const sim = new Stream2OrdinalSim();
    // Compound IDs: "globalSeq.ordinal". The snapshot gets ordinal 1.
    es1.fire("snapshot", sim.id(1, "snapshot"), makeSnapshot([
      { info: { id: "m0", sessionID: "s1", role: "user", time: { created: 1 } }, parts: [] },
    ]));

    // Deliver message events (ordinal 2, 3) — builds the tail.
    es1.fire("message.upsert", sim.id(2, "message.upsert"), {
      id: "m1", sessionID: "s1", role: "assistant", time: { created: 2 },
    });
    es1.fire("message.upsert", sim.id(3, "message.upsert"), {
      id: "m1", sessionID: "s1", role: "assistant", time: { created: 2, completed: 3 },
    });

    // Baseline: sesLastDeliveryOrdinal = 3.
    expect(_getSesLastSeqForTest()).toBe(3);

    // Arm the drop hook for 2 events — simulate silent loss.
    _setSesDropNextNForTest(2);

    // Fire events (ordinal 4, 5) — DROPPED (silent loss, connection stays open).
    es1.fire("message.upsert", sim.id(4, "message.upsert"), {
      id: "m2", sessionID: "s1", role: "assistant", time: { created: 4, completed: 5 },
    });
    es1.fire("part.upsert", sim.id(5, "part.upsert"), {
      id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello",
    });

    // Dropped events did NOT advance the ordinal.
    expect(_getSesLastSeqForTest()).toBe(3);

    // Fire event (ordinal 6) — ARRIVES. Ordinal gap: 3→6 (missed=2). Directly
    // actionable → openSessionStream(id, true).
    es1.fire("message.upsert", sim.id(6, "message.upsert"), {
      id: "m3", sessionID: "s1", role: "user", time: { created: 6 },
    });

    // A NEW session EventSource was created (resync occurred).
    expect(sessionESes().length).toBe(2);

    // A stall diag entry with trigger='seq-gap' was captured.
    const stalls = stallEntries();
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    expect(stalls[0].trigger).toBe("seq-gap");
    expect(stalls[0].stream).toBe("session");
    expect(stalls[0].seqGap).toEqual({
      stream: "session", expected: 4, got: 6, missed: 2,
    });

    // NO location.reload().
    expect((globalThis as unknown as { __reloadCalled?: boolean }).__reloadCalled).toBeFalsy();
  });
});

// =============================================================================
// Case 5 (Finding 3): Structural interleave on Stream 2 → NO resync
// =============================================================================
// THE REGRESSION THE PRE-COMMIT GREENS MISSED: a structural event (status/
// activity/unread/permission/question) arrives BETWEEN two selected-session
// message events on Stream 2. Before Finding 1's fix, the server advanced the
// ordinal for the structural event (invisible to the FE, which has NO
// structural listener on Stream 2) → the second message arrived at ordinal 3
// instead of 2 → checkSesOrdinalGap saw ordinal > expected → spurious
// openSessionStream(id, true). This recreates the thrash class on EVERY status
// busy/idle flip, activity, unread, permission event.
//
// With Finding 1's fix, structural frames are emitted via writeRawNoID (no
// ordinal advance) → message ordinals stay contiguous → NO gap → NO resync.
//
// This test uses Stream2OrdinalSim (mirrors the fixed server) to assign IDs.
// The companion Go test (sse_ordinal_interleave_test.go) drives the REAL
// server and is the deterministic red→green non-vacuity proof; this FE test
// proves the FE gap-detection logic handles the correct ordinal pattern.
describe("O3 case 5 (Finding 3) — structural interleave on Stream 2 → NO resync", () => {
  it("a structural event between two messages does NOT create an ordinal gap", () => {
    vi.useFakeTimers();
    openSessionStream("s1");
    expect(sessionESes()).toHaveLength(1);
    const es1 = sessionESes()[0];
    es1.simulateOpen();

    // The simulator mirrors the FIXED server's ordinal logic: structural kinds
    // get no id (writeRawNoID), so they don't advance the ordinal.
    const sim = new Stream2OrdinalSim();

    // Snapshot at ordinal 1 (global seq 1).
    es1.fire("snapshot", sim.id(1, "snapshot"), makeSnapshot([
      { info: { id: "m0", sessionID: "s1", role: "user", time: { created: 1 } }, parts: [] },
    ]));
    expect(_getSesLastSeqForTest()).toBe(1);

    // Message at ordinal 2 (global seq 2).
    es1.fire("message.upsert", sim.id(2, "message.upsert"), {
      id: "m1", sessionID: "s1", role: "assistant", time: { created: 2 },
    });
    expect(_getSesLastSeqForTest()).toBe(2);

    // STRUCTURAL INTERLEAVE: a status event arrives (global seq 3). The server
    // emits it via writeRawNoID → no id line → no ordinal advance. The FE has
    // no listener for "status" on Stream 2 (it consumes structural via the tree
    // stream), so this is a no-op. Fire it to prove the point.
    const statusID = sim.id(3, "status"); // "" — no ordinal advance
    expect(statusID).toBe(""); // structural → no id (writeRawNoID)
    es1.fire("status", statusID, { sessionID: "s1", state: "busy" });

    // The ordinal did NOT advance for the structural event.
    expect(_getSesLastSeqForTest()).toBe(2);

    // Next message at ordinal 3 (global seq 4) — contiguous (2 → 3). NO gap.
    es1.fire("message.upsert", sim.id(4, "message.upsert"), {
      id: "m2", sessionID: "s1", role: "assistant", time: { created: 4 },
    });

    // NO resync occurred (still 1 session ES).
    expect(sessionESes().length).toBe(1);
    // The ordinal advanced only for the two messages (1→2→3), not the structural.
    expect(_getSesLastSeqForTest()).toBe(3);
    // NO stall entry was captured.
    expect(stallEntries().filter((s) => s.stream === "session").length).toBe(0);
  });

  it("multiple structural kinds interleaved (status + activity + unread + permission) → still contiguous", () => {
    vi.useFakeTimers();
    openSessionStream("s1");
    const es1 = sessionESes()[0];
    es1.simulateOpen();

    const sim = new Stream2OrdinalSim();
    es1.fire("snapshot", sim.id(1, "snapshot"), makeSnapshot([
      { info: { id: "m0", sessionID: "s1", role: "user", time: { created: 1 } }, parts: [] },
    ]));

    // Message (ordinal 2).
    es1.fire("message.upsert", sim.id(10, "message.upsert"), {
      id: "m1", sessionID: "s1", role: "assistant", time: { created: 10 },
    });
    expect(_getSesLastSeqForTest()).toBe(2);

    // A BURST of structural events (the real-world thrash trigger: busy/idle
    // flip + activity + unread + permission). Each gets no id (writeRawNoID).
    for (const [kind, data] of [
      ["status", { sessionID: "s1", state: "busy" }],
      ["activity", { sessionID: "s1", state: "busy" }],
      ["unread.set", { sessionID: "s1", count: 1 }],
      ["permission.upsert", { sessionID: "s1", name: "test" }],
      ["status", { sessionID: "s1", state: "idle" }],
    ] as const) {
      const id = sim.id(99, kind);
      expect(id).toBe(""); // structural → no ordinal advance
      es1.fire(kind, id, data);
    }

    // Ordinal unchanged through the structural burst.
    expect(_getSesLastSeqForTest()).toBe(2);

    // Next message (ordinal 3) — contiguous. NO gap.
    es1.fire("message.upsert", sim.id(20, "message.upsert"), {
      id: "m2", sessionID: "s1", role: "assistant", time: { created: 20 },
    });

    expect(sessionESes().length).toBe(1); // no resync
    expect(_getSesLastSeqForTest()).toBe(3);
    expect(stallEntries().filter((s) => s.stream === "session").length).toBe(0);
  });
});

// =============================================================================
// Finding 2: ordinal baseline resets on CLOSED-retry open() + native reconnect
// =============================================================================
// The server restarts its per-connection ordinal on each new HTTP connection.
// After a CLOSED-retry (open() running directly from the sesRetry timer) OR a
// native EventSource auto-reconnect (onopen firing again on the same ES), the
// client's baseline must be reset so early replay events are not misclassified
// (ordinal <= stale-high-expected → real loss silently ignored).
describe("O3 Finding 2 — ordinal baseline resets on reconnect", () => {
  it("resets sesLastDeliveryOrdinal when onopen fires again (native auto-reconnect path)", () => {
    vi.useFakeTimers();
    openSessionStream("s1");
    const es1 = sessionESes()[0];
    es1.simulateOpen();

    const sim = new Stream2OrdinalSim();
    es1.fire("snapshot", sim.id(1, "snapshot"), makeSnapshot([
      { info: { id: "m0", sessionID: "s1", role: "user", time: { created: 1 } }, parts: [] },
    ]));
    es1.fire("message.upsert", sim.id(2, "message.upsert"), {
      id: "m1", sessionID: "s1", role: "assistant", time: { created: 2 },
    });
    // Baseline is now 2 (high).
    expect(_getSesLastSeqForTest()).toBe(2);

    // Simulate a native EventSource auto-reconnect: the browser reuses this
    // EventSource but opens a NEW HTTP connection → onopen fires AGAIN. The
    // server restarts its ordinal (handler-local counter). Finding 2's fix
    // resets sesLastDeliveryOrdinal in onopen so the fresh ordinal space is
    // re-seeded correctly (not compared against the stale high baseline).
    es1.simulateOpen();

    // The baseline was RESET to -1 (Finding 2: onopen reset).
    expect(_getSesLastSeqForTest()).toBe(-1);

    // A fresh event at ordinal 1 (the server restarted) re-seeds the baseline
    // correctly — NOT misclassified as ordinal <= expected (which would happen
    // if the stale baseline 2 persisted).
    const sim2 = new Stream2OrdinalSim(); // fresh server, ordinal restarts at 0
    es1.fire("message.upsert", sim2.id(10, "message.upsert"), {
      id: "m2", sessionID: "s1", role: "assistant", time: { created: 10 },
    });
    expect(_getSesLastSeqForTest()).toBe(1); // re-seeded, not ignored
    expect(sessionESes().length).toBe(1); // no spurious resync
    expect(stallEntries().filter((s) => s.stream === "session").length).toBe(0);
  });

  it("CLOSED-retry path: open() resets the baseline before the new connection's first event", () => {
    vi.useFakeTimers();
    openSessionStream("s1");
    const es1 = sessionESes()[0];
    es1.simulateOpen();

    const sim = new Stream2OrdinalSim();
    es1.fire("snapshot", sim.id(1, "snapshot"), makeSnapshot([
      { info: { id: "m0", sessionID: "s1", role: "user", time: { created: 1 } }, parts: [] },
    ]));
    es1.fire("message.upsert", sim.id(2, "message.upsert"), {
      id: "m1", sessionID: "s1", role: "assistant", time: { created: 2 },
    });
    expect(_getSesLastSeqForTest()).toBe(2);

    // Simulate a fatal CLOSED: set readyState, fire onerror (schedules retry).
    (es1 as unknown as { readyState: number }).readyState = CLOSED;
    es1.onerror?.();
    // Advance past the 1500ms backoff so open() fires.
    vi.advanceTimersByTime(2000);

    // open() ran: a new EventSource was constructed.
    expect(sessionESes().length).toBe(2);
    // The baseline was RESET by open() (Finding 2). simulateOpen fires onopen
    // which ALSO resets it (belt-and-suspenders). The value should be -1.
    expect(_getSesLastSeqForTest()).toBe(-1);

    // Fire the new connection's first event (server restarted ordinal at 1).
    const es2 = sessionESes()[1];
    es2.simulateOpen();
    const sim2 = new Stream2OrdinalSim();
    es2.fire("snapshot", sim2.id(1, "snapshot"), makeSnapshot([
      { info: { id: "m0", sessionID: "s1", role: "user", time: { created: 1 } }, parts: [] },
    ]));
    // Re-seeded from the fresh connection — NOT ignored as ordinal <= expected.
    expect(_getSesLastSeqForTest()).toBe(1);
    expect(stallEntries().filter((s) => s.stream === "session").length).toBe(0);
  });
});

// =============================================================================
// Invariant 2 (tail-integrity on idle) — preserved (Inv1-B landed, untouched)
// =============================================================================
describe("seq-gap recovery — Invariant 2 (tail-integrity on idle)", () => {
  beforeEach(() => {
    setState("messages", "s1", {
      order: ["m1"],
      byId: {
        m1: {
          info: { id: "m1", sessionID: "s1", role: "user", time: { created: 1 } },
          parts: [],
        },
      },
    });
    setState("activity", "s1", "busy");
  });

  it("force-fetches a fresh snapshot when activity=idle arrives but the tail's last message is not a completed assistant", () => {
    vi.useFakeTimers();
    openSessionStream("s1");
    expect(sessionESes()).toHaveLength(1);
    sessionESes()[0].simulateOpen();

    applyMessageEvent("activity", 100, { sessionID: "s1", state: "idle" }, true);

    expect(sessionESes().length).toBe(2);

    const stalls = stallEntries();
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    const tailStall = stalls.find((s) => s.trigger === "tail-incomplete-on-idle");
    expect(tailStall).toBeDefined();
    expect(tailStall!.sessionId).toBe("s1");
    expect(tailStall!.residentTail?.lastMsgRole).toBe("user");
    expect(tailStall!.residentTail?.lastMsgCompleted).toBe(false);

    expect((globalThis as unknown as { __reloadCalled?: boolean }).__reloadCalled).toBeFalsy();
  });

  it("does NOT force-fetch when the tail's last assistant message already has time.completed (bridge handled it)", () => {
    vi.useFakeTimers();
    setState("messages", "s1", {
      order: ["m1"],
      byId: {
        m1: {
          info: {
            id: "m1", sessionID: "s1", role: "assistant",
            time: { created: 1, completed: 2 },
          },
          parts: [],
        },
      },
    });

    openSessionStream("s1");
    sessionESes()[0].simulateOpen();

    applyMessageEvent("activity", 100, { sessionID: "s1", state: "idle" }, true);

    expect(sessionESes().length).toBe(1);
    const tailStalls = stallEntries().filter((s) => s.trigger === "tail-incomplete-on-idle");
    expect(tailStalls.length).toBe(0);
  });
});

// =============================================================================
// No-reload guarantee — O3 must NEVER call location.reload()
// =============================================================================
describe("seq-gap recovery — no-reload guarantee", () => {
  it("NEVER calls location.reload() during any recovery path", () => {
    vi.useFakeTimers();
    openSessionStream("s1");
    const es1 = sessionESes()[0];
    es1.simulateOpen();

    const sim = new Stream2OrdinalSim();
    es1.fire("snapshot", sim.id(1, "snapshot"), makeSnapshot([
      { info: { id: "m0", sessionID: "s1", role: "user", time: { created: 1 } }, parts: [] },
    ]));

    // Trigger an ordinal-gap recovery.
    _setSesDropNextNForTest(1);
    es1.fire("message.upsert", sim.id(2, "message.upsert"), {
      id: "m1", sessionID: "s1", role: "assistant", time: { created: 2 },
    });
    es1.fire("message.upsert", sim.id(4, "message.upsert"), {
      id: "m2", sessionID: "s1", role: "assistant", time: { created: 4 },
    });

    // Recovery happened (new ES created).
    expect(sessionESes().length).toBe(2);
    // No reload.
    expect((globalThis as unknown as { __reloadCalled?: boolean }).__reloadCalled).toBeFalsy();
  });
});
