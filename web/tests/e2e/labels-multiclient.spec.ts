import { expect, test, type APIRequestContext, type Browser, type Locator, type Page } from "@playwright/test";
import { demoDir, projectUrl, resetLabels, resetPins } from "./util";

// Slice 6 — server-managed root-session labels (groups + tags): multi-client
// convergence + the filter×pin render matrix.
//
// Labels are WORKER-OWNED durable state (slices 1–3: /vh/labels CAS doc + SSE
// labels.snapshot/labels.updated). The defining property is that TWO browsers
// viewing the same worker CONVERGE: a group/tag/assignment mutation in one
// reaches the other through the server, and lifecycle cleanup (archive/delete)
// evicts the root from EVERY viewer. These specs prove that end-to-end through
// real browsers against the real fixtureserver (real web.NewServer + aggregator
// + fake OpenCode — same binary `npm run test:e2e` boots via fixture-web.sh).
//
// SCENARIO → LANE MAP (honest deterministic coverage):
//   (a) create-group-via-context-menu + two-tab convergence ..... Playwright (here)
//   (b) move-root-to-existing-group converges in B .............. Playwright (here)
//   (c) filter×pin matrix (F2/F3/F1) ........................... Playwright (here)
//        - F2: pinned root MATCHING the filter stays in pinned
//        - F3: pinned root FAILING the filter is hidden entirely (not demoted)
//        - F1: a deep (non-root) pin is dropped from pinned top-level under filter
//   (d) reconnecting client receives surviving groups (bootstrap) . Playwright (here)
//   (e) archiving a grouped+tagged disposable session removes it in both . Playwright
//   (f) tag-filter AND narrows the tree ........................ Playwright (here)
// The facade's CAS/conflict/retry contract is covered deterministically by
// web/tests/unit (sidebar-labels, labelsDeletionCascade); these e2e prove the
// browser↔server↔browser wiring + the render partition.
//
// TEST HYGIENE: the suite is SERIAL (workers:1) over ONE shared fixtureserver,
// so server-side labels AND pins state leak across specs. beforeEach/afterEach
// reset BOTH the labels doc and the pin doc via the real APIs so this spec
// neither inherits nor leaks grouped/pinned/tagged state. (A grouped root
// renders under a GroupHeader and OUT of the ungrouped list, and a pinned root
// is hoisted into .tree-pinned — both silently break sibling assertions if
// leaked.) (e) uses a DISPOSABLE session (POST /oc/session) so the destructive
// archive never touches a seeded session.
//
// SELECTOR NOTE: slice-6 component CSS is co-located CSS Modules (hashed class
// names), so these tests select via STABLE hooks only: global classes
// (.tree-pinned/.tree-node/.ctxm-item/.ctxm-grouplabel), data attributes
// ([data-session-id]/[data-group-id]), aria attributes ([aria-pressed]/
// [aria-expanded]/[aria-label]), role+name (getByRole), and text content. No
// test depends on a hashed module class name.

// Wait for the tree to populate (mirrors pins-multiclient — does NOT gate on
// global idle, since a prior serial spec can leave a session genuinely busy).
async function waitForTreeSettled(page: Page): Promise<void> {
  await expect(page.locator(".tree-row").first()).toBeVisible({ timeout: 15000 });
}

// openClient loads a fresh browser CONTEXT (distinct client — own SSE stream +
// own Solid state) and waits for the tree to settle. Callers MUST close the
// returned handle in a finally block (a leaked context keeps a /vh/stream open
// and can perturb later broadcast assertions).
async function openClient(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(projectUrl("/"));
  await waitForTreeSettled(page);
  return { page, close: () => ctx.close() };
}

// createDisposableSession — a fresh never-opened ROOT session via the raw
// /oc/session passthrough (the fake OpenCode's /session handler). Emits a
// session.upsert that both browsers render. Used by (e) so the destructive
// archive never touches a seeded session.
async function createDisposableSession(request: APIRequestContext): Promise<string> {
  const res = await request.post("/oc/session", {
    headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
    data: {},
  });
  if (!res.ok()) {
    throw new Error(`createDisposableSession: POST /oc/session -> ${res.status()} ${res.statusText()}`);
  }
  const body = await res.json();
  if (!body?.id) throw new Error("createDisposableSession: POST /oc/session returned no id");
  return body.id as string;
}

