package state

import (
	"encoding/json"
	"strings"
	"testing"
)

// This file tests the Phase 3 snapshot trimming:
//   - GateFacts.Tokens is omitted in the projected path (the web client
//     derives token usage from message info, never from gate.tokens).
//   - Per-session constants (model, projectID, directory) are hoisted to
//     snapshot-level ProjectConstants when hoist=true, and stripped from
//     session info JSON. Sessions with per-session overrides keep the inline
//     field. Back-compat: hoist=false → legacy per-session fields.
//
// Proving tests follow a strict FAIL-without / PASS-with structure.

// trimTestStore builds a store with two active sessions sharing the same
// model/projectID/directory — the common real-world shape. Both sessions are
// busy so they land in the active closure and get materialized as full sessions
// with gate facets.
func trimTestStore() *Store {
	s := New(64)
	// Two sessions with identical model/projectID/directory.
	s.Apply(ev("session.created", `{"info":{"id":"a","title":"Root","projectID":"proj","directory":"/home/user/repo","model":{"providerID":"anthropic","id":"claude-sonnet-4-20250514","variant":"default"}}}`))
	s.Apply(ev("session.created", `{"info":{"id":"b","parentID":"a","title":"Child","projectID":"proj","directory":"/home/user/repo","model":{"providerID":"anthropic","id":"claude-sonnet-4-20250514","variant":"default"}}}`))
	// Make both active (busy).
	s.Apply(ev("session.status", evStatus("a", "busy")))
	s.Apply(ev("session.status", evStatus("b", "busy")))
	return s
}

// --- Gate tokens drop ---

// TestProjectedSnapshot_OmitsGateTokens proves that a projected snapshot
// (SnapshotProjected) does NOT serialize GateFacts.Tokens. The web client
// derives token usage from message info (usage.ts contextUsage), never from
// gate.tokens. FAIL-without: if the JSON output of a projected snapshot
// contains a "tokens" field inside any gate entry.
func TestProjectedSnapshot_OmitsGateTokens(t *testing.T) {
	s := trimTestStore()
	snap := s.SnapshotProjected(nil, "initial", false) // hoist irrelevant here

	rb, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	jsonStr := string(rb)

	// The gate facet is "gate":{"a":{...},"b":{...}}. Check that no gate entry
	// carries a "tokens" field. We check the substring within the gate object.
	// This is deliberately a raw-string check (not a struct decode) so it
	// catches both the Go struct tag AND any accidental population.
	if strings.Contains(jsonStr, `"tokens"`) {
		// Verify it's NOT in the gate section. The only valid "tokens" in a
		// snapshot would be inside a message info (messages[id][n].info.tokens).
		// Since this snapshot has no messages (nil messagesFor → but active
		// sessions DO get messages... let's check more carefully).
		// Actually: messagesFor=nil means ALL active sessions get messages.
		// But trimTestStore has no messages. So "tokens" can only be in gate.
		if snap.Gate != nil {
			for sid, g := range snap.Gate {
				if len(g.Tokens) > 0 {
					t.Fatalf("gate[%s].Tokens should be nil in projected path, got %s", sid, g.Tokens)
				}
			}
		}
		// If "tokens" appears but not in gate, it's from messages — which is fine.
		// But trimTestStore has no messages with tokens, so fail.
		t.Fatalf("projected snapshot JSON contains \"tokens\" — gate tokens should be omitted:\n%s", jsonStr)
	}
}

// TestLegacySnapshot_StillHasGateTokens proves the legacy Snapshot() path
// still populates gate tokens. This is the back-compat proof: old clients
// (non-proj) still get the full gate.
func TestLegacySnapshot_StillHasGateTokens(t *testing.T) {
	s := trimTestStore()
	// Seed an assistant message with tokens so the gate captures them.
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","tokens":{"input":100,"output":20}}}`))
	snap := s.Snapshot(nil)

	g, ok := snap.Gate["a"]
	if !ok {
		t.Fatal("legacy snapshot should have gate for session a")
	}
	if len(g.Tokens) == 0 {
		t.Fatal("legacy snapshot gate should have tokens (back-compat)")
	}
}

// --- Hoisted constants ---

