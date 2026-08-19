// @vitest-environment jsdom
//
// Slice 3 of the part-append-streaming redesign — FE apply + frame-batch tests.
// (see docs/ai/wire-protocols/part-append-streaming.md — the wire-protocol spec;
//  the pure apply lives in src/lib/reduce.ts appendPartSuffix; the transport
//  layer + frame-batching lives in src/sync/session-stream.ts.)
//
// TWO test surfaces:
//   1. PURE UNIT — appendPartSuffix + utf8ByteLength (src/lib/reduce.ts): the
//      offset-validation + in-place append + merge/completion-ordering logic,
//      tested directly on a hand-built SessionMessages draft (no store, no SSE).
//   2. INTEGRATION — session-stream.ts: the part_delta=1 URL negotiation, the
//      part.append listener manifest, frame-batching (one setState per tick —
//      exercised via MockEventSource's SAME-TASK synchronous fire, the lane-5
//      unit mechanism; under NATIVE EventSource the batch does NOT engage,
//      measured cardinality 1, commit 693433e),
//      the end-to-end append through the real Solid store, multi-byte UTF-8
//      validation, offset-mismatch → cursorless re-snapshot, and the kill-switch
//      disabled → legacy revert path.
//
// The CRITICAL carry-forward from slice 2's review: `start` is a UTF-8 BYTE
// offset, NOT a UTF-16 code-unit index (JS .length). The multi-byte tests below
// pin this — a field containing é/日本語/emoji has byteLen > .length, and using
// .length would falsely mismatch a correct server-side byte offset.
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { createEffect } from "solid-js";
import {
  appendPartSuffix,
  utf8ByteLength,
  upsertMessage,
  upsertPart,
  prependMessagesIfAbsent,
  type PartAppendPayload,
} from "../../src/lib/reduce";
import type { SessionMessages } from "../../src/types";

// ---------------------------------------------------------------------------
// PURE UNIT — utf8ByteLength + appendPartSuffix (no store, no SSE)
// ---------------------------------------------------------------------------

describe("utf8ByteLength — UTF-8 byte length (NOT UTF-16 code units)", () => {
  it("ASCII: byte length === .length", () => {
    expect(utf8ByteLength("Hello")).toBe(5);
    expect(utf8ByteLength("")).toBe(0);
  });

  it("2-byte chars (é, ñ, ö) count as 2 bytes each, not 1", () => {
    // "héllo" = h(1) + é(2) + l(1) + l(1) + o(1) = 6 bytes, but .length === 5.
    expect(utf8ByteLength("héllo")).toBe(6);
    expect("héllo".length).toBe(5); // pin the divergence the offset check relies on
  });

  it("3-byte chars (CJK: 日本語) count as 3 bytes each", () => {
    // 日本語 = 3 chars × 3 bytes = 9 bytes, .length === 3.
    expect(utf8ByteLength("日本語")).toBe(9);
    expect("日本語".length).toBe(3);
  });

  it("4-byte chars (emoji: 😀) count as 4 bytes (surrogate pair in UTF-16)", () => {
    // 😀 = 1 codepoint, 4 UTF-8 bytes, 2 UTF-16 code units (.length === 2).
    expect(utf8ByteLength("😀")).toBe(4);
    expect("😀".length).toBe(2);
  });

  it("mixed ASCII + multi-byte: byte length is the SUM of per-codepoint byte widths", () => {
    // "Hi é 日本 😀" = H(1) i(1) space(1) é(2) space(1) 日(3) 本(3) space(1) 😀(4) = 17 bytes
    expect(utf8ByteLength("Hi é 日本 😀")).toBe(17);
  });
});

// Build a SessionMessages with one assistant message `m1` carrying a text part
// `p1` whose `text` field is `fieldText`. The part/message objects are stable
// references so object-identity assertions are meaningful.
function smWithPart(fieldText: string, opts?: { completed?: boolean }): SessionMessages {
  return {
    order: ["m1"],
    byId: {
      m1: {
        id: "m1",
        info: {
          id: "m1",
          sessionID: "s",
          role: "assistant",
          time: opts?.completed ? { created: 10, completed: 20 } : { created: 10 },
        },
        partOrder: ["p1"],
        parts: {
          p1: { id: "p1", sessionID: "s", messageID: "m1", type: "text", text: fieldText },
        },
      },
    },
  };
}

function appendPay(
  overrides: Partial<PartAppendPayload> & { start: number; text: string },
): PartAppendPayload {
  return {
    sessionID: "s",
    messageID: "m1",
    partID: "p1",
    field: "text",
    ...overrides,
  };
}

