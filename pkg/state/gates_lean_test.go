package state

import (
	"encoding/json"
	"reflect"
	"testing"
)

// TestGateFactsLeanParityWithSnapshot pins the lean accessor's contract: the
// worker's GET /vh/gates endpoint (pkg/web handleFleetGates) serves
// Store.GateFacts() so the controller's fleet rollup never pays full-snapshot
// marshaling — which is only honest if the lean map carries EXACTLY the values
// a full Snapshot's Gate map carries. Both projections share
// gateFactsFromScalars (single derivation); this test FAILS if the two paths
// ever drift (e.g. someone edits one literal without the other).
//
// The tree is non-trivial on purpose: busy/retry/error activities, a
// multi-level subtree, and pending questions/permissions — the facets the
// fleet rollup folds into conditions.
func TestGateFactsLeanParityWithSnapshot(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"child","parentID":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"idle1","parentID":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"grand","parentID":"idle1"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"err","parentID":"root"}}`))

	// child busy + grand retry make root/idle1/child/grand subtrees busy.
	s.Apply(ev("session.status", `{"sessionID":"child","status":{"type":"busy"}}`))
	s.Apply(ev("session.status", `{"sessionID":"grand","status":{"type":"retry"}}`))
	// ActivityError carve-out (session.status normalizes error→idle, so set
	// via the internal chokepoint like the M1/L-05 standing-check does).
	s.mu.Lock()
	s.setActivityLocked("err", ActivityError)
	s.mu.Unlock()
	// Pending question + permission on distinct sessions (public reconcile
	// mutators — the GET /question and GET /permission hydrate paths).
	s.SetPendingQuestions([]json.RawMessage{[]byte(`{"id":"q1","sessionID":"root"}`)})
	s.SetPendingPermissions([]json.RawMessage{[]byte(`{"id":"perm1","sessionID":"idle1"}`)})

	lean := s.GateFacts()
	full := s.Snapshot(nil).Gate

	if len(lean) == 0 {
		t.Fatal("lean gate map is empty — sessions never seeded")
	}
	if !reflect.DeepEqual(lean, full) {
		t.Fatalf("lean GateFacts() drifted from Snapshot(nil).Gate:\n lean=%+v\n full=%+v", lean, full)
	}

	// Spot-pin the load-bearing rollup facts (activity + pending flags +
	// subtree busy) so a drift in EITHER direction of the shared derivation
	// is readable, not just a map diff.
	if g := lean["child"]; g.Activity != ActivityBusy || !g.SubtreeBusy {
		t.Errorf("child: want busy+subtreeBusy, got %+v", g)
	}
	if g := lean["err"]; g.Activity != ActivityError || g.SubtreeBusy {
		t.Errorf("err: want error without subtreeBusy, got %+v", g)
	}
	if g := lean["root"]; !g.PendingQuestion || !g.SubtreeBusy {
		t.Errorf("root: want pendingQuestion+subtreeBusy, got %+v", g)
	}
	if g := lean["idle1"]; !g.PendingPermission {
		t.Errorf("idle1: want pendingPermission, got %+v", g)
	}
	if g := lean["grand"]; g.Activity != ActivityRetry {
		t.Errorf("grand: want retry, got %+v", g)
	}

	// --- fleet-selection enrichment (gauge-semantics slice) ---
	// The shared derivation stamps the SAME selection/pending facts on both
	// paths (DeepEqual above already covers them); spot-pin the load-bearing
	// values so a drift is readable, and pin the filtered-subset contract:
	// GateFactsFleetSelected is exactly the selected subset of the complete
	// map — root is the only selected session here (child/idle1/err/grand are
	// resident children; every session is unarchived).
	if g := lean["root"]; g.FleetSelected == nil || !*g.FleetSelected {
		t.Errorf("root: want fleet_selected=true, got %+v", g)
	}
	for _, sid := range []string{"child", "idle1", "err", "grand"} {
		if g := lean[sid]; g.FleetSelected == nil || *g.FleetSelected {
			t.Errorf("%s: want fleet_selected=false (resident child), got %+v", sid, g)
		}
	}
	// root's subtree holds BOTH kinds: its own question + idle1's permission.
	if g := lean["root"]; g.SubtreePendingPermission != 1 || g.SubtreePendingQuestion != 1 || g.SubtreePendingInput != 2 {
		t.Errorf("root: want subtree perm=1 quest=1 union=2, got %+v", g)
	}
	if g := lean["idle1"]; g.SubtreePendingPermission != 1 || g.SubtreePendingInput != 1 {
		t.Errorf("idle1: want subtree perm=1 union=1, got %+v", g)
	}

	// --- S3 subtree activity counts ---
	// Presence on EVERY entry (the controller's validators reject nil counts
	// in nonempty gate maps — the lean path is one of the three capture
	// paths that must never omit them), then the per-kind sums: root's
	// subtree holds err (error) + grand (retry); idle1's holds grand (retry);
	// the error carve-out means err contributes to NO busy-class fact.
	for sid, g := range lean {
		if g.SubtreeError == nil || g.SubtreeRetry == nil {
			t.Fatalf("%s: subtree_error/subtree_retry must be nonnil on the lean path, got %+v", sid, g)
		}
	}
	if g := lean["root"]; *g.SubtreeError != 1 || *g.SubtreeRetry != 1 {
		t.Errorf("root: want subtree err=1 retry=1, got %+v", g)
	}
	if g := lean["idle1"]; *g.SubtreeError != 0 || *g.SubtreeRetry != 1 {
		t.Errorf("idle1: want subtree err=0 retry=1, got %+v", g)
	}
	if g := lean["err"]; *g.SubtreeError != 1 || *g.SubtreeRetry != 0 || g.SubtreeBusy {
		t.Errorf("err: want subtree err=1 retry=0 and NOT subtree-busy (carve-out), got %+v", g)
	}
	if g := lean["grand"]; *g.SubtreeError != 0 || *g.SubtreeRetry != 1 {
		t.Errorf("grand: want subtree err=0 retry=1, got %+v", g)
	}

	filt := s.GateFactsFleetSelected()
	if len(filt) != 1 {
		t.Fatalf("filtered lean map: want exactly [root], got %d entries", len(filt))
	}
	if !reflect.DeepEqual(filt["root"], lean["root"]) {
		t.Fatalf("filtered root entry drifted from the complete lean entry:\n filt=%+v\n lean=%+v", filt["root"], lean["root"])
	}
}
