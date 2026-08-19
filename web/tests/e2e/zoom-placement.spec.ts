import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { projectUrl } from "./util";

// Live-browser receipt (M1) for the UI-zoom fixed-placement conversion commits
// fc2ef59d / f9a8bbd4 / a191148d. prefs.ts applies UI zoom as CSS `zoom` +
// inline `--ui-zoom` on :root; pointer coords and getBoundingClientRect report
// VISUAL px while inline px styles on fixed-position surfaces resolve in LAYOUT
// px; web/src/lib/zoom.ts layoutPx() converts at the style boundary. jsdom
// cannot apply CSS zoom, so the existing unit tests are arithmetic-only — this
// spec proves rendered placement in a real engine.
//
// Every test first PROVES the zoom premise live (inline + computed root zoom,
// --ui-zoom, and a 100px probe box rendering at 100×zoom visual px), then
// asserts the surface's getBoundingClientRect (visual px) against the pointer /
// anchor (visual px), tolerance 2px (gBCR subpixel rounding under zoom).
//
// Surfaces covered, in slice order (1-4: the original four; 5-10: the
// follow-up slice that closed the campaign's remaining excluded surfaces):
//   1. Chat autocomplete popup (Composer acStyle, a191148d) — REQUIRED.
//   2. Select popup (Select popStyle, fc2ef59d) — composer agent select
//      (flip-up at the screen bottom; branch PINNED per review F7) and
//      Settings→Appearance font select (open-down mid-screen; branch PINNED).
//   3. Session context menu (SessionContextMenu pos, fc2ef59d) — right-click
//      the chat header title; menu must land at the pointer.
//   4. TerminalDock drag-resize (f9a8bbd4) — dock height grows by the VISUAL
//      drag distance at any zoom.
//   5. Sidebar drag-resize (Sidebar startResize, fc2ef59d) — width =
//      layoutPx(clientX); the right edge tracks the pointer at any zoom.
//   6. Code-dock drag-resize (CodeFrame startResize, fc2ef59d) — delta-based
//      layoutPx width; the inner edge tracks the pointer (the resize handle
//      lives in the PARENT document, beside the iframe).
//   7. Tasks-popover drag-resize (ChatTasksStatus startTasksResize, fc2ef59d)
//      — the demo session's seeded todos (pkg/fixtures/opencode.go) make the
//      pill + popover reachable; the grip grows width/height by the visual
//      drag deltas while the bottom-right anchor stays put.
//   8. Hover tooltip (Tooltip placeTooltip + the layoutPx style boundary,
//      fc2ef59d) — a real sidebar data-tip anchor; the bubble's visual
//      centre-x and below-branch top track the anchor's visual rect at any
//      zoom. (Non-zoom behaviour — delay, nesting, edge clamping — has its
//      own spec, tooltip.spec.ts.)
//   9. PathSelectionAction floating button (f9a8bbd4) — a REAL DOM selection
//      (Range + addRange fires the same selectionchange the product listens
//      for) over a transcript .filepath span; the button centres on the
//      selection's visual centre and floats 8×zoom visual px above its top
//      (the 8px gap is a LAYOUT-px quantity inside the transform).
//  10. Code-view folder context menu (CodeView .code-ctx, fc2ef59d) —
//      right-click a .code-tree-row.dir INSIDE the same-origin code iframe.
//      The standalone code document shares localStorage, so its own :root
//      carries the same uiScale zoom (prefs.ts's module render-effect runs
//      in any importing document); the layoutPx seam under test is the
//      IFRAME document's own, and the click point, menu rect, and zoom
//      premise are all asserted in the iframe's coordinate space.
//
// Surfaces EXCLUDED from this spec: none remain — the original exclusion
// list (sidebar / code-dock / tasks-popover drags, hover tooltips,
// PathSelectionAction, code-view folder ctxm) was closed by surfaces 5-10.
//
// Engines: spec-compliant CSS zoom needs Chromium ≥ 128 (lane bundles
// playwright-core 1.60.0 → Chrome for Testing 148.0.7778.96, see
// node_modules/playwright-core/browsers.json) or Firefox ≥ 126. The lane runs
// this file on the `chromium` project only — the `firefox` project is
// testMatch-scoped to codeview.spec.ts (playwright.config.ts) — so no engine
// restriction is silently added here. WebKit is skipped defensively in case
// the project matrix is ever widened: it does not implement the standardized
// zoom model.
const UI_KEY = "vh.prefs.uiScale.v1";
const TOL = 2; // px — honest bound for gBCR subpixel rounding under zoom

// Repo root — a real on-disk dir so the terminal's PTY can spawn a shell
// (same rationale as terminal.spec.ts; the demo fixture dir hosts fake
// sessions and cannot back a real shell).
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

async function rect(loc: Locator): Promise<Rect> {
  return loc.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
  });
}

