// Package render turns OpenCode content (markdown, code, diffs) into sanitized
// HTML on the daemon, so phone clients don't pay the markdown-parse and
// syntax-highlight CPU cost. Results are cached by content hash; the client is
// expected to render only in-flight/streaming content itself and request
// rendered HTML for settled content.
package render

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"html"
	"strings"
	"sync"

	"github.com/alecthomas/chroma/v2"
	chromahtml "github.com/alecthomas/chroma/v2/formatters/html"
	"github.com/alecthomas/chroma/v2/lexers"
	"github.com/alecthomas/chroma/v2/styles"
	"github.com/microcosm-cc/bluemonday"
	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	"github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/util"
)

// DefaultStyle is the chroma style for code (dark, the default). LightStyle is
// emitted scoped under .theme-light-scoped (set on <html> for every light theme).
const (
	DefaultStyle = "github-dark"
	LightStyle   = "github"
)

// Renderer renders and caches HTML. Safe for concurrent use.
type Renderer struct {
	md     goldmark.Markdown
	policy *bluemonday.Policy
	style  string

	mu        sync.Mutex
	mdCache   map[string]string
	diffCache map[string]string
	cacheCap  int
}

// New builds a Renderer with GFM markdown + class-based chroma highlighting.
func New() *Renderer {
	md := goldmark.New(
		goldmark.WithExtensions(
			extension.GFM,
			// Custom chroma NodeRenderer (see codeHighlighter). Routes EVERY
			// fenced code block — bare, unrecognized-language, and recognized —
			// through chroma's structural envelope so they all share the same
			// per-line <span class="line"> spacing. Replaces the stock
			// goldmark-highlighting extension, whose bare/unknown fallback
			// emitted plain <pre><code> with no per-line spans.
			newCodeHighlighter(),
		),
	)

	p := bluemonday.UGCPolicy()
	// chroma emits <pre class="chroma"><code>…<span class="…">; allow class.
	p.AllowAttrs("class").OnElements("span", "code", "pre", "div")
	// GFM task lists render as disabled checkboxes.
	p.AllowAttrs("type", "checked", "disabled").OnElements("input")

	return &Renderer{
		md:        md,
		policy:    p,
		style:     DefaultStyle,
		mdCache:   map[string]string{},
		diffCache: map[string]string{},
		cacheCap:  2048,
	}
}

// codeHighlighter is a goldmark NodeRenderer (+ Extender) that routes every
// fenced code block through chroma's structural HTML envelope.
//
// Why this exists: the stock github.com/yuin/goldmark-highlighting/v2 extension
// only engages chroma when the info-string names a lexer chroma recognizes
// (lexers.Get != nil). Bare fences (``` ``` ```) and unrecognized-language
// fences (``` ```totallymadelang ```) fell through to goldmark's plain
// <pre><code>…</code></pre> fallback, which lacks the per-line
// <span class="line"> wrapping that gives language-fenced blocks their tighter
// spacing. Routing those blocks through chroma's plaintext lexer (which emits
// only chroma.Text tokens — no token classes, so no coloring) yields the full
// envelope with no visual change beyond the shared line spacing.
//
// Recognized languages are unchanged: lexers.Get returns their real lexer, so
// token-class highlighting (e.g. <span class="kd">func</span>) is preserved.
type codeHighlighter struct {
	formatter *chromahtml.Formatter
	style     *chroma.Style
}

// newCodeHighlighter builds a renderer using class-based chroma formatting
// (no inline styles) and the package's default (dark) style. The formatter and
// style are immutable after construction and safe for concurrent use — Format
// only reads config and writes to the per-call writer.
func newCodeHighlighter() *codeHighlighter {
	style := styles.Get(DefaultStyle)
	if style == nil {
		style = styles.Fallback
	}
	return &codeHighlighter{
		formatter: chromahtml.New(chromahtml.WithClasses(true)),
		style:     style,
	}
}

// Extend implements goldmark.Extender. Registered at priority 200 (matching the
// stock highlighting extension) so it overrides goldmark's built-in
// fenced-code-block HTML renderer.
func (c *codeHighlighter) Extend(m goldmark.Markdown) {
	m.Renderer().AddOptions(renderer.WithNodeRenderers(util.Prioritized(c, 200)))
}

// RegisterFuncs implements renderer.NodeRenderer.
func (c *codeHighlighter) RegisterFuncs(reg renderer.NodeRendererFuncRegisterer) {
	reg.Register(ast.KindFencedCodeBlock, c.renderFencedCodeBlock)
}

