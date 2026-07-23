import { describe, expect, it } from "vitest";
import {
  buildMessages,
  deleteMessage,
  deletePart,
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
