// @vitest-environment jsdom
// L-08/M4 — deletion-cascade parity. A session.delete event and the eager
// archive prune (pruneSessionDeleted) must remove a session from every shared
// store slice identically and produce the same typed effects, because both
// route through ONE session-removal projection helper (projectSessionRemoval).
// This test pins that consolidation (L-08/M4 item 5/6): if the two paths ever
// diverge, an archived orphan whose server-side delete never arrives would leave
// stale metadata (a "ghost" the banner can still find) while a real delete would
// not.
//
// Two levels:
//   1. PROJECTION-level — call the project* cores directly on equivalent seeded
//      drafts and compare the resulting slices + the effect lists (byte-identical
//      because session.delete routes through projectSessionRemoval).
//   2. ORCHESTRATION-level — drive applySessionEvent vs pruneSessionDeleted and
//      compare the observable store slices (cursor intentionally excluded — the
//      event path advances it, the archive path carries no seq).
import { beforeEach, describe, expect, it } from "vitest";
import { produce, reconcile } from "solid-js/store";
import { projectSessionEvent, projectSessionRemoval } from "../../src/sync/reducers";
import { applySessionEvent, applyScopedSnapshot, applySnapshot, pruneSessionDeleted } from "../../src/sync/reconcile";
import type { ReconcileEffect } from "../../src/sync/reducers.types";
import {
  lsSessionAgents,
  resetSessionAgentPicks,
  sessionAgentPicks,
  setSessionAgentPick,
  setState,
  state,
} from "../../src/sync/store";

beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("lastAgents", reconcile({}));
  setState("messageWindows", reconcile({}));
  setState("messagesDelivered", reconcile({}));
  setState("messagesError", reconcile({}));
  setState("refreshing", reconcile({}));
  setState("cursor", 0);
});

// Seed every slice projectSessionRemoval touches, so a divergence would leave a
// stale value the snapshot can detect.
function seedRemovalSlices(): void {
  setState("sessions", "x", { id: "x", title: "ghost" } as any);
  setState("lastAgents", "x", "build");
  setState("messageWindows", "x", { hasOlder: true, oldestResidentID: "m1" });
  setState("messagesDelivered", "x", true);
  setState("messagesError", "x", true);
  setState("refreshing", "x", true);
}

// Capture exactly the shared removal slices (cursor is intentionally excluded —
// it is an event-seq concern, not a removal concern).
function snapshotRemovalSlices() {
  return {
    sessions: state.sessions.x,
    lastAgents: state.lastAgents.x,
    messageWindows: state.messageWindows.x,
    messagesDelivered: state.messagesDelivered.x,
    messagesError: state.messagesError.x,
    refreshing: state.refreshing.x,
  };
}

