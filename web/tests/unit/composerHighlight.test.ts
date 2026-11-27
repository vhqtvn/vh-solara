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
// An opener may also sit behind container prefixes (blockquote markers, list
// markers, combined or nested). The block belongs to those containers: it ends
// when one of them ends, and a closer must sit behind the same prefixes again.
//
// A fence, a list marker and a blockquote marker may each be indented at most
// three columns, counted from the start of the content of the container they
// sit in. More is indented code and never a fence — at top level; inside a
// list item the same absolute indentation is real, being counted from the
// item's content.

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
// list-marker line is tested with the same opener rule, and the block ends
// with its container: a closer must sit behind the same prefix again, and a
// line outside the container ends the block.
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
    // An ordered list marker works the same way. Content and closer are indented
    // by the marker's width (4 for "10. ") so that they belong to the list item;
    // a line that is not indented that far ends the block.
    const ord = expectLines(["10. ```", "    x := 1", "    ```", "# after"], [1, 2]);
    expect(ord[0]).toBe(prefixSpan("hl-marker", "10. ") + codeSpan("```"));
    expect(ord[3]).toBe(headLine("# after"));
  });

  it("a bare fence line ends a blockquote block and opens a top-level one", () => {
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

// A block belongs to the containers its opener line sat in. It ends when one
// of them ends — even without a closer line — and the lines after it are
// markdown again. (An opener line behind a prefix is that prefix's span plus
// one code span, so it is asserted on its own rather than as a whole-line
// code span.)
describe("highlightInput: a block ends when its container ends", () => {
  it("a blockquote block ends at a line outside the quote", () => {
    const out = expectLines(["> ```", "> code", "# after"], [1]);
    expect(out[0]).toBe(prefixSpan("hl-quote", "> ") + codeSpan("```"));
    expect(out[2]).toBe(headLine("# after"));
  });

  it("a blank line ends a blockquote block", () => {
    const out = expectLines(["> ```", "> code", "", "# after"], [1]);
    expect(out[0]).toBe(prefixSpan("hl-quote", "> ") + codeSpan("```"));
    expect(out[2]).toBe("");
    expect(out[3]).toBe(headLine("# after"));
  });

  it("a bare fence line outside the quote ends the block and opens a top-level one", () => {
    // Line 3 is inside the new top-level block, so the heading is content.
    const out = expectLines(["> ```js", "> foo", "```", "# after"], [1, 2, 3]);
    expect(out[0]).toBe(prefixSpan("hl-quote", "> ") + codeSpan("```js"));
  });

  it("a list-item block ends at an unindented line", () => {
    const out = expectLines(["- ```", "  code", "# after"], [1]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "- ") + codeSpan("```"));
    expect(out[2]).toBe(headLine("# after"));
  });

  it("a list-item block ends at the next item's line, which renders as a list line", () => {
    const out = expectLines(["- ```", "  a", "- b", "# after"], [1]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "- ") + codeSpan("```"));
    expect(out[2]).toBe(prefixSpan("hl-marker", "- ") + "b");
    expect(out[3]).toBe(headLine("# after"));
  });

  it("a blank line does not end a list-item block", () => {
    const out = expectLines(["- ```", "  a", "", "  b", "  ```", "# after"], [1, 2, 3, 4]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "- ") + codeSpan("```"));
    expect(out[5]).toBe(headLine("# after"));
  });

  it("a fence indented under an ordered item belongs to that item", () => {
    const out = expectLines(["1. run", "", "   ```", "   code", "   ```", "# after"], [2, 3, 4]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "1. ") + "run");
    expect(out[1]).toBe("");
    expect(out[5]).toBe(headLine("# after"));
  });

  it("the inner quote ending ends the block", () => {
    const out = expectLines([">> ```", ">> a", "> b", "# after"], [1]);
    expect(out[0]).toBe(prefixSpan("hl-quote", ">") + codeSpan("> ```"));
    expect(out[2]).toBe(prefixSpan("hl-quote", "> ") + "b");
    expect(out[3]).toBe(headLine("# after"));
  });
});

