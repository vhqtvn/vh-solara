import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

test("selecting a session puts it in the URL and deep-links on reload", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.locator(".tree-node", { hasText: "Demo session" }).first().click();
  await expect(page).toHaveURL(/[?&]session=demo/);

  // A fresh load of that URL opens the same session.
  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".main-title")).toContainText("Demo session", { timeout: 8000 });
});

// PINNED to ?tree=1: this test exercises the proj=1 "temp" display-state
// auto-reveal (deep-linking to a child auto-reveals its hidden parent path).
// tree=2 has no client-side path-reveal — the server-owned frontier snapshot
// ships roots only, and there is no temporary display state. This is OLD-path-
// only behavior slated for deletion in Phase 3 Step C (alongside reduce.ts /
// orphans.ts / the proj=1 SessionTree body).
test("opening a session temporarily reveals its hidden parent path", async ({ page }) => {
  await page.goto(projectUrl("/?tree=1"));
  await expect(page.getByRole("button", { name: /Demo session/ })).toBeVisible();
  // Demo (default "filtered") hides its idle subsession.
  await expect(page.locator(".tree-node", { hasText: "Subagent: search" })).toHaveCount(0);

  // Deep-linking to the child auto-reveals the path (the parent isn't expanded),
  // so the child becomes visible via the temporary reveal.
  await page.goto(projectUrl("/?session=sub&tree=1"));
  await expect(page.locator(".tree-node", { hasText: "Subagent: search" })).toBeVisible({ timeout: 8000 });
});
