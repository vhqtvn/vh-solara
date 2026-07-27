import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Behavioral-closure e2e for MermaidViewer — the inline diagram + the
// full-viewport overlay (Solid <Portal> to <body>) with copy/download/expand,
// Close/Escape, focus management, body scroll-lock, and the hardware/browser
// Back integration (pushState on open, popstate closes, explicit Close consumes
// the entry via history.back).
//
// The fake OpenCode seeds a dedicated "mermaid" session
// (pkg/fixtures/opencode.go) whose assistant turn carries a ```mermaid fence.
// The settled markdown path runs splitMermaid client-side → MermaidViewer → the
// lazy mermaid lib renders a real SVG in the (real Chromium) browser.

// NOTE: the sidebar also renders an "Expand" button per session ROW (subtree
// expand/collapse), so the diagram's expand must be scoped to the mermaid block.
const inlineExpand = (page: import("@playwright/test").Page) =>
  page.locator("[data-mermaid='inline'] button[title='Expand diagram']").first();

async function openMermaidSession(page: import("@playwright/test").Page) {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Mermaid diagrams/ }).click();
  // Wait for the inline diagram SVG (lazy mermaid lib renders client-side).
  await page
    .locator("[data-mermaid='inline'] [data-mermaid-diagram] svg")
    .first()
    .waitFor({ state: "visible", timeout: 30000 });
}

test("inline mermaid renders; expand opens a full-viewport overlay with background scroll locked", async ({ page }) => {
  await openMermaidSession(page);
  // Inline diagram SVG is present.
  await expect(
    page.locator("[data-mermaid='inline'] [data-mermaid-diagram] svg").first(),
  ).toBeVisible();

  // No overlay before expand.
  await expect(page.locator("[data-mermaid='overlay']")).toHaveCount(0);

  // Expand opens the overlay (scoped to the diagram's expand button).
  await inlineExpand(page).click();
  const overlay = page.locator("[data-mermaid='overlay']");
  await expect(overlay).toBeVisible({ timeout: 10000 });
  // The overlay is a dialog covering the viewport.
  await expect(overlay).toHaveAttribute("role", "dialog");
  await expect(overlay).toHaveAttribute("aria-modal", "true");
  // Exactly one overlay.
  await expect(page.locator("[data-mermaid='overlay']")).toHaveCount(1);

  // Body scroll is locked while the overlay is open.
  const bodyOverflow = await page.evaluate(() => document.body.style.overflow);
  expect(bodyOverflow).toBe("hidden");

  // The overlay's diagram svg is present (snapshot rendered at open time).
  await expect(overlay.locator("[data-mermaid-diagram] svg")).toBeVisible();
});

test("Close returns focus to the originating Expand button", async ({ page }) => {
  await openMermaidSession(page);
  const expand = inlineExpand(page);
  await expand.click();
  const overlay = page.locator("[data-mermaid='overlay']");
  await expect(overlay).toBeVisible({ timeout: 10000 });

  // Close the overlay (scoped to the overlay's close button).
  await overlay.getByRole("button", { name: "Close" }).click();
  await expect(overlay).toHaveCount(0);

  // Body scroll is released.
  await expect.poll(async () => page.evaluate(() => document.body.style.overflow)).toBe("");
  // Focus returned to the originating Expand button.
  await expect(expand).toBeFocused();
});

test("hardware/browser Back closes the overlay (popstate) without leaving the session", async ({ page }) => {
  await openMermaidSession(page);
  // Snapshot the selected session URL so we can prove Back does not corrupt it.
  const beforeUrl = page.url();

  await inlineExpand(page).click();
  const overlay = page.locator("[data-mermaid='overlay']");
  await expect(overlay).toBeVisible({ timeout: 10000 });

  // Hardware/browser Back pops the marker entry → popstate → overlay closes.
  await page.goBack();
  await expect(overlay).toHaveCount(0);

  // The marker entry is URL-transparent: the session query string is unchanged
  // (the host re-selected the SAME session on popstate). We assert the inline
  // diagram (the mermaid session's content) is still present.
  await expect(
    page.locator("[data-mermaid='inline'] [data-mermaid-diagram] svg").first(),
  ).toBeVisible();
  expect(page.url()).toBe(beforeUrl);
});
