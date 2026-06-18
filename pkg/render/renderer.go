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

	chromahtml "github.com/alecthomas/chroma/v2/formatters/html"
	"github.com/alecthomas/chroma/v2/styles"
	"github.com/microcosm-cc/bluemonday"
	"github.com/yuin/goldmark"
	highlighting "github.com/yuin/goldmark-highlighting/v2"
	"github.com/yuin/goldmark/extension"
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
			highlighting.NewHighlighting(
				highlighting.WithStyle(DefaultStyle),
				// Class mode (not inline styles) so heights are stable and the
				// theme is a single cacheable stylesheet (GET /vh/highlight.css).
				highlighting.WithFormatOptions(chromahtml.WithClasses(true)),
			),
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
	return dark + "\n" + scopeCSS(light, ".theme-light-scoped"), nil
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
