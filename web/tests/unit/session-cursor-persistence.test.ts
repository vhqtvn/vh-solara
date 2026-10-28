// @vitest-environment jsdom
//
// session-cursor-persistence.test.ts — the session-stream cursor-loss fix
// (card task-2026-10-28t17-34-52-pwa-session-cursor-loss-fix; capture-1
// interpretation §Q3: the recurring "second recovery" defect).
//
// DEFECT (observed 3×): closeSessionStream zeroes the live sesCursor at the
// START of every fresh open (B10 offset-mismatch / B12 silence-fallback / B6
// watchdog force / B13 retry all reach that state). If that open's
// authoritative snapshot never APPLIES — suspend raced it mid-flight (the
// sesGen guard discards the in-flight decode) or delivery never landed — the
// state parks at marker-set + sesCursor=0, and the next preserving open
// (B3 reveal-resume / B13 retry-ladder) sends cursor=0 → the worker ships a
// full cursorless session re-snapshot (the slow-resume cost driver).
//
// FIX under test: a per-session last-known cursor (module state, page-life
// scoped — NOT persisted) that advances ONLY on successfully APPLIED content
// and is sent by openSessionES in place of a live cursor of 0, EXCEPT for the
// deliberately-fresh recovery classes (force=true recoveries, the B12
// silence-fallback confirmation) whose repair requires the server's
// fresh-snapshot branch.
//
// INVARIANT (card-stated): any PRESERVING session-stream open in a page-life
// where content was previously applied carries a cursor ≥ the last applied
// cursor — never 0. (Deliberately-fresh opens stay cursorless by design;
// they are the recovery mechanism, not a violation.)
//
// Harness mirrors partAppendStreaming.test.ts (MockEventSource + resetModules
// + raw store setters + fake timers).
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { gzipSync } from "node:zlib";

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
    });
    Object.defineProperty(ev, "lastEventId", { value: lastEventId });
    const arr = this.listeners.get(type);
    if (arr) for (const fn of arr) fn(ev);
  }
  fireError(readyState: number): void {
    this.readyState = readyState;
    this.onerror?.();
  }
  simulateOpen(): void {
    this.readyState = OPEN;
    this.onopen?.();
  }
}

let instances: MockEventSource[] = [];
// ALL session EventSources ever constructed (including CLOSED ones) — cursor
// assertions reason over the full construction history.
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => /sessions=[^&]/.test(e.url));

let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
let sesMod: typeof import("../../src/sync/session-stream") = null as unknown as typeof import("../../src/sync/session-stream");
let cascade: typeof import("../../src/sync/cascade") = null as unknown as typeof import("../../src/sync/cascade");
let diaglog: typeof import("../../src/sync/diaglog") = null as unknown as typeof import("../../src/sync/diaglog");
let actions: typeof import("../../src/sync/actions") = null as unknown as typeof import("../../src/sync/actions");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  instances = [];
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  sesMod = await import("../../src/sync/session-stream");
  cascade = await import("../../src/sync/cascade");
  diaglog = await import("../../src/sync/diaglog");
  actions = await import("../../src/sync/actions");
  store.setProjectDirRaw("/test");
  store.setSelectedIdRaw("s1");
}

beforeEach(async () => {
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

// Pump the microtask queue (part.append flush is a queueMicrotask; fake
// timers do not fake microtasks).
const flushMicro = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

// A RAW session snapshot for `id` carrying message `msgID` (assistant, one
// empty part list). RAW → sync apply (no gzip64 decode).
// gate.messagesLoaded=true → marks delivered.
function rawSessionSnap(seq: number, id: string, msgID: string): any {
  return {
    seq,
    gate: { [id]: { messagesLoaded: true } },
    messages: {
      [id]: [{ info: { id: msgID, sessionID: id, role: "assistant", time: { created: 1 } }, parts: [] }],
    },
  };
}

const SID = "s1";

// The URL cursor an EventSource construction carried (0 = cursorless).
const urlCursor = (es: MockEventSource): number => {
  const m = /(?:^|\?|&)cursor=(\d+)/.exec(es.url);
  return m ? Number(m[1]) : 0;
};

const openEntries = () =>
  diaglog.diagEntries().filter((e) => e.kind === "stream-open");

describe("defect shape 1 — fresh-open-then-suspend WITHOUT apply → reveal sends last-known, not 0", () => {
  it("a cursorless recovery open raced by suspend parks at live 0; the B3 reveal restores last-known", async () => {
    diaglog.setDiagLogOn(true);
    // Page life begins: first open of s1 (cursorless), snapshot APPLIES.
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    expect(urlCursor(es0)).toBe(0); // B1 first-open: nothing streamed yet
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();

    // A cursorless recovery open (any fresh class — closeSessionStream zeroes
    // the live cursor) whose snapshot NEVER applies: deliver nothing, then
    // suspend mid-flight (the 17:08 capture shape).
    stream.openSessionStream(SID, true, "recovery-fresh", "test-zeroing");
    const es1 = sessionESes()[1];
    expect(urlCursor(es1)).toBe(0); // deliberately cursorless recovery
    sesMod.suspendSessionStreamForVisibility();
    expect(es1.readyState).toBe(CLOSED);
    // Parked state: suspended, marker set, LIVE cursor 0 — pre-fix, the next
    // open would send cursor=0 (the defect).

    // B3 reveal-resume through the retry seam.
    sesMod.resumeSessionStreamForVisibility();
    const es2 = sessionESes()[2];
    expect(sessionESes()).toHaveLength(3);
    expect(urlCursor(es2)).toBe(100); // RESTORED last-known — not 0

    // The diagnostics record reflects the restored value naturally
    // (b2d3d62 instrumentation constraint — no special-casing).
    const rec = openEntries()[openEntries().length - 1];
    expect(rec.kind).toBe("stream-open");
    if (rec.kind !== "stream-open") return;
    expect(rec.stream).toBe("session");
    expect(rec.reason).toBe("reveal-resume");
    expect(rec.detail).toBe("visibility-reveal");
    expect(rec.cursor).toBe(100);
    expect(rec.hadCursor).toBe(true);
  });

  it("a second hide→reveal cycle with no delivery restores the SAME last-known (idempotent restore)", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    sessionESes()[0].fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();
    // Zero the live cursor via a forced recovery, race it with suspend.
    stream.openSessionStream(SID, true, "recovery-fresh", "test-zeroing");
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    expect(urlCursor(sessionESes()[2])).toBe(100);
    // Another full cycle, still nothing delivered on the replacements.
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    expect(urlCursor(sessionESes()[3])).toBe(100);
  });
});

describe("defect shape 2 — REAL offset-mismatch (B10) zeroing → next preserving open sends last-known", () => {
  it("B10 fires cursorless (anti-livelock), and the post-B10 reveal carries the last APPLIED cursor — never the mismatched frame's seq", async () => {
    // Seed: snapshot seq 1 (m1 resident) + part.upsert seq 2 ("Hello", 5 bytes).
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(1, SID, "m1"), "1.1");
    es0.fire(
      "part.upsert",
      { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "Hello" },
      "2.1",
    );
    await flushMicro();

    // REAL B10: a part.append with a WRONG byte offset (field is 5 bytes,
    // start claims 3). The frame is RECEIVED (live sesCursor → 3) but its
    // content NEVER APPLIES — the memory must not advance to its seq.
    es0.fire(
      "part.append",
      { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 3, text: " world" },
      "3.1",
    );
    expect(sesMod._hasPendingAppendsForTest()).toBe(true);
    await flushMicro(); // flush → mismatch → cascade direct() → openSessionStream(sid, true)

    // The B10 recovery open is CURSORLESS by design: its realignment requires
    // the server's fresh-snapshot branch (a replay of the mismatching range
    // would mismatch again — livelock). This pins the anti-livelock property
    // the restore must NOT defeat.
    const esB10 = sessionESes()[1];
    expect(esB10).not.toBe(es0);
    expect(urlCursor(esB10)).toBe(0);

    // The B10 recovery is raced by suspend before its snapshot applies.
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    const esReveal = sessionESes()[2];
    // Restored to the last APPLIED seq (2, the part.upsert) — not 0, and not
    // 3 (the mismatched frame was received but never applied).
    expect(urlCursor(esReveal)).toBe(2);
  });
});

