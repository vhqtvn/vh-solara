import { test, expect } from "@playwright/test";
import * as H from "./util";

// =============================================================================
// Host-side tail/follow control per pane (indicator + force-follow).
//
// READ-FIRST VERDICT pinned by this suite: force-UNFOLLOW is not durably
// expressible in the SPA's scroll machinery (ChatView re-engages an at-bottom
// following=false via its RO/self-heal recoveries), so the shipped surface is
// the indicator + a single "Jump to latest" force-follow action. The wire
// contract stays the closed {type:'vh-host-tail',following:boolean} and the
// SPA-side listener validates the full payload (unit-pinned in
// web/tests/unit/tailListener.test.ts) while dispatching only true.
//
// Round-trip at the mock seam (host-web/iframe-content/content.ts): the mock
// models the reader's scroll state (click in the chat area toggles
// tailFollowing) and re-emits {type:"status",...,following} through the SAME
// status bridge the real SPA's statusEmitter uses. The overlay's Tail row
// reads the REPORTED state (PaneVm.status.following) — no local echo — so the
// row flipping back to "on" after "Jump to latest" IS the round-trip proof.
//
// CRUX: SURVIVAL. A tail command is postMessage only — the iframe element,
// its src, and `renderer:'always'` are NEVER touched. Identity
// (mountTs/nonce/connId) is UNCHANGED across the whole sequence.
//
// Runs on Chromium + Firefox (playwright.config.ts projects).
// =============================================================================

/** The mock pane's #app element (inside the pane's iframe). */
function mockApp(page: import("@playwright/test").Page, pane: string) {
  return page
    .locator(`[data-pane-id="${pane}"] iframe.pane-iframe`)
    .contentFrame()
    .locator("#app");
}

/** Click inside the mock pane to model the reader scrolling away from / back
 *  to the tail (deterministic; the real SPA's scroll classifier produces the
 *  same following transitions). */
async function mockToggleReader(page: import("@playwright/test").Page, pane: string): Promise<void> {
  await mockApp(page, pane).locator(".view-label").click();
}

