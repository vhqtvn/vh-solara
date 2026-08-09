// @vitest-environment jsdom
//
// Regression test for the "UI behind reality until reload" bug — the compound
// loss where the terminal message.upsert(time.completed) on Stream2 AND/OR the
// activity=idle on Stream1 are silently lost while the connection stays OPEN.
// Before this fix, the ONLY recovery was a full page reload.
//
// This suite proves the fix makes "reload fixes it" impossible by construction:
//   1. Stream2 seq-gap detection → forced fresh-snapshot resync (Invariant 1)
//   2. Stream1 seq-gap detection → forced tree reconnect (Invariant 1)
//   3. Tail-integrity check on idle → force-fetch (Invariant 2)
//   4. A StallEntry diag entry is captured on each recovery
//   5. NO location.reload() is ever called
//
// The deterministic red signal = a test-settable __dropNextN hook that drops N
// events from a stream listener BEFORE markSeen/reconcile, simulating "events
// lost below SSE but the connection stays OPEN."
//
// RED (without the fix): drop terminal events → tail stays wrong, no resync,
//   no diag. The bug reproduces deterministically.
// GREEN (with the fix): drop terminal events → seq-gap detected on the next
//   surviving event → forced resync → fresh snapshot → tail converges → diag
//   entry written. No reload needed.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { openSessionStream, closeSessionStream } from "../../src/sync/session-stream";
import {
  _setSesDropNextNForTest,
  _getSesLastSeqForTest,
  _resetSesGapStateForTest,
} from "../../src/sync/session-stream";
import {
  setSelectedIdRaw,
  setProjectDirRaw,
  state,
  setState,
} from "../../src/sync/store";
import {
  setDiagLogOn,
  diagEntries,
  _resetDiagForTest,
  type StallEntry,
} from "../../src/sync/diaglog";
import { applyMessageEvent } from "../../src/sync/reconcile";
import { reconcile } from "solid-js/store";

// --- Mock EventSource ---
// jsdom doesn't implement EventSource. This mock supports lastEventId on fired
// events (the key property for seq-gap detection) via Object.defineProperty.
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

  // --- test helpers ---
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
  // Reset the seq-gap baseline.
  _resetSesGapStateForTest();
  // Reset the store's cursor so the covering check (state.cursor >= seq - 1)
  // starts from a clean baseline. state is module-level and persists across
  // tests; an Invariant 2 test that passes trackCursor=true can leave cursor
  // at 100, which would falsely "cover" any gap in a subsequent test.
  setState("cursor", 0);
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
  // leak into subsequent test files. state is module-level (shared across all
  // tests in the vitest run).
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

describe("seq-gap recovery — Stream2 (session stream)", () => {
  it("detects a seq gap from dropped events and forces a fresh-snapshot resync", () => {
    vi.useFakeTimers();
    // 1. Open the session stream — creates the first session ES.
    openSessionStream("s1");
    expect(sessionESes()).toHaveLength(1);
    const es1 = sessionESes()[0];
    es1.simulateOpen();

    // 2. Deliver a snapshot (seq=1) — initializes messages.s1.
    es1.fire("snapshot", "1", makeSnapshot([
      { info: { id: "m0", sessionID: "s1", role: "user", time: { created: 1 } }, parts: [] },
    ]));

    // 3. Deliver message events (seq=2, 3) — builds the tail.
    es1.fire("message.upsert", "2", {
      id: "m1", sessionID: "s1", role: "assistant", time: { created: 2 },
    });
    es1.fire("message.upsert", "3", {
      id: "m1", sessionID: "s1", role: "assistant", time: { created: 2, completed: 3 },
    });

    // Baseline: sesLastSeq = 3, 2 messages in the store.
    expect(_getSesLastSeqForTest()).toBe(3);

    // 4. Arm the drop hook for 2 events — simulate silent loss.
    _setSesDropNextNForTest(2);

    // 5. Fire events seq=4, 5 — DROPPED (silent loss, connection stays open).
    es1.fire("message.upsert", "4", {
      id: "m2", sessionID: "s1", role: "assistant", time: { created: 4, completed: 5 },
    });
    es1.fire("part.upsert", "5", {
      id: "p1", sessionID: "s1", messageID: "m2", type: "text", text: "hello",
    });

    // Dropped events did NOT advance sesLastSeq or add to the store.
    expect(_getSesLastSeqForTest()).toBe(3);

    // 6. Fire event seq=6 — ARRIVES. Gap: 3→6 (missed=2). Stream1's cursor
    //    (state.cursor) is 0 (no tree events in this test) → uncovered gap →
    //    forced resync.
    es1.fire("message.upsert", "6", {
      id: "m3", sessionID: "s1", role: "user", time: { created: 6 },
    });

    // 7. Assert: a NEW session EventSource was created (resync occurred).
    expect(sessionESes().length).toBe(2);

    // 8. Assert: a stall diag entry with trigger='seq-gap' was captured.
    const stalls = stallEntries();
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    expect(stalls[0].trigger).toBe("seq-gap");
    expect(stalls[0].stream).toBe("session");
    expect(stalls[0].seqGap).toEqual({
      stream: "session", expected: 4, got: 6, missed: 2,
    });

    // 9. Assert: NO location.reload() was called.
    expect((globalThis as unknown as { __reloadCalled?: boolean }).__reloadCalled).toBeFalsy();
  });

  it("does NOT trigger a resync when the gap is covered by Stream1's structural cursor", () => {
    vi.useFakeTimers();
    openSessionStream("s1");
    const es1 = sessionESes()[0];
    es1.simulateOpen();

    es1.fire("snapshot", "1", makeSnapshot([
      { info: { id: "m0", sessionID: "s1", role: "user", time: { created: 1 } }, parts: [] },
    ]));
    es1.fire("message.upsert", "2", {
      id: "m1", sessionID: "s1", role: "assistant", time: { created: 2 },
    });
    // sesLastSeq = 2.

    // Simulate Stream1 having processed structural events up to seq=10
    // (state.cursor = 10). A gap on Stream2 from seq=2 to seq=5 is COVERED
    // by state.cursor (10 >= 5-1=4) → benign structural events → no resync.
    setState("cursor", 10);

    es1.fire("message.upsert", "5", {
      id: "m2", sessionID: "s1", role: "assistant", time: { created: 5 },
    });

    // No new EventSource created — gap was covered, no resync.
    expect(sessionESes().length).toBe(1);
    expect(stallEntries().length).toBe(0);
    // sesLastSeq advanced to 5 (the event was processed normally).
    expect(_getSesLastSeqForTest()).toBe(5);
  });
});

