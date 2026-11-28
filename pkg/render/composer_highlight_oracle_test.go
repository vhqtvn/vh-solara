package render

// The conformance oracle for the composer's syntax highlighter
// (web/src/lib/composerHighlight.ts).
//
// The highlighter is the web's own small CommonMark scanner; the daemon
// renders settled messages with goldmark. Where they disagree about which
// lines are code, the compose box shows a block the reader never sees, or
// hides one. This file freezes goldmark's answer — one flag per input line,
// "is this line part of a code block" — in a fixture, and
// web/tests/unit/composerHighlight.goldmark.test.ts holds the highlighter
// against it, with every known deviation listed there by line and cause.
//
// Regenerate the fixture when the oracle itself moves (a goldmark bump, a
// renderer parser change, a new table input):
//
//	go test ./pkg/render/ -run TestComposerHighlightOracleFixture -update
//
// The generator's output is the oracle, so the generator is validated on
// every run, for every input:
//
//   - Every row carries flags (`want`) that hold the renderer's output for
//     that row; three rows carry the renderer's flags where it departs from
//     CommonMark 0.31.2 and say so.
//   - Rendered HTML: the content lines the oracle attributes to code blocks
//     must be the lines the renderer puts inside <pre>, in order — and, for
//     `plain` inputs, with the same text. This check does not read the AST.
//   - The twin parser: a fenced block's fence lines (its opener, and its
//     closer when it has one) are not kept in the AST, and neither is whether
//     the block was closed by a fence or by the end of its container. They
//     are read from a twin of the renderer's markdown that wraps the real
//     fenced-code-block parser in a recorder. The twin must parse every input
//     exactly like the renderer's own: same HTML, same code blocks.

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"html"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/text"
)

// updateComposerOracleFixture is the golden-file switch: with -update, the
// fixture test rewrites the committed fixture instead of comparing with it.
var updateComposerOracleFixture = flag.Bool("update", false,
	"rewrite web/tests/unit/fixtures/composerHighlight.goldmark.json from the goldmark oracle")

// composerOracleFixturePath is the committed oracle, relative to this
// package's directory. web/tests/unit/composerHighlight.goldmark.test.ts
// reads it.
const composerOracleFixturePath = "../../web/tests/unit/fixtures/composerHighlight.goldmark.json"

// oracleInput is one named input of the table.
type oracleInput struct {
	name  string
	lines []string
	// want holds, one flag per line, whether that line is code. Every row
	// carries one. See composerOracleInputs for what a green run proves.
	want []bool
	// plain marks inputs whose code blocks sit at top level behind spaces
	// only, so the HTML the renderer produces shows their content verbatim
	// (up to the block's own indentation). Those get the text check too.
	plain bool
}

// flags turns "TTF" into per-line expectations; any other character is a
// mistake in the table and panics.
func flags(s string) []bool {
	out := make([]bool, len(s))
	for i := range s {
		switch s[i] {
		case 'T':
			out[i] = true
		case 'F':
		default:
			panic(fmt.Sprintf("composer oracle table: flag %q in %q", s[i:i+1], s))
		}
	}
	return out
}

