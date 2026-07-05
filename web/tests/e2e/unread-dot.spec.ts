import { expect, test } from "@playwright/test";

// Regression guard for bug P1-WEB-005: the "finished — not yet viewed" unread
// dot (.dot.unread in a SessionTree row) must clear correctly in the two cases
// that previously left it stuck, and must STAY in the one case where clearing it
// would be wrong.
//
//  (1) PRIMARY — opening an already-finished unread session that lands at the
//      bottom (no read anchor) must clear the dot WITHOUT the user scrolling.
//      Fixed in ChatView.tsx maybeRestore(): the no-anchor bottom-pin branch now
//      calls ackSession(props.sessionId).
//
//  (2) REACTIVE — a session that finishes WHILE the user is already watching it
//      at the bottom must not leave a lingering dot. Fixed in ChatView.tsx
//      createEffect: when !draft && ready() && following() && nearBottom() &&
//      state.unread[sid], it acks immediately. (The busy→idle transition that
//      arms the dot is selection-agnostic server-side, so without this the dot
//      would linger on the very session you are looking at.)
//
//  (3) GUARD — opening a session restored to a MID-HISTORY read anchor (read
//      cursor not at the bottom) must NOT clear the dot: the user has not caught
//      up, so "finished — not yet viewed" must remain. maybeRestore's anchor
//      branch deliberately does NOT ack; this test pins that behaviour so a
//      future "just always ack on open" change can't silently regress it.
//
// Unread derivation (server-side): a root subtree busy→idle transition fires
// markUnreadLocked → emits "unread.set" (pkg/state/store.go). The fixture's
// prompt_async path drives a real busy→idle transition, so the dot is armed by
// prompting a session while it is NOT the selected one — no fixture change
// needed. See web/tests/e2e/scroll-follow.spec.ts for the serial/shared-backend
// conventions mirrored here (workers:1, one mutable in-memory backend, each test
// reloads to reset client state).
//
// All three cases use the `other` session, NOT `demo`: `demo` is prompted by
// ~half the serial suite, and its busyCount/activity state drifts (overlapping
// turns, reactive acks), which makes arming its unread dot unreliably. `other`
// has a clean activity history and arms reliably — the same path the primary
// test proves.

const VP = { width: 400, height: 320 };

type Page = import("@playwright/test").Page;

// The unread dot inside a session's tree row.
function dot(page: Page, id: string) {
  return page.locator(`.tree-node[data-session-id="${id}"] .dot.unread`);
}

// Prompt a session through the same route the composer uses
// (POST /oc/session/<id>/prompt_async), run in-page so the request is same-origin
// and the X-VH-CSRF header satisfies the state-changing-request guard. A plain
// prompt (no [[perm]]/[[ask]]/[[stall]]) completes normally in ~1s, driving the
// session busy→idle — exactly the transition that arms the unread dot.
async function promptSession(page: Page, id: string, text: string) {
  await page.evaluate(
    async ({ id, text }) => {
      const res = await fetch(`/oc/session/${id}/prompt_async`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
      });
      // 204 is the expected immediate ack (the reply streams over SSE).
      if (!res.ok && res.status !== 204) {
        throw new Error(`prompt_async ${id} -> ${res.status}`);
      }
    },
    { id, text },
  );
}

// Clear a session's unread state server-side (POST /vh/ack). Documents the ack
// route; the active tests assert the app's OWN ack behavior (so they don't call
// this), but it's kept available for any future test that needs to reset unread
// state against the shared backend.
async function ackSession(page: Page, id: string) {
  await page.evaluate(async (sessionID) => {
    await fetch("/vh/ack", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
      body: JSON.stringify({ sessionID }),
    });
  }, id);
}

// Wait for the currently-selected session's busy shimmer to appear and then
// settle, i.e. one full busy→idle turn. Awaiting each turn fully prevents the
// fixture from running concurrent simulatePrompt goroutines on the same session
// (which would interleave their session.status/session.idle events and corrupt
// the aggregator's busyCount). Kept for revival of the guard test.
async function waitForTurnSettled(page: Page) {
  await expect(page.locator(".working-text")).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".working-text")).toHaveCount(0, { timeout: 12000 });
}

