import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as H from "./util";

/**
 * Workspace-tabs e2e (Phase 1 i3 host-shell: the top tabstrip shows WORKSPACES).
 *
 * Replaces the P4 pane-tabs.spec.ts (the pane-tab model was reverted). Each test
 * verifies one operator-facing feature of the restored workspace tabstrip:
 * presence, switch (survival-safe), add, delete (two-step confirm), rename
 * (long-press), and the per-tab needs-you badge.
 *
 * The suite is serial (host-web playwright.config.ts: workers:1). Each test
 * calls loadHost in beforeEach for a fresh page + the seeded default workspace.
 */

const REPO_ROOT = path.resolve(process.cwd(), "..");
const VISION_DIR = path.join(REPO_ROOT, "tmp/host-web-playwright/vision/i3");

test.beforeAll(() => {
  fs.mkdirSync(VISION_DIR, { recursive: true });
});

test.describe("workspace-tabs (top tabstrip = workspaces)", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  // Feature: the tabstrip renders one ws-tab per workspace + a ws-add button.
  test("tabstrip shows one ws-tab per workspace + ws-add", async ({ page }) => {
    const wsIds = await H.workspaces(page);
    expect(wsIds.length, "at least one seeded workspace").toBeGreaterThanOrEqual(1);

    const tabs = page.locator('[data-testid="ws-tab"]');
    await expect(tabs).toHaveCount(wsIds.length);
    await expect(page.locator('[data-testid="ws-add"]')).toHaveCount(1);

    await page.screenshot({ path: path.join(VISION_DIR, "01-workspace-tabs.png"), fullPage: true });
  });

  // Feature: a11y tab semantics — the container is a tablist; each tab carries
  // role=tab + aria-selected, and the ACTIVE tab reports selected=true.
  test("tabs expose tablist/tab/aria-selected semantics", async ({ page }) => {
    const list = page.locator('[data-testid="ws-tabs"]');
    await expect(list).toHaveAttribute("role", "tablist");

    const first = page.locator('[data-testid="ws-tab"]').first();
    await expect(first).toHaveAttribute("role", "tab");
    await expect(first).toHaveAttribute("aria-selected", "true");

    // A second workspace (addWorkspace ACTIVATES it — switch back so the
    // un-selected state is observable before the switch-under-test).
    const ws2 = await H.addWorkspace(page, "Second");
    const second = page.locator(`[data-testid="ws-tab"][data-workspace="${ws2}"]`);
    await expect(second).toHaveAttribute("aria-selected", "true");
    await H.setActiveWorkspace(page, (await H.workspaces(page))[0]);
    await expect(second).toHaveAttribute("aria-selected", "false");
    await H.setActiveWorkspace(page, ws2!);
    await expect(second).toHaveAttribute("aria-selected", "true");
    await expect(first).toHaveAttribute("aria-selected", "false");
  });

  // Feature: switching workspace is survival-safe (the overlay stack keeps every
  // iframe mounted; switching is CSS-visibility-only). The crux of the model.
  test("switching workspace is survival-safe (no iframe reload)", async ({ page }) => {
    // Add a second workspace + a pane into it so switching is non-trivial.
    const ws2 = await H.addWorkspace(page, "Second");
    expect(ws2).not.toBeNull();
    // Seed a pane in ws2 (a runtime-added ws starts empty).
    await H.addServer(page, "http://127.0.0.1:5174?srv=ws2seed", "ws2-seed");
    const ws2Panes = await H.panes(page);
    expect(ws2Panes.length, "ws2 has a seeded pane").toBeGreaterThanOrEqual(1);
    const ws2Pane = ws2Panes[0];
    await H.waitForReady(page, ws2Pane);
    const before = await H.survival(page, ws2Pane);
    expect(before).not.toBeNull();

    // Switch back to ws1, then back to ws2 — the ws2 pane's iframe MUST survive.
    const ws1 = (await H.workspaces(page))[0];
    await H.setActiveWorkspace(page, ws1);
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws1);
    await H.setActiveWorkspace(page, ws2!);
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws2);

    // The ws2 pane's identity SURVIVED both switches (no reload).
    await H.assertSurvived(page, ws2Pane, before!, "ws2 pane across ws switch");
  });

  // Feature: ws-add creates a new (empty) workspace and activates it.
  test("ws-add creates a new empty workspace and activates it", async ({ page }) => {
    const before = (await H.workspaces(page)).length;
    const beforeActive = await H.activeWorkspace(page);

    await page.locator('[data-testid="ws-add"]').click();

    await expect.poll(async () => (await H.workspaces(page)).length).toBe(before + 1);
    // The new workspace is active.
    await expect.poll(async () => H.activeWorkspace(page)).not.toBe(beforeActive);
    // A runtime-added workspace starts EMPTY (the empty-workspace affordance).
    await expect.poll(async () => (await H.panes(page)).length).toBe(0);
    await expect(page.locator('[data-testid="empty-workspace"]')).toBeVisible();
  });

  // Feature: delete is a two-step confirm (first tap → "Delete?" ✓/✗; confirm
  // → close). Cancelling reverts. The last workspace is guarded (disabled ×).
  test("delete is a two-step confirm; cancel reverts", async ({ page }) => {
    // Add a second workspace so delete is not the last-ws guard.
    const ws2 = await H.addWorkspace(page, "ToDelete");
    expect(ws2).not.toBeNull();
    await expect.poll(async () => (await H.workspaces(page)).length).toBe(2);

    const before = (await H.workspaces(page)).length;

    // First tap arms the confirm (✓/✗ appear, × disappears).
    await page.locator(`[data-testid="ws-delete"][data-workspace="${ws2}"]`).click();
    await expect(page.locator(`[data-testid="ws-delete-confirm"][data-workspace="${ws2}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="ws-delete-cancel"][data-workspace="${ws2}"]`)).toBeVisible();

    // Cancel reverts (no close).
    await page.locator(`[data-testid="ws-delete-cancel"][data-workspace="${ws2}"]`).click();
    await expect(page.locator(`[data-testid="ws-delete-confirm"][data-workspace="${ws2}"]`)).toHaveCount(0);
    await expect.poll(async () => (await H.workspaces(page)).length).toBe(before);
  });

  test("delete confirm closes the workspace", async ({ page }) => {
    const ws2 = await H.addWorkspace(page, "ToDelete");
    await expect.poll(async () => (await H.workspaces(page)).length).toBe(2);
    const before = (await H.workspaces(page)).length;

    await page.locator(`[data-testid="ws-delete"][data-workspace="${ws2}"]`).click();
    await page.locator(`[data-testid="ws-delete-confirm"][data-workspace="${ws2}"]`).click();

    await expect.poll(async () => (await H.workspaces(page)).length).toBe(before - 1);
    expect((await H.workspaces(page)).includes(ws2!)).toBe(false);
  });

  test("can't delete the last remaining workspace (× disabled)", async ({ page }) => {
    // The seeded default workspace is the only one.
    const ws1 = (await H.workspaces(page))[0];
    const del = page.locator(`[data-testid="ws-delete"][data-workspace="${ws1}"]`);
    await expect(del).toBeDisabled();
  });

  // Feature: rename via long-press → inline edit; Enter/blur commits, Esc cancels.
  // Long-press (RENAME_PRESS_MS=500) is emulated with a sustained pointerdown.
  test("long-press a tab opens rename; Enter commits (survival-safe)", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    const before = await H.workspaceName(page, ws1);

    // Long-press the tab label area to enter rename mode.
    const label = page.locator(`[data-testid="ws-tab-label"][title="${before}"]`);
    const box = await label.boundingBox();
    expect(box).not.toBeNull();

    // Sustained pointerdown > RENAME_PRESS_MS (500ms). Use mouse + a wait.
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700); // > 500ms threshold
    await page.mouse.up();

    const input = page.locator('[data-testid="ws-rename-input"]');
    await expect(input).toBeVisible();
    expect(await input.inputValue()).toBe(before);

    await input.fill("Renamed WS");
    await input.press("Enter");

    await expect.poll(async () => H.workspaceName(page, ws1)).toBe("Renamed WS");
  });

  // Feature: keyboard rename entry — F2 on a focused tab opens the same inline
  // rename (the no-pointer twin of the long-press; standard rename key).
  test("F2 on a focused tab opens rename; Enter commits", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    const before = await H.workspaceName(page, ws1);

    const tab = page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`);
    await tab.focus();
    await page.keyboard.press("F2");

    const input = page.locator('[data-testid="ws-rename-input"]');
    await expect(input).toBeVisible();
    expect(await input.inputValue()).toBe(before);

    await input.fill("F2 Renamed");
    await input.press("Enter");

    await expect.poll(async () => H.workspaceName(page, ws1)).toBe("F2 Renamed");
  });

  // Feature: per-tab needs-you badge reflects the workspace's needy-session count.
  test("per-tab needs-you badge shows for a workspace with a needy session", async ({ page }) => {
    // Initially no needs-you badges.
    expect(await page.locator('[data-testid="ws-needs-you"]').count()).toBe(0);

    // Inject a needs_reply status for a pane in the active (default) workspace.
    const ids = await H.panes(page);
    const pane0 = ids[0];
    await H.probeStatus(page, {
      sourcePaneId: pane0,
      origin: H.MOCK_ORIGIN,
      payload: {
        type: "status",
        dir: "/proj",
        session: "sess-1",
        title: "Needs Reply",
        attention: "needs_reply",
        activity: "idle",
        following: true,
      },
    });

    // The aggregate needs-you count reflects it.
    await expect.poll(async () => H.needsYou(page), { timeout: 8000 }).toBe(1);

    // The needs-you badge appears on the default workspace's tab.
    const ws1 = (await H.workspaces(page))[0];
    await expect.poll(async () => {
      return page.locator(
        `[data-testid="ws-needs-you"][data-workspace="${ws1}"]`,
      ).count();
    }, { timeout: 8000 }).toBe(1);
  });
});
