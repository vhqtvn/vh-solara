import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { projectUrl, resetPins } from "./util";

// Phase 7 — server-managed pinned sessions: multi-client convergence.
//
// Pins are now WORKER-OWNED durable state (Phase 4+: /vh/pins doc + SSE
// pins.snapshot/pins.updated). The defining property of server-managed state is
// that TWO browsers viewing the same worker CONVERGE: a pin/unpin/reorder in one
// reaches the other through the server, and lifecycle cleanup (archive/delete)
// removes the pin from EVERY viewer. These specs prove that end-to-end through
// real browsers against the real fixtureserver (real web.NewServer + aggregator
// + fake OpenCode, same binary `npm run test:e2e` boots via scripts/fixture-web.sh).
//
// SCENARIO → LANE MAP (honest deterministic coverage, not "force everything into
// Playwright"):
//   (a) pin in A → appears in B .................... Playwright (here)
//   (b) unpin in A → removed in B .................. Playwright (here)
//   (c) reorder in A → order syncs to B ............ Playwright (here, keyboard)
//   (d) conflicting reorder → 409 adoption ......... NOT here. A true concurrent
//        conflict is inherently racy in a browser (the UI reads the live revision
//        at click time, so two real clients almost never collide on the same
//        baseRevision). The CONTRACT is covered deterministically elsewhere:
//          - server CAS: pkg/web TestPinsHTTPPut409CASMismatch (409 returns the
//            full current doc, does NOT mutate).
//          - client adoption: web/tests/unit/sidebar-pins.test.ts ("on 409
//            discards optimistic, does NOT auto-replay"; "stale reorder NOT
//            silently replayed — adopts server doc verbatim").
//   (e) archive a pinned session → both remove .... Playwright (here, single
//        disposable session cross-client broadcast). The SUBTREE-cascade
//        mechanics (affected[] fan-out) are covered deterministically by
//        pkg/web TestPinsL1_ArchiveCascadesSubtree + TestPinsL1_ArchiveBroadcastsUpdate.
//   (f) delete a pinned session → both remove ..... Playwright (here, disposable
//        session). L2 subscriber mechanics: pkg/web TestPinsL2_SessionDeleteRemovesPin
//        / TestPinsL2_RawSessionDeletedRemovesPin / TestPinsL2_SubscriberBroadcastsUpdate.
//   (g) disconnect/reconnect → surviving pins persist  Playwright (here; reload
//        B and assert the pins.snapshot bootstrap restores the surviving pins).
//
// TEST HYGIENE: the suite is SERIAL (workers:1) over ONE shared fixtureserver
// process, so server-side pin state leaks across specs. beforeEach/afterEach
// reset the pin doc via the real /vh/pins API (resetPins) so this spec neither
// inherits nor leaks pinned state. (e)/(f) use DISPOSABLE sessions created via
// POST /oc/session — archive/delete are destructive and permanent (the fixture
// has no un-archive-for-test path), so the seeded demo/other/slow/sub sessions
// are never archived or deleted.

// Wait for the tree to populate. Unlike tree2-parity's waitForTreeSettled this
// does NOT gate on `.tree-twisty.running` count 0: in a full serial-suite run a
// PRIOR spec (e.g. layout.spec's "Working… indicator" stream test) can leave a
// session genuinely busy, and gating on global idle would couple these pin
// tests to every other spec's session state. Pin/unpin/reorder and the pinned
// group render are independent of any session's busy state, so waiting for the
// first tree row is sufficient and deterministic.
async function waitForTreeSettled(page: Page): Promise<void> {
  await expect(page.locator(".tree-row").first()).toBeVisible({ timeout: 15000 });
}

// openClient loads a fresh browser CONTEXT (a distinct client — its own SSE
// /vh/stream connection, its own Solid state) and waits for the tree to settle.
// Manually-created contexts are NOT auto-closed by Playwright; callers MUST close
// the returned handle in a finally block (a leaked context keeps a /vh/stream
// open and can perturb later broadcast assertions).
async function openClient(browser: Browser): Promise<{ page: Page; close: () => Promise<void> }> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(projectUrl("/"));
  await waitForTreeSettled(page);
  return { page, close: () => ctx.close() };
}

// Right-click an UNPINNED session (in the tree body) and choose "Pin to top".
// Waits for the pin to land in THIS client's .tree-pinned group (the local
// optimistic + confirm signal) before returning.
async function pinViaMenu(page: Page, sessionId: string): Promise<void> {
  const node = page.locator(`.tree-node[data-session-id="${sessionId}"]`).first();
  await node.click({ button: "right" });
  await expect(page.locator(".ctxm-menu")).toBeVisible();
  await page.locator(".ctxm-item", { hasText: "Pin to top" }).click();
  await expect(
    page.locator(`.tree-pinned .tree-node[data-session-id="${sessionId}"]`)
  ).toBeVisible({ timeout: 5000 });
}

