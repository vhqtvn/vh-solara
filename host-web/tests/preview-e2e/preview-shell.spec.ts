import { test, expect } from "@playwright/test";

// PRODUCTION-BUILD shell proof. Runs against `vite preview` (a real production
// bundle) via playwright.preview.config.ts. Every assertion here is PURELY DOM
// — it NEVER touches window.__host (which is correctly absent in a production
// build). This is what the DEV-only tests/e2e suite CANNOT prove: that the host
// shell's layout ops still work when the DEV test bridge is eliminated.
//
// Phase 1 (i3 host-shell): the top tabstrip is the WORKSPACE tabstrip again
// (ws-tab/ws-add present), and split/close/zoom/mode-switch live in the statusbar
// control cluster (the touch fallback). Per-pane headers are gone.

async function waitForHostReady(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  // "document alive" in the statusbar (Q1-C focused-pane liveness) proves
  // heartbeats are flowing through the store's message router (not DEV-gated) —
  // independent of window.__host. Never realtime/SSE wording.
  await expect(page.locator('[data-testid="statusbar"]'))
    .toContainText("document alive", { timeout: 30_000 });
  // Seed panes rendered (DOM-only readiness): the workspace tabstrip is present
  // (Phase 1 restored it) with the default workspace tab.
  await expect
    .poll(async () => page.locator('[data-testid="ws-tab"]').count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
}

test.describe("host shell — production build (vite preview)", () => {
  test.beforeEach(async ({ page }) => {
    await waitForHostReady(page);
  });

  test("production build has NO window.__host (and no DEV bridges)", async ({ page }) => {
    // The DEV-only test bridges (host + keyboard-focus + i3-keys) and their
    // destructive hooks must be entirely absent from the running production app.
    const hasBridge = await page.evaluate(() => {
      const w = window as unknown as {
        __host?: unknown;
        __hostKbdFocus?: unknown;
        __hostI3Keys?: unknown;
      };
      return {
        host: typeof w.__host !== "undefined",
        kbdFocus: typeof w.__hostKbdFocus !== "undefined",
        i3Keys: typeof w.__hostI3Keys !== "undefined",
      };
    });
    expect(hasBridge.host, "window.__host must be absent in production").toBe(false);
    expect(hasBridge.kbdFocus, "window.__hostKbdFocus must be absent in production").toBe(false);
    expect(hasBridge.i3Keys, "window.__hostI3Keys must be absent in production").toBe(false);
  });

  test("production tabstrip HAS workspace chrome (ws-tab/ws-add present)", async ({ page }) => {
    // Phase 1: the workspace tabs + add-workspace "+" are RESTORED to the
    // primary tabstrip (P4 pane-tabs reverted). This proves the production
    // bundle reflects the workspace-tabstrip change.
    await expect(page.locator('[data-testid="ws-tab"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="ws-add"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="statusbar"]')).toContainText("document alive");
  });

  test("production statusbar control cluster is present (touch fallback)", async ({ page }) => {
    // The i3 control cluster (split-h/v, mode, zoom, close) is part of the
    // production shell (NOT DEV-gated) and must render in a production build.
    // With a focused pane, none of these are disabled.
    await expect(page.locator('[data-testid="i3-controls"]')).toBeVisible();
    for (const tid of [
      "i3-split-h",
      "i3-split-v",
      "i3-tabbed",
      "i3-stacked",
      "i3-zoom",
      "i3-close",
    ]) {
      await expect(page.locator(`[data-testid="${tid}"]`)).toBeVisible();
    }
  });

  test("zoom (statusbar cluster) maximizes + restores in production", async ({ page }) => {
    // Zoom is reachable in production via the statusbar cluster (no DEV bridge).
    // The statusbar "maximized" badge reflects the state.
    await page.locator('[data-testid="i3-zoom"]').click();
    await expect(page.locator('[data-testid="statusbar"]')).toContainText("maximized");
    await page.locator('[data-testid="i3-zoom"]').click();
    await expect(page.locator('[data-testid="statusbar"]')).not.toContainText("maximized");
  });

  test("split (statusbar cluster) adds a pane in production", async ({ page }) => {
    // Split is reachable in production via the statusbar cluster (no DEV bridge).
    // Count the iframes before/after (DOM-only — no bridge needed).
    const before = await page.locator("iframe.pane-iframe").count();
    await page.locator('[data-testid="i3-split-h"]').click();
    await expect
      .poll(async () => page.locator("iframe.pane-iframe").count())
      .toBe(before + 1);
  });

  test("P3 attention hub renders in production; NEXT button absent when no needs-you", async ({ page }) => {
    // The statusbar attention-hub text ("N need you · M running") is part of the
    // production shell (NOT DEV-gated) and must render in a production build.
    // With no DEV bridge to inject a {type:"status"} message, every pane stays
    // attention="none" → N=0 → the NEXT hero button must be ABSENT.
    await expect(page.locator('[data-testid="attention-hub"]')).toContainText("need you");
    await expect(page.locator('[data-testid="attention-hub"]')).toContainText("running");
    await expect(page.locator('[data-testid="attention-hub"]')).toContainText("0 need you");
    await expect(page.locator('[data-testid="attention-next"]')).toHaveCount(0);
  });
});
