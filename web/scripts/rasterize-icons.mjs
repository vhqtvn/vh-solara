// Rasterize web/public/icon.svg and icon-maskable.svg to the four PNG icons
// Chrome's PWA manifest diagnostics expect:
//   icon-192.png, icon-512.png                 (purpose "any")
//   icon-maskable-192.png, icon-maskable-512.png (purpose "maskable")
//
// Uses Playwright's bundled Chromium (no extra native dependency). Output is
// written at the SVG's intrinsic geometry — 192x192 and 512x512 — with
// transparent corners (omitBackground) so the rounded-rect "any" variants keep
// their shape and the full-bleed "maskable" variants cover the safe zone.
//
// Re-run: node web/scripts/rasterize-icons.mjs
import { chromium } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(webRoot, "..", "public");

// (source SVG, output basename, edge size in px)
const targets = [
  ["icon.svg", "icon-192.png", 192],
  ["icon.svg", "icon-512.png", 512],
  ["icon-maskable.svg", "icon-maskable-192.png", 192],
  ["icon-maskable.svg", "icon-maskable-512.png", 512],
];

function sizedSvg(svg, size) {
  // Force the root <svg> to render at exactly size×size regardless of the
  // original viewBox; preserve the viewBox so the artwork scales correctly.
  return svg.replace(/<svg\b/, `<svg width="${size}" height="${size}"`);
}

const browser = await chromium.launch();
try {
  for (const [src, out, size] of targets) {
    const svg = readFileSync(path.join(publicDir, src), "utf8");
    const ctx = await browser.newContext({
      viewport: { width: size, height: size },
      deviceScaleFactor: 1,
    });
    const page = await ctx.newPage();
    await page.setContent(
      `<!doctype html><html><head><style>html,body{margin:0;padding:0;background:transparent}</style></head><body>${sizedSvg(svg, size)}</body></html>`,
      { waitUntil: "networkidle" },
    );
    const dest = path.join(publicDir, out);
    await page.screenshot({
      path: dest,
      clip: { x: 0, y: 0, width: size, height: size },
      omitBackground: true,
    });
    await ctx.close();
    console.log(`[rasterize] wrote ${path.relative(webRoot, dest)}`);
  }
} finally {
  await browser.close();
}
