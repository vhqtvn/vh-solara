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
