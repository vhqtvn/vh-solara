// @vitest-environment jsdom
//
// streamOpenDiag.test.ts — PWA warm-resume stream-open diagnostics
// (card task-2026-10-28t15-08-16-pwa-resume-diagnostics-capture-instrumentation).
//
// LOGGING-ONLY contract under test:
//  1. Every tree/session EventSource construction records one stream-open
//     diag entry carrying the closed reason enum + cursor semantics — but
//     ONLY when the (default-OFF) diaglog capture flag is on; the
//     window.__vhSyncDiag mirror counts are ALWAYS on.
//  2. Content-progress stamps complete on the SAME record object (ring holds
//     the reference; identity is asserted, not shape).
//  3. EventSource lifecycle (onopen/onerror + readyState) is logged bounded
//     per connection generation, so a NATIVE retry (onerror CONNECTING, no
//     new stream-open) is distinguishable from a JS-owned open.
//  4. The diag ring stays bounded under an open burst (existing caps).
//  5. (B-F3, deferred from the diagnostics-slice review — closed by the
//     cursor-loss-fix card) the REAL scheduled retry callbacks execute under
//     fake timers: the tree CLOSED backoff (tree-transport) and the session
//     retry ladder (session-stream) re-open through their own timers,
//     carrying the preserved cursor and emitting their stream-open reason —
//     no substituted direct openSessionStream/connect calls.
//
// Harness mirrors coherentBarrierReloadRace.test.ts (MockEventSource +
// resetModules + raw store setters). Real timers.
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

  fireError(readyState: number): void {
    this.readyState = readyState;
    this.onerror?.();
  }
}

let instances: MockEventSource[] = [];
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => /sessions=[^&]/.test(e.url));
const treeESes = (): MockEventSource[] =>
  instances.filter((e) => e.readyState !== CLOSED && !/sessions=[^&]/.test(e.url));

let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
let diaglog: typeof import("../../src/sync/diaglog") = null as unknown as typeof import("../../src/sync/diaglog");
let sod: typeof import("../../src/sync/stream-open-diag") = null as unknown as typeof import("../../src/sync/stream-open-diag");
let rr: typeof import("../../src/sync/recovery-reasons") = null as unknown as typeof import("../../src/sync/recovery-reasons");
let treeTransport: typeof import("../../src/sync/tree-transport") = null as unknown as typeof import("../../src/sync/tree-transport");
let sessionStream: typeof import("../../src/sync/session-stream") = null as unknown as typeof import("../../src/sync/session-stream");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  diaglog = await import("../../src/sync/diaglog");
  sod = await import("../../src/sync/stream-open-diag");
  rr = await import("../../src/sync/recovery-reasons");
  treeTransport = await import("../../src/sync/tree-transport");
  sessionStream = await import("../../src/sync/session-stream");
  store.setProjectDirRaw("/test");
  store.setSelectedIdRaw("s1");
}

const tick = async (n = 1): Promise<void> => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0));
};

const openEntries = () =>
  diaglog.diagEntries().filter((e) => e.kind === "stream-open");
const lifeEntries = () =>
  diaglog.diagEntries().filter((e) => e.kind === "es-life");

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
  sessionStream?.closeSessionStream();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe("stream-open diag — default OFF ring, ALWAYS-ON counter mirror", () => {
  it("records NOTHING in the ring when capture is off, but counts the mirror", () => {
    stream.connect(false, "watchdog", "watchdog-closed");
    stream.openSessionStream("s1", false, "selection-change", "selection-follow");
    expect(diaglog.diagEntries()).toEqual([]);
    const mirror = rr.readSyncDiag().streamOpens;
    expect(mirror.tree?.["watchdog"]?.count).toBe(1);
    expect(mirror.session?.["selection-change"]?.count).toBe(1);
  });

  it("records one stream-open entry per construction when capture is on", () => {
    diaglog.setDiagLogOn(true);
    stream.connect(false, "watchdog", "watchdog-closed");
    const treeRec = openEntries()[0];
    expect(treeRec.kind).toBe("stream-open");
    if (treeRec.kind !== "stream-open") return;
    expect(treeRec.stream).toBe("tree");
    expect(treeRec.reason).toBe("watchdog");
    expect(treeRec.detail).toBe("watchdog-closed");
    expect(treeRec.generation).toBe(treeTransport.getTreeGen());
    expect(treeRec.hadCursor).toBe(false);

    stream.openSessionStream("s1", false, "first-open", "boot");
    const sesRec = openEntries()[1];
    if (sesRec.kind !== "stream-open") return;
    expect(sesRec.stream).toBe("session");
    expect(sesRec.reason).toBe("first-open");
    expect(sesRec.sessionId).toBe("s1");
    expect(sesRec.cursor).toBe(0);
    expect(sesRec.hadCursor).toBe(false);
    // Identity: the tracker's current record IS the ring entry.
    expect(sod._currentRecordForTest("session")).toBe(sesRec);
  });

  it("untagged callers land on the explicit 'other' (no untagged opens)", () => {
    diaglog.setDiagLogOn(true);
    stream.connect(); // no reason args — the safety net
    const rec = openEntries()[0];
    if (rec.kind !== "stream-open") return;
    expect(rec.reason).toBe("other");
  });
});

