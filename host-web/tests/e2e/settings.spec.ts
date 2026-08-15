import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as H from "./util";

// =============================================================================
// Settings popover + AddServer catalog click-to-prefill (one host-chrome slice).
//
// Part 1 — the tabstrip SETTINGS gear (host-web/src/shell/Settings.tsx): the
// host's only settings surface (statusbar + per-pane headers are gone). Menu
// items: "Reload page" (location.reload — the post-deploy refresh path) and
// "Auto-rotate layout" (the vh-host:autotranspose localStorage toggle, which
// had NO UI until now). All assertions drive the REAL UI, not the DEV bridge;
// the toggle's effect is proven LIVE (a resize flip gated by the UI toggle,
// no reload), which works because viewportShape.applyTranspose re-reads the
// key on every evaluation.
//
// Part 2 — AddServer catalog click-to-prefill: clicking a catalog row fills
// the url+label inputs (focus + select-all on the URL); the × remove button
// must NOT prefill (stopPropagation).
//
// Vision screenshots land under tmp/host-web-playwright/vision/settings/
// (gitignored). Serial suite (config: workers 1); each test clears persisted
// state in beforeEach so the auto-transpose key starts ABSENT (default ON)
// and no prior layout leaks in — same defensive pattern as
// viewport-shape.spec.ts.
// =============================================================================

const REPO_ROOT = path.resolve(process.cwd(), "..");
const VISION_DIR = path.join(REPO_ROOT, "tmp/host-web-playwright/vision/settings");

test.beforeAll(() => {
  fs.mkdirSync(VISION_DIR, { recursive: true });
});

// Viewport sizes matching viewport-shape.spec.ts (classifyShape bands:
// h/w>1.2 → tall; w/h>1.2 → wide).
const WIDE = { width: 1024, height: 640 };
const TALL = { width: 400, height: 800 };

// The mock content page origin (:5174) — same as server-mgmt.spec.ts.
const MOCK_ORIGIN = "http://127.0.0.1:5174";
function serverUrl(server: string): string {
  const q = new URLSearchParams({ server, view: "chat" });
  return `${MOCK_ORIGIN}/?${q.toString()}`;
}

/** Open the settings popover and wait for it to be visible. */
async function openSettings(page: Page): Promise<void> {
  await page.locator('[data-testid="settings-btn"]').click();
  await expect(page.locator('[data-testid="settings-popover"]')).toBeVisible();
}

/** Open the add-server popover and return locators for its inputs. */
async function openAddServer(page: Page): Promise<void> {
  await page.locator('[data-testid="add-server-btn"]').click();
  await expect(page.locator('[data-testid="add-server-popover"]')).toBeVisible();
}

async function fillAndSubmit(page: Page, url: string, label: string): Promise<void> {
  await page.locator('[data-testid="add-server-url"]').fill(url);
  await page.locator('[data-testid="add-server-label"]').fill(label);
  await page.locator('[data-testid="add-server-submit"]').click();
}

/** Reduce the seeded grid to exactly TWO side-by-side panes (HORIZONTAL) —
 *  same helper as viewport-shape.spec.ts. Returns [keeper, newPane]. */
async function twoPanes(page: Page): Promise<[string, string]> {
  const seeded = await H.panes(page);
  const keeper = seeded[0];
  for (const id of seeded.slice(1)) await H.closePane(page, id);
  await H.waitForReady(page, keeper);
  const other = await H.split(page, keeper, "right");
  expect(other, "split created a second pane").toBeTruthy();
  await H.waitForReady(page, other!);
  return [keeper, other!];
}