// withLabels — read-modify-write the worker-wide labels doc via the real CAS
// API. Reads the current doc + revision, applies `fn` to produce the next doc,
// PUTs with baseRevision, retries on 409. The store generates NO ids (the
// client supplies them), so callers mint deterministic test ids (lg-e2e-… /
// lt-e2e-…) directly in `fn` — no find-by-name needed. Mirrors resetLabels' CSRF
// + retry shape. Used to set up known label state deterministically without
// driving the (slower, UI-bound) context-menu flow for every test.
type LabelDocApi = {
  revision: number;
  groups: { id: string; name: string; color: string; collapsed: boolean; orderedRootSessionIds: string[] }[];
  tags: { id: string; name: string; color: string }[];
  tagIdsByRootSessionId: Record<string, string[]>;
};
async function withLabels(
  request: APIRequestContext,
  fn: (doc: LabelDocApi) => LabelDocApi,
): Promise<void> {
  // Mirror the SPA: stamp x-opencode-directory so reqDir resolves to the demo
  // project key (the same key the SPA loads via ?dir=). See resetLabels in
  // util.ts for the full rationale.
  const csrf = { "X-VH-CSRF": "1", "x-opencode-directory": demoDir };
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await request.get("/vh/labels", { headers: csrf });
    if (!cur.ok()) throw new Error(`withLabels: GET -> ${cur.status()}`);
    const base = (await cur.json()) as LabelDocApi;
    const next = fn(JSON.parse(JSON.stringify(base)));
    const put = await request.put("/vh/labels", {
      headers: csrf,
      data: { baseRevision: base.revision, ...next, revision: undefined },
    });
    if (put.ok()) return;
    if (put.status() === 409) continue;
    throw new Error(`withLabels: PUT -> ${put.status()} ${put.statusText()}`);
  }
  throw new Error("withLabels: exhausted retries on repeated 409");
}

// withPins — read-modify-write the pin doc (mirrors withLabels over /vh/pins).
// Used to set up the filter×pin matrix's pinned state deterministically.
async function withPins(
  request: APIRequestContext,
  fn: (orderedSessionIds: string[]) => string[],
): Promise<void> {
  const csrf = { "X-VH-CSRF": "1" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await request.get("/vh/pins");
    if (!cur.ok()) throw new Error(`withPins: GET -> ${cur.status()}`);
    const base = await cur.json();
    const next = fn([...(base.orderedSessionIds ?? [])]);
    const put = await request.put("/vh/pins", {
      headers: csrf,
      data: { baseRevision: base.revision, orderedSessionIds: next },
    });
    if (put.ok()) return;
    if (put.status() === 409) continue;
    throw new Error(`withPins: PUT -> ${put.status()} ${put.statusText()}`);
  }
  throw new Error("withPins: exhausted retries on repeated 409");
}

// Locators for the three render sections. A root renders in EXACTLY ONE
// (DISJOINT): pinned wins, then group, then ungrouped.
const inPinned = (page: Page, id: string) =>
  page.locator(`.tree-pinned [data-session-id="${id}"]`);
const inGroup = (page: Page, id: string) =>
  page.locator(`[data-group-id] [data-session-id="${id}"]`);
// Ungrouped = present in the tree but NOT pinned and NOT grouped.
async function expectUngrouped(page: Page, id: string): Promise<void> {
  await expect(inPinned(page, id)).toHaveCount(0);
  await expect(inGroup(page, id)).toHaveCount(0);
  await expect(page.locator(`.tree2 [data-session-id="${id}"]`)).toBeVisible();
}
async function expectHiddenEverywhere(page: Page, id: string): Promise<void> {
  await expect(page.locator(`.tree2 [data-session-id="${id}"]`)).toHaveCount(0);
}

test.beforeEach(async ({ request }) => {
  await resetLabels(request);
  await resetPins(request);
});
test.afterEach(async ({ request }) => {
  await resetLabels(request);
  await resetPins(request);
});

// ─── (a) create-group-via-context-menu + two-tab convergence ──────────────────
test("(a) creating a group via the context menu in A converges in B", async ({ browser }) => {
  const a = await openClient(browser);
  const b = await openClient(browser);
  try {
    // Sanity: `other` is ungrouped in both before the action.
    await expectUngrouped(a.page, "other");
    await expectUngrouped(b.page, "other");

    // A: right-click `other` → "Group" ▸ "New group…" → name it → create.
    await a.page.locator(`.tree-node[data-session-id="other"]`).first().click({ button: "right" });
    await expect(a.page.locator(".ctxm-menu")).toBeVisible();
    await a.page.locator(".ctxm-item", { hasText: "New group…" }).click();
    // The menu closes and the new-group TextPromptDialog opens.
    await expect(a.page.locator(".vh-prompt")).toBeVisible();
    await a.page.locator(".vh-prompt-input").fill("Backend");
    await a.page.locator(".vh-prompt .confirm-go").click();

    // A: `other` left ungrouped, now lives under a "Backend" group header.
    await expect(inGroup(a.page, "other")).toBeVisible({ timeout: 8000 });
    await expect(
      a.page.locator("[data-group-id]").filter({ hasText: "Backend" })
    ).toBeVisible();
    await expect(inPinned(a.page, "other")).toHaveCount(0);

    // B converges via labels.updated SSE: the same group + assignment appear.
    await expect(inGroup(b.page, "other")).toBeVisible({ timeout: 8000 });
    await expect(
      b.page.locator("[data-group-id]").filter({ hasText: "Backend" })
    ).toBeVisible();
  } finally {
    await a.close();
    await b.close();
  }
});