describe("appendPartSuffix — pure suffix apply (offset validation + append)", () => {
  it("appends a suffix when start === current field UTF-8 byte length", () => {
    const sm = smWithPart("Hello"); // 5 ASCII bytes
    const result = appendPartSuffix(sm, appendPay({ start: 5, text: " world" }));
    expect(result).toBe("applied");
    expect((sm.byId.m1.parts.p1 as { text: string }).text).toBe("Hello world");
  });

  it("returns mismatch when start disagrees with the field byte length", () => {
    const sm = smWithPart("Hello"); // 5 bytes
    expect(appendPartSuffix(sm, appendPay({ start: 3, text: " world" }))).toBe("mismatch");
    // Field is UNCHANGED on mismatch (no byte-splice at the wrong offset).
    expect((sm.byId.m1.parts.p1 as { text: string }).text).toBe("Hello");
  });

  it("VALIDATES UTF-8 BYTES, not UTF-16 code units (multi-byte field)", () => {
    // "héllo" is 6 UTF-8 bytes but 5 UTF-16 code units (.length===5).
    const sm = smWithPart("héllo");
    // CORRECT server offset: 6 bytes.
    expect(appendPartSuffix(sm, appendPay({ start: 6, text: "!" }))).toBe("applied");
    expect((sm.byId.m1.parts.p1 as { text: string }).text).toBe("héllo!");
    // WRONG offset (UTF-16 code-unit length): 5 would falsely mismatch.
    const sm2 = smWithPart("héllo");
    expect(appendPartSuffix(sm2, appendPay({ start: 5, text: "!" }))).toBe("mismatch");
  });

  it("multi-byte contiguous resume (CJK + emoji)", () => {
    const sm = smWithPart("日本語"); // 9 bytes
    // Append "😀" (4 bytes): start must be 9 (byte offset), NOT 3 (.length).
    expect(appendPartSuffix(sm, appendPay({ start: 9, text: "😀" }))).toBe("applied");
    expect((sm.byId.m1.parts.p1 as { text: string }).text).toBe("日本語😀");
    // Next suffix: field is now "日本語😀" = 9 + 4 = 13 bytes.
    expect(appendPartSuffix(sm, appendPay({ start: 13, text: "!" }))).toBe("applied");
    expect((sm.byId.m1.parts.p1 as { text: string }).text).toBe("日本語😀!");
  });

  it("contiguous resume across several ASCII suffixes (the happy path)", () => {
    const sm = smWithPart(""); // 0 bytes
    expect(appendPartSuffix(sm, appendPay({ start: 0, text: "Hello" }))).toBe("applied");
    expect(appendPartSuffix(sm, appendPay({ start: 5, text: " world" }))).toBe("applied");
    expect(appendPartSuffix(sm, appendPay({ start: 11, text: "!" }))).toBe("applied");
    expect((sm.byId.m1.parts.p1 as { text: string }).text).toBe("Hello world!");
  });

  it("PRESERVES the resident Part object identity (in-place mutation)", () => {
    const sm = smWithPart("Hello");
    const partRef = sm.byId.m1.parts.p1;
    appendPartSuffix(sm, appendPay({ start: 5, text: " world" }));
    // SAME object reference — no new Part created (chat-row identity + scroll preserved).
    expect(sm.byId.m1.parts.p1).toBe(partRef);
    expect((sm.byId.m1.parts.p1 as { text: string }).text).toBe("Hello world");
  });

  it("upgrade-on-completed: a suffix for a COMPLETED message is SKIPPED (field unchanged)", () => {
    const sm = smWithPart("final", { completed: true });
    expect(appendPartSuffix(sm, appendPay({ start: 5, text: " stale" }))).toBe("skipped");
    // The completed field is authoritative/terminal — the stale suffix is dropped.
    expect((sm.byId.m1.parts.p1 as { text: string }).text).toBe("final");
  });

  it("merge-if-absent: seeds an UNSET field from start===0 (first suffix for the field)", () => {
    // Part exists (metadata upsert) but the streaming field was never set.
    const sm = smWithPart("");
    delete (sm.byId.m1.parts.p1 as { text?: string }).text;
    expect(appendPartSuffix(sm, appendPay({ start: 0, text: "first" }))).toBe("applied");
    expect((sm.byId.m1.parts.p1 as { text: string }).text).toBe("first");
  });

  it("returns mismatch for an unset field when start !== 0", () => {
    const sm = smWithPart("");
    delete (sm.byId.m1.parts.p1 as { text?: string }).text;
    expect(appendPartSuffix(sm, appendPay({ start: 5, text: "x" }))).toBe("mismatch");
  });

  it("returns mismatch when the MESSAGE is not resident", () => {
    const sm: SessionMessages = { order: [], byId: {} };
    expect(appendPartSuffix(sm, appendPay({ start: 0, text: "x" }))).toBe("mismatch");
  });

  it("returns mismatch when the PART is not resident", () => {
    const sm: SessionMessages = {
      order: ["m1"],
      byId: {
        m1: {
          id: "m1",
          info: { id: "m1", sessionID: "s", role: "assistant" },
          partOrder: [],
          parts: {},
        },
      },
    };
    expect(appendPartSuffix(sm, appendPay({ start: 0, text: "x" }))).toBe("mismatch");
  });

  it("works for the reasoning field (v1 allowlist)", () => {
    const sm = smWithPart("");
    delete (sm.byId.m1.parts.p1 as { text?: string }).text;
    (sm.byId.m1.parts.p1 as { reasoning?: string }).reasoning = "thinking...";
    const pay: PartAppendPayload = {
      sessionID: "s",
      messageID: "m1",
      partID: "p1",
      field: "reasoning",
      start: utf8ByteLength("thinking..."),
      text: " more",
    };
    expect(appendPartSuffix(sm, pay)).toBe("applied");
    expect((sm.byId.m1.parts.p1 as { reasoning: string }).reasoning).toBe("thinking... more");
  });
});