describe("defect shape 3 — normal advance: the sent cursor advances with applied content", () => {
  it("snapshot then message.upsert: the reveal carries the newest applied seq", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();
    es0.fire(
      "message.upsert",
      { id: "m2", sessionID: SID, role: "user", time: { created: 2 } },
      "250.2",
    );
    await flushMicro();
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    expect(urlCursor(sessionESes()[1])).toBe(250);
  });

  it("applied part.append suffixes advance the memory (streaming sessions keep a fresh restore point)", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    // Seed an empty text field (0 bytes) so a start=0 suffix applies.
    es0.fire(
      "part.upsert",
      { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "" },
      "200.1",
    );
    await flushMicro();
    es0.fire(
      "part.append",
      { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 0, text: "abc" },
      "250.1",
    );
    await flushMicro();
    // The suffix APPLIED (offset 0 matched the empty field).
    expect(
      (store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text,
    ).toBe("abc");
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    // Restored to the applied suffix's seq — a replay from here re-delivers
    // only the MISSED suffixes with aligned offsets.
    expect(urlCursor(sessionESes()[1])).toBe(250);
  });
});

describe("invariant — a preserving open in a page-life with prior applied content is never cursor-0", () => {
  it("survives a gauntlet of zeroing events (force recovery, close, B12 fallback, suspend races)", async () => {
    let lastApplied = 0;
    const assertPreservingOpen = (es: MockEventSource, why: string) => {
      const c = urlCursor(es);
      expect(c, `${why}: cursor must be ≥ last applied (${lastApplied}), never 0`).toBeGreaterThanOrEqual(lastApplied);
    };

    // Apply a snapshot (seq 100).
    stream.openSessionStream(SID, false, "first-open", "boot");
    sessionESes()[0].fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();
    lastApplied = 100;

    // (1) forced cursorless recovery, raced by suspend → reveal restores.
    stream.openSessionStream(SID, true, "recovery-fresh", "gauntlet-1");
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    assertPreservingOpen(sessionESes()[2], "reveal after forced recovery");

    // (2) a plain closeSessionStream (selection-clear shape) → unforced
    // re-open restores (re-selection of a streamed session replays).
    stream.closeSessionStream();
    stream.openSessionStream(SID, false, "selection-change", "gauntlet-2");
    assertPreservingOpen(sessionESes()[3], "unforced re-open after close");

    // (3) apply newer content, then the B12 silence-fallback: its own open is
    // deliberately cursorless (anti-wedge), and the NEXT preserving open
    // still restores the last applied cursor.
    const esLive = sessionESes()[3];
    esLive.fire("snapshot", rawSessionSnap(150, SID, "m1"), "150.1");
    await flushMicro();
    lastApplied = 150;
    esLive.close(); // fatal close, no error dispatch → the 5b branch owns reopen
    sesMod.reopenSessionStreamPreservingCursor("watchdog", "sentinel-timeout");
    expect(urlCursor(sessionESes()[4])).toBe(150); // cursor-preserving seam (live cursor survived)
    await vi.advanceTimersByTimeAsync(sesMod.SES_RESUME_SILENT_FALLBACK_MS + 1);
    const fallbackES = sessionESes()[5];
    expect(fallbackES).toBeDefined();
    expect(urlCursor(fallbackES), "B12 confirmation stays cursorless (anti-wedge)").toBe(0);
    // Deliver nothing on the fallback; suspend races it too.
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    assertPreservingOpen(sessionESes()[6], "reveal after B12 fallback");
  });

  it("a NEVER-streamed session opens cursorless — no false restore across sessions", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    sessionESes()[0].fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();
    // Switch to s2 (never streamed in this page life): fresh, no cursor.
    store.setSelectedIdRaw("s2");
    stream.openSessionStream("s2", false, "selection-change", "selection-follow");
    expect(urlCursor(sessionESes()[1])).toBe(0);
    expect(sessionESes()[1].url).toContain("sessions=s2");
  });
});

describe("scope boundaries of the memory", () => {
  it("is NOT persisted: a fresh module instance (page reload shape) opens cursorless", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    sessionESes()[0].fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();
    // Simulate the reload: every module re-evaluates from scratch. A first
    // open after reload is cursorless BY DESIGN (B1 semantics hold).
    await setupFresh();
    stream.openSessionStream(SID, false, "first-open", "boot");
    expect(urlCursor(sessionESes()[0])).toBe(0);
  });

  it("does NOT survive a project switch: a dir change clears it (replay against a wiped store would strand the transcript)", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    sessionESes()[0].fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();
    // switchProject wipes s.messages and changes the dir; the raw seam here
    // reproduces the dir-change observation openSessionES performs (kept as
    // defense-in-depth by the fix — see the zero-open excursion suite below
    // for the switchProject-boundary reset those shapes require).
    stream.closeSessionStream();
    store.setProjectDirRaw("/other");
    store.setSelectedIdRaw("s9");
    stream.openSessionStream("s9", false, "selection-change", "project-switch");
    expect(urlCursor(sessionESes()[1])).toBe(0);
    // Back on the original dir: the memory was dropped at the dir change —
    // the store was wiped by the switch, so a replay cursor would strand the
    // pre-cursor transcript. The open must be cursorless (fresh hydrate).
    stream.closeSessionStream();
    store.setProjectDirRaw("/test");
    store.setSelectedIdRaw(SID);
    stream.openSessionStream(SID, false, "selection-change", "project-switch-back");
    expect(urlCursor(sessionESes()[2])).toBe(0);
  });
});

// F1/F2/F3 (review blockers, one root cause — lazy project-scope
// invalidation): the memory used to clear only when an openSessionES call
// OBSERVED dirNow !== lastKnownCursorDir. A ZERO-OPEN excursion never observes
// the change — switchProject("") closes the session stream so no open runs,
// and a switch to B with nothing selected opens nothing under B. On return,
// re-selecting a previously-streamed session sent the stale remembered cursor
// against a store that switchProject had wiped (s.messages = {} on EVERY dir
// change) → the server replayed only deltas > M, no snapshot landed, and the
// pre-M transcript was STRANDED — a regression on a path that correctly sent
// cursor=0 before the fix. The required fix: invalidate at the TRUE boundary
// (switchProject calls resetLastKnownSesCursors on every dir change); the
// openSessionES observation clear stays as defense-in-depth. These drive the
// REAL switchProject (not the raw store seam) so the boundary itself is what
// the tests pin.
describe("F1/F2/F3 — zero-open project excursions: switchProject is the TRUE reset boundary", () => {
  it("A→''→A: re-selecting a previously-streamed session after the excursion opens CURSORLESS", async () => {
    // Stream s1 under /test; the snapshot APPLIES → the memory holds s1→100.
    stream.openSessionStream(SID, false, "first-open", "boot");
    sessionESes()[0].fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();

    // Zero-open excursion through the no-project state: switchProject("")
    // closes the session stream (selection null) and wipes s.messages — and
    // NO open runs while dir === "", so openSessionES never observes the dir
    // change. The leg back to /test is equally open-less.
    actions.switchProject("");
    actions.switchProject("/test");

    // Re-select the previously-streamed session. The store was wiped on BOTH
    // dir changes; a remembered cursor=100 would replay only deltas > 100
    // against an EMPTY store and strand the pre-100 transcript.
    store.setSelectedIdRaw(SID);
    stream.openSessionStream(SID, false, "selection-change", "reselect");
    const es = sessionESes()[sessionESes().length - 1];
    expect(es.url).toContain(`sessions=${SID}`);
    expect(urlCursor(es)).toBe(0);
  });

  it("A→B with NO session selected in B → back to A: the re-select is cursorless (no open ever ran under B)", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    sessionESes()[0].fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();
    // Land on B without selecting anything. The app's selection-follow effect
    // (sync.ts:187) reacts to the selection drop with openSessionStream("") —
    // close-then-guard, so Stream 2 CLOSES but NO EventSource is constructed
    // under B: the excursion is genuinely zero-open and the lazy dir
    // observation never fires.
    actions.switchProject("/projB");
    stream.openSessionStream("", false, "selection-change", "selection-follow");
    actions.switchProject("/test");
    store.setSelectedIdRaw(SID);
    stream.openSessionStream(SID, false, "selection-change", "reselect");
    const es = sessionESes()[sessionESes().length - 1];
    expect(es).not.toBe(sessionESes()[0]); // a NEW construction (not the early-return)
    expect(urlCursor(es)).toBe(0);
  });

  it("session-less popstate back to A (the fromUrl leg): same cursorless re-select", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    sessionESes()[0].fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await flushMicro();
    // The popstate shape: switchProject(dir, fromUrl=true) — identical reset
    // semantics, no history re-push. The session-less popstate re-selection
    // (sync.ts:274, B16) lands on "" mid-excursion: same close-then-guard.
    actions.switchProject("/projB", true);
    stream.openSessionStream("", false, "selection-change", "popstate");
    actions.switchProject("/test", true);
    store.setSelectedIdRaw(SID);
    stream.openSessionStream(SID, false, "selection-change", "reselect");
    const es = sessionESes()[sessionESes().length - 1];
    expect(es).not.toBe(sessionESes()[0]);
    expect(urlCursor(es)).toBe(0);
  });
});

