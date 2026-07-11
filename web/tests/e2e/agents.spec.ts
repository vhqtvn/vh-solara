import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// The agent-styles editor reads/writes the project's .vh-solara/project.jsonc via
// /vh/project-settings. We intercept that endpoint so the test owns the data and
// never writes the repo's real file; /vh/render (the confirm diff) hits the real
// fixture daemon.
test("agent-styles editor edits a row, previews a diff, and saves", async ({ page }) => {
  let committed: any = null;
  await page.route("**/vh/project-settings*", async (route) => {
    const req = route.request();
    if (req.url().includes("/project-settings/watch")) return route.continue(); // real SSE
    if (req.method() === "GET") {
      await route.fulfill({ json: { agentStyles: { build: { label: "BLD", color: "warn", style: "solid" } } } });
      return;
    }
    // PUT/POST: dryRun returns a before/after pair; a real save returns ok.
    const body = JSON.parse(req.postData() || "{}");
    if (body.dryRun) {
      await route.fulfill({
        json: { old: `{\n  "agentStyles": {}\n}\n`, new: `{\n  "agentStyles": ${JSON.stringify(body.agentStyles, null, 2)}\n}\n` },
      });
    } else {
      committed = body.agentStyles;
      await route.fulfill({ json: { ok: true } });
    }
  });

  await page.goto(projectUrl("/"));
  // Reach the editor via the settings gear beside the project switcher. The gear
  // now opens a project-settings dropdown (Agent styles / Reload project); open
  // it, then pick the Agent-styles entry.
  await page.locator(".proj-settings").click();
  await page.getByRole("menuitem", { name: "Agent styles" }).click();

  // The @build row is seeded from the (mocked) file.
  const buildRow = page.locator(".agents-row", { hasText: "@build" });
  await expect(buildRow).toBeVisible();
  const label = buildRow.locator(".agents-label");
  await expect(label).toHaveValue("BLD");

  // Edit the label; the live preview chip follows.
  await label.fill("SUP");
  await expect(buildRow.locator(".msg-agent.styled")).toHaveText("SUP");

  // Save… opens the confirm diff.
  await page.getByRole("button", { name: "Save…" }).click();
  const modal = page.locator(".agents-modal");
  await expect(modal).toBeVisible();
  await expect(modal.locator(".agents-diff")).not.toBeEmpty();

  // Confirm writes; the editor reports success and the payload carried our edit.
  await modal.getByRole("button", { name: "Save to file" }).click();
  await expect(modal).toHaveCount(0);
  await expect(page.locator(".agents-msg")).toContainText("Saved");
  expect(committed.build.label).toBe("SUP");
  expect(committed.build.color).toBe("warn");
});