// The live zoom-premise proof, extracted from openSessionAtZoom so ANY test
// can run it after its OWN navigation (review F1: the TerminalDock drag boots
// via /?dir=<repo> and previously inferred the zoom implicitly from its
// 300×scale height assertion). Proves the inline + computed root zoom,
// --ui-zoom, and — the defect premise itself — that a 100px fixed-probe box
// renders at 100×zoom VISUAL px (gBCR reports visual px while inline px
// styles resolve in layout px). If this ever fails, every placement assert
// in this file is vacuous.
async function assertZoomPremise(page: Page, scale: number): Promise<void> {
  const premise = await page.evaluate((s) => {
    const root = document.documentElement;
    const cs = getComputedStyle(root);
    const probe = document.createElement("div");
    probe.style.cssText = "position:fixed;left:0;top:0;width:100px;height:10px;visibility:hidden;";
    document.body.appendChild(probe);
    const probeW = probe.getBoundingClientRect().width;
    probe.remove();
    return {
      inlineZoom: root.style.zoom,
      computedZoom: cs.zoom,
      uiZoomVar: cs.getPropertyValue("--ui-zoom").trim(),
      probeW,
    };
  }, scale);
  expect(premise.inlineZoom, `root.style.zoom at uiScale=${scale}`).toBe(String(scale));
  expect(Number(premise.computedZoom), `computed root zoom at uiScale=${scale}`).toBeCloseTo(scale, 3);
  expect(premise.uiZoomVar, `--ui-zoom at uiScale=${scale}`).toBe(String(scale));
  expect(premise.probeW, `100px probe gBCR width at uiScale=${scale}`).toBeCloseTo(100 * scale, 1);
}

// Boot the app with the UI-zoom pref persisted BEFORE first load (the same
// {v,data} envelope the Settings slider writes), on a DESKTOP viewport so
// applyScale takes the CSS-zoom branch — mobile-standalone pins --ui-zoom to 1
// and would fail the premise asserts below, so a vacuously-unzoomed run cannot
// pass. Then open the demo session and PROVE the premise in the live engine.
async function openSessionAtZoom(page: Page, scale: number): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.addInitScript(
    ([k, v]) => localStorage.setItem(k, JSON.stringify({ v: 1, data: v })),
    [UI_KEY, scale] as [string, number],
  );
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();
  await page.getByPlaceholder(/Message/).waitFor({ timeout: 15000 });
  await assertZoomPremise(page, scale);
}

// The Select popup opens 4px below the trigger's bottom, or flips UP to 4px
// above its top when there is no room below (composer bar at screen bottom).
// Both gaps are converted as part of the whole viewport-px quantity, so the
// VISUAL gap is 4px at every zoom level. Assert left tracking (and the
// min-width anchor) plus a ≤TOL gap on whichever side it opened.
async function expectSelectTracks(pop: Locator, trig: Locator): Promise<void> {
  const p = await rect(pop);
  const t = await rect(trig);
  expect(Math.abs(p.left - t.left), "select popup visual left ≈ trigger visual left").toBeLessThanOrEqual(TOL);
  expect(p.width, "select popup visual width ≥ trigger visual width (min-width anchor)").toBeGreaterThanOrEqual(t.width - TOL);
  const gapDown = Math.abs(p.top - (t.bottom + 4));
  const gapUp = Math.abs(t.top - 4 - p.bottom);
  expect(Math.min(gapDown, gapUp), "select popup sits ≈4px from the trigger (open-down or flip-up)").toBeLessThanOrEqual(TOL);
}

test.skip(
  ({ browserName }) => browserName === "webkit",
  "WebKit does not implement the spec-compliant CSS zoom model this spec asserts",
);

// Open the code dock on the open demo session by clicking a file path in the
// transcript (the codeview.spec.ts navigation). The serial lane appends turns
// to the shared demo session, windowing the original path-bearing messages
// out of the rendered DOM at the tail — scroll to the top to surface them
// first. Returns the docked pane locator (the resize handle + head chrome
// live in the PARENT document; only the tree/file view is inside the iframe).
async function openCodeDock(page: Page): Promise<Locator> {
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => (el.scrollTop = 0));
  await page.locator(".filepath", { hasText: "src/parser.go" }).first().click();
  const dock = page.locator(".code-dock.dock");
  await expect(dock).toBeVisible({ timeout: 6000 });
  return dock;
}