// ---------------------------------------------------------------------------
// F4 — appendPartSuffix × KEYLESS SHADOW path (281a2f2 mechanism; coverage
// gap flagged by the 2026-08-20 study: message-not-resident and
// part-not-resident were covered, parent-is-SHADOW-with-part-present was
// not). A shadow is byId-only (never in order); its stub info has NO time,
// so the not-completed check passes; a held part is found → offset-validated
// append applies; an unknown part routes to mismatch → the transport layer
// triggers a cursorless re-snapshot (session-stream flushAppends). These are
// coverage-only (the study traced the path correct-by-construction) —
// expected GREEN.
// ---------------------------------------------------------------------------

// Seed a KEYLESS SHADOW for message "mSh" holding one text part "p1" with
// `text` — via the production part-only path (upsertPart for a non-resident
// message), NOT a hand-built byId entry, so the stub shape is exactly what
// production creates.
function smWithShadowPart(fieldText: string): SessionMessages {
  const sm: SessionMessages = { order: [], byId: {} };
  upsertPart(sm, { id: "p1", sessionID: "s", messageID: "mSh", type: "text", text: fieldText });
  return sm;
}

function shadowPay(overrides: Partial<PartAppendPayload> & { start: number; text: string }): PartAppendPayload {
  return {
    sessionID: "s",
    messageID: "mSh",
    partID: "p1",
    field: "text",
    ...overrides,
  };
}

