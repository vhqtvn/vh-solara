package projectcfg

import (
	"encoding/json"
	"strings"
	"testing"
)

// parseStyles round-trips the spliced output through the same JSONC loader the
// daemon uses, so a passing test proves the edit stays loadable.
func parseStyles(t *testing.T, b []byte) map[string]AgentStyle {
	t.Helper()
	var c Config
	if err := json.Unmarshal(stripJSONC(b), &c); err != nil {
		t.Fatalf("spliced output does not parse: %v\n---\n%s", err, b)
	}
	return c.AgentStyles
}

func TestSpliceReplacesExistingKeyPreservingComments(t *testing.T) {
	src := []byte(`{
  // companion processes (trust-gated — must survive the edit)
  "processes": [{ "id": "p", "command": "echo hi" }],
  "agentStyles": {
    "build": { "color": "muted" } // old value, will be replaced
  },
  "notes": true
}`)
	out, err := SpliceTopLevelKey(src, "agentStyles", map[string]AgentStyle{
		"supervisor": {Label: "SUP", Color: "danger", Style: "solid"},
	})
	if err != nil {
		t.Fatal(err)
	}
	s := parseStyles(t, out)
	if _, gone := s["build"]; gone {
		t.Fatalf("old agentStyles value not replaced: %+v", s)
	}
	if s["supervisor"].Label != "SUP" || s["supervisor"].Color != "danger" {
		t.Fatalf("new value not written: %+v", s)
	}
	str := string(out)
	if !strings.Contains(str, "trust-gated — must survive") {
		t.Fatalf("a comment outside the value was lost:\n%s", str)
	}
	if !strings.Contains(str, `"command": "echo hi"`) || !strings.Contains(str, `"notes": true`) {
		t.Fatalf("a sibling key was disturbed:\n%s", str)
	}
}

func TestSpliceInsertsWhenAbsentKeepingSiblings(t *testing.T) {
	src := []byte(`{
  // top comment
  "processes": [{ "id": "p", "command": "echo hi" }]
}`)
	out, err := SpliceTopLevelKey(src, "agentStyles", map[string]AgentStyle{
		"plan": {Color: "accent"},
	})
	if err != nil {
		t.Fatal(err)
	}
	s := parseStyles(t, out)
	if s["plan"].Color != "accent" {
		t.Fatalf("inserted value missing: %+v", s)
	}
	if !strings.Contains(string(out), "top comment") {
		t.Fatalf("comment lost on insert:\n%s", out)
	}
	// The trust-gated section must be byte-identical in spirit (still parses to
	// the same process).
	var c Config
	_ = json.Unmarshal(stripJSONC(out), &c)
	if len(c.Processes) != 1 || string(c.Processes[0].Command) == "" {
		t.Fatalf("processes disturbed by insert: %+v", c.Processes)
	}
}

func TestSpliceCreatesFreshWhenNoRoot(t *testing.T) {
	for _, src := range []string{"", "   \n  ", "// only a comment\n"} {
		out, err := SpliceTopLevelKey([]byte(src), "agentStyles", map[string]AgentStyle{
			"x": {Label: "X"},
		})
		if err != nil {
			t.Fatal(err)
		}
		if parseStyles(t, out)["x"].Label != "X" {
			t.Fatalf("fresh doc not authored for %q: %s", src, out)
		}
	}
}

func TestSpliceHandlesBracesInStringsAndComments(t *testing.T) {
	// A `}` inside a string and inside a comment must not be mistaken for the
	// end of the agentStyles object.
	src := []byte(`{
  "agentStyles": { "a": { "label": "}" } /* trailing } brace */ },
  "notes": false
}`)
	out, err := SpliceTopLevelKey(src, "agentStyles", map[string]AgentStyle{
		"b": {Label: "B"},
	})
	if err != nil {
		t.Fatal(err)
	}
	s := parseStyles(t, out)
	if _, stillThere := s["a"]; stillThere {
		t.Fatalf("old value not fully replaced (brace/string/comment miscount): %+v", s)
	}
	if s["b"].Label != "B" {
		t.Fatalf("new value missing: %+v", s)
	}
	if !strings.Contains(string(out), `"notes": false`) {
		t.Fatalf("sibling after a tricky value was dropped:\n%s", out)
	}
}

