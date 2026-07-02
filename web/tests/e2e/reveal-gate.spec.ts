import { expect, test } from "@playwright/test";

// Regression guard for the ChatView VISUAL REVEAL GATE (.chat-content opacity).
//
// The reveal gate (web/src/styles.css: `.chat-content { opacity: 0 }` +
// `.chat-content.ready { opacity: 1 }`; web/src/components/ChatView.tsx:
// `revealed() = ready() && (delivered() || messageFailed())`) hides the
// transcript at opacity:0 until Slice-C async hydration completes
// (messages.loaded / delivered()), so a large session never visibly populates
// top-down while already on screen.
//
// Playwright's `toBeVisible` does NOT treat opacity:0 as not-visible — it only
// checks the element's box model + that it's not display:none/visibility:hidden.
// So a reveal-gate regression (e.g. `.ready` never applied, or `revealed()`
// resolving true too early) would NOT be caught by any existing spec, which is
// why this one exists. It asserts the ACTUAL computed opacity via
// `getComputedStyle` (which DOES see opacity:0), plus the `.ready` class as a
// belt-and-suspenders boolean signal.
//
// The production fixture (pkg/fixtures/opencode.go) returns messages instantly,
// so the partial-hydration window can't be observed there. A dedicated "slow"
// session holds its full-message GET for a bounded window (~900ms, see
// handleSession's slow-hydration branch) so the aggregator streams a partial
// snapshot (messagesLoaded=false → gate closed) and then fills via deltas +
// messages.loaded (gate opens). This spec observes both states.

test("slow session: .chat-content hides at opacity:0 during hydration then reveals at opacity:1", async ({
  page,
}) => {
  await page.goto("/?session=slow");
  const content = page.locator(".chat-content");

  // Wait for the element to attach. Deliberately NOT `toBeVisible` — it cannot
  // see opacity:0, which is the exact blind spot this spec closes.
  await content.waitFor({ state: "attached", timeout: 10000 });

  // (1) Hidden state — during the ~900ms partial-hydration window the gate is
  //     closed: computed opacity is "0" and the .ready class is absent. The
  //     element attaches at opacity:0 (revealed() is false until delivered()),
  //     so a fast first poll catches it before the background fetch completes.
  await expect.poll(
    async () => content.evaluate((el: HTMLElement) => getComputedStyle(el).opacity),
    { timeout: 5000, intervals: [50, 100, 200] },
  ).toBe("0");
  await expect(content).not.toHaveClass(/\bready\b/);

  // (2) Revealed state — once messages.loaded lands the gate opens: .ready is
  //     applied (instant, no transition ambiguity) and the 0.12s opacity
  //     transition settles to "1".
  await expect(content).toHaveClass(/\bready\b/, { timeout: 10000 });
  await expect.poll(
    async () => content.evaluate((el: HTMLElement) => getComputedStyle(el).opacity),
    { timeout: 3000 },
  ).toBe("1");
});