// --- F4/F5 helpers: REAL gzip64 wire payloads --------------------------------
//
// Node ≥18 ships DecompressionStream + atob as globals, so the REAL decode
// path runs (same fixture discipline as messagesBatchDecode.test.ts:
// node:zlib gzipSync + base64 — the server's exact round-trip). These suites
// run on REAL timers: the gzip64 decode is a genuinely async native source,
// and fake timers can starve it (the coherentBarrierReloadRace.test.ts
// precedent). None of these tests advance timers — suspend/resume and forced
// opens schedule nothing.
const gzip64Batch = (messages: unknown[]): { sessionID: string; encoding: "gzip64"; data: string } => ({
  sessionID: SID,
  encoding: "gzip64",
  data: Buffer.from(gzipSync(Buffer.from(JSON.stringify({ messages })))).toString("base64"),
});
const gzip64Snapshot = (snap: unknown): { encoding: "gzip64"; data: string } => ({
  encoding: "gzip64",
  data: Buffer.from(gzipSync(Buffer.from(JSON.stringify(snap)))).toString("base64"),
});
// A macrotask pump for the real-timer suites (flushMicro covers only
// microtasks; the native decompression pipe settles across macrotasks).
const waitTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function settle(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) {
    await waitTick();
    await flushMicro();
  }
}

// F4 (deferred coverage closed): the end-to-end proof that a messages.batch
// whose decode APPLIES sets the restore point the reveal sends — the reveal
// carries the batch's own seq, not the pre-batch snapshot's.
describe("F4 — messages.batch end-to-end: the reveal carries the batch's seq", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("a gzip64 batch applies, then suspension before any further apply → reveal cursor = batch seq", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await settle();
    // Cold-load batch (the REAL gzip64 wire shape) carrying m2 at seq 300.
    es0.fire(
      "messages.batch",
      gzip64Batch([{ info: { id: "m2", sessionID: SID, role: "user", time: { created: 2 } }, parts: [] }]),
      "300.2",
    );
    await settle();
    // The batch content APPLIED (end-to-end: store content + restore point).
    expect(store.state.messages[SID]?.byId?.m2).toBeTruthy();
    // Suspend BEFORE any further apply; the reveal must carry the batch's seq.
    // (Masking note: the live cursor also reached 300 at receipt — the UNMASKED
    // proof that the cursor MEMORY itself advanced is the F5 suite below.)
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    expect(urlCursor(sessionESes()[1])).toBe(300);
  });
});

// F5 (deferred coverage closed): the message.upsert/part.append/messages.batch
// advance tests above pass even if noteSessionCursorApplied were REMOVED — a
// nonzero live sesCursor masks them (suspend preserves the live cursor, so the
// reveal sends it regardless of the memory). These tests ZERO the live cursor
// after each successful apply (a forced recovery open whose snapshot is never
// delivered — the exact parked defect shape), so the reveal's cursor can come
// ONLY from the per-session memory. Removing any advance site turns its test
// red. The two discard cases pin the converse: a decode whose continuation
// suspension invalidated (sesGen bump mid-decode) NEVER advances the memory —
// its content is not in the store.
describe("F5 — unmasked advance sites + pending-decode discard", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("message.upsert advances the memory: zeroed live cursor, reveal still carries the upsert's seq", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await settle();
    es0.fire(
      "message.upsert",
      { id: "m2", sessionID: SID, role: "user", time: { created: 2 } },
      "250.2",
    );
    await settle();
    // ZERO the live cursor: forced recovery open, deliver nothing on it.
    stream.openSessionStream(SID, true, "recovery-fresh", "test-zeroing");
    expect(urlCursor(sessionESes()[1])).toBe(0);
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    // The ONLY possible source of 250 is the memory's advance site.
    expect(urlCursor(sessionESes()[2])).toBe(250);
  });

  it("part.append advances the memory (flush site): zeroed live cursor, reveal still carries the suffix's seq", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await settle();
    // Seed an empty text field (0 bytes) so a start=0 suffix APPLIES.
    es0.fire(
      "part.upsert",
      { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "" },
      "200.2",
    );
    await settle();
    es0.fire(
      "part.append",
      { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 0, text: "abc" },
      "250.3",
    );
    await settle();
    expect(
      (store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text,
    ).toBe("abc"); // the suffix APPLIED
    stream.openSessionStream(SID, true, "recovery-fresh", "test-zeroing");
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    expect(urlCursor(sessionESes()[2])).toBe(250);
  });

  it("messages.batch advances the memory (decode+apply site): zeroed live cursor, reveal still carries the batch's seq", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await settle();
    es0.fire(
      "messages.batch",
      gzip64Batch([{ info: { id: "m2", sessionID: SID, role: "user", time: { created: 2 } }, parts: [] }]),
      "300.2",
    );
    await settle();
    expect(store.state.messages[SID]?.byId?.m2).toBeTruthy(); // batch APPLIED
    stream.openSessionStream(SID, true, "recovery-fresh", "test-zeroing");
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    expect(urlCursor(sessionESes()[2])).toBe(300);
  });

  it("DISCARD: suspension invalidating a pending batch decode never advances — reveal keeps the pre-batch cursor", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await settle();
    // Fire the batch and suspend SYNCHRONOUSLY — the gzip64 decode is still
    // in flight, so the sesGen bump discards its continuation (the entry gen
    // guard inside the decode). The frame's seq 300 DID advance the LIVE
    // cursor at receipt, which is exactly why the zeroing step below is
    // needed to observe the memory in isolation.
    es0.fire(
      "messages.batch",
      gzip64Batch([{ info: { id: "m2", sessionID: SID, role: "user", time: { created: 2 } }, parts: [] }]),
      "300.2",
    );
    sesMod.suspendSessionStreamForVisibility();
    await settle(); // the discarded decode resolves into the gen guard → dropped
    expect(store.state.messages[SID]?.byId?.m2).toBeUndefined(); // never applied
    // Zero the live cursor (receipt had advanced it to 300), then reveal.
    stream.openSessionStream(SID, true, "recovery-fresh", "test-zeroing");
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    // The memory must NOT have advanced to 300: content ≤ 300 is NOT in the
    // store. A stored 300 would strand the batch's transcript on resume.
    expect(urlCursor(sessionESes()[2])).toBe(100);
  });

  it("DISCARD: suspension invalidating a pending gzip64 SNAPSHOT decode never advances — reveal keeps the pre-snapshot cursor", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await settle();
    // A compressed snapshot (seq 400, carrying m9) whose decode is still
    // pending when suspension bumps sesGen — the continuation's gen re-check
    // drops it before applySnap, so the snapshot advance site never runs.
    es0.fire("snapshot", gzip64Snapshot(rawSessionSnap(400, SID, "m9")), "400.2");
    sesMod.suspendSessionStreamForVisibility();
    await settle(); // the discarded decode resolves into the gen guard → dropped
    expect(store.state.messages[SID]?.byId?.m9).toBeUndefined(); // never applied
    stream.openSessionStream(SID, true, "recovery-fresh", "test-zeroing");
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    expect(urlCursor(sessionESes()[2])).toBe(100);
  });
});

