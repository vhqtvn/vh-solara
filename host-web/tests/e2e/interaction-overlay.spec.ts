import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as H from "./util";

/** Read the focus-indicator OUTCOME for a pane: the .is-active class presence +
 *  the computed 3px outline + the 5px ::before top edge. This is the observable
 *  signal (not just the class mechanism) the operator sees move when activation
 *  changes. Runs in the browser via locator.evaluate. */
async function focusIndicatorStyle(
  page: Page,
  paneId: string,
): Promise<{ isActive: boolean; outline: string; beforeHeight: string }> {
  return page.locator(`.pane[data-pane-id="${paneId}"]`).evaluate((el) => ({
    isActive: el.classList.contains("is-active"),
    outline: window.getComputedStyle(el).outlineWidth,
    beforeHeight: window.getComputedStyle(el, "::before").height,
  }));
}

/**
 * Layout overlay interaction model (replaces the dropped Alt keyboard shortcuts).
 *
 * Covers: (1) the host-gesture protocol security (closed payload, source-bound
 * pane derivation, origin check); (2) overlay open/action/close + dismiss modes
 * + tabstrip-clickability + idempotent re-anchor; (3) the focus indicator +
 * reduced-motion; (4) the split-target fix (non-first-pane setLayoutMode anchors
 * on the source, not panels[0]); (5) workspace-switch dismissal + NEXT
 * composability. One screenshot per feature under
 * tmp/host-web-playwright/vision/interaction/ (gitignored). Chromium only.
 *
 * The host-gesture MESSAGE is driven through probePaneMessage (the real
 * routeMessage, with a real pane's contentWindow as source) — the SAME path the
 * SPA's hostGesture.ts posts. The overlay ops (open/close/split) are driven
 * through the production HostOps path (the DEV bridge openLayoutOverlay routes
 * through the same hostOps().openLayoutOverlay the gesture does). The statusbar
 * Layout button that used to also open the overlay was removed with the
 * statusbar; the overlay is gesture + DEV-bridge triggered now.
 */
const REPO_ROOT = path.resolve(process.cwd(), "..");
const VISION_DIR = path.join(REPO_ROOT, "tmp/host-web-playwright/vision/interaction");

test.beforeAll(() => {
  fs.mkdirSync(VISION_DIR, { recursive: true });
});

const WRONG_ORIGIN = "http://127.0.0.1:9999";

