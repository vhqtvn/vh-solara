import { expect, test } from "@playwright/test";

test("plugins tab shows the full plugin id, not a truncated trailing '…'", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Servers" }).click();
  await page.getByRole("tab", { name: "Plugins" }).click();

  const longName = page
    .locator(".m-name-full")
    .filter({ hasText: "github:acme/opencode-plugin-very-long-name@v1.2.3" });
  await expect(longName).toBeVisible();

  // The meaningful tail (version) is present and, crucially, not clipped: the id
  // wraps, so there's no horizontal overflow. An ellipsis-truncated element would
  // have scrollWidth > clientWidth.
  await expect(longName).toContainText("@v1.2.3");
  const overflow = await longName.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