for (const scale of [1.25, 0.8] as const) {
  const pct = `${Math.round(scale * 100)}%`;

  test(`chat autocomplete popup tracks the composer at UI zoom ${pct}`, async ({ page }) => {
    await openSessionAtZoom(page, scale);
    const ta = page.getByPlaceholder(/Message/);
    await ta.fill("look at @parser");
    const pop = page.locator(".ac-pop");
    await expect(pop).toBeVisible({ timeout: 5000 });

    // acStyle (a191148d): left/width from the composer's gBCR, bottom from
    // innerHeight − composer.top + 6 — each converted via layoutPx, so the
    // popup's VISUAL left/width match the composer and its VISUAL bottom edge
    // sits 6px above the composer's VISUAL top, at any zoom.
    const p = await rect(pop);
    const c = await rect(page.locator(".composer"));
    expect(Math.abs(p.left - c.left), "ac popup visual left ≈ composer visual left").toBeLessThanOrEqual(TOL);
    expect(Math.abs(p.width - c.width), "ac popup visual width ≈ composer visual width").toBeLessThanOrEqual(TOL);
    expect(Math.abs(p.bottom - (c.top - 6)), "ac popup visual bottom ≈ 6px above composer visual top").toBeLessThanOrEqual(TOL);
  });

  test(`composer agent select popup tracks its trigger at UI zoom ${pct}`, async ({ page }) => {
    await openSessionAtZoom(page, scale);
    const trig = page.locator(".agent-select .vh-select-btn");
    await expect(trig).toBeVisible();
    await trig.click();
    const pop = page.locator(".vh-select-pop");
    await expect(pop).toBeVisible();
    // The composer bar sits at the screen bottom, so this exercises the
    // FLIP-UP branch (bottom-anchored popup) of Select's popStyle.
    await expectSelectTracks(pop, trig);
    // Flip-branch pinning (review F7): expectSelectTracks accepts EITHER
    // branch via min(gapDown, gapUp) — pin THIS one to flip-up: the popup's
    // bottom edge must sit ≈4px ABOVE the trigger's top, never below it.
    const pf = await rect(pop);
    const tf = await rect(trig);
    expect(pf.bottom, "flip-up branch pinned: popup visual bottom ≤ trigger visual top").toBeLessThanOrEqual(tf.top + TOL);
    await page.keyboard.press("Escape");
  });

  test(`session context menu lands at the pointer at UI zoom ${pct}`, async ({ page }) => {
    await openSessionAtZoom(page, scale);
    const title = page.locator(".main-title.has-menu");
    await expect(title).toBeVisible();
    const t = await rect(title);
    // A point well inside the viewport, far from the clamped edges (the menu
    // clamps to the viewport; we assert the UNCLAMPED tracks-the-pointer path).
    const x = t.left + t.width * 0.4;
    const y = t.top + t.height / 2;
    await page.mouse.click(x, y, { button: "right" });
    const menu = page.locator(".ctxm-menu");
    await expect(menu).toBeVisible();
    // .ctxm-menu plays the 0.12s `dialog-in` entry animation (from
    // translateY(8px) scale(0.99) to none — 80-professional-pass.css). Measure
    // only at the resting state, else gBCR reads through the in-flight
    // transform (a ~10px visual offset that scales with zoom and would fail
    // even at 100%). The unclamped regime holds throughout: the fixture menu
    // is ~481px tall, so the pos() bottom-clamp never engages at y≈30.
    await expect(menu).toHaveCSS("transform", "none");
    // SessionContextMenu pos (fc2ef59d): layoutPx(clientX/clientY) → the
    // menu's VISUAL left/top land at the pointer's VISUAL clientX/clientY.
    const m = await rect(menu);
    expect(Math.abs(m.left - x), "menu visual left ≈ pointer clientX").toBeLessThanOrEqual(TOL);
    expect(Math.abs(m.top - y), "menu visual top ≈ pointer clientY").toBeLessThanOrEqual(TOL);
    await page.keyboard.press("Escape");
  });

  test(`sidebar drag-resize tracks the pointer at UI zoom ${pct}`, async ({ page }) => {
    await openSessionAtZoom(page, scale);
    const sb = page.locator(".sidebar");
    await expect(sb).toBeVisible();
    const handle = page.locator(".sidebar-resize");
    // Desktop 1280px viewport → the wide (non-rail) band, where the handle is
    // displayed (rail hides it; see 10-sidebar-statusmark.css).
    await expect(handle).toBeVisible();

    // Sidebar.startResize (fc2ef59d): the sidebar is pinned to the viewport's
    // left, so the new width IS the pointer's X — setSidebarWidth(layoutPx(
    // clientX)) (clamped 200..480 LAYOUT px, rounded to int) → the sidebar's
    // VISUAL right edge lands exactly at the pointer's final VISUAL X, at any
    // zoom. (Growth-vs-drag-distance is NOT the clean invariant here: the
    // handle's centre sits 5 LAYOUT px inside the edge, so the edge-to-pointer
    // contract is the honest assertion — unlike the TerminalDock drag, whose
    // handle straddles the edge ±0.5px.) The .sidebar width carries a 0.16s
    // transition — settle before measuring.
    const before = await rect(sb);
    const h = await rect(handle);
    const cy = h.top + h.height / 2;
    const x0 = h.left + h.width / 2;
    const DRAG = 100; // visual px, rightward
    const xEnd = x0 + DRAG;
    await page.mouse.move(x0, cy);
    await page.mouse.down();
    await page.mouse.move(xEnd, cy, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(350); // let the width transition settle

    const after = await rect(sb);
    expect(Math.abs(after.right - xEnd), "sidebar visual right edge lands at the pointer's final X").toBeLessThanOrEqual(TOL);
    expect(Math.abs(after.width - xEnd), "sidebar visual width ≈ pointer's final visual X (pinned at viewport left)").toBeLessThanOrEqual(TOL);
    // Non-vacuity: the drag visibly widened the sidebar.
    expect(after.width, "sidebar actually grew").toBeGreaterThan(before.width);
  });

  test(`code dock drag-resize tracks the pointer at UI zoom ${pct}`, async ({ page }) => {
    await openSessionAtZoom(page, scale);
    const dock = await openCodeDock(page);

    // CodeFrame.startResize (fc2ef59d): delta-based — the dock is right-docked
    // by default, so dragging the inner (left) edge LEFT by D VISUAL px adds
    // D/z to flex-basis (LAYOUT px, clamped 280..900, rounded) → the dock's
    // VISUAL width grows by exactly D and its left edge tracks the pointer.
    // No transition on .code-dock — measure right after pointerup.
    const before = await rect(dock);
    const handle = page.locator(".code-dock-resize");
    const h = await rect(handle);
    const cy = h.top + h.height / 2;
    const x0 = h.left + h.width / 2;
    const DRAG = 100; // visual px, leftward (widens a right-docked pane)
    await page.mouse.move(x0, cy);
    await page.mouse.down();
    await page.mouse.move(x0 - DRAG, cy, { steps: 8 });
    await page.mouse.up();

    const after = await rect(dock);
    expect(Math.abs(after.width - before.width - DRAG), "code dock visual width grows by the visual drag distance").toBeLessThanOrEqual(TOL);
    expect(Math.abs(before.left - after.left - DRAG), "code dock visual left edge tracks the pointer").toBeLessThanOrEqual(TOL);

    // Serial-lane hygiene: close the dock (state is per-context anyway, but
    // leave the shared fixture session's UI tidy).
    await page.locator(".code-dock .icon-btn[aria-label='Close']").click();
    await expect(page.locator(".code-dock.dock")).toHaveCount(0);
  });

  test(`tasks popover drag-resize tracks the pointer at UI zoom ${pct}`, async ({ page }) => {
    await openSessionAtZoom(page, scale);
    // The fixture seeds the demo session's todos (pkg/fixtures/opencode.go:
    // 1 in_progress + 3 pending), so the Tasks pill appears once the
    // subtree-todos poll settles (immediate fetch + 5s cadence).
    const pill = page.locator(".tasks-pill");
    await expect(pill).toBeVisible({ timeout: 15000 });
    await pill.click();
    const pop = page.locator(".tasks-popup");
    await expect(pop).toBeVisible();

    // ChatTasksStatus.startTasksResize (fc2ef59d): the grip at the popup's
    // top-left grows the popup UP/LEFT from its bottom-right anchor — the
    // width/height inline styles are LAYOUT px fed layoutPx-converted pointer
    // deltas (w clamped 220..560, h ≤ 0.72×layoutPx(innerHeight)), so a
    // D-VISUAL-px drag grows the VISUAL dimension by exactly D while the
    // anchored right/bottom edges stay put.
    const before = await rect(pop);
    const grip = page.locator(".tasks-resize");
    const g = await rect(grip);
    const x0 = g.left + g.width / 2;
    const y0 = g.top + g.height / 2;
    const DX = 80; // visual px, leftward → wider
    const DY = 60; // visual px, upward → taller
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 - DX, y0 - DY, { steps: 8 });
    await page.mouse.up();

    const after = await rect(pop);
    expect(Math.abs(after.width - before.width - DX), "tasks popup visual width grows by the visual drag delta").toBeLessThanOrEqual(TOL);
    expect(Math.abs(after.height - before.height - DY), "tasks popup visual height grows by the visual drag delta").toBeLessThanOrEqual(TOL);
    expect(Math.abs(after.right - before.right), "popup stays anchored at its visual right edge").toBeLessThanOrEqual(TOL);
    expect(Math.abs(after.bottom - before.bottom), "popup stays anchored at its visual bottom edge").toBeLessThanOrEqual(TOL);

    // Hygiene: toggle the popover closed (the persisted size is per-context).
    await pill.click();
    await expect(pop).toHaveCount(0);
  });

  test(`hover tooltip tracks its anchor at UI zoom ${pct}`, async ({ page }) => {
    await openSessionAtZoom(page, scale);
    // A real data-tip surface in the unclamped mid-screen regime: the
    // sidebar's search toggle. Hover arms the 450ms delay, then the bubble
    // places. tip-in animates opacity only — gBCR is stable while it fades.
    const anchor = page.locator(".icon-btn[aria-label='Search sessions']");
    await expect(anchor).toBeVisible();
    await anchor.hover();
    const bubble = page.locator(".tooltip");
    await expect(bubble).toBeVisible({ timeout: 5000 });

    // placeTooltip computes in VIEWPORT px (anchor gBCR, bubble gBCR, and
    // innerWidth/innerHeight are all visual); Tooltip.tsx converts the
    // assigned left/top through layoutPx — so the bubble's VISUAL centre-x
    // tracks the anchor's visual centre and, on the below branch (anchor
    // near the screen top), its visual top sits 6px under the anchor's
    // visual bottom, at any zoom.
    const a = await rect(anchor);
    const b = await rect(bubble);
    const anchorCx = a.left + a.width / 2;
    expect(Math.abs(b.left + b.width / 2 - anchorCx), "tooltip visual centre ≈ anchor visual centre").toBeLessThanOrEqual(TOL);
    expect(Math.abs(b.top - (a.bottom + 6)), "tooltip visual top ≈ 6px below anchor visual bottom").toBeLessThanOrEqual(TOL);
    // Mouse off the anchor onto a tip-free surface (the composer textarea)
    // so the bubble hides again — a blind mid-screen move could land on a
    // transcript data-tip element and re-arm a NEW bubble (lane hygiene).
    await page.getByPlaceholder(/Message/).hover();
    await expect(bubble).toHaveCount(0);
  });

  test(`path selection action floats above the selection at UI zoom ${pct}`, async ({ page }) => {
    await openSessionAtZoom(page, scale);
    await page.locator(".chat-scroll").evaluate((el: HTMLElement) => (el.scrollTop = 0));
    const span = page.locator(".filepath", { hasText: "src/parser.go" }).first();
    await expect(span).toBeVisible();

    // A REAL DOM selection over the path span: Range + addRange fires the
    // same selectionchange the component listens for, and the geometry comes
    // from the same getRangeAt(0).getBoundingClientRect() the product reads.
    await span.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
    });
    const btn = page.getByRole("button", { name: /Open file/ });
    await expect(btn).toBeVisible({ timeout: 5000 });

    // PathSelectionAction (f9a8bbd4): left = layoutPx(selection centre-x),
    // top = layoutPx(selection top); the fixed button then self-translates
    // (-50%, calc(-100% - 8px)) — so its VISUAL centre-x equals the
    // selection's visual centre and its VISUAL bottom sits 8×zoom px above
    // the selection's visual top (the 8px gap lives in the transform, a
    // LAYOUT-px quantity — it is NOT zoom-compensated, by design).
    const s = await rect(span);
    const b = await rect(btn);
    const selCx = s.left + s.width / 2;
    expect(Math.abs(b.left + b.width / 2 - selCx), "action visual centre ≈ selection visual centre").toBeLessThanOrEqual(TOL);
    expect(Math.abs(b.bottom - (s.top - 8 * scale)), "action visual bottom ≈ 8×zoom px above selection visual top").toBeLessThanOrEqual(TOL);

    // Hygiene: drop the selection (hides the button via the same rAF path).
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await expect(btn).toHaveCount(0);
  });

  test(`code-view folder context menu lands at the pointer at UI zoom ${pct}`, async ({ page }) => {
    // The demo fixture dir is EMPTY on disk (its transcript paths like
    // src/parser.go are fake — only the chat content exists), so the code TREE
    // needs a real project. Boot the repo itself (same rationale as the
    // TerminalDock describe: repoRoot is a real on-disk dir) and open the code
    // dock with its Ctrl+B hotkey (App.tsx global binding — the header
    // switcher has no Code tab; the dock is the code surface).
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.addInitScript(
      ([k, v]) => localStorage.setItem(k, JSON.stringify({ v: 1, data: v })),
      [UI_KEY, scale] as [string, number],
    );
    await page.goto(`/?dir=${encodeURIComponent(repoRoot)}`);
    await assertZoomPremise(page, scale); // F1: prove the premise on THIS navigation
    await page.keyboard.press("Control+b");
    const dock = page.locator(".code-dock.dock");
    await expect(dock).toBeVisible({ timeout: 6000 });

    // The tree (and its fixed .code-ctx menu) live INSIDE the same-origin
    // code iframe. The standalone code document shares localStorage, so its
    // own :root carries the same zoom (prefs.ts's module render-effect runs
    // in any importing document) — prove that in-iframe premise, then assert
    // EVERYTHING (click point, menu rect) in the iframe's own coordinate
    // space: the menu tracks the pointer iff the iframe document's layoutPx
    // conversion (fc2ef59d) is correct, regardless of how the parent's zoom
    // layers onto the frame box.
    const code = page.frameLocator('iframe[title="Code"]');
    const framePremise = await code.locator("html").evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        inlineZoom: (el as HTMLElement).style.zoom,
        uiZoomVar: cs.getPropertyValue("--ui-zoom").trim(),
      };
    });
    expect(framePremise.inlineZoom, `iframe root.style.zoom at uiScale=${scale}`).toBe(String(scale));
    expect(framePremise.uiZoomVar, `iframe --ui-zoom at uiScale=${scale}`).toBe(String(scale));

    const row = code.locator(".code-tree-row.dir").first();
    await expect(row).toBeVisible({ timeout: 8000 });
    const r = await row.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, top: b.top, width: b.width, height: b.height };
    });
    // Right-click the row's centre. Playwright's click hit-test mis-maps
    // element-relative offsets for an iframe nested in a CSS-zoomed parent
    // whose OWN document is also zoomed (the computed point lands off the row
    // — observed interceptors differ per zoom: the row's <aside> at 1.25, the
    // frame <html> at 0.8), so dispatch the contextmenu SYNTHETICALLY at the
    // row's real in-iframe gBCR centre — the same clientX/clientY (the
    // iframe's visual space) a real pointer at that point would produce.
    // Everything downstream of the event is fully live: Solid's delegated
    // handler, the layoutPx conversion in the zoomed iframe document, and
    // the fixed menu's rendered position.
    await row.evaluate((el, pos) => {
      el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: pos.x, clientY: pos.y }));
    }, { x: r.left + r.width * 0.5, y: r.top + r.height / 2 });
    const menu = code.locator(".code-ctx");
    await expect(menu).toBeVisible();
    const m = await menu.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, top: b.top };
    });
    expect(Math.abs(m.left - (r.left + r.width * 0.5)), "code ctx visual left ≈ pointer clientX (iframe space)").toBeLessThanOrEqual(TOL);
    expect(Math.abs(m.top - (r.top + r.height / 2)), "code ctx visual top ≈ pointer clientY (iframe space)").toBeLessThanOrEqual(TOL);

    // Hygiene: close the dock — the parent-document click does NOT reach the
    // iframe's own document-click dismiss (separate documents), but the dock
    // unmount hides the frame (and its menu) and the per-test context dies
    // with it anyway.
    await page.locator(".code-dock .icon-btn[aria-label='Close']").click();
    await expect(page.locator(".code-dock.dock")).toHaveCount(0);
  });

  test.describe(`terminal dock drag at UI zoom ${pct}`, () => {
    test.beforeEach(async ({ request }) => {
      // Same rationale as terminal.spec.ts: one shared fixtureserver backs the
      // whole serial lane; kill every live PTY so the Terminal click spawns a
      // fresh shell (uses the bare request fixture — the page hasn't navigated
      // yet; GET is CSRF-exempt, POST carries X-VH-CSRF).
      const res = await request.get("/vh/term/list");
      const terms = res.ok() ? ((await res.json()) as Array<{ dir: string; id: string }>) : [];
      await Promise.all(
        terms.map((tm) =>
          request.post("/vh/term/kill", { headers: { "X-VH-CSRF": "1" }, data: { dir: tm.dir, id: tm.id } }),
        ),
      );
    });

    test("dock height renders in layout px and the drag edge tracks the pointer", async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.addInitScript(
        ([k, v]) => localStorage.setItem(k, JSON.stringify({ v: 1, data: v })),
        [UI_KEY, scale] as [string, number],
      );
      await page.goto(`/?dir=${encodeURIComponent(repoRoot)}`);
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
      const dock = page.locator(".term-dock");
      await expect(dock).toBeVisible();
      // Review F1: prove the live zoom premise on THIS navigation too (this
      // describe boots via /?dir=<repo>, not openSessionAtZoom) instead of
      // inferring the zoom implicitly from the 300×scale height assert below.
      await assertZoomPremise(page, scale);

      // Default height is 300 LAYOUT px (vh.term.height.v1) → the dock renders
      // 300×zoom VISUAL px — a real-surface restatement of the zoom premise.
      const before = await rect(dock);
      expect(Math.abs(before.height - 300 * scale), "default dock visual height = 300 layout px × zoom").toBeLessThanOrEqual(TOL);

      // startResize (f9a8bbd4): height = layoutPx(innerHeight − clientY), so
      // dragging the edge up by D VISUAL px must grow the dock by exactly D
      // VISUAL px at any zoom. The pre-fix code recomputed the height from
      // viewport coords each move (h = innerHeight − clientY, unconverted —
      // NOT an incremental-drag defect that would grow D×zoom): at a 300
      // layout-px start height a 120 visual-px drag writes h = 300z + 120
      // LAYOUT px, so the VISUAL growth is 300z(z−1) + 120z ≈ +244px at 1.25
      // and ≈ +48px at 0.8 — both far outside TOL.
      const handle = page.locator(".term-dock-resize");
      const h = await rect(handle);
      const cx = h.left + h.width / 2;
      const y0 = h.top + h.height / 2;
      const DRAG = 120; // visual px, upward
      await page.mouse.move(cx, y0);
      await page.mouse.down();
      await page.mouse.move(cx, y0 - DRAG, { steps: 8 });
      await page.mouse.up();

      const after = await rect(dock);
      expect(Math.abs(after.height - before.height - DRAG), "dock visual height grows by the visual drag distance").toBeLessThanOrEqual(TOL);
      expect(Math.abs(before.top - after.top - DRAG), "dock visual top edge tracks the pointer").toBeLessThanOrEqual(TOL);
    });
  });
}