// F9 (round-2 review blocker, data_integrity): append-flush vs pending-batch
// decode interleaving. The part.append branch buffers and returns BEFORE the
// pendingBatch wait; the flush-time advance site used to run with NO
// pendingBatch coordination. Wire order means an append arriving after a
// batch frame has a HIGHER seq, so the flush could push the remembered cursor
// PAST the batch's seq while the batch decode was still in flight; a
// suspension then bumped sesGen, the batch continuation dropped at its gen
// guard, and the batch's content never applied — the remembered cursor now
// COVERED un-applied content, so the next preserving open replayed from it
// and omitted the batch entirely (m2 stranded). The fix gates the flush-time
// advance on pendingBatch (under-advance while unresolved; the batch's own
// advance-on-apply catches up). These suites run on REAL timers (the gzip64
// decode is genuinely async — same discipline as F4/F5); the append flush is
// driven by a MICROTASK-ONLY pump so it provably runs while the batch decode
// is still in flight.
describe("F9 — append-flush vs pending-batch decode interleaving", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("an append that applies while a batch decode is pending must NOT advance the memory past the batch (red-first F9)", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    // Snapshot (m1 resident) + an empty text part p1 — the append's target.
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    es0.fire(
      "part.upsert",
      { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "" },
      "150.2",
    );
    await settle();
    // Batch seq 200 (carrying m2) starts decoding — pendingBatch is set
    // synchronously before the listener suspends at its await.
    es0.fire(
      "messages.batch",
      gzip64Batch([{ info: { id: "m2", sessionID: SID, role: "user", time: { created: 2 } }, parts: [] }]),
      "200.3",
    );
    // Immediately-following APPLICABLE append seq 201 (targets resident
    // m1/p1). Microtask-only pump: the flush runs at the end of this task
    // while the native decompression is still in flight (it settles across
    // macrotasks — hence settle() elsewhere in these suites).
    es0.fire(
      "part.append",
      { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 0, text: "abc" },
      "201.4",
    );
    await flushMicro(2);
    // The interleaving this test exists for: the suffix APPLIED (the flush's
    // advance site ran with a legitimate high seq available)…
    expect(
      (store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text,
    ).toBe("abc");
    // …while the batch decode was still unresolved (m2 not yet in the store).
    expect(store.state.messages[SID]?.byId?.m2).toBeUndefined();

    // Suspend BEFORE the batch resolves: sesGen bumps, the decode
    // continuation drops at its gen guard — m2 NEVER lands.
    sesMod.suspendSessionStreamForVisibility();
    await settle();
    expect(store.state.messages[SID]?.byId?.m2).toBeUndefined();

    // Forced cursorless recovery with NO delivery (live cursor → 0), then a
    // preserving reopen: its cursor can come ONLY from the memory.
    stream.openSessionStream(SID, true, "recovery-fresh", "f9-zeroing");
    expect(urlCursor(sessionESes()[1])).toBe(0);
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    // The memory must hold the last seq that does NOT pass the unresolved
    // batch: 150 (the part.upsert) — never 201 (the append's seq covered the
    // batch's un-applied content: the pre-fix defect sent exactly that) and
    // never 200 (the batch was DISCARDED, not applied).
    expect(urlCursor(sessionESes()[2])).toBe(150);
  });

  it("mirrored happy path: the batch resolves and applies, then a later append advances legitimately", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    es0.fire(
      "part.upsert",
      { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "" },
      "150.2",
    );
    await settle();
    // Batch applies (memory → 200) BEFORE any append flushes.
    es0.fire(
      "messages.batch",
      gzip64Batch([{ info: { id: "m2", sessionID: SID, role: "user", time: { created: 2 } }, parts: [] }]),
      "200.3",
    );
    await settle();
    expect(store.state.messages[SID]?.byId?.m2).toBeTruthy();
    // A later append flushes with NO batch pending — the advance is
    // legitimate (everything ≤ its seq is applied).
    es0.fire(
      "part.append",
      { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 0, text: "xyz" },
      "250.4",
    );
    await settle();
    expect(
      (store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text,
    ).toBe("xyz");
    stream.openSessionStream(SID, true, "recovery-fresh", "f9-zeroing");
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    expect(urlCursor(sessionESes()[2])).toBe(250);
  });

  it("catch-up: the gated append does not strand the memory — the batch's own advance-on-apply catches it up", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    es0.fire(
      "part.upsert",
      { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "" },
      "150.2",
    );
    await settle();
    // Append applies while the batch decode is pending → gated (memory stays
    // 150) — this suspension-free variant lets the batch resolve NORMALLY.
    es0.fire(
      "messages.batch",
      gzip64Batch([{ info: { id: "m2", sessionID: SID, role: "user", time: { created: 2 } }, parts: [] }]),
      "200.3",
    );
    es0.fire(
      "part.append",
      { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 0, text: "abc" },
      "201.4",
    );
    await flushMicro(2);
    expect(
      (store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text,
    ).toBe("abc"); // the suffix applied; its advance was withheld
    // The batch resolves on the SAME generation → applies → its own advance
    // site catches the memory up to 200 (past the gated append's 201? NO —
    // to the batch seq; 201 stays uncovered, which is SAFE under-advance).
    await settle();
    expect(store.state.messages[SID]?.byId?.m2).toBeTruthy();
    stream.openSessionStream(SID, true, "recovery-fresh", "f9-zeroing");
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    expect(urlCursor(sessionESes()[2])).toBe(200);
  });
});

// F9 round-2b (review follow-up, data_integrity): the batch-vs-batch
// interleaving the round-2 fix did not cover. pendingBatch maps only the
// LATEST registration per session — a second same-session messages.batch
// frame arriving while a first decode is in flight (server-reachable: the
// ring records messages.batch events, the replay filter passes messages.*,
// and a session can be cold-published more than once, so one connection can
// deliver two same-session batches back-to-back) OVERWRITES the map entry,
// and nothing in the batch path waits on a pre-existing entry. If the
// LATER-seq batch's decode completes and applies while the EARLIER-seq
// batch's decode is still unresolved, the batch advance site used to push
// the remembered cursor to the later batch's seq — covering the earlier
// batch's not-yet-applied content. A suspend (sesGen bump) or gate flip in
// the remaining window then discards the earlier batch's continuation, and
// the next preserving open replays from PAST its content — the same
// stranded-transcript class, through the batch path.
//
// The fix: per-session UNRESOLVED batch frame seq tracking
// (pendingBatchSeqs) + a single claim helper — a cursor claim advances only
// to min(unresolved seqs) − 1 while any same-session batch is unresolved
// (under-advance is always safe: server replay + merge dedup converge).
//
// Deterministic decode-order control: the gzip64 decode is a native async
// source, and the hazard needs the LATER frame's decode to COMPLETE while
// the EARLIER frame's is still in flight — an ordering real decompression
// does not guarantee. stubHoldFirstBatchDecode replaces DecompressionStream
// with a pass-through proxy whose FIRST constructed instance (batch 200's —
// it is fired first) buffers its readable until the test releases it; every
// later instance proxies the native stream untouched. Real gzip64 payloads
// still flow through the real decompression path on both sides.
// t1b-F2 (round 3): the round-2b stub held construction instance #1 only.
// The earlier-seq-FIRST corner needs the SECOND constructed decode held
// (batch 200 fires first → native instance #1 which settles on its own;
// batch 300 → held instance #2), so the factory is generalized to holdNth.
// holdNth=1 reproduces the round-2b later-first shape exactly.
function stubHoldNthBatchDecode(holdNth: number): () => void {
  const RealMaybe = (globalThis as { DecompressionStream?: new (fmt: string) => unknown }).DecompressionStream;
  if (!RealMaybe) throw new Error("DecompressionStream global unavailable in test env");
  // Narrowed alias — type queries (`typeof Real`) do not inherit guard
  // narrowing, so InstanceType<typeof Real> would still carry `| undefined`.
  const Real = RealMaybe;
  let released = false;
  const waiters: Array<() => void> = [];
  let n = 0;
  class HoldFirst {
    private real: InstanceType<typeof Real>;
    readable: ReadableStream<Uint8Array>;
    writable: WritableStream<Uint8Array>;
    constructor(fmt: string) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.real = new (Real as any)(fmt) as InstanceType<typeof Real>;
      if (++n === holdNth) {
        // Instance #1 = the first decode after stubbing (batch 200's): hold
        // the readable side closed until release; writes forward straight
        // into the real stream so the decompressed bytes are exact.
        this.readable = new ReadableStream<Uint8Array>({
          start: (controller) => {
            void (async () => {
              if (!released) await new Promise<void>((r) => waiters.push(r));
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const reader = (this.real as any).readable.getReader();
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value as Uint8Array);
              }
              controller.close();
            })();
          },
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const w = (this.real as any).writable.getWriter();
        this.writable = new WritableStream<Uint8Array>({
          write: (chunk) => w.write(chunk),
          close: () => w.close(),
        });
      } else {
        // Every later decode (batch 300's, and any unrelated one): native.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.readable = (this.real as any).readable as ReadableStream<Uint8Array>;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        this.writable = (this.real as any).writable as WritableStream<Uint8Array>;
      }
    }
  }
  vi.stubGlobal("DecompressionStream", HoldFirst);
  return () => {
    released = true;
    for (const r of waiters) r();
  };
}