// An opener is found behind every prefix written on its line, however the
// blockquote and list markers are combined or nested.
describe("highlightInput: an opener behind combined or nested prefixes", () => {
  it("a blockquote marker and a list marker on one line", () => {
    const out = expectLines(["> - ```", ">   code", ">   ```", "# after"], [1, 2]);
    expect(out[0]).toBe(prefixSpan("hl-quote", "> ") + codeSpan("- ```"));
    expect(out[3]).toBe(headLine("# after"));
  });

  it("a doubled blockquote marker", () => {
    const out = expectLines([">> ```", ">> code", ">> ```", "# after"], [1, 2]);
    expect(out[0]).toBe(prefixSpan("hl-quote", ">") + codeSpan("> ```"));
    expect(out[3]).toBe(headLine("# after"));
  });

  it("a blockquote inside a list item", () => {
    const out = expectLines(["- > ```", "  > code", "  > ```", "# after"], [1, 2]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "- ") + codeSpan("> ```"));
    expect(out[3]).toBe(headLine("# after"));
  });

  it("a fence under a nested list item", () => {
    const out = expectLines(["- a", "  - ```", "    code", "    ```", "# after"], [2, 3]);
    expect(out[1]).toBe(prefixSpan("hl-marker", "  - ") + codeSpan("```"));
    expect(out[4]).toBe(headLine("# after"));
  });
});

// A fence, a list marker and a blockquote marker may each be indented at most
// three columns, counted from the start of the content of the container they
// sit in. More is indented code: never a fence, a marker or a quote, and the
// line is code.
describe("highlightInput: indentation bounds", () => {
  it("four columns of indentation is indented code at top level, not a fence", () => {
    const out = expectLines(["    ```", "    a", "# after"], [0, 1]);
    expect(out[2]).toBe(headLine("# after"));
  });

  it("a tab is four columns", () => {
    const out = expectLines(["\t```", "a", "# after"], [0]);
    expect(out[1]).toBe("a");
    expect(out[2]).toBe(headLine("# after"));
  });

  it("three columns of indentation still opens a block", () => {
    const out = expectLines(["   ```", "   a", "   ```", "# after"], [0, 1, 2]);
    expect(out[3]).toBe(headLine("# after"));
  });

  it("four columns is a real fence under a \"10. \" item", () => {
    const out = expectLines(["10. item", "", "    ```", "    a", "    ```", "# after"], [2, 3, 4]);
    expect(out[5]).toBe(headLine("# after"));
  });

  it("a closer indented four columns is content", () => {
    const out = expectLines(["```", "a", "    ```", "b", "```", "# after"], [0, 1, 2, 3, 4]);
    expect(out[5]).toBe(headLine("# after"));
  });

  it("a closer indented four columns inside an item is content", () => {
    const out = expectLines(["- ```", "  a", "      ```", "  b", "  ```", "# after"], [1, 2, 3, 4]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "- ") + codeSpan("```"));
    expect(out[5]).toBe(headLine("# after"));
  });

  it("a fence indented four columns inside an item is indented code", () => {
    const out = expectLines(["- item", "", "      ```", "  # after"], [2]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "- ") + "item");
    expect(out[1]).toBe("");
    // A heading at the item's content column: coloured whole, indentation included.
    expect(out[3]).toBe(headLine("  # after"));
  });

  it("a \">\" indented four columns is not a blockquote", () => {
    // The first line opens the block, behind its quote prefix; the second
    // continues it, behind its quote prefix too.
    const out = expectLines(["    > ```", "    > a", "# after"], []);
    expect(out[0]).toBe(prefixSpan("hl-quote", "    > ") + codeSpan("```"));
    expect(out[1]).toBe(prefixSpan("hl-quote", "    > ") + codeSpan("a"));
    expect(out[2]).toBe(headLine("# after"));
  });

  it("a marker indented four columns is not a list", () => {
    const out = expectLines(["    - ```", "# after"], []);
    expect(out[0]).toBe(prefixSpan("hl-marker", "    - ") + codeSpan("```"));
    expect(out[1]).toBe(headLine("# after"));
  });

  it("a marker indented four columns inside an item does not open a nested item", () => {
    // The fence sits in the outer item, and the indented closer closes it.
    const out = expectLines(["- a", "", "      - b", "  ```", "  x", "  ```", "# after"], [3, 4, 5]);
    expect(out[2]).toBe(prefixSpan("hl-marker", "      - ") + codeSpan("b"));
    expect(out[6]).toBe(headLine("# after"));
  });

  it("a \">\" indented four columns inside an item does not open a quote", () => {
    const out = expectLines(["- a", "", "      > b", "  ```", "  x", "  ```", "# after"], [3, 4, 5]);
    expect(out[2]).toBe(prefixSpan("hl-quote", "      > ") + codeSpan("b"));
    expect(out[6]).toBe(headLine("# after"));
  });

  it("a closer indented four columns behind a quote prefix is content", () => {
    const out = expectLines(["> ```", "> a", ">     ```", "> b", "> ```", "# after"], [1, 2, 3, 4]);
    expect(out[0]).toBe(prefixSpan("hl-quote", "> ") + codeSpan("```"));
    expect(out[5]).toBe(headLine("# after"));
  });
});