test("settings display-font select popup (open-down) tracks its trigger at UI zoom 125%", async ({ page }) => {
  await openSessionAtZoom(page, 1.25);
  // Branch determinism for the F7 pin: Select flips UP when less than
  // min(maxH,220)px of viewport remains below the trigger (Select.tsx
  // popStyle). The Settings dialog is a FIXED min(82vh,560px) layout-px tall
  // (70-composer-diff-git.css .dialog.settings) and flex-centered, so the
  // Display-font row (near the tab's bottom) sits ~697 visual px into the
  // dialog — on the standard 900px viewport only ~103px remain below and the
  // popup flips UP. Grow the viewport to 1400px: the fixed-height dialog just
  // re-centers, leaving ~353px below the trigger → the open-down branch.
  await page.setViewportSize({ width: 1280, height: 1400 });
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Appearance" }).click();
  const trig = dialog.getByLabel("Display font");
  await expect(trig).toBeVisible();
  await trig.click();
  const pop = page.locator(".vh-select-pop");
  await expect(pop).toBeVisible();
  // Tall-viewport trigger → the OPEN-DOWN branch (top-anchored popup).
  await expectSelectTracks(pop, trig);
  // Flip-branch pinning (review F7): pin THIS one to open-down — the popup's
  // top edge must sit ≈4px BELOW the trigger's bottom, never above it.
  {
    const pd = await rect(pop);
    const td = await rect(trig);
    expect(pd.top, "open-down branch pinned: popup visual top ≥ trigger visual bottom").toBeGreaterThanOrEqual(td.bottom - TOL);
  }
  await page.keyboard.press("Escape");
});

