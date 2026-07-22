// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "solid-js/store";
import { orphanSessions, archiveEligibleOrphans, type RootInfo } from "../../src/orphans";
import { collapseBranch } from "../../src/sync/stream";
import { state, setState, setSelectedIdRaw } from "../../src/sync/store";
import { invalidateChildrenIndex } from "../../src/sync/selectors";
import type { CollapsedBranchStub, Session } from "../../src/types";

// orphans.ts is the client-side orphanhood predicate. A child is an orphan iff
// it has a parentID, that parent is in NEITHER state.sessions (materialized) NOR
// state.branchStubs (collapsed frontier stub), and the child isn't itself
// working. The branchStubs check is the fix for the destructive false-positive
// where a child of a collapsed (live) parent was offered for bulk-archive.
//
// These drive the singleton store directly (the applySnapshot.test.ts pattern),
// so they need jsdom for the window.setTimeout persist() schedules and the
// store's localStorage/location access at module load. No network calls.

// Reset every slice these tests touch. Solid's setState MERGES objects, so a
// plain setState("x", {}) would leave stale nested keys; reconcile({}) diffs
// each slice down to empty (the selectors.test.ts / applySnapshot.test.ts reset
// convention). Also invalidate the cached parent->children index since these
// tests mutate state.sessions directly (the production mutation sites do this
// internally; direct-setState tests must mirror it), and reset the open-session
// signal + expandedBranches so the collapseBranch tests (which set both) are
// isolated from each other.
beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("branchStubs", reconcile({}));
  setState("activity", reconcile({}));
  setState("currentVerbs", reconcile({}));
  setState("expandedBranches", reconcile({}));
  setSelectedIdRaw(null);
  invalidateChildrenIndex();
});

// Minimal valid CollapsedBranchStub (matches the wire shape from types.ts).
const stub = (id: string): CollapsedBranchStub => ({
  id,
  kind: "collapsed-branch",
  hasChildren: true,
  descendantCount: 1,
  aggregateState: "idle",
});

const childOf = (id: string, parentID: string): Session => ({ id, parentID });

