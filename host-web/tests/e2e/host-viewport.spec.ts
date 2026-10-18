import { test, expect, type Page } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// HOST ROOT = THE ACTUALLY VISIBLE VIEWPORT (src/hostViewport.ts)
//
// On-device bug (Android tablet, no keyboard, every project tab at once): the
// SPA composer was clipped ~40-80px below the screen bottom. Root cause: the
// host root `.app` was `height: 100vh`; on mobile 100vh is the LARGE viewport
// (dynamic toolbar retracted) while the visible layout viewport
// (innerHeight) is smaller whenever the toolbar shows / after a stale resume —
// so `.app` and every pane iframe overshot the screen. The SPA's own
// min(vv, innerHeight) clamp is inert inside a too-tall iframe.
//
// Headless engines have 100vh == innerHeight, so these tests mock the
// window's innerHeight / visualViewport getters to make the layout/visible
// viewport SMALLER than 100vh (exactly the device condition) and assert the
// root + focused iframe stay inside it. Pre-fix the root stayed at 100vh
// (= VIEWPORT.height) and these fail.
//
// Event wiring is proven with window events (pageshow/resize), which engines
// deliver to listeners when dispatched synthetically. WebKit skipped (touch +
// visualViewport emulation unreliable; matches keyboard-focus.spec.ts).
// =============================================================================

const VIEWPORT = { width: 414, height: 740 };

test.use({ viewport: VIEWPORT, hasTouch: true });

test.beforeEach(async ({ browserName }) => {
  test.skip(browserName === "webkit", "host-viewport: chromium + firefox only");
});

/** Install controllable innerHeight + visualViewport getters. Setting a value
 *  is SILENT (no event) — the caller decides which signal (if any) fires. */
async function mockViewport(page: Page): Promise<void> {
  await page.evaluate(() => {
    const real = window.visualViewport!;
    const st = { ih: window.innerHeight, vh: real.height, vo: 0, scale: 1 };
    Object.defineProperty(window, "innerHeight", { configurable: true, get: () => st.ih });
    Object.defineProperty(real, "height", { configurable: true, get: () => st.vh });
    Object.defineProperty(real, "offsetTop", { configurable: true, get: () => st.vo });
    Object.defineProperty(real, "scale", { configurable: true, get: () => st.scale });
    (window as unknown as { __mockVp: typeof st }).__mockVp = st;
  });
}

async function setMock(
  page: Page,
  v: Partial<{ ih: number; vh: number; vo: number; scale: number }>,
): Promise<void> {
  await page.evaluate((v) => {
    Object.assign((window as unknown as { __mockVp: object }).__mockVp, v);
  }, v);
}

async function fire(page: Page, ev: string): Promise<void> {
  await page.evaluate((ev) => window.dispatchEvent(new Event(ev)), ev);
}

async function rootBottom(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.querySelector('[data-testid="host-app-root"]') as HTMLElement;
    return el.getBoundingClientRect().bottom;
  });
}