test.describe("settings popover", () => {
  test.beforeEach(async ({ page }) => {
    // Clear persisted state so the auto-transpose key starts ABSENT (toggle
    // default ON) and no prior test's saved layout leaks in.
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await H.loadHost(page);
  });

  test("gear opens the popover; Escape closes; click-outside closes", async ({ page }) => {
    const btn = page.locator('[data-testid="settings-btn"]');
    await expect(btn).toHaveAttribute("aria-haspopup", "menu");
    await expect(btn).toHaveAttribute("aria-expanded", "false");

    await openSettings(page);
    await expect(btn).toHaveAttribute("aria-expanded", "true");
    // Both menu items render with their roles.
    await expect(page.locator('[data-testid="settings-reload"]')).toHaveAttribute("role", "menuitem");
    await expect(page.locator('[data-testid="settings-autorotate"]')).toHaveAttribute(
      "role",
      "menuitemcheckbox",
    );

    // Escape closes.
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="settings-popover"]')).toBeHidden();
    await expect(btn).toHaveAttribute("aria-expanded", "false");

    // Click-outside closes: open again, then tap ANOTHER tabstrip control
    // (the AddServer trigger — a real sibling-chrome outside tap; it opens
    // the AddServer popover as its own side effect).
    await openSettings(page);
    await page.locator('[data-testid="add-server-btn"]').click();
    await expect(page.locator('[data-testid="settings-popover"]')).toBeHidden();
    await expect(page.locator('[data-testid="add-server-popover"]')).toBeVisible();
  });

  test("Reload page item reloads the document", async ({ page }) => {
    await openSettings(page);
    // Install the load listener BEFORE the click so the reload cannot race
    // it. location.reload() is a real navigation → a fresh 'load' event; if
    // the item were not wired to reload, this times out.
    const loadPromise = page.waitForEvent("load", { timeout: 10_000 });
    await page.locator('[data-testid="settings-reload"]').click();
    await loadPromise;
    // The host re-seeds after the reload (document was replaced).
    await expect.poll(async () => H.connected(page), { timeout: 20_000 }).toBe(true);
  });

  test("auto-rotate toggle round-trips localStorage + popover state", async ({ page }) => {
    const KEY = H.AUTOTRANSPOSE_STORAGE_KEY;
    const item = page.locator('[data-testid="settings-autorotate"]');

    // Key absent → default ON, checkbox checked.
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBeNull();
    await openSettings(page);
    await expect(item).toHaveAttribute("aria-checked", "true");
    await page.screenshot({
      path: path.join(VISION_DIR, "01-settings-autorotate-on.png"),
      fullPage: true,
    });

    // Click → key "off", checkbox reflects it in-place.
    await item.click();
    await expect
      .poll(() => page.evaluate((k) => localStorage.getItem(k), KEY))
      .toBe("off");
    await expect(item).toHaveAttribute("aria-checked", "false");

    // Close + reopen → the popover re-reads the persisted state (not a stale
    // in-memory copy).
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="settings-popover"]')).toBeHidden();
    await openSettings(page);
    await expect(item).toHaveAttribute("aria-checked", "false");
    await page.screenshot({
      path: path.join(VISION_DIR, "02-settings-autorotate-off.png"),
      fullPage: true,
    });

    // Toggle back on (leave the shared default in place).
    await item.click();
    await expect
      .poll(() => page.evaluate((k) => localStorage.getItem(k), KEY))
      .toBe("on");
    await expect(item).toHaveAttribute("aria-checked", "true");
  });

  test("auto-rotate applies LIVE: UI toggle gates the resize flip (no reload)", async ({ page }) => {
    // Known wide baseline with exactly two side-by-side panes.
    await page.setViewportSize(WIDE);
    const [a, b] = await twoPanes(page);
    expect(await H.gridPaneCount(page), "exactly 2 grid panes").toBe(2);
    await H.waitForSideBySide(page, a, b);
    expect(await H.viewportOrientation(page), "wide baseline = HORIZONTAL").toBe("HORIZONTAL");
    const ba = (await H.survival(page, a))!;
    const bb = (await H.survival(page, b))!;

    // Toggle OFF via the UI (default ON → OFF), close the popover, resize to
    // portrait. The evaluation runs but short-circuits: NO flip.
    await openSettings(page);
    await page.locator('[data-testid="settings-autorotate"]').click();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="settings-popover"]')).toBeHidden();
    const flipsBefore = await H.viewportFlipCount(page);

    await page.setViewportSize(TALL);
    await page.waitForTimeout(400); // past DEBOUNCE_MS (200) + settle
    await H.waitForSideBySide(page, a, b); // still HORIZONTAL
    expect(await H.viewportOrientation(page), "still HORIZONTAL (toggled off)").toBe("HORIZONTAL");
    expect(await H.viewportFlipCount(page), "no flip while toggled off").toBe(flipsBefore);

    // Toggle ON via the UI — LIVE: no reload happened. The viewport is still
    // tall; one synthetic resize event (deterministic, dimensions unchanged)
    // triggers the evaluation, which now flips to VERTICAL.
    await openSettings(page);
    await page.locator('[data-testid="settings-autorotate"]').click();
    await page.keyboard.press("Escape");
    await H.dispatchResize(page);
    await H.waitForStacked(page, a, b);
    expect(await H.viewportOrientation(page), "flipped to VERTICAL (toggled on)").toBe("VERTICAL");
    expect(await H.viewportFlipCount(page), "exactly one flip after re-enabling").toBe(
      flipsBefore + 1,
    );

    // Both iframes kept their identity across the UI-gated flip.
    await H.assertSurvived(page, a, ba, "live-toggle pane A");
    await H.assertSurvived(page, b, bb, "live-toggle pane B");
  });
});