// renderFencedCodeBlock emits the chroma envelope for a fenced code block. All
// output is produced on the entering pass (mirroring goldmark's own code-block
// renderers); the exiting pass is a no-op.
func (c *codeHighlighter) renderFencedCodeBlock(w util.BufWriter, source []byte, node ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	n := node.(*ast.FencedCodeBlock)

	// Gather the raw code text. FencedCodeBlock content is held as source
	// segments, so join them verbatim (same as the stock renderer).
	var buf bytes.Buffer
	for i := 0; i < n.Lines().Len(); i++ {
		line := n.Lines().At(i)
		buf.Write(line.Value(source))
	}

	// Pick a lexer: the named language's lexer when chroma recognizes it,
	// otherwise chroma's plaintext lexer. n.Language returns nil for a bare
	// fence; lexers.Get returns nil for an unrecognized name. Plaintext emits
	// only chroma.Text tokens, so the formatter wraps each line in
	// <span class="line"> but emits no token classes (no coloring) — exactly
	// the wanted structural envelope for non-code pastes.
	lexer := lexers.Get(string(n.Language(source)))
	if lexer == nil {
		lexer = lexers.Get("text")
	}
	lexer = chroma.Coalesce(lexer)

	it, err := lexer.Tokenise(nil, buf.String())
	if err != nil {
		// Tokenise essentially never fails; if it does, fall back to a plain
		// escaped <pre><code> so the block still renders safely.
		_, _ = w.WriteString("<pre><code>")
		_, _ = w.WriteString(html.EscapeString(buf.String()))
		_, _ = w.WriteString("</code></pre>\n")
		return ast.WalkContinue, nil
	}

	_ = c.formatter.Format(w, c.style, it)
	return ast.WalkContinue, nil
}

// Markdown renders GFM markdown (with highlighted code blocks) to sanitized HTML.
func (r *Renderer) Markdown(src string) string {
	key := hashKey("md", src)
	if v, ok := r.get(r.mdCache, key); ok {
		return v
	}
	var buf bytes.Buffer
	if err := r.md.Convert([]byte(src), &buf); err != nil {
		return "<pre>" + html.EscapeString(src) + "</pre>"
	}
	out := r.policy.Sanitize(buf.String())
	r.put(r.mdCache, key, out)
	return out
}

// HighlightCSS returns the syntax stylesheet: the dark theme by default, plus
// the light theme scoped under .theme-light-scoped so a single sheet covers both
// (the marker class is set on <html> for every light theme). The client fetches
// this once (GET /vh/highlight.css) and caches it.
func (r *Renderer) HighlightCSS() (string, error) {
	dark, err := styleCSS(DefaultStyle)
	if err != nil {
		return "", err
	}
	light, err := styleCSS(LightStyle)
	if err != nil {
		return "", err
	}
	scoped := scopeCSS(light, ".theme-light-scoped")
	// chroma's light (github) sheet sets only background-color on .chroma, with no
	// text color. The dark sheet above is emitted unscoped, so its near-white
	// .chroma foreground would otherwise win in light themes and render plain code
	// text invisible on the light surface (white-on-white). Carry the page's (dark)
	// foreground onto the scoped light base so untokenized code stays readable.
	scoped += "\n.theme-light-scoped .chroma { color: inherit; }\n"
	return dark + "\n" + scoped, nil
}

func styleCSS(name string) (string, error) {
	style := styles.Get(name)
	if style == nil {
		style = styles.Fallback
	}
	formatter := chromahtml.New(chromahtml.WithClasses(true))
	var buf bytes.Buffer
	if err := formatter.WriteCSS(&buf, style); err != nil {
		return "", err
	}
	return buf.String(), nil
}

// scopeCSS prefixes every rule's selector(s) with scope, so a whole stylesheet
// only applies under that ancestor (e.g. ".theme-light"). chroma writes one
// rule per line as `[/* comment */ ]selectors { decls }`.
func scopeCSS(css, scope string) string {
	var b strings.Builder
	for _, line := range strings.Split(css, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		brace := strings.Index(line, "{")
		if brace < 0 {
			b.WriteString(line + "\n")
			continue
		}
		head, rest := line[:brace], line[brace:]
		prefix := ""
		if i := strings.LastIndex(head, "*/"); i >= 0 {
			prefix = head[:i+2] + " "
			head = head[i+2:]
		}
		sels := strings.Split(head, ",")
		for j := range sels {
			s := strings.TrimSpace(sels[j])
			if s != "" {
				sels[j] = scope + " " + s
			}
		}
		b.WriteString(prefix + strings.Join(sels, ", ") + " " + strings.TrimSpace(rest) + "\n")
	}
	return b.String()
}

func hashKey(kind, content string) string {
	h := sha256.New()
	h.Write([]byte(kind))
	h.Write([]byte{0})
	h.Write([]byte(content))
	return hex.EncodeToString(h.Sum(nil))
}

func (r *Renderer) get(cache map[string]string, key string) (string, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	v, ok := cache[key]
	return v, ok
}

func (r *Renderer) put(cache map[string]string, key, val string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(cache) >= r.cacheCap {
		// Bounded; evict an arbitrary entry (map iteration order is randomized).
		for k := range cache {
			delete(cache, k)
			break
		}
	}
	cache[key] = val
}
