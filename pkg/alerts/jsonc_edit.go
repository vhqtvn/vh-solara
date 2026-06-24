package alerts

import (
	"bytes"
	"encoding/json"
	"fmt"
	"reflect"
	"sort"
)

// Surgical JSONC editor: apply a new value to an existing JSONC document by
// rewriting ONLY the bytes whose value actually changed, leaving every comment,
// blank line, key order, and unknown key byte-for-byte intact.
//
// It parses the document into a light CST that records each value's byte span,
// then diffs the new value against it: scalars whose value differs are spliced
// in place; an array that changed is re-rendered whole (its own inner comments
// are the thing being edited); objects recurse key-by-key and never delete a key
// they weren't given (so unknown keys survive). Keys present in the new value but
// missing from the file are appended.

type jkind byte

const (
	jObject jkind = iota
	jArray
	jScalar // string | number | bool | null
)

type jnode struct {
	kind    jkind
	start   int // byte offset of the value's first token (in the original src)
	end     int // byte offset just past the value's last token
	members []jmember
	elems   []*jnode
}

type jmember struct {
	key      string
	keyStart int
	val      *jnode
}

type jparser struct {
	src []byte
	i   int
}

// editJSONC returns src with newVal applied surgically. newVal must be a
// JSON-native value (map[string]any / []any / scalar), e.g. from unmarshaling a
// marshaled struct. topOrder gives a deterministic order for any top-level keys
// that have to be appended.
func editJSONC(src []byte, newVal any, topOrder []string) ([]byte, error) {
	p := &jparser{src: src}
	p.skipTrivia()
	node, err := p.parseValue()
	if err != nil {
		return nil, err
	}
	var edits []edit
	if err := diffNode(src, node, newVal, topOrder, &edits); err != nil {
		return nil, err
	}
	return applyEdits(src, edits), nil
}

// --- edits ---

type edit struct {
	start, end int
	repl       []byte
}

func applyEdits(src []byte, edits []edit) []byte {
	// Apply from the end so earlier offsets stay valid. Stable sort keeps an
	// insertion (start==end) after a same-point replacement deterministic.
	sort.SliceStable(edits, func(a, b int) bool { return edits[a].start > edits[b].start })
	out := append([]byte{}, src...)
	for _, e := range edits {
		out = append(out[:e.start], append(append([]byte{}, e.repl...), out[e.end:]...)...)
	}
	return out
}

// --- diff ---

func diffNode(src []byte, node *jnode, newVal any, topOrder []string, edits *[]edit) error {
	switch nv := newVal.(type) {
	case map[string]any:
		if node.kind != jObject {
			return replaceWhole(src, node, newVal, edits)
		}
		seen := map[string]bool{}
		for _, m := range node.members {
			if v, ok := nv[m.key]; ok {
				seen[m.key] = true
				if err := diffNode(src, m.val, v, nil, edits); err != nil {
					return err
				}
			}
			// A key in the file but not in newVal is left untouched — this is how
			// unknown keys (and comments hanging off them) survive.
		}
		// Append keys present in newVal but missing from the file.
		missing := orderMissing(nv, seen, topOrder)
		if len(missing) > 0 {
			if err := appendMembers(src, node, nv, missing, edits); err != nil {
				return err
			}
		}
		return nil
	case []any:
		if node.kind != jArray || !jsonEqual(src, node, newVal) {
			return replaceWhole(src, node, newVal, edits)
		}
		return nil
	default: // scalar
		if node.kind == jObject || node.kind == jArray || !scalarEqual(src, node, newVal) {
			return replaceWhole(src, node, newVal, edits)
		}
		return nil
	}
}

func replaceWhole(src []byte, node *jnode, v any, edits *[]edit) error {
	b, err := renderValue(v, lineIndent(src, node.start))
	if err != nil {
		return err
	}
	*edits = append(*edits, edit{start: node.start, end: node.end, repl: b})
	return nil
}

