import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Behaviour safety-net for the sync.ts decomposition (stream state-machine / URL
// deep-linking / activity reconciliation). These are the interactions a careless
// split would break silently and a build/typecheck can't catch — lock them down
// BEFORE refactoring so the split is verified, not hoped.

// App-like back discipline (see back-navigation.spec.ts + lib/backStack.ts):
// session selection UPDATES the URL via replaceState (deep-links/reload/sharing
// keep working) but creates NO history entries — back dismisses surfaces, it
// never revisits a prior session.
test("session selection updates the URL without history entries; back never revisits", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();
  await expect(page).toHaveURL(/[?&]session=demo/);
  await expect(page.locator(".main-title")).toContainText("Demo session");

  // Selecting a second session REPLACES the URL (no pushState entry).
  const lenAfterDemo = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: /Another root/ }).click();
  await expect(page).toHaveURL(/[?&]session=other/);
  await expect(page.locator(".main-title")).toContainText("Another root");
  expect(await page.evaluate(() => history.length)).toBe(lenAfterDemo);

  // With a surface open, back dismisses the surface — it does NOT walk back to
  // the demo selection (popstate no longer re-targets the session).
  await page.locator('button[aria-label="Settings"]').click();
  await expect(page.locator('div[role="dialog"][aria-label="Settings"]')).toBeVisible();
  await page.goBack();
  await expect(page.locator('div[role="dialog"][aria-label="Settings"]')).toBeHidden();
  await expect(page).toHaveURL(/[?&]session=other/);
  await expect(page.locator(".main-title")).toContainText("Another root");
});

test("switching sessions re-targets the message stream", async ({ page }) => {
  await page.goto(projectUrl("/?session=demo"));
  // demo has rendered content (its assistant turn ran tools).
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 8000 });
  const demoMsgs = await page.locator(".msg").count();
  expect(demoMsgs).toBeGreaterThan(0);
  // Confirm demo's seeded first-turn content (m1) is ACTUALLY rendered before
  // switching — otherwise the post-switch absence check below could pass
  // vacuously (e.g. if the m1 seed text drifted, the fixture didn't load, or a
  // prior spec left demo in an unexpected state). Bounded so a genuinely-broken
  // demo surface fails loudly here rather than as a false-green absence later.
  await expect(page.getByText("Refactor the parser and explain the change.")).toBeVisible({
    timeout: 8000,
  });

  // Switch to a different root — the transcript must re-target to that session
  // (not keep showing demo's messages).
  await page.getByRole("button", { name: /Another root/ }).click();
  await expect(page).toHaveURL(/[?&]session=other/);
  await expect(page.locator(".main-title")).toContainText("Another root");
  // Verify re-targeting by asserting demo's seeded first-turn content (m1) is
  // ABSENT — the canonical "you are no longer looking at demo" signal. This is
  // robust to cross-spec transcript accumulation: the serial e2e suite shares
  // one fixture backend, so prior specs (e.g. read-position.spec.ts) may leave
  // extra turns in demo OR seed turns into `other`. A count-based
  // `toHaveCount(0)` breaks when `other` itself is polluted (it legitimately
  // retains its own turns). But demo's static seed text (m1) can never appear
  // in `other`'s transcript, so its absence proves the stream re-targeted.
  // Marker literal mirrors pkg/fixtures/opencode.go:150 (demo m1 static seed) —
  // keep in sync if that seed text ever changes.
  await expect(page.getByText("Refactor the parser and explain the change.")).toHaveCount(0);
});

test("a prompt drives the session busy → idle (activity reconciliation)", async ({ page }) => {
  await page.goto(projectUrl("/"));
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
