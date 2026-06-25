import { expect, test } from "@playwright/test";

// Fixture-backed smoke tests. The fake OpenCode seeds a "demo" root session
// with a "Subagent: search" subsession, an assistant message with a
// markdown/code block and a completed tool call, and a working-tree diff.

test("session tree filters idle subsessions by default and expands to show them", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /Demo session/ })).toBeVisible();
  // Wait for the shared fixture to settle (no running sessions) so the tree
  // isn't re-sorting/auto-tidying under the click.
  await expect(page.locator(".tree-spinner")).toHaveCount(0, { timeout: 10000 });
  // Default is "filtered": the idle subsession is hidden behind a footer count.
  await expect(page.locator(".tree-node", { hasText: "Subagent: search" })).toHaveCount(0);
  await expect(page.locator(".tree-footer-idle")).toContainText("1 idle");
  // Cycling the parent's twisty (filtered -> expanded) reveals it. Retry the
  // click+check to tolerate any tree re-render under the shared fixture.
  const twisty = page.locator(".tree-row", { hasText: "Demo session" }).locator(".tree-twisty");
  await expect(async () => {
    await twisty.click();
    await expect(page.locator(".tree-node", { hasText: "Subagent: search" })).toBeVisible({ timeout: 800 });
  }).toPass({ timeout: 8000 });
});

test("opening a session renders server-highlighted markdown and tool parts", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();
  // Daemon-rendered code block (chroma classes survive sanitization).
  await expect(page.locator(".md pre.chroma").first()).toBeVisible();
  // The first .tool-name is the reasoning part's "Thinking"; the edit tool
  // renders with its friendly label "Edit File" — assert that one is present.
  await expect(page.locator(".tool-name", { hasText: "Edit File" }).first()).toBeVisible();
  // LSP diagnostics from the edit are surfaced (severity-1 error, file:line:col).
  await expect(page.locator(".tool-diag")).toContainText("undefined: parse");
  await expect(page.locator(".tool-diag-loc")).toContainText("[2:9]");
  // LaTeX is rendered client-side to native MathML (inline + display).
  await expect(page.locator(".md .katex-math math").first()).toBeVisible();
  await expect(page.locator("div.katex-math math")).toHaveCount(1); // the display $$…$$
});

test("Changes view renders a git diff", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await page.getByText("parser.go").click();
  await expect(page.locator(".vh-diff-add").first()).toBeVisible();
});

test("Changes view toggles between inline and split diff layouts", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Changes", exact: true }).click();
  await page.getByText("parser.go").click();
  await expect(page.locator(".vh-diff-add").first()).toBeVisible();
  // Default is inline (unified) — no split container.
  await expect(page.locator(".vh-diff-split")).toHaveCount(0);
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await expect(page.locator(".vh-diff-split").first()).toBeVisible();
  // Back to inline.
  await page.getByRole("button", { name: "Inline", exact: true }).click();
  await expect(page.locator(".vh-diff-split")).toHaveCount(0);
});

test("sending a prompt streams an assistant response", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Demo session/ }).click();
  await page.getByPlaceholder("Message…").fill("hello fixture");
  await page.keyboard.press("Enter");
  // The simulated stream completes with this text. (.first() — other specs may
  // have left a completed turn in the shared demo session.)
  await expect(page.getByText(/Done\. Updated/).first()).toBeVisible({ timeout: 8000 });
});
