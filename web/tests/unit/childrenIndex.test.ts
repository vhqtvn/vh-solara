// @vitest-environment jsdom
//
// Correctness + perf tests for the cached parent→children index that backs
// subtreeSessionIds / descendantWorking (Fix A for the cold-mount freeze).
//
// The index itself is not exported; we exercise it through the public
// selectors that consume it — sessionNeedsInput, sessionTodos, sessionWorking,
// runningSessionCount — and assert they (a) match a full recompute of the
// pre-fix semantics across topologies, (b) stay correct after each mutation
// kind (upsert / delete / wholesale replace), and (c) build the index O(1)
// across many selector calls, NOT O(N) per call (the perf-correctness test).
//
// jsdom is required because the selectors read the Solid singleton store and
// invalidation is wired through stream.ts's apply* helpers (which schedule
// timers via window.setTimeout).
import { beforeEach, describe, expect, it } from "vitest";
import { produce, reconcile } from "solid-js/store";
import { setState, state } from "../../src/sync/store";
import {
  invalidateChildrenIndex,
  __childrenIndexBuildCountForTest,
  __resetChildrenIndexBuildCountForTest,
  sessionNeedsInput,
  sessionTodos,
  sessionWorking,
  runningSessionCount,
} from "../../src/sync/selectors";
import type { Session, TodoItem } from "../../src/types";

// A minimal session shape (the selectors only read id + parentID).
function sess(id: string, parentID?: string): Session {
  return { id, ...(parentID ? { parentID } : {}) } as Session;
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

describe("childrenIndex correctness — descendantWorking via sessionWorking", () => {
  it("detects a busy descendant (busy propagation up the tree)", () => {
    loadSessions([sess("root"), sess("child", "root"), sess("grand", "child")]);
    setState("activity", "grand", "busy");
    expect(sessionWorking("root")).toBe(true);
    expect(sessionWorking("child")).toBe(true);
    expect(sessionWorking("grand")).toBe(true);
  });

  it("does NOT propagate busy from a sibling subtree", () => {
    loadSessions([
      sess("root"),
      sess("a", "root"),
      sess("b", "root"),
      sess("a1", "a"),
      sess("b1", "b"),
    ]);
    setState("activity", "b1", "busy");
    expect(sessionWorking("root")).toBe(true); // b1 is a descendant of root
    expect(sessionWorking("a")).toBe(false); // a's subtree is idle
    expect(sessionWorking("b")).toBe(true);
  });

  it("treats 'retry' as working but not 'idle' or 'error'", () => {
    loadSessions([sess("root"), sess("c", "root")]);
    setState("activity", "c", "retry");
    expect(sessionWorking("root")).toBe(true);
    setState("activity", "c", "idle");
    expect(sessionWorking("root")).toBe(false);
    setState("activity", "c", "error");
    expect(sessionWorking("root")).toBe(false);
  });

  it("runningSessionCount counts each running subtree ONCE (root-level rollup)", () => {
    loadSessions([
      sess("r1"), sess("r1c", "r1"),
      sess("r2"),
      sess("r3"), sess("r3c", "r3"),
    ]);
    // Only r1's subtree is working.
    setState("activity", "r1c", "busy");
    expect(runningSessionCount()).toBe(1);
    // r2 itself working.
    setState("activity", "r2", "busy");
    expect(runningSessionCount()).toBe(2);
    // r3 idle subtree.
    expect(runningSessionCount()).toBe(2);
  });
});

describe("childrenIndex correctness — sessionNeedsInput subtree rollup", () => {
  it("detects a pending permission on a deep descendant", () => {
    loadSessions([sess("root"), sess("child", "root"), sess("grand", "child")]);
    setState("permissions", "grand", { p1: { id: "p1", sessionID: "grand" } });
    expect(sessionNeedsInput("root")).toBe(true);
    expect(sessionNeedsInput("child")).toBe(true);
    expect(sessionNeedsInput("grand")).toBe(true);
  });

  it("detects a pending question (not just permission)", () => {
    loadSessions([sess("root"), sess("c", "root")]);
    setState("questions", "c", { q1: { id: "q1", sessionID: "c", questions: [] } });
    expect(sessionNeedsInput("root")).toBe(true);
  });

  it("clears when the descendant's pending request is resolved", () => {
    loadSessions([sess("root"), sess("c", "root")]);
    setState("permissions", "c", { p1: { id: "p1", sessionID: "c" } });
    expect(sessionNeedsInput("root")).toBe(true);
    setState("permissions", "c", reconcile({}));
    expect(sessionNeedsInput("root")).toBe(false);
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

describe("childrenIndex perf — O(1) builds across N selector calls", () => {
  // The cold-mount workload: ~10 roots × ~10 subagents = ~100 sessions, and
  // ~100 SessionTree Nodes each calling sessionNeedsInput() once on the first
  // render. The pre-fix code rebuilt a childrenOf index by walking ALL
  // sessions on EVERY call → O(N²) ≈ 10,000 ops in a single tick. The cached
  // index must build ONCE and reuse across all selector calls in the same
  // mutation-stable window.
  it("builds the index exactly once across 100 sessionNeedsInput calls on 100 sessions", () => {
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

    // Touch every session via a subtree-walking selector — the cold-mount
    // pattern (each Node calls sessionNeedsInput once).
    for (let r = 0; r < ROOTS; r++) {
      expect(sessionNeedsInput(`r${r}`)).toBe(false);
    }
    // Touch each child too — 100 selector calls total.
    for (let r = 0; r < ROOTS; r++) {
      for (let c = 0; c < CHILDREN_PER_ROOT; c++) {
        expect(sessionNeedsInput(`r${r}.c${c}`)).toBe(false);
      }
    }
    expect(__childrenIndexBuildCountForTest()).toBe(1); // STILL one — cache reused

    // Running a different subtree-walking selector also reuses the cache.
    for (let r = 0; r < ROOTS; r++) {
      expect(sessionWorking(`r${r}`)).toBe(false);
    }
    expect(__childrenIndexBuildCountForTest()).toBe(1);

    // A mutation invalidates; the next selector call rebuilds exactly once.
    upsertSession(sess("r0.newchild", "r0"));
    expect(__childrenIndexBuildCountForTest()).toBe(1); // invalidated but not yet rebuilt
    expect(sessionNeedsInput("r0")).toBe(false);
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
    sessionNeedsInput("r0"); // 11 sessions in this subtree
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
    sessionNeedsInput("R0"); // same 11-session subtree
    // Built exactly once for the single selector call — the total store size
    // did not multiply the cost.
    expect(__childrenIndexBuildCountForTest()).toBe(1);
  });
});
