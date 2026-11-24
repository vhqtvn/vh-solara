// Composer highlight mirror — fenced code blocks in highlightInput().
//
// Pure logic, default node environment (no jsdom docblock). The mirror is a
// color-only overlay: it must emit exactly the textarea's characters on every
// line or the caret drifts, so each case also checks character parity.
//
// Fence rule (CommonMark): a block is closed ONLY by a run of the opener's
// fence character, at least as long as the opener, followed by nothing but
// whitespace. Three backticks are therefore plain content inside a
// 4-backtick block.
//
// An opener may also sit behind a container prefix (a blockquote marker or a
// list marker). One behind a blockquote marker closes only behind one again.

import { describe, expect, it } from "vitest";
import { highlightInput } from "../../src/lib/composerHighlight";

// escHtml() encodes & < >; inverted so the parity check compares raw characters.
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const unesc = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

// Spans the mirror emits.
const codeSpan = (text: string) => `<span class="hl-code">${esc(text)}</span>`;
const prefixSpan = (cls: "hl-quote" | "hl-marker", prefix: string) =>
  `<span class="${cls}">${esc(prefix)}</span>`;
// One whole-line span — what every fence line and block-content line must be.
const codeLine = (line: string) => codeSpan(line);
const headLine = (line: string) => `<span class="hl-head">${esc(line)}</span>`;

// Runs `lines` through highlightInput() and checks the result line by line:
// the trailing "\n" (mirror height) is preserved, stripping the spans and
// decoding the entities gives every input line back, and the lines listed in
// `codeLines` are ONE whole-line `hl-code` span — no inline spans nested —
// while every other line is not a whole-line code span.
// Returns the split output for exact assertions on the non-code lines.
function expectLines(lines: string[], codeLines: number[] | "all"): string[] {
  const out = highlightInput(lines.join("\n")).split("\n");
  expect(out).toHaveLength(lines.length + 1);
  expect(out[lines.length]).toBe("");
  lines.forEach((line, i) => {
    expect(unesc(out[i].replace(/<\/?span[^>]*>/g, ""))).toBe(line);
    if (codeLines === "all" || codeLines.includes(i)) expect(out[i]).toBe(codeLine(line));
    else expect(out[i]).not.toBe(codeLine(line));
  });
  return out;
}

describe("highlightInput: fenced code blocks", () => {
  it("a 4-backtick block is not closed by a 3-backtick line inside it", () => {
    expectLines(["````md", "foo", "```", "bar", "````"], "all");
  });

  it("markdown resumes right after the real closer", () => {
    const out = expectLines(["````md", "foo", "```", "````", "# after"], [0, 1, 2, 3]);
    expect(out[4]).toBe(headLine("# after"));
  });

  it("a plain 3-backtick block still opens and closes, with or without an info string", () => {
    expectLines(["```", "code block", "```"], "all");
    expectLines(["```go", "x := 1", "```"], "all");
    // Two blocks in a row: closing the first must leave markdown mode.
    const out = expectLines(
      ["```go", "x := 1", "```", "plain text", "```", "again", "```", "# after"],
      [0, 1, 2, 4, 5, 6],
    );
    expect(out[3]).toBe("plain text");
    expect(out[7]).toBe(headLine("# after"));
  });

  it("an opener-looking line is content, and a longer run still closes", () => {
    // A closer may not carry an info string, so "```go" inside the block is
    // content; "`````" (5) closes the 3-backtick block.
    const out = expectLines(["```txt", "inner", "```go", "still code", "`````", "# after"], [0, 1, 2, 3, 4]);
    expect(out[5]).toBe(headLine("# after"));
  });

  it("an unterminated block stays in fence until the end of input", () => {
    expectLines(["```md", "# not a heading", "- not a list item"], "all");
    expectLines(["````", "```", "# not a heading"], "all");
  });

  it("tilde fences work, and neither fence char closes the other's block", () => {
    const tilde = expectLines(["~~~", "```", "inside tilde", "~~~", "# after"], [0, 1, 2, 3]);
    expect(tilde[4]).toBe(headLine("# after"));
    const tick = expectLines(["```", "~~~", "inside backtick", "```", "# after"], [0, 1, 2, 3]);
    expect(tick[4]).toBe(headLine("# after"));
  });

  it("a tilde block obeys the same run-length rule", () => {
    const out = expectLines(["~~~~", "~~~", "~~~~", "# after"], [0, 1, 2]);
    expect(out[3]).toBe(headLine("# after"));
  });

  it("a backtick opener whose info string contains a backtick is an ordinary line", () => {
    const out = expectLines(["``` foo `bar` ```", "# after"], []);
    expect(out[1]).toBe(headLine("# after"));
    // Only backtick openers have that restriction: a tilde opener may carry
    // backticks in its info string.
    expectLines(["~~~ ```", "inside", "~~~"], "all");
  });

  it("indented fence lines still open and close a block (list-nested fences)", () => {
    const out = expectLines(["- item", "  ```", "  code", "  ```", "# after"], [1, 2, 3]);
    expect(out[4]).toBe(headLine("# after"));
  });
});

