import { test, expect } from "@playwright/test";
import * as H from "./util";

/**
 * Pane-tabs e2e (tabs = panes = windows model).
 *
 * Replaces the session-tab tests (target-tabs.spec.ts + target-tabs-ux.spec.ts)
 * which were deleted when the targetRegistry layer was removed. Each test
 * verifies one operator-facing feature of the reframe.
 *
 * The suite is serial (host-web playwright.config.ts: workers:1). Each test
 * calls loadHost in beforeEach for a fresh page + seeded panes.
 */

// The mock content page origin (same as session-attention.spec.ts). The mock
// content server runs on :5174 cross-origin from the host dev server (:5173).
const MOCK_ORIGIN = "http://127.0.0.1:5174";

test.describe("pane-tabs (tabs = panes = windows)", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  // Feature 1: Tab title = label (NOT session title)
  test("tab title is the pane label, not a session title", async ({ page }) => {
    const params = await H.paneParams(page);
    expect(params.length).toBeGreaterThanOrEqual(2);

    const tabs = page.locator('[data-testid="pane-tab"]');
    const count = await tabs.count();
    expect(count, "one tab per pane").toBe(params.length);

    // Each tab's data-label matches its pane's label
    for (const param of params) {
      const label = await page
        .locator(`[data-testid="pane-tab"][data-tab-pane-id="${param.id}"]`)
        .getAttribute("data-label");
      expect(label, `tab label for ${param.id}`).toBe(param.label);
    }
  });

  // Feature 6: No session-title in the tab (even after a status with a title)
  test("session title does NOT appear in any tab", async ({ page }) => {
    const ids = await H.panes(page);
    const params = await H.paneParams(page);
    const pane0 = ids[0];
    const originalLabel = params.find((p) => p.id === pane0)!.label;

    // Inject a status with a long session title that would have appeared in the
    // OLD session-tab model. In the new model it must NOT touch the tab.
    await H.probeStatus(page, {
      sourcePaneId: pane0,
      origin: MOCK_ORIGIN,
      payload: {
        type: "status",
        dir: "/proj",
        session: "sess-1",
        title: "ZZZ_SESSION_TITLE_THAT_MUST_NOT_APPEAR_ZZZ",
        attention: "none",
        activity: "idle",
      },
    });
    await page.waitForTimeout(300);

    // The tab label is STILL the pane label
    const tabLabel = await page
      .locator(`[data-testid="pane-tab"][data-tab-pane-id="${pane0}"]`)
      .getAttribute("data-label");
    expect(tabLabel).toBe(originalLabel);

    // The session title appears nowhere in the tabstrip
    const stripText = await page.locator('[data-testid="pane-tabs"]').textContent();
    expect(stripText).not.toContain("ZZZ_SESSION_TITLE_THAT_MUST_NOT_APPEAR_ZZZ");
  });

  // Feature 2: Close tab = dispose the pane (iframe gone; tab gone; others survive)
  test("close tab disposes the pane; other panes survive", async ({ page }) => {
    const ids = await H.panes(page);
    expect(ids.length, "≥2 seeded panes").toBeGreaterThanOrEqual(2);

    const keepId = ids[0];
    const closeId = ids[1];

    const beforeKeep = await H.survival(page, keepId);
    expect(beforeKeep).not.toBeNull();

    // Click the × on the second tab
    await page
      .locator(
        `[data-testid="pane-tab"][data-tab-pane-id="${closeId}"] [data-testid="pane-close"]`,
      )
      .click();

    // The closed pane is gone; the kept pane remains
    await expect.poll(async () => {
      return (await H.panes(page)).includes(closeId);
    }).toBe(false);

    const remaining = await H.panes(page);
    expect(remaining).toContain(keepId);
    expect(remaining).not.toContain(closeId);

    // The tab for the closed pane is gone from the DOM
    const closedTabGone = await page
      .locator(`[data-testid="pane-tab"][data-tab-pane-id="${closeId}"]`)
      .count();
    expect(closedTabGone).toBe(0);

    // The surviving pane's iframe SURVIVED (identity unchanged)
    await H.assertSurvived(page, keepId, beforeKeep!, "kept pane after close-other");
  });

  // Feature 2b: Closing all panes shows the empty state (last-pane guard = allow)
  test("closing all panes shows the empty state", async ({ page }) => {
    const ids = await H.panes(page);
    for (const id of ids) {
      await H.closePane(page, id);
    }
    await expect.poll(async () => (await H.panes(page)).length).toBe(0);
    await expect(page.locator('[data-testid="pane-tabs-empty"]')).toBeVisible();
  });

  // Feature 3: Add tab = new pane; AddServer prefills active pane URL
  test("AddServer prefills the active pane's URL", async ({ page }) => {
    const activeId = await H.focused(page);
    const params = await H.paneParams(page);
    const activePane = params.find((p) => p.id === activeId) ?? params[0];
    expect(activePane).toBeTruthy();

    // Open the AddServer popover
    await page.locator('[data-testid="add-server-btn"]').click();
    await expect(page.locator('[data-testid="add-server-popover"]')).toBeVisible();

    // The URL field is prefilled with the active pane's URL
    const urlValue = await page.locator('[data-testid="add-server-url"]').inputValue();
    expect(urlValue).toBe(activePane!.url);
  });

  // Feature 4: Select tab = activate pane (survival-safe)
  test("selecting a tab activates its pane (survival-safe)", async ({ page }) => {
    const ids = await H.panes(page);
    expect(ids.length).toBeGreaterThanOrEqual(2);

    // Focus pane 0 first
    await H.focusPane(page, ids[0]);
    await expect.poll(async () => H.focused(page)).toBe(ids[0]);

    const before1 = await H.survival(page, ids[1]);
    expect(before1).not.toBeNull();

    // Click the tab for pane 1
    await page.locator(`[data-testid="pane-tab"][data-tab-pane-id="${ids[1]}"]`).click();

    // Pane 1 is now focused
    await expect.poll(async () => H.focused(page)).toBe(ids[1]);

    // The tab is marked active
    const activeAttr = await page
      .locator(`[data-testid="pane-tab"][data-tab-pane-id="${ids[1]}"]`)
      .getAttribute("data-active");
    expect(activeAttr).toBe("1");

    // The iframe SURVIVED the tab select (no reload)
    await H.assertSurvived(page, ids[1], before1!, "pane 1 after tab select");
  });

  // Feature 5: Needs-you badge per tab (P1 status bridge, per-pane)
  test("needs-you badge shows for a pane with needs_reply", async ({ page }) => {
    const ids = await H.panes(page);
    const pane0 = ids[0];

    // Initially no needs-you badges
    expect(await page.locator('[data-testid="pane-needs-you"]').count()).toBe(0);

    // Inject a needs_reply status for pane 0
    const r = await H.probeStatus(page, {
      sourcePaneId: pane0,
      origin: MOCK_ORIGIN,
      payload: {
        type: "status",
        dir: "/proj",
        session: "sess-1",
        title: "Needs Reply Session",
        attention: "needs_reply",
        activity: "idle",
      },
    });
    expect(r.accepted, "status message accepted").toBe(true);

    // The aggregate needs-you count reflects it (status landed in statusByPane)
    await expect.poll(async () => H.needsYou(page), { timeout: 8000 }).toBe(1);

    // The needs-you badge appears on pane 0's tab (panes signal carries status)
    await expect.poll(async () => {
      return page
        .locator(
          `[data-testid="pane-tab"][data-tab-pane-id="${pane0}"] [data-testid="pane-needs-you"]`,
        )
        .count();
    }, { timeout: 8000 }).toBe(1);
  });

  // Feature: Rename via bridge (survival-safe + persists in params)
  test("rename mutates the label (survival-safe, persists)", async ({ page }) => {
    const ids = await H.panes(page);
    const pane0 = ids[0];
    const before = await H.survival(page, pane0);
    expect(before).not.toBeNull();

    // Rename via the production HostOps path
    await H.renamePane(page, pane0, "renamed-via-bridge");

    // The label changed in pane params
    await expect.poll(async () => {
      const params = await H.paneParams(page);
      return params.find((p) => p.id === pane0)?.label;
    }).toBe("renamed-via-bridge");

    // The tab data-label updated
    await expect.poll(async () =>
      page
        .locator(`[data-testid="pane-tab"][data-tab-pane-id="${pane0}"]`)
        .getAttribute("data-label"),
    ).toBe("renamed-via-bridge");

    // The iframe SURVIVED the rename (no reload)
    await H.assertSurvived(page, pane0, before!, "pane after rename");
  });

  // Feature: Rename via double-click inline edit (UI path)
  test("double-click tab opens inline rename; Enter commits", async ({ page }) => {
    const ids = await H.panes(page);
    const pane0 = ids[0];
    const params = await H.paneParams(page);
    const originalLabel = params.find((p) => p.id === pane0)!.label;

    // Double-click the tab to enter rename mode
    await page.locator(`[data-testid="pane-tab"][data-tab-pane-id="${pane0}"]`).dblclick();

    // The rename input appears with the current label
    const input = page.locator('[data-testid="pane-rename-input"]');
    await expect(input).toBeVisible();
    expect(await input.inputValue()).toBe(originalLabel);

    // Type a new name + press Enter to commit
    await input.fill("renamed-via-ui");
    await input.press("Enter");

    // The label changed
    await expect.poll(async () =>
      page
        .locator(`[data-testid="pane-tab"][data-tab-pane-id="${pane0}"]`)
        .getAttribute("data-label"),
    ).toBe("renamed-via-ui");
  });

  // Feature: Rename via Escape cancels (label unchanged)
  test("Escape in rename input cancels (label unchanged)", async ({ page }) => {
    const ids = await H.panes(page);
    const pane0 = ids[0];
    const params = await H.paneParams(page);
    const originalLabel = params.find((p) => p.id === pane0)!.label;

    await page.locator(`[data-testid="pane-tab"][data-tab-pane-id="${pane0}"]`).dblclick();
    const input = page.locator('[data-testid="pane-rename-input"]');
    await expect(input).toBeVisible();

    await input.fill("should-not-persist");
    await input.press("Escape");

    // The input is gone; the label is unchanged
    await expect(input).not.toBeVisible();
    await expect.poll(async () =>
      page
        .locator(`[data-testid="pane-tab"][data-tab-pane-id="${pane0}"]`)
        .getAttribute("data-label"),
    ).toBe(originalLabel);
  });
});