describe("stream-open diag — cursor semantics on the record", () => {
  it("a cursor-carrying tree open records cursor + hadCursor", async () => {
    diaglog.setDiagLogOn(true);
    store.setState("cursor", 521072);
    stream.connect(false, "reveal-resume", "visibility-reveal");
    const rec = openEntries()[openEntries().length - 1];
    if (rec.kind !== "stream-open") return;
    expect(rec.cursor).toBe(521072);
    expect(rec.hadCursor).toBe(true);
  });

  it("a cursor-carrying session reopen preserves sesCursor on the record", async () => {
    diaglog.setDiagLogOn(true);
    stream.openSessionStream("s1");
    const ses = sessionESes()[0];
    ses.fire("snapshot", { seq: 7, sessions: [] }, "7.1");
    await tick(2);
    // Reopen through the preserving seam (B5 shape): sesCursor survives.
    sessionStream.reopenSessionStreamPreservingCursor("watchdog", "sentinel-timeout");
    const rec = openEntries()[openEntries().length - 1];
    if (rec.kind !== "stream-open") return;
    expect(rec.cursor).toBe(7);
    expect(rec.hadCursor).toBe(true);
    expect(rec.reason).toBe("watchdog");
    expect(rec.detail).toBe("sentinel-timeout");
    // The watchdog-preserving seam ARMS the silence fallback → stamped on the
    // SAME record it just created (fallbackArmed).
    expect(rec.fallbackArmed).toBe(true);
  });
});

describe("stream-open diag — stamps complete on the SAME record", () => {
  it("session: onopen + snapshot frame + snapshot apply stamp the open record", async () => {
    diaglog.setDiagLogOn(true);
    stream.openSessionStream("s1");
    const ses = sessionESes()[0];
    const rec = sod._currentRecordForTest("session");
    expect(rec).toBeTruthy();
    ses.simulateOpen();
    expect(rec!.openTs).toBeGreaterThan(0);
    ses.fire("snapshot", { seq: 3, sessions: [] }, "3.1");
    await tick(2);
    expect(rec!.firstFrameTs).toBeGreaterThan(0);
    expect(rec!.firstSnapshotTs).toBeGreaterThan(0);
    expect(rec!.snapshotAppliedTs).toBeGreaterThan(0);
    // Session stream has NO replay-complete milestone (S0 gate (b)) — the
    // field must stay undefined on the session record.
    expect(rec!.replayDoneTs).toBeUndefined();
    // The ring entry is the same object the stamps mutated.
    const ringRec = openEntries().find((e) => e.kind === "stream-open");
    expect(ringRec).toBe(rec);
  });

  it("tree: snapshot.complete stamps replayDoneTs; snapshot applies stamp snapshotAppliedTs", async () => {
    diaglog.setDiagLogOn(true);
    stream.connect(true, "first-open", "boot");
    const es = treeESes()[0];
    const rec = sod._currentRecordForTest("tree");
    expect(rec).toBeTruthy();
    es.simulateOpen();
    expect(rec!.openTs).toBeGreaterThan(0);
    // A raw detail snapshot (no epoch → independent apply path).
    es.fire("snapshot", { seq: 4, sessions: [] }, "4.0");
    await tick(2);
    expect(rec!.firstFrameTs).toBeGreaterThan(0);
    expect(rec!.firstSnapshotTs).toBeGreaterThan(0);
    expect(rec!.snapshotAppliedTs).toBeGreaterThan(0);
    // The tree's truthful boundary: snapshot.complete → replayDoneTs.
    es.fire("snapshot.complete", { epoch: "e1", revision: 4, projections: ["tree", "detail"] }, "4.0");
    await tick(1);
    expect(rec!.replayDoneTs).toBeGreaterThan(0);
  });
});

