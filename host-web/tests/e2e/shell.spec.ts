import { test, expect } from "@playwright/test";
import * as H from "./util";

// Shell wiring: drives the REAL UI (buttons, workspace tabs, tray chip,
// statusbar) — not the bridge — to prove the host chrome is wired end-to-end.
// Survival is covered by survival.spec.ts; this covers the affordances a human
// would use. Chromium only (Firefox runs survival.spec.ts; this is chrome-only
// UI smoke).

test.describe("host shell UI wiring", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  test("statusbar reports liveness + servers + renderer", async ({ page }) => {
    const bar = page.locator('[data-testid="statusbar"]');
    // Q1-C: the statusbar shows the focused pane's DOCUMENT liveness ("document
    // alive" when heartbeats are flowing), never realtime/SSE wording.
    await expect(bar).toContainText("document alive");
    await expect(bar).toContainText("servers");
    await expect(bar).toContainText("dockview · renderer:always");
  });

  // P4: the workspace tabstrip was REPLACED by the flat target tabstrip. The
  // ws-tab/ws-add/delete/rename affordances are GONE from the primary nav
  // (workspaces stay internal — the overlay stack is untouched). The flat-tab
  // visit/select/survival behavior is covered by target-tabs.spec.ts; this
  // suite keeps covering the pane-level shell chrome (split/close/tray/zoom/
  // focus/statusbar) which is unchanged.

  test("flat tabstrip has no workspace chrome (ws-tab/ws-add absent)", async ({ page }) => {
    // The workspace tabs + the add-workspace "+" were removed from the primary
    // tabstrip (P4). The brand + AddServer remain.
    await expect(page.locator('[data-testid="ws-tab"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="ws-add"]')).toHaveCount(0);
  });

  test("pane header 'Split →' adds a pane to the active workspace", async ({ page }) => {
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
    await expect.poll(async () => H.trayIds(page)).toContainEqual(first);
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

  test("focusing a pane via its header updates the statusbar focus line", async ({ page }) => {
    const ids = await H.panes(page);
    // Focus pane b via the bridge (the top tabstrip is workspace-scoped now;
    // within-workspace focus is exercised by clicking a pane's header area).
    await H.focusPane(page, ids[1]);
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
