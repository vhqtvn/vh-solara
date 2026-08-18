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
// Surfaces covered, in the slice's priority order:
//   1. Chat autocomplete popup (Composer acStyle, a191148d) — REQUIRED.
//   2. Select popup (Select popStyle, fc2ef59d) — composer agent select
//      (flip-up at the screen bottom) and Settings→Appearance font select
//      (open-down mid-screen).
//   3. Session context menu (SessionContextMenu pos, fc2ef59d) — right-click
//      the chat header title; menu must land at the pointer.
//   4. TerminalDock drag-resize (f9a8bbd4) — dock height grows by the VISUAL
//      drag distance at any zoom.
//
// Surfaces EXCLUDED from this spec (recorded per the slice contract):
//   - Sidebar / code-dock / tasks-popover pane drags and hover tooltips
//     (fc2ef59d): same conversion class, outside this slice's four-surface
//     priority list; tooltip placement already has its own non-zoom spec
//     (tooltip.spec.ts).
//   - PathSelectionAction (f9a8bbd4): needs a multi-path selection flow in the
//     code viewer; lower priority than the four covered surfaces.
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
  // The defect premise itself, live: a 100 LAYOUT-px box renders at 100×zoom
  // VISUAL px — gBCR reports visual px while inline px styles resolve in
  // layout px. If this ever fails, the placement asserts below are vacuous.
  expect(premise.probeW, `100px probe gBCR width at uiScale=${scale}`).toBeCloseTo(100 * scale, 1);
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

      // Default height is 300 LAYOUT px (vh.term.height.v1) → the dock renders
      // 300×zoom VISUAL px — a real-surface restatement of the zoom premise.
      const before = await rect(dock);
      expect(Math.abs(before.height - 300 * scale), "default dock visual height = 300 layout px × zoom").toBeLessThanOrEqual(TOL);

      // startResize (f9a8bbd4): height = layoutPx(innerHeight − clientY), so
      // dragging the edge up by D VISUAL px must grow the dock by exactly D
      // VISUAL px at any zoom. Without the conversion it grows by D×zoom
      // (150px at 125% / 96px at 80% for D=120 — far outside TOL).
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
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await dialog.getByRole("button", { name: "Appearance" }).click();
  const trig = dialog.getByLabel("Display font");
  await expect(trig).toBeVisible();
  await trig.click();
  const pop = page.locator(".vh-select-pop");
  await expect(pop).toBeVisible();
  // Mid-screen trigger → the OPEN-DOWN branch (top-anchored popup).
  await expectSelectTracks(pop, trig);
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
