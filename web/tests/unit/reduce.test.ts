import { describe, expect, it } from "vitest";
import {
  anyDescendantWorking,
  buildChildrenIndex,
  buildMessages,
  deleteMessage,
  deletePart,
  upsertMessage,
  upsertPart,
} from "../../src/lib/reduce";
import type { SessionMessages } from "../../src/types";

const empty = (): SessionMessages => ({ order: [], byId: {} });

describe("buildChildrenIndex", () => {
  it("groups by parentID and sorts roots newest-first", () => {
    const idx = buildChildrenIndex({
      a: { id: "a", time: { updated: 1 } },
      b: { id: "b", time: { updated: 3 } },
      c: { id: "c", parentID: "a", time: { updated: 2 } },
    });
    expect(idx[""].map((s) => s.id)).toEqual(["b", "a"]); // newest root first
    expect(idx["a"].map((s) => s.id)).toEqual(["c"]); // subsession under a
  });

  it("hides an orphan (parent absent) by default but surfaces it when the predicate allows", () => {
    const sessions = {
      a: { id: "a", time: { updated: 1 } },
      c: { id: "c", parentID: "gone", time: { updated: 2 } },
    };
    // Default: orphan 'c' stays hidden (grouped under the missing parent).
    const hidden = buildChildrenIndex(sessions);
    expect(hidden[""].map((s) => s.id)).toEqual(["a"]);
    expect(hidden["gone"].map((s) => s.id)).toEqual(["c"]); // hidden, not rendered

    // With a predicate (e.g. "is running"), the orphan surfaces as a root.
    const shown = buildChildrenIndex(sessions, (s) => s.id === "c");
    expect(shown[""].map((s) => s.id)).toEqual(["c", "a"]);
    expect(shown["gone"]).toBeUndefined();
  });
});

describe("anyDescendantWorking", () => {
  const busy = (a?: string) => a === "busy" || a === "retry";
  const sessions = {
    root: { id: "root" },
    child: { id: "child", parentID: "root" },
    grand: { id: "grand", parentID: "child" },
    other: { id: "other" },
  };

  it("is true when a direct child is busy", () => {
    expect(anyDescendantWorking(sessions, { child: "busy" }, "root", busy)).toBe(true);
  });

  it("is true when a grandchild (delegate's delegate) is busy", () => {
    expect(anyDescendantWorking(sessions, { grand: "retry" }, "root", busy)).toBe(true);
  });

  it("is false when no descendant is busy", () => {
    expect(anyDescendantWorking(sessions, { other: "busy" }, "root", busy)).toBe(false);
    expect(anyDescendantWorking(sessions, { child: "idle" }, "root", busy)).toBe(false);
  });

  it("does not loop forever on a parentID cycle", () => {
    const cyclic = { a: { id: "a", parentID: "b" }, b: { id: "b", parentID: "a" } };
    expect(anyDescendantWorking(cyclic, {}, "a", busy)).toBe(false);
  });
});

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