describe("appendPartSuffix × keyless shadow (F4 coverage)", () => {
  it("applies a suffix onto a SHADOW-HELD part; the shadow stays out of order", () => {
    const sm = smWithShadowPart("Hello"); // 5 ASCII bytes
    const partRef = sm.byId.mSh.parts.p1;
    expect(sm.order).toEqual([]); // precondition: mSh is a shadow, not rendered
    const res = appendPartSuffix(sm, shadowPay({ start: 5, text: " world" }));
    expect(res).toBe("applied");
    expect((sm.byId.mSh.parts.p1 as { text: string }).text).toBe("Hello world");
    // In-place append — the held Part object keeps its identity (promotion
    // later hands the SAME object to the rendered row).
    expect(sm.byId.mSh.parts.p1).toBe(partRef);
    // Still a shadow: applying a suffix must NOT realize it into order.
    expect(sm.order).toEqual([]);
  });

  it("a later keyed promotion (message.upsert) carries the appended text", () => {
    const sm = smWithShadowPart("Hello");
    appendPartSuffix(sm, shadowPay({ start: 5, text: " world" }));
    upsertMessage(sm, { id: "mSh", sessionID: "s", role: "assistant", time: { created: 42 } });
    // Promoted into order at its chronological slot — with the appended
    // suffix still in the held part.
    expect(sm.order).toEqual(["mSh"]);
    expect((sm.byId.mSh.parts.p1 as { text: string }).text).toBe("Hello world");
  });

  it("a later page-merge promotion (completed copy) carries the appended text and keeps part identity", () => {
    const sm = smWithShadowPart("Hello");
    appendPartSuffix(sm, shadowPay({ start: 5, text: " world" }));
    const partRef = sm.byId.mSh.parts.p1;
    // A Load-older page re-brings the message as a COMPLETED copy (terminal
    // upgrade path — the server copy is authoritative, parts assign in place).
    const added = prependMessagesIfAbsent(sm, [
      {
        info: { id: "mSh", sessionID: "s", role: "assistant", time: { created: 42, completed: 50 } },
        parts: [{ id: "p1", sessionID: "s", messageID: "mSh", type: "text", text: "Hello world" }],
      },
    ]);
    expect(added).toBe(0); // shadow-resident → upgrade/promotion, not an insert
    expect(sm.order).toEqual(["mSh"]);
    // mergePartsOrdered keeps the resident (held) object and Object.assigns
    // the completed copy onto it — identity preserved, text converged.
    expect(sm.byId.mSh.parts.p1).toBe(partRef);
    expect((sm.byId.mSh.parts.p1 as { text: string }).text).toBe("Hello world");
  });

  it("UNKNOWN part on a shadow → mismatch (routes to cursorless re-snapshot)", () => {
    const sm = smWithShadowPart("Hello");
    expect(
      appendPartSuffix(sm, shadowPay({ start: 5, text: "x", partID: "p-UNKNOWN" })),
    ).toBe("mismatch");
    // The held part is unchanged (no splice at any offset); the repair is the
    // transport layer's cursorless re-snapshot, already covered above.
    expect((sm.byId.mSh.parts.p1 as { text: string }).text).toBe("Hello");
    // The shadow itself is untouched by the failed apply.
    expect(sm.order).toEqual([]);
    expect(sm.byId.mSh).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// INTEGRATION — session-stream.ts (MockEventSource, real Solid store)
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
  listenerTypes(): string[] {
    return Array.from(this.listeners.keys()).sort();
  }
  fire(type: string, data: unknown, lastEventId = ""): void {
    const ev = new MessageEvent(type, {
      data: typeof data === "string" ? data : JSON.stringify(data),
    });
    Object.defineProperty(ev, "lastEventId", { value: lastEventId });
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
  instances.filter((e) => e.readyState !== CLOSED && /sessions=[^&]/.test(e.url));

let stream: typeof import("../../src/sync/stream") = null as unknown as typeof import("../../src/sync/stream");
let store: typeof import("../../src/sync/store") = null as unknown as typeof import("../../src/sync/store");
let sesMod: typeof import("../../src/sync/session-stream") = null as unknown as typeof import("../../src/sync/session-stream");

async function setupFresh(): Promise<void> {
  vi.resetModules();
  stream = await import("../../src/sync/stream");
  store = await import("../../src/sync/store");
  sesMod = await import("../../src/sync/session-stream");
  store.setProjectDirRaw("/test");
  store.setSelectedIdRaw("s1");
}

// Pump the microtask queue so queueMicrotask(flushAppends) drains. Fake timers
// do NOT fake microtasks, so Promise.resolve() drains them deterministically.
const flushMicro = async (n = 5): Promise<void> => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

// A RAW session snapshot for SID carrying message m1 (assistant). RAW → sync
// apply (no gzip64 decode). gate.messagesLoaded=true → marks delivered.
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
  // Restore the kill-switch default between tests.
  sesMod?._setPartDeltaEnabledForTest(true);
  // DEFER #2 O1 F1 (isolation): clear BOTH flush-cardinality collector slots
  // so a throwing-vector test cannot leak into a sibling. The module-level
  // slot is re-seeded null by vi.resetModules() in setupFresh, but the
  // globalThis.__vhFlushCollector slot is NOT module-scoped — a throwing
  // getter installed by one test would survive into the next without this.
  sesMod?._setFlushCardinalityCollectorForTest(null);
  delete (globalThis as { __vhFlushCollector?: unknown }).__vhFlushCollector;
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  delete (globalThis as unknown as { EventSource?: unknown }).EventSource;
});

describe("session-stream — part_delta=1 URL negotiation", () => {
  it("appends part_delta=1 to the /vh/stream query string when enabled (default)", () => {
    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    expect(es.url).toContain("part_delta=1");
    // z=1 is still present (coexists with the new capability flag).
    expect(es.url).toContain("z=1");
  });

  it("OMITS part_delta=1 when the kill-switch is disabled (legacy revert)", () => {
    sesMod._setPartDeltaEnabledForTest(false);
    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    expect(es.url).not.toContain("part_delta=1");
    // z=1 survives — the kill-switch is scoped to the suffix protocol only.
    expect(es.url).toContain("z=1");
  });
});

describe("session-stream — part.append listener manifest", () => {
  it("registers a part.append listener on the session EventSource", () => {
    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    expect(es.listenerTypes()).toContain("part.append");
  });
});

describe("session-stream — end-to-end suffix append through the Solid store", () => {
  it("seeds via part.upsert then appends a suffix via part.append", async () => {
    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    es.fire("snapshot", rawSessionSnap(1, SID, "m1"), "1");
    // Seed the part with base text "Hello" (5 bytes) via a legacy part.upsert.
    es.fire("part.upsert", { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "Hello" }, "2");
    expect((store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text).toBe("Hello");

    // part.append suffix: start=5 (byte offset), text=" world".
    es.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 5, text: " world" }, "3");
    // Buffered for frame-batch; not yet applied synchronously.
    expect((store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text).toBe("Hello");
    await flushMicro();
    expect((store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text).toBe("Hello world");
  });

  it("multi-byte UTF-8 validation through the store (é + CJK)", async () => {
    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    es.fire("snapshot", rawSessionSnap(1, SID, "m1"), "1");
    // Base field "héllo" = 6 UTF-8 bytes (é is 2 bytes).
    es.fire("part.upsert", { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "héllo" }, "2");
    // Correct byte offset: 6 (NOT .length===5).
    es.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 6, text: " 日本" }, "3");
    await flushMicro();
    // " 日本" = space(1) + 日(3) + 本(3) = 7 bytes appended; field now "héllo 日本".
    expect((store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text).toBe("héllo 日本");
  });
});

describe("session-stream — frame-batching (one reactive setState per SAME-TASK burst; lane-5 unit via MockEventSource — NOT native delivery)", () => {
  it("buffers multiple suffixes in one tick and applies them in a SINGLE flush", async () => {
    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    es.fire("snapshot", rawSessionSnap(1, SID, "m1"), "1");
    es.fire("part.upsert", { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "" }, "2");

    // Fire THREE contiguous suffixes synchronously (one event-loop tick).
    es.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 0, text: "Hello" }, "3");
    es.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 5, text: " world" }, "4");
    es.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 11, text: "!" }, "5");

    // CRUX: all three are BUFFERED (not yet applied) before the microtask flush.
    // If the code did per-suffix setState, the field would already be mutated.
    expect(sesMod._hasPendingAppendsForTest()).toBe(true);
    expect((store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text).toBe("");

    // ONE microtask pump flushes the whole buffer (one setState).
    await flushMicro();

    expect(sesMod._hasPendingAppendsForTest()).toBe(false);
    expect((store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text).toBe("Hello world!");
  });

  it("coalesces a SAME-TASK suffix burst into ONE reactive notification (lane-5 unit; MockEventSource fires synchronously — NOT native delivery)", async () => {
    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    es.fire("snapshot", rawSessionSnap(1, SID, "m1"), "1");
    es.fire("part.upsert", { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "" }, "2");

    // Track reactive notifications on the part's text field. A Solid createEffect
    // that reads .text re-runs once per reactive mutation (per setState that
    // touches the field). Frame-batching = ONE re-run for the whole SAME-TASK
    // burst (MockEventSource.fire dispatches synchronously in one task — the
    // lane-5 unit mechanism). Under NATIVE EventSource each event is its own
    // task so the microtask drains after each (cardinality 1, commit 693433e)
    // and this coalescing does NOT occur; the queue is retained for non-batching
    // work (gen-filter, mismatch aggregation, bumpUpdating, drain ordering).
    let runs = 0;
    let lastText = "";
    createEffect(() => {
      lastText = (store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string })?.text ?? "";
      runs++;
    });
    // Flush the initial effect setup (Solid runs the effect once on create).
    await flushMicro();
    const baseline = runs;

    // Fire THREE suffixes in one tick.
    es.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 0, text: "a" }, "3");
    es.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 1, text: "b" }, "4");
    es.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 2, text: "c" }, "5");
    await flushMicro();

    // Exactly ONE reactive notification beyond baseline (one setState, one flush).
    expect(runs).toBe(baseline + 1);
    expect(lastText).toBe("abc");
  });
});

