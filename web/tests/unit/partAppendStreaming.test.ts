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
//      part.append listener manifest, frame-batching (one setState per tick),
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

describe("session-stream — frame-batching (one reactive setState per tick)", () => {
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

  it("coalesces a suffix burst into ONE reactive notification (createEffect count)", async () => {
    stream.openSessionStream(SID);
    const es = sessionESes()[0];
    es.fire("snapshot", rawSessionSnap(1, SID, "m1"), "1");
    es.fire("part.upsert", { id: "p1", sessionID: SID, messageID: "m1", type: "text", text: "" }, "2");

    // Track reactive notifications on the part's text field. A Solid createEffect
    // that reads .text re-runs once per reactive mutation (per setState that
    // touches the field). Frame-batching = ONE re-run for the whole burst.
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