async function waitForTree(page: Page) {
  await expect(page.locator(".tree-node").first()).toBeVisible({ timeout: 10000 });
}

// P1-WEB-004: in-app session switch via popstate. The session-switch effect
// (where the arm-time stash flush lives) fires on SPA navigation — props.sessionId
// changes while ChatView stays MOUNTED. page.goto would UNMOUNT ChatView and lose
// the in-memory armedCand stash, bypassing the fix entirely, so the tests must
// drive the same popstate path the app's own history navigation uses. pushState
// updates window.location synchronously; the manually dispatched PopStateEvent
// triggers sync.ts's popstate handler → setSelectedIdRaw(id) → switch effect.
async function switchSessionInApp(page: Page, id: string) {
  await page.evaluate((sid) => {
    const url = new URL(window.location.href);
    url.searchParams.set("session", sid);
    history.pushState({}, "", url.toString());
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, id);
}

// Confirm a session's tree row is marked selected — proves the popstate switch
// took and SolidJS has flushed the selection signal through the tree.
async function waitForSessionSelected(page: Page, id: string) {
  await expect(
    page.locator(`.tree-node[data-session-id="${id}"].selected`),
  ).toBeVisible({ timeout: 5000 });
}

// P1-WEB-004: read a session's persisted read anchor DIRECTLY from localStorage
// (key "vh.scroll.v2", wrapped as {v:1,data:{[sid]:msgId}} by lib/store.ts
// saveVersioned). This is the most direct proof that the arm-time stash flush
// (or its invalidation) had the intended persistence effect — independent of the
// reopen/restore path that maybeRestore drives.
async function readAnchor(page: Page, id: string): Promise<string | undefined> {
  return page.evaluate((sid) => {
    try {
      const raw = localStorage.getItem("vh.scroll.v2");
      if (!raw) return undefined;
      const parsed = JSON.parse(raw);
      if (parsed && parsed.v === 1 && parsed.data && typeof parsed.data === "object") {
        return (parsed.data as Record<string, string>)[sid] ?? undefined;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }, id);
}

// (1) PRIMARY: open a finished unread session at the bottom → dot clears without
// scrolling. This is the exact P1-WEB-005 regression: before the fix, opening a
// finished session at the bottom left the dot until the user scrolled.
test("opening a finished unread session at the bottom clears the dot", async ({ page }) => {
  await page.setViewportSize(VP);
  // View demo so `other` is NOT the selected session — its completion will then
  // arm the unread dot against an unselected root.
  await page.goto("/?session=demo");
  await waitForTree(page);

  // Prompt `other` while it is unselected → busy→idle → markUnread → dot appears.
  // The dot renders only once `other` is idle again (busy() suppresses it via the
  // <Show> gate), so waiting for the dot inherently waits the turn out.
  await promptSession(page, "other", "unread-dot primary probe");
  await expect(dot(page, "other")).toBeVisible({ timeout: 15000 });

  // Open `other`. It has no stored read anchor → maybeRestore takes the no-anchor
  // bottom-pin branch → following=true, pinned to the tail, and (the fix)
  // ackSession(other) fires. The dot must clear with NO user scrolling.
  await page.goto("/?session=other");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  await expect(dot(page, "other")).toHaveCount(0, { timeout: 10000 });
});

// (2) REACTIVE: a session that finishes WHILE the user is watching it at the
// bottom must not leave a lingering dot. Before the fix the busy→idle transition
// armed the dot server-side with nothing to clear it client-side until the user
// scrolled or reopened; the reactive createEffect now acks it at the bottom.
test("a session finishing while watched at the bottom clears the dot", async ({ page }) => {
  await page.setViewportSize(VP);
  await page.goto("/?session=other");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  // Glue deterministically to the tail so following() && nearBottom() hold when
  // the turn completes (the reactive ack's precondition).
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  // Confirm the tail-glue took via geometry. `other` is idle here (pre-prompt),
  // so the .chat-live pill is hidden by the `&& working()` gate (419ea39 — see
  // scroll-follow.spec.ts expectFollowingTail) even though following=true; the
  // bottom geometry + absent "↓ Latest" button prove following && nearBottom(),
  // which is exactly the reactive ack's precondition.
  await expect.poll(
    async () =>
      page.locator(".chat-scroll").evaluate((e: HTMLElement) =>
        e.scrollHeight - e.scrollTop - e.clientHeight < 24 ? 1 : 0,
      ),
    { timeout: 5000 },
  ).toBe(1);
  await expect(page.locator("button.jump")).toHaveCount(0);

  // Prompt the session we are watching → busy (shimmer) → idle. The busy→idle
  // transition arms the dot server-side; the reactive effect acks it at the
  // bottom before it can linger.
  await promptSession(page, "other", "unread-dot reactive probe");
  // Wait for the turn to settle (the fixture's standard completion marker), then
  // the dot must be gone — cleared by the reactive ack, not by any scrolling.
  await expect(page.getByText(/Done\. Updated/).first()).toBeVisible({ timeout: 15000 });
  await expect(dot(page, "other")).toHaveCount(0, { timeout: 10000 });
});

// (3) GUARD — opening a session restored to a MID-HISTORY read anchor must NOT
// clear the dot: the user has not caught up, so "finished — not yet viewed" must
// remain. maybeRestore's anchor branch (ChatView.tsx:524-552) deliberately does
// NOT ack, and following()/nearBottom() are both false there (blocking the
// reactive ack effect at ~:626-631 and onScrolled's ack path).
//
// This was previously `test.skip`: the anchor branch could not run
// deterministically because maybeRestore's "defer until the snapshot arrives"
// guard keyed off object truthiness (`if (!sm())`), but openSession
// (sync/actions.ts) pre-initializes the message slot to a truthy-but-empty
// {order:[],byId:{}} the instant a session is selected — so on a fresh
// `/?session=…` load the guard did NOT defer, `order.includes(anchor)` was false
// on the empty order, the valid anchor was misclassified as "stale", the
// bottom-pin (acking) branch ran instead, and `restoredFor` was set before the
// staleness check so the later RO retry never honored the anchor. Fixed by
// P1-WEB-007: the defer is now keyed off `sm()?.order?.length`, so it waits while
// the snapshot is empty and proceeds once messages have landed.
//
// Strategy (real user flow — no localStorage surgery): build an overflowing
// transcript in `other` via real prompt_async turns, scroll UP so the debounced
// flushReadCursor writes a mid-history read anchor (the first message, pinned at
// the viewport top), switch to `demo`, prompt `other` (arms the dot while
// unselected), then reopen `other` and assert BOTH (a) it restored to the anchor
// (NOT at the bottom) and (b) the dot REMAINS visible.
test("opening a session at a mid-history anchor keeps the dot", async ({ page }) => {
  await page.setViewportSize(VP);
  // 1. Build an overflowing transcript in `other`. Each prompt_async turn
  //    appends a user + assistant message; 3 turns comfortably overflow the
  //    ~70px chat-scroll clientHeight at this 320px viewport. Serial turns
  //    (settle between each) avoid concurrent simulatePrompt on one session.
  await page.goto("/?session=other");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  for (let i = 0; i < 3; i++) {
    await promptSession(
      page,
      "other",
      `Transcript seed turn ${i + 1}.\nSecond line of context.\nThird line.\nFourth line.\nFifth line.`,
    );
    await waitForTurnSettled(page);
  }
  // 2. Scroll to the TOP. onScrolled fires (scrollTop != pinnedTop), following
  //    flips false (Live pill hides — proves the scroll event was processed and
  //    scheduleReadCursor armed its 400ms debounce), then flushReadCursor writes
  //    a read-up-to anchor on `other`'s FIRST message (bottommostRead = the row
  //    pinned at the viewport top). This is a mid-history anchor: content sits
  //    below the fold.
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = 0;
  });
  await expect(page.locator(".chat-live")).toHaveCount(0, { timeout: 3000 });
  // Wait out the 400ms debounce so the flush persists the anchor before nav.
  await page.waitForTimeout(600);
  // 3. Switch away to demo. The anchor persists (the session-switch effect
  //    cancels only the PENDING debounce, which already fired and wrote).
  await page.goto("/?session=demo");
  await waitForTree(page);
  // 4. Prompt `other` while it is NOT selected → busy→idle → markUnread → dot.
  await promptSession(page, "other", "unread-dot guard probe");
  await expect(dot(page, "other")).toBeVisible({ timeout: 15000 });
  // 5. Reopen `other` (fresh `/?session=…` load). maybeRestore now defers until
  //    the snapshot arrives (order non-empty — the P1-WEB-007 fix), then
  //    restores to the anchor: following=false, scrollTop at the anchor (top),
  //    NOT the bottom. The anchor branch does not ack; following/nearBottom are
  //    false so the reactive effect and onScrolled don't fire either → dot STAYS.
  await page.goto("/?session=other");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  // (a) Restored to the mid-history anchor, NOT pinned at the bottom (at least
  //     24px — the app's nearBottom threshold — shy of the max scroll).
  const notAtBottom = await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    return el.scrollTop < el.scrollHeight - el.clientHeight - 24;
  });
  expect(notAtBottom).toBe(true);
  // following is false at a mid-history anchor → Live pill absent.
  await expect(page.locator(".chat-live")).toHaveCount(0);
  // (b) The unread dot remains visible (no ack fired on the anchor branch).
  await expect(dot(page, "other")).toBeVisible();
});