describe("F9 round-2b — batch-vs-batch interleaving (concurrent same-session batch decodes)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("a later batch applying while an earlier same-session batch decode is unresolved must NOT advance the memory past the earlier batch (red-first F9-2b)", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await settle();

    const release = stubHoldNthBatchDecode(1);

    // Batch seq 200 (m2) starts decoding — its pendingBatch registration runs
    // SYNCHRONOUSLY before the listener suspends at the decode await; the
    // decode itself is HELD (instance #1).
    es0.fire(
      "messages.batch",
      gzip64Batch([{ info: { id: "m2", sessionID: SID, role: "user", time: { created: 2 } }, parts: [] }]),
      "200.2",
    );
    // Batch seq 300 (m3) arrives on the SAME connection while 200 is
    // unresolved — the second registration OVERWRITES the promise-map entry.
    // Its decode runs the native path and completes.
    es0.fire(
      "messages.batch",
      gzip64Batch([{ info: { id: "m3", sessionID: SID, role: "user", time: { created: 3 } }, parts: [] }]),
      "300.3",
    );
    await settle();
    // The interleaving this test exists for: the LATER batch APPLIED (its
    // advance site ran with seq 300 available)…
    expect(store.state.messages[SID]?.byId?.m3).toBeTruthy();
    // …while the EARLIER batch's decode was STILL unresolved (held): m2 is
    // not in the store, yet the pre-fix memory now claims 300.
    expect(store.state.messages[SID]?.byId?.m2).toBeUndefined();

    // Suspend FIRST (sesGen bump), THEN release the held decode: batch 200's
    // continuation drops at its gen guard — m2 NEVER lands.
    sesMod.suspendSessionStreamForVisibility();
    release();
    await settle();
    expect(store.state.messages[SID]?.byId?.m2).toBeUndefined();

    // Cursorless recovery with NO delivery (zeroes the live cursor — receipt
    // of the two frames had advanced it to 300), then the preserving reopen:
    // its cursor can come ONLY from the memory.
    stream.openSessionStream(SID, true, "recovery-fresh", "f9b-zeroing");
    expect(urlCursor(sessionESes()[1])).toBe(0);
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    // The memory must NOT send a cursor ≥ 200: batch 200's content never
    // applied, and a replay from ≥ 200 would strand it. Pre-fix this sent
    // exactly 300 (the later batch's advance covered the earlier batch's
    // un-applied content). Post-fix the claim is capped to
    // min(unresolved) − 1 = 199, so the replay re-delivers batch@200 and the
    // merge dedups the rest.
    expect(urlCursor(sessionESes()[2])).toBe(199);
  });

  it("mirrored happy path: both batches apply in wire order → the reveal legitimately carries the later batch's seq", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await settle();
    // Batch 200 applies fully (memory → 200) BEFORE batch 300 arrives.
    es0.fire(
      "messages.batch",
      gzip64Batch([{ info: { id: "m2", sessionID: SID, role: "user", time: { created: 2 } }, parts: [] }]),
      "200.2",
    );
    await settle();
    expect(store.state.messages[SID]?.byId?.m2).toBeTruthy();
    // Batch 300 applies with nothing unresolved → the advance to 300 is
    // legitimate (everything ≤ 300 is applied).
    es0.fire(
      "messages.batch",
      gzip64Batch([{ info: { id: "m3", sessionID: SID, role: "user", time: { created: 3 } }, parts: [] }]),
      "300.3",
    );
    await settle();
    expect(store.state.messages[SID]?.byId?.m3).toBeTruthy();
    stream.openSessionStream(SID, true, "recovery-fresh", "f9b-zeroing");
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    expect(urlCursor(sessionESes()[2])).toBe(300);
  });

  it("overlap resolved on the same generation: the earlier batch applies after the later one → the memory ends at the earlier batch's seq (safe under-advance, not the later's)", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    await settle();

    const release = stubHoldNthBatchDecode(1);
    es0.fire(
      "messages.batch",
      gzip64Batch([{ info: { id: "m2", sessionID: SID, role: "user", time: { created: 2 } }, parts: [] }]),
      "200.2",
    );
    es0.fire(
      "messages.batch",
      gzip64Batch([{ info: { id: "m3", sessionID: SID, role: "user", time: { created: 3 } }, parts: [] }]),
      "300.3",
    );
    await settle(); // m3 applied; its claim was capped to 199 by the held 200
    expect(store.state.messages[SID]?.byId?.m3).toBeTruthy();

    // Release WITHOUT any suspend — the same generation is still live, so
    // batch 200 applies for real. Its own claim catches the memory up to
    // 200. Deliberate under-advance vs the applied 300: the fix does NOT
    // re-claim to the later batch's seq, because a remembered-max re-claim
    // could cover frames in (200, 300] that were received but never applied
    // (gate-deferred). Replaying (200, head] re-delivers that range and the
    // merge dedups it — always safe.
    release();
    await settle();
    expect(store.state.messages[SID]?.byId?.m2).toBeTruthy();
    stream.openSessionStream(SID, true, "recovery-fresh", "f9b-zeroing");
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    expect(urlCursor(sessionESes()[2])).toBe(200);
  });
});

// t1b-F1 (round-3 review BLOCKER, data_integrity): the same-flush mismatch
// covering hole. flushAppends tracked ONE highest-applied seq per flush and
// claimed it BEFORE running the mismatch recovery loop — when a mismatched
// suffix (target part absent → content NOT applied) shared the flush with a
// LATER applicable suffix, the flush's claim committed the APPLIED suffix's
// seq to the cursor memory while the MISMATCHED frame's content had never
// landed. The mismatch's cursorless recovery open raced by suspend (snapshot
// discarded), a later memory-restoring open replayed from the claimed seq,
// and the un-applied frame's content was skipped — the same
// remembered-cursor-covers-un-applied-content charter violation as F9/F9-2b,
// through the mismatch path. Fix: a flush that recorded a mismatch for a
// session never claims for that session (conservative under-advance; the
// mismatch recovery's authoritative snapshot re-advances the memory when it
// applies).
describe("t1b-F1 — same-flush mismatch covering (mismatched suffix + applicable suffix in ONE flush)", () => {
  it("mismatched 200 + applicable 201 in one flush: 201 applies but the memory never claims past 200 (red-first)", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    es0.fire(
      "part.upsert",
      { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "" },
      "150.1",
    );
    await flushMicro();
    // Memory = 150 (snapshot 100 + part.upsert 150, both applied).

    // ONE task, TWO buffered suffixes → ONE flush:
    // seq 200 targets a NON-RESIDENT part → appendPartSuffix "mismatch"
    // (content NOT applied; receipt still advanced the live cursor to 201).
    es0.fire(
      "part.append",
      { sessionID: SID, messageID: "m1", partID: "p-absent", field: "text", start: 0, text: "XX" },
      "200.2",
    );
    // seq 201 targets the resident empty p1 (start 0 = its byte length) → applies.
    es0.fire(
      "part.append",
      { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 0, text: "abc" },
      "201.3",
    );
    await flushMicro(2);
    // The applicable suffix APPLIED — the flush's claim site ran with a
    // legitimate-looking high seq available…
    expect(
      (store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text,
    ).toBe("abc");
    // …and the mismatch recovery opened CURSORLESS (the cascade direct runs
    // synchronously inside the flush, AFTER the claim — the defect ordering).
    const esB10 = sessionESes()[1];
    expect(esB10).not.toBe(es0);
    expect(urlCursor(esB10)).toBe(0);

    // Race the recovery before its snapshot applies (the capture shape).
    sesMod.suspendSessionStreamForVisibility();

    // Unmask the memory: cursorless forced open with NO delivery (live
    // cursor → 0), then reveal — its cursor can come ONLY from the memory.
    stream.openSessionStream(SID, true, "recovery-fresh", "t1bf1-zeroing");
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    // Pre-fix defect: 201 (the applied suffix's claim covered the un-applied
    // mismatched 200). Post-fix: 150 — the last seq whose content is FULLY
    // applied; the replay re-delivers 200+ and the recovery realigns.
    expect(urlCursor(sessionESes()[3])).toBe(150);
  });
});

