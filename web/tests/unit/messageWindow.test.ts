// @vitest-environment jsdom
// Phase 3 — client initial-window semantics. These tests pin the purely-additive
// population of `state.messageWindows[id]` (the resident-window state: hasOlder
// + oldestResidentID) across the three wholesale-replace paths:
//   1. messages.batch case (cold-load SSE)
//   2. applySessionSnapshot (Stream-2 warm/cold snapshot)
//   3. (refreshOpenSessions is covered indirectly — it shares the helper + the
//      fetchSessionMessages shape; see fetchSessionMessages-return-shape below.)
// Plus the B2b-parity reset points (session.delete, switchProject) and the
// back-compat default (older server omits window meta → hasOlder=false).
//
// The audit (per the gate) found NO consumer of messages.loaded assumes
// "whole transcript resident"; the tests pin that the gate-flip is independent
// of the new window state (purely additive — messages.loaded does NOT touch
// messageWindows).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { produce, reconcile } from "solid-js/store";
import {
  applyMessageEvent,
  applySessionEvent,
  applySessionSnapshot,
  decodeMessagesBatch,
  deriveMessageWindow,
  refreshOpenSessions,
} from "../../src/sync/stream";
import { state, setState, setSelectedIdRaw } from "../../src/sync/store";
import type { Snapshot } from "../../src/types";

// Reset every slice these tests touch. Solid's setState MERGES objects, so a
// plain setState("x", {}) would leave stale nested keys; reconcile({}) diffs
// each slice down to empty — a true reset (applySnapshot.test.ts pattern).
beforeEach(() => {
  setState("messages", reconcile({}));
  setState("messageWindows", reconcile({}));
  setState("messagesLoaded", reconcile({}));
  setState("messagesError", reconcile({}));
  setState("sessions", reconcile({}));
  setState("cursor", 0);
});

// Helper: build a {info, parts} message item with the given id.
function item(id: string) {
  return {
    info: { id, sessionID: "s1", role: "user", time: { created: 1 } },
    parts: [{ id: `p-${id}`, sessionID: "s1", messageID: id, type: "text", text: "x" }],
  };
}

describe("deriveMessageWindow (pure helper)", () => {
  it("server window wins for oldestResidentID", () => {
    const items = [item("a"), item("b"), item("c")];
    const w = deriveMessageWindow(items, { oldest_loaded_id: "a", has_older: true });
    expect(w.hasOlder).toBe(true);
    expect(w.oldestResidentID).toBe("a");
  });

  it("falls back to items[0].info.id when server omits oldest_loaded_id", () => {
    const items = [item("first"), item("second")];
    const w = deriveMessageWindow(items, { has_older: false });
    expect(w.hasOlder).toBe(false);
    expect(w.oldestResidentID).toBe("first");
  });

  it("omits oldestResidentID when items empty AND no server meta", () => {
    const w = deriveMessageWindow([], undefined);
    expect(w.hasOlder).toBe(false);
    expect(w.oldestResidentID).toBeUndefined();
  });

  it("server meta with empty items keeps server oldest_loaded_id", () => {
    // Edge: server reports oldest_loaded_id even for an empty window (shouldn't
    // happen in practice, but the helper must not crash). hasOlder carries
    // through; items-empty is irrelevant when the server declares the id.
    const w = deriveMessageWindow([], { oldest_loaded_id: "ghost", has_older: true });
    expect(w.hasOlder).toBe(true);
    expect(w.oldestResidentID).toBe("ghost");
  });
});