// A fence opened behind a container prefix. The rest of a blockquote or
// list-marker line is tested with the same opener rule, and a block opened
// behind a blockquote marker closes only behind one again.
describe("highlightInput: a fence behind a container prefix", () => {
  it("opens behind a blockquote marker and closes on a blockquote line", () => {
    const out = expectLines(["> ```js", "> code with **bold**", "> ```", "# after"], [1, 2]);
    expect(out[0]).toBe(prefixSpan("hl-quote", "> ") + codeSpan("```js"));
    expect(out[3]).toBe(headLine("# after"));
  });

  it("opens behind a list marker and closes on an indented bare fence line", () => {
    const out = expectLines(["- ```bash", "  npm install", "  ```", "# after"], [1, 2]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "- ") + codeSpan("```bash"));
    expect(out[3]).toBe(headLine("# after"));
    // An ordered list marker works the same way.
    const ord = expectLines(["10. ```", "x := 1", "```", "# after"], [1, 2]);
    expect(ord[0]).toBe(prefixSpan("hl-marker", "10. ") + codeSpan("```"));
    expect(ord[3]).toBe(headLine("# after"));
  });

  it("a bare fence line does not close a blockquote block", () => {
    const out = expectLines(["> ```md", "> a", "```", "b"], [1, 2, 3]);
    expect(out[0]).toBe(prefixSpan("hl-quote", "> ") + codeSpan("```md"));
  });

  it("a blockquote-prefixed fence line does not close a top-level block", () => {
    const out = expectLines(["```md", "> ```", "foo", "```", "# after"], [0, 1, 2, 3]);
    expect(out[4]).toBe(headLine("# after"));
  });

  it("container lines without a fence render as before", () => {
    const out = expectLines(["> see **bold**", "- see *it*", "> ``", "# after"], []);
    expect(out[0]).toBe(prefixSpan("hl-quote", "> ") + 'see <span class="hl-strong">**bold**</span>');
    expect(out[1]).toBe(prefixSpan("hl-marker", "- ") + 'see <span class="hl-em">*it*</span>');
    // Two backticks are not a fence: an ordinary quote line that opens nothing.
    expect(out[2]).toBe(prefixSpan("hl-quote", "> ") + "``");
    expect(out[3]).toBe(headLine("# after"));
  });

  it("the backtick-in-info-string rule still applies behind a prefix", () => {
    // Neither line is an opener: both stay ordinary container lines, and
    // nothing after them is inside a fence.
    const out = expectLines(["> ``` a`b", "- ``` a`b", "# after"], []);
    expect(out[0].startsWith(prefixSpan("hl-quote", "> "))).toBe(true);
    expect(out[0]).not.toBe(prefixSpan("hl-quote", "> ") + codeSpan("``` a`b"));
    expect(out[1].startsWith(prefixSpan("hl-marker", "- "))).toBe(true);
    expect(out[1]).not.toBe(prefixSpan("hl-marker", "- ") + codeSpan("``` a`b"));
    expect(out[2]).toBe(headLine("# after"));
  });
});
