// @vitest-environment jsdom
// Phase 2 — Stream2 (selected session) resumability. The core invariant this
// suite pins: when Stream2 reconnects and the server replays ring events
// (message.upsert, part.upsert, messages.loaded, activity, etc.) to the client,
// those events arrive at applyMessageEvent with trackCursor=false and MUST NOT
// advance state.cursor. state.cursor is Stream1's shared resume position; if a
// Stream2 replay clobbered it, Stream1's reconnect would skip every event the
// replay delivered (data loss on the tree stream).
//
// sesCursor (module-private in stream.ts) is the per-Stream2-connection
// Last-Event-ID tracker that powers native EventSource auto-reconnect. It is
// separate from state.cursor by design: sesCursor lives on the connection, not
// the store. The server-side replay-vs-snapshot branch is proven by
// session_stream_replay_test.go; this suite proves the CLIENT-SIDE half of the
// contract — the events the replay delivers do not corrupt Stream1's cursor.
import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { applyMessageEvent } from "../../src/sync/stream";
import { state, setState } from "../../src/sync/store";

beforeEach(() => {
  setState("messages", reconcile({}));
  setState("activity", reconcile({}));
  setState("messagesLoaded", reconcile({}));
  setState("messagesError", reconcile({}));
  setState("cursor", 0);
});

describe("applyMessageEvent trackCursor:false — Stream2 replay invariant", () => {
  it("message.upsert with trackCursor:false does not advance state.cursor", () => {
    // Seed a session with one message so upsertMessage has a store to mutate.
    setState("messages", "s1", {
      order: ["m1"],
      byId: {
        m1: {
          info: { id: "m1", sessionID: "s1", role: "user", time: { created: 1 } },
          parts: [],
        },
      },
    });
    // Pretend Stream1 has already advanced the shared cursor to 100.
    setState("cursor", 100);

    applyMessageEvent(
      "message.upsert",
      250, // a seq from the replay window (would advance cursor if trackCursor=true)
      {
        id: "m1",
        sessionID: "s1",
        role: "user",
        time: { created: 2 },
      },
      false, // Stream2 invariant: trackCursor=false
    );
    // The message store was updated (upsert applied)...
    expect(state.messages.s1.byId.m1).toBeDefined();
    // ...but the shared cursor is UNCHANGED — Stream2 must not clobber Stream1.
    expect(state.cursor).toBe(100);
  });

  it("part.upsert with trackCursor:false does not advance state.cursor", () => {
    // The store shape for a message is { info, parts: {<id>: Part}, partOrder: string[] }
    // (reduce.ts upsertPart reads msg.parts[part.id] + msg.partOrder).
    setState("messages", "s1", {
      order: ["m1"],
      byId: {
        m1: {
          info: { id: "m1", sessionID: "s1", role: "user", time: { created: 1 } },
          parts: {
            p1: { id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "hi" },
          },
          partOrder: ["p1"],
        },
      },
    });
    setState("cursor", 50);

    applyMessageEvent(
      "part.upsert",
      300,
      {
        id: "p2",
        sessionID: "s1",
        messageID: "m1",
        type: "text",
        text: "new",
      },
      false,
    );
    expect(state.cursor).toBe(50);
  });

  it("activity with trackCursor:false does not advance state.cursor", () => {
    setState("cursor", 75);

    applyMessageEvent(
      "activity",
      400,
      { sessionID: "s1", state: "busy" },
      false,
    );
    // Activity state was applied...
    expect(state.activity.s1).toBe("busy");
    // ...but cursor untouched.
    expect(state.cursor).toBe(75);
  });

  it("messages.loaded with trackCursor:false does not advance state.cursor", () => {
    setState("cursor", 200);

    applyMessageEvent("messages.loaded", 500, { sessionID: "s1" }, false);
    expect(state.messagesLoaded.s1).toBe(true);
    expect(state.cursor).toBe(200);
  });

  it("trackCursor=true (Stream1 path) DOES advance state.cursor", () => {
    // Contrast test: the same events on Stream1 (trackCursor=true) advance the
    // cursor. This proves the false path is a real branch, not dead code.
    setState("cursor", 0);

    applyMessageEvent("activity", 42, { sessionID: "s1", state: "busy" }, true);
    expect(state.cursor).toBe(42);
  });

  it("a burst of replay events with trackCursor:false leaves cursor at its pre-burst value", () => {
    // The real-world Stream2 reconnect scenario: after a transient drop, the
    // server replays the ring (N events) before live streaming resumes. None of
    // the replayed events may advance the shared cursor, no matter how many
    // arrive or how high their seq numbers are.
    setState("messages", "s1", {
      order: ["m1"],
      byId: {
        m1: {
          info: { id: "m1", sessionID: "s1", role: "user", time: { created: 1 } },
          parts: {},
          partOrder: [],
        },
      },
    });
    setState("cursor", 1000);

    // Burst of 5 replay events across different kinds + high seq numbers.
    applyMessageEvent("activity", 1001, { sessionID: "s1", state: "busy" }, false);
    applyMessageEvent(
      "message.upsert",
      1002,
      { id: "m1", sessionID: "s1", role: "user", time: { created: 2 } },
      false,
    );
    applyMessageEvent("messages.loaded", 1003, { sessionID: "s1" }, false);
    applyMessageEvent(
      "part.upsert",
      1004,
      { id: "p1", sessionID: "s1", messageID: "m1", type: "text", text: "x" },
      false,
    );
    applyMessageEvent("activity", 1005, { sessionID: "s1", state: "idle" }, false);

    // Cursor still at the Stream1 value — replay did not clobber it.
    expect(state.cursor).toBe(1000);
  });
});
