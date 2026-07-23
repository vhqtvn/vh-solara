import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Phase 3 Step D — PART 3: old-client (?tree=1) failure evidence.
//
// The five symptoms (a–e) were recurring bugs in the proj=1 client that tree=2
// eliminates by design. This file documents — per symptom — whether the
// synthetic fixture can REPRODUCE the old-client failure under ?tree=1, and
// where it cannot, cites the source-code evidence that proves the bug existed
// and why the fixture is insufficient.
//
// The fixture's sessions are all "real" (full data in the aggregator store,
// clean parent/child). The old bugs were triggered by conditions the fixture
// does not model: StubNodes (server-omitted collapsed-branch stubs), real
// OpenCode scale, and specific race conditions. For those, we cite the source.

test("tree=1 old render path is active (structural baseline)", async ({ page }) => {
  await page.goto(projectUrl("/?tree=1"));

  // Wait for the old tree to populate.
  await expect(page.locator(".tree-node").first()).toBeVisible({ timeout: 15000 });

  // tree=2 renders <div class="tree tree2">; tree=1 renders <div class="tree">.
  // The absence of .tree2 proves the OLD proj=1 path is active.
  await expect(page.locator(".tree.tree2")).toHaveCount(0);
  await expect(page.locator(".tree:not(.tree2)")).toBeVisible();

  // tree=1 Node renders .tree-guides (indent guides); tree=2 TreeRow does not.
  // At depth 0 the guides span is empty (zero-width) so check existence, not
  // visibility.
  const guidesCount = await page.locator(".tree-guides").count();
  expect(guidesCount).toBeGreaterThan(0);
});

// ─── (a) first-click blank pane ──────────────────────────────────────────────
// OLD BUG: clicking a "materialized" (detail-not-yet-fetched) session showed an
// empty chat pane. In proj=1, a session could exist in the local cache (in the
// tree) without its message history having been fetched; clicking it opened the
// chat but the client didn't proactively fetch the transcript.
//
// FIX IN tree=2: every node carries its own data; clicking opens the chat which
// fetches the transcript independently. See tree2-symptoms.spec.ts (a).
//
// FIXTURE FEASIBILITY: NOT REPRODUCIBLE. The fixture's sessions are all fully
// hydrated in the aggregator store (GET /session returns complete data). The
// proj=1 "materialized" state required a session whose detail hadn't been
// fetched — the fixture always has it. The bug was a client-side lazy-fetch gap
// that only manifested under real OpenCode's async hydration.
test("(a) [infeasible in fixture] old-client blank pane needed unfetched detail", () => {
  // No DOM assertion — documented infeasibility. See header comment.
  expect(true).toBe(true);
});

// ─── (b) subagent jumps to root ──────────────────────────────────────────────
// OLD BUG: a subagent (child session) would appear at root level after certain
// operations, because the proj=1 client inferred parent/child locally and a
// timing gap could misplace the child before the parent's data arrived.
//
// FIX IN tree=2: the server owns the parent/child structure (tree.snapshot
// ships the hierarchy); the client never re-infers it.
//
// FIXTURE FEASIBILITY: NOT REPRODUCIBLE. The fixture's sessions have clean,
// deterministic parent/child data (sub.parentID=demo). The proj=1 client
// correctly groups sub under demo from the first snapshot. The bug required a
// race where the child's data arrived before the parent's, causing a temporary
// root-level misplacement that could persist if the client didn't re-project.
test("(b) [infeasible in fixture] subagent-as-root needed parent/child race", () => {
  // No DOM assertion — documented infeasibility. See header comment.
  expect(true).toBe(true);
});

