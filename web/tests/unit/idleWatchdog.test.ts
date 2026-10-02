// @vitest-environment jsdom
//
// Slice 3 (webperf build1): IDLE-AWARE WATCHDOG — the state machine that stops
// a healthy idle pane from forcing periodic recovery while keeping an ACTIVE
// pane fully covered by the existing watchdog.
//
// CONTRACT under test:
//   (a) IDLE session (not sessionWorking) + content clock aged past
//       CONTENT_STALE_MS → NO forced reconnect; counted as
//       `idle-content-stale-skipped` (per skipped tick).
//   (b) BUSY session + aged content clock → forced reconnect EXACTLY as
//       before (cursorless fresh snapshot; `idle-content-stale` counted).
//   (c) idle→busy EDGE on a closed / content-aged (zombie) stream →
//       cursor-preserving reopen through the retry seam (URL carries the
//       preserved cursor; `busy-edge-rearm` counted); fresh-content stream →
//       no reopen; hidden (suspended) pane → no reopen.
//   (d) IDLE tree (nothing running anywhere) + aged treeContentSeen → NO tree
//       force; `tree-idle-stale-skipped` counted.
//   (e) ACTIVE tree (something running) + aged treeContentSeen → tree force
//       fires exactly as before (`tree-idle-stale` counted).
//   (f) TRANSPORT-stale is never idle-gated: a session whose pings STOPPED
//       forces a reconnect even while idle (dead socket ≠ expected silence).
//
// Harness mirrors visibilityLifecycle.test.ts / sessionLivenessContentStall
// .test.ts (MockEventSource + setupFresh with vi.resetModules; the busy-edge
// watcher is armed through the same stream.ts facade shim startSync uses).
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
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => /sessions=[^&]/.test(e.url));
const treeESes = (): MockEventSource[] =>
  instances.filter((e) => !/sessions=[^&]/.test(e.url));

let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
let counters: typeof import("../../src/sync/recovery-reasons") = null as unknown as typeof import("../../src/sync/recovery-reasons");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  instances = [];
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  counters = await import("../../src/sync/recovery-reasons");
  store.setProjectDirRaw("/test");
  store.setSelectedIdRaw("s1");
  // Arm the busy-edge watcher exactly as startSync does (slice 3).
  stream.startBusyEdgeRearm();
}

beforeEach(async () => {
  (globalThis as unknown as { EventSource: unknown }).EventSource = MockEventSource;
  // Slice 5 (webperf): the fetch stub answers 404 — the OLD-WORKER posture.
  // The liveness sentinel memos capability-unavailable and the watchdog runs
  // the LEGACY heuristics this suite pins byte-for-byte (idle-skip /
  // active-force). The capability-confirmed outcomes (probe → proven-alive /
  // timeout → cursor-preserving recovery / whichever-first nonce
  // correlation) live in sentinel.test.ts.
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(new Response("{}", { status: 404 })),
  );
  window.localStorage.clear();
  Object.defineProperty(document, "visibilityState", {
    value: "visible",
    configurable: true,
  });
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

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
};

const sessionSnapshot = (seq: number, id = "s1") => ({
  seq,
  gate: { [id]: { messagesLoaded: true } },
  messages: {},
});
const treeSnapshot = (seq: number, sessionIds: string[] = ["s1"]) => ({
  seq,
  sessions: sessionIds.map((id) => ({ id })),
});