// composerOracleInputs is the table: the shapes a composer block can take.
// Every input is parsed with the renderer's own parser and compared with its
// `want`, which holds the renderer's output for that row. Every row's comment
// but eight names the rule its flags follow; the eight are: fence-tilde,
// fence-blank-line-inside-tildes, double-quote-fence,
// lazy-paragraph-then-fence-in-quote, indent-marker-line-is-code,
// indent-marker-in-item-is-code, indent-quote-in-item-is-code and
// thematic-break-stars. For some rows that rule was written before the
// renderer was run on them; for others it was written after the renderer
// had answered. Which rows are which is not recorded.
//
// Three rows carry the renderer's flags where it departs from CommonMark
// 0.31.2, each with its own comment saying so:
// html-lowercase-declaration-after-paragraph, html-meta-after-paragraph and
// html-self-closing-kind-one-name.
//
// A green run of this test together with a green run of the web conformance
// test (composerHighlight.goldmark.test.ts) shows two things: the highlighter
// and the renderer agree on every row's code flags, and the renderer's code
// flags have not changed on any row since they were written.
var composerOracleInputs = []oracleInput{
	// 1. Top-level fences.
	{
		name:  "fence-plain",
		lines: []string{"```", "a", "```"},
		// Opening fence, content, closing fence.
		want: flags("TTT"), plain: true,
	},
	{
		name:  "fence-info-string",
		lines: []string{"```go", "x := 1", "```"},
		// An info string changes nothing.
		want: flags("TTT"), plain: true,
	},
	{
		name:  "fence-tilde",
		lines: []string{"~~~", "a", "~~~"},
		want:  flags("TTT"), plain: true,
	},
	{
		name:  "fence-four-backticks-hold-three",
		lines: []string{"````", "```", "a", "```", "````"},
		// A closing fence is a run of the opener's character at least as long
		// as the opener: the three-backtick lines are content.
		want: flags("TTTTT"), plain: true,
	},
	{
		name:  "fence-closer-with-info-is-content",
		lines: []string{"```txt", "inner", "```go", "still code", "`````", "# after"},
		// A closing fence carries no info string, so "```go" is content; a
		// longer run closes the block.
		want: flags("TTTTTF"), plain: true,
	},
	{
		name:  "fence-backtick-in-info-is-text",
		lines: []string{"``` foo `bar` ```", "```", "a", "```"},
		// A backtick fence's info string may not contain a backtick: the
		// first line is paragraph text. A fenced block can interrupt a
		// paragraph, so the next line opens one.
		want: flags("FTTT"), plain: true,
	},
	{
		name:  "fence-unclosed",
		lines: []string{"```", "a", "b"},
		// No closing fence: everything to the end of the document is content.
		want: flags("TTT"), plain: true,
	},
	{
		name:  "fence-empty",
		lines: []string{"```", "```", "after"},
		// A closing fence may follow the opening one directly: a block with
		// no content lines.
		want: flags("TTF"), plain: true,
	},
	{
		name:  "fence-blank-line-inside-backticks",
		lines: []string{"```", "a", "", "b", "```"},
		// Blank lines inside a fenced block are content lines.
		want: flags("TTTTT"), plain: true,
	},
	{
		name:  "fence-blank-line-inside-tildes",
		lines: []string{"~~~", "a", "", "b", "~~~"},
		want:  flags("TTTTT"), plain: true,
	},

	// 2. Behind ">": the block belongs to the blockquote.
	{
		name:  "quote-fence-closed",
		lines: []string{"> ```", "> a", "> ```", "after"},
		// Opened and closed behind the quote marker; the blockquote ends at
		// the unquoted line.
		want: flags("TTTF"),
	},
	{
		name:  "quote-fence-unclosed",
		lines: []string{"> ```", "> a", "after"},
		// A code block is not a paragraph, so the unquoted line is not a lazy
		// continuation: the blockquote ends, and with it the block, with no
		// closing fence.
		want: flags("TTF"),
	},
	{
		name:  "quote-blank-line-ends-quoted-block",
		lines: []string{"> ```", "> a", "", "> b", "after"},
		// A blank line ends the blockquote, so it ends the block too; the
		// next quoted line is a new, plain blockquote.
		want: flags("TTFFF"),
	},
	{
		name:  "quote-closer-indented-four-is-content",
		lines: []string{"> ```", "> a", ">     ```", "> b", "> ```", "after"},
		// Measured from the quote's content, the fence run on the third line
		// is indented four columns: content, not a closing fence.
		want: flags("TTTTTF"),
	},
	{
		name:  "quote-bare-fence-does-not-close",
		lines: []string{"> ```md", "> a", "```", "b", "```", "after"},
		// The bare fence line is outside the blockquote, so it ends the quoted
		// block without closing it — and opens a new, top-level one, which the
		// last fence closes.
		want: flags("TTTTTF"),
	},

	// 3. Behind list markers: the block belongs to the list item.
	{
		name:  "list-bullet-fence-closed",
		lines: []string{"- ```", "  a", "  ```", "after"},
		// Content and closing fence sit at the item's content column (2).
		want: flags("TTTF"),
	},
	{
		name:  "list-bullet-fence-unclosed",
		lines: []string{"- ```", "  a", "after"},
		// The unindented line is outside the item: the item ends, and with it
		// the block, with no closing fence.
		want: flags("TTF"),
	},
	{
		name:  "list-ordered-fence",
		lines: []string{"1. ```", "   a", "   ```", "after"},
		// "1. " is three columns wide, so content sits at column 3.
		want: flags("TTTF"),
	},
	{
		name:  "quote-list-fence",
		lines: []string{"> - ```", ">   a", ">   ```", "after"},
		// A list item inside a blockquote.
		want: flags("TTTF"),
	},
	{
		name:  "double-quote-fence",
		lines: []string{">> ```", ">> a", ">> ```", "after"},
		want:  flags("TTTF"),
	},
	{
		name:  "list-quote-fence",
		lines: []string{"- > ```", "  > a", "  > ```", "after"},
		// A blockquote inside a list item.
		want: flags("TTTF"),
	},
	{
		name:  "list-next-item-ends-block-without-closer",
		lines: []string{"- ```", "  a", "- b", "after"},
		// The next item's line is outside the first item, so the block ends
		// without a closing fence; "after" lazily continues item "b".
		want: flags("TTFF"),
	},
	{
		name:  "list-empty-fence",
		lines: []string{"- ```", "  ```", "after"},
		// An empty block behind a list marker: the closing fence sits at the
		// item's content column.
		want: flags("TTF"),
	},

	// 4. Lazy continuation: a paragraph continues outside its container, a
	// code block does not.
	{
		name:  "lazy-paragraph-then-fence-in-item",
		lines: []string{"- text", "lazy", "  ```", "  a", "after"},
		// "lazy" continues the item's paragraph. The fence interrupts that
		// paragraph from inside the item; "after" is outside the item.
		want: flags("FFTTF"),
	},
	{
		name:  "lazy-paragraph-then-fence-in-quote",
		lines: []string{"> text", "lazy", "> ```", "> a", "after"},
		want:  flags("FFTTF"),
	},

	// 5. Indented four or more columns: indented code, never a fence, a
	// marker or a quote.
	{
		name:  "indent-top-level-fence-line-is-code",
		lines: []string{"    ```", "    a", "after"},
		// An opening fence may be indented at most three columns. Four make
		// this an indented code block holding both lines.
		want: flags("TTF"), plain: true,
	},
	{
		name:  "indent-quote-line-is-code",
		lines: []string{"    > a", "after"},
		// A blockquote marker may be indented at most three columns.
		want: flags("TF"),
	},
	{
		name:  "indent-marker-line-is-code",
		lines: []string{"    - a", "after"},
		want:  flags("TF"),
	},
	{
		name:  "indent-fence-in-item-is-code",
		lines: []string{"- item", "", "      ```", "  after"},
		// Six columns is four past the item's content column: indented code
		// inside the item.
		want: flags("FFTF"),
	},
	{
		name:  "indent-marker-in-item-is-code",
		lines: []string{"- item", "", "      - b", "  after"},
		want:  flags("FFTF"),
	},
	{
		name:  "indent-quote-in-item-is-code",
		lines: []string{"- item", "", "      > b", "  after"},
		want:  flags("FFTF"),
	},

	// 6. Ordered-list markers: ")" is one too, and nine digits are the most.
	{
		name:  "paren-list-marker-fence",
		lines: []string{"1) ```", "   a", "   ```", "after"},
		// "1) " opens an ordered list item, three columns wide like "1. ".
		want: flags("TTTF"),
	},
	{
		name:  "list-ten-digits-are-no-marker",
		lines: []string{"1234567890. ```", "after"},
		// Ten digits are no list marker: the line is a paragraph, and the
		// fence it holds is inline text; "after" continues the paragraph.
		want: flags("FF"),
	},
	{
		name:  "list-nine-digits-are-a-marker",
		lines: []string{"123456789. ```", "after"},
		// Nine digits are a list marker, the most there can be. The fence
		// opens inside the item; the unindented line ends both, with no
		// closing fence.
		want: flags("TF"),
	},

	// 7. List start rules.
	{
		name:  "list-starts-at-two",
		lines: []string{"2. item", "", "   ```", "   a", "text"},
		// A list may start at any number. The blank line does not end the
		// item, because the next non-blank line is indented to its content.
		want: flags("FFTTF"),
	},
	{
		name:  "list-bare-marker-then-fence",
		lines: []string{"1.", "   ```", "   a", "text"},
		// "1." alone is an empty list item: one that starts with a blank
		// line, whose content starts at the marker's width plus one (3). The
		// fence is inside the item; the unindented line ends it.
		want: flags("FTTF"),
	},
	{
		name:  "list-bare-bullet-then-fence",
		lines: []string{"-", "  ```", "  a", "text"},
		// A bare bullet is an empty list item in the same way: its content
		// starts at the marker's width plus one (2), so the fence is inside
		// the item and the unindented line ends it.
		want: flags("FTTF"),
	},
	{
		name:  "list-bare-marker-then-deeper-fence",
		lines: []string{"1.", "    ```", "    a", "text"},
		// The fence sits one column past the bare marker's content column
		// (3), still inside the item; the unindented line ends it.
		want: flags("FTTF"),
	},
	{
		name:  "paragraph-then-bare-marker-then-fence",
		lines: []string{"text", "1.", "   ```", "after"},
		// An empty list item cannot interrupt a paragraph: "1." continues
		// it. The fence is therefore at the top level, and with no closing
		// fence it runs to the end of the input.
		want: flags("FFTT"),
	},
	{
		name:  "paragraph-then-lone-dash-is-setext-then-fence",
		lines: []string{"text", "-", "  ```", "after"},
		// A lone "-" under a paragraph reads as a setext heading underline,
		// which also ends the paragraph. The next line is therefore a
		// top-level fence, and with no closing fence it runs to the end of
		// the input.
		want: flags("FFTT"),
	},
	{
		name:  "paragraph-then-bare-star-then-fence",
		lines: []string{"text", "*", "  ```", "after"},
		// An empty list item cannot interrupt a paragraph, and "*" is not
		// a thematic break: the star continues the paragraph. The fence is
		// therefore at the top level, and with no closing fence it runs to
		// the end of the input.
		want: flags("FFTT"),
	},
	{
		name:  "paragraph-then-bare-plus-then-fence",
		lines: []string{"text", "+", "  ```", "after"},
		// The same with "+".
		want: flags("FFTT"),
	},
	{
		name:  "paragraph-then-ordered-item-starting-at-two",
		lines: []string{"text", "2. item", "   ```", "after"},
		// An ordered list must start at 1 to interrupt a paragraph, so
		// "2. item" continues it. The fence is therefore at the top level,
		// and with no closing fence it runs to the end of the input.
		want: flags("FFTT"),
	},
	{
		name:  "item-paragraph-then-ordered-item-starting-at-two",
		lines: []string{"- text", "  2. item", "     ```", "after"},
		// An ordered list must start at 1 to interrupt a paragraph, so
		// inside the item "2. item" continues the item's paragraph. The
		// fence is indented three columns past the item's content and
		// belongs to the item; "after", at column 0, ends it.
		want: flags("FFTF"),
	},
	{
		name:  "quote-paragraph-then-ordered-item-starting-at-two",
		lines: []string{"> text", "2. item", "after"},
		// An ordered list must start at 1 to interrupt a paragraph, so
		// "2. item" is paragraph text: a lazy continuation of the quoted
		// paragraph, which "after" continues the same way.
		want: flags("FFF"),
	},
	{
		name:  "quote-paragraph-then-lazy-ordered-item-starting-at-two-then-fence",
		lines: []string{"> text", "2. item", "   ```", "after"},
		// A line that leaves the quote is judged outside it, where no paragraph is open:
		// "2. item" starts an ordered item, the fence sits inside it, and "after",
		// at column 0, ends it.
		want: flags("FFTF"),
	},
	{
		name:  "paragraph-then-ordered-item-with-leading-zero",
		lines: []string{"text", "01. item", "    ```", "after"},
		// "01." counts as starting at 1, so it opens an item and interrupts
		// the paragraph. The four-space fence sits inside that item, and
		// "after", at column 0, ends it.
		want: flags("FFTF"),
	},
	{
		name:  "paragraph-then-bullet-with-trailing-space-then-fence",
		lines: []string{"text", "- ", "  ```", "after"},
		// A marker followed only by whitespace is an empty list item, which
		// cannot interrupt a paragraph: "- " continues it. The fence is
		// therefore at the top level, and with no closing fence it runs to
		// the end of the input.
		want: flags("FFTT"),
	},
	{
		name:  "paragraph-then-ordered-marker-with-trailing-tab-then-fence",
		lines: []string{"text", "1.\t", "   ```", "after"},
		// The same with "1." and a tab: the marker is still an empty list
		// item.
		want: flags("FFTT"),
	},
	{
		name:  "paragraph-then-star-with-trailing-space-then-fence",
		lines: []string{"text", "* ", "  ```", "after"},
		// The same with "* ".
		want: flags("FFTT"),
	},
	{
		name:  "blank-line-then-bullet-with-trailing-space-then-fence",
		lines: []string{"text", "", "- ", "  ```", "after"},
		// The blank line ends the paragraph, so "- " opens an empty list
		// item whose content starts two columns in. The fence sits there and
		// belongs to the item; "after", at column 0, ends it.
		want: flags("FFFTF"),
	},
	{
		name:  "paragraph-then-indented-dashes-then-marker-then-fence",
		lines: []string{"text", "    ---", "1.", "   ```", "after"},
		// A line indented four columns cannot interrupt a paragraph: the
		// dashes are paragraph text there. The bare marker continues the
		// paragraph too, so the fence is at the top level and, with no
		// closing fence, runs to the end of the input.
		want: flags("FFFTT"),
	},
	{
		name:  "paragraph-then-indented-equals-then-marker-then-fence",
		lines: []string{"text", "    ===", "1.", "   ```", "after"},
		// The same with a setext underline of equals signs.
		want: flags("FFFTT"),
	},
	{
		name:  "paragraph-then-indented-spaced-dashes-then-marker-then-fence",
		lines: []string{"text", "    - - -", "1.", "   ```", "after"},
		// The same with dashes separated by spaces.
		want: flags("FFFTT"),
	},
	{
		name:  "paragraph-then-empty-heading-then-marker-then-fence",
		lines: []string{"text", "#", "1.", "   ```", "after"},
		// A bare "#" is a heading, which ends the paragraph, so "1." opens
		// an empty list item whose content starts three columns in. The
		// fence sits there and belongs to the item; "after", at column 0,
		// ends it.
		want: flags("FFFTF"),
	},
	{
		name:  "paragraph-then-indented-heading-then-marker-then-fence",
		lines: []string{"text", "  # head", "1.", "   ```", "after"},
		// The same with a heading indented two columns, which is still a
		// heading.
		want: flags("FFFTF"),
	},
	{
		name:  "quote-paragraph-then-heading-then-lazy-marker-then-fence",
		lines: []string{"> text", "> # head", "lazy", "1.", "   ```", "after"},
		// The heading ends the quoted paragraph, and only a paragraph
		// continues lazily: "lazy" leaves the quote and starts a paragraph.
		// The empty item "1." cannot interrupt it, so the fence is at the
		// top level and, with no closing fence, runs to the end of the input.
		want: flags("FFFFTT"),
	},
	{
		name:  "item-paragraph-then-heading-then-lazy-marker-then-fence",
		lines: []string{"- text", "  # head", "lazy", "1.", "   ```", "after"},
		// The same inside a list item: the heading ends the item's
		// paragraph, "lazy" leaves the item, and the fence is at the top
		// level.
		want: flags("FFFFTT"),
	},
	{
		name:  "paragraph-then-seven-hashes-then-marker-then-fence",
		lines: []string{"text", "#######", "1.", "   ```", "after"},
		// Seven hashes are too many for a heading: the line is paragraph
		// text, which the empty item "1." continues too. The fence is
		// therefore at the top level and, with no closing fence, runs to the
		// end of the input.
		want: flags("FFFTT"),
	},
	{
		name:  "paragraph-then-hash-without-space-then-marker-then-fence",
		lines: []string{"text", "#head", "1.", "   ```", "after"},
		// A "#" not followed by a space is no heading: the line is paragraph
		// text, which the empty item "1." continues too. The fence is
		// therefore at the top level and, with no closing fence, runs to the
		// end of the input.
		want: flags("FFFTT"),
	},
	{
		name:  "paragraph-then-item-then-fence",
		lines: []string{"text", "- a", "  ```", "  a", "after"},
		// A list item with content can interrupt a paragraph. The fence
		// belongs to the item, and "after" is outside it.
		want: flags("FFTTF"),
	},
	{
		name:  "paragraph-in-item-then-nested-bare-marker-then-fence",
		lines: []string{"- text", "  -", "  ```", "  a", "after"},
		// While the item's paragraph is open, the bare marker is paragraph
		// text and opens no nested item. A lone "-" is also a setext
		// underline, which ends the paragraph. The fence belongs to the item,
		// and "after", outside it, ends it.
		want: flags("FFTTF"),
	},
	{
		name:  "heading-closes-paragraph-then-marker-is-an-item",
		lines: []string{"text", "# head", "1.", "   ```", "after"},
		// The heading closes the paragraph, so the bare marker on the next
		// line interrupts nothing: it is an empty item holding the fence.
		// The fence holds only its opening line: "after", at column 0, ends
		// the item — and with it the block, which has no closing fence.
		want: flags("FFFTF"),
	},
	{
		name:  "blank-line-closes-paragraph-then-marker-is-an-item",
		lines: []string{"text", "", "1.", "   ```", "after"},
		// A blank line closes the paragraph in the same way.
		want: flags("FFFTF"),
	},
	{
		name:  "dash-after-paragraph-is-setext-then-marker-is-an-item",
		lines: []string{"text", "-", "1.", "   ```", "after"},
		// "-" under a paragraph is a setext heading underline, which closes
		// the paragraph in the same way.
		want: flags("FFFTF"),
	},
	{
		name:  "lazy-line-then-bare-marker-then-fence",
		lines: []string{"- text", "-", "  ```", "after"},
		// The bare "-" is a lazy line that opens a second, empty item rather
		// than continuing the first item's paragraph. The fence belongs to
		// that item as an empty block, holding only its opening fence;
		// "after", outside it, ends it.
		want: flags("FFTF"),
	},
	// The line leaves the item, so it is judged outside it, where no paragraph
	// is open: the bare "1." starts a new, empty ordered item and so ends the
	// bullet list. The fence at column 2 sits left of that item's content
	// (column 3), so it ends the list too and opens a top-level block, which
	// holds "a" and "after".
	{
		name:  "lazy-line-then-bare-ordered-marker-then-fence",
		lines: []string{"- text", "1.", "  ```", "  a", "after"},
		want:  flags("FFTTT"),
	},
	// The line leaves the item, so it is judged outside it, where no paragraph
	// is open: "2. item" opens a new ordered item, ending the bullet list,
	// rather than continuing its paragraph. The fence belongs to that item as
	// an empty block, and "after" ends it.
	{
		name:  "lazy-line-then-ordered-item-starting-at-two-then-fence",
		lines: []string{"- text", "2. item", "   ```", "after"},
		want:  flags("FFTF"),
	},
	// "===" is no marker and no block start: a line that does not match the
	// paragraph's own container cannot underline it. It stays paragraph text
	// of the item's open paragraph, so no heading is made; the item stays
	// open, the fence is its empty block, and "after" ends it.
	{
		name:  "lazy-line-then-equals-line-then-fence",
		lines: []string{"- text", "===", "  ```", "after"},
		want:  flags("FFTF"),
	},
	// "--" is no marker (a bullet marker is one character) and no block start,
	// so it is paragraph text of the item's open paragraph: the item stays
	// open, the fence is its empty block, and "after" ends it.
	{
		name:  "lazy-line-then-two-dashes-line-then-fence",
		lines: []string{"- text", "--", "  ```", "after"},
		want:  flags("FFTF"),
	},
	// "---" is a thematic break, a block start wherever it lands, which ends
	// the list: the fence is a top-level block with no closer, so "after" is
	// inside it.
	{
		name:  "lazy-line-then-three-dashes-line-then-fence",
		lines: []string{"- text", "---", "  ```", "after"},
		want:  flags("FFTT"),
	},
	{
		name:  "nested-bare-marker-then-deep-fence",
		lines: []string{"- -", "    ```", "  - a"},
		// The second "-" is a bare marker inside the first item: a nested,
		// empty item whose content starts at column 4. The fence belongs to
		// it; "  - a" is indented less than 4, so it ends that item and the
		// unclosed fence with it.
		want: flags("FTF"),
	},
	{
		name:  "list-second-item-bare-bullet-then-fence",
		lines: []string{"- a", "-", "  ```", "after"},
		// A bare bullet after an item opens a second, empty item. The fence
		// belongs to that item, and "after" ends the item — and with it the
		// fence, which has no closer.
		want: flags("FFTF"),
	},
	{
		name:  "list-second-item-bare-marker-then-fence",
		lines: []string{"1. a", "2.", "   ```", "after"},
		// The same with an ordered marker: the second item's content starts
		// at column 3.
		want: flags("FFTF"),
	},
	{
		name:  "list-continues-at-two",
		lines: []string{"1. item", "2. item", "   ```", "   a", "text"},
		// "2. item" continues the list: same delimiter, still ordered. The
		// fence belongs to that item; the unindented line ends it.
		want: flags("FFTTF"),
	},

	// 8. Thematic breaks.
	{
		name:  "thematic-break-dashes",
		lines: []string{"- - -", "  ```", "  a", "```", "b"},
		// "- - -" is a thematic break, not nested list items: it is no
		// container. The fence is a top-level one, so the bare fence closes
		// it and "b" is a paragraph.
		want: flags("FTTTF"),
	},
	{
		name:  "thematic-break-stars",
		lines: []string{"***", "  ```", "  a", "```", "b"},
		want:  flags("FTTTF"),
	},
	{
		name:  "thematic-break-spaced-stars",
		lines: []string{"* * *", "  ```", "  a", "```", "b"},
		// Stars with spaces between them are a break in the same way as
		// dashes: the fence is a top-level one, and the bare fence closes it.
		want: flags("FTTTF"),
	},
	{
		name:  "thematic-break-tabbed-dashes",
		lines: []string{"-\t-\t-", "  ```", "  a", "```", "b"},
		// Tabs separate the characters as well as spaces do.
		want: flags("FTTTF"),
	},
	{
		name:  "thematic-break-underscores",
		lines: []string{"___", "  ```", "  a", "```", "b"},
		// "_" is the third character a break may be made of.
		want: flags("FTTTF"),
	},
	{
		name:  "thematic-break-ends-list-then-fence",
		lines: []string{"- a", "- - -", "  ```", "  a", "after"},
		// The break ends the list, so the fence at line 2 is a top-level
		// one. Nothing closes it: "after" is inside the block.
		want: flags("FFTTT"),
	},
	{
		name:  "quote-thematic-break",
		lines: []string{"> - - -", "> ```", "> a", "after"},
		// A break may sit inside a blockquote, which it does not end. The
		// fence on the next quote line belongs to the quote and ends with it.
		want: flags("FTTF"),
	},
	{
		name:  "mixed-break-characters-are-a-list",
		lines: []string{"- * -", "  ```", "  a", "```", "b"},
		// A break is three or more of ONE character: "- * -" is a list item
		// with a nested empty item, like "- - ". The bare fence ends that
		// item and opens a top-level block, which holds "b".
		want: flags("FTTTT"),
	},
	{
		name:  "setext-heading-then-fence",
		lines: []string{"text", "---", "  ```", "  a", "```", "b"},
		// "---" under a paragraph line makes a setext heading, not a break
		// or a list.
		want: flags("FFTTTF"),
	},
	{
		name:  "two-dashes-are-a-list",
		lines: []string{"- - ", "  ```", "  a", "```", "b"},
		// Two markers are a list item with an empty nested item, not a break.
		// The fence is in the outer item; the bare fence ends that item
		// without closing the block and opens a top-level one instead.
		want: flags("FTTTT"),
	},

	// 9. HTML blocks.
	{
		name:  "html-block-hides-fence-lines",
		lines: []string{"<div>", "```", "a", "", "after"},
		// An HTML block runs to the next blank line; fence-looking lines
		// inside it are its raw content, not code.
		want: flags("FFFFF"),
	},

	// 10. Shapes where the `marked` library is known to be wrong (the client
	// declares marked ^18.1.1, its in-flight renderer; that version was not
	// re-checked for these rows): the highlighter is expected to agree with
	// goldmark here.
	{
		name:  "marked-unindented-line-ends-item-block",
		lines: []string{"- ```", "  a", "b", "  ```", "after"},
		// "b" is outside the item and ends it, so the block has no closing
		// fence. The indented fence line does not continue the paragraph "b"
		// lazily: paragraph continuation text is text that is not a block
		// start, and a fence indented up to three columns is one. It opens a
		// top-level block that holds "after".
		want: flags("TTFTT"),
	},
	{
		name:  "marked-blank-lines-inside-item-block",
		lines: []string{"- x", "", "  ```", "  a", "", "  b", "y", "after"},
		// The blank line inside the block is content; "y" is outside the item
		// and ends the block without a closing fence.
		want: flags("FFTTTTFF"),
	},

	// 11. Tabs count as four columns.
	{
		name:  "tab-opener-is-indented-code",
		lines: []string{"\t```", "a", "after"},
		// A leading tab is four columns: an indented code block of one line.
		want: flags("TFF"),
	},
	{
		name:  "tab-before-fence-in-item",
		lines: []string{"- x", "\t```", "\ta", "after"},
		// The tab reaches column 4, which is two past the item's content
		// column: a fence inside the item.
		want: flags("FTTF"),
	},

	// 12. Indented code blocks, and the lines around them.
	// The indented line opens an indented code block; "after" is not blank
	// and not indented, so it ends the block before itself.
	{
		name:  "indent-code-plain",
		lines: []string{"    code", "after"},
		want:  flags("TF"),
	},
	// The first indented line opens an indented code block. The blank line
	// and the indented line after it continue it, so the blank line is inside
	// the block; "after" ends it before itself.
	{
		name:  "indent-code-blank-line-inside",
		lines: []string{"    a", "", "    b", "after"},
		want:  flags("TTTF"),
	},
	// The indented line opens an indented code block. The blank line after it
	// would continue it, but "after" ends the block, and a blank line that
	// trails an indented code block is not part of it.
	{
		name:  "indent-code-trailing-blank-line",
		lines: []string{"    a", "", "after"},
		want:  flags("TFF"),
	},
	// The first indented line opens a block that "text" ends before itself;
	// the blank line between them trails the block and is not part of it.
	// "text" is a paragraph, which the next blank line ends, and with no
	// paragraph open the last indented line opens a second block.
	{
		name:  "indent-code-two-blocks",
		lines: []string{"    a", "", "text", "", "    b"},
		want:  flags("TFFFT"),
	},
	// Indented code cannot interrupt a paragraph: with "text" still open, the
	// indented line is paragraph text, and so is "after".
	{
		name:  "indent-code-cannot-interrupt-paragraph",
		lines: []string{"text", "    code", "after"},
		want:  flags("FFF"),
	},
	// The blank line ends the paragraph "text" opened, so with no paragraph
	// open the indented line opens an indented code block; "after" ends it
	// before itself.
	{
		name:  "indent-code-after-blank-line",
		lines: []string{"text", "", "    code", "after"},
		want:  flags("FFTF"),
	},
	// The first line opens an indented code block. "  b" is indented only two
	// columns, so it is not an indented line: it ends the block before itself
	// and opens a paragraph, which "after" continues.
	{
		name:  "indent-code-less-indent-ends",
		lines: []string{"    a", "  b", "after"},
		want:  flags("TFF"),
	},
	// The first line opens an indented code block. The fence line is neither
	// blank nor indented, so it ends that block before itself, and it opens a
	// fenced code block, which holds "b" up to its closing fence.
	{
		name:  "indent-code-then-fence",
		lines: []string{"    a", "```", "b", "```"},
		want:  flags("TTTT"),
	},
	// The blank line ends the item's paragraph. The six-space line sits four
	// columns past the item's content (column 2), so with no paragraph open it
	// opens an indented code block in the item; "  after" is a paragraph line
	// of the item and ends the block before itself.
	{
		name:  "indent-code-in-item",
		lines: []string{"- item", "", "      code", "  after"},
		want:  flags("FFTF"),
	},
	// Behind ">", four columns of indentation open an indented code block
	// inside the quote. "after" carries no quote marker, and a code block,
	// not a paragraph, was last inside the quote, so it ends before "after".
	{
		name:  "indent-code-in-quote",
		lines: []string{">     code", "after"},
		want:  flags("TF"),
	},
	// An indented line cannot interrupt the quote's paragraph: it continues
	// it, and nothing is code.
	{
		name:  "indent-code-lazy-line-in-quote",
		lines: []string{"> text", "    code"},
		want:  flags("FF"),
	},
	// Inside the item the line is indented two columns past its content
	// start, not four: a paragraph, not code. "after" is a lazy line of it.
	{
		name:  "indent-two-spaces-in-item-is-paragraph",
		lines: []string{"- item", "", "    code", "after"},
		want:  flags("FFFF"),
	},
	// In the item, "      a" starts four columns past its content start:
	// code. "after" leaves the item, and a code block, not a paragraph, was
	// last, so it is a plain paragraph; the indented "      b" cannot
	// interrupt a paragraph.
	{
		name:  "indent-code-in-item-then-plain-then-indent",
		lines: []string{"- item", "", "      a", "after", "      b"},
		want:  flags("FFTFF"),
	},
	// The bare ">" is a blank line for the quote: it ends the paragraph.
	// ">       code" starts four columns past the item's content start, so
	// it is code. "after" leaves the quote, and a code block was last.
	{
		name:  "indent-code-in-item-inside-quote",
		lines: []string{"> - text", ">", ">       code", "after"},
		want:  flags("FFTF"),
	},
	// "***" is a thematic break, which ends the paragraph; the bare "1."
	// then opens an empty item, with no paragraph above it to continue. The
	// fence sits at the item's content start: code. "after" ends the item
	// and its unclosed block.
	{
		name:  "thematic-break-closes-paragraph-then-bare-marker",
		lines: []string{"text", "***", "1.", "   ```", "after"},
		want:  flags("FFFTF"),
	},
	// Indented four columns, the marker starts no item and cannot interrupt
	// the quote's paragraph: the line continues it.
	{
		name:  "lazy-line-indented-list-marker-in-quote",
		lines: []string{"> text", "    - x"},
		want:  flags("FF"),
	},
	// The bare ">" is a blank line inside the quote's indented code block,
	// which it continues: code, like ">     more". "after" leaves the quote,
	// where a code block was last.
	{
		name:  "quote-marked-blank-line-inside-indented-code",
		lines: []string{">     code", ">", ">     more", "after"},
		want:  flags("TTTF"),
	},
	// The fence belongs to the quote and the item; the bare ">", a blank
	// line, continues it. Opener, content, blank line and closer are code.
	// "after" leaves the quote, where a code block was last.
	{
		name:  "quote-marked-blank-line-keeps-fence-in-quoted-list",
		lines: []string{"> - ```", ">   a", ">", ">   b", ">   ```", "after"},
		want:  flags("TTTTTF"),
	},
	// The bare ">" is a blank line for the quote: it ends the item's
	// paragraph, and ">   more" starts a new one. "after" is a lazy line of
	// that paragraph.
	{
		name:  "quote-marked-blank-line-closes-item-paragraph",
		lines: []string{"> - text", ">", ">   more", "after"},
		want:  flags("FFFF"),
	},
	// The bare ">" is a blank line for the quote: it ends the paragraph, and
	// "> more" starts a new one. "after" is a lazy line of that paragraph.
	{
		name:  "quote-marked-blank-line-closes-paragraph",
		lines: []string{"> text", ">", "> more", "after"},
		want:  flags("FFFF"),
	},
	// The fence is closed by its closer, so no block is open: "    code" is
	// indented code, which "after" ends before itself.
	{
		name:  "indent-code-after-fence",
		lines: []string{"```", "a", "```", "    code", "after"},
		want:  flags("TTTTF"),
	},
	// A heading may be indented three columns at most: "    # head" is not
	// one but indented code, which "after" ends before itself.
	{
		name:  "indent-code-indented-heading",
		lines: []string{"    # head", "after"},
		want:  flags("TF"),
	},
	// The item's content starts one column past the marker (the five spaces
	// do not all count), so "code" is indented four columns there: the
	// first line of an indented code block. "  continued" sits at the item's
	// content start: it ends the block and is a paragraph, of which "after"
	// is a lazy line.
	{
		name:  "indent-code-item-first-line-then-continuation",
		lines: []string{"-     code", "  continued", "after"},
		want:  flags("TFF"),
	},
	// A tab advances to the next tab stop, four columns: "\tb" is indented
	// like "    a" and continues the block. "after" ends it before itself.
	{
		name:  "indent-code-tab-continuation",
		lines: []string{"    a", "\tb", "after"},
		want:  flags("TTF"),
	},
	// "        b" is indented, so it continues the block that "    a"
	// opened. "after" ends it before itself.
	{
		name:  "indent-code-more-indented-continuation",
		lines: []string{"    a", "        b", "after"},
		want:  flags("TTF"),
	},

	// 13. HTML blocks.
	// "<pre>" opens an HTML block that holds everything up to "</pre>": the
	// blank line, which does not end it, and the indented line, which is not
	// code inside it. "after" follows the block.
	{
		name:  "html-pre-holds-blank-and-indented-lines",
		lines: []string{"<pre>", "", "    x", "</pre>", "after"},
		want:  flags("FFFFF"),
	},
	// "</pre>" holds the end marker, so the block ends on that line; the fence
	// after it opens a code block, closed on the last line.
	{
		name:  "html-pre-close-then-fence",
		lines: []string{"<pre>", "</pre>", "```", "a", "```"},
		want:  flags("FFTTT"),
	},
	// "<script>" opens an HTML block that holds everything up to "</script>":
	// the blank line and the fence line, which is no fence inside it. "after"
	// follows the block.
	{
		name:  "html-script-holds-blank-and-fence",
		lines: []string{"<script>", "", "```", "x", "</script>", "after"},
		want:  flags("FFFFFF"),
	},
	// "<!--" opens an HTML block that holds the fence line up to "-->", the
	// line holding its end marker. "after" follows the block.
	{
		name:  "html-comment-holds-fence",
		lines: []string{"<!--", "```", "x", "-->", "after"},
		want:  flags("FFFFF"),
	},
	// "<!--" opens an HTML block that holds the blank line, which does not end
	// it, up to "-->". "after" follows the block.
	{
		name:  "html-comment-holds-blank-line",
		lines: []string{"<!--", "", "-->", "after"},
		want:  flags("FFFF"),
	},
	// "<?" opens an HTML block that holds the fence line up to "?>", the line
	// holding its end marker. "after" follows the block.
	{
		name:  "html-processing-instruction-holds-fence",
		lines: []string{"<?", "```", "?>", "after"},
		want:  flags("FFFF"),
	},
	// "<!X" is a declaration: it opens an HTML block that holds the fence line
	// up to ">", the line holding its end marker. "after" follows the block.
	{
		name:  "html-declaration-holds-fence",
		lines: []string{"<!X", "```", ">", "after"},
		want:  flags("FFFF"),
	},
	// "<![CDATA[" opens an HTML block that holds the fence line up to "]]>",
	// the line holding its end marker. "after" follows the block.
	{
		name:  "html-cdata-holds-fence",
		lines: []string{"<![CDATA[", "```", "]]>", "after"},
		want:  flags("FFFF"),
	},
	// "<div>", a block-level tag, opens an HTML block that ends at a blank
	// line: there is none, so it holds the fence line and "a".
	{
		name:  "html-unterminated-div-holds-fence",
		lines: []string{"<div>", "```", "a"},
		want:  flags("FFF"),
	},
	// A block-level tag interrupts a paragraph: "<div>" opens an HTML block,
	// which holds the fence line and "after", there being no blank line.
	{
		name:  "html-div-after-paragraph-is-text",
		lines: []string{"text", "<div>", "```", "after"},
		want:  flags("FFFF"),
	},
	// A complete tag alone on the line opens an HTML block when no paragraph
	// is open: it holds the fence line and "after", there being no blank line.
	{
		name:  "html-custom-tag-alone-is-a-block",
		lines: []string{"<my-tag>", "```", "after"},
		want:  flags("FFF"),
	},
	// The tag is not alone on the line, so it starts no block: the line is a
	// paragraph, which the fence interrupts; the code block holds "after".
	{
		name:  "html-custom-tag-with-text-is-paragraph",
		lines: []string{"<my-tag>text", "```", "after"},
		want:  flags("FTT"),
	},
	// A complete tag alone cannot interrupt a paragraph: "<my-tag>" continues
	// it, and the fence after it opens a code block, which holds "after".
	{
		name:  "html-custom-tag-after-paragraph-is-text",
		lines: []string{"text", "<my-tag>", "```", "after"},
		want:  flags("FFTT"),
	},
	// A block-level closing tag alone on the line opens an HTML block, which
	// holds the fence line and "after", there being no blank line.
	{
		name:  "html-closing-tag-alone-is-a-block",
		lines: []string{"</div>", "```", "after"},
		want:  flags("FFF"),
	},
	// An HTML block starts on an unindented line: indented four columns, the
	// tag line is indented code. "after" ends the block before itself.
	{
		name:  "html-indented-tag-is-indented-code",
		lines: []string{"    <div>", "after"},
		want:  flags("TF"),
	},
	// "<div>" opens an HTML block in the quote: it holds the quote's fence
	// line and "a", up to the quote's blank line. "> after" is a paragraph.
	{
		name:  "html-block-in-quote",
		lines: []string{"> <div>", "> ```", "> a", ">", "> after"},
		want:  flags("FFFFF"),
	},
	// "<div>" opens an HTML block in the item: it holds the item's fence line
	// and "a", up to the blank line. "after" is outside the item.
	{
		name:  "html-block-in-list",
		lines: []string{"- <div>", "  ```", "  a", "", "after"},
		want:  flags("FFFFF"),
	},
	// The line does not start with the tag, so it is a paragraph, which the
	// fence interrupts; the code block holds "after".
	{
		name:  "html-tag-inside-paragraph-line",
		lines: []string{"text <div> more", "```", "after"},
		want:  flags("FTT"),
	},
	// The indented line opens indented code, which "<script>" ends before
	// itself; it opens an HTML block that, having no end marker, holds "after".
	{
		name:  "html-script-inside-indented-code",
		lines: []string{"    a", "<script>", "after"},
		want:  flags("TFF"),
	},
	// The line holds both "<pre" and its end marker, so the block is that one
	// line; the fence after it opens a code block, which holds "after".
	{
		name:  "html-pre-closes-on-the-same-line",
		lines: []string{"<pre>x</pre>", "```", "after"},
		want:  flags("FTT"),
	},
	// Start condition 4: the spec gives FFTF — "<!" then any letter starts a
	// block that interrupts the paragraph, so the indented line is code. The
	// renderer gives FFFF: its declaration starts with an uppercase letter
	// only, so the line is paragraph text and "    code" continues it. The
	// mirror follows the renderer.
	{
		name:  "html-lowercase-declaration-after-paragraph",
		lines: []string{"text", "<!doctype html>", "    code", "after"},
		want:  flags("FFFF"),
	},
	// The spec gives FFTT: "meta" is not in the condition-6 name list, so the
	// line is paragraph text and the fence is code. The renderer gives FFFF:
	// it counts "meta" as a block-level tag, so the line starts a block that
	// holds the fence. The mirror follows the renderer.
	{
		name:  "html-meta-after-paragraph",
		lines: []string{"text", "<meta charset=\"x\">", "```", "after"},
		want:  flags("FFFF"),
	},
	// The spec gives FTT: condition 1 needs a space, tab, ">" or the end of
	// the line after the name, and condition 7 excludes the kind-1 names, so
	// the line is a paragraph and the fence is code. The renderer gives FFF:
	// it lets "/>" follow the name, so the line starts a block that holds the
	// fence. The mirror follows the renderer.
	{
		name:  "html-self-closing-kind-one-name",
		lines: []string{"<pre/>", "```", "after"},
		want:  flags("FFF"),
	},
	// Condition 6 allows a tab after the name; the block runs until a blank
	// line.
	{
		name:  "html-tab-after-block-tag-name",
		lines: []string{"<div\tclass=\"x\">", "```", "after"},
		want:  flags("FFF"),
	},
	// Condition 1 allows a tab after the name; the block runs until "</pre>".
	{
		name:  "html-tab-after-kind-one-name",
		lines: []string{"<pre\tclass=\"x\">", "```", "</pre>", "after"},
		want:  flags("FFFF"),
	},
	// Condition 6 allows a space, tab, the end of the line, ">" and "/>" after
	// the name, but no quote: a paragraph; the fence is code.
	{
		name:  "html-quote-after-block-tag-name",
		lines: []string{"<div\"class\">", "```", "after"},
		want:  flags("FTT"),
	},
	// Condition 7 cannot interrupt a paragraph, so the tag is lazy text of the
	// quote's paragraph; the fence is a block start outside the quote, never
	// closed.
	{
		name:  "lazy-line-then-tag-alone-then-fence",
		lines: []string{"> text", "<my-tag>", "```", "after"},
		want:  flags("FFTT"),
	},
	// Condition 2 interrupts the paragraph, so the quote ends; the block runs
	// until "-->", which never comes.
	{
		name:  "lazy-line-then-comment-start-then-fence",
		lines: []string{"> text", "<!--", "```", "after"},
		want:  flags("FFFF"),
	},
	// Condition 1: the block holds the fence and ends on "</style>".
	{
		name:  "html-style-holds-fence",
		lines: []string{"<style>", "```", "x", "</style>", "after"},
		want:  flags("FFFFF"),
	},
	// Condition 1: the block holds the fence and ends on "</textarea>".
	{
		name:  "html-textarea-holds-fence",
		lines: []string{"<textarea>", "```", "x", "</textarea>", "after"},
		want:  flags("FFFFF"),
	},
	// Condition 2 interrupts the paragraph; the block ends on "-->".
	{
		name:  "html-comment-interrupts-paragraph",
		lines: []string{"text", "<!--", "```", "-->", "after"},
		want:  flags("FFFFF"),
	},
	// Condition 1 interrupts the paragraph; the block ends on "</pre>".
	{
		name:  "html-pre-interrupts-paragraph",
		lines: []string{"text", "<pre>", "```", "</pre>", "after"},
		want:  flags("FFFFF"),
	},

	// 14. Headings behind a prefix do not change what is code.
	{
		name:  "bare-hash-then-fence",
		lines: []string{"#", "```", "a", "```"},
		// A bare "#" is a heading, which closes a paragraph; the fence on the
		// next line opens a top-level block, which the last fence closes.
		want: flags("FTTT"), plain: true,
	},
	{
		name:  "quote-heading-then-fence",
		lines: []string{"> # h", "> ```", "> a", "> ```", "after"},
		// The heading sits in the blockquote; the fence belongs to the quote
		// and ends with it.
		want: flags("FTTTF"),
	},
	{
		name:  "list-heading-then-fence",
		lines: []string{"- # h", "  ```", "  a", "  ```", "after"},
		// The heading is the item's first block; the fence belongs to the
		// item and ends with it.
		want: flags("FTTTF"),
	},
}

