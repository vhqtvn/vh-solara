import { expect, test } from "@playwright/test";

// Regression guard for the "↓ Latest" scroll-to-bottom button in ChatView.
//
// The button (<button class="jump">) renders via `<Show when={!following() && !focusMode() && messages().length > 0}>`
// once the user scrolls away from the live tail; the complementary ".chat-live"
// Live pill renders via `<Show when={following() && working() && !focusMode() && messages().length > 0}>`
// while glued to the tail AND while a turn is live (busy/retrying). The `&& working()`
// gate hides the Live pill on finished/idle turns (test 11) — the idle demo fixture
// has working()=false, so the pill never shows there; tests that only need to prove
// `following=true` use the geometry-first `expectFollowingTail` helper instead. The
// two cues are mutually exclusive and share the same anchor spot (bottom:8px,
// centered) inside `.chat-main` (the scroll viewport).
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

// Geometry-first "following the tail" assertion: proves following=true (glued
// to the live tail) via bottom geometry + the absence of the "↓ Latest" button.
// It deliberately does NOT depend on the .chat-live Live pill: that pill now
// also requires working() (it hides on finished/idle turns — see test 11 and
// the gate at ChatView.tsx `<Show when={following() && working() && ...}>`).
// The idle demo fixture has working()=false, so a pill-based assertion there
// would be vacuous; this helper is the non-vacuous replacement for the old
// ".chat-live visible" checks in openDemo and tests 1/5/6/7/8.
async function expectFollowingTail(page: import("@playwright/test").Page) {
  await expect.poll(
    async () =>
      page.locator(".chat-scroll").evaluate((e: HTMLElement) =>
        e.scrollHeight - e.scrollTop - e.clientHeight < 24 ? 1 : 0,
      ),
    { timeout: 5000 },
  ).toBe(1);
  await expect(page.locator("button.jump")).toHaveCount(0);
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
  // Geometry-first (see expectFollowingTail): the idle demo has working()=false,
  // so the .chat-live pill is hidden by the `&& working()` gate even though
  // following=true. Assert the glued geometry + no "↓ Latest" button instead.
  await expectFollowingTail(page);
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

// (1) Tail state: glued to the live tail → following=true (geometry at the
//     bottom, "↓ Latest" button absent). The .chat-live pill itself hides on
//     the idle demo (working()=false per the `&& working()` gate), so we assert
//     the glued geometry, not the pill.
test("at the tail: following the tail, Latest button absent", async ({ page }) => {
  await openDemo(page);
  await expectFollowingTail(page);
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

// (5) Focus mode hides the Latest button (and the Live pill when working).
//
// Why: in focus mode the composer fills the whole `.chat` card
// (`.composer.focus` is position:absolute; inset:0; z-index:30), but
// `.chat-live` and `.jump` sit just inside the bottom edge of the scroll
// viewport (bottom:8px inside `.chat-main`, above the composer). Left ungated,
// the pill/button float over and paint onto the full-card textarea. The `<Show>`
// gates now also check `!focusMode()`, suppressing both cues while the expanded
// composer is up (semantically correct: they're tail/scroll cues that are
// meaningless over a full-card input).
//
// This test guards the `!focusMode()` gate via the button.jump half
// (following=false): it establishes following=false, verifies the button renders
// BEFORE entering focus mode (so the in-focus count:0 is unambiguous), then
// toggles focus off and confirms reactivity. The identical `!focusMode()` clause
// on the .chat-live Show is symmetric; its effect under working()=true is
// covered in test 11 (the idle demo here has working()=false, so the .chat-live
// pill is hidden by the `&& working()` gate regardless of focus — not a useful
// signal here). Toggling focus does not touch the following signal, so the
// following=false state is preserved across the on/off toggle pair.
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
// same end state as openDemo, no detach-prone click.
test("focus mode hides the Latest button (focus gate reactivity)", async ({ page }) => {
  await page.setViewportSize(VP);
  await page.goto("/?session=demo");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  // Glue to the tail deterministically (see NOTE above).
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  // following=true now (glued to the tail). PROVES the tail state going in via
  // GEOMETRY (not the .chat-live pill): the idle demo has working()=false, so
  // the pill is hidden by the `&& working()` gate even at the tail. The
  // focusMode gate's effect on the .chat-live pill (needs working()=true) is
  // covered in test 11; here the identical `!focusMode()` clause is exercised
  // via the button.jump half below (following=false).
  await expectFollowingTail(page);

  // --- Latest button gate + reactivity (following=false) ---
  // Switch to following=false in NORMAL mode (reliable; see tests 2–4).
  await setScrollTop(page, 0);
  // PROVES following=false going in, so the count:0 below is unambiguous
  // (without this, count:0 would pass whether following were true OR false).
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });

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
  // following=true → glued to the tail (geometry), Latest button absent. The
  // .chat-live pill hides on the idle demo (working()=false), so assert geometry.
  await expectFollowingTail(page);

  // Scroll away from the tail → following=false, Latest button appears, Live pill hides.
  await setScrollTop(page, 0);
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });
  await expect(page.locator(".chat-live")).toHaveCount(0);

  // Scroll back to the EXACT clamp the last pin() wrote (== pinnedTop). The OLD
  // guard bailed here with following still false; with the `&& following()` fix,
  // onScrolled runs → nearBottom() true → setFollowing(true).
  await setScrollTop(page, bottomClamp);
  // Following flips true → re-glued to the tail (geometry), Latest button hides.
  // (.chat-live stays hidden: idle demo, working()=false — the flip is proven by
  // geometry + the button.jump disappearance, not the pill.)
  await expectFollowingTail(page);
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
  // via the RO's first pin(). Glued to the tail, Latest button absent. The
  // .chat-live pill hides on the idle demo (working()=false), so assert geometry.
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  await expectFollowingTail(page);

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
  // STILL following after the grow (sanity) — geometry, since idle demo hides the pill.
  await expectFollowingTail(page);

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

  // The fix: following stayed true through shrink + growth. Glued to the tail,
  // Latest button stays absent. (Under the bug: following dropped during the
  // growth, button.jump→visible, failing here.) Geometry-first since the idle
  // demo hides the .chat-live pill.
  await expectFollowingTail(page);
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
  // the bottom) — same end state as openDemo, no detach-prone click. Geometry-first
  // (idle demo hides the .chat-live pill via the `&& working()` gate).
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  await expectFollowingTail(page);

  // SHRINK the viewport to VP (400×320): .chat-main drops ~280px, so the bottom
  // edge (scrollHeight - clientHeight) moves DOWN ~280px while scrollTop is
  // unchanged (no clamp on a shrink → no scroll event → onScrolled never runs).
  // Simulates the mobile-keyboard-up / console-resize shrink.
  await page.setViewportSize(VP);

  // The fix: the scrollEl ResizeObserver fired and re-pinned to the new bottom
  // while following. This GEOMETRY assertion is what catches the bug — without
  // the fix scrollTop is stale ~280px above the new bottom (a pill-only check
  // would pass under the bug, and the idle demo hides the pill regardless).
  await expectFollowingTail(page);

  // Grow back to the tall size and re-assert glued to the tail. (A grow
  // self-corrects via the clamp scroll event in any case, but this confirms the
  // end-to-end resize round-trip leaves us following at the bottom.)
  await page.setViewportSize({ width: VP.width, height: 600 });
  // Geometry-first re-assert (idle demo hides the pill).
  await expectFollowingTail(page);
});

