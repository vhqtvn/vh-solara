// @vitest-environment jsdom
//
// Session-tree STATE MACHINE regression tests. The recent bug batch
// (4bc41db dedup, de782d8 merge-reconcile, e88f19e orphan gate +
// collapse-removes-descendants, 773e0aa stub-row-opens) were each a
// CROSS-COMPONENT transition bug, not an isolated predicate. A static
// "these two maps coexist" test does NOT reproduce the failing transition; a
// multi-step drive through the real merge seam does. These five scenarios
// (S1–S5) each drive a REAL transition sequence and assert the cross-component
// invariant that broke.
//
// These reuse the helper/seed conventions of the sibling files:
//   - applySnapshot.test.ts  → how projected snapshots are constructed and how
//                              fetch is mocked for lazyExpand;
//   - StubNode.test.tsx      → the render helpers + DOM selectors;
//   - orphans.test.ts        → the orphanSessions/archiveEligibleOrphans row
//                              builders and the direct-setState seed pattern.
//
// NOTE on extension: the mission named this `sessionTreeLifecycle.test.ts`,
// but S1/S2 render `<SessionTree/>` (JSX), which a `.ts` file cannot compile
// under esbuild. The sibling DOM-rendering test is `StubNode.test.tsx`, so this
// file follows that convention and is `.tsx`.
//
// jsdom is required: the DOM-rendering scenarios (S1/S2) need it, and every
// scenario touches store persistence (window.setTimeout in bumpUpdating/
// persist) and the store's localStorage/location access at module load.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import {
  applySnapshot,
  collapseBranch,
  lazyExpandBranch,
  resetTreeStreamStateForTesting,
} from "../../src/sync/stream";
import { selectedId, setState, setSelectedIdRaw, state } from "../../src/sync/store";
import { view } from "../../src/ui";
import { archiveEligibleOrphans, orphanSessions, type RootInfo } from "../../src/orphans";
import type { CollapsedBranchStub, Session, Snapshot } from "../../src/types";
import SessionTree, { __resetTreeForTest, openSessionChat } from "../../src/components/SessionTree";
import { __resetPinnedForTest } from "../../src/sidebar";
import { setNameReplacements } from "../../src/projectSettings";

// --- shared helpers (mirror the sibling files' conventions) -----------------

// Minimal valid CollapsedBranchStub (orphans.test.ts / StubNode.test.tsx shape).
const stub = (id: string, over: Partial<CollapsedBranchStub> = {}): CollapsedBranchStub => ({
  id,
  kind: "collapsed-branch",
  hasChildren: true,
  descendantCount: 1,
  aggregateState: "idle",
  ...over,
});

const childOf = (id: string, parentID: string): Session => ({ id, parentID });

const rootInfo = (id: string, archived: boolean): RootInfo => ({ id, title: id, archived });

// Projected-snapshot driver. `cause` ABSENT ⇒ lazy/merge path (no reconcile);
// `cause` in {initial,promotion,reconnect,resync} ⇒ full frontier rebuild +
// sessions reconcile. `rev` is bumped per snapshot so applySnapshot's
// structuralRevision monotonicity guard never idempotent-skips a later
// snapshot; lastAppliedStructuralRevision is cleared between tests by
// resetTreeStreamStateForTesting(). A single stable epoch keeps every snapshot
// on the same revision clock (no epoch reset).
function proj(o: {
  seq: number;
  rev: number;
  cause?: Snapshot["cause"];
  sessions?: Session[];
  stubs?: CollapsedBranchStub[];
}): void {
  applySnapshot({
    seq: o.seq,
    structuralRevision: o.rev,
    epoch: "e1",
    projected: true,
    cause: o.cause,
    sessions: o.sessions ?? [],
    stubs: o.stubs ?? [],
  });
}