// oracleBlock is one code block of a parse.
type oracleBlock struct {
	kind    ast.NodeKind // KindFencedCodeBlock, or KindCodeBlock (indented)
	content []int        // 0-based line indexes of the content lines
	opener  int          // fenced only: the opening fence's line; -1 otherwise
	closer  int          // fenced only: the closing fence's line, or -1 when the block ended without one
}

// oracleEntry is one input as the fixture holds it.
type oracleEntry struct {
	Name  string   `json:"name"`
	Lines []string `json:"lines"`
	Code  []bool   `json:"code"`
}

// fenceSpy wraps goldmark's fenced-code-block parser and records what the AST
// does not keep. For each fenced block: the line its opening fence is on, and
// the line of the closing fence when the parser itself closed the block on
// one. A block that ended because its list item or blockquote ended has no
// entry in closer.
type fenceSpy struct {
	parser.BlockParser
	opener map[ast.Node]int
	closer map[ast.Node]int
}

func (s *fenceSpy) Open(parent ast.Node, reader text.Reader, pc parser.Context) (ast.Node, parser.State) {
	line, _ := reader.Position()
	node, state := s.BlockParser.Open(parent, reader, pc)
	if node != nil {
		s.opener[node] = line
	}
	return node, state
}

func (s *fenceSpy) Continue(node ast.Node, reader text.Reader, pc parser.Context) parser.State {
	line, _ := reader.Position()
	state := s.BlockParser.Continue(node, reader, pc)
	if state&parser.Close != 0 {
		s.closer[node] = line
	}
	return state
}

