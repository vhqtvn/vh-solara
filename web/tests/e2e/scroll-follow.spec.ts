import { expect, test } from "@playwright/test";

// Regression guard for the "↓ Latest" scroll-to-bottom button in ChatView.
//
// The button (<button class="jump">) renders via `<Show when={!following() && !focusMode() && messages().length > 0}>`
// once the user scrolls away from the live tail; the complementary ".chat-live"
// Live pill renders via `<Show when={following() && !focusMode() && messages().length > 0}>` while glued
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
  // unrelated load behaviour, we explicitly re-glue.
  //
  // We glue by scrolling to the bottom (the app's onScrolled sets following=true
  // when near the bottom, mounting .chat-live) instead of clicking "↓ Latest".
  // The click was a documented flaky spot: it had no timeout, so if a geometry
  // regression ever made the button's click point occluded again (it has — by
  // the header Code button at 400×320), the click retried until the whole 30s
  // test budget was gone, failing every test that calls openDemo. The scroll is
  // deterministic and detach-proof — same proven pattern test 5 below uses and
  // chat-controls-gating.spec test 1. (The scroll-subsystem quirk itself is out
  // of scope for this regression fix.)
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
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
  // Short timeout: this is the one intentional .jump click left in the suite.
  // If a future geometry regression makes it occluded again, fail fast here
  // (5s) instead of burning the whole 30s test budget on click retries.
  await jump.click({ timeout: 5000 });
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

// (6) Regression: scrolling back to the bottom after scrolling up MUST flip the
//     "↓ Latest" button back to the "Live" pill.
//
// The onScrolled self-pin guard bails when scrollEl.scrollTop === pinnedTop
// (pinnedTop is the clamp the last programmatic pin() wrote, i.e. the bottom).
// That bail is a perf optimization for our OWN pins while following — without
// it, every streamed pin re-runs nearBottom/ack/navigator per frame. But the
// bail used to fire even when following was FALSE: a user who scrolled up
// (following=false → Latest button) and then scrolled back to the bottom landed
// on the SAME scrollTop as the last pin (no new content since → scrollHeight
// unchanged → same clamp), so onScrolled bailed before setFollowing(true) ran,
// following stayed false, and the Live pill never came back — the Latest button
// was stuck up forever. The guard now also requires `&& following()`, so it only
// short-circuits the exact case it exists for (our own pin while glued).
//
// Reproduction avoids openDemo on purpose: openDemo's click-based re-glue is the
// documented detach-prone flaky spot (see the focus-mode test NOTE above — the RO
// re-pin guard can unmount button.jump mid-click and hang the 30s budget). We
// instead glue deterministically by scrolling to the bottom, and we capture the
// clamp value so the scroll-back lands on the EXACT scrollTop pin() wrote. The
// demo transcript is small and static (no streaming), and Deferred rows mount
// once and never unmount, so scrollHeight is stable and the clamp matches
// pinnedTop on the way back down.
test("scrolling back to the bottom flips Latest → Live", async ({ page }) => {
  await page.setViewportSize(VP);
  await page.goto("/?session=demo");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });

  // Glue to the tail deterministically. The RO path pins while following=true,
  // arming pinnedTop to this bottom clamp; capture it so the scroll-back below
  // lands on the exact value pin() wrote.
  const bottomClamp = await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  // following=true → Live pill up, Latest button absent.
  await expect(page.locator(".chat-live")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("button.jump")).toHaveCount(0);

  // Scroll away from the tail → following=false, Latest button appears, Live pill hides.
  await setScrollTop(page, 0);
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });
  await expect(page.locator(".chat-live")).toHaveCount(0);

  // Scroll back to the EXACT clamp the last pin() wrote (== pinnedTop). The OLD
  // guard bailed here with following still false; with the `&& following()` fix,
  // onScrolled runs → nearBottom() true → setFollowing(true).
  await setScrollTop(page, bottomClamp);
  // Following flips true → Live pill reappears, Latest button hides.
  await expect(page.locator(".chat-live")).toBeVisible({ timeout: 3000 });
  await expect(page.locator("button.jump")).toHaveCount(0);
});

