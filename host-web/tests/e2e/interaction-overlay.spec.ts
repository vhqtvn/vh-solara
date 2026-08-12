import { test, expect } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as H from "./util";

/**
 * Layout overlay interaction model (replaces the dropped Alt keyboard shortcuts).
 *
 * Covers: (1) the host-gesture protocol security (closed payload, source-bound
 * pane derivation, origin check); (2) overlay open/action/close + dismiss modes
 * + statusbar-clickability + idempotent re-anchor; (3) the focus indicator +
 * reduced-motion; (4) the split-target fix (non-first-pane setLayoutMode anchors
 * on the source, not panels[0]); (5) workspace-switch dismissal + NEXT
 * composability. One screenshot per feature under
 * tmp/host-web-playwright/vision/interaction/ (gitignored). Chromium only.
 *
 * The host-gesture MESSAGE is driven through probePaneMessage (the real
 * routeMessage, with a real pane's contentWindow as source) — the SAME path the
 * SPA's hostGesture.ts posts. The overlay ops (open/close/split) are driven
 * through the production HostOps path the statusbar Layout button uses.
 */
const REPO_ROOT = path.resolve(process.cwd(), "..");
const VISION_DIR = path.join(REPO_ROOT, "tmp/host-web-playwright/vision/interaction");

test.beforeAll(() => {
  fs.mkdirSync(VISION_DIR, { recursive: true });
});

const MOCK_ORIGIN = "http://127.0.0.1:5174"; // mock content origin (:5174)
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
      origin: MOCK_ORIGIN,
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
      origin: MOCK_ORIGIN,
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
      origin: MOCK_ORIGIN,
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
      origin: MOCK_ORIGIN,
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
      origin: MOCK_ORIGIN,
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
      origin: MOCK_ORIGIN,
      payload: { type: "host-gesture", gesture: "layout-overlay-request" },
    });
    await expect.poll(async () => H.overlaySource(page)).toBe(source);
    expect(await H.overlaySource(page), "bound to source, not other").not.toBe(other);
    await H.closeLayoutOverlay(page);
  });

  // ---- (2) overlay open / action / close + dismiss + statusbar clickable -----

  test("statusbar Layout button opens the overlay for the focused pane", async ({ page }) => {
    const ids = await H.panes(page);
    await H.focusPane(page, ids[0]);
    await expect.poll(async () => H.focused(page)).toBe(ids[0]);

    await page.locator('[data-testid="layout-overlay-btn"]').click();
    await expect.poll(async () => H.overlaySource(page)).toBe(ids[0]);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    await page.screenshot({ path: path.join(VISION_DIR, "02-statusbar-open.png"), fullPage: true });
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

  test("statusbar stays clickable while the overlay is open (Layering gate)", async ({ page }) => {
    const ids = await H.panes(page);
    await H.openLayoutOverlay(page, ids[0]);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    // The statusbar Layout button is OUTSIDE <main> → not covered by the capture
    // layer → still clickable. Clicking it re-opens (focuses) without error.
    const btn = page.locator('[data-testid="layout-overlay-btn"]');
    await expect(btn).toBeEnabled();
    await btn.click();
    // The control-cluster buttons are also still clickable.
    await expect(page.locator('[data-testid="i3-split-h"]')).toBeEnabled();
    // The overlay is still open (re-opened for the focused pane).
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
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

  test("NEXT composability: the statusbar NEXT button stays clickable while the overlay is open", async ({ page }) => {
    const ids = await H.panes(page);
    // Drive a needs-permission status on a non-source pane so the NEXT button
    // appears, then open the overlay + assert NEXT is still present + clickable.
    await H.probeStatus(page, {
      sourcePaneId: ids[1],
      origin: MOCK_ORIGIN,
      payload: { type: "status", dir: "/p", session: "s1", title: "T", attention: "needs_permission", activity: "running" },
    });
    await expect.poll(async () => H.needsYou(page), { timeout: 8000 }).toBe(1);
    await expect(page.locator('[data-testid="attention-next"]')).toBeVisible();

    await H.openLayoutOverlay(page, ids[0]);
    await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
    // NEXT is still visible + enabled (the capture layer does not cover the
    // statusbar).
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
});
