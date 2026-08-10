import { test, expect } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// Workspace-management quick-wins (host-web shell) — three affordances on the
// workspace tabstrip that ship together:
//
//   (a) DELETE workspace — a × per tab with a fat-finger-safe two-step inline
//       confirm. Last-workspace guard (× disabled). Cross-workspace isolation:
//       deleting ws-A does NOT reload ws-B's surviving panes (assertSurvived).
//       Deleting a workspace DESTROYS its own panes (intentional; not a
//       survival op — contrast with a survival-safe CSS-only switch).
//
//   (b) RENAME workspace — long-press the tab label → inline edit. Commit on
//       blur/Enter; cancel on Esc. The new name round-trips through layout
//       persistence (reload restores it). SURVIVAL-SAFE: the store mutates only
//       the name field, preserving the Workspace object's referential identity
//       so App.tsx's <For> overlay stack never remounts the host (no iframe
//       reload) — proven here by assertSurvived on the renamed ws's pane.
//
//   (c) PER-TAB needs-you badge — a count on EVERY workspace tab (not just the
//       active one). A BACKGROUND workspace's needy sessions are the ones the
//       operator can't see on the active grid; surfacing them here is the point.
//
// Runs on Chromium + Firefox (the survival-critical lanes). The long-press +
// two-step-confirm are driven through the REAL pointer/click UI (behavioral
// closure), not the bridge.
// =============================================================================

const MOCK_ORIGIN = "http://127.0.0.1:5174"; // mock content page origin (:5174)
function serverUrl(server: string): string {
  const q = new URLSearchParams({ server, view: "chat" });
  return `${MOCK_ORIGIN}/?${q.toString()}`;
}

/** Hold a long-press on an element for longer than the rename threshold (~500ms).
 *  Uses the real mouse API so pointerdown/up + the timer fire exactly as a
 *  touch would. Returns once the pointer is released. */
async function longPress(page: import("@playwright/test").Page, x: number, y: number, holdMs = 650): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.waitForTimeout(holdMs);
  await page.mouse.up();
}

