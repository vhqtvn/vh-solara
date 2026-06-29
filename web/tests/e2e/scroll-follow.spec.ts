import { expect, test } from "@playwright/test";

// Regression guard for the "↓ Latest" scroll-to-bottom button in ChatView.
//
// The button (<button class="jump">) renders via `<Show when={!following() && !focusMode() && messages().length > 0 && !isChild()}>`
// once the user scrolls away from the live tail; the complementary ".chat-live"
// Live pill renders via `<Show when={following() && !focusMode() && messages().length > 0 && !isChild()}>` while glued
// to the tail. The two are mutually exclusive and share the same anchor spot
// (bottom:8px, centered) inside `.chat-main` (the scroll viewport).
//
// This regression has re-broken before. The most recent failure was NOT a logic
// bug — `following()` flipped to false correctly and the button rendered — but
// an OCCLUSION bug: `.jump`/`.chat-live` had z-index:30 while the sibling
// `.composer-wrap` had z-index:40, so the composer painted over the button and
// the pill was invisible to the user even though it was in the DOM. A plain
// `toBeVisible()` does NOT catch occlusion (it only checks the box is non-empty
// and not display:none/visibility:hidden), so these tests additionally assert
// the button is the topmost element at its own center via elementFromPoint —
// that is the real guard against this class of regression.
//
// The demo transcript overflows `.chat-scroll` at a 400x320 viewport
// (scrollHeight ~1450 vs clientHeight ~70), so we shrink the viewport to make
// the transcript scrollable without touching the Go fixture.
//
// The e2e suite is serial (workers:1, fullyParallel:false) and shares one
// mutable fixture backend, so each test reloads the demo session to reset to a
// known state.

const VP = { width: 400, height: 320 };

// Asserts the element matching `sel` is the topmost painted element at its own
// center point — i.e. not occluded by another element with a higher z-index.
// A bare toBeVisible() passes for an occluded element; this does not.
async function topmostAtCenter(
  page: import("@playwright/test").Page,
  sel: string,
): Promise<boolean> {
  return page.locator(sel).evaluate((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return false;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    let n: Element | null = el.ownerDocument.elementFromPoint(cx, cy);
    while (n) {
      if (n === el) return true; // element (or a descendant) is on top
      n = n.parentElement;
    }
    return false; // covered by an unrelated element
  });
}

async function openDemo(page: import("@playwright/test").Page) {
  await page.setViewportSize(VP);
  await page.goto("/?session=demo");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  // Glue deterministically to the tail. The e2e suite is serial and mutates the
  // shared demo session (extra streamed turns, pending [[ask]] questions); on
  // reload a streamed turn settling / content shrinking above the fold can make
  // the browser clamp scrollTop down, which the app's ResizeObserver re-pin
  // guard reads as "user scrolled up" and drops `following` — so the demo no
  // longer reliably loads glued to the tail. Rather than depend on that
  // unrelated load behaviour, we explicitly re-glue (clicking "↓ Latest" only if
  // the load landed away from the tail) so every case starts from a known tail.
  // (The scroll-subsystem quirk itself is out of scope for this regression fix.)
  await expect(page.locator("button.jump, .chat-live").first()).toBeVisible({ timeout: 5000 });
  if (await page.locator("button.jump").count()) {
    await page.locator("button.jump").click();
  }
  await expect(page.locator(".chat-live")).toBeVisible({ timeout: 5000 });
}

async function setScrollTop(page: import("@playwright/test").Page, value: number) {
  await page.locator(".chat-scroll").evaluate((el: HTMLElement, v) => {
    el.scrollTop = v;
  }, value);
}

// Toggle the composer Focus-mode button. In focus mode the expanded composer
// (`.composer.focus`, inset:0) covers the toggle, so Playwright's normal click
// fails its pointer-actionability check — and force:true still dispatches at the
// button's coordinates, landing on the overlapping textarea. A native el.click()
// fires a real bubbling click event that SolidJS's delegated onClick catches
// regardless of what is painted on top, so it reliably flips the focusMode
// signal in both directions.
async function toggleFocus(page: import("@playwright/test").Page) {
  await page
    .locator('button[aria-label="Focus mode"]')
    .evaluate((el: HTMLElement) => el.click());
}

// (1) Tail state: glued to the live tail → Live pill shows, Latest button absent.
test("at the tail: Live pill visible, Latest button absent", async ({ page }) => {
  await openDemo(page);
  await expect(page.locator(".chat-live")).toBeVisible();
  await expect(page.locator("button.jump")).toHaveCount(0);
});

// (2) Scroll up reveals the Latest button on top of the composer.
test("scrolling up shows the Latest button (not occluded)", async ({ page }) => {
  await openDemo(page);
  await setScrollTop(page, 0);
  // Button appears (following flipped false) and the Live pill hides.
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });
  await expect(page.locator(".chat-live")).toHaveCount(0);
  // The real guard: the button must be the topmost element at its center, i.e.
  // NOT painted under the composer (.composer-wrap). This is what a bare
  // toBeVisible() misses and what let the z-index regression ship.
  expect(await topmostAtCenter(page, "button.jump")).toBe(true);
});

