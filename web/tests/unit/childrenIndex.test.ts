// @vitest-environment jsdom
//
// sessionWorking + sessionNeedsInput selector tests.
//
// As of P1 these trust the SERVER-COMPUTED tree facets (flags.subtreeBusy /
// subtreeNeedsInput) and no longer walk a client-side parent→children index.
// P5 deleted the now-dead index + the sessionTodos/sessionTodoCounts rollup it
// backed (the subtree-todo rollup is server-authoritative via
// GET /vh/session/:id/subtree-todos). What remains here is the P1-retained
// facet-trusting + self-only-fallback coverage for the working/needs-input
// selectors.
//
// jsdom is required because the selectors read the Solid singleton store, the
// tree flat-map store, and stream.ts's apply* helpers schedule timers via
// window.setTimeout.
import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { setState, state } from "../../src/sync/store";
import { seedTreeStore, resetTreeStore } from "../../src/sync/treeState";
import type { TreeNode } from "../../src/sync/treeMap";
import { sessionNeedsInput, sessionWorking } from "../../src/sync/selectors";
import type { Session } from "../../src/types";

// A minimal session shape (the selectors only read id + parentID).
function sess(id: string, parentID?: string): Session {
  return { id, ...(parentID ? { parentID } : {}) } as Session;
}

// A minimal tree node for facet-trusting tests. Only the fields the selectors
// read (activity + flags) are parameterised; the rest are inert defaults.
function tNode(
  id: string,
  opts?: {
    parentId?: string | null;
    activity?: string;
    subtreeBusy?: boolean;
    subtreeNeedsInput?: boolean;
    pendingInput?: boolean;
  },
): TreeNode {
  return {
    id,
    parentId: opts?.parentId ?? null,
    title: id,
    activity: (opts?.activity ?? "idle") as TreeNode["activity"],
    childCount: 0,
    loaded: false,
    flags: {
      pendingInput: opts?.pendingInput ?? false,
      subtreeNeedsInput: opts?.subtreeNeedsInput ?? false,
      subtreeBusy: opts?.subtreeBusy,
      permission: false,
      archived: false,
      orphan: false,
    },
    updatedMs: 0,
  };
}

// Bulk-load sessions into the detail store (mirrors stream.ts's applySnapshot
// wholesale replace, minus the now-deleted childrenIndex invalidation).
function loadSessions(sessions: Session[]): void {
  const map: Record<string, Session> = {};
  for (const s of sessions) map[s.id] = s;
  setState("sessions", reconcile(map));
}

beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("activity", reconcile({}));
  setState("permissions", reconcile({}));
  setState("questions", reconcile({}));
  resetTreeStore();
});

describe("sessionWorking — trusts server subtreeBusy facet (+ self-only fallback)", () => {
  it("returns true when the node's own activity is busy/retry (self via state.activity)", () => {
    // Self activity is read from state.activity[id] (the detail store), NOT
    // treeNode().activity — this is what keeps the reactive flush aligned with
    // the cross-stream completion bridge (see sessionWorking comment).
    setState("activity", "root", "busy");
    expect(sessionWorking("root")).toBe(true);
    setState("activity", "root", "retry");
    expect(sessionWorking("root")).toBe(true);
  });

  it("returns true when flags.subtreeBusy is set (server rolls up descendants)", () => {
    // The server sets subtreeBusy on every ancestor of a busy descendant.
    // The FE must trust it WITHOUT walking its own detail-store topology.
    seedTreeStore([
      tNode("root", { subtreeBusy: true }),
      tNode("child", { parentId: "root" }),
    ]);
    expect(sessionWorking("root")).toBe(true);
    expect(sessionWorking("child")).toBe(false); // child itself is idle
  });

  it("returns false for an idle resident node with no subtreeBusy", () => {
    seedTreeStore([tNode("root", { activity: "idle" })]);
    expect(sessionWorking("root")).toBe(false);
  });

  it("does NOT treat 'error' as working", () => {
    setState("activity", "root", "error");
    expect(sessionWorking("root")).toBe(false);
  });

  it("non-resident node: self-only fallback reads state.activity (NO subtree walk)", () => {
    // Node NOT in the tree flat map — only in the detail store. A busy
    // DESCENDANT in the detail store must NOT propagate up (P1 collapsed
    // the split-brain; the subtree aggregate is the server facet's job).
    loadSessions([sess("root"), sess("child", "root")]);
    setState("activity", "child", "busy");
    expect(sessionWorking("root")).toBe(false); // root's own activity is idle
    expect(sessionWorking("child")).toBe(true); // child's own activity is busy
  });
});

describe("sessionNeedsInput — trusts server subtreeNeedsInput facet (+ self-only fallback)", () => {
  it("returns true when flags.subtreeNeedsInput is set on a resident node", () => {
    seedTreeStore([tNode("root", { subtreeNeedsInput: true })]);
    expect(sessionNeedsInput("root")).toBe(true);
  });

  it("returns true when flags.pendingInput is set on a resident node (self)", () => {
    seedTreeStore([tNode("root", { pendingInput: true })]);
    expect(sessionNeedsInput("root")).toBe(true);
  });

  it("returns false for a resident node with no pending input flags", () => {
    seedTreeStore([tNode("root")]);
    expect(sessionNeedsInput("root")).toBe(false);
  });

  it("resident node: server facet OVERRIDES detail-store permissions (pins authority)", () => {
    // A RESIDENT node with clear tree flags must return false even if the
    // detail-store permissions/questions map is non-empty — the server facet
    // is the authority, not the detail store. This is the inverse of the
    // non-resident fallback and pins the split-brain collapse.
    seedTreeStore([tNode("root")]); // no pendingInput / subtreeNeedsInput
    setState("permissions", "root", { p1: { id: "p1", sessionID: "root" } });
    expect(sessionNeedsInput("root")).toBe(false);
  });

  it("non-resident node: self-only fallback reads state.permissions/questions (NO subtree walk)", () => {
    // Node NOT in the tree flat map. A pending permission on a DESCENDANT in
    // the detail store must NOT roll up (P1 collapsed the split-brain).
    loadSessions([sess("root"), sess("child", "root")]);
    setState("permissions", "child", { p1: { id: "p1", sessionID: "child" } });
    expect(sessionNeedsInput("root")).toBe(false); // root's own perms are empty
    expect(sessionNeedsInput("child")).toBe(true); // child's own perm is pending
  });

  it("non-resident node: self-only fallback detects a pending question", () => {
    loadSessions([sess("root")]);
    setState("questions", "root", { q1: { id: "q1", sessionID: "root", questions: [] } });
    expect(sessionNeedsInput("root")).toBe(true);
  });
});
