// @vitest-environment jsdom
//
// history-merge-transport.test.ts — the three TRANSPORT no-resurrection pins,
// card task-2026-11-07t15-07-21-store-merge-verify-first (verify-first stage
// 1). BINDING design basis: tmp/agent-runs/store-merge/eligibility.md (Q1's
// per-caller ordering receipts + Q3 case 3's satisfiable forms; the pure
// reducer cannot distinguish "missing because deleted" from "missing because
// never shipped" — NO item-level eligibility signal exists — so resurrection
// safety lives ONLY in the transport orderings pinned here).
//
// THE ORDERING PREMISE (cited in-test below): all THREE production callers of
// prependMessagesIfAbsent are fresh-capture-or-delete-replaying BY
// CONSTRUCTION (eligibility Q1 receipts):
//   1. Stream-2 session snapshot (web/src/sync/session-stream.ts:887-938):
//      snapshot frames are captures at connection open; live events in the
//      gzip64 decode window serialize BEHIND the decode (session-stream.ts:
//      1386-1395); SSE delivery on one connection is ordered. A delete the
//      client applied was processed server-side BEFORE any later capture, and
//      a delete processed after capture arrives as an event applied AFTER the
//      snapshot and re-deletes (client deletePart is idempotent).
//   2. messages.batch (web/src/sync/reducers.ts:369-394): server-side cold
//      batches are packaged under the msgRev ABA guard — a delete racing the
//      package bumps msgRev and the stale package is discarded and repackaged
//      (pkg/state/message_window.go publishColdBatch; pinned Go-side by
//      pkg/state/message_window_msgrev_aba_test.go).
//   3. Historical page (web/src/sync/history.ts:407-464): guarded by the
//      Contract-B dirty gate — part.delete / message.delete / messages.batch
//      during a page flight mark it dirty and the response gate discards +
//      bounded-retries (history.ts:291-346) — pinned part-level in §3a here.
//
// TEST-ONLY slice (stage 1): the stage-1 verify-first card modified ZERO
// production files. Real modules are driven through the REAL listener
// machinery (MockEventSource → session-stream listeners →
// applyMessageEvent/applySessionSnapshot), the persistence-harness pattern
// (session-cursor-persistence.test.ts). STAGE 2 (card
// task-2026-11-07t15-45-23-store-merge-stage2-admission) folded the stage-1
// review's F1 defer here (§3a now fires part.delete through the REAL
// session-stream listener) and added the §case-4 paired case for the
// admitted page-merge behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { gzipSync } from "node:zlib";
import { buildMessages, prependMessagesIfAbsent } from "../../src/lib/reduce";
import type { SessionMessages } from "../../src/types";

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
}

let instances: MockEventSource[] = [];
const sessionESes = (): MockEventSource[] =>
  instances.filter((e) => /sessions=[^&]/.test(e.url));

let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
let sesMod: typeof import("../../src/sync/session-stream") = null as unknown as typeof import("../../src/sync/session-stream");
let history: typeof import("../../src/sync/history") = null as unknown as typeof import("../../src/sync/history");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  instances = [];
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  sesMod = await import("../../src/sync/session-stream");
  history = await import("../../src/sync/history");
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

const flushMicro = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};
const waitTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
// Real-timer settle for macrotask-spanning gzip64 decodes (the persistence /
// property-suite discipline: fake timers do not fake the DecompressionStream
// settle path).
async function settleReal(n = 8): Promise<void> {
  for (let i = 0; i < n; i++) {
    await waitTick();
    await flushMicro(5);
  }
}

const gzip64Snapshot = (snap: unknown): { encoding: "gzip64"; data: string } => ({
  encoding: "gzip64",
  data: Buffer.from(gzipSync(Buffer.from(JSON.stringify(snap)))).toString("base64"),
});

const SID = "s1";

