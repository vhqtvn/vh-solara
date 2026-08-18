import { describe, expect, it } from "vitest";
import {
  buildMessages,
  deleteMessage,
  deletePart,
  prependMessagesIfAbsent,
  upsertMessage,
  upsertPart,
} from "../../src/lib/reduce";
import type { SessionMessages } from "../../src/types";

const empty = (): SessionMessages => ({ order: [], byId: {} });

describe("message reducers", () => {
  it("upserts messages in creation order and updates in place", () => {
    const sm = empty();
    upsertMessage(sm, { id: "m2", sessionID: "s", role: "assistant", time: { created: 20 } });
    upsertMessage(sm, { id: "m1", sessionID: "s", role: "user", time: { created: 10 } });
    expect(sm.order).toEqual(["m1", "m2"]); // sorted by created
    upsertMessage(sm, { id: "m1", sessionID: "s", role: "user", time: { created: 10, completed: 11 } });
    expect(sm.order).toEqual(["m1", "m2"]); // no duplicate
    expect(sm.byId["m1"].info.time?.completed).toBe(11);
  });

  it("deletes messages", () => {
    const sm = empty();
    upsertMessage(sm, { id: "m1", sessionID: "s", role: "user" });
    deleteMessage(sm, "m1");
    expect(sm.order).toEqual([]);
    expect(sm.byId["m1"]).toBeUndefined();
  });
});

describe("part reducers", () => {
  it("creates a placeholder message when a part arrives first", () => {
    const sm = empty();
    upsertPart(sm, { id: "p1", sessionID: "s", messageID: "m1", type: "text", text: "hi" });
    expect(sm.byId["m1"]).toBeDefined();
    expect(sm.byId["m1"].partOrder).toEqual(["p1"]);
  });

  it("updates a streaming part in place (no duplicate)", () => {
    const sm = empty();
    upsertPart(sm, { id: "p1", sessionID: "s", messageID: "m1", type: "text", text: "he" });
    upsertPart(sm, { id: "p1", sessionID: "s", messageID: "m1", type: "text", text: "hello" });
    expect(sm.byId["m1"].partOrder).toEqual(["p1"]);
    expect(sm.byId["m1"].parts["p1"].text).toBe("hello");
  });

  it("deletes parts", () => {
    const sm = empty();
    upsertPart(sm, { id: "p1", sessionID: "s", messageID: "m1", type: "text" });
    deletePart(sm, "m1", "p1");
    expect(sm.byId["m1"].partOrder).toEqual([]);
  });
});