// ─── (b) move-root-to-existing-group converges in B ───────────────────────────
test("(b) moving a root into an existing group via the menu converges in B", async ({ request, browser }) => {
  // Pre-create the group via the API (deterministic setup; the create flow is
  // already proven by (a)). `demo` starts ungrouped.
  await withLabels(request, (doc) => ({
    ...doc,
    groups: [
      ...doc.groups,
      { id: "lg-e2e-feat", name: "Feature", color: "green", collapsed: false, orderedRootSessionIds: [] },
    ],
  }));

  const a = await openClient(browser);
  const b = await openClient(browser);
  try {
    // Both see the empty "Feature" group + `demo` ungrouped.
    await expect(a.page.locator("[data-group-id]").filter({ hasText: "Feature" })).toBeVisible();
    await expectUngrouped(a.page, "demo");
    await expectUngrouped(b.page, "demo");

    // A: right-click `demo` → "Group" ▸ pick "Feature" (the existing group).
    await a.page.locator(`.tree-node[data-session-id="demo"]`).first().click({ button: "right" });
    await expect(a.page.locator(".ctxm-menu")).toBeVisible();
    await a.page.locator(".ctxm-item", { hasText: "Feature" }).click();

    // A: `demo` moves into the Feature group.
    await expect(inGroup(a.page, "demo")).toBeVisible({ timeout: 8000 });

    // B converges: `demo` is in the Feature group too.
    await expect(inGroup(b.page, "demo")).toBeVisible({ timeout: 8000 });
  } finally {
    await a.close();
    await b.close();
  }
});

// ─── (c) filter×pin matrix — F2/F3 (pinned ROOTS) ────────────────────────────
// Fixture roots: demo, other, slow. Setup (via API, before the client loads):
// pin [demo, other]; create tag T1; assign T1 to `demo` ONLY. Filter by T1 and:
//   F2: demo (pinned root, matches T1) → STAYS in .tree-pinned.
//   F3: other (pinned root, no T1)     → hidden ENTIRELY (not demoted to
//       group/ungrouped — the filter hides it, pinned or not).
test("(c) filter×pin: matching pinned root stays, failing pinned root hides", async ({ request, browser }) => {
  await withPins(request, () => ["demo", "other"]);
  await withLabels(request, (doc) => ({
    ...doc,
    tags: [...doc.tags, { id: "lt-e2e-t1", name: "T1", color: "blue" }],
    tagIdsByRootSessionId: { ...doc.tagIdsByRootSessionId, demo: ["lt-e2e-t1"] },
  }));

  const a = await openClient(browser);
  try {
    // Pre-filter: both pinned roots at top level.
    await expect(inPinned(a.page, "demo")).toBeVisible();
    await expect(inPinned(a.page, "other")).toBeVisible();

    // Reveal the filter rail and toggle T1 (selectedTagIds is client-local).
    await a.page.locator(`[aria-label="Filter sessions by tags"]`).click();
    const rail = a.page.locator('[role="group"][aria-label="Filter sessions by tag"]');
    await expect(rail).toBeVisible();
    await rail.locator("button", { hasText: "T1" }).click();

    // F2: demo (matches T1) STAYS in pinned.
    await expect(inPinned(a.page, "demo")).toBeVisible({ timeout: 8000 });

    // F3: other (pinned root, fails filter) is hidden ENTIRELY — not demoted to
    // ungrouped or any group. It must not reappear anywhere in the tree.
    await expectHiddenEverywhere(a.page, "other");

    // Clearing the filter restores other to pinned top-level.
    await rail.locator("button", { hasText: "Clear" }).click();
    await expect(inPinned(a.page, "other")).toBeVisible({ timeout: 8000 });
  } finally {
    await a.close();
  }
});