// Indented code: a line whose content starts four or more columns past the
// content start of its container opens an indented code block when no
// paragraph is open there. Blank lines and indented lines continue the block;
// any other line ends it before itself. A blank line is code only when an
// indented line follows it.
describe("highlightInput: indented code", () => {
  it("a line indented four columns is code, and a less indented line ends the block", () => {
    const out = expectLines(["    code", "after"], [0]);
    expect(out[1]).toBe("after");
  });

  it("a blank line inside the block is code when an indented line follows it", () => {
    const out = expectLines(["    a", "", "    b", "after"], [0, 1, 2]);
    expect(out[3]).toBe("after");
  });

  it("a blank line that ends the block is not code", () => {
    const out = expectLines(["    a", "", "after"], [0]);
    expect(out[1]).toBe("");
    expect(out[2]).toBe("after");
  });

  it("an indented line cannot interrupt a paragraph", () => {
    const out = expectLines(["text", "    code", "after"], []);
    expect(out[1]).toBe("    code");
  });

  it("a blank line closes the paragraph, so the indented line after it is code", () => {
    const out = expectLines(["text", "", "    code", "after"], [2]);
    expect(out[3]).toBe("after");
  });

  it("inside an item the columns are counted from the item's content", () => {
    const out = expectLines(["- item", "", "      code", "  after"], [2]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "- ") + "item");
    expect(out[3]).toBe("  after");
  });

  it("a line holding only a quote marker is blank for the code block inside the quote", () => {
    const out = expectLines([">     code", ">", ">     more", "after"], []);
    expect(out[0]).toBe(prefixSpan("hl-quote", "> ") + codeSpan("    code"));
    expect(out[1]).toBe(prefixSpan("hl-quote", ">") + codeSpan(""));
    expect(out[2]).toBe(prefixSpan("hl-quote", "> ") + codeSpan("    more"));
    expect(out[3]).toBe("after");
  });

  it("a line holding only a quote marker keeps a fence open inside a quoted list", () => {
    const out = expectLines(["> - ```", ">   a", ">", ">   b", ">   ```", "after"], [1, 2, 3, 4]);
    expect(out[0]).toBe(prefixSpan("hl-quote", "> ") + codeSpan("- ```"));
    expect(out[5]).toBe("after");
  });

  it("a continuation line that carries a quote prefix keeps it as a prefix span", () => {
    const out = expectLines(["    > code", "    > more", "after"], []);
    expect(out[0]).toBe(prefixSpan("hl-quote", "    > ") + codeSpan("code"));
    expect(out[1]).toBe(prefixSpan("hl-quote", "    > ") + codeSpan("more"));
    expect(out[2]).toBe("after");
  });

  it("a continuation line that carries a list marker keeps it as a prefix span", () => {
    const out = expectLines(["    - a", "    - b", "after"], []);
    expect(out[0]).toBe(prefixSpan("hl-marker", "    - ") + codeSpan("a"));
    expect(out[1]).toBe(prefixSpan("hl-marker", "    - ") + codeSpan("b"));
    expect(out[2]).toBe("after");
  });

  it("a heading indented four columns is code", () => {
    const out = expectLines(["    # head", "after"], [0]);
    expect(out[1]).toBe("after");
  });

  it("indented code right after a closed fence is code", () => {
    const out = expectLines(["```", "a", "```", "    code", "after"], [0, 1, 2, 3]);
    expect(out[4]).toBe("after");
  });
});