describe("messages.batch populates messageWindows[id]", () => {
  it("sets hasOlder + oldestResidentID from payload.window", () => {
    setState("messages", "s1", { order: [], byId: {} });
    applyMessageEvent(
      "messages.batch",
      10,
      {
        sessionID: "s1",
        messages: [item("m1"), item("m2"), item("m3")],
        window: { oldest_loaded_id: "m1", has_older: true, message_count: 3 },
      },
      false,
    );
    expect(state.messageWindows.s1).toBeDefined();
    expect(state.messageWindows.s1.hasOlder).toBe(true);
    expect(state.messageWindows.s1.oldestResidentID).toBe("m1");
    // The bounded content also landed.
    expect(state.messages.s1.order).toEqual(["m1", "m2", "m3"]);
  });

  it("derives oldestResidentID from messages[0] when window absent (back-compat)", () => {
    // Older server (pre-Phase-1) omits window entirely → hasOlder=false
    // (correct: unbounded server, nothing older to fetch), and the helper
    // derives the oldest resident id from the first shipped message.
    setState("messages", "s1", { order: [], byId: {} });
    applyMessageEvent(
      "messages.batch",
      11,
      {
        sessionID: "s1",
        messages: [item("first"), item("second")],
        // no window field
      },
      false,
    );
    expect(state.messageWindows.s1.hasOlder).toBe(false);
    expect(state.messageWindows.s1.oldestResidentID).toBe("first");
  });

  it("leaves hasOlder=false on an empty cold fetch", () => {
    setState("messages", "s1", { order: [], byId: {} });
    applyMessageEvent(
      "messages.batch",
      12,
      {
        sessionID: "s1",
        messages: [],
        window: { oldest_loaded_id: "", has_older: false, message_count: 0 },
      },
      false,
    );
    expect(state.messageWindows.s1.hasOlder).toBe(false);
    expect(state.messageWindows.s1.oldestResidentID).toBeUndefined();
  });

  it("oversized-item window still reports hasOlder from server meta", () => {
    // The Phase-1 oversized-anchor case: one item shipped alone because it
    // exceeded the byte budget, with older messages still beyond it.
    // The window meta carries has_older=true + oversized_item=true.
    setState("messages", "s1", { order: [], byId: {} });
    applyMessageEvent(
      "messages.batch",
      13,
      {
        sessionID: "s1",
        messages: [item("huge")],
        window: {
          oldest_loaded_id: "huge",
          has_older: true,
          message_count: 1,
          oversized_item: true,
          actual_bytes: 2_000_000,
          budget_bytes: 1_048_576,
        },
      },
      false,
    );
    expect(state.messageWindows.s1.hasOlder).toBe(true);
    expect(state.messageWindows.s1.oldestResidentID).toBe("huge");
  });
});

describe("applySessionSnapshot populates messageWindows[id]", () => {
  it("warm path (messagesLoaded !== false) populates from snap.messageWindows", () => {
    // The session must exist in state.messages for buildMessages to land.
    setState("messages", "s1", { order: [], byId: {} });
    const snap: Snapshot = {
      seq: 1,
      sessions: [{ id: "s1" }],
      gate: { s1: { hydrated: true, messagesLoaded: true } },
      messages: { s1: [item("m1"), item("m2")] },
      messageWindows: { s1: { oldest_loaded_id: "m1", has_older: true, message_count: 2 } },
    };
    applySessionSnapshot("s1", snap);
    expect(state.messageWindows.s1.hasOlder).toBe(true);
    expect(state.messageWindows.s1.oldestResidentID).toBe("m1");
    expect(state.messagesLoaded.s1).toBe(true);
  });

  it("cold fork (messagesLoaded===false) still populates window from snap.messageWindows", () => {
    // Partial snapshot path: the gate says the daemon hasn't fetched the full
    // history yet (messagesLoaded=false), so messagesLoaded stays false — but
    // the window meta for whatever shipped in the partial snapshot still lands.
    setState("messages", "s1", { order: [], byId: {} });
    setState("messagesLoaded", "s1", false);
    const snap: Snapshot = {
      seq: 2,
      sessions: [{ id: "s1" }],
      gate: { s1: { hydrated: false, messagesLoaded: false } },
      messages: { s1: [item("only")] },
      messageWindows: { s1: { oldest_loaded_id: "only", has_older: false, message_count: 1 } },
    };
    applySessionSnapshot("s1", snap);
    expect(state.messagesLoaded.s1).toBe(false);
    expect(state.messageWindows.s1.hasOlder).toBe(false);
    expect(state.messageWindows.s1.oldestResidentID).toBe("only");
  });

  it("back-compat: no snap.messageWindows defaults hasOlder=false (unbounded server)", () => {
    setState("messages", "s1", { order: [], byId: {} });
    const snap: Snapshot = {
      seq: 3,
      sessions: [{ id: "s1" }],
      gate: { s1: { hydrated: true, messagesLoaded: true } },
      messages: { s1: [item("a"), item("b")] },
      // no messageWindows field
    };
    applySessionSnapshot("s1", snap);
    expect(state.messageWindows.s1.hasOlder).toBe(false);
    expect(state.messageWindows.s1.oldestResidentID).toBe("a");
  });

  it("replaces prior window state on a fresh snapshot (no merge)", () => {
    // A warm Stream-2 re-snapshot wholesale-replaces messages[id]; the window
    // state must be re-asserted (not merged). Stale hasOlder from a prior
    // snapshot must NOT persist if the new one says has_older=false.
    setState("messages", "s1", { order: [], byId: {} });
    setState("messageWindows", "s1", { hasOlder: true, oldestResidentID: "stale" });
    const snap: Snapshot = {
      seq: 4,
      sessions: [{ id: "s1" }],
      gate: { s1: { hydrated: true, messagesLoaded: true } },
      messages: { s1: [item("fresh")] },
      messageWindows: { s1: { oldest_loaded_id: "fresh", has_older: false, message_count: 1 } },
    };
    applySessionSnapshot("s1", snap);
    expect(state.messageWindows.s1.hasOlder).toBe(false);
    expect(state.messageWindows.s1.oldestResidentID).toBe("fresh");
  });
});

