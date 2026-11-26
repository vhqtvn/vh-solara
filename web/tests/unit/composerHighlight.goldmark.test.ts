// Composer highlight mirror against the daemon's markdown parser: which
// lines are code?
//
// The daemon renders settled messages with goldmark (pkg/render). The
// composer colours code lines as they are typed, with its own small scanner
// (`highlightInput`). Where the two disagree about a line, the compose box
// shows a block that the sent message will not have — or fails to show one
// that it will.
//
// ./fixtures/composerHighlight.goldmark.json is goldmark's answer, produced
// by pkg/render/composer_highlight_oracle_test.go: for each input, its lines
// and, per line, whether goldmark puts that line in a code block (a fenced
// block's opening fence, content and closing fence, or an indented code
// block). This test derives the same flag from the mirror's HTML and
// compares, line by line.
//
// The ledger: every line on which the mirror is known to differ is listed in
// `knownGaps` below with its cause. It lists none, and `CAUSES` names no
// cause: there are no known deviations — the mirror agrees with goldmark on
// every line of every input. The test fails when
//   - a line differs and is not listed: a new or unknown deviation;
//   - a listed line no longer differs: a stale entry, to be removed.
// So the number of entries goes down only on purpose. To close a class of
// deviation, fix the scanner, run this test, and delete the entries it
// reports as stale. A differing line is not a known gap until its cause is
// found: find out what it is before adding a cause or an entry.
//
// Pure logic, default node environment (no jsdom docblock).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { highlightInput } from "../../src/lib/composerHighlight";

type OracleEntry = { name: string; lines: string[]; code: boolean[] };

// Read with node:fs rather than imported: web/tsconfig.json has no
// resolveJsonModule.
const fixture: OracleEntry[] = JSON.parse(
  readFileSync(new URL("./fixtures/composerHighlight.goldmark.json", import.meta.url), "utf8"),
);

// The classes of known deviation between the mirror and goldmark. None: the
// mirror agrees with goldmark on every line of every input.
const CAUSES = [] as const;
type Cause = (typeof CAUSES)[number];

