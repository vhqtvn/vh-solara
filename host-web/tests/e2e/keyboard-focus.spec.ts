import { test, expect } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// HOST-OWNED KEYBOARD FOCUS-MODE (mechanism proof)
//
// Mission: "When the keyboard is shown, the focused pane takes the whole
// remaining viewport." The host detects the soft keyboard (its visualViewport
// shrinks), shrinks the host root to the visible area, and maximizes the
// focused pane's group — so the focused IFRAME ELEMENT itself resizes to the
// visible area (then the SPA's own-vv-only viewport tracking puts the composer
// above the keyboard with no gap). On keyboard close the layout restores.
//
// The real soft-keyboard OUTCOME is not-demonstrable headlessly (no Playwright
// engine can open a soft keyboard). These tests prove the MECHANISM three ways:
//   1. Direct mechanism (DEV bridge open/close): root shrinks + group maximizes
//      + iframe element height shrinks to the visible area + identity survives.
//   2. Real detection path (visualViewport height override): the heuristic +
//      debounce fire open/close via the SAME listener the on-device path uses.
//   3. Manual-maximize ownership: a user's manual zoom is NOT clobbered by
//      keyboard-open NOR exited by keyboard-close (only what focus-mode entered).
//
// Runs in a touch-emulated mobile viewport (hasTouch) so the touch-capability
// gate passes and the focus-mode installs. Chromium + Firefox (the mission's
// required bar); WebKit skipped — touch-keyboard emulation there is unreliable
// and not required.
// =============================================================================

// Mobile viewport for the keyboard tests. innerHeight ≈ 740; a keyboard-open
// value of 360 (~49% of innerHeight) is well past the 0.7 detection threshold.
const VIEWPORT = { width: 414, height: 740 };
const KEYBOARD_VISIBLE_H = 360; // visible area above the keyboard (px)

test.beforeEach(async ({ browserName }) => {
  // WebKit touch + visualViewport emulation is unreliable; the mission requires
  // only chromium + firefox for this mechanism. Skip webkit rather than risk a
  // flaky false-red on a non-required engine.
  test.skip(browserName === "webkit", "keyboard-focus: chromium + firefox only");
});

// Touch-emulated mobile viewport for the whole file (so the focus-mode's
// touch-capability gate passes and it installs its listener + DEV bridge).
// NOTE: isMobile is intentionally NOT set — Firefox does not support it and
// hasTouch alone satisfies the navigator.maxTouchPoints gate the focus-mode
// uses.
test.use({
  viewport: VIEWPORT,
  hasTouch: true,
});