// (7) Regression: a transcript height SHRINK while Live (following=true, glued to
//     the tail) must NOT drop `following`. The Live pill must persist and the
//     Latest button must stay absent.
//
// Root cause this guards: the ResizeObserver re-pin guard in ChatView reads
// `scrollTop < pinnedTop` as "the user scrolled up since our last pin → drop
// following and let their position win" (the documented "↓ Latest" race fix).
// But a content SHRINK also clamps `scrollTop` below `pinnedTop` with NO user
// intent: when content above/around the viewport shrinks, the browser clamps
// `scrollTop` down to the new (smaller) max bottom. The guard then wrongly set
// `following=false`, refused to re-pin, and subsequent streaming content drifted
// off-screen — Live was lost on a mere layout shrink.
//
// Real triggers: a reasoning/thinking block collapsing the instant it stops
// being the tail (expanded only while tail — body up to 320px), a tool part
// collapsing on de-tail (same `!!props.tail` pattern in Part.tsx), or the
// raw→rendered-HTML swap landing shorter than the raw stream. All three shrink
// `.chat-content` (the element the RO observes), so the guard sees the same
// `scrollTop < pinnedTop` dip each time.
//
// WHY A GENERIC SHRINK (not a real reasoning→text de-tail stream): the fixture
// backend (pkg/fixtures/opencode.go simulatePrompt/streamAssistant) ONLY streams
// plain text parts — no reasoning part can ever become the streaming tail, so
// the exact "thinking block expands as tail then collapses when text streams
// below it" sequence cannot be driven through the fixture's prompt flow. A
// deterministic DOM-driven shrink exercises the IDENTICAL code path the RO
// callback + the guard at ChatView.tsx run for a real collapse: both reduce
// `.chat-content`'s height, which is all the RO observes, without any
// streaming-timing nondeterminism.
//
// WHY THE SHRINK IS GRADUAL (multi-frame), NOT a single discrete removal: the
// real reasoning/tool collapse is a CSS grid TRANSITION (`.disclosure`
// grid-template-rows: 1fr→0fr) that shrinks over multiple animation frames. A
// single DISCRETE removal (e.g. `el.remove()` in one step) is VACUOUS here — its
// ResizeObserver notification for that one step reads the PRE-clamp scrollTop
// (still === pinnedTop), so `scrollTop < pinnedTop` is false, the guard takes
// the else→pin() branch, pinnedTop stays correct, and even a pure shrink
// self-heals via onScrolled (nearBottom after the clamp → setFollowing(true)).
// The GRADUAL sequence matches the real transition's timing: on each intermediate
// frame the browser clamps scrollTop in layout BEFORE the RO notification fires,
// so the guard observes a POST-clamp `scrollTop < pinnedTop` on every step. With
// the bug, that fired setFollowing(false) on each step (re-armed by onScrolled
// while still at the bottom, so the break was hidden during the shrink) but pin()
// NEVER ran, leaving pinnedTop STALE at the tall pre-shrink value. The very next
// GROWTH frame then saw `scrollTop < stale-pinnedTop`, fired setFollowing(false)
// WITHOUT pinning, and growth doesn't move scrollTop so no scroll event fired to
// re-arm following — the viewport drifted off the tail and the Latest button
// appeared. That grow-after-gradual-shrink is the precise failure mode this test
// pins down, and it requires the multi-frame shrink to arm the stale pinnedTop.
//
// Like tests (5) and (6), this deliberately avoids openDemo()'s detach-prone
// click-based re-glue (the documented flaky spot in this suite) and glues to the
// tail deterministically by scrolling to the bottom.
test("a content shrink while Live keeps following (no false user-scroll-up)", async ({ page }) => {
  await page.setViewportSize(VP);
  await page.goto("/?session=demo");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });

  // Glue to the tail deterministically (app's onScrolled sets following=true near
  // the bottom). This arms pinnedTop/pinnedScrollHeight to the current content
  // via the RO's first pin(). Live pill up, Latest button absent.
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator(".chat-live")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("button.jump")).toHaveCount(0);

  // Append a tall block to .chat-content (the RO-observed element). The RO fires,
  // following is true, so pin() re-glues to the new bottom and arms the tall
  // pinnedScrollHeight we need for the subsequent shrink to register as `shrank`.
  // Poll until the app has caught up (scrollTop is back within 24px of bottom).
  await page.locator(".chat-content").evaluate((el: HTMLElement) => {
    const t = document.createElement("div");
    t.id = "__e2e_shrink_block";
    t.style.height = "600px";
    t.style.background = "transparent";
    el.appendChild(t);
  });
  await expect.poll(
    async () =>
      page.locator(".chat-scroll").evaluate((e: HTMLElement) =>
        e.scrollHeight - e.scrollTop - e.clientHeight < 24 ? 1 : 0,
      ),
    { timeout: 3000 },
  ).toBe(1);
  // STILL Live after the grow (sanity).
  await expect(page.locator(".chat-live")).toBeVisible({ timeout: 3000 });
  await expect(page.locator("button.jump")).toHaveCount(0);

  // GRADUAL SHRINK over many frames — the essential reproduction. Step the
  // injected block's height through [500,400,300,200,100,0], waiting 2 rAFs +
  // 30ms between steps (matches the .disclosure grid-transition cadence). On
  // each step the browser clamps scrollTop in layout before the RO fires, so the
  // guard sees post-clamp `scrollTop < pinnedTop`. With the bug this set
  // following=false every step (re-armed by onScrolled) but never ran pin(),
  // leaving pinnedTop STALE at the tall pre-shrink value — which the growth
  // below then exposes.
  await page.locator("#__e2e_shrink_block").evaluate(
    (el: HTMLElement) =>
      new Promise<void>((resolve) => {
        const steps = [500, 400, 300, 200, 100, 0];
        let i = 0;
        const tick = () => {
          if (i >= steps.length) return resolve();
          el.style.height = steps[i] + "px";
          i++;
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setTimeout(tick, 30)),
          );
        };
        tick();
      }),
  );

  // GROW, one frame at a time (append six 60px blocks, 2 rAFs + 30ms apart).
  // With the bug: pinnedTop is stale (tall), so each growth frame's RO callback
  // sees `scrollTop < pinnedTop` and sets following=false WITHOUT pinning; growth
  // doesn't move scrollTop, so no scroll event fires to re-arm following → the
  // viewport drifts off the tail and the Latest button appears. With the fix:
  // pin() ran on the shrink frames, keeping pinnedTop tracking the smaller max,
  // so growth is followed and Live persists.
  await page.locator(".chat-content").evaluate(
    (el: HTMLElement) =>
      new Promise<void>((resolve) => {
        let n = 0;
        const tick = () => {
          if (n >= 6) return resolve();
          const d = document.createElement("div");
          d.style.height = "60px";
          d.style.background = "transparent";
          el.appendChild(d);
          n++;
          requestAnimationFrame(() =>
            requestAnimationFrame(() => setTimeout(tick, 30)),
          );
        };
        tick();
      }),
  );

  // The fix: following stayed true through shrink + growth. Live pill persists
  // and the Latest button stays absent. (Under the bug: following dropped during
  // the growth, .chat-live→0, button.jump→visible, failing here.)
  await expect(page.locator(".chat-live")).toBeVisible({ timeout: 3000 });
  await expect(page.locator("button.jump")).toHaveCount(0);
});

