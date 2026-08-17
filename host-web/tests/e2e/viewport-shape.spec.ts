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
 * exist on DockviewApi — it belongs to GridviewApi; the
 * hostController.rootOrientation/setRootOrientation bridge now reads/writes
 * the correct gridview path too). This spec asserts orientation via GEOMETRY
 * (groupBox: side-by-side vs stacked) as the primary signal, and via the
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
    // the persisted state BEFORE the single app boot (addInitScript runs on
    // the loadHost navigation, before any app script — forces the fresh
    // HORIZONTAL seed) instead of the old goto('/') + clear + loadHost
    // double-boot, which discarded one full app boot per test and raced its
    // debounced layout save. Clearing also removes the toggle key → default
    // ON.
    await page.addInitScript(() => localStorage.clear());
    await H.loadHost(page);
    // Ensure a known wide baseline for every test (the project default is wide,
    // but be explicit so a shape assertion is never ambiguous).
    await page.setViewportSize(WIDE);
  });

  test("portrait flip preserves BOTH pane identities [SURVIVAL CRUX]", async ({ page }) => {
    // Build a clean 2-pane side-by-side (HORIZONTAL) layout for unambiguous
    // geometry + clean vision screenshots (the mock fleet seeds more than 2).
    const [a, b] = await H.twoPanes(page);
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

/** Boot the app again on the SAME page (localStorage + the persisted layout
 *  blob survive — the reload is the point), then wait for the socket. Pane
 *  readiness is per-test (the restored pane count varies). */
async function reloadHost(page: Page): Promise<void> {
  await page.goto("/");
  await expect.poll(async () => H.connected(page), { timeout: 20_000 }).toBe(true);
}

test.describe("startup normalization (mount + activation)", () => {
  // The RESIZE-path describe above clears localStorage on every boot. These
  // tests deliberately PERSIST state across an in-test reload (the saved
  // layout is the input to the mount normalization), so the clear runs ONCE
  // per test page: a sessionStorage sentinel (sessionStorage survives
  // same-tab navigation, and each Playwright test gets a fresh context — so
  // the first boot clears, in-test reloads keep the blob).
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("vh-test:booted")) {
        localStorage.clear();
        sessionStorage.setItem("vh-test:booted", "1");
      }
    });
    await H.loadHost(page);
    await page.setViewportSize(WIDE);
  });

  test("mount: a restored HORIZONTAL 2-pane layout normalizes to VERTICAL when booted at portrait (stacked + exactly one flip + identities stable)", async ({ page }) => {
    // Persist a HORIZONTAL 2-pane layout from the wide baseline.
    const [a, b] = await H.twoPanes(page);
    await H.waitForSideBySide(page, a, b);
    expect(await H.viewportOrientation(page), "wide baseline = HORIZONTAL").toBe("HORIZONTAL");
    const saved = await H.waitForSavedLayout(page, 2);
    expect(Object.keys(saved).sort(), "the saved blob holds exactly our two panes").toEqual([a, b].sort());

    // Boot at PORTRAIT. The cold restore reinstates the HORIZONTAL split,
    // then DockviewHost's mount normalization (after restore, before the FLIP
    // install) flips it to VERTICAL — instead of staying wrong until the
    // first resize.
    await page.setViewportSize(TALL);
    await reloadHost(page);
    await expect.poll(async () => (await H.panes(page)).sort()).toEqual([a, b].sort());
    await H.waitForReady(page, a);
    await H.waitForReady(page, b);

    await H.waitForStacked(page, a, b);
    expect(await H.viewportOrientation(page), "portrait boot = VERTICAL (normalized at mount)").toBe("VERTICAL");
    // Exactly ONE flip — no double-fire from a mount normalize + stray resize
    // evaluation (the idempotent setter + the shared pre-check make repeats
    // no-ops; flipCount counts real orientation changes only).
    expect(await H.viewportFlipCount(page), "exactly one mount flip").toBe(1);

    // Identities: the restore re-CREATES the iframes (a reload is a new
    // document — assertReloaded territory, not assertSurvived); what this
    // pins is that the normalized layout holds BOTH panes stable AFTER the
    // mount flip, with no follow-on reload churn.
    const ba = (await H.survival(page, a))!;
    const bb = (await H.survival(page, b))!;
    await page.waitForTimeout(400);
    await H.assertSurvived(page, a, ba, "post-normalization stability pane A");
    await H.assertSurvived(page, b, bb, "post-normalization stability pane B");
    await page.screenshot({
      path: path.join(VISION_DIR, "10-startup-normalize-portrait.png"),
      fullPage: true,
    });
  });

  test("mount: a restored HORIZONTAL layout at landscape stays HORIZONTAL (no spurious flip)", async ({ page }) => {
    const [a, b] = await H.twoPanes(page);
    await H.waitForSideBySide(page, a, b);
    await H.waitForSavedLayout(page, 2);

    // Boot at the SAME wide shape: orientation already matches → the mount
    // normalization must be a pure no-op.
    await reloadHost(page);
    await expect.poll(async () => (await H.panes(page)).sort()).toEqual([a, b].sort());
    await H.waitForReady(page, a);
    await H.waitForReady(page, b);

    await H.waitForSideBySide(page, a, b);
    expect(await H.viewportOrientation(page), "landscape boot stays HORIZONTAL").toBe("HORIZONTAL");
    expect(await H.viewportFlipCount(page), "no flip at a matching shape").toBe(0);
  });

  test("mount: toggle OFF (vh-host:autotranspose=off) → portrait boot does NOT normalize", async ({ page }) => {
    const [a, b] = await H.twoPanes(page);
    await H.waitForSideBySide(page, a, b);
    // Persist the DISABLED toggle (survives the reload like the layout blob).
    await H.setViewportEnabled(page, false);
    await H.waitForSavedLayout(page, 2);

    await page.setViewportSize(TALL);
    await reloadHost(page);
    await expect.poll(async () => (await H.panes(page)).sort()).toEqual([a, b].sort());
    await H.waitForReady(page, a);
    await H.waitForReady(page, b);
    await page.waitForTimeout(350); // past the resize debounce — nothing flips

    await H.waitForSideBySide(page, a, b);
    expect(await H.viewportOrientation(page), "toggle off: stays HORIZONTAL at portrait").toBe("HORIZONTAL");
    expect(await H.viewportFlipCount(page), "no flip while the toggle is off").toBe(0);
  });

  test("mount: a 1-pane workspace does not normalize at portrait (no split to transpose)", async ({ page }) => {
    const keeper = await onePane(page);
    expect(await H.gridPaneCount(page), "one pane on the grid").toBe(1);
    await H.waitForSavedLayout(page, 1);

    await page.setViewportSize(TALL);
    await reloadHost(page);
    await expect.poll(async () => H.panes(page)).toEqual([keeper]);
    await H.waitForReady(page, keeper);
    await page.waitForTimeout(350);

    expect(await H.gridPaneCount(page), "still one pane after restore").toBe(1);
    expect(await H.viewportOrientation(page), "1 pane: orientation untouched (gridGroupCount < 2 guard)").toBe("HORIZONTAL");
    expect(await H.viewportFlipCount(page), "no flip (nothing to transpose)").toBe(0);
  });

  test("activation: a workspace rotated-while-inactive normalizes on switch-back [SURVIVAL CRUX] + both panes survive the activation flip", async ({ page }) => {
    // ws1: horizontal 2-pane; capture LIVE survival baselines BEFORE it goes
    // inactive (unlike the mount path, the activation flip happens on panes
    // that never remounted — this is the true survival proof for the
    // normalization primitive).
    const [ws1] = await H.workspaces(page);
    const [a, b] = await H.twoPanes(page);
    await H.waitForSideBySide(page, a, b);
    expect(await H.activeWorkspace(page)).toBe(ws1);
    const ba = (await H.survival(page, a))!;
    const bb = (await H.survival(page, b))!;

    // Switch to a NEW (empty) workspace, then rotate the viewport to portrait.
    // The resize evaluation only ever transposes the ACTIVE workspace (0 grid
    // groups here → no-op), so ws1 keeps its HORIZONTAL split while inactive.
    const ws2 = await H.addWorkspace(page, "rotated-away");
    expect(ws2, "second workspace created + activated").toBeTruthy();
    expect(await H.activeWorkspace(page)).toBe(ws2);
    await page.setViewportSize(TALL);
    await page.waitForTimeout(350); // past the debounce: the eval ran + no-op'd

    // Switch BACK to ws1 → the activation normalization flips it to the
    // current portrait shape (the FLIP module animates it — that is the
    // designed behavior for activation flips).
    await H.setActiveWorkspace(page, ws1);
    await H.waitForStacked(page, a, b);
    expect(await H.viewportOrientation(page), "ws1 normalized to VERTICAL on activation").toBe("VERTICAL");

    // SURVIVAL CRUX: both panes kept their identity across the activation
    // flip (captured while live, before the workspace went inactive).
    await H.assertSurvived(page, a, ba, "activation-flip pane A");
    await H.assertSurvived(page, b, bb, "activation-flip pane B");
    await page.screenshot({
      path: path.join(VISION_DIR, "11-startup-normalize-activation.png"),
      fullPage: true,
    });
  });
});
