import { expect, test } from "@playwright/test";

// The demo session has a completed `task` tool part linking to the "sub"
// subsession; clicking it should jump into that subsession's chat.
test("a task tool part jumps to its subsession", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();

  // The task tool part exposes an "open subsession" affordance.
  const jump = page.locator(".tool-jump").first();
  await expect(jump).toBeVisible();
  await jump.click();

  // We're now in the subsession: its message content is shown, and the header
  // reflects the subsession title.
  await expect(page.locator(".main-title")).toContainText("Subagent: search");
  await expect(page.getByText(/Searched 12 files/)).toBeVisible();

  // A subagent session cannot be prompted: the composer is replaced by a notice
  // with a jump back to the parent.
  await expect(page.locator(".composer-text")).toHaveCount(0);
  await expect(page.locator(".composer-child-note")).toContainText(/disabled for subagent/i);
  await page.locator(".composer-child-back").click();
  await expect(page.locator(".main-title")).toContainText("Demo session");
  // Back in the parent, the composer is available again.
  await expect(page.locator(".composer-text")).toBeVisible();
});