describe("(a) idle session: content-stale watchdog SKIPS the force", () => {
  it("pings flow, zero content past CONTENT_STALE_MS → NO reconnect, skipped counted, forced code absent", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await flush();
    sessionESes()[0].fire("snapshot", sessionSnapshot(1), "1");
    await flush();

    // 9 cycles × 15s = 135s > 120s with pings only on the session; the tree
    // control keeps flowing content so it stays healthy (and idle-skipped is
    // only asserted on the session side here).
    for (let cycle = 0; cycle < 9; cycle++) {
      vi.advanceTimersByTime(15_000);
      treeESes()[0].fire("ping");
      treeESes()[0].fire("snapshot", treeSnapshot(cycle + 2), String(cycle + 2));
      sessionESes()[0].fire("ping"); // transport alive, content silent
      stream.watchdogTick();
      // Slice 5: settle the sentinel probe's 404 .then (microtask) so the
      // legacy fallback decision lands within the same cycle.
      await flush();
    }

    // The idle session did NOT force a reconnect.
    expect(sessionESes()).toHaveLength(1);
    const d = counters.readSyncDiag();
    expect(d.recovery["idle-content-stale"]).toBeUndefined(); // forced code frozen
    expect((d.recovery["idle-content-stale-skipped"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
  });
});

describe("(b) busy session: content-stale watchdog forces EXACTLY as before", () => {
  it("busy (state.activity=busy) + zero content past CONTENT_STALE_MS → forced cursorless reconnect", async () => {
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await flush();
    sessionESes()[0].fire("snapshot", sessionSnapshot(1), "1");
    await flush();
    // Make the session BUSY (the frozen-session scenario the watchdog protects).
    store.setState("activity", "s1", "busy");
    await flush();
    // The busy-edge re-arm must NOT have acted: the stream just delivered
    // content (fresh content clock) → presumed healthy.
    expect(sessionESes()).toHaveLength(1);

    for (let cycle = 0; cycle < 9; cycle++) {
      vi.advanceTimersByTime(15_000);
      sessionESes()[0].fire("ping");
      stream.watchdogTick();
      await flush(); // settle the 404 .then (slice-5 legacy fallback)
    }

    expect(sessionESes()).toHaveLength(2);
    // The force path is today's: openSessionStream(id, true) → cursorless.
    expect(sessionESes()[1].url).not.toMatch(/cursor=/);
    const d = counters.readSyncDiag();
    expect((d.recovery["idle-content-stale"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
    expect(d.recovery["idle-content-stale-skipped"]).toBeUndefined();
  });
});

describe("(c) idle→busy edge: cursor-preserving re-arm", () => {
  it("closed stream + busy edge → reopen ONCE with preserved cursor (ring replay, NOT cursorless snapshot)", async () => {
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await flush();
    sessionESes()[0].fire("snapshot", sessionSnapshot(5), "100.0");
    await flush();
    // sesCursor = 100 (last applied globalSeq). The stream "died" while idle:
    // externally closed (fatal error posture) with a pending backoff retry.
    sessionESes()[0].close();
    sessionESes()[0].onerror?.();

    // The busy edge: the operator prompts (activity flips busy via the tree).
    store.setState("activity", "s1", "busy");
    await flush();

    // Reopened exactly once, THROUGH the retry seam: cursor preserved → ring
    // replay branch, never the cursorless full-snapshot path.
    expect(sessionESes()).toHaveLength(2);
    expect(sessionESes()[1].url).toContain("cursor=100");
    expect(sessionESes()[0].readyState).toBe(CLOSED); // old connection torn down
    // UI honesty: the reopen re-arms the per-session refresh indicator.
    expect(store.state.refreshing["s1"]).toBe(true);
    const d = counters.readSyncDiag();
    expect(d.recovery["busy-edge-rearm"]?.count).toBe(1);
  });

  it("OPEN but content-aged (zombie) stream + busy edge → cursor-preserving reopen", async () => {
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await flush();
    sessionESes()[0].fire("snapshot", sessionSnapshot(5), "100.0");
    await flush();

    // Idle silence past CONTENT_STALE_MS while the socket stays "open".
    vi.advanceTimersByTime(130_000);
    sessionESes()[0].fire("ping"); // pings still flow — the ping-mask posture

    store.setState("activity", "s1", "busy");
    await flush();

    expect(sessionESes()).toHaveLength(2);
    expect(sessionESes()[1].url).toContain("cursor=100");
    const d = counters.readSyncDiag();
    expect(d.recovery["busy-edge-rearm"]?.count).toBe(1);
  });

  it("FRESH content (busy→idle→busy flutter) → edge fires but NO reopen (presumed healthy)", async () => {
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await flush();
    sessionESes()[0].fire("snapshot", sessionSnapshot(5), "100.0");
    await flush();

    store.setState("activity", "s1", "busy"); // edge; content fresh
    await flush();
    store.setState("activity", "s1", "idle");
    await flush();
    store.setState("activity", "s1", "busy"); // edge again; content still fresh
    await flush();

    expect(sessionESes()).toHaveLength(1);
    const d = counters.readSyncDiag();
    expect(d.recovery["busy-edge-rearm"]).toBeUndefined();
  });

  it("host-hidden (suspended) pane: busy edge does NOT reopen — the reveal owns it", async () => {
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await flush();
    sessionESes()[0].fire("snapshot", sessionSnapshot(5), "100.0");
    await flush();
    // Suspend the pane's streams (the facade's hide path — cursor preserved).
    stream.suspendSessionStreamForVisibility();
    expect(sessionESes()[0].readyState).toBe(CLOSED);

    // A busy edge observed while hidden (e.g. a store write from a raced
    // frame) must not reopen the suspended pane's stream — the reveal
    // (resumeSessionStreamForVisibility) owns reopening it.
    store.setState("activity", "s1", "busy");
    await flush();
    expect(sessionESes()).toHaveLength(1); // no new EventSource
  });
});

describe("(d) idle tree: content-stale watchdog SKIPS the force", () => {
  it("pings flow, zero tree content past CONTENT_STALE_MS, nothing running → NO reconnect", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();
    treeESes()[0].fire("snapshot", treeSnapshot(1), "1");
    await flush();

    for (let cycle = 0; cycle < 9; cycle++) {
      vi.advanceTimersByTime(15_000);
      treeESes()[0].fire("ping"); // transport alive, content silent
      stream.watchdogTick();
      await flush(); // settle the 404 .then (slice-5 legacy fallback)
    }

    expect(treeESes()).toHaveLength(1);
    const d = counters.readSyncDiag();
    expect(d.recovery["tree-idle-stale"]).toBeUndefined(); // forced code frozen
    expect((d.recovery["tree-idle-stale-skipped"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
  });
});

describe("(e) active tree: content-stale watchdog forces EXACTLY as before", () => {
  it("something running (state.activity busy) + zero tree content past CONTENT_STALE_MS → forced reconnect", async () => {
    stream.connect();
    treeESes()[0].simulateOpen();
    treeESes()[0].fire("snapshot", treeSnapshot(1), "1");
    await flush();
    store.setState("activity", "s1", "busy"); // anySessionActive() → true
    await flush();

    for (let cycle = 0; cycle < 9; cycle++) {
      vi.advanceTimersByTime(15_000);
      treeESes()[0].fire("ping");
      stream.watchdogTick();
      await flush(); // settle the 404 .then (slice-5 legacy fallback)
    }

    expect(treeESes()).toHaveLength(2);
    const d = counters.readSyncDiag();
    expect((d.recovery["tree-idle-stale"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
    expect(d.recovery["tree-idle-stale-skipped"]).toBeUndefined();
  });
});

describe("(f) transport-stale is never idle-gated", () => {
  it("idle session whose pings STOPPED still forces a reconnect (dead socket)", async () => {
    stream.openSessionStream("s1");
    sessionESes()[0].simulateOpen();
    await flush();
    sessionESes()[0].fire("snapshot", sessionSnapshot(1), "1");
    await flush();

    // Total silence (no pings, no content) past STALE_MS(45s) AND
    // CONTENT_STALE_MS(120s): both clocks age out; transport-stale dominates.
    vi.advanceTimersByTime(130_000);
    stream.watchdogTick();

    expect(sessionESes()).toHaveLength(2);
    const d = counters.readSyncDiag();
    expect((d.recovery["session-transport-stale"]?.count ?? 0)).toBeGreaterThanOrEqual(1);
    expect(d.recovery["idle-content-stale-skipped"]).toBeUndefined();
  });
});
