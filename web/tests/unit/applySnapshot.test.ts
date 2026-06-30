// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { applySnapshot, applySessionEvent } from "../../src/sync/stream";
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
