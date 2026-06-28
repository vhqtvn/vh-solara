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
	if strings.Contains(out, "<script>") {
		t.Fatalf("script tag not stripped: %s", out)
	}
	out2 := r.Markdown("[click](javascript:alert(1))")
	if strings.Contains(out2, "javascript:") {
		t.Fatalf("javascript: URI not sanitized: %s", out2)
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
