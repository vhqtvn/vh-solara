package state

// translate_test.go — translator-level unit tests (direct calls to
// TranslatorV1.Translate, distinct from the Apply-level ingestion-contract
// tests in ingest_contract_test.go). This is the test home for invariants that
// live ENTIRELY inside the translator: the parsed/typed NormalizedEvent is the
// observable, not a downstream store mutation.
//
// The callId defensive-parsing invariant (paseo ToolCallDetail, adapted to Go
// — DESIGN ONLY, never copied; paseo is AGPL) is the first such behavior. It
// was RED-first: this test was written and confirmed failing BEFORE the rule
// landed in translate.go, then turned GREEN by the implementation in the same
// slice.

import (
	"encoding/json"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// partUpdatedEvent builds a raw "message.part.updated" event whose properties
// carry the given part sub-blob under "part" (the opencode wire shape the
// translator extracts — see translate.go's message.part.updated arm).
func partUpdatedEvent(partJSON string) opencode.Event {
	return opencode.Event{
		Type:       "message.part.updated",
		Properties: json.RawMessage(`{"part":` + partJSON + `}`),
	}
}

// TestTranslatorV1_ToolCallPartCallIDPrecedence pins the tool-call callId
// defensive-parsing invariant: a tool-call part's identity resolves by
// precedence **callID > id > drop**.
//
//   - Prefer the tool-call correlation id (callID).
//   - If callID is absent, fall back to the part id.
//   - If NEITHER is present the part is uncorrelatable → DROPPED at the
//     translation boundary (NormIgnored), never passed through.
//
// A callId is NEVER synthesized or fabricated: only fields the wire payload
// actually carries are used, and the opaque part blob is passed through
// byte-identical (Raw == input part sub-blob, no re-serialization).
//
// The rule is TOOL-CALL-specific (type:"tool"): non-tool parts are untouched
// (no identity resolution, no callId-driven drop at the translator).
//
// This test was RED before the rule: the translator returned NormPartUpsert
// with PartID=="" (no identity resolution) and did not drop neither-field tool
// parts. The implementation in translate.go turned it GREEN in the same slice.
func TestTranslatorV1_ToolCallPartCallIDPrecedence(t *testing.T) {
	tr := TranslatorV1{}

	// --- Case 1: BOTH callID and id present → callID wins (precedence). ---
	t.Run("both_present_callID_wins", func(t *testing.T) {
		part := `{"id":"p1","sessionID":"s","messageID":"m","type":"tool","callID":"c1","tool":"bash"}`
		ne, err := tr.Translate(partUpdatedEvent(part))
		if err != nil {
			t.Fatalf("Translate returned error: %v", err)
		}
		if ne.Kind != NormPartUpsert {
			t.Fatalf("callID+id tool part: kind=%v, want NormPartUpsert (survives)", ne.Kind)
		}
		if ne.PartID != "c1" {
			t.Errorf("callID+id tool part: PartID=%q, want %q (callID wins over id; callID>id>drop)", ne.PartID, "c1")
		}
		// Never synthesize / never re-serialize: Raw is the part sub-blob byte-identical.
		if string(ne.Raw) != part {
			t.Errorf("callID+id tool part: Raw=%s, want byte-identical input %s (no synthesis)", ne.Raw, part)
		}
	})

	// --- Case 2: callID present, id absent → callID is the identity. ---
	t.Run("callID_only", func(t *testing.T) {
		part := `{"sessionID":"s","messageID":"m","type":"tool","callID":"c2","tool":"bash"}`
		ne, err := tr.Translate(partUpdatedEvent(part))
		if err != nil {
			t.Fatalf("Translate returned error: %v", err)
		}
		if ne.Kind != NormPartUpsert {
			t.Fatalf("callID-only tool part: kind=%v, want NormPartUpsert (callID correlates it; survives)", ne.Kind)
		}
		if ne.PartID != "c2" {
			t.Errorf("callID-only tool part: PartID=%q, want %q (callID is the identity)", ne.PartID, "c2")
		}
		if string(ne.Raw) != part {
			t.Errorf("callID-only tool part: Raw=%s, want byte-identical input %s (no synthesis)", ne.Raw, part)
		}
	})

	// --- Case 3: id present, callID absent → id fallback. ---
	t.Run("id_only_fallback", func(t *testing.T) {
		part := `{"id":"p3","sessionID":"s","messageID":"m","type":"tool","tool":"bash"}`
		ne, err := tr.Translate(partUpdatedEvent(part))
		if err != nil {
			t.Fatalf("Translate returned error: %v", err)
		}
		if ne.Kind != NormPartUpsert {
			t.Fatalf("id-only tool part: kind=%v, want NormPartUpsert (id fallback; survives)", ne.Kind)
		}
		if ne.PartID != "p3" {
			t.Errorf("id-only tool part: PartID=%q, want %q (id fallback when callID absent)", ne.PartID, "p3")
		}
		if string(ne.Raw) != part {
			t.Errorf("id-only tool part: Raw=%s, want byte-identical input %s (no synthesis)", ne.Raw, part)
		}
	})

	// --- Case 4: NEITHER callID nor id → DROP (NormIgnored). ---
	t.Run("neither_present_dropped", func(t *testing.T) {
		part := `{"sessionID":"s","messageID":"m","type":"tool","tool":"bash"}`
		ne, err := tr.Translate(partUpdatedEvent(part))
		if err != nil {
			t.Fatalf("Translate returned error: %v", err)
		}
		if ne.Kind != NormIgnored {
			t.Errorf("neither-field tool part: kind=%v, want NormIgnored (uncorrelatable → DROPPED at the "+
				"translation boundary; callID>id>drop, never synthesize)", ne.Kind)
		}
	})

	// --- Case 5: NON-tool part is UNAFFECTED (rule is tool-call-specific). ---
	// A text part passes through with no identity resolution (PartID stays empty);
	// the callId-driven drop does NOT apply to non-tool parts.
	t.Run("non_tool_part_unaffected", func(t *testing.T) {
		part := `{"id":"t1","sessionID":"s","messageID":"m","type":"text","text":"hi"}`
		ne, err := tr.Translate(partUpdatedEvent(part))
		if err != nil {
			t.Fatalf("Translate returned error: %v", err)
		}
		if ne.Kind != NormPartUpsert {
			t.Fatalf("non-tool text part: kind=%v, want NormPartUpsert (rule is tool-call-specific)", ne.Kind)
		}
		if ne.PartID != "" {
			t.Errorf("non-tool text part: PartID=%q, want empty (identity resolution is tool-call-specific)", ne.PartID)
		}
		if string(ne.Raw) != part {
			t.Errorf("non-tool text part: Raw=%s, want byte-identical input %s", ne.Raw, part)
		}
	})
}
