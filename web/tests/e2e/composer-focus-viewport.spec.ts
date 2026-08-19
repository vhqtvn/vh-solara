import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Regression guard for the composer Focus mode ("Expand / focus") viewport bug.
//
// `.composer.focus` is position:absolute; inset:0 — sized by its containing
// block, which is `.composer-wrap` (position:relative), the content-sized strip
// at the bottom of `.chat`. When the composer goes absolute it leaves the flow,
// the wrap collapses to its ~20px of padding, and the "expanded" card becomes a
// 20px sliver whose field+bar overflow BELOW the viewport edge (clipped by the
// composer's overflow:hidden) — the input lands off-screen. The fix mirrors the
// focus class onto the wrap and lifts THE WRAP over `.chat`, so the card spans
// the whole chat pane and the field stays inside the visible viewport.
//
// These tests click the real toggle and assert REAL geometry (headless layout
// geometry is deterministic — this is layout, not GPU rendering): the
// textarea's bounding rect must sit fully inside the visual viewport, and the
// card must actually expand (a collapsed sliver that merely "fits" is not focus
// mode). Both desktop-wide and narrow/mobile widths are covered (the mobile
// media query trips at <=720px).

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 720 },
  // <=720px trips the mobile composer rules (16px font); 667 height stays in
  // the normal height tier (short <=520), avoiding the shape-tier composer
  // caps that are unrelated to focus mode.
  { name: "mobile", width: 375, height: 667 },
] as const;

// Toggle via a native el.click(), mirroring scroll-follow.spec.ts's
// toggleFocus: focus-mode geometry changes around the button can defeat
// Playwright's pointer-actionability checks, while a bubbling DOM click still
// reaches SolidJS's delegated onClick in both directions.
async function toggleFocus(page: import("@playwright/test").Page) {
  await page
    .locator('button[aria-label="Focus mode"]')
    .evaluate((el: HTMLElement) => el.click());
}

interface Rect {
  top: number;
  left: number;
  bottom: number;
  right: number;
  width: number;
  height: number;
}

interface Geometry {
  viewport: { width: number; height: number };
  field: Rect;
  composer: Rect;
  wrap: Rect;
  chat: Rect;
  // offsetParent walk from the composer card: the actual positioned-ancestor
  // chain, with each ancestor's computed position and rect. This is the
  // diagnostic that pins WHY the card is where it is.
  chain: { cls: string; position: string; rect: Rect }[];
}

async function geometry(page: import("@playwright/test").Page): Promise<Geometry> {
  return page.locator(".composer").evaluate((el: HTMLElement) => {
    const rect = (e: Element): Rect => {
      const r = e.getBoundingClientRect();
      return {
        top: r.top,
        left: r.left,
        bottom: r.bottom,
        right: r.right,
        width: r.width,
        height: r.height,
      };
    };
    // Full ancestor walk (card → up to 8 levels): each ancestor's computed
    // position + rect. The first `position != static` entry after the card is
    // the card's actual containing block — the diagnostic that pins WHY the
    // card sits where it sits.
    const chain: Geometry["chain"] = [];
    let p: Element | null = el;
    while (p && chain.length < 8) {
      const cls =
        p.tagName.toLowerCase() +
        (p.className ? "." + p.className.toString().trim().split(/\s+/).join(".") : "");
      chain.push({ cls, position: getComputedStyle(p).position, rect: rect(p) });
      p = p.parentElement;
    }
    const q = (s: string) => document.querySelector(s);
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      field: rect(q(".composer-text")!),
      composer: rect(el),
      wrap: rect(q(".composer-wrap")!),
      chat: rect(q(".chat")!),
      chain,
    };
  });
}

// One rAF settle: the composer autosize effect re-measures on the frame after
// the focusMode signal flips (createEffect → requestAnimationFrame(autosize)),
// so geometry read in the same tick as the click can predate the resize.
async function settle(page: import("@playwright/test").Page) {
  await page.evaluate(
    () =>
      new Promise((res) =>
        requestAnimationFrame(() => requestAnimationFrame(res)),
      ),
  );
}

function expectInsideViewport(g: Geometry, label: string) {
  const dump = JSON.stringify(g, null, 2);
  expect(g.field.top, `${label}: field top must be >= 0\n${dump}`).toBeGreaterThanOrEqual(0);
  expect(g.field.left, `${label}: field left must be >= 0\n${dump}`).toBeGreaterThanOrEqual(0);
  expect(
    g.field.bottom,
    `${label}: field bottom (${g.field.bottom}) must be <= viewport height (${g.viewport.height})\n${dump}`,
  ).toBeLessThanOrEqual(g.viewport.height);
  expect(
    g.field.right,
    `${label}: field right (${g.field.right}) must be <= viewport width (${g.viewport.width})\n${dump}`,
  ).toBeLessThanOrEqual(g.viewport.width);
}

for (const vp of VIEWPORTS) {
  test(`focus mode keeps the input inside the viewport (${vp.name} ${vp.width}x${vp.height})`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto(projectUrl("/?session=demo"));
    await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".composer")).toBeVisible();

    // Toggle focus ON.
    await toggleFocus(page);
    await expect(page.locator(".composer.focus")).toBeVisible();
    await settle(page);
    const g = await geometry(page);

    // (a) The card must actually EXPAND over the chat pane — the bug's other
    //     face is a collapsed sliver that would trivially satisfy (b).
    expect(
      g.composer.height,
      `focus card must expand past half the viewport\n${JSON.stringify(g, null, 2)}`,
    ).toBeGreaterThan(vp.height * 0.5);

    // (b) The input must sit fully inside the visible viewport.
    expectInsideViewport(g, `${vp.name} focus-on`);

    // Round-trip: toggling OFF restores the normal bottom composer, still
    // fully in-viewport.
    await toggleFocus(page);
    await expect(page.locator(".composer.focus")).toHaveCount(0);
    await settle(page);
    const g2 = await geometry(page);
    expectInsideViewport(g2, `${vp.name} focus-off`);
    // And the restored card is bottom-anchored, not still overlaying the pane.
    expect(
      g2.composer.height,
      `focus-off card must return to normal (content-sized) height\n${JSON.stringify(g2, null, 2)}`,
    ).toBeLessThan(vp.height * 0.5);
  });
}