describe("prependMessagesIfAbsent — upgrade-on-completed", () => {
  // A PARTIAL assistant message cached while streaming (info WITHOUT
  // time.completed, only the parts streamed so far).
  const partialResident = (): SessionMessages => ({
    order: ["m1"],
    byId: {
      m1: {
        id: "m1",
        info: { id: "m1", sessionID: "s", role: "assistant", time: { created: 10 } },
        partOrder: ["p1"],
        parts: {
          p1: { id: "p1", sessionID: "s", messageID: "m1", type: "text", text: "par" },
        },
      },
    },
  });

  it("upgrades a resident PARTIAL message when the incoming copy is COMPLETED", () => {
    const sm = partialResident();
    const p1Ref = sm.byId["m1"].parts["p1"]; // capture reference to prove in-place merge
    const added = prependMessagesIfAbsent(sm, [
      {
        info: { id: "m1", sessionID: "s", role: "assistant", time: { created: 10, completed: 20 } },
        parts: [
          // updated existing part (fuller text) + a brand-new part
          { id: "p1", sessionID: "s", messageID: "m1", type: "text", text: "partial-then-full" },
          { id: "p2", sessionID: "s", messageID: "m1", type: "text", text: "second" },
        ],
      },
    ]);
    // No NEW message inserted → return count stays 0 (oldestResident/hasOlder
    // bookkeeping in history.ts must not see an upgrade as an insert).
    expect(added).toBe(0);
    // info upgraded to the completed copy.
    expect(sm.byId["m1"].info.time?.completed).toBe(20);
    // existing part updated IN PLACE (same object reference kept).
    expect(sm.byId["m1"].parts["p1"]).toBe(p1Ref);
    expect(sm.byId["m1"].parts["p1"].text).toBe("partial-then-full");
    // missing part filled.
    expect(sm.byId["m1"].partOrder).toEqual(["p1", "p2"]);
    expect(sm.byId["m1"].parts["p2"].text).toBe("second");
  });

  it("fills MISSING parts on a resident message already stamped completed (activity-idle case)", () => {
    // The activity-idle path stamps time.completed on the resident but leaves it
    // MISSING parts; an incoming completed copy with full parts must still fill.
    const sm: SessionMessages = {
      order: ["m1"],
      byId: {
        m1: {
          id: "m1",
          info: { id: "m1", sessionID: "s", role: "assistant", time: { created: 10, completed: 15 } },
          partOrder: [],
          parts: {},
        },
      },
    };
    const added = prependMessagesIfAbsent(sm, [
      {
        info: { id: "m1", sessionID: "s", role: "assistant", time: { created: 10, completed: 20 } },
        parts: [{ id: "p1", sessionID: "s", messageID: "m1", type: "text", text: "full" }],
      },
    ]);
    expect(added).toBe(0);
    expect(sm.byId["m1"].partOrder).toEqual(["p1"]);
    expect(sm.byId["m1"].parts["p1"].text).toBe("full");
  });

  it("does NOT overwrite a resident (live) message when the incoming copy is NOT completed", () => {
    // Symmetric guard: a NON-completed incoming copy is the live-streaming tail
    // the insert-if-absent guard protects — it must never clobber the resident.
    const sm = partialResident();
    const added = prependMessagesIfAbsent(sm, [
      {
        info: { id: "m1", sessionID: "s", role: "assistant", time: { created: 10 } }, // no completed
        parts: [{ id: "p1", sessionID: "s", messageID: "m1", type: "text", text: "STALE" }],
      },
    ]);
    expect(added).toBe(0);
    // Resident untouched — the stale non-completed copy did not win.
    expect(sm.byId["m1"].parts["p1"].text).toBe("par");
    expect(sm.byId["m1"].info.time?.completed).toBeUndefined();
  });

  it("re-slots a resident PLACEHOLDER lacking time.created to its correct position on upgrade", () => {
    // A resident placeholder created by upsertPart (a part arrived before
    // message.updated) has NO time.created — it sorts as 0 (front of order).
    // An incoming COMPLETED copy carrying time.created must trigger the upgrade
    // path (reduce.ts:123-136) AND the post-upgrade sortMessages (reduce.ts:152)
    // must re-slot the resident to its real creation-time position. This is the
    // sort-reorder case the created:10-only resident above does NOT exercise.
    const p2Ref = { id: "p2", sessionID: "s", messageID: "m2", type: "text", text: "placeholder" };
    const sm: SessionMessages = {
      // m2 placeholder lacks time.created → sorts as 0 → front (WRONG slot).
      order: ["m2", "m1", "m3"],
      byId: {
        m2: {
          id: "m2",
          // NO time field — a placeholder created by upsertPart (reduce.ts:33-42).
          info: { id: "m2", sessionID: "s", role: "assistant" },
          partOrder: ["p2"],
          parts: { p2: p2Ref },
        },
        m1: {
          id: "m1",
          info: { id: "m1", sessionID: "s", role: "user", time: { created: 10 } },
          partOrder: [],
          parts: {},
        },
        m3: {
          id: "m3",
          info: { id: "m3", sessionID: "s", role: "assistant", time: { created: 20 } },
          partOrder: [],
          parts: {},
        },
      },
    };
    // Sanity: the placeholder currently sits at the FRONT (wrong slot) because
    // its missing time.created sorts as 0.
    expect(sm.order[0]).toBe("m2");

    // Incoming completed copy for the placeholder carries time.created=15 →
    // after upgrade it belongs BETWEEN m1(10) and m3(20).
    const added = prependMessagesIfAbsent(sm, [
      {
        info: { id: "m2", sessionID: "s", role: "assistant", time: { created: 15, completed: 16 } },
        parts: [{ id: "p2", sessionID: "s", messageID: "m2", type: "text", text: "completed" }],
      },
    ]);

    // Upgrade is NOT an insert → return count stays 0 (oldestResident/hasOlder
    // bookkeeping in history.ts must not see an upgrade as an insert).
    expect(added).toBe(0);
    // info upgraded to the completed copy (now carries time.created=15).
    expect(sm.byId["m2"].info.time?.created).toBe(15);
    expect(sm.byId["m2"].info.time?.completed).toBe(16);
    // existing part updated IN PLACE (same object reference kept).
    expect(sm.byId["m2"].parts["p2"]).toBe(p2Ref);
    expect(sm.byId["m2"].parts["p2"].text).toBe("completed");
    // CRUX: post-upgrade sortMessages (reduce.ts:152) re-slotted m2 from the
    // front (created=0 fallback) to its real creation-time slot between m1 and m3.
    expect(sm.order).toEqual(["m1", "m2", "m3"]);
  });

  it("still inserts ABSENT messages and returns the insert count (base behavior intact)", () => {
    const sm = partialResident();
    const added = prependMessagesIfAbsent(sm, [
      {
        info: { id: "m0", sessionID: "s", role: "user", time: { created: 5 } },
        parts: [{ id: "p0", sessionID: "s", messageID: "m0", type: "text", text: "older" }],
      },
      // a resident id in the same batch is skipped (not completed) — not counted
      {
        info: { id: "m1", sessionID: "s", role: "assistant", time: { created: 10 } },
        parts: [],
      },
    ]);
    expect(added).toBe(1); // only the absent m0 counted
    expect(sm.order).toEqual(["m0", "m1"]); // prepend sorted by created
  });
});

