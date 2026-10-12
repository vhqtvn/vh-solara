// Real-app integration proof for the 2026-10-12 v1.77.3 freeze recurrence.
//
// The unit/integration lane (tests/unit/paneGateUserUnfreeze.test.ts) drives
// the real gate module with real timers but jsdom cannot produce a TRUSTED
// pointerdown (isTrusted is LegacyUnforgeable). This spec closes that gap on
// the REAL fixture app: the real SPA bundle with the real index.tsx wiring
// (startPaneVisibility + installPaneAnimationGate), the production freeze
// posture forced in-page (visibilityState stranded at "hidden" after a real
// hide — the WebKit standalone-PWA failure class), and then a REAL Playwright
// click (a genuinely trusted pointerdown) must un-latch the gate. Synthetic
// taps must not. A genuine re-hide must re-pause (the perf gate survives).
import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

test("pane gate: stuck-visibilityState freeze is un-latched by a real trusted tap", async ({ page }) => {
  await page.goto(projectUrl("/"));
  const classOnP = (): Promise<boolean> =>
    page.evaluate(() => document.documentElement.classList.contains("pane-hidden"));

  // App booted visible: the gate holds NO pause class (dots animate).
  await expect
    .poll(classOnP, { timeout: 10_000, message: "fresh load: not paused" })
    .toBe(false);

  // Neutral click absorber: a trusted pointerdown must land WITHOUT touching
  // real app UI (no accidental sidebar/menu interaction).
  await page.evaluate(() => {
    const el = document.createElement("div");
    el.id = "probe-absorber";
    el.style.cssText = "position:fixed;inset:0;z-index:99999;cursor:default";
    document.body.appendChild(el);
  });

  // The production posture, in-order: (1) a REAL hide — state flips + the
  // real visibilitychange fires → the real gate listener pauses the pane.
  const forceHide = (): Promise<void> =>
    page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        get: () => "hidden",
        configurable: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
  await forceHide();
  await expect.poll(classOnP, { message: "real hide → gate paused" }).toBe(true);

  // (2) The WebKit unlock failure: the state stays "hidden", no further
  // event. The gate's heals would re-derive the lie — this is the frozen
  // posture the operator sees (dots stopped, pane visibly open).

  // Synthetic (untrusted) pointerdown is NOT evidence — must stay frozen.
  await page.evaluate(() => {
    document
      .getElementById("probe-absorber")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
  });
  await page.waitForTimeout(150);
  expect(await classOnP(), "untrusted pointerdown ignored").toBe(true);

  // (3) A REAL tap — Playwright input is a genuinely trusted pointerdown.
  await page.mouse.click(400, 300);
  await expect.poll(classOnP, { message: "trusted tap un-latches the freeze" }).toBe(false);

  // The perf gate survives: a genuine re-hide (real event) re-pauses.
  await forceHide();
  await expect.poll(classOnP, { message: "genuine re-hide re-pauses" }).toBe(true);
});