test("anchor at 100% zoom: autocomplete popup and context menu track (identity sanity)", async ({ page }) => {
  await openSessionAtZoom(page, 1);
  const ta = page.getByPlaceholder(/Message/);
  await ta.fill("look at @parser");
  const pop = page.locator(".ac-pop");
  await expect(pop).toBeVisible({ timeout: 5000 });
  const p = await rect(pop);
  const c = await rect(page.locator(".composer"));
  expect(Math.abs(p.left - c.left)).toBeLessThanOrEqual(TOL);
  expect(Math.abs(p.bottom - (c.top - 6))).toBeLessThanOrEqual(TOL);

  const title = page.locator(".main-title.has-menu");
  await expect(title).toBeVisible();
  const t = await rect(title);
  const x = t.left + t.width * 0.4;
  const y = t.top + t.height / 2;
  await page.mouse.click(x, y, { button: "right" });
  const menu = page.locator(".ctxm-menu");
  await expect(menu).toBeVisible();
  await expect(menu).toHaveCSS("transform", "none"); // settle dialog-in (see above)
  const m = await rect(menu);
  expect(Math.abs(m.left - x)).toBeLessThanOrEqual(TOL);
  expect(Math.abs(m.top - y)).toBeLessThanOrEqual(TOL);
  await page.keyboard.press("Escape");
});