describe("session-stream — offset mismatch → cursorless re-snapshot", () => {
  it("triggers openSessionStream(sid, true) on a byte-offset mismatch (new EventSource)", async () => {
    stream.openSessionStream(SID);
    const esBefore = sessionESes()[0];
    esBefore.fire("snapshot", rawSessionSnap(1, SID, "m1"), "1");
    esBefore.fire("part.upsert", { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "Hello" }, "2");

    // WRONG offset: field is 5 bytes, start claims 3.
    esBefore.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 3, text: " world" }, "3");
    expect(sesMod._hasPendingAppendsForTest()).toBe(true);

    const esCountBefore = sessionESes().length;
    await flushMicro();

    // Mismatch → openSessionStream(sid, true) → a fresh EventSource was created.
    expect(sesMod._hasPendingAppendsForTest()).toBe(false);
    expect(sessionESes().length).toBe(esCountBefore); // old one closed, new one opened = same count
    // The NEW ES is a different object than the one we fired against (which is CLOSED).
    expect(esBefore.readyState).toBe(CLOSED);
    const esAfter = sessionESes()[0];
    expect(esAfter).not.toBe(esBefore);
  });

  it("does NOT mutate the field on mismatch (no byte-splice at the wrong offset)", async () => {
    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    es.fire("snapshot", rawSessionSnap(1, SID, "m1"), "1");
    es.fire("part.upsert", { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "Hello" }, "2");

    es.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 99, text: "X" }, "3");
    await flushMicro();

    // The field is UNCHANGED (the mismatched suffix was not applied).
    expect((store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text).toBe("Hello");
  });
});