describe("reset points — B2b parity", () => {
  it("session.delete clears messageWindows[id]", () => {
    setState("messages", "s1", { order: [], byId: {} });
    setState("messageWindows", "s1", { hasOlder: true, oldestResidentID: "m1" });
    setState("sessions", "s1", { id: "s1" });
    applySessionEvent("session.delete", 20, { id: "s1" });
    expect(state.messageWindows.s1).toBeUndefined();
  });

  it("switchProject clears the whole messageWindows map (B2b parity)", () => {
    // switchProject lives in actions.ts (async: calls connect()). The
    // end-to-end path is covered by Playwright project-switch e2e; this test
    // pins the B2b invariant directly: a previous project's window state does
    // NOT leak across a switch. The slice reset in actions.ts is a single
    // assignment inside produce() — `s.messageWindows = {}` — which we drive
    // here to pin the contract on the store shape the assignment targets.
    setState("messages", "s1", { order: [], byId: {} });
    setState("messageWindows", "s1", { hasOlder: true, oldestResidentID: "leak" });
    setState("messageWindows", "s2", { hasOlder: false, oldestResidentID: "x" });
    expect(Object.keys(state.messageWindows)).toHaveLength(2);
    // Mirror the exact mutation switchProject's produce block makes.
    setState(
      produce((s) => {
        s.messageWindows = {};
      }),
    );
    expect(Object.keys(state.messageWindows)).toHaveLength(0);
  });

  it("messages.loaded does NOT touch messageWindows (purely additive)", () => {
    // The reveal-gate flip is independent of the window state. A pre-existing
    // window (from an earlier messages.batch) must survive messages.loaded
    // unchanged; a missing window must NOT be populated by messages.loaded.
    setState("messages", "s1", { order: [], byId: {} });
    setState("messageWindows", "s1", { hasOlder: true, oldestResidentID: "m1" });
    applyMessageEvent("messages.loaded", 30, { sessionID: "s1" }, false);
    // Window state unchanged.
    expect(state.messageWindows.s1.hasOlder).toBe(true);
    expect(state.messageWindows.s1.oldestResidentID).toBe("m1");
    // The gate DID flip.
    expect(state.messagesLoaded.s1).toBe(true);

    // And a session with NO prior window state stays absent after messages.loaded.
    setState("messages", "s2", { order: [], byId: {} });
    applyMessageEvent("messages.loaded", 31, { sessionID: "s2" }, false);
    expect(state.messageWindows.s2).toBeUndefined();
  });
});

describe("decodeMessagesBatch carries window field through", () => {
  it("gzip64 round-trip preserves the outer payload's window field", async () => {
    // Mirrors the server's outer payload shape after Phase 1:
    // {sessionID, encoding:"gzip64", data:<base64-gzip({messages:[...]})>, window:{...}}.
    // The window field is OUTSIDE the gzip envelope so the client can read
    // has_older without decompressing.
    const { gzipSync } = await import("node:zlib");
    const messages = [item("m1"), item("m2")];
    const data = Buffer.from(
      gzipSync(Buffer.from(JSON.stringify({ messages }))),
    ).toString("base64");
    const window = { oldest_loaded_id: "m1", has_older: true, message_count: 2 };
    const decoded = await decodeMessagesBatch({
      sessionID: "s1",
      encoding: "gzip64",
      data,
      window,
    });
    expect(decoded.sessionID).toBe("s1");
    expect(decoded.messages).toHaveLength(2);
    expect(decoded.window).toEqual(window);
  });

  it("non-compressed payload passes window through (back-compat / small batch)", async () => {
    const window = { has_older: false, message_count: 1 };
    const decoded = await decodeMessagesBatch({
      sessionID: "raw",
      messages: [item("only")],
      window,
    });
    expect(decoded.window).toEqual(window);
    expect(decoded.messages).toHaveLength(1);
  });

  it("absent window field yields undefined (older server)", async () => {
    const decoded = await decodeMessagesBatch({
      sessionID: "old",
      messages: [item("x")],
    });
    expect(decoded.window).toBeUndefined();
  });
});

