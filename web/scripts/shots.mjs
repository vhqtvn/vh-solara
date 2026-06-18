// Screenshots of the new surfaces against a running fixture server (BASE).
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const base = process.env.BASE || "http://127.0.0.1:8099";
const out = process.env.OUT || "/tmp/vhshots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const wait = (p, ms) => p.waitForTimeout(ms);

// Unfolded
{
  const ctx = await browser.newContext({ viewport: { width: 860, height: 920 } });
  const page = await ctx.newPage();
  await page.goto(base);
  await wait(page, 600);
  await page.screenshot({ path: `${out}/n0-empty.png` }); // empty state
  await page.getByRole("button", { name: /Demo session/ }).click();
  await wait(page, 900);
  await page
    .getByPlaceholder(/Message/)
    .fill(
      "# Refactor plan\n@build please make it **fast**: edit src/parser.go and run `go test ./...`\n- step one\n- see [docs](http://x)\n```go\nfunc tokenize(s string) {}\n```",
    );
  await wait(page, 200);
  await page.screenshot({ path: `${out}/n1-chat-composer.png` }); // rich composer (highlight + auto-grow)

  await page.getByRole("button", { name: "Settings" }).click();
  await wait(page, 300);
  await page.screenshot({ path: `${out}/n2a-settings-appearance.png` });
  await page.getByRole("dialog", { name: "Settings" }).getByRole("button", { name: "Servers" }).click();
  await wait(page, 400);
  await page.screenshot({ path: `${out}/n2b-settings-servers.png` });
  await page.keyboard.press("Escape");

  await page.locator(".filepath", { hasText: "src/parser.go" }).first().click();
  await wait(page, 500);
  await page.screenshot({ path: `${out}/n3-fileviewer.png` });
  await page.keyboard.press("Escape");

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await wait(page, 500);
  await page.getByText("parser.go").click();
  await wait(page, 400);
  await page.screenshot({ path: `${out}/n4-git-diff.png` });
  await ctx.close();
}

// Folded (Galaxy Fold cover)
{
  const ctx = await browser.newContext({ viewport: { width: 280, height: 653 } });
  const page = await ctx.newPage();
  await page.goto(base);
  await page.getByRole("button", { name: /Demo session/ }).click().catch(() => {});
  await wait(page, 600);
  await page.locator(".model-btn").click().catch(() => {});
  await wait(page, 300);
  await page.screenshot({ path: `${out}/n5-folded-modelpicker.png` });
  await ctx.close();
}

await browser.close();
console.log("shots written to", out);