// An ordered marker is one to nine digits followed by "." or ")", then
// whitespace: ")" is as good as ".", and a run of ten or more digits is no
// marker at all.
describe("highlightInput: ordered-list markers", () => {
  it("a \")\" marker opens an item, and a fence behind it belongs to that item", () => {
    const out = expectLines(["1) ```", "   a", "   ```", "after"], [1, 2]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "1) ") + codeSpan("```"));
    expect(out[3]).toBe("after");
  });

  it("ten digits are not an ordered marker", () => {
    const out = expectLines(["1234567890. ```", "after"], []);
    expect(out[0]).toBe("1234567890. ```");
    expect(out[1]).toBe("after");
  });

  it("nine digits are still an ordered marker", () => {
    const out = expectLines(["123456789. ```", "after"], []);
    expect(out[0]).toBe(prefixSpan("hl-marker", "123456789. ") + codeSpan("```"));
    expect(out[1]).toBe("after");
  });
});

// A thematic break — three or more of one character, "-", "_" or "*", with
// nothing but spaces and tabs between and around them, and nothing else on the
// line — opens no container. "- - -" is therefore not two nested list items: a
// fence on the next line is a top-level one. The break line itself renders as
// it always did.
describe("highlightInput: a thematic break opens no container", () => {
  it("\"- - -\" is a break, not nested list items", () => {
    const out = expectLines(["- - -", "  ```", "  a", "```", "b"], [1, 2, 3]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "- ") + "- -");
  });

  it("\"* * *\" is a break", () => {
    expectLines(["* * *", "  ```", "  a", "```", "b"], [1, 2, 3]);
  });

  it("tabs separate the characters as well as spaces do", () => {
    expectLines(["-\t-\t-", "  ```", "  a", "```", "b"], [1, 2, 3]);
  });

  it("a break at column 0 ends the list above it", () => {
    // The fence is then a top-level one, and nothing closes it.
    const out = expectLines(["- a", "- - -", "  ```", "  a", "after"], [2, 3, 4]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "- ") + "a");
    expect(out[1]).toBe(prefixSpan("hl-marker", "- ") + "- -");
  });

  it("two markers are a list, not a break", () => {
    const out = expectLines(["- - ", "  ```", "  a", "```", "b"], [1, 2, 3, 4]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "- ") + "- ");
  });
});

// A marker alone on a line is a list item too: an empty one, which starts
// with a blank line and whose content begins one column past the marker. A
// fence indented to that column sits inside the item and ends with it, with
// no closer: an unindented line after it is plain.
describe("highlightInput: a bare marker opens a list item", () => {
  it("an ordered marker alone holds a fence indented to its content", () => {
    const out = expectLines(["1.", "   ```", "   a", "text"], [1, 2]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "1."));
    expect(out[3]).toBe("text");
  });

  it("a bullet alone holds a fence indented to its content", () => {
    const out = expectLines(["-", "  ```", "  a", "text"], [1, 2]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "-"));
    expect(out[3]).toBe("text");
  });

  it("a fence one column past the bare marker's content column is still inside the item", () => {
    const out = expectLines(["1.", "    ```", "    a", "text"], [1, 2]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "1."));
    expect(out[3]).toBe("text");
  });

  it("a bare bullet after an item is a second item, holding the fence", () => {
    const out = expectLines(["- a", "-", "  ```", "after"], [2]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "- ") + "a");
    expect(out[1]).toBe(prefixSpan("hl-marker", "-"));
    expect(out[3]).toBe("after");
  });

  it("a bare ordered marker after an item is a second item, holding the fence", () => {
    const out = expectLines(["1. a", "2.", "   ```", "after"], [2]);
    expect(out[0]).toBe(prefixSpan("hl-marker", "1. ") + "a");
    expect(out[1]).toBe(prefixSpan("hl-marker", "2."));
    expect(out[3]).toBe("after");
  });
});

