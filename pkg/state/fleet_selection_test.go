package state

// fleet_selection_test.go — lane-1 pins for the fleet-watch projection
// (gauge-semantics slice of the fleet-status program): the root+unarchived
// selection predicate, the per-kind subtree pending counts surfacing
// descendant waits on selected roots, the read-time union's equivalence to
// the maintained subtreePendingInput index, and the snapshot/lean wire
// contract (marker + complete gate map + tri-state selection).

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

// fleetSelOf extracts the selection tri-state from a captured gate map.
func fleetSelOf(t *testing.T, gates map[string]GateFacts, sid string) bool {
	t.Helper()
	gf, ok := gates[sid]
	if !ok {
		t.Fatalf("session %q missing from gate map", sid)
	}
	if gf.FleetSelected == nil {
		t.Fatalf("session %q: fleet_selected must be a set pointer in store-derived maps", sid)
	}
	return *gf.FleetSelected
}

// TestFleetSelectionPredicateMatrix pins the selection predicate's every
// clause against the store's established archive/tree authorities:
//   - a raw root IS selected;
//   - a resident child of a live root is NOT (it is not an effective root);
//   - an unresolved-parent orphan (parent absent from the live store AND not
//     in the authoritative archived snapshot) IS selected — the effective
//     root collapse, and the chain does not terminate at "archived";
//   - an archived-chain orphan (parent removed from the live store and
//     present in the authoritative archived snapshot) is NOT selected;
//   - an authoritative-only archived resident (in the archived snapshot, no
//     time.archived on the info) is NOT selected;
//   - a live descendant of a REMOVED archived ancestor is NOT selected (its
//     chain terminates at the archived parent — the §9.1 orphan rule);
//   - own-info time.archived funnels through deleteSessionLocked on the
//     Apply path (the session LEAVES the live store — asserted as absence);
//     the resident-own-archived clause of the predicate (the archive-keep
//     hypothetical, same posture as isArchivedLocked) is pinned by the
//     direct unit block below;
//   - a malformed parent cycle terminates without promoting either member.
func TestFleetSelectionPredicateMatrix(t *testing.T) {
	s := New(100)
	// Plain tree: rootA -- childA; rootB alone.
	s.Apply(ev("session.created", `{"info":{"id":"rootA"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"childA","parentID":"rootA"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"rootB"}}`))
	// orphanU: parent points at an id absent from the live store and NOT in
	// the archived snapshot (unresolvable) → effective root, selected.
	s.Apply(ev("session.created", `{"info":{"id":"orphanU","parentID":"goneUnresolvable"}}`))
	// orphanArch: parent absent from the live store and IN the authoritative
	// archived snapshot → archived-chain orphan, excluded.
	s.Apply(ev("session.created", `{"info":{"id":"orphanArch","parentID":"goneArchived"}}`))
	// authArch: resident, no time.archived, but IN the authoritative snapshot.
	s.Apply(ev("session.created", `{"info":{"id":"authArch"}}`))
	// keepChild: parent arrives ALREADY archived → the parent is deleted and
	// noted in the snapshot, so the child's chain terminates at it.
	s.Apply(ev("session.created", `{"info":{"id":"keepParent","time":{"archived":123}}}`))
	s.Apply(ev("session.created", `{"info":{"id":"keepChild","parentID":"keepParent"}}`))
	// ownArch: created with time.archived — the Apply path deletes it.
	s.Apply(ev("session.created", `{"info":{"id":"ownArch","time":{"archived":123}}}`))
	// Malformed cycle: neither member is reachable from a root.
	s.Apply(ev("session.created", `{"info":{"id":"cycA","parentID":"cycB"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"cycB","parentID":"cycA"}}`))
	s.RefreshArchivedSnapshot([]json.RawMessage{
		[]byte(`{"id":"goneArchived","time":{"archived":1}}`),
		[]byte(`{"id":"authArch","time":{"archived":1}}`),
		// keepParent was auto-noted when its archived creation was deleted;
		// the wholesale rebuild would drop it, so re-include it (the periodic
		// refresh would list it too — it IS OpenCode-archived).
		[]byte(`{"id":"keepParent","time":{"archived":1}}`),
	})

	gates := s.GateFacts()
	want := map[string]bool{
		"rootA":      true,
		"childA":     false, // resident child: never a selected root
		"rootB":      true,
		"orphanU":    true,  // unresolvable parent → effective root, not archived-chain
		"orphanArch": false, // chain terminates at an archived parent
		"authArch":   false, // authoritative-snapshot archived (still resident)
		"keepChild":  false, // chain terminates at the removed archived parent
		"cycA":       false, // cycle members: no-root behavior pinned, not repaired
		"cycB":       false,
	}
	for sid, sel := range want {
		if got := fleetSelOf(t, gates, sid); got != sel {
			t.Errorf("selection(%s): want %v, got %v", sid, sel, got)
		}
	}
	// The Apply-path archive funnel: own-info archived sessions LEAVE the
	// live store (deleteSessionLocked) — they are absent from every gate
	// map, not merely unselected.
	for _, sid := range []string{"ownArch", "keepParent"} {
		if _, ok := gates[sid]; ok {
			t.Errorf("session %s: own-info archived must be deleted from the live store, but is present in the gate map", sid)
		}
	}

	// Direct unit block: the predicate's resident-own-archived clause. On
	// the Apply path this state is unreachable (the reducer deletes), but
	// the predicate keeps the clause as archive-keep defense — the SAME
	// posture as isArchivedLocked/chainTerminatesAtArchivedLocked, which
	// also guard a resident-archived hypothetical. Pin the clause where it
	// lives by installing a resident archived entry under the store lock.
	s.mu.Lock()
	s.sessions["ownArchResident"] = &sessionEntry{
		id:   "ownArchResident",
		info: []byte(`{"id":"ownArchResident","time":{"archived":5}}`),
	}
	sel := s.fleetSelectedLocked("ownArchResident", s.sessions["ownArchResident"])
	delete(s.sessions, "ownArchResident")
	s.mu.Unlock()
	if sel {
		t.Errorf("resident own-info archived entry must not be selected (archive-keep defense)")
	}
}

