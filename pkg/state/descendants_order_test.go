package state

// This file pins the parent-first ORDER CONTRACT of Store.Descendants /
// descendantsLocked (snapshots.go). The order is load-bearing for the archive
// cascade in pkg/web/archive.go: runArchiveCascade freezes the archive scope via
// Store.Descendants and iterates it in order, populating succeededSet as each id
// archives successfully; classifyArchiveFailure → descendantOfSucceeded then
// walks a captured parentOf chain UPWARD from a failed id and requires that id's
// parent to ALREADY be in succeededSet when the failed id is classified.
// Parent-first order is what makes that hold — a child's parent is processed
// (and thus in succeededSet) before the child is classified. Child-first order
// would misclassify a just-orphaned child as a root failure instead of a
// descendant-of-succeeded. These tests pin the order so a future refactor of
// descendantsLocked's traversal cannot silently break the archive classifier.
//
// The archive-side classification itself (descendantOfSucceeded) is already
// exercised end-to-end by pkg/web/archive_job_test.go's F1-fix path; the gap
// these tests close is the ordering CONTRACT on the store side, which was
// previously implicit and undocumented.

import (
	"testing"
)

// descendantIndices builds id→position from a Descendants result so the
// parent-before-descendant property can be checked in O(1) per pair.
func descendantIndices(order []string) map[string]int {
	idx := make(map[string]int, len(order))
	for i, id := range order {
		idx[id] = i
	}
	return idx
}

// TestDescendantsOrderIsParentFirst pins the core ORDER CONTRACT: for a
// multi-level tree with a sibling subtree
//
//	root
//	 ├── child ── grandchild
//	 └── sib   ── sibchild
//
// Descendants(root) returns EVERY parent before its OWN descendants. This is
// the precise property descendantOfSucceeded relies on (a child's parent is
// processed into succeededSet before the child is classified). Sibling order is
// intentionally NOT asserted — the children map is built by iterating
// s.sessions (nondeterministic), so only the parent-before-descendant property
// is contracted, not sibling interleaving.
//
// Mutation-observability: if descendantsLocked's DFS pre-order were flipped to
// append a node only after recursing into its children (child-first), or any
// node were emitted before its parent, the parent-before-descendant assertion
// fails immediately.
func TestDescendantsOrderIsParentFirst(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"root","title":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"child","parentID":"root","title":"child"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"grandchild","parentID":"child","title":"grandchild"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"sib","parentID":"root","title":"sibling"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"sibchild","parentID":"sib","title":"sibling-child"}}`))

	// The known parent links — mirrors the parentOf chain archive.go captures at
	// job start (runArchiveCascade). "root" has no parent.
	parentOf := map[string]string{
		"child":      "root",
		"grandchild": "child",
		"sib":        "root",
		"sibchild":   "sib",
	}

	got := s.Descendants("root")

	// Completeness: the self-inclusive descendant set is all 5 ids.
	wantSet := map[string]bool{
		"root": true, "child": true, "grandchild": true,
		"sib": true, "sibchild": true,
	}
	if len(got) != len(wantSet) {
		t.Fatalf("Descendants(root) len=%d, want %d; got %v", len(got), len(wantSet), got)
	}
	for _, id := range got {
		if !wantSet[id] {
			t.Fatalf("Descendants(root) unexpected id %q; got %v", id, got)
		}
	}

	// CRUX 1: the seed id itself is first — descendantsLocked appends `id` to
	// `out` before pushing any children onto the stack.
	if got[0] != "root" {
		t.Fatalf("Descendants(root)[0] = %q, want \"root\" (the seed id precedes its descendants)", got[0])
	}

	// CRUX 2: every ancestor appears strictly before each of its descendants —
	// the load-bearing property for descendantOfSucceeded. For each non-root id,
	// walk its full ancestor chain and assert every ancestor's position is
	// strictly less than the id's own position.
	idx := descendantIndices(got)
	for id, parent := range parentOf {
		cur := parent
		for cur != "" {
			ancIdx, ok := idx[cur]
			if !ok {
				t.Fatalf("ancestor %q of %q missing from Descendants(root)=%v", cur, id, got)
			}
			if ancIdx >= idx[id] {
				t.Errorf("parent-first order violated: ancestor %q (pos %d) must precede descendant %q (pos %d); full order=%v",
					cur, ancIdx, id, idx[id], got)
			}
			cur = parentOf[cur] // walk up; root's parent is "" → loop exits
		}
	}
}

// TestDescendantsOrderLinearChain pins parent-first on a degenerate single-child
// chain (root → c1 → c2 → c3) where the DFS stack-order is most likely to be
// accidentally inverted by a refactor (e.g. appending after recursing). With one
// child per node the order is FULLY determined — each parent immediately precedes
// its only child — so an exact-slice assertion is valid here (unlike the
// multi-sibling tree above, where sibling interleaving is nondeterministic).
func TestDescendantsOrderLinearChain(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"root","title":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"c1","parentID":"root","title":"c1"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"c2","parentID":"c1","title":"c2"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"c3","parentID":"c2","title":"c3"}}`))

	got := s.Descendants("root")
	want := []string{"root", "c1", "c2", "c3"}
	if len(got) != len(want) {
		t.Fatalf("Descendants(root) len=%d, want %d; got %v", len(got), len(want), got)
	}
	for i, id := range want {
		if got[i] != id {
			t.Fatalf("Descendants(root)[%d] = %q, want %q (parent-first linear chain); full order=%v", i, got[i], id, got)
		}
	}
}

// TestDescendantsOrderUnknownIDReturnsNil pins the nil-on-unknown contract:
// Descendants returns nil (not a non-nil empty slice) when id is absent from the
// live store. This is the documented API surface (see the Descendants doc
// comment) and is pinned here for API regularity and contract stability for
// future callers. NOTE: the current archive/delete handlers gate on
// `len(affected) == 0`, which treats nil and an empty slice identically in Go,
// so this nil-vs-empty distinction is NOT load-bearing for those handlers today
// — it is pinned as the documented contract so a future caller that DOES
// distinguish nil from empty is not surprised.
func TestDescendantsOrderUnknownIDReturnsNil(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"root","title":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"child","parentID":"root","title":"child"}}`))

	if got := s.Descendants("ghost"); got != nil {
		t.Fatalf("Descendants(unknown) = %v, want nil (nil-on-unknown contract; see the Descendants doc comment)", got)
	}
	// Sanity: the known root still returns ancestor-first [root, child].
	got := s.Descendants("root")
	if len(got) != 2 || got[0] != "root" || got[1] != "child" {
		t.Fatalf("Descendants(root) = %v, want [root child] (ancestor-first)", got)
	}
}