// A paragraph inside a container keeps it open across a lazy line: a
// non-blank line that carries neither the container's prefix nor the start of
// a block. And an empty list item cannot interrupt a paragraph: a bare marker
// after paragraph text is paragraph text, so a fence on the next line stands
// outside every container.
describe("highlightInput: an open paragraph", () => {
  it("a lazy line keeps the item open, so a fence inside it belongs to the item", () => {
    const out = expectLines(["- text", "lazy", "  ```", "  a", "after"], [2, 3]);
    expect(out[1]).toBe("lazy");
    expect(out[4]).toBe("after");
  });

  // A lazy line is rendered like any line without a block: the prefix it
  // carries stays a prefix span.
  it("a lazy line that carries a quote prefix keeps it as a prefix span", () => {
    const out = expectLines(["> > text", "> lazy"], []);
    expect(out[1]).toBe(prefixSpan("hl-quote", "> ") + "lazy");
  });

  it("a lazy line without a prefix is plain inline highlighting", () => {
    const out = expectLines(["> text", "lazy"], []);
    expect(out[1]).toBe("lazy");
  });

  it("a bare ordered marker after paragraph text is paragraph text, not an item", () => {
    const out = expectLines(["text", "1.", "   ```", "after"], [2, 3]);
    expect(out[1]).toBe("1.");
  });

  it("a lone dash after a paragraph is a setext underline, not an item", () => {
    const out = expectLines(["text", "-", "  ```", "after"], [2, 3]);
    expect(out[1]).toBe("-");
  });

  // A bare star or plus is no setext underline: it is an empty list item,
  // which cannot interrupt a paragraph, so the marker is paragraph text.
  it("a bare star after paragraph text is paragraph text, not an item", () => {
    const out = expectLines(["text", "*", "  ```", "after"], [2, 3]);
    expect(out[1]).toBe("*");
  });

  it("a bare plus after paragraph text is paragraph text, not an item", () => {
    const out = expectLines(["text", "+", "  ```", "after"], [2, 3]);
    expect(out[1]).toBe("+");
  });

  // An ordered item can interrupt a paragraph only when it starts at 1.
  it("an ordered item starting at two cannot interrupt a paragraph, so its marker is paragraph text", () => {
    const out = expectLines(["text", "2. item", "   ```", "after"], [2, 3]);
    expect(out[1]).toBe("2. item");
  });

  // Guards: the code lines are the ones goldmark reports for the same lines,
  // as the fixture inputs "paragraph-then-item-then-fence",
  // "paragraph-in-item-then-nested-bare-marker-then-fence" and
  // "heading-closes-paragraph-then-marker-is-an-item" record them in
  // composerHighlight.goldmark.json.
  it("an item with content interrupts a paragraph, so the fence belongs to the item", () => {
    const out = expectLines(["text", "- a", "  ```", "  a", "after"], [2, 3]);
    expect(out[4]).toBe("after");
  });

  // While the item's paragraph is open, the bare marker is returned as text
  // and opens no nested item; the marker line matches a setext underline,
  // which ends the paragraph.
  it("a bare marker inside an item opens no nested item and ends the paragraph as a setext underline", () => {
    const out = expectLines(["- text", "  -", "  ```", "  a", "after"], [2, 3]);
    expect(out[4]).toBe("after");
  });

  it("a heading closes the paragraph, so a bare marker after it is an item holding the fence", () => {
    const out = expectLines(["text", "# head", "1.", "   ```", "after"], [3]);
    expect(out[1]).toBe(headLine("# head"));
    expect(out[2]).toBe(prefixSpan("hl-marker", "1."));
    expect(out[4]).toBe("after");
  });

  // A marker followed by nothing but spaces or tabs up to the end of the line
  // is an empty list item in the same way: after a paragraph it is paragraph
  // text, and the fence on the next line stands at the top level.
  it("a bullet with only a trailing space after paragraph text is paragraph text, not an item", () => {
    const out = expectLines(["text", "- ", "  ```", "after"], [2, 3]);
    expect(out[1]).toBe("- ");
  });

  it("an ordered marker with only a trailing tab after paragraph text is paragraph text, not an item", () => {
    const out = expectLines(["text", "1.\t", "   ```", "after"], [2, 3]);
    expect(out[1]).toBe("1.\t");
  });

  it("a star with only a trailing space after paragraph text is paragraph text, not an item", () => {
    const out = expectLines(["text", "* ", "  ```", "after"], [2, 3]);
    expect(out[1]).toBe("* ");
  });

  it("after a blank line, a bullet with only a trailing space is an item holding the fence", () => {
    const out = expectLines(["text", "", "- ", "  ```", "after"], [3]);
    expect(out[1]).toBe("");
    expect(out[2]).toBe(prefixSpan("hl-marker", "- "));
    expect(out[4]).toBe("after");
  });

  // An ATX heading closes a paragraph: one to six "#", then a space, a tab
  // or the end of the line. The line after it is no lazy continuation, and a
  // bare marker on it is an item.
  it("an empty heading closes the paragraph, so a bare marker after it is an item holding the fence", () => {
    const out = expectLines(["text", "#", "1.", "   ```", "after"], [3]);
    expect(out[2]).toBe(prefixSpan("hl-marker", "1."));
    expect(out[4]).toBe("after");
  });

  it("a heading indented two columns closes the paragraph in the same way", () => {
    const out = expectLines(["text", "  # head", "1.", "   ```", "after"], [3]);
    expect(out[2]).toBe(prefixSpan("hl-marker", "1."));
    expect(out[4]).toBe("after");
  });

  it("a heading inside a blockquote closes its paragraph, so the next line is not lazy", () => {
    const out = expectLines(["> text", "> # head", "lazy", "1.", "   ```", "after"], [4, 5]);
    expect(out[2]).toBe("lazy");
    expect(out[3]).toBe("1.");
  });

  it("a heading inside a list item closes its paragraph, so the next line is not lazy", () => {
    const out = expectLines(["- text", "  # head", "lazy", "1.", "   ```", "after"], [4, 5]);
    expect(out[2]).toBe("lazy");
    expect(out[3]).toBe("1.");
  });

  it("seven hashes are not a heading: the bare marker stays paragraph text and the fence is top-level", () => {
    const out = expectLines(["text", "#######", "1.", "   ```", "after"], [3, 4]);
    expect(out[1]).toBe("#######");
    expect(out[2]).toBe("1.");
  });

  it("hashes without a space after them are not a heading, in the same way", () => {
    const out = expectLines(["text", "#head", "1.", "   ```", "after"], [3, 4]);
    expect(out[1]).toBe("#head");
    expect(out[2]).toBe("1.");
  });

  // A line indented four columns or more cannot interrupt a paragraph: it is
  // paragraph text there, whatever it looks like.
  it("a thematic break indented four columns does not end a paragraph", () => {
    const out = expectLines(["text", "    ---", "1.", "   ```", "after"], [3, 4]);
    expect(out[2]).toBe("1.");
  });

  it("a setext underline indented four columns does not end a paragraph", () => {
    const out = expectLines(["text", "    ===", "1.", "   ```", "after"], [3, 4]);
    expect(out[2]).toBe("1.");
  });

  // Pinned to what goldmark reports for the same lines: the fixture inputs
  // "lazy-line-then-equals-line-then-fence",
  // "lazy-line-then-bare-ordered-marker-then-fence" and
  // "lazy-line-then-ordered-item-starting-at-two-then-fence" in
  // composerHighlight.goldmark.json. Each second line leaves its item: it
  // carries neither the item's marker nor its indentation.
  it("an equals line that leaves its item is paragraph text, so the fence belongs to the item", () => {
    expectLines(["- text", "===", "  ```", "after"], [2]);
  });

  it("a bare ordered marker on a line that leaves its item starts a new list", () => {
    expectLines(["- text", "1.", "  ```", "  a", "after"], [2, 3, 4]);
  });

  it("an ordered item starting at two on a line that leaves its item starts a new list", () => {
    expectLines(["- text", "2. item", "   ```", "after"], [2]);
  });

  // Pinned in the same way to "lazy-line-then-two-dashes-line-then-fence" and
  // "lazy-line-then-three-dashes-line-then-fence".
  it("a two-dashes line that leaves its item is paragraph text, so the fence belongs to the item", () => {
    expectLines(["- text", "--", "  ```", "after"], [2]);
  });

  it("a three-dashes line that leaves its item is a thematic break, so the fence is top-level", () => {
    expectLines(["- text", "---", "  ```", "after"], [2, 3]);
  });

  // Pinned in the same way to "thematic-break-closes-paragraph-then-bare-marker"
  // and "lazy-line-indented-list-marker-in-quote".
  it("a thematic break closes the paragraph, so a bare marker after it is an item holding the fence", () => {
    const out = expectLines(["text", "***", "1.", "   ```", "after"], [3]);
    expect(out[2]).toBe(prefixSpan("hl-marker", "1."));
  });

  it("a lazy line that carries a list prefix keeps it as a prefix span", () => {
    const out = expectLines(["> text", "    - x"], []);
    expect(out[1]).toBe(prefixSpan("hl-marker", "    - ") + "x");
  });
});