test.describe("add-server catalog click-to-prefill", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  /** Seed the catalog with TWO servers via the real form flow; leaves the
   *  popover open with the SECOND server's url prefilled (the post-submit
   *  re-prefill) and an outcome line showing. Returns the two {url,label}. */
  async function seedTwoServers(
    page: Page,
  ): Promise<[{ url: string; label: string }, { url: string; label: string }]> {
    const base = (await H.panes(page)).length;
    const one = { url: serverUrl("prefill-one"), label: "prefill-one" };
    const two = { url: serverUrl("prefill-two"), label: "prefill-two" };
    await openAddServer(page);
    await fillAndSubmit(page, one.url, one.label);
    await expect.poll(async () => (await H.panes(page)).length).toBe(base + 1);
    await fillAndSubmit(page, two.url, two.label);
    await expect.poll(async () => (await H.panes(page)).length).toBe(base + 2);
    // Both rows are in the catalog.
    await expect(page.locator(`[data-testid="server-row"][data-url="${one.url}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-testid="server-row"][data-url="${two.url}"]`)).toHaveCount(1);
    return [one, two];
  }

  test("clicking a catalog row prefills url + label, focuses + selects the url", async ({ page }) => {
    const [one, two] = await seedTwoServers(page);

    // Post-submit state: url = the just-added pane's url (two), label empty,
    // an outcome line is showing. Clicking row `one` must CHANGE the values.
    await expect(page.locator('[data-testid="add-server-url"]')).toHaveValue(two.url);
    await expect(page.locator('[data-testid="add-server-outcome"]')).toBeVisible();

    await page.locator(`[data-testid="server-row"][data-url="${one.url}"]`).click();

    // The form carries the row's {url,label}…
    await expect(page.locator('[data-testid="add-server-url"]')).toHaveValue(one.url);
    await expect(page.locator('[data-testid="add-server-label"]')).toHaveValue(one.label);
    // …the error/outcome text cleared…
    await expect(page.locator('[data-testid="add-server-outcome"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="add-server-error"]')).toHaveCount(0);
    // …and the URL input is focused with the value fully selected.
    const focusState = await page.evaluate(() => {
      const el = document.activeElement;
      return {
        testid: el?.getAttribute("data-testid") ?? null,
        selStart: el instanceof HTMLInputElement ? el.selectionStart : null,
        selEnd: el instanceof HTMLInputElement ? el.selectionEnd : null,
      };
    });
    expect(focusState.testid, "URL input focused").toBe("add-server-url");
    expect(focusState.selStart, "url select-all start").toBe(0);
    expect(focusState.selEnd, "url select-all end").toBe(one.url.length);

    await page.screenshot({
      path: path.join(VISION_DIR, "03-addserver-prefilled.png"),
      fullPage: true,
    });
  });

  test("removing via × does not prefill the form", async ({ page }) => {
    const [one, two] = await seedTwoServers(page);
    const base = (await H.panes(page)).length;

    // Prefill from row `one` first, so "untouched" is observable.
    await page.locator(`[data-testid="server-row"][data-url="${one.url}"]`).click();
    await expect(page.locator('[data-testid="add-server-url"]')).toHaveValue(one.url);
    await expect(page.locator('[data-testid="add-server-label"]')).toHaveValue(one.label);

    // Remove `two` via its × — must NOT overwrite the form.
    await page.locator(`[data-testid="remove-server"][data-url="${two.url}"]`).click();
    await expect(page.locator(`[data-testid="server-row"][data-url="${two.url}"]`)).toHaveCount(0);
    await expect.poll(async () => (await H.panes(page)).length).toBe(base - 1);

    // The form still holds row `one`'s values (removal did not prefill).
    await expect(page.locator('[data-testid="add-server-url"]')).toHaveValue(one.url);
    await expect(page.locator('[data-testid="add-server-label"]')).toHaveValue(one.label);
    await expect(page.locator(`[data-testid="server-row"][data-url="${one.url}"]`)).toHaveCount(1);
  });
});
