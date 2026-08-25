import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as H from "./util";

/**
 * Workspace-tabs e2e (Phase 1 i3 host-shell: the top tabstrip shows WORKSPACES).
 *
 * Replaces the P4 pane-tabs.spec.ts (the pane-tab model was reverted). Each test
 * verifies one operator-facing feature of the restored workspace tabstrip:
 * presence, switch (survival-safe), add, the tab CONTEXT MENU (right-click /
 * long-press / F2 → Rename | Close | Close others — which replaced the per-tab
 * × two-step confirm AND the direct long-press→rename), and the per-tab
 * needs-you badge.
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

  // ---- Tab CONTEXT MENU (replaces the × two-step confirm + direct rename) ----

  // Feature: right-click (contextmenu) opens the tab menu — role=menu with the
  // three menuitems, anchored to that workspace's tab; Escape closes it (the
  // surface stack's topmost-only dismiss).
  test("right-click opens the tab menu; Esc closes", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    const tab = page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`);

    await tab.click({ button: "right" });
    const menu = page.locator(`[data-testid="ws-tab-menu"][data-workspace="${ws1}"]`);
    await expect(menu).toBeVisible();
    await expect(menu).toHaveAttribute("role", "menu");
    await expect(page.locator('[data-testid="ws-menu-rename"]')).toBeVisible();
    await expect(page.locator('[data-testid="ws-menu-close"]')).toBeVisible();
    await expect(page.locator('[data-testid="ws-menu-close-others"]')).toBeVisible();
    // aria-expanded on the tab itself advertises the open menu to AT.
    await expect(tab).toHaveAttribute("aria-expanded", "true");

    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(tab).toHaveAttribute("aria-expanded", "false");

    // Vision receipts: the menu open at 1280 (desktop posture), then at ~360
    // (mobile posture — the clamped placement; the long-press gesture itself
    // is covered by the touch test below).
    await tab.click({ button: "right" });
    await expect(menu).toBeVisible();
    await page.screenshot({ path: path.join(VISION_DIR, "tab-menu-1280.png") });
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(200); // reflow settle
    await page.keyboard.press("Escape");
    await tab.click({ button: "right" }); // re-place for the narrow viewport
    await expect(menu).toBeVisible();
    await page.screenshot({ path: path.join(VISION_DIR, "tab-menu-360.png") });
  });

  // Feature: menu → Close closes THAT workspace (the old × two-step confirm's
  // replacement — one deliberate action, no per-tab button cost).
  test("menu Close closes that workspace", async ({ page }) => {
    const ws2 = await H.addWorkspace(page, "ToDelete");
    await expect.poll(async () => (await H.workspaces(page)).length).toBe(2);

    await page
      .locator(`[data-testid="ws-tab"][data-workspace="${ws2}"]`)
      .click({ button: "right" });
    await page.locator('[data-testid="ws-menu-close"]').click();

    await expect.poll(async () => (await H.workspaces(page)).length).toBe(1);
    expect((await H.workspaces(page)).includes(ws2!)).toBe(false);
    // The menu closed with the action.
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);
  });

  // Feature: menu → Close others closes every OTHER workspace (REVERSIBLE
  // DEFAULT — the operator said "maybe"; flagged as removable). The survivor's
  // panes are untouched by the carnage (closing another ws's host never reloads
  // this one — survival), and the closed workspaces' panes are gone.
  test("menu Close others leaves only this workspace; survivor panes survive", async ({ page }) => {
    // ws1: seeded with panes. ws2: a runtime pane, the survivor.
    const ws1 = (await H.workspaces(page))[0];
    const ws2 = await H.addWorkspace(page, "Survivor");
    await H.addServer(page, "http://127.0.0.1:5174?srv=menuclose", "menu-close");
    const ws2Panes = await H.panes(page);
    expect(ws2Panes.length, "ws2 has a pane").toBeGreaterThanOrEqual(1);
    await H.waitForReady(page, ws2Panes[0]);
    const before = await H.survival(page, ws2Panes[0]);
    expect(before).not.toBeNull();

    // Right-click the SURVIVOR's tab (a background-vs-active mix is part of
    // the point: Close others must close the ACTIVE ws1 cleanly).
    await page
      .locator(`[data-testid="ws-tab"][data-workspace="${ws2}"]`)
      .click({ button: "right" });
    await page.locator('[data-testid="ws-menu-close-others"]').click();

    // Only the survivor remains (and became the active workspace).
    await expect.poll(async () => (await H.workspaces(page))).toEqual([ws2]);
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws2);
    // The closed ws1's panes are gone; the survivor's pane set is intact.
    await expect.poll(async () => (await H.panes(page)).sort()).toEqual(ws2Panes.slice().sort());
    // The survivor's pane iframe SURVIVED the close-others (no reload).
    await H.assertSurvived(page, ws2Panes[0], before!, "survivor pane across close-others");
  });

  // Feature: last-workspace guard — with one workspace, Close + Close others
  // are aria-disabled and their activation is a full no-op (the menu stays
  // open; the workspace survives). Rename stays enabled.
  test("last-workspace guard: Close/Close others disabled no-ops", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    await page
      .locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`)
      .click({ button: "right" });

    const close = page.locator('[data-testid="ws-menu-close"]');
    const others = page.locator('[data-testid="ws-menu-close-others"]');
    await expect(close).toHaveAttribute("aria-disabled", "true");
    await expect(others).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator('[data-testid="ws-menu-rename"]')).not.toHaveAttribute(
      "aria-disabled",
      "true",
    );

    // Both disabled activations are no-ops: no close, menu stays open.
    // force:true — Playwright's actionability check refuses plain clicks on
    // aria-disabled buttons (correct for real flows); here the whole point is
    // proving the handler is a no-op anyway.
    await close.click({ force: true });
    await others.click({ force: true });
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toBeVisible();
    await expect.poll(async () => (await H.workspaces(page)).length).toBe(1);
  });

  // Feature: menu → Rename opens the existing inline rename on that tab (Enter
  // commits, Esc cancels — the machinery is unchanged; only the entry point
  // moved into the menu).
  test("menu Rename opens inline rename; Enter commits, Esc cancels", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    const before = await H.workspaceName(page, ws1);

    await page
      .locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`)
      .click({ button: "right" });
    await page.locator('[data-testid="ws-menu-rename"]').click();

    const input = page.locator('[data-testid="ws-rename-input"]');
    await expect(input).toBeVisible();
    expect(await input.inputValue()).toBe(before);

    await input.fill("Menu Renamed");
    await input.press("Enter");
    await expect.poll(async () => H.workspaceName(page, ws1)).toBe("Menu Renamed");

    // Esc path: reopen rename, cancel — name unchanged.
    await page
      .locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`)
      .click({ button: "right" });
    await page.locator('[data-testid="ws-menu-rename"]').click();
    await input.fill("Should Not Land");
    await input.press("Escape");
    await expect.poll(async () => H.workspaceName(page, ws1)).toBe("Menu Renamed");
  });

  // Feature: keyboard entry — F2 on a focused tab opens the SAME menu (the old
  // F2-direct-rename, retargeted: F2, Enter is the two-keystroke rename).
  test("F2 on a focused tab opens the menu; Rename + Enter commits", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    const before = await H.workspaceName(page, ws1);

    const tab = page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`);
    await tab.focus();
    await page.keyboard.press("F2");
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toBeVisible();

    await page.locator('[data-testid="ws-menu-rename"]').click();
    const input = page.locator('[data-testid="ws-rename-input"]');
    await expect(input).toBeVisible();
    await input.fill("F2 Renamed");
    await input.press("Enter");
    await expect.poll(async () => H.workspaceName(page, ws1)).toBe("F2 Renamed");
  });

  // Feature: Shift+F10 (the keyboard context-menu key) opens the menu on the
  // focused tab — the browser synthesizes a contextmenu event for it.
  test("Shift+F10 on a focused tab opens the menu", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    const tab = page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`);
    await tab.focus();
    await page.keyboard.press("Shift+F10");
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);
  });

  // Feature: keyboard menu-item activation — F2 opens the menu, Tab reaches
  // the items, Enter runs the focused item's action NATIVELY (the tab's
  // keydown handler must not swallow bubbled Enter/Space from the item
  // buttons; commit-review's converged finding).
  test("menu items are keyboard-activatable (F2 → Tab → Enter runs Rename)", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    const tab = page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`);

    await tab.focus();
    await page.keyboard.press("F2");
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toBeVisible();

    // Tab into the menu; the first item is Rename.
    await page.keyboard.press("Tab");
    await expect(page.locator('[data-testid="ws-menu-rename"]')).toBeFocused();
    await page.keyboard.press("Enter");

    const input = page.locator('[data-testid="ws-rename-input"]');
    await expect(input).toBeVisible();
    await input.fill("KB Renamed");
    await input.press("Enter");
    await expect.poll(async () => H.workspaceName(page, ws1)).toBe("KB Renamed");
  });

  // Feature: dismissal on workspace switch via a NON-pointer path — a keyboard
  // switch (focus another tab, Enter) moves no pointer, so the surface
  // stack's outside-click pass never fires; the tab's reactive
  // activeWorkspaceId effect must close the menu.
  test("keyboard workspace switch closes an open menu (reactive dismissal)", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    const ws2 = await H.addWorkspace(page, "Second"); // addWorkspace ACTIVATES ws2

    const ws2Tab = page.locator(`[data-testid="ws-tab"][data-workspace="${ws2}"]`);
    await ws2Tab.focus();
    await page.keyboard.press("F2");
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toBeVisible();

    // Keyboard-switch to ws1 (locator.focus moves focus without a pointerdown;
    // Enter drives the switch through the tab's real keydown handler).
    const ws1Tab = page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`);
    await ws1Tab.focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws1);
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);
  });

  // Feature: LONG-PRESS (real mouse hold — the same input pipeline the old
  // rename long-press used) opens the menu; the release click is consumed (no
  // workspace switch); pointer drift beyond the threshold cancels the arm.
  test("long-press opens the menu; release click doesn't switch; drift cancels", async ({ page }) => {
    // A BACKGROUND tab makes the no-switch assertion meaningful (switching to
    // the already-active tab would be invisible).
    const ws1 = (await H.workspaces(page))[0];
    const ws2 = await H.addWorkspace(page, "Second"); // addWorkspace ACTIVATES ws2
    const bgTab = page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`);

    // Sustained hold > MENU_PRESS_MS (500ms).
    const box = await bgTab.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(700); // > 500ms threshold
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toBeVisible();
    await page.mouse.up();
    // The release click was consumed: no workspace switch.
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws2);
    await page.keyboard.press("Escape");

    // Drift > 12px while holding cancels the arm — no menu.
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 14, box!.y + box!.height / 2);
    await page.waitForTimeout(700);
    await page.mouse.up();
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);
  });

  // Feature: TOUCH long-press (pointerType "touch") opens the same menu — the
  // mobile gesture that replaced direct-rename. Dispatched through the page's
  // real PointerEvent pipeline (handler-level truth; Playwright cannot hold a
  // real touchscreen press).
  test("touch long-press (pointerType touch) opens the menu", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    const tab = page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`);
    await tab.dispatchEvent("pointerdown", { pointerType: "touch" });
    await page.waitForTimeout(700); // > 500ms threshold
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toBeVisible();
    await tab.dispatchEvent("pointerup", { pointerType: "touch" });
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);
  });

  // Feature: dismissal — a click OUTSIDE the tab (another tab) closes the menu
  // (the surface stack's outside-click pass) and the click proceeds (switch).
  test("outside click (another tab) closes the menu and switches", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    const ws2 = await H.addWorkspace(page, "Second");
    // Open the menu on ws2's tab (background), then click ws1's tab.
    await page
      .locator(`[data-testid="ws-tab"][data-workspace="${ws2}"]`)
      .click({ button: "right" });
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toBeVisible();

    await page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`).click();
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws1);
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
        runningCount: 0,
        unreadCount: 0,
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
