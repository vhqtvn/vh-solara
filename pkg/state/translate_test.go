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
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
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

// TestResolveToolCallIdentity_FallThrough pins the two NON-happy fall-through
// contracts of resolveToolCallIdentity that were previously unpinned by an
// executable assertion (a prior review DEFER flagged the gap). Both fall-throughs
// return the zero tuple (partTool=false, resolved="", ok=false), which tells the
// translator to LEAVE THE PART ALONE — no identity resolution and no callId-driven
// drop; the part is then subject to the handler's own validity guard.
//
// This is a CHARACTERIZATION test (it pins current behavior), NOT TDD-red: it is
// expected to pass against the current implementation and FAIL if a later change
// violates the documented fall-through contract:
//
//   - parse-fail must NOT panic, must NOT be conflated with a tool part
//     (partTool stays false), and must NOT fabricate an identity (resolved
//     stays ""). A panic surfaces as a normal test failure, so simply running
//     the function under each malformed input pins the no-panic guarantee.
//   - a non-tool part must NOT be misclassified as a tool call (partTool stays
//     false) and must NOT synthesize an identity (resolved stays "").
//
// resolveToolCallIdentity is package-private, so this test lives in package
// state and calls it directly — exercising the EXACT fall-through code paths in
// translate.go (the two `return false, "", false` statements) rather than only
// their downstream Translate-level effect.
func TestResolveToolCallIdentity_FallThrough(t *testing.T) {
	// --- (a) parse-FAIL: malformed / unparseable part sub-blobs. ---
	// Every input below makes json.Unmarshal(part, &meta) return a non-nil
	// error (syntax error OR a type mismatch — array/string/number into a
	// struct). The contract is a graceful fall-through to the zero tuple.
	t.Run("parse_fail_no_panic_no_fabricated_identity", func(t *testing.T) {
		cases := []struct {
			name  string
			input string
		}{
			{"truncated_garbage", `{bad json`},
			{"truncated_object_mid_field", `{"type":"tool",`},
			{"json_array_into_struct", `[1,2,3]`},
			{"json_string_into_struct", `"a string"`},
			{"json_number_into_struct", `42`},
		}
		for _, c := range cases {
			t.Run(c.name, func(t *testing.T) {
				// A panic here (e.g. if a future change panics on parse error)
				// fails the test outright — pinning the no-panic guarantee.
				partTool, resolved, ok := resolveToolCallIdentity(json.RawMessage(c.input))
				if partTool {
					t.Errorf("parse-fail input %q: partTool=true, want false "+
						"(a parse error must NOT be conflated with a tool part; "+
						"the part is left to the handler's own validity guard, "+
						"not the callId-driven drop)", c.input)
				}
				if resolved != "" {
					t.Errorf("parse-fail input %q: resolved=%q, want empty "+
						"(a parse error must NOT fabricate/synthesize an identity; "+
						"only wire-carried fields are used, never synthesized)", c.input, resolved)
				}
				if ok {
					t.Errorf("parse-fail input %q: ok=true, want false "+
						"(an unparseable part does not survive identity resolution)", c.input)
				}
			})
		}
	})

	// --- (b) NON-TOOL: a parseable part that is genuinely not a tool call. ---
	// These all parse cleanly but meta.Type != "tool", so the rule (which is
	// tool-call-specific) does not apply and no identity is produced.
	t.Run("non_tool_no_identity_synthesized", func(t *testing.T) {
		cases := []struct {
			name  string
			input string
		}{
			{"type_text", `{"id":"t1","type":"text","text":"hi"}`},
			{"type_reasoning", `{"id":"r1","type":"reasoning"}`},
			{"type_file", `{"id":"f1","type":"file"}`},
			{"type_absent", `{"id":"p1"}`},
			{"type_empty_string", `{"id":"p2","type":""}`},
		}
		for _, c := range cases {
			t.Run(c.name, func(t *testing.T) {
				partTool, resolved, ok := resolveToolCallIdentity(json.RawMessage(c.input))
				if partTool {
					t.Errorf("non-tool input %q: partTool=true, want false "+
						"(the rule is tool-call-specific (type:\"tool\"); a non-tool "+
						"part must NOT be misclassified as a tool call)", c.input)
				}
				if resolved != "" {
					t.Errorf("non-tool input %q: resolved=%q, want empty "+
						"(a non-tool part must NOT synthesize a tool-call identity; "+
						"identity resolution applies only to type:\"tool\")", c.input, resolved)
				}
				if ok {
					t.Errorf("non-tool input %q: ok=true, want false "+
						"(a non-tool part is not a tool-call survival/drop decision)", c.input)
				}
			})
		}
	})
}

