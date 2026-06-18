import { expect, test } from "@playwright/test";

test("selecting a session puts it in the URL and deep-links on reload", async ({ page }) => {
  await page.goto("/");
  await page.locator(".tree-node", { hasText: "Demo session" }).first().click();
  await expect(page).toHaveURL(/[?&]session=demo/);

  // A fresh load of that URL opens the same session.
  await page.goto("/?session=demo");
  await expect(page.locator(".main-title")).toContainText("Demo session", { timeout: 8000 });
});

test("opening a session temporarily reveals its hidden parent path", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Demo session/ })).toBeVisible();
  // Demo (default "filtered") hides its idle subsession.
  await expect(page.locator(".tree-node", { hasText: "Subagent: search" })).toHaveCount(0);

  // Deep-linking to the child auto-reveals the path (the parent isn't expanded),
  // so the child becomes visible via the temporary reveal.
  await page.goto("/?session=sub");
  await expect(page.locator(".tree-node", { hasText: "Subagent: search" })).toBeVisible({ timeout: 8000 });
});