// Reset every slice these tests touch. Solid's setState MERGES objects, so a
// plain setState("x", {}) would leave stale nested keys; reconcile({}) diffs
// each slice down to empty (selectors.test.ts / applySnapshot.test.ts reset
// convention). The DOM-render hygiene block mirrors StubNode.test.tsx.
beforeEach(() => {
  setState("sessions", reconcile({}));
  setState("messages", reconcile({}));
  setState("lastAgents", reconcile({}));
  setState("messagesLoaded", reconcile({}));
  setState("messagesError", reconcile({}));
  setState("refreshing", reconcile({}));
  setState("activity", reconcile({}));
  setState("permissions", reconcile({}));
  setState("questions", reconcile({}));
  setState("currentVerbs", reconcile({}));
  setState("unread", reconcile({}));
  setState("expandedBranches", reconcile({}));
  setState("branchStubs", reconcile({}));
  setState("epoch", "");
  setState("epochChanged", false);
  setState("cursor", 0);
  // Isolate the reconcile openId exemption + lazyExpand single-flight state.
  setSelectedIdRaw(null);
  resetTreeStreamStateForTesting();
  // DOM-render hygiene: SessionTree / pinned / name-replacements are module
  // singletons; localStorage holds tree-mode hydration.
  localStorage.clear();
  __resetTreeForTest();
  __resetPinnedForTest();
  setNameReplacements([]);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// =========================================================================== //
// S1 — duplicate-row reproducer through the REAL merge seam.
// Pins 4bc41db (render-layer dedup) + de782d8 (full-rebuild merge reconcile).
//
// The duplicate-session bug was a TRANSITION: a session demoted to a stub on a
// full-rebuild snapshot used to leave its stale materialized payload in
// state.sessions ALONGSIDE the new branchStubs entry, so the tree rendered two
// rows for one id. de782d8 added the reconcile that prunes the demoted payload
// (case a: stub present, absent from snap.sessions); 4bc41db made the render
// layer suppress the stub whenever the materialized node wins. A static
// "both maps hold the id" coexist test does NOT reproduce the failing
// transition — only driving the demotion snapshot through applySnapshot does.
// =========================================================================== //
describe("S1 — demotion reconcile + render dedup (no duplicate row)", () => {
  it("a session demoted to a stub is reconciled out of state.sessions and renders exactly once", () => {
    // (1) Seed: active root R with a materialized child Rchild.
    proj({
      seq: 1,
      rev: 1,
      cause: "initial",
      sessions: [{ id: "R", title: "Root" }, { id: "Rchild", parentID: "R" }],
    });
    expect(state.sessions.R).toBeDefined();
    expect(state.sessions.Rchild).toBeDefined();

    // (2) Promotion: R goes idle past the projection cutoff → the server emits
    //     R as a collapsed-branch stub and OMITS it from snap.sessions.
    proj({
      seq: 2,
      rev: 2,
      cause: "promotion",
      sessions: [],
      stubs: [stub("R", { title: "Root" })],
    });

    // (a) The stale materialized payload for R was reconciled away (case a:
    //     R is now a stub id and absent from snap.sessions).
    expect(state.sessions.R).toBeUndefined();
    // (b) R is now a frontier stub.
    expect(state.branchStubs.R).toBeDefined();
    // Rchild is PRESERVED: the ghost-reconcile only authoritatively deletes a
    // child of a MATERIALIZED parent (the frontier is exhaustive one level
    // deep under an active parent). R is no longer materialized in this
    // snapshot, so Rchild is not an authoritative ghost-child delete. (Rchild
    // is not an orphan either: its parent R is now a stub in branchStubs.)
    expect(state.sessions.Rchild).toBeDefined();

    // (c) Render-layer invariant: EXACTLY ONE row for R (no duplicate). The
    //     demotion left R only as a stub, so a materialized <Node> must NOT
    //     render and a <StubNode> must.
    const { container } = render(() => <SessionTree />);
    const c = container as unknown as HTMLElement;
    const nodeRows = c.querySelectorAll(`[data-session-id="R"]`);
    const stubRowEl = c.querySelector(`[data-stub-id="R"]`);
    expect(
      nodeRows.length,
      "R is demoted — no materialized <Node> should render",
    ).toBe(0);
    expect(stubRowEl, "R must render once as a <StubNode>").not.toBeNull();
    // The duplicate-row regression is the SUM across both maps === 1.
    expect(nodeRows.length + (stubRowEl ? 1 : 0)).toBe(1);
  });
});

// =========================================================================== //
// S2 — idle-root open + re-materialization race.
// Pins 773e0aa (stub row opens + carries the selected highlight) and the
// reviewer-flagged selection-transfer race stub → materialized.
//
// From S1's demoted end state (R is stub-only), the user opens the stub row.
// openSessionChat(R) selects R and switches to chat. A subsequent snapshot
// re-materializes R (active again) via a MERGE (cause absent ⇒ no reconcile),
// landing R in BOTH maps transiently. The render-layer dedup must let the
// <Node> win, suppress the <StubNode>, and selection must transfer cleanly
// onto the materialized row.
// =========================================================================== //
describe("S2 — open a stub then re-materialize: selection transfers stub→materialized", () => {
  it("selection survives the stub→materialized transition with the dedup resolving to the Node", () => {
    // Re-establish S1's end state: R is stub-only (demoted); Rchild preserved.
    proj({
      seq: 1,
      rev: 1,
      cause: "initial",
      sessions: [{ id: "R", title: "Root" }, { id: "Rchild", parentID: "R" }],
    });
    proj({
      seq: 2,
      rev: 2,
      cause: "promotion",
      sessions: [],
      stubs: [stub("R", { title: "Root" })],
    });
    expect(state.branchStubs.R).toBeDefined();
    expect(state.sessions.R).toBeUndefined();

    // (1) Open the stub row. openSessionChat = setSelectedId(R) + setView("chat").
    openSessionChat("R");
    expect(selectedId()).toBe("R");
    expect(view()).toBe("chat");

    // Render once; the tree is reactive and will follow the store transitions
    // below without a re-render. The stub row carries the selected highlight
    // (the 773e0aa StubNode classList binding).
    const { container } = render(() => <SessionTree />);
    const c = container as unknown as HTMLElement;
    const stubEl = c.querySelector(`.tree-stub-node[data-stub-id="R"]`);
    expect(stubEl, "stub row for R must render while R is stub-only").not.toBeNull();
    expect(stubEl?.classList.contains("selected")).toBe(true);

    // (2) Re-materialize R via a MERGE snapshot: cause ABSENT ⇒ no reconcile,
    //     so the R stub is PRESERVED and R is upserted into sessions — the
    //     transient both-maps state the render-layer dedup must resolve.
    proj({ seq: 3, rev: 3, sessions: [{ id: "R", title: "Root" }] });
    expect(state.sessions.R).toBeDefined();
    expect(state.branchStubs.R).toBeDefined(); // merge preserved the stub

    // (3) Same reactive container, now updated: the <Node> wins, the
    //     <StubNode> is suppressed, and selection is preserved on the
    //     materialized row.
    const nodeEl = c.querySelector(`.tree-node[data-session-id="R"]`);
    expect(nodeEl, "re-materialized <Node> for R must render").not.toBeNull();
    expect(
      c.querySelector(`[data-stub-id="R"]`),
      "stale <StubNode> for R must be suppressed",
    ).toBeNull();
    expect(nodeEl?.classList.contains("selected"), "selection transfers stub→materialized").toBe(true);
    expect(selectedId()).toBe("R");
  });
});

// =========================================================================== //
// S3 — the orphan residual topology `tier1_b-F1` (THE untested residual).
//
// This is the most valuable scenario. It reproduces the EXACT multi-step
// sequence the orphan reviewer flagged as a residual false-positive that the
// direct-parentID predicate cannot close on its own:
//   (1) P is a frontier stub in state.branchStubs;
//   (2) lazy-expand P ⇒ child C is materialized in state.sessions with
//       parentID=P, while P STAYS a stub (applyLazyExpandMerge only ADDS);
//   (3) a promotion full-rebuild snapshot arrives where an ancestor A is idle
//       ⇒ state.branchStubs is rebuilt with ONLY A (P leaves the frontier);
//   (4) C is PRESERVED by the ghost-reconcile (its parent P is NOT
//       materialized, so it isn't an authoritative ghost-child delete).
// The resulting topology strands C: C ∈ sessions, P ∈ NEITHER sessions NOR
// branchStubs.
//
// Two-layer safety is then asserted:
//   (a) orphanSessions() DOES surface C — the KNOWN residual false-positive
//       (the inherent direct-parentID predicate limit). DOCUMENTED as expected.
//   (b) archiveEligibleOrphans() — the e88f19e destructive gate — REFUSES to
//       bulk-archive C because its server-resolved root is ACTIVE. The
//       residual is contained; the destructive path can't reach a live-root
//       subtree. This pins the known residual AND its mitigation.
// =========================================================================== //
describe("S3 — orphan residual tier1_b-F1: lazy-expand child stranded by a promotion rebuild", () => {
  it("strands a lazy-expand child and contains it via the archive gate (known residual + mitigation)", async () => {
    // (1) P is a frontier stub. A is a materialized ancestor (so the promotion
    //     below has a live root to keep on the rebuilt frontier).
    proj({
      seq: 1,
      rev: 1,
      cause: "initial",
      sessions: [{ id: "A", title: "Ancestor" }],
      stubs: [stub("P", { title: "Parent" })],
    });
    expect(state.branchStubs.P).toBeDefined();

    // (2) Lazy-expand P. The server returns child C (parentID=P). The merge
    //     ONLY ADDS — C is materialized while P STAYS a stub (mirrors the
    //     applySnapshot.test.ts Theme-3 fetch mock for lazyExpand).
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              seq: 100,
              projected: true,
              cause: "lazy-expand",
              sessions: [{ id: "C", parentID: "P", title: "Child" }],
              stubs: [],
            }),
            { status: 200, headers: { "X-VH-Branch-Cursor": "" } },
          ),
        ),
      ),
    );
    await lazyExpandBranch("P");
    vi.unstubAllGlobals();

    expect(state.sessions.C).toBeDefined();
    expect(state.sessions.C.parentID).toBe("P");
    expect(state.branchStubs.P, "P stays a stub after lazy-expand").toBeDefined();

    // (3) Promotion: ancestor A goes idle ⇒ the server re-projects the
    //     frontier with ONLY A. P leaves the frontier.
    proj({
      seq: 2,
      rev: 2,
      cause: "promotion",
      sessions: [],
      stubs: [stub("A", { title: "Ancestor" })],
    });

    // --- resulting topology ---
    // C is PRESERVED by the ghost-reconcile: parent P is NOT materialized in
    // this snapshot (so C is not an authoritative ghost-child delete), and C
    // is not a stub id (so the explicit-demotion case a doesn't fire either).
    expect(state.sessions.C, "C preserved by ghost-reconcile").toBeDefined();
    // P is in NEITHER map: never materialized (sessions) and the full-rebuild
    // wiped branchStubs and rebuilt it with only A.
    expect(state.sessions.P, "P never materialized").toBeUndefined();
    expect(state.branchStubs.P, "P left the frontier on rebuild").toBeUndefined();

    // --- two-layer safety ---
    // (a) orphanSessions() SURFACES C — the KNOWN residual false-positive.
    //     The direct-parentID predicate cannot distinguish a collapsed-
    //     stranded child (parent left the frontier on a rebuild) from a
    //     genuinely-deleted-parent child. This is the inherent predicate
    //     limit; it is EXPECTED, not a bug. (If this assertion ever flips to
    //     NOT containing C, the residual has been closed by a new guard —
    //     convert this into a stays-closed guard and report it.)
    const orphanIds = orphanSessions().map((s) => s.id);
    expect(orphanIds).toContain("C");

    // (b) archiveEligibleOrphans() — the e88f19e destructive gate — REFUSES
    //     C because its server-resolved root is ACTIVE. The predicate
    //     false-positive is contained: the destructive bulk-archive path
    //     can never reach a live-root subtree.
    const gated = archiveEligibleOrphans([
      { orphan: childOf("C", "P"), root: rootInfo("A", false) },
    ]);
    expect(gated, "active root ⇒ never bulk-archived").toEqual([]);
    // (Sanity: only a CONFIRMED-archived root would pass the gate.)
    const kept = archiveEligibleOrphans([
      { orphan: childOf("C", "P"), root: rootInfo("A", true) },
    ]);
    expect(kept.map((s) => s.id)).toEqual(["C"]);
  });
});

