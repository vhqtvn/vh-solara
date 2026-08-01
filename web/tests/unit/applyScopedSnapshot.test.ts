// @vitest-environment jsdom
// Slice-A (D3/D4): projectScopedPartial / applyScopedSnapshot — the frontier-
// scoped partial detail installer. Covers client-side requirements 5 (partial
// omission preserves buried cache), 6 (global Q/P/unread authoritative-replace),
// 9 (epoch-change clears prior detail), plus no-deletion-from-omission and
// omitted-maps-ignored. Mirrors the applySnapshot.test.ts harness (singleton
// state store + reconcile({}) reset; jsdom for the window.setTimeout that
// bumpUpdating()/persist() schedule).
import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { applyScopedSnapshot } from "../../src/sync/reconcile";
import { state, setState } from "../../src/sync/store";
import type { Snapshot } from "../../src/types";

const frontierAuth = {
  sessions: "frontier",
  activity: "frontier",
  gate: "frontier",
  lastAgents: "frontier",
  currentVerbs: "frontier",
  questions: "global",
  permissions: "global",
  unread: "global",
  todos: "omitted",
  statuses: "omitted",
  messages: "omitted",
} as const;

function partialSnap(
  over: Partial<Snapshot> & { scope: string[] },
  ringGap = false,
  mode = "tree-stream-1-frontier",
): Snapshot {
  return {
    seq: 10,
    epoch: "stable",
    ...over,
    partial: { mode, scope: over.scope, authority: { ...frontierAuth }, ringGap },
  } as Snapshot;
}

beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("activity", reconcile({}));
  setState("gate", reconcile({}));
  setState("lastAgents", reconcile({}));
  setState("currentVerbs", reconcile({}));
  setState("permissions", reconcile({}));
  setState("questions", reconcile({}));
  setState("unread", reconcile({}));
  setState("epoch", "");
  setState("epochChanged", false);
  setState("cursor", 0);
});

