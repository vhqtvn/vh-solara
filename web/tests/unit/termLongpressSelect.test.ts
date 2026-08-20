// Terminal long-press selection (coarse pointers) — SOURCE PIN for the CSS
// half of the mobile long-press fix.
//
// xterm.css parks `.xterm { user-select: none }` on the terminal root; an
// explicit descendant declaration beats ancestor inheritance, so the app-wide
// `.term` carve-out in styles/legacy/00-app-globals.css can never make the
// DOM-rendered rows natively selectable. The fix ships a (pointer: coarse)
// media rule in TerminalDock.css opting `.term .xterm` back into native
// selection (touch devices only — xterm's own mouse selection owns desktop,
// and its mousedown preventDefaults native selection there anyway).
//
// This test is a source-content pin (fast lane): it proves the rule exists in
// the authored CSS. The behavioral proof that the rule is actually BUNDLED and
// loaded lives in the e2e lane (terminal.spec.ts "coarse-pointer native-
// selection rule is shipped and desktop-gated" walks the served page's CSSOM).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// vitest runs with cwd = web/ (npm --prefix web); import.meta.url is re-rooted
// by the transform pipeline, so cwd-relative is the stable form here.
const css = readFileSync(path.resolve(process.cwd(), "src/components/TerminalDock.css"), "utf8");

/** Concatenated bodies of EVERY `@media (...)` block whose query contains `needle`. */
function mediaBlocks(source: string, needle: string): string {
  const found: string[] = [];
  const re = /@media[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source))) {
    const openFrom = m.index + m[0].length;
    let depth = 1;
    let i = openFrom;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "{") depth++;
      else if (source[i] === "}") depth--;
    }
    if (m[0].includes(needle)) found.push(source.slice(openFrom, i - 1));
  }
  return found.join("\n");
}

describe("TerminalDock.css coarse-pointer long-press selection rule", () => {
  it("ships a (pointer: coarse) block re-enabling native selection inside .term .xterm", () => {
    const block = mediaBlocks(css, "pointer: coarse");
    // The rule targets the xterm root INSIDE .term (specificity (0,2,0) beats
    // xterm.css's `.xterm { user-select: none }` (0,1,0)).
    expect(block, "@media (pointer: coarse) rule present").toMatch(/\.term\s+\.xterm\s*\{/);
    // Both engines: standard + WebKit prefixes, plus the iOS callout default
    // (the app-wide none would otherwise suppress the long-press callout).
    expect(block).toMatch(/-webkit-user-select:\s*text/);
    expect(block).toMatch(/user-select:\s*text/);
    expect(block).toMatch(/-webkit-touch-callout:\s*default/);
  });
});
