import { expect, test, type Page } from "@playwright/test";
import { projectUrl } from "./util";

// Safety-net for the ChatView navigator (one of the pieces a ChatView
// decomposition would extract). The demo session has two user turns, so on a
// desktop viewport the right-edge turn navigator renders; clicking a dot jumps
// to that turn. Locks the behaviour before extracting <ChatNavigator>.

test("desktop turn navigator shows a dot per turn and jumps on click", async ({ page }) => {
  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 8000 });

  const nav = page.locator(".chat-nav");
  await expect(nav).toBeVisible();
  const dots = nav.locator(".chat-nav-dot");
  // demo has multiple user turns (it has grown past the original m1/m3 pair).
  expect(await dots.count()).toBeGreaterThanOrEqual(2);

  // Clicking the first dot jumps to (and marks active) the first user turn.
  await dots.first().click();
  await expect(dots.first()).toHaveAttribute("aria-current", "true", { timeout: 4000 });
});

// ---------------------------------------------------------------------------
// E-ink display profile — instant navigator jumps
// ---------------------------------------------------------------------------
// jumpToMsg is the chat's ONLY behavior:"smooth" scroll site, so the profile's
// single conditional there is observable from OUTSIDE the component: record
// scrollIntoView calls on the real event path (the patch chains to the native
// implementation, so the jump still happens) and filter entries by the
// target's data-mid. The profile is toggled through the REAL Settings UI
// (Slice 1's manual path — no detection), covering both directions in one
// run: OFF = the stock smooth jump, ON = instant (behavior "auto").

async function installJumpRecorder(page: Page) {
  await page.addInitScript(() => {
    const orig = Element.prototype.scrollIntoView;
    (window as any).__vhJumps = [] as { mid: string; behavior?: string }[];
    Element.prototype.scrollIntoView = function (this: Element, arg?: ScrollIntoViewOptions) {
      const mid = this.getAttribute?.("data-mid");
      if (mid) (window as any).__vhJumps.push({ mid, behavior: arg?.behavior });
      return (orig as (...a: unknown[]) => void).call(this, arg);
    };
  });
}

const lastJump = (page: Page) =>
  page.evaluate(() => {
    const j = (window as any).__vhJumps as { mid: string; behavior?: string }[];
    return j.length ? j[j.length - 1] : null;
  });

test("navigator jump is smooth by default and instant under the e-ink profile (real Settings toggle)", async ({ page }) => {
  await installJumpRecorder(page);
  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 8000 });

  const nav = page.locator(".chat-nav");
  await expect(nav).toBeVisible();
  const dots = nav.locator(".chat-nav-dot");
  expect(await dots.count()).toBeGreaterThanOrEqual(2);

  // ---- OFF (default): the stock smooth jump.
  await dots.first().click();
  await expect(dots.first()).toHaveAttribute("aria-current", "true", { timeout: 4000 });
  expect(await lastJump(page)).toMatchObject({ behavior: "smooth" });

  // ---- Toggle the profile ON through the real Settings UI.
  await page.getByRole("button", { name: "Settings" }).click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Appearance" }).click();
  await dialog.getByRole("checkbox", { name: "E Ink mode" }).click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // ---- ON: the SAME real click path now jumps instantly.
  await dots.last().click();
  await expect.poll(() => lastJump(page)).toMatchObject({ behavior: "auto" });
  // Outcome, not just args: the turn row the jump targeted (identified by
  // the recorded mid — the fixture's LAST user turn) landed inside the
  // scroll viewport. (aria-current is the WRONG outcome signal here:
  // activeTurn marks the topmost turn within +8px of the fold, and the
  // bottom clamp on this short fixture leaves the last turn's row top
  // below that line — geometry, not a failed jump.)
  const mid = (await lastJump(page))!.mid;
  await expect
    .poll(() =>
      page.evaluate((targetMid) => {
        const scroll = document.querySelector(".chat-scroll");
        const row = scroll?.querySelector(`[data-mid="${targetMid}"]`);
        if (!scroll || !row) return false;
        const r = row.getBoundingClientRect();
        const c = scroll.getBoundingClientRect();
        return r.top >= c.top - 1 && r.bottom <= c.bottom + 1 && r.height > 0;
      }, mid),
    )
    .toBe(true);
});