// E2/E3 pin (round-3 systematic enumeration): the drain-ordering guard that
// protects the NON-flush claim sites from a mismatch discovered mid-drain.
// A buffered mismatched suffix drained by a NON-APPEND frame's listener
// triggers the cursorless recovery SYNCHRONOUSLY inside the drain (the
// cascade executes the mismatch direct immediately when it starts a pass),
// and the sesGen bump makes the triggering frame's continuation drop at the
// post-drain gen re-check (the landed t1d-F1 guard) — so the triggering
// frame neither applies nor CLAIMS, and the 1728/1659 claim sites can never
// cover the mismatched range from the triggering frame. This pin goes red if
// (a) the drain-before-apply ordering is broken, or (b) the mismatch direct
// ever becomes deferred WITHOUT bumping sesGen (a deferred recovery would
// leave the gen unchanged → the triggering frame would apply + claim past
// the mismatch).
//
// SCOPE (round-4b): this pin covers the NO-PASS case only — its scenario has
// no cascade pass in flight, so the mismatch direct runs synchronously. The
// resume-subsume corner (a pending resume-mode step SUBSUMES the mismatch's
// recovery: no direct, no sesGen bump → the triggering frame applies and
// CLAIMS at the listener tail) is out of this pin's reach — it stays green
// through that defect — and is covered red-first by the round-4b suite at
// the bottom of this file (the uniform latch gate inside
// claimSessionCursorApplied is what closes it).
describe("E2/E3 pin — drain-time mismatch: recovery opens synchronously, the triggering non-append frame drops and never claims", () => {
  it("message.upsert@250 draining a mismatched buffered suffix@200: the upsert does not apply and the memory stays below 200", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    es0.fire(
      "part.upsert",
      { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "" },
      "150.1",
    );
    await flushMicro();
    // Buffer ONE mismatched suffix (target part absent).
    es0.fire(
      "part.append",
      { sessionID: SID, messageID: "m1", partID: "p-absent", field: "text", start: 0, text: "XX" },
      "200.2",
    );
    expect(sesMod._hasPendingAppendsForTest()).toBe(true);
    // The triggering non-append frame (a message whose own claim site would
    // run at the tail of its listener). The drain fires first, the recovery
    // opens synchronously, and the post-drain gen re-check drops the upsert
    // — synchronously within this fire().
    es0.fire(
      "message.upsert",
      { id: "m2", sessionID: SID, role: "user", time: { created: 2 } },
      "250.3",
    );
    // The upsert did NOT apply (the recovery's fresh snapshot owns it —
    // MERGE via prependMessagesIfAbsent on the new connection).
    expect(store.state.messages[SID]?.byId?.m2).toBeUndefined();
    // The recovery opened cursorless.
    const esRec = sessionESes()[1];
    expect(esRec).not.toBe(es0);
    expect(urlCursor(esRec)).toBe(0);
    // Race the recovery, unmask, and prove no claim site covered the
    // mismatched 200: the memory sits at the last pre-mismatch apply (150).
    sesMod.suspendSessionStreamForVisibility();
    stream.openSessionStream(SID, true, "recovery-fresh", "e2e3-zeroing");
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    expect(urlCursor(sessionESes()[3])).toBe(150);
  });
});

// t1b-F2 (deferred → closed in round 3): the EARLIER-SEQ-FIRST overlapping
// decode corner the round-2b suites did not pin. Round-2b held the EARLIER
// batch (instance #1) while the LATER applied; this corner holds the LATER
// batch (instance #2) while the EARLIER applies and FINALIZES — and the
// earlier listener's finally DELETES the shared promise-map entry that
// still belongs to the held later batch (pendingBatch.has → false while the
// later decode is genuinely unresolved: the has()-gate hole). A non-batch
// APPEND flushing in that window passes the has() gate; only the
// pendingBatchSeqs min-unresolved cap keeps its claim below the held batch.
// A has()-only gate would send the append's own seq (350) — the round-2b
// hole, re-proven through the opposite decode ordering.
describe("t1b-F2 — earlier-seq-first overlapping batch decodes (the finalized earlier batch's finally deletes the held later batch's map entry)", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it("batch 200 applies+finalizes while batch 300 is held: a later append applies and its claim is capped below 300", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    es0.fire(
      "part.upsert",
      { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "" },
      "150.1",
    );
    await settle();

    // Hold construction instance #2: batch 200 (fired first) decodes
    // natively; batch 300's decode is held until release().
    const release = stubHoldNthBatchDecode(2);

    // Same task: batch 200 registers (native decode in flight across
    // macrotasks), then batch 300 registers and OVERWRITES the promise-map
    // entry — both seqs live in pendingBatchSeqs.
    es0.fire(
      "messages.batch",
      gzip64Batch([{ info: { id: "m2", sessionID: SID, role: "user", time: { created: 2 } }, parts: [] }]),
      "200.2",
    );
    es0.fire(
      "messages.batch",
      gzip64Batch([{ info: { id: "m3", sessionID: SID, role: "user", time: { created: 3 } }, parts: [] }]),
      "300.3",
    );
    await settle();
    // The EARLIER batch applied while the LATER was still unresolved…
    expect(store.state.messages[SID]?.byId?.m2).toBeTruthy();
    expect(store.state.messages[SID]?.byId?.m3).toBeUndefined();
    // …and its listener's finally has now DELETED the shared promise-map
    // entry (pendingBatch.has(SID) === false with batch 300 still decoding
    // — observable only through the next claim's outcome, below).

    // A non-batch APPEND applies while 300 is still held. Its flush claim
    // passes the (empty) has() gate; the seq-set cap must hold it below 300.
    es0.fire(
      "part.append",
      { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 0, text: "abc" },
      "350.4",
    );
    await flushMicro(2);
    // STORE APPLICATION happened (the suffix content is live in the store)…
    expect(
      (store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text,
    ).toBe("abc");

    // Suspend BEFORE releasing 300: the held decode's continuation drops at
    // its gen guard — batch 300's content NEVER applies.
    sesMod.suspendSessionStreamForVisibility();
    release();
    await settle();
    expect(store.state.messages[SID]?.byId?.m3).toBeUndefined();

    // Unmask + restore: the cursor can come ONLY from the memory.
    stream.openSessionStream(SID, true, "recovery-fresh", "t1bf2-zeroing");
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    // 299 = min(unresolved 300) − 1: the memory does not cover the discarded
    // batch. A has()-only gate would send 350 here (the round-2b hole
    // re-proven through the earlier-first ordering). (ESes: [es0, zeroing,
    // reveal] — no mismatch fired in this test, so the reveal is index 2.)
    expect(urlCursor(sessionESes()[2])).toBe(299);
  });
});