// (9) Composer auto-grow while Live keeps following at the tail.
//
// Empirical capture of the "composer resize is covered" claim: `.chat-scroll`
// is `flex:1;min-height:0` (styles.css) and `.composer-wrap` is an in-flow
// sibling, so growing the composer (autosize() up to MAX_COMPOSER_PX=200)
// SHRINKS `.chat-scroll`'s box → fires the scrollEl ResizeObserver → the
// `if (following() && ready()) pin()` re-glue at ChatView.tsx keeps Live. This
// test drives that path end-to-end: a busy turn (so working()=true and the
// .chat-live pill renders — it hides on the idle demo via `&& working()`), then
// a long multi-line composer draft forcing several autosize growth steps, then a
// geometry + pill assertion.
test("composer auto-grow while Live keeps following at the tail", async ({ page }) => {
  await page.setViewportSize(VP);
  await page.goto("/?session=demo");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  // Glue to the tail (geometry-first).
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  await expectFollowingTail(page);
  // Drive a busy turn so working()=true and the .chat-live pill renders. [[stall]]
  // keeps the turn busy server-side for ~5s — enough window to type + assert.
  await page.getByPlaceholder("Message…").fill("[[stall]] composer grow");
  await page.keyboard.press("Enter");
  await expect(page.locator(".working-text")).toBeVisible({ timeout: 5000 });
  // .chat-live is up now (following && working && !focus).
  await expect(page.locator(".chat-live")).toBeVisible({ timeout: 3000 });

  // Type a long multi-line draft to force several autosize() growth steps (each
  // step shrinks .chat-scroll → scrollEl RO → re-pin while following). 16 lines
  // overshoots MAX_COMPOSER_PX=200 so the cap is exercised too.
  const tall = Array.from({ length: 16 }, (_, i) => `composer growth line number ${i + 1}`).join("\n");
  await page.getByPlaceholder("Message…").fill(tall);
  // Still glued to the tail (bottom geometry, no "↓ Latest" button) and the Live
  // pill is still visible — the composer growth did NOT drop following.
  await expectFollowingTail(page);
  await expect(page.locator(".chat-live")).toBeVisible({ timeout: 3000 });
});

