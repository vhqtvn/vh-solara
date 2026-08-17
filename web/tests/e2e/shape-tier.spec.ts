// Phase 3 S2a — height-tier responsiveness (the short-pane defense).
//
// The fixture serves the SPA standalone (zoom = 1, `.app` height = viewport
// height via --app-h), so page.setViewportSize drives the tier signal
// end-to-end: RO on `.app` -> visual-px classification -> `data-h-tier`
// attribute -> the CSS defenses. Asserts the attribute AND the computed
// defenses (the honest seam): hero hidden, composer cap, bar nowrap, tiny
// header slim — plus the normal-viewport no-change case, the live hysteresis
// band, and the persisted kill-switch.
import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

test("short/tiny tiers drive the vertical-budget defenses; normal changes nothing", async ({ page }) => {
  // Normal height (640 > 520+16): no defenses, hero visible.
  await page.setViewportSize({ width: 900, height: 640 });
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Create session" }).click();
  await expect(page.locator(".chat-hero")).toBeVisible();
  await expect(page.locator(".app")).toHaveAttribute("data-h-tier", "normal");

  // Short (480 visual px): hero yields its vertical budget, composer capped,
  // composer bar pinned to one row.
  await page.setViewportSize({ width: 900, height: 480 });
  await expect(page.locator(".app")).toHaveAttribute("data-h-tier", "short");
  await expect(page.locator(".chat-hero")).toBeHidden(); // defense a
  await expect(page.locator(".composer-text")).toHaveCSS("max-height", "110px"); // defense c
  await expect(page.locator(".composer-bar")).toHaveCSS("flex-wrap", "nowrap"); // defense d
  await expect(page.locator(".composer-bar")).toHaveCSS("overflow-x", "auto");
  // Defense b (status-row compress) targets .chat-status, which only renders
  // while working / with open todos (ChatTasksStatus) — not in an idle draft.
  // Its CSS is gated on the same attribute asserted above; not e2e-probed.

  // Tiny (380 visual px): tighter composer cap, slimmer header, draft
  // min-height restored so the cap actually binds (min beats max in CSS).
  await page.setViewportSize({ width: 900, height: 380 });
  await expect(page.locator(".app")).toHaveAttribute("data-h-tier", "tiny");
  await expect(page.locator(".composer-text")).toHaveCSS("max-height", "80px"); // defense c
  await expect(page.locator(".chat.draft .composer-text")).toHaveCSS("min-height", "44px");
  await expect(page.locator(".main-head")).toHaveCSS("padding-top", "4px"); // defense e (tiny only)

  // Back to normal: every defense relaxes, the hero returns.
  await page.setViewportSize({ width: 900, height: 640 });
  await expect(page.locator(".app")).toHaveAttribute("data-h-tier", "normal");
  await expect(page.locator(".chat-hero")).toBeVisible();
  await expect(page.locator(".composer-text")).toHaveCSS("max-height", "200px");
  await expect(page.locator(".composer-bar")).toHaveCSS("flex-wrap", "wrap");
});

test("hysteresis at the live boundary: short holds at 535 and is left at 536", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 480 });
  await page.goto(projectUrl("/"));
  await expect(page.locator(".app")).toHaveAttribute("data-h-tier", "short");
  // Grow into the buffer band: entering is immediate but leaving needs +16px.
  await page.setViewportSize({ width: 900, height: 535 });
  await expect(page.locator(".app")).toHaveAttribute("data-h-tier", "short"); // held
  await page.setViewportSize({ width: 900, height: 536 });
  await expect(page.locator(".app")).toHaveAttribute("data-h-tier", "normal"); // left
});

test("kill-switch: vh.prefs.shapeTier.v1 = \"off\" disables the tier signal entirely", async ({ page }) => {
  await page.addInitScript(() =>
    localStorage.setItem("vh.prefs.shapeTier.v1", JSON.stringify({ v: 1, data: "off" })),
  );
  await page.setViewportSize({ width: 900, height: 480 }); // would be "short"
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: "Create session" }).click();
  // No attribute is ever set — and the hero (a short-pane defense target)
  // stays visible: the whole feature is inert.
  await expect(page.locator(".chat-hero")).toBeVisible();
  await expect(page.locator(".app")).not.toHaveAttribute("data-h-tier", "short");
  await expect(page.locator(".app[data-h-tier]")).toHaveCount(0);
});
