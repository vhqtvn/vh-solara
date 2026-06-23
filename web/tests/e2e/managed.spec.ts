import { expect, test } from "@playwright/test";

// A repo-declared managed project (.vh-solara/project.jsonc) is discovered on
// open and BLOCKED behind a trust gate: the exact declared commands are shown
// before anything runs, and only after the operator approves does the daemon
// start the processes + register their views. This spec drives that gate end to
// end against the fixture server (which seeds a managed project under its state
// dir): review → approve → process ready → controls → logs. The proxy/prefix
// contract is covered by the Go TestManagedHTTP_TrustGateThenProxy.

const procRow = (page: import("@playwright/test").Page) => page.locator(".managed-proc").filter({ hasText: "demo" });
const status = (page: import("@playwright/test").Page) => procRow(page).locator(".managed-status");

test("a repo-declared project is gated, then its processes run after approval", async ({ page }) => {
  await page.goto("/");

  // The trust-review card auto-opens and shows the EXACT declared command before
  // any of it runs (display-before-run).
  const panel = page.locator(".managed-panel");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".managed-trust")).toBeVisible();
  await expect(panel.locator(".managed-decl-id").first()).toHaveText("demo");
  await expect(panel.locator(".managed-cmd").first()).toContainText("sleep 999");

  // Approve the config — the daemon starts the declared process + registers its view.
  await panel.getByRole("button", { name: /Trust & run/ }).click();

  // The process becomes ready (default-settle readiness) and surfaces with controls.
  await expect(procRow(page)).toBeVisible();
  await expect(status(page)).toHaveText("ready", { timeout: 15000 });

  // Stop, then restart from the controls.
  await procRow(page).getByRole("button", { name: "Stop" }).click();
  await expect(status(page)).toHaveText("stopped", { timeout: 10000 });
  await procRow(page).getByRole("button", { name: "Start" }).click();
  await expect(status(page)).toHaveText("ready", { timeout: 15000 });

  // Expand a row to see command + pid detail.
  await procRow(page).locator(".managed-proc-toggle").click();
  await expect(procRow(page).locator(".managed-proc-detail .managed-cmd")).toContainText("sleep 999");

  // Tailed logs are fetched on demand.
  await procRow(page).getByRole("button", { name: "Logs" }).click();
  await expect(procRow(page).locator(".managed-log")).toBeVisible();
});
