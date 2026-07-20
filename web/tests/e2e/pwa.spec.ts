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

test("PWA: raster icons, screenshots and protocol handler are declared and served", async ({ page, baseURL }) => {
  // Manifest is reachable and declares the new PWA-critical surfaces.
  const m = await page.request.get(`${baseURL}/manifest.webmanifest`);
  expect(m.ok()).toBeTruthy();
  const manifest = await m.json();

  // Four raster PNG icons (192/512, any/maskable) — clears Chrome's
  // "no square PNG icons" diagnostic. iOS apple-touch-icon also points here.
  const pngIcons = (manifest.icons || []).filter(
    (i: { type?: string; sizes?: string }) => i.type === "image/png",
  );
  expect(pngIcons.length).toBeGreaterThanOrEqual(4);
  const sizePurpose = new Set(pngIcons.map((i: { sizes?: string; purpose?: string }) => `${i.sizes}|${i.purpose}`));
  expect(sizePurpose.has("192x192|any")).toBeTruthy();
  expect(sizePurpose.has("512x512|any")).toBeTruthy();
  expect(sizePurpose.has("192x192|maskable")).toBeTruthy();
  expect(sizePurpose.has("512x512|maskable")).toBeTruthy();

  // The existing SVG entries are still declared (favicon + scalable maskable).
  const svgIcons = (manifest.icons || []).filter(
    (i: { type?: string }) => i.type === "image/svg+xml",
  );
  expect(svgIcons.length).toBe(2);

  // Each PNG icon is actually served as image/png (200) — guards against a
  // broken/clobbered asset on the deployed host. (A 404 at the deployed host
  // caused by nginx auth is out of scope; the assets themselves must exist.)
  for (const name of ["icon-192.png", "icon-512.png", "icon-maskable-192.png", "icon-maskable-512.png"]) {
    const r = await page.request.get(`${baseURL}/${name}`);
    expect(r.ok(), `${name} should be served`).toBeTruthy();
    expect(r.headers()["content-type"]).toContain("image/png");
  }

  // Screenshots: >=1 wide (desktop store tile) and >=1 with no form_factor
  // (mobile store tile) — clears Chrome's "no screenshots" diagnostics.
  const shots = manifest.screenshots || [];
  expect(shots.length).toBeGreaterThanOrEqual(2);
  const wide = shots.filter((s: { form_factor?: string }) => s.form_factor === "wide");
  const nonWide = shots.filter((s: { form_factor?: string }) => !s.form_factor);
  expect(wide.length).toBeGreaterThanOrEqual(1);
  expect(nonWide.length).toBeGreaterThanOrEqual(1);

  // Protocol handler: web+vhsolara is registered, with the %s launch placeholder.
  const handlers = manifest.protocol_handlers || [];
  const vhs = handlers.find((h: { protocol?: string }) => h.protocol === "web+vhsolara");
  expect(vhs, "manifest must register the web+vhsolara protocol handler").toBeTruthy();
  expect(vhs.url).toContain("%s");
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
