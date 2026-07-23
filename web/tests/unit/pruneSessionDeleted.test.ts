// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { pruneSessionDeleted } from "../../src/sync/stream";
import { state, setState } from "../../src/sync/store";
import { invalidateChildrenIndex } from "../../src/sync/selectors";

// pruneSessionDeleted mirrors the session.delete event handler's pruning: it
// removes a session from every client-side store slice (sessions, lastAgents,
// messageWindows, messagesLoaded, messagesError, refreshing) and resets derived
// caches (pageInFlight, childrenIndex, persist).
// It is called by archiveSession after a successful /vh/archive so that an
// orphan whose server-side delete event never arrives (the session wasn't in
// the server store → no KindSessionDelete emitted) is still removed from the
// client tree immediately — the banner disappears without a switch-away+back.

beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("lastAgents", reconcile({}));
  setState("messageWindows", reconcile({}));
  setState("messagesLoaded", reconcile({}));
  setState("messagesError", reconcile({}));
  setState("refreshing", reconcile({}));
  setState("activity", reconcile({}));
  invalidateChildrenIndex();
});

describe("pruneSessionDeleted", () => {
  it("removes the session from every store slice", () => {
    // Seed a session + its metadata across all the maps the delete handler
    // touches.
    setState("sessions", "ghost", {
      id: "ghost",
      parentID: "deadroot",
      title: "an orphan",
    } as any);
    setState("lastAgents", "ghost", "Claude Sonnet");
    setState("messageWindows", "ghost", { hasMore: false, ids: ["m1"] } as any);
    setState("messagesLoaded", "ghost", true);
    setState("messagesError", "ghost", "something");
    setState("refreshing", "ghost", true);

    expect(state.sessions["ghost"]).toBeDefined();
    expect(state.lastAgents["ghost"]).toBe("Claude Sonnet");
    expect(state.messagesLoaded["ghost"]).toBe(true);

    pruneSessionDeleted("ghost");

    // The session is gone from every slice — the banner can no longer find it.
    expect(state.sessions["ghost"]).toBeUndefined();
    expect(state.lastAgents["ghost"]).toBeUndefined();
    expect(state.messageWindows["ghost"]).toBeUndefined();
    expect(state.messagesLoaded["ghost"]).toBeUndefined();
    expect(state.messagesError["ghost"]).toBeUndefined();
    expect(state.refreshing["ghost"]).toBeUndefined();
  });

  it("is a no-op for an id that was never seeded (no throw)", () => {
    // A ghost that was already pruned by a prior event should be safe to
    // prune again (idempotent).
    expect(() => pruneSessionDeleted("neverexisted")).not.toThrow();
    expect(state.sessions["neverexisted"]).toBeUndefined();
  });

  it("prunes one session without touching a sibling", () => {
    setState("sessions", "sibling", { id: "sibling" } as any);
    setState("sessions", "target", { id: "target" } as any);
    setState("messagesLoaded", "sibling", true);
    setState("messagesLoaded", "target", true);

    pruneSessionDeleted("target");

    expect(state.sessions["target"]).toBeUndefined();
    expect(state.messagesLoaded["target"]).toBeUndefined();
    // Sibling untouched.
    expect(state.sessions["sibling"]).toBeDefined();
    expect(state.messagesLoaded["sibling"]).toBe(true);
  });
});
