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

