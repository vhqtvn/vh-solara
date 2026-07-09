import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Regression guard for the ChatView tail/scroll control GATES.
//
// Two controls anchor at the bottom of `.chat-main` (the scroll viewport):
//
//   .chat-live — the "Live" pill, shown while glued to the live tail AND while a
//     turn is live (busy/retrying):
//     <Show when={following() && working() && !focusMode() && messages().length > 0}>
//     The `&& working()` gate (commit 419ea39) hides the pill on finished/idle
//     turns — the idle demo/other/sub fixtures all have working()=false, so the
//     pill never shows there; tail-following is asserted via geometry instead
//     (expectFollowingTail below), and the pill itself is exercised under a real
//     busy turn in test (3) and in scroll-follow.spec.ts test 11.
//
//   button.jump — the "↓ Latest" button, shown after scrolling away from the
//     tail:
//     <Show when={!following() && !focusMode() && messages().length > 0}>
//
// Both are nested inside <Show when={!props.draft}>, so a draft session never
// renders either (draft is gated one level up and is not exercised here).
//
// This spec pins the OTHER three gates across the three fixture sessions served
// by the Go fixture backend (pkg/fixtures/opencode.go):
//
//   demo — populated root session (6 messages, no parent). Guards the baseline:
//          the controls DO render for a normal populated parent, and flip on
//          `following`. Sibling scroll-follow.spec.ts covers this session's
//          occlusion/focus-mode regressions in depth; we re-assert only the
//          presence/absence matrix here.
//
//   other — empty root session (0 messages). BOTH controls absent. Guards the
//           `messages().length > 0` term on both gates: without it, the Live
//           pill or Latest button would paint over an empty transcript
//           (depending on following(), one of them always would).
//
//   sub — child/subagent session (parentID="demo", 1 message). BOTH controls
//         now RENDER. The `!isChild()` term was REMOVED so the auto-follow
//         controls are reachable in a subagent view too (a child session has no
//         composer, but these controls are anchored to the scroll viewport, not
//         the composer — see the anchor comment in ChatView.tsx ~:1390). `sub`
//         HAS a message (so `messages().length > 0` is satisfied) and is a
//         normal scroll surface, so exactly one of the Live pill / Latest button
//         renders on the `following` signal, exactly like a parent.
//
// Each test navigates directly to its session (/?session=<id>), so they don't
// perturb each other regardless of order — important because the e2e suite is
// serial (workers:1, fullyParallel:false) and shares one mutable fixture backend.

// The demo transcript overflows `.chat-scroll` at this viewport
// (scrollHeight ~1450 vs clientHeight ~70), so we can flip `following` by
// scrolling. The other two sessions don't depend on scrolling.
const VP = { width: 400, height: 320 };

// Geometry-first "following the tail" check — mirrors scroll-follow.spec.ts's
// expectFollowingTail. The idle demo/other fixtures have working()=false, so the
// .chat-live pill is hidden by the `&& working()` gate (419ea39) even at the tail;
// following=true is proved here via bottom geometry + the absent "↓ Latest" button.
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

// Prompt a session via the same route the composer uses (POST prompt_async), run
// in-page so the request is same-origin and carries the X-VH-CSRF header the
// state-changing-request guard requires. A prompt containing [[stall]] keeps the
// session busy ~5s (no assistant message), giving a stable window to assert a
// control gated on working() (used in test 3 — a child session has no composer to
// type into, so we drive its busy state through the API).
async function promptSession(page: import("@playwright/test").Page, id: string, text: string) {
  await page.evaluate(
    async ({ id, text }) => {
      const res = await fetch(`/oc/session/${id}/prompt_async`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-VH-CSRF": "1" },
        body: JSON.stringify({ parts: [{ type: "text", text }] }),
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`prompt_async ${id} -> ${res.status}`);
      }
    },
    { id, text },
  );
}

