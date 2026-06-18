import { expect, test } from "@playwright/test";

test("messages show timestamps, code blocks have a copy button, retry resends", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();

  // Relative timestamp on messages (sub-minute reads "just now"; older reads
  // "<n> ago" — formatting itself is unit-tested in tests/unit/time.test.ts).
  await expect(page.locator(".msg-time").first()).toContainText(/ago|just now/);

  // Server-rendered code block gets a copy affordance.
  await expect(page.locator(".code-copy").first()).toBeVisible();

  // Retry on the user message resends its text -> one more user message appears.
  const before = await page.locator(".msg.user").count();
  const userMsg = page.locator(".msg.user").first();
  await userMsg.hover();
  await userMsg.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator(".msg.user")).toHaveCount(before + 1, { timeout: 8000 });
});

test("assistant messages show the model beside the role", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();

  // The seeded assistant turn carries model {fake/dummy-think, variant high};
  // it resolves to the catalog display name ("Dummy Thinking") with the variant.
  const model = page.locator(".msg.assistant .msg-model").first();
  await expect(model).toBeVisible();
  await expect(model).toContainText(/Dummy Thinking|dummy-think/);
  await expect(model).toContainText("high");

  // User messages have no model label.
  await expect(page.locator(".msg.user .msg-model")).toHaveCount(0);
});
