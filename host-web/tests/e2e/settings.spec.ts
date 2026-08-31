import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as H from "./util";

// =============================================================================
// Settings popover + AddServer catalog click-to-prefill (one host-chrome slice).
//
// Part 1 — the tabstrip SETTINGS gear (host-web/src/shell/Settings.tsx): the
// host's only settings surface (statusbar + per-pane headers are gone). Menu
// items: "Edit layout…" (opens the layout overlay for the FOCUSED pane through
// the production HostOps path — the host-side no-gesture fallback the statusbar
// removal in aa244b3 had orphaned; aria-disabled + no-op when no pane is
// focused; renamed from "Layout…" in the de-confusion slice — the manager
// formerly "Layouts…" now lives in its own tabstrip Layouts popover, see
// named-layouts.spec.ts), "Reload page" (location.reload — the post-deploy
// refresh path) and "Auto-rotate layout" (the vh-host:autotranspose
// localStorage toggle, which had NO UI until now). All assertions drive the
// REAL UI, not the DEV bridge; the toggle's effect is proven LIVE (a resize
// flip gated by the UI toggle, no reload), which works because
// viewportShape.applyTranspose re-reads the key on every evaluation.
//
// Part 2 — AddServer catalog click-to-prefill: clicking a catalog row fills
// the url+label inputs (focus + select-all on the URL); the × remove button
// must NOT prefill (siblings — no propagation path).
//
// Part 3 — the shared surface stack (host-web/src/shell/popover.ts): the
// tabstrip popovers are mutually exclusive (AddServer-then-gear must not
// leave both forms open), and Escape dismisses only the TOPMOST surface (the
// app-like back-navigation principle from f7bba45 — one Escape, one surface,
// even with the layout overlay also open).
//
// Vision screenshots land under tmp/host-web-playwright/vision/settings/
// (gitignored). Serial suite (config: workers 1); each test clears persisted
// state via addInitScript BEFORE the single app boot, so the auto-transpose
// key starts ABSENT (default ON) and no prior layout leaks in — no discarded
// first boot.
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

/** Open the settings popover and wait for it to be visible. */
async function openSettings(page: Page): Promise<void> {
  await page.locator('[data-testid="settings-btn"]').click();
  await expect(page.locator('[data-testid="settings-popover"]')).toBeVisible();
}

