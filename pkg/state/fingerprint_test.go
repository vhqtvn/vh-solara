package state

import "testing"

// FingerprintIDs (C5) — pure-function tests for the stateless subtree-id-set
// fingerprint used by the archive-preview drift fence. The contract:
//   - idempotent for a given set (deterministic hex);
//   - order-independent (sorted before hashing);
//   - changes iff the set's MEMBERSHIP changes (add/remove/reparent across the
//     subtree boundary);
//   - does NOT change on title or parentID-within-set changes (id-only);
//   - does not mutate the caller's slice.
//
// The preview↔commit coherence (DescendantSummaries returns the fingerprint
// under-lock; handleArchive recomputes it from the live affected set) is
// exercised in pkg/web/archive_drift_test.go against the real handler.

func TestFingerprintIDs_Deterministic(t *testing.T) {
	a := FingerprintIDs([]string{"a", "b"})
	b := FingerprintIDs([]string{"a", "b"})
	if a != b {
		t.Fatalf("fingerprint not deterministic: %q vs %q", a, b)
	}
	// Sanity: a real sha256-hex is 64 hex chars.
	if len(a) != 64 {
		t.Fatalf("fingerprint len want 64 hex chars, got %d (%q)", len(a), a)
	}
}

func TestFingerprintIDs_OrderIndependent(t *testing.T) {
	// An internal reparent keeps the same id-set (just reorders the children),
	// so it must NOT change the fingerprint — that is the precise property that
	// makes the fence reject only membership changes, not topology shuffles.
	if FingerprintIDs([]string{"a", "b", "c"}) != FingerprintIDs([]string{"c", "b", "a"}) {
		t.Fatal("fingerprint must be order-independent (sorted before hashing)")
	}
}

func TestFingerprintIDs_MembershipChangeDetected(t *testing.T) {
	// Spawn (add to subtree) — the over-archive case C5 exists to prevent.
	if FingerprintIDs([]string{"a", "b"}) == FingerprintIDs([]string{"a", "b", "c"}) {
		t.Fatal("fingerprint must change when an id is added (spawn)")
	}
	// Delete (remove from subtree) — under-archive.
	if FingerprintIDs([]string{"a", "b", "c"}) == FingerprintIDs([]string{"a", "b"}) {
		t.Fatal("fingerprint must change when an id is removed (delete)")
	}
	// Reparent across the boundary (replace one id with another) — same count,
	// different set. This is the ABA failure mode that rejects a count-only
	// guard (Option 5 in the design memo); the fingerprint catches it.
	if FingerprintIDs([]string{"a", "b"}) == FingerprintIDs([]string{"a", "c"}) {
		t.Fatal("fingerprint must change on membership swap (reparent in/out)")
	}
}

func TestFingerprintIDs_DoesNotMutateInput(t *testing.T) {
	in := []string{"c", "a", "b"}
	before := append([]string(nil), in...)
	_ = FingerprintIDs(in)
	for i := range in {
		if in[i] != before[i] {
			t.Fatalf("FingerprintIDs mutated its input: got %v, want %v", in, before)
		}
	}
}

func TestFingerprintIDs_EmptySet(t *testing.T) {
	// Two distinct empty-ish shapes must agree (both hash the empty join).
	if FingerprintIDs(nil) != FingerprintIDs([]string{}) {
		t.Fatal("nil and []string{} must fingerprint identically")
	}
	// And be distinct from a non-empty set.
	if FingerprintIDs(nil) == FingerprintIDs([]string{"a"}) {
		t.Fatal("empty set must differ from a non-empty set")
	}
}

// TestDescendantSummaries_FingerprintCoherent asserts the fingerprint
// DescendantSummaries returns is exactly FingerprintIDs of the walked id-set
// (extracted from the returned SessionSummary list), computed under the same
// lock. This is the under-lock coherence guarantee the design memo rests on.
func TestDescendantSummaries_FingerprintCoherent(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"root","title":"R"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"c1","parentID":"root","title":"C1"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"c2","parentID":"root","title":"C2"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"g1","parentID":"c1","title":"G1"}}`))

	descs, fp, _, _ := s.DescendantSummaries("root")
	ids := make([]string, len(descs))
	for i, d := range descs {
		ids[i] = d.ID
	}
	if want := FingerprintIDs(ids); fp != want {
		t.Fatalf("DescendantSummaries fingerprint %q != FingerprintIDs(walk ids) %q", fp, want)
	}
}

// TestDescendantSummaries_FingerprintUnknownIDSeedsID asserts the unknown-id
// path returns FingerprintIDs([id]) — matching the archive commit's empty-set
// fallback (archive.go: len(affected)==0 → [body.SessionID]) so preview↔commit
// stay coherent on the orphan/ghost path. A fingerprint of the empty set would
// always mismatch the fallback and stuck-loop the dialog.
func TestDescendantSummaries_FingerprintUnknownIDSeedsID(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"root"}}`)) // a live session

	descs, fp, _, _ := s.DescendantSummaries("ghost")
	if descs != nil {
		t.Fatalf("unknown id want nil descs, got %v", descs)
	}
	if want := FingerprintIDs([]string{"ghost"}); fp != want {
		t.Fatalf("unknown-id fingerprint %q != FingerprintIDs([ghost]) %q", fp, want)
	}
}

// TestDescendantSummaries_FingerprintChangesOnSpawn asserts the fingerprint
// changes when a new descendant is added between two preview calls — the core
// drift signal. (The full preview→commit 409 is exercised in pkg/web; this
// pins the Store-level behavior the handler relies on.)
func TestDescendantSummaries_FingerprintChangesOnSpawn(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"c1","parentID":"root"}}`))

	_, fpBefore, _, _ := s.DescendantSummaries("root")

	// Spawn a new child under root between the two previews.
	s.Apply(ev("session.created", `{"info":{"id":"c2","parentID":"root"}}`))

	_, fpAfter, _, _ := s.DescendantSummaries("root")
	if fpBefore == fpAfter {
		t.Fatal("fingerprint must change when a descendant spawns between previews")
	}
}
