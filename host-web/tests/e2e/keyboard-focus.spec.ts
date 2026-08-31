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

  // ---- 4. OFFSET COMPENSATION (root pinned to visible rect, continuous) ------
  //
  // The bug (operator on-device, Fold + soft keyboard): the host root had the
  // right SIZE (height = visible area) but the wrong POSITION — focusing an
  // editable in the cross-origin iframe makes the browser scroll the layout
  // viewport to reveal the caret, so visualViewport.offsetTop becomes nonzero
  // and the root (still at layout-y 0) scrolled off the top with a black body
  // band below it. The fix pins the root's top to offsetTop continuously. This
  // proves the MATH headlessly: the root's inline transform tracks offsetTop on
  // open, on a mid-typing scroll, and on a SECOND scroll (continuous re-apply,
  // not one-shot), then clears on close. The real soft-keyboard OUTCOME (no
  // scroll-up on a real Fold) is the operator's on-device retest gate — not
  // demonstrable headlessly (no engine opens a keyboard or scrolls a layout
  // viewport to reveal a cross-origin caret).

  test("keyboard-open pins the host root to the visible rect and re-pins on every scroll (offset compensation)", async ({ page }) => {
    const ids = await H.panes(page);
    const focused = await H.focused(page);
    const target = focused ?? ids[0];
    if (focused !== target) await H.focusPane(page, target);
    await page.waitForTimeout(200);
    const before = (await H.survival(page, target))!;

    // Sanity: no inline transform before the keyboard.
    expect(await H.appRootTransform(page), "no inline transform before keyboard").toBe("");

    // Install a controllable visualViewport mock: height + offsetTop getters
    // and a helper that sets both and OPTIONALLY dispatches resize/scroll on the
    // REAL visualViewport. The offset-compensation MATH is proven via the mock-
    // bridge (set values + bridge.reapplyGeometry) so it does NOT depend on
    // synthetic event delivery (firefox does not deliver synthetic visualViewport
    // events to addEventListener listeners); the event WIRING is proven in the
    // chromium-only test below.
    await page.evaluate(() => {
      const real = window.visualViewport!;
      let mockH = real.height;
      let mockOffset = 0;
      Object.defineProperty(real, "height", { configurable: true, get: () => mockH });
      Object.defineProperty(real, "offsetTop", { configurable: true, get: () => mockOffset });
      (window as unknown as {
        __setMockVv?: (h: number, offset: number, ev?: "resize" | "scroll") => void;
      }).__setMockVv = (h, offset, ev) => {
        mockH = h;
        mockOffset = offset;
        if (ev) real.dispatchEvent(new Event(ev));
      };
    });

    // --- OPEN with a caret-reveal offset already present (offsetTop = 80). ---
    // The real detection path reads BOTH height and offsetTop; the root must be
    // pinned to [80, 80+360], i.e. transform.top = 80, height = 360.
    await page.evaluate(
      ({ h, offset }) => {
        (window as unknown as { __setMockVv: (h: number, o: number) => void }).__setMockVv(h, offset);
      },
      { h: KEYBOARD_VISIBLE_H, offset: 80 },
    );
    await H.kbdFocusFlushDetection(page); // bypass debounce → applyOpen reads vv
    await expect.poll(async () => (await H.kbdFocusState(page)).open).toBe(true);
    // CRUX #1: the root's top is pinned to offsetTop (the visible-rect top),
    // not left at 0. Before the fix this was "" (no compensation) → the app
    // scrolled off the top with a black band below.
    await expect
      .poll(async () => H.appRootTransform(page), { timeout: 8000 })
      .toBe("translateY(80px)");
    await expect.poll(async () => H.appRootHeight(page), { timeout: 8000 }).toBe(KEYBOARD_VISIBLE_H);

    // --- CONTINUOUS re-apply: a mid-keyboard offset change re-pins the root. ---
    // The browser re-scrolls on caret moves mid-typing (offsetTop 80 → 150); the
    // root must re-pin to the NEW visible rect immediately — a single pin at
    // open is NOT enough (the contract). Driven through the bridge re-apply
    // (the exact function onVvEvent calls on every event) so the math is
    // engine-independent; the event-wiring is proven separately on chromium.
    await page.evaluate(
      ({ h, offset }) => {
        (window as unknown as { __setMockVv: (h: number, o: number) => void }).__setMockVv(h, offset);
      },
      { h: KEYBOARD_VISIBLE_H, offset: 150 },
    );
    await H.kbdFocusReapplyGeometry(page);
    await expect
      .poll(async () => H.appRootTransform(page), { timeout: 8000 })
      .toBe("translateY(150px)");
    await expect.poll(async () => H.appRootHeight(page), { timeout: 8000 }).toBe(KEYBOARD_VISIBLE_H);

    // --- A SECOND offset change (proves continuous re-apply, not one-shot). ---
    await page.evaluate(
      ({ h, offset }) => {
        (window as unknown as { __setMockVv: (h: number, o: number) => void }).__setMockVv(h, offset);
      },
      { h: KEYBOARD_VISIBLE_H, offset: 220 },
    );
    await H.kbdFocusReapplyGeometry(page);
    await expect
      .poll(async () => H.appRootTransform(page), { timeout: 8000 })
      .toBe("translateY(220px)");
    await expect.poll(async () => H.appRootHeight(page), { timeout: 8000 }).toBe(KEYBOARD_VISIBLE_H);

    // --- CLEAN RESTORE on close: offset compensation removed, original
    //     positioning restored exactly (transform cleared, height → CSS 100vh).
    await page.evaluate(
      ({ h, offset }) => {
        (window as unknown as { __setMockVv: (h: number, o: number) => void }).__setMockVv(h, offset);
      },
      { h: VIEWPORT.height, offset: 0 },
    );
    await H.kbdFocusFlushDetection(page);
    await expect.poll(async () => (await H.kbdFocusState(page)).open).toBe(false);
    await expect.poll(async () => H.appRootTransform(page), { timeout: 8000 }).toBe("");
    await expect
      .poll(async () => H.appRootHeight(page), { timeout: 8000 })
      .toBeGreaterThanOrEqual(VIEWPORT.height - 5);

    // Identity survived the whole pin → re-pin → re-pin → restore cycle.
    await H.assertSurvived(page, target, before, "offset-compensation pin→re-pin→restore");
  });

  // ---- 5. SCROLL-EVENT WIRING (scroll fires continuous re-apply) -------------
  //
  // Companion to the offset-compensation math test above: proves a real
  // visualViewport SCROLL event routes through onVvEvent → reapplyGeometryIfOpen
  // and re-pins the root mid-keyboard, WITHOUT a resize or a detection flush.
  // Chromium-only: firefox does not deliver synthetic visualViewport scroll
  // events via dispatchEvent (a headless-test limitation; the production
  // addEventListener("scroll", onVvEvent) wiring is engine-agnostic and the
  // shared re-apply MATH is proven cross-engine in the test above). WebKit is
  // skipped file-wide.

  test("a visualViewport scroll event re-pins the host root mid-keyboard (scroll-event wiring)", async ({ page, browserName }) => {
    test.skip(browserName !== "chromium", "synthetic visualViewport scroll dispatch is chromium-only");
    const ids = await H.panes(page);
    const focused = await H.focused(page);
    const target = focused ?? ids[0];
    if (focused !== target) await H.focusPane(page, target);
    await page.waitForTimeout(200);

    // Same controllable-vv mock as the offset math test.
    await page.evaluate(() => {
      const real = window.visualViewport!;
      let mockH = real.height;
      let mockOffset = 0;
      Object.defineProperty(real, "height", { configurable: true, get: () => mockH });
      Object.defineProperty(real, "offsetTop", { configurable: true, get: () => mockOffset });
      (window as unknown as {
        __setMockVv?: (h: number, offset: number, ev?: "resize" | "scroll") => void;
      }).__setMockVv = (h, offset, ev) => {
        mockH = h;
        mockOffset = offset;
        if (ev) real.dispatchEvent(new Event(ev));
      };
    });

    // Open with offset 0.
    await page.evaluate(
      ({ h, offset }) => {
        (window as unknown as { __setMockVv: (h: number, o: number) => void }).__setMockVv(h, offset);
      },
      { h: KEYBOARD_VISIBLE_H, offset: 0 },
    );
    await H.kbdFocusFlushDetection(page);
    await expect.poll(async () => (await H.kbdFocusState(page)).open).toBe(true);
    await expect.poll(async () => H.appRootTransform(page), { timeout: 8000 }).toBe("translateY(0px)");

    // A SCROLL event (offset change, NO resize, NO detection flush, NO bridge
    // call) must fire onVvEvent → reapplyGeometryIfOpen and re-pin the root to
    // the new offset. This is the continuous-re-apply contract: the browser
    // re-scrolls on caret moves mid-typing and the root follows every event,
    // not just keyboard-open.
    await page.evaluate(
      ({ h, offset, ev }) => {
        (window as unknown as { __setMockVv: (h: number, o: number, e: "resize" | "scroll") => void }).__setMockVv(h, offset, ev);
      },
      { h: KEYBOARD_VISIBLE_H, offset: 180, ev: "scroll" as const },
    );
    await expect
      .poll(async () => H.appRootTransform(page), { timeout: 8000 })
      .toBe("translateY(180px)");
    await expect.poll(async () => H.appRootHeight(page), { timeout: 8000 }).toBe(KEYBOARD_VISIBLE_H);

    // A second scroll (continuous, not one-shot).
    await page.evaluate(
      ({ h, offset, ev }) => {
        (window as unknown as { __setMockVv: (h: number, o: number, e: "resize" | "scroll") => void }).__setMockVv(h, offset, ev);
      },
      { h: KEYBOARD_VISIBLE_H, offset: 240, ev: "scroll" as const },
    );
    await expect
      .poll(async () => H.appRootTransform(page), { timeout: 8000 })
      .toBe("translateY(240px)");
  });

  // ---- 6. OWNERSHIP EDGES (review-defer F1/F2/F3, 2026-08-09) ----------------
  //
  // Three edge gaps around the focus-mode's MAXIMIZE OWNERSHIP model
  // (host-web/src/keyboardFocus.ts): what happens when the owned maximize's
  // world changes AFTER keyboard-open — a workspace switch re-points it (F1),
  // the user re-maximizes manually (F2), the visible viewport changes size
  // (F3). Deterministic headless MECHANISM pins of CURRENT behavior, driven
  // through this file's established seams (DEV bridge + vv mock + real ws-tab
  // clicks). No real soft-keyboard / real-device claims.

  test("F1: switching workspace while the keyboard is open re-points the owned maximize without reloading any iframe", async ({ page }) => {
    const ws1 = (await H.workspaces(page))[0];
    // Create ws B (addWorkspace ACTIVATES it — the keyboard is still closed,
    // so the activation effect no-ops) and give it one live pane.
    const ws2 = (await H.addWorkspace(page, "Kbd B"))!;
    const paneB = await H.addServer(page, H.serverUrl("kbdfocus-ws-b"), "Kbd B pane");
    expect(paneB, "ws B got a live pane").toBeTruthy();
    await H.waitForReady(page, paneB!);
    // Back to ws A via the REAL ws-tab click (the operator's actual gesture —
    // there is a real UI control for switching, so we use it).
    await page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`).click();
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws1);

    const ids = await H.panes(page);
    const focused = await H.focused(page);
    const target = focused ?? ids[0];
    if (focused !== target) await H.focusPane(page, target);
    await page.waitForTimeout(200); // Dockview overlay positioning settle (file idiom)
    const beforeA = (await H.survival(page, target))!;
    const beforeB = (await H.survival(page, paneB!))!;

    // Keyboard opens in ws A: A's focused group maximized, ownership = ws A.
    await H.kbdFocusOpen(page, KEYBOARD_VISIBLE_H);
    await expect.poll(async () => H.isMaximized(page)).toBe(true);
    await expect.poll(async () => (await H.kbdFocusState(page)).ownedWs).toBe(ws1);
    await expect.poll(async () => H.appRootHeight(page)).toBe(KEYBOARD_VISIBLE_H);

    // SWITCH to ws B with the keyboard open (real tab click). App.tsx's effect
    // (activeWorkspaceId → onWorkspaceActivated) must: exit ws A's owned
    // maximize, maximize ws B's focused pane, re-point ownership to B.
    await page.locator(`[data-testid="ws-tab"][data-workspace="${ws2}"]`).click();
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws2);
    // CRUX — ownership re-pointed at ws B. (isMaximized reads the ACTIVE ws,
    // so "maximized" here is B's group, not a leftover of A's.)
    await expect
      .poll(async () => (await H.kbdFocusState(page)).ownedWs, { timeout: 8000 })
      .toBe(ws2);
    await expect.poll(async () => H.isMaximized(page), { timeout: 8000 }).toBe(true);
    // The keyboard itself stays open — the shrunk root is host-global.
    await expect.poll(async () => H.appRootHeight(page)).toBe(KEYBOARD_VISIBLE_H);
    // NO iframe reloaded across the switch: A's pane identity intact with a
    // fresh heartbeat (the now-hidden pane is still mounted + beating).
    await H.assertSurvived(page, target, beforeA, "keyboard-open workspace switch (ws A pane)");

    // SWITCH BACK to ws A: exit B's owned maximize, re-maximize A's focused
    // pane, ownership back to A. Consistency check with the ownership model:
    // had the first switch NOT exited A's maximize, maximizeActive() would
    // find hasMaximizedGroup() true here and set ownedWs=null instead — so
    // ownedWs=ws1 below ALSO proves the exit on the first switch happened.
    await page.locator(`[data-testid="ws-tab"][data-workspace="${ws1}"]`).click();
    await expect.poll(async () => H.activeWorkspace(page)).toBe(ws1);
    await expect
      .poll(async () => (await H.kbdFocusState(page)).ownedWs, { timeout: 8000 })
      .toBe(ws1);
    await expect.poll(async () => H.isMaximized(page), { timeout: 8000 }).toBe(true);
    await expect.poll(async () => H.appRootHeight(page)).toBe(KEYBOARD_VISIBLE_H);

    // Close: exits A's owned maximize, restores the root, ownership null.
    await H.kbdFocusClose(page);
    await expect.poll(async () => H.isMaximized(page), { timeout: 8000 }).toBe(false);
    await expect.poll(async () => (await H.kbdFocusState(page)).ownedWs).toBeNull();
    await expect
      .poll(async () => H.appRootHeight(page), { timeout: 8000 })
      .toBeGreaterThanOrEqual(VIEWPORT.height - 5);
    // Both panes (A's and B's) survived the whole open→switch→switch→close
    // dance without a reload — workspace switching is CSS-visibility-only.
    await H.assertSurvived(page, target, beforeA, "F1 full cycle (ws A pane)");
    await H.assertSurvived(page, paneB!, beforeB, "F1 full cycle (ws B pane)");
  });

  // F2 — POST-OPEN RE-MAXIMIZE (review-defer 2026-08-09; FIXED by group-
  // instance ownership). Ownership used to be recorded per WORKSPACE at open
  // time (keyboardFocus.ts `ownedWs`), and close's exitOwned() exited whatever
  // group was CURRENTLY maximized in that ws — it could not distinguish
  // focus-mode's own (already-replaced) maximize from the user's LATER manual
  // one, so close CLOBBERED the user's re-maximize (the pinned defect this
  // test used to tripwire as candidate-defect).
  //
  // The fix scopes ownership to the GROUP INSTANCE focus-mode maximized
  // (OwnedMaximize {ws, groupId} in keyboardFocus.ts): close exits ONLY if the
  // group it maximized is STILL the maximized one. Semantics pinned here:
  //   - DIFFERENT group re-maximized after open (the crux): close must NOT
  //     touch it — the user's maximize survives.
  //   - SAME group re-maximized after open: close DOES exit it. A re-maximize
  //     of the owned group recreates the exact state focus-mode entered
  //     (indistinguishable), so ownership follows the group instance, not the
  //     maximize episode — close restores the pre-open layout.
  // Contrast the pre-open case (test above: manual maximize BEFORE open
  // survives close — there ownership is never claimed because maximizeActive()
  // sees hasMaximizedGroup() true at OPEN time).
  test("F2: keyboard-close preserves a manual re-maximize of a different group made after keyboard-open (exits a same-group re-maximize)", async ({ page }) => {
    // Two side-by-side panes = two groups (deterministic manual-maximize
    // target; the keyboard-open maximize owns a's group, the user re-maxes b).
    const [a, b] = await H.twoPanes(page);
    await H.focusPane(page, a);
    await page.waitForTimeout(200);
    const beforeA = (await H.survival(page, a))!;
    const beforeB = (await H.survival(page, b))!;

    // Keyboard opens: a's group maximized, focus-mode owns it (ownedWs = ws).
    await H.kbdFocusOpen(page, KEYBOARD_VISIBLE_H);
    await expect.poll(async () => H.isMaximized(page)).toBe(true);
    const ws = (await H.kbdFocusState(page)).ownedWs;
    expect(ws, "focus-mode owns the maximize it entered").toBeTruthy();
    await expect.poll(async () => H.appRootHeight(page)).toBe(KEYBOARD_VISIBLE_H);

    // The user manually exits the maximize, then manually re-maximizes a
    // DIFFERENT group (b). These bridge calls drive the exact dockview api
    // sequence the real gesture path (toggleZoom, hostController.ts) produces
    // — the shell has no clickable zoom control anymore (the statusbar zoom
    // cluster was removed), so the bridge IS the manual-action surrogate.
    await H.exitMaximized(page);
    await expect.poll(async () => H.isMaximized(page)).toBe(false);
    await H.maximize(page, b);
    await expect.poll(async () => H.isMaximized(page)).toBe(true);
    // The bridge's ownedWs still names the open-time ws (ownership was not
    // re-claimed — nothing in the manual path notifies keyboardFocus), but
    // with group-instance ownership that is no longer a clobber hazard: close
    // compares the owned GROUP id, and b's group is not it.
    expect(
      (await H.kbdFocusState(page)).ownedWs,
      "ownership still names the open-time ws (group id is the guard now)",
    ).toBe(ws);

    // Keyboard closes. FIXED behavior: the currently-maximized group (b's) is
    // not the group focus-mode owns → close leaves the user's manual
    // re-maximize alone.
    await H.kbdFocusClose(page);
    await expect
      .poll(async () => H.isMaximized(page), { timeout: 8000 })
      .toBe(true); // the user's manual re-maximize SURVIVES close (fixed)
    await expect.poll(async () => (await H.kbdFocusState(page)).ownedWs).toBeNull();
    await expect
      .poll(async () => H.appRootHeight(page), { timeout: 8000 })
      .toBeGreaterThanOrEqual(VIEWPORT.height - 5);

    // --- Edge pin: SAME-group re-maximize IS exited on close ----------------
    // (decision: ownership follows the group instance; a re-maximize of the
    // owned group recreates the state focus-mode entered, so close restores
    // the pre-open layout.) Clean b's maximize, then re-run the dance with
    // the user re-maximizing the SAME group keyboard-open owned.
    await H.exitMaximized(page);
    await expect.poll(async () => H.isMaximized(page)).toBe(false);
    await H.focusPane(page, a);
    await page.waitForTimeout(200);
    await H.kbdFocusOpen(page, KEYBOARD_VISIBLE_H);
    await expect.poll(async () => H.isMaximized(page)).toBe(true);
    expect((await H.kbdFocusState(page)).ownedWs, "focus-mode owns again").toBeTruthy();
    await H.exitMaximized(page); // user exits focus-mode's maximize
    await expect.poll(async () => H.isMaximized(page)).toBe(false);
    await H.maximize(page, a); // user re-maximizes the SAME group
    await expect.poll(async () => H.isMaximized(page)).toBe(true);
    await H.kbdFocusClose(page);
    await expect
      .poll(async () => H.isMaximized(page), { timeout: 8000 })
      .toBe(false); // same-group re-maximize is still ours → exited
    await expect.poll(async () => (await H.kbdFocusState(page)).ownedWs).toBeNull();
    await expect
      .poll(async () => H.appRootHeight(page), { timeout: 8000 })
      .toBeGreaterThanOrEqual(VIEWPORT.height - 5);

    // No reload through the whole maximize-ownership dance.
    await H.assertSurvived(page, a, beforeA, "F2 open→manual re-maximize→close (a)");
    await H.assertSurvived(page, b, beforeB, "F2 open→manual re-maximize→close (b)");
  });

  // F3 — POST-OPEN VIEWPORT RESIZE (review-defer 2026-08-09): after the
  // keyboard is open, a visualViewport HEIGHT change (suggestion bar /
  // accessory bar appearing on top of the keyboard — still below the open
  // threshold, so no close transition) must keep the host-root geometry
  // tracking the visible area. Two proofs, mirroring tests 4/5's split:
  //   A (chromium+firefox): the re-apply MATH via the bridge's reapplyGeometry
  //      — the exact function the production resize listener calls.
  //   B (chromium only): the real EVENT WIRING — a synthetic resize dispatched
  //      on the real visualViewport (no bridge call, no detection flush) re-
  //      pins the root through onVvEvent. Firefox is excluded for the same
  //      documented reason as test 5: it does not deliver synthetic
  //      visualViewport events to addEventListener listeners.
  test("F3: a post-open visualViewport height change re-tracks the host-root geometry", async ({ page, browserName }) => {
    const ids = await H.panes(page);
    const focused = await H.focused(page);
    const target = focused ?? ids[0];
    if (focused !== target) await H.focusPane(page, target);
    await page.waitForTimeout(200);
    const before = (await H.survival(page, target))!;

    // Controllable-vv mock (file idiom): height + offsetTop getters + optional
    // real-event dispatch.
    await page.evaluate(() => {
      const real = window.visualViewport!;
      let mockH = real.height;
      let mockOffset = 0;
      Object.defineProperty(real, "height", { configurable: true, get: () => mockH });
      Object.defineProperty(real, "offsetTop", { configurable: true, get: () => mockOffset });
      (window as unknown as {
        __setMockVv?: (h: number, offset: number, ev?: "resize" | "scroll") => void;
      }).__setMockVv = (h, offset, ev) => {
        mockH = h;
        mockOffset = offset;
        if (ev) real.dispatchEvent(new Event(ev));
      };
    });

    // Open through the REAL detection path (mock shrink + flush).
    await page.evaluate((h) => {
      (window as unknown as { __setMockVv: (h: number, o: number) => void }).__setMockVv(h, 0);
    }, KEYBOARD_VISIBLE_H);
    await H.kbdFocusFlushDetection(page);
    await expect.poll(async () => (await H.kbdFocusState(page)).open).toBe(true);
    await expect.poll(async () => H.appRootHeight(page), { timeout: 8000 }).toBe(KEYBOARD_VISIBLE_H);

    // --- A: post-open HEIGHT shrink (accessory bar): 360 → 300, offset too. ---
    // BOTH dimensions move together (unlike test 4, which holds h constant and
    // varies only the offset): the root must track the new height AND the new
    // offset in the same re-apply.
    await page.evaluate(
      ({ h, offset }) => {
        (window as unknown as { __setMockVv: (h: number, o: number) => void }).__setMockVv(h, offset);
      },
      { h: 300, offset: 40 },
    );
    await H.kbdFocusReapplyGeometry(page);
    await expect.poll(async () => H.appRootHeight(page), { timeout: 8000 }).toBe(300);
    await expect.poll(async () => H.appRootTransform(page), { timeout: 8000 }).toBe("translateY(40px)");
    // Still open — a height change WITHIN the keyboard-open band is not a
    // close transition (300 < 0.7*740 = 518).
    expect((await H.kbdFocusState(page)).open, "in-band resize does not close").toBe(true);

    // A second change (continuous tracking, not one-shot): 300 → 260.
    await page.evaluate(
      ({ h, offset }) => {
        (window as unknown as { __setMockVv: (h: number, o: number) => void }).__setMockVv(h, offset);
      },
      { h: 260, offset: 0 },
    );
    await H.kbdFocusReapplyGeometry(page);
    await expect.poll(async () => H.appRootHeight(page), { timeout: 8000 }).toBe(260);
    await expect.poll(async () => H.appRootTransform(page), { timeout: 8000 }).toBe("translateY(0px)");

    // --- B: real resize EVENT wiring (chromium only; see header comment) -----
    if (browserName === "chromium") {
      // A dispatched resize — NO bridge call, NO detection flush — must route
      // onVvEvent → reapplyGeometryIfOpen and re-pin the root to the new vv.
      await page.evaluate(
        ({ h, offset, ev }) => {
          (window as unknown as { __setMockVv: (h: number, o: number, e: "resize" | "scroll") => void }).__setMockVv(h, offset, ev);
        },
        { h: 320, offset: 0, ev: "resize" as const },
      );
      await expect.poll(async () => H.appRootHeight(page), { timeout: 8000 }).toBe(320);
      expect((await H.kbdFocusState(page)).open, "in-band resize does not close").toBe(true);
      // And again (event-driven tracking is continuous too).
      await page.evaluate(
        ({ h, offset, ev }) => {
          (window as unknown as { __setMockVv: (h: number, o: number, e: "resize" | "scroll") => void }).__setMockVv(h, offset, ev);
        },
        { h: 280, offset: 0, ev: "resize" as const },
      );
      await expect.poll(async () => H.appRootHeight(page), { timeout: 8000 }).toBe(280);
    }

    // Close through the real path: grow past the threshold + flush.
    await page.evaluate(
      ({ h, offset }) => {
        (window as unknown as { __setMockVv: (h: number, o: number) => void }).__setMockVv(h, offset);
      },
      { h: VIEWPORT.height, offset: 0 },
    );
    await H.kbdFocusFlushDetection(page);
    await expect.poll(async () => (await H.kbdFocusState(page)).open, { timeout: 8000 }).toBe(false);
    await expect
      .poll(async () => H.appRootHeight(page), { timeout: 8000 })
      .toBeGreaterThanOrEqual(VIEWPORT.height - 5);
    await expect.poll(async () => H.appRootTransform(page), { timeout: 8000 }).toBe("");
    // Identity survived the whole open → resize → resize → close cycle.
    await H.assertSurvived(page, target, before, "F3 post-open vv resize cycle");
  });
});