// ─── (c2) filter×pin matrix — F1 (deep / non-root pin) ────────────────────────
// Create a disposable ROOT R and fork a CHILD C under it (both resident via
// session.created — deterministic, unlike the lazy-loaded seeded demo→sub pair).
// Tag R with T1b; pin C (a non-root). C has no pinned ancestor (R is unpinned),
// so selectPinnedNodes hoists C to pinned top-level. Under the filter:
//   F1: C (pinned NON-root) is DROPPED from pinned top-level — labels are
//       root-only, so a deep pin can never carry a tag and cannot match a non-
//       empty filter (selectLabeledSections: parentId !== null → skip).
test("(c2) filter×pin: a deep (non-root) pin is dropped from pinned top-level under filter", async ({ request, browser }) => {
  // The seeded `demo` has a known child `sub` (parentID=demo). `sub` is NOT
  // resident at cold load (the snapshot trims non-root children), so we expand
  // `demo` first — clicking its twisty fetches its children into the tree map,
  // making `sub` resident. Once resident, the pre-set pin hoists `sub` (a non-
  // root with no pinned ancestor) to pinned top-level; the filter then drops it.
  // (The deterministic selector contract is also unit-covered in
  // labelSelectors.test.ts "F1: a deep (non-root) pin is dropped…".)
  await withPins(request, () => ["sub"]);
  await withLabels(request, (doc) => ({
    ...doc,
    tags: [...doc.tags, { id: "lt-e2e-t1b", name: "T1b", color: "green" }],
    tagIdsByRootSessionId: { ...doc.tagIdsByRootSessionId, demo: ["lt-e2e-t1b"] },
  }));

  const a = await openClient(browser);
  try {
    // Expand demo: click its twisty (a sibling of .tree-node inside .tree-row).
    // This fetches demo's children → `sub` becomes resident in the tree map.
    const demoTwisty = a.page
      .locator(".tree-row")
      .filter({ has: a.page.locator('[data-session-id="demo"]') })
      .locator(".tree-twisty");
    await demoTwisty.click();

    // sub is pinned + now resident + no pinned ancestor (demo is unpinned) →
    // hoisted to pinned top-level by selectPinnedNodes.
    await expect(inPinned(a.page, "sub")).toBeVisible({ timeout: 10000 });

    // Reveal the filter rail and toggle T1b.
    await a.page.locator(`[aria-label="Filter sessions by tags"]`).click();
    const rail = a.page.locator('[role="group"][aria-label="Filter sessions by tag"]');
    await rail.locator("button", { hasText: "T1b" }).click();

    // F1: sub (non-root) is dropped from pinned top-level under the filter —
    // labels are root-only, so a deep pin can never carry a tag and cannot
    // match a non-empty filter (selectLabeledSections: parentId !== null → skip).
    await expect(inPinned(a.page, "sub")).toHaveCount(0, { timeout: 8000 });

    // Clearing the filter restores sub to pinned top-level.
    await rail.locator("button", { hasText: "Clear" }).click();
    await expect(inPinned(a.page, "sub")).toBeVisible({ timeout: 8000 });
  } finally {
    await a.close();
  }
});

// ─── (d) reconnecting client receives surviving groups via the bootstrap ──────
test("(d) a reconnecting client receives surviving groups via labels.snapshot", async ({ request, browser }) => {
  // Load B FIRST (clean), then create a group via the API while B is connected,
  // then RELOAD B and assert it re-acquires the group via the labels.snapshot
  // bootstrap frame (not retained DOM). This is the reconnect-catches-up
  // guarantee: labels are server-owned, so a client that drops and reconnects
  // is never permanently out of sync.
  const a = await openClient(browser);
  const b = await openClient(browser);
  try {
    // No groups initially.
    await expect(b.page.locator("[data-group-id]")).toHaveCount(0);

    // Create a group + assign `other` via the API. The PUT fans out
    // labels.updated → B (still connected) sees it live.
    await withLabels(request, (doc) => ({
      ...doc,
      groups: [
        ...doc.groups,
        {
          id: "lg-e2e-recon",
          name: "Recon",
          color: "purple",
          collapsed: false,
          orderedRootSessionIds: ["other"],
        },
      ],
    }));

    // B (still connected) converges via labels.updated.
    await expect(inGroup(b.page, "other")).toBeVisible({ timeout: 8000 });

    // Reconnect B: reload tears down its SSE stream + Solid state; on reconnect
    // the server emits labels.snapshot as the bootstrap frame, restoring the
    // surviving group + assignment.
    await b.page.reload();
    await waitForTreeSettled(b.page);
    await expect(inGroup(b.page, "other")).toBeVisible({ timeout: 10000 });
  } finally {
    await a.close();
    await b.close();
  }
});

