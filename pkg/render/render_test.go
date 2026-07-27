package render

import "strings"

import "testing"

func TestMarkdownBasic(t *testing.T) {
	r := New()
	out := r.Markdown("# Title\n\nsome **bold** text")
	if !strings.Contains(out, "<h1") || !strings.Contains(out, "Title") {
		t.Fatalf("missing heading: %s", out)
	}
	if !strings.Contains(out, "<strong>bold</strong>") {
		t.Fatalf("missing bold: %s", out)
	}
}

func TestCodeHighlightingSurvivesSanitization(t *testing.T) {
	r := New()
	out := r.Markdown("```go\nfunc main() {}\n```")
	if !strings.Contains(out, "chroma") {
		t.Fatalf("expected chroma-highlighted block, got: %s", out)
	}
	// class attributes must survive the sanitizer or highlighting is dead.
	if !strings.Contains(out, "class=") {
		t.Fatalf("class attributes were stripped: %s", out)
	}
}

func TestCodeBlockChromaEnvelopeForBareAndUnknown(t *testing.T) {
	r := New()

	// A bare fence (no info-string) must now route through chroma's structural
	// envelope: <pre class="chroma"><code><span class="line">…</span></code></pre>.
	// Previously it fell through to plain <pre><code> with no per-line spans,
	// so bare code blocks (plain-text pastes) rendered with looser spacing than
	// language-fenced blocks.
	bare := r.Markdown("```\nplain line one\nplain line two\n```")
	if !strings.Contains(bare, `class="chroma"`) {
		t.Fatalf("bare fence missing chroma envelope: %s", bare)
	}
	if !strings.Contains(bare, `<span class="line">`) {
		t.Fatalf("bare fence missing per-line spans: %s", bare)
	}

	// An unrecognized language fence must get the same structural envelope.
	unknown := r.Markdown("```totallymadelang\nsome text\n```")
	if !strings.Contains(unknown, `class="chroma"`) {
		t.Fatalf("unknown-language fence missing chroma envelope: %s", unknown)
	}
	if !strings.Contains(unknown, `<span class="line">`) {
		t.Fatalf("unknown-language fence missing per-line spans: %s", unknown)
	}

	// A recognized language must still carry its token classes (e.g. go's "kd"
	// keyword), i.e. the envelope change must not regress real highlighting.
	goOut := r.Markdown("```go\nfunc main() {}\n```")
	if !strings.Contains(goOut, `class="chroma"`) {
		t.Fatalf("go fence lost chroma envelope: %s", goOut)
	}
	if !strings.Contains(goOut, `<span class="line">`) {
		t.Fatalf("go fence lost per-line spans: %s", goOut)
	}
	if !strings.Contains(goOut, `class="kd"`) {
		t.Fatalf("go fence lost token-class highlighting: %s", goOut)
	}
}

func TestMarkdownSanitizesXSS(t *testing.T) {
	r := New()
	out := r.Markdown("hello <script>alert(1)</script> world")
	// Raw HTML is ESCAPED as visible literal text (not dropped, not passed through).
	if strings.Contains(out, "<script>") {
		t.Fatalf("raw script tag passed through unescaped: %s", out)
	}
	// The escaped literal must be visible so the operator sees the syntax.
	if !strings.Contains(out, "&lt;script&gt;") {
		t.Fatalf("script tag not escaped as visible literal text: %s", out)
	}
	out2 := r.Markdown("[click](javascript:alert(1))")
	if strings.Contains(out2, "javascript:") {
		t.Fatalf("javascript: URI not sanitized: %s", out2)
	}
}