// (10a) [SKIPPED] Spurious Live loss then a new turn → Live re-engages.
//
// This is the "self-heal catches a NON-intent loss" branch of the lifecycle
// (decision: re-engage on new turn/resume UNLESS the intent latch is set). Under
// the fix, a content-shrink clamp no longer drops `following` at all — the
// contentEl ResizeObserver guard's `!shrank` discriminator re-pins instead of
// flipping following false (test 7 pins that down). So there is no deterministic
// e2e-reachable path that leaves `following=false` WITHOUT also arming the intent
// latch `userScrolledUp`: every remaining false-flip site is either a genuine
// user scroll-up (arms the latch → 10b) or the maybeRestore anchor branch on
// reopen (system restore, does NOT arm the latch, but requires seeding a read
// anchor + reload — not exposed cleanly by the fixture's prompt flow).
//
// To exercise this branch deterministically you would either (a) extend the
// fixture (pkg/fixtures/opencode.go) to emit a content-shrink that bypasses the
// `!shrank` guard, or (b) expose a test-only hook to call setFollowing(false)
// without scrolling, then drive a new turn and assert `.chat-live` returns +
// bottom geometry. Skipped until such a hook lands; the complementary intent
// branch (10b) IS covered below.
test.skip("spurious Live loss re-engages on a new turn (needs fixture hook)", async () => {
  // placeholder — see comment above for how to make this deterministic.
});

// (10b) A deliberate scroll-up reader is NOT yanked when a new turn starts.
//
// The operator's desired lifecycle: Live re-engages on new turn/resume BUT does
// NOT yank a user who deliberately scrolled up to read history (intent-latch,
// not always-yank). This test pins the intent branch: scroll up (arms the latch
// at onScrolled's `!atBottom && !shrank` site), start a new turn (the working()
// false→true busy edge the self-heal effect watches), and verify self-heal is
// SUPPRESSED — the reader stays where they are.
test("a deliberate scroll-up reader is not yanked when a new turn starts", async ({ page }) => {
  await page.setViewportSize(VP);
  await page.goto("/?session=demo");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  // Glue to the tail (following=true, latch=false).
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  await expectFollowingTail(page);

  // Deliberately scroll UP to read history — genuine user intent. This arms the
  // intent latch (userScrolledUp=true) at onScrolled's `!atBottom && !shrank`
  // site, drops following, and surfaces the "↓ Latest" button.
  await setScrollTop(page, 0);
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });

  // Start a NEW turn. working() goes false→true (the busy edge). The fix's
  // intent-latch check (`!userScrolledUp()`) must keep self-heal from
  // re-engaging — the reader stays put. (A normal prompt streams + finishes fast;
  // the assertions hold throughout because following never flips back true.)
  await page.getByPlaceholder("Message…").fill("a new turn while reading history");
  await page.keyboard.press("Enter");
  await expect(page.locator(".working-text")).toBeVisible({ timeout: 5000 });

  // NOT yanked: still scrolled up (NOT at the bottom), Live pill stays hidden,
  // and the "↓ Latest" button remains available so the reader can jump back.
  await expect(page.locator(".chat-live")).toHaveCount(0);
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });
  const atBottom = await page.locator(".chat-scroll").evaluate(
    (el: HTMLElement) => el.scrollHeight - el.scrollTop - el.clientHeight < 24,
  );
  expect(atBottom).toBe(false);
});

// (11) The Live pill hides when the turn finishes (working gate), and focus mode
//      still hides it while busy (focus gate under working()=true).
//
// Two gates on the .chat-live Show are exercised here under working()=true
// (impossible on the idle demo, so they can't live in tests 1/5/6/7/8):
//   - `&& working()`: when the turn finishes (working() false) the pill hides
//     EVEN THOUGH following is still true (we never scrolled). The complementary
//     "↓ Latest" button also stays absent (following true) — finished tail state
//     shows neither cue. (test 11's primary purpose.)
//   - `!focusMode()`: while busy, focus mode still suppresses the pill, and
//     toggling back reveals it (reactivity). Moved here from test 5, which can't
//     show the pill on the idle demo.
test("the Live pill hides when the turn finishes (working gate + focus gate)", async ({ page }) => {
  await page.setViewportSize(VP);
  await page.goto("/?session=demo");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  await expectFollowingTail(page);

  // Start a busy turn so working()=true and the .chat-live pill renders.
  await page.getByPlaceholder("Message…").fill("[[stall]] finish gate");
  await page.keyboard.press("Enter");
  await expect(page.locator(".working-text")).toBeVisible({ timeout: 5000 });
  // Pill is up: following && working && !focus.
  await expect(page.locator(".chat-live")).toBeVisible({ timeout: 3000 });

  // Focus-gate coverage under working()=true. Focus mode hides the pill; toggling
  // back reveals it — proves the `!focusMode()` clause still gates the pill while
  // busy (the identical clause on button.jump is covered in test 5).
  await toggleFocus(page);
  await expect(page.locator(".chat-live")).toHaveCount(0);
  await toggleFocus(page);
  await expect(page.locator(".chat-live")).toBeVisible({ timeout: 3000 });

  // Wait for the stall turn to finish → working() flips false. Per the
  // `&& working()` gate the Live pill hides even though following is still true.
  // (Generous timeout: [[stall]] sleeps ~5s server-side before emitting idle.)
  await expect(page.locator(".working-text")).toHaveCount(0, { timeout: 12000 });
  await expect(page.locator(".chat-live")).toHaveCount(0);
  // Still glued to the tail (geometry) and no "↓ Latest" button — following is
  // true; the pill is hidden only because the turn is idle/finished.
  await expectFollowingTail(page);
});