// appendMembers inserts missing keys before the object's closing brace,
// matching the indentation of existing members.
func appendMembers(src []byte, node *jnode, nv map[string]any, keys []string, edits *[]edit) error {
	indent := "  "
	if len(node.members) > 0 {
		indent = lineIndent(src, node.members[0].keyStart)
	} else {
		indent = lineIndent(src, node.start) + "  "
	}
	closeIndent := lineIndent(src, node.start)

	var buf bytes.Buffer
	for _, k := range keys {
		rv, err := renderValue(nv[k], indent)
		if err != nil {
			return err
		}
		kb, _ := json.Marshal(k)
		buf.WriteString(",\n")
		buf.WriteString(indent)
		buf.Write(kb)
		buf.WriteString(": ")
		buf.Write(rv)
	}
	// For an empty object the leading comma is wrong; emit without it + a newline.
	if len(node.members) == 0 {
		var b2 bytes.Buffer
		for n, k := range keys {
			rv, _ := renderValue(nv[k], indent)
			kb, _ := json.Marshal(k)
			if n > 0 {
				b2.WriteString(",")
			}
			b2.WriteString("\n")
			b2.WriteString(indent)
			b2.Write(kb)
			b2.WriteString(": ")
			b2.Write(rv)
		}
		b2.WriteString("\n")
		b2.WriteString(closeIndent)
		// Insert just before the closing brace.
		*edits = append(*edits, edit{start: node.end - 1, end: node.end - 1, repl: b2.Bytes()})
		return nil
	}
	// Insert right after the last member's value (before any trailing comma/ws).
	last := node.members[len(node.members)-1].val
	*edits = append(*edits, edit{start: last.end, end: last.end, repl: buf.Bytes()})
	return nil
}

func orderMissing(nv map[string]any, seen map[string]bool, topOrder []string) []string {
	var out []string
	used := map[string]bool{}
	for _, k := range topOrder {
		if _, ok := nv[k]; ok && !seen[k] {
			out = append(out, k)
			used[k] = true
		}
	}
	var rest []string
	for k := range nv {
		if !seen[k] && !used[k] {
			rest = append(rest, k)
		}
	}
	sort.Strings(rest)
	return append(out, rest...)
}

// --- comparison ---

func scalarEqual(src []byte, node *jnode, newVal any) bool {
	var cur any
	if json.Unmarshal(src[node.start:node.end], &cur) != nil {
		return false
	}
	return jsonScalarDeepEqual(cur, newVal)
}

func jsonEqual(src []byte, node *jnode, newVal any) bool {
	var cur any
	if json.Unmarshal(stripJSONC(src[node.start:node.end]), &cur) != nil {
		return false
	}
	a, _ := json.Marshal(cur)
	b, _ := json.Marshal(newVal)
	return bytes.Equal(a, b)
}

// jsonScalarDeepEqual compares two json-native scalars, tolerating int/float
// representations.
func jsonScalarDeepEqual(a, b any) bool {
	if reflect.DeepEqual(a, b) {
		return true
	}
	af, aok := toFloat(a)
	bf, bok := toFloat(b)
	return aok && bok && af == bf
}

func toFloat(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	case json.Number:
		f, err := n.Float64()
		return f, err == nil
	}
	return 0, false
}

// renderValue marshals v as indented JSON. The first line carries no prefix (it
// continues the `"key": ` line); subsequent lines are prefixed with indent.
func renderValue(v any, indent string) ([]byte, error) {
	b, err := json.MarshalIndent(v, indent, "  ")
	if err != nil {
		return nil, err
	}
	return b, nil
}

// lineIndent returns the leading whitespace of the line containing pos.
func lineIndent(src []byte, pos int) string {
	if pos > len(src) {
		pos = len(src)
	}
	ls := pos
	for ls > 0 && src[ls-1] != '\n' {
		ls--
	}
	i := ls
	for i < len(src) && (src[i] == ' ' || src[i] == '\t') {
		i++
	}
	return string(src[ls:i])
}

// --- parser ---