// (3) Clicking Latest re-glues to the tail and dismisses the button.
test("clicking Latest re-glues to the tail", async ({ page }) => {
  await openDemo(page);
  await setScrollTop(page, 0);
  const jump = page.locator("button.jump");
  await expect(jump).toBeVisible({ timeout: 3000 });
  await jump.click();
  // Near-bottom again (within the 24px nearBottom threshold the app uses).
  const atBottom = await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 24;
  });
  expect(atBottom).toBe(true);
  // Button is gone (following true again).
  await expect(page.locator("button.jump")).toHaveCount(0);
});

// (4) The race that keeps breaking: during a live/stalled turn, scrolling up
// must still surface the Latest button on top of the composer. Guards the busy
// streaming path (and the ResizeObserver re-pin neighbourhood that regressed
// before) — the button must render AND not be occluded while a turn is live.
test("mid-stream scroll up still surfaces the Latest button", async ({ page }) => {
  await openDemo(page);
  // [[stall]] keeps the turn busy server-side for several seconds.
  await page.getByPlaceholder("Message…").fill("[[stall]] scroll up while busy");
  await page.keyboard.press("Enter");
  // Wait for the busy/streaming state.
  await expect(page.locator(".working-text")).toBeVisible({ timeout: 5000 });
  // Scroll away from the tail mid-turn.
  await setScrollTop(page, 0);
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });
  // And it must not be occluded by the composer while the turn is live.
  expect(await topmostAtCenter(page, "button.jump")).toBe(true);
});

// (5) Focus mode hides both Live pill and Latest button.
//
// Why: in focus mode the composer fills the whole `.chat` card
// (`.composer.focus` is position:absolute; inset:0; z-index:30), but
// `.chat-live` and `.jump` sit just inside the bottom edge of the scroll
// viewport (bottom:8px inside `.chat-main`, above the composer). Left ungated,
// the pill/button float over and paint onto the full-card textarea. The `<Show>`
// gates now also check `!focusMode()`, suppressing both cues while the expanded
// composer is up (semantically correct: they're tail/scroll cues that are
// meaningless over a full-card input). This test guards both gates — each one
// establishes the relevant `following` state and verifies the cue renders
// BEFORE entering focus mode (so the in-focus count:0 is unambiguous). Both
// gates and both reactivity checks run from one page load: the Live-pill section
// at the tail (following=true), then a normal-mode scroll-up switches to
// following=false for the Latest-button section. Toggling focus does not touch
// the following signal, so each section's following state is preserved across
// its on/off toggle pair.
//
// NOTE: this test intentionally does NOT use openDemo(). openDemo's click-based
// re-glue (clicking button.jump when the load lands away from the tail) is the
// documented flaky spot in this suite: the ResizeObserver re-pin guard can flip
// `following` back to true mid-click, detaching button.jump and hanging the
// 30s test budget. It hits whichever scroll-follow test runs LAST hardest,
// because earlier tests mutate the shared demo session (test 4 streams a turn
// that grows the transcript). That makes openDemo unreliable for this test
// specifically. We instead glue to the tail deterministically by scrolling to
// the bottom — the app's onScrolled sets following=true when near the bottom,
// mounting .chat-live — same end state as openDemo, no detach-prone click.
test("focus mode hides both Live pill and Latest button", async ({ page }) => {
  await page.setViewportSize(VP);
  await page.goto("/?session=demo");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  // Glue to the tail deterministically (see NOTE above).
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  // following=true now → Live pill is up. PROVES the tail state going in, so
  // the count:0 below can only be explained by the focusMode gate.
  await expect(page.locator(".chat-live")).toBeVisible({ timeout: 5000 });

  // --- Live pill gate + reactivity (following=true) ---
  await toggleFocus(page); // focus mode on
  await expect(page.locator(".chat-live")).toHaveCount(0);
  await toggleFocus(page); // focus mode off — following is unchanged (no scroll)
  // Reactivity: the Live pill reappears, proving the gate is driven by
  // focusMode() and is not a permanent hide.
  await expect(page.locator(".chat-live")).toBeVisible({ timeout: 3000 });

  // --- Switch to following=false in NORMAL mode (reliable; see tests 2–4) ---
  await setScrollTop(page, 0);
  // PROVES following=false going in, so the count:0 below is unambiguous
  // (without this, count:0 would pass whether following were true OR false).
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });

  // --- Latest button gate + reactivity (following=false) ---
  await toggleFocus(page); // focus mode on — button suppressed (would float
  await expect(page.locator("button.jump")).toHaveCount(0); //   over the textarea)
  await toggleFocus(page); // focus mode off — following still false (no scroll)
  // Reactivity: the Latest button reappears.
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });
});