// newFenceSpyMarkdown builds the twin: the renderer's own markdown — the
// default block parsers, inline parsers and paragraph transformers, and the
// same extensions — with the fenced-code-block parser wrapped by a recorder.
// The test fails unless exactly that one parser was swapped.
func newFenceSpyMarkdown(t *testing.T) (goldmark.Markdown, *fenceSpy) {
	t.Helper()
	real := parser.NewFencedCodeBlockParser()
	spy := &fenceSpy{
		BlockParser: real,
		opener:      map[ast.Node]int{},
		closer:      map[ast.Node]int{},
	}
	bps := parser.DefaultBlockParsers()
	swapped := 0
	for i := range bps {
		if bps[i].Value == any(real) {
			bps[i].Value = spy
			swapped++
		}
	}
	if swapped != 1 {
		t.Fatalf("swapped %d block parsers, want exactly 1: goldmark's default block parser list changed", swapped)
	}
	p := parser.NewParser(
		parser.WithBlockParsers(bps...),
		parser.WithInlineParsers(parser.DefaultInlineParsers()...),
		parser.WithParagraphTransformers(parser.DefaultParagraphTransformers()...),
	)
	md := goldmark.New(
		goldmark.WithParser(p),
		goldmark.WithExtensions(extension.GFM, newCodeHighlighter(), newRawHTMLRenderer()),
	)
	return md, spy
}