// Round-4 F1 (review BLOCKER, data_integrity — enumeration E11): CROSS-flush
// mismatch covering via the resume-mode cascade subsume. The round-3 fix made
// the flush claim's mismatch gate FLUSH-LOCAL (mismatchSessions), resting on
// the premise that a mismatch's cursorless recovery always runs (bumping
// sesGen, moving every later frame onto a snapshot-first recovery
// connection). The verified counterexample: a sentinel-timeout cascade pass
// (health.ts's watchdog) holds a PENDING {session:'resume'} step whose reopen
// connection sends cursor= with NO tree=2 → the server's replay branch ships
// NO trailing session snapshot (stream_http.go gates it on treeEmitter !=
// nil) → that step can never converge (only applySnap converges it) and pends
// up to the 15s cascade timeout. A part.append mismatch in that window hits
// the COALESCE branch — the pending session step SUBSUMES the direct (skipped
// — no sesGen bump, no cursorless re-snapshot), and S2 cannot supersede (the
// implied session step is pending). A LATER CLEAN flush then passes every
// flush-local gate and claims past the un-applied mismatched seq; a
// subsequent close + unforced reopen sends that cursor and STRANDS the
// mismatched range (pre-fix that reopen sent cursor=0 → healed).
//
// Fix (panel option 1): the cross-flush latch mismatchLatchedSids — set at
// flush-mismatch time, cleared ONLY by applySnap (a snapshot that APPLIES
// contains the mismatched range's content by construction — panel-verified
// content-inclusion), gating the flush claim. If no snapshot ever applies the
// latch freezes the memory at the pre-mismatch value — under-advance, always
// safe.
describe("round-4 F1 (E11) — cross-flush mismatch covering via resume-mode cascade subsume", () => {
  it("pending resume-mode session step → mismatch flush (recovery subsumed, no reopen) → later clean flush applies but the memory stays below the mismatch; close + unforced reopen replays it (red-first)", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    es0.fire(
      "part.upsert",
      { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "" },
      "150.1",
    );
    await flushMicro();
    // Memory = 150 (snapshot 100 + part.upsert 150, both applied).

    // The window-maker — health.ts's sentinel-timeout shape verbatim: a pass
    // with a PENDING resume-mode session step. Its direct reopens through the
    // cursor-preserving seam, so the recovery connection is RESUME-mode: it
    // never receives a session snapshot (no trailing snapshot on the replay
    // branch without tree=2), the step cannot converge, and the pass pends to
    // its 15s timeout.
    cascade.requestRecovery(
      "sentinel-timeout",
      () => sesMod.reopenSessionStreamPreservingCursor("watchdog", "sentinel-timeout"),
      { session: "resume" },
    );
    const esResume = sessionESes()[1];
    expect(esResume).not.toBe(es0);
    expect(urlCursor(esResume)).toBe(150); // cursor-preserving reopen

    // Mismatch flush ON the resume connection: seq 200 targets a NON-RESIDENT
    // part → "mismatch" (content NOT applied). Its
    // requestRecovery("offset-mismatch", …, {session:"fresh"}) hits COALESCE:
    // the pass holds a PENDING session step → `direct` SKIPPED; S2 cannot
    // supersede (session step not converged). Pin the subsume mechanics: no
    // new ES, one coalesce, pass still in flight.
    esResume.fire(
      "part.append",
      { sessionID: SID, messageID: "m1", partID: "p-absent", field: "text", start: 0, text: "XX" },
      "200.2",
    );
    await flushMicro(2);
    expect(sessionESes()).toHaveLength(2); // NO recovery reopen fired (subsumed)
    const cs = cascade._getCascadeStateForTest();
    expect(cs.coalesced).toBe(1); // the offset-mismatch coalesced into the pass
    expect(cs.inFlight).toBe(true); // …which still awaits its resume baseline

    // A SEPARATE, LATER, CLEAN flush: seq 250 targets the resident empty p1
    // (start 0 = its byte length) → APPLIES. Pre-fix (flush-local gate) this
    // flush's claim passes every gate and commits 250 to the memory —
    // COVERING the un-applied mismatched 200.
    esResume.fire(
      "part.append",
      { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 0, text: "abc" },
      "250.3",
    );
    await flushMicro(2);
    expect(
      (store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text,
    ).toBe("abc"); // the clean suffix APPLIED

    // Close + UNFORCED reopen (the re-selection shape): closeSessionStream
    // zeroes the LIVE cursor, so the reopen's URL cursor can come ONLY from
    // the per-session memory. Post-fix: 150 — BELOW the mismatched 200, so
    // the replay re-delivers the mismatched range (and the server's
    // fresh-fallback realigns it). Pre-fix: 250 — the replay skips the
    // un-applied 200 entirely (the stranding defect; the red signal).
    stream.closeSessionStream();
    stream.openSessionStream(SID, false, "selection-change", "reselect");
    const esReopen = sessionESes()[sessionESes().length - 1];
    expect(esReopen).not.toBe(esResume);
    expect(urlCursor(esReopen)).toBe(150);
  });

  // The latch's CLEAR semantics (the fix's second half): a session snapshot
  // that APPLIES is the authoritative repair point — content-inclusion makes
  // claims above it legitimate again. This pin is not red-first (it passes
  // pre-fix by design — there the claim was simply never gated); it exists to
  // catch a broken latch-clear implementation (a latch that never clears
  // would freeze the memory at the repair snapshot's seq and regress the
  // fresh-restore-point property).
  it("the latch clears when a session snapshot APPLIES — post-repair flush claims resume (latch-clear pin)", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    es0.fire(
      "part.upsert",
      { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "" },
      "150.1",
    );
    await flushMicro();
    // Mismatch with NO pass in flight: the recovery direct runs synchronously
    // (cursorless es1 — the cascade startPass path) and latches the sid.
    es0.fire(
      "part.append",
      { sessionID: SID, messageID: "m1", partID: "p-absent", field: "text", start: 0, text: "XX" },
      "200.2",
    );
    await flushMicro(2);
    const esRec = sessionESes()[1];
    expect(esRec).not.toBe(es0);
    expect(urlCursor(esRec)).toBe(0); // the recovery's cursorless open

    // The recovery connection's authoritative snapshot APPLIES (seq 300) —
    // the content-inclusion repair point. The latch clears; the snapshot's
    // own advance-on-apply puts the memory at 300.
    esRec.fire("snapshot", rawSessionSnap(300, SID, "m1"), "300.1");
    await flushMicro();

    // A clean suffix at 350 now CLAIMS again (latch cleared): memory → 350.
    esRec.fire(
      "part.append",
      { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 0, text: "abc" },
      "350.2",
    );
    await flushMicro(2);
    expect(
      (store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text,
    ).toBe("abc");

    // Unmask: cursorless forced open with NO delivery (zeroes the live
    // cursor), then reveal — its cursor can come ONLY from the memory. 350 =
    // the post-clear claim ran. A never-clearing latch sends 300 here (safe
    // under-advance, but the frozen-memory regression this pin catches).
    stream.openSessionStream(SID, true, "recovery-fresh", "latch-clear-zeroing");
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    expect(urlCursor(sessionESes()[3])).toBe(350);
  });
});

