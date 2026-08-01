import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { projectUrl, resetLabels, resetPins } from "./util";

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
  const csrf = { "X-VH-CSRF": "1" };
  for (let attempt = 0; attempt < 3; attempt++) {
    const cur = await request.get("/vh/labels");
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
