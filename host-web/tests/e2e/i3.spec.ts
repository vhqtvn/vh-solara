import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as H from "./util";

/**
 * Phase 1 i3 host-shell — feature e2e (items 2-7, minus the dropped keyboard
 * shortcuts) + vision screenshots.
 *
 * The Alt-based host keyboard shortcuts (Item 4) were REMOVED in favor of the
 * SPA gesture → host overlay model (the host cannot see keys inside a cross-
 * origin iframe). The gesture/overlay interaction is covered by
 * interaction-overlay.spec.ts; this file keeps the layout-mode / persistence /
 * statusbar / popover coverage that remains valid.
 *
 * One test per feature, each capturing a screenshot at the key state under
 * tmp/host-web-playwright/vision/i3/ (gitignored). Item 1 (workspace tabstrip)
 * is covered in depth by workspace-tabs.spec.ts; this file references it only
 * for the survival-safe switch crux.
 *
 * The suite is serial (host-web playwright.config.ts: workers:1). Each test
 * calls loadHost in beforeEach for a fresh page + seeded panes.
 */

const REPO_ROOT = path.resolve(process.cwd(), "..");
const VISION_DIR = path.join(REPO_ROOT, "tmp/host-web-playwright/vision/i3");

test.beforeAll(() => {
  fs.mkdirSync(VISION_DIR, { recursive: true });
});

const MOCK_ORIGIN = "http://127.0.0.1:5174";