// lineStarts returns the byte offset at which each line of src begins.
func lineStarts(src []byte) []int {
	starts := []int{0}
	for i, c := range src {
		if c == '\n' && i+1 < len(src) {
			starts = append(starts, i+1)
		}
	}
	return starts
}

// lineOf returns the 0-based index of the line holding byte offset off. A
// segment's start may sit anywhere in its line, behind a quote or list
// prefix.
func lineOf(starts []int, off int) int {
	return sort.Search(len(starts), func(i int) bool { return starts[i] > off }) - 1
}

// codeBlocks parses src with md and lists its code blocks in document order,
// with their content lines. With a spy, fenced blocks also carry their fence
// lines.
func codeBlocks(md goldmark.Markdown, spy *fenceSpy, src []byte) ([]oracleBlock, error) {
	doc := md.Parser().Parse(text.NewReader(src))
	starts := lineStarts(src)
	var blocks []oracleBlock
	err := ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		kind := n.Kind()
		if kind != ast.KindFencedCodeBlock && kind != ast.KindCodeBlock {
			return ast.WalkContinue, nil
		}
		b := oracleBlock{kind: kind, opener: -1, closer: -1}
		lines := n.Lines()
		for i := 0; i < lines.Len(); i++ {
			off := lines.At(i).Start
			if off < 0 || off > len(src) {
				return ast.WalkStop, fmt.Errorf("%s: content segment at byte %d is outside the %d-byte source", kind, off, len(src))
			}
			b.content = append(b.content, lineOf(starts, off))
		}
		if kind == ast.KindFencedCodeBlock && spy != nil {
			opener, ok := spy.opener[n]
			if !ok {
				return ast.WalkStop, fmt.Errorf("fenced code block with content lines %v: the recorder saw no opening fence", b.content)
			}
			b.opener = opener
			if closer, ok := spy.closer[n]; ok {
				b.closer = closer
			}
		}
		blocks = append(blocks, b)
		return ast.WalkContinue, nil
	})
	return blocks, err
}