// TestProjectedSnapshot_HoistStripsConstants proves that when hoist=true,
// the snapshot carries ProjectConstants and the per-session model/projectID/
// directory are stripped from session info. FAIL-without: if any session's
// info still carries the hoisted fields after a hoist=true snapshot.
func TestProjectedSnapshot_HoistStripsConstants(t *testing.T) {
	s := trimTestStore()
	snap := s.SnapshotProjected(nil, "initial", true)

	// 1. ProjectConstants must be populated.
	if snap.ProjectConstants == nil {
		t.Fatal("hoist=true should populate ProjectConstants")
	}
	if string(snap.ProjectConstants.Model) == "" {
		t.Fatal("ProjectConstants.Model should be set")
	}
	if snap.ProjectConstants.ProjectID != "proj" {
		t.Fatalf("ProjectConstants.ProjectID = %q, want proj", snap.ProjectConstants.ProjectID)
	}
	if snap.ProjectConstants.Directory != "/home/user/repo" {
		t.Fatalf("ProjectConstants.Directory = %q, want /home/user/repo", snap.ProjectConstants.Directory)
	}

	// 2. Verify the model was hoisted correctly.
	var modelObj map[string]string
	if err := json.Unmarshal(snap.ProjectConstants.Model, &modelObj); err != nil {
		t.Fatalf("unmarshal projectConstants model: %v", err)
	}
	if modelObj["providerID"] != "anthropic" || modelObj["id"] != "claude-sonnet-4-20250514" {
		t.Fatalf("hoisted model = %+v, want providerID=anthropic id=claude-sonnet-4-20250514", modelObj)
	}

	// 3. Each session's info should NOT have model/projectID/directory.
	for _, raw := range snap.Sessions {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatalf("unmarshal session info: %v", err)
		}
		if _, ok := fields["model"]; ok {
			t.Errorf("session info should NOT have model after hoist: %s", raw)
		}
		if _, ok := fields["projectID"]; ok {
			t.Errorf("session info should NOT have projectID after hoist: %s", raw)
		}
		if _, ok := fields["directory"]; ok {
			t.Errorf("session info should NOT have directory after hoist: %s", raw)
		}
	}
}

// TestProjectedSnapshot_HoistPreservesOverride proves that a session with a
// DIFFERENT model from the project constant keeps its inline model field.
// The test is order-independent (Go map iteration is randomized, so either
// model could become the project constant).
func TestProjectedSnapshot_HoistPreservesOverride(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"a","title":"Root","projectID":"proj","directory":"/home/user/repo","model":{"providerID":"anthropic","id":"claude-sonnet-4-20250514","variant":"default"}}}`))
	s.Apply(ev("session.created", `{"info":{"id":"b","parentID":"a","title":"Child","projectID":"proj","directory":"/home/user/repo","model":{"providerID":"openai","id":"gpt-4o","variant":"default"}}}`))
	s.Apply(ev("session.status", evStatus("a", "busy")))
	s.Apply(ev("session.status", evStatus("b", "busy")))

	snap := s.SnapshotProjected(nil, "initial", true)

	if snap.ProjectConstants == nil {
		t.Fatal("hoist should populate ProjectConstants")
	}

	// The project constant model is whichever session was iterated first.
	// Identify it so we know which session should be stripped vs kept.
	var pcModel map[string]string
	json.Unmarshal(snap.ProjectConstants.Model, &pcModel)
	pcID := pcModel["id"]

	// Each session: if its model == project constant → stripped; else → kept.
	for _, raw := range snap.Sessions {
		var fields map[string]json.RawMessage
		json.Unmarshal(raw, &fields)
		var sid string
		json.Unmarshal(fields["id"], &sid)

		// Determine this session's "original" model — from inline if present,
		// else from projectConstants (it was stripped because it matched).
		hasInlineModel := false
		if rawModel, ok := fields["model"]; ok {
			hasInlineModel = true
			var m map[string]string
			json.Unmarshal(rawModel, &m)
			// This session has a DIFFERENT model from the constant.
			if m["id"] == pcID {
				t.Errorf("session %s has inline model matching constant — should have been stripped", sid)
			}
		}
		if !hasInlineModel {
			// This session was stripped — its original model == pcModel.
			// (We can't read it anymore since it was stripped; that's the point.)
		}
	}

	// At least one session should have inline model (the override).
	// Exactly one session should be stripped (the one matching the constant).
	// With 2 sessions and 2 different models: 1 stripped, 1 kept.
	strippedCount := 0
	keptCount := 0
	for _, raw := range snap.Sessions {
		var fields map[string]json.RawMessage
		json.Unmarshal(raw, &fields)
		if _, ok := fields["model"]; ok {
			keptCount++
		} else {
			strippedCount++
		}
	}
	if strippedCount != 1 {
		t.Errorf("expected 1 session stripped (matching constant), got %d", strippedCount)
	}
	if keptCount != 1 {
		t.Errorf("expected 1 session with inline override, got %d", keptCount)
	}
}

// TestProjectedSnapshot_NoHoistKeepsPerSession proves that when hoist=false,
// session info is untouched (back-compat for old clients).
func TestProjectedSnapshot_NoHoistKeepsPerSession(t *testing.T) {
	s := trimTestStore()
	snap := s.SnapshotProjected(nil, "initial", false)

	if snap.ProjectConstants != nil {
		t.Fatal("hoist=false should NOT populate ProjectConstants")
	}

	// Sessions should still have model/projectID/directory inline.
	foundModel := false
	for _, raw := range snap.Sessions {
		var fields map[string]json.RawMessage
		json.Unmarshal(raw, &fields)
		if _, ok := fields["model"]; ok {
			foundModel = true
		}
	}
	if !foundModel {
		t.Fatal("hoist=false should keep per-session model (back-compat)")
	}
}

// --- Byte-count proof ---

// TestProjectedSnapshot_ByteReduction proves that hoist=true + gate-tokens
// drop produces a SMALLER JSON payload than hoist=false. This is the
// constant-factor savings proof. The exact reduction depends on fixture size;
// we assert strictly less than (not a fixed percentage) to avoid fragility.
func TestProjectedSnapshot_ByteReduction(t *testing.T) {
	s := trimTestStore()
	// Seed assistant messages with token usage on both sessions.
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","time":{"completed":1},"tokens":{"input":4200,"output":380,"cache":{"read":1800,"write":0}}}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m2","sessionID":"b","role":"assistant","time":{"completed":1},"tokens":{"input":1800,"output":240,"cache":{"read":900,"write":0}}}}`))

	withoutTrim := s.SnapshotProjected(nil, "initial", false)
	withTrim := s.SnapshotProjected(nil, "initial", true)

	rbOld, _ := json.Marshal(withoutTrim)
	rbNew, _ := json.Marshal(withTrim)

	if len(rbNew) >= len(rbOld) {
		t.Fatalf("trimmed snapshot should be SMALLER: old=%d new=%d", len(rbOld), len(rbNew))
	}
	t.Logf("byte reduction: old=%d new=%d saved=%d (%.1f%%)",
		len(rbOld), len(rbNew), len(rbOld)-len(rbNew),
		float64(len(rbOld)-len(rbNew))/float64(len(rbOld))*100)
}