describe("orphanSessions — branchStubs aware (collapsed parent is NOT an orphan)", () => {
  it("a child whose parent is collapsed behind a frontier stub is NOT an orphan", () => {
    // The core fix: parent "p" is live but collapsed into state.branchStubs
    // (the lazy-expand / projected-snapshot state). The child must not be
    // classified as orphaned.
    setState("sessions", "child", childOf("child", "p"));
    setState("branchStubs", "p", stub("p"));
    expect(orphanSessions()).toEqual([]);
  });

  it("a child whose parent is genuinely absent IS an orphan", () => {
    // Parent "gone" is in neither state.sessions nor state.branchStubs — a real
    // orphan (parent archived/deleted server-side, cascade missed the child).
    setState("sessions", "child", childOf("child", "gone"));
    expect(orphanSessions()).toHaveLength(1);
    expect(orphanSessions()[0].id).toBe("child");
  });

  it("a child whose parent is materialized is NOT an orphan", () => {
    // Parent present in state.sessions — ordinary in-tree child.
    setState("sessions", "child", childOf("child", "p"));
    setState("sessions", "p", { id: "p" });
    expect(orphanSessions()).toEqual([]);
  });

  it("a working child is never an orphan (even with an absent parent)", () => {
    // The sessionWorking guard is retained: a running orphan already surfaces in
    // the tree and is active work you wouldn't bulk-archive. activity="busy"
    // makes sessionWorking(child) true.
    setState("sessions", "child", childOf("child", "gone"));
    setState("activity", "child", "busy");
    expect(orphanSessions()).toEqual([]);
  });

  it("a rootless session (no parentID) is never an orphan", () => {
    // No parentID => cannot be a subsession => cannot be orphaned.
    setState("sessions", "r", { id: "r" });
    expect(orphanSessions()).toEqual([]);
  });

  // Frontier invariant — necessary but NOT sufficient for a destructive action:
  //   A materialized child's DIRECT parent is always EITHER materialized
  //   (state.sessions) OR a frontier stub (state.branchStubs). The only time the
  //   direct parent is in NEITHER is the orphanhood predicate's signal.
  // The direct-parentID check is NECESSARY to classify an orphan, but it is NOT
  // SUFFICIENT to authorize the destructive bulk-archive on its own. Two known
  // paths can strand a materialized child whose live parent lands in neither
  // store: collapse-on-abandon / manual twisty-collapse used to leave the
  // descendants in state.sessions (FIX 1 — collapseBranch now REMOVES them so
  // the invariant is restored), and a full-rebuild snapshot that drops the
  // parent stub off the one-level frontier. So the bulk action is gated a
  // SECOND time by archiveEligibleOrphans (FIX 2), which requires the orphan's
  // root to be CONFIRMED archived server-side. The two fixes are complementary:
  // FIX 1 prevents the stranded state from arising via collapse; FIX 2
  // guarantees safety even if it arises another way.
  //
  // The lazy-expand fact below remains true: expanding stub "p" materializes p's
  // children while p STAYS a stub (stream.ts applyLazyExpandMerge only adds
  // stubs, never removes the expanded branch). So child "c" with parentID="p"
  // and p in branchStubs is NOT an orphan. What no longer holds is the old
  // "sufficient / invariant closed" claim — see the stranding test below and the
  // archiveEligibleOrphans suite.
  it("FRONTIER INVARIANT: lazy-expand child (parent is a stub) is NOT an orphan", () => {
    setState("sessions", "c", childOf("c", "p"));
    setState("branchStubs", "p", stub("p"));
    // Also seed a sibling materialized root to ensure the filter doesn't trip
    // on unrelated sessions.
    setState("sessions", "root", { id: "root" });
    expect(orphanSessions()).toEqual([]);
  });

  it("does not flag children of distinct materialized and stub parents together", () => {
    // Mixed tree: one real orphan, one stub-collapsed child, one in-tree child.
    // Only the genuine orphan should surface.
    setState("sessions", "orph", childOf("orph", "archived")); // parent gone
    setState("sessions", "collapsed", childOf("collapsed", "stub-p")); // parent a stub
    setState("sessions", "intree", childOf("intree", "mat-p")); // parent materialized
    setState("sessions", "mat-p", { id: "mat-p" });
    setState("branchStubs", "stub-p", stub("stub-p"));
    const out = orphanSessions().map((s) => s.id);
    expect(out).toEqual(["orph"]);
  });
});

// collapseBranch — FIX 1 (root cause): collapsing a branch must REMOVE its
// materialized descendants (not merely hide them), restoring the frontier
// invariant so the descendants can never become false orphans. The three
// trigger paths (lazyExpandBranch stale-cursor-twice / structural-churn-exhausted
// and the manual twisty in StubNode) all route through collapseBranch, so these
// cover all paths.
describe("collapseBranch — restores the frontier invariant (FIX 1)", () => {
  it("removes materialized descendants on collapse so they cannot become false orphans", () => {
    // Lazy-expanded state: p is a stub, c materialized as a child of p.
    setState("sessions", "c", childOf("c", "p"));
    setState("branchStubs", "p", stub("p"));
    setState("expandedBranches", "p", true);
    collapseBranch("p");
    // c is gone from sessions — it can no longer be flagged as an orphan.
    expect(state.sessions["c"]).toBeUndefined();
    // p itself is preserved (stays as its stub).
    expect(state.branchStubs["p"]).toBeDefined();
    // Branch marked collapsed.
    expect(state.expandedBranches["p"]).toBe(false);
    // And the now-empty sessions map yields no orphans.
    expect(orphanSessions()).toEqual([]);
  });

  it("exempts the open/viewed session from removal (does not blank it mid-view)", () => {
    // Two children of the collapsed branch p; one is the currently-viewed session.
    setState("sessions", "c", childOf("c", "p"));
    setState("sessions", "other", childOf("other", "p"));
    setState("branchStubs", "p", stub("p"));
    setSelectedIdRaw("c");
    collapseBranch("p");
    // The open session c is preserved (its payload must not blank ChatView/
    // SessionInspector mid-view — mirrors applyProjectedSnapshot's openId exempt).
    expect(state.sessions["c"]).toBeDefined();
    // Other descendants are still removed.
    expect(state.sessions["other"]).toBeUndefined();
    expect(state.expandedBranches["p"]).toBe(false);
  });

  it("removes a multi-level materialized subtree and clears nested-expand flags", () => {
    // p stub; c materialized child of p; g materialized child of c (nested expand).
    setState("sessions", "c", childOf("c", "p"));
    setState("sessions", "g", childOf("g", "c"));
    setState("branchStubs", "p", stub("p"));
    setState("expandedBranches", "c", true);
    setState("expandedBranches", "p", true);
    collapseBranch("p");
    // Both c and g removed from sessions.
    expect(state.sessions["c"]).toBeUndefined();
    expect(state.sessions["g"]).toBeUndefined();
    // Nested-expand flag for c cleared; p marked collapsed.
    expect(state.expandedBranches["c"]).toBeUndefined();
    expect(state.expandedBranches["p"]).toBe(false);
    // No orphan surfaces from the now-empty sessions.
    expect(orphanSessions()).toEqual([]);
  });
});