// checkFence holds the recorder's facts against what the AST does keep: the
// content lines run on from one another, the opening fence is the line right
// before the first content line, and a closing fence is the line right after
// the last one.
func checkFence(b oracleBlock, nlines int) error {
	inRange := func(l int) bool { return l >= 0 && l < nlines }
	if !inRange(b.opener) {
		return fmt.Errorf("opening fence line %d is outside the %d-line input", b.opener, nlines)
	}
	if b.closer >= 0 && !inRange(b.closer) {
		return fmt.Errorf("closing fence line %d is outside the %d-line input", b.closer, nlines)
	}
	for i, l := range b.content {
		if l != b.content[0]+i {
			return fmt.Errorf("content lines %v do not run on from one another", b.content)
		}
	}
	first, last := b.opener, b.opener
	if len(b.content) > 0 {
		first, last = b.content[0], b.content[len(b.content)-1]
		if b.opener != first-1 {
			return fmt.Errorf("opening fence on line %d, but the content starts on line %d", b.opener, first)
		}
	}
	if b.closer >= 0 && b.closer != last+1 {
		return fmt.Errorf("closing fence on line %d, but the content ends on line %d", b.closer, last)
	}
	return nil
}

// oracleFlags parses src with the renderer's own parser and returns, per line,
// whether the line is part of a code block: for a fenced block its opening
// fence, its content (blank lines included) and its closing fence when it has
// one; for an indented block its content lines.
func oracleFlags(r *Renderer, twin goldmark.Markdown, spy *fenceSpy, src []byte, nlines int) ([]bool, []oracleBlock, error) {
	own, err := codeBlocks(r.md, nil, src)
	if err != nil {
		return nil, nil, fmt.Errorf("the renderer's parser: %w", err)
	}
	blocks, err := codeBlocks(twin, spy, src)
	if err != nil {
		return nil, nil, fmt.Errorf("the twin parser: %w", err)
	}
	// The twin is only trusted for the fence lines if it sees the same code
	// blocks as the renderer's own parser.
	if len(own) != len(blocks) {
		return nil, nil, fmt.Errorf("the renderer's parser sees %d code blocks, the twin %d", len(own), len(blocks))
	}
	for i := range own {
		if own[i].kind != blocks[i].kind || !slices.Equal(own[i].content, blocks[i].content) {
			return nil, nil, fmt.Errorf("code block %d differs: the renderer's parser %s %v, the twin %s %v",
				i, own[i].kind, own[i].content, blocks[i].kind, blocks[i].content)
		}
	}
	flags := make([]bool, nlines)
	for _, b := range blocks {
		if b.kind == ast.KindFencedCodeBlock {
			if err := checkFence(b, nlines); err != nil {
				return nil, nil, err
			}
			flags[b.opener] = true
			if b.closer >= 0 {
				flags[b.closer] = true
			}
		}
		for _, l := range b.content {
			flags[l] = true
		}
	}
	return flags, blocks, nil
}