test.describe("host tail/follow control (indicator + force-follow)", () => {
  test.beforeEach(async ({ page }) => {
    await H.loadHost(page);
  });

  test("status capture shows following=true/false; overlay row tracks the reported state", async ({
    page,
  }) => {
    const ids = await H.panes(page);
    const pane = ids[0];

    // The mock reports an initial status on handshake → following=true is
    // captured by the host store (source-bound + origin-checked, the same
    // routeMessage path the real SPA's emitter uses).
    await expect
      .poll(async () => (await H.status(page, pane))?.following, { timeout: 5000 })
      .toBe(true);

    // Overlay Tail row reflects the REPORTED state (no status yet for a pane →
    // honest "on" default; here the pane reported true).
    await H.openLayoutOverlay(page, pane);
    const state = page.locator('[data-testid="layout-overlay-tail-state"]');
    await expect(state).toHaveText("Tail: on");
    // Force-follow is the ONLY action: no Jump button while following=true.
    await expect(page.locator('[data-testid="layout-overlay-tail-jump"]')).toHaveCount(0);
    await H.closeLayoutOverlay(page);

    // The modeled reader scrolls up (click in the mock pane) → the mock
    // re-emits status with following=false → the host store + overlay track it.
    await mockToggleReader(page, pane);
    await expect
      .poll(async () => (await H.status(page, pane))?.following, { timeout: 5000 })
      .toBe(false);
    await H.openLayoutOverlay(page, pane);
    await expect(state).toHaveText("Tail: off");
    // Scrolled-up state exposes exactly one action: Jump to latest.
    await expect(page.locator('[data-testid="layout-overlay-tail-jump"]')).toHaveCount(1);
    await H.closeLayoutOverlay(page);
  });

  test("clicking the overlay row posts the command; the pane round-trips back to following=true", async ({
    page,
  }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const before = (await H.survival(page, pane))!;

    // Drive the modeled reader off the tail, then open the overlay.
    await mockToggleReader(page, pane);
    await expect
      .poll(async () => (await H.status(page, pane))?.following, { timeout: 5000 })
      .toBe(false);
    await H.openLayoutOverlay(page, pane);
    await expect(page.locator('[data-testid="layout-overlay-tail-state"]')).toHaveText("Tail: off");

    // Click "Jump to latest": the overlay posts {type:'vh-host-tail',
    // following:true} through HostOps.setTail (origin-scoped to the mock's
    // :5174). The mock's tail handler (source-guard + boolean allowlist — the
    // faithful stand-in for web/src/tailListener.ts) flips its modeled state
    // and re-emits status.
    await page.locator('[data-testid="layout-overlay-tail-jump"]').click();

    // ROUND-TRIP #1: the mock received + dispatched the command (DOM surface,
    // deterministic, not network-bound).
    await expect
      .poll(async () => mockApp(page, pane).getAttribute("data-tail-following"), { timeout: 5000 })
      .toBe("true");

    // ROUND-TRIP #2: the host store captured the re-reported status — the
    // pane REPORTED following=true (not a local echo; setStatusFor is the only
    // writer). The overlay row (still open) flips from the reported state.
    await expect
      .poll(async () => (await H.status(page, pane))?.following, { timeout: 5000 })
      .toBe(true);
    await expect(page.locator('[data-testid="layout-overlay-tail-state"]')).toHaveText("Tail: on");
    // Force-follow done → the Jump action is gone again (single-action row).
    await expect(page.locator('[data-testid="layout-overlay-tail-jump"]')).toHaveCount(0);
    await H.closeLayoutOverlay(page);

    // CRUX — SURVIVAL: the tail command is postMessage only; the iframe
    // element is untouched. Identity (mountTs/nonce/connId) UNCHANGED across
    // the reader-toggle + force-follow sequence.
    await H.assertSurvived(page, pane, before, "tail toggle round-trip");
  });

  test("setTail is no-op for an unknown pane (no throw, survival unchanged)", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const before = (await H.survival(page, pane))!;

    // An unknown pane id → lookupContentWindow returns null → setTail is a
    // no-op (no post, no throw). The known pane is untouched.
    await H.setTail(page, "nonexistent-pane-id", true);
    // The known pane survived (nothing global changed).
    await H.assertSurvived(page, pane, before, "no-op tail on unknown pane");
  });

  test("the mock pane ignores out-of-contract tail payloads (allowlist pin)", async ({ page }) => {
    const ids = await H.panes(page);
    const pane = ids[0];

    // Drive the modeled reader off the tail (following=false baseline).
    await mockToggleReader(page, pane);
    await expect
      .poll(async () => (await H.status(page, pane))?.following, { timeout: 5000 })
      .toBe(false);

    // Post a POISON tail command directly from the host window into the pane's
    // contentWindow. Inside the mock, ev.source IS window.parent (the sender
    // is the host top window), so the source-guard alone would pass — only the
    // payload allowlist (following must be a boolean; every other field
    // dropped) can reject it. This pins the mock's faithfulness to the real
    // tailListener's CF1 allowlist (unit-pinned for the real SPA in
    // web/tests/unit/tailListener.test.ts).
    await page.evaluate(
      ({ pane, payload }) => {
        const f = document.querySelector(
          `[data-pane-id="${pane}"] iframe.pane-iframe`,
        ) as HTMLIFrameElement | null;
        f?.contentWindow?.postMessage(payload, "*");
      },
      {
        pane,
        payload: { type: "vh-host-tail", following: "true", access_token: "SECRET" },
      },
    );

    // The mock must NOT have dispatched (non-boolean following): its modeled
    // state stays false and no status re-emit flips the host store.
    await page.waitForTimeout(600);
    expect(await mockApp(page, pane).getAttribute("data-tail-following")).toBe("false");
    expect((await H.status(page, pane))?.following, "poison payload stored nothing").toBe(false);

    // A VALID payload through the same direct route DOES dispatch (proves the
    // rejection above was the allowlist, not the transport).
    await page.evaluate(
      ({ pane, payload }) => {
        const f = document.querySelector(
          `[data-pane-id="${pane}"] iframe.pane-iframe`,
        ) as HTMLIFrameElement | null;
        f?.contentWindow?.postMessage(payload, "*");
      },
      { pane, payload: { type: "vh-host-tail", following: true } },
    );
    await expect
      .poll(async () => mockApp(page, pane).getAttribute("data-tail-following"), { timeout: 5000 })
      .toBe("true");
  });

  test("assertSurvived across a tail toggle driven through the bridge (production path)", async ({
    page,
  }) => {
    const ids = await H.panes(page);
    const pane = ids[0];
    const before = (await H.survival(page, pane))!;

    // Off (modeled reader), then force-follow through the SAME production
    // HostOps path the overlay row uses — survival across the full cycle.
    await mockToggleReader(page, pane);
    await expect
      .poll(async () => (await H.status(page, pane))?.following, { timeout: 5000 })
      .toBe(false);
    await H.setTail(page, pane, true);
    await expect
      .poll(async () => (await H.status(page, pane))?.following, { timeout: 5000 })
      .toBe(true);

    await H.assertSurvived(page, pane, before, "bridge tail toggle");
  });
});

// =============================================================================
// Vision evidence (gitignored): overlay screenshots in both Tail states.
// Gated behind VH_TAIL_SHOTS=<dir> so ordinary CI runs write nothing; the
// verification pass runs the suite once with the env var set and analyzes the
// captures with the vision tool.
// =============================================================================

test("vision evidence: overlay Tail row in both states (gitignored screenshots)", async ({
  page,
}) => {
  const shotDir = process.env.VH_TAIL_SHOTS;
  test.skip(!shotDir, "screenshot evidence only captured when VH_TAIL_SHOTS is set");

  await H.loadHost(page);
  const ids = await H.panes(page);
  const pane = ids[0];

  await H.openLayoutOverlay(page, pane);
  await expect(page.locator('[data-testid="layout-overlay-card"]')).toBeVisible();
  await expect(page.locator('[data-testid="layout-overlay-tail-state"]')).toHaveText("Tail: on");
  await page.locator('[data-testid="layout-overlay-card"]').screenshot({
    path: `${shotDir}/tail-overlay-on.png`,
  });
  await H.closeLayoutOverlay(page);

  await mockToggleReader(page, pane);
  await expect
    .poll(async () => (await H.status(page, pane))?.following, { timeout: 5000 })
    .toBe(false);
  await H.openLayoutOverlay(page, pane);
  await expect(page.locator('[data-testid="layout-overlay-tail-state"]')).toHaveText("Tail: off");
  await page.locator('[data-testid="layout-overlay-card"]').screenshot({
    path: `${shotDir}/tail-overlay-off.png`,
  });
  await H.closeLayoutOverlay(page);
});
