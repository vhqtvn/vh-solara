import { test, expect } from "@playwright/test";

// PRODUCTION-BUILD shell proof. Runs against `vite preview` (a real production
// bundle) via playwright.preview.config.ts. Every assertion here is PURELY DOM
// — it NEVER touches window.__host (which is correctly absent in a production
// build). This is what the DEV-only tests/e2e suite CANNOT prove: that the host
// shell's chrome reflects the production bundle (no DEV bridges).
//
// The bottom statusbar was REMOVED entirely (operator directive). Readiness is
// now proven by DOM chrome (seed iframes + the workspace tabstrip) instead of
// the statusbar's Q1-C "document alive" liveness text (that text surface is
// gone — the real heartbeat→liveness crux is now proven only by the real-embed
// e2e lane via the bridge liveness() helper; it has no DOM surface anymore).
//
// Phase 1 (i3 host-shell): the top tabstrip is the WORKSPACE tabstrip again
// (ws-tab/ws-add present). The statusbar's layout control cluster (split/close/
// zoom/mode) is GONE; the layout overlay is gesture-triggered in production
// (there is no production button to open it anymore). The P3 NEXT hero button
// moved into the tabstrip next to "Add server".

async function waitForHostReady(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/");
  // DOM-only readiness: seed panes rendered as iframes + the workspace tabstrip
  // is present. (The prior statusbar "document alive" gate is gone with the
  // statusbar; there is no DOM-visible heartbeat indicator anymore.)
  await expect
    .poll(async () => page.locator("iframe.pane-iframe").count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
  await expect
    .poll(async () => page.locator('[data-testid="ws-tab"]').count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(1);
}

test.describe("host shell — production build (vite preview)", () => {
  test.beforeEach(async ({ page }) => {
    await waitForHostReady(page);
  });

  test("production build has NO window.__host (and no DEV bridges)", async ({ page }) => {
    // The DEV-only test bridges (host + keyboard-focus + viewport auto-transpose
    // + proportions re-normalizer) and their destructive hooks must be entirely
    // absent from the running production app. (The i3-keys bridge was removed
    // when the Alt-shortcut module was dropped.)
    const hasBridge = await page.evaluate(() => {
      const w = window as unknown as {
        __host?: unknown;
        __hostKbdFocus?: unknown;
        __hostViewport?: unknown;
        __hostProportions?: unknown;
      };
      return {
        host: typeof w.__host !== "undefined",
        kbdFocus: typeof w.__hostKbdFocus !== "undefined",
        viewport: typeof w.__hostViewport !== "undefined",
        proportions: typeof w.__hostProportions !== "undefined",
      };
    });
    expect(hasBridge.host, "window.__host must be absent in production").toBe(false);
    expect(hasBridge.kbdFocus, "window.__hostKbdFocus must be absent in production").toBe(false);
    expect(hasBridge.viewport, "window.__hostViewport must be absent in production").toBe(false);
    expect(hasBridge.proportions, "window.__hostProportions must be absent in production").toBe(false);
  });

  test("production tabstrip HAS workspace chrome (ws-tab/ws-add/add-server)", async ({ page }) => {
    // Phase 1: the workspace tabs + add-workspace "+" are RESTORED to the
    // primary tabstrip. The "Add server" trigger sits beside them. This proves
    // the production bundle reflects the workspace-tabstrip shell.
    await expect(page.locator('[data-testid="ws-tab"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="ws-add"]')).toHaveCount(1);
    await expect(page.locator('[data-testid="add-server-btn"]')).toHaveCount(1);
  });

  test("production build has NO statusbar chrome", async ({ page }) => {
    // The bottom statusbar was deleted entirely. None of its testids render in
    // a production build (proves the deletion landed in the prod bundle, not
    // just the dev tree).
    await expect(page.locator('[data-testid="statusbar"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="attention-hub"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="i3-controls"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="layout-overlay-btn"]')).toHaveCount(0);
  });

  test("P3 NEXT button lives in the tabstrip; absent in production when no needs-you", async ({ page }) => {
    // The P3 NEXT hero button moved from the deleted statusbar into the
    // tabstrip. With no DEV bridge to inject a {type:"status"} message, every
    // pane stays attention="none" → N=0 → the NEXT button must be ABSENT. (The
    // old "N need you · M running" attention-hub text is gone with the statusbar;
    // only the conditional NEXT button remains as the attention-loop surface.)
    await expect(page.locator('[data-testid="attention-next"]')).toHaveCount(0);
  });
});