describe("session-stream — non-append kind drains the buffer first (seq ordering)", () => {
  it("applies buffered suffixes BEFORE a subsequent part.upsert (synchronous drain)", async () => {
    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    es.fire("snapshot", rawSessionSnap(1, SID, "m1"), "1");
    es.fire("part.upsert", { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "Hi" }, "2");

    // Buffer a suffix (not yet flushed — no microtask pump).
    es.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 2, text: "!" }, "3");
    expect(sesMod._hasPendingAppendsForTest()).toBe(true);
    expect((store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text).toBe("Hi");

    // A non-append kind (part.delete for a DIFFERENT part) drains the buffer
    // synchronously BEFORE its own apply. The buffered suffix lands first.
    es.fire("part.delete", { sessionID: SID, messageID: "m1", partID: "pOther" }, "4");

    // The suffix was applied synchronously by the drain (before part.delete).
    expect(sesMod._hasPendingAppendsForTest()).toBe(false);
    expect((store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text).toBe("Hi!");
  });
});

// t1d-F1 (slice 4 carry-forward): after drainPendingAppends() in the shared
// listener path, a drain-triggered cursorless re-snapshot (offset mismatch →
// openSessionStream(sid, true) inside flushAppends) bumps sesGen. The post-drain
// `if (gen !== sesGen) return` prevents the triggering non-append event from
// reaching applyMessageEvent on a stale gen — the fresh snapshot from the new
// connection is authoritative. Mirrors the post-await gen re-checks.
describe("session-stream — t1d-F1: post-drain gen-recheck (drain-triggered resnapshot)", () => {
  it("does NOT apply the triggering non-append event on a stale gen after a drain-triggered resnapshot", async () => {
    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    es.fire("snapshot", rawSessionSnap(1, SID, "m1"), "1");
    // Seed part p1 with text "Hello" (5 ASCII bytes).
    es.fire("part.upsert", { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "Hello" }, "2");
    expect((store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text).toBe("Hello");

    // Buffer a MISMATCHED part.append (start=3 but field is 5 bytes). The next
    // non-append event drains this synchronously → flushAppends detects the
    // mismatch → openSessionStream(sid, true) → sesGen++.
    es.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 3, text: " world" }, "3");
    expect(sesMod._hasPendingAppendsForTest()).toBe(true);

    // Fire a non-append kind (message.upsert for a NEW message m2) on the SAME
    // (now-stale) connection. The listener drains the buffer synchronously,
    // which triggers the resnapshot (sesGen++). Without the post-drain
    // gen-recheck, this m2 upsert would be applied on the STALE gen before the
    // fresh snapshot lands. message.upsert payload is the FLAT MessageInfo.
    es.fire("message.upsert", { id: "m2", sessionID: SID, role: "user", time: { created: 5 } }, "4");

    // Pump microtasks so any async tail settles. The gen-recheck is synchronous
    // (it runs before any await in the listener body — sesSnapshotDecoding is
    // false here so the snapshot-decode await is skipped), so m2 is already
    // deterministically absent, but pump for robustness.
    await flushMicro();

    // CRUX (t1d-F1): m2 was NOT applied — the stale-gen non-append event was
    // blocked by the post-drain gen-recheck. m2 can only be resident if the
    // upsert reached applyMessageEvent; it did not.
    expect(store.state.messages[SID]?.byId?.m2).toBeUndefined();

    // The drain-triggered resnapshot closed the old EventSource and opened a new
    // one (the reconnect half of the cursorless repair).
    expect(es.readyState).toBe(CLOSED);
    const esAfter = sessionESes()[0];
    expect(esAfter).not.toBe(es);

    // The fresh connection's authoritative snapshot lands cleanly (m1 from the
    // new snapshot; m2 remains absent because the stale upsert was blocked).
    esAfter.fire("snapshot", rawSessionSnap(5, SID, "m1"), "5");
    await flushMicro();
    expect(store.state.messages[SID]?.byId?.m1).toBeDefined();
    expect(store.state.messages[SID]?.byId?.m2).toBeUndefined();
  });
});

