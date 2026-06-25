import { expect, test } from "@playwright/test";

// Safety-net for the ChatView navigator (one of the pieces a ChatView
// decomposition would extract). The demo session has two user turns, so on a
// desktop viewport the right-edge turn navigator renders; clicking a dot jumps
// to that turn. Locks the behaviour before extracting <ChatNavigator>.

test("desktop turn navigator shows a dot per turn and jumps on click", async ({ page }) => {
  await page.goto("/?session=demo");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 8000 });

  const nav = page.locator(".chat-nav");
  await expect(nav).toBeVisible();
  const dots = nav.locator(".chat-nav-dot");
  // demo has two user turns (m1, m3).
  expect(await dots.count()).toBeGreaterThanOrEqual(2);

  // Clicking the first dot jumps to (and marks active) the first user turn.
  await dots.first().click();
  await expect(dots.first()).toHaveAttribute("aria-current", "true", { timeout: 4000 });
});
