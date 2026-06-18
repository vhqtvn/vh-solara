package render

import (
	"html"
	"strings"
)

// Patch renders a unified-diff patch string (as produced by `git diff` and
// OpenCode's /vcs/diff) to HTML with hunk headers and add/remove line styling.
// Content is escaped here, so no extra sanitization pass is needed.
func (r *Renderer) Patch(patch string) string {
	key := hashKey("patch", patch)
	if v, ok := r.get(r.diffCache, key); ok {
		return v
	}

	var b strings.Builder
	b.WriteString(`<div class="vh-diff vh-patch">`)
	for _, line := range strings.Split(patch, "\n") {
		cls := "ctx"
		switch {
		case strings.HasPrefix(line, "@@"):
			cls = "hunk"
		case strings.HasPrefix(line, "+++") || strings.HasPrefix(line, "---"):
			cls = "meta"
		case strings.HasPrefix(line, "diff ") || strings.HasPrefix(line, "index ") ||
			strings.HasPrefix(line, "new file") || strings.HasPrefix(line, "deleted file") ||
			strings.HasPrefix(line, "rename ") || strings.HasPrefix(line, "similarity "):
			cls = "meta"
		case strings.HasPrefix(line, "+"):
			cls = "add"
		case strings.HasPrefix(line, "-"):
			cls = "del"
		}
		b.WriteString(`<div class="vh-diff-line vh-diff-`)
		b.WriteString(cls)
		b.WriteString(`">`)
		b.WriteString(html.EscapeString(line))
		b.WriteString("</div>")
	}
	b.WriteString("</div>")

	out := b.String()
	r.put(r.diffCache, key, out)
	return out
}

// PatchSplit renders the same unified-diff patch as a side-by-side (split) view:
// removed lines on the left, added lines on the right, context spanning both.
// A run of deletions immediately followed by additions is paired row-by-row
// (the common "changed N lines" case); leftover lines on either side get an
// empty opposite cell. Hunk/meta headers span the full width.
func (r *Renderer) PatchSplit(patch string) string {
	key := hashKey("patch.split", patch)
	if v, ok := r.get(r.diffCache, key); ok {
		return v
	}

	var b strings.Builder
	b.WriteString(`<div class="vh-diff vh-patch vh-diff-split">`)

	// Pending deletion/addition runs, flushed (paired) on any non +/- line.
	var dels, adds []string
	cell := func(cls, text string) {
		b.WriteString(`<div class="vh-diff-cell vh-diff-`)
		b.WriteString(cls)
		b.WriteString(`">`)
		b.WriteString(html.EscapeString(text))
		b.WriteString("</div>")
	}
	flush := func() {
		n := len(dels)
		if len(adds) > n {
			n = len(adds)
		}
		for i := 0; i < n; i++ {
			b.WriteString(`<div class="vh-diff-row">`)
			if i < len(dels) {
				cell("del", dels[i])
			} else {
				cell("empty", "")
			}
			if i < len(adds) {
				cell("add", adds[i])
			} else {
				cell("empty", "")
			}
			b.WriteString("</div>")
		}
		dels = dels[:0]
		adds = adds[:0]
	}
	span := func(cls, text string) {
		b.WriteString(`<div class="vh-diff-row"><div class="vh-diff-cell vh-diff-span2 vh-diff-`)
		b.WriteString(cls)
		b.WriteString(`">`)
		b.WriteString(html.EscapeString(text))
		b.WriteString("</div></div>")
	}

	for _, line := range strings.Split(patch, "\n") {
		switch {
		case strings.HasPrefix(line, "@@"):
			flush()
			span("hunk", line)
		case strings.HasPrefix(line, "+++") || strings.HasPrefix(line, "---"):
			flush()
			span("meta", line)
		case strings.HasPrefix(line, "diff ") || strings.HasPrefix(line, "index ") ||
			strings.HasPrefix(line, "new file") || strings.HasPrefix(line, "deleted file") ||
			strings.HasPrefix(line, "rename ") || strings.HasPrefix(line, "similarity "):
			flush()
			span("meta", line)
		case strings.HasPrefix(line, "+"):
			adds = append(adds, line)
		case strings.HasPrefix(line, "-"):
			dels = append(dels, line)
		default: // context line: same on both sides
			flush()
			b.WriteString(`<div class="vh-diff-row">`)
			cell("ctx", line)
			cell("ctx", line)
			b.WriteString("</div>")
		}
	}
	flush()
	b.WriteString("</div>")

	out := b.String()
	r.put(r.diffCache, key, out)
	return out
}
