import { test, expect } from "@playwright/test";
import * as H from "./util";

// Shell wiring: drives the REAL UI (buttons, tabs, tray chip, statusbar) — not
// the bridge — to prove the host chrome is wired end-to-end. Survival is
// covered by survival.spec.ts; this covers the affordances a human would use.
// Chromium only (Firefox runs survival.spec.ts; this is chrome-only UI smoke).

test.describe("host shell UI wiring", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  test("statusbar reports connection + servers + renderer", async ({ page }) => {
    const bar = page.locator('[data-testid="statusbar"]');
    await expect(bar).toContainText("connected");
    await expect(bar).toContainText("servers");
    await expect(bar).toContainText("dockview · renderer:always");
  });

  test("tabstrip shows one tab per pane and '+' adds a pane", async ({ page }) => {
    const before = (await H.panes(page)).length;
    await expect(page.locator('[data-testid="ws-tab"]')).toHaveCount(before);
    await page.locator('[data-testid="ws-add"]').click();
    await expect.poll(async () => (await H.panes(page)).length).toBe(before + 1);
  });

  test("pane header 'Split →' adds a pane", async ({ page }) => {
    const before = (await H.panes(page)).length;
    await page.locator('[data-testid="pane-split-right"]').first().click();
    await expect.poll(async () => (await H.panes(page)).length).toBe(before + 1);
  });

  test("pane header close removes a pane", async ({ page }) => {
    const before = (await H.panes(page)).length;
    await page.locator('[data-testid="pane-close"]').first().click();
    await expect.poll(async () => (await H.panes(page)).length).toBe(before - 1);
  });

  test("collapse parks a pane in the tray chip rail; chip restores it", async ({ page }) => {
    const ids = await H.panes(page);
    const first = ids[0];
    await page.locator(`[data-pane-id="${first}"] [data-testid="pane-collapse"]`).click();
    // a tray chip appears
    const chip = page.locator('[data-testid="tray-chip"]');
    await expect(chip).toHaveCount(1);
    await expect.poll(async () => (await H.trayIds(page))).toContainEqual(first);
    // restore via the chip
    await chip.click();
    await expect.poll(async () => (await H.trayIds(page)).includes(first)).toBe(false);
    await expect(page.locator('[data-testid="tray-chip"]')).toHaveCount(0);
  });

  test("zoom toggles the maximized badge in the statusbar", async ({ page }) => {
    await page.locator('[data-testid="pane-zoom"]').first().click();
    await expect.poll(async () => H.isMaximized(page)).toBe(true);
    await expect(page.locator('[data-testid="statusbar"]')).toContainText("maximized");
    await page.locator('[data-testid="pane-zoom"]').first().click();
    await expect.poll(async () => H.isMaximized(page)).toBe(false);
  });

  test("clicking a top tab focuses that pane", async ({ page }) => {
    const ids = await H.panes(page);
    await page.locator('[data-testid="ws-tab"]').nth(1).click();
    await expect.poll(async () => H.focused(page)).toBe(ids[1]);
  });

  test("can't collapse the last remaining pane via the UI", async ({ page }) => {
    const ids = await H.panes(page);
    for (let i = 1; i < ids.length; i++) {
      await page.locator('[data-testid="pane-close"]').first().click();
    }
    await expect.poll(async () => H.gridPaneCount(page)).toBe(1);
    // The Collapse affordance is DISABLED (the guard): Playwright refuses to
    // click a disabled button, so we assert the disabled state directly.
    const collapseBtn = page.locator('[data-testid="pane-collapse"]').first();
    await expect(collapseBtn).toBeDisabled();
    await expect(page.locator('[data-testid="tray-chip"]')).toHaveCount(0);
  });
});