// Wheel-scroll parity across zoom (76dfaeb2 follow-up). xterm.js v6's wheel
// consumers mix a VISUAL-px pixel-mode delta into LAYOUT-px math (scrollback
// scrollTop in SmoothScrollableElement; consumeWheelEvent's layout-px cell
// divisor), so at zoom ≠ 1 the terminal scrolls ~×z: 1.25× too fast at 125%,
// 1.25× too slow at 80%. The TerminalPane wheel seam (rewriteWheelEvent)
// divides pixel-mode deltas by zoom once at the capture boundary.
//
// Live-browser proof strategy: the same physical wheel gesture (identical
// pixel-mode deltaY notches) must advance the terminal by the same VISUAL
// distance at every zoom. Rows are LAYOUT units, so the parity invariant is
// Δrows(1.25) × 1.25 ≈ Δrows(1) — inside a tolerance covering xterm's
// per-event round() row quantization (≤ z×0.5 + 0.5 rows ≈ 1.13 at 1.25).
// Unfixed code scrolls Δrows(1.25) = Δrows(1) (layout px are what the delta
// is wrongly treated as), so |Δ×1.25 − Δ| = 0.25Δ ≈ 7 rows for this test's
// ~28-row gesture — far outside tolerance. The assertion is font-metric
// INDEPENDENT: no cell size is assumed, only that both zoom phases share the
// same layout dims (dock height pref is layout px) and the same PTY buffer.
//
// The buffer survives the in-test zoom switch: the PTY lives server-side and
// replays identical scrollback bytes on reattach, so phase 2 (localStorage
// 1.25 + reload, NO PTY kill) measures the very same content ladder (`seq`
// emits pure-integer lines — the first pure-int row of .xterm-rows innerText
// is a font-free scroll marker). A non-vacuity floor (≥ 12 rows) guards
// against a 0==0 pass.
test.describe("terminal wheel parity across UI zoom", () => {
  const NOTCHES = 8;
  const NOTCH = -300; // visual px per wheel event (pixel deltaMode)
  const PARITY_TOL_ROWS = 1.5;
  // Non-vacuity floor: the observed gesture moves ~25-30 rows at 100% (the
  // per-notch advance depends on engine wheel heuristics — measured ~3.4
  // rows/notch in this lane), far above quantization noise; a broken seam
  // (0 rows) or a trackpad-damped no-op must not pass vacuously.
  const FLOOR_ROWS = 8;

  test.beforeEach(async ({ request }) => {
    // Same rationale as the drag describe above: one shared fixtureserver
    // backs the serial lane; kill every live PTY so this test boots a fresh
    // shell with a known-empty scrollback (the in-test reload keeps it).
    const res = await request.get("/vh/term/list");
    const terms = res.ok() ? ((await res.json()) as Array<{ dir: string; id: string }>) : [];
    await Promise.all(
      terms.map((tm) =>
        request.post("/vh/term/kill", { headers: { "X-VH-CSRF": "1" }, data: { dir: tm.dir, id: tm.id } }),
      ),
    );
  });

  // First pure-integer line visible in the terminal — a scroll marker that
  // needs no font metrics (seq output is a ladder of ints; any prompt/echo
  // noise above it is skipped identically in both phases).
  const topLineNumber = (page: Page) =>
    page.locator(".xterm-rows").evaluate((el) => {
      for (const line of (el as HTMLElement).innerText.split("\n")) {
        if (/^\d+$/.test(line.trim())) return Number.parseInt(line, 10);
      }
      return null;
    });

  // xterm v6 smoothScrollDuration defaults to 0 (immediate), but the seq
  // burst streams asynchronously — poll until the marker is stable.
  async function settledTopLineNumber(page: Page): Promise<number> {
    let prev: number | null = null;
    for (let i = 0; i < 40; i++) {
      const cur = await topLineNumber(page);
      if (cur !== null && cur === prev) return cur;
      prev = cur;
      await page.waitForTimeout(150);
    }
    throw new Error(`terminal scroll marker never settled (last: ${prev})`);
  }

  async function measureWheelAdvance(page: Page): Promise<number> {
    const before = await settledTopLineNumber(page);
    const box = await page.locator(".xterm-screen").boundingBox();
    if (!box) throw new Error(".xterm-screen not rendered");
    // Hover the screen center — well inside the viewport, clear of the dock
    // header and the scrollbar lane. mouse.wheel dispatches pixel-mode wheel
    // events at the current pointer position (visual px, like a real wheel).
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < NOTCHES; i++) await page.mouse.wheel(0, NOTCH);
    const after = await settledTopLineNumber(page);
    return before - after; // rows scrolled UP (layout units)
  }

  test("identical pixel wheel events scroll the same VISUAL distance at 100% and 125%", async ({ page }) => {
    // ---- Phase 1: boot at zoom 1, fill the scrollback ----
    // No addInitScript here on purpose: init scripts re-run on the phase-2
    // reload and would clobber the 1.25 value. Each Playwright test gets a
    // fresh context (clean localStorage → default zoom 1), and the premise
    // asserts below prove the live zoom of BOTH phases.
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`/?dir=${encodeURIComponent(repoRoot)}`);
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(page.locator(".term-host")).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".term-status.open")).toBeVisible({ timeout: 10000 });
    await page.locator(".term-host").click(); // focus the terminal
    await page.keyboard.type("seq 1 250");
    await page.keyboard.press("Enter");
    await expect
      .poll(() => topLineNumber(page), { timeout: 15000 })
      .toBeLessThanOrEqual(250); // output complete (marker visible)

    // Live premise, phase 1: the engine is really at zoom 1 (same probe as
    // openSessionAtZoom — guards a leaked/changed default pref). applyScale
    // writes the inline values even at scale 1 (zoom="1", --ui-zoom: 1).
    const premise1 = await page.evaluate(() => {
      const root = document.documentElement;
      const cs = getComputedStyle(root);
      return { inlineZoom: root.style.zoom, computedZoom: cs.zoom, uiZoomVar: cs.getPropertyValue("--ui-zoom").trim() };
    });
    expect(premise1.inlineZoom, "root.style.zoom at phase 1").toBe("1");
    expect(Number(premise1.computedZoom) || 1, "computed root zoom at phase 1").toBeCloseTo(1, 3);
    expect(premise1.uiZoomVar, "--ui-zoom at phase 1").toBe("1");

    const moved100 = await measureWheelAdvance(page);
    expect(moved100, `non-vacuity: the gesture must scroll at 100% (got ${moved100})`).toBeGreaterThanOrEqual(FLOOR_ROWS);

    // ---- Phase 2: same page, zoom 1.25, SAME PTY (replays identical buffer) ----
    await page.evaluate(
      ([k, v]) => localStorage.setItem(k, JSON.stringify({ v: 1, data: v })),
      [UI_KEY, 1.25] as [string, number],
    );
    await page.reload();
    // termOpen is session-scoped (deliberately not persisted — ui.ts), so the
    // dock needs re-opening after the reload; the server-side PTY survives it.
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(page.locator(".term-host")).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".term-status.open")).toBeVisible({ timeout: 10000 });
    await expect
      .poll(() => topLineNumber(page), { timeout: 15000 })
      .toBeLessThanOrEqual(250); // replay complete

    // The file-standard live zoom premise (see openSessionAtZoom): prove the
    // engine really applied 1.25 before trusting the parity assertion.
    const premise = await page.evaluate(() => {
      const root = document.documentElement;
      const cs = getComputedStyle(root);
      const probe = document.createElement("div");
      probe.style.cssText = "position:fixed;left:0;top:0;width:100px;height:10px;visibility:hidden;";
      document.body.appendChild(probe);
      const probeW = probe.getBoundingClientRect().width;
      probe.remove();
      return { inlineZoom: root.style.zoom, computedZoom: cs.zoom, uiZoomVar: cs.getPropertyValue("--ui-zoom").trim(), probeW };
    });
    expect(premise.inlineZoom, "root.style.zoom at uiScale=1.25 (wheel phase 2)").toBe("1.25");
    expect(Number(premise.computedZoom), "computed root zoom at uiScale=1.25 (wheel phase 2)").toBeCloseTo(1.25, 3);
    expect(premise.uiZoomVar, "--ui-zoom at uiScale=1.25 (wheel phase 2)").toBe("1.25");
    expect(premise.probeW, "100px probe gBCR width at uiScale=1.25 (wheel phase 2)").toBeCloseTo(125, 1);

    const moved125 = await measureWheelAdvance(page);
    expect(moved125, `non-vacuity: the gesture must scroll at 125% (got ${moved125})`).toBeGreaterThanOrEqual(FLOOR_ROWS);

    // Parity: rows are layout px, so equal VISUAL advance means
    // moved125 × 1.25 ≈ moved100. Unfixed code leaves moved125 == moved100
    // (0.25×moved ≈ 7 rows off at this gesture size — well outside the 1.5-row
    // quantization tolerance); the fix lands within it.
    console.log(`[wheel-parity] moved100=${moved100} moved125=${moved125} → ${moved125 * 1.25} vs ${moved100}`);
    expect(
      Math.abs(moved125 * 1.25 - moved100),
      `visual wheel parity: Δrows@125%×1.25 (${moved125 * 1.25}) ≈ Δrows@100% (${moved100})`,
    ).toBeLessThanOrEqual(PARITY_TOL_ROWS);
  });
});
