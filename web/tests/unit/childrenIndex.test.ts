// @vitest-environment jsdom
//
// Correctness + perf tests for the cached parent→children index that backs
// subtreeSessionIds (Fix A for the cold-mount freeze).
//
// The index itself is not exported; we exercise it through the public selectors
// that consume it. As of P1, sessionWorking/sessionNeedsInput trust the SERVER-
// COMPUTED tree facets and no longer touch this index — only sessionTodos (the
// subtree-todo rollup, C5/P5) still walks it. The sessionTodos tests below
// verify (a) the index matches a full recompute across topologies, (b) stays
// correct after each mutation kind, and (c) builds O(1) across many calls. The
// sessionWorking/sessionNeedsInput tests verify facet-trusting + self-only
// fallback (P1's split-brain collapse).
//
// jsdom is required because the selectors read the Solid singleton store, the
// tree flat-map store, and invalidation is wired through stream.ts's apply*
// helpers (which schedule timers via window.setTimeout).
import { beforeEach, describe, expect, it } from "vitest";
import { produce, reconcile } from "solid-js/store";
import { setState, state } from "../../src/sync/store";
import { seedTreeStore, resetTreeStore } from "../../src/sync/treeState";
import type { TreeNode } from "../../src/sync/treeMap";
import {
  invalidateChildrenIndex,
  __childrenIndexBuildCountForTest,
  __resetChildrenIndexBuildCountForTest,
  sessionNeedsInput,
  sessionTodos,
  sessionWorking,
} from "../../src/sync/selectors";
import type { Session, TodoItem } from "../../src/types";

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

// Bulk-load sessions into the store and invalidate the index exactly once
// (mirrors what stream.ts's applySnapshot does after a wholesale replace).
function loadSessions(sessions: Session[]): void {
  const map: Record<string, Session> = {};
  for (const s of sessions) map[s.id] = s;
  setState("sessions", reconcile(map));
  invalidateChildrenIndex();
}

// Incremental upsert mirroring stream.ts's applySessionEvent("session.upsert").
function upsertSession(s: Session): void {
  setState("sessions", s.id, s);
  invalidateChildrenIndex();
}

// Incremental delete mirroring stream.ts's applySessionEvent("session.delete").
function deleteSession(id: string): void {
  const next: Record<string, Session> = {};
  for (const [k, v] of Object.entries(state.sessions)) if (k !== id) next[k] = v;
  setState("sessions", reconcile(next));
  invalidateChildrenIndex();
}

beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("activity", reconcile({}));
  setState("permissions", reconcile({}));
  setState("questions", reconcile({}));
  setState("todos", reconcile({}));
  invalidateChildrenIndex();
  __resetChildrenIndexBuildCountForTest();
  resetTreeStore();
});

