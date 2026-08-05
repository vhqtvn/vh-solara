// @vitest-environment jsdom
//
// Tests for rewriteImageSrcs — the detached-HTML image-src rewriter applied to
// server-rendered /vh/render HTML before it is cached or inserted into the DOM.
//
// This is the FOURTH render surface (after one-shot md.ts, streaming streamMd.ts,
// and the marked renderer.image). The classifier must be consistent across all
// four: the same src that gets proxied in the marked renderer must also get
// proxied here, and the same src that gets neutralized must also be neutralized.

import { describe, expect, it } from "vitest";
import { rewriteImageSrcs } from "../../src/lib/markdownEnhance";

describe("rewriteImageSrcs", () => {
  // window.location.origin in jsdom is "http://localhost:3000" by default.
  // classifyImageSrc uses window.location.origin when selfOrigin is omitted,
  // so we frame our test URLs relative to that known origin.

  it("rewrites cross-origin http(s) img src to /vh/img proxy", () => {
    const html = '<p><img src="https://cdn.example.com/x.png" alt="x"></p>';
    const out = rewriteImageSrcs(html);
    expect(out).toContain("/vh/img?url=");
    expect(out).toContain(encodeURIComponent("https://cdn.example.com/x.png"));
    expect(out).not.toContain('src="https://cdn.example.com');
  });

  it("keeps same-origin http(s) img src unchanged", () => {
    // jsdom default origin is http://localhost:3000
    const html = '<img src="http://localhost:3000/assets/a.png" alt="a">';
    const out = rewriteImageSrcs(html);
    expect(out).toContain('src="http://localhost:3000/assets/a.png"');
    expect(out).not.toContain("/vh/img");
  });

  it("keeps root-relative img src unchanged", () => {
    const html = '<img src="/assets/a.png" alt="a">';
    const out = rewriteImageSrcs(html);
    expect(out).toContain('src="/assets/a.png"');
  });

  it("rewrites relative img src to /vh/code/raw (project file)", () => {
    // A relative src is a project-file reference the SPA does NOT serve; it
    // would 404 against the document origin. rewriteImageSrcs routes it through
    // the daemon's /vh/code/raw endpoint (same-origin, contained, open-project-
    // gated). projectDir() is "" in the test env, so assert endpoint + encoded
    // path, not the dir= value.
    const html = '<img src="assets/a.png" alt="a">';
    const out = rewriteImageSrcs(html);
    expect(out).toContain("/vh/code/raw?");
    expect(out).toContain("path=" + encodeURIComponent("assets/a.png"));
    // The raw relative src must NOT survive.
    expect(out).not.toContain('src="assets/a.png"');
  });

  it("rewrites inline attachment relative src to /vh/code/raw", () => {
    // The substituted form a RENDERED message carries (never vh-attach:): a
    // project-relative path under .vh-solara/sessions/<sid>/attachments/.
    const attach = ".vh-solara/sessions/ses_abc/attachments/1700000000000_shot.png";
    const html = `<img src="${attach}" alt="shot.png">`;
    const out = rewriteImageSrcs(html);
    expect(out).toContain("/vh/code/raw?");
    expect(out).toContain("path=" + encodeURIComponent(attach));
    expect(out).not.toContain(`src="${attach}"`);
    // alt is preserved for accessibility.
    expect(out).toContain('alt="shot.png"');
  });

  it("keeps vh-attach: img src unchanged", () => {
    const html = '<img src="vh-attach:abc123" alt="a">';
    const out = rewriteImageSrcs(html);
    expect(out).toContain('src="vh-attach:abc123"');
  });

  it("keeps data:image/png src unchanged", () => {
    const html = '<img src="data:image/png;base64,iVBOR" alt="a">';
    const out = rewriteImageSrcs(html);
    expect(out).toContain('src="data:image/png;base64,iVBOR"');
  });

  it("neutralizes data:image/svg+xml (removes src)", () => {
    const html = '<img src="data:image/svg+xml;base64,PHN2Zz4=" alt="a">';
    const out = rewriteImageSrcs(html);
    expect(out).not.toContain("data:image/svg");
    expect(out).not.toContain('src="');
    expect(out).toContain("alt");
  });

  it("neutralizes javascript: src (removes src)", () => {
    const html = '<img src="javascript:alert(1)" alt="x">';
    const out = rewriteImageSrcs(html);
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain('src="');
  });

  it("neutralizes file: src", () => {
    const html = '<img src="file:///etc/passwd" alt="x">';
    const out = rewriteImageSrcs(html);
    expect(out).not.toContain("file:");
    expect(out).not.toContain('src="');
  });

  it("neutralizes protocol-relative //host src", () => {
    const html = '<img src="//cdn.example.com/x.png" alt="x">';
    const out = rewriteImageSrcs(html);
    expect(out).not.toContain("//cdn.example.com");
    expect(out).not.toContain('src="');
  });

  it("handles multiple images in one HTML block independently", () => {
    const html = `<p>
      <img src="https://cdn.example.com/a.png" alt="a">
      <img src="/local.png" alt="b">
      <img src="javascript:evil()" alt="c">
    </p>`;
    const out = rewriteImageSrcs(html);
    expect(out).toContain("/vh/img?url=" + encodeURIComponent("https://cdn.example.com/a.png"));
    expect(out).toContain('src="/local.png"');
    expect(out).not.toContain("javascript:");
  });

  it("fast-paths HTML with no <img tag (returns input unchanged)", () => {
    const html = "<p>no images here</p>";
    // Identity check — not just equal content.
    const out = rewriteImageSrcs(html);
    expect(out).toBe(html);
  });

  it("fast-paths empty string", () => {
    expect(rewriteImageSrcs("")).toBe("");
  });

  it("handles img without src attribute (structural img, leave as-is)", () => {
    const html = '<img alt="placeholder" width="100">';
    const out = rewriteImageSrcs(html);
    expect(out).toContain('alt="placeholder"');
    expect(out).toContain('width="100"');
  });

  it("preserves surrounding HTML structure (paragraphs, classes)", () => {
    const html = '<div class="msg"><p class="prose">text</p><img src="https://cdn.example.com/x.png" alt="x"></div>';
    const out = rewriteImageSrcs(html);
    expect(out).toContain('class="msg"');
    expect(out).toContain('class="prose"');
    expect(out).toContain("/vh/img?url=");
  });
});
