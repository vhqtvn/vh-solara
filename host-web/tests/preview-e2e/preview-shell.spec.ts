import { test, expect } from "@playwright/test";

// PRODUCTION-BUILD shell proof. Runs against `vite preview` (a real production
// bundle) via playwright.preview.config.ts. Every assertion here is PURELY DOM
// — it NEVER touches window.__host (which is correctly absent in a production
// build). This is what the DEV-only tests/e2e suite CANNOT prove: that the host
// shell's three layout ops (split / focusPane / restore) still work when the
// DEV test bridge is eliminated. The pane-header ops already went through the
// HostOps controller surface; this proves the SHELL ops do too.
//
// Seed layout (state/mockData.ts): 4 panes —
//   tab0 = srv-A · chat (initially focused), tab1 = srv-A · terminal,
//   tab2 = srv-B · diff, tab3 = srv-B · sessions.

async function waitForHostReady(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  // "document alive" in the statusbar (Q1-C focused-pane liveness) proves
  // heartbeats are flowing through the store's message router (not DEV-gated) —
  // independent of window.__host. Never realtime/SSE wording.
  await expect(page.locator('[data-testid="statusbar"]'))
    .toContainText("document alive", { timeout: 30_000 });
  // Seed panes rendered as workspace tabs (DOM-only readiness).
  await expect
    .poll(async () => page.locator('[data-testid="ws-tab"]').count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2);
}

test.describe("host shell — production build (vite preview)", () => {
  test.beforeEach(async ({ page }) => {
    await waitForHostReady(page);
  });

  test("production build has NO window.__host", async ({ page }) => {
    // The DEV-only test bridge (and its destructive hooks) must be entirely
    // absent from the running production app. This is the runtime twin of the
    // dist/ grep proof.
    const hasBridge = await page.evaluate(() => {
      const w = window as unknown as { __host?: unknown };
      return typeof w.__host !== "undefined";
    });
    expect(hasBridge, "window.__host must be absent in production").toBe(false);
  });

  test("'+' adds a pane — shell split via HostOps (not the bridge)", async ({ page }) => {
    // The "+" button calls hostOps().split(focused, "right") in the production
    // bundle. A new tab must appear.
    const before = await page.locator('[data-testid="ws-tab"]').count();
    await page.locator('[data-testid="ws-add"]').click();
    await expect
      .poll(async () => page.locator('[data-testid="ws-tab"]').count())
      .toBe(before + 1);
  });

  test("clicking a tab focuses it — shell focusPane via HostOps", async ({ page }) => {
    // Focus routing: ws-tab click → hostOps().focusPane(id) → setActive → the
    // statusbar's "focus: …" text updates from the store's focusedId() signal.
    // tab0 is initially focused (srv-A · chat); tab1 is srv-A · terminal.
    const status = page.locator('[data-testid="statusbar"]');
    await expect(status).toContainText("chat");
    await page.locator('[data-testid="ws-tab"]').nth(1).click();
    await expect(status).toContainText("terminal");
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