// (1) Populated parent (demo): the controls flip on `following`. The `&& working()`
//     gate (419ea39) hides the Live pill on the idle demo, so the tail state is
//     asserted via geometry + the absent "↓ Latest" button; scrolling away flips
//     following=false and surfaces the button. The pill's OWN `following` gate
//     under working()=true is covered in scroll-follow.spec.ts test 11 (it needs a
//     busy turn, impossible on the static idle demo here).
test("demo: Latest button flips on following at the tail (Live pill gated on working)", async ({ page }) => {
  await page.setViewportSize(VP);
  await page.goto(projectUrl("/?session=demo"));
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });

  // Glue to the tail deterministically (the app's onScrolled sets following=true
  // near the bottom). This is the RELIABLE glue pattern from scroll-follow.spec.ts's
  // focus-mode test — it deliberately avoids the detach-prone click-based re-glue.
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  // following=true. The idle demo's Live pill is HIDDEN by the `&& working()` gate
  // (419ea39 — the pill renders only while a turn is live), so prove following=true
  // via bottom geometry + the absent "↓ Latest" button (expectFollowingTail).
  await expectFollowingTail(page);

  // Scroll away from the tail: following flips false → "↓ Latest" appears. The
  // Live pill stays absent (it needs following && working; following is now false),
  // proving the pill's `following` gate reads the signal even when hidden by working.
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = 0;
  });
  await expect(page.locator("button.jump")).toBeVisible({ timeout: 3000 });
  await expect(page.locator(".chat-live")).toHaveCount(0);
});

// (2) Empty root session (other): NEITHER control renders. Guards the
//     `messages().length > 0` term on both gates — without it the Live pill or
//     Latest button would render over an empty transcript.
test("other: both Live pill and Latest button absent for an empty session", async ({ page }) => {
  await page.goto(projectUrl("/?session=other"));
  // Confirm the right session loaded (not a stale demo view) before asserting.
  await expect(page.locator(".main-title")).toContainText("Another root", { timeout: 10000 });

  // An empty session has messages().length === 0 from first render, so neither
  // gate's `messages().length > 0` term can ever be satisfied — regardless of
  // following().
  await expect(page.locator(".chat-live")).toHaveCount(0);
  await expect(page.locator("button.jump")).toHaveCount(0);
});

// (3) Child/subagent session (sub): the auto-follow controls RENDER in a child.
//     This guards the REMOVAL of the `!isChild()` term on both gates. Under the
//     `&& working()` gate (419ea39) an idle single-message child at the tail shows
//     NEITHER cue (pill needs working; button needs !following) — a vacuous count:0
//     indistinguishable from isChild still suppressing both. So we drive a real busy
//     turn (a subagent working while you watch it is exactly the live scenario the
//     pill exists for) via the API — a child has no composer to type into — and
//     assert the Live pill renders in the child: following (never scrolled) &&
//     working (busy) && !isChild. The controls are anchored to `.chat-main` (the
//     scroll viewport), NOT the composer, so they position correctly without one.
test("sub: the Live pill renders in a working child/subagent session", async ({ page }) => {
  await page.goto(projectUrl("/?session=sub"));
  // The child-note replaces the composer for subagent sessions; it only renders
  // once isChild() has resolved true (state.sessions[sub].parentID synced in),
  // so waiting for it guarantees the session has settled before we assert on
  // the controls. (subsession.spec.ts asserts this same element carries the
  // "disabled for subagent" notice.)
  await expect(page.locator(".composer-child-note")).toBeVisible({ timeout: 10000 });

  // Drive a busy turn so working()=true. [[stall]] holds the session busy ~5s
  // (no assistant message), a stable window to assert the pill. `sub` is a
  // non-scrollable single-message child at rest (following=true), so the only
  // cue reachable to non-vacuously prove the !isChild() removal is the Live pill.
  await promptSession(page, "sub", "[[stall]] subagent controls probe");
  await expect(page.locator(".working-text")).toBeVisible({ timeout: 8000 });

  // The Live pill renders in the child: following && working && !focusMode &&
  // messages>0, AND (the point) the old !isChild() term no longer suppresses it.
  // The "↓ Latest" button stays absent (following=true; we never scrolled).
  await expect(page.locator(".chat-live")).toBeVisible({ timeout: 3000 });
  await expect(page.locator("button.jump")).toHaveCount(0);
});