describe("applyScopedSnapshot — D3/D4 frontier-scoped partial installer", () => {
  it("(req 5) preserves buried detail outside the frontier scope; upserts scope only", () => {
    // Seed buried detail (a session NOT in the incoming frontier scope).
    setState("sessions", "buried", { id: "buried" });
    setState("lastAgents", "buried", "old-agent");
    setState("currentVerbs", "buried", { tool: "Read" });
    setState("activity", "buried", "busy");
    setState("gate", "buried", { hydrated: true, hasMessages: true });
    // Incoming partial scopes only frontier {front, root}; buried is omitted.
    const snap = partialSnap({
      scope: ["front", "root"],
      sessions: [
        { id: "front" },
        { id: "root" },
        // NOTE: "buried" is intentionally ABSENT from this partial frame.
      ],
      lastAgents: { front: "plan", root: "build" },
      currentVerbs: { front: { tool: "Edit" } },
      activity: { front: "idle", root: "idle" },
      gate: { front: { hydrated: true, hasMessages: true } },
    });
    applyScopedSnapshot(snap);
    // Buried detail PRESERVED (no deletion from omission).
    expect(state.sessions.buried).toEqual({ id: "buried" });
    expect(state.lastAgents.buried).toBe("old-agent");
    expect(state.currentVerbs.buried).toEqual({ tool: "Read" });
    expect(state.activity.buried).toBe("busy");
    expect(state.gate.buried).toEqual({ hydrated: true, hasMessages: true });
    // Frontier upserted.
    expect(state.sessions.front).toEqual({ id: "front" });
    expect(state.sessions.root).toEqual({ id: "root" });
    expect(state.lastAgents.front).toBe("plan");
    expect(state.currentVerbs.front).toEqual({ tool: "Edit" });
  });

  it("(req 6) globally-complete Q/P/unread authoritatively replace (replied question cleared)", () => {
    // Stale pending Q/P/unread from a prior frame.
    setState("questions", "front", { staleQ: { id: "staleQ" } });
    setState("permissions", "front", { staleP: { id: "staleP" } });
    setState("unread", "buried", true);
    // Incoming partial carries a REPLACED global set: only a new question, no
    // permission, no unread (the replied question must disappear).
    const snap = partialSnap({
      scope: ["front"],
      questions: { front: [{ id: "newQ" }] },
      permissions: {},
      unread: [],
    });
    applyScopedSnapshot(snap);
    // Authoritative-replace: stale Q gone, new Q present; stale P cleared.
    // (A session absent from the global set has NO entry — undefined, not {} —
    // mirroring projectSnapshot: it only creates s.permissions[sid] for sids
    // present in the set.)
    expect(state.questions.front).toEqual({ newQ: { id: "newQ" } });
    expect(state.permissions.front).toBeUndefined();
    expect(Object.keys(state.permissions)).toHaveLength(0);
    // unread wholesale-replaced → the stale buried unread dot is cleared.
    expect(state.unread.buried).toBeUndefined();
    expect(Object.keys(state.unread)).toHaveLength(0);
  });

  it("(req 9) epoch-change clears prior frontier-mergeable detail (prior epoch stale)", () => {
    setState("epoch", "oldEpoch");
    // Buried + frontier detail from the OLD epoch.
    setState("sessions", "buried", { id: "buried" });
    setState("sessions", "front", { id: "front-old" });
    setState("lastAgents", "buried", "stale-agent");
    setState("gate", "buried", { hydrated: true, hasMessages: true });
    // Incoming partial with a NEW epoch scopes only {front}.
    const snap = partialSnap({
      epoch: "newEpoch",
      scope: ["front"],
      sessions: [{ id: "front", title: "fresh" }],
    });
    applyScopedSnapshot(snap);
    // Prior-epoch buried detail CLEARED (server restarted; buried caches stale).
    expect(state.sessions.buried).toBeUndefined();
    expect(state.lastAgents.buried).toBeUndefined();
    expect(state.gate.buried).toBeUndefined();
    // Fresh frontier applied.
    expect(state.sessions.front).toEqual({ id: "front", title: "fresh" });
    expect(state.epoch).toBe("newEpoch");
    expect(state.epochChanged).toBe(true);
  });

  it("does NOT delete a session absent from a non-epoch-change partial (merge-only)", () => {
    setState("epoch", "stable");
    setState("sessions", "buried", { id: "buried" });
    const snap = partialSnap({ epoch: "stable", scope: ["front"], sessions: [{ id: "front" }] });
    applyScopedSnapshot(snap);
    // No epoch change → buried survives (deletions arrive as live session.delete).
    expect(state.sessions.buried).toEqual({ id: "buried" });
    expect(state.sessions.front).toEqual({ id: "front" });
  });

  it("ignores omitted maps (todos/statuses/messages) without touching consumers", () => {
    const snap = partialSnap({
      scope: ["front"],
      sessions: [{ id: "front" }],
    });
    applyScopedSnapshot(snap);
    // No todos/statuses/messages maps exist on the partial installer's path;
    // applying must not throw and must not populate any such slice.
    expect((state as unknown as { todos?: unknown }).todos).toBeUndefined();
    expect(state.sessions.front).toEqual({ id: "front" });
  });

  it("advances the cursor to the shared partial seq", () => {
    setState("cursor", 3);
    const snap = partialSnap({ seq: 42, scope: ["front"], sessions: [{ id: "front" }] });
    applyScopedSnapshot(snap);
    expect(state.cursor).toBe(42);
  });

  it("(req 8/D1) same-epoch ring-gap invalidates retained frontier-mergeable detail NOT in the new scope", () => {
    // Retained detail from a prior connection (SAME epoch — no epoch-change
    // clear): some ids in the new scope, some not (stale, lost in the gap).
    setState("epoch", "stable");
    setState("sessions", "keep", { id: "keep" }); // in new scope → preserved
    setState("sessions", "stale", { id: "stale" }); // NOT in new scope → invalidated
    setState("sessions", "frontier", { id: "frontier-old" }); // in scope → upserted
    setState("lastAgents", "stale", "old-agent");
    setState("gate", "stale", { hydrated: true });
    setState("activity", "stale", "busy");
    setState("currentVerbs", "stale", { tool: "Read" });
    // ring-gap reconnect (same epoch): scope {keep, frontier}; stale is out.
    const snap = partialSnap(
      {
        epoch: "stable",
        scope: ["keep", "frontier"],
        sessions: [{ id: "frontier", title: "fresh" }],
      },
      true,
    );
    applyScopedSnapshot(snap);
    // NOT-in-scope 'stale' invalidated (its deltas were lost in the ring-gap).
    expect(state.sessions.stale).toBeUndefined();
    expect(state.lastAgents.stale).toBeUndefined();
    expect(state.gate.stale).toBeUndefined();
    expect(state.activity.stale).toBeUndefined();
    expect(state.currentVerbs.stale).toBeUndefined();
    // In-scope 'keep' preserved (carried in scope, no deltas needed).
    expect(state.sessions.keep).toEqual({ id: "keep" });
    // In-scope 'frontier' upserted fresh.
    expect(state.sessions.frontier).toEqual({ id: "frontier", title: "fresh" });
  });

  it("(req 4/B) expand-page bundle installs detail for the page and preserves buried siblings", () => {
    // A buried sibling NOT in this expand page (another unexpanded node).
    setState("sessions", "buried-sib", { id: "buried-sib" });
    setState("lastAgents", "buried-sib", "old");
    // Expand returns only the page's children detail (page-scoped, mode expand-page).
    const snap = partialSnap(
      {
        scope: ["childA", "childB"],
        sessions: [{ id: "childA" }, { id: "childB" }],
        lastAgents: { childA: "plan", childB: "build" },
        activity: { childA: "idle", childB: "busy" },
      },
      false,
      "expand-page",
    );
    applyScopedSnapshot(snap);
    // Page detail installed (lastAgents/currentVerbs/... for the page ids).
    expect(state.sessions.childA).toEqual({ id: "childA" });
    expect(state.sessions.childB).toEqual({ id: "childB" });
    expect(state.lastAgents.childA).toBe("plan");
    expect(state.activity.childB).toBe("busy");
    // Buried sibling (not in this page) preserved — no deletion from omission.
    expect(state.sessions["buried-sib"]).toEqual({ id: "buried-sib" });
    expect(state.lastAgents["buried-sib"]).toBe("old");
  });
});