// ─── (e) archiving a grouped+tagged disposable session removes it in both ─────
test("(e) archiving a grouped+tagged disposable session removes the assignment in both clients", async ({ request, browser }) => {
  const id = await createDisposableSession(request);
  // Pre-create a group + tag and assign the disposable root to both.
  await withLabels(request, (doc) => ({
    ...doc,
    groups: [
      ...doc.groups,
      {
        id: "lg-e2e-arch",
        name: "Arch",
        color: "amber",
        collapsed: false,
        orderedRootSessionIds: [id],
      },
    ],
    tags: [...doc.tags, { id: "lt-e2e-arch", name: "toArchive", color: "red" }],
    tagIdsByRootSessionId: { ...doc.tagIdsByRootSessionId, [id]: ["lt-e2e-arch"] },
  }));

  const a = await openClient(browser);
  const b = await openClient(browser);
  try {
    // The new session fans out via session.upsert; wait for it in both, grouped.
    await expect(inGroup(a.page, id)).toBeVisible({ timeout: 10000 });
    await expect(inGroup(b.page, id)).toBeVisible({ timeout: 10000 });

    // Archive via the real /vh/archive path (the L1 cleanup hook runs on its
    // success → RemoveRootIDs + labels.updated broadcast).
    const res = await request.post("/vh/archive", {
      headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
      data: { sessionID: id },
    });
    expect(res.ok()).toBe(true);

    // The L1 labels cleanup fans out labels.updated → the root is evicted from
    // the group's ordered list in BOTH clients (the group header survives —
    // definitions are kept by invariant #7; only the assignment is removed).
    await expect(inGroup(a.page, id)).toHaveCount(0, { timeout: 10000 });
    await expect(inGroup(b.page, id)).toHaveCount(0, { timeout: 10000 });
  } finally {
    await a.close();
    await b.close();
  }
});

// ─── (f) tag filter AND narrows the tree ──────────────────────────────────────
// Assign two tags to `demo` and one of them to `other`; toggling one tag narrows
// to its bearers, toggling BOTH (AND) narrows to only the root carrying both.
test("(f) tag filter AND narrows the visible roots", async ({ request, browser }) => {
  await withLabels(request, (doc) => ({
    ...doc,
    tags: [
      ...doc.tags,
      { id: "lt-e2e-and1", name: "alpha", color: "teal" },
      { id: "lt-e2e-and2", name: "beta", color: "orange" },
    ],
    tagIdsByRootSessionId: {
      ...doc.tagIdsByRootSessionId,
      demo: ["lt-e2e-and1", "lt-e2e-and2"],
      other: ["lt-e2e-and1"],
    },
  }));

  const a = await openClient(browser);
  try {
    await expectUngrouped(a.page, "demo");
    await expectUngrouped(a.page, "other");

    // Reveal the filter rail and toggle "alpha" → demo + other visible, slow hidden.
    await a.page.locator(`[aria-label="Filter sessions by tags"]`).click();
    const rail = a.page.locator('[role="group"][aria-label="Filter sessions by tag"]');
    await rail.locator("button", { hasText: "alpha" }).click();

    await expect(a.page.locator(`.tree2 [data-session-id="demo"]`)).toBeVisible({ timeout: 8000 });
    await expect(a.page.locator(`.tree2 [data-session-id="other"]`)).toBeVisible();
    await expectHiddenEverywhere(a.page, "slow");

    // Toggle "beta" too (AND) → only demo (carries both) remains.
    await rail.locator("button", { hasText: "beta" }).click();
    await expect(a.page.locator(`.tree2 [data-session-id="demo"]`)).toBeVisible();
    await expectHiddenEverywhere(a.page, "other");
    await expectHiddenEverywhere(a.page, "slow");

    // The active chips read as aria-pressed.
    await expect(rail.locator("button[aria-pressed='true']")).toHaveCount(2);
  } finally {
    await a.close();
  }
});

// ─── (g) GroupHeader manage popover: rename / recolor / reorder / delete ──────
// Drives the group header "⋯" manage popover end-to-end through a real browser.
// The popover actions are NOT exercised by any other e2e — the facade intents
// are unit-covered (labels.test.ts), and multi-client convergence is e2e-proven
// by (a)–(f), but the popover-driven paths were a slice-6 review DEFER. One
// walkthrough test exercises every popover action on two groups created via the
// context menu (reusing (a)'s create flow):
//   - rename via the popover input (closes the popover, opens TextPromptDialog)
//   - recolor via a swatch (aria-pressed flips + the header dot's --label-color)
//   - reorder (move up) + the move buttons disable at the ends
//   - delete (group gone, its root returns to ungrouped)
// Two-tab convergence is asserted for the rename and the delete (a second tab
// sees the same change via labels.updated).
//
// SELECTOR STRATEGY (stable hooks only — slice-6 CSS is hashed CSS Modules):
//   - open popover : button[aria-label="Manage group <name>"]
//   - popover menu : [role="menu"][aria-label="Manage group <name>"]  (the shared
//                    module-scope manageOpenId keeps one popover open at a time,
//                    so the per-group menu aria-label disambiguates)
//   - menu items   : menu.getByRole("menuitem", { name: "..." })
//   - swatches     : [role="group"][aria-label="Group color"] button[aria-label="Color <c>"]
//                    with aria-pressed reflecting the current color
//   - header name  : groupToggle(page, name) matches the Expand/Collapse toggle
//                    by an ANCHORED regex so "Alpha" never matches "AlphaRenamed"
//                    (a plain prefix/suffix matcher would hit either the substring
//                    trap or the "Manage group <name>" button)
//   - popover open : openManagePopover(name) clicks the manage button; the menu
//                    is an overlapping high-z-index dropdown, so before touching
//                    anything below the open menu the caller MUST first call
//                    closeManagePopover (toggles its own trigger closed — the
//                    trigger sits above its dropdown so it is never covered).
//                    Never reopen the group whose popover is currently open
//                    (that click toggles it closed); Escape proved an unreliable
//                    closer in e2e.

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// groupToggle — the GroupHeader collapse/expand toggle button for the group
// named `name`. Matches the toggle aria-label ("Expand group <name>" or
// "Collapse group <name>") by an ANCHORED regex so that "Alpha" does NOT match
// "AlphaRenamed" and the "Manage group <name>" button is excluded.
function groupToggle(page: Page, name: string): Locator {
  const re = new RegExp(`^(Expand|Collapse) group ${escapeForRegex(name)}$`);
  return page.getByRole("button", { name: re });
}

