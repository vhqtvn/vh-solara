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
// `knownGaps` below with its cause. The test fails when
//   - a line differs and is not listed: a new or unknown deviation;
//   - a listed line no longer differs: a stale entry, to be removed.
// So the number of entries goes down only on purpose. To close a class of
// deviation, fix the scanner, run this test, and delete the entries it
// reports as stale. A differing line that fits none of the causes below is
// not a known gap: find out what it is before adding anything.
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

// The six classes of known deviation between the mirror and goldmark.
// "lazy continuation" is an item's (or a quote's) continuity across a lazy
// line — a non-blank line that does not carry the container's prefix. The
// mirror ends the container at such a line; while a paragraph inside the
// container is open, CommonMark keeps it open.
const CAUSES = [
  "indented code",
  "`)` marker",
  "list start rule",
  "thematic break",
  "HTML block",
  "lazy continuation",
] as const;
type Cause = (typeof CAUSES)[number];

// Every line on which the mirror is known to disagree with goldmark, by
// input name, in line order. `line` is a 0-based index into the input's
// lines. An input with no deviation has an empty array. A deviating input
// carries a comment on how the two come to differ.
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
  // "lazy" (line 1) lazily continues the paragraph in the item, so the item
  // stays open and the fence at line 2 belongs to it; "after" ends it. The
  // mirror ends the item at "lazy" and opens a top-level fence at line 2,
  // which swallows "after": goldmark plain, mirror code.
  "lazy-paragraph-then-fence-in-item": [{ line: 4, cause: "lazy continuation" }],
  "lazy-paragraph-then-fence-in-quote": [],
  // Indented code: on every line here goldmark says code and the mirror
  // plain. A block indented four or more columns is never coloured.
  "indent-top-level-fence-line-is-code": [
    { line: 0, cause: "indented code" },
    { line: 1, cause: "indented code" },
  ],
  "indent-quote-line-is-code": [{ line: 0, cause: "indented code" }],
  "indent-marker-line-is-code": [{ line: 0, cause: "indented code" }],
  "indent-fence-in-item-is-code": [{ line: 2, cause: "indented code" }],
  "indent-marker-in-item-is-code": [{ line: 2, cause: "indented code" }],
  "indent-quote-in-item-is-code": [{ line: 2, cause: "indented code" }],
  // "1) " is no list marker to the mirror, so lines 0 and 1 are plain to it.
  // The fence at line 2 then opens a top-level block, which swallows
  // "after": line 3 is goldmark plain, mirror code.
  "paren-list-marker-fence": [
    { line: 0, cause: "`)` marker" },
    { line: 1, cause: "`)` marker" },
    { line: 3, cause: "`)` marker" },
  ],
  "list-starts-at-two": [],
  // "1." alone is an empty list item in CommonMark. The mirror opens no
  // item, so the fence at line 1 is top-level and swallows "text": goldmark
  // plain, mirror code.
  "list-bare-marker-then-fence": [{ line: 3, cause: "list start rule" }],
  // A bare "-" is an empty list item in CommonMark too, and the mirror opens
  // no item here either: the fence at line 1 is top-level and swallows "text".
  // goldmark plain, mirror code.
  "list-bare-bullet-then-fence": [{ line: 3, cause: "list start rule" }],
  "list-continues-at-two": [],
  // "- - -" is a thematic break, not nested list items. To the mirror the
  // fence at line 1 sits inside a list item, which the bare fence at line 3
  // ends; that line then opens a top-level block, which swallows "b":
  // goldmark plain, mirror code.
  "thematic-break-dashes": [{ line: 4, cause: "thematic break" }],
  "thematic-break-stars": [],
  "setext-heading-then-fence": [],
  "two-dashes-are-a-list": [],
  // "<div>" opens an HTML block that runs to the blank line, so lines 1 to 4
  // are plain to goldmark. The mirror opens a fence at line 1: mirror code.
  "html-block-hides-fence-lines": [
    { line: 1, cause: "HTML block" },
    { line: 2, cause: "HTML block" },
    { line: 3, cause: "HTML block" },
    { line: 4, cause: "HTML block" },
  ],
  "marked-unindented-line-ends-item-block": [],
  "marked-blank-lines-inside-item-block": [],
  // A leading tab is four columns: indented code, goldmark code, mirror plain.
  "tab-opener-is-indented-code": [{ line: 0, cause: "indented code" }],
  "tab-before-fence-in-item": [],
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