// Every line on which the mirror is known to disagree with goldmark, by
// input name, in line order. There are no known deviations, so every input
// here has an empty array. Should one appear, `line` is a 0-based index into
// the input's lines and the entry carries a cause from `CAUSES`, with a
// comment on the input saying how the two come to differ.
const knownGaps: Record<string, Array<{ line: number; cause: Cause }>> = {
  "fence-plain": [],
  "fence-info-string": [],
  "fence-tilde": [],
  "fence-four-backticks-hold-three": [],
  "fence-closer-with-info-is-content": [],
  "fence-backtick-in-info-is-text": [],
  "fence-unclosed": [],
  "fence-empty": [],
  "fence-blank-line-inside-backticks": [],
  "fence-blank-line-inside-tildes": [],
  "quote-fence-closed": [],
  "quote-fence-unclosed": [],
  "quote-blank-line-ends-quoted-block": [],
  "quote-closer-indented-four-is-content": [],
  "quote-bare-fence-does-not-close": [],
  "list-bullet-fence-closed": [],
  "list-bullet-fence-unclosed": [],
  "list-ordered-fence": [],
  "quote-list-fence": [],
  "double-quote-fence": [],
  "list-quote-fence": [],
  "list-next-item-ends-block-without-closer": [],
  "list-empty-fence": [],
  "lazy-paragraph-then-fence-in-item": [],
  "lazy-paragraph-then-fence-in-quote": [],
  "indent-top-level-fence-line-is-code": [],
  "indent-quote-line-is-code": [],
  "indent-marker-line-is-code": [],
  "indent-fence-in-item-is-code": [],
  "indent-marker-in-item-is-code": [],
  "indent-quote-in-item-is-code": [],
  "paren-list-marker-fence": [],
  "list-ten-digits-are-no-marker": [],
  "list-nine-digits-are-a-marker": [],
  "list-starts-at-two": [],
  "list-bare-marker-then-fence": [],
  "list-bare-bullet-then-fence": [],
  "list-bare-marker-then-deeper-fence": [],
  "paragraph-then-bare-marker-then-fence": [],
  "paragraph-then-lone-dash-is-setext-then-fence": [],
  "paragraph-then-bare-star-then-fence": [],
  "paragraph-then-bare-plus-then-fence": [],
  "paragraph-then-ordered-item-starting-at-two": [],
  "item-paragraph-then-ordered-item-starting-at-two": [],
  "quote-paragraph-then-ordered-item-starting-at-two": [],
  "quote-paragraph-then-lazy-ordered-item-starting-at-two-then-fence": [],
  "paragraph-then-ordered-item-with-leading-zero": [],
  "paragraph-then-bullet-with-trailing-space-then-fence": [],
  "paragraph-then-ordered-marker-with-trailing-tab-then-fence": [],
  "paragraph-then-star-with-trailing-space-then-fence": [],
  "blank-line-then-bullet-with-trailing-space-then-fence": [],
  "paragraph-then-indented-dashes-then-marker-then-fence": [],
  "paragraph-then-indented-equals-then-marker-then-fence": [],
  "paragraph-then-indented-spaced-dashes-then-marker-then-fence": [],
  "paragraph-then-empty-heading-then-marker-then-fence": [],
  "paragraph-then-indented-heading-then-marker-then-fence": [],
  "quote-paragraph-then-heading-then-lazy-marker-then-fence": [],
  "item-paragraph-then-heading-then-lazy-marker-then-fence": [],
  "paragraph-then-seven-hashes-then-marker-then-fence": [],
  "paragraph-then-hash-without-space-then-marker-then-fence": [],
  "paragraph-then-item-then-fence": [],
  "paragraph-in-item-then-nested-bare-marker-then-fence": [],
  "heading-closes-paragraph-then-marker-is-an-item": [],
  "blank-line-closes-paragraph-then-marker-is-an-item": [],
  "dash-after-paragraph-is-setext-then-marker-is-an-item": [],
  "lazy-line-then-bare-marker-then-fence": [],
  "lazy-line-then-bare-ordered-marker-then-fence": [],
  "lazy-line-then-ordered-item-starting-at-two-then-fence": [],
  "lazy-line-then-equals-line-then-fence": [],
  "lazy-line-then-two-dashes-line-then-fence": [],
  "lazy-line-then-three-dashes-line-then-fence": [],
  "nested-bare-marker-then-deep-fence": [],
  "list-second-item-bare-bullet-then-fence": [],
  "list-second-item-bare-marker-then-fence": [],
  "list-continues-at-two": [],
  "thematic-break-dashes": [],
  "thematic-break-stars": [],
  "thematic-break-spaced-stars": [],
  "thematic-break-tabbed-dashes": [],
  "thematic-break-underscores": [],
  "thematic-break-ends-list-then-fence": [],
  "quote-thematic-break": [],
  "mixed-break-characters-are-a-list": [],
  "setext-heading-then-fence": [],
  "two-dashes-are-a-list": [],
  "html-block-hides-fence-lines": [],
  "marked-unindented-line-ends-item-block": [],
  "marked-blank-lines-inside-item-block": [],
  "tab-opener-is-indented-code": [],
  "tab-before-fence-in-item": [],
  "indent-code-plain": [],
  "indent-code-blank-line-inside": [],
  "indent-code-trailing-blank-line": [],
  "indent-code-two-blocks": [],
  "indent-code-cannot-interrupt-paragraph": [],
  "indent-code-after-blank-line": [],
  "indent-code-less-indent-ends": [],
  "indent-code-then-fence": [],
  "indent-code-in-item": [],
  "indent-code-in-quote": [],
  "indent-code-lazy-line-in-quote": [],
  "indent-two-spaces-in-item-is-paragraph": [],
  "indent-code-in-item-then-plain-then-indent": [],
  "indent-code-in-item-inside-quote": [],
  "thematic-break-closes-paragraph-then-bare-marker": [],
  "lazy-line-indented-list-marker-in-quote": [],
  "quote-marked-blank-line-inside-indented-code": [],
  "quote-marked-blank-line-keeps-fence-in-quoted-list": [],
  "quote-marked-blank-line-closes-item-paragraph": [],
  "quote-marked-blank-line-closes-paragraph": [],
  "indent-code-after-fence": [],
  "indent-code-indented-heading": [],
  "indent-code-item-first-line-then-continuation": [],
  "indent-code-tab-continuation": [],
  "indent-code-more-indented-continuation": [],
  "html-pre-holds-blank-and-indented-lines": [],
  "html-pre-close-then-fence": [],
  "html-script-holds-blank-and-fence": [],
  "html-comment-holds-fence": [],
  "html-comment-holds-blank-line": [],
  "html-processing-instruction-holds-fence": [],
  "html-declaration-holds-fence": [],
  "html-cdata-holds-fence": [],
  "html-unterminated-div-holds-fence": [],
  "html-div-after-paragraph-is-text": [],
  "html-custom-tag-alone-is-a-block": [],
  "html-custom-tag-with-text-is-paragraph": [],
  "html-custom-tag-after-paragraph-is-text": [],
  "html-closing-tag-alone-is-a-block": [],
  "html-indented-tag-is-indented-code": [],
  "html-block-in-quote": [],
  "html-block-in-list": [],
  "html-tag-inside-paragraph-line": [],
  "html-script-inside-indented-code": [],
  "html-pre-closes-on-the-same-line": [],
  "bare-hash-then-fence": [],
  "quote-heading-then-fence": [],
  "list-heading-then-fence": [],
};