// (4) P1-WEB-004 REGRESSION — the <400ms debounce-window loss. Before the fix,
// scrolling UP from the bottom and switching sessions FAST (before the 400ms
// debounce fired) lost the read position entirely: the switch effect cancelled
// the pending flush (which would have captured the scroll-up anchor), and by
// the time the effect ran the DOM had flipped to the entering session, so
// bottommostReadFromDom would have measured the wrong session. The fix captures
// the read position at arm-time (leading-edge throttled in scheduleReadCursor)
// and flushes that stash for the OUTGOING session on switch.
//
// SWITCH MECHANISM: the switch TO demo uses in-app popstate (ChatView stays
// mounted, the switch effect fires, the stash flush runs — this is the code path
// under test). The reopen uses page.goto instead: an in-app switch-back triggers
// openSession("other") which pre-initializes the message slot to empty, the
// browser clamps scrollTop to 0, onScrolled runs, and (when a prior serial-suite
// test left demo at a mid-history anchor, leaving following=false globally) the
// self-pin bail does NOT fire and the atBottom branch clears the anchor before
// maybeRestore can read it. page.goto gives a fresh mount (following starts true,
// pinnedTop starts -1 → self-pin bail protects the anchor) — the same reopen
// path the guard test (3) already relies on. The stash flush itself is verified
// DIRECTLY by reading localStorage right after the in-app switch to demo.
test("scroll-up read position survives a fast (<400ms) session switch (P1-WEB-004)", async ({ page }) => {
  await page.setViewportSize(VP);
  // 1. Build an overflowing transcript in `other` (same seed shape as the guard
  //    test). 3 turns comfortably overflow the ~70px chat clientHeight at 320px.
  await page.goto("/?session=other");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  // Clear any stale read anchor left on `other` by earlier serial-suite tests
  // (e.g. the guard test writes a mid-history anchor that persists in
  // localStorage). Scroll to the bottom so onScrolled's atBottom branch fires
  // clearReadAnchor + invalidates the stash → known bottom-pinned start state.
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator("button.jump")).toHaveCount(0, { timeout: 3000 });
  for (let i = 0; i < 3; i++) {
    await promptSession(
      page,
      "other",
      `P1-WEB-004 regression seed turn ${i + 1}.\nSecond line.\nThird line.\nFourth line.\nFifth line.`,
    );
    await waitForTurnSettled(page);
  }
  // 2. Scroll to the TOP. onScrolled fires → scheduleReadCursor's leading-edge
  //    captures the read position into armedCand SYNCHRONOUSLY (this is the fix).
  //    The "↓ Latest" button appearing proves following=false → onScrolled ran.
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = 0;
  });
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });
  // 3. Switch to demo FAST — NO waitForTimeout, so the 400ms debounce is still
  //    pending and is cancelled by the switch effect. Before the fix the anchor
  //    was never written. The fix flushes armedCand for `other` (outgoing) here.
  await switchSessionInApp(page, "demo");
  await waitForSessionSelected(page, "demo");
  // 4. DIRECT verification: the stash flush persisted a read anchor for `other`.
  //    This is the synchronous proof of the fix — independent of the reopen path.
  //    Before the fix this readAnchor call returns undefined (the pending flush
  //    was cancelled, nothing else wrote the anchor within the <400ms window).
  expect(await readAnchor(page, "other")).toBeDefined();
  // 5. Reopen `other` via a fresh page load (NOT in-app — see the switch-
  //    mechanism note above). Fresh mount → following starts true, pinnedTop
  //    starts -1 → self-pin bail protects the anchor through the empty-content
  //    window. maybeRestore defers until the snapshot arrives, then restores to
  //    the anchor written from the stash → NOT pinned at the bottom.
  await page.goto("/?session=other");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  // Before the fix: anchor lost → maybeRestore no-anchor branch → pinned to
  //    bottom. After the fix: anchor written from the stash → restored to top.
  await expect.poll(
    async () =>
      page.locator(".chat-scroll").evaluate((e: HTMLElement) =>
        e.scrollTop < e.scrollHeight - e.clientHeight - 24 ? 1 : 0,
      ),
    { timeout: 5000 },
  ).toBe(1);
});

