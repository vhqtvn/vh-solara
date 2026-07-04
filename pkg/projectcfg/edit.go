package projectcfg

import (
	"bytes"
	"encoding/json"
	"fmt"
	"path/filepath"
)

// ResolvePath returns the config file path for a project root, mirroring Load's
// resolution: the override (absolute, or relative to root) when set, else the
// conventional root/.vh-solara/project.jsonc. Used by the editor write-back,
// which must know the target even when the file does not yet exist.
func ResolvePath(root, override string) (string, error) {
	rootAbs, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	if override != "" {
		if filepath.IsAbs(override) {
			return override, nil
		}
		return filepath.Join(rootAbs, override), nil
	}
	return filepath.Join(rootAbs, ConfigName), nil
}

// SpliceTopLevelKey returns raw with the root object's `key` set to value,
// preserving every comment, every other key, and the file's formatting outside
// the replaced value. It is a surgical text edit, NOT a re-marshal: only the
// target key's value span is rewritten (or, when the key is absent, inserted
// right after the root `{`). Comments INSIDE the old value are dropped — that
// span is owned by whatever now writes it. Trailing commas are valid JSONC, so
// inserts always append one; the loader strips them on read.
//
// value is marshaled with two-space indentation. When raw has no root object
// (empty/whitespace/garbage), a fresh `{ "key": <value> }` document is returned.
func SpliceTopLevelKey(raw []byte, key string, value any) ([]byte, error) {
	enc, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("marshal %s: %w", key, err)
	}
	// Re-indent so nested lines sit two levels in (the value lives under the
	// root object). MarshalIndent leaves the first line flush; subsequent lines
	// carry one indent level — prefix them with one more.
	enc = bytes.ReplaceAll(enc, []byte("\n"), []byte("\n  "))

	scan := blankComments(raw)
	open := indexRootOpen(scan)
	if open < 0 {
		// No root object → author a fresh document.
		return []byte(fmt.Sprintf("{\n  %q: %s\n}\n", key, enc)), nil
	}

	if _, vs, ve, ok := findTopLevelValue(scan, open, key); ok {
		out := make([]byte, 0, len(raw)+len(enc))
		out = append(out, raw[:vs]...)
		out = append(out, enc...)
		out = append(out, raw[ve:]...)
		return out, nil
	}

	// Absent → insert just after the root `{` (with a trailing comma; JSONC ok).
	ins := []byte(fmt.Sprintf("\n  %q: %s,", key, enc))
	out := make([]byte, 0, len(raw)+len(ins))
	out = append(out, raw[:open+1]...)
	out = append(out, ins...)
	out = append(out, raw[open+1:]...)
	return out, nil
}

// RemoveTopLevelKey returns raw with the root object's `key` (and its value)
// removed, preserving every comment, every other key, and the file's formatting
// outside the removed span. Like SpliceTopLevelKey it is a surgical text edit,
// NOT a re-marshal: only the target pair is cut out. A trailing-or-leading comma
// adjacent to the removed pair is consumed so the result stays valid JSONC
// (JSONC permits trailing commas, so leaving one would also be fine — consuming
// it just keeps the file tidy). When the key is absent (or there is no root
// object) raw is returned unchanged.
func RemoveTopLevelKey(raw []byte, key string) []byte {
	scan := blankComments(raw)
	open := indexRootOpen(scan)
	if open < 0 {
		return raw
	}
	keyStart, _, valEnd, ok := findTopLevelValue(scan, open, key)
	if !ok {
		return raw
	}
	// Cut [keyStart, valEnd). Then consume ONE adjacent comma so the result is
	// valid JSONC: prefer the comma trailing the value (skip whitespace forward);
	// if none, fall back to the comma leading the key (skip whitespace backward).
	start, end := keyStart, valEnd
	j := valEnd
	for j < len(scan) && isJSONSpace(scan[j]) {
		j++
	}
	if j < len(scan) && scan[j] == ',' {
		end = j + 1
	} else {
		i := keyStart
		for i > 0 && isJSONSpace(scan[i-1]) {
			i--
		}
		if i > 0 && scan[i-1] == ',' {
			start = i - 1
		}
	}
	out := make([]byte, 0, len(raw)-(end-start))
	out = append(out, raw[:start]...)
	out = append(out, raw[end:]...)
	return out
}

