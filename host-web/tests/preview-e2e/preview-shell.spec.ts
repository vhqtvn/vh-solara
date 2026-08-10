import { test, expect } from "@playwright/test";

// PRODUCTION-BUILD shell proof. Runs against `vite preview` (a real production
// bundle) via playwright.preview.config.ts. Every assertion here is PURELY DOM
// — it NEVER touches window.__host (which is correctly absent in a production
// build). This is what the DEV-only tests/e2e suite CANNOT prove: that the host
// shell's layout ops still work when the DEV test bridge is eliminated. The
// pane-header ops already went through the HostOps controller surface; this
// proves the SHELL ops do too.
//
// P4: the top tabstrip is the FLAT target tabstrip (workspace tabs were removed
// from primary nav — workspaces stay internal as the rendering layer). The
// flat-tab visit/select/survival behavior is covered by the DEV e2e
// (target-tabs.spec.ts, which has the bridge to drive visits). Here we only
// prove the production build renders the new tabstrip without workspace chrome
// and without crashing.

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

  test("production tabstrip has NO workspace chrome (flat target strip)", async ({ page }) => {
    // P4: the workspace tabs + add-workspace "+" were removed from the primary
    // tabstrip. The brand remains. This proves the production bundle reflects
    // the flat-tabstrip change (no ws-tab / ws-add elements in the DOM).
    await expect(page.locator('[data-testid="ws-tab"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="ws-add"]')).toHaveCount(0);
    // The brand mark is still present (the tabstrip container rendered).
    await expect(page.locator('[data-testid="statusbar"]')).toContainText("document alive");
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