describe("deletion-cascade parity (L-08/M4)", () => {
  it("projection-level: session.delete and eager-prune remove the same slices + effects", () => {
    // Path A: session.delete event projection.
    seedRemovalSlices();
    const effectsDelete: ReconcileEffect[] = [];
    setState(produce((s) => projectSessionEvent(s, "session.delete", { id: "x" }, effectsDelete)));
    const slicesDelete = snapshotRemovalSlices();

    // Path B: eager archive prune projection (the shared helper).
    seedRemovalSlices();
    const effectsPrune: ReconcileEffect[] = [];
    setState(produce((s) => projectSessionRemoval(s, "x", effectsPrune)));
    const slicesPrune = snapshotRemovalSlices();

    // Both route through projectSessionRemoval → identical slices + effects.
    expect(slicesDelete).toEqual(slicesPrune);
    expect(effectsDelete).toEqual(effectsPrune);
    // Both fully removed (parity is "both empty", not "both stale").
    expect(effectsDelete).toEqual([
      { kind: "session-removed", sessionID: "x" },
      { kind: "sync-state-dirty" },
    ]);
    expect(slicesDelete.sessions).toBeUndefined();
    expect(slicesDelete.lastAgents).toBeUndefined();
    expect(slicesDelete.messageWindows).toBeUndefined();
    expect(slicesDelete.messagesDelivered).toBeUndefined();
    expect(slicesDelete.messagesError).toBeUndefined();
    expect(slicesDelete.refreshing).toBeUndefined();
  });

  it("orchestration-level: session.delete event and eager archive prune leave equivalent store slices", () => {
    // Path A: a session.delete event (trackCursor=true advances the cursor to
    // the event seq).
    seedRemovalSlices();
    setState("cursor", 0);
    applySessionEvent("session.delete", 99, { id: "x" });
    const afterEvent = snapshotRemovalSlices();
    const cursorAfterEvent = state.cursor;

    // Path B: eager archive prune (no cursor — the archive path carries no seq).
    seedRemovalSlices();
    setState("cursor", 0);
    pruneSessionDeleted("x");
    const afterPrune = snapshotRemovalSlices();
    const cursorAfterPrune = state.cursor;

    // The shared removal slices are identical.
    expect(afterEvent).toEqual(afterPrune);
    // Both fully removed.
    expect(afterEvent.sessions).toBeUndefined();
    expect(afterEvent.lastAgents).toBeUndefined();
    expect(afterEvent.messageWindows).toBeUndefined();
    expect(afterEvent.messagesDelivered).toBeUndefined();
    expect(afterEvent.messagesError).toBeUndefined();
    expect(afterEvent.refreshing).toBeUndefined();
    // Cursor parity is OUT OF SCOPE by design: only the tracked event advances
    // it (99), the archive prune does not (0). Pinning this keeps the contract
    // explicit so a future change that accidentally advances the prune cursor is
    // caught.
    expect(cursorAfterEvent).toBe(99);
    expect(cursorAfterPrune).toBe(0);
  });

  it("deletion is idempotent: pruning an already-absent id is a no-op that still emits the effect shape", () => {
    // Both paths must be safe to apply twice (the archive path can fire for an
    // id a prior event already deleted).
    const effects: ReconcileEffect[] = [];
    expect(() =>
      setState(produce((s) => projectSessionRemoval(s, "neverexisted", effects))),
    ).not.toThrow();
    expect(effects).toEqual([
      { kind: "session-removed", sessionID: "neverexisted" },
      { kind: "sync-state-dirty" },
    ]);
    // The orchestration path is also a safe re-prune.
    expect(() => pruneSessionDeleted("neverexisted")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// F3 (review): the deletion cascade must prune the PERSISTED per-session agent
// pick. The session-removed effect consumer (reconcile.ts interpretEffects →
// clearSessionAgentPick) must drop BOTH the in-memory sessionAgentPicks entry
// AND the persisted localStorage map (vh.sessionagents.v1:<dir>) — or a
// server-side id reuse resurrects the old session's explicit agent pick for
// the new occupant (the silent-flip class this slice closes).
// ---------------------------------------------------------------------------
describe("deletion cascade prunes the persisted agent pick (F3)", () => {
  beforeEach(() => {
    resetSessionAgentPicks({});
    localStorage.removeItem(lsSessionAgents(""));
  });

  it("session.delete event removes the pick in-memory AND from the persisted map", () => {
    setSessionAgentPick("x", "build");
    expect(sessionAgentPicks["x"]?.agent).toBe("build");
    expect(JSON.parse(localStorage.getItem(lsSessionAgents("")) ?? "null")?.data?.x?.agent).toBe("build");

    applySessionEvent("session.delete", 7, { id: "x" });

    expect(sessionAgentPicks["x"]).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(lsSessionAgents("")) ?? "null")?.data?.x).toBeUndefined();
  });

  it("eager archive prune (pruneSessionDeleted) removes the pick identically", () => {
    setSessionAgentPick("x", "build");

    pruneSessionDeleted("x");

    expect(sessionAgentPicks["x"]).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(lsSessionAgents("")) ?? "null")?.data?.x).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// b-F1 (review blocker): the agent-pick store's sole clear path is the
// session-removed effect — which never fires when the session.delete was
// MISSED (deleted while offline). The reconnect's authoritative FULL snapshot
// replaces s.sessions wholesale; it must also prune the persisted agent pick
// for every disappeared id (same id-reuse silent-flip guard as the discrete
// path). Frontier-scoped partials are EXEMPT: they merge by scope and omission
// from them is NOT deletion.
// ---------------------------------------------------------------------------
describe("wholesale full snapshot prunes the persisted agent pick (b-F1)", () => {
  beforeEach(() => {
    resetSessionAgentPicks({});
    localStorage.removeItem(lsSessionAgents(""));
  });

  it("a full snapshot omitting the session removes the agent pick in-memory AND persisted (missed session.delete)", () => {
    setState("sessions", reconcile({ gone: { id: "gone" } as any, keep: { id: "keep" } as any }));
    setSessionAgentPick("gone", "build");
    setSessionAgentPick("keep", "plan");
    expect(sessionAgentPicks["gone"]?.agent).toBe("build");

    // The authoritative FULL snapshot (no `partial`) drops `gone` — the store
    // replacement itself is the only removal signal for a missed delete.
    applySnapshot({ seq: 10, sessions: [{ id: "keep" }], epoch: "e1" } as any);

    expect(state.sessions["gone"]).toBeUndefined();
    expect(sessionAgentPicks["gone"]).toBeUndefined();
    expect(JSON.parse(localStorage.getItem(lsSessionAgents("")) ?? "null")?.data?.gone).toBeUndefined();
    // Diff-scoped: the id still resident in the snapshot keeps its pick.
    expect(sessionAgentPicks["keep"]?.agent).toBe("plan");
    expect(JSON.parse(localStorage.getItem(lsSessionAgents("")) ?? "null")?.data?.keep?.agent).toBe("plan");
  });

  it("a frontier-scoped partial omitting the session leaves the agent pick intact (exemption)", () => {
    setState("sessions", reconcile({ buried: { id: "buried" } as any }));
    setSessionAgentPick("buried", "build");

    applyScopedSnapshot({
      seq: 11,
      epoch: "e1",
      sessions: [{ id: "front" }],
      partial: {
        mode: "tree-stream-1-frontier",
        scope: ["front"],
        authority: {
          sessions: "frontier",
          activity: "frontier",
          gate: "frontier",
          lastAgents: "frontier",
          currentVerbs: "frontier",
          questions: "global",
          permissions: "global",
          unread: "global",
        },
      },
    } as any);

    // Scoped merge keeps the buried session resident…
    expect(state.sessions["buried"]).toBeTruthy();
    // …and its pick survives in-memory AND persisted.
    expect(sessionAgentPicks["buried"]?.agent).toBe("build");
    expect(JSON.parse(localStorage.getItem(lsSessionAgents("")) ?? "null")?.data?.buried?.agent).toBe("build");
  });
});