var oracleTag = regexp.MustCompile(`<[^>]*>`)

// preTexts returns the text of every <pre> element in s — tags stripped,
// entities decoded — in document order. The renderer emits one per code
// block.
func preTexts(s string) ([]string, error) {
	var out []string
	for {
		a := strings.Index(s, "<pre")
		if a < 0 {
			return out, nil
		}
		opened := strings.Index(s[a:], ">")
		if opened < 0 {
			return nil, fmt.Errorf("unterminated <pre tag in %q", s[a:a+min(len(s)-a, 40)])
		}
		ended := strings.Index(s[a+opened:], "</pre>")
		if ended < 0 {
			return nil, fmt.Errorf("unclosed <pre> element in the rendered HTML")
		}
		inner := s[a+opened+1 : a+opened+ended]
		out = append(out, html.UnescapeString(oracleTag.ReplaceAllString(inner, "")))
		s = s[a+opened+ended+len("</pre>"):]
	}
}

// preLines splits the text of one <pre> element into its lines. Every content
// line ends with a newline, so the final piece after the last one is empty.
func preLines(s string) []string {
	lines := strings.Split(s, "\n")
	if lines[len(lines)-1] == "" {
		lines = lines[:len(lines)-1]
	}
	return lines
}

// stripSpaces removes up to n leading spaces.
func stripSpaces(s string, n int) string {
	i := 0
	for i < n && i < len(s) && s[i] == ' ' {
		i++
	}
	return s[i:]
}