// archiveEligibleOrphans — FIX 2 (defense-in-depth): a pure, network-free gate
// that returns ONLY orphans whose server-resolved root is CONFIRMED archived.
// This makes the destructive bulk action safe-by-construction regardless of
// client state.
describe("archiveEligibleOrphans — defense-in-depth gate (FIX 2)", () => {
  // Synthetic row builder so the test never touches the network.
  const row = (id: string, root: RootInfo | null) => ({
    orphan: childOf(id, root ? root.id : "unknown"),
    root,
  });
  const archived = (id: string): RootInfo => ({ id, title: id, archived: true });
  const active = (id: string): RootInfo => ({ id, title: id, archived: false });

  it("includes only orphans whose server-resolved root is CONFIRMED archived", () => {
    const rows = [
      row("a", archived("ra")), // archived root → eligible
      row("b", active("rb")), // ACTIVE root → excluded
      row("c", null), // unresolved root → excluded
    ];
    const out = archiveEligibleOrphans(rows).map((s) => s.id);
    expect(out).toEqual(["a"]);
  });

  it("excludes every row when no root is confirmed archived (all live/unresolved)", () => {
    const rows = [row("b", active("rb")), row("c", null)];
    expect(archiveEligibleOrphans(rows)).toEqual([]);
  });

  it("includes all rows when every root is confirmed archived", () => {
    const rows = [row("a", archived("ra")), row("b", archived("rb"))];
    expect(archiveEligibleOrphans(rows).map((s) => s.id)).toEqual(["a", "b"]);
  });

  // Invariant-hardening / stranding: the regression itself. With c left
  // materialized and its parent p stranded in NEITHER store, orphanSessions()
  // WOULD flag c (the inherent direct-parentID predicate limitation). But
  // archiveEligibleOrphans refuses to archive it when its root is ACTIVE. This
  // pins that the two fixes are complementary: FIX 1 prevents the stranded
  // state from arising via collapse; FIX 2 guarantees safety even if it arises
  // another way.
  it("predicate returns a stranded child, but the archive gate excludes it when its root is ACTIVE", () => {
    // Simulate the stranded state: c materialized, p in NEITHER store (a
    // full-rebuild promotion snapshot wiped branchStubs and omitted p from the
    // frontier). This is exactly the state FIX 1's collapseBranch prevents from
    // arising via collapse, but it can still arise another way.
    setState("sessions", "c", childOf("c", "p"));
    // p is absent from both sessions and branchStubs → inherent predicate
    // limitation surfaces c as an orphan candidate.
    expect(orphanSessions().map((s) => s.id)).toEqual(["c"]);
    // But the defense gate refuses to bulk-archive a child whose root is ACTIVE.
    const gated = archiveEligibleOrphans([row("c", active("p"))]);
    expect(gated).toEqual([]);
    // And only a CONFIRMED-archived root would pass the gate.
    const kept = archiveEligibleOrphans([row("c", archived("p"))]);
    expect(kept.map((s) => s.id)).toEqual(["c"]);
  });
});