// (5) P1-WEB-004 INVALIDATION GUARD — the return-to-bottom stash clear. The
// arm-time stash (armedCand) must be invalidated when the user scrolls back to
// the bottom, else a stale mid-history anchor would re-apply on the next switch.
// flushReadCursor's nearBottom branch and onScrolled's atBottom branch both clear
// the stash (the two clearReadAnchor sites). This test would FAIL if the stash
// were added WITHOUT the invalidation — it is the regression guard for the
// mandatory refinement that keeps the stash from going stale.
//
// SWITCH MECHANISM: same as test (4) — in-app popstate for the switch to demo
// (exercises the stash flush path), page.goto for the reopen (avoids the
// openSession-clears-messages onScrolled side effect).
test("scroll back to bottom invalidates the arm-time stash (P1-WEB-004)", async ({ page }) => {
  await page.setViewportSize(VP);
  await page.goto("/?session=other");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  // Clear stale read anchor from prior serial-suite tests (see test (4)'s comment).
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator("button.jump")).toHaveCount(0, { timeout: 3000 });
  for (let i = 0; i < 3; i++) {
    await promptSession(
      page,
      "other",
      `P1-WEB-004 invalidation seed turn ${i + 1}.\nSecond line.\nThird line.\nFourth line.\nFifth line.`,
    );
    await waitForTurnSettled(page);
  }
  // 1. Scroll UP — arms the stash (leading-edge capture). "↓ Latest" visible
  //    proves onScrolled ran and following=false.
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = 0;
  });
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });
  // 2. Scroll BACK to the bottom. onScrolled's atBottom branch fires →
  //    clearReadAnchor + (the fix) armedCand invalidated. "↓ Latest" vanishing
  //    proves the return-to-bottom scroll was processed.
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(page.locator("button.jump")).toHaveCount(0, { timeout: 3000 });
  // 3. Switch to demo in-app. The stash was invalidated, so the switch effect's
  //    stash flush finds armedCand===undefined and writes NO anchor.
  await switchSessionInApp(page, "demo");
  await waitForSessionSelected(page, "demo");
  // 4. DIRECT verification: `other` has no persisted anchor. Without the
  //    invalidation, the stale stash would have re-written it here.
  expect(await readAnchor(page, "other")).toBeUndefined();
  // 5. Reopen `other` via fresh page load. No anchor → maybeRestore's no-anchor
  //    branch pins to the bottom.
  await page.goto("/?session=other");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });
  // Without the invalidation, the stale stash would have written a mid-history
  // anchor → restored away from the bottom. With the fix, the stash was cleared
  // → no anchor → pinned at the bottom.
  await expect.poll(
    async () =>
      page.locator(".chat-scroll").evaluate((e: HTMLElement) =>
        e.scrollHeight - e.scrollTop - e.clientHeight < 24 ? 1 : 0,
      ),
    { timeout: 5000 },
  ).toBe(1);
});