test.describe("settings popover", () => {
  test.beforeEach(async ({ page }) => {
    // Clear persisted state BEFORE the app boots: addInitScript runs on the
    // (single) loadHost navigation, before any app script, so the
    // auto-transpose key starts ABSENT (toggle default ON) and no prior
    // test's saved layout leaks in. This replaces the old goto('/') +
    // localStorage.clear() + loadHost double-boot — one full app boot
    // (mock iframe fleet included) used to be discarded per test purely to
    // clear storage, racing the first boot's debounced layout save.
    await page.addInitScript(() => localStorage.clear());
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

  test("AddServer-then-gear: the gear closes AddServer — never both forms at once", async ({ page }) => {
    // The ordering the old suite never exercised: AddServer FIRST, then the
    // gear. AddServer used to have NO outside-click/Escape dismissal, so
    // both popovers stayed open and Settings covered ~246px of the AddServer
    // form (its controls still tabbable underneath). The shared surface
    // stack's tabstrip group makes them mutually exclusive.
    const addBtn = page.locator('[data-testid="add-server-btn"]');
    await H.openAddServer(page);
    await expect(addBtn).toHaveAttribute("aria-expanded", "true");

    await page.locator('[data-testid="settings-btn"]').click();

    // Exactly one tabstrip popover: Settings open, AddServer GONE (the form
    // unmounts with <Show>, so no control stays visible or tabbable).
    await expect(page.locator('[data-testid="settings-popover"]')).toBeVisible();
    await expect(page.locator('[data-testid="settings-popover"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="add-server-popover"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="add-server-url"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="add-server-label"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="server-catalog"]')).toHaveCount(0);
    await expect(addBtn).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator('[data-testid="settings-btn"]')).toHaveAttribute("aria-expanded", "true");
  });

  test("Escape dismisses only the TOPMOST surface (app-like back navigation)", async ({ page }) => {
    const pane = (await H.panes(page))[0];

    // Settings open, then the layout overlay on top of it. Both surfaces
    // coexist (the overlay's capture layer covers only <main>, so the
    // tabstrip gear stays clickable) — the exact reachable state where one
    // Escape used to close BOTH.
    await openSettings(page);
    await H.openLayoutOverlay(page, pane);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    await expect(page.locator('[data-testid="settings-popover"]')).toBeVisible();

    // ONE Escape → only the topmost (the overlay, opened last) closes.
    await page.keyboard.press("Escape");
    await expect.poll(async () => H.overlaySource(page)).toBeNull();
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="settings-popover"]')).toBeVisible();

    // The next Escape dismisses the next surface (Settings) — LIFO unwind.
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="settings-popover"]')).toHaveCount(0);

    // Reverse open order → reverse dismissal: overlay first, then Settings
    // (the gear is reachable while the overlay is open) makes Settings the
    // topmost, so the FIRST Escape takes Settings and spares the overlay.
    await H.openLayoutOverlay(page, pane);
    await openSettings(page);
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="settings-popover"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toHaveCount(0);
  });

  test("Edit layout… item opens the layout overlay for the focused pane", async ({ page }) => {
    // Two+ panes; focus the SECOND so the anchor is distinguishable from the
    // boot default (seed focuses the first pane).
    const ids = await H.panes(page);
    expect(ids.length, "seeded fleet present").toBeGreaterThanOrEqual(2);
    const target = ids[1];
    await H.focusPane(page, target);
    await expect.poll(async () => H.focused(page)).toBe(target);
    // The focused pane's label — the overlay card's "Layout: <label>" identity
    // must reflect exactly this (labels are pairwise non-substring: distinct
    // server · view pairs).
    const params = await H.paneParams(page);
    const label = params.find((p) => p.id === target)!.label;

    await openSettings(page);
    const item = page.locator('[data-testid="settings-layout"]');
    // Renders as an enabled menuitem (a pane IS focused) — FIRST in the menu.
    await expect(item).toHaveAttribute("role", "menuitem");
    await expect(item).not.toHaveAttribute("aria-disabled", "true");
    await expect(item).toHaveText(/Edit layout…/);

    await item.click();

    // The settings popover CLOSED (surface handoff — the layout overlay is the
    // next surface; never two popovers at once)…
    await expect(page.locator('[data-testid="settings-popover"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="settings-btn"]')).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // …and the overlay opened anchored to the FOCUSED pane.
    await expect.poll(async () => H.overlaySource(page)).toBe(target);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toContainText(label);
    await expect(
      page.locator(`.pane[data-pane-id="${target}"].is-overlay-source`),
    ).toHaveCount(1);

    await page.screenshot({
      path: path.join(VISION_DIR, "04-settings-layout-open.png"),
      fullPage: true,
    });
  });

  test("Edit layout… is aria-disabled + a no-op when no pane is focused (empty workspace)", async ({ page }) => {
    // Close every pane → empty workspace → nothing focused.
    const ids = await H.panes(page);
    for (const id of ids) {
      await H.closePane(page, id);
    }
    await expect.poll(async () => H.gridPaneCount(page)).toBe(0);
    expect(await H.focused(page), "no focused pane on empty workspace").toBeNull();

    await openSettings(page);
    const item = page.locator('[data-testid="settings-layout"]');
    await expect(item).toHaveAttribute("aria-disabled", "true");

    // Clicking is a FULL no-op: no overlay opens, and the popover STAYS open
    // (the disabled guard runs before the close-after-run handoff, so the
    // operator can still pick another entry). force: the item is deliberately
    // NOT natively disabled (aria-disabled keeps it focusable/discoverable),
    // but Playwright's actionability check refuses to plain-click an
    // aria-disabled element — force dispatches the REAL pointer/click sequence
    // through the actual event path, so the no-op guard in activate() is what
    // is exercised.
    await item.click({ force: true });
    await expect(page.locator('[data-testid="settings-popover"]')).toBeVisible();
    expect(await H.overlaySource(page), "overlay not opened").toBeNull();
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toHaveCount(0);

    await page.screenshot({
      path: path.join(VISION_DIR, "05-settings-layout-disabled.png"),
      fullPage: true,
    });
  });

  test("Edit layout… flips aria-disabled LIVE while the popover stays open (focusedId → null via pane closes)", async ({ page }) => {
    // The item's disabled state reads the focusedId() SIGNAL inside the JSX
    // class/aria-disabled expressions (not a snapshot taken at open), so a
    // focusedId change while the popover is OPEN must flip the item in place
    // — no close/reopen. The bridge closePane path drives focusedId to null
    // the same way a real pane close does (unregisterPane → setFocusedId).
    await openSettings(page);
    const item = page.locator('[data-testid="settings-layout"]');
    await expect(item).not.toHaveAttribute("aria-disabled", "true");

    // Close every pane through the bridge — the popover is NOT surface-managed
    // by pane lifecycle, so it stays open through the mutation.
    const ids = await H.panes(page);
    for (const id of ids) {
      await H.closePane(page, id);
    }
    await expect.poll(async () => H.gridPaneCount(page)).toBe(0);
    expect(await H.focused(page), "no focused pane after the closes").toBeNull();

    // The STILL-OPEN popover's item is now disabled — auto-waiting assertion,
    // so a lazy (non-reactive) implementation fails on timeout, not silently.
    await expect(item).toHaveAttribute("aria-disabled", "true");
    await expect(page.locator('[data-testid="settings-popover"]')).toBeVisible();
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

  test("auto-rotate checkmark tracks EXTERNAL writers live (never stale while open)", async ({ page }) => {
    const KEY = H.AUTOTRANSPOSE_STORAGE_KEY;
    const item = page.locator('[data-testid="settings-autorotate"]');

    await openSettings(page);
    await expect(item).toHaveAttribute("aria-checked", "true");

    // Same-document external writer — the DEV bridge (__hostViewport.setEnabled
    // routes through setAutoTranspose, which now refreshes the reactive
    // mirror). The old hand-synced signal re-read storage only on OPEN, so
    // this write left a stale checkmark until close/reopen.
    await H.setViewportEnabled(page, false);
    await expect(item).toHaveAttribute("aria-checked", "false");
    expect(await page.evaluate((k) => localStorage.getItem(k), KEY)).toBe("off");

    // Cross-document writer — a second tab on this origin. The storage event
    // the reactive mirror listens for fires only in NON-writer documents, so
    // a same-document write alone cannot prove the listener; dispatch it
    // synthetically around a REAL localStorage write (the same precedent as
    // dispatchResize).
    await page.evaluate((k) => {
      localStorage.setItem(k, "on");
      window.dispatchEvent(new StorageEvent("storage", { key: k }));
    }, KEY);
    await expect(item).toHaveAttribute("aria-checked", "true");
  });

  test("auto-rotate applies LIVE: UI toggle gates the resize flip (no reload)", async ({ page }) => {
    // Known wide baseline with exactly two side-by-side panes.
    await page.setViewportSize(WIDE);
    const [a, b] = await H.twoPanes(page);
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

  test("Copy layout diagnostics: clipboard payload carries the ring JSON; denial falls back to a selected textarea", async ({
    page,
  }) => {
    // The evidence-collection path for the on-device PWA relaunch loss
    // (2026-08-31 diagnosis-first slice). The diag ring (layoutDiag.ts) is
    // always-on and persisted; this Settings action is the operator's one-tap
    // export. The beforeEach's localStorage.clear() means this boot's ring
    // holds exactly the fresh-boot fingerprint: read(source:none) + seed.
    await openSettings(page);

    // Stub the async clipboard (capture writes). The REAL menu item + REAL
    // copy handler run; only the browser clipboard is stubbed.
    await page.evaluate(() => {
      const w = window as unknown as { __diagCaptures?: string[] };
      w.__diagCaptures = [];
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: (t: string) => {
            w.__diagCaptures!.push(t);
            return Promise.resolve();
          },
        },
      });
    });

    await page.locator('[data-testid="settings-copy-diag"]').click();
    await expect(page.locator('[data-testid="settings-copy-diag-hint"]')).toHaveText(
      "Copied to clipboard ✓",
    );
    // No fallback textarea on the success path.
    await expect(page.locator('[data-testid="settings-diag-textarea"]')).toHaveCount(0);

    const payload = await page.evaluate(
      () => (window as unknown as { __diagCaptures?: string[] }).__diagCaptures?.[0] ?? "",
    );
    expect(payload, "exactly one clipboard write happened").not.toBe("");
    const events = JSON.parse(payload) as Array<{ kind: string; source?: string }>;
    expect(Array.isArray(events), "payload is the ring JSON array").toBe(true);
    const kinds = events.map((e) => e.kind);
    expect(kinds, "fresh-boot fingerprint: read + seed events").toContain("read");
    expect(kinds).toContain("seed");
    const read = events.find((e) => e.kind === "read");
    expect(read?.source).toBe("none");

    // ---- DENIAL path: make writeText reject; the copy falls back to staging
    // the ring JSON into a readonly textarea and selecting it (browsers without
    // the async clipboard / denied permission — e.g. the operator's non-secure
    // LAN origin).
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: () => Promise.reject(new Error("denied")),
        },
      });
    });
    await page.locator('[data-testid="settings-copy-diag"]').click();
    await expect(page.locator('[data-testid="settings-diag-textarea"]')).toBeVisible();
    await expect(page.locator('[data-testid="settings-copy-diag-hint"]')).toHaveText(
      "Selected below — copy from the text box",
    );
    // The textarea holds the ring JSON and ALL of it is selected (the
    // pwa-probe select-all fallback).
    await expect
      .poll(() =>
        page.evaluate(() => {
          const ta = document.querySelector(
            '[data-testid="settings-diag-textarea"]',
          ) as HTMLTextAreaElement | null;
          if (!ta || !ta.value) return false;
          const events = JSON.parse(ta.value) as unknown[];
          return (
            Array.isArray(events) &&
            events.some((e) => (e as { kind?: string }).kind === "read") &&
            ta.selectionStart === 0 &&
            ta.selectionEnd === ta.value.length
          );
        }),
      )
      .toBe(true);
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
    const one = { url: H.serverUrl("prefill-one"), label: "prefill-one" };
    const two = { url: H.serverUrl("prefill-two"), label: "prefill-two" };
    await H.openAddServer(page);
    await H.fillAndSubmit(page, one.url, one.label);
    await expect.poll(async () => (await H.panes(page)).length).toBe(base + 1);
    await H.fillAndSubmit(page, two.url, two.label);
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

  test("bottom-edge click on a catalog row prefills THAT row (no hit-box overlap)", async ({ page }) => {
    const [one, two] = await seedTwoServers(page);

    // The old rows' -3px negative margins overlapped the next row's border
    // box by 2px (the later row won hit-testing): a click 1px above the
    // bottom of row `one` — visually inside its highlight — prefilled row
    // `two`. Rows now have strictly non-overlapping boxes: the bottom edge
    // belongs to its own row.
    const row = page.locator(`[data-testid="server-row"][data-url="${one.url}"]`);
    const box = await row.boundingBox();
    expect(box, "row has a bounding box").toBeTruthy();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height - 1);

    await expect(page.locator('[data-testid="add-server-url"]')).toHaveValue(one.url);
    await expect(page.locator('[data-testid="add-server-label"]')).toHaveValue(one.label);
    // Explicitly NOT the row below.
    await expect(page.locator('[data-testid="add-server-url"]')).not.toHaveValue(two.url);
    await expect(page.locator('[data-testid="add-server-label"]')).not.toHaveValue(two.label);
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

  test("keyboard: Enter and Space on a catalog row's pick button both prefill (native <button> activation)", async ({ page }) => {
    const [one, two] = await seedTwoServers(page);

    // The pick button is the row's first button child (button.catalogPick,
    // rendered before the ✕ remove button). It is a NATIVE <button> — Enter
    // and Space both dispatch a synthesized click through the real handler
    // (no bespoke key handling exists, and none is needed). Assert BOTH keys.
    const pickOne = page
      .locator(`[data-testid="server-row"][data-url="${one.url}"]`)
      .locator("button")
      .first();
    const pickTwo = page
      .locator(`[data-testid="server-row"][data-url="${two.url}"]`)
      .locator("button")
      .first();
    await expect(pickOne).toBeVisible();
    await expect(pickTwo).toBeVisible();

    // Enter on row one → prefills one.
    await pickOne.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-testid="add-server-url"]')).toHaveValue(one.url);
    await expect(page.locator('[data-testid="add-server-label"]')).toHaveValue(one.label);

    // Space on row two → prefills two (also proves Space did not just
    // re-trigger row one's focused button).
    await pickTwo.focus();
    await page.keyboard.press(" ");
    await expect(page.locator('[data-testid="add-server-url"]')).toHaveValue(two.url);
    await expect(page.locator('[data-testid="add-server-label"]')).toHaveValue(two.label);
    await expect(page.locator('[data-testid="add-server-url"]')).not.toHaveValue(one.url);
  });
});