// Right-click a PINNED session (in the pinned group) and choose "Unpin". Waits
// for the pin to leave THIS client's .tree-pinned group.
async function unpinViaMenu(page: Page, sessionId: string): Promise<void> {
  const node = page.locator(`.tree-pinned .tree-node[data-session-id="${sessionId}"]`).first();
  await node.click({ button: "right" });
  await expect(page.locator(".ctxm-menu")).toBeVisible();
  await page.locator(".ctxm-item", { hasText: "Unpin" }).click();
  await expect(
    page.locator(`.tree-pinned .tree-node[data-session-id="${sessionId}"]`)
  ).toHaveCount(0, { timeout: 5000 });
}

// pinnedOrder returns the ordered list of pinned session ids as rendered in the
// DOM (.tree-pinned children in document order). This is the observable shape of
// the server's orderedSessionIds after reconcile + render.
async function pinnedOrder(page: Page): Promise<string[]> {
  return page.locator(`.tree-pinned .tree-node`).evaluateAll((nodes) =>
    nodes.map((n) => (n as HTMLElement).dataset.sessionId ?? "")
  );
}

// createDisposableSession creates a fresh never-opened root session via the raw
// /oc/session passthrough (the fake OpenCode's /session handler). Used by (e)/(f)
// so the destructive archive/delete never touches a seeded session. Emits a
// session.upsert that both browsers render in their trees.
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

test.beforeEach(async ({ request }) => {
  await resetPins(request);
});
test.afterEach(async ({ request }) => {
  await resetPins(request);
});

// ─── (a) pin in A → appears in B ─────────────────────────────────────────────
test("(a) pinning a session in client A appears in client B", async ({ browser }) => {
  const a = await openClient(browser);
  const b = await openClient(browser);
  try {
    // Sanity: `other` is unpinned in both before the action.
    await expect(a.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`)).toHaveCount(0);
    await expect(b.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`)).toHaveCount(0);

    await pinViaMenu(a.page, "other");

    // B converges via pins.updated SSE: the pin hoists `other` into B's
    // .tree-pinned group too.
    await expect(
      b.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`)
    ).toBeVisible({ timeout: 8000 });
  } finally {
    await a.close();
    await b.close();
  }
});

// ─── (b) unpin in A → removed in B ───────────────────────────────────────────
test("(b) unpinning a session in client A removes it in client B", async ({ browser }) => {
  const a = await openClient(browser);
  const b = await openClient(browser);
  try {
    // Establish the shared pin first (A pins, B converges).
    await pinViaMenu(a.page, "other");
    await expect(
      b.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`)
    ).toBeVisible({ timeout: 8000 });

    // A unpins; B must follow.
    await unpinViaMenu(a.page, "other");

    await expect(
      b.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`)
    ).toHaveCount(0, { timeout: 8000 });
  } finally {
    await a.close();
    await b.close();
  }
});

// ─── (c) reorder in A → order syncs to B ─────────────────────────────────────
test("(c) reordering pinned sessions in A syncs the new order to B", async ({ browser }) => {
  const a = await openClient(browser);
  const b = await openClient(browser);
  try {
    // Pin two ROOTS (Move up/down are gated to pinned roots only). Insertion
    // order → server orderedSessionIds = [demo, other].
    await pinViaMenu(a.page, "demo");
    await pinViaMenu(a.page, "other");

    // Both clients converge to [demo, other].
    await expect.poll(async () => await pinnedOrder(a.page), { timeout: 8000 }).toEqual(["demo", "other"]);
    await expect.poll(async () => await pinnedOrder(b.page), { timeout: 8000 }).toEqual(["demo", "other"]);

    // Reorder in A: right-click `other` (currently last) → "Move up". This fires
    // movePinnedByOffset(other, -1) → server reorders to [other, demo].
    const otherPinned = a.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`).first();
    await otherPinned.click({ button: "right" });
    await expect(a.page.locator(".ctxm-menu")).toBeVisible();
    await a.page.locator(".ctxm-item", { hasText: "Move up" }).click();

    // A adopts its own successful reorder...
    await expect.poll(async () => await pinnedOrder(a.page), { timeout: 8000 }).toEqual(["other", "demo"]);
    // ...and B converges to the SAME server order via pins.updated.
    await expect.poll(async () => await pinnedOrder(b.page), { timeout: 8000 }).toEqual(["other", "demo"]);
  } finally {
    await a.close();
    await b.close();
  }
});