// groupOrder — the ordered list of group header names as rendered (the groups[]
// array order). Reads the Expand/Collapse toggle buttons in DOM order and strips
// the prefix. Used to assert reorder actually permutes the rendered headers.
async function groupOrder(page: Page): Promise<string[]> {
  const toggles = page.locator('button[aria-label^="Expand group"], button[aria-label^="Collapse group"]');
  const count = await toggles.count();
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    const label = (await toggles.nth(i).getAttribute("aria-label")) ?? "";
    names.push(label.replace(/^(Expand|Collapse) group /, ""));
  }
  return names;
}

// openManagePopover — opens the GroupHeader "⋯" manage popover for `name` and
// returns its menu locator.
//
// OVERLAP HAZARD: the menu is an absolutely-positioned, high-z-index dropdown
// anchored to the trigger's bottom-right (.groupMenu { position: absolute; top:
// calc(100% + 4px); right: 0; z-index: var(--z-popover) }), so while it is open
// it OVERLAPS the group header(s) below it. Therefore, before interacting with
// anything beneath the open menu (e.g. another group's header / manage button),
// the caller MUST first close it via closeManagePopover — otherwise the click
// lands on the overlapping menu (e.g. its "Delete group" item), not the target.
//
// SAME-GROUP-REOPEN HAZARD: clicking a group's own manage button while its
// popover is already open TOGGLES it closed (open() is true). And keyboard
// Escape proved an unreliable closer in e2e (a same-group Escape-then-click
// ended up toggling closed). So: never reopen the group whose popover is
// currently open; close it explicitly first.
async function openManagePopover(page: Page, name: string): Promise<Locator> {
  await page.locator(`button[aria-label="Manage group ${name}"]`).click();
  const menu = page.locator(`[role="menu"][aria-label="Manage group ${name}"]`);
  await expect(menu).toBeVisible();
  return menu;
}

// closeManagePopover — toggles the open popover for `name` CLOSED by clicking
// its own manage button again (open() is true → setManageOpenId(null)). The
// trigger sits ABOVE its own dropdown menu (.groupMenu top: calc(100% + 4px)),
// so it is never covered by the menu and the click always lands on the trigger.
// Verified-closed (menu count 0) before returning. Precondition: the popover is
// open (otherwise the click would OPEN it and the verify fails fast).
async function closeManagePopover(page: Page, name: string): Promise<void> {
  await page.locator(`button[aria-label="Manage group ${name}"]`).click();
  await expect(page.locator(`[role="menu"][aria-label="Manage group ${name}"]`)).toHaveCount(0);
}