// blankComments copies b, replacing JSONC comment bytes with spaces (newlines
// kept) so byte offsets stay aligned with the original — letting a scan over the
// blanked copy yield splice positions valid in the source.
func blankComments(b []byte) []byte {
	out := make([]byte, len(b))
	copy(out, b)
	n := len(b)
	inStr := false
	for i := 0; i < n; {
		c := b[i]
		if inStr {
			if c == '\\' && i+1 < n {
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
			i++
		case c == '/' && i+1 < n && b[i+1] == '/':
			for i < n && b[i] != '\n' {
				out[i] = ' '
				i++
			}
		case c == '/' && i+1 < n && b[i+1] == '*':
			out[i] = ' '
			out[i+1] = ' '
			i += 2
			for i < n && !(i+1 < n && b[i] == '*' && b[i+1] == '/') {
				if b[i] != '\n' {
					out[i] = ' '
				}
				i++
			}
			if i+1 < n {
				out[i] = ' '
				out[i+1] = ' '
				i += 2
			} else {
				i = n
			}
		default:
			i++
		}
	}
	return out
}

// indexRootOpen returns the index of the first `{` (the root object's open
// brace) in the comment-blanked scan buffer, or -1 if there is none.
func indexRootOpen(scan []byte) int {
	inStr := false
	for i := 0; i < len(scan); i++ {
		c := scan[i]
		if inStr {
			if c == '\\' {
				i++
				continue
			}
			if c == '"' {
				inStr = false
			}
			continue
		}
		if c == '"' {
			inStr = true
			continue
		}
		if c == '{' {
			return i
		}
	}
	return -1
}

// findTopLevelValue locates the span of the root object's `key` (depth 1,
// immediately inside the root object opened at openIdx) and returns three
// offsets: keyStart (the key's opening `"`), valStart (the value's first byte),
// and valEnd (just past the value's last byte). Operates on the blanked scan
// buffer; the returned offsets are valid in the source too. SpliceTopLevelKey
// uses valStart/valEnd to rewrite the value; RemoveTopLevelKey uses
// keyStart/valEnd to cut the whole pair.
func findTopLevelValue(scan []byte, openIdx int, key string) (keyStart, valStart, valEnd int, found bool) {
	target := []byte(`"` + key + `"`)
	depth := 0
	inStr := false
	n := len(scan)
	for i := openIdx; i < n; {
		c := scan[i]
		if inStr {
			if c == '\\' {
				i += 2
				continue
			}
			if c == '"' {
				inStr = false
			}
			i++
			continue
		}
		switch c {
		case '"':
			if depth == 1 && bytes.HasPrefix(scan[i:], target) {
				ks := i
				j := i + len(target)
				for j < n && isJSONSpace(scan[j]) {
					j++
				}
				if j < n && scan[j] == ':' {
					j++
					for j < n && isJSONSpace(scan[j]) {
						j++
					}
					return ks, j, valueEnd(scan, j), true
				}
			}
			inStr = true
			i++
		case '{', '[':
			depth++
			i++
		case '}', ']':
			depth--
			i++
		default:
			i++
		}
	}
	return 0, 0, 0, false
}

// valueEnd returns the index just past the JSON value starting at s.
func valueEnd(scan []byte, s int) int {
	n := len(scan)
	if s >= n {
		return n
	}
	switch scan[s] {
	case '{', '[':
		open := scan[s]
		close := byte('}')
		if open == '[' {
			close = ']'
		}
		depth := 0
		inStr := false
		for i := s; i < n; i++ {
			c := scan[i]
			if inStr {
				if c == '\\' {
					i++
					continue
				}
				if c == '"' {
					inStr = false
				}
				continue
			}
			switch c {
			case '"':
				inStr = true
			case open:
				depth++
			case close:
				depth--
				if depth == 0 {
					return i + 1
				}
			}
		}
		return n
	case '"':
		for i := s + 1; i < n; i++ {
			if scan[i] == '\\' {
				i++
				continue
			}
			if scan[i] == '"' {
				return i + 1
			}
		}
		return n
	default:
		// number / true / false / null: until a structural terminator.
		for i := s; i < n; i++ {
			switch scan[i] {
			case ',', '}', ']', ' ', '\t', '\n', '\r':
				return i
			}
		}
		return n
	}
}

func isJSONSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }
