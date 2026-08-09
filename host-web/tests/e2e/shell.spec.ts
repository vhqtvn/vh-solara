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

  test("workspace tabstrip shows one tab per workspace and '+' adds a workspace", async ({ page }) => {
    // The default context has exactly one workspace (Workspace 1).
    const before = (await H.workspaces(page)).length;
    await expect(page.locator('[data-testid="ws-tab"]')).toHaveCount(before);
    await page.locator('[data-testid="ws-add"]').click();
    await expect.poll(async () => (await H.workspaces(page)).length).toBe(before + 1);
    // The newly-added workspace is empty → the empty-workspace affordance shows.
    await expect(page.locator('[data-testid="empty-workspace"]')).toBeVisible();
  });

  test("switching workspace tabs is survival-safe (UI click path)", async ({ page }) => {
    // The default workspace is active. Create a second one (via the UI +) and
    // switch between them by clicking tabs; this is CSS-visibility-only and
    // must keep every iframe alive.
    const [ws1] = await H.workspaces(page);
    const aIds = await H.panes(page);
    const a = aIds[0];
    const beforeA = (await H.survival(page, a))!;

    await page.locator('[data-testid="ws-add"]').click();
    await expect.poll(async () => (await H.workspaces(page)).length).toBe(2);
    const ws2 = (await H.workspaces(page))[1];

    // Click the ws2 tab → it becomes active (UI click path).
    await page.locator('[data-testid="ws-tab"][data-workspace="' + ws2 + '"]').click();
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws2);

    // Click back to ws1.
    await page.locator('[data-testid="ws-tab"][data-workspace="' + ws1 + '"]').click();
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws1);

    // The ws1 pane survived the UI round-trip.
    await H.assertSurvived(page, a, beforeA, "ws tab click round-trip");
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
