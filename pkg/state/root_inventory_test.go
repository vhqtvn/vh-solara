package state

import (
	"sort"
	"testing"
)

// TestRootInventory covers the authoritative active-root inventory that the
// labels subsystem consumes. It must (a) include every live session; (b) mark
// IsRoot=true iff parentID == "" (the STRICT definition labels use — NOT the
// orphan-inclusive definition RootCount/RunningRoots use); (c) exclude archived
// sessions (archive funnels through deleteSessionLocked); and (d) carry the raw
// parentID so the web layer can compose project ownership.
func TestRootInventory(t *testing.T) {
	s := New(100)

	// Empty store → empty inventory.
	if got := s.RootInventory(); len(got) != 0 {
		t.Fatalf("empty store: want 0 entries, got %d", len(got))
	}

	// a is a root, a1 is its child, b is a second root.
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"a1","parentID":"a"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"b"}}`))

	// An orphan (parentID points at a session NOT in the live tree): the
	// orphan-inclusive RootCount would count it as a root, but labels use the
	// STRICT definition, so its IsRoot MUST be false (parentID != "").
	s.Apply(ev("session.created", `{"info":{"id":"o","parentID":"ghost"}}`))

	entries := s.RootInventory()
	got := map[string]RootInventoryEntry{}
	for _, e := range entries {
		got[e.SessionID] = e
	}
	if len(got) != 4 {
		t.Fatalf("inventory len = %d, want 4 (a, a1, b, o): %v", len(got), got)
	}
	for id, want := range map[string]struct {
		parent string
		root   bool
	}{
		"a":  {"", true},
		"a1": {"a", false},
		"b":  {"", true},
		"o":  {"ghost", false}, // STRICT root definition: parentID != "" → not a root
	} {
		e, ok := got[id]
		if !ok {
			t.Fatalf("inventory missing %s: %v", id, got)
		}
		if e.ParentID != want.parent {
			t.Fatalf("%s: ParentID = %q, want %q", id, e.ParentID, want.parent)
		}
		if e.IsRoot != want.root {
			t.Fatalf("%s: IsRoot = %v, want %v", id, e.IsRoot, want.root)
		}
	}

	// Cross-check against the orphan-INCLUSIVE RootCount: a, b are strict roots
	// (2), but the orphan o is ALSO counted by RootCount (3). RootInventory's
	// IsRoot count (2) must be strictly less, proving the definitions differ.
	strictRoots := 0
	for _, e := range entries {
		if e.IsRoot {
			strictRoots++
		}
	}
	if strictRoots != 2 {
		t.Fatalf("strict root count = %d, want 2 (a, b only)", strictRoots)
	}
	if rc := s.RootCount(); rc != 3 {
		t.Fatalf("RootCount = %d, want 3 (a, b, orphan o) — proves definitions differ", rc)
	}

	// Archiving a live root removes it from the live tree, so it vanishes from
	// the inventory entirely (RootInventory is live-only, like SessionIDs).
	s.Apply(ev("session.updated", `{"info":{"id":"b","time":{"archived":12345}}}`))
	after := s.RootInventory()
	var ids []string
	for _, e := range after {
		ids = append(ids, e.SessionID)
	}
	sort.Strings(ids)
	want := []string{"a", "a1", "o"}
	if len(ids) != len(want) {
		t.Fatalf("after archive b: ids = %v, want %v", ids, want)
	}
	for i := range want {
		if ids[i] != want[i] {
			t.Fatalf("after archive b: ids = %v, want %v", ids, want)
		}
	}
}
