import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// The Preferences editor writes the project's .vh-solara/preferences.local.jsonc
// via /vh/project-settings. We intercept that endpoint so the test owns the data
// and never writes the repo's real file; /vh/render (the confirm diff) hits the
// real fixture daemon.
test("Preferences: agent-styles row edits, previews a diff, and saves", async ({ page }) => {
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
      committed = body;
      await route.fulfill({ json: { ok: true } });
    }
  });

  await page.goto(projectUrl("/"));
  // Reach the editor via the settings gear beside the project switcher. The gear
  // opens a project-settings dropdown (Preferences / Reload project); open it,
  // then pick the Preferences entry.
  await page.locator(".proj-settings").click();
  await page.getByRole("menuitem", { name: "Preferences" }).click();

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
  expect(committed.agentStyles.build.label).toBe("SUP");
  expect(committed.agentStyles.build.color).toBe("warn");
  // The combined payload always carries nameReplacements (possibly empty).
  expect(Array.isArray(committed.nameReplacements)).toBe(true);
});

test("Preferences: session-names editor adds a rule and previews the transform", async ({ page }) => {
  let committed: any = null;
  await page.route("**/vh/project-settings*", async (route) => {
    const req = route.request();
    if (req.url().includes("/project-settings/watch")) return route.continue();
    if (req.method() === "GET") {
      await route.fulfill({ json: {} });
      return;
    }
    const body = JSON.parse(req.postData() || "{}");
    if (body.dryRun) {
      await route.fulfill({
        json: { old: `{}`, new: JSON.stringify({ nameReplacements: body.nameReplacements }, null, 2) },
      });
    } else {
      committed = body;
      await route.fulfill({ json: { ok: true } });
    }
  });

  await page.goto(projectUrl("/"));
  await page.locator(".proj-settings").click();
  await page.getByRole("menuitem", { name: "Preferences" }).click();

  // The Session names section is the first <section>. Add a rule.
  await page.getByRole("button", { name: "Add rule" }).click();

  // Fill the pattern and replacement inputs (first row). Pattern is regex, so
  // brackets must be escaped to match literally.
  const pattern = page.locator('input[placeholder*="IMPORTANT"]');
  const replacement = page.locator('input[placeholder="❗"]');
  await pattern.first().fill("\\[\\[IMPORTANT\\]\\]");
  await replacement.first().fill("❗");

  // Edit the sample title and check the preview transforms.
  const sample = page.locator("#pref-name-sample");
  await sample.fill("[[IMPORTANT]] release");
  await expect(page.locator("#pref-name-sample ~ strong")).toContainText("❗ release");

  // Save → confirm → commit.
  await page.getByRole("button", { name: "Save…" }).click();
  const modal = page.locator(".agents-modal");
  await expect(modal).toBeVisible();
  await modal.getByRole("button", { name: "Save to file" }).click();
  await expect(modal).toHaveCount(0);

  // The committed payload carries the rule.
  expect(committed.nameReplacements).toHaveLength(1);
  expect(committed.nameReplacements[0].pattern).toBe("\\[\\[IMPORTANT\\]\\]");
  expect(committed.nameReplacements[0].replacement).toBe("❗");
});
