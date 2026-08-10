import { test, expect } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// P4 flat-tabs UX overhaul (O1) — the 7 design decisions.
//
// This suite covers the operator-reported defects + their fixes:
//  1. `+` semantics (decision #3): "Add server" label + deterministic outcome
//     (already-open / opened / added) + visible outcome text.
//  2. Stable ordering (decision #1): re-visit does NOT move the tab; LRU still
//     evicts least-recently-visited at the cap.
//  3. Title stability (decision #2): fallback → first real session title (pin);
//     later status ticks / empty titles never replace it.
//  4. Dismiss (decision #4): × removes the record only; pane/iframe survives;
//     persists across reload.
//  5. Overflow (decision #7): horizontal scroll, no Add-server overlap,
//     scrollIntoView surfaces the active tab.
//  6. No-rename (decision #6): no edit control on tabs; a pinned session title
//     survives a re-visit that carries the server label.
//  7. Honest status retained (settled): live → needs-you badge; stale → none.
//  8. Unavailable server (decision #7): close the pane → tab aria-disabled +
//     click no-op (no selectTarget, no iframe mutation).
//  9. Cross-workspace selection (decision #7): tab's pane in a hidden workspace
//     → click activates the owning ws (CSS-only) + routes + iframe survives.
//
// Runs on Chromium + Firefox + WebKit (playwright.config.ts projects). Serial.
// =============================================================================

const MOCK_ORIGIN = "http://127.0.0.1:5174";

/** Build a mock server url with distinct ?server= so each is a distinct origin
 *  view (isFleetEntry-valid, heartbeats). */
function serverUrl(server: string): string {
  const q = new URLSearchParams({ server, view: "chat" });
  return `${MOCK_ORIGIN}/?${q.toString()}`;
}