test.describe("layout overlay interaction model", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  // ---- (1) protocol security ------------------------------------------------

  test("protocol: a valid host-gesture opens the overlay for the SOURCE pane", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    expect(await H.overlaySource(page), "overlay closed before any gesture").toBeNull();

    const r = await H.probePaneMessage(page, {
      sourcePaneId: pane,
      origin: H.MOCK_ORIGIN,
      payload: { type: "host-gesture", gesture: "layout-overlay-request" },
    });
    expect(r.accepted, "valid host-gesture accepted").toBe(true);
    expect(r.paneId, "pane derived from event.source").toBe(pane);
    expect(r.reason).toBe("accepted:non-heartbeat");

    await expect.poll(async () => H.overlaySource(page)).toBe(pane);
    // The source pane received focus (focusPane via openLayoutOverlay).
    await expect.poll(async () => H.focused(page)).toBe(pane);
    // The overlay card + the source's focus badge rendered.
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    await expect(page.locator(`.pane[data-pane-id="${pane}"].is-overlay-source`)).toHaveCount(1);

    await page.screenshot({ path: path.join(VISION_DIR, "01-gesture-open.png"), fullPage: true });
  });

  test("protocol: rejects an unknown field (closed payload)", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const r = await H.probePaneMessage(page, {
      sourcePaneId: pane,
      origin: H.MOCK_ORIGIN,
      // A poison paneId + dir must cause rejection — the host accepts ONLY
      // {type, gesture}. The host never trusts a sender-claimed id (and here it
      // rejects the whole message before any action).
      payload: { type: "host-gesture", gesture: "layout-overlay-request", paneId: "evil", dir: "/x" },
    });
    expect(r.accepted, "unknown field rejected").toBe(false);
    expect(r.reason).toBe("ignored-non-pane-to-host");
    expect(await H.overlaySource(page), "overlay not opened").toBeNull();
  });

  test("protocol: rejects a bad gesture value", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const r = await H.probePaneMessage(page, {
      sourcePaneId: pane,
      origin: H.MOCK_ORIGIN,
      payload: { type: "host-gesture", gesture: "something-else" },
    });
    expect(r.accepted, "bad gesture rejected").toBe(false);
    expect(r.reason).toBe("ignored-non-pane-to-host");
    expect(await H.overlaySource(page)).toBeNull();
  });

  test("protocol: rejects a bad type value (not host-gesture)", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const r = await H.probePaneMessage(page, {
      sourcePaneId: pane,
      origin: H.MOCK_ORIGIN,
      payload: { type: "host-gesture-typo", gesture: "layout-overlay-request" },
    });
    expect(r.accepted, "bad type rejected").toBe(false);
    expect(await H.overlaySource(page)).toBeNull();
  });

  test("protocol: rejects an unregistered source (no pane bound)", async ({ page }) => {
    // sourcePaneId that does not exist → lookupContentWindow returns null → the
    // router treats it as an unknown source (rejected:unknown-source).
    const r = await H.probePaneMessage(page, {
      sourcePaneId: "nonexistent-pane",
      origin: H.MOCK_ORIGIN,
      payload: { type: "host-gesture", gesture: "layout-overlay-request" },
    });
    expect(r.accepted, "unknown source rejected").toBe(false);
    expect(r.reason).toBe("rejected:unknown-source");
    expect(await H.overlaySource(page)).toBeNull();
  });

  test("protocol: rejects a wrong-origin gesture (origin-checked tier)", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const r = await H.probePaneMessage(page, {
      sourcePaneId: pane,
      origin: WRONG_ORIGIN,
      payload: { type: "host-gesture", gesture: "layout-overlay-request" },
    });
    expect(r.accepted, "wrong-origin gesture rejected").toBe(false);
    expect(r.reason).toBe("rejected:origin-mismatch");
    expect(await H.overlaySource(page), "no focus/overlay mutation").toBeNull();
  });

  test("protocol: host derives the pane from event.source (a poison id field cannot redirect)", async ({ page }) => {
    const ids = await H.panes(page);
    const source = ids[0];
    const other = ids[1];
    // Post from `source`'s contentWindow. Even though the SPA sends NO id, prove
    // the host binds to `source` (not `other`). (A payload WITH an id field is
    // rejected outright by the closed-payload test above; this test proves the
    // source-binding for the clean payload.)
    await H.probePaneMessage(page, {
      sourcePaneId: source,
      origin: H.MOCK_ORIGIN,
      payload: { type: "host-gesture", gesture: "layout-overlay-request" },
    });
    await expect.poll(async () => H.overlaySource(page)).toBe(source);
    expect(await H.overlaySource(page), "bound to source, not other").not.toBe(other);
    await H.closeLayoutOverlay(page);
  });

  // ---- (2) overlay open / action / close + dismiss + tabstrip clickable -----

  test("DEV-bridge openLayoutOverlay opens the overlay for the focused pane", async ({ page }) => {
    const ids = await H.panes(page);
    await H.focusPane(page, ids[0]);
    await expect.poll(async () => H.focused(page)).toBe(ids[0]);

    // The statusbar Layout button is gone (statusbar removed); the overlay is
    // gesture-triggered in production. The DEV bridge openLayoutOverlay routes
    // through the SAME hostOps().openLayoutOverlay the gesture does, so this
    // proves the production open path end-to-end.
    await H.openLayoutOverlay(page, ids[0]);
    await expect.poll(async () => H.overlaySource(page)).toBe(ids[0]);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    await page.screenshot({ path: path.join(VISION_DIR, "02-open.png"), fullPage: true });
  });

  test("overlay arrow splits the SOURCE pane (above) and survives", async ({ page }) => {
    const ids = await H.panes(page);
    const source = ids[0];
    await H.focusPane(page, source);
    await H.openLayoutOverlay(page, source);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    const before = await H.survival(page, source);

    const beforeCount = (await H.panes(page)).length;
    const created = await H.overlaySplit(page, source, "above");
    expect(created, "arrow split created a new pane").toBeTruthy();
    await expect.poll(async () => (await H.panes(page)).length).toBe(beforeCount + 1);
    // A split auto-closes the overlay.
    await expect.poll(async () => H.overlaySource(page)).toBeNull();
    // The source iframe survived the split (renderer:'always').
    await H.assertSurvived(page, source, before!, "source pane across overlay split-above");
  });

  test("overlay arrow splits right (survival) + new pane becomes active", async ({ page }) => {
    const ids = await H.panes(page);
    const source = ids[0];
    await H.openLayoutOverlay(page, source);
    const before = await H.survival(page, source);
    const created = await H.overlaySplit(page, source, "right");
    expect(created).toBeTruthy();
    await H.assertSurvived(page, source, before!, "source pane across overlay split-right");
    // The new pane is active (matching split() behavior).
    await expect.poll(async () => H.focused(page)).toBe(created);
  });

  test("Esc dismisses the overlay", async ({ page }) => {
    const ids = await H.panes(page);
    await H.openLayoutOverlay(page, ids[0]);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect.poll(async () => H.overlaySource(page)).toBeNull();
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toHaveCount(0);
  });

  test("Close button dismisses the overlay", async ({ page }) => {
    const ids = await H.panes(page);
    await H.openLayoutOverlay(page, ids[0]);
    await page.locator('[data-testid="layout-overlay-close"]').click();
    await expect.poll(async () => H.overlaySource(page)).toBeNull();
  });

  test("outside-click (within main) dismisses the overlay", async ({ page }) => {
    const ids = await H.panes(page);
    await H.openLayoutOverlay(page, ids[0]);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    // Click the capture layer (outside the card, inside main).
    await page.locator('[data-testid="layout-overlay-capture"]').click();
    await expect.poll(async () => H.overlaySource(page)).toBeNull();
  });

  test("tabstrip stays clickable while the overlay is open (Layering gate)", async ({ page }) => {
    const ids = await H.panes(page);
    await H.openLayoutOverlay(page, ids[0]);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    // The AddServer trigger is OUTSIDE <main> (in the tabstrip, a sibling of
    // <main>) → not covered by the capture layer → still clickable. Clicking it
    // toggles its popover without dismissing the overlay (the popover is a
    // tabstrip child too, not inside <main>).
    const add = page.locator('[data-testid="add-server-btn"]');
    await expect(add).toBeEnabled();
    await add.click();
    await expect(page.locator('[data-testid="add-server-popover"]')).toBeVisible();
    // The overlay is still open (the capture layer does not reach the tabstrip).
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    // The workspace tabs are also still clickable (a sibling of <main>).
    await expect(page.locator('[data-testid="ws-tab"]').first()).toBeEnabled();
  });

  test("idempotent re-anchor: a second request re-anchors, no stacking", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    const b = ids[1];
    await H.openLayoutOverlay(page, a);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toHaveCount(1);
    await expect(page.locator(`.pane[data-pane-id="${a}"].is-overlay-source`)).toHaveCount(1);

    // A second valid request re-anchors to b.
    await H.openLayoutOverlay(page, b);
    await expect.poll(async () => H.overlaySource(page)).toBe(b);
    // Still exactly ONE card (no stacking).
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toHaveCount(1);
    // The badge moved from a to b.
    await expect(page.locator(`.pane[data-pane-id="${a}"].is-overlay-source`)).toHaveCount(0);
    await expect(page.locator(`.pane[data-pane-id="${b}"].is-overlay-source`)).toHaveCount(1);

    await page.screenshot({ path: path.join(VISION_DIR, "03-re-anchor.png"), fullPage: true });
  });

  // ---- (3) focus indicator + reduced-motion --------------------------------

  test("focus indicator: exactly one pane is active; the source carries the badge", async ({ page }) => {
    const ids = await H.panes(page);
    const source = ids[0];
    await H.focusPane(page, source);
    // Exactly one pane has the strong focus indicator (.is-active).
    await expect.poll(async () => page.locator(".pane.is-active").count()).toBe(1);
    // Before the overlay opens, no pane carries the overlay-source badge.
    await expect(page.locator(".pane.is-overlay-source")).toHaveCount(0);

    await H.openLayoutOverlay(page, source);
    // Exactly the source carries the badge while the overlay is open.
    await expect(page.locator(`.pane[data-pane-id="${source}"].is-overlay-source`)).toHaveCount(1);
    await expect(page.locator(".pane.is-overlay-source")).toHaveCount(1);

    await page.screenshot({ path: path.join(VISION_DIR, "04-focus-indicator.png"), fullPage: true });
  });

  test("reduced-motion disables the focus pulse animation (solid indicator kept)", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const ids = await H.panes(page);
    const source = ids[0];
    await H.focusPane(page, ids[1]);
    await H.focusPane(page, source);
    // Under reduced-motion the pulse class is still toggled (so the mechanism is
    // observable) but the CSS animation is disabled. Assert: the pane has the
    // pulse class AND the computed animation-name is "none" (the @media rule).
    const pulseInfo = await page.locator(`.pane[data-pane-id="${source}"]`).evaluate((el) => {
      const cls = el.classList.contains("pane-focus-pulse");
      const before = window.getComputedStyle(el, "::before");
      return { hasPulseClass: cls, animName: before.animationName, animDuration: before.animationDuration };
    });
    expect(pulseInfo.hasPulseClass, "pulse class toggled").toBe(true);
    expect(pulseInfo.animName, "no animation under reduced-motion").toBe("none");
    // The solid indicator (3px outline + 5px top edge) is still present.
    const outline = await page.locator(`.pane[data-pane-id="${source}"]`).evaluate((el) => ({
      outline: window.getComputedStyle(el).outlineWidth,
      beforeHeight: window.getComputedStyle(el, "::before").height,
    }));
    expect(outline.outline, "3px outline kept").toBe("3px");
    expect(outline.beforeHeight, "5px top edge kept").toBe("5px");
  });

  // ---- (4) split-target fix (non-first-pane setLayoutMode anchors on source) -

  test("split-target fix: setLayoutMode split-h anchors on the SOURCE (not panels[0])", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    // Split a → creates b2 in its own group; a and b2 are separate panes.
    const b2 = await H.split(page, a, "right");
    expect(b2).toBeTruthy();
    await H.waitForReady(page, b2!);
    // Dock a INTO b2's group as a tab (so the group holds both). After docking
    // the group's panels[0] is b2 (the original), and a is appended → a is NOT
    // panels[0]. This is the fixture: a non-first-pane source.
    await H.dockAsTab(page, a, b2!);
    await expect.poll(async () => H.sameGroup(page, a, b2!)).toBe(true);

    // Capture survival before the mode switch.
    const before = await H.survival(page, a);

    // setLayoutMode split-h on the SOURCE (a, which is NOT panels[0]). The fix:
    // the break-out anchors on a and a stays active. The bug would have anchored
    // on panels[0] (b2) + activated b2.
    await H.setLayoutModeBridge(page, a, "split-h");
    // a is active (the source), NOT panels[0] (b2).
    await expect.poll(async () => H.focused(page), { timeout: 5000 }).toBe(a);
    // The two are now in SEPARATE groups again (break-out).
    await expect.poll(async () => H.sameGroup(page, a, b2!)).toBe(false);
    // a survived (renderer:'always').
    await H.assertSurvived(page, a, before!, "source pane across split-h break-out");

    await page.screenshot({ path: path.join(VISION_DIR, "05-split-target-fix.png"), fullPage: true });
  });

  // ---- (5) workspace-switch dismissal + NEXT composability -------------------

  test("workspace-switch dismisses the overlay (CSS-only switch, survival-safe)", async ({ page }) => {
    const ids = await H.panes(page);
    await H.openLayoutOverlay(page, ids[0]);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    // Create + switch to a new workspace.
    const ws = await H.addWorkspace(page, "second");
    expect(ws).toBeTruthy();
    await H.setActiveWorkspace(page, ws!);
    // The overlay dismissed (active-workspace-scoped).
    await expect.poll(async () => H.overlaySource(page)).toBeNull();
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toHaveCount(0);
  });

  test("NEXT composability: the tabstrip NEXT button stays clickable while the overlay is open", async ({ page }) => {
    const ids = await H.panes(page);
    // Drive a needs-permission status on a non-source pane so the NEXT button
    // appears, then open the overlay + assert NEXT is still present + clickable.
    await H.probeStatus(page, {
      sourcePaneId: ids[1],
      origin: H.MOCK_ORIGIN,
      payload: { type: "status", dir: "/p", session: "s1", title: "T", attention: "needs_permission", activity: "running", following: true },
    });
    await expect.poll(async () => H.needsYou(page), { timeout: 8000 }).toBe(1);
    await expect(page.locator('[data-testid="attention-next"]')).toBeVisible();

    await H.openLayoutOverlay(page, ids[0]);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    // NEXT moved from the statusbar into the tabstrip (a sibling of <main>), so
    // it is STILL outside the capture layer → visible + enabled while the overlay
    // is open. This is the moved-button analogue of the Layering gate above.
    await expect(page.locator('[data-testid="attention-next"]')).toBeVisible();
    await expect(page.locator('[data-testid="attention-next"]')).toBeEnabled();
    // Clicking NEXT still routes (focus the needy pane). The overlay is dismissed
    // by the workspace/cross-pane focus? NEXT focuses a pane in the SAME ws, so
    // the overlay stays open but re-anchored is NOT triggered (NEXT only focuses,
    // does not open the overlay). Assert NEXT is clickable without error.
    await page.locator('[data-testid="attention-next"]').click();
    // The needy pane became focused (NEXT routed through attentionNext).
    await expect.poll(async () => H.focused(page)).toBe(ids[1]);
  });

  // ---- (6) pane-activate (tap-to-focus bridge) ------------------------------
  // The SPA forwards {type:"host-gesture",gesture:"pane-activate"} when it gets
  // focus (desktop click-into-pane) or on pointerdown (mobile tap). The host
  // activates the source pane (focusPane → setActive → onDidActivePanelChange
  // → focusedId + is-active + visual indicator). This closes the regression
  // where tapping inside a cross-origin iframe never reached Dockview's native
  // activation (Phase 1 removed the per-pane headers — the only host-DOM click
  // target). Probed through the REAL routeMessage (same path the SPA's
  // hostGesture.ts posts); same security model as layout-overlay-request.

  test("pane-activate: a valid gesture moves focus + is-active + the visual indicator to the source pane", async ({ page }) => {
    const ids = await H.panes(page);
    const stale = ids[0];
    const target = ids[1];
    // Start with the focus on pane[0] (the stale pane).
    await H.focusPane(page, stale);
    await expect.poll(async () => H.focused(page)).toBe(stale);
    // Scene: the stale pane is active, the target is not.
    expect((await focusIndicatorStyle(page, stale)).isActive, "stale active before").toBe(true);
    expect((await focusIndicatorStyle(page, target)).isActive, "target not active before").toBe(false);

    await page.screenshot({ path: path.join(VISION_DIR, "06a-activate-before.png"), fullPage: true });

    // Probe-post pane-activate from the target's contentWindow (the SAME path
    // the SPA's hostGesture.ts uses).
    const r = await H.probePaneMessage(page, {
      sourcePaneId: target,
      origin: H.MOCK_ORIGIN,
      payload: { type: "host-gesture", gesture: "pane-activate" },
    });
    expect(r.accepted, "pane-activate accepted").toBe(true);
    expect(r.paneId, "pane derived from event.source").toBe(target);
    expect(r.reason).toBe("accepted:non-heartbeat");

    // OUTCOME: focusedId + is-active + visual indicator all moved to target.
    await expect.poll(async () => H.focused(page)).toBe(target);
    const targetAfter = await focusIndicatorStyle(page, target);
    const staleAfter = await focusIndicatorStyle(page, stale);
    expect(targetAfter.isActive, "target is-active after").toBe(true);
    expect(targetAfter.outline, "target has 3px outline after").toBe("3px");
    expect(targetAfter.beforeHeight, "target has 5px top edge after").toBe("5px");
    expect(staleAfter.isActive, "stale lost is-active after").toBe(false);
    // Exactly one pane is active.
    await expect.poll(async () => page.locator(".pane.is-active").count()).toBe(1);

    await page.screenshot({ path: path.join(VISION_DIR, "06b-activate-after.png"), fullPage: true });
  });

  test("pane-activate: idempotent — re-post from the already-active pane is a no-op", async ({ page }) => {
    const ids = await H.panes(page);
    const target = ids[1];
    await H.focusPane(page, target);
    await expect.poll(async () => H.focused(page)).toBe(target);

    // First activate from the active pane — accepted, no thrash.
    const r1 = await H.probePaneMessage(page, {
      sourcePaneId: target,
      origin: H.MOCK_ORIGIN,
      payload: { type: "host-gesture", gesture: "pane-activate" },
    });
    expect(r1.accepted, "activate on active pane accepted").toBe(true);
    await expect.poll(async () => H.focused(page)).toBe(target);

    // Second activate from the same pane — still accepted, focus unchanged.
    const r2 = await H.probePaneMessage(page, {
      sourcePaneId: target,
      origin: H.MOCK_ORIGIN,
      payload: { type: "host-gesture", gesture: "pane-activate" },
    });
    expect(r2.accepted, "repeat activate accepted").toBe(true);
    expect(await H.focused(page), "focus unchanged after repeat").toBe(target);
  });

  test("pane-activate: dismisses the overlay when open for a DIFFERENT pane", async ({ page }) => {
    const ids = await H.panes(page);
    const overlayPane = ids[0];
    const activator = ids[1];
    await H.openLayoutOverlay(page, overlayPane);
    await expect.poll(async () => H.overlaySource(page)).toBe(overlayPane);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();

    // Activate a DIFFERENT pane → overlay dismisses (focus moved away from the
    // overlay's source).
    await H.probePaneMessage(page, {
      sourcePaneId: activator,
      origin: H.MOCK_ORIGIN,
      payload: { type: "host-gesture", gesture: "pane-activate" },
    });
    await expect.poll(async () => H.overlaySource(page)).toBeNull();
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toHaveCount(0);
    await expect.poll(async () => H.focused(page)).toBe(activator);
  });

  test("pane-activate: overlay stays open when activate is for the SAME pane", async ({ page }) => {
    const ids = await H.panes(page);
    const overlayPane = ids[0];
    await H.openLayoutOverlay(page, overlayPane);
    await expect.poll(async () => H.overlaySource(page)).toBe(overlayPane);

    // Activate the SAME pane the overlay is open for → no-op on the overlay.
    await H.probePaneMessage(page, {
      sourcePaneId: overlayPane,
      origin: H.MOCK_ORIGIN,
      payload: { type: "host-gesture", gesture: "pane-activate" },
    });
    await expect.poll(async () => H.overlaySource(page)).toBe(overlayPane);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
  });

  test("pane-activate: rejects an unknown field (closed payload)", async ({ page }) => {
    const ids = await H.panes(page);
    const target = ids[1];
    await H.focusPane(page, ids[0]);
    const r = await H.probePaneMessage(page, {
      sourcePaneId: target,
      origin: H.MOCK_ORIGIN,
      // A poison paneId must cause rejection — the host accepts ONLY
      // {type, gesture}. The host never trusts a sender-claimed id.
      payload: { type: "host-gesture", gesture: "pane-activate", paneId: "evil" },
    });
    expect(r.accepted, "unknown field rejected").toBe(false);
    expect(r.reason).toBe("ignored-non-pane-to-host");
    // Focus did NOT move (the activate was rejected before any action).
    expect(await H.focused(page), "focus unchanged after rejected activate").toBe(ids[0]);
  });

  test("pane-activate: rejects a wrong-origin gesture (origin-checked tier)", async ({ page }) => {
    const ids = await H.panes(page);
    const target = ids[1];
    await H.focusPane(page, ids[0]);
    const r = await H.probePaneMessage(page, {
      sourcePaneId: target,
      origin: WRONG_ORIGIN,
      payload: { type: "host-gesture", gesture: "pane-activate" },
    });
    expect(r.accepted, "wrong-origin activate rejected").toBe(false);
    expect(r.reason).toBe("rejected:origin-mismatch");
    expect(await H.focused(page), "focus unchanged after wrong-origin").toBe(ids[0]);
  });

  // ---- (6b) pane-activate × surface stack (cross-boundary popover dismissal) --
  // The surface stack's outside-click pass (shell/popover.ts) listens on
  // document.pointerdown — which NEVER fires for a tap inside a cross-origin
  // pane iframe. A VALID pane-activate is that tap's bridge signal:
  // routeMessage dismisses every ANCHORED surface (the tabstrip popovers) on
  // the way through. Anchor-less surfaces (the layout overlay) are skipped;
  // spoofed messages (wrong origin / unregistered source) are rejected BEFORE
  // the dismiss call.

  test("pane-activate closes each tabstrip popover (Layouts, Settings, AddServer)", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    // One per popover: open via the REAL tabstrip trigger, post a valid
    // pane-activate from a pane's contentWindow (the SAME routeMessage path
    // the SPA's hostGesture.ts posts through), assert the popover closed.
    const cases = [
      { btn: '[data-testid="layouts-btn"]', pop: '[data-testid="layouts-popover"]' },
      { btn: '[data-testid="settings-btn"]', pop: '[data-testid="settings-popover"]' },
      { btn: '[data-testid="add-server-btn"]', pop: '[data-testid="add-server-popover"]' },
    ];
    for (const { btn, pop } of cases) {
      await page.locator(btn).click();
      await expect(page.locator(pop)).toBeVisible();
      const r = await H.probePaneMessage(page, {
        sourcePaneId: pane,
        origin: H.MOCK_ORIGIN,
        payload: { type: "host-gesture", gesture: "pane-activate" },
      });
      expect(r.accepted, `${pop}: pane-activate accepted`).toBe(true);
      await expect(page.locator(pop), `${pop}: closed by pane-activate`).toHaveCount(0);
    }
  });

  test("pane-activate from an ALREADY-focused pane still dismisses (focus no-op, tap still happened)", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    // Focus the pane FIRST (the end state a prior activate produces), so the
    // probe below takes the idempotent focus no-op branch.
    await H.focusPane(page, pane);
    await expect.poll(async () => H.focused(page)).toBe(pane);

    await page.locator('[data-testid="settings-btn"]').click();
    await expect(page.locator('[data-testid="settings-popover"]')).toBeVisible();

    const r = await H.probePaneMessage(page, {
      sourcePaneId: pane,
      origin: H.MOCK_ORIGIN,
      payload: { type: "host-gesture", gesture: "pane-activate" },
    });
    expect(r.accepted, "activate on the focused pane accepted").toBe(true);
    expect(await H.focused(page), "focus unchanged (idempotent no-op)").toBe(pane);
    // The popover STILL closed — the dismiss runs before/independent of the
    // focus no-op.
    await expect(page.locator('[data-testid="settings-popover"]')).toHaveCount(0);
  });

  test("pane-activate does NOT dismiss the layout overlay (anchor-less skip)", async ({ page }) => {
    const ids = await H.panes(page);
    const source = ids[0];
    await H.openLayoutOverlay(page, source);
    await expect.poll(async () => H.overlaySource(page)).toBe(source);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    // Make the source the focused pane explicitly, so the probe takes the
    // idempotent branch AND the same-pane overlay composition is a no-op.
    await H.focusPane(page, source);
    await expect.poll(async () => H.focused(page)).toBe(source);

    // Post pane-activate from the overlay's own source pane. A synthetic
    // postMessage bypasses the overlay's <main> capture layer entirely, so the
    // ONLY dismissal paths in play are the anchor-less skip (must hold) and
    // the same-pane overlay composition (no-op) — deterministic.
    const r = await H.probePaneMessage(page, {
      sourcePaneId: source,
      origin: H.MOCK_ORIGIN,
      payload: { type: "host-gesture", gesture: "pane-activate" },
    });
    expect(r.accepted, "activate accepted").toBe(true);
    await expect.poll(async () => H.overlaySource(page)).toBe(source);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
  });

  test("spoofed pane-activate (wrong origin / unregistered source) does NOT dismiss", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    await page.locator('[data-testid="settings-btn"]').click();
    await expect(page.locator('[data-testid="settings-popover"]')).toBeVisible();

    // Wrong origin (origin-checked tier): rejected before the dismiss call.
    const r1 = await H.probePaneMessage(page, {
      sourcePaneId: pane,
      origin: WRONG_ORIGIN,
      payload: { type: "host-gesture", gesture: "pane-activate" },
    });
    expect(r1.accepted, "wrong-origin activate rejected").toBe(false);
    expect(r1.reason).toBe("rejected:origin-mismatch");
    await expect(page.locator('[data-testid="settings-popover"]'), "popover survives wrong-origin").toBeVisible();

    // Unregistered source (no pane bound to that window): rejected before the
    // dismiss call.
    const r2 = await H.probePaneMessage(page, {
      sourcePaneId: "nonexistent-pane",
      origin: H.MOCK_ORIGIN,
      payload: { type: "host-gesture", gesture: "pane-activate" },
    });
    expect(r2.accepted, "unknown-source activate rejected").toBe(false);
    expect(r2.reason).toBe("rejected:unknown-source");
    await expect(page.locator('[data-testid="settings-popover"]'), "popover survives unknown-source").toBeVisible();
  });

  test("REAL tap inside a pane closes an anchored popover (full cross-origin chain)", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    // Focus a DIFFERENT pane first so the tap's activation (not just the
    // dismissal) is observable as a real focus move.
    await H.focusPane(page, ids[1]);
    await expect.poll(async () => H.focused(page)).toBe(ids[1]);

    await page.locator('[data-testid="layouts-btn"]').click();
    await expect(page.locator('[data-testid="layouts-popover"]')).toBeVisible();

    // A REAL click inside the pane's cross-origin iframe: the host document
    // receives NO pointerdown (cross-origin), so the ONLY dismissal path is
    // the bridge — the mock's capture-phase pointerdown forward (the faithful
    // stand-in for web/src/hostGesture.ts) posts pane-activate through the
    // REAL postMessage boundary into the REAL router → dismissAnchoredSurfaces
    // + focusPane. This exercises the production interaction chain (real
    // input events, real cross-origin delivery) end to end; the real SPA's
    // own recognizer is out of scope here (lane 8 covers the real SPA).
    const frame = page
      .locator(`[data-pane-id="${pane}"] iframe.pane-iframe`)
      .contentFrame();
    await frame.locator(".view-label").click();

    // OUTCOME: the popover closed AND the tapped pane became the focused pane
    // — both through the real cross-origin bridge.
    await expect(page.locator('[data-testid="layouts-popover"]')).toHaveCount(0);
    await expect.poll(async () => H.focused(page)).toBe(pane);
  });

  // ---- (7) Slice 2: Swap mode + swap-with-direction -------------------------

  test("Swap mode toggle: arrow aria-label + data-mode reflect the selected mode", async ({ page }) => {
    const ids = await H.panes(page);
    await H.openLayoutOverlay(page, ids[0]);
    const up = page.locator('[data-testid="layout-overlay-above"]');
    // Default mode is Split.
    expect(await up.getAttribute("data-mode")).toBe("split");
    expect(await up.getAttribute("aria-label")).toBe("Split above");
    // Toggle to Swap — the label + mode attr follow.
    await page.locator('[data-testid="layout-overlay-mode-swap"]').click();
    await expect.poll(async () => up.getAttribute("data-mode")).toBe("swap");
    expect(await up.getAttribute("aria-label")).toBe("Swap above");
    await page.screenshot({ path: path.join(VISION_DIR, "07-swap-mode.png"), fullPage: true });
    // Toggle back to Split.
    await page.locator('[data-testid="layout-overlay-mode-split"]').click();
    await expect.poll(async () => up.getAttribute("aria-label")).toBe("Split above");
  });

  test("Swap mode: arrow exchanges two panes — both SURVIVE, relative ORDER flips, source stays active", async ({ page }) => {
    const seed = await H.panes(page);
    const a = seed[0];
    // Build a DETERMINISTIC 2-pane horizontal split: split a to the right so b is
    // guaranteed to be a's nearest right neighbor (independent of the seed
    // arrangement), each in its own single-panel grid group.
    const b = await H.split(page, a, "right");
    expect(b, "split created the swap neighbor").toBeTruthy();
    await H.waitForReady(page, b!);

    const rectOf = (id: string): Promise<{ left: number; top: number }> =>
      page
        .locator(`.pane[data-pane-id="${id}"]`)
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { left: Math.round(r.left), top: Math.round(r.top) };
        });
    const ra0 = await rectOf(a);
    const rb0 = await rectOf(b!);
    // Precondition: a is left of b (the split put b to a's right).
    expect(ra0.left < rb0.left, "precondition: a left of b before swap").toBe(true);

    const beforeA = await H.survival(page, a);
    const beforeB = await H.survival(page, b!);

    await H.openLayoutOverlay(page, a);
    await page.screenshot({ path: path.join(VISION_DIR, "08a-swap-before.png"), fullPage: true });

    // Switch to Swap mode + drive the right arrow (the production UI path).
    await page.locator('[data-testid="layout-overlay-mode-swap"]').click();
    const arrow = page.locator('[data-testid="layout-overlay-right"]');
    await expect.poll(async () => arrow.getAttribute("data-mode")).toBe("swap");
    await expect(arrow).toBeEnabled();
    await arrow.click();

    // A swap auto-closes the overlay.
    await expect.poll(async () => H.overlaySource(page)).toBeNull();

    // CRUX (Architecture A): BOTH iframes survived the exchange (mountTs/nonce/
    // connId unchanged) — renderer:'always' kept them mounted across the
    // live-tree moveTo ops.
    await H.assertSurvived(page, a, beforeA!, "source pane across overlay swap");
    await H.assertSurvived(page, b!, beforeB!, "neighbor pane across overlay swap");

    // Geometry: the two panes exchanged RELATIVE ORDER — a (was left) is now
    // RIGHT of b. (Dockview re-proportions sizes on dock+split, so the SIGN of
    // the position difference flips; absolute pixels are not preserved — that is
    // the intended "swap with neighbor" semantic.) The swap is FLIP-animated
    // (layoutAnimation.ts: pin + hold-until-stable + morph), so settle BEFORE
    // reading rects — mid-morph the panes have not yet crossed.
    await H.waitForLayoutSettled(page);
    const ra1 = await rectOf(a);
    const rb1 = await rectOf(b!);
    expect(ra1.left > rb1.left, "a now right of b after swap").toBe(true);

    // Source stays active/focused after the swap.
    await expect.poll(async () => H.focused(page), { timeout: 5000 }).toBe(a);

    await page.screenshot({ path: path.join(VISION_DIR, "08b-swap-after.png"), fullPage: true });
  });

  test("Swap mode: an arrow with no swappable neighbor is DISABLED (visual + aria-disabled)", async ({ page }) => {
    const seed = await H.panes(page);
    const a = seed[0];
    // Same deterministic setup: split a to the right, so a has exactly one
    // neighbor (to its right). Left / above / below have no neighbor.
    const b = await H.split(page, a, "right");
    await H.waitForReady(page, b!);

    await H.openLayoutOverlay(page, a);
    await page.locator('[data-testid="layout-overlay-mode-swap"]').click();
    await expect.poll(async () => page.locator('[data-testid="layout-overlay-left"]').getAttribute("data-mode")).toBe("swap");

    // The RIGHT arrow has a swappable neighbor → enabled.
    const rightArrow = page.locator('[data-testid="layout-overlay-right"]');
    await expect(rightArrow).toBeEnabled();
    expect(await rightArrow.getAttribute("aria-disabled")).toBeNull();

    // The LEFT arrow has no neighbor (a is at the left edge) → DISABLED, not a
    // silent no-op: native disabled + aria-disabled + an explanatory title.
    const leftArrow = page.locator('[data-testid="layout-overlay-left"]');
    await expect(leftArrow).toBeDisabled();
    expect(await leftArrow.getAttribute("aria-disabled")).toBe("true");
    expect(await leftArrow.getAttribute("title")).toContain("No swappable pane");

    await page.screenshot({ path: path.join(VISION_DIR, "09-swap-no-neighbor.png"), fullPage: true });
  });

  // ---- (8) Slice 2: Close-pane action ---------------------------------------

  test("Close-pane: disposes source, surviving pane SURVIVES, overlay dismisses; close-to-empty allowed", async ({ page }) => {
    const ids = await H.panes(page);
    const a = ids[0];
    const b = ids[1];
    const beforeB = await H.survival(page, b);

    await H.openLayoutOverlay(page, a);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();

    // Close-pane is DISTINCT from the overlay-dismiss ✕ — it disposes the SOURCE
    // pane (HostOps.closePane → removePanel; intended iframe disposal for close).
    await page.locator('[data-testid="layout-overlay-close-pane"]').click();

    // The source pane is gone from the model + the DOM.
    await expect.poll(async () => (await H.panes(page)).includes(a)).toBe(false);
    await expect(page.locator(`.pane[data-pane-id="${a}"]`)).toHaveCount(0);
    // The overlay dismissed (source no longer exists).
    await expect.poll(async () => H.overlaySource(page)).toBeNull();
    // The SURVIVING pane's iframe was NOT touched (close disposes only the
    // source — survival matters for the remaining panes).
    await H.assertSurvived(page, b, beforeB!, "surviving pane across sibling close");

    await page.screenshot({ path: path.join(VISION_DIR, "10-after-close.png"), fullPage: true });

    // close-to-empty is ALLOWED (no guard): close every remaining pane one by one
    // and assert the workspace reaches an empty state without error.
    let remaining = await H.panes(page);
    while (remaining.length > 0) {
      await H.closePane(page, remaining[0]);
      remaining = await H.panes(page);
    }
    await expect.poll(async () => (await H.panes(page)).length).toBe(0);
  });

  // ---- (9) Slice 2: stale-comment sweep (no current-surface statusbar refs) -

  test("comment sweep: no stale (non-removal-aware) statusbar references in non-test source/docs", () => {
    // The statusbar was removed in its entirety. References that describe it as
    // a CURRENT surface are stale; references that document its REMOVAL as
    // provenance are fine. This asserts every remaining "statusbar" mention
    // (±1 line of context) carries a removal/historical indicator.
    const REMOVAL_RX = /remov|delet|retir|legacy|surviv|exist|no longer|gone|dropped/i;
    const walk = (dir: string, out: string[]): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, out);
        else out.push(p);
      }
    };
    const roots = ["host-web/src", "host-web/docs"].map((r) => path.resolve(REPO_ROOT, r));
    const files: string[] = [];
    for (const r of roots) walk(r, files);
    const offenders: string[] = [];
    for (const f of files) {
      if (!/\.(ts|tsx|css|md)$/.test(f)) continue;
      const lines = fs.readFileSync(f, "utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (!/statusbar/i.test(lines[i])) continue;
        const ctx = [lines[i - 1], lines[i], lines[i + 1]].filter(Boolean).join(" ");
        if (!REMOVAL_RX.test(ctx)) {
          offenders.push(`${path.relative(REPO_ROOT, f)}:${i + 1}: ${lines[i].trim()}`);
        }
      }
    }
    expect(offenders, `stale statusbar refs (non-removal-aware):\n${offenders.join("\n")}`).toEqual([]);
  });
});