// journalBuf is a concurrency-safe vhlog capture (the same lockedWriter
// pattern as pkg/web's stream journal tests). vhlog.SetOutput is
// PROCESS-WIDE: tests using it must never call t.Parallel() without first
// converting to a test-scoped logger.
type journalBuf struct {
	mu  sync.Mutex
	buf bytes.Buffer
}

func (b *journalBuf) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.Write(p)
}

func (b *journalBuf) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.buf.String()
}

func (b *journalBuf) Reset() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.buf.Reset()
}

// TestTranslatorV1_InstanceDisposedJournaledAndIgnored — P4 incident
// self-capture (2026-10-31 post-mortem, Gap 2). server.instance.disposed is
// ignored for the VIEW (NormIgnored — no UI state, no snapshot, deliberately
// unchanged), but the drop decision now emits ONE always-on "oc instance
// disposed" journal line naming the directory, so opencode instance churn —
// invisible during the incident — lands in durable evidence. Verified
// upstream (sst/opencode /event route): the SSE stream forwards the event for
// the disposed instance's directory as its TERMINAL event (the stream ends
// right after), and vh-solara's SubscribeEvents applies no type filter, so
// the event reaches Translate on every dispose. Also pins that OTHER event
// types keep their exact existing translate behavior: no journal line, same
// NormalizedKind.
func TestTranslatorV1_InstanceDisposedJournaledAndIgnored(t *testing.T) {
	var jb journalBuf
	prev := vhlog.SetOutput(&jb)
	defer vhlog.SetOutput(prev)

	tr := TranslatorV1{}

	// (1) The disposed event, well-formed: still NormIgnored for the view,
	//     but the journal line names the directory from the properties.
	ne, err := tr.Translate(opencode.Event{
		Type:       "server.instance.disposed",
		Properties: json.RawMessage(`{"directory":"/home/op/repo"}`),
	})
	if err != nil {
		t.Fatalf("Translate returned error: %v", err)
	}
	if ne.Kind != NormIgnored {
		t.Fatalf("server.instance.disposed must stay NormIgnored (view behavior unchanged), got %v", ne.Kind)
	}
	if line := jb.String(); !strings.Contains(line, "oc instance disposed") ||
		!strings.Contains(line, "type=server.instance.disposed") ||
		!strings.Contains(line, "directory=/home/op/repo") {
		t.Errorf("disposed event must journal one line naming the directory, got: %q", line)
	}
	// Volume pin: EXACTLY one line per disposed event (a duplicate emission
	// must fail, not pass silently through substring containment).
	if n := strings.Count(jb.String(), `msg="oc instance disposed"`); n != 1 {
		t.Errorf("disposed event must emit exactly one journal line, got %d: %q", n, jb.String())
	}

	// (2) Unparseable/absent properties: the ARRIVAL is the evidence — the
	//     line still emits (with an empty directory), never panics.
	jb.Reset()
	ne, err = tr.Translate(opencode.Event{Type: "server.instance.disposed", Properties: json.RawMessage(`{not-json`)})
	if err != nil || ne.Kind != NormIgnored {
		t.Fatalf("malformed disposed: err=%v kind=%v, want nil/NormIgnored", err, ne.Kind)
	}
	if line := jb.String(); !strings.Contains(line, "oc instance disposed") {
		t.Errorf("disposed arrival with malformed properties must still journal: %q", line)
	}

	// (3) Existing behavior unchanged for other event types — no journal line
	//     for the rest of the ignored set, and a real translated kind still
	//     translates.
	jb.Reset()
	ne, err = tr.Translate(opencode.Event{Type: "server.heartbeat", Properties: json.RawMessage(`{}`)})
	if err != nil || ne.Kind != NormIgnored {
		t.Fatalf("server.heartbeat: err=%v kind=%v, want nil/NormIgnored", err, ne.Kind)
	}
	ne, err = tr.Translate(opencode.Event{
		Type:       "session.created",
		Properties: json.RawMessage(`{"info":{"id":"s1"}}`),
	})
	if err != nil || ne.Kind != NormSessionUpsert {
		t.Fatalf("session.created: err=%v kind=%v, want nil/NormSessionUpsert", err, ne.Kind)
	}
	if line := jb.String(); strings.Contains(line, "oc instance disposed") {
		t.Errorf("non-disposed events must NOT emit the disposed journal line: %q", line)
	}
}
