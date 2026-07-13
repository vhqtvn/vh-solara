// @vitest-environment jsdom
//
// Regression test for the codeblock copy button duplicating newlines.
//
// BUG: chroma's server-rendered (settled) code blocks wrap each source line in
//   <span class="line"><span class="cl">…\n</span></span>
// and the chroma stylesheet sets `.chroma .line { display: flex }` (block-level).
// In a real browser, Element.innerText is CSS-box-aware: it inserts an EXTRA
// line break at each block-level (flex) boundary, ON TOP of the `\n` already
// present inside `.cl`, so copying produced a blank line between every source
// line. The fix swaps innerText → textContent (which reproduces the source
// verbatim, ignoring CSS box layout).
//
// FRAMEWORK CHOICE (vitest + jsdom, NOT Playwright):
// We verify empirically that jsdom's innerText is NOT a faithful browser model
// here (it returns "" for the chroma envelope rather than the browser's doubled
// newlines), but it STILL diverges from textContent — so an assertion on the
// value the copy handler writes is meaningful and non-vacuous:
//   - OLD code (innerText)  → writes ""   → this test FAILS
//   - NEW code (textContent) → writes "line1\nline2\n" → this test PASSES
// This is a stronger, faster, dependency-free regression guard than a Playwright
// e2e (which would need the SPA build + the Go fixture server). The real-browser
// bug shape (doubled newlines) cannot be reproduced in jsdom, so this test pins
// the contract ("copy writes the verbatim source") rather than the specific
// innerText failure mode.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// jsdom doesn't implement matchMedia, but importing Part pulls in code/frame →
// layout, which calls window.matchMedia at module load. Stub it BEFORE the
// component import is evaluated (vi.hoisted runs ahead of static imports).
vi.hoisted(() => {
  const w = globalThis as unknown as { matchMedia?: unknown };
  if (!w.matchMedia) {
    w.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    });
  }
});
import { addCodeCopyButtons } from "../../src/components/Part";

// Build a DOM matching chroma's real server-rendered output for a two-line
// fenced code block (each line wrapped in <span class=line><span class=cl>…\n),
// inside the <pre class=chroma><code> envelope addCodeCopyButtons targets.
function chromaBlock(lines: string[]): HTMLElement {
  const root = document.createElement("div");
  const pre = document.createElement("pre");
  pre.className = "chroma";
  const code = document.createElement("code");
  for (const ln of lines) {
    const line = document.createElement("span");
    line.className = "line";
    const cl = document.createElement("span");
    cl.className = "cl";
    // chroma emits the source line followed by a literal `\n` inside .cl.
    cl.textContent = ln + "\n";
    line.appendChild(cl);
    code.appendChild(line);
  }
  pre.appendChild(code);
  root.appendChild(pre);
  return root;
}

// jsdom does not ship a working navigator.clipboard; install a stub that
// records the argument handed to writeText so the test can assert on it.
let written: string[];
let writeText: ReturnType<typeof vi.fn>;
let savedClipboard: PropertyDescriptor | undefined;

beforeEach(() => {
  written = [];
  writeText = vi.fn((s: string) => {
    written.push(s);
    return Promise.resolve();
  });
  savedClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
  Object.defineProperty(navigator, "clipboard", {
    value: { writeText },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  if (savedClipboard) {
    Object.defineProperty(navigator, "clipboard", savedClipboard);
  }
  document.body.innerHTML = "";
});

describe("codeblock copy button", () => {
  it("writes the verbatim source (single newlines) for chroma-enveloped code", () => {
    const root = chromaBlock(["line1", "line2"]);
    addCodeCopyButtons(root);

    const btn = root.querySelector<HTMLButtonElement>(".code-copy");
    expect(btn, ".code-copy button should be wired by addCodeCopyButtons").not.toBeNull();
    btn!.click();

    expect(writeText).toHaveBeenCalledTimes(1);
    // Single newlines, no blank lines between source lines.
    expect(written[0]).toBe("line1\nline2\n");
  });

  it("uses the <pre> itself when no <code> child is present", () => {
    // A code block without chroma highlighting still gets copy buttons; the
    // handler falls back to reading the <pre> directly.
    const root = document.createElement("div");
    const pre = document.createElement("pre");
    pre.textContent = "alpha\nbeta\n";
    root.appendChild(pre);
    addCodeCopyButtons(root);

    root.querySelector<HTMLButtonElement>(".code-copy")!.click();
    expect(written[0]).toBe("alpha\nbeta\n");
  });

  it("copies the verbatim source even when a source line is visually empty", () => {
    // An empty source line is still wrapped by chroma as
    // <span class=line><span class=cl>\n</span></span>; textContent must keep
    // that blank line rather than collapsing it.
    const root = chromaBlock(["line1", "", "line3"]);
    addCodeCopyButtons(root);

    root.querySelector<HTMLButtonElement>(".code-copy")!.click();
    expect(written[0]).toBe("line1\n\nline3\n");
  });
});