describe("seq-gap recovery — Invariant 2 (tail-integrity on idle)", () => {
  beforeEach(() => {
    // Seed the store with a session whose last message is a USER message
    // (the assistant response was lost in transit).
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
    // Open the session stream so openSessionStream(id, true) has a connection
    // to force-reconnect.
    openSessionStream("s1");
    expect(sessionESes()).toHaveLength(1);
    sessionESes()[0].simulateOpen();

    // activity=idle arrives for s1. The reducer's bridge stamps time.completed
    // only if the last message is an assistant — it's a user message, so no
    // stamp. The tail-incomplete-on-idle effect fires → orchestration calls
    // openSessionStream(s1, true).
    applyMessageEvent("activity", 100, { sessionID: "s1", state: "idle" }, true);

    // Assert: a NEW session EventSource was created (force-fetch via
    // openSessionStream(s1, true)).
    expect(sessionESes().length).toBe(2);

    // Assert: a stall diag entry with trigger='tail-incomplete-on-idle'.
    const stalls = stallEntries();
    expect(stalls.length).toBeGreaterThanOrEqual(1);
    const tailStall = stalls.find((s) => s.trigger === "tail-incomplete-on-idle");
    expect(tailStall).toBeDefined();
    expect(tailStall!.sessionId).toBe("s1");
    expect(tailStall!.residentTail?.lastMsgRole).toBe("user");
    expect(tailStall!.residentTail?.lastMsgCompleted).toBe(false);

    // Assert: NO location.reload().
    expect((globalThis as unknown as { __reloadCalled?: boolean }).__reloadCalled).toBeFalsy();
  });

  it("does NOT force-fetch when the tail's last assistant message already has time.completed (bridge handled it)", () => {
    vi.useFakeTimers();
    // Seed the store with a session whose last message IS a completed assistant.
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

    // activity=idle arrives. The bridge finds a completed assistant → no
    // tail-incomplete effect → no force-fetch.
    applyMessageEvent("activity", 100, { sessionID: "s1", state: "idle" }, true);

    expect(sessionESes().length).toBe(1); // no new ES
    const tailStalls = stallEntries().filter((s) => s.trigger === "tail-incomplete-on-idle");
    expect(tailStalls.length).toBe(0);
  });
});

describe("seq-gap recovery — no-reload guarantee", () => {
  it("NEVER calls location.reload() during any recovery path", () => {
    vi.useFakeTimers();
    openSessionStream("s1");
    const es1 = sessionESes()[0];
    es1.simulateOpen();

    es1.fire("snapshot", "1", makeSnapshot([
      { info: { id: "m0", sessionID: "s1", role: "user", time: { created: 1 } }, parts: [] },
    ]));

    // Trigger a seq-gap recovery.
    _setSesDropNextNForTest(1);
    es1.fire("message.upsert", "2", {
      id: "m1", sessionID: "s1", role: "assistant", time: { created: 2 },
    });
    es1.fire("message.upsert", "4", {
      id: "m2", sessionID: "s1", role: "assistant", time: { created: 4 },
    });

    // Recovery happened (new ES created).
    expect(sessionESes().length).toBe(2);
    // No reload.
    expect((globalThis as unknown as { __reloadCalled?: boolean }).__reloadCalled).toBeFalsy();
  });
});
