package state

import (
	"testing"
)

// TreeBusyForDispatch contract tests (slice S2 of queue-idle-gate-send-now —
// the daemon queue drain loop's idle gate). The accessor is the NARROW
// canonical eligibility read (annex-1 E4 pre-authorization): effective-root
// resolution + the single subtreeBusyCount index GateFacts.SubtreeBusy
// derives from. These pin the (busy, exists) contract, root resolution
// (including orphan roots), and the retry-in / error-out busy classes.

// TestTreeBusyForDispatchContract pins the (busy, exists) contract across
// the whole tree: descendant busy holds EVERY lane of the tree
// (root-resolved), absent sessions report exists=false with NO busy
// evidence, and idle trees release every lane.
func TestTreeBusyForDispatchContract(t *testing.T) {
	s := New(100)

	// Absent: no entry, no busy evidence (the caller owns the absent=allow
	// disposition — W1; the accessor reports the observation).
	if busy, exists := s.TreeBusyForDispatch("nowhere"); busy || exists {
		t.Fatalf("absent session = (%v,%v), want (false,false)", busy, exists)
	}

	// Tree: root──c1──g, root──c2.
	s.Apply(ev("session.created", `{"info":{"id":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"c1","parentID":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"g","parentID":"c1"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"c2","parentID":"root"}}`))

	// Idle tree: present and not busy at every node.
	for _, sid := range []string{"root", "c1", "g", "c2"} {
		if busy, exists := s.TreeBusyForDispatch(sid); busy || !exists {
			t.Fatalf("idle %s = (%v,%v), want (false,true)", sid, busy, exists)
		}
	}

	// Deep descendant busy → the WHOLE tree holds (root-resolved read; note
	// g's own subtree contains the busy node, and every ancestor lane sees
	// it too via the root).
	s.Apply(ev("session.status", `{"sessionID":"g","status":{"type":"busy"}}`))
	for _, sid := range []string{"root", "c1", "g", "c2"} {
		if busy, exists := s.TreeBusyForDispatch(sid); !busy || !exists {
			t.Fatalf("busy-tree %s = (%v,%v), want (true,true) — root-resolved read must hold sibling lanes too", sid, busy, exists)
		}
	}

	// Agrees with the GateFacts derivation (single index, two projections).
	if gf := s.GateFacts()["root"]; !gf.SubtreeBusy {
		t.Fatalf("GateFacts[root].SubtreeBusy=false, want true — the accessor and the gate wire value must agree")
	}

	// Idle again → releases everywhere (fresh per call, no memory).
	s.Apply(ev("session.status", `{"sessionID":"g","status":{"type":"idle"}}`))
	for _, sid := range []string{"root", "c1", "g", "c2"} {
		if busy, _ := s.TreeBusyForDispatch(sid); busy {
			t.Fatalf("%s still busy after idle — the read must be fresh per call", sid)
		}
	}
}

// TestTreeBusyForDispatchRetryInErrorOut pins the busy classes: retry COUNTS
// (the operator contract's busy|retry), error does NOT (the standing
// ActivityError carve-out — error ≠ running).
func TestTreeBusyForDispatchRetryInErrorOut(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"r"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"kid","parentID":"r"}}`))

	// Retry is busy-class.
	s.Apply(ev("session.status", `{"sessionID":"kid","status":{"type":"retry"}}`))
	if busy, _ := s.TreeBusyForDispatch("r"); !busy {
		t.Fatal("retry descendant must hold the tree (busy|retry contract)")
	}
	s.Apply(ev("session.status", `{"sessionID":"kid","status":{"type":"idle"}}`))

	// Error is NOT busy-class. session.status normalizes error→idle, so set
	// via the internal chokepoint exactly like the M1/L-05 standing check
	// and gates_lean_test.go do.
	s.mu.Lock()
	s.setActivityLocked("kid", ActivityError)
	s.mu.Unlock()
	if busy, _ := s.TreeBusyForDispatch("r"); busy {
		t.Fatal("errored descendant must NOT hold the tree (the ActivityError carve-out: error ≠ running)")
	}
}

// TestTreeBusyForDispatchOrphanRoot pins root resolution at an ORPHAN: a
// session whose parentID names a session ABSENT from the store is its own
// effective root (rootOfLocked stops at the highest PRESENT ancestor). Its
// busy does not leak into unrelated trees, and its own lane sees its own
// busy.
func TestTreeBusyForDispatchOrphanRoot(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"orphan","parentID":"gone"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"solo"}}`))
	s.Apply(ev("session.status", `{"sessionID":"orphan","status":{"type":"busy"}}`))

	if busy, exists := s.TreeBusyForDispatch("orphan"); !busy || !exists {
		t.Fatalf("orphan = (%v,%v), want (true,true) — its own lane must see its own busy", busy, exists)
	}
	if busy, exists := s.TreeBusyForDispatch("solo"); busy || !exists {
		t.Fatalf("unrelated solo = (%v,%v), want (false,true) — an orphan's busy must not leak outside its tree", busy, exists)
	}
}