test("(g) GroupHeader manage popover: rename, recolor, reorder, delete converge across tabs", async ({ browser }) => {
  const a = await openClient(browser);
  const b = await openClient(browser);
  try {
    // ── Setup: create two groups via the context menu (proven in (a)), each with
    //    a root in it. Order is [Alpha, Beta] (createGroup appends). Alpha (first)
    //    takes the palette-cycle default color "blue"; Beta (second) "green".
    await a.page.locator(`.tree-node[data-session-id="other"]`).first().click({ button: "right" });
    await expect(a.page.locator(".ctxm-menu")).toBeVisible();
    await a.page.locator(".ctxm-item", { hasText: "New group…" }).click();
    await expect(a.page.locator(".vh-prompt")).toBeVisible();
    await a.page.locator(".vh-prompt-input").fill("Alpha");
    await a.page.locator(".vh-prompt .confirm-go").click();
    await expect(inGroup(a.page, "other")).toBeVisible({ timeout: 8000 });

    await a.page.locator(`.tree-node[data-session-id="slow"]`).first().click({ button: "right" });
    await expect(a.page.locator(".ctxm-menu")).toBeVisible();
    await a.page.locator(".ctxm-item", { hasText: "New group…" }).click();
    await expect(a.page.locator(".vh-prompt")).toBeVisible();
    await a.page.locator(".vh-prompt-input").fill("Beta");
    await a.page.locator(".vh-prompt .confirm-go").click();
    await expect(inGroup(a.page, "slow")).toBeVisible({ timeout: 8000 });

    // Both groups converge in B; order is [Alpha, Beta].
    await expect(groupToggle(b.page, "Alpha")).toBeVisible({ timeout: 8000 });
    await expect(groupToggle(b.page, "Beta")).toBeVisible({ timeout: 8000 });
    expect(await groupOrder(a.page)).toEqual(["Alpha", "Beta"]);

    // ── Rename Alpha → AlphaRenamed via the popover input.
    {
      const menu = await openManagePopover(a.page, "Alpha");
      await menu.getByRole("menuitem", { name: "Rename group" }).click();
      // Popover closes (setManageOpenId(null)); the rename TextPromptDialog opens.
      await expect(a.page.locator(".vh-prompt")).toBeVisible();
      await a.page.locator(".vh-prompt-input").fill("AlphaRenamed");
      await a.page.locator(".vh-prompt .confirm-go").click();
    }
    // A: old toggle gone, new toggle renders.
    await expect(groupToggle(a.page, "Alpha")).toHaveCount(0, { timeout: 8000 });
    await expect(groupToggle(a.page, "AlphaRenamed")).toBeVisible({ timeout: 8000 });
    // B converges via labels.updated: same rename.
    await expect(groupToggle(b.page, "Alpha")).toHaveCount(0, { timeout: 8000 });
    await expect(groupToggle(b.page, "AlphaRenamed")).toBeVisible({ timeout: 8000 });

    // ── Session 1 — AlphaRenamed's popover (opened once; nothing was open after
    //    the rename menuitem closed Alpha's). Recolor blue→red AND assert the
    //    move-up button disables at the FIRST end, in the same popover session.
    {
      const menu = await openManagePopover(a.page, "AlphaRenamed");
      // Recolor via the red swatch.
      const swatches = menu.locator('[role="group"][aria-label="Group color"]');
      await expect(swatches.locator('button[aria-label="Color blue"]')).toHaveAttribute("aria-pressed", "true");
      await swatches.locator('button[aria-label="Color red"]').click();
      // Red swatch now pressed, blue no longer; header dot adopts red via the
      // --label-color CSS var (the optimistic apply flips both before the PUT).
      await expect(menu.locator('button[aria-label="Color red"]')).toHaveAttribute("aria-pressed", "true", { timeout: 8000 });
      await expect(menu.locator('button[aria-label="Color blue"]')).toHaveAttribute("aria-pressed", "false");
      // d63c757 hoisted the inline --label-color binding OFF the .groupDot span
      // and onto the .group container div (rail/tint/dot share one source), so
      // the dot no longer carries style*="--label-red" — its [data-group-id]
      // ancestor does. Assert the recolor bound red by comparing the container's
      // resolved --label-color to :root's --label-red value: chromium resolves
      // the var() substitution for a custom property (so --label-color comes
      // back as the hex, e.g. #f85149), and --label-red on :root resolves the
      // same way — so the two are string-equal iff the recolor took effect,
      // without hardcoding the palette hex here. closest("[data-group-id]")
      // climbs from the AlphaRenamed toggle to the group container holding the
      // binding. (Custom-property resolution is chromium-only here; this e2e
      // runs the single chromium project, so the comparison is stable.)
      await expect.poll(
        () => groupToggle(a.page, "AlphaRenamed").evaluate((btn) => {
          const root = btn.ownerDocument.documentElement;
          const bound = getComputedStyle(btn.closest("[data-group-id]")!).getPropertyValue("--label-color").trim();
          return bound === getComputedStyle(root).getPropertyValue("--label-red").trim();
        }),
        { timeout: 8000 },
      ).toBe(true);
      // AlphaRenamed is FIRST → Move-up disabled (onFirst). Assert Move-down
      // ENABLED first so the disabled below is due to onFirst, not a stray
      // labelsPending left over from the recolor PUT (toBeEnabled auto-retries
      // until the PUT settles).
      await expect(menu.getByRole("menuitem", { name: "Move group down" })).toBeEnabled();
      await expect(menu.getByRole("menuitem", { name: "Move group up" })).toBeDisabled();
    }
    // Close AlphaRenamed's popover before touching Beta: the open dropdown
    // overlaps Beta's header below it (see openManagePopover OVERLAP HAZARD).
    await closeManagePopover(a.page, "AlphaRenamed");

    // ── Session 2 — Beta's popover. Assert the move-down button disables at the
    //    LAST end, move Beta up, then delete Beta — all in the same popover
    //    session (the move and delete clicks do not close it; delete closes it).
    {
      const menu = await openManagePopover(a.page, "Beta");
      // Beta is LAST → Move-down disabled (onLast), Move-up enabled.
      await expect(menu.getByRole("menuitem", { name: "Move group up" })).toBeEnabled();
      await expect(menu.getByRole("menuitem", { name: "Move group down" })).toBeDisabled();
      // Move Beta up → order becomes [Beta, AlphaRenamed].
      await menu.getByRole("menuitem", { name: "Move group up" }).click();
      await expect.poll(() => groupOrder(a.page), { timeout: 8000, message: "group order to become [Beta, AlphaRenamed]" }).toEqual(["Beta", "AlphaRenamed"]);
      // Delete Beta from the SAME open popover. Wait for the move PUT to settle
      // (Delete is disabled while labelsPending), then click.
      const deleteBtn = menu.getByRole("menuitem", { name: "Delete group" });
      await expect(deleteBtn).toBeEnabled();
      await deleteBtn.click();
    }
    // Beta gone; its root (slow) returns to ungrouped; AlphaRenamed survives.
    await expect(groupToggle(a.page, "Beta")).toHaveCount(0, { timeout: 8000 });
    await expectUngrouped(a.page, "slow");
    await expect(groupToggle(a.page, "AlphaRenamed")).toBeVisible();
    await expect(inGroup(a.page, "other")).toBeVisible();
    // B converges via labels.updated: Beta gone, slow ungrouped.
    await expect(groupToggle(b.page, "Beta")).toHaveCount(0, { timeout: 8000 });
    await expectUngrouped(b.page, "slow");
  } finally {
    await a.close();
    await b.close();
  }
});

