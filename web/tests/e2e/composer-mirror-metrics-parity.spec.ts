import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Regression spec for the composer caret/mirror empty-state drift bug
// ("the input textarea and its rendered contents' caret are not in sync, both x
// and y, right from empty state"). The transparent <textarea class="composer-
// text"> overlays the highlight <div class="composer-mirror">; for the textarea's
// caret to sit exactly over the highlighted glyph, the two layers MUST share
// identical font metrics (font-size + line-height) and identical padding. Any
// divergence drifts the caret off the glyph on BOTH axes — and because font-size
// drives glyph advance + line-box height, even the FIRST typed character is off
// (the "right from empty state" symptom).
//
// The mobile case is the known hazard: the iOS-zoom-prevention rule historically
// set `font-size: 16px` on ONLY the textarea (`.composer textarea`), leaving the
// mirror (a div) at the 14px base — so on mobile the two layers advanced at
// different metrics and the caret never tracked the highlight. The fix gives both
// layers ONE source of truth so they cannot diverge.
//
// NOTE: the session is opened at DESKTOP width (at ≤720px the session tree is an
// off-canvas drawer, so the sidebar click to open a session is not reachable);
// the page is then RESIZED to mobile so the media query re-evaluates against the
// already-mounted composer. The composer lives in the always-visible main column
// (the sidebar drawer is what hides), so its metrics are observable at both sizes.

interface Metrics {
  taFs: string;
  miFs: string;
  taLh: string;
  miLh: string;
  taPad: string;
  miPad: string;
}

async function metrics(page: import("@playwright/test").Page): Promise<Metrics> {
  return page.evaluate(() => {
    const ta = document.querySelector(".composer-text") as HTMLElement;
    const mi = document.querySelector(".composer-mirror") as HTMLElement;
    const cs = (el: HTMLElement) => {
      const c = getComputedStyle(el);
      return { fs: c.fontSize, lh: c.lineHeight, pad: `${c.paddingTop}|${c.paddingLeft}` };
    };
    const a = cs(ta);
    const b = cs(mi);
    return { taFs: a.fs, miFs: b.fs, taLh: a.lh, miLh: b.lh, taPad: a.pad, miPad: b.pad };
  });
}

test("composer textarea and mirror share font metrics at desktop AND mobile (empty state)", async ({ page }) => {
  // Open at desktop so the sidebar "Demo session" button is reachable.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();
  const ta = page.getByPlaceholder(/Message/);
  await ta.focus(); // mount + focus; leave EMPTY (the reported case)

  // --- Desktop ---
  const d = await metrics(page);
  expect(d.taFs, `desktop font-size must match (ta=${d.taFs} mi=${d.miFs})`).toBe(d.miFs);
  expect(d.taLh, `desktop line-height must match (ta=${d.taLh} mi=${d.miLh})`).toBe(d.miLh);
  expect(d.taPad, `desktop padding must match (ta=${d.taPad} mi=${d.miPad})`).toBe(d.miPad);

  // --- Mobile (≤720px trips the media query; composer stays mounted) ---
  await page.setViewportSize({ width: 390, height: 844 });
  // Brief settle for any resize-driven effect (autosize, viewport var).
  await page.waitForTimeout(80);
  const m = await metrics(page);
  expect(m.taFs, `mobile font-size must match (ta=${m.taFs} mi=${m.miFs})`).toBe(m.miFs);
  expect(m.taLh, `mobile line-height must match (ta=${m.taLh} mi=${m.miLh})`).toBe(m.miLh);
  expect(m.taPad, `mobile padding must match (ta=${m.taPad} mi=${m.miPad})`).toBe(m.miPad);
  // And the mobile size is the iOS-safe 16px (not the 14px base) so focusing the
  // textarea still doesn't trigger auto-zoom on iOS Safari.
  expect(m.taFs, "mobile composer font-size must be iOS-safe (16px)").toBe("16px");
});