describe("partial → batch → loaded ordering (Phase 3 gate)", () => {
  it("window state flows correctly through the cold-load sequence", () => {
    // The canonical cold-load sequence: partial snapshot (empty or sparse
    // window) → messages.batch (the real bounded tail with window meta) →
    // messages.loaded (gate flip, window UNCHANGED).
    setState("messages", "s1", { order: [], byId: {} });
    setState("messagesLoaded", "s1", false);

    // 1. Partial snapshot — gate says messagesLoaded=false; empty messages +
    //    an empty window (or none). Window state is {hasOlder:false} (nothing
    //    resident yet).
    applySessionSnapshot("s1", {
      seq: 1,
      sessions: [{ id: "s1" }],
      gate: { s1: { messagesLoaded: false } },
      messages: { s1: [] },
      messageWindows: { s1: { has_older: false, message_count: 0 } },
    });
    expect(state.messagesLoaded.s1).toBe(false);
    expect(state.messageWindows.s1.hasOlder).toBe(false);

    // 2. messages.batch lands the real bounded tail. Window state is replaced.
    applyMessageEvent(
      "messages.batch",
      40,
      {
        sessionID: "s1",
        messages: [item("m1"), item("m2"), item("m3")],
        window: { oldest_loaded_id: "m1", has_older: true, message_count: 3 },
      },
      false,
    );
    expect(state.messages.s1.order).toEqual(["m1", "m2", "m3"]);
    expect(state.messageWindows.s1.hasOlder).toBe(true);
    expect(state.messageWindows.s1.oldestResidentID).toBe("m1");
    // Gate NOT flipped yet (content-only event).
    expect(state.messagesLoaded.s1).toBe(false);

    // 3. messages.loaded flips the gate. Window state must be UNCHANGED.
    applyMessageEvent("messages.loaded", 41, { sessionID: "s1" }, false);
    expect(state.messagesLoaded.s1).toBe(true);
    expect(state.messageWindows.s1.hasOlder).toBe(true);
    expect(state.messageWindows.s1.oldestResidentID).toBe("m1");
    expect(state.messages.s1.order).toEqual(["m1", "m2", "m3"]);
  });
});

describe("refreshOpenSessions populates messageWindows (third wholesale-replace path)", () => {
  // Direct wiring test for the third path — clears the convergent advisory
  // (A-F2/B-F1/C-F4/D-F4) that flagged refreshOpenSessions as only indirectly
  // covered. Mocks the /vh/snapshot fetch, drives refreshOpenSessions, and
  // asserts messageWindows[id] is populated from snap.messageWindows[id].

  afterEach(() => {
    vi.unstubAllGlobals();
    setSelectedIdRaw(null);
  });

  it("populates messageWindows[id] from snap.messageWindows[id]", async () => {
    setState("messages", "s1", { order: [], byId: {} });
    const transcript = [item("m1"), item("m2"), item("m3")];
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => ({
            messages: { s1: transcript },
            messageWindows: {
              s1: { oldest_loaded_id: "m1", has_older: true, message_count: 3 },
            },
          }),
        }),
      ),
    );
    await refreshOpenSessions();
    expect(state.messagesLoaded.s1).toBe(true);
    expect(state.messageWindows.s1).toBeDefined();
    expect(state.messageWindows.s1.hasOlder).toBe(true);
    expect(state.messageWindows.s1.oldestResidentID).toBe("m1");
  });

  it("falls back to hasOlder=false when snap omits messageWindows (back-compat)", async () => {
    setState("messages", "s1", { order: [], byId: {} });
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => ({
            messages: { s1: [item("first"), item("second")] },
            // no messageWindows field — pre-Phase-1 server shape
          }),
        }),
      ),
    );
    await refreshOpenSessions();
    expect(state.messageWindows.s1.hasOlder).toBe(false);
    expect(state.messageWindows.s1.oldestResidentID).toBe("first");
  });
});
