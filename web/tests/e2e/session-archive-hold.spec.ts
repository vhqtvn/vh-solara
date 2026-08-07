import { type Page, expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Real-browser e2e for the Archive menu button's tap-vs-hold wiring. The jsdom
// unit test (web/tests/unit/SessionContextMenuArchiveHold.test.tsx) drives a
// mocked clock; THIS spec exercises the REAL pointerdown→click gesture in
// Chromium through the REAL classifyHold threshold (web/src/lib/copyHold.ts,
// HOLD_THRESHOLD_MS = 450):
//   - normal click (tap) → recoverable Archive confirm (.dialog.confirm, NO .danger)
//   - long-hold click     → irreversible  Delete confirm (.dialog.confirm.danger)
//
// The standalone Delete menu item was removed; a long-press on Archive is the
// ONLY delete entry. The serial e2e suite shares ONE mutable fixture backend
// (pkg/fixtures/opencode.go), so every confirm opened here is CANCELLED — never
// confirmed — so the shared session pool stays clean for downstream specs.

// Open the positioned (mouse) session context menu by right-clicking the chat
// header title (.main-title.has-menu). Matches the idiom in interactive.spec.ts
// and theme.spec.ts. Returns the .ctxm-menu locator, awaited visible.
async function openMenu(page: Page) {
  await page.locator(".main-title.has-menu").click({ button: "right" });
  const menu = page.locator(".ctxm-menu");
  await expect(menu).toBeVisible();
  return menu;
}

test.describe("session context menu: Archive tap vs long-press (hold → delete)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(projectUrl("/"));
    // Select the shared seeded Demo session so the chat header title
    // (.main-title.has-menu) renders. No fixture mutation happens here — every
    // confirm in these tests is cancelled.
    await page.getByRole("button", { name: /Demo session/ }).click();
  });

  test("menu shows Archive… and no standalone Delete… item", async ({ page }) => {
    const menu = await openMenu(page);

    // Archive is the single destructive menu item now (the standalone Delete
    // item was removed; long-press on Archive is the only delete entry).
    await expect(menu.locator(".ctxm-item.danger")).toHaveCount(1);
    await expect(menu.getByText("Archive…")).toBeVisible();

    // No standalone Delete menu item must be rendered.
    await expect(menu.locator(".ctxm-item").filter({ hasText: /Delete/ })).toHaveCount(0);

    // Close the menu so the state is clean.
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  });

  test("normal click on Archive… opens the recoverable Archive confirm (no .danger)", async ({ page }) => {
    const menu = await openMenu(page);

    // A plain click is a tap (elapsed < HOLD_THRESHOLD_MS) → Archive confirm.
    await menu.getByText("Archive…").click();

    const confirm = page.getByRole("dialog", { name: "Confirm archive" });
    await expect(confirm).toBeVisible();
    // The recoverable Archive confirm MUST NOT carry the destructive .danger
    // modifier (only the Delete confirm does).
    await expect(confirm).not.toHaveClass(/danger/);

    // Cancel — never archive the shared fixture session.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
  });

  test("long-hold click on Archive… opens the irreversible Delete confirm (.danger)", async ({ page }) => {
    const menu = await openMenu(page);

    // Hold the Archive button past classifyHold's HOLD_THRESHOLD_MS (450ms): a
    // 500ms delay between pointerdown and the subsequent click yields a real
    // hold. classifyHold (web/src/lib/copyHold.ts) compares Date.now() captured
    // at pointerdown against Date.now() at click; >= 450ms → "hold" → Delete.
    await menu.getByText("Archive…").click({ delay: 500 });

    const confirm = page.getByRole("dialog", { name: "Confirm delete" });
    await expect(confirm).toBeVisible();
    // The irreversible Delete confirm MUST carry the destructive .danger
    // modifier so it reads as unrecoverable at a glance.
    await expect(confirm).toHaveClass(/danger/);

    // Cancel — NEVER confirm a delete. A real delete would mutate the shared
    // fixture backend for every downstream spec in this serial run.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
  });
});
