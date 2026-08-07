import { test, expect } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// iframe-survival regression gate — the load-bearing guarantee for the whole
// multi-server architecture.
//
// Moving/reparenting an <iframe> RELOADS it in current browsers. The host
// container MUST keep each iframe element permanently mounted (Dockview
// renderer:'always') and change only geometry/visibility. This spec proves
// every layout op preserves cross-origin iframe identity, and that the two
// reload-causing mistakes (naive remove+re-add; toJSON→fromJSON reswap) are
// DETECTED (identity changes).
//
// Runs on Chromium AND Firefox (see playwright.config.ts projects).
// =============================================================================

test.describe("iframe-survival regression gate", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  test("split keeps the source pane identity", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    const before = (await H.survival(page, a))!;
    const newId = await H.split(page, a, "right");
    expect(newId, "split created a new pane").toBeTruthy();
    await H.waitForReady(page, newId!);
    await H.assertSurvived(page, a, before, "split source");
  });

  test("swap keeps BOTH pane identities", async ({ page }) => {
    const ids = await H.panes(page);
    const [a, b] = [ids[0], ids[1]];
    const ba = (await H.survival(page, a))!;
    const bb = (await H.survival(page, b))!;
    await H.swap(page, a, b);
    await H.assertSurvived(page, a, ba, "swap pane A");
    await H.assertSurvived(page, b, bb, "swap pane B");
  });

  test("drag-rearrange (native sash resize) keeps identity", async ({ page }) => {
    test.setTimeout(60_000);
    const ids = await H.panes(page);
    const a = ids[0];
    const before = (await H.survival(page, a))!;
    const boxBefore = await H.groupBox(page, a);

    // Drag the first sash (the splitter between two grid panes). Native Dockview
    // pointer plumbing — the iframe must survive a geometry change. Sashes are
    // thin (4px); pick the first one with a real, grabbable bounding box.
    const sashes = page.locator(".dv-sash");
    const n = await sashes.count();
    expect(n, "at least one sash present").toBeGreaterThan(0);
    let sb: { x: number; y: number; width: number; height: number } | null = null;
    let horiz = true;
    for (let i = 0; i < n; i++) {
      const cand = sashes.nth(i);
      const b = await cand.boundingBox();
      if (b && b.width > 0 && b.height > 0) {
        sb = b;
        horiz = await cand.evaluate((el) => el.classList.contains("dv-horizontal"));
        break;
      }
    }
    expect(sb, "a grabbable sash is present").not.toBeNull();
    const dx = horiz ? 30 : 0;
    const dy = horiz ? 0 : 30;
    await page.mouse.move(sb!.x + sb!.width / 2, sb!.y + sb!.height / 2);
    await page.mouse.down();
    await page.mouse.move(sb!.x + sb!.width / 2 + dx, sb!.y + sb!.height / 2 + dy, { steps: 8 });
    await page.mouse.up();

    const boxAfter = await H.groupBox(page, a);
    expect(boxAfter, "group box present after drag").not.toBeNull();
    // The geometry may or may not have shifted (a maximized/at-limit sash may
    // not move), but the iframe identity MUST be intact regardless.
    await H.assertSurvived(page, a, before, "sash resize");
  });

  test("switch tab (focus another pane) keeps identity", async ({ page }) => {
    const ids = await H.panes(page);
    const [a, b] = [ids[0], ids[1]];
    const beforeA = (await H.survival(page, a))!;
    const beforeB = (await H.survival(page, b))!;
    // Click the 2nd top tabstrip tab to focus pane b. "switch tab" is a
    // survival-safe focus change (setActive), never a layout disposal.
    await page.locator('[data-testid="ws-tab"]').nth(1).click();
    await expect.poll(async () => H.focused(page)).toBe(b);
    await H.assertSurvived(page, a, beforeA, "switch-tab source");
    await H.assertSurvived(page, b, beforeB, "switch-tab target");
  });

  test("maximize + restore keeps identity", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    const before = (await H.survival(page, a))!;
    await H.maximize(page, a);
    await expect.poll(async () => H.isMaximized(page)).toBe(true);
    await H.assertSurvived(page, a, before, "maximize");
    await H.exitMaximized(page);
    await expect.poll(async () => H.isMaximized(page)).toBe(false);
    await H.assertSurvived(page, a, before, "restore-from-maximize");
  });

  test("collapse-to-tray + restore keeps identity", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    const before = (await H.survival(page, a))!;
    expect(await H.gridPaneCount(page), ">=2 grid panes to allow collapse").toBeGreaterThanOrEqual(2);
    await H.collapse(page, a);
    await expect.poll(async () => (await H.trayIds(page)).includes(a)).toBe(true);
    await H.assertSurvived(page, a, before, "collapse-to-tray");
    await H.restore(page, a);
    await expect.poll(async () => (await H.trayIds(page)).includes(a)).toBe(false);
    await H.assertSurvived(page, a, before, "restore-from-tray");
  });

  test("can't collapse the last visible pane", async ({ page }) => {
    const ids = await H.panes(page);
    // Close panes until only one grid pane remains.
    for (let i = 1; i < ids.length; i++) await H.closePane(page, ids[i]);
    await expect.poll(async () => H.gridPaneCount(page)).toBe(1);
    const last = (await H.panes(page))[0];
    const before = (await H.survival(page, last))!;
    await H.collapse(page, last); // guard: no-op
    await expect.poll(async () => H.trayIds(page)).toEqual([]);
    // identity unchanged (collapse was refused)
    await H.assertSurvived(page, last, before, "last-pane collapse refused");
  });

  // ---- negative controls: the gate must DETECT a real reload ---------------

  test("NEGATIVE: naive remove + re-add RELOADS the iframe", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    const before = (await H.survival(page, a))!;
    await H.naiveReload(page, a);
    await H.assertReloaded(page, a, before, "naive remove+re-add");
  });

  test("NEGATIVE: toJSON → fromJSON reswap RELOADS every iframe", async ({ page }) => {
    const ids = await H.panes(page);
    const snapshots = await Promise.all(ids.map(async (id) => ({ id, before: (await H.survival(page, id))! })));
    await H.jsonReswap(page);
    for (const { id, before } of snapshots) {
      await H.assertReloaded(page, id, before, `jsonReswap pane ${id}`);
    }
  });
});
