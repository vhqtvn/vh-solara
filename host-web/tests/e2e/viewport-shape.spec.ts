import { test, expect, type Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as H from "./util";

/**
 * i3 Phase 2 — viewport-shape auto-transpose (host-web/src/viewportShape.ts).
 *
 * On device rotation / window resize, when the viewport shape crosses a
 * threshold, flip the ACTIVE workspace's Dockview grid root orientation so the
 * split axis matches the shape (portrait → VERTICAL stack; landscape →
 * HORIZONTAL side-by-side; square → no change). This is the survival-safe,
 * reversible piece of the viewport-responsive i3 vision.
 *
 * SURVIVAL CRUX (load-bearing). The transpose primitive is the Dockview
 * Gridview orientation setter (reached at api.component.gridview.orientation),
 * which calls flipNode(root) — a live-tree geometry rebuild. Moving/reparenting
 * an iframe RELOADS it; flipNode must NOT. Tests 1 + 2 prove via assertSurvived
 * (mountTs/nonce/connId unchanged on BOTH panes) that the flip preserves
 * cross-origin iframe identity in BOTH directions. If that ever fails, the whole
 * feature premise is wrong (see the mission's STOP condition).
 *
 * The transpose path is NOT DockviewApi.orientation (that property does not
 * exist on DockviewApi — it belongs to GridviewApi; the existing
 * hostController.rootOrientation/setRootOrientation bridge reads/writes the
 * wrong no-op path). This spec asserts orientation via GEOMETRY (groupBox:
 * side-by-side vs stacked) as the primary signal, and via the corrected
 * __hostViewport.currentOrientation() bridge as a cross-check.
 *
 * One test per feature + vision screenshots under
 * tmp/host-web-playwright/vision/viewport/ (gitignored). The suite is serial
 * (host-web playwright.config.ts: workers:1); each test clears persisted layout
 * in beforeEach so it starts from the fresh HORIZONTAL seed (a prior test's
 * auto-transposed + saved layout would otherwise leak in via the shared
 * localStorage context).
 */

const REPO_ROOT = path.resolve(process.cwd(), "..");
const VISION_DIR = path.join(REPO_ROOT, "tmp/host-web-playwright/vision/viewport");

test.beforeAll(() => {
  fs.mkdirSync(VISION_DIR, { recursive: true });
});

// Viewport sizes chosen to land clearly in each shape band
// (classifyShape: h/w>1.2 → tall; w/h>1.2 → wide; else square).
const WIDE = { width: 1024, height: 640 }; // w/h=1.6 → wide
const TALL = { width: 400, height: 800 }; // h/w=2.0 → tall
const SQUARE = { width: 600, height: 600 }; // 1.0 → square

/** Reduce the seeded grid to exactly TWO side-by-side panes (HORIZONTAL) for
 *  deterministic geometry + clean vision screenshots, regardless of how many
 *  panes the mock fleet seeds (the seed count is not part of this feature's
 *  contract). Closes every seeded pane except the first, then splits it right.
 *  The keeper's iframe survives the closes (removePanel on the others does not
 *  touch its mounted iframe). Returns [keeper, newPane]. */
async function twoPanes(
  page: Page,
): Promise<[string, string]> {
  const seeded = await H.panes(page);
  const keeper = seeded[0];
  for (const id of seeded.slice(1)) await H.closePane(page, id);
  await H.waitForReady(page, keeper);
  const other = await H.split(page, keeper, "right");
  expect(other, "split created a second pane").toBeTruthy();
  await H.waitForReady(page, other!);
  return [keeper, other!];
}

/** Reduce the seeded grid to exactly ONE pane (for the 1-pane no-op test).
 *  Closes every seeded pane except the first; the keeper survives. */
async function onePane(page: Page): Promise<string> {
  const seeded = await H.panes(page);
  const keeper = seeded[0];
  for (const id of seeded.slice(1)) await H.closePane(page, id);
  await H.waitForReady(page, keeper);
  return keeper;
}

test.describe("viewport-shape auto-transpose (i3 Phase 2)", () => {
  test.beforeEach(async ({ page }) => {
    // The serial suite shares a localStorage context. A prior test may have
    // auto-transposed the layout and the debounced save flushed it; without a
    // reset, this test's loadHost would cold-restore a VERTICAL layout. Clear
    // the persisted layout (forces the fresh HORIZONTAL seed) before loading.
    // Clearing also removes the toggle key → default ON.
    await page.goto("/");
    await page.evaluate(() => localStorage.clear());
    await H.loadHost(page);
    // Ensure a known wide baseline for every test (the project default is wide,
    // but be explicit so a shape assertion is never ambiguous).
    await page.setViewportSize(WIDE);
  });

  test("portrait flip preserves BOTH pane identities [SURVIVAL CRUX]", async ({ page }) => {
    // Build a clean 2-pane side-by-side (HORIZONTAL) layout for unambiguous
    // geometry + clean vision screenshots (the mock fleet seeds more than 2).
    const [a, b] = await twoPanes(page);
    expect(await H.gridPaneCount(page), "exactly 2 grid panes").toBe(2);

    // Baseline: wide → HORIZONTAL (side-by-side). Capture survival identities
    // BEFORE the flip; assertSurvived will wait for a fresh heartbeat after.
    await H.waitForSideBySide(page, a, b);
    expect(await H.viewportOrientation(page), "wide baseline = HORIZONTAL").toBe("HORIZONTAL");
    expect(await H.viewportShape(page), "wide baseline shape").toBe("wide");
    const ba = (await H.survival(page, a))!;
    const bb = (await H.survival(page, b))!;
    await page.screenshot({
      path: path.join(VISION_DIR, "01-landscape-before.png"),
      fullPage: true,
    });

    // Rotate to portrait → debounce → transpose to VERTICAL (stacked).
    await page.setViewportSize(TALL);
    await H.waitForStacked(page, a, b);
    expect(await H.viewportOrientation(page), "portrait = VERTICAL").toBe("VERTICAL");
    expect(await H.viewportShape(page), "portrait shape").toBe("tall");
    await page.screenshot({
      path: path.join(VISION_DIR, "02-portrait-after.png"),
      fullPage: true,
    });

    // SURVIVAL CRUX: both iframes kept their identity across the orientation
    // flip. If this fails, the feature premise (flipNode is survival-safe) is
    // wrong — STOP per the mission.
    await H.assertSurvived(page, a, ba, "portrait-flip pane A");
    await H.assertSurvived(page, b, bb, "portrait-flip pane B");
  });

  test("landscape flip-back preserves BOTH pane identities [SURVIVAL CRUX]", async ({ page }) => {
    const ids = await H.panes(page);
    const [a, b] = [ids[0], ids[1]];

    // Drive to the VERTICAL (portrait) state first via the real path, then
    // capture baselines THERE — so this test proves the V→H flip is survival-
    // safe (test 1 proved H→V).
    await page.setViewportSize(TALL);
    await H.waitForStacked(page, a, b);
    expect(await H.viewportOrientation(page), "portrait setup = VERTICAL").toBe("VERTICAL");
    const ba = (await H.survival(page, a))!;
    const bb = (await H.survival(page, b))!;

    // Rotate back to landscape → transpose to HORIZONTAL (side-by-side).
    await page.setViewportSize(WIDE);
    await H.waitForSideBySide(page, a, b);
    expect(await H.viewportOrientation(page), "landscape = HORIZONTAL").toBe("HORIZONTAL");

    await H.assertSurvived(page, a, ba, "landscape-flipback pane A");
    await H.assertSurvived(page, b, bb, "landscape-flipback pane B");
  });

  test("single pane: resize is a no-op (no split to transpose)", async ({ page }) => {
    // Reduce to a single pane (the keeper survives the closes).
    const a = await onePane(page);
    await H.waitForReady(page, a);
    expect(await H.gridPaneCount(page), "one pane on the grid").toBe(1);
    const before = (await H.survival(page, a))!;
    const oriBefore = await H.viewportOrientation(page);
    const flipsBefore = await H.viewportFlipCount(page);

    // Resize to portrait. With 1 grid pane there is no split to transpose →
    // applyTranspose skips (gridGroupCount < 2); orientation + flipCount
    // unchanged.
    await page.setViewportSize(TALL);
    await page.waitForTimeout(350); // past DEBOUNCE_MS (200) + settle
    expect(await H.viewportOrientation(page), "orientation unchanged (1 pane)").toBe(oriBefore);
    expect(await H.viewportFlipCount(page), "no flip (1 pane)").toBe(flipsBefore);
    await H.assertSurvived(page, a, before, "single-pane resize");
  });

  test("square viewport: no forced flip (ambiguous shape)", async ({ page }) => {
    const ids = await H.panes(page);
    const [a, b] = [ids[0], ids[1]];
    await H.waitForSideBySide(page, a, b);
    expect(await H.viewportOrientation(page), "wide baseline = HORIZONTAL").toBe("HORIZONTAL");
    const flipsBefore = await H.viewportFlipCount(page);

    // Resize to square. targetOrientation(square) = null → no forced flip.
    await page.setViewportSize(SQUARE);
    expect(await H.viewportShape(page), "square shape").toBe("square");
    await page.waitForTimeout(350);
    // Still side-by-side (the HORIZONTAL split is left alone).
    await H.waitForSideBySide(page, a, b);
    expect(await H.viewportOrientation(page), "still HORIZONTAL (square no-op)").toBe("HORIZONTAL");
    expect(await H.viewportFlipCount(page), "no flip (square)").toBe(flipsBefore);
  });

  test("toggle OFF: resize does not transpose", async ({ page }) => {
    const ids = await H.panes(page);
    const [a, b] = [ids[0], ids[1]];
    await H.waitForSideBySide(page, a, b);
    expect(await H.viewportEnabled(page), "default ON after clear").toBe(true);

    // Disable the effect. The listeners stay wired but every evaluation
    // short-circuits on the toggle.
    await H.setViewportEnabled(page, false);
    expect(await H.viewportEnabled(page), "toggle now OFF").toBe(false);
    const flipsBefore = await H.viewportFlipCount(page);

    await page.setViewportSize(TALL);
    await page.waitForTimeout(350);
    // No transpose: still side-by-side HORIZONTAL despite a tall viewport.
    await H.waitForSideBySide(page, a, b);
    expect(await H.viewportOrientation(page), "still HORIZONTAL (toggle off)").toBe("HORIZONTAL");
    expect(await H.viewportFlipCount(page), "no flip (toggle off)").toBe(flipsBefore);
  });

  test("debounce: rapid resize events coalesce to exactly one evaluation", async ({ page }) => {
    // Part A (coalescing, deterministic): fire N synthetic resize events in one
    // tick. They do NOT change dimensions (so no flip), but each fires the
    // listener → resets the 200ms debounce timer. After settling, exactly ONE
    // applyTranspose run must have executed (N events → 1 evaluation), proving
    // the debounce coalesces a burst into a single transpose check.
    const evalsBefore = await H.viewportEvalCount(page);
    await page.evaluate(() => {
      for (let i = 0; i < 5; i++) window.dispatchEvent(new Event("resize"));
    });
    await page.waitForTimeout(350); // past DEBOUNCE_MS (200)
    const evalsAfterSynthetic = await H.viewportEvalCount(page);
    expect(evalsAfterSynthetic - evalsBefore, "5 rapid events → 1 evaluation").toBe(1);

    // Part B (real single resize → exactly one eval + one flip): a real
    // dimension-changing resize to portrait must transpose exactly once (one
    // evaluation, one flip), not multiple.
    const ids = await H.panes(page);
    const [a, b] = [ids[0], ids[1]];
    const flipsBefore = await H.viewportFlipCount(page);
    const evalsBeforeReal = await H.viewportEvalCount(page);
    await page.setViewportSize(TALL);
    await H.waitForStacked(page, a, b);
    await page.waitForTimeout(100); // let any stray second eval land
    expect(await H.viewportFlipCount(page), "exactly one flip").toBe(flipsBefore + 1);
    expect(
      (await H.viewportEvalCount(page)) - evalsBeforeReal,
      "exactly one evaluation for one resize",
    ).toBe(1);
  });
});
