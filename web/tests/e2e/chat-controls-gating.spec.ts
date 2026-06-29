import { expect, test } from "@playwright/test";

// Regression guard for the ChatView tail/scroll control GATES.
//
// Two controls anchor at the bottom of `.chat-main` (the scroll viewport):
//
//   .chat-live — the "Live" pill, shown while glued to the live tail:
//     <Show when={following() && !focusMode() && messages().length > 0}>
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

// (1) Populated parent (demo): the Live pill and the Latest button are
//     mutually exclusive on the `following` signal. Glued to the tail the Live
//     pill is up and the button is absent; scrolling away flips them.
test("demo: Live pill and Latest button flip on following at the tail", async ({ page }) => {
  await page.setViewportSize(VP);
  await page.goto("/?session=demo");
  await expect(page.locator(".msg").first()).toBeVisible({ timeout: 10000 });

  // Glue to the tail deterministically (the app's onScrolled sets following=true
  // near the bottom). This is the RELIABLE glue pattern from scroll-follow.spec.ts's
  // focus-mode test — it deliberately avoids the detach-prone click-based re-glue.
  await page.locator(".chat-scroll").evaluate((el: HTMLElement) => {
    el.scrollTop = el.scrollHeight;
  });
  // following=true → Live pill is up, Latest button is absent.
  await expect(page.locator(".chat-live")).toBeVisible({ timeout: 5000 });
  await expect(page.locator("button.jump")).toHaveCount(0);

  // Scroll away from the tail: following flips false → Latest button appears,
  // Live pill disappears. Proves BOTH gates read `following`.
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
  await page.goto("/?session=other");
  // Confirm the right session loaded (not a stale demo view) before asserting.
  await expect(page.locator(".main-title")).toContainText("Another root", { timeout: 10000 });

  // An empty session has messages().length === 0 from first render, so neither
  // gate's `messages().length > 0` term can ever be satisfied — regardless of
  // following().
  await expect(page.locator(".chat-live")).toHaveCount(0);
  await expect(page.locator("button.jump")).toHaveCount(0);
});

// (3) Child/subagent session (sub): the auto-follow controls now RENDER.
//     This guards the REMOVAL of the `!isChild()` term on both gates: `sub` HAS
//     one message (so `messages().length > 0` is true) and is a normal scroll
//     surface, so exactly one of the Live pill / Latest button must render on
//     the `following` signal, exactly like a parent session. The controls are
//     anchored to `.chat-main` (the scroll viewport), NOT the composer, so they
//     position correctly even though the child view has no composer.
test("sub: the Live pill / Latest button render in a child/subagent session", async ({ page }) => {
  await page.goto("/?session=sub");
  // The child-note replaces the composer for subagent sessions; it only renders
  // once isChild() has resolved true (state.sessions[sub].parentID synced in),
  // so waiting for it guarantees the session has settled before we assert on
  // the controls. (subsession.spec.ts asserts this same element carries the
  // "disabled for subagent" notice.)
  await expect(page.locator(".composer-child-note")).toBeVisible({ timeout: 10000 });

  // Exactly one of the Live pill / Latest button renders — they are mutually
  // exclusive on `following`. `sub` is a single short message at rest at the
  // default viewport, so following=true (its initial value) and the Live pill is
  // the one that's up; the Latest button is absent.
  await expect(page.locator(".chat-live, button.jump")).toHaveCount(1);
  await expect(page.locator(".chat-live")).toBeVisible();
  await expect(page.locator("button.jump")).toHaveCount(0);
});