describe("stream-open diag — EventSource lifecycle observability (A3 discriminator)", () => {
  it("native CONNECTING retries appear as es-life records WITHOUT a new stream-open", () => {
    diaglog.setDiagLogOn(true);
    stream.connect(false, "reveal-resume", "visibility-reveal");
    const es = treeESes()[0];
    const opensBefore = openEntries().length;
    // A frozen-socket thaw: the SAME EventSource fires CONNECTING errors —
    // the browser's native auto-retry — without any JS construction. (Two
    // attempts stay under TREE_CONNECTING_GIVEUP=3 so no manual-backoff timer
    // is scheduled by the takeover path — this test observes only.)
    for (let i = 0; i < 2; i++) es.fireError(CONNECTING);
    // Bounded: the first error of the generation is always logged; the
    // second inside the 30 s gap window is suppressed.
    const errs = lifeEntries().filter((e) => e.kind === "es-life" && e.phase === "onerror");
    expect(errs.length).toBe(1);
    const first = errs[0];
    if (first.kind !== "es-life") return;
    expect(first.readyState).toBe(CONNECTING);
    expect(first.attempt).toBe(1);
    // The discriminator: error/life activity with NO new construction.
    expect(openEntries().length).toBe(opensBefore);
    // onopen still logs (≥1 per generation).
    es.simulateOpen();
    expect(
      lifeEntries().filter((e) => e.kind === "es-life" && e.phase === "onopen").length,
    ).toBe(1);
  });

  it("a JS-owned reopen after CLOSED creates a NEW stream-open record (vs the native retry)", () => {
    diaglog.setDiagLogOn(true);
    stream.openSessionStream("s1", false, "first-open", "boot");
    const ses = sessionESes()[0];
    ses.fireError(CONNECTING);
    ses.fireError(CLOSED);
    const opensBefore = openEntries().length;
    // The manual retry-ladder reopen (what the CLOSED handler schedules).
    stream.openSessionStream("s1", true, "retry-ladder", "closed-retry");
    const rec = openEntries()[openEntries().length - 1];
    if (rec.kind !== "stream-open") return;
    expect(rec.reason).toBe("retry-ladder");
    expect(openEntries().length).toBe(opensBefore + 1);
  });

  // B-F3 (deferred from the diagnostics-slice review): the two tests above
  // SUBSTITUTE a direct openSessionStream call for the scheduled retry. These
  // execute the REAL scheduled retry callbacks under fake timers and assert
  // the re-open's wire shape (URL cursor) + the emitted stream-open record.
  describe("the REAL scheduled retry callbacks (B-F3)", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
    });

    it("session retry ladder: the scheduled closed-retry reopens with the preserved cursor", async () => {
      diaglog.setDiagLogOn(true);
      stream.openSessionStream("s1", false, "first-open", "boot");
      const ses = sessionESes()[0];
      // A raw snapshot applies synchronously → sesCursor = 7.
      ses.fire("snapshot", { seq: 7, sessions: [] }, "7.1");
      const firstRec = openEntries()[openEntries().length - 1];
      const opensBefore = openEntries().length;

      ses.fireError(CLOSED); // onerror CLOSED → sesRetry scheduled at sesBackoff=1500
      // Just before the ladder fires: no new construction, no new record.
      vi.advanceTimersByTime(1499);
      expect(sessionESes()).toHaveLength(1);
      expect(openEntries()).toHaveLength(opensBefore);
      // Cross the boundary: the REAL openSessionES("retry-ladder",
      // "closed-retry") runs from the timer.
      vi.advanceTimersByTime(1);
      expect(sessionESes()).toHaveLength(2);
      expect(sessionESes()[1].url).toContain("cursor=7"); // preserved cursor

      const rec = openEntries()[openEntries().length - 1];
      expect(rec.kind).toBe("stream-open");
      if (rec.kind !== "stream-open") return;
      expect(rec.stream).toBe("session");
      expect(rec.reason).toBe("retry-ladder");
      expect(rec.detail).toBe("closed-retry");
      expect(rec.cursor).toBe(7);
      expect(rec.hadCursor).toBe(true);
      expect(rec.generation).toBeGreaterThan(
        firstRec.kind === "stream-open" ? firstRec.generation : 0,
      );
    });

    // F10 (round-2 review, deferred → closed): composition proof that the B13
    // retry ladder restores the cursor from the per-session MEMORY (the
    // cursor-loss fix) when the live cursor was zeroed — snapshot applied
    // (memory=100) → cursorless recovery with NO delivery (live=0) → CLOSED
    // on that connection → advance past sesBackoff → the scheduled retry ES
    // carries cursor=100. Pre-fix this open sent cursor=0 (the parked defect
    // shape the fix exists to kill).
    it("B13 retry ladder restores the cursor from MEMORY when the live cursor was zeroed (cursor-loss fix)", async () => {
      diaglog.setDiagLogOn(true);
      // Raw session snapshot carrying m1 — applies synchronously, advancing
      // the per-session cursor memory to 100.
      const rawSessionSnap = (seq: number, id: string, msgID: string): any => ({
        seq,
        gate: { [id]: { messagesLoaded: true } },
        messages: {
          [id]: [{ info: { id: msgID, sessionID: id, role: "assistant", time: { created: 1 } }, parts: [] }],
        },
      });
      stream.openSessionStream("s1", false, "first-open", "boot");
      sessionESes()[0].fire("snapshot", rawSessionSnap(100, "s1", "m1"), "100.1");

      // Forced cursorless recovery, NO delivery → the live sesCursor parks at
      // 0 (closeSessionStream zeroed it; nothing arrived to re-advance it).
      stream.openSessionStream("s1", true, "recovery-fresh", "f10-zeroing");
      const es1 = sessionESes()[1];
      expect(es1).toBeDefined();
      expect(es1).not.toBe(sessionESes()[0]);

      // Fatal CLOSED on the recovery connection → the manual retry ladder is
      // scheduled at sesBackoff (1500, reset by the recovery's close).
      es1.fireError(CLOSED);
      vi.advanceTimersByTime(1499);
      expect(sessionESes()).toHaveLength(2); // nothing yet — the ladder owns the reopen
      vi.advanceTimersByTime(1); // cross sesBackoff
      expect(sessionESes()).toHaveLength(3);
      const es2 = sessionESes()[2];
      expect(es2).not.toBe(es1);
      // The LIVE cursor is 0 — this cursor can come ONLY from the memory.
      expect(es2.url).toContain("cursor=100");

      const rec = openEntries()[openEntries().length - 1];
      expect(rec.kind).toBe("stream-open");
      if (rec.kind !== "stream-open") return;
      expect(rec.stream).toBe("session");
      expect(rec.reason).toBe("retry-ladder");
      expect(rec.detail).toBe("closed-retry");
      expect(rec.cursor).toBe(100);
      expect(rec.hadCursor).toBe(true);
    });

    it("tree CLOSED backoff: the scheduled closed-backoff reconnect re-carries the store cursor", async () => {
      diaglog.setDiagLogOn(true);
      stream.connect(false, "first-open", "boot");
      const allTree = () => instances.filter((e) => !/sessions=[^&]/.test(e.url));
      const es = allTree()[0];
      es.simulateOpen();
      // Advance the SHARED store cursor via a live tree event (session.upsert
      // seq 42 → state.cursor=42, trackCursor=true — Stream1 owns it).
      es.fire("session.upsert", { id: "s1" }, "42.1");
      await vi.advanceTimersByTimeAsync(0);
      const opensBefore = openEntries().length;

      es.fireError(CLOSED); // onerror CLOSED → reconnectTimer at backoff=1000
      vi.advanceTimersByTime(999);
      expect(allTree()).toHaveLength(1);
      expect(openEntries()).toHaveLength(opensBefore);
      vi.advanceTimersByTime(1);
      // The REAL connect(false, "onerror-backoff", "closed-backoff") ran.
      expect(allTree()).toHaveLength(2);
      const es2 = allTree()[1];
      expect(es2).not.toBe(es);
      expect(es2.url).toContain("cursor=42"); // cursor-PRESERVING reconnect

      const rec = openEntries()[openEntries().length - 1];
      expect(rec.kind).toBe("stream-open");
      if (rec.kind !== "stream-open") return;
      expect(rec.stream).toBe("tree");
      expect(rec.reason).toBe("onerror-backoff");
      expect(rec.detail).toBe("closed-backoff");
      expect(rec.cursor).toBe(42);
      expect(rec.hadCursor).toBe(true);
    });
  });
});