// ---------------------------------------------------------------------------
// Incident 2026-08-19 — stale rows appended after the final message.
//
// A part-only event for a message that is NOT resident (the end-of-turn
// compaction burst re-publishing old completed TOOL parts, or the daemon's
// warm reconcile re-publishing changed parts of daemon-resident messages)
// carries NO message info — no time.created. The old upsertPart fabricated a
// placeholder and PUSHED it onto the END of sm.order, so old tool parts
// rendered as rows AFTER the session's final message, sticky until reload.
//
// The fix: such a placeholder is a KEYLESS SHADOW — held in byId only (never
// in order, so it never renders and never holds the tail slot), promoted into
// its chronological order slot when real info arrives (message.upsert or a
// snapshot/page merge).
// ---------------------------------------------------------------------------
describe("part.upsert for a NON-RESIDENT message — keyless shadow", () => {
  const seededTail = (): SessionMessages =>
    buildMessages([
      { info: { id: "m1", sessionID: "s", role: "user", time: { created: 10 } }, parts: [] },
      {
        info: { id: "mFinal", sessionID: "s", role: "assistant", time: { created: 20, completed: 21 } },
        parts: [{ id: "pf", sessionID: "s", messageID: "mFinal", type: "text", text: "answer" }],
      },
    ]);

  it("(a) does NOT append an unordered tail row — the placeholder is held in byId only, never in order", () => {
    const sm = seededTail();
    // The compaction-burst shape: a completed TOOL part re-published for an
    // out-of-window OLD message (part-only event, no message info).
    upsertPart(sm, { id: "pOld", sessionID: "s", messageID: "mOld", type: "tool", state: "completed" });
    // The render list (ChatView maps s.order → byId) stays clean: no row
    // after the final message.
    expect(sm.order).toEqual(["m1", "mFinal"]);
    // The part data is HELD (not silently dropped) for a later merge.
    expect(sm.byId["mOld"]).toBeDefined();
    expect(sm.byId["mOld"].parts["pOld"].type).toBe("tool");
    // The shadow is keyless — no fabricated time (nothing for the idle bridge
    // to misread as a stampable/completed tail).
    expect(sm.byId["mOld"].info.time).toBeUndefined();
  });

  it("(c) a later message.upsert PROMOTES the shadow and re-slots it by time.created", () => {
    const sm = buildMessages([
      { info: { id: "m1", sessionID: "s", role: "user", time: { created: 10 } }, parts: [] },
      { info: { id: "m3", sessionID: "s", role: "user", time: { created: 30 } }, parts: [] },
    ]);
    // Part-before-info arrival for a message that belongs BETWEEN m1 and m3.
    upsertPart(sm, { id: "p2", sessionID: "s", messageID: "m2", type: "text", text: "streamed" });
    expect(sm.order).toEqual(["m1", "m3"]); // shadow not renderable yet
    // The real info arrives (the promotion trigger):
    upsertMessage(sm, { id: "m2", sessionID: "s", role: "assistant", time: { created: 20, completed: 25 } });
    // Re-slotted to its chronological position (pre-fix: kept its wrong tail
    // slot — ["m1","m3","m2"]).
    expect(sm.order).toEqual(["m1", "m2", "m3"]);
    // Parts held through the shadow window survived the promotion.
    expect(sm.byId["m2"].parts["p2"].text).toBe("streamed");
    expect(sm.byId["m2"].info.time?.completed).toBe(25);
  });

  it("a message.upsert WITHOUT time.created adopts the info but does NOT promote the shadow into order", () => {
    // No chronological key → no honest slot. The shadow stays hidden until a
    // keyed copy arrives (defense: never render an unkeyed row).
    const sm = seededTail();
    upsertPart(sm, { id: "pOld", sessionID: "s", messageID: "mOld", type: "tool" });
    upsertMessage(sm, { id: "mOld", sessionID: "s", role: "assistant" }); // no time
    expect(sm.order).toEqual(["m1", "mFinal"]);
    expect(sm.byId["mOld"].info.role).toBe("assistant");
  });

  it("sortMessages parks a keyless entry LAST, never at the top (top-jump guard)", () => {
    // Hand-built legacy shape: an info-less entry already inside order (the
    // pre-fix placeholder behavior). The next sort trigger must not fling it
    // above real history (the pre-fix `|| 0` fallback sorted it to the FRONT).
    const sm: SessionMessages = {
      order: ["mX", "m1"],
      byId: {
        mX: { id: "mX", info: { id: "mX", sessionID: "s", role: "assistant" }, partOrder: [], parts: {} },
        m1: { id: "m1", info: { id: "m1", sessionID: "s", role: "user", time: { created: 10 } }, partOrder: [], parts: {} },
      },
    };
    upsertMessage(sm, { id: "m2", sessionID: "s", role: "user", time: { created: 20 } }); // sort trigger
    expect(sm.order).toEqual(["m1", "m2", "mX"]); // keyless sorts LAST
  });
});

