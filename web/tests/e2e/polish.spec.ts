import { expect, test } from "@playwright/test";

test("messages show timestamps, code blocks have a copy button, retry resends", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();

  // Relative timestamp on messages.
  await expect(page.locator(".msg-time").first()).toContainText("ago");

  // Server-rendered code block gets a copy affordance.
  await expect(page.locator(".code-copy").first()).toBeVisible();

  // Retry on the user message resends its text -> one more user message appears.
  const before = await page.locator(".msg.user").count();
  const userMsg = page.locator(".msg.user").first();
  await userMsg.hover();
  await userMsg.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator(".msg.user")).toHaveCount(before + 1, { timeout: 8000 });
});