describe("stream-open diag — bounded ring under an open burst", () => {
  it("an open burst cannot grow the ring past MAX_DIAG_ENTRIES", () => {
    diaglog.setDiagLogOn(true);
    for (let i = 0; i < diaglog.MAX_DIAG_ENTRIES + 20; i++) {
      stream.connect(false, "watchdog", "watchdog-closed");
    }
    expect(diaglog.diagEntries().length).toBeLessThanOrEqual(diaglog.MAX_DIAG_ENTRIES);
    // The mirror counted every open (census is unbounded-by-design, ring is not).
    expect(rr.readSyncDiag().streamOpens.tree?.["watchdog"]?.count).toBe(
      diaglog.MAX_DIAG_ENTRIES + 20,
    );
  });
});

describe("stream-open diag — entryLine rendering for capture retrieval", () => {
  it("renders stream-open and es-life lines with the attribution fields", () => {
    diaglog.setDiagLogOn(true);
    stream.connect(false, "watchdog", "watchdog-closed");
    const es = treeESes()[0];
    es.fireError(CONNECTING);
    const lines = diaglog.diagEntries().map(diaglog.entryLine).join("\n");
    expect(lines).toContain("stream-open stream=tree reason=watchdog");
    expect(lines).toContain("detail=watchdog-closed");
    expect(lines).toContain("es-life stream=tree");
    expect(lines).toContain("onerror readyState=0");
  });
});