// An HTML block — a line starting with "<pre", "<script", "<style" or
// "<textarea", a comment, a processing instruction, a declaration, a CDATA
// section, a block-level tag, or any complete tag alone on the line — holds
// everything up to the line that closes it: the one holding its end marker,
// or the first blank line for a block started by a tag. Nothing inside it is
// code, so a fence-looking or indented line there stays plain. Every kind but
// a tag alone can interrupt a paragraph.
//
// Each case asserts the whole rendering, the mirror's trailing line included:
// a line without a prefix is exactly its plain rendering — the escaped line
// and nothing more — and a code line is one whole-line code span.
describe("highlightInput: HTML blocks", () => {
  it("a <pre> block holds a blank line and an indented line, both plain, and its end tag closes it", () => {
    const out = expectLines(["<pre>", "", "    x", "</pre>", "after"], []);
    expect(out).toEqual([esc("<pre>"), "", esc("    x"), esc("</pre>"), esc("after"), ""]);
  });

  // A guard: the block is closed on the line before the fence.
  it("a fence on the line after a <pre> block's end tag opens a code block", () => {
    const out = expectLines(["<pre>", "</pre>", "```", "a", "```"], [2, 3, 4]);
    expect(out).toEqual([esc("<pre>"), esc("</pre>"), codeLine("```"), codeLine("a"), codeLine("```"), ""]);
  });

  it("a <script> block holds a blank line and a fence line, both plain: a blank line does not close it", () => {
    const out = expectLines(["<script>", "", "```", "x", "</script>", "after"], []);
    expect(out).toEqual([esc("<script>"), "", "```", "x", esc("</script>"), esc("after"), ""]);
  });

  it("a comment holds a fence line, up to the line holding its end", () => {
    const out = expectLines(["<!--", "```", "x", "-->", "after"], []);
    expect(out).toEqual([esc("<!--"), "```", "x", esc("-->"), esc("after"), ""]);
  });

  it("a block-level tag interrupts a paragraph and holds the fence line after it", () => {
    const out = expectLines(["text", "<div>", "```", "after"], []);
    expect(out).toEqual([esc("text"), esc("<div>"), "```", esc("after"), ""]);
  });

  // A guard: a complete tag alone cannot interrupt a paragraph.
  it("a complete tag alone does not interrupt a paragraph, so the fence after it opens a code block", () => {
    const out = expectLines(["text", "<my-tag>", "```", "after"], [2, 3]);
    expect(out).toEqual([esc("text"), esc("<my-tag>"), codeLine("```"), codeLine("after"), ""]);
  });

  it("a complete tag alone on the first line opens a block that holds the fence line after it", () => {
    const out = expectLines(["<my-tag>", "```", "after"], []);
    expect(out).toEqual([esc("<my-tag>"), "```", esc("after"), ""]);
  });

  it("a block inside a blockquote holds the quote's fence lines, and a bare quote marker ends it", () => {
    const quoted = (rest: string) => prefixSpan("hl-quote", "> ") + rest;
    const out = expectLines(["> <div>", "> ```", "> a", ">", "> after"], []);
    expect(out).toEqual([quoted(esc("<div>")), quoted("```"), quoted("a"), prefixSpan("hl-quote", ">"), quoted("after"), ""]);
  });

  it("a block inside a list item holds the item's fence lines, and a blank line ends it", () => {
    const out = expectLines(["- <div>", "  ```", "  a", "", "after"], []);
    expect(out).toEqual([prefixSpan("hl-marker", "- ") + esc("<div>"), "  ```", "  a", "", esc("after"), ""]);
  });

  // A guard: the opener holds its end tag on the same line, so it starts nothing.
  it("a <pre> block closed on its own first line holds nothing, so the fence after it opens a code block", () => {
    const out = expectLines(["<pre>x</pre>", "```", "after"], [1, 2]);
    expect(out).toEqual([esc("<pre>x</pre>"), codeLine("```"), codeLine("after"), ""]);
  });

  it("a processing instruction holds a fence line, up to the line holding its end", () => {
    const out = expectLines(["<?", "```", "?>", "after"], []);
    expect(out).toEqual([esc("<?"), "```", esc("?>"), esc("after"), ""]);
  });

  // The renderer writes every line of an HTML block out escaped and unparsed,
  // so the mirror colours no inline Markdown inside one. A block started by a
  // tag ends only at a blank line, so the third line is inside it too.
  it("inside a block no inline Markdown is coloured: the lines are the escaped text", () => {
    const out = expectLines(["<div> **x**", "`y`", "after *z*"], []);
    expect(out).toEqual([esc("<div> **x**"), esc("`y`"), esc("after *z*"), ""]);
  });

  it("inside a quoted block the quote prefix is a span and the rest is the escaped text", () => {
    const quoted = (rest: string) => prefixSpan("hl-quote", "> ") + rest;
    const out = expectLines(["> <div>", "> **x**", "after"], []);
    expect(out).toEqual([quoted(esc("<div>")), quoted("**x**"), esc("after"), ""]);
  });

  // Guards: the item's paragraph decides whether the block start counts.
  it("a complete tag alone does not interrupt an item's paragraph, so the fence after it opens a code block", () => {
    const out = expectLines(["- text", "<my-tag>", "```", "after"], [2, 3]);
    expect(out).toEqual([prefixSpan("hl-marker", "- ") + "text", esc("<my-tag>"), codeLine("```"), codeLine("after"), ""]);
  });

  it("a comment start does interrupt an item's paragraph, so no line is code", () => {
    const out = expectLines(["- text", "<!--", "```", "after"], []);
    expect(out).toEqual([prefixSpan("hl-marker", "- ") + "text", esc("<!--"), "```", esc("after"), ""]);
  });
});