// (d) — the completion-time recovery merge must place recovered parts in
// INCOMING (server partOrder = chronological) order, not blind-append them
// after the final text part.
describe("prependMessagesIfAbsent — part-order-aware upgrade merge", () => {
  it("(d) recovered tool/step parts land BEFORE the final text, in incoming order", () => {
    // Resident: the activity-idle path stamped completed but only the streamed
    // TEXT part is resident (the incident's message-level mirror).
    const pTextRef = { id: "pText", sessionID: "s", messageID: "m1", type: "text", text: "par" };
    const sm: SessionMessages = {
      order: ["m1"],
      byId: {
        m1: {
          id: "m1",
          info: { id: "m1", sessionID: "s", role: "assistant", time: { created: 10, completed: 15 } },
          partOrder: ["pText"],
          parts: { pText: pTextRef },
        },
      },
    };
    // Incoming completed copy carries the full authoritative part sequence
    // (serialized in server partOrder order): tool → step → final text.
    const added = prependMessagesIfAbsent(sm, [
      {
        info: { id: "m1", sessionID: "s", role: "assistant", time: { created: 10, completed: 20 } },
        parts: [
          { id: "pTool", sessionID: "s", messageID: "m1", type: "tool", state: "completed" },
          { id: "pStep", sessionID: "s", messageID: "m1", type: "step" },
          { id: "pText", sessionID: "s", messageID: "m1", type: "text", text: "partial-then-full" },
        ],
      },
    ]);
    expect(added).toBe(0); // upgrade, not insert
    // CRUX: recovered parts slot in incoming order around the resident text —
    // NOT appended after it (pre-fix: ["pText","pTool","pStep"]).
    expect(sm.byId["m1"].partOrder).toEqual(["pTool", "pStep", "pText"]);
    // Resident part body merged IN PLACE (reference kept — chat-row identity).
    expect(sm.byId["m1"].parts["pText"]).toBe(pTextRef);
    expect(sm.byId["m1"].parts["pText"].text).toBe("partial-then-full");
  });

  it("completed upgrade REALIZES a shadow: promotes it into order at its chronological slot", () => {
    // Regression guard for the new shadow path: an out-of-window message whose
    // parts streamed into a shadow is promoted by an Inv-2 recovery snapshot
    // (completed copy) — rendered at its true position, parts merged.
    const sm = buildMessages([
      { info: { id: "m1", sessionID: "s", role: "user", time: { created: 10 } }, parts: [] },
      { info: { id: "m3", sessionID: "s", role: "user", time: { created: 30 } }, parts: [] },
    ]);
    upsertPart(sm, { id: "p2", sessionID: "s", messageID: "m2", type: "text", text: "held" });
    const added = prependMessagesIfAbsent(sm, [
      {
        info: { id: "m2", sessionID: "s", role: "assistant", time: { created: 20, completed: 25 } },
        parts: [{ id: "p2", sessionID: "s", messageID: "m2", type: "text", text: "final" }],
      },
    ]);
    expect(added).toBe(0); // byId-resident → not counted as a new insert
    expect(sm.order).toEqual(["m1", "m2", "m3"]); // realized + re-slotted
    expect(sm.byId["m2"].parts["p2"].text).toBe("final");
  });

  it("a NON-completed incoming copy promotes a shadow (info adoption) without clobbering live part bodies", () => {
    // The live-wins guard protects a KEYED resident from a stale non-completed
    // snapshot copy. A shadow has no info to protect — adopting the incoming
    // info is strictly a repair (e.g. a warm snapshot inlining the mid-stream
    // tail whose first part arrived part-first). Resident part bodies still
    // win (insert-if-absent only, never assign).
    const sm = buildMessages([
      { info: { id: "m1", sessionID: "s", role: "user", time: { created: 10 } }, parts: [] },
    ]);
    upsertPart(sm, { id: "pLive", sessionID: "s", messageID: "mTail", type: "text", text: "live-tokens" });
    const added = prependMessagesIfAbsent(sm, [
      {
        info: { id: "mTail", sessionID: "s", role: "assistant", time: { created: 20 } }, // NOT completed
        parts: [
          { id: "pLive", sessionID: "s", messageID: "mTail", type: "text", text: "STALE" },
          { id: "pOther", sessionID: "s", messageID: "mTail", type: "tool" },
        ],
      },
    ]);
    expect(added).toBe(0);
    expect(sm.order).toEqual(["m1", "mTail"]); // shadow realized
    expect(sm.byId["mTail"].info.time?.created).toBe(20); // info adopted
    expect(sm.byId["mTail"].parts["pLive"].text).toBe("live-tokens"); // live body wins
    expect(sm.byId["mTail"].parts["pOther"]).toBeDefined(); // missing part filled
    expect(sm.byId["mTail"].partOrder).toEqual(["pLive", "pOther"]);
  });

  it("resident-only parts absent from the incoming copy keep their relative order at the end", () => {
    // Defensive absence-never-delete mirror (server Option A): a part deleted
    // server-side after the resident copy was built must not vanish from the
    // merged order on upgrade.
    const sm: SessionMessages = {
      order: ["m1"],
      byId: {
        m1: {
          id: "m1",
          info: { id: "m1", sessionID: "s", role: "assistant", time: { created: 10, completed: 15 } },
          partOrder: ["pKept", "pGone"],
          parts: {
            pKept: { id: "pKept", sessionID: "s", messageID: "m1", type: "text", text: "a" },
            pGone: { id: "pGone", sessionID: "s", messageID: "m1", type: "tool" },
          },
        },
      },
    };
    prependMessagesIfAbsent(sm, [
      {
        info: { id: "m1", sessionID: "s", role: "assistant", time: { created: 10, completed: 20 } },
        parts: [{ id: "pKept", sessionID: "s", messageID: "m1", type: "text", text: "b" }],
      },
    ]);
    expect(sm.byId["m1"].partOrder).toEqual(["pKept", "pGone"]);
    expect(sm.byId["m1"].parts["pGone"]).toBeDefined();
  });
});

describe("buildMessages", () => {
  it("builds ordered messages with parts from snapshot items", () => {
    const sm = buildMessages([
      {
        info: { id: "m1", sessionID: "s", role: "user", time: { created: 1 } },
        parts: [{ id: "p1", sessionID: "s", messageID: "m1", type: "text", text: "hi" }],
      },
    ]);
    expect(sm.order).toEqual(["m1"]);
    expect(sm.byId["m1"].partOrder).toEqual(["p1"]);
  });
});
