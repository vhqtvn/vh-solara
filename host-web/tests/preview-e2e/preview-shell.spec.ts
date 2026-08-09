import { test, expect } from "@playwright/test";

// PRODUCTION-BUILD shell proof. Runs against `vite preview` (a real production
// bundle) via playwright.preview.config.ts. Every assertion here is PURELY DOM
// — it NEVER touches window.__host (which is correctly absent in a production
// build). This is what the DEV-only tests/e2e suite CANNOT prove: that the host
// shell's layout ops still work when the DEV test bridge is eliminated. The
// pane-header ops already went through the HostOps controller surface; this
// proves the SHELL ops do too.
//
// MULTI-WORKSPACE: the top tabstrip is workspace-scoped. The "+" adds a
// WORKSPACE (not a pane); clicking a workspace tab switches (CSS-visibility-
// only — survival-safe, no iframe reload, proven separately in tests/e2e).
// Panes within the active workspace are represented by their own custom headers.

async function waitForHostReady(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  // "document alive" in the statusbar (Q1-C focused-pane liveness) proves
  // heartbeats are flowing through the store's message router (not DEV-gated) —
  // independent of window.__host. Never realtime/SSE wording.
  await expect(page.locator('[data-testid="statusbar"]'))
    .toContainText("document alive", { timeout: 30_000 });
  // Seed panes rendered (DOM-only readiness): the active workspace has panes
  // with custom headers carrying the Split affordance.
  await expect
    .poll(async () => page.locator('[data-testid="pane-split-right"]').count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
}

test.describe("host shell — production build (vite preview)", () => {
  test.beforeEach(async ({ page }) => {
    await waitForHostReady(page);
  });

  test("production build has NO window.__host (and no keyboard-focus DEV bridge)", async ({ page }) => {
    // The DEV-only test bridge (and its destructive hooks) must be entirely
    // absent from the running production app. This is the runtime twin of the
    // dist/ grep proof.
    const hasBridge = await page.evaluate(() => {
      const w = window as unknown as { __host?: unknown; __hostKbdFocus?: unknown };
      return {
        host: typeof w.__host !== "undefined",
        kbdFocus: typeof w.__hostKbdFocus !== "undefined",
      };
    });
    expect(hasBridge.host, "window.__host must be absent in production").toBe(false);
    expect(hasBridge.kbdFocus, "window.__hostKbdFocus must be absent in production").toBe(false);
  });

  test("'+' adds a workspace — shell addWorkspace via HostOps (not the bridge)", async ({ page }) => {
    // The "+" button calls addWorkspace() in the production bundle. A new
    // workspace tab must appear and the empty-workspace affordance must show
    // (a freshly-created workspace has 0 panels).
    const before = await page.locator('[data-testid="ws-tab"]').count();
    await page.locator('[data-testid="ws-add"]').click();
    await expect
      .poll(async () => page.locator('[data-testid="ws-tab"]').count())
      .toBe(before + 1);
    await expect(page.locator('[data-testid="empty-workspace"]')).toBeVisible();
  });

  test("clicking a workspace tab switches active workspace (survival-safe)", async ({ page }) => {
    // There is initially one workspace tab. Add a second one and switch between
    // them by clicking tabs — this exercises the CSS-visibility-only overlay
    // stack path in production (no bridge).
    await page.locator('[data-testid="ws-add"]').click();
    await expect
      .poll(async () => page.locator('[data-testid="ws-tab"]').count())
      .toBe(2);
    const tabs = page.locator('[data-testid="ws-tab"]');
    // The second tab is active (addWorkspace activates the new workspace).
    await expect(tabs.nth(1)).toHaveClass(/tabActive/);
    // Click the first tab → it becomes active (switch back).
    await tabs.nth(0).click();
    await expect(tabs.nth(0)).toHaveClass(/tabActive/);
    // The empty-workspace affordance disappears (ws1 has seeded panes).
    await expect(page.locator('[data-testid="empty-workspace"]')).toHaveCount(0);
  });

  test("collapse + tray-chip restore — shell restore via HostOps", async ({ page }) => {
    // Collapse a pane via its header button (controller collapse → floating
    // group), which makes App.tsx render a tray-chip. Clicking the SHELL tray-
    // chip calls hostOps().restore(id) → grid. The chip must disappear.
    await page.locator('[data-testid="pane-collapse"]').first().click();
    const chip = page.locator('[data-testid="tray-chip"]');
    await expect(chip).toHaveCount(1);
    await chip.click();
    await expect(page.locator('[data-testid="tray-chip"]')).toHaveCount(0);
  });
});