describe("childrenIndex correctness — subtreeSessionIds via sessionTodos", () => {
  it("returns just the root when there are no descendants", () => {
    loadSessions([sess("root")]);
    setState("todos", "root", [{ id: "t1", status: "in_progress" }] as TodoItem[]);
    expect(sessionTodos("root").map((t) => t.id)).toEqual(["t1"]);
  });

  it("rolls up direct children's todos", () => {
    loadSessions([sess("root"), sess("c1", "root"), sess("c2", "root")]);
    setState("todos", "c1", [{ id: "a", status: "in_progress" }] as TodoItem[]);
    setState("todos", "c2", [{ id: "b", status: "pending" }] as TodoItem[]);
    expect(sessionTodos("root").map((t) => t.id).sort()).toEqual(["a", "b"]);
    // A child's subtree does NOT include siblings.
    expect(sessionTodos("c1").map((t) => t.id)).toEqual(["a"]);
  });

  it("rolls up deep descendants (grandchild + great-grandchild)", () => {
    loadSessions([
      sess("root"),
      sess("child", "root"),
      sess("grand", "child"),
      sess("great", "grand"),
    ]);
    setState("todos", "great", [{ id: "deep", status: "in_progress" }] as TodoItem[]);
    expect(sessionTodos("root").map((t) => t.id)).toEqual(["deep"]);
    expect(sessionTodos("child").map((t) => t.id)).toEqual(["deep"]);
    expect(sessionTodos("grand").map((t) => t.id)).toEqual(["deep"]);
  });

  it("excludes orphan subtrees (a child whose parent is absent from the store)", () => {
    // 'orphan' has parentID='ghost' but 'ghost' is not in the store. The
    // pre-fix subtreeSessionIds grouped such a child under the missing parent
    // and never visited it from a real root — the cached index must match.
    loadSessions([sess("root"), sess("orphan", "ghost")]);
    setState("todos", "orphan", [{ id: "x", status: "in_progress" }] as TodoItem[]);
    expect(sessionTodos("root").map((t) => t.id)).toEqual([]);
  });
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

describe("childrenIndex correctness — mutation kinds", () => {
  it("reflects a session.upsert (new child added under an existing root)", () => {
    loadSessions([sess("root")]);
    expect(sessionTodos("root")).toEqual([]);
    upsertSession(sess("child", "root"));
    setState("todos", "child", [{ id: "t", status: "in_progress" }] as TodoItem[]);
    expect(sessionTodos("root").map((t) => t.id)).toEqual(["t"]);
  });

  it("reflects a session.upsert that REPARENTS (parentID change)", () => {
    loadSessions([sess("root"), sess("other"), sess("mover", "root")]);
    setState("todos", "mover", [{ id: "t", status: "in_progress" }] as TodoItem[]);
    expect(sessionTodos("root").map((t) => t.id)).toEqual(["t"]);
    expect(sessionTodos("other").map((t) => t.id)).toEqual([]);
    // Reparent 'mover' from root → other.
    upsertSession(sess("mover", "other"));
    expect(sessionTodos("root")).toEqual([]);
    expect(sessionTodos("other").map((t) => t.id)).toEqual(["t"]);
  });

  it("reflects a session.delete (child removed; siblings unaffected)", () => {
    loadSessions([sess("root"), sess("a", "root"), sess("b", "root")]);
    setState("todos", "a", [{ id: "ta", status: "in_progress" }] as TodoItem[]);
    setState("todos", "b", [{ id: "tb", status: "in_progress" }] as TodoItem[]);
    expect(sessionTodos("root").map((t) => t.id).sort()).toEqual(["ta", "tb"]);
    deleteSession("a");
    expect(sessionTodos("root").map((t) => t.id)).toEqual(["tb"]);
  });

  it("reflects a wholesale snapshot replace (applySnapshot path)", () => {
    loadSessions([sess("root"), sess("a", "root")]);
    setState("todos", "a", [{ id: "old", status: "in_progress" }] as TodoItem[]);
    expect(sessionTodos("root").map((t) => t.id)).toEqual(["old"]);
    // Wholesale replace — entirely new topology.
    loadSessions([sess("newroot"), sess("newchild", "newroot")]);
    setState("todos", "newchild", [{ id: "new", status: "in_progress" }] as TodoItem[]);
    // Old root's subtree is gone (state.sessions was replaced wholesale).
    expect(sessionTodos("root")).toEqual([]);
    expect(sessionTodos("newroot").map((t) => t.id)).toEqual(["new"]);
  });

  it("orphans a child when its parent is deleted (matches pre-fix semantics)", () => {
    // Pre-fix: deleting a parent left the child in state.sessions with a
    // parentID pointing at the now-absent parent. The child became an orphan
    // — invisible from any real root's subtree. The cached index must match.
    loadSessions([sess("root"), sess("child", "root"), sess("grand", "child")]);
    setState("todos", "grand", [{ id: "g", status: "in_progress" }] as TodoItem[]);
    expect(sessionTodos("root").map((t) => t.id)).toEqual(["g"]);
    deleteSession("child");
    // 'grand' is still in the store but its parent 'child' is gone.
    // 'root' no longer sees 'grand' (the chain broke at the missing 'child').
    expect(sessionTodos("root")).toEqual([]);
  });

  // Regression for the F1 finding from commit-review: switchProject() in
  // web/src/sync/actions.ts does a wholesale `s.sessions = ...` inside
  // setState(produce(...)) and MUST call invalidateChildrenIndex() after,
  // or selectors read the PREVIOUS project's topology until the next SSE
  // snapshot lands. (Aggravating case: switchProject("") never opens a tree
  // stream, so no SSE snapshot ever arrives — stale cache persists.)
  // This test replicates that exact mutation pattern (produce-based wholesale
  // replace, bypassing loadSessions's built-in invalidate) to lock the
  // contract: the production code's explicit invalidate is the only thing
  // keeping this correct.
  it("switchProject-pattern wholesale replace requires explicit invalidate (else stale)", () => {
    // Project A: rootA → childA, todos on childA. Build the cache by reading.
    loadSessions([sess("rootA"), sess("childA", "rootA")]);
    setState("todos", "childA", [{ id: "a", status: "in_progress" }] as TodoItem[]);
    expect(sessionTodos("rootA").map((t) => t.id)).toEqual(["a"]);
    // (cache now holds { rootA: ["childA"] })

    // switchProject-equivalent wholesale replace via setState(produce(...)),
    // WITHOUT invalidate (demonstrates the F1 staleness bug). Both s.sessions
    // AND s.todos are replaced, mirroring switchProject's actual behavior.
    setState(
      produce((s: any) => {
        s.sessions = { rootB: sess("rootB"), childB: sess("childB", "rootB") };
        s.todos = { childB: [{ id: "b", status: "in_progress" }] };
      }),
    );

    // STALE: the cache still describes project A's topology ({rootA:[childA]}),
    // with NO entry for rootB. sessionTodos("rootB") traverses only rootB
    // (no children in the stale cache) and so MISSES childB's todo "b".
    // This is exactly the bug F1 caught: after a project switch, selectors
    // read the PREVIOUS project's topology until the next SSE snapshot lands.
    expect(sessionTodos("rootB").map((t) => t.id)).toEqual([]); // stale: misses childB

    // Now apply the production fix: invalidate after the produce. The next
    // selector call rebuilds against the CURRENT topology ({rootB:[childB]}).
    invalidateChildrenIndex();
    expect(sessionTodos("rootB").map((t) => t.id)).toEqual(["b"]); // correct
  });
});

describe("childrenIndex perf — O(1) builds across N sessionTodos calls", () => {
  // P1 shrank the index's user set: sessionWorking/sessionNeedsInput now trust
  // server facets and no longer touch this index. Only sessionTodos (subtree
  // todo rollup) walks it. The cold-mount workload that motivated the cache is
  // lighter now, but the O(1)-build invariant still holds for sessionTodos.
  it("builds the index exactly once across 100 sessionTodos calls on 100 sessions", () => {
    const ROOTS = 10;
    const CHILDREN_PER_ROOT = 10;
    const sessions: Session[] = [];
    for (let r = 0; r < ROOTS; r++) {
      const rootID = `r${r}`;
      sessions.push(sess(rootID));
      for (let c = 0; c < CHILDREN_PER_ROOT; c++) {
        sessions.push(sess(`${rootID}.c${c}`, rootID));
      }
    }
    loadSessions(sessions);
    expect(__childrenIndexBuildCountForTest()).toBe(0); // lazy — not built until first selector call

    // Touch every session via sessionTodos — 100 selector calls total.
    for (let r = 0; r < ROOTS; r++) {
      expect(sessionTodos(`r${r}`)).toEqual([]);
    }
    for (let r = 0; r < ROOTS; r++) {
      for (let c = 0; c < CHILDREN_PER_ROOT; c++) {
        expect(sessionTodos(`r${r}.c${c}`)).toEqual([]);
      }
    }
    expect(__childrenIndexBuildCountForTest()).toBe(1); // STILL one — cache reused

    // A mutation invalidates; the next selector call rebuilds exactly once.
    upsertSession(sess("r0.newchild", "r0"));
    expect(__childrenIndexBuildCountForTest()).toBe(1); // invalidated but not yet rebuilt
    expect(sessionTodos("r0")).toEqual([]);
    expect(__childrenIndexBuildCountForTest()).toBe(2); // rebuilt once after mutation
  });

  it("subtree lookups do not scale with total session count (only with subtree size)", () => {
    // Build a 100-session forest, then verify a single-subtree selector call
    // touches only the index once (O(1) builds) regardless of N. The
    // SUBTREE SIZE bounds the per-call traversal, not the total store size.
    const ROOTS = 10;
    const CHILDREN_PER_ROOT = 10;
    const sessions: Session[] = [];
    for (let r = 0; r < ROOTS; r++) {
      sessions.push(sess(`r${r}`));
      for (let c = 0; c < CHILDREN_PER_ROOT; c++) {
        sessions.push(sess(`r${r}.c${c}`, `r${r}`));
      }
    }
    loadSessions(sessions);

    // A root with a single-child subtree should produce the same build count
    // as a root with a 10-child subtree: ONE build, then traversal.
    const before = __childrenIndexBuildCountForTest();
    sessionTodos("r0"); // 11 sessions in this subtree
    expect(__childrenIndexBuildCountForTest()).toBe(before + 1);

    // Now compare against a forest with 10× the total session count but the
    // SAME per-root subtree size — the build cost must not scale with N.
    const BIG_ROOTS = 100;
    const sessions2: Session[] = [];
    for (let r = 0; r < BIG_ROOTS; r++) {
      sessions2.push(sess(`R${r}`));
      for (let c = 0; c < CHILDREN_PER_ROOT; c++) {
        sessions2.push(sess(`R${r}.c${c}`, `R${r}`));
      }
    }
    loadSessions(sessions2); // 10× the sessions, same per-root subtree
    __resetChildrenIndexBuildCountForTest();
    sessionTodos("R0"); // same 11-session subtree
    // Built exactly once for the single selector call — the total store size
    // did not multiply the cost.
    expect(__childrenIndexBuildCountForTest()).toBe(1);
  });
});