// parseFull round-trips the edited output through the JSONC loader so a passing
// test proves the result stays loadable as a full Config (not just agentStyles).
func parseFull(t *testing.T, b []byte) *Config {
	t.Helper()
	var c Config
	if err := json.Unmarshal(stripJSONC(b), &c); err != nil {
		t.Fatalf("edited output does not parse: %v\n---\n%s", err, b)
	}
	return &c
}

// parseRepls round-trips the spliced output through the same JSONC loader the
// daemon uses, so a passing test proves the edit stays loadable and the
// nameReplacements array round-trips with order/flags preserved.
func parseRepls(t *testing.T, b []byte) []NameReplacementRule {
	t.Helper()
	var c Config
	if err := json.Unmarshal(stripJSONC(b), &c); err != nil {
		t.Fatalf("spliced output does not parse: %v\n---\n%s", err, b)
	}
	return c.NameReplacements
}

func TestSpliceNameReplacementsInsertsWhenAbsentKeepingSiblings(t *testing.T) {
	src := []byte(`{
  // top comment
  "processes": [{ "id": "p", "command": "echo hi" }]
}`)
	out, err := SpliceTopLevelKey(src, "nameReplacements", []NameReplacementRule{
		{Pattern: `\[\[A\]\]`, Replacement: "A!", Flags: "g"},
		{Pattern: `\[\[B\]\]`, Replacement: "B!"},
	})
	if err != nil {
		t.Fatal(err)
	}
	r := parseRepls(t, out)
	if len(r) != 2 || r[0].Pattern != `\[\[A\]\]` || r[0].Flags != "g" || r[1].Pattern != `\[\[B\]\]` {
		t.Fatalf("inserted value missing/order/flags wrong: %+v", r)
	}
	if r[1].Flags != "" {
		t.Fatalf("absent flags should serialize away (omitempty): %+v", r[1])
	}
	if !strings.Contains(string(out), "top comment") {
		t.Fatalf("comment lost on insert:\n%s", out)
	}
	var c Config
	_ = json.Unmarshal(stripJSONC(out), &c)
	if len(c.Processes) != 1 {
		t.Fatalf("processes disturbed by insert: %+v", c.Processes)
	}
}

func TestSpliceNameReplacementsReplacesExistingPreservingSiblings(t *testing.T) {
	src := []byte(`{
  // companion processes (trust-gated — must survive the edit)
  "processes": [{ "id": "p", "command": "echo hi" }],
  "nameReplacements": [
    { "pattern": "old", "replacement": "x" } // old value, will be replaced
  ],
  "notes": true
}`)
	out, err := SpliceTopLevelKey(src, "nameReplacements", []NameReplacementRule{
		{Pattern: "new", Replacement: "y", Flags: "g"},
	})
	if err != nil {
		t.Fatal(err)
	}
	r := parseRepls(t, out)
	if len(r) != 1 || r[0].Pattern != "new" || r[0].Replacement != "y" || r[0].Flags != "g" {
		t.Fatalf("old value not replaced / fields wrong: %+v", r)
	}
	str := string(out)
	if !strings.Contains(str, "trust-gated — must survive") {
		t.Fatalf("a comment outside the value was lost:\n%s", str)
	}
	if !strings.Contains(str, `"command": "echo hi"`) || !strings.Contains(str, `"notes": true`) {
		t.Fatalf("a sibling key was disturbed:\n%s", str)
	}
}