// Round-4b (E2 subsume corner — the round-4 report's own flag): E2's
// "the triggering non-append frame drops at the post-drain gen re-check"
// disposition holds ONLY when the mismatch's recovery DIRECT runs (no pass in
// flight — what the E2/E3 pin above covers). With a pending resume-mode
// cascade step (pass in flight), the drain-time mismatch's
// requestRecovery({session:"fresh"}) is SUBSUMED: no direct, no sesGen bump —
// so the post-drain gen re-check PASSES, the triggering non-append frame
// APPLIES, and its message-listener TAIL claim site
// (claimSessionCursorApplied(sid || id, seq) after applyMessageEvent) — a
// site the round-4 flush-local latch never gated — claims past the un-applied
// mismatched seq. The E2/E3 pin stays green through all of this because its
// scenario has no pass in flight (the pin's blind spot, noted above).
//
// Fix: the latch is consulted INSIDE claimSessionCursorApplied, so ALL capped
// claim sites (batch apply, non-batch tail, flush) are gated uniformly; the
// snapshot-apply site stays UNGATED (raw noteSessionCursorApplied — the
// authoritative floor-raise) and remains the latch-clear point.
describe("round-4b E2 subsume corner — drain-time mismatch subsumed by a pending resume step: the triggering non-append frame applies but its tail claim must not advance past the mismatch", () => {
  it("pending resume-mode session step → drain-time mismatch subsumed (no direct) → message.upsert applies + tail-claims → memory stays below the mismatch; close + unforced reopen replays the range (red-first)", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire("snapshot", rawSessionSnap(100, SID, "m1"), "100.1");
    es0.fire(
      "part.upsert",
      { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "" },
      "150.1",
    );
    await flushMicro();
    // Memory = 150 (snapshot 100 + part.upsert 150, both applied).

    // The window-maker (same as the round-4 F1 suite): a pass with a PENDING
    // resume-mode session step whose reopen connection can never converge.
    cascade.requestRecovery(
      "sentinel-timeout",
      () => sesMod.reopenSessionStreamPreservingCursor("watchdog", "sentinel-timeout"),
      { session: "resume" },
    );
    const esResume = sessionESes()[1];
    expect(esResume).not.toBe(es0);
    expect(urlCursor(esResume)).toBe(150); // cursor-preserving reopen

    // Buffer ONE mismatched suffix on the resume connection (target part
    // absent — its content will never apply).
    esResume.fire(
      "part.append",
      { sessionID: SID, messageID: "m1", partID: "p-absent", field: "text", start: 0, text: "XX" },
      "200.2",
    );
    expect(sesMod._hasPendingAppendsForTest()).toBe(true);

    // The triggering NON-APPEND frame (the E2 corner): its listener drains
    // the buffered suffix FIRST → the drain-time flush records the mismatch,
    // latches the sid, and its offset-mismatch requestRecovery is SUBSUMED by
    // the pending resume step (no direct → no sesGen bump → NO new ES). The
    // post-drain gen re-check therefore PASSES and the upsert APPLIES — the
    // defining property separating this corner from the E2/E3 no-pass pin
    // (where the frame drops).
    esResume.fire(
      "message.upsert",
      { id: "m2", sessionID: SID, role: "user", time: { created: 2 } },
      "250.3",
    );
    await flushMicro(2);
    // Subsume mechanics pinned: no recovery reopen fired, one coalesce, the
    // pass still in flight (the 15s timeout never advances under fake
    // timers).
    expect(sessionESes()).toHaveLength(2);
    const cs = cascade._getCascadeStateForTest();
    expect(cs.coalesced).toBe(1);
    expect(cs.inFlight).toBe(true);
    // The triggering frame APPLIED on the resume connection (gen unchanged —
    // exactly the corner's premise) and reached the TAIL claim site.
    expect(store.state.messages[SID]?.byId?.m2).toBeTruthy();

    // Close + UNFORCED reopen: closeSessionStream zeroes the LIVE cursor, so
    // the reopen's URL cursor can come ONLY from the per-session memory.
    // Post-fix: 150 — BELOW the mismatched 200, so the replay re-delivers the
    // mismatched range (server fresh-fallback realigns). Pre-fix: 250 — the
    // ungated tail claim covered the un-applied 200 and the replay skips it
    // (the stranding defect; the red signal).
    stream.closeSessionStream();
    stream.openSessionStream(SID, false, "selection-change", "reselect");
    const esReopen = sessionESes()[sessionESes().length - 1];
    expect(esReopen).not.toBe(esResume);
    expect(urlCursor(esReopen)).toBe(150);
  });
});

// Round-5b (coordinator adjudication on round-5 F1/F2): the PIN of the
// adjudicated behavior at the applySnap boundary — deliberately NOT
// tier1_b's failing regression. The residual gap tier1_b targeted (a
// snapshot CONTAINS repair for a keyed non-completed resident — a missing
// part — but prependMessagesIfAbsent skips merging it, reduce.ts:200-228)
// is a PRE-EXISTING store merge-policy defect, routed to a separate
// store-policy card; this slice does not change store semantics. This pin
// freezes the CURRENT adjudicated boundary on three conjuncts:
//   (a) the merge SKIPS (p2 stays absent — pins the store-policy boundary);
//   (b) the memory floor-raises to the snapshot seq AND the latch clears at
//       applySnap receipt (pins the adjudicated repair predicate — accepted
//       over freeze-until-merged, which would livelock the mismatch-recovery
//       loop into re-snapshot storms);
//   (c) close + unforced reopen sends the snapshot seq (the documented
//       pre-slice-parity boundary: pre-slice, the LIVE cursor advanced at
//       receipt — session-stream.ts:974 pre-slice — so the same reopen also
//       sent 300).
// If reduce.ts's merge semantics ever change (the separate store-policy
// card landing), this pin AND the round-5 F7 defer trigger fire.
describe("round-5b boundary pin — keyed incomplete resident's snapshot repair is merge-SKIPPED, yet the memory floor-raises and the latch clears", () => {
  it("m1 missing p2 → append@200 mismatch latches → cursorless recovery snapshot@300 (m1-with-p2, incomplete) → merge skips p2; memory → 300 + latch cleared; close+unforced reopen sends 300", async () => {
    // Seed: m1 KEYED (inserted into order by the cold snapshot) and
    // INCOMPLETE (no time.completed), its only part p1 (empty text — a
    // known-length target for the post-repair claim below). Memory = 100.
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es0 = sessionESes()[0];
    es0.fire(
      "snapshot",
      {
        seq: 100,
        gate: { [SID]: { messagesLoaded: true } },
        messages: {
          [SID]: [{
            info: { id: "m1", sessionID: SID, role: "assistant", time: { created: 1 } },
            parts: [{ id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "" }],
          }],
        },
      },
      "100.1",
    );
    await flushMicro();

    // The append for the MISSING p2 mismatches (part not resident → content
    // NOT applied) → the sid LATCHES; no pass in flight → the direct runs
    // synchronously → cursorless recovery open (esRec).
    es0.fire(
      "part.append",
      { sessionID: SID, messageID: "m1", partID: "p2", field: "text", start: 0, text: "XX" },
      "200.2",
    );
    await flushMicro(2);
    const esRec = sessionESes()[1];
    expect(esRec).not.toBe(es0);
    expect(urlCursor(esRec)).toBe(0);

    // The cursorless recovery delivers its authoritative snapshot@300
    // carrying m1-WITH-p2 — but m1's incoming copy is still INCOMPLETE, so
    // the store's merge policy (prependMessagesIfAbsent) leaves the KEYED
    // resident untouched: the repair does NOT land.
    esRec.fire(
      "snapshot",
      {
        seq: 300,
        gate: { [SID]: { messagesLoaded: true } },
        messages: {
          [SID]: [{
            info: { id: "m1", sessionID: SID, role: "assistant", time: { created: 1 } },
            parts: [
              { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "STALE" },
              { id: "p2", sessionID: SID, messageID: "m1", type: "text", text: "repaired" },
            ],
          }],
        },
      },
      "300.1",
    );
    await flushMicro();

    // (a) THE STORE-POLICY BOUNDARY (pinned, not fixed — separate card): the
    // merge skipped m1's repair — p2 is STILL absent, and the resident p1
    // body was not clobbered by the stale incoming copy (live-wins).
    expect(store.state.messages[SID]?.byId?.m1?.parts?.p2).toBeUndefined();
    expect(
      (store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text,
    ).toBe("");

    // (c) Close + UNFORCED reopen (the re-selection shape): the close zeroes
    // the LIVE cursor, so the 300 can come ONLY from the memory — applySnap's
    // floor-raise fired at receipt THROUGH the merge policy even though the
    // merge skipped p2 (the adjudicated predicate). Pre-slice parity: the
    // LIVE cursor also sat at 300 after receipt, so the same reopen sent 300
    // from it — the fix preserves that wire value by a different mechanism.
    stream.closeSessionStream();
    stream.openSessionStream(SID, false, "selection-change", "reselect");
    const esReopen = sessionESes()[sessionESes().length - 1];
    expect(esReopen).not.toBe(esRec);
    expect(urlCursor(esReopen)).toBe(300);

    // (b, latch half) The latch CLEARED at applySnap: a clean applicable
    // suffix at 350 on the reopen connection CLAIMS again — a still-latched
    // sid would void the claim and leave the memory at 300 (the latch-clear
    // observation; a never-clearing latch is exactly the frozen-memory
    // regression this half catches).
    esReopen.fire(
      "part.append",
      { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 0, text: "abc" },
      "350.1",
    );
    await flushMicro(2);
    expect(
      (store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text,
    ).toBe("abc"); // the suffix APPLIED
    // Unmask the memory: cursorless forced open with NO delivery (zeroes the
    // live cursor), then reveal — 350 proves the post-clear claim ran.
    stream.openSessionStream(SID, true, "recovery-fresh", "r5b-zeroing");
    sesMod.suspendSessionStreamForVisibility();
    sesMod.resumeSessionStreamForVisibility();
    expect(urlCursor(sessionESes()[sessionESes().length - 1])).toBe(350);
  });
});
