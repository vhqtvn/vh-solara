import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

test("model picker dialog: search, badges, pick, then variant dropdown", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();

  await page.locator(".model-btn").click();
  const dialog = page.getByRole("dialog", { name: "Select model" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Dummy Thinking");
  await expect(dialog.locator(".b-reason").first()).toBeVisible(); // capability badge
  // Grouped rows sit under a provider header, so no per-row provider line.
  await expect(dialog.locator(".m-group-label", { hasText: "Fake LLM" })).toBeVisible();
  await expect(dialog.locator(".m-row .m-prov")).toHaveCount(0);

  // Search filters the list.
  await dialog.locator(".dialog-search").fill("thinking");
  await expect(dialog).toContainText("Dummy Thinking");
  await expect(dialog).not.toContainText("Dummy Model");

  // Pick it; dialog closes, the button reflects the choice, variant dropdown appears.
  await dialog.getByText("Dummy Thinking").click();
  await expect(page.getByRole("dialog", { name: "Select model" })).toHaveCount(0);
  await expect(page.locator(".model-btn-name")).toContainText("Dummy Thinking");

  const variant = page.locator(".variant-select");
  await expect(variant).toBeVisible();
  await variant.locator(".vh-select-btn").click();
  await page.getByRole("option", { name: "high" }).click(); // popup portaled to <body>
  await expect(variant.locator(".vh-select-label")).toHaveText("high");
});

test("selecting an agent switches the model to the agent's configured model", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();

  // Start on a specific model explicitly.
  await page.locator(".model-btn").click();
  const dialog = page.getByRole("dialog", { name: "Select model" });
  await dialog.getByText("Dummy Model", { exact: true }).click();
  await expect(page.locator(".model-btn-name")).toContainText("Dummy Model");

  // The `plan` agent is configured with dummy-think/high — switching to it
  // moves the composer's model + variant to match.
  const agentSel = page.locator(".agent-select");
  await agentSel.locator(".vh-select-btn").click();
  await page.getByRole("option", { name: "@build" }).click();
  await agentSel.locator(".vh-select-btn").click();
  await page.getByRole("option", { name: "@plan" }).click();
  await expect(page.locator(".model-btn-name")).toContainText("Dummy Thinking");
  await expect(page.locator(".variant-select .vh-select-label")).toHaveText("high");
});

test("layout has no horizontal overflow at Galaxy Fold folded width (280px)", async ({ page }) => {
  await page.setViewportSize({ width: 280, height: 653 });
  await page.goto(projectUrl("/"));
  // The sidebar collapses to a drawer; its toggle is shown.
  await expect(page.locator(".nav-toggle")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("theme selector switches palettes (light/dim/dark)", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Settings" }).click();
  const html = page.locator("html");
  const select = page.getByLabel("Theme"); // the custom-select button
  const pick = async (name: string) => {
    await select.click();
    await page.getByRole("option", { name, exact: true }).click();
  };

  await pick("Light");
  await expect(html).toHaveClass(/theme-light/);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe("rgb(255, 255, 255)");

  await pick("Dim");
  await expect(html).toHaveClass(/theme-dim/);
  await expect(html).not.toHaveClass(/theme-light/);

  await pick("Dark");
  await expect(html).toHaveClass(/theme-dark/);
});
