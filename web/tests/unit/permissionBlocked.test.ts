// @vitest-environment jsdom
//
// permission.blocked live consumer (M8/L-04 server emit + this L-08 slice).
//
// The server emits KindPermissionBlocked as a replayable Stream-1 event the
// moment a permission blocking occurs. Before this slice the web client had
// ZERO consumers: the kind was absent from TREE_STREAM_KINDS (so EventSource
// silently dropped the live frame) and projectMessageEvent had no case for it,
// so an already-connected client only converged the sticky permission-blocked
// gate fact on a snapshot/reconnect. This test pins the live wiring: the kind
// IS registered, and driving the event through applyMessageEvent flips BOTH
// gate-fact spellings to true in the live store mirror (state.gate).
//
// Mirrors the lastAgent.set cold-seed live-patch test in applySnapshot.test.ts.
// Drives the REAL applyMessageEvent / applySnapshot / applySessionEvent against
// the singleton sync store (the selectors.test.ts convention), so it needs
// jsdom for the window.setTimeout that bumpUpdating() / persist() schedule.
import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { applyMessageEvent, applySnapshot, applySessionEvent } from "../../src/sync/reconcile";
import { TREE_STREAM_KINDS } from "../../src/sync/tree-transport";
import { state, setState } from "../../src/sync/store";
import type { Snapshot } from "../../src/types";

// Reset every slice these tests touch. Solid's setState MERGES objects, so a
// plain setState("x", {}) would leave stale nested keys; reconcile({}) diffs
// each slice down to empty — a true reset (selectors.test.ts pattern).
beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("gate", reconcile({}));
  setState("lastAgents", reconcile({}));
  setState("cursor", 0);
});

describe("permission.blocked — TREE_STREAM_KINDS registration (cold-chip guard)", () => {
  it("registers permission.blocked in TREE_STREAM_KINDS", () => {
    // The cold-chip regression: a handler case with no EventSource listener is
    // silently dead on the wire. Without this registration the live frame is
    // dropped in production even though the reducer has the case.
    expect(TREE_STREAM_KINDS).toContain("permission.blocked");
  });
});

describe("permission.blocked — live projection flips both gate facts (L-09 dual-emit)", () => {
  it("sets permissionWasBlocked AND permission_blocked true on the live event", () => {
    // No gate fact seeded yet.
    expect(state.gate.s1).toBeUndefined();
    // The server emits {sessionID, permissionWasBlocked: true} the moment a
    // blocking occurs; an already-connected client applies it live.
    applyMessageEvent("permission.blocked", 1, {
      sessionID: "s1",
      permissionWasBlocked: true,
    });
    // BOTH wire spellings flip (L-09 dual-emit alias window): the exact-name
    // alias the SPA migrates toward + its retained peer.
    expect(state.gate.s1?.permissionWasBlocked).toBe(true);
    expect(state.gate.s1?.permission_blocked).toBe(true);
  });

  it("does not clobber other gate facts already present for the session", () => {
    // A session may already carry hasMessages / messagesLoaded from the seeded
    // baseline; the live patch must merge, not wholesale-replace, the gate entry.
    setState("gate", "s2", { hasMessages: true, messagesLoaded: true });
    applyMessageEvent("permission.blocked", 2, {
      sessionID: "s2",
      permissionWasBlocked: true,
    });
    expect(state.gate.s2?.permissionWasBlocked).toBe(true);
    expect(state.gate.s2?.permission_blocked).toBe(true);
    // Pre-existing facts survive the merge.
    expect(state.gate.s2?.hasMessages).toBe(true);
    expect(state.gate.s2?.messagesLoaded).toBe(true);
  });

  it("ignores an event with no sessionID (defensive)", () => {
    applyMessageEvent("permission.blocked", 3, { permissionWasBlocked: true });
    expect(Object.keys(state.gate)).toEqual([]);
  });
});

describe("permission.blocked — snapshot seeds + session.delete prunes the gate mirror", () => {
  it("applySnapshot seeds state.gate from snap.gate (snapshot convergence baseline)", () => {
    // The live patch composes on top of the seeded baseline: a fresh load whose
    // snapshot already carries permissionWasBlocked=true must populate the live
    // mirror so the SPA reflects it before any new live event arrives.
    const snap: Snapshot = {
      seq: 10,
      sessions: [{ id: "s3" }],
      gate: {
        s3: { hasMessages: true, permissionWasBlocked: true, permission_blocked: true },
      },
    };
    applySnapshot(snap);
    expect(state.gate.s3?.permissionWasBlocked).toBe(true);
    expect(state.gate.s3?.permission_blocked).toBe(true);
    expect(state.gate.s3?.hasMessages).toBe(true);
  });

  it("a live permission.blocked flip lands on top of the seeded baseline", () => {
    // Snapshot seeds the session as NOT yet blocked.
    const snap: Snapshot = {
      seq: 10,
      sessions: [{ id: "s4" }],
      gate: { s4: { hasMessages: true } },
    };
    applySnapshot(snap);
    expect(state.gate.s4?.permissionWasBlocked).toBeUndefined();
    // The false→true transition arrives as a live Stream-1 event.
    applyMessageEvent("permission.blocked", 11, {
      sessionID: "s4",
      permissionWasBlocked: true,
    });
    expect(state.gate.s4?.permissionWasBlocked).toBe(true);
    expect(state.gate.s4?.permission_blocked).toBe(true);
    // The seeded hasMessages fact survives the live patch (merge, not replace).
    expect(state.gate.s4?.hasMessages).toBe(true);
  });

  it("session.delete prunes the gate entry (B2b — no leak / no resurrect on id-reuse)", () => {
    // Seed the gate fact, then delete the session structurally.
    applyMessageEvent("permission.blocked", 20, {
      sessionID: "s5",
      permissionWasBlocked: true,
    });
    expect(state.gate.s5?.permissionWasBlocked).toBe(true);
    applySessionEvent("session.delete", 21, { id: "s5" });
    // The deleted session's gate facts must not leak.
    expect(state.gate.s5).toBeUndefined();
  });
});