// TestRawHtmlEscapedAsText verifies that raw HTML tokens render as visible
// escaped literal text — NOT dropped, NOT passed through. This is the core
// hardening: a model emitting `<report>` or `<vh-solara>` syntax must show the
// literal tag in the rendered view, not a silent gap.
//
// Each case asserts BOTH conditions:
//
//	(a) no source-created HTML element/attribute exists in output, AND
//	(b) the original syntax is visibly present as escaped literal text.
func TestRawHtmlEscapedAsText(t *testing.T) {
	r := New()
	tests := []struct {
		name  string
		input string
		// rawSubstr must NOT appear literally (it would be an active element).
		rawSubstr string
		// escapedSubstr MUST appear (the escaped visible literal text).
		escapedSubstr string
	}{
		// Custom tags — the operator-facing bug: these were silently dropped.
		{"inline custom tag <report>", "see <report> here", "<report>", "&lt;report&gt;"},
		{"inline custom tag <vh-solara>", "see <vh-solara> here", "<vh-solara>", "&lt;vh-solara&gt;"},
		{"inline custom tag closing", "see </report> here", "</report>", "&lt;/report&gt;"},

		// Block-level HTML.
		{"block div", "<div>content</div>", "<div>", "&lt;div&gt;"},
		{"block script", "<script>x=1</script>", "<script>", "&lt;script&gt;"},
		{"block paragraph with attrs", `<p class="evil">text</p>`, `<p class="evil">`, "&lt;p"},

		// Comments / declarations / processing instructions / CDATA.
		{"comment", "<!-- secret -->", "<!--", "&lt;!--"},
		{"declaration", "<!DOCTYPE html>", "<!DOCTYPE", "&lt;!DOCTYPE"},
		{"PI", "<?xml version='1.0'?>", "<?xml", "&lt;?xml"},
		{"CDATA", "<![CDATA[data]]>", "<![CDATA[", "&lt;![CDATA["},

		// Dangerous tags (the whole tag is escaped as text — onerror/onload
		// are harmless visible text inside the escaped &lt;...&gt;).
		{"img onerror", `<img src=x onerror=alert(1)>`, "<img ", "&lt;img"},
		{"iframe", `<iframe src=evil></iframe>`, "<iframe", "&lt;iframe"},
		{"svg onload", `<svg onload=alert(1)>`, "<svg ", "&lt;svg"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			out := r.Markdown(tc.input)
			// (a) No source-created HTML element/attribute in output.
			if strings.Contains(out, tc.rawSubstr) {
				t.Fatalf("raw HTML '%s' passed through unescaped: %s", tc.rawSubstr, out)
			}
			// (b) The escaped literal text IS visible.
			if !strings.Contains(out, tc.escapedSubstr) {
				t.Fatalf("escaped literal '%s' not found in output (dropped?): %s", tc.escapedSubstr, out)
			}
		})
	}
}

// TestRawHtmlPreservesMarkdownFeatures verifies that the escape renderer does
// not break legitimate markdown features that contain angle brackets or HTML
// syntax inside code, autolinks, etc.
func TestRawHtmlPreservesMarkdownFeatures(t *testing.T) {
	r := New()

	// Inline code containing HTML syntax: preserved as code, not double-escaped.
	out := r.Markdown("use `<foo>` syntax")
	if !strings.Contains(out, "&lt;foo&gt;") {
		t.Fatalf("inline code with <foo> should contain escaped angle: %s", out)
	}

	// Fenced code containing HTML: preserved as code.
	out = r.Markdown("```\n<div>test</div>\n```")
	if !strings.Contains(out, "&lt;div&gt;") {
		t.Fatalf("fenced code with <div> should contain escaped angle: %s", out)
	}

	// Autolink: <https://example.com> should render as a link, NOT escaped.
	out = r.Markdown("see <https://example.com>")
	if !strings.Contains(out, "href") {
		t.Fatalf("autolink <https://...> should render as a link: %s", out)
	}

	// Email autolink: <user@example.com> should render as a mailto link.
	out = r.Markdown("contact <user@example.com>")
	if !strings.Contains(out, "mailto") && !strings.Contains(out, "user@example.com") {
		t.Fatalf("email autolink should render as a link: %s", out)
	}

	// Markdown in a list with HTML-like text: list structure preserved.
	out = r.Markdown("- item <report>\n- item two")
	if !strings.Contains(out, "&lt;report&gt;") {
		t.Fatalf("list item with <report> should escape it: %s", out)
	}
	if !strings.Contains(out, "<ul") && !strings.Contains(out, "<li") {
		t.Fatalf("list structure should be preserved: %s", out)
	}
}

func TestHighlightCSS(t *testing.T) {
	r := New()
	css, err := r.HighlightCSS()
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(css, ".chroma") {
		t.Fatalf("css missing .chroma rules: %.200s", css)
	}
	// The light theme is scoped under the generic .theme-light-scoped marker (set
	// on <html> for EVERY light theme), so it must use that class — not the
	// specific .theme-light id, which would miss shire-light & friends.
	if !strings.Contains(css, ".theme-light-scoped .chroma") {
		t.Fatalf("light syntax rules must be scoped under .theme-light-scoped, got: %.300s", css)
	}
	// The scoped light .chroma base must set a text color, not only a background.
	// Without it the unscoped dark sheet's near-white .chroma foreground wins in
	// light themes and plain code text goes white-on-white (invisible).
	if !strings.Contains(css, ".theme-light-scoped .chroma { color: inherit; }") {
		t.Fatalf("light .chroma base must carry color: inherit so dark fg doesn't leak, got: %.300s", css)
	}
}

func TestDiffRender(t *testing.T) {
	r := New()
	out := r.Diff("main.go", "line one\nline two\n", "line one\nline 2\nline three\n")
	if !strings.Contains(out, "vh-diff-del") {
		t.Fatalf("expected a deleted line: %s", out)
	}
	if !strings.Contains(out, "vh-diff-add") {
		t.Fatalf("expected an added line: %s", out)
	}
	if !strings.Contains(out, `data-file="main.go"`) {
		t.Fatalf("expected file attribution: %s", out)
	}
}

func TestDiffEscapesContent(t *testing.T) {
	r := New()
	out := r.Diff("x", "", "<img src=x onerror=alert(1)>")
	if strings.Contains(out, "<img") {
		t.Fatalf("diff content not escaped: %s", out)
	}
}
