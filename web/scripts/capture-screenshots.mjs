// Capture the two PWA store screenshots (wide + narrow) into web/public/screenshots/.
// The wide shot (form_factor:"wide") is the desktop store tile; the narrow shot
// (no form_factor) is the mobile store tile. Both must show a representative
// app state — session list + an open chat — never a blank/empty screen.
//
// Assumes the fixture web server is already running (set BASE). The companion
// capture-screenshots.sh builds the SPA, starts the fixture server, then runs
// this script. Re-run from a running fixture server with:
//   BASE=http://127.0.0.1:8099 node web/scripts/capture-screenshots.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const base = process.env.BASE || "http://127.0.0.1:8099";
// Default output is the tracked web/public/screenshots/ dir so the materialize
// step copies the PNGs into pkg/web/dist/. Override OUT for a throwaway run.
const out = process.env.OUT || path.resolve(webRoot, "..", "public", "screenshots");
mkdirSync(out, { recursive: true });

const wait = (p, ms) => p.waitForTimeout(ms);

// Open the demo project, click a representative session, and wait for the chat
// to populate. Mirrors the proven flow from scripts/shots.mjs.
async function captureSessionAndView(viewport, dest) {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport });
    const page = await ctx.newPage();
    await page.goto(base);
    await wait(page, 700);
    // Open a real session so the chat surface is populated (not the empty state).
    await page.getByRole("button", { name: /Demo session/ }).first().click().catch(() => {});
    await wait(page, 1100);
    await page.screenshot({ path: dest, fullPage: false });
    await ctx.close();
    console.log(`[capture] wrote ${path.relative(webRoot, dest)} (${viewport.width}x${viewport.height})`);
  } finally {
    await browser.close();
  }
}

await captureSessionAndView({ width: 1920, height: 1080 }, path.join(out, "wide.png"));
await captureSessionAndView({ width: 390, height: 844 }, path.join(out, "narrow.png"));

console.log(`[capture] screenshots written to ${path.relative(webRoot, out)}`);
