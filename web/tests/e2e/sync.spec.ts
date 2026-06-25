import { expect, test } from "@playwright/test";

// Behaviour safety-net for the sync.ts decomposition (stream state-machine / URL
// deep-linking / activity reconciliation). These are the interactions a careless
// split would break silently and a build/typecheck can't catch — lock them down
// BEFORE refactoring so the split is verified, not hoped.

test("back/forward navigates session selection (pushState + popstate)", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();
  await expect(page).toHaveURL(/[?&]session=demo/);
  await expect(page.locator(".main-title")).toContainText("Demo session");

  // Selecting a second session pushes a history entry.
  await page.getByRole("button", { name: /Another root/ }).click();
  await expect(page).toHaveURL(/[?&]session=other/);
  await expect(page.locator(".main-title")).toContainText("Another root");

  // Back returns to the first selection (popstate drives selection, not a reload).
  await page.goBack();
  await expect(page).toHaveURL(/[?&]session=demo/);
  await expect(page.locator(".main-title")).toContainText("Demo session");

  // Forward re-advances.
  await page.goForward();
  await expect(page).toHaveURL(/[?&]session=other/);
  await expect(page.locator(".main-title")).toContainText("Another root");
});

test("switching sessions re-targets the message stream", async ({ page }) => {
  await page.goto("/?session=demo");
  // demo has rendered content (its assistant turn ran tools).
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 8000 });
  const demoMsgs = await page.locator(".msg").count();
  expect(demoMsgs).toBeGreaterThan(0);

  // Switch to a different root — the transcript must re-target to that session
  // (not keep showing demo's messages).
  await page.getByRole("button", { name: /Another root/ }).click();
  await expect(page).toHaveURL(/[?&]session=other/);
  await expect(page.locator(".main-title")).toContainText("Another root");
  // "other" has no messages → its own transcript state, not demo's turns.
  await expect(page.getByText("Done. Updated").first()).toHaveCount(0);
});

test("a prompt drives the session busy → idle (activity reconciliation)", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();
  await page.getByPlaceholder("Message…").fill("hello fixture");
  await page.keyboard.press("Enter");

  // While the streamed turn runs the session is busy → the "Working…" indicator
  // shows; once it settles (idle) the indicator clears. This is the activity
  // reconciliation the stream state-machine owns.
  await expect(page.locator(".working")).toBeVisible({ timeout: 8000 });
  await expect(page.getByText(/Done\. Updated/).first()).toBeVisible({ timeout: 12000 });
  await expect(page.locator(".working")).toHaveCount(0, { timeout: 12000 });
});