// The mirror's escHtml() encodes & < >; inverted for the text comparison.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

const codeSpan = (text: string) => `<span class="hl-code">${esc(text)}</span>`;
// A blockquote-marker or list-marker prefix span. It holds no "<": the
// mirror escapes it.
const PREFIX = /^<span class="hl-(?:quote|marker)">([^<]*)<\/span>([\s\S]*)$/;

// Whether the mirror colours all of `line` as code: the whole line is one
// code span, or a quote or marker prefix span is followed by one code span
// holding the rest of the line.
function isCodeLine(out: string, line: string): boolean {
  if (out === codeSpan(line)) return true;
  const m = PREFIX.exec(out);
  if (!m) return false;
  const prefix = unesc(m[1]);
  return line.startsWith(prefix) && m[2] === codeSpan(line.slice(prefix.length));
}

// Per line of `lines`: does the mirror colour the line as code?
function mirrorCodeLines(lines: string[]): boolean[] {
  const out = highlightInput(lines.join("\n")).split("\n");
  return lines.map((line, i) => isCodeLine(out[i], line));
}

const said = (code: boolean) => (code ? "code" : "plain");

// Every way the mirror is out of step with the ledger, one line per problem.
function audit(): string[] {
  const failures: string[] = [];
  for (const { name, lines, code } of fixture) {
    const mirror = mirrorCodeLines(lines);
    const listed = new Map(knownGaps[name].map((gap) => [gap.line, gap.cause]));
    lines.forEach((line, i) => {
      const differs = mirror[i] !== code[i];
      const at = `${name} line ${i} ${JSON.stringify(line)}: goldmark=${said(code[i])} highlighter=${said(mirror[i])}`;
      if (differs && !listed.has(i)) {
        failures.push(`${at} — the two differ, but no knownGaps entry names this line (a new or unknown deviation)`);
      } else if (!differs && listed.has(i)) {
        failures.push(`${at}, cause "${listed.get(i)}" — knownGaps names this line, but the two agree (a stale entry: remove it)`);
      }
    });
  }
  return failures;
}

describe("highlightInput against goldmark: composerHighlight.goldmark.json", () => {
  it("the fixture is well formed: unique names, and one flag per line", () => {
    expect(fixture.length).toBeGreaterThan(0);
    const names = new Set<string>();
    for (const entry of fixture) {
      expect(typeof entry.name, "name").toBe("string");
      expect(names.has(entry.name), `repeated name ${entry.name}`).toBe(false);
      names.add(entry.name);
      expect(entry.lines.length, `${entry.name}: lines`).toBeGreaterThan(0);
      expect(entry.code, `${entry.name}: one flag per line`).toHaveLength(entry.lines.length);
      for (const flag of entry.code) expect(typeof flag, `${entry.name}: flags are booleans`).toBe("boolean");
    }
  });

  it("knownGaps covers exactly the fixture's inputs, and each entry has a known cause and a line in range", () => {
    const fixtureNames = fixture.map((entry) => entry.name);
    const ledgerNames = Object.keys(knownGaps);
    expect(ledgerNames.filter((name) => !fixtureNames.includes(name)), "ledger names missing from the fixture").toEqual([]);
    expect(fixtureNames.filter((name) => !ledgerNames.includes(name)), "fixture inputs missing from the ledger").toEqual([]);
    for (const [name, gaps] of Object.entries(knownGaps)) {
      const nlines = fixture.find((entry) => entry.name === name)?.lines.length ?? 0;
      gaps.forEach((gap, i) => {
        expect(CAUSES as readonly string[], `${name} line ${gap.line}: cause`).toContain(gap.cause);
        expect(gap.line, `${name}: line index`).toBeGreaterThanOrEqual(0);
        expect(gap.line, `${name}: line index`).toBeLessThan(nlines);
        if (i > 0) expect(gap.line, `${name}: entries in line order`).toBeGreaterThan(gaps[i - 1].line);
      });
    }
  });

  it("every line where the mirror differs from goldmark is a known gap, and every known gap still differs", () => {
    expect(audit()).toEqual([]);
  });
});