test.describe("host root tracks the visible viewport", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
    await mockViewport(page);
  });

  test("layout viewport smaller than 100vh (toolbar shown): root + focused iframe stay on-screen", async ({ page }) => {
    const before = await H.appRootHeight(page);
    expect(before, "root fills the viewport at rest").toBeGreaterThanOrEqual(VIEWPORT.height - 5);
    const ids = await H.panes(page);
    const target = (await H.focused(page)) ?? ids[0];
    const surv = (await H.survival(page, target))!;

    // Toolbar shows: the visible layout viewport is 60px shorter than 100vh.
    const visible = VIEWPORT.height - 60;
    await setMock(page, { ih: visible, vh: visible });
    await fire(page, "resize");

    await expect.poll(async () => H.appRootHeight(page), { timeout: 8000 }).toBe(visible);
    expect(await rootBottom(page)).toBeLessThanOrEqual(visible);
    await expect
      .poll(async () => {
        const b = await H.focusedIframeBox(page);
        return b ? b.y + b.height : Infinity;
      }, { timeout: 8000 })
      .toBeLessThanOrEqual(visible);

    // Toolbar hides again → root grows back.
    await setMock(page, { ih: VIEWPORT.height, vh: VIEWPORT.height });
    await fire(page, "resize");
    await expect.poll(async () => H.appRootHeight(page), { timeout: 8000 }).toBe(VIEWPORT.height);
    await H.assertSurvived(page, target, surv, "root resize with visible viewport");
  });

  test("level re-sync: a lost resize edge is corrected by pageshow/focus/orientationchange", async ({ page }) => {
    const visible = VIEWPORT.height - 48;
    await setMock(page, { ih: visible, vh: visible }); // silent: the edge is lost
    await page.waitForTimeout(300);
    expect(await H.appRootHeight(page), "still stale without a signal").toBe(VIEWPORT.height);

    await fire(page, "pageshow");
    await expect.poll(async () => H.appRootHeight(page), { timeout: 8000 }).toBe(visible);

    await setMock(page, { ih: VIEWPORT.height - 20, vh: VIEWPORT.height - 20 });
    await fire(page, "focus");
    await expect
      .poll(async () => H.appRootHeight(page), { timeout: 8000 })
      .toBe(VIEWPORT.height - 20);

    // Rotation: the visible height changes AGAIN with no resize edge — a prime
    // on-device world-change (bfcache resume after rotating away and back).
    await setMock(page, { ih: visible, vh: visible });
    await fire(page, "orientationchange");
    await expect.poll(async () => H.appRootHeight(page), { timeout: 8000 }).toBe(visible);
  });

  test("visible band bottom (vv.offsetTop + vv.height) bounds the root; pinch-zoom vv is ignored", async ({ page }) => {
    const compute = () =>
      page.evaluate(
        () =>
          (window as unknown as { __hostVisibleViewport: { compute(): number | null } })
            .__hostVisibleViewport.compute(),
      );
    // vv shorter than the layout viewport (sub-keyboard-threshold shrink).
    await setMock(page, { vh: 650, vo: 0 });
    expect(await compute()).toBe(650);
    // Panned visible band: its bottom edge is offsetTop + height.
    await setMock(page, { vh: 600, vo: 50 });
    expect(await compute()).toBe(650);
    // Stale-large vv can never exceed the layout viewport.
    await setMock(page, { vh: 900, vo: 0 });
    expect(await compute()).toBe(VIEWPORT.height);
    // Pinch-zoomed: vv is smaller by the zoom factor, not the screen → ignored.
    await setMock(page, { vh: 370, vo: 0, scale: 2 });
    expect(await compute()).toBe(VIEWPORT.height);
    // Degenerate samples keep the last good value (null → no write).
    await setMock(page, { ih: 0, vh: 0, scale: 1 });
    expect(await compute()).toBeNull();
    await fire(page, "resize");
    await page.waitForTimeout(100);
    expect(await H.appRootHeight(page)).toBeGreaterThan(0);
  });

  test("root never exceeds the layout viewport — fractional innerHeight must not round the root past the ICB", async ({ page }) => {
    // On-device bug class (Chrome PWA standalone, DPR 2.625-class fractional
    // CSS viewport): innerHeight/ICB = N.6 → Math.round(N.6) = N+1 made `.app`
    // 1px taller than the viewport → scrollingElement.scrollHeight (N+1) >
    // clientHeight (N) → a touch drag on the tabstrip panned the whole
    // document instead of performing the drag gesture. Invariant: the tracker
    // may only ever make the root SHORTER than the ICB (toolbar/visible-band
    // clamps), never taller — hence FLOOR here, plus the .app max-height:100%
    // CSS cap proven by the next test as the stale-sample backstop.
    const frac = VIEWPORT.height + 0.6;
    await setMock(page, { ih: frac, vh: frac });
    await fire(page, "resize");
    // Floor, not round: N.6 → N (root ≤ ICB).
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.style.getPropertyValue("--host-h")),
      )
      .toBe(`${VIEWPORT.height}px`);
    expect(await H.appRootHeight(page)).toBeLessThanOrEqual(VIEWPORT.height);
    const doc = await page.evaluate(() => {
      const se = document.scrollingElement!;
      return { sh: se.scrollHeight, ch: se.clientHeight };
    });
    expect(doc.sh, "document must never be taller than the viewport").toBeLessThanOrEqual(doc.ch);
  });

  test("CSS cap: even a stale-large --host-h cannot make the document scrollable", async ({ page }) => {
    // Whatever makes --host-h exceed the ICB on device (a stale sample that
    // missed a shrink edge, an engine rounding disagreement), `.app`'s
    // max-height:100% caps the root at the ICB: the document never gains a
    // scroll range, so no touch drag on the shell can pan it.
    await page.evaluate((h) => {
      document.documentElement.style.setProperty("--host-h", `${h}px`);
    }, VIEWPORT.height + 12);
    await page.waitForTimeout(80); // a frame; no world-event fires a resample
    expect(await H.appRootHeight(page), "root capped at the ICB").toBe(VIEWPORT.height);
    const doc = await page.evaluate(() => {
      const se = document.scrollingElement!;
      return { sh: se.scrollHeight, ch: se.clientHeight };
    });
    expect(doc.sh, "document never scrollable").toBeLessThanOrEqual(doc.ch);
  });

  test("keyboard-focus restore lands on the CURRENT visible height (not 100vh / a stale sample)", async ({ page }) => {
    await H.kbdFocusOpen(page, 360);
    await expect.poll(async () => H.appRootHeight(page), { timeout: 8000 }).toBe(360);
    expect(
      await page.evaluate(
        () => (document.querySelector('[data-testid="host-app-root"]') as HTMLElement).dataset.kbdFocus,
      ),
    ).toBe("open");

    // While open, the toolbar state changes silently (no event reaches us).
    const visible = VIEWPORT.height - 56;
    await setMock(page, { ih: visible, vh: visible });
    await H.kbdFocusClose(page);

    // Restore clears the inline override AND re-samples --host-h.
    await expect.poll(async () => H.appRootHeight(page), { timeout: 8000 }).toBe(visible);
    expect(await H.appRootTransform(page)).toBe("");
    expect(
      await page.evaluate(
        () => (document.querySelector('[data-testid="host-app-root"]') as HTMLElement).dataset.kbdFocus,
      ),
    ).toBeUndefined();
  });
});
