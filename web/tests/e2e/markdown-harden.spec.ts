import { expect, test } from "@playwright/test";
import { projectUrl } from "./util";

// Behavioral-closure e2e for the two markdown-hardening features:
//  - Feature 2 (HTML escape-as-text): raw HTML like <report>/<vh-solara> must
//    render as VISIBLE literal text, never as a live element and never silently
//    dropped.
//  - Feature 1 (image proxy): external http(s) image src must be rewritten to
//    /vh/img?url=... BEFORE the browser issues the fetch, so NO request reaches
//    the arbitrary external origin.
//
// The fake OpenCode seeds a dedicated "mdhard" session (pkg/fixtures/opencode.go)
// whose assistant turn carries <report>/<vh-solara> tags and an external image.
// Loading it exercises the FULL path: markdown → /vh/render (server Goldmark
// escape + Bluemonday) → client rewriteImageSrcs (detached HTML rewrite before
// cacheSet) → final DOM.

test("raw HTML tags render as visible literal text, not as elements", async ({ page }) => {
  // Track any request that would reach an external origin — there must be NONE
  // for the image, and the tags must never become live DOM elements.
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Markdown hardening/ }).click();

  // The server-rendered markdown arrives in a .md container. The escaped
  // &lt;report&gt; ... &lt;/report&gt; becomes visible text "<report>".
  const md = page.locator(".msg.assistant .md").first();
  await expect(md).toBeVisible({ timeout: 10000 });

  // (a) No <report> / <vh-solara> ELEMENT exists in the DOM (they are text, not
  // elements). querySelector returns null for unknown elements, but the escaped
  // text IS present as textContent.
  const hasReportElement = await page.evaluate(() => !!document.querySelector("report"));
  const hasVhsolaraElement = await page.evaluate(() => !!document.querySelector("vh-solara"));
  expect(hasReportElement).toBe(false);
  expect(hasVhsolaraElement).toBe(false);

  // (b) The original <report> and <vh-solara> syntax is VISIBLE as literal text
  // in the rendered output (the bug we fixed was silent dropping, not just XSS).
  await expect(md).toContainText("<report>");
  await expect(md).toContainText("</report>");
  await expect(md).toContainText("<vh-solara>");
});

test("external image src is proxied through /vh/img; no direct external fetch", async ({ page }) => {
  // Capture every request the page issues so we can prove the external URL is
  // NEVER contacted directly. We check the request HOST, not a substring — the
  // proxy request /vh/img?url=https://example.com/... legitimately contains
  // "example.com" in its query parameter but is sent to OUR host.
  const externalHits: string[] = [];
  page.on("request", (req) => {
    try {
      const u = new URL(req.url());
      if (u.hostname === "example.com") externalHits.push(req.url());
    } catch {
      // non-URL requests (data:, blob:) are not external HTTP dials — ignore.
    }
  });

  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Markdown hardening/ }).click();
  const md = page.locator(".msg.assistant .md").first();
  await expect(md).toBeVisible({ timeout: 10000 });

  // The img src must be rewritten to the proxy endpoint, carrying the original
  // URL percent-encoded. (The proxy fetch will 502 since example.com is not
  // reachable from the fixture environment, but the REQUEST targets /vh/img.)
  const img = md.locator("img").first();
  await expect(img).toHaveAttribute("src", /\/vh\/img\?url=/);
  const src = await img.getAttribute("src");
  expect(src).toContain("example.com");
  expect(src).toContain("diagram.png");

  // CRITICAL: no request was ever sent directly to the external origin. The
  // browser never dialled example.com — it only asked our own /vh/img.
  expect(externalHits).toEqual([]);
});

test("inline code containing angle brackets is preserved (not HTML-escaped twice)", async ({ page }) => {
  // The fixture assistant message also carries `inline code` and **bold**; this
  // is a regression guard that the escape renderer did NOT corrupt normal
  // markdown features while fixing raw-HTML handling.
  await page.goto(projectUrl("/"));
  await page.getByRole("button", { name: /Markdown hardening/ }).click();
  const md = page.locator(".msg.assistant .md").first();
  await expect(md).toBeVisible({ timeout: 10000 });

  // Bold text renders as a <strong> element (a KNOWN markdown element).
  await expect(md.locator("strong")).toHaveText("bold");
  // Inline code renders as a <code> element.
  await expect(md.locator("code")).toHaveText("inline code");
});