// ─── (e) archive a pinned session → both clients remove it ───────────────────
test("(e) archiving a pinned disposable session removes it in both clients", async ({ request, browser }) => {
  const id = await createDisposableSession(request);
  const a = await openClient(browser);
  const b = await openClient(browser);
  try {
    // The new session fans out via session.upsert; wait for it in both trees.
    await expect(a.page.locator(`.tree-node[data-session-id="${id}"]`)).toBeVisible({ timeout: 10000 });
    await expect(b.page.locator(`.tree-node[data-session-id="${id}"]`)).toBeVisible({ timeout: 10000 });

    // Pin it in A; B converges.
    await pinViaMenu(a.page, id);
    await expect(
      b.page.locator(`.tree-pinned .tree-node[data-session-id="${id}"]`)
    ).toBeVisible({ timeout: 8000 });

    // Archive via the real /vh/archive path (the L1 cleanup hook runs on its
    // success). The response returns before the async cascade completes, so we
    // poll for the broadcast below.
    const res = await request.post("/vh/archive", {
      headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
      data: { sessionID: id },
    });
    expect(res.ok()).toBe(true);

    // The L1 archive hook (removePinsAndBroadcast) fans out pins.updated → the
    // pin is removed from BOTH clients. (Subtree-cascade mechanics for a parent
    // with descendants are covered deterministically by pkg/web
    // TestPinsL1_ArchiveCascadesSubtree; this is the single-session cross-client
    // broadcast slice.)
    await expect(
      a.page.locator(`.tree-pinned .tree-node[data-session-id="${id}"]`)
    ).toHaveCount(0, { timeout: 10000 });
    await expect(
      b.page.locator(`.tree-pinned .tree-node[data-session-id="${id}"]`)
    ).toHaveCount(0, { timeout: 10000 });
  } finally {
    await a.close();
    await b.close();
  }
});

// ─── (f) delete a pinned session → both clients remove it ────────────────────
test("(f) deleting a pinned disposable session removes it in both clients", async ({ request, browser }) => {
  const id = await createDisposableSession(request);
  const a = await openClient(browser);
  const b = await openClient(browser);
  try {
    await expect(a.page.locator(`.tree-node[data-session-id="${id}"]`)).toBeVisible({ timeout: 10000 });
    await expect(b.page.locator(`.tree-node[data-session-id="${id}"]`)).toBeVisible({ timeout: 10000 });

    await pinViaMenu(a.page, id);
    await expect(
      b.page.locator(`.tree-pinned .tree-node[data-session-id="${id}"]`)
    ).toBeVisible({ timeout: 8000 });

    // Delete via the fake OpenCode's /fixture/delete, reached through the web
    // server's /oc/ passthrough (NOT the bare /fixture/delete form, which hits
    // the static handler and silently no-ops). The fake emits session.deleted →
    // the aggregator → the L2 subscriber → removePinsAndBroadcast → pins.updated.
    const res = await request.post(`/oc/fixture/delete?session=${encodeURIComponent(id)}`, {
      headers: { "X-VH-CSRF": "1" },
    });
    expect(res.ok()).toBe(true);

    // L2 cleanup broadcasts to BOTH clients.
    await expect(
      a.page.locator(`.tree-pinned .tree-node[data-session-id="${id}"]`)
    ).toHaveCount(0, { timeout: 10000 });
    await expect(
      b.page.locator(`.tree-pinned .tree-node[data-session-id="${id}"]`)
    ).toHaveCount(0, { timeout: 10000 });
  } finally {
    await a.close();
    await b.close();
  }
});

// ─── (g) disconnect/reconnect → surviving pins persist ───────────────────────
test("(g) a reconnecting client receives surviving pins via the bootstrap snapshot", async ({ browser }) => {
  // Load B FIRST (clean — beforeEach reset left no pins), then pin in A while B
  // is connected, then RELOAD B (tearing down + re-establishing its /vh/stream)
  // and assert B re-acquires the pin via the pins.snapshot bootstrap frame, not
  // via retained DOM. This is the reconnect-catches-up guarantee: pins are
  // server-owned, so a client that drops and reconnects is never permanently out
  // of sync.
  const a = await openClient(browser);
  const b = await openClient(browser);
  try {
    await expect(b.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`)).toHaveCount(0);

    await pinViaMenu(a.page, "other");
    // B (still connected) sees the live update.
    await expect(
      b.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`)
    ).toBeVisible({ timeout: 8000 });

    // Reconnect B: reload tears down its SSE stream + Solid state; on reconnect
    // the server emits pins.snapshot as the bootstrap frame, which restores the
    // surviving pin.
    await b.page.reload();
    await waitForTreeSettled(b.page);
    await expect(
      b.page.locator(`.tree-pinned .tree-node[data-session-id="other"]`)
    ).toBeVisible({ timeout: 10000 });
  } finally {
    await a.close();
    await b.close();
  }
});