// =========================================================================== //
// S4 — busy non-open descendant removed on collapse is not orphan-enumerable.
// Pins the dropped advisory T1 from the e88f19e review.
//
// collapseBranch removes every materialized descendant EXCEPT openId. There is
// NO busy guard, so a sessionWorking-but-not-open descendant D is removed too.
// The safety this pins: once D is gone from state.sessions, orphanSessions()
// (which iterates state.sessions) cannot enumerate it, so the destructive
// bulk-archive path can't reach it. D re-materializes on the next server
// snapshot (self-heal).
// =========================================================================== //
describe("S4 — collapse removes a busy non-open descendant (no orphan enumeration)", () => {
  it("a sessionWorking descendant that is not the open session is removed and not orphan-enumerable", () => {
    // Materialize branch B (stub) with descendant D. Seed via applySnapshot so
    // the parent→children index is invalidated correctly (a direct-setState
    // seed would leave a stale cache and collapseBranch's descendantSessionIds
    // would miss D). D (parentID=B) is grouped under the missing parent's id
    // "B" in the index even though B is only a stub.
    proj({
      seq: 1,
      rev: 1,
      cause: "initial",
      sessions: [{ id: "D", parentID: "B", title: "Descendant" }],
      stubs: [stub("B", { title: "Branch" })],
    });
    // Mark D busy (sessionWorking(D) === true) but D is NOT the open session.
    setState("activity", "D", "busy");
    expect(state.sessions.D).toBeDefined();
    setSelectedIdRaw(null); // D not open

    // Collapse B. No busy guard ⇒ busy-but-not-open D is removed (the
    // openId-only exemption).
    collapseBranch("B");

    expect(state.sessions.D, "busy non-open descendant removed on collapse").toBeUndefined();

    // Safety: D is gone from state.sessions, so orphanSessions() (which
    // iterates state.sessions) cannot enumerate it — the destructive path
    // can't reach it.
    const orphanIds = orphanSessions().map((s) => s.id);
    expect(orphanIds).not.toContain("D");
    // D re-materializes on the next server snapshot — self-heal.
  });
});