test.describe("workspace quick-wins: delete / rename / per-tab badge", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  // ===========================================================================
  // (a) DELETE workspace
  // ===========================================================================
  test.describe("delete workspace (two-step confirm)", () => {
    test("× then ✓ removes the workspace and re-points active to a remaining one", async ({ page }) => {
      // ws1 (default) is active with seeded panes. Add ws2 (becomes active).
      const ws1 = (await H.workspaces(page))[0];
      await H.addWorkspace(page);
      const ws2 = (await H.workspaces(page))[1];
      await expect.poll(async () => H.activeWorkspace(page)).toBe(ws2);
      expect(await H.workspaces(page)).toHaveLength(2);

      // The × on ws2's tab is present and enabled (not the last workspace).
      const del2 = page.locator(`[data-testid="ws-delete"][data-workspace="${ws2}"]`);
      await expect(del2).toBeVisible();
      await expect(del2).toBeEnabled();

      // First tap → enters the two-step confirm state.
      await del2.click();
      const tab2 = page.locator(`[data-testid="ws-tab"][data-workspace="${ws2}"]`);
      await expect(tab2).toHaveAttribute("data-confirming", "1");
      // The confirm + cancel affordances appear.
      await expect(page.locator(`[data-testid="ws-delete-confirm"][data-workspace="${ws2}"]`)).toBeVisible();
      await expect(page.locator(`[data-testid="ws-delete-cancel"][data-workspace="${ws2}"]`)).toBeVisible();

      // Second tap (confirm) → ws2 removed; active re-points to ws1.
      await page.locator(`[data-testid="ws-delete-confirm"][data-workspace="${ws2}"]`).click();
      await expect.poll(async () => H.workspaces(page)).toEqual([ws1]);
      await expect.poll(async () => H.activeWorkspace(page)).toBe(ws1);
      // ws2's tab is gone.
      await expect(page.locator(`[data-testid="ws-tab"][data-workspace="${ws2}"]`)).toHaveCount(0);
    });

    test("cancel reverts the confirm state without deleting", async ({ page }) => {
      const ws1 = (await H.workspaces(page))[0];
      await H.addWorkspace(page);
      const ws2 = (await H.workspaces(page))[1];

      await page.locator(`[data-testid="ws-delete"][data-workspace="${ws2}"]`).click();
      const tab2 = page.locator(`[data-testid="ws-tab"][data-workspace="${ws2}"]`);
      await expect(tab2).toHaveAttribute("data-confirming", "1");

      // Cancel → exits confirm; ws2 still present.
      await page.locator(`[data-testid="ws-delete-cancel"][data-workspace="${ws2}"]`).click();
      await expect(tab2).toHaveAttribute("data-confirming", "0");
      expect(await H.workspaces(page)).toHaveLength(2);
    });

    test("confirm state auto-reverts after a timeout without a second tap", async ({ page }) => {
      // Fat-finger safety: if the operator taps × then doesn't confirm, the tab
      // exits the confirming state on its own (DELETE_CONFIRM_MS ~3.5s) so a
      // stale armed state can't linger. The workspace is NOT deleted.
      await H.addWorkspace(page);
      const ws2 = (await H.workspaces(page))[1];

      await page.locator(`[data-testid="ws-delete"][data-workspace="${ws2}"]`).click();
      const tab2 = page.locator(`[data-testid="ws-tab"][data-workspace="${ws2}"]`);
      await expect(tab2).toHaveAttribute("data-confirming", "1");

      // No second tap — wait out the auto-revert window. The confirm state
      // clears and the normal × control returns; ws2 is still present. The
      // auto-revert does NOT switch the active workspace (ws2 stays active).
      await expect
        .poll(async () => tab2.getAttribute("data-confirming"), { timeout: 6000 })
        .toBe("0");
      await expect(page.locator(`[data-testid="ws-delete"][data-workspace="${ws2}"]`)).toBeVisible();
      expect(await H.workspaces(page)).toHaveLength(2);
      await expect.poll(async () => H.activeWorkspace(page)).toBe(ws2);
    });

    test("last-workspace guard: × is disabled on the only remaining workspace", async ({ page }) => {
      const ws1 = (await H.workspaces(page))[0];
      expect(await H.workspaces(page)).toHaveLength(1);
      const del1 = page.locator(`[data-testid="ws-delete"][data-workspace="${ws1}"]`);
      // The single workspace's × is disabled (can't have zero workspaces).
      await expect(del1).toBeDisabled();
      // Clicking a disabled button is refused by Playwright; assert it stays put.
      expect(await H.workspaces(page)).toHaveLength(1);
    });

    test("cross-workspace isolation: deleting ws-A leaves ws-B's panes' iframe identity unchanged", async ({ page }) => {
      // ws1 (default) seeded with heartbeating pane A.
      const ws1 = (await H.workspaces(page))[0];
      const ws1Panes = await H.panes(page);
      const a = ws1Panes[0];
      const beforeA = (await H.survival(page, a))!;

      // Create ws2 → active. Add a server pane B there.
      await H.addWorkspace(page);
      const ws2 = (await H.workspaces(page))[1];
      await expect.poll(async () => H.activeWorkspace(page)).toBe(ws2);
      const b = await H.addServer(page, serverUrl("del-iso-b"), "del-iso-b");
      expect(b, "server B pane opened in ws2").toBeTruthy();
      const beforeB = await H.waitForReady(page, b!);

      // Switch to ws1 so ws1 is active, then delete ws1 via the UI. closeWorkspace
      // re-points active to the remaining ws2.
      await H.setActiveWorkspace(page, ws1);
      await expect.poll(async () => H.activeWorkspace(page)).toBe(ws1);

      // Delete ws1 via the two-step UI.
      await page.locator(`[data-testid="ws-delete"][data-workspace="${ws1}"]`).click();
      await page.locator(`[data-testid="ws-delete-confirm"][data-workspace="${ws1}"]`).click();

      // ws1 is gone; ws2 is the only + active workspace now.
      await expect.poll(async () => H.workspaces(page)).toEqual([ws2]);
      await expect.poll(async () => H.activeWorkspace(page)).toBe(ws2);

      // SURVIVING pane B in ws2 was NOT reloaded by ws1's destruction (its host
      // was never touched). Identity strictly unchanged — the load-bearing
      // isolation guarantee for a workspace destroy.
      await H.assertSurvived(page, b!, beforeB, "ws2 pane B across ws1 delete");
      // ws1's pane A is gone (its host was disposed — intentional destroy).
      expect(await H.survival(page, a), "deleted ws1's pane A is gone").toBeNull();
      // Unused-var guard for beforeA (captured for clarity; the destroy path
      // means it cannot survive by definition).
      void beforeA;
    });

    test("deleting the active workspace with panes removes those panes too", async ({ page }) => {
      // ws1 (default, seeded) is active. Add ws2 so there's a fallback, then
      // switch back to ws1 and delete IT (the active, pane-bearing workspace).
      const ws1 = (await H.workspaces(page))[0];
      await H.addWorkspace(page);
      const ws2 = (await H.workspaces(page))[1];
      await H.setActiveWorkspace(page, ws1);
      const ws1PanesBefore = await H.panes(page);
      expect(ws1PanesBefore.length, "ws1 has seeded panes").toBeGreaterThanOrEqual(1);

      await page.locator(`[data-testid="ws-delete"][data-workspace="${ws1}"]`).click();
      await page.locator(`[data-testid="ws-delete-confirm"][data-workspace="${ws1}"]`).click();

      await expect.poll(async () => H.workspaces(page)).toEqual([ws2]);
      await expect.poll(async () => H.activeWorkspace(page)).toBe(ws2);
      // Every ws1 pane is gone from the global survival store (intentional destroy).
      for (const id of ws1PanesBefore) {
        expect(await H.survival(page, id), `ws1 pane ${id} destroyed with its workspace`).toBeNull();
      }
    });
  });

  // ===========================================================================
  // (b) RENAME workspace (long-press → inline edit)
  // ===========================================================================
  test.describe("rename workspace (long-press inline edit)", () => {
    test("newly-added workspaces get incrementing default names", async ({ page }) => {
      // Regression guard: addWorkspace derives the default name from the current
      // workspace count. A prior store refactor (signal→store) briefly read the
      // accessor function's arity instead of the array length, so every new ws
      // was named "Workspace 1". This locks the incrementing behavior in.
      await H.addWorkspace(page);
      const ws2 = (await H.workspaces(page))[1];
      await H.addWorkspace(page);
      const ws3 = (await H.workspaces(page))[2];
      expect(await H.workspaceName(page, ws2), "second ws default name").toBe("Workspace 2");
      expect(await H.workspaceName(page, ws3), "third ws default name").toBe("Workspace 3");
    });

    test("long-press the tab → inline edit → Enter commits the new name", async ({ page }) => {
      const ws1 = (await H.workspaces(page))[0];
      expect(await H.workspaceName(page, ws1), "default name").toBe("Workspace 1");

      const tab = page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`);
      const box = await tab.boundingBox();
      expect(box, "tab has a bounding box").not.toBeNull();

      // Long-press the label area (left portion of the tab) → inline edit opens.
      await longPress(page, box!.x + 24, box!.y + box!.height / 2);
      const input = page.locator('[data-testid="ws-rename-input"]');
      await expect(input).toBeVisible();
      await expect(tab).toHaveAttribute("data-editing", "1");

      // Type a new name + commit with Enter.
      await input.fill("My Project");
      await input.press("Enter");

      // Edit mode exited; the new name landed in the store.
      await expect(tab).toHaveAttribute("data-editing", "0");
      await expect.poll(async () => H.workspaceName(page, ws1)).toBe("My Project");
      // The tab label now shows the new name.
      await expect(tab).toContainText("My Project");
    });

    test("Esc cancels the edit and keeps the original name", async ({ page }) => {
      const ws1 = (await H.workspaces(page))[0];
      const original = await H.workspaceName(page, ws1);

      const tab = page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`);
      const box = await tab.boundingBox();
      await longPress(page, box!.x + 24, box!.y + box!.height / 2);
      const input = page.locator('[data-testid="ws-rename-input"]');
      await expect(input).toBeVisible();

      await input.fill("Discarded Name");
      await input.press("Escape");

      await expect(tab).toHaveAttribute("data-editing", "0");
      expect(await H.workspaceName(page, ws1), "name unchanged after Esc-cancel").toBe(original);
    });

    test("rename is survival-safe: the renamed ws's pane is NOT reloaded", async ({ page }) => {
      // SURVIVAL-CRITICAL: rename mutates only the name field (store), preserving
      // the Workspace object's referential identity. App.tsx's <For> overlay
      // stack keys hosts by reference, so a spread-new-object rename would
      // remount the host → cold fromJSON → EVERY iframe reloads. This proves the
      // store-mutation path keeps the iframe alive.
      const ws1 = (await H.workspaces(page))[0];
      const a = (await H.panes(page))[0];
      const before = (await H.survival(page, a))!;

      const tab = page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`);
      const box = await tab.boundingBox();
      await longPress(page, box!.x + 24, box!.y + box!.height / 2);
      const input = page.locator('[data-testid="ws-rename-input"]');
      await expect(input).toBeVisible();
      await input.fill("Survival Check");
      await input.press("Enter");

      // Identity SURVIVED the rename (the store mutated only the name; the host
      // was never remounted).
      await H.assertSurvived(page, a, before, "rename of its workspace");
    });

    test("renamed name round-trips through a layout-persistence reload", async ({ page }) => {
      const ws1 = (await H.workspaces(page))[0];
      const newName = "Persisted Ws Name";

      // Rename via the UI (long-press → edit → Enter).
      const tab = page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`);
      const box = await tab.boundingBox();
      await longPress(page, box!.x + 24, box!.y + box!.height / 2);
      const input = page.locator('[data-testid="ws-rename-input"]');
      await expect(input).toBeVisible();
      await input.fill(newName);
      await input.press("Enter");
      await expect.poll(async () => H.workspaceName(page, ws1)).toBe(newName);

      // Flush the debounced save to localStorage (the name lives in the v2 blob).
      await H.waitForPersistedWorkspaceName(page, ws1, newName);

      // Reload → cold restore reads the blob; the name round-trips.
      await page.reload();
      await expect.poll(async () => H.connected(page), { timeout: 20000 }).toBe(true);
      // The workspace id is stable across reload (initWorkspaces restores ids).
      await expect.poll(async () => H.workspaceName(page, ws1), { timeout: 20000 }).toBe(newName);
    });
  });

  // ===========================================================================
  // (c) PER-TAB needs-you badge (every workspace, not just active)
  // ===========================================================================
  test.describe("per-tab needs-you badge", () => {
    test("a BACKGROUND workspace's needy pane shows a count on its tab", async ({ page }) => {
      // ws1 (default, seeded panes) is active. Create ws2 + add a server pane.
      const ws1 = (await H.workspaces(page))[0];
      const ws1Panes = await H.panes(page);
      await H.addWorkspace(page);
      const ws2 = (await H.workspaces(page))[1];
      await expect.poll(async () => H.activeWorkspace(page)).toBe(ws2);
      const ws2PaneRaw = await H.addServer(page, serverUrl("badge-bg"), "badge-bg");
      expect(ws2PaneRaw, "ws2 has a pane").toBeTruthy();
      const ws2Pane = ws2PaneRaw!;
      await H.waitForReady(page, ws2Pane);

      // Switch back to ws1 → ws2 is now the BACKGROUND workspace. Its pane is
      // not in the active `panes()` projection, but it still heartbeats.
      await H.setActiveWorkspace(page, ws1);
      await expect.poll(async () => H.activeWorkspace(page)).toBe(ws1);

      // Neither tab shows a badge yet (no needs-you panes anywhere).
      await expect(page.locator('[data-testid="ws-needs-you"]')).toHaveCount(0);
      expect(await H.needsYouFor(page, ws2), "ws2 needs-you before status").toBe(0);

      // Make ws2's BACKGROUND pane needy. The per-ws count recomputes (global
      // statusByPane + per-ws panel scan) and surfaces on ws2's tab even though
      // ws2 is not active — the whole point of the per-tab badge.
      await H.probeStatus(page, {
        sourcePaneId: ws2Pane,
        origin: MOCK_ORIGIN,
        payload: { type: "status", dir: "/p", session: "s1", title: "bg", attention: "needs_permission", activity: "idle" },
      });
      await expect.poll(async () => H.needsYouFor(page, ws2), { timeout: 5000 }).toBe(1);

      // ws2's tab now carries a badge with count 1.
      const ws2Badge = page.locator(`[data-testid="ws-needs-you"][data-workspace="${ws2}"]`);
      await expect(ws2Badge).toBeVisible();
      await expect(ws2Badge).toHaveText("1");

      // ws1's tab has NO badge (its panes are not needy). Only ws2's badge exists.
      await expect(page.locator('[data-testid="ws-needs-you"]')).toHaveCount(1);
      const ws1Badge = page.locator(`[data-testid="ws-needs-you"][data-workspace="${ws1}"]`);
      await expect(ws1Badge).toHaveCount(0);

      // ws1's active-ws aggregate is still 0 (ws1's panes are fine).
      expect(await H.needsYou(page), "active-ws aggregate unaffected by bg ws").toBe(0);

      // Also make ws1's pane needy → ws1's tab gets its OWN badge (count 1),
      // while ws2's badge stays at 1. Two independent per-tab badges.
      await H.probeStatus(page, {
        sourcePaneId: ws1Panes[0],
        origin: MOCK_ORIGIN,
        payload: { type: "status", dir: "/p", session: "s2", title: "fg", attention: "needs_reply", activity: "idle" },
      });
      await expect.poll(async () => H.needsYouFor(page, ws1), { timeout: 5000 }).toBe(1);
      await expect(page.locator(`[data-testid="ws-needs-you"][data-workspace="${ws1}"]`)).toHaveText("1");
      await expect(page.locator(`[data-testid="ws-needs-you"][data-workspace="${ws2}"]`)).toHaveText("1");
    });

    test("the badge updates when the pane's status changes (none → needy → none)", async ({ page }) => {
      const ws1 = (await H.workspaces(page))[0];
      const ws1Panes = await H.panes(page);
      const pane = ws1Panes[0];

      // No badge initially.
      await expect(page.locator(`[data-testid="ws-needs-you"][data-workspace="${ws1}"]`)).toHaveCount(0);

      // needy → badge appears with count 1.
      await H.probeStatus(page, {
        sourcePaneId: pane,
        origin: MOCK_ORIGIN,
        payload: { type: "status", dir: "", session: "s", title: "", attention: "needs_permission", activity: "idle" },
      });
      await expect.poll(async () => H.needsYouFor(page, ws1), { timeout: 5000 }).toBe(1);
      await expect(page.locator(`[data-testid="ws-needs-you"][data-workspace="${ws1}"]`)).toHaveText("1");

      // resolves → count drops to 0 → badge hidden.
      await H.probeStatus(page, {
        sourcePaneId: pane,
        origin: MOCK_ORIGIN,
        payload: { type: "status", dir: "", session: "s", title: "", attention: "none", activity: "idle" },
      });
      await expect.poll(async () => H.needsYouFor(page, ws1), { timeout: 5000 }).toBe(0);
      await expect(page.locator(`[data-testid="ws-needs-you"][data-workspace="${ws1}"]`)).toHaveCount(0);
    });

    test("two needy panes in one workspace show a single badge with count 2", async ({ page }) => {
      const ws1 = (await H.workspaces(page))[0];
      const [a, b] = (await H.panes(page)).slice(0, 2);

      await H.probeStatus(page, {
        sourcePaneId: a,
        origin: MOCK_ORIGIN,
        payload: { type: "status", dir: "", session: "a", title: "", attention: "needs_permission", activity: "idle" },
      });
      await H.probeStatus(page, {
        sourcePaneId: b,
        origin: MOCK_ORIGIN,
        payload: { type: "status", dir: "", session: "b", title: "", attention: "needs_reply", activity: "idle" },
      });
      await expect.poll(async () => H.needsYouFor(page, ws1), { timeout: 5000 }).toBe(2);
      await expect(page.locator(`[data-testid="ws-needs-you"][data-workspace="${ws1}"]`)).toHaveText("2");
    });
  });
});