test.describe("P4 flat-tabs UX overhaul (O1)", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  // --------------------------------------------------------------------------
  // 1. `+` SEMANTICS (decision #3): label + deterministic outcome + outcome text
  // --------------------------------------------------------------------------

  test("+: trigger shows 'Add server' text; popover has heading + helper + outcome", async ({
    page,
  }) => {
    // The trigger is visible + carries the "Add server" aria-label + text.
    const btn = page.locator('[data-testid="add-server-btn"]');
    await expect(btn).toBeVisible();
    await expect(btn).toHaveAttribute("aria-label", "Add server");
    await expect(btn).toContainText("Add server");

    // Open the popover.
    await btn.click();
    const pop = page.locator('[data-testid="add-server-popover"]');
    await expect(pop).toBeVisible();
    await expect(pop).toContainText("Add a server");
    await expect(pop).toContainText("Session tabs appear after you open a session");
    await expect(page.locator('[data-testid="add-server-submit"]')).toHaveText("Add server");
  });

  test("+: existing-URL → 'Already open' + no new pane; new-URL → 'Added and opened' + one pane", async ({
    page,
  }) => {
    const url = serverUrl("ux-add-sem");
    const label = "ux-add-sem";

    // Open the popover + add a brand-new server → "Added and opened" + 1 pane.
    const before = (await H.panes(page)).length;
    await page.locator('[data-testid="add-server-btn"]').click();
    await page.locator('[data-testid="add-server-url"]').fill(url);
    await page.locator('[data-testid="add-server-label"]').fill(label);
    await page.locator('[data-testid="add-server-submit"]').click();

    await expect.poll(async () => (await H.panes(page)).length).toBe(before + 1);
    const outcome = page.locator('[data-testid="add-server-outcome"]');
    await expect(outcome).toBeVisible();
    await expect(outcome).toHaveAttribute("data-kind", "added");
    await expect(outcome).toContainText("Added and opened");

    // Submit the SAME url again → "Already open" + NO new pane (focuses existing).
    await page.locator('[data-testid="add-server-url"]').fill(url);
    await page.locator('[data-testid="add-server-label"]').fill(label);
    await page.locator('[data-testid="add-server-submit"]').click();
    await expect(outcome).toHaveAttribute("data-kind", "already-open");
    await expect(outcome).toContainText("Already open");
    // Pane count unchanged (no duplicate opened).
    await expect.poll(async () => (await H.panes(page)).length).toBe(before + 1);
  });

  test("+: catalog-known but no open pane → 'Opened'", async ({ page }) => {
    // Add a server (opens a pane + catalog entry), then close ONLY the pane
    // (closePane does NOT remove the catalog entry) → catalog-known, no pane.
    const url = serverUrl("ux-opened");
    const label = "ux-opened";
    const paneId = await H.addServer(page, url, label);
    expect(paneId, "legacy addServer opened a pane").toBeTruthy();
    await H.closePane(page, paneId!);
    await expect.poll(async () => (await H.panes(page)).some((p) => p === paneId)).toBe(false);

    // Now addServerWithOutcome(same url) → catalog-known, no pane → "opened".
    const outcome = await H.addServerWithOutcome(page, url, label);
    expect(outcome, "outcome returned").toBeTruthy();
    expect(outcome!.kind).toBe("opened");
    // A new pane opened for it.
    await expect.poll(async () => (await H.panes(page)).length).toBeGreaterThanOrEqual(2);
  });

  // --------------------------------------------------------------------------
  // 2. STABLE ORDERING (decision #1): re-visit does not move; LRU still evicts
  // --------------------------------------------------------------------------

  test("stable order: re-visit updates lastVisitedAt + active but does NOT move the tab", async ({
    page,
  }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const DIR = "/proj-stable";

    // Visit A, B, C in order → insertion order [A, B, C].
    await H.visitTarget(page, MOCK_ORIGIN, DIR, "a");
    await H.visitTarget(page, MOCK_ORIGIN, DIR, "b");
    await H.visitTarget(page, MOCK_ORIGIN, DIR, "c");
    await H.waitForTargetCount(page, 3);

    const order0 = (await H.targets(page)).map((t) => t.session);
    expect(order0, "insertion order").toEqual(["a", "b", "c"]);
    const tsA0 = (await H.targets(page)).find((t) => t.session === "a")!.lastVisitedAt;

    // Re-visit A then B. Stable order: array stays [A, B, C]; active → B.
    await page.waitForTimeout(20); // ensure lastVisitedAt tick differs
    await H.visitTarget(page, MOCK_ORIGIN, DIR, "a");
    await page.waitForTimeout(20);
    await H.visitTarget(page, MOCK_ORIGIN, DIR, "b");

    const order1 = (await H.targets(page)).map((t) => t.session);
    expect(order1, "order unchanged after re-visit").toEqual(["a", "b", "c"]);
    const at = await H.activeTarget(page);
    expect(at?.session, "active is last-revisited (b)").toBe("b");
    const tsA1 = (await H.targets(page)).find((t) => t.session === "a")!.lastVisitedAt;
    expect(tsA1, "lastVisitedAt updated on re-visit").toBeGreaterThan(tsA0);

    // DOM order mirrors the registry order.
    const domOrder = await page
      .locator('[data-testid="target-tab"]')
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.session ?? ""));
    expect(domOrder).toEqual(["a", "b", "c"]);
  });

  test("stable order: LRU still evicts least-recently-visited at the cap", async ({ page }) => {
    // Visit 21 distinct unpinned targets in order cap-0..cap-20. cap-0 has the
    // smallest lastVisitedAt (visited first, never revisited) → LRU victim.
    for (let i = 0; i < 21; i++) {
      await H.visitTarget(page, MOCK_ORIGIN, `/cap-ux-${i}`, `s-${i}`);
    }
    await H.waitForTargetCount(page, 20);
    const recs = await H.targets(page);
    expect(recs.find((r) => r.dir === "/cap-ux-0"), "LRU victim evicted").toBeUndefined();
    expect(recs.find((r) => r.dir === "/cap-ux-20"), "most-recent survives").toBeDefined();
  });

  // --------------------------------------------------------------------------
  // 3. TITLE STABILITY (decision #2): fallback → pin first session title
  // --------------------------------------------------------------------------

  test("title stability: fallback → first session title (pin); later ticks never replace it", async ({
    page,
  }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const DIR = "/proj-title";
    const SESSION = "s-title";

    // Visit with NO title → fallback (title = server host, titleSource fallback).
    await H.visitTarget(page, MOCK_ORIGIN, DIR, SESSION);
    await H.waitForTargetCount(page, 1);
    const r0 = (await H.targets(page))[0];
    expect(r0.titleSource, "starts as fallback").toBe("fallback");
    expect(r0.title, "fallback title is server host").toBe(hostOf(MOCK_ORIGIN));

    // First non-empty session title arrives → adopt + pin ("session").
    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: DIR, session: SESSION, title: "Real Title", attention: "none", activity: "idle" },
    });
    await expect.poll(async () => (await H.targets(page))[0]?.title).toBe("Real Title");
    expect((await H.targets(page))[0].titleSource, "pinned to session").toBe("session");

    // A later status tick with a DIFFERENT title does NOT replace it.
    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: DIR, session: SESSION, title: "Other Title", attention: "none", activity: "running" },
    });
    await page.waitForTimeout(100);
    expect((await H.targets(page))[0].title, "pinned title unchanged").toBe("Real Title");

    // An EMPTY status title cannot clear it.
    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: DIR, session: SESSION, title: "", attention: "none", activity: "idle" },
    });
    await page.waitForTimeout(100);
    expect((await H.targets(page))[0].title, "empty title cannot clear pin").toBe("Real Title");

    // PERSISTENCE (decision #2 completeness): the title-pin survives a cold
    // reload EVEN WHEN no other registry mutation (visit/dismiss) follows the
    // status tick. The pin branch must persist durable title+titleSource on its
    // own — otherwise the pinned session title reverts to the fallback server
    // label on reload (a violation of "never replace a session title"). Flush
    // the debounced registry save, reload, assert the pin landed on disk.
    await page.waitForTimeout(600);
    await page.reload();
    await expect.poll(async () => H.connected(page), { timeout: 20_000 }).toBe(true);
    for (const id of await H.panes(page)) await H.waitForReady(page, id);
    const after = (await H.targets(page)).find((r) => r.dir === DIR && r.session === SESSION);
    expect(after, "record survived reload").toBeDefined();
    expect(after!.title, "pinned session title survives reload").toBe("Real Title");
    expect(after!.titleSource, "titleSource stays 'session' after reload").toBe("session");
  });

  // --------------------------------------------------------------------------
  // 4. DISMISS (decision #4): × removes record only; iframe survives; persists
  // --------------------------------------------------------------------------

  test("dismiss (×): removes the record; pane/iframe survives; persists across reload", async ({
    page,
  }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const DIR = "/proj-dismiss";
    const SESSION = "s-dismiss";

    await H.selectTarget(page, pane, DIR, SESSION);
    await H.waitForTargetCount(page, 1);
    const before = (await H.survival(page, pane))!;

    // Click the × on the tab (NOT the tab body). The dismiss button carries no
    // unique data-session; scope it via the enclosing tab.
    const tab = page.locator(`[data-testid="target-tab"][data-session="${SESSION}"]`);
    await tab.locator('[data-testid="target-dismiss"]').click();

    await H.waitForTargetCount(page, 0);

    // CRUX: dismissing does NOT close the pane/session — iframe SURVIVED.
    await H.assertSurvived(page, pane, before, "dismiss does not close the pane");

    // Persist: flush the debounced registry save, reload, record still gone.
    await page.waitForTimeout(600);
    await page.reload();
    await expect.poll(async () => H.connected(page), { timeout: 20_000 }).toBe(true);
    for (const id of await H.panes(page)) await H.waitForReady(page, id);
    expect(await H.targetCount(page), "dismissed record stays gone after reload").toBe(0);
  });

  test("dismiss: clearing the active tab clears the active selection (rendered SPA stays)", async ({
    page,
  }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const DIR = "/proj-dismiss-active";
    const SESSION = "s-da";
    await H.selectTarget(page, pane, DIR, SESSION);
    await H.waitForTargetCount(page, 1);
    expect((await H.activeTarget(page))?.session).toBe(SESSION);

    await page
      .locator(`[data-testid="target-tab"][data-session="${SESSION}"] [data-testid="target-dismiss"]`)
      .click();
    await H.waitForTargetCount(page, 0);
    expect(await H.activeTarget(page), "active cleared").toBeNull();
  });

  // --------------------------------------------------------------------------
  // 5. OVERFLOW (decision #7): horizontal scroll, no Add-server overlap, scrollIntoView
  // --------------------------------------------------------------------------

  test("overflow: at phone width the strip scrolls; Add server stays visible + reachable; active tab scrolls into view", async ({
    page,
  }) => {
    // Seed enough tabs to overflow a phone-width strip.
    for (let i = 0; i < 12; i++) {
      await H.visitTarget(page, MOCK_ORIGIN, `/proj-overflow`, `s-${i}`);
    }
    await H.waitForTargetCount(page, 12);

    // Narrow viewport (phone width).
    await page.setViewportSize({ width: 375, height: 667 });

    // The tabs container scrolls horizontally (content wider than viewport).
    const tabsScroll = await page.locator('[data-testid="target-tabs"]').evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(tabsScroll.scrollWidth, "tabs overflow horizontally").toBeGreaterThan(tabsScroll.clientWidth);

    // The Add server button is visible + within the viewport (not pushed off).
    const addBtn = page.locator('[data-testid="add-server-btn"]');
    await expect(addBtn).toBeVisible();
    const box = await addBtn.boundingBox();
    expect(box, "add-server has a bounding box").toBeTruthy();
    expect(box!.x + box!.width, "add-server is within viewport").toBeLessThanOrEqual(375);

    // Click the LAST tab (offscreen right). scrollIntoView should surface it.
    const lastTab = page.locator('[data-testid="target-tab"]').last();
    await lastTab.click();
    await page.waitForTimeout(200);
    // After the select, the active tab is scrolled into view: its right edge is
    // within the viewport's horizontal extent (allow the Add-server column).
    const activeBox = await page
      .locator('[data-testid="target-tab"][data-active="1"]')
      .boundingBox();
    expect(activeBox, "active tab has a box").toBeTruthy();
    expect(activeBox!.x, "active tab left edge visible (>=0 after scrollIntoView)").toBeGreaterThanOrEqual(-1);
  });

  // --------------------------------------------------------------------------
  // 6. NO-RENAME (decision #6): no edit control; pinned title survives re-visit
  // --------------------------------------------------------------------------

  test("no-rename: no edit/input control on tabs; a pinned session title survives a re-visit carrying the server label", async ({
    page,
  }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const DIR = "/proj-norename";
    const SESSION = "s-nr";

    await H.visitTarget(page, MOCK_ORIGIN, DIR, SESSION);
    await H.waitForTargetCount(page, 1);
    // Pin a session title.
    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: DIR, session: SESSION, title: "Pinned Session", attention: "none", activity: "idle" },
    });
    await expect.poll(async () => (await H.targets(page))[0]?.title).toBe("Pinned Session");

    // No <input> / [contenteditable] inside any tab (no rename affordance).
    const tabInputs = await page
      .locator('[data-testid="target-tab"]')
      .locator('input, [contenteditable="true"]')
      .count();
    expect(tabInputs, "no edit control on tabs").toBe(0);

    // A re-visit through selectTarget passes titleFor(pane) (the server label),
    // but the pinned session title MUST survive (titleSource precedence).
    await H.selectTarget(page, pane, DIR, SESSION);
    await page.waitForTimeout(100);
    expect((await H.targets(page))[0].title, "pinned title survives re-visit").toBe("Pinned Session");
  });

  // --------------------------------------------------------------------------
  // 7. HONEST STATUS RETAINED (settled): live → badge; stale → none
  // --------------------------------------------------------------------------

  test("honest status retained: live target shows needs-you; stale shows last-known WITHOUT badge", async ({
    page,
  }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const DIR = "/proj-honest-ux";

    await H.selectTarget(page, pane, DIR, "s-live");
    await H.waitForTargetCount(page, 1);
    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: DIR, session: "s-live", title: "Live", attention: "needs_permission", activity: "idle" },
    });
    const tabLive = page.locator('[data-testid="target-tab"][data-session="s-live"]');
    await expect(tabLive).toHaveAttribute("data-live", "1");
    await expect(tabLive.locator('[data-testid="target-needs-you"]')).toHaveCount(1);

    // Navigate the pane to a different session → s-live goes stale (no badge).
    await H.selectTarget(page, pane, DIR, "s-gone");
    await H.probeStatus(page, {
      sourcePaneId: pane,
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: DIR, session: "s-gone", title: "Gone", attention: "none", activity: "idle" },
    });
    await expect.poll(async () => tabLive.getAttribute("data-live"), { timeout: 5000 }).toBe("0");
    await expect(tabLive.locator('[data-testid="target-needs-you"]')).toHaveCount(0);
  });

  // --------------------------------------------------------------------------
  // 8. UNAVAILABLE SERVER (decision #7): close pane → aria-disabled + no-op
  // --------------------------------------------------------------------------

  test("unavailable server: a tab whose server has no bound pane → aria-disabled; click is a no-op (no route change)", async ({
    page,
  }) => {
    // All seeded mock panes share MOCK_ORIGIN, so closing one can't make the
    // origin unavailable. Instead, visit a target whose serverId has NO bound
    // pane (an unbound origin) → the tab is unavailable from the start.
    const ids = await H.panes(page);
    const survivor = ids[0]; // a pane whose iframe we'll prove is untouched
    const UNBOUND = "http://127.0.0.1:9999";
    const DIR = "/proj-unavail";
    const SESSION = "s-unavail";

    await H.visitTarget(page, UNBOUND, DIR, SESSION);
    await H.waitForTargetCount(page, 1);

    const tab = page.locator(`[data-testid="target-tab"][data-session="${SESSION}"]`);
    await expect(tab).toHaveAttribute("data-available", "0");
    await expect(tab).toHaveAttribute("aria-disabled", "true");

    const before = (await H.survival(page, survivor))!;
    const routeBefore = (await H.paneParams(page)).find((p) => p.id === survivor)?.route ?? "";

    // Click the unavailable tab → NO selectTarget (no pane to route to), NO
    // iframe mutation. force:true bypasses Playwright's actionability guard
    // (aria-disabled is intentionally non-actionable) so we can prove the
    // handler itself is a no-op.
    await tab.click({ force: true });
    await page.waitForTimeout(150);

    // The survivor pane's route is unchanged + its iframe survived.
    const routeAfter = (await H.paneParams(page)).find((p) => p.id === survivor)?.route ?? "";
    expect(routeAfter, "no route changed from an unavailable-tab click").toBe(routeBefore);
    await H.assertSurvived(page, survivor, before, "unavailable-tab click did not reload a pane");
  });

  // --------------------------------------------------------------------------
  // 9. CROSS-WORKSPACE SELECTION (decision #7): hidden-ws pane → activate + route
  // --------------------------------------------------------------------------

  test("cross-workspace selection: tab's pane in a non-active workspace → click activates owning ws + routes + iframe survives", async ({
    page,
  }) => {
    // All seeded mock panes share MOCK_ORIGIN, so for ws2's pane to be the SOLE
    // binder (and thus the resolver's pick), close ws1's seeded panes first.
    const [ws1] = await H.workspaces(page);
    for (const id of await H.panes(page)) {
      await H.closePane(page, id);
    }
    await expect.poll(async () => (await H.panes(page)).length).toBe(0);

    const ws2 = await H.addWorkspace(page, "ws2");
    expect(ws2, "ws2 created").toBeTruthy();

    // Add a server in ws2 (its pane binds MOCK_ORIGIN — now the SOLE binder).
    await H.setActiveWorkspace(page, ws2!);
    const ws2Pane = await H.addServer(page, serverUrl("ux-xws"), "ux-xws");
    expect(ws2Pane, "ws2 pane opened").toBeTruthy();
    await H.waitForReady(page, ws2Pane!);

    const DIR = "/proj-xws";
    const SESSION = "s-xws";
    await H.selectTarget(page, ws2Pane!, DIR, SESSION);
    await H.waitForTargetCount(page, 1);

    // Resolve confirms the target's pane is ws2Pane in ws2.
    const resolved = await H.resolveTabTarget(page, MOCK_ORIGIN);
    expect(resolved?.paneId, "target resolves to the ws2 pane").toBe(ws2Pane);
    expect(await H.workspaceOfPane(page, ws2Pane!), "ws2Pane owns ws2").toBe(ws2);

    // Switch back to ws1 (empty; the tab's pane is in HIDDEN ws2).
    await H.setActiveWorkspace(page, ws1);
    expect(await H.activeWorkspace(page), "ws1 active").toBe(ws1);

    const before = (await H.survival(page, ws2Pane!))!;

    // Click the tab (its pane is in hidden ws2). selectTab must activate ws2
    // FIRST (CSS-only, survival-safe) then issue selectTarget.
    await page.locator(`[data-testid="target-tab"][data-session="${SESSION}"]`).click();

    // The owning workspace ws2 is now active.
    await expect.poll(async () => H.activeWorkspace(page), { timeout: 5000 }).toBe(ws2);

    // The select round-tripped: ws2Pane's route now points at the target.
    const wantRoute = `?dir=${encodeURIComponent(DIR)}&session=${SESSION}`;
    await expect
      .poll(async () => (await H.paneParams(page)).find((p) => p.id === ws2Pane)?.route ?? null)
      .toBe(wantRoute);

    // CRUX: the ws2 pane's iframe SURVIVED the cross-workspace select (CSS-only
    // workspace switch + SPA-internal route; no iframe.src change).
    await H.assertSurvived(page, ws2Pane!, before, "cross-workspace tab select");
  });
});

/** Extract the host:port from an origin (matches fallbackTitle in the registry). */
function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}
