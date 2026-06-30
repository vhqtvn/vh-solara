// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { applySnapshot, applySessionEvent, applySessionSnapshot, applyMessageEvent } from "../../src/sync/stream";
import { state, setState } from "../../src/sync/store";
import type { Snapshot } from "../../src/types";

// B2a (resync-window gating of lastAgents) + B2b (session.delete prunes the
// per-session maps) integration coverage. These drive the REAL applySnapshot /
// applySessionEvent against the singleton sync store (the selectors.test.ts
// convention), so they need jsdom for the window.setTimeout that bumpUpdating()
// / persist() schedule. applySnapshot is the tree stream's sole reconciliation
// entry point and does NOT call refreshOpenSessions (that lives in the
// EventSource handler), so these tests make no network calls.

// Reset every slice these tests touch. Solid's setState MERGES objects, so a
// plain setState("x", {}) would leave stale nested keys; reconcile({}) diffs
// each slice down to empty — a true reset (selectors.test.ts pattern).
beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("messages", reconcile({}));
  setState("lastAgents", reconcile({}));
  setState("hydrated", reconcile({}));
  setState("messagesLoaded", reconcile({}));
  setState("epoch", "");
  setState("epochChanged", false);
  setState("cursor", 0);
});

describe("applySnapshot — B2a resync-window lastAgents gating", () => {
  it("merge-protects a prev label when the epoch just changed (transition snapshot)", () => {
    setState("epoch", "oldEpoch");
    setState("lastAgents", "s1", "build");
    const snap: Snapshot = {
      seq: 1,
      epoch: "newEpoch", // epoch transition → resync window
      sessions: [{ id: "s1" }, { id: "s2" }],
      gate: { s1: { hydrated: true }, s2: { hydrated: true } },
      // mid-aggregation: server omits s1's label, but the FE already knows "build"
      lastAgents: { s2: "plan" },
    };
    applySnapshot(snap);
    // s1 preserved (merge-protect); s2's incoming label applied.
    expect(state.lastAgents.s1).toBe("build");
    expect(state.lastAgents.s2).toBe("plan");
    // The transition latches the flag for the toast and advances the epoch.
    expect(state.epochChanged).toBe(true);
    expect(state.epoch).toBe("newEpoch");
  });

  it("merge-protects a prev label when a session is hydrated===false (no epoch change)", () => {
    setState("epoch", "stable");
    setState("lastAgents", reconcile({ s1: "build", s2: "plan" }));
    const snap: Snapshot = {
      seq: 2,
      epoch: "stable", // NO epoch transition
      sessions: [{ id: "s1" }, { id: "s2" }],
      gate: { s1: { hydrated: true }, s2: { hydrated: false } }, // s2 mid-aggregation
      // server omits s2 (still pulling its tail); s1 updated authoritatively
      lastAgents: { s1: "ship" },
    };
    applySnapshot(snap);
    expect(state.lastAgents.s1).toBe("ship"); // incoming non-empty wins
    expect(state.lastAgents.s2).toBe("plan"); // FE label preserved (merge-protect)
    expect(state.epochChanged).toBe(false); // no epoch transition latched
  });

  it("merge-protects while the latched epochChanged flag is still set (toast not yet consumed)", () => {
    setState("epoch", "stable");
    setState("epochChanged", true); // a recent transition the toast hasn't cleared yet
    setState("lastAgents", reconcile({ s1: "build" }));
    const snap: Snapshot = {
      seq: 3,
      epoch: "stable", // epoch now stable, all hydrated
      sessions: [{ id: "s1" }, { id: "s2" }],
      gate: { s1: { hydrated: true }, s2: { hydrated: true } },
      lastAgents: { s2: "plan" }, // server omits s1
    };
    applySnapshot(snap);
    // Still inside the resync window (latch set) → s1's FE label preserved.
    expect(state.lastAgents.s1).toBe("build");
    expect(state.lastAgents.s2).toBe("plan");
  });

  it("wholesale-replaces lastAgents when stable + all hydrated (legitimate clears propagate)", () => {
    setState("epoch", "stable");
    setState("lastAgents", reconcile({ s1: "build", s2: "plan" }));
    const snap: Snapshot = {
      seq: 4,
      epoch: "stable", // no transition
      sessions: [{ id: "s1" }, { id: "s2" }],
      gate: { s1: { hydrated: true }, s2: { hydrated: true } }, // all hydrated
      // authoritative: s2 legitimately cleared (its latest assistant no longer
      // has an agent / recomputed messages yield none)
      lastAgents: { s1: "ship" },
    };
    applySnapshot(snap);
    expect(state.lastAgents.s1).toBe("ship"); // updated
    expect(state.lastAgents.s2).toBeUndefined(); // cleared — NO merge-protect
  });

  it("does NOT force resync when gate is omitted (older daemon) + epoch stable", () => {
    // An older daemon that omits snap.gate entirely must still get wholesale
    // replace when the epoch is stable — otherwise the overcorrection returns
    // for every such daemon (clears never propagate). Only EXPLICIT
    // hydrated===false counts toward the resync window.
    setState("epoch", "stable");
    setState("lastAgents", "s1", "build");
    const snap: Snapshot = {
      seq: 5,
      epoch: "stable",
      sessions: [{ id: "s1" }],
      // gate omitted; authoritative snapshot clears s1
      lastAgents: {},
    };
    applySnapshot(snap);
    expect(state.lastAgents.s1).toBeUndefined(); // cleared
  });
});