// TestFleetSelectedSubtreePendingCounts pins the descendant-wait surface:
// per-kind subtree pending SESSION counts (inclusive of self) on every gate
// entry, with a resident descendant's wait surfacing on its selected root
// even though the descendant is itself outside the selected population.
// Multiple request objects on ONE session count as one pending session; a
// permission→question transition with an unchanged union count still changes
// the per-kind counts.
func TestFleetSelectedSubtreePendingCounts(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"childP","parentID":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"childQ","parentID":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"grand","parentID":"childQ"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"root2"}}`))

	// The reconcile entrypoints REPLACE each kind's whole pending set (they
	// mirror GET /question + GET /permission hydrates), so each kind is
	// scripted in ONE call. Two pending permissions on ONE session (childP)
	// still count as one pending SESSION; grand's question is buried two
	// levels under root; root2 holds BOTH kinds.
	s.SetPendingPermissions([]json.RawMessage{
		[]byte(`{"id":"p1","sessionID":"childP"}`),
		[]byte(`{"id":"p2","sessionID":"childP"}`),
		[]byte(`{"id":"p3","sessionID":"root2"}`),
	})
	s.SetPendingQuestions([]json.RawMessage{
		[]byte(`{"id":"q1","sessionID":"grand"}`),
		[]byte(`{"id":"q2","sessionID":"root2"}`),
	})

	gates := s.GateFacts()
	if g := gates["root"]; g.SubtreePendingPermission != 1 || g.SubtreePendingQuestion != 1 || g.SubtreePendingInput != 2 {
		t.Errorf("root subtree pending: want perm=1 quest=1 union=2, got %+v", g)
	}
	if g := gates["childP"]; g.SubtreePendingPermission != 1 || g.SubtreePendingQuestion != 0 || g.SubtreePendingInput != 1 {
		t.Errorf("childP subtree pending: want perm=1 quest=0 union=1, got %+v", g)
	}
	if g := gates["childQ"]; g.SubtreePendingQuestion != 1 || g.SubtreePendingPermission != 0 {
		t.Errorf("childQ subtree pending: want quest=1 perm=0, got %+v", g)
	}
	if g := gates["grand"]; g.SubtreePendingQuestion != 1 || g.SubtreePendingInput != 1 {
		t.Errorf("grand subtree pending: want quest=1 union=1, got %+v", g)
	}
	// Both kinds on one session: once per kind, once in the union.
	if g := gates["root2"]; g.SubtreePendingPermission != 1 || g.SubtreePendingQuestion != 1 || g.SubtreePendingInput != 1 {
		t.Errorf("root2 subtree pending: want perm=1 quest=1 union=1, got %+v", g)
	}

	// Kind-only transition: childP's permission is REPLACED by a question
	// while grand's question survives — the UNION count over root's subtree
	// is unchanged at 2, but the per-kind counts must flip.
	s.SetPendingPermissions(nil)
	s.SetPendingQuestions([]json.RawMessage{
		[]byte(`{"id":"q1","sessionID":"grand"}`),
		[]byte(`{"id":"q3","sessionID":"childP"}`),
	})
	gates = s.GateFacts()
	if g := gates["root"]; g.SubtreePendingPermission != 0 || g.SubtreePendingQuestion != 2 || g.SubtreePendingInput != 2 {
		t.Errorf("root after kind flip: want perm=0 quest=2 union=2, got %+v", g)
	}

	// The filtered accessor: only selected roots, values identical.
	filt := s.GateFactsFleetSelected()
	wantSel := map[string]bool{"root": true, "root2": true}
	if len(filt) != len(wantSel) {
		t.Fatalf("filtered accessor: want exactly %v, got %d entries %v", wantSel, len(filt), filt)
	}
	for sid := range wantSel {
		other, ok := filt[sid]
		if !ok || !reflect.DeepEqual(other, gates[sid]) {
			t.Errorf("filtered entry %s must equal the complete map's entry: %+v vs %+v", sid, other, gates[sid])
		}
	}
}

// TestFleetAggregatesDifferentialWithMaintainedUnion pins the read-time
// union projection against the MAINTAINED subtreePendingInput index across
// the lifecycle inputs the index's own writers cover (pending set/clear,
// reconcile replacement, create, reparent, delete) — the differential proof
// that the read-time traversal and the maintained index agree on topology.
func TestFleetAggregatesDifferentialWithMaintainedUnion(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"r1"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"c1","parentID":"r1"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"g1","parentID":"c1"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"r2"}}`))

	check := func(stage string) {
		t.Helper()
		s.mu.RLock()
		read := s.computeFleetAggregatesLocked()
		maint := map[string]int{}
		for id, v := range s.subtreePendingInput {
			maint[id] = v
		}
		s.mu.RUnlock()
		ids := map[string]bool{}
		for id := range maint {
			ids[id] = true
		}
		for id := range read {
			ids[id] = true
		}
		for id := range ids {
			if read[id].unionPending != maint[id] {
				t.Fatalf("%s: union drift at %s: read=%d maintained=%d", stage, id, read[id].unionPending, maint[id])
			}
		}
	}

	check("seed")
	s.SetPendingQuestions([]json.RawMessage{[]byte(`{"id":"q1","sessionID":"g1"}`)})
	check("pending set (propagates to r1/c1)")
	s.SetPendingPermissions([]json.RawMessage{[]byte(`{"id":"p1","sessionID":"r2"}`)})
	check("second root pending")
	// Reconcile replacement: g1's question replaced by nothing.
	s.SetPendingQuestions(nil)
	check("cleared")
	// Reparent c1 (with g1 below it) under r2.
	s.Apply(ev("session.updated", `{"info":{"id":"c1","parentID":"r2"}}`))
	s.SetPendingQuestions([]json.RawMessage{[]byte(`{"id":"q2","sessionID":"g1"}`)})
	check("post-reparent")
	// Delete the pending leaf; its ancestor contributions must leave with it.
	s.RemoveSessions([]string{"g1"})
	check("post-delete")
	// Fresh create reabsorbing an orphan: c2 points at the not-yet-created
	// r3 (phantom-parent orphan), then r3 arrives and re-parents it.
	s.Apply(ev("session.created", `{"info":{"id":"c2","parentID":"r3"}}`))
	s.SetPendingPermissions([]json.RawMessage{[]byte(`{"id":"p2","sessionID":"c2"}`)})
	check("orphan pending")
	s.Apply(ev("session.created", `{"info":{"id":"r3"}}`))
	check("reabsorbed")
}

