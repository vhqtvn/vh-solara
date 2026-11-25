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
//   - Hand-derived: the inputs that carry a `want` were derived by hand from
//     the CommonMark spec. The oracle must agree with each.
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
	// want is the expectation hand-derived from the CommonMark spec, one flag
	// per line, for the inputs that carry a derivation. nil for inputs that
	// are only measured.
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
// Every input is parsed with the renderer's own parser; `want` records what
// the CommonMark spec says for it, so the generator is checked against the
// spec rather than against itself.
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

	// 6. ")" is an ordered-list marker too.
	{
		name:  "paren-list-marker-fence",
		lines: []string{"1) ```", "   a", "   ```", "after"},
		// "1) " opens an ordered list item, three columns wide like "1. ".
		want: flags("TTTF"),
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

	// 10. Shapes where the `marked` library is known to be wrong: the
	// highlighter is expected to agree with goldmark here.
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
// oracle, or rewrites it with -update.
func TestComposerHighlightOracleFixture(t *testing.T) {
	const regenerate = "go test ./pkg/render/ -run TestComposerHighlightOracleFixture -update"
	entries := buildComposerOracle(t)
	got, err := encodeOracle(entries)
	if err != nil {
		t.Fatalf("encoding the oracle: %v", err)
	}
	if *updateComposerOracleFixture {
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