describe("applySessionEvent — B2b session.delete prunes per-session maps", () => {
  it("deletes lastAgents/hydrated/messagesLoaded alongside the session", () => {
    setState("sessions", "s1", { id: "s1" });
    setState("lastAgents", "s1", "build");
    setState("hydrated", "s1", true);
    setState("messagesLoaded", "s1", true);

    applySessionEvent("session.delete", 99, { id: "s1" });

    expect(state.sessions.s1).toBeUndefined();
    expect(state.lastAgents.s1).toBeUndefined();
    expect(state.hydrated.s1).toBeUndefined();
    expect(state.messagesLoaded.s1).toBeUndefined();
    expect(state.cursor).toBe(99); // the cursor still advances on a tracked event
  });

  it("does not prune metadata on session.upsert (only the session row is touched)", () => {
    setState("lastAgents", "s1", "build");
    setState("hydrated", "s1", true);
    applySessionEvent("session.upsert", 7, { id: "s1", title: "t" });
    expect(state.sessions.s1).toEqual({ id: "s1", title: "t" });
    expect(state.lastAgents.s1).toBe("build"); // untouched
    expect(state.hydrated.s1).toBe(true); // untouched
  });
});

// Slice C — async selected-session hydration. The Stream-2 first-open snapshot
// no longer waits for the upstream full-message fetch: a hydrating snapshot
// (gate.messagesLoaded===false) must keep the loading UI up until the explicit
// messages.loaded completion event lands (or a re-snapshot reports loaded).
describe("applySessionSnapshot / applyMessageEvent — Slice C async hydration", () => {
  it("a HYDRATING partial snapshot does NOT mark the session delivered", () => {
    // openSession sets messagesLoaded=false on open; the hydrating snapshot must
    // NOT flip it to true (only messages.loaded / a loaded gate does).
    setState("messagesLoaded", "s1", false);
    const snap: Snapshot = {
      seq: 1,
      sessions: [{ id: "s1" }],
      gate: { s1: { messagesLoaded: false } }, // background fetch still in flight
      messages: { s1: [] },
    };
    applySessionSnapshot("s1", snap);
    // messages slice is populated (empty order) but the delivery flag stays false
    // so the transcript shows "loading" rather than "delivered-and-empty".
    expect(state.messagesLoaded.s1).toBe(false);
    expect(state.messages.s1).toBeDefined();
  });

  it("a FULL snapshot (messagesLoaded true) marks the session delivered", () => {
    const snap: Snapshot = {
      seq: 1,
      sessions: [{ id: "s1" }],
      gate: { s1: { messagesLoaded: true } },
      messages: { s1: [{ info: { id: "m1", sessionID: "s1", role: "user" }, parts: [] }] },
    };
    applySessionSnapshot("s1", snap);
    expect(state.messagesLoaded.s1).toBe(true);
    expect(state.messages.s1.order).toEqual(["m1"]);
  });

  it("an older daemon (gate.messagesLoaded omitted) stays delivered (back-compat)", () => {
    const snap: Snapshot = {
      seq: 1,
      sessions: [{ id: "s1" }],
      gate: { s1: {} }, // no messagesLoaded field → undefined !== false → delivered
      messages: { s1: [] },
    };
    applySessionSnapshot("s1", snap);
    expect(state.messagesLoaded.s1).toBe(true);
  });

  it("a hydrating snapshot ACTIVELY clears a stale delivered=true (daemon restart case)", () => {
    // A session that was previously delivered (messagesLoaded===true, e.g. the
    // daemon restarted / epoch changed while the session was open and stale
    // delivered state lingers) must be flipped BACK to loading when a hydrating
    // partial snapshot (gate.messagesLoaded===false) overwrites messages[id].
    // Otherwise the empty-order snapshot renders "delivered-and-empty".
    setState("messagesLoaded", "s1", true);
    const snap: Snapshot = {
      seq: 1,
      sessions: [{ id: "s1" }],
      gate: { s1: { messagesLoaded: false } },
      messages: { s1: [] },
    };
    applySessionSnapshot("s1", snap);
    expect(state.messagesLoaded.s1).toBe(false);
    expect(state.messages.s1).toBeDefined();
  });

  it("messages.loaded flips the delivery flag (the completion signal)", () => {
    setState("messagesLoaded", "s1", false); // was hydrating
    applyMessageEvent("messages.loaded", 42, { sessionID: "s1" }, false);
    expect(state.messagesLoaded.s1).toBe(true);
    // trackCursor:false → Stream 2 must NOT advance the shared resume cursor.
    expect(state.cursor).toBe(0);
  });

  it("messages.loaded fires even when the fetch returned no message.* deltas", () => {
    // Empty/unchanged fetch: no message.upsert would ever land, but the
    // completion event still flips the flag → "delivered-and-empty".
    setState("messagesLoaded", "s1", false);
    applyMessageEvent("messages.loaded", 43, { sessionID: "s1" }, false);
    expect(state.messagesLoaded.s1).toBe(true);
  });

  it("messages.error does NOT claim completion (keeps loading UI up)", () => {
    setState("messagesLoaded", "s1", false);
    applyMessageEvent("messages.error", 44, { sessionID: "s1", error: "boom" }, false);
    // Error path logs + leaves the session loading (retry on reselect); the
    // delivery flag must NOT flip to true (would show a misleading empty view).
    expect(state.messagesLoaded.s1).toBe(false);
  });

  it("message.upsert arriving BEFORE completion is applied without claiming loaded", () => {
    // Stream 2 forwards reconciled deltas on the same connection as the fetch;
    // they can land before messages.loaded. They must populate the transcript
    // but not flip the delivery flag (only messages.loaded does). The
    // message.upsert payload is the FLAT MessageInfo ({id,sessionID,role}).
    setState("messagesLoaded", "s1", false);
    setState("messages", "s1", { order: [], byId: {} });
    applyMessageEvent(
      "message.upsert",
      40,
      { id: "m1", sessionID: "s1", role: "user" },
      false,
    );
    expect(state.messages.s1.order).toContain("m1");
    expect(state.messagesLoaded.s1).toBe(false);
  });
});