// contentText is what the renderer shows for source line `line` inside block
// `b`: the line behind up to the block's own indentation. Fenced content
// loses up to the opening fence's indentation, indented code up to four
// columns. Exact for the `plain` inputs, whose blocks sit behind spaces only.
func contentText(line string, b oracleBlock, lines []string) string {
	if b.kind == ast.KindCodeBlock {
		return stripSpaces(line, 4)
	}
	return stripSpaces(line, len(lines[b.opener])-len(strings.TrimLeft(lines[b.opener], " ")))
}

// checkHTML holds the oracle against the HTML the renderer produces for the
// same input, without reading the AST: every code block is one <pre> element
// holding exactly the block's content lines — and for `plain` inputs, with
// the same text.
func checkHTML(t *testing.T, in oracleInput, rendered string, blocks []oracleBlock) {
	t.Helper()
	pres, err := preTexts(rendered)
	if err != nil {
		t.Fatalf("the rendered HTML: %v", err)
	}
	if len(pres) != len(blocks) {
		t.Fatalf("the oracle sees %d code blocks, the HTML has %d <pre> elements", len(blocks), len(pres))
	}
	for i, b := range blocks {
		got := preLines(pres[i])
		if len(got) != len(b.content) {
			t.Errorf("code block %d (content lines %v): the HTML has %d content lines, the oracle %d", i, b.content, len(got), len(b.content))
			continue
		}
		if !in.plain {
			continue
		}
		for j, l := range b.content {
			if want := contentText(in.lines[l], b, in.lines); got[j] != want {
				t.Errorf("code block %d, line %d %q: the HTML shows %q, the oracle's text is %q", i, l, in.lines[l], got[j], want)
			}
		}
	}
}

// flagString renders per-line flags as "TTTF".
func flagString(perLine []bool) string {
	var b strings.Builder
	for _, f := range perLine {
		if f {
			b.WriteByte('T')
		} else {
			b.WriteByte('F')
		}
	}
	return b.String()
}

// buildComposerOracleInput runs the generator on one input and validates the
// result every way this file can.
func buildComposerOracleInput(t *testing.T, r *Renderer, in oracleInput) oracleEntry {
	t.Helper()
	if in.want != nil && len(in.want) != len(in.lines) {
		t.Fatalf("table error: %d lines but %d hand-derived flags", len(in.lines), len(in.want))
	}
	src := []byte(strings.Join(in.lines, "\n"))
	twin, spy := newFenceSpyMarkdown(t)
	got, blocks, err := oracleFlags(r, twin, spy, src, len(in.lines))
	if err != nil {
		t.Fatalf("the oracle: %v", err)
	}

	// The twin parses like the renderer's own markdown.
	var ownHTML, twinHTML bytes.Buffer
	if err := r.md.Convert(src, &ownHTML); err != nil {
		t.Fatalf("the renderer's markdown: %v", err)
	}
	if err := twin.Convert(src, &twinHTML); err != nil {
		t.Fatalf("the twin markdown: %v", err)
	}
	if ownHTML.String() != twinHTML.String() {
		t.Errorf("the twin does not parse like the renderer's markdown\nrenderer: %s\ntwin:     %s", ownHTML.String(), twinHTML.String())
	}

	// The HTML the renderer produces for the input shows the same content.
	checkHTML(t, in, ownHTML.String(), blocks)

	// The hand-derived expectation.
	if in.want != nil && !slices.Equal(in.want, got) {
		t.Errorf("hand-derived %s, oracle %s", flagString(in.want), flagString(got))
	}
	t.Logf("%s", flagString(got))
	return oracleEntry{Name: in.name, Lines: in.lines, Code: got}
}

// buildComposerOracle runs the generator over the whole table, validating
// every result.
func buildComposerOracle(t *testing.T) []oracleEntry {
	t.Helper()
	r := New()
	seen := map[string]bool{}
	entries := make([]oracleEntry, 0, len(composerOracleInputs))
	for _, in := range composerOracleInputs {
		if in.name == "" || seen[in.name] {
			t.Fatalf("table error: empty or repeated input name %q", in.name)
		}
		seen[in.name] = true
		entries = append(entries, buildComposerOracleInput(t, r, in))
	}
	return entries
}

// encodeOracle writes the fixture: one input per line, in table order, so a
// change to one input is a one-line diff. "<", ">" and "&" stay readable.
func encodeOracle(entries []oracleEntry) ([]byte, error) {
	var out bytes.Buffer
	out.WriteString("[\n")
	for i, e := range entries {
		var line bytes.Buffer
		enc := json.NewEncoder(&line)
		enc.SetEscapeHTML(false)
		if err := enc.Encode(e); err != nil {
			return nil, err
		}
		out.WriteString("  " + strings.TrimSuffix(line.String(), "\n"))
		if i < len(entries)-1 {
			out.WriteString(",")
		}
		out.WriteString("\n")
	}
	out.WriteString("]\n")
	return out.Bytes(), nil
}

// TestComposerHighlightOracleGenerator validates the generator: its output is
// the oracle every later check is measured against.
func TestComposerHighlightOracleGenerator(t *testing.T) {
	r := New()
	for _, in := range composerOracleInputs {
		t.Run(in.name, func(t *testing.T) {
			buildComposerOracleInput(t, r, in)
		})
	}
}

// TestComposerHighlightOracleFixture holds the committed fixture against the
// oracle, or rewrites it with -update. A failed run writes nothing: the
// fixture is what later checks are measured against, so it is rewritten only
// from a table the whole of which the oracle agreed with.
func TestComposerHighlightOracleFixture(t *testing.T) {
	const regenerate = "go test ./pkg/render/ -run TestComposerHighlightOracleFixture -update"
	entries := buildComposerOracle(t)
	got, err := encodeOracle(entries)
	if err != nil {
		t.Fatalf("encoding the oracle: %v", err)
	}
	if *updateComposerOracleFixture {
		if t.Failed() {
			t.Logf("the run failed, so %s was not written; fix the table, then regenerate it with: %s", composerOracleFixturePath, regenerate)
			return
		}
		if err := os.MkdirAll(filepath.Dir(composerOracleFixturePath), 0o755); err != nil {
			t.Fatalf("creating the fixture directory: %v", err)
		}
		if err := os.WriteFile(composerOracleFixturePath, got, 0o644); err != nil {
			t.Fatalf("writing the fixture: %v", err)
		}
		t.Logf("wrote %s (%d inputs)", composerOracleFixturePath, len(entries))
		return
	}
	committed, err := os.ReadFile(composerOracleFixturePath)
	if err != nil {
		t.Fatalf("reading the fixture: %v (regenerate it with: %s)", err, regenerate)
	}
	if bytes.Equal(committed, got) {
		return
	}
	var held []oracleEntry
	if err := json.Unmarshal(committed, &held); err != nil {
		t.Fatalf("the fixture is not the oracle's format: %v (regenerate it with: %s)", err, regenerate)
	}
	reported := false
	for i := 0; i < len(entries) && i < len(held) && !reported; i++ {
		e, h := entries[i], held[i]
		if e.Name != h.Name || !slices.Equal(e.Lines, h.Lines) {
			t.Errorf("input %d: the fixture holds %q, the oracle %q (a table input was added, removed or renamed)", i, h.Name, e.Name)
			reported = true
		} else if !slices.Equal(e.Code, h.Code) {
			t.Errorf("%s: the fixture says %s, the oracle %s", e.Name, flagString(h.Code), flagString(e.Code))
			reported = true
		}
	}
	if len(entries) != len(held) {
		t.Errorf("the fixture holds %d inputs, the table has %d", len(held), len(entries))
	}
	t.Errorf("the fixture is out of date; look at the difference above, then regenerate it with: %s", regenerate)
}
