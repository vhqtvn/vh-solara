// @vitest-environment jsdom
//
// Characterization tests for the non-streaming markdown-enhance helpers
// extracted from components/Part.tsx (TS refactor slice 1). These lock the new
// lib/markdownEnhance.ts seam by asserting the EXACT current behavior of each
// helper, drawing input/expected-output pairs from how Part.tsx uses them on
// settled (server-rendered) markdown.
//
// addCodeCopyButtons has its own regression suite (codeCopy.test.ts); this file
// covers the other three: linkifyPaths, tagInlineCodePaths, splitMermaid.
//
// Behavior-preserving extraction: these tests do NOT change what the functions
// do — they pin what they already did inside Part.tsx so a future refactor of
// the seam cannot silently shift it.

import { describe, expect, it } from "vitest";
import { linkifyPaths, splitMermaid, tagInlineCodePaths } from "../../src/lib/markdownEnhance";

// ---- splitMermaid --------------------------------------------------------
// Pure string split of markdown into alternating prose / mermaid segments.
// Called by Part.tsx's <Markdown> settled view to route mermaid fences to the
// <Mermaid> diagram component and the rest to <MarkdownHtml>.
describe("splitMermaid", () => {
  it("returns the whole text as a single md segment when there is no mermaid fence", () => {
    expect(splitMermaid("just prose")).toEqual([{ type: "md", content: "just prose" }]);
  });

  it("splits leading prose, a mermaid block, and trailing prose into three segments", () => {
    const text = "intro\n```mermaid\ngraph LR\nA-->B\n```\nouteo";
    expect(splitMermaid(text)).toEqual([
      { type: "md", content: "intro\n" },
      { type: "mermaid", content: "graph LR\nA-->B\n" },
      { type: "md", content: "\nouteo" },
    ]);
  });

  it("emits no leading md segment when the text starts with a mermaid fence", () => {
    expect(splitMermaid("```mermaid\ngraph TD\nX-->Y\n```")).toEqual([
      { type: "mermaid", content: "graph TD\nX-->Y\n" },
    ]);
  });

  it("emits no trailing md segment when the text ends with a mermaid fence", () => {
    expect(splitMermaid("preamble\n```mermaid\ngraph\n```")).toEqual([
      { type: "md", content: "preamble\n" },
      { type: "mermaid", content: "graph\n" },
    ]);
  });

  it("treats an empty mermaid body as a mermaid segment with empty content", () => {
    expect(splitMermaid("```mermaid\n```")).toEqual([{ type: "mermaid", content: "" }]);
  });

  it("does NOT treat a fence missing the required newline after 'mermaid' as mermaid", () => {
    // The regex requires \s*\n after ```mermaid; a bare ```mermaid``` with no
    // newline is plain prose.
    expect(splitMermaid("```mermaid```")).toEqual([{ type: "md", content: "```mermaid```" }]);
  });

  it("alternates across multiple mermaid fences", () => {
    const text = "a\n```mermaid\nM1\n```\nb\n```mermaid\nM2\n```\nc";
    expect(splitMermaid(text)).toEqual([
      { type: "md", content: "a\n" },
      { type: "mermaid", content: "M1\n" },
      { type: "md", content: "\nb\n" },
      { type: "mermaid", content: "M2\n" },
      { type: "md", content: "\nc" },
    ]);
  });
});

// ---- tagInlineCodePaths --------------------------------------------------
// Adds a `code-pathlike` class to inline <code> spans whose text looks like a
// file path, so Part.tsx can offer a ctrl/cmd-click go-to affordance. Skips
// <code> inside <pre> (block code) and already-tagged spans. Path shape comes
// from lib/pathlike.ts looksLikePath (path-ish chars; must have a '/' or a
// trailing extension; optional trailing :line[:col]).
describe("tagInlineCodePaths", () => {
  it("tags an inline <code> whose text is a path with a separator", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p>see <code>src/foo.ts</code> here</p>`;
    tagInlineCodePaths(root);
    expect(root.querySelector("code")!.classList.contains("code-pathlike")).toBe(true);
  });

  it("tags a bare filename <code> that ends in an extension", () => {
    const root = document.createElement("div");
    root.innerHTML = `<code>Foo.ts</code>`;
    tagInlineCodePaths(root);
    expect(root.querySelector("code")!.classList.contains("code-pathlike")).toBe(true);
  });

  it("does NOT tag <code> whose text lacks a path shape (function call)", () => {
    const root = document.createElement("div");
    root.innerHTML = `<code>foo()</code>`;
    tagInlineCodePaths(root);
    expect(root.querySelector("code")!.classList.contains("code-pathlike")).toBe(false);
  });

  it("does NOT tag <code> inside a <pre> (block code is left alone)", () => {
    const root = document.createElement("div");
    root.innerHTML = `<pre><code>src/foo.ts</code></pre>`;
    tagInlineCodePaths(root);
    expect(root.querySelector("code")!.classList.contains("code-pathlike")).toBe(false);
  });

  it("is a no-op when passed undefined", () => {
    expect(() => tagInlineCodePaths(undefined)).not.toThrow();
  });
});

// ---- linkifyPaths --------------------------------------------------------
// Walks rendered prose text nodes (skipping pre/code/a/.filepath) and wraps
// file-path-like substrings in clickable .filepath spans carrying the path and
// an optional :line in dataset. Called by Part.tsx on settled server-rendered
// HTML so prose mentions of files become jump targets.
describe("linkifyPaths", () => {
  it("wraps a path mention in a .filepath span with dataset.path", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p>edit src/foo.ts to fix</p>`;
    linkifyPaths(root);
    const span = root.querySelector<HTMLSpanElement>(".filepath");
    expect(span, "a .filepath span should wrap the path").not.toBeNull();
    expect(span!.dataset.path).toBe("src/foo.ts");
    expect(span!.textContent).toBe("src/foo.ts");
  });

  it("captures a trailing :line into dataset.line", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p>see src/foo.ts:42 for the bug</p>`;
    linkifyPaths(root);
    const span = root.querySelector<HTMLSpanElement>(".filepath");
    expect(span!.dataset.path).toBe("src/foo.ts");
    expect(span!.dataset.line).toBe("42");
    // The full matched text (including :42) is the span's text content.
    expect(span!.textContent).toBe("src/foo.ts:42");
  });

  it("does NOT linkify paths inside <code> (code is handled by tagInlineCodePaths)", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p>see <code>src/foo.ts</code> inline</p>`;
    linkifyPaths(root);
    expect(root.querySelector(".filepath")).toBeNull();
  });

  it("does NOT linkify paths inside <pre>", () => {
    const root = document.createElement("div");
    root.innerHTML = `<pre>lint src/foo.ts</pre>`;
    linkifyPaths(root);
    expect(root.querySelector(".filepath")).toBeNull();
  });

  it("preserves surrounding text when wrapping a path", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p>before src/foo.ts after</p>`;
    linkifyPaths(root);
    expect(root.querySelector("p")!.textContent).toBe("before src/foo.ts after");
    expect(root.querySelectorAll(".filepath").length).toBe(1);
  });

  it("is a no-op when passed undefined", () => {
    expect(() => linkifyPaths(undefined)).not.toThrow();
  });
});