// ═════════════════════════════════════════════════════════════════════════════
// §3a — page dirty-gate, PART level: a served history page whose parts change
// mid-flight stays dirty so the re-fetch heals (history.ts markPageDirty /
// isPageDirtyingKind; the production call site is the Stream2 listener hook —
// session-stream.ts:2032-2034 `if (sid && isPageDirtyingKind(kind))
// markPageDirty(sid)`).
// ═════════════════════════════════════════════════════════════════════════════
describe("§3a page dirty-gate (part-level): a part.delete during a page flight discards the stale page and re-fetches", () => {
  it("part.delete mid-flight (fired through the REAL session-stream listener) → stale page (still carrying the deleted part) is discarded; the re-fetch heals — no resurrection", async () => {
    // Resident tail: m5 with one part. Window says older history exists.
    const sm = buildMessages([
      {
        info: { id: "m5", sessionID: "s1", role: "user", time: { created: 50 } },
        parts: [{ id: "p-m5", sessionID: "s1", messageID: "m5", type: "text", text: "tail" }],
      },
    ]);
    store.setState("epoch", "e1");
    store.setState("messages", "s1", sm);
    store.setState("messageWindows", "s1", { hasOlder: true, oldestResidentID: "m5" });

    // The STALE page (captured BEFORE the server processed part.delete(m4,
    // pb)) still carries m4 with BOTH parts. The HEALED page (captured after
    // the delete — snapshots/pages represent deletion by ABSENCE ONLY,
    // eligibility Q1) carries m4 with pa alone.
    const stalePageItem = {
      info: { id: "m4", sessionID: "s1", role: "user", time: { created: 40 } },
      parts: [
        { id: "pa", sessionID: "s1", messageID: "m4", type: "text", text: "A" },
        { id: "pb", sessionID: "s1", messageID: "m4", type: "text", text: "B-deleted-server-side" },
      ],
    };
    const healedPageItem = {
      info: { id: "m4", sessionID: "s1", role: "user", time: { created: 40 } },
      parts: [{ id: "pa", sessionID: "s1", messageID: "m4", type: "text", text: "A" }],
    };
    const pageResponse = (item: any) => ({
      items: [item],
      oldest_id: "m4",
      newest_id: "m4",
      has_older: false,
      session_id: "s1",
      project_id: "",
      daemon_epoch: "e1",
      baseline_seq: 1,
      request_before: "m5",
      serialized_bytes: 0,
      count_limited: false,
      bytes_limited: false,
    });
    const makeResponse = (body: any) =>
      ({
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name === "X-VH-Seq" ? "1" : name === "X-VH-Epoch" ? "e1" : null,
        },
        json: async () => body,
      }) as any;

    // F1 FOLD (stage-1 review defer, folded at store-merge stage 2): drive
    // the dirty mark through the REAL session-stream listener —
    // MockEventSource → the session-stream message listener →
    // applyMessageEvent(part.delete) + the Stream2 hook `if (sid &&
    // isPageDirtyingKind(kind)) markPageDirty(sid)` — instead of calling
    // markPageDirty directly inside the fetch mock. The server processed
    // part.delete(m4, pb) mid-flight and the event reaches the client while
    // the (pre-delete) page response is being read; m4/pb is not yet
    // resident, so the applied delete no-ops on content — the dirty MARK is
    // the load-bearing effect this leg proves reaches the gate from the real
    // wire path.
    stream.openSessionStream("s1", false, "first-open", "boot");
    let fetchCount = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: unknown) => {
      if (typeof url !== "string" || !url.includes("/vh/session/")) {
        return new Response("{}", { status: 200 }); // non-page fetches: benign
      }
      fetchCount++;
      if (fetchCount === 1) {
        sessionESes()[sessionESes().length - 1].fire(
          "part.delete",
          { sessionID: "s1", messageID: "m4", partID: "pb" },
          "150.1",
        );
        return makeResponse(pageResponse(stalePageItem));
      }
      return makeResponse(pageResponse(healedPageItem));
    });
    vi.stubGlobal("fetch", fetchMock);

    await history.loadOlder("s1");

    // The dirty gate DISCARDED the stale response and re-fetched (healed).
    expect(fetchCount).toBe(2);
    // The deleted part NEVER resurrected: m4 is resident with pa alone.
    const m4 = store.state.messages.s1?.byId?.m4;
    expect(m4).toBeDefined();
    expect(m4?.parts?.pa?.text).toBe("A");
    expect(m4?.parts?.pb).toBeUndefined();
    expect(store.state.messages.s1?.order).toEqual(["m4", "m5"]);
    expect(store.state.messageWindows.s1?.oldestResidentID).toBe("m4");

    // COUNTERFACTUAL (load-bearing-ness proof): the merge ALONE would have
    // resurrected pb — prependMessagesIfAbsent on the stale page installs
    // every part it carries (absence never deletes, but presence installs).
    // The dirty gate is the ONLY thing standing between the stale capture and
    // the store on this path.
    const scratch: SessionMessages = buildMessages([
      {
        info: { id: "m5", sessionID: "s1", role: "user", time: { created: 50 } },
        parts: [{ id: "p-m5", sessionID: "s1", messageID: "m5", type: "text", text: "tail" }],
      },
    ]);
    prependMessagesIfAbsent(scratch, [stalePageItem]);
    expect(scratch.byId["m4"].parts["pb"]).toBeDefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §3b — snapshot-then-part.delete healing through the REAL session-stream
// decode path: a part.delete after a snapshot removes the part, and a
// subsequent FRESH (post-delete) snapshot does not resurrect it — including
// when the delete lands INSIDE the gzip64 decode window (serialized behind
// the decode, applied after — session-stream.ts:1386-1395) and when the fresh
// snapshot takes the most invasive merge path (completed upgrade).
// ═════════════════════════════════════════════════════════════════════════════
describe("§3b snapshot-then-part.delete healing (real session-stream path)", () => {
  it("raw snapshot path: snapshot installs p2 → part.delete removes it → FRESH completed snapshot does not resurrect it", async () => {
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es = sessionESes()[0];

    // Snapshot@100 (raw — synchronous apply): m1 keyed incomplete with p1+p2.
    es.fire(
      "snapshot",
      {
        seq: 100,
        gate: { [SID]: { messagesLoaded: true } },
        messages: {
          [SID]: [{
            info: { id: "m1", sessionID: SID, role: "assistant", time: { created: 1 } },
            parts: [
              { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "live" },
              { id: "p2", sessionID: SID, messageID: "m1", type: "text", text: "doomed" },
            ],
          }],
        },
      },
      "100.1",
    );
    await flushMicro();
    expect(store.state.messages[SID]?.byId?.m1?.parts?.p1?.text).toBe("live");
    expect(store.state.messages[SID]?.byId?.m1?.parts?.p2?.text).toBe("doomed");

    // part.delete@200 through the REAL listener → applyMessageEvent →
    // deletePart: the part is removed (idempotent hard delete).
    es.fire(
      "part.delete",
      { sessionID: SID, messageID: "m1", partID: "p2" },
      "200.2",
    );
    await flushMicro();
    expect(store.state.messages[SID]?.byId?.m1?.parts?.p2).toBeUndefined();
    expect(store.state.messages[SID]?.byId?.m1?.parts?.p1?.text).toBe("live");

    // FRESH (post-delete) snapshot@300: captured AFTER the server processed
    // the delete, so it represents the deletion by ABSENCE (carries p1 only)
    // and marks m1 COMPLETED — driving the merge's most invasive path, the
    // completed-upgrade (mergePartsOrdered assignPresent=true). The upgrade
    // runs (p1 body upgraded) and STILL does not resurrect p2: the merge only
    // admits parts the incoming copy carries.
    es.fire(
      "snapshot",
      {
        seq: 300,
        gate: { [SID]: { messagesLoaded: true } },
        messages: {
          [SID]: [{
            info: {
              id: "m1", sessionID: SID, role: "assistant",
              time: { created: 1, completed: 299 },
            },
            parts: [{ id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "final-full" }],
          }],
        },
      },
      "300.3",
    );
    await flushMicro();
    // The completed upgrade ENGAGED (proves the merge path ran, not a skip).
    expect(store.state.messages[SID]?.byId?.m1?.parts?.p1?.text).toBe("final-full");
    expect(store.state.messages[SID]?.byId?.m1?.info?.time?.completed).toBe(299);
    // NO RESURRECTION: p2 stays absent under the fresh-capture merge.
    expect(store.state.messages[SID]?.byId?.m1?.parts?.p2).toBeUndefined();
  });

  it("gzip64 decode-window path: part.delete delivered DURING the decode serializes behind it, applies after, and a fresh gzip64 snapshot does not resurrect", async () => {
    // gzip64 decodes settle across macrotasks — real timers (the persistence /
    // property-suite gzip64 discipline).
    vi.useRealTimers();
    stream.openSessionStream(SID, false, "first-open", "boot");
    const es = sessionESes()[0];

    // Snapshot@100 as gzip64 (async decode starts; sesSnapshotDecoding set
    // synchronously at listener entry — session-stream.ts:1402-1431).
    es.fire(
      "snapshot",
      gzip64Snapshot({
        seq: 100,
        gate: { [SID]: { messagesLoaded: true } },
        messages: {
          [SID]: [{
            info: { id: "m1", sessionID: SID, role: "assistant", time: { created: 1 } },
            parts: [
              { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "live" },
              { id: "p2", sessionID: SID, messageID: "m1", type: "text", text: "doomed" },
            ],
          }],
        },
      }),
      "100.1",
    );
    // The delete fires SYNCHRONOUSLY while the decode is in flight — the
    // decode-window serialization premise itself (session-stream.ts:1952-1973:
    // the message listener awaits sesSnapshotDecode before any state effect).
    es.fire(
      "part.delete",
      { sessionID: SID, messageID: "m1", partID: "p2" },
      "200.2",
    );
    await settleReal();

    // Ordering healed: the snapshot applied first (p1 + p2 installed), THEN
    // the serialized delete removed p2. Final state: p2 absent.
    expect(store.state.messages[SID]?.byId?.m1?.parts?.p1?.text).toBe("live");
    expect(store.state.messages[SID]?.byId?.m1?.parts?.p2).toBeUndefined();

    // FRESH (post-delete) gzip64 snapshot@300, completed copy, p1 only.
    es.fire(
      "snapshot",
      gzip64Snapshot({
        seq: 300,
        gate: { [SID]: { messagesLoaded: true } },
        messages: {
          [SID]: [{
            info: {
              id: "m1", sessionID: SID, role: "assistant",
              time: { created: 1, completed: 299 },
            },
            parts: [{ id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "final-full" }],
          }],
        },
      }),
      "300.3",
    );
    await settleReal();
    expect(store.state.messages[SID]?.byId?.m1?.parts?.p1?.text).toBe("final-full");
    expect(store.state.messages[SID]?.byId?.m1?.info?.time?.completed).toBe(299);
    expect(store.state.messages[SID]?.byId?.m1?.parts?.p2).toBeUndefined();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// §case-4 — the HISTORY-PAGE paired case under the stage-2 ADMISSION (card
// task-2026-11-07t15-45-23-store-merge-stage2-admission; the fourth paired
// case from the store-merge draft, eligibility Q3): a clean page merge
// ADMITS a keyed non-completed resident's MISSING parts while PRESERVING its
// live parts (bodies/info never overwritten — live-wins stays). Also pins
// the case-4 bookkeeping invariants: `added` counts only NEW message ids, so
// oldestResidentID/hasOlder move by the server page meta alone (eligibility
// Q2 receipts — part admission into an existing resident leaves `added`
// unchanged → history.ts eviction bookkeeping unaffected).
// ═════════════════════════════════════════════════════════════════════════════
describe("§case-4 page merge under admission — keyed resident gains missing parts, live body preserved, insert-only bookkeeping", () => {
  it("page [m3 (new), m4 (resident keyed incomplete: stale pl4 body + missing p-miss4)] → m3 inserted, p-miss4 ADMITTED, pl4 live body kept; window meta from page only", async () => {
    // Resident state: m5 (tail) + m4 (oldest), both KEYED + incomplete. m4
    // holds one LIVE part pl4 ("live4" — streamed live; the body the
    // live-wins guard protects) and is MISSING p-miss4 (e.g. its part.upsert
    // was lost out-of-window — the repair class admission targets).
    const sm = buildMessages([
      {
        info: { id: "m4", sessionID: "s1", role: "user", time: { created: 40 } },
        parts: [{ id: "pl4", sessionID: "s1", messageID: "m4", type: "text", text: "live4" }],
      },
      {
        info: { id: "m5", sessionID: "s1", role: "user", time: { created: 50 } },
        parts: [{ id: "p-m5", sessionID: "s1", messageID: "m5", type: "text", text: "tail" }],
      },
    ]);
    store.setState("epoch", "e1");
    store.setState("messages", "s1", sm);
    store.setState("messageWindows", "s1", { hasOlder: true, oldestResidentID: "m4" });

    // The page (request_before=m4) carries m3 (genuinely new) AND m4's
    // server copy: pl4 with a STALE body ("stale-page4" — must NOT overwrite
    // "live4") plus the MISSING p-miss4 ("miss4-repaired" — must INSTALL).
    const pageResponse = {
      items: [
        {
          info: { id: "m3", sessionID: "s1", role: "user", time: { created: 30 } },
          parts: [{ id: "p-m3", sessionID: "s1", messageID: "m3", type: "text", text: "older" }],
        },
        {
          info: { id: "m4", sessionID: "s1", role: "user", time: { created: 40 } },
          parts: [
            { id: "pl4", sessionID: "s1", messageID: "m4", type: "text", text: "stale-page4" },
            { id: "p-miss4", sessionID: "s1", messageID: "m4", type: "text", text: "miss4-repaired" },
          ],
        },
      ],
      oldest_id: "m3",
      newest_id: "m4",
      has_older: false,
      session_id: "s1",
      project_id: "",
      daemon_epoch: "e1",
      baseline_seq: 1,
      request_before: "m4",
      serialized_bytes: 0,
      count_limited: false,
      bytes_limited: false,
    };
    let fetchCount = 0;
    const fetchMock = vi.fn().mockImplementation(async (url: unknown) => {
      if (typeof url !== "string" || !url.includes("/vh/session/")) {
        return new Response("{}", { status: 200 }); // non-page fetches: benign
      }
      fetchCount++;
      return {
        ok: true,
        status: 200,
        headers: {
          get: (name: string) =>
            name === "X-VH-Seq" ? "1" : name === "X-VH-Epoch" ? "e1" : null,
        },
        json: async () => pageResponse,
      } as any;
    });
    vi.stubGlobal("fetch", fetchMock);

    await history.loadOlder("s1");

    // Clean page — exactly one fetch (no dirty, no retry).
    expect(fetchCount).toBe(1);
    // THE PAIRED CASE: p-miss4 ADMITTED (the repair lands), pl4's live body
    // PRESERVED (the stale page body did NOT overwrite it), info untouched,
    // partOrder = server order with no dups (integrity maintained).
    const m4 = store.state.messages.s1?.byId?.m4;
    expect(m4?.parts?.pl4?.text).toBe("live4");
    expect(m4?.parts?.["p-miss4"]?.text).toBe("miss4-repaired");
    expect(m4?.partOrder).toEqual(["pl4", "p-miss4"]);
    expect(m4?.info?.time?.completed).toBeUndefined();
    // Insert-only bookkeeping: m3 inserted (added counted it alone), order
    // created-sorted, window meta moved by the server page alone.
    expect(store.state.messages.s1?.order).toEqual(["m3", "m4", "m5"]);
    expect(store.state.messages.s1?.byId?.m3?.parts?.["p-m3"]?.text).toBe("older");
    expect(store.state.messageWindows.s1?.oldestResidentID).toBe("m3");
    expect(store.state.messageWindows.s1?.hasOlder).toBe(false);
  });
});
