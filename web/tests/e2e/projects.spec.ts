import { expect, test } from "@playwright/test";

test("project switcher adds a project and re-scopes the session tree", async ({ page }) => {
  await page.goto("/");
  // Default project shows the seeded demo sessions.
  await expect(page.locator(".tree-node", { hasText: "Demo session" })).toBeVisible();
  await expect(page.locator(".proj-name")).toContainText("Default");

  // Add a project via the switcher (DOM dialog → a directory path).
  await page.locator(".proj-current").click();
  await page.getByRole("button", { name: /Add project/ }).click();
  await page.locator(".vh-prompt-input").fill("/work/projectx");
  await page.locator(".vh-prompt .confirm-go").click();

  // The UI re-scopes: the switcher shows the new project and the tree shows ITS
  // sessions (fixture returns one synthetic session per directory), not demo's.
  await expect(page.locator(".proj-name")).toContainText("projectx", { timeout: 8000 });
  await expect(page.locator(".tree-node", { hasText: "Project: projectx" })).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".tree-node", { hasText: "Demo session" })).toHaveCount(0);

  // The workspace is encoded in the URL so the tab is self-describing (survives
  // reload, supports a per-tab workspace).
  await expect.poll(() => new URL(page.url()).searchParams.get("dir")).toBe("/work/projectx");
  await page.reload();
  await expect(page.locator(".tree-node", { hasText: "Project: projectx" })).toBeVisible({ timeout: 8000 });

  // Switching back to Default restores the demo sessions.
  await page.locator(".proj-current").click();
  await page.getByRole("button", { name: "Default project" }).click();
  await expect(page.locator(".tree-node", { hasText: "Demo session" })).toBeVisible({ timeout: 8000 });
});

test("project switcher offers OpenCode recents to pin", async ({ page }) => {
  await page.goto("/");
  await page.locator(".proj-current").click();

  // Recent section lists projects from OpenCode (GET /project), newest first.
  await expect(page.locator(".proj-section", { hasText: /Recent/ })).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".proj-item-name", { hasText: "alpha" })).toBeVisible();
  await expect(page.locator(".proj-item-name", { hasText: "beta" })).toBeVisible();
  // alpha is returned twice by OpenCode (same worktree, different ids) — the
  // recents list must dedupe by directory and show it exactly once.
  await expect(page.locator(".proj-item-name", { hasText: "alpha" })).toHaveCount(1);

  // Picking a recent pins it and re-scopes to that project.
  await page.locator(".proj-pick", { hasText: "alpha" }).click();
  await expect(page.locator(".proj-name")).toContainText("alpha", { timeout: 8000 });
});