// Recovery convergence (#3 from the part-streaming review): the existing mismatch
// test above proves the TRIGGER (byte-offset mismatch → openSessionStream(sid,
// true) cursorless re-snapshot, new EventSource). It does NOT prove the RECOVERY
// CONVERGENCE — that after the fresh snapshot lands, a subsequent live
// part.append with the CORRECT UTF-8 byte offset applies cleanly and the field
// converges with NO second re-snapshot. This block closes that gap.
//
// Merge semantics note (why the snapshot "carrying" the authoritative field is
// consistent, not a clobber): applySessionSnapshot merges message bodies via
// prependMessagesIfAbsent — for a NON-completed resident message, LIVE ALWAYS
// WINS (the resident entry is left untouched). The mismatch did NOT mutate the
// field (no byte-splice at the wrong offset), so the resident "Hello" survives;
// the fresh snapshot agrees with it. The crux this test observes is the
// POST-SNAPSHOT correct-offset suffix applying cleanly and converging — the
// snapshot-offset-coherence contract (flushAppends comment: the post-snapshot
// suffix resumes at the client baseline).
describe("session-stream — recovery convergence: post-re-snapshot correct suffix converges (no second re-snapshot)", () => {
  it("after a mismatch-triggered cursorless re-snapshot, a correct-offset live suffix applies and the field converges", async () => {
    // --- Seed: resident part p1 with text "Hello" (5 ASCII bytes). ---
    stream.openSessionStream(SID);
    const esBefore = sessionESes()[0];
    esBefore.fire("snapshot", rawSessionSnap(1, SID, "m1"), "1");
    esBefore.fire("part.upsert", { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "Hello" }, "2");
    const partRef = store.state.messages[SID]?.byId?.m1?.parts?.p1;
    expect((partRef as { text?: string } | undefined)?.text).toBe("Hello");

    // --- (1) MISMATCH: field is 5 bytes, start claims 3 → triggers cursorless
    //         re-snapshot (the existing trigger). The field is NOT mutated. ---
    esBefore.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 3, text: " world" }, "3");
    expect(sesMod._hasPendingAppendsForTest()).toBe(true);
    await flushMicro();

    // Field UNCHANGED on mismatch (no byte-splice at the wrong offset).
    expect((store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text).toBe("Hello");
    // The old EventSource was closed; a fresh cursorless one was created.
    expect(esBefore.readyState).toBe(CLOSED);
    const esAfter = sessionESes()[0];
    expect(esAfter).not.toBe(esBefore);
    // Capture sesGen right after the ONE mismatch-triggered re-snapshot — it
    // MUST NOT bump again over the rest of the recovery arc.
    const genAfterResnap = sesMod.getSesGen();

    // --- (2) Fresh cursorless snapshot lands on the new connection, carrying
    //         the authoritative field "Hello" for m1 PLUS a second, NON-resident
    //         message m2. The m1 merge is live-wins for a non-completed streaming
    //         message (no observable change), so m1 alone would not prove the
    //         snapshot applied. m2 is absent before this snapshot, so the
    //         insert-if-absent path seeds it unconditionally — m2 becoming
    //         resident is the DIRECT proof the fresh snapshot landed (F3). ---
    esAfter.fire(
      "snapshot",
      {
        seq: 5,
        gate: { [SID]: { messagesLoaded: true } },
        messages: {
          [SID]: [
            {
              info: { id: "m1", sessionID: SID, role: "assistant", time: { created: 1 } },
              parts: [{ id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "Hello" }],
            },
            {
              info: { id: "m2", sessionID: SID, role: "user", time: { created: 2 } },
              parts: [{ id: "p2", sessionID: SID, messageID: "m2", type: "text", text: "hi" }],
            },
          ],
        },
      },
      "5",
    );
    expect((store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text).toBe("Hello");
    // F3: m2 was NOT resident before this snapshot (only m1 was seeded in step 1);
    // it is now — direct proof the fresh cursorless snapshot applied. The m1 merge
    // alone is unobservable (live-wins), so without m2 the snapshot-landing half
    // of the arc is only implied. m2's part content confirms a full seed, not a
    // stub.
    expect(store.state.messages[SID]?.byId?.m2).toBeDefined();
    expect((store.state.messages[SID]?.byId?.m2?.parts?.p2 as { text?: string }).text).toBe("hi");

    // --- (3) Subsequent CORRECT live suffix on the new connection: start=5
    //         (matches the resident field's UTF-8 byte length), text=" world".
    //         This is the post-snapshot suffix the snapshot-offset-coherence
    //         contract guarantees. ---
    esAfter.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 5, text: " world" }, "6");
    expect(sesMod._hasPendingAppendsForTest()).toBe(true);
    await flushMicro();

    // --- CRUX: the field converged to "Hello world" (snapshot baseline + the
    //         correctly-offset suffix). ---
    expect(sesMod._hasPendingAppendsForTest()).toBe(false);
    expect((store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text).toBe("Hello world");
    // Object identity PRESERVED through mismatch (no mutation) + snapshot
    // (live-wins merge) + correct suffix (in-place append): no Part object
    // recreated — chat-row identity + scroll preserved across the repair.
    expect(store.state.messages[SID]?.byId?.m1?.parts?.p1).toBe(partRef);
    // NO second re-snapshot: sesGen is stable after the one mismatch-triggered
    // bump (the correct-offset suffix did not mismatch → no new openSessionStream).
    expect(sesMod.getSesGen()).toBe(genAfterResnap);
    // And the recovery EventSource survived (not CLOSED by a second re-snapshot).
    expect(esAfter.readyState).not.toBe(CLOSED);
  });
});

