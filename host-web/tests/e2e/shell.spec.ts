import { test, expect } from "@playwright/test";
import * as H from "./util";

// Shell wiring: drives the REAL UI (workspace tabs, statusbar control cluster,
// tray chip) — not the bridge — to prove the host chrome is wired end-to-end.
// Survival is covered by survival.spec.ts; this covers the affordances a human
// would use. Chromium only (Firefox runs survival.spec.ts; this is chrome-only
// UI smoke).
//
// Phase 1 (i3 host-shell): the per-pane header was REMOVED (panes are content +
// focus-border only). Split/close/zoom/mode-switch are driven from the statusbar
// control cluster (the touch fallback) or the keyboard (i3Keyboard.ts). The top
// tabstrip is the WORKSPACE tabstrip again (ws-tab/ws-add present).

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

  // Phase 1: the workspace tabstrip is RESTORED (P4 pane-tabs reverted). The
  // brand + one ws-tab per workspace + the add-workspace "+" are present in the
  // primary nav. Workspace switching + add/delete/rename/needs-you are covered
  // by workspace-tabs.spec.ts; here we only assert the chrome is present.
  test("workspace tabstrip is present (ws-tab/ws-add visible)", async ({ page }) => {
    const wsTabs = page.locator('[data-testid="ws-tab"]');
    await expect(wsTabs).toHaveCount(1); // the seeded default workspace
    await expect(page.locator('[data-testid="ws-add"]')).toHaveCount(1);
  });

  test("statusbar control cluster split adds a pane to the active workspace", async ({ page }) => {
    const before = (await H.panes(page)).length;
    await page.locator('[data-testid="i3-split-h"]').click();
    await expect.poll(async () => (await H.panes(page)).length).toBe(before + 1);
  });

  test("statusbar control cluster close removes the focused pane", async ({ page }) => {
    const before = (await H.panes(page)).length;
    await page.locator('[data-testid="i3-close"]').click();
    await expect.poll(async () => (await H.panes(page)).length).toBe(before - 1);
  });

  test("collapse (bridge) parks a pane in the tray chip rail; chip restores it", async ({ page }) => {
    // Phase 1 does not surface collapse-to-tray in the chrome (no per-pane
    // header, no statusbar collapse button). The tray rail + restore chip still
    // exist for a cold-restored tray; drive collapse via the DEV bridge to prove
    // the tray-chip restore wiring still works.
    const ids = await H.panes(page);
    const first = ids[0];
    await H.collapse(page, first);
    // a tray chip appears
    const chip = page.locator('[data-testid="tray-chip"]');
    await expect(chip).toHaveCount(1);
    await expect.poll(async () => H.trayIds(page)).toContainEqual(first);
    // restore via the chip
    await chip.click();
    await expect.poll(async () => (await H.trayIds(page)).includes(first)).toBe(false);
    await expect(page.locator('[data-testid="tray-chip"]')).toHaveCount(0);
  });

  test("zoom (statusbar cluster) toggles the maximized badge", async ({ page }) => {
    await page.locator('[data-testid="i3-zoom"]').click();
    await expect.poll(async () => H.isMaximized(page)).toBe(true);
    await expect(page.locator('[data-testid="statusbar"]')).toContainText("maximized");
    await page.locator('[data-testid="i3-zoom"]').click();
    await expect.poll(async () => H.isMaximized(page)).toBe(false);
  });

  test("focusing a pane updates the statusbar focus line", async ({ page }) => {
    const ids = await H.panes(page);
    // Focus pane 1 via the bridge; the statusbar "focus: <label>" line updates.
    const params = await H.paneParams(page);
    const label1 = params.find((p) => p.id === ids[1])?.label ?? "";
    await H.focusPane(page, ids[1]);
    await expect.poll(async () => H.focused(page)).toBe(ids[1]);
    await expect(page.locator('[data-testid="statusbar"]')).toContainText(`focus: ${label1}`);
  });
});