// TestFleetSelectedSubtreeActivityCounts pins the S3 subtree ACTIVITY
// surface: per-kind subtree error/retry SESSION counts (inclusive of self)
// on every gate entry, as ALWAYS-NONNIL pointers — the presence contract
// that lets the controller distinguish a supported zero (explicit 0) from a
// producer that predates the counts (nil, rejected at acquisition). A
// resident descendant's error/retry surfaces on its selected root even
// though the descendant is itself outside the selected population, and a
// session in error does NOT contribute to the retry count (or vice versa).
func TestFleetSelectedSubtreeActivityCounts(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"childE","parentID":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"childR","parentID":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"grandE","parentID":"childR"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"rootSelfErr"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"quiet"}}`))

	// session.error is the ONLY ActivityError source (a session.status
	// type:"error" normalizes to idle); retry seeds via session.status.
	s.Apply(ev("session.error", `{"sessionID":"childE"}`))
	s.Apply(ev("session.error", `{"sessionID":"grandE"}`))
	s.Apply(ev("session.status", `{"sessionID":"childR","status":{"type":"retry"}}`))
	s.Apply(ev("session.error", `{"sessionID":"rootSelfErr"}`))

	gates := s.GateFacts()
	// Presence first: EVERY entry (selected or not, quiet or not) carries
	// both pointers — the shared derivation never omits them.
	for sid, g := range gates {
		if g.SubtreeError == nil || g.SubtreeRetry == nil {
			t.Fatalf("session %s: subtree_error/subtree_retry must be nonnil on every derived entry, got %+v", sid, g)
		}
	}
	// root's subtree: childE + grandE in error, childR in retry.
	if g := gates["root"]; *g.SubtreeError != 2 || *g.SubtreeRetry != 1 {
		t.Errorf("root subtree activity: want err=2 retry=1, got %+v", g)
	}
	// childR: own retry + grandE's error below it.
	if g := gates["childR"]; *g.SubtreeError != 1 || *g.SubtreeRetry != 1 {
		t.Errorf("childR subtree activity: want err=1 retry=1, got %+v", g)
	}
	// Leaves count only themselves; kinds never cross.
	if g := gates["childE"]; *g.SubtreeError != 1 || *g.SubtreeRetry != 0 {
		t.Errorf("childE subtree activity: want err=1 retry=0, got %+v", g)
	}
	if g := gates["grandE"]; *g.SubtreeError != 1 || *g.SubtreeRetry != 0 {
		t.Errorf("grandE subtree activity: want err=1 retry=0, got %+v", g)
	}
	// Self-inclusive on a selected root; supported zero on a quiet root.
	if g := gates["rootSelfErr"]; *g.SubtreeError != 1 || *g.SubtreeRetry != 0 {
		t.Errorf("rootSelfErr subtree activity: want err=1 retry=0 (self-inclusive), got %+v", g)
	}
	if g := gates["quiet"]; *g.SubtreeError != 0 || *g.SubtreeRetry != 0 {
		t.Errorf("quiet subtree activity: want err=0 retry=0 (supported zero), got %+v", g)
	}
	// The filtered accessor carries the identical facts.
	filt := s.GateFactsFleetSelected()
	for _, sid := range []string{"root", "rootSelfErr", "quiet"} {
		other, ok := filt[sid]
		if !ok {
			t.Fatalf("filtered accessor: selected root %s missing", sid)
		}
		if *other.SubtreeError != *gates[sid].SubtreeError || *other.SubtreeRetry != *gates[sid].SubtreeRetry {
			t.Errorf("filtered entry %s drifted from the complete map: %+v vs %+v", sid, other, gates[sid])
		}
	}
	for _, sid := range []string{"childE", "childR", "grandE"} {
		if _, ok := filt[sid]; ok {
			t.Errorf("filtered accessor: child %s must never appear", sid)
		}
	}

	// WIRE shape: a supported zero SERIALIZES (an explicit "subtree_error":0
	// / "subtree_retry":0) — omitempty only drops the nil. This is the
	// producer half of the presence contract.
	b, err := json.Marshal(gates["quiet"])
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"subtree_error":0`, `"subtree_retry":0`} {
		if !strings.Contains(string(b), key) {
			t.Fatalf("quiet root wire: want explicit %s on a supported zero, got %s", key, b)
		}
	}

	// Recovery: the error clears (a live session.idle), the counts follow.
	s.Apply(ev("session.idle", `{"sessionID":"childE"}`))
	gates = s.GateFacts()
	if g := gates["root"]; *g.SubtreeError != 1 || *g.SubtreeRetry != 1 {
		t.Errorf("root after childE idle: want err=1 retry=1, got %+v", g)
	}
	s.Apply(ev("session.idle", `{"sessionID":"childR"}`))
	s.Apply(ev("session.idle", `{"sessionID":"grandE"}`))
	gates = s.GateFacts()
	if g := gates["root"]; *g.SubtreeError != 0 || *g.SubtreeRetry != 0 {
		t.Errorf("root after full recovery: want err=0 retry=0, got %+v", g)
	}
}

