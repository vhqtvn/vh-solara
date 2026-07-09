import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Clicking a path in chat must actually OPEN the file inside the standalone
// code-viewer iframe — not merely reveal the dock. The dock/overlay becomes
// visible regardless of whether the postMessage open command ever crosses the
// frame boundary, so asserting only on .code-dock visibility hides a whole
// class of bug (the parent <-> iframe ready handshake losing the open command).
//
// This asserts the file is open INSIDE the iframe: the viewer renders a
// .code-tab-name per open file (basename of the path). Runs on chromium AND
// firefox — the ready-handshake ordering bug it guards was firefox-only
// (firefox processes the child's vh-code:ready before the iframe `load` event,
// so the parent flushed through a still-null module-level `frame` reference;
// chromium happened to order load-before-message and masked it). See
// web/playwright.config.ts for the scoped firefox project that runs ONLY this
// file on a second engine.
test("clicking a file path opens it inside the code viewer iframe", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();
  // The serial e2e suite appends many turns to this shared Demo session
  // (read-position / scroll-follow probes), which window the transcript's
  // original messages — the ones carrying the clickable .filepath — out of the
  // rendered DOM when the view sits at the tail. Scroll to the top to surface
  // them before looking for the path (position-independent across the suite).
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => (el.scrollTop = 0));
  await page.locator(".filepath", { hasText: "src/parser.go" }).first().click();
  // Docked (desktop) / overlay (mobile) surface reveals — happens independent
  // of the open message being delivered, so this alone is insufficient.
  await expect(page.locator(".code-dock.dock, .code-dock.overlay")).toBeVisible({ timeout: 6000 });

  // The real assertion: the file opened inside the same-origin code iframe.
  // "parser.go" is the basename of src/parser.go. Without the ready-handshake
  // fix this never appears on firefox (the open message is lost crossing the
  // frame boundary and the viewer stays on its "Select a file" empty state).
  const code = page.frameLocator('iframe[title="Code"]');
  await expect(code.locator(".code-tab-name", { hasText: "parser.go" })).toBeVisible({ timeout: 8000 });

  // Steady-state regression: after the first open settles, a SECOND open must
  // still deliver. On Firefox the child's vh-code:ready (onMount, during doc
  // load) is processed before the iframe `load` event; bindCodeFrame used to
  // reset ready=false on load, clobbering the just-set flag — so every
  // subsequent open was queued and never flushed (the child doesn't re-post
  // ready without a reload). Close the tab, then re-open the same file: the
  // tab must reappear (proves the second open message crossed the boundary).
  await code.locator(".code-tab-close").first().click();
  await expect(code.locator(".code-tab-name", { hasText: "parser.go" })).toBeHidden({ timeout: 4000 });
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => (el.scrollTop = 0));
  await page.locator(".filepath", { hasText: "src/parser.go" }).first().click();
  await expect(code.locator(".code-tab-name", { hasText: "parser.go" })).toBeVisible({ timeout: 8000 });
});
