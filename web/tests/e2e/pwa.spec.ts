import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

test("PWA: manifest, icon and service worker are served and linked", async ({ page, baseURL }) => {
  await page.goto(projectUrl("/"));

  // The manifest is linked from the document head.
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute("href", "/manifest.webmanifest");
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#0d1117");

  // Manifest is reachable and declares an installable standalone app.
  const m = await page.request.get(`${baseURL}/manifest.webmanifest`);
  expect(m.ok()).toBeTruthy();
  expect(m.headers()["content-type"]).toContain("manifest");
  const manifest = await m.json();
  expect(manifest.name).toBe("VHSolara");
  expect(manifest.display).toBe("standalone");
  expect(manifest.icons.length).toBeGreaterThan(0);

  // Service worker + icon are served.
  const sw = await page.request.get(`${baseURL}/sw.js`);
  expect(sw.ok()).toBeTruthy();
  expect(sw.headers()["content-type"]).toContain("javascript");
  const icon = await page.request.get(`${baseURL}/icon.svg`);
  expect(icon.ok()).toBeTruthy();
  expect(icon.headers()["content-type"]).toContain("svg");
});

test("PWA: the service worker registers and controls the page", async ({ page }) => {
  await page.goto(projectUrl("/"));
  const ready = await page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return false;
    const reg = await navigator.serviceWorker.ready;
    return !!reg.active;
  });
  expect(ready).toBeTruthy();
});