// (8) Regression: a VIEWPORT shrink while Live (following=true, glued to the tail)
//     must re-glue to the new bottom — the tail must not drift up off-screen while
//     the Live pill still claims we're following. Distinct from (7): (7) exercises
//     the contentEl ResizeObserver (a CONTENT height change); this exercises the
//     scrollEl ResizeObserver (a VIEWPORT height change with content unchanged).
//
// Root cause this guards: while Live, `following` is true and the viewport sits at
// the bottom edge (scrollTop ≈ scrollHeight - clientHeight). When the VIEWPORT
// shrinks (mobile keyboard appearing, window/console resize, layout shift),
// clientHeight drops, so the bottom edge (scrollHeight - clientHeight) moves DOWN
// — but scrollTop is unchanged (a shrink does NOT clamp, since the new max is
// LARGER, so NO scroll event fires) and scrollHeight is unchanged (content didn't
// change, so the contentEl ResizeObserver doesn't fire either). Result: following
// stays true, the Live pill stays visible, but the viewport is now stale — sitting
// above the new bottom — and nothing re-glues it. (A viewport GROW is the inverse:
// the new max is smaller, the browser DOES clamp scrollTop down → a scroll event
// fires → onScrolled → nearBottom() → stays following; only the SHRINK is broken.)
//
// The fix lives in the EXISTING scrollEl ResizeObserver (the one that already
// tracks measureNavCap): it fires exactly on this viewport resize, and now also
// re-pins to the bottom while following (gated on ready() so initial scroll-restore
// via maybeRestore owns positioning until it completes).
//
// Reproduction: load at a TALL viewport (400×600) so .chat-main has room to shrink
// into, glue to the tail deterministically (scroll to bottom — same pattern as
// tests 5–7, avoids the detach-prone openDemo click), then SHRINK to 400×320 (the
// VP the rest of the suite uses; .chat-main drops from ~348px to ~68px — a ~280px
// shrink that definitely fires the scrollEl RO and moves the bottom edge well past
// the 24px nearBottom threshold). We assert the GEOMETRY is at the bottom, NOT just
// the Live pill: following is never re-evaluated on a shrink (no scroll event), so
// the pill stays visible even under the bug — the geometry check is the only thing
// that catches it. Then we grow back and re-assert to confirm the resize round-trip.
test("a viewport shrink while Live re-glues to the tail", async ({ page }) => {
  // Start TALL so .chat-main has room to shrink into. At 400×600 .chat-main is
  // ~348px (the non-scroll chrome — header/.chat-status/.composer-wrap — eats the
  // rest); the demo transcript (scrollHeight ~1450) still overflows at this size.
  await page.setViewportSize({ width: VP.width, height: 600 });
  await page.goto("/?session=demo");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });

  // Glue to the tail deterministically (app's onScrolled sets following=true near
  // the bottom) — same end state as openDemo, no detach-prone click.
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator(".chat-live")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("button.jump")).toHaveCount(0);

  // SHRINK the viewport to VP (400×320): .chat-main drops ~280px, so the bottom
  // edge (scrollHeight - clientHeight) moves DOWN ~280px while scrollTop is
  // unchanged (no clamp on a shrink → no scroll event → onScrolled never runs).
  // Simulates the mobile-keyboard-up / console-resize shrink.
  await page.setViewportSize(VP);

  // The fix: the scrollEl ResizeObserver fired and re-pinned to the new bottom
  // while following. Poll because the RO fires on a later frame. This GEOMETRY
  // assertion is what catches the bug — without the fix scrollTop is stale ~280px
  // above the new bottom, but the Live pill stays visible (following never
  // re-evaluated), so a pill-only check would pass under the bug.
  await expect.poll(
    async () =>
      page.locator(".chat-scroll").evaluate((e: HTMLElement) =>
        e.scrollHeight - e.scrollTop - e.clientHeight < 24 ? 1 : 0,
      ),
    { timeout: 3000 },
  ).toBe(1);
  await expect(page.locator(".chat-live")).toBeVisible({ timeout: 3000 });
  await expect(page.locator("button.jump")).toHaveCount(0);

  // Grow back to the tall size and re-assert glued to the tail. (A grow
  // self-corrects via the clamp scroll event in any case, but this confirms the
  // end-to-end resize round-trip leaves us following at the bottom.)
  await page.setViewportSize({ width: VP.width, height: 600 });
  await expect.poll(
    async () =>
      page.locator(".chat-scroll").evaluate((e: HTMLElement) =>
        e.scrollHeight - e.scrollTop - e.clientHeight < 24 ? 1 : 0,
      ),
    { timeout: 3000 },
  ).toBe(1);
  await expect(page.locator(".chat-live")).toBeVisible({ timeout: 3000 });
  await expect(page.locator("button.jump")).toHaveCount(0);
});
