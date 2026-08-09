import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Diagnostic probe for "ui scaling no longer works" — exercises the SPA's
// applyScale() DOM effect in the STANDALONE fixture (SPA at /, fixture opts out
// of the host-shell fold). Establishes whether the SPA's own scale logic works
// standalone, independent of the host-shell embed / production service worker.
//
// applyScale (src/prefs.ts): on a NON-coarse pointer (desktop) it sets
// documentElement.style.zoom + the --ui-zoom CSS var (the visible scaling on
// desktop, where the viewport meta is ignored). The mobile/coarse branch
// (viewport meta) is already covered by tests/unit/prefs.test.ts against the real
// meta element; this spec covers the DESKTOP zoom branch end-to-end through the
// real hydrated signal + render-effect.

const UI_KEY = "vh.prefs.uiScale.v1";

async function openSession(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();
  await page.getByPlaceholder(/Message/).waitFor({ timeout: 15000 });
}

async function setScaleAndReload(page: import("@playwright/test").Page, scale: number): Promise<void> {
  await page.evaluate(
    ([k, v]) => localStorage.setItem(k, JSON.stringify({ v: 1, data: v })),
    [UI_KEY, scale] as [string, number],
  );
  await page.reload();
  await page.getByPlaceholder(/Message/).waitFor({ timeout: 15000 });
}

test("desktop pointer — applyScale sets documentElement.style.zoom + --ui-zoom from the hydrated pref", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openSession(page);

  await setScaleAndReload(page, 1.5);
  const zoom = await page.evaluate(() => document.documentElement.style.zoom);
  const uiZoom = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue("--ui-zoom").trim(),
  );
  expect(zoom, "desktop root.style.zoom must reflect uiScale=1.5").toBe("1.5");
  expect(uiZoom, "desktop --ui-zoom must reflect uiScale=1.5").toBe("1.5");

  // A different value is actually applied (not stuck at the prior value).
  await setScaleAndReload(page, 0.75);
  const zoom2 = await page.evaluate(() => document.documentElement.style.zoom);
  expect(zoom2, "desktop root.style.zoom must reflect uiScale=0.75").toBe("0.75");
});