// TestFleetAggregatesRetryDifferentialWithMaintainedIndex pins the read-time
// retry projection against the MAINTAINED subtreeRetryCount index across the
// lifecycle inputs the index's own writers cover (activity transitions,
// create, reparent, delete) — the S3 differential the brief prescribes
// instead of a new mutable index. (The error count has no maintained
// counterpart by design; its equivalence to the busy index is deliberately
// NOT asserted — error is excluded from subtreeBusyCount by the carve-out.)
func TestFleetAggregatesRetryDifferentialWithMaintainedIndex(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"r1"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"c1","parentID":"r1"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"g1","parentID":"c1"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"r2"}}`))

	check := func(stage string) {
		t.Helper()
		s.mu.RLock()
		read := s.computeFleetAggregatesLocked()
		maint := map[string]int{}
		for id, v := range s.subtreeRetryCount {
			maint[id] = v
		}
		s.mu.RUnlock()
		ids := map[string]bool{}
		for id := range maint {
			ids[id] = true
		}
		for id := range read {
			ids[id] = true
		}
		for id := range ids {
			if read[id].retrySessions != maint[id] {
				t.Fatalf("%s: retry drift at %s: read=%d maintained=%d", stage, id, read[id].retrySessions, maint[id])
			}
		}
	}

	check("seed (all idle)")
	// busy→retry is retry-CHANGING: both the index and the read projection
	// must flip together.
	s.Apply(ev("session.status", `{"sessionID":"g1","status":{"type":"busy"}}`))
	check("g1 busy (retry count still 0)")
	s.Apply(ev("session.status", `{"sessionID":"g1","status":{"type":"retry"}}`))
	check("g1 retry (propagates to r1/c1)")
	s.Apply(ev("session.status", `{"sessionID":"g1","status":{"type":"idle"}}`))
	check("g1 idle (cleared)")
	s.Apply(ev("session.status", `{"sessionID":"g1","status":{"type":"retry"}}`))
	s.Apply(ev("session.status", `{"sessionID":"r2","status":{"type":"retry"}}`))
	check("two retrying sessions in distinct subtrees")
	// Reparent c1 (with g1 retrying below it) under r2.
	s.Apply(ev("session.updated", `{"info":{"id":"c1","parentID":"r2"}}`))
	check("post-reparent (r1 loses, r2 gains)")
	// Delete the retrying leaf; contributions leave with it.
	s.RemoveSessions([]string{"g1"})
	check("post-delete")
	// session.error on the remaining retry root flips retry→error: the
	// retry index must drop while the error count rises (checked via the
	// gate surface, since error has no maintained index).
	s.Apply(ev("session.error", `{"sessionID":"r2"}`))
	check("r2 error (retry index drops)")
	g := s.GateFacts()["r2"]
	if *g.SubtreeError != 1 || *g.SubtreeRetry != 0 {
		t.Fatalf("r2 after error: want subtree err=1 retry=0, got %+v", g)
	}
}

// TestSnapshotFleetSelectionContract pins the SNAPSHOT side of the wire
// contract: the envelope carries the fleet_selection capability marker, the
// gate map stays COMPLETE (children and archived sessions present, selected
// = false — ordinary SPA consumers are untouched), and the lean filtered
// accessor is exactly the selected subset of the snapshot's gate map with
// identical values.
func TestSnapshotFleetSelectionContract(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"child","parentID":"root"}}`))
	// auths: RESIDENT session in the authoritative archived snapshot (the
	// pre-delete window of a real archive cascade) — present in the complete
	// gate map, excluded from selection.
	s.Apply(ev("session.created", `{"info":{"id":"auths"}}`))
	s.RefreshArchivedSnapshot([]json.RawMessage{[]byte(`{"id":"auths","time":{"archived":1}}`)})
	s.SetPendingPermissions([]json.RawMessage{[]byte(`{"id":"p1","sessionID":"child"}`)})
	snap := s.Snapshot(nil)
	if snap.FleetSelection != FleetSelectionRootUnarchivedV1 {
		t.Fatalf("snapshot fleet_selection marker: want %q, got %q", FleetSelectionRootUnarchivedV1, snap.FleetSelection)
	}
	if len(snap.Gate) != 3 {
		t.Fatalf("snapshot gate must stay COMPLETE (3 sessions incl. child+archived), got %d", len(snap.Gate))
	}
	if fleetSelOf(t, snap.Gate, "root") != true || fleetSelOf(t, snap.Gate, "child") != false || fleetSelOf(t, snap.Gate, "auths") != false {
		t.Fatalf("snapshot selection flags: root=true child=false auths=false, got %+v", snap.Gate)
	}
	if g := snap.Gate["root"]; g.SubtreePendingPermission != 1 || g.SubtreePendingInput != 1 {
		t.Fatalf("snapshot root must surface the child's pending permission: %+v", g)
	}

	// Lean filtered accessor == the selected subset of the snapshot map.
	lean := s.GateFactsFleetSelected()
	if len(lean) != 1 {
		t.Fatalf("lean selected map: want exactly root, got %v", lean)
	}
	if !reflect.DeepEqual(lean["root"], snap.Gate["root"]) {
		t.Fatalf("lean selected entry drifted from snapshot entry:\n lean=%+v\n snap=%+v", lean["root"], snap.Gate["root"])
	}
}