// ─── (h) group-card chrome renders (d63c757) ─────────────────────────────────
// Commit d63c757 made each labeled group a visually distinct card: the .group
// container carries a faint --label-color background tint, a 2px --label-color
// left accent rail, rounded corners, and 4px separation. --label-color is set
// INLINE on the .group element (labelColorVar) and cascades to the rail/tint.
// This spec seeds a red group via the labels API (NOT the fixture) and asserts
// the chrome actually resolves in the browser. The .group class is hashed (CSS
// Modules), so select via the stable [data-group-id] hook (precedent: (a)–(g))
// and read getComputedStyle on it. Single client — the chrome is a client-local
// render, no multi-client convergence to prove here.
//
// What the assertions distinguish from the pre-d63c757 state:
//   - --label-color: the .group module default is var(--label-gray); the inline
//     var(--label-red) override must beat it. Custom properties are not var()-
//     resolved by getComputedStyle, so the literal reference is what comes back.
//   - borderLeftWidth "2px" + a resolved rgba() borderLeftColor (color-mix at
//     45%): before the commit the container had no border (0px / transparent).
//   - a resolved rgba() backgroundColor (color-mix at 6%): before the commit
//     the surface was the unset rgba(0,0,0,0).
test("(h) a labeled group renders the d63c757 card chrome (tint + accent rail)", async ({ request, browser }) => {
  await withLabels(request, (doc) => ({
    ...doc,
    groups: [
      ...doc.groups,
      {
        id: "lg-e2e-chrome",
        name: "Chrome",
        color: "red",
        collapsed: false,
        orderedRootSessionIds: ["demo"],
      },
    ],
  }));

  const a = await openClient(browser);
  try {
    const group = a.page.locator("[data-group-id]").first();
    await expect(group).toBeVisible({ timeout: 10000 });

    // --label-color is set inline to var(--label-red) by labelColorVar and must
    // beat the module's var(--label-gray) default. Custom props are not var()-
    // resolved by getComputedStyle, so the literal reference is returned (for
    // "red" this reads "var(--label-red)"); asserting non-empty proves the inline
    // override applied, format-stable across browsers.
    await expect.poll(
      () => group.evaluate((el) => getComputedStyle(el).getPropertyValue("--label-color").trim()),
      { timeout: 5000 },
    ).not.toBe("");

    // The 2px left accent rail: width + a resolved (non-transparent) color.
    await expect.poll(
      () => group.evaluate((el) => getComputedStyle(el).borderLeftWidth),
      { timeout: 5000 },
    ).toBe("2px");
    await expect.poll(
      () => group.evaluate((el) => getComputedStyle(el).borderLeftColor),
      { timeout: 5000 },
    ).not.toBe("rgba(0, 0, 0, 0)");

    // The faint surface tint: a resolved (non-transparent) rgba().
    await expect.poll(
      () => group.evaluate((el) => getComputedStyle(el).backgroundColor),
      { timeout: 5000 },
    ).not.toBe("rgba(0, 0, 0, 0)");
  } finally {
    await a.close();
  }
});
