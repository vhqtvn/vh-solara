package alerts

import (
	"bytes"
	"encoding/json"
	"sort"
)

// stripJSONC removes // line and /* block */ comments and trailing commas,
// respecting string literals, leaving valid JSON for the decoder.
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
			for i < n && b[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < n && b[i+1] == '*':
			i += 2
			for i+1 < n && !(b[i] == '*' && b[i+1] == '/') {
				i++
			}
			i += 2
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
			i--
		}
	}
	return b
}

// leadingComment returns the bytes before the first structural '{' (the
// top-level object opener), respecting comments — i.e. the file's header
// comment/whitespace block, preserved verbatim across saves.
func leadingComment(raw []byte) []byte {
	n := len(raw)
	i := 0
	for i < n {
		c := raw[i]
		switch {
		case c == '/' && i+1 < n && raw[i+1] == '/':
			for i < n && raw[i] != '\n' {
				i++
			}
		case c == '/' && i+1 < n && raw[i+1] == '*':
			i += 2
			for i+1 < n && !(raw[i] == '*' && raw[i+1] == '/') {
				i++
			}
			i += 2
		case c == '{':
			return raw[:i]
		default:
			i++
		}
	}
	return nil
}

// marshalOrdered pretty-prints a JSON object with the given keys first (in
// order) then any remaining keys sorted, using 2-space indentation.
func marshalOrdered(m map[string]json.RawMessage, order []string) ([]byte, error) {
	seen := map[string]bool{}
	var keys []string
	for _, k := range order {
		if _, ok := m[k]; ok {
			keys = append(keys, k)
			seen[k] = true
		}
	}
	var rest []string
	for k := range m {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	keys = append(keys, rest...)

	var compact bytes.Buffer
	compact.WriteByte('{')
	for i, k := range keys {
		if i > 0 {
			compact.WriteByte(',')
		}
		kb, _ := json.Marshal(k)
		compact.Write(kb)
		compact.WriteByte(':')
		var c bytes.Buffer
		if err := json.Compact(&c, m[k]); err != nil {
			return nil, err
		}
		compact.Write(c.Bytes())
	}
	compact.WriteByte('}')

	var pretty bytes.Buffer
	if err := json.Indent(&pretty, compact.Bytes(), "", "  "); err != nil {
		return nil, err
	}
	return pretty.Bytes(), nil
}
