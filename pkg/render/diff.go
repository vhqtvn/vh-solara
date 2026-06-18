package render

import (
	"html"
	"strings"
)

// Diff renders a before/after file pair (OpenCode's FileDiff shape) to
// line-level unified HTML with add/remove styling. The structure is built and
// escaped here, so no extra sanitization pass is needed.
func (r *Renderer) Diff(file, before, after string) string {
	key := hashKey("diff", file+"\x00"+before+"\x00"+after)
	if v, ok := r.get(r.diffCache, key); ok {
		return v
	}

	lines := lineDiff(splitLines(before), splitLines(after))
	var b strings.Builder
	b.WriteString(`<div class="vh-diff" data-file="`)
	b.WriteString(html.EscapeString(file))
	b.WriteString(`">`)
	for _, l := range lines {
		cls, sign := "ctx", " "
		switch l.op {
		case opAdd:
			cls, sign = "add", "+"
		case opDel:
			cls, sign = "del", "-"
		}
		b.WriteString(`<div class="vh-diff-line vh-diff-`)
		b.WriteString(cls)
		b.WriteString(`"><span class="vh-diff-sign">`)
		b.WriteString(sign)
		b.WriteString(`</span>`)
		b.WriteString(html.EscapeString(l.text))
		b.WriteString("</div>")
	}
	b.WriteString("</div>")

	out := b.String()
	r.put(r.diffCache, key, out)
	return out
}

type diffOp int

const (
	opEqual diffOp = iota
	opDel
	opAdd
)

type diffLine struct {
	op   diffOp
	text string
}

func splitLines(s string) []string {
	if s == "" {
		return nil
	}
	s = strings.TrimSuffix(s, "\n")
	return strings.Split(s, "\n")
}

// lineDiff computes an LCS-based line alignment of a → b. Adequate for the
// modest file diffs OpenCode produces; it is O(n*m) in space.
func lineDiff(a, b []string) []diffLine {
	n, m := len(a), len(b)
	dp := make([][]int, n+1)
	for i := range dp {
		dp[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				dp[i][j] = dp[i+1][j+1] + 1
			} else if dp[i+1][j] >= dp[i][j+1] {
				dp[i][j] = dp[i+1][j]
			} else {
				dp[i][j] = dp[i][j+1]
			}
		}
	}

	var out []diffLine
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case a[i] == b[j]:
			out = append(out, diffLine{opEqual, a[i]})
			i++
			j++
		case dp[i+1][j] >= dp[i][j+1]:
			out = append(out, diffLine{opDel, a[i]})
			i++
		default:
			out = append(out, diffLine{opAdd, b[j]})
			j++
		}
	}
	for ; i < n; i++ {
		out = append(out, diffLine{opDel, a[i]})
	}
	for ; j < m; j++ {
		out = append(out, diffLine{opAdd, b[j]})
	}
	return out
}
