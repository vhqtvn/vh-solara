package render

import (
	"bytes"
	"sort"

	chroma "github.com/alecthomas/chroma/v2"
	chromahtml "github.com/alecthomas/chroma/v2/formatters/html"
	"github.com/alecthomas/chroma/v2/lexers"
	"github.com/alecthomas/chroma/v2/styles"
)

// HighlightFile turns a file's source into class-based HTML for the read-only
// code view: a chroma lexer picked from the filename (content-sniffed as a
// fallback), formatted with CSS classes so it styles against the shared
// /vh/highlight.css (no inline styles, no per-file CSS). Line numbers are
// emitted in a table with linkable `#L<n>` ids, giving a free gutter and
// shareable deep-links. The work is O(file) and bounded by the caller's size cap.
func (r *Renderer) HighlightFile(filename, source, lang string) (string, error) {
	var lexer chroma.Lexer
	if lang != "" {
		lexer = lexers.Get(lang) // explicit language override (by name or alias)
	}
	if lexer == nil {
		lexer = lexers.Match(filename)
	}
	if lexer == nil {
		lexer = lexers.Analyse(source)
	}
	if lexer == nil {
		lexer = lexers.Fallback
	}
	lexer = chroma.Coalesce(lexer)

	formatter := chromahtml.New(
		chromahtml.WithClasses(true),
		chromahtml.WithLineNumbers(true),
		chromahtml.LineNumbersInTable(true),
		chromahtml.WithLinkableLineNumbers(true, "L"),
	)
	style := styles.Get(DefaultStyle)
	if style == nil {
		style = styles.Fallback
	}
	it, err := lexer.Tokenise(nil, source)
	if err != nil {
		return "", err
	}
	var buf bytes.Buffer
	if err := formatter.Format(&buf, style, it); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// LexerName returns the display name of the lexer chroma would use for a file
// (e.g. "Go", "TypeScript") — shown in the viewer's status line.
func LexerName(filename string) string {
	if l := lexers.Match(filename); l != nil {
		return l.Config().Name
	}
	return "Plain text"
}

// StyleNames returns the available chroma style names (for the highlight picker).
func StyleNames() []string {
	names := append([]string(nil), styles.Names()...)
	sort.Strings(names)
	return names
}

// LangNames returns the available chroma lexer names (for the language override
// picker — e.g. when chroma mis-detects a file or it has no extension).
func LangNames() []string {
	names := append([]string(nil), lexers.Names(false)...)
	sort.Strings(names)
	return names
}

// StyleCSS returns one chroma style's stylesheet, with every selector prefixed by
// scope so picking a style only re-themes the code view (the global sheet still
// covers code blocks elsewhere). Returns "" for an unknown style.
func (r *Renderer) StyleCSS(name, scope string) (string, error) {
	if styles.Get(name) == nil {
		return "", nil
	}
	css, err := styleCSS(name)
	if err != nil {
		return "", err
	}
	if scope == "" {
		return css, nil
	}
	return scopeCSS(css, scope), nil
}