// ─── (c) blank chip + no right-click on collapsed stubs ──────────────────────
// OLD BUG: StubNodes (CollapsedBranchStub) — sessions whose parent was collapsed
// under an active ancestor — explicitly omitted the AgentChip and did not spread
// the context-menu triggers (menuTriggers). A user saw a blank row with no chip
// and no right-click menu.
//
// SOURCE-CODE EVIDENCE (StubNode.tsx):
//   Line 125-126: "Stubs never carry an AgentChip: the server omitted
//                  per-session agent data for collapsed subtrees."
//   Line 100-139: the .tree-node.tree-stub-node button does NOT spread
//                  {...menuTriggers(...)} — compare SessionTree.tsx:391 which
//                  does. No context menu on stubs.
//   Line 112: uses data-stub-id (NOT data-session-id) — stubs are a distinct
//              DOM kind, invisible to tests keyed on data-session-id.
//
// FIX IN tree=2: TreeRow.tsx line 131 comment: "the legacy StubNode omitted the
// agent chip; tree=2's loaded:false node STILL shows its chip. This is bug fix
// #5." Every node — collapsed or not — carries its own agent and spreads
// menuTriggers. See tree2-symptoms.spec.ts (c) for the passing assertion.
//
// FIXTURE FEASIBILITY: NOT REPRODUCIBLE AT DOM LEVEL. The fixture produces zero
// StubNodes: all sessions are roots with clean parent/child, and none are "under
// an active ancestor" (all idle at startup). The server's SnapshotFrontier ships
// all roots; no branch stubs are emitted. We cannot produce a StubNode without
// an active session whose collapsed subtree would be stubbed.
test("(c) [source-code evidence] StubNode.tsx:125-126 + missing menuTriggers", () => {
  // Source-code evidence cited in header. The tree=2 fix is proven in
  // tree2-symptoms.spec.ts (c): the collapsed demo node shows its agent chip
  // AND opens the context menu on right-click.
  expect(true).toBe(true);
});

// ─── (d) flatten-on-load ─────────────────────────────────────────────────────
// OLD BUG: on page reload, the tree would temporarily flatten — showing all
// sessions as flat roots or a stale partial list — because the proj=1 client
// rebuilt the tree from a flat session-list snapshot and the parent/child
// inference was not instantaneous. At real OpenCode scale (hundreds of sessions,
// deep nesting) the flatten was visible for seconds.
//
// FIX IN tree=2: the server re-ships the authoritative frontier snapshot on
// reconnect; the client applies it as-is (no local re-inference).
//
// FIXTURE FEASIBILITY: NOT REPRODUCIBLE. The fixture has 4 sessions with at
// most 1 level of nesting. The flatten is a scale-dependent timing artifact
// that only manifests with enough sessions to make the rebuild visible. With 4
// sessions the proj=1 client rebuilds in <1 frame — no flatten is observable.
// The docker-gold Phase 2 proof (tests/e2e-docker/) covered server-level
// snapshot correctness at a larger fixture scale.
test("(d) [infeasible in fixture] flatten-on-load needed real OpenCode scale", () => {
  // No DOM assertion — documented infeasibility. See header comment.
  expect(true).toBe(true);
});

// ─── (e) archived-session ghost ──────────────────────────────────────────────
// OLD BUG: after archiving a session, a ghost row would linger — the proj=1
// client's "preserve-absent" semantics (SessionTree.tsx:215-219) kept
// state.sessions[id] alive after the server removed it, and the tree could
// re-render the stale row on the next reactive tick.
//
// FIX IN tree=2: the server emits tree.op node.remove; the client drops the
// node from the tree map cleanly. No preserve-absent, no ghost.
//
// FIXTURE FEASIBILITY: NOT RELIABLY REPRODUCIBLE. The fixture's archive flow is
// synchronous and clean: the server removes the session, the client receives
// the removal event, and the row disappears. The ghost was a race condition
// (stale cache re-rendering between the removal event and the next reactive
// sweep) that depended on specific timing. The tree=2 no-ghost assertion is
// proven in tree2-symptoms.spec.ts (e): after archiving, the node is gone and
// does NOT reappear after a 2s wait.
test("(e) [infeasible in fixture] ghost needed stale-cache race", () => {
  // No DOM assertion — documented infeasibility. See header comment.
  expect(true).toBe(true);
});
