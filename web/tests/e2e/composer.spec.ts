import { expect, test } from "@playwright/test";

test("composer highlights mentions/paths/code and auto-grows then caps", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();
  const ta = page.getByPlaceholder(/Message/);

  await ta.fill("ping @build edit src/x.ts and run `go test`");
  await expect(page.locator(".composer-mirror .hl-mention")).toContainText("@build");
  await expect(page.locator(".composer-mirror .hl-path")).toContainText("src/x.ts");
  await expect(page.locator(".composer-mirror .hl-code")).toContainText("go test");

  // Auto-grow: more lines → taller textarea (until the cap).
  const oneLine = await ta.evaluate((e) => (e as HTMLTextAreaElement).clientHeight);
  await ta.fill(Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n"));
  await page.waitForTimeout(50);
  const many = await ta.evaluate((e) => (e as HTMLTextAreaElement).clientHeight);
  expect(many).toBeGreaterThan(oneLine);
  expect(many).toBeLessThanOrEqual(200);
});

test("composer markdown-highlights headings, bold, links and fenced code", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();
  await page
    .getByPlaceholder(/Message/)
    .fill("# Title\nMake it **bold** see [docs](http://x)\n```\ncode block\n```");
  const mirror = page.locator(".composer-mirror");
  await expect(mirror.locator(".hl-head")).toContainText("# Title");
  await expect(mirror.locator(".hl-strong")).toContainText("bold");
  await expect(mirror.locator(".hl-link")).toContainText("docs");
  await expect(mirror.locator(".hl-code").first()).toBeVisible();
});

test("composer shows a shell-mode rail for a leading !", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();
  await page.getByPlaceholder(/Message/).fill("!ls -la");
  await expect(page.locator(".composer-field.shell")).toBeVisible();
});

test("agent picker excludes subagents and hidden agents", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();
  await page.locator(".agent-select .vh-select-btn").click();
  const opts = page.locator(".vh-select-pop .vh-select-opt"); // popup is portaled to <body>
  await expect(opts).toHaveCount(2); // build + plan only
  await expect(opts).toHaveText(["@build", "@plan"]);
  // "general" is a subagent and "summarize" is hidden — neither should appear.
  await expect(page.locator(".vh-select-pop")).not.toContainText("general");
  await expect(page.locator(".vh-select-pop")).not.toContainText("summarize");
});
