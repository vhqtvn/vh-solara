import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Isolated regression spec for the composer caret/mirror drift bug. The
// transparent <textarea class="composer-text"> and the highlight
// <div class="composer-mirror"> MUST keep identical content (clientWidth) so
// glyphs wrap at the same column and the caret never drifts off the highlighted
// glyph. Once the prompt overflows the composer's max-height:200px, overflow-y:
// auto shows a space-taking scrollbar INSIDE the textarea but never inside the
// overflow:hidden mirror, so the two layers wrap at different points and drift
// apart (observed ~10px/line-box, can compound across many lines).
//
// The fix is a single `scrollbar-gutter: stable` declaration on the SHARED
// `.composer-mirror, .composer-text` rule (reserves the gutter on BOTH layers),
// and THIS spec is its gate.
//
// Why a dedicated spec file (not a describe block inside composer.spec.ts):
// Playwright forbids test.use({ launchOptions }) inside a test.describe group
// (launchOptions forces a new worker, so it is only allowed at file/config top
// level). A FILE-scoped test.use inside composer.spec.ts would force all six
// pre-existing composer specs to run with visible scrollbars (~10px narrower
// layout); the e2e suite is serial over one shared fixture backend, so we
// isolate the override to this single-test file instead.
test.use({ launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

test("composer textarea and mirror keep equal clientWidth once the prompt overflows max-height", async ({ page }) => {
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Demo session/ }).click();
  const ta = page.getByPlaceholder(/Message/);

  // Synthetic filler ONLY. Content is irrelevant — the assertion depends solely
  // on the text being long enough to overflow max-height:200px so overflow-y:
  // auto shows a space-taking scrollbar inside the textarea. Real prompt text
  // MUST NOT be used: this config captures trace/screenshot/video on failure
  // (playwright.config.ts) which CI may upload, and it would also land in the
  // committed spec.
  await ta.fill("lorem ipsum dolor sit amet ".repeat(40));
  await page.waitForTimeout(60);

  const [t, m, sb] = await page.evaluate(() => {
    const ta = document.querySelector(".composer-text") as HTMLElement;
    const mi = document.querySelector(".composer-mirror") as HTMLElement;
    return [ta.clientWidth, mi.clientWidth, ta.offsetWidth - ta.clientWidth];
  });

  // Guard: fail loudly if scrollbars take no space in this build (e.g. someone
  // re-hides them via --hide-scrollbars, or a platform switches to overlay
  // scrollbars). Otherwise the parity check below is vacuously true and the bug
  // is invisible — this is exactly the default-headless-Chromium trap this spec
  // exists to defeat.
  expect(sb, "textarea must be showing a space-taking scrollbar").toBeGreaterThan(0);

  // The two layers MUST share a content width. Before the fix the textarea's
  // scrollbar steals width that the overflow:hidden mirror never loses, so
  // t < m; after scrollbar-gutter:stable on the shared rule both reserve the
  // gutter and t === m whether or not a scrollbar is currently showing.
  expect(t, "textarea clientWidth must equal mirror clientWidth").toBe(m);
});