// TestProjectedSnapshot_HoistEmitsOnProjectIDOnly proves the pcInitialized fix
// (reviewer b-F1): when sessions carry projectID/directory but NO model field,
// the stripped constants must still be emitted in ProjectConstants. The initial
// implementation set pcInitialized only in the model branch — this test catches
// that regression by verifying ProjectConstants is non-nil and populated.
func TestProjectedSnapshot_HoistEmitsOnProjectIDOnly(t *testing.T) {
	s := New(64)
	// Two sessions with projectID+directory but NO model.
	s.Apply(ev("session.created", `{"info":{"id":"x","title":"X","projectID":"proj-x","directory":"/repo/x"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"y","parentID":"x","title":"Y","projectID":"proj-x","directory":"/repo/x"}}`))
	s.Apply(ev("session.status", evStatus("x", "busy")))
	s.Apply(ev("session.status", evStatus("y", "busy")))

	snap := s.SnapshotProjected(nil, "initial", true)

	// FAIL-without: if pcInitialized were model-only, ProjectConstants would be nil.
	if snap.ProjectConstants == nil {
		t.Fatal("ProjectConstants must be emitted even when sessions have projectID/directory but no model")
	}
	if snap.ProjectConstants.ProjectID != "proj-x" {
		t.Errorf("ProjectConstants.ProjectID = %q, want %q", snap.ProjectConstants.ProjectID, "proj-x")
	}
	if snap.ProjectConstants.Directory != "/repo/x" {
		t.Errorf("ProjectConstants.Directory = %q, want %q", snap.ProjectConstants.Directory, "/repo/x")
	}

	// The sessions' projectID/directory must be stripped from inline info.
	for i, raw := range snap.Sessions {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(raw, &fields); err != nil {
			t.Fatalf("session[%d]: unmarshal: %v", i, err)
		}
		if _, ok := fields["projectID"]; ok {
			t.Errorf("session[%d]: projectID should be stripped (hoisted)", i)
		}
		if _, ok := fields["directory"]; ok {
			t.Errorf("session[%d]: directory should be stripped (hoisted)", i)
		}
	}
}

// TestProjectedSnapshot_HoistEmitsOnDirectoryOnly proves the same pcInitialized
// fix for the directory-only case (no model, no projectID).
func TestProjectedSnapshot_HoistEmitsOnDirectoryOnly(t *testing.T) {
	s := New(64)
	s.Apply(ev("session.created", `{"info":{"id":"z","title":"Z","directory":"/repo/z"}}`))
	s.Apply(ev("session.status", evStatus("z", "busy")))

	snap := s.SnapshotProjected(nil, "initial", true)

	if snap.ProjectConstants == nil {
		t.Fatal("ProjectConstants must be emitted when sessions have directory but no model/projectID")
	}
	if snap.ProjectConstants.Directory != "/repo/z" {
		t.Errorf("ProjectConstants.Directory = %q, want %q", snap.ProjectConstants.Directory, "/repo/z")
	}
}