func (p *jparser) skipTrivia() {
	n := len(p.src)
	for p.i < n {
		c := p.src[p.i]
		switch {
		case c == ' ' || c == '\t' || c == '\n' || c == '\r':
			p.i++
		case c == '/' && p.i+1 < n && p.src[p.i+1] == '/':
			for p.i < n && p.src[p.i] != '\n' {
				p.i++
			}
		case c == '/' && p.i+1 < n && p.src[p.i+1] == '*':
			p.i += 2
			for p.i+1 < n && !(p.src[p.i] == '*' && p.src[p.i+1] == '/') {
				p.i++
			}
			p.i += 2
			if p.i > n {
				p.i = n
			}
		default:
			return
		}
	}
}

func (p *jparser) parseValue() (*jnode, error) {
	p.skipTrivia()
	if p.i >= len(p.src) {
		return nil, fmt.Errorf("unexpected end of input")
	}
	switch c := p.src[p.i]; {
	case c == '{':
		return p.parseObject()
	case c == '[':
		return p.parseArray()
	case c == '"':
		return p.parseString()
	default:
		return p.parseLiteral()
	}
}

func (p *jparser) parseObject() (*jnode, error) {
	start := p.i
	p.i++ // '{'
	node := &jnode{kind: jObject, start: start}
	for {
		p.skipTrivia()
		if p.i >= len(p.src) {
			return nil, fmt.Errorf("unterminated object")
		}
		if p.src[p.i] == '}' {
			p.i++
			node.end = p.i
			return node, nil
		}
		keyStart := p.i
		keyNode, err := p.parseString()
		if err != nil {
			return nil, err
		}
		var key string
		if uerr := json.Unmarshal(p.src[keyNode.start:keyNode.end], &key); uerr != nil {
			return nil, uerr
		}
		p.skipTrivia()
		if p.i >= len(p.src) || p.src[p.i] != ':' {
			return nil, fmt.Errorf("expected ':' at %d", p.i)
		}
		p.i++ // ':'
		val, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		node.members = append(node.members, jmember{key: key, keyStart: keyStart, val: val})
		p.skipTrivia()
		if p.i < len(p.src) && p.src[p.i] == ',' {
			p.i++
			continue
		}
	}
}

func (p *jparser) parseArray() (*jnode, error) {
	start := p.i
	p.i++ // '['
	node := &jnode{kind: jArray, start: start}
	for {
		p.skipTrivia()
		if p.i >= len(p.src) {
			return nil, fmt.Errorf("unterminated array")
		}
		if p.src[p.i] == ']' {
			p.i++
			node.end = p.i
			return node, nil
		}
		val, err := p.parseValue()
		if err != nil {
			return nil, err
		}
		node.elems = append(node.elems, val)
		p.skipTrivia()
		if p.i < len(p.src) && p.src[p.i] == ',' {
			p.i++
			continue
		}
	}
}

func (p *jparser) parseString() (*jnode, error) {
	if p.i >= len(p.src) || p.src[p.i] != '"' {
		return nil, fmt.Errorf("expected string at %d", p.i)
	}
	start := p.i
	p.i++ // opening quote
	n := len(p.src)
	for p.i < n {
		c := p.src[p.i]
		if c == '\\' && p.i+1 < n {
			p.i += 2
			continue
		}
		if c == '"' {
			p.i++
			return &jnode{kind: jScalar, start: start, end: p.i}, nil
		}
		p.i++
	}
	return nil, fmt.Errorf("unterminated string at %d", start)
}

func (p *jparser) parseLiteral() (*jnode, error) {
	start := p.i
	n := len(p.src)
	for p.i < n {
		c := p.src[p.i]
		if c == ',' || c == '}' || c == ']' || c == ' ' || c == '\t' || c == '\n' || c == '\r' ||
			(c == '/' && p.i+1 < n && (p.src[p.i+1] == '/' || p.src[p.i+1] == '*')) {
			break
		}
		p.i++
	}
	if p.i == start {
		return nil, fmt.Errorf("invalid value at %d", start)
	}
	return &jnode{kind: jScalar, start: start, end: p.i}, nil
}
