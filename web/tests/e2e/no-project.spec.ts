import { expect, test } from "@playwright/test";

// vh-solara runs as a daemon whose cwd is NOT a meaningful project, so with no
// project pinned the app must NOT bridge cwd: it shows a no-project empty state
// (Select a project message + CTA) that opens the switcher, and selecting a
// project lands in the real session view. The default `{ page }` fixture gives
// a fresh isolated context (no localStorage, no ?dir=) → no project on load.

test("no project selected shows the empty state and the CTA opens the switcher", async ({ page }) => {
  await page.goto("/");
  // No project: the empty state invites the user to pick one (NOT the cwd
  // bridge). The SessionTree is hidden (Sidebar gates on projectDir).
  await expect(page.locator(".empty", { hasText: "Select a project" })).toBeVisible();
  await expect(page.locator(".empty-cta", { hasText: "Select project" })).toBeVisible();
  await expect(page.locator(".tree-node")).toHaveCount(0);

  // The sidebar switcher trigger reads "Select project" and stays reachable.
  await expect(page.locator(".proj-name")).toContainText("Select project");

  // The empty-state CTA opens the SAME global switcher dialog as the sidebar
  // trigger (projSwitcherOpen in ui.ts), so either entry point drives one dialog.
  await page.locator(".empty-cta", { hasText: "Select project" }).click();
  await expect(page.getByRole("dialog", { name: "Switch project" })).toBeVisible();

  // Selecting a recent lands in the real project view: the switcher trigger now
  // names the project and the session tree renders its synthetic session.
  await page.locator(".proj-pick", { hasText: "alpha" }).click();
  await expect(page.locator(".proj-name")).toContainText("alpha", { timeout: 8000 });
  // The no-PROJECT empty state is gone (the no-session EmptyState ALSO uses
  // .empty, so scope by its distinctive text rather than asserting count 0 on
  // the bare .empty class).
  await expect(page.locator(".empty", { hasText: "Select a project" })).toHaveCount(0);
  await expect(page.locator(".tree-node", { hasText: "Project: alpha" })).toBeVisible({ timeout: 8000 });
});

test("the sidebar switcher trigger also opens the dialog from the no-project state", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".empty", { hasText: "Select a project" })).toBeVisible();

  // The sidebar trigger and the empty-state CTA share one global open signal, so
  // both entry points are equivalent.
  await page.locator(".proj-current").click();
  await expect(page.getByRole("dialog", { name: "Switch project" })).toBeVisible();
  // Dismiss without selecting — we stay on the no-project state. Arm first: the
  // dismiss directive arms its Escape listener on a setTimeout(0) AFTER mount, so
  // pressing Escape in the next step can race ahead of arming (projects.spec.ts
  // hits the same with its armDismiss helper). Yield one turn to let it attach.
  await page.evaluate(() => new Promise<void>((r) => setTimeout(r, 0)));
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "Switch project" })).toHaveCount(0);
  await expect(page.locator(".empty", { hasText: "Select a project" })).toBeVisible();
});