test.describe("host keyboard focus-mode", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  // ---- 1. DIRECT MECHANISM (DEV bridge open/close) -------------------------

  test("keyboard-open maximizes the focused pane + shrinks its iframe to the visible area", async ({ page }) => {
    const ids = await H.panes(page);
    const focused = await H.focused(page);
    const target = focused ?? ids[0];
    if (focused !== target) await H.focusPane(page, target);
    await expect.poll(async () => H.focused(page)).toBe(target);
    // Let Dockview's overlay positioning settle before measuring.
    await page.waitForTimeout(200);

    // Sanity: the host root fills the layout viewport before any keyboard.
    const fullAppH = await H.appRootHeight(page);
    expect(fullAppH, "host root fills viewport before keyboard").toBeGreaterThanOrEqual(
      VIEWPORT.height - 5,
    );
    const before = (await H.survival(page, target))!;

    // Keyboard opens: the host root shrinks to the visible area + the focused
    // pane's group is maximized (overlays the others in place, no reparent).
    await H.kbdFocusOpen(page, KEYBOARD_VISIBLE_H);

    // CRUX #1 — the host root shrank to the visible area. This is the fix: the
    // host now OWNS the resize (not the SPA's --app-h cap), so the iframe
    // element follows the root instead of staying full-size.
    await expect
      .poll(async () => H.appRootHeight(page), { timeout: 8000 })
      .toBe(KEYBOARD_VISIBLE_H);
    // CRUX #2 — the focused pane's group is maximized (overlaid in place).
    await expect.poll(async () => H.isMaximized(page), { timeout: 8000 }).toBe(true);
    // Focus-mode owns the maximize (recorded for close to exit).
    await expect.poll(async () => (await H.kbdFocusState(page)).ownedWs).not.toBeNull();
    // CRUX #3 — the focused iframe ELEMENT is bounded by the shrunk root (it
    // lives in `.main`, a child of the now-visibleHeight-tall `.app`), NOT the
    // full layout viewport. Before the fix the iframe stayed full-size while
    // only --app-h shrank (the gap); now the iframe itself resized. Assert it
    // is well below the full layout height and not collapsed.
    await expect
      .poll(async () => (await H.focusedIframeBox(page))!.height, { timeout: 8000 })
      .toBeLessThan(KEYBOARD_VISIBLE_H); // < visible (host chrome eats some)
    await expect
      .poll(async () => (await H.focusedIframeBox(page))!.height, { timeout: 8000 })
      .toBeLessThan(VIEWPORT.height * 0.6); // well below full layout height
    await expect
      .poll(async () => (await H.focusedIframeBox(page))!.height, { timeout: 8000 })
      .toBeGreaterThan(KEYBOARD_VISIBLE_H * 0.5); // tied to visible, not collapsed

    // SURVIVAL: the iframe was NOT reloaded (no reparent/move/remove — only
    // geometry changed). Identity unchanged, uptime climbing.
    await H.assertSurvived(page, target, before, "keyboard-open focus-maximize");
  });

  test("keyboard-close restores the layout (focus-mode exits only what it entered)", async ({ page }) => {
    const ids = await H.panes(page);
    const focused = await H.focused(page);
    const target = focused ?? ids[0];
    if (focused !== target) await H.focusPane(page, target);
    await page.waitForTimeout(200);
    const before = (await H.survival(page, target))!;

    // Open then close a full cycle.
    await H.kbdFocusOpen(page, KEYBOARD_VISIBLE_H);
    await expect.poll(async () => H.isMaximized(page)).toBe(true);
    await expect.poll(async () => H.appRootHeight(page)).toBe(KEYBOARD_VISIBLE_H);
    await H.kbdFocusClose(page);

    // Root restored to the full viewport.
    await expect
      .poll(async () => H.appRootHeight(page), { timeout: 8000 })
      .toBeGreaterThanOrEqual(VIEWPORT.height - 5);
    // Maximize exited (focus-mode owned it).
    await expect.poll(async () => H.isMaximized(page), { timeout: 8000 }).toBe(false);
    // Focus-mode no longer owns anything.
    await expect.poll(async () => (await H.kbdFocusState(page)).ownedWs).toBeNull();
    // Identity survived the whole open→close cycle (no reload).
    await H.assertSurvived(page, target, before, "keyboard open→close cycle");
  });

  // ---- 2. MANUAL-MAXIMIZE OWNERSHIP (do not clobber user zoom) -------------

  test("a user's manual maximize is NOT clobbered by keyboard-open NOR exited by close", async ({ page }) => {
    const ids = await H.panes(page);
    const focused = await H.focused(page);
    const target = focused ?? ids[0];
    if (focused !== target) await H.focusPane(page, target);

    // User manually maximizes the focused pane (toggleZoom → maximizeGroup).
    await H.maximize(page, target);
    await expect.poll(async () => H.isMaximized(page)).toBe(true);
    // Focus-mode did NOT open this — ownership stays null.
    expect((await H.kbdFocusState(page)).ownedWs, "manual maximize is not focus-owned").toBeNull();

    // Keyboard opens while the user's maximize is active. Focus-mode must NOT
    // clobber it (it's already maximized) and must NOT claim ownership.
    await H.kbdFocusOpen(page, KEYBOARD_VISIBLE_H);
    await expect.poll(async () => H.isMaximized(page)).toBe(true); // still maximized
    expect(
      (await H.kbdFocusState(page)).ownedWs,
      "focus-mode does not own the user's manual maximize",
    ).toBeNull();

    // Keyboard closes. Focus-mode must NOT exit the user's manual maximize.
    await H.kbdFocusClose(page);
    await expect
      .poll(async () => H.isMaximized(page), { timeout: 8000 })
      .toBe(true); // still maximized — the user's, untouched

    // Clean up so the maximize state doesn't leak into sibling tests (serial).
    await H.exitMaximized(page);
    await expect.poll(async () => H.isMaximized(page)).toBe(false);
  });

  // ---- 3. REAL DETECTION PATH (visualViewport shrink fires the heuristic) ---

  test("real detection path: visualViewport shrink past threshold opens focus-mode", async ({ page }) => {
    const ids = await H.panes(page);
    const focused = await H.focused(page);
    const target = focused ?? ids[0];
    if (focused !== target) await H.focusPane(page, target);

    // Override the host's visualViewport.height with a controllable getter so
    // we can simulate a keyboard shrink WITHOUT a real keyboard. The override
    // is installed BEFORE this evaluate returns; the focus-mode's listener is
    // already attached (App mounted in loadHost), so dispatching resize on the
    // REAL visualViewport fires the SAME on-device code path.
    await page.evaluate(() => {
      const real = window.visualViewport!;
      let mockH = real.height;
      Object.defineProperty(real, "height", {
        configurable: true,
        get: () => mockH,
      });
      (window as unknown as { __setMockVvH?: (h: number) => void }).__setMockVvH = (h: number) => {
        mockH = h;
        real.dispatchEvent(new Event("resize"));
      };
    });

    expect(
      (await H.kbdFocusState(page)).open,
      "focus-mode closed before any shrink",
    ).toBe(false);

    // Shrink the visual viewport past the 0.7 threshold (360 < 0.7*740=518).
    await page.evaluate((h) => {
      (window as unknown as { __setMockVvH: (h: number) => void }).__setMockVvH(h);
    }, KEYBOARD_VISIBLE_H);

    // The REAL detection path (heuristic + debounce) must fire open. Flush any
    // pending debounce immediately so the assertion is deterministic.
    await H.kbdFocusFlushDetection(page);
    await expect
      .poll(async () => (await H.kbdFocusState(page)).open, { timeout: 8000 })
      .toBe(true);
    await expect.poll(async () => H.isMaximized(page), { timeout: 8000 }).toBe(true);
    await expect
      .poll(async () => H.appRootHeight(page), { timeout: 8000 })
      .toBe(KEYBOARD_VISIBLE_H);

    // Grow back past the threshold → the real path fires close.
    await page.evaluate((h) => {
      (window as unknown as { __setMockVvH: (h: number) => void }).__setMockVvH(h);
    }, VIEWPORT.height);
    await H.kbdFocusFlushDetection(page);
    await expect
      .poll(async () => (await H.kbdFocusState(page)).open, { timeout: 8000 })
      .toBe(false);
    await expect.poll(async () => H.isMaximized(page), { timeout: 8000 }).toBe(false);
    await expect
      .poll(async () => H.appRootHeight(page), { timeout: 8000 })
      .toBeGreaterThanOrEqual(VIEWPORT.height - 5);

    // Identity survived the real-path open→close cycle.
    const before = (await H.survival(page, target))!;
    // re-open + close once more to assert survival across a detected cycle
    await page.evaluate((h) => {
      (window as unknown as { __setMockVvH: (h: number) => void }).__setMockVvH(h);
    }, KEYBOARD_VISIBLE_H);
    await H.kbdFocusFlushDetection(page);
    await expect.poll(async () => (await H.kbdFocusState(page)).open).toBe(true);
    await page.evaluate((h) => {
      (window as unknown as { __setMockVvH: (h: number) => void }).__setMockVvH(h);
    }, VIEWPORT.height);
    await H.kbdFocusFlushDetection(page);
    await expect.poll(async () => (await H.kbdFocusState(page)).open).toBe(false);
    await H.assertSurvived(page, target, before, "real-path detected open→close");
  });
});