// The renderer departs from CommonMark 0.31.2 on three HTML start conditions,
// and the mirror follows it: its job is to preview what the reader gets. Each
// departure is pinned by its own row of the Go oracle table.
//
// Each case asserts the whole rendering, the mirror's trailing line included.
describe("highlightInput: HTML blocks follow the renderer", () => {
  it("a lowercase declaration is paragraph text, so it closes no paragraph and the indented line is plain", () => {
    const out = expectLines(["text", "<!doctype html>", "    code", "after"], []);
    expect(out).toEqual(["text", esc("<!doctype html>"), esc("    code"), "after", ""]);
  });

  it("a meta tag counts as a block-level tag: it interrupts the paragraph and holds the fence", () => {
    const out = expectLines(["text", '<meta charset="x">', "```", "after"], []);
    expect(out).toEqual(["text", esc('<meta charset="x">'), "```", "after", ""]);
  });

  it("a kind-1 name closed by \"/>\" starts a block, which holds the fence", () => {
    const out = expectLines(["<pre/>", "```", "after"], []);
    expect(out).toEqual([esc("<pre/>"), "```", "after", ""]);
  });

  it("a quote right after a block-level name starts no block, so the fence opens a code block", () => {
    const out = expectLines(['<div"class">', "```", "after"], [1, 2]);
    expect(out).toEqual([esc('<div"class">'), codeLine("```"), codeLine("after"), ""]);
  });
});

