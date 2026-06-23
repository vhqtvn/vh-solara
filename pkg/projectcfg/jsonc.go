package projectcfg

// stripJSONC removes JSONC comments (// line and /* block */) and trailing
// commas from b, leaving valid JSON. String literals are respected so a "//"
// inside a string is preserved. It is a small, dependency-free preprocessor;
// it does not validate — the json decoder does that next.
func stripJSONC(b []byte) []byte {
	out := make([]byte, 0, len(b))
	n := len(b)
	inStr := false
	i := 0
	for i < n {
		c := b[i]
		if inStr {
			out = append(out, c)
			if c == '\\' && i+1 < n {
				out = append(out, b[i+1])
				i += 2
				continue
			}
			if c == '"' {
				inStr = false
			}
			i++
			continue
		}
		switch {
		case c == '"':
			inStr = true
			out = append(out, c)
			i++
		case c == '/' && i+1 < n && b[i+1] == '/':
			// line comment: skip to newline (not consuming it; the newline is
			// whitespace and harmless)
			for i < n && b[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < n && b[i+1] == '*':
			i += 2
			for i+1 < n && !(b[i] == '*' && b[i+1] == '/') {
				i++
			}
			i += 2 // skip closing */ (clamped by loop guard; safe if truncated)
			if i > n {
				i = n
			}
		default:
			out = append(out, c)
			i++
		}
	}
	return stripTrailingCommas(out)
}

// stripTrailingCommas removes a comma immediately preceding } or ] (with
// optional whitespace between), which JSONC permits but encoding/json rejects.
func stripTrailingCommas(b []byte) []byte {
	for i := 0; i < len(b); i++ {
		if b[i] != ',' {
			continue
		}
		j := i + 1
		for j < len(b) && (b[j] == ' ' || b[j] == '\t' || b[j] == '\n' || b[j] == '\r') {
			j++
		}
		if j < len(b) && (b[j] == '}' || b[j] == ']') {
			b = append(b[:i], b[j:]...)
			i-- // re-examine this index
		}
	}
	return b
}
