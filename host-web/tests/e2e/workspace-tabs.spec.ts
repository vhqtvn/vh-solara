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

  // Feature: the tabstrip renders one ws-tab per workspace + the single
  // merged "+" (ws-add → AddMenu popover: New workspace + Connect server…).
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

  // Feature: the merged "+" offers New workspace; creating one activates it
  // and it starts empty (the empty-workspace affordance).
  test("ws-add popover creates a new empty workspace and activates it", async ({ page }) => {
    const before = (await H.workspaces(page)).length;
    const beforeActive = await H.activeWorkspace(page);

    await page.locator('[data-testid="ws-add"]').click();
    await expect(page.locator('[data-testid="add-menu-popover"]')).toBeVisible();
    await page.locator('[data-testid="add-menu-new-workspace"]').click();

    await expect.poll(async () => (await H.workspaces(page)).length).toBe(before + 1);
    // The new workspace is active.
    await expect.poll(async () => H.activeWorkspace(page)).not.toBe(beforeActive);
    // A runtime-added workspace starts EMPTY (the empty-workspace affordance).
    await expect.poll(async () => (await H.panes(page)).length).toBe(0);
    await expect(page.locator('[data-testid="empty-workspace"]')).toBeVisible();
  });

  // Feature (F3 E2E ENFORCEMENT, cc1): the OVERLAY add-server path (the
  // empty-active-workspace gate's AddServer — App.tsx:157, surface id
  // "add-server") is DRIVEN end-to-end: open its popover, submit a real url,
  // a pane opens. The strip's merged AddMenu (surface id "add-menu") is
  // co-mounted the whole time; the DISTINCT surface ids keep dismissal
  // independent (cc2 — same-id mounting would clobber the registry).
  test("overlay AddServer drives a server add end-to-end; co-mounted AddMenu never clobbers dismissal", async ({ page }) => {
    // Make the ACTIVE workspace empty → the overlay AddServer renders while
    // the populated strip (incl. the merged +) stays mounted.
    await page.locator('[data-testid="ws-add"]').click();
    await page.locator('[data-testid="add-menu-new-workspace"]').click();
    await expect(page.locator('[data-testid="empty-workspace"]')).toBeVisible();

    // CO-MOUNTED posture: the overlay trigger AND the strip trigger exist.
    const overlayBtn = page.locator('[data-testid="add-server-btn"]');
    await expect(overlayBtn).toHaveCount(1);
    await expect(page.locator('[data-testid="ws-add"]')).toHaveCount(1);

    // Distinct-surface-id check (cc2), BEFORE the drive (the overlay
    // unmounts on success): opening the STRIP menu closes the overlay
    // popover (group exclusion) without killing its registration — the
    // overlay trigger still works afterwards.
    await overlayBtn.click();
    await expect(page.locator('[data-testid="add-server-popover"]')).toBeVisible();
    await page.locator('[data-testid="ws-add"]').click();
    await expect(page.locator('[data-testid="add-menu-popover"]')).toBeVisible();
    await expect(page.locator('[data-testid="add-server-popover"]')).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="add-menu-popover"]')).toHaveCount(0);
    await overlayBtn.click();
    await expect(page.locator('[data-testid="add-server-popover"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="add-server-popover"]')).toHaveCount(0);

    // DRIVE the overlay path: open the OVERLAY's popover (add-server-popover
    // — the overlay surface, not the strip menu) and submit a real url.
    await overlayBtn.click();
    await expect(page.locator('[data-testid="add-server-popover"]')).toBeVisible();
    const before = (await H.panes(page)).length;
    const url = H.serverUrl("overlay-drive");
    await page.locator('[data-testid="add-server-url"]').fill(url);
    await page.locator('[data-testid="add-server-label"]').fill("overlay-drive");
    await page.locator('[data-testid="add-server-submit"]').click();
    // The pane opened (the submit path genuinely ran — not render-visible).
    await expect.poll(async () => (await H.panes(page)).length).toBe(before + 1);
    const params = await H.paneParams(page);
    expect(params.find((p) => p.url === url), "overlay add opened a pane for the url").toBeDefined();
    // USER-VISIBLE outcome: the workspace is no longer empty — the overlay
    // (and its AddServer) unmounts by design (App.tsx's activeEmpty gate).
    await expect(page.locator('[data-testid="empty-workspace"]')).toHaveCount(0);
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

  // Feature: TOUCH long-press (pointerType "touch") — drag-era semantics: the
  // 500ms hold ARMS the press (drag candidate); the MENU opens on the
  // STATIONARY RELEASE (deferred so a post-hold drag can never race an
  // already-open menu), still carrying the Move left/Move right reorder
  // items. Pre-arm drift past the threshold cancels the arm (scroll intent —
  // no menu, no drag). Dispatched through the page's real PointerEvent
  // pipeline (handler-level truth; Playwright cannot hold a real touchscreen
  // press, and hasTouch is off in the default projects).
  test("touch long-press arms, stationary release opens the menu; pre-arm drift cancels", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    const tab = page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`);
    await tab.dispatchEvent("pointerdown", { pointerType: "touch" });
    await page.waitForTimeout(700); // > 500ms threshold — ARMED, menu deferred
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);
    await tab.dispatchEvent("pointerup", { pointerType: "touch" });
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toBeVisible();
    // The hold-opened menu still carries the reorder items (the landed menu,
    // unchanged by the drag gesture layer).
    await expect(page.locator('[data-testid="ws-menu-move-left"]')).toBeVisible();
    await expect(page.locator('[data-testid="ws-menu-move-right"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);

    // Pre-arm drift: a touch that moves past the threshold inside the 500ms
    // window is scroll intent — the arm cancels and NOTHING fires at release
    // (no menu; the drag model also refuses un-armed touch movement).
    const box = await tab.boundingBox();
    expect(box).not.toBeNull();
    const x = box!.x + box!.width / 2;
    const y = box!.y + box!.height / 2;
    await tab.dispatchEvent("pointerdown", { pointerType: "touch", clientX: x, clientY: y });
    await tab.dispatchEvent("pointermove", { pointerType: "touch", clientX: x + 20, clientY: y });
    await page.waitForTimeout(700);
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);
    await tab.dispatchEvent("pointerup", { pointerType: "touch", clientX: x + 20, clientY: y });
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

  // ---- PRIORITY-FIT MEMBERSHIP (attention-selected visibility) ---------------
  // Width budgets are MEASURED, not eyeballed: at an 800px viewport the tabs
  // container is ~461px wide (brand + text-bearing Layouts/Settings chrome),
  // so the fit budget is ~409px. Test 1 uses short names (active + prev
  // always fit); test 2 uses ~58-char names (nothing fits beside the active
  // tab); test 3 crowds a ~200px needy tab behind ~70px fillers. Every
  // window holds with large margins in every engine.

  // Feature: phone-width saturation with 20 workspaces — the active workspace
  // (canonically LAST) stays visible (tier 0 outranks fit), the rendered row
  // keeps CANONICAL order (membership is priority-selected, never reshuffled),
  // the overflow trigger appears, the overflow lists every hidden workspace,
  // and the search filters the hidden list.
  test("priority fit: 20-workspace saturation keeps active-last visible + canonical order + searchable overflow", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 800 });
    // 20 total (seed + 19 short-named — ~50px tabs against the measured
    // ~409px budget at this viewport). addWorkspace ACTIVATES each new
    // workspace, so the canonical LAST workspace ends active and the
    // second-to-last is the one-slot prev-active (D1).
    for (let i = 2; i <= 20; i++) await H.addWorkspace(page, `Ws ${i}`);
    const all = await H.workspaces(page);
    expect(all.length).toBe(20);
    const last = all[all.length - 1];

    // Saturated: fewer than 20 tabs render; the overflow trigger exists.
    await expect
      .poll(async () => page.locator('[data-testid="ws-tab"]').count(), { timeout: 5000 })
      .toBeLessThan(20);
    const trigger = page.locator('[data-testid="ws-overflow-trigger"]');
    await expect(trigger).toBeVisible();

    // The ACTIVE (canonical-last) workspace is rendered + selected, and the
    // PREV-ACTIVE keeps a visible slot (the D1 recency tier — short tabs fit
    // comfortably, so both survive saturation).
    const activeTab = page.locator(`[data-testid="ws-tab"][data-workspace="${last}"]`);
    await expect(activeTab).toBeVisible();
    await expect(activeTab).toHaveAttribute("aria-selected", "true");
    await expect(
      page.locator(`[data-testid="ws-tab"][data-workspace="${all[all.length - 2]}"]`),
    ).toBeVisible();

    // The rendered row is in CANONICAL workspace order.
    const rendered = await page.locator('[data-testid="ws-tab"]').evaluateAll((els) =>
      (els as HTMLElement[]).map((e) => e.dataset.workspace ?? ""),
    );
    expect(rendered).toEqual(all.filter((id) => rendered.includes(id!)));

    // The overflow popover lists exactly the hidden complement; search
    // filters it deterministically (pick a hidden row's OWN name).
    await trigger.click();
    const rows = page.locator('[data-testid="ws-overflow-row"]');
    await expect(rows).toHaveCount(20 - rendered.length);
    const hiddenIds = await rows.evaluateAll((els) =>
      (els as HTMLElement[]).map((e) => e.dataset.workspace ?? ""),
    );
    expect(hiddenIds.length).toBeGreaterThan(0);
    const pick = hiddenIds[Math.floor(hiddenIds.length / 2)]!;
    const pickName = (await H.workspaceName(page, pick)) ?? "";
    await page.locator('[data-testid="ws-overflow-search"]').fill(pickName);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-workspace", pick);
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="ws-overflow-popover"]')).toHaveCount(0);

    await page.screenshot({ path: path.join(VISION_DIR, "priority-fit-360.png"), fullPage: true });
  });

  // Feature: selecting a HIDDEN workspace from the overflow activates it and
  // it becomes visible (the active rule) — quiet workspaces are reachable in
  // ≤2 taps. The previously-active workspace keeps a slot (one-slot recency,
  // D1 — prev-active tier).
  test("overflow: choosing a hidden workspace activates it and makes it visible", async ({ page }) => {
    // 600px viewport → a fit budget (~175px, engine-dependent ±40px) far
    // below active(218, the tabLabel max-width:200px cap) + seed(~92+4):
    // the seed can NEVER fit beside the active tab here, so every quiet
    // workspace (incl. the seed) sits behind the overflow trigger while the
    // active tab stays visible (tier 0 outranks fit — computeFits always
    // includes the top-ranked candidate).
    await page.setViewportSize({ width: 600, height: 800 });
    const seed = (await H.workspaces(page))[0];
    for (let i = 0; i < 6; i++) {
      await H.addWorkspace(page, `LongWorkspaceNameForWidthPaddingLongWorkspaceNameForWidth${i}`);
    }

    const trigger = page.locator('[data-testid="ws-overflow-trigger"]');
    await expect(trigger).toBeVisible();
    // The seed workspace (quiet, canonically first) starts hidden.
    const seedTab = page.locator(`[data-testid="ws-tab"][data-workspace="${seed}"]`);
    await expect(seedTab).toHaveCount(0);

    await trigger.click();
    const row = page.locator(`[data-testid="ws-overflow-row"][data-workspace="${seed}"]`);
    await expect(row).toBeVisible();
    await row.click();

    // The chosen workspace ACTIVATES and becomes VISIBLE (the active rule —
    // tier 0 outranks fit even in a fully saturated strip).
    await expect.poll(async () => H.activeWorkspace(page)).toBe(seed);
    await expect(seedTab).toBeVisible();
    await expect(seedTab).toHaveAttribute("aria-selected", "true");
    // The popover closed with the choice.
    await expect(page.locator('[data-testid="ws-overflow-popover"]')).toHaveCount(0);
  });

  // Feature: MEMBERSHIP FREEZE — while a strip menu is open, a hidden
  // workspace going needs-you does NOT reshuffle the visible set (the cue and
  // badges keep updating LIVE); closing the menu applies the promotion.
  test("membership freezes while a tab menu is open; cue updates live; unfreeze promotes the needy workspace", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 800 });
    const seed = (await H.workspaces(page))[0];
    // Layout for the measured ~409px budget: seed(~100px, ACTIVE) + four
    // ~70px fillers (canonical indexes 1-4 — they consume the budget before
    // the needy tab, canonical index 5, ~200px, is considered) + a fifth
    // filler created LAST so the one-slot prev-active is a FILLER rather
    // than the needy workspace. Pre-freeze the needy tab is hidden;
    // post-promotion it jumps to tier 1 (right after the active seed) and
    // fits easily.
    for (let i = 1; i <= 4; i++) await H.addWorkspace(page, `FillerWs${i}`);
    const needy = await H.addWorkspace(page, "NeedyWorkspaceNameForWidthPad1");
    await H.addServer(page, H.serverUrl("freeze-seed"), "freeze-seed");
    const needyPane = (await H.panes(page))[0];
    expect(needyPane).toBeTruthy();
    await H.addWorkspace(page, "FillerWs5"); // activates it; prev-active ≠ needy
    await H.setActiveWorkspace(page, seed);

    // Saturated with Needy hidden (quiet, no attention).
    const needyTab = page.locator(`[data-testid="ws-tab"][data-workspace="${needy}"]`);
    await expect(page.locator('[data-testid="ws-overflow-trigger"]')).toBeVisible();
    await expect(needyTab).toHaveCount(0);

    // FREEZE: open the active tab's context menu (a TABSTRIP_POPOVER_GROUP
    // surface — membership must hold still while it is open).
    await page.locator(`[data-testid="ws-tab"][data-workspace="${seed}"]`).click({ button: "right" });
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toBeVisible();

    // The hidden workspace goes needs-you: the overflow cue updates LIVE
    // (counts hidden WORKSPACES, not sessions — exactly 1 here)…
    await H.probeStatus(page, {
      sourcePaneId: needyPane!,
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
    const cue = page.locator('[data-testid="ws-overflow-cue"]');
    await expect(cue).toBeVisible();
    await expect(cue).toHaveAttribute("data-kind", "needs-you");
    await expect(cue).toHaveAttribute("data-count", "1");

    // …but membership is FROZEN while the menu is open: no promotion yet.
    await page.waitForTimeout(400);
    await expect(needyTab).toHaveCount(0);

    // UNFREEZE: close the menu — the needy workspace is promoted into the
    // strip (attention-selected membership) with its live badge.
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);
    await expect(needyTab).toBeVisible();
    await expect(
      page.locator(`[data-testid="ws-needs-you"][data-workspace="${needy}"]`),
    ).toBeVisible();
    // With the needy workspace no longer hidden, the needs-you cue clears.
    await expect(page.locator('[data-testid="ws-overflow-cue"]')).toHaveCount(0);
  });

  /** Probe a full valid status (counts + attention) for a pane through the
   *  REAL router — the probeCounts wrapper precedent (tab-pairs.spec.ts /
   *  overflow-live.spec.ts). Used by the tier/fit tests below. */
  async function probeStatusCounts(
    page: import("@playwright/test").Page,
    paneId: string,
    runningCount: number,
    unreadCount: number,
    attention: "none" | "needs_reply" = "none",
  ): Promise<void> {
    const r = await H.probeStatus(page, {
      sourcePaneId: paneId,
      origin: H.MOCK_ORIGIN,
      payload: {
        type: "status",
        dir: "",
        session: "",
        title: "",
        attention,
        activity: "idle",
        following: true,
        runningCount,
        unreadCount,
      },
    });
    expect(r.accepted, `status (${runningCount}|${unreadCount} ${attention}) accepted`).toBe(true);
  }

  // Feature: MEMBERSHIP FREEZE — the KEYBOARD-FOCUS arm of the freeze
  // predicate (pressed || openMenu || kbdFocus). Focusing a tab WITHOUT a
  // preceding pointer (locator.focus moves DOM focus only; the
  // POINTER_FOCUS_MS attribution gate sees lastPointerAt=0 and passes) arms
  // kbdFocus exactly like an open menu: a hidden workspace going needs-you
  // does NOT reshuffle the visible set while the cue updates LIVE; moving
  // focus back out of the strip (blur) applies the promotion.
  test("membership freezes while a tab holds keyboard focus; blur unfreezes and promotes the needy workspace", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 800 });
    const seed = (await H.workspaces(page))[0];
    // Same measured geometry as the menu-freeze test above (seed ~100px
    // ACTIVE + four ~70px fillers consume the ~409px budget before the
    // ~218px long-capped needy tab at canonical index 5; a fifth filler
    // created LAST keeps the one-slot prev-active off the needy workspace).
    // Distinct names so any cross-test leak fails loudly.
    for (let i = 1; i <= 4; i++) await H.addWorkspace(page, `KbdFill${i}`);
    const needy = await H.addWorkspace(page, "NeedyKbdFocusFreezeNameForWidthPadA1");
    const needyPane = await H.addServer(page, H.serverUrl("kbd-freeze"), "kbd-freeze");
    expect(needyPane).toBeTruthy();
    await H.addWorkspace(page, "KbdFill5"); // activates it; prev-active ≠ needy
    await H.setActiveWorkspace(page, seed);

    // Saturated with Needy hidden (quiet, no attention).
    const needyTab = page.locator(`[data-testid="ws-tab"][data-workspace="${needy}"]`);
    await expect(page.locator('[data-testid="ws-overflow-trigger"]')).toBeVisible();
    await expect(needyTab).toHaveCount(0);

    // The neutral handshake must land before the probe (last write wins).
    await H.waitForReady(page, needyPane!);

    // FREEZE via KEYBOARD FOCUS on the active tab — no pointerdown precedes
    // it, so the strip's focusin is attributed to the KEYBOARD (not the
    // pointer) and arms the kbdFocus freeze arm.
    const seedTab = page.locator(`[data-testid="ws-tab"][data-workspace="${seed}"]`);
    await seedTab.focus();

    // The hidden workspace goes needs-you: the overflow cue updates LIVE
    // (counts hidden WORKSPACES, not sessions — exactly 1 here)…
    await H.probeStatus(page, {
      sourcePaneId: needyPane!,
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
    const cue = page.locator('[data-testid="ws-overflow-cue"]');
    await expect(cue).toBeVisible();
    await expect(cue).toHaveAttribute("data-kind", "needs-you");
    await expect(cue).toHaveAttribute("data-count", "1");

    // …but membership is FROZEN while the tab holds keyboard focus.
    await page.waitForTimeout(400);
    await expect(needyTab).toHaveCount(0);

    // UNFREEZE: blur the tab (focus leaves the strip) — the needy workspace
    // is promoted into the strip (attention-selected membership) with its
    // live badge, and the cue clears.
    await seedTab.blur();
    await expect(needyTab).toBeVisible();
    await expect(
      page.locator(`[data-testid="ws-needs-you"][data-workspace="${needy}"]`),
    ).toBeVisible();
    await expect(page.locator('[data-testid="ws-overflow-cue"]')).toHaveCount(0);
  });

  // Feature: MEMBERSHIP FREEZE — the PRESSED arm of the freeze predicate
  // (pressed || openMenu || kbdFocus, Tabstrip.tsx). A pointer press anywhere
  // on the strip (the STRIP-WIDE pointerdown) freezes membership until the
  // WINDOW-level release. The press targets the strip BACKGROUND — the
  // tab-free right end of the tabs container, guaranteed ≥52px wide by the
  // fit's overflow reserve whenever anything is hidden — so the tab-anchored
  // long-press menu timer (MENU_PRESS_MS=500, bound per-TAB) never arms and
  // the hold below cannot open a menu (no timing window to race).
  test("membership freezes while the strip is pressed; release unfreezes and promotes the needy workspace", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 800 });
    const seed = (await H.workspaces(page))[0];
    // Same measured geometry as the menu/kbd-focus freeze tests above (seed
    // ~92px ACTIVE + ~60px fillers consume the ~409px budget before the
    // ~218px long-capped needy tab; a fifth filler created LAST keeps the
    // one-slot prev-active off the needy workspace). Distinct names in the
    // same width classes (9-char fillers, a ≥200px-capped needy name) so any
    // cross-test leak fails loudly without moving the geometry.
    for (let i = 1; i <= 4; i++) await H.addWorkspace(page, `PressedF${i}`);
    const needy = await H.addWorkspace(page, "NeedyPressedFreezeNameForWidthPadB1");
    const needyPane = await H.addServer(page, H.serverUrl("pressed-freeze"), "pressed-freeze");
    expect(needyPane).toBeTruthy();
    await H.addWorkspace(page, "PressedF5"); // activates it; prev-active ≠ needy
    await H.setActiveWorkspace(page, seed);

    // Saturated with Needy hidden (quiet, no attention).
    const needyTab = page.locator(`[data-testid="ws-tab"][data-workspace="${needy}"]`);
    await expect(page.locator('[data-testid="ws-overflow-trigger"]')).toBeVisible();
    await expect(needyTab).toHaveCount(0);

    // The neutral handshake must land before the probe (last write wins).
    await H.waitForReady(page, needyPane!);

    // FREEZE via a POINTER PRESS on the strip background. The press point is
    // 20px inside the RIGHT edge of the tabs container — the fit reserves
    // ≥52px there (OVERFLOW_RESERVE_PX) whenever anything is hidden, so it is
    // guaranteed tab-free (and the "⋯" trigger lives OUTSIDE the container),
    // while the pointerdown still bubbles to the strip-wide listener.
    const tabsBox = await page.locator('[data-testid="ws-tabs"]').boundingBox();
    expect(tabsBox).not.toBeNull();
    await page.mouse.move(tabsBox!.x + tabsBox!.width - 20, tabsBox!.y + tabsBox!.height / 2);
    await page.mouse.down(); // arms `pressed`; release is window-level
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);

    // The hidden workspace goes needs-you: the overflow cue updates LIVE
    // (counts hidden WORKSPACES, not sessions — exactly 1 here)…
    await probeStatusCounts(page, needyPane!, 0, 0, "needs_reply");
    const cue = page.locator('[data-testid="ws-overflow-cue"]');
    await expect(cue).toBeVisible();
    await expect(cue).toHaveAttribute("data-kind", "needs-you");
    await expect(cue).toHaveAttribute("data-count", "1");

    // …but membership is FROZEN while the strip is pressed (the hold
    // outlasts MENU_PRESS_MS with no menu opening — the press is on
    // background, not a tab — so the freeze can only be the pressed arm).
    await page.waitForTimeout(400);
    await expect(needyTab).toHaveCount(0);
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);

    // UNFREEZE: release the pointer (the window-level pointerup clears
    // `pressed`) — the needy workspace is promoted into the strip
    // (attention-selected membership) with its live badge, and the cue clears.
    await page.mouse.up();
    await expect(needyTab).toBeVisible();
    await expect(
      page.locator(`[data-testid="ws-needs-you"][data-workspace="${needy}"]`),
    ).toBeVisible();
    await expect(page.locator('[data-testid="ws-overflow-cue"]')).toHaveCount(0);
  });

  // Feature: TIER PRECEDENCE — an UNREAD workspace outranks a RUNNING one at
  // equal fit (TIER.UNREAD=2 < TIER.RUNNING=3, priorityFit.ts): when only one
  // of two ~218px long-capped tabs fits beside the active seed, the unread
  // one is visible and the running one sits behind the overflow trigger.
  test("priority fit: unread beats running when only one long tab fits", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 800 });
    const seed = (await H.workspaces(page))[0];
    // Two long-capped (~218px) workspaces, each with its own pane (budget
    // ~409px: seed ~96 + one long tab ~218+badge ≈ 340 fits; adding the
    // second ≈ 580 spills). The RUNNING one is created FIRST, so canonical
    // index order alone cannot satisfy the assertions below — only tier
    // precedence (UNREAD outranks RUNNING) can.
    const runningWs = await H.addWorkspace(page, "RunningWsLongNameForWidthPaddingP1");
    const runningPane = await H.addServer(page, H.serverUrl("p1-running"), "p1-running");
    expect(runningPane).toBeTruthy();
    const unreadWs = await H.addWorkspace(page, "UnreadWsLongNameForWidthPaddingP1x");
    const unreadPane = await H.addServer(page, H.serverUrl("p1-unread"), "p1-unread");
    expect(unreadPane).toBeTruthy();
    await H.setActiveWorkspace(page, seed);

    // Neutral handshakes first (last write wins).
    await H.waitForReady(page, unreadPane!);
    await H.waitForReady(page, runningPane!);

    // UnreadWs: unread only. RunningWs: running only. Neither needs-you.
    await probeStatusCounts(page, unreadPane!, 0, 3);
    await probeStatusCounts(page, runningPane!, 2, 0);

    // The seed and the UNREAD workspace are visible…
    await expect(page.locator(`[data-testid="ws-tab"][data-workspace="${seed}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="ws-tab"][data-workspace="${unreadWs}"]`)).toBeVisible();
    // …the RUNNING workspace is hidden behind the overflow trigger.
    const runningTab = page.locator(`[data-testid="ws-tab"][data-workspace="${runningWs}"]`);
    await expect(runningTab).toHaveCount(0);

    // Overflow membership agrees: the running workspace is in the list, the
    // unread one is not.
    const trigger = page.locator('[data-testid="ws-overflow-trigger"]');
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(
      page.locator(`[data-testid="ws-overflow-row"][data-workspace="${runningWs}"]`),
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="ws-overflow-row"][data-workspace="${unreadWs}"]`),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="ws-overflow-popover"]')).toHaveCount(0);
  });

  // Feature: TIE-BREAK — same-tier workspaces tie by CANONICAL index, and
  // count MAGNITUDE is never a tie-breaker (D4): with two long-capped UNREAD
  // workspaces where only one fits, the canonically-EARLIER one is visible
  // even though the later one carries MORE unreads (5 vs 1).
  test("priority fit: same-tier tie breaks by canonical index, never by count magnitude", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 800 });
    const seed = (await H.workspaces(page))[0];
    // Canonical order: seed, tieEarlier (index 1), tieLater (index 2).
    const tieEarlier = await H.addWorkspace(page, "TieEarlierLongNameForWidthPaddingP2a");
    const earlierPane = await H.addServer(page, H.serverUrl("p2-earlier"), "p2-earlier");
    expect(earlierPane).toBeTruthy();
    const tieLater = await H.addWorkspace(page, "TieLaterLongNameForWidthPaddingP2bMore");
    const laterPane = await H.addServer(page, H.serverUrl("p2-later"), "p2-later");
    expect(laterPane).toBeTruthy();
    await H.setActiveWorkspace(page, seed);

    // Neutral handshakes first (last write wins).
    await H.waitForReady(page, earlierPane!);
    await H.waitForReady(page, laterPane!);

    // BOTH unread tier; the canonically-LATER one carries MORE unreads —
    // magnitude must NOT decide (only nonzero-ness sets the tier).
    await probeStatusCounts(page, earlierPane!, 0, 1);
    await probeStatusCounts(page, laterPane!, 0, 5);

    // The canonically-earlier unread workspace wins the single fitting slot…
    await expect(page.locator(`[data-testid="ws-tab"][data-workspace="${seed}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="ws-tab"][data-workspace="${tieEarlier}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="ws-tab"][data-workspace="${tieLater}"]`)).toHaveCount(0);

    // …and the overflow list holds exactly the higher-index one.
    const trigger = page.locator('[data-testid="ws-overflow-trigger"]');
    await expect(trigger).toBeVisible();
    await trigger.click();
    await expect(
      page.locator(`[data-testid="ws-overflow-row"][data-workspace="${tieLater}"]`),
    ).toBeVisible();
    await expect(
      page.locator(`[data-testid="ws-overflow-row"][data-workspace="${tieEarlier}"]`),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="ws-overflow-popover"]')).toHaveCount(0);
  });

  // Feature: GREEDY CONTINUATION (D4) — the fit walk does NOT stop at the
  // first spill: an oversized candidate overflows WHOLE (never truncated or
  // squeezed), and the walk CONTINUES so a lower-ranked, smaller tab after it
  // may still fit. A stop-at-first-spill implementation would hide BOTH.
  test("priority fit: greedy walk continues past an oversized candidate (smaller lower-ranked tab still fits)", async ({ page }) => {
    // 650px viewport → ~259px budget (the ~409px budget at 800px minus 150
    // of viewport): the long-capped unread tab (~218 + badge) can NEVER fit
    // beside the seed (~92), but the short running tab (~70) always can.
    await page.setViewportSize({ width: 650, height: 800 });
    const seed = (await H.workspaces(page))[0];
    const unreadLong = await H.addWorkspace(page, "P3UnreadLongWorkspaceNameForWidthPad");
    const unreadPane = await H.addServer(page, H.serverUrl("p3-unread"), "p3-unread");
    expect(unreadPane).toBeTruthy();
    const runShort = await H.addWorkspace(page, "P3RunShort");
    const runPane = await H.addServer(page, H.serverUrl("p3-run"), "p3-run");
    expect(runPane).toBeTruthy();
    await H.setActiveWorkspace(page, seed);

    // Neutral handshakes first (last write wins).
    await H.waitForReady(page, unreadPane!);
    await H.waitForReady(page, runPane!);

    // Ranked: seed (active) → unreadLong (UNREAD tier) → runShort (RUNNING
    // tier — ranked AFTER, exactly the "lower-ranked" the greedy walk must
    // still consider).
    await probeStatusCounts(page, unreadPane!, 0, 2);
    await probeStatusCounts(page, runPane!, 1, 0);

    // The seed and the SHORT RUNNING tab are visible…
    await expect(page.locator(`[data-testid="ws-tab"][data-workspace="${seed}"]`)).toBeVisible();
    await expect(page.locator(`[data-testid="ws-tab"][data-workspace="${runShort}"]`)).toBeVisible();
    // …the oversized UNREAD tab overflowed WHOLE (a stop-at-first-spill
    // implementation would hide runShort too).
    const unreadTab = page.locator(`[data-testid="ws-tab"][data-workspace="${unreadLong}"]`);
    await expect(unreadTab).toHaveCount(0);

    // Overflow membership agrees: only the long unread workspace is hidden.
    const trigger = page.locator('[data-testid="ws-overflow-trigger"]');
    await expect(trigger).toBeVisible();
    await trigger.click();
    const rows = page.locator('[data-testid="ws-overflow-row"]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-workspace", unreadLong!);
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="ws-overflow-popover"]')).toHaveCount(0);
  });

  // ---- workspace REORDER (F-A) -------------------------------------------------
  //
  // ORDER TRUTH NOTE: the DEV bridge's __host.workspaces() returns the
  // controllers map's INSERTION order (hostController.ts), which a reorder
  // never changes — it is NOT canonical order once reordering exists. The
  // order truth for assertions is (1) the RENDERED strip/overflow rows (both
  // derive from the store array order) and (2) the persisted v3 blob's
  // workspaces array (exactly what reload restores).

  /** The persisted workspace ORDER from the v3 localStorage mirror (the
   *  store's canonical array order — the thing reload restores). */
  async function persistedWsOrder(page: import("@playwright/test").Page): Promise<string[]> {
    return page.evaluate(
      (key) => {
        try {
          const raw = localStorage.getItem(key);
          if (!raw) return [];
          const parsed = JSON.parse(raw) as { workspaces?: Array<{ id?: string }> };
          return (parsed.workspaces ?? []).map((w) => w.id ?? "");
        } catch {
          return [];
        }
      },
      H.LAYOUT_STORAGE_KEY,
    );
  }

  /** The rendered strip order (visible tabs, canonical order). */
  async function renderedTabOrder(page: import("@playwright/test").Page): Promise<string[]> {
    return page.locator('[data-testid="ws-tab"]').evaluateAll((els) =>
      (els as HTMLElement[]).map((e) => e.dataset.workspace ?? ""),
    );
  }

  /** The HOST-LAYER DOM order (creation order — the fence-extension
   *  observable): the hostLayer divs are direct children of <main>, each
   *  carrying data-workspace. A reorder must NEVER change this order; a close
   *  removes exactly the closed workspace's layer. */
  async function hostLayerIds(page: import("@playwright/test").Page): Promise<string[]> {
    return page.locator("main > [data-workspace]").evaluateAll((els) =>
      (els as HTMLElement[]).map((e) => e.dataset.workspace ?? ""),
    );
  }

  // Feature: the tab context menu offers Move left / Move right; a move
  // reflects IMMEDIATELY in the canonical (blob) order AND the rendered strip
  // order, preserves identity on BOTH dimensions — store identity (<For>
  // survival: same Workspace refs, no host remount) AND host-layer DOM
  // stability (the reorder never DOM-moves a host layer, so no iframe
  // browsing context is re-created) — and the boundary entry (first-left) is
  // an aria-disabled full no-op. BOTH workspaces carry panes so ANY node move
  // under the old <For> reconciliation would hit a pane-ful layer (the
  // 2-workspace paneless-mover fixture passed by accident of Solid's minimal
  // move — this is the deliberate pin, criterion 11).
  test("menu Move left/Move right reorder workspaces (rendered + persisted order, identity-preserving)", async ({
    page,
  }) => {
    const ws1 = (await H.workspaces(page))[0];
    const ws2 = await H.addWorkspace(page, "Second");
    expect(ws2).toBeTruthy();
    // Seed a pane into ws2 TOO (it is active right after creation) — every
    // workspace in the fixture is pane-ful, so any DOM node move reloads.
    const ws2Pane = await H.addServer(page, H.serverUrl("reorder-ws2"), "reorder-ws2");
    expect(ws2Pane).toBeTruthy();
    await H.waitForReady(page, ws2Pane!);
    const ws2Before = await H.survival(page, ws2Pane!);
    expect(ws2Before).not.toBeNull();
    await H.setActiveWorkspace(page, ws1!);

    // Identity probes: ws1's seeded pane must SURVIVE the reorder (reorder
    // mutates array order only — same Workspace object refs, no host remount).
    const seedPane = (await H.panes(page))[0];
    expect(seedPane).toBeTruthy();
    await H.waitForReady(page, seedPane!);
    const before = await H.survival(page, seedPane!);
    expect(before).not.toBeNull();

    // Boundary guard FIRST: ws1 is canonically first — Move left is disabled
    // and its (forced) activation is a full no-op (menu stays open).
    await page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`).click({ button: "right" });
    const leftBtn = page.locator('[data-testid="ws-menu-move-left"]');
    await expect(leftBtn).toHaveAttribute("aria-disabled", "true");
    await leftBtn.click({ force: true });
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toBeVisible();
    expect(await renderedTabOrder(page)).toEqual([ws1, ws2]);
    await page.keyboard.press("Escape");

    // The host-layer DOM order starts at CREATION order [ws1, ws2] (the
    // hostLayer divs are direct children of <main>, each carrying
    // data-workspace — the production-safe layer-order observable).
    expect(await hostLayerIds(page)).toEqual([ws1, ws2]);

    // Move ws1 RIGHT: the rendered strip order flips to [ws2, ws1]…
    await page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`).click({ button: "right" });
    await page.locator('[data-testid="ws-menu-move-right"]').click();
    await expect.poll(async () => renderedTabOrder(page)).toEqual([ws2, ws1]);
    // …the persisted blob carries the SAME canonical order (v3 array order)…
    await expect.poll(async () => persistedWsOrder(page)).toEqual([ws2, ws1]);
    // …the host-layer DOM order is UNTOUCHED (creation order — the decoupling:
    // display reorders, the layer never DOM-moves an iframe)…
    expect(await hostLayerIds(page)).toEqual([ws1, ws2]);
    // …and BOTH workspaces' pane iframes SURVIVED (no remount AND no browsing
    // context recreation — survival identity asserts mountTs continuity).
    await H.assertSurvived(page, seedPane!, before!, "ws1 seed pane across reorder");
    await H.assertSurvived(page, ws2Pane!, ws2Before!, "ws2 pane across reorder");

    // Move ws1 LEFT (back): rendered order restores to [ws1, ws2] and ws1 is
    // canonically FIRST again — Move left is its disabled boundary. The host
    // layer NEVER moved.
    await page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`).click({ button: "right" });
    await page.locator('[data-testid="ws-menu-move-left"]').click();
    await expect.poll(async () => renderedTabOrder(page)).toEqual([ws1, ws2]);
    await expect.poll(async () => persistedWsOrder(page)).toEqual([ws1, ws2]);
    expect(await hostLayerIds(page)).toEqual([ws1, ws2]);
    await H.assertSurvived(page, seedPane!, before!, "ws1 seed pane after move-left back");
    await H.assertSurvived(page, ws2Pane!, ws2Before!, "ws2 pane after move-left back");

    // Close removes the layer (hostLayerOrder set-equality: no stale layer
    // for a closed workspace).
    expect(await H.closeWorkspace(page, ws2!)).toBe(true);
    await expect.poll(async () => hostLayerIds(page)).toEqual([ws1]);
  });

  // Feature: a workspace hidden behind ⋯ has NO tab on the strip, so its ONLY
  // reorder affordance is the ⋮ row menu. Driving it reorders the CANONICAL
  // order (persisted blob; the swap partner may be a visible tab) and the row
  // list re-renders in the new canonical order while the popover stays open;
  // the canonical-first row's Move left is a disabled no-op.
  test("overflow row menu reorders a hidden workspace (persisted order + live row order)", async ({
    page,
  }) => {
    // 600px viewport: the seed can never fit beside the active long tab —
    // every quiet workspace sits behind the overflow trigger.
    await page.setViewportSize({ width: 600, height: 800 });
    const seed = (await H.workspaces(page))[0];
    const longs: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = await H.addWorkspace(page, `LongWorkspaceNameForWidthPaddingLongWorkspaceNameFor${i}`);
      longs.push(id!);
    }
    // Canonical creation order: [seed, L0..L5]; active = L5.
    await expect.poll(async () => persistedWsOrder(page), { timeout: 8000 }).toEqual([seed, ...longs]);

    const trigger = page.locator('[data-testid="ws-overflow-trigger"]');
    await expect(trigger).toBeVisible();
    await trigger.click();
    const rows = page.locator('[data-testid="ws-overflow-row"]');
    const hiddenBefore = await rows.evaluateAll((els) =>
      (els as HTMLElement[]).map((e) => e.dataset.workspace ?? ""),
    );
    expect(hiddenBefore).toContain(seed);
    expect(hiddenBefore[0], "rows render in canonical order (seed first)").toBe(seed);

    // ⋮ on the seed row → the row menu opens (a popover surface DISTINCT from
    // the parent — the parent stays open; no group mutual-exclusion).
    await page
      .locator(`[data-testid="ws-overflow-row-menu-trigger"][data-workspace="${seed}"]`)
      .click();
    await expect(page.locator('[data-testid="ws-overflow-row-menu"]')).toBeVisible();
    await expect(page.locator('[data-testid="ws-overflow-popover"]')).toBeVisible();
    // The seed is canonically FIRST: its Move left is disabled.
    await expect(
      page.locator(`[data-testid="ws-menu-move-left"][data-workspace="${seed}"]`),
    ).toHaveAttribute("aria-disabled", "true");

    // Move the seed RIGHT one slot: canonical order becomes [L0, seed, L1..L5].
    await page.locator(`[data-testid="ws-menu-move-right"][data-workspace="${seed}"]`).click();
    await expect.poll(async () => persistedWsOrder(page)).toEqual([longs[0], seed, ...longs.slice(1)]);
    // The row menu closed with the action; the parent popover is still open…
    await expect(page.locator('[data-testid="ws-overflow-row-menu"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="ws-overflow-popover"]')).toBeVisible();
    // …and the row list re-rendered in the NEW canonical order (membership is
    // frozen while the popover is open, but the row ORDER follows the store).
    const hiddenAfter = [longs[0], seed, ...hiddenBefore.slice(1).filter((id) => id !== longs[0])];
    await expect
      .poll(async () =>
        rows.evaluateAll((els) => (els as HTMLElement[]).map((e) => e.dataset.workspace ?? "")),
      )
      .toEqual(hiddenAfter);

    // The canonical-first row (L0, still hidden) has a disabled Move left.
    await page
      .locator(`[data-testid="ws-overflow-row-menu-trigger"][data-workspace="${longs[0]}"]`)
      .click();
    const rowLeft = page.locator(`[data-testid="ws-menu-move-left"][data-workspace="${longs[0]}"]`);
    await expect(rowLeft).toHaveAttribute("aria-disabled", "true");
    await rowLeft.click({ force: true });
    await expect(page.locator('[data-testid="ws-overflow-row-menu"]')).toBeVisible();
    expect(await persistedWsOrder(page)).toEqual([longs[0], seed, ...longs.slice(1)]);
    await page.keyboard.press("Escape"); // closes the row menu (topmost)
    await page.keyboard.press("Escape"); // then the parent popover
    await expect(page.locator('[data-testid="ws-overflow-popover"]')).toHaveCount(0);
  });

  // ---- DRAG-TO-REORDER (gesture layer over the menu reorder) ------------------
  //
  // The drag is the GESTURE upgrade over the ⋮ menu moves: a pressed tab
  // dragged along the strip reorders through the SAME identity-preserving
  // reorderWorkspace (rendered + persisted order flip; host-layer DOM order
  // and every pane iframe UNTOUCHED). Disambiguation vs the long-press menu:
  // movement threshold (12px) + hold time (500ms) — mouse drags start
  // immediately past the threshold, touch drags only after the hold ARMS the
  // press, and a stationary touch release still opens the menu (the test
  // above). Fixtures are deliberately SMALL (3 short-named workspaces, all
  // visible at the 1280 default viewport) so drag geometry is unambiguous;
  // drop targets aim at tab QUARTERS (≥15px from any center) so engine font
  // deltas cannot flip the drop slot.

  /** Center-point of a tab (the drag y + a handy x reference). */
  async function tabCenter(
    page: import("@playwright/test").Page,
    wsId: string,
  ): Promise<{ x: number; y: number }> {
    const box = await page
      .locator(`[data-testid="ws-tab"][data-workspace="${wsId}"]`)
      .boundingBox();
    expect(box, `tab ${wsId} has a box`).not.toBeNull();
    return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  }

  // Feature: MOUSE drag end-to-end (the crux) — press a tab, move several
  // real steps past the 12px threshold to another tab's quarter, drop:
  // rendered order flips, persisted blob order flips (the persistence seam),
  // the HOST-LAYER DOM order is UNCHANGED (creation-stable — no iframe
  // browsing context re-created), panes SURVIVE (mountTs continuity), the
  // active workspace is UNCHANGED (drag ≠ activation), and no menu opens
  // (drag ≠ stationary hold).
  test("mouse drag reorders (rendered + persisted order; host layer + iframes untouched)", async ({ page }) => {
    // Canonical [ws1(seed, pane-ful), Second(pane-ful), Third(pane-ful,
    // ACTIVE — the last addWorkspace activates)]. Every workspace pane-ful so
    // ANY host-layer node move would reload a pane (the reorder menu test's
    // deliberate pin).
    const ws1 = (await H.workspaces(page))[0];
    const seedPane = (await H.panes(page))[0];
    expect(seedPane).toBeTruthy();
    await H.waitForReady(page, seedPane!);
    const seedBefore = await H.survival(page, seedPane!);
    expect(seedBefore).not.toBeNull();

    const ws2 = await H.addWorkspace(page, "Second"); // activates ws2
    const ws2Pane = await H.addServer(page, H.serverUrl("drag-ws2"), "drag-ws2");
    expect(ws2Pane).toBeTruthy();
    await H.waitForReady(page, ws2Pane!);
    const ws2Before = await H.survival(page, ws2Pane!);
    expect(ws2Before).not.toBeNull();

    const ws3 = await H.addWorkspace(page, "Third"); // activates ws3
    const ws3Pane = await H.addServer(page, H.serverUrl("drag-ws3"), "drag-ws3");
    expect(ws3Pane).toBeTruthy();
    await H.waitForReady(page, ws3Pane!);
    const ws3Before = await H.survival(page, ws3Pane!);
    expect(ws3Before).not.toBeNull();

    expect(await renderedTabOrder(page)).toEqual([ws1, ws2, ws3]);
    const hostBefore = await hostLayerIds(page); // creation order

    // Press Third, drag to ws1's LEFT quarter (unambiguous drop slot 0).
    const tab3 = page.locator(`[data-testid="ws-tab"][data-workspace="${ws3}"]`);
    const from = await tabCenter(page, ws3!);
    const box1 = await page
      .locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`)
      .boundingBox();
    expect(box1).not.toBeNull();
    const dropX = box1!.x + box1!.width / 4;
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    // Several REAL steps past the 12px threshold: the drag starts and follows.
    await page.mouse.move(dropX, from.y, { steps: 12 });

    // LIVE PREVIEW (before any commit): the dragged tab is flagged and the
    // earlier siblings each translated right by one slot (the transform-only
    // drop gap) — while the canonical DOM order is untouched (preview ≠
    // commit; the strip never reshuffles mid-gesture).
    await expect(tab3).toHaveAttribute("data-dragging", "1");
    expect(
      Number(
        await page
          .locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`)
          .getAttribute("data-shift"),
      ),
    ).toBeGreaterThan(0);
    expect(
      Number(
        await page
          .locator(`[data-testid="ws-tab"][data-workspace="${ws2}"]`)
          .getAttribute("data-shift"),
      ),
    ).toBeGreaterThan(0);
    expect(await renderedTabOrder(page)).toEqual([ws1, ws2, ws3]);
    await page.screenshot({ path: path.join(VISION_DIR, "drag-preview-mouse.png"), fullPage: true });

    // Drop.
    await page.mouse.up();

    // Commit: rendered + persisted order flip to [Third, ws1, Second]…
    await expect.poll(async () => renderedTabOrder(page)).toEqual([ws3, ws1, ws2]);
    await expect.poll(async () => persistedWsOrder(page)).toEqual([ws3, ws1, ws2]);
    // …the host layer NEVER moved (creation order — the decoupling)…
    expect(await hostLayerIds(page)).toEqual(hostBefore);
    // …and EVERY pane iframe SURVIVED (no remount, no browsing-context
    // recreation — including the DRAGGED workspace's own pane).
    await H.assertSurvived(page, seedPane!, seedBefore!, "ws1 seed pane across drag reorder");
    await H.assertSurvived(page, ws2Pane!, ws2Before!, "ws2 pane across drag reorder");
    await H.assertSurvived(page, ws3Pane!, ws3Before!, "ws3 (dragged) pane across drag reorder");
    // Drag ≠ hold: no menu on release. Drag ≠ click: active UNCHANGED. The
    // preview state cleared with the commit.
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws3);
    await expect(tab3).toHaveAttribute("data-dragging", "0");
  });

  // Feature: mouse drag in the OTHER direction (left→right) on a BACKGROUND
  // tab — the dragged workspace stays background (a drag never activates).
  test("mouse drag right reorders a background tab; drag opens no menu and switches nothing", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    const ws2 = await H.addWorkspace(page, "Second");
    const ws3 = await H.addWorkspace(page, "Third"); // activates ws3 (stays it)

    expect(await renderedTabOrder(page)).toEqual([ws1, ws2, ws3]);
    const from = await tabCenter(page, ws2!);
    const box3 = await page
      .locator(`[data-testid="ws-tab"][data-workspace="${ws3}"]`)
      .boundingBox();
    expect(box3).not.toBeNull();

    // Drag (BACKGROUND) Second to ws3's RIGHT quarter (unambiguous drop slot 2).
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(box3!.x + (box3!.width * 3) / 4, from.y, { steps: 12 });
    await page.mouse.up();

    await expect.poll(async () => renderedTabOrder(page)).toEqual([ws1, ws3, ws2]);
    await expect.poll(async () => persistedWsOrder(page)).toEqual([ws1, ws3, ws2]);
    expect(await hostLayerIds(page)).toEqual([ws1, ws2, ws3]);
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);
    // The DRAGGED workspace stayed BACKGROUND (a drag never activates; ws3
    // remains the active workspace).
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws3);
  });

  // Feature: TOUCH drag — the armed long-press becomes a drag when the finger
  // moves past the threshold AFTER the 500ms hold (movement before the hold is
  // scroll intent). Dispatched pointer events with pointerType "touch" through
  // the page's real PointerEvent pipeline (handler-level truth — the lane's
  // established touch idiom; Playwright has no touchscreen drag API and the
  // default projects run hasTouch off).
  test("touch drag: armed hold + movement reorders (pointerType touch)", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    const ws2 = await H.addWorkspace(page, "Second");
    const ws3 = await H.addWorkspace(page, "Third");
    expect(await renderedTabOrder(page)).toEqual([ws1, ws2, ws3]);

    const tab3 = page.locator(`[data-testid="ws-tab"][data-workspace="${ws3}"]`);
    const ws1Tab = page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`);
    const ws2Tab = page.locator(`[data-testid="ws-tab"][data-workspace="${ws2}"]`);
    const from = await tabCenter(page, ws3!);
    const box1 = await ws1Tab.boundingBox();
    const box2 = await ws2Tab.boundingBox();
    expect(box1).not.toBeNull();
    expect(box2).not.toBeNull();
    // ws2's LEFT quarter → live drop slot 1 (insert BEFORE ws2: only ws2
    // shifts right a slot; the dragged tab comes from the right, so hovering
    // ws2's right half would be the insert-AFTER no-op slot).
    const midX = box2!.x + box2!.width / 4;
    const endX = box1!.x + box1!.width / 4; // ws1's LEFT quarter → slot 0

    await tab3.dispatchEvent("pointerdown", {
      pointerType: "touch",
      clientX: from.x,
      clientY: from.y,
    });
    // Sub-threshold jitter while pressed: neither cancels the arm nor drags.
    await tab3.dispatchEvent("pointermove", {
      pointerType: "touch",
      clientX: from.x + 5,
      clientY: from.y,
    });
    await page.waitForTimeout(600); // > 500ms hold → ARMED (menu deferred)
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);

    // Armed + >12px move → the drag starts, already over ws2's left quarter:
    // live slot 1 (ws2 shifted a slot right; ws1 not yet moved).
    await tab3.dispatchEvent("pointermove", {
      pointerType: "touch",
      clientX: midX,
      clientY: from.y,
    });
    await expect(tab3).toHaveAttribute("data-dragging", "1");
    expect(Number(await ws2Tab.getAttribute("data-shift"))).toBeGreaterThan(0);
    expect(await ws1Tab.getAttribute("data-shift")).toBeNull();
    expect(await renderedTabOrder(page)).toEqual([ws1, ws2, ws3]); // preview ≠ commit

    // Continue to ws1's left quarter (slot 0) and drop.
    await tab3.dispatchEvent("pointermove", {
      pointerType: "touch",
      clientX: endX,
      clientY: from.y,
    });
    expect(Number(await ws1Tab.getAttribute("data-shift"))).toBeGreaterThan(0);
    await tab3.dispatchEvent("pointerup", { pointerType: "touch", clientX: endX, clientY: from.y });

    await expect.poll(async () => renderedTabOrder(page)).toEqual([ws3, ws1, ws2]);
    await expect.poll(async () => persistedWsOrder(page)).toEqual([ws3, ws1, ws2]);
    expect(await hostLayerIds(page)).toEqual([ws1, ws2, ws3]);
    // Drag ≠ hold: no menu.
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);
  });

  // Feature: ABORT — Escape mid-drag collapses the preview and commits
  // NOTHING (order unchanged); the late release neither reorders, opens the
  // menu, nor switches the workspace.
  test("Escape mid-drag aborts to the original order (mouse)", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    const ws2 = await H.addWorkspace(page, "Second");
    const ws3 = await H.addWorkspace(page, "Third"); // active
    expect(await renderedTabOrder(page)).toEqual([ws1, ws2, ws3]);

    const tab3 = page.locator(`[data-testid="ws-tab"][data-workspace="${ws3}"]`);
    const from = await tabCenter(page, ws3!);
    const box1 = await page
      .locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`)
      .boundingBox();
    expect(box1).not.toBeNull();

    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(box1!.x + box1!.width / 4, from.y, { steps: 12 });
    await expect(tab3).toHaveAttribute("data-dragging", "1"); // drag in flight

    await page.keyboard.press("Escape"); // ABORT
    await expect(tab3).toHaveAttribute("data-dragging", "0"); // preview gone
    expect(await renderedTabOrder(page)).toEqual([ws1, ws2, ws3]); // no commit

    await page.mouse.up(); // late release — suppressed click, still nothing
    expect(await renderedTabOrder(page)).toEqual([ws1, ws2, ws3]);
    expect(await persistedWsOrder(page)).toEqual([ws1, ws2, ws3]);
    expect(await hostLayerIds(page)).toEqual([ws1, ws2, ws3]);
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws3); // no switch
  });

  // Feature: ABORT — pointercancel (the system took the pointer over)
  // collapses the preview and commits NOTHING; no menu either.
  test("pointercancel mid-drag aborts to the original order (touch)", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    const ws2 = await H.addWorkspace(page, "Second");
    const ws3 = await H.addWorkspace(page, "Third");
    expect(await renderedTabOrder(page)).toEqual([ws1, ws2, ws3]);

    const tab3 = page.locator(`[data-testid="ws-tab"][data-workspace="${ws3}"]`);
    const from = await tabCenter(page, ws3!);
    const box1 = await page
      .locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`)
      .boundingBox();
    expect(box1).not.toBeNull();

    await tab3.dispatchEvent("pointerdown", {
      pointerType: "touch",
      clientX: from.x,
      clientY: from.y,
    });
    await page.waitForTimeout(600); // armed
    await tab3.dispatchEvent("pointermove", {
      pointerType: "touch",
      clientX: box1!.x + box1!.width / 4,
      clientY: from.y,
    });
    await expect(tab3).toHaveAttribute("data-dragging", "1"); // drag in flight

    await tab3.dispatchEvent("pointercancel", { pointerType: "touch" }); // ABORT
    await expect(tab3).toHaveAttribute("data-dragging", "0");
    expect(await renderedTabOrder(page)).toEqual([ws1, ws2, ws3]); // no commit
    await expect(page.locator('[data-testid="ws-tab-menu"]')).toHaveCount(0);
  });
});