// TestSpliceNameReplacementsExplicitEmptyClears: writing an empty (non-nil)
// slice authors `[]`, which decodes back to a non-nil empty slice — the overlay
// key PRESENCE is preserved (so it replaces the base wholesale), not absent.
func TestSpliceNameReplacementsExplicitEmptyClears(t *testing.T) {
	src := []byte(`{
  "nameReplacements": [{ "pattern": "old", "replacement": "x" }]
}`)
	out, err := SpliceTopLevelKey(src, "nameReplacements", []NameReplacementRule{})
	if err != nil {
		t.Fatal(err)
	}
	c := parseFull(t, out)
	if c.NameReplacements == nil {
		t.Fatalf("explicit [] should decode to non-nil empty slice, got nil:\n%s", out)
	}
	if len(c.NameReplacements) != 0 {
		t.Fatalf("explicit [] should clear the array, got %+v:\n%s", c.NameReplacements, out)
	}
	if !strings.Contains(string(out), `"nameReplacements": []`) {
		t.Fatalf("expected an explicit empty array in the authored text:\n%s", out)
	}
}

func TestRemoveExistingKeyPreservesSiblingsAndComments(t *testing.T) {
	src := []byte(`{
  // companion processes (trust-gated — must survive the edit)
  "processes": [{ "id": "p", "command": "echo hi" }],
  "agentStyles": {
    "build": { "color": "muted" } // old value, will be removed
  },
  "notes": true
}`)
	out := RemoveTopLevelKey(src, "agentStyles")
	c := parseFull(t, out)
	if c.AgentStyles != nil && len(c.AgentStyles) > 0 {
		t.Fatalf("agentStyles not removed: %+v", c.AgentStyles)
	}
	str := string(out)
	if !strings.Contains(str, "trust-gated — must survive") {
		t.Fatalf("a comment outside the removed value was lost:\n%s", str)
	}
	if !strings.Contains(str, `"command": "echo hi"`) || !strings.Contains(str, `"notes": true`) {
		t.Fatalf("a sibling key was disturbed:\n%s", str)
	}
}

func TestRemoveAbsentKeyIsNoop(t *testing.T) {
	src := []byte(`{
  // top comment
  "processes": [{ "id": "p", "command": "echo hi" }]
}`)
	out := RemoveTopLevelKey(src, "agentStyles")
	if string(out) != string(src) {
		t.Fatalf("removing an absent key changed the file:\nwant: %s\ngot:  %s", src, out)
	}
}

func TestRemoveOnlyKeyLeavesValidEmptyObject(t *testing.T) {
	for _, src := range [][]byte{
		[]byte(`{ "agentStyles": { "build": { "label": "B" } } }`),
		// Trailing comma after the only key must also collapse cleanly.
		[]byte(`{ "agentStyles": { "build": { "label": "B" } }, }`),
	} {
		out := RemoveTopLevelKey(src, "agentStyles")
		c := parseFull(t, out)
		if c.AgentStyles != nil && len(c.AgentStyles) > 0 {
			t.Fatalf("agentStyles not removed: %+v\ncase: %s", c.AgentStyles, src)
		}
	}
}

func TestRemoveHandlesBracesInStringsAndComments(t *testing.T) {
	// A `}` inside a string and inside a comment must not be mistaken for the
	// end of the agentStyles object — the cut must stop at the real value end,
	// leaving the sibling intact.
	src := []byte(`{
  "agentStyles": { "a": { "label": "}" } /* trailing } brace */ },
  "notes": false
}`)
	out := RemoveTopLevelKey(src, "agentStyles")
	c := parseFull(t, out)
	if c.AgentStyles != nil && len(c.AgentStyles) > 0 {
		t.Fatalf("agentStyles not removed (brace/string/comment miscount): %+v", c.AgentStyles)
	}
	if c.Notes == nil || *c.Notes != false {
		t.Fatalf("sibling after a tricky value was dropped or disturbed: %+v", c.Notes)
	}
	if !strings.Contains(string(out), `"notes": false`) {
		t.Fatalf("sibling text not preserved:\n%s", out)
	}
}
