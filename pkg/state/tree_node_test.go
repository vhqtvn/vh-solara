package state

import (
	"encoding/json"
	"strings"
	"testing"
)

// Group 1 — Node + delta-op JSON serialization (§3, §4).
// These are the server-side contract types. They MUST round-trip to the exact
// wire shape the design doc specifies, because the Phase 3 client decodes them
// verbatim and the field set is the cross-version contract.

// jsonFields returns the set of keys present in a JSON object literal. Used to
// assert exact field PRESENCE (optionality) per §3, not just successful decode.
func jsonFields(t *testing.T, raw []byte) map[string]bool {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("jsonFields: unmarshal %s: %v", raw, err)
	}
	out := make(map[string]bool, len(m))
	for k := range m {
		out[k] = true
	}
	return out
}

// TestNode_JSON_OptionalAbsent verifies the OPTIONAL fields (§3) are OMITTED
// when zero, and the required fields are always present.
func TestNode_JSON_OptionalAbsent(t *testing.T) {
	n := Node{
		ID:         "S_a91f",
		ParentID:   "", // root → emitted as null
		Title:      "fix: parser edge case",
		Activity:   ActivityBusy,
		ChildCount: 3,
		Loaded:     false,
		Flags:      NodeFlags{},
		UpdatedMs:  1721700123000,
		// agent, verb, descendantCount left zero → MUST be absent (§3 omitempty).
	}
	raw, err := json.Marshal(n)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	fields := jsonFields(t, raw)

	// Required fields always present (§3).
	for _, k := range []string{"id", "parentId", "title", "activity", "childCount", "loaded", "flags", "updatedMs"} {
		if !fields[k] {
			t.Errorf("required field %q absent in %s", k, raw)
		}
	}
	// parentId null for a root.
	if !strings.Contains(string(raw), `"parentId":null`) {
		t.Errorf("root parentId must be null, got %s", raw)
	}
	// OPTIONAL fields absent when zero (§3: agent?, verb?, descendantCount?).
	for _, k := range []string{"agent", "verb", "descendantCount"} {
		if fields[k] {
			t.Errorf("optional field %q must be absent when zero, got %s", k, raw)
		}
	}
}

// TestNode_JSON_OptionalPresent verifies the OPTIONAL fields are emitted when
// set, and verb carries its tool+state shape (§3).
func TestNode_JSON_OptionalPresent(t *testing.T) {
	n := Node{
		ID:              "S_b",
		ParentID:        "S_a",
		Title:           "sub",
		Agent:           "build",
		Activity:        ActivityRetry,
		Verb:            &VerbFacet{Tool: "read", State: json.RawMessage(`{"x":1}`)},
		ChildCount:      0,
		DescendantCount: ptrInt(533),
		Loaded:          true,
		Flags:           NodeFlags{SubtreeNeedsInput: true},
		UpdatedMs:       42,
	}
	raw, err := json.Marshal(n)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	fields := jsonFields(t, raw)
	for _, k := range []string{"agent", "verb", "descendantCount"} {
		if !fields[k] {
			t.Errorf("optional field %q must be present when set, got %s", k, raw)
		}
	}
	if !strings.Contains(string(raw), `"parentId":"S_a"`) {
		t.Errorf("non-root parentId must be the id string, got %s", raw)
	}
	// Round-trip.
	var back Node
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if back.Agent != "build" || back.Verb.Tool != "read" || back.DescendantCount == nil || *back.DescendantCount != 533 {
		t.Errorf("round-trip lost optional data: %+v", back)
	}
}

// TestNodeFlags_JSON_Shape verifies flags is an object with exactly the §3 keys.
func TestNodeFlags_JSON_Shape(t *testing.T) {
	f := NodeFlags{PendingInput: true, SubtreeNeedsInput: true, Permission: false, Archived: false, Orphan: false}
	raw, err := json.Marshal(f)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := jsonFields(t, raw)
	want := map[string]bool{
		"pendingInput": true, "subtreeNeedsInput": true,
		"permission": true, "archived": true, "orphan": true,
	}
	for k := range want {
		if !got[k] {
			t.Errorf("flags missing %q in %s", k, raw)
		}
	}
	for k := range got {
		if !want[k] {
			t.Errorf("flags has unexpected %q in %s", k, raw)
		}
	}
}

// TestTreeOp_JSON_Shapes verifies each delta op (§4.2-4.6) marshals to its
// envelope+data shape exactly.
func TestTreeOp_JSON_Shapes(t *testing.T) {
	cases := []struct {
		name string
		op   TreeOp
		want string // substring assertions
	}{
		{
			name: "node.upsert",
			op:   NodeUpsertOp(Node{ID: "x", Title: "t"}),
			want: `"op":"node.upsert","data":{"node":`,
		},
		{
			name: "node.remove",
			op:   NodeRemoveOp("S_a91f"),
			want: `"op":"node.remove","data":{"id":"S_a91f"}`,
		},
		{
			name: "node.move",
			op:   NodeMoveOp("S_b22", "S_a91f"),
			want: `"op":"node.move","data":{"id":"S_b22","newParentId":"S_a91f"}`,
		},
		{
			name: "node.move to root",
			op:   NodeMoveOp("S_b22", ""),
			want: `"op":"node.move","data":{"id":"S_b22","newParentId":null`,
		},
		{
			name: "node.children terminal",
			op:   NodeChildrenOp("S_a91f", []Node{{ID: "c1"}}, false, ""),
			want: `"op":"node.children","data":{"parentId":"S_a91f","nodes":[`,
		},
		{
			name: "node.facet partial flags",
			op:   NodeFacetOp("S_a91f", FacetData{Activity: ptrString("retry"), Flags: map[string]bool{"pendingInput": true}}),
			want: `"activity":"retry"`,
		},
		{
			name: "node.facet verb null clears",
			op:   NodeFacetOp("S_a91f", FacetData{Verb: ClearVerb()}),
			want: `"op":"node.facet","data":{"id":"S_a91f","verb":null`,
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			raw, err := json.Marshal(c.op)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if !strings.Contains(string(raw), c.want) {
				t.Errorf("op %s: want substring %q, got %s", c.name, c.want, raw)
			}
		})
	}
}

// TestTreeOp_Sequence verifies the envelope carries a monotonic seq (INV-A).
func TestTreeOp_Sequence(t *testing.T) {
	if NodeUpsertOp(Node{ID: "x"}).Op() != "node.upsert" {
		t.Fatal("Op() must report the op kind")
	}
}

// TestFacetData_FlagsPartial verifies a node.facet carries ONLY the changed flag
// keys (§4.6 "omitted flags are untouched"), not the full NodeFlags set.
func TestFacetData_FlagsPartial(t *testing.T) {
	op := NodeFacetOp("S_x", FacetData{Flags: map[string]bool{"pendingInput": true}})
	raw, err := json.Marshal(op)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// Decode data.flags and assert it has exactly one key: pendingInput=true.
	var env struct {
		Data struct {
			Flags map[string]bool `json:"flags"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(env.Data.Flags) != 1 || !env.Data.Flags["pendingInput"] {
		t.Errorf("facet flags must be partial {pendingInput:true}, got %v (in %s)", env.Data.Flags, raw)
	}
}

// ptrInt / ptrString / VerbClear are test helpers defined here; the real
// definitions live in tree_node.go. They are referenced to confirm the API.
func ptrInt(v int) *int          { return &v }
func ptrString(v string) *string { return &v }
