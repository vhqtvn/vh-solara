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

// ---------------------------------------------------------------------------
// E-ink display profile — compact semantic turn navigation on NARROW
// viewports (UX Slice 1). The desktop dot navigator does not render below the
// 721px breakpoint; the e-ink paging bar fills that gap with prev/next turn
// buttons routed through the SAME navigator controller machinery
// (userTurns/activeTurn/jumpToMsg). An effective instant jump establishes
// persistent reading intent (createNavigator's onInstantJump seam).
// ---------------------------------------------------------------------------
test("e-ink ON narrow viewport: compact turn navigation jumps between user turns", async ({ page }) => {
  // Boot the profile via its saved preference (the manual activation path)
  // and shrink below the desktop breakpoint (721px).
  await page.addInitScript(() => {
    localStorage.setItem("vh.prefs.einkProfile.v1", JSON.stringify({ v: 1, data: true }));
    localStorage.setItem("vh.prefs.streamLive.v1", JSON.stringify({ v: 1, data: true }));
  });
  await page.setViewportSize({ width: 400, height: 600 });
  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".chat-content.ready")).toBeVisible({ timeout: 10000 });
  // Glue deterministically to the tail (mirrors scroll-follow's openDemo).
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });

  // Narrow posture: no desktop dot navigator, but the paging bar + its
  // compact turn navigation ARE reachable.
  await expect(page.locator(".chat-nav")).toHaveCount(0);
  await expect(page.locator('[data-eink="paging"]')).toBeVisible();
  await expect(page.locator('[data-eink="prev-turn"]')).toBeVisible();
  await expect(page.locator('[data-eink="next-turn"]')).toBeVisible();

  // Expected target, derived from the app's OWN position label — the same
  // navigator.activeTurn signal stepTurn targets (never a parallel
  // computation that can race it). The shared demo transcript grows across
  // the serial suite, so turn indexes are never hardcoded; the label is
  // polled until STABLE (two reads 250ms apart agree) because activeTurn
  // updates on a rAF after the glue scroll.
  const label = page.locator('[data-eink="turn-pos"]');
  await expect(label).toBeVisible();
  const stableLabel = async (): Promise<string | null> => {
    const a = await label.textContent();
    await page.waitForTimeout(250);
    const b = await label.textContent();
    return a && a === b ? a : null;
  };
  await expect.poll(stableLabel, { timeout: 8000 }).toMatch(/^\d+\/\d+$/);
  const posText = (await label.textContent())!;
  const activeIdx = parseInt(posText.split("/")[0], 10) - 1;
  const total = parseInt(posText.split("/")[1], 10);
  expect(activeIdx).toBeGreaterThan(0); // non-vacuous: a previous turn exists
  const prevMid = await page.evaluate((i) => {
    const turns = Array.from(document.querySelectorAll(".chat-content .msg.user")) as HTMLElement[];
    return turns[i]?.dataset.mid ?? null;
  }, activeIdx - 1);
  expect(prevMid).not.toBeNull();

  // REAL click on Previous turn: instant jump to that turn's row...
  await page.locator('[data-eink="prev-turn"]').click();
  await expect
    .poll(() =>
      page.evaluate((wantMid) => {
        const scroll = document.querySelector(".chat-scroll") as HTMLElement | null;
        const row = scroll?.querySelector(`.msg[data-mid="${wantMid}"]`) as HTMLElement | null;
        if (!scroll || !row) return false;
        const r = row.getBoundingClientRect();
        const c = scroll.getBoundingClientRect();
        return r.top >= c.top - 2 && r.top <= c.top + 40 && r.height > 0;
      }, prevMid!),
    )
    .toBe(true);
  // ...and the jump established persistent reading intent ("↓ Latest" pill).
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });

  // The position label tracks the active turn (1-based "n/total").
  await expect(label).toHaveText(`${activeIdx}/${total}`);

  // Next turn jumps back down to the turn we came from (same rule, forward).
  const cameFromMid = await page.evaluate((i) => {
    const turns = Array.from(document.querySelectorAll(".chat-content .msg.user")) as HTMLElement[];
    return turns[i + 1]?.dataset.mid ?? null;
  }, activeIdx - 1);
  expect(cameFromMid).not.toBeNull();
  await page.locator('[data-eink="next-turn"]').click();
  await expect
    .poll(() =>
      page.evaluate((wantMid) => {
        const scroll = document.querySelector(".chat-scroll") as HTMLElement | null;
        const row = scroll?.querySelector(`.msg[data-mid="${wantMid}"]`) as HTMLElement | null;
        if (!scroll || !row) return false;
        const r = row.getBoundingClientRect();
        const c = scroll.getBoundingClientRect();
        return r.top >= c.top - 2 && r.top <= c.top + 40 && r.height > 0;
      }, cameFromMid!),
    )
    .toBe(true);
  await expect(label).toHaveText(`${activeIdx + 1}/${total}`);
});