// DEFER #2 O1 — F1 (data_integrity): the flush-cardinality observer sits on
// the production flush path AFTER the buffer was drained (pendingAppends = [])
// but BEFORE setState(produce(...)) applies the frames. A throwing observer
// MUST NOT abort the flush or the drained `frames` are silently dropped. The
// FIRST F1 fix wrapped the collector INVOCATION in try/catch; the bound re-
// review blocked again on a DISTINCT residual vector: resolveFlushCardinality-
// Collector() — which reads (globalThis as any).__vhFlushCollector — was
// called on a line OUTSIDE the try/catch, so a THROWING GETTER on that slot
// (reachable from any same-realm actor with code-injection access: browser
// extension, devtools console, third-party script — not just a test's
// addInitScript) would throw from the resolver, exit flushAppends AFTER the
// drain but BEFORE setState → silently drop the drained frames. The second-
// iteration fix wraps RESOLUTION + INVOCATION TOGETHER in one try/catch.
//
// These two tests exercise BOTH throwing vectors and assert the drained
// frames STILL reach the store (outcome, not mechanism) — proving the
// isolation is now airtight AND observed.
describe("session-stream — DEFER #2 O1 F1: throwing observer MUST NOT abort the flush (both vectors)", () => {
  // Shared seed: snapshot + part.upsert establishes resident field "Hello"
  // (5 ASCII bytes) for SID/m1/p1, so a start=5 suffix is a valid append.
  function seedHello(es: MockEventSource): void {
    es.fire("snapshot", rawSessionSnap(1, SID, "m1"), "1");
    es.fire("part.upsert", { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "Hello" }, "2");
    expect((store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text).toBe("Hello");
  }

  it("Vector 1 — THROWING COLLECTOR (module-level slot): drained frames STILL reach the store", async () => {
    // Install a collector callback that throws on every invocation. This is
    // the vector the FIRST F1 fix already isolated (invocation try/catch);
    // re-asserted here so the second-iteration fix's combined wrap does not
    // silently regress it.
    sesMod._setFlushCardinalityCollectorForTest(() => {
      throw new Error("collector boom");
    });

    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    seedHello(es);

    // Buffer a part.append suffix (5-byte "Hello" → start=5, text=" world").
    es.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 5, text: " world" }, "3");
    expect(sesMod._hasPendingAppendsForTest()).toBe(true);

    // Pump the microtask so queueMicrotask(flushAppends) runs. flushAppends
    // drains the buffer, then resolves + invokes the collector (which
    // throws). The throw MUST be contained — execution must reach setState.
    await flushMicro();

    // CRUX (outcome-observed): the drained frame reached the store despite
    // the throwing collector. If the throw had escaped, flushAppends would
    // have exited after the drain and BEFORE setState, leaving the field at
    // its pre-flush "Hello" — the silent-drop failure mode.
    expect(sesMod._hasPendingAppendsForTest()).toBe(false);
    expect((store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text).toBe("Hello world");
  });

  it("Vector 2 — THROWING GETTER on globalThis.__vhFlushCollector: drained frames STILL reach the store", async () => {
    // Leave the module-level collector unset so resolveFlushCardinality-
    // Collector falls through to the globalThis slot read. Install a throwing
    // ACCESSOR GETTER on that slot — this is the DISTINCT residual vector the
    // first F1 fix missed: the resolver was called OUTSIDE the try/catch, so
    // a throwing getter threw from the resolver itself (before any callback
    // invocation), exiting flushAppends after the drain but before setState.
    expect(sesMod._setFlushCardinalityCollectorForTest(null)).toBeNull();
    Object.defineProperty(globalThis, "__vhFlushCollector", {
      configurable: true,
      get() {
        throw new Error("getter boom");
      },
    });

    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    seedHello(es);

    es.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 5, text: " world" }, "3");
    expect(sesMod._hasPendingAppendsForTest()).toBe(true);

    await flushMicro();

    // CRUX (outcome-observed): the drained frame reached the store despite
    // the throwing getter. Before the second-iteration fix, the resolver
    // throw escaped flushAppends and the field stayed at "Hello" (silent
    // drop). The combined resolve+call try/catch now contains BOTH vectors.
    expect(sesMod._hasPendingAppendsForTest()).toBe(false);
    expect((store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text).toBe("Hello world");
  });

  it("both vectors: drained frames reach the store AND a NON-throwing collector still observes the cardinality", async () => {
    // Sanity guard against over-isolation: the wrap must NOT swallow a
    // well-behaved collector's observation. A non-throwing collector records
    // the cardinality AND the frames still apply — proving the isolation is
    // scoped to the throw path only, not a blanket no-op.
    const observed: number[] = [];
    sesMod._setFlushCardinalityCollectorForTest((n) => {
      observed.push(n);
    });

    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    seedHello(es);

    // Fire TWO contiguous suffixes in one tick → one flush with cardinality 2.
    es.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 5, text: " wor" }, "3");
    es.fire("part.append", { sessionID: SID, messageID: "m1", partID: "p1", field: "text", start: 9, text: "ld" }, "4");
    await flushMicro();

    // The non-throwing collector observed the flush cardinality (2 frames).
    expect(observed).toEqual([2]);
    // And the frames applied to the store (converged text).
    expect((store.state.messages[SID]?.byId?.m1?.parts?.p1 as { text?: string }).text).toBe("Hello world");
  });
});
