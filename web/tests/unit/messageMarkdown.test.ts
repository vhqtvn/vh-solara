// @vitest-environment jsdom
//
// Client-side tests for the shared message-markdown policy (messageMarkdown.ts).
//
// These verify the TWO hardening requirements:
//   (a) No source-created HTML element/attribute exists in the rendered output.
//   (b) The original raw-HTML syntax (<report>, <vh-solara>, etc.) is visibly
//       present as escaped literal text (&lt;report&gt;) — NOT silently dropped.
//
// Proving "no <script> executed" is INSUFFICIENT: the original bug was silent
// DROPPING. These tests explicitly check that the escaped text IS present.

import { describe, expect, it } from "vitest";
import {
  messageMarked,
  escapeHtml,
  classifyImageSrc,
  normalizeAttrs,
  RASTER_DATA_IMG,
} from "../../src/lib/messageMarkdown";
import { rewriteImageSrcs } from "../../src/lib/markdownEnhance";
import { renderStreamMd } from "../../src/lib/md";
import { StreamMd } from "../../src/lib/streamMd";

// --- escapeHtml helper ---------------------------------------------------
describe("escapeHtml", () => {
  it("escapes the five XML-mandated characters", () => {
    expect(escapeHtml(`<a href="x" title='y'>&`)).toBe(
      "&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;",
    );
  });
  it("leaves non-HTML text unchanged", () => {
    expect(escapeHtml("plain text 123")).toBe("plain text 123");
  });
  it("is idempotent-safe on already-escaped ampersands", () => {
    // Double-escaping an already-escaped entity is expected (we escape the &).
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});

// --- Shared Marked instance: escape renderer -----------------------------
describe("messageMarked — raw HTML escaped as visible literal text", () => {
  // Each case checks BOTH conditions:
  //   (a) the raw (unescaped) tag does NOT appear as an active element, AND
  //   (b) the escaped literal text IS present.
  const cases: { name: string; input: string; rawMust: string; escapedMust: string }[] = [
    // Custom tags — the operator-facing bug.
    { name: "inline <report>", input: "see <report> here", rawMust: "<report>", escapedMust: "&lt;report&gt;" },
    { name: "inline <vh-solara>", input: "see <vh-solara> here", rawMust: "<vh-solara>", escapedMust: "&lt;vh-solara&gt;" },
    { name: "closing </report>", input: "text </report> end", rawMust: "</report>", escapedMust: "&lt;/report&gt;" },

    // Block HTML.
    { name: "block div", input: "<div>content</div>", rawMust: "<div>", escapedMust: "&lt;div&gt;" },
    { name: "block script", input: "<script>alert(1)</script>", rawMust: "<script>", escapedMust: "&lt;script&gt;" },

    // Comments / declarations / PI / CDATA.
    { name: "comment", input: "<!-- secret -->", rawMust: "<!--", escapedMust: "&lt;!--" },
    { name: "declaration DOCTYPE", input: "<!DOCTYPE html>", rawMust: "<!DOCTYPE", escapedMust: "&lt;!DOCTYPE" },
    { name: "processing instruction", input: "<?xml version='1.0'?>", rawMust: "<?xml", escapedMust: "&lt;?xml" },
    { name: "CDATA", input: "<![CDATA[data]]>", rawMust: "<![CDATA[", escapedMust: "&lt;![CDATA[" },

    // Malformed / incomplete.
    { name: "unterminated div", input: "text <div more text", rawMust: "<div", escapedMust: "&lt;" },
    { name: "bare closing", input: "text </ more", rawMust: "</ more", escapedMust: "&lt;/" },
    { name: "tag with space", input: "see < tag > here", rawMust: "< tag", escapedMust: "&lt;" },
    { name: "incomplete comment", input: "<!-- not closed", rawMust: "<!--", escapedMust: "&lt;!--" },
  ];

  for (const tc of cases) {
    it(tc.name, () => {
      const out = messageMarked.parse(tc.input, { async: false }) as string;
      // (a) No active element/attribute from the source.
      expect(out).not.toContain(tc.rawMust);
      // (b) Escaped literal text IS present (not dropped).
      expect(out).toContain(tc.escapedMust);
    });
  }
});

// --- Preservation of legitimate markdown features ------------------------
describe("messageMarked — markdown features with angle brackets preserved", () => {
  it("inline code with HTML syntax is preserved as code (escaped, not double-escaped)", () => {
    const out = messageMarked.parse("use `<foo>` syntax", { async: false }) as string;
    expect(out).toContain("<code>");
    expect(out).toContain("&lt;foo&gt;");
  });

  it("fenced code with HTML syntax is preserved as code", () => {
    const out = messageMarked.parse("```\n<div>test</div>\n```", { async: false }) as string;
    expect(out).toContain("<pre");
    expect(out).toContain("&lt;div&gt;");
  });

  it("autolink <https://...> renders as a link (not escaped)", () => {
    const out = messageMarked.parse("see <https://example.com>", { async: false }) as string;
    expect(out).toContain("href");
    expect(out).toContain("example.com");
  });

  it("list structure is preserved when items contain HTML-like text", () => {
    const out = messageMarked.parse("- item <report>\n- item two", { async: false }) as string;
    expect(out).toContain("<ul");
    expect(out).toContain("<li");
    expect(out).toContain("&lt;report&gt;");
  });

  it("blockquote with HTML-like text is preserved", () => {
    const out = messageMarked.parse("> quoted <report>", { async: false }) as string;
    expect(out).toContain("<blockquote");
    expect(out).toContain("&lt;report&gt;");
  });

  it("table structure is preserved", () => {
    const out = messageMarked.parse("| a | b |\n|---|---|\n| <report> | d |", { async: false }) as string;
    expect(out).toContain("<table") || expect(out).toContain("<th") || expect(out).toContain("<td");
    expect(out).toContain("&lt;report&gt;");
  });
});

// --- Settled / streaming parity ------------------------------------------
// Both the one-shot renderer (renderStreamMd) and the streaming engine
// (StreamMd) must produce the SAME escaped output for raw HTML — the escape
// policy must not diverge between paths.
describe("settled/streaming parity — raw HTML escaped in both paths", () => {
  const inputs = [
    "see <report> here",
    "<vh-solara>block</vh-solara>",
    "<!-- comment -->",
    "<script>alert(1)</script>",
    "use `<code>` here",
  ];

  for (const input of inputs) {
    it(`parity for: ${input.slice(0, 40)}`, () => {
      // One-shot (renderStreamMd).
      const oneShot = renderStreamMd(input);

      // Streaming (StreamMd — pushes the full text at once).
      const host = document.createElement("div");
      const stream = new StreamMd(host);
      stream.push(input);
      const streamed = host.innerHTML;

      // Both must contain the escaped literal (not the raw tag).
      // Check a sample: if input contains <report>, both must have &lt;report&gt;.
      if (input.includes("<report>")) {
        expect(oneShot).toContain("&lt;report&gt;");
        expect(streamed).toContain("&lt;report&gt;");
      }
      if (input.includes("<script>")) {
        expect(oneShot).not.toContain("<script>");
        expect(streamed).not.toContain("<script>");
        expect(oneShot).toContain("&lt;script&gt;");
        expect(streamed).toContain("&lt;script&gt;");
      }
      if (input.includes("<vh-solara>")) {
        expect(oneShot).toContain("&lt;vh-solara&gt;");
        expect(streamed).toContain("&lt;vh-solara&gt;");
      }
    });
  }
});

// --- Raw-block walkTokens gap fix ----------------------------------------
// Inner angle fragments inside an unterminated raw block must get normal
// escaping (the walkTokens fix clears Text.escaped:true).
describe("walkTokens fix — raw-block inner text escaped", () => {
  it("clears escaped:true so inner text is not emitted raw", () => {
    // `<kbd>Ctrl < notag</kbd>` — marked sees <kbd> as a raw HTML block start.
    // Without the walkTokens fix, the inner text "Ctrl " would have
    // escaped:true and be emitted UNESCAPED (raw), leaking angle fragments.
    const out = messageMarked.parse("press <kbd>Ctrl</kbd> done", { async: false }) as string;
    // The kbd tag must be escaped as literal text.
    expect(out).toContain("&lt;kbd&gt;");
  });

  it("Code.escaped is NOT cleared (legitimate code stays escaped)", () => {
    // Fenced code is legitimately escaped; the walkTokens fix must not touch
    // Code tokens (only Text tokens).
    const out = messageMarked.parse("```\n<div>code</div>\n```", { async: false }) as string;
    // The code content must still be escaped (Code.escaped preserved).
    expect(out).toContain("&lt;div&gt;");
    // It must NOT contain the raw unescaped tag.
    expect(out).not.toContain(">code<");
  });
});

// --- Image-source classifier ---------------------------------------------
// Pure function (no DOM dependency). selfOrigin is injected for deterministic
// tests. The classifier routes images into keep/proxy/neutralize.
describe("classifyImageSrc", () => {
  const self = "https://demo.example.com";

  it("cross-origin http(s) → proxy", () => {
    const r = classifyImageSrc("https://cdn.example.com/x.png", self);
    expect(r.kind).toBe("proxy");
    if (r.kind === "proxy") {
      expect(r.url).toBe("/vh/img?url=" + encodeURIComponent("https://cdn.example.com/x.png"));
    }
  });

  it("same-origin http(s) → keep", () => {
    expect(classifyImageSrc("https://demo.example.com/img/a.png", self).kind).toBe("keep");
    expect(classifyImageSrc("https://demo.example.com/x.png", self).kind).toBe("keep");
  });

  it("root-relative → keep", () => {
    expect(classifyImageSrc("/assets/x.png", self).kind).toBe("keep");
  });

  it("relative path → projectFile (routed to /vh/code/raw)", () => {
    // A relative path is a project-file reference (the SPA serves only
    // root-absolute assets, so a relative URL would 404 against the document
    // origin). The classifier returns the raw path; the render site resolves it.
    const generic = classifyImageSrc("assets/x.png", self);
    expect(generic.kind).toBe("projectFile");
    if (generic.kind === "projectFile") expect(generic.path).toBe("assets/x.png");

    const dotSlash = classifyImageSrc("./x.png", self);
    expect(dotSlash.kind).toBe("projectFile");
    if (dotSlash.kind === "projectFile") expect(dotSlash.path).toBe("./x.png");

    const dotDotSlash = classifyImageSrc("../x.png", self);
    expect(dotDotSlash.kind).toBe("projectFile");
    if (dotDotSlash.kind === "projectFile") expect(dotDotSlash.path).toBe("../x.png");
  });

  it("inline attachment relative path → projectFile", () => {
    // The exact shape produced by lib/inlineAttach.ts substituteInlineTokens at
    // send time (vh-attach:<localId> → .vh-solara/sessions/<sid>/attachments/...).
    const attach = ".vh-solara/sessions/ses_abc/attachments/1700000000000_shot.png";
    const r = classifyImageSrc(attach, self);
    expect(r.kind).toBe("projectFile");
    if (r.kind === "projectFile") expect(r.path).toBe(attach);
  });

  it("model-emitted repo-relative path → projectFile", () => {
    // Model output referencing a repo file relatively (e.g. ![d](docs/arch.png))
    // is the same class of relative URL and routes the same way.
    const r = classifyImageSrc("docs/diagram.png", self);
    expect(r.kind).toBe("projectFile");
    if (r.kind === "projectFile") expect(r.path).toBe("docs/diagram.png");
  });

  it("vh-attach: → keep", () => {
    expect(classifyImageSrc("vh-attach:abc123", self).kind).toBe("keep");
  });

  it("data:image/* raster types → keep", () => {
    expect(classifyImageSrc("data:image/png;base64,iVBOR", self).kind).toBe("keep");
    expect(classifyImageSrc("data:image/jpeg;base64,/9j/", self).kind).toBe("keep");
    expect(classifyImageSrc("data:image/gif;base64,R0lG", self).kind).toBe("keep");
    expect(classifyImageSrc("data:image/webp;base64,UklGR", self).kind).toBe("keep");
    expect(classifyImageSrc("data:image/avif;base64,", self).kind).toBe("keep");
  });

  it("data:image/svg+xml → neutralize", () => {
    expect(classifyImageSrc("data:image/svg+xml;base64,PHN2Zz4=", self).kind).toBe("neutralize");
  });

  it("data: non-image → neutralize", () => {
    expect(classifyImageSrc("data:text/html,<h1>x</h1>", self).kind).toBe("neutralize");
    expect(classifyImageSrc("data:application/json,{}", self).kind).toBe("neutralize");
  });

  it("javascript:/vbscript:/file:/blob:/ftp: → neutralize", () => {
    expect(classifyImageSrc("javascript:alert(1)", self).kind).toBe("neutralize");
    expect(classifyImageSrc("vbscript:msgbox", self).kind).toBe("neutralize");
    expect(classifyImageSrc("file:///etc/passwd", self).kind).toBe("neutralize");
    expect(classifyImageSrc("blob:https://example.com/uuid", self).kind).toBe("neutralize");
    expect(classifyImageSrc("ftp://example.com/x.png", self).kind).toBe("neutralize");
  });

  it("protocol-relative //host → neutralize", () => {
    expect(classifyImageSrc("//cdn.example.com/x.png", self).kind).toBe("neutralize");
  });

  it("malformed/empty/null → neutralize", () => {
    expect(classifyImageSrc("", self).kind).toBe("neutralize");
    expect(classifyImageSrc(null, self).kind).toBe("neutralize");
    expect(classifyImageSrc(undefined, self).kind).toBe("neutralize");
    expect(classifyImageSrc("   ", self).kind).toBe("neutralize");
  });

  it("other schemes (mailto/tel/unknown) → neutralize", () => {
    expect(classifyImageSrc("mailto:a@b.com", self).kind).toBe("neutralize");
    expect(classifyImageSrc("custom-scheme:data", self).kind).toBe("neutralize");
  });

  it("malformed http URL → neutralize", () => {
    // new URL() throws → neutralize
    expect(classifyImageSrc("http://", self).kind).toBe("neutralize");
  });
});

// --- Custom renderer.image (md.ts + streamMd.ts via shared instance) -----
describe("renderer.image — classifier applied in render output", () => {
  it("cross-origin image src rewritten to /vh/img proxy", () => {
    const out = messageMarked.parse("![alt](https://cdn.example.com/x.png)", { async: false }) as string;
    expect(out).toContain("/vh/img?url=");
    expect(out).toContain(encodeURIComponent("https://cdn.example.com/x.png"));
    expect(out).not.toContain('src="https://cdn.example.com');
  });

  it("same-origin image src kept unchanged", () => {
    // jsdom default origin is http://localhost:3000
    const md = "![alt](http://localhost:3000/assets/a.png)";
    const out = messageMarked.parse(md, { async: false }) as string;
    expect(out).toContain('src="http://localhost:3000/assets/a.png"');
    expect(out).not.toContain("/vh/img");
  });

  it("root-relative (/) image src kept unchanged (SPA asset)", () => {
    const out = messageMarked.parse("![alt](/assets/x.png)", { async: false }) as string;
    expect(out).toContain('src="/assets/x.png"');
    expect(out).not.toContain("/vh/img");
    expect(out).not.toContain("/vh/code/raw");
  });

  it("relative image src rewritten to /vh/code/raw (project file)", () => {
    // In the jsdom test env projectDir() is "" (no project selected), so the
    // daemon URL is /vh/code/raw?dir=&path=<enc>. Assert the endpoint + encoded
    // path; do NOT hard-assert the dir= value (that is the sync store's concern,
    // tested via the live app, not here).
    const md = "![alt](docs/diagram.png)";
    const out = messageMarked.parse(md, { async: false }) as string;
    expect(out).toContain("/vh/code/raw?");
    expect(out).toContain("path=" + encodeURIComponent("docs/diagram.png"));
    // The raw relative src must NOT survive to the DOM (it would 404).
    expect(out).not.toContain('src="docs/diagram.png"');
    expect(out).not.toContain("/vh/img");
  });

  it("inline attachment relative src rewritten to /vh/code/raw", () => {
    // The exact substituted form a RENDERED message carries after send:
    // .vh-solara/sessions/<sid>/attachments/<ts>_<name>.png (never vh-attach:).
    const attach = ".vh-solara/sessions/ses_abc/attachments/1700000000000_shot.png";
    const out = messageMarked.parse(`![shot.png](${attach})`, { async: false }) as string;
    expect(out).toContain("/vh/code/raw?");
    expect(out).toContain("path=" + encodeURIComponent(attach));
    expect(out).not.toContain('src=".vh-solara/');
    // alt text (the filename) is preserved.
    expect(out).toContain('alt="shot.png"');
  });

  it("javascript: image src neutralized (no src attribute)", () => {
    const out = messageMarked.parse('![alt](javascript:alert(1))', { async: false }) as string;
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain('src="');
    expect(out).toContain("<img");
    expect(out).toContain("alt");
  });

  it("data:image/svg+xml neutralized", () => {
    const out = messageMarked.parse("![x](data:image/svg+xml;base64,PHN2Zz4=)", { async: false }) as string;
    expect(out).not.toContain("data:image/svg");
    expect(out).not.toContain('src="data:');
  });

  it("data:image/png kept", () => {
    const out = messageMarked.parse("![x](data:image/png;base64,iVBOR)", { async: false }) as string;
    expect(out).toContain('src="data:image/png;base64,iVBOR"');
  });

  it("vh-attach: src kept unchanged", () => {
    const out = messageMarked.parse("![alt](vh-attach:abc123)", { async: false }) as string;
    expect(out).toContain('src="vh-attach:abc123"');
  });

  it("alt text and title preserved", () => {
    const out = messageMarked.parse('![my alt](https://cdn.example.com/x.png "my title")', { async: false }) as string;
    expect(out).toContain('alt="my alt"');
    expect(out).toContain('title="my title"');
  });

  it("streaming path also rewrites cross-origin images", () => {
    // StreamMd uses messageMarked.lexer/parser — the renderer applies.
    const host = document.createElement("div");
    const stream = new StreamMd(host);
    stream.push("![alt](https://cdn.example.com/x.png)");
    const streamed = host.innerHTML;
    expect(streamed).toContain("/vh/img?url=");
    expect(streamed).not.toContain('src="https://cdn.example.com');
  });
});

// --- B1: streaming/settled raster-data-image parity ------------------------
// (defer-streaming-data-image-scrub-divergence)
//
// Both streaming entry points (renderStreamMd via md.ts, StreamMd.push via
// streamMd.ts) route rendered HTML through normalizeAttrs, which is keyed on the
// SAME raster allowlist (RASTER_DATA_IMG) the pre-render classifier
// (classifyImageSrc) uses. The settled path (rewriteImageSrcs) applies the
// classifier directly. All three must AGREE: a raster data:image/* the operator
// kept is NOT neutralized by the streaming post-scrub. The old inline URL_SCRUB
// neutralized ALL data: schemes and silently undid the keep.
//
// Parity matrix pinned here:
//   - retain <img src="data:image/(png|jpeg|gif|webp|avif);...">;
//   - neutralize javascript:/vbscript: on BOTH href and src;
//   - neutralize SVG / non-allowlisted data: on src;
//   - retain benign href="data:image/png;...";
//   - neutralize href="data:text/html,...".
describe("B1 — normalizeAttrs + classifier parity across streaming + settled", () => {
  // sanity: the exported allowlist matches the classifier's keep set.
  it("RASTER_DATA_IMG is the single source of truth and matches the allowlist", () => {
    expect(RASTER_DATA_IMG.test("data:image/png;base64,x")).toBe(true);
    expect(RASTER_DATA_IMG.test("data:image/jpeg;base64,x")).toBe(true);
    expect(RASTER_DATA_IMG.test("data:image/gif;base64,x")).toBe(true);
    expect(RASTER_DATA_IMG.test("data:image/webp;base64,x")).toBe(true);
    expect(RASTER_DATA_IMG.test("data:image/avif;base64,x")).toBe(true);
    expect(RASTER_DATA_IMG.test("data:image/svg+xml;base64,x")).toBe(false);
    expect(RASTER_DATA_IMG.test("data:text/html,<x>")).toBe(false);
  });

  // Render the same markdown through all three paths. rewriteImageSrcs is
  // img-src-only (it never touches href), so it is omitted from the href cases.
  function renderAll(md: string): { oneShot: string; stream: string; settled: string } {
    const host = document.createElement("div");
    const s = new StreamMd(host);
    s.push(md);
    const stream = host.innerHTML;
    const oneShot = renderStreamMd(md);
    // rewriteImageSrcs operates on already-rendered HTML; feed it the one-shot
    // output (which still carries the classifier-applied img tags).
    const settled = rewriteImageSrcs(oneShot);
    return { oneShot, stream, settled };
  }

  // --- direct unit cases on normalizeAttrs (the streaming scrub, isolated) ---
  it("normalizeAttrs keeps raster data: img src; neutralizes svg/non-raster src", () => {
    expect(normalizeAttrs('<img src="data:image/png;base64,AAAA">')).toContain(
      'src="data:image/png;base64,AAAA"',
    );
    expect(normalizeAttrs('<img src="data:image/svg+xml;base64,PHN2">')).toContain('src="#"');
    expect(normalizeAttrs('<img src="data:text/html,<x>">')).toContain('src="#"');
  });

  it("normalizeAttrs neutralizes javascript:/vbscript: on BOTH href and src", () => {
    expect(normalizeAttrs('<a href="javascript:alert(1)">x</a>')).toContain('href="#"');
    expect(normalizeAttrs('<a href="vbscript:msgbox">x</a>')).toContain('href="#"');
    expect(normalizeAttrs('<img src="javascript:alert(1)">')).toContain('src="#"');
    expect(normalizeAttrs('<img src="vbscript:msgbox">')).toContain('src="#"');
    // and never leaks the scheme text
    expect(normalizeAttrs('<a href="javascript:alert(1)">x</a>')).not.toContain("javascript:");
  });

  it("normalizeAttrs keeps benign raster data: href; neutralizes data:text/html href", () => {
    expect(normalizeAttrs('<a href="data:image/png;base64,iVBOR">x</a>')).toContain(
      'href="data:image/png;base64,iVBOR"',
    );
    expect(normalizeAttrs('<a href="data:image/png;base64,iVBOR">x</a>')).not.toContain('href="#"');
    expect(normalizeAttrs('<a href="data:text/html,<h1>x</h1>">x</a>')).toContain('href="#"');
    expect(normalizeAttrs('<a href="data:text/html,<h1>x</h1>">x</a>')).not.toContain("data:text/html");
  });

  it("normalizeAttrs is case-insensitive on scheme + MIME", () => {
    expect(normalizeAttrs('<img src="DATA:IMAGE/PNG;base64,x">')).toContain(
      'src="DATA:IMAGE/PNG;base64,x"',
    );
    expect(normalizeAttrs('<a HREF="JavaScript:alert(1)">x</a>')).not.toContain("JavaScript:");
  });

  it("normalizeAttrs leaves safe attributes untouched", () => {
    const html = '<a href="/path/x">x</a><img src="/assets/y.png" alt="z">';
    expect(normalizeAttrs(html)).toBe(html);
  });

  // --- the load-bearing B1 case, pinned across all three renderers ----------
  const rasterTypes = [
    ["png", "data:image/png;base64,iVBOR"],
    ["jpeg", "data:image/jpeg;base64,/9j/"],
    ["gif", "data:image/gif;base64,R0lG"],
    ["webp", "data:image/webp;base64,UklGR"],
    ["avif", "data:image/avif;base64,"],
  ] as const;

  for (const [name, dataUrl] of rasterTypes) {
    it(`retains <img src="${name} raster"> in renderStreamMd, StreamMd.push, AND rewriteImageSrcs`, () => {
      const md = `![a](${dataUrl})`;
      const { oneShot, stream, settled } = renderAll(md);
      const cases: [string, string][] = [
        ["renderStreamMd", oneShot],
        ["StreamMd.push", stream],
        ["rewriteImageSrcs", settled],
      ];
      for (const [label, html] of cases) {
        expect(html, `${label} must keep the raster data src`).toContain(`src="${dataUrl}"`);
        expect(html, `${label} must NOT neutralize the kept raster src to #`).not.toContain('src="#"');
        expect(html, `${label} must emit an img`).toContain("<img");
      }
    });
  }

  it("B1 pinned: streamed ![a](data:image/png;base64,AAAA) stays <img> with data src (NOT src=#)", () => {
    const host = document.createElement("div");
    const s = new StreamMd(host);
    s.push("![a](data:image/png;base64,AAAA)");
    const html = host.innerHTML;
    expect(html).toContain("<img");
    expect(html).toContain('src="data:image/png;base64,AAAA"');
    expect(html).not.toContain('src="#"');
    // And the one-shot path agrees (the regression was streaming-only before).
    expect(renderStreamMd("![a](data:image/png;base64,AAAA)")).toContain(
      'src="data:image/png;base64,AAAA"',
    );
  });

  it("neutralizes SVG / non-allowlisted data: on src across all three paths", () => {
    const md = "![x](data:image/svg+xml;base64,PHN2Zz4=)";
    const { oneShot, stream, settled } = renderAll(md);
    const cases: [string, string][] = [
      ["renderStreamMd", oneShot],
      ["StreamMd.push", stream],
      ["rewriteImageSrcs", settled],
    ];
    for (const [label, html] of cases) {
      expect(html, `${label} must not keep svg data src`).not.toContain("data:image/svg");
      expect(html, `${label} must not carry any data: src`).not.toContain('src="data:');
    }
  });

  it("neutralizes javascript: link href in BOTH streaming paths (settled rewriteImageSrcs is img-only, out of scope)", () => {
    const md = "[click](javascript:alert(1))";
    const oneShot = renderStreamMd(md);
    const host = document.createElement("div");
    const s = new StreamMd(host);
    s.push(md);
    const stream = host.innerHTML;
    for (const [label, html] of [["renderStreamMd", oneShot], ["StreamMd.push", stream]] as const) {
      expect(html, label).not.toContain("javascript:");
      expect(html, label).toContain('href="#"');
    }
  });

  it("neutralizes vbscript: link href in BOTH streaming paths", () => {
    const md = "[x](vbscript:msgbox)";
    const oneShot = renderStreamMd(md);
    const host = document.createElement("div");
    const s = new StreamMd(host);
    s.push(md);
    const stream = host.innerHTML;
    for (const [label, html] of [["renderStreamMd", oneShot], ["StreamMd.push", stream]] as const) {
      expect(html, label).not.toContain("vbscript:");
      expect(html, label).toContain('href="#"');
    }
  });

  it("retains benign raster data: link href; neutralizes data:text/html link href (both streaming paths)", () => {
    // raster data: href is benign (no script execution from a data:image href) — kept.
    const pngMd = "[a](data:image/png;base64,iVBOR)";
    const pngOne = renderStreamMd(pngMd);
    const pngHost = document.createElement("div");
    const ps = new StreamMd(pngHost);
    ps.push(pngMd);
    const pngStream = pngHost.innerHTML;
    for (const [label, html] of [["renderStreamMd", pngOne], ["StreamMd.push", pngStream]] as const) {
      expect(html, label).toContain('href="data:image/png;base64,iVBOR"');
      expect(html, label).not.toContain('href="#"');
    }
    // data:text/html href is dangerous — neutralized.
    const htmlMd = "[a](data:text/html,<h1>x</h1>)";
    const htmlOne = renderStreamMd(htmlMd);
    const htmlHost = document.createElement("div");
    const hs = new StreamMd(htmlHost);
    hs.push(htmlMd);
    const htmlStream = htmlHost.innerHTML;
    for (const [label, html] of [["renderStreamMd", htmlOne], ["StreamMd.push", htmlStream]] as const) {
      expect(html, label).not.toContain("data:text/html");
      expect(html, label).toContain('href="#"');
    }
  });
});