// =========================================================================== //
// S5 — open-as-stub consumer safety + the A1 cosmetic.
// Pins the 773e0aa consumer audit: opening a pure stub must not throw, and the
// one documented cosmetic degradation (advisory A1) is pinned as KNOWN.
//
// From S1's demoted end state (R stub-only), openSessionChat(R) must not throw
// across the selection path. The A1 cosmetic: the header title resolution
// would fall back because state.sessions[selectedId()] is undefined while the
// stub exists in branchStubs. This pins the wart explicitly so it is known,
// not silent.
// =========================================================================== //
describe("S5 — open a pure stub (consumer safety + A1 cosmetic)", () => {
  it("opening a stub-only session does not throw and the title-fallback wart is pinned", () => {
    // Demote R to stub-only (the S1 transition).
    proj({ seq: 1, rev: 1, cause: "initial", sessions: [{ id: "R", title: "Root" }], stubs: [] });
    proj({
      seq: 2,
      rev: 2,
      cause: "promotion",
      sessions: [],
      stubs: [stub("R", { title: "Root" })],
    });
    expect(state.sessions.R).toBeUndefined();
    expect(state.branchStubs.R).toBeDefined();

    // Opening a pure stub must not throw across the selection path.
    expect(() => openSessionChat("R")).not.toThrow();
    expect(selectedId()).toBe("R");

    // A1 cosmetic (documented, not silent): the header title resolution would
    // fall back because state.sessions[selectedId()] is undefined while the
    // stub exists in branchStubs. Pin it as a KNOWN wart.
    const open = selectedId()!;
    expect(state.sessions[open]).toBeUndefined();
    expect(state.branchStubs[open]).toBeDefined();
  });
});
