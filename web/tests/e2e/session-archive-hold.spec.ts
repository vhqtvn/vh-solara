import { type Locator, type Page, expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Real-browser e2e for the Archive menu button's tap-vs-hold wiring. The jsdom
// unit test (web/tests/unit/SessionContextMenuArchiveHold.test.tsx) drives a
// mocked clock; THIS spec exercises the REAL pointerdown→click gesture in
// Chromium through the REAL classifyHold threshold (web/src/lib/copyHold.ts,
// HOLD_THRESHOLD_MS = 450):
//   - normal click (tap) → recoverable Archive confirm (.dialog.confirm, NO .danger)
//   - long-hold click     → irreversible  Delete confirm (.dialog.confirm.danger)
//   - sustained press (F3) → the 450ms early-trigger timer fires MID-HOLD; the
//     release click (whose mousedown target is detached) must NOT dismiss it
//   - drag beyond ARCHIVE_HOLD_SLOP_PX mid-press → gesture cancelled; neither
//     confirm may ever open
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

// Border box of the Archive… item (.ctxm-item.danger — asserted unique in the
// first test below) for RAW-mouse gestures. The raw page.mouse API is required
// because locator.click() re-aims the pointer at the element on release —
// these cases must let the release click land wherever the ENGINE routes it
// (the mousedown target may be detached by then).
async function archiveItemBox(menu: Locator) {
  const box = await menu.locator(".ctxm-item.danger").boundingBox();
  if (!box) throw new Error("Archive… item has no bounding box (menu closed?)");
  return box;
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

  test("sustained press on Archive… fires the Delete confirm MID-HOLD; the release click must NOT dismiss it", async ({ page }) => {
    const menu = await openMenu(page);
    const box = await archiveItemBox(menu);

    // F3 — the feature's defining gesture: press and KEEP holding. The
    // pointerdown arms the 450ms early-trigger timer (SessionContextMenu.tsx);
    // openDeleteConfirm must fire while the button is STILL PRESSED — no
    // release involved. Stability-by-construction: the hold is indefinite,
    // so CI load can only LENGTHEN it; the timer fires during the hold and
    // toBeVisible polls until it does. No load path flips the outcome.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();

    // Still down: the timer fires → openDeleteConfirm closes the menu
    // (sessionMenu.ts) so the pressed button DETACHES, and the Delete
    // confirm renders above the press.
    const confirm = page.getByRole("dialog", { name: "Confirm delete" });
    await expect(confirm).toBeVisible();
    await expect(confirm).toHaveClass(/danger/);
    await expect(menu).toHaveCount(0); // the pressed button is now detached

    // Release the sustained press. The mousedown target is detached, so this
    // exercises WHERE Chromium routes the release click of the in-flight
    // gesture. Observed-outcome guard: the confirm must STILL be visible
    // after release — .dialog-overlay's onClick is closeDeleteConfirm
    // (SessionContextMenu.tsx), so an engine routing the release click to
    // the overlay would SILENTLY CLOSE the destructive prompt. Any such
    // dismissal runs synchronously in the mouse.up input dispatch; the
    // 250ms settle only makes its absence easy to observe.
    await page.mouse.up();
    await page.waitForTimeout(250);
    await expect(confirm).toBeVisible();

    // Cancel — NEVER confirm a delete. A real delete would mutate the shared
    // fixture backend for every downstream spec in this serial run.
    await confirm.getByRole("button", { name: "Cancel" }).click();
    await expect(confirm).toHaveCount(0);
    // Shared-fixture discipline: the seeded Demo session row must survive.
    await expect(page.getByRole("button", { name: /Demo session/ })).toBeVisible();
  });

  test("drag beyond the hold slop mid-press cancels: neither confirm ever opens", async ({ page }) => {
    const menu = await openMenu(page);
    const box = await archiveItemBox(menu);
    const deleteConfirm = page.getByRole("dialog", { name: "Confirm delete" });
    const archiveConfirm = page.getByRole("dialog", { name: "Confirm archive" });

    // Abandoned-gesture guarantee (drag-off half, commit 70cb7d3): a press
    // dragged beyond ARCHIVE_HOLD_SLOP_PX (10px, SessionContextMenu.tsx)
    // must NEVER open either confirm. The slop-cancel is SYNCHRONOUS on the
    // pointermove — the armed timer is cleared BY the move, not by a timer —
    // so the sequence is deterministic under CI load: once the move lands,
    // no timer exists to fire.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // Move IMMEDIATELY (well before 450ms), far beyond the 10px slop radius —
    // horizontally to just inside the button's right edge (dx = width/2 - 4,
    // ≫ 10px for any item wide enough to show its label; dy = 0). The pointer
    // stays ON the button, which isolates the pointermove slop path: the
    // deterministic stand-in for real TOUCH drag-off, where implicit pointer
    // capture keeps pointermove firing on the button and pointerleave never
    // comes. A mouse drag fully OFF the button additionally fires
    // pointerleave, which resets to the same cancelled state (see the button
    // comment in SessionContextMenu.tsx); both halves end cancelled — this
    // case drives the slop half.
    await page.mouse.move(box.x + box.width - 4, box.y + box.height / 2);

    // Wait past the 450ms threshold: nothing may appear. Load-independent —
    // the slop move already CLEARED the timer, and a cleared timer never
    // fires; no click has happened yet, so no opener can run in this window.
    await page.waitForTimeout(700);
    await expect(deleteConfirm).toHaveCount(0);
    await expect(archiveConfirm).toHaveCount(0);

    // Release ON the still-attached button: the click fires on the Archive
    // button itself, whose onClick consumes the moved flag FIRST and opens
    // NOTHING (mirrors menuTriggers' "moved = no action" in sessionMenu.ts).
    await page.mouse.up();
    await expect(deleteConfirm).toHaveCount(0);
    await expect(archiveConfirm).toHaveCount(0);

    // Menu state consistent: the abandoned gesture neither opened a confirm
    // NOR dismissed the menu. Close it via keyboard for shared-state hygiene.
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);

    // Honest limit: real TOUCH drag-off (implicit pointer capture suppressing
    // pointerleave) is NOT drivable by Playwright — touchscreen.tap() performs
    // taps only, no press-move-release stream. The mouse slop/leave paths
    // above are what a real browser can prove here; the touch-capture path
    // stays covered by the unit pointermove slop tests
    // (SessionContextMenuArchiveHold.test.tsx) plus the capture-semantics
    // argument in the component comment.
  });
});
