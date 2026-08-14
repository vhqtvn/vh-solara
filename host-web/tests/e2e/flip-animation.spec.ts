import { test, expect, type Page } from "@playwright/test";
import * as H from "./util";

/**
 * FLIP layout animation gate (host-web/src/layoutAnimation.ts).
 *
 * The FLIP replaces the laggy `transition: left/top/width/height` on
 * `.dv-render-overlay` with a single GPU-composited `transform` per pane. These
 * tests assert the MECHANISM is observable + cleans up, NOT the GPU smoothness
 * (headless does not GPU-rasterize; on-device is the final smoothness gate).
 *
 * Crux signals:
 *   1. CLEANUP — after a discrete op + settle, NO residual inline transform /
 *      transition remains on any `.dv-render-overlay` (transitionend cleared it).
 *   2. RUNS — a discrete split DOES create a transient transform transition on
 *      the overlays (sampled via getAnimations() during the play window). This
 *      is what would regress to zero if the FLIP install silently no-op'd.
 *   3. REDUCED-MOTION — under prefers-reduced-motion, NO transform transition is
 *      ever created (the JS gate skips the FLIP entirely).
 *   4. SURVIVAL — applying a transform to the overlay (an ANCESTOR of the
 *      iframe, never the iframe itself) does NOT reload the iframe. This is the
 *      architecture-A / renderer:'always' invariant; a transform that triggered a
 *      reload would fail the mission's STOP condition.
 *
 * Chromium only (the interaction spec's convention; Firefox/WebKit survival is
 * covered by survival.spec.ts). Serial with the rest of the suite
 * (playwright.config.ts: workers:1, shared fixture state).
 */

/** Max number of running CSS animations across all `.dv-render-overlay` elements,
 *  sampled every ~20ms for `durationMs`. Used to detect a transient FLIP
 *  transition (normal motion: ≥1 during the play window) vs none (reduced-motion
 *  or a no-op'd install: always 0). Runs the sampling loop IN the browser so it
 *  does not race the animation window. */
async function maxOverlayAnimations(page: Page, durationMs = 350): Promise<number> {
  return page.evaluate(async (durationMs) => {
    let max = 0;
    const deadline = performance.now() + durationMs;
    while (performance.now() < deadline) {
      let n = 0;
      for (const el of document.querySelectorAll(".dv-render-overlay")) {
        n += el.getAnimations().length;
      }
      if (n > max) max = n;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
    return max;
  }, durationMs);
}

/** Count `.dv-render-overlay` elements with a residual INLINE transform /
 *  transition left by the FLIP. Must be 0 once the layout has settled.
 *
 *  INLINE-ONLY by design: the FLIP only ever sets inline styles, and the
 *  COMPUTED transform can never be a FLIP residual — dockview's base stylesheet
 *  pins a constant `transform: translate3d(0,0,0)` (+ `will-change: transform`)
 *  on `.dv-render-overlay` (dockview-core dist styles, the "GPU optimizations"
 *  block), so the computed value is the identity matrix even at rest. Comparing
 *  it against the string "none" would flag every overlay forever. */
async function residualTransformCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    let count = 0;
    for (const el of document.querySelectorAll<HTMLElement>(".dv-render-overlay")) {
      if (el.style.transform || el.style.transition) {
        count++;
      }
    }
    return count;
  });
}

/** Assert no residual transform/transition remains after a discrete layout op.
 *
 *  `waitForLayoutSettled` (polls getAnimations()==0) can FALSE-EARLY in the
 *  ~1-frame window right after the op: the FLIP transition is created
 *  synchronously on onDidLayoutChange but only "starts" (becomes visible to
 *  getAnimations) at the next style recalc. A bare zero-poll therefore passes
 *  before the transition is live. This helper waits past that pre-start window
 *  so the transition is running, THEN polls residual to 0 (cleared by
 *  transitionend, or the FLIP_DURATION_MS+slack fallback at ~210ms). Robust
 *  across multi-burst ops (split/swap emit several onDidLayoutChange bursts):
 *  residual stays non-zero while any burst's transition runs and only reaches 0
 *  once the last one's transitionend (or fallback) fires. */
async function assertNoResidual(page: Page): Promise<void> {
  await page.waitForTimeout(60);
  await expect
    .poll(() => residualTransformCount(page), { timeout: 5000 })
    .toBe(0);
}

test.describe("FLIP layout animation", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  test("CLEANUP: after a discrete split + settle, no residual transform/transition on overlays", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    const before = (await H.survival(page, a))!;

    const created = await H.split(page, a, "right");
    expect(created, "split created a new pane").toBeTruthy();
    // Wait for the FLIP play window to fully finish + clear its transient styles.
    await assertNoResidual(page);

    // The source iframe survived the animated split (transform on the overlay
    // ancestor did not reload it).
    await H.assertSurvived(page, a, before, "source pane across animated split");
  });

  test("RUNS: a discrete split creates a transient transform transition on overlays (FLIP is live)", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    // Start sampling FIRST (the loop runs in-browser), then trigger the split so
    // the ~150ms FLIP play window is captured regardless of bridge round-trip
    // latency. The split is fired via a microtask inside the same evaluate so it
    // lands within the sampling window.
    const promise = maxOverlayAnimations(page, 350);
    // Tiny yield so the sampling loop begins before the split's layout change.
    await page.waitForTimeout(0);
    const created = await H.split(page, a, "right");
    expect(created, "split created a new pane").toBeTruthy();
    const maxN = await promise;

    expect(maxN, "FLIP transition ran on at least one overlay").toBeGreaterThan(0);
    // And it still cleans up afterwards.
    await assertNoResidual(page);
  });

  test("REDUCED-MOTION: no transform transition is ever created under prefers-reduced-motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const ids = await H.panes(page);
    const a = ids[0];

    const promise = maxOverlayAnimations(page, 350);
    await page.waitForTimeout(0);
    const created = await H.split(page, a, "right");
    expect(created, "split created a new pane").toBeTruthy();
    const maxN = await promise;

    expect(maxN, "no FLIP transition under reduced-motion").toBe(0);
    // Reduced-motion must also leave no inline styles (baseline refresh only).
    await assertNoResidual(page);
  });

  test("SWAP: both panes survive an animated swap and no residual transform remains", async ({ page }) => {
    const ids = await H.panes(page);
    const [a, b] = [ids[0], ids[1]];
    const ba = (await H.survival(page, a))!;
    const bb = (await H.survival(page, b))!;

    await H.swap(page, a, b);
    await assertNoResidual(page);

    await H.assertSurvived(page, a, ba, "swap pane A across animated swap");
    await H.assertSurvived(page, b, bb, "swap pane B across animated swap");
  });
});