// A heading is coloured by the test that also closes a paragraph — `isHeading`:
// one to six "#", then a space, a tab or the end of the line, the "#" at most
// three columns past the content start. So a bare "#", an indented heading and
// a heading behind a quote or list prefix get the heading colour too: the
// prefix is its own span and the heading span holds the text behind it.
//
// Each case asserts the whole rendering, the mirror's trailing line included.
describe("highlightInput: headings", () => {
  it("a bare # is a heading, and the line after it is plain", () => {
    const out = expectLines(["#", "after"], []);
    expect(out).toEqual([headLine("#"), "after", ""]);
  });

  it("a heading indented up to three columns is one whole heading line", () => {
    const out = expectLines(["  ## two", "after"], []);
    expect(out).toEqual([headLine("  ## two"), "after", ""]);
  });

  it("a heading behind a quote marker: the marker is a prefix span, the heading span holds the text behind it", () => {
    const out = expectLines(["> # title", "after"], []);
    expect(out).toEqual([prefixSpan("hl-quote", "> ") + headLine("# title"), "after", ""]);
  });

  it("a heading behind a list marker: the marker is a prefix span, the heading span holds the text behind it", () => {
    const out = expectLines(["- # title", "after"], []);
    expect(out).toEqual([prefixSpan("hl-marker", "- ") + headLine("# title"), "after", ""]);
  });

  // A guard: the browser spec composer.spec.ts asserts this shape.
  it("a heading at the top of the line is one whole heading line", () => {
    const out = expectLines(["# Heading one", "after"], []);
    expect(out).toEqual([headLine("# Heading one"), "after", ""]);
  });

  // A guard: four columns of indentation make indented code, whatever follows.
  it("a # indented four columns is indented code, not a heading", () => {
    const out = expectLines(["    # four", "after"], [0]);
    expect(out).toEqual([codeLine("    # four"), "after", ""]);
  });
});