test.describe("i3 host-shell Phase 1", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  // ---- Item 2: per-pane headers REMOVED (content + focus-border only) --------
  test("per-pane headers removed; panes are content + focus-border", async ({ page }) => {
    // No header / actions / brand / badges in any pane.
    await expect(page.locator(".pane-header")).toHaveCount(0);
    await expect(page.locator(".pane-actions")).toHaveCount(0);
    await expect(page.locator(".pane-brand")).toHaveCount(0);
    await expect(page.locator(".pane-btn")).toHaveCount(0);
    await expect(page.locator('[data-testid="pane-split-right"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="pane-close"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="pane-status-badge"]')).toHaveCount(0);

    // Each pane is a body + iframe.
    const panes = page.locator(".pane");
    const count = await panes.count();
    expect(count).toBeGreaterThanOrEqual(2);
    for (let i = 0; i < count; i++) {
      await expect(panes.nth(i).locator(".pane-body")).toHaveCount(1);
      await expect(panes.nth(i).locator("iframe.pane-iframe")).toHaveCount(1);
    }

    // Focus border: focusing a pane adds the .is-active class (outline).
    const ids = await H.panes(page);
    await H.focusPane(page, ids[0]);
    await expect.poll(async () => H.focused(page)).toBe(ids[0]);
    // Exactly one pane is active (the focused one).
    await expect.poll(async () => page.locator(".pane.is-active").count()).toBe(1);

    await page.screenshot({ path: path.join(VISION_DIR, "02-no-headers.png"), fullPage: true });
  });

  // ---- Item 3: statusbar control cluster + focused-pane identity ------------
  test("statusbar carries focused-pane identity + control cluster", async ({ page }) => {
    const cluster = page.locator('[data-testid="i3-controls"]');
    await expect(cluster).toBeVisible();

    // Each control button is present + enabled (a pane is focused after load).
    for (const tid of ["i3-split-h", "i3-split-v", "i3-tabbed", "i3-stacked", "i3-zoom", "i3-close"]) {
      const btn = page.locator(`[data-testid="${tid}"]`);
      await expect(btn).toBeVisible();
      await expect(btn).toBeEnabled();
    }

    // Focused-pane identity line: "focus: <label>".
    const ids = await H.panes(page);
    const params = await H.paneParams(page);
    const focusedId = await H.focused(page);
    const focusedLabel = params.find((p) => p.id === focusedId)?.label ?? params[0].label;
    await expect(page.locator('[data-testid="statusbar"]')).toContainText(`focus: ${focusedLabel}`);

    // Split via the cluster adds a pane; the focus line follows the new pane.
    const before = ids.length;
    await page.locator('[data-testid="i3-split-h"]').click();
    await expect.poll(async () => (await H.panes(page)).length).toBe(before + 1);

    await page.screenshot({ path: path.join(VISION_DIR, "03-statusbar-cluster.png"), fullPage: true });
  });

  // ---- Item 5: i3 layout modes (split-h / split-v / tabbed / stacked) --------
  test("layout modes: split-h/split-v geometry + tabbed/stacked native strip; survival across mode change", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];

    // --- split-h: two panes side by side (split-right default). Seed a second
    //     pane split off a, then assert their group boxes are left/right.
    const b = await H.split(page, a, "right");
    expect(b).not.toBeNull();
    await H.waitForReady(page, b!);
    const boxA = await H.groupBox(page, a);
    const boxB = await H.groupBox(page, b!);
    expect(boxA).not.toBeNull();
    expect(boxB).not.toBeNull();
    // side-by-side: b is to the right of a (b.left >= a.right - epsilon).
    expect(boxB!.left, "b is right of a (split-h)").toBeGreaterThanOrEqual(boxA!.left + boxA!.width - 8);
    expect(boxB!.top, "same row").toBeLessThan(boxA!.top + boxA!.height);

    // --- tabbed: dock b into a's group → one group with two panels. The native
    //     tab strip is un-hidden by CSS for multi-panel groups (:has rule in
    //     dockviewOverrides.css); the grouping is asserted via sameGroup +
    //     groupOf.panelCount. setLayoutMode tabbed sets headerPosition 'top'.
    await H.dockAsTab(page, b!, a);
    await expect.poll(async () => H.sameGroup(page, a, b!)).toBe(true);
    await H.setLayoutModeBridge(page, a, "tabbed");
    // The group header position is 'top' + the group now holds both panels.
    const gTabbed = await H.groupOf(page, a);
    expect(gTabbed?.headerPosition).toBe("top");
    expect(gTabbed?.panelCount).toBe(2);

    // --- SURVIVAL crux (Gate 1 passed): the iframe survives the mode change.
    //     Capture identity after docking (pre-mode), set stacked, re-capture.
    const beforeStacked = await H.survival(page, a);
    expect(beforeStacked).not.toBeNull();
    await H.setLayoutModeBridge(page, a, "stacked");
    const gStacked = await H.groupOf(page, a);
    expect(gStacked?.headerPosition, "stacked → header left").toBe("left");
    await H.assertSurvived(page, a, beforeStacked!, "pane across tabbed→stacked mode change");

    // --- split-v: break the tabbed group out stacked-vertically. Re-dock first
    //     (split-h break-out left them separate), then split-v.
    await H.dockAsTab(page, b!, a);
    await expect.poll(async () => H.sameGroup(page, a, b!)).toBe(true);
    const beforeSplitV = await H.survival(page, a);
    await H.setLayoutModeBridge(page, a, "split-v");
    // After break-out, a and b are in SEPARATE groups stacked vertically.
    await expect.poll(async () => H.sameGroup(page, a, b!)).toBe(false);
    const boxA2 = await H.groupBox(page, a);
    const boxB2 = await H.groupBox(page, b!);
    expect(boxA2).not.toBeNull();
    expect(boxB2).not.toBeNull();
    expect(boxB2!.top, "b is below a (split-v)").toBeGreaterThan(boxA2!.top + boxA2!.height - 8);
    await H.assertSurvived(page, a, beforeSplitV!, "pane across tabbed→split-v break-out");

    await page.screenshot({ path: path.join(VISION_DIR, "05-layout-modes.png"), fullPage: true });
  });

  // ---- Item 6: split-orientation persistence (vertical survives reload) -----
  test("persistence round-trip: a vertical split survives reload as vertical", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];

    // Create a VERTICAL split (split-down → two groups stacked vertically).
    // Pane ids are preserved across cold restore (fromJSON reuses saved ids),
    // so a and b are locatable after reload.
    const b = await H.split(page, a, "down");
    expect(b).not.toBeNull();
    await H.waitForReady(page, b!);

    // Capture geometry BEFORE reload: b is below a (vertical), not to the right.
    const before = await captureOrientation(page, a, b!);
    expect(before.bBelow, "pre-reload: b is below a (vertical split)").toBe(true);

    // Wait for the debounced save to flush to localStorage + the URL hash.
    await H.waitForSavedLayout(page, (await H.panes(page)).length);

    // Reload (cold restore path). Pane ids survive.
    await page.reload();
    await expect.poll(async () => H.connected(page), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await H.panes(page)).includes(a), { timeout: 20_000 }).toBe(true);
    await expect.poll(async () => (await H.panes(page)).includes(b!), { timeout: 20_000 }).toBe(true);
    await H.waitForReady(page, a);
    await H.waitForReady(page, b!);

    // The restored layout is STILL a vertical split (b below a), not horizontal.
    const after = await captureOrientation(page, a, b!);
    expect(after.bBelow, "post-reload: vertical split PRESERVED").toBe(true);
    expect(after.bRight, "post-reload: NOT horizontal").toBe(false);

    await page.screenshot({ path: path.join(VISION_DIR, "06-persistence.png"), fullPage: true });
  });

  // ---- Item 7: AddServer popover opens when tabs are present ----------------
  test("AddServer popover opens with workspace tabs present", async ({ page }) => {
    // Preconditions: at least one ws-tab is present (default workspace) AND at
    // least one pane exists (seeded). The bug: + did not open when tabs existed.
    await expect(page.locator('[data-testid="ws-tab"]')).toHaveCount(1);
    expect((await H.panes(page)).length).toBeGreaterThanOrEqual(1);

    // Click + : the popover opens.
    const trigger = page.locator('[data-testid="add-server-btn"]');
    await trigger.click();
    await expect(page.locator('[data-testid="add-server-popover"]')).toBeVisible();

    // Toggle closed (click the trigger again) + reopen: still opens reliably
    // (the toggle is not one-shot, and re-opening is not blocked by tabs).
    await trigger.click();
    await expect(page.locator('[data-testid="add-server-popover"]')).toHaveCount(0);
    await trigger.click();
    await expect(page.locator('[data-testid="add-server-popover"]')).toBeVisible();

    await page.screenshot({ path: path.join(VISION_DIR, "07-popover.png"), fullPage: true });
  });
});

/** Capture the relative orientation of two panes (bBelow / bRight) from their
 *  live group bounding boxes. Used to assert split-v (bBelow) vs split-h (bRight)
 *  survives a reload. */
async function captureOrientation(
  page: import("@playwright/test").Page,
  a: string,
  b: string,
): Promise<{ bBelow: boolean; bRight: boolean }> {
  const ba = await H.groupBox(page, a);
  const bb = await H.groupBox(page, b);
  if (!ba || !bb) return { bBelow: false, bRight: false };
  const bBelow = bb.top > ba.top + ba.height - 8; // b starts below a's bottom edge
  const bRight = bb.left > ba.left + ba.width - 8; // b starts right of a's right edge
  return { bBelow, bRight };
}
