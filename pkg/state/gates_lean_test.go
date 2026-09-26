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
}
