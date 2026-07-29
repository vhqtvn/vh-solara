package state

// gate_alias_test.go pins the WIRE-FIELD ALIAS standing-checks for the
// snapshot.gate response (audit L-03 / L-09, Posture B alias-during-transition).
//
// The daemon DUAL-EMITS the old + new field names with the SAME value so the
// SPA can migrate to the exact names (`hasMessages`, `permissionWasBlocked`)
// while a stale un-reloaded tab keeps reading the retained old names
// (`hydrated`, `permission_blocked`). These tests assert BOTH names are present
// on the wire and carry identical values — they are the regression gate against
// either name silently disappearing or the two drifting apart.
//
// Removal of the old names is a FUTURE slice gated on an operator-approved
// cutoff; during the alias window these tests assert presence of BOTH. See
// docs/ai/wire-field-deprecation.md.

import (
	"encoding/json"
	"testing"
)

// gateJSON builds a snapshot carrying one gate entry, marshals it to JSON, and
// returns the decoded per-session gate map so a test can assert field presence
// and value equality. This exercises the REAL wire path (Snapshot → json) for a
// snapshot.gate response, not a hand-rolled fragment.
func gateJSON(t *testing.T, g GateFacts) map[string]any {
	t.Helper()
	snap := Snapshot{Gate: map[string]GateFacts{"s1": g}}
	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal snapshot: %v", err)
	}
	var dec map[string]any
	if err := json.Unmarshal(raw, &dec); err != nil {
		t.Fatalf("unmarshal snapshot: %v", err)
	}
	gateAny, ok := dec["gate"]
	if !ok {
		t.Fatalf("snapshot JSON missing top-level gate object: %s", raw)
	}
	gate, ok := gateAny.(map[string]any)
	if !ok {
		t.Fatalf("snapshot gate is not an object: %v", gateAny)
	}
	s1Any, ok := gate["s1"]
	if !ok {
		t.Fatalf("snapshot gate missing entry s1: %v", gate)
	}
	s1, ok := s1Any.(map[string]any)
	if !ok {
		t.Fatalf("snapshot gate[s1] is not an object: %v", s1Any)
	}
	return s1
}

// TestGateDualEmitsHydratedAndHasMessages is the L-03 standing-check: the
// snapshot.gate response must carry BOTH `hydrated` (retained) and `hasMessages`
// (the exact name the SPA migrates to), with the SAME value, for both the true
// and false states.
func TestGateDualEmitsHydratedAndHasMessages(t *testing.T) {
	for _, want := range []bool{true, false} {
		s1 := gateJSON(t, GateFacts{Hydrated: want, HasMessages: want})
		hyd, okH := s1["hydrated"]
		has, okM := s1["hasMessages"]
		if !okH {
			t.Errorf("gate missing retained `hydrated` field (want=%v): %v", want, s1)
		}
		if !okM {
			t.Errorf("gate missing new `hasMessages` field (want=%v): %v", want, s1)
		}
		if okH && okM && hyd != has {
			t.Errorf("hydrated (%v) != hasMessages (%v) — alias fields drifted apart", hyd, has)
		}
	}
}

// TestGateDualEmitsPermissionBlocked is the L-09 standing-check: the
// snapshot.gate response must carry BOTH `permission_blocked` (retained) and
// `permissionWasBlocked` (the exact name), with the SAME value. The SPA does not
// currently read either, but non-SPA consumers (coordapi/MCP/headless) may, so
// both stay on the wire during the alias window.
func TestGateDualEmitsPermissionBlocked(t *testing.T) {
	for _, want := range []bool{true, false} {
		s1 := gateJSON(t, GateFacts{PermissionBlocked: want, PermissionWasBlocked: want})
		old, okO := s1["permission_blocked"]
		new, okN := s1["permissionWasBlocked"]
		if !okO {
			t.Errorf("gate missing retained `permission_blocked` field (want=%v): %v", want, s1)
		}
		if !okN {
			t.Errorf("gate missing new `permissionWasBlocked` field (want=%v): %v", want, s1)
		}
		if okO && okN && old != new {
			t.Errorf("permission_blocked (%v) != permissionWasBlocked (%v) — alias fields drifted apart", old, new)
		}
	}
}
