package state

// tree_emitter_prepare_test.go — L-14/M5 Prepare/Commit delivery-integrity
// protocol tests. These assert the invariant the protocol exists to enforce:
// Prepare NEVER mutates committed cache state, so a delivery failure (which
// only discards the prepared object) leaves the committed cache exactly as if
// the event never happened. The emitter cache therefore always reflects
// operations the client actually received, not operations merely constructed
// during translation.
//
// The translation-correctness tests in tree_emitter_test.go (and friends) keep
// using the Translate wrapper (Prepare+Commit); they assert on returned ops and
// are unaffected by the protocol. These tests assert the PROTOCOL.

import (
	"encoding/json"
	"fmt"
	"reflect"
	"testing"
)

// --- internal helpers ---

// committedSnapshot captures the four committed cache fields for before/after
// comparison. Used to prove Prepare leaves committed state untouched.
type committedSnapshot struct {
	seq         uint64
	ec          map[string]bool
	parentCache map[string]string
	known       map[string]bool
}

func snapshotCommitted(e *TreeEmitter) committedSnapshot {
	return committedSnapshot{
		seq:         e.seq,
		ec:          cloneBoolMapState(e.ec),
		parentCache: cloneStringMapState(e.parentCache),
		known:       cloneBoolMapState(e.known),
	}
}

func cloneBoolMapState(m map[string]bool) map[string]bool {
	out := make(map[string]bool, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func cloneStringMapState(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

func (a committedSnapshot) equal(b committedSnapshot) bool {
	return a.seq == b.seq &&
		reflect.DeepEqual(a.ec, b.ec) &&
		reflect.DeepEqual(a.parentCache, b.parentCache) &&
		reflect.DeepEqual(a.known, b.known)
}

// marshalFailOp is a TreeOp that fails to marshal. It lives here (internal) so
// the marshal-failure branch of the delivery boundary can be exercised: an
// unexported-method interface (TreeOp.assignSeq/setDir/setSessionHint) can only
// be satisfied by a type in package state. Embedding baseOp provides those.
type marshalFailOp struct {
	baseOp
}

func (marshalFailOp) Op() string { return "node.bogus" }
func (marshalFailOp) MarshalJSON() ([]byte, error) {
	return nil, fmt.Errorf("synthetic marshal failure")
}

// mkLoadedParentEmitter builds an emitter whose frontier has R on the active
// path (so R ∈ E_c and R/child-of-R are known). Used to get a connection state
// where a new child create produces real ops (child upsert + parent count
// facet) rather than a suppressed count-only path.
func mkLoadedParentEmitter(t *testing.T) (*TreeEmitter, *Store) {
	t.Helper()
	s := New(64)
	applySeq(t, s,
		[2]string{"session.created", evSessionCreated("R", "")},
		[2]string{"session.created", evSessionCreated("A", "R")},
		[2]string{"session.status", evStatus("A", "busy")},
	)
	e := NewTreeEmitter(s, "/proj")
	_ = e.SnapshotFrontier("cold") // R ∈ E_c, R/A known
	return e, s
}

// ---------------------------------------------------------------------------
// Slice 6 — Prepare isolation + Commit
// ---------------------------------------------------------------------------

// TestPrepare_LeavesCommittedUnchanged asserts Prepare does not mutate any of
// the four committed fields, regardless of how many ops the event produces.
// This is the crux of the fix: the committed cache only advances via Commit.
func TestPrepare_LeavesCommittedUnchanged(t *testing.T) {
	e, s := mkLoadedParentEmitter(t)
	before := snapshotCommitted(e)

	// Create C under loaded R → real child upsert + parent count facet.
	applySeq(t, s, [2]string{"session.created", evSessionCreated("C", "R")})
	ev := lastEventOfKind(t, s, KindSessionUpsert)

	prepared, err := e.Prepare(ev)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if len(prepared.Ops) == 0 {
		t.Fatalf("fixture: expected ops for child create under loaded R")
	}

	after := snapshotCommitted(e)
	if !before.equal(after) {
		t.Errorf("Prepare mutated committed state:\n before=%+v\n after =%+v", before, after)
	}
	// And the prepared object carries the PROPOSED state (distinct from
	// committed): known now includes C.
	if !prepared.Next.known["C"] {
		t.Errorf("prepared Next.known should include C; got %v", prepared.Next.known)
	}
	if prepared.Next.known["C"] == e.known["C"] {
		t.Errorf("prepared Next.known[C] should differ from committed (still false); committed known=%v", e.known)
	}
}

// TestPrepare_EmptyOpsLeavesCommittedUnchanged covers the filtered case (an
// event that produces zero ops). Prepare must still be a committed-state no-op.
func TestPrepare_EmptyOpsLeavesCommittedUnchanged(t *testing.T) {
	e, _ := mkLoadedParentEmitter(t)
	before := snapshotCommitted(e)

	// An activity event for a session NOT in the store and NOT known to this
	// connection: onActivityLocked's !known branch returns nil (not active →
	// no promotion). Deterministic zero-op path via a directly-built event.
	ev := ClientEvent{
		Seq:     999,
		Kind:    KindActivity,
		Payload: json.RawMessage(`{"sessionID":"NEVERKNOWN","state":"busy"}`),
	}
	prepared, err := e.Prepare(ev)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if len(prepared.Ops) != 0 {
		t.Fatalf("expected zero ops for idle unknown node, got %d (%v)", len(prepared.Ops), opKinds(prepared.Ops))
	}
	after := snapshotCommitted(e)
	if !before.equal(after) {
		t.Errorf("Prepare (empty ops) mutated committed state:\n before=%+v\n after =%+v", before, after)
	}
}

// TestCommit_AppliesPreparedState asserts Commit installs all four proposed
// fields into committed state.
func TestCommit_AppliesPreparedState(t *testing.T) {
	e, s := mkLoadedParentEmitter(t)
	before := snapshotCommitted(e)

	applySeq(t, s, [2]string{"session.created", evSessionCreated("C", "R")})
	ev := lastEventOfKind(t, s, KindSessionUpsert)
	prepared, _ := e.Prepare(ev)

	e.Commit(prepared)

	// Committed now reflects the proposed state: known includes C, seq advanced.
	if !e.known["C"] {
		t.Errorf("after Commit, committed known should include C; got %v", e.known)
	}
	if e.seq != prepared.Next.seq {
		t.Errorf("after Commit, committed seq=%d want %d", e.seq, prepared.Next.seq)
	}
	if e.seq == before.seq {
		t.Errorf("after Commit, committed seq should have advanced from %d", before.seq)
	}
}

// TestCommit_Idempotent asserts calling Commit twice is harmless.
func TestCommit_Idempotent(t *testing.T) {
	e, s := mkLoadedParentEmitter(t)
	applySeq(t, s, [2]string{"session.created", evSessionCreated("C", "R")})
	ev := lastEventOfKind(t, s, KindSessionUpsert)
	prepared, _ := e.Prepare(ev)

	e.Commit(prepared)
	after1 := snapshotCommitted(e)
	e.Commit(prepared) // harmless re-install
	after2 := snapshotCommitted(e)
	if !after1.equal(after2) {
		t.Errorf("second Commit changed committed state:\n 1=%+v\n 2=%+v", after1, after2)
	}
}

// TestCommit_NilSafe asserts Commit(nil) is a no-op.
func TestCommit_NilSafe(t *testing.T) {
	e, _ := mkLoadedParentEmitter(t)
	before := snapshotCommitted(e)
	e.Commit(nil) // must not panic, must not change state
	after := snapshotCommitted(e)
	if !before.equal(after) {
		t.Errorf("Commit(nil) changed state:\n before=%+v\n after =%+v", before, after)
	}
}

// ---------------------------------------------------------------------------
// Slice 6 — double-stamp elimination (stamp exactly once)
// ---------------------------------------------------------------------------

// TestPrepare_StampExactlyOnce asserts each op consumes exactly ONE seq value
// (the former Translate re-stamped every op a second time in a final loop,
// doubling seq consumption). For an event producing N ops the committed seq
// must advance by exactly N, and the op seqs must be a dense run.
func TestPrepare_StampExactlyOnce(t *testing.T) {
	e, s := mkLoadedParentEmitter(t)
	seqBefore := e.seq

	applySeq(t, s, [2]string{"session.created", evSessionCreated("C", "R")})
	ev := lastEventOfKind(t, s, KindSessionUpsert)
	prepared, _ := e.Prepare(ev)
	e.Commit(prepared)

	n := len(prepared.Ops)
	if n < 2 {
		t.Fatalf("fixture: need >=2 ops (child upsert + parent count facet), got %d", n)
	}
	// Committed seq advanced by exactly n (one stamp per op). The old
	// double-stamp would have advanced it by 2*n.
	if got := e.seq - seqBefore; got != uint64(n) {
		t.Errorf("seq advanced by %d, want exactly %d (one stamp per op; old double-stamp was 2x)", got, n)
	}
	// Op seqs are a dense run [seqBefore+1 .. seqBefore+n] with no gaps/dupes.
	seen := map[uint64]bool{}
	for _, op := range prepared.Ops {
		sq := op.Seq()
		if sq == 0 {
			t.Errorf("op %q has zero seq (un-stamped)", op.Op())
		}
		if seen[sq] {
			t.Errorf("duplicate op seq %d (double-stamp residue)", sq)
		}
		seen[sq] = true
	}
	for i := 1; i <= n; i++ {
		want := seqBefore + uint64(i)
		if !seen[want] {
			t.Errorf("missing op seq %d in dense run (seen=%v)", want, seen)
		}
	}
}

// ---------------------------------------------------------------------------
// Slice 6 — failed delivery does not poison the cache
// ---------------------------------------------------------------------------

// TestPrepare_FailedDeliveryReproducible asserts that if Commit is NEVER called
// (delivery failed), the committed cache is unchanged and a fresh Prepare of
// the SAME event reproduces the same ops — i.e. the event can be re-delivered.
// This is the actual fix for "a dropped operation can poison the cache."
func TestPrepare_FailedDeliveryReproducible(t *testing.T) {
	e, s := mkLoadedParentEmitter(t)

	applySeq(t, s, [2]string{"session.created", evSessionCreated("C", "R")})
	ev := lastEventOfKind(t, s, KindSessionUpsert)

	prepared1, _ := e.Prepare(ev)
	// Simulate a FAILED delivery: discard prepared1, do NOT commit.
	_ = prepared1

	// Committed state is untouched → re-preparing the same event reproduces
	// equivalent ops (same count, same kinds, same node targets).
	prepared2, _ := e.Prepare(ev)
	if len(prepared2.Ops) != len(prepared1.Ops) {
		t.Errorf("re-prepare op count drifted: %d vs %d (committed was poisoned?)",
			len(prepared2.Ops), len(prepared1.Ops))
	}
	if !opKindsEq(prepared1.Ops, prepared2.Ops) {
		t.Errorf("re-prepare op kinds differ:\n 1=%v\n 2=%v", opKinds(prepared1.Ops), opKinds(prepared2.Ops))
	}
}

// ---------------------------------------------------------------------------
// Slice 6 — retry equivalence
// ---------------------------------------------------------------------------

// TestPrepare_RetryEquivalence asserts two Prepares from the SAME committed
// state produce equivalent ops + proposed next state (deterministic
// translation; only seq is advanced on Commit).
func TestPrepare_RetryEquivalence(t *testing.T) {
	e, s := mkLoadedParentEmitter(t)

	applySeq(t, s, [2]string{"session.created", evSessionCreated("C", "R")})
	ev := lastEventOfKind(t, s, KindSessionUpsert)

	p1, _ := e.Prepare(ev)
	p2, _ := e.Prepare(ev)

	if len(p1.Ops) != len(p2.Ops) {
		t.Fatalf("op count differs across prepares: %d vs %d", len(p1.Ops), len(p2.Ops))
	}
	// Proposed cache (known/ec/parentCache) must match — only the scalar seq
	// advances inside each Prepare's working clone (relative to the same
	// committed seq), so the proposed known sets are identical.
	if !reflect.DeepEqual(p1.Next.known, p2.Next.known) {
		t.Errorf("proposed known diverges:\n 1=%v\n 2=%v", p1.Next.known, p2.Next.known)
	}
	if !reflect.DeepEqual(p1.Next.ec, p2.Next.ec) {
		t.Errorf("proposed ec diverges:\n 1=%v\n 2=%v", p1.Next.ec, p2.Next.ec)
	}
	if !reflect.DeepEqual(p1.Next.parentCache, p2.Next.parentCache) {
		t.Errorf("proposed parentCache diverges:\n 1=%v\n 2=%v", p1.Next.parentCache, p2.Next.parentCache)
	}
}

// ---------------------------------------------------------------------------
// Slice 6 — marshal-failure boundary (op-level)
// ---------------------------------------------------------------------------

// TestPrepare_MarshalFailureIsRejectable proves the delivery boundary's
// marshal-failure branch is reachable: a TreeOp can fail to marshal, and when
// one does the boundary must return that error BEFORE any write/commit. Here we
// assert the op-level precondition (marshal fails); the pkg/web
// tree_delivery_test.go asserts the boundary returns the error and leaves the
// committed cache + wire untouched.
func TestPrepare_MarshalFailureIsRejectable(t *testing.T) {
	var op TreeOp = &marshalFailOp{}
	if _, err := json.Marshal(op); err == nil {
		t.Fatalf("marshalFailOp must fail to marshal (boundary marshal branch is dead otherwise)")
	}
	// A PreparedTranslation carrying such an op is exactly what the boundary
	// receives; the boundary marshals each op before any write, so this op
	// short-circuits the buffer with an error and no Commit is reached.
	prepared := &PreparedTranslation{
		Ops:      []TreeOp{op},
		EventSeq: 42,
	}
	if _, err := json.Marshal(prepared.Ops[0]); err == nil {
		t.Fatalf("prepared op must still fail to marshal at delivery time")
	}
}

// ---------------------------------------------------------------------------
// Slice 6 — replay/live parity (unit level)
// ---------------------------------------------------------------------------

// TestPrepare_ReplayLiveParity asserts the replay and live paths share one
// translation entrypoint (Prepare), so a store event produces the same ops
// regardless of which delivery path feeds it. Both pkg/web paths call
// Prepare + deliverTreeOps, so parity holds by construction; this test pins it
// at the emitter level.
func TestPrepare_ReplayLiveParity(t *testing.T) {
	e, s := mkLoadedParentEmitter(t)

	applySeq(t, s, [2]string{"session.created", evSessionCreated("C", "R")})
	ev := lastEventOfKind(t, s, KindSessionUpsert)

	// "Replay" prepare (committed at frontier baseline).
	pReplay, _ := e.Prepare(ev)
	e.Commit(pReplay)

	// "Live" prepare of the NEXT equivalent event on a fresh emitter with the
	// same starting state must match. Rebuild the same starting state.
	e2, s2 := mkLoadedParentEmitter(t)
	applySeq(t, s2, [2]string{"session.created", evSessionCreated("C", "R")})
	ev2 := lastEventOfKind(t, s2, KindSessionUpsert)
	pLive, _ := e2.Prepare(ev2)

	if !opKindsEq(pReplay.Ops, pLive.Ops) {
		t.Errorf("replay/live op kinds differ:\n replay=%v\n live  =%v",
			opKinds(pReplay.Ops), opKinds(pLive.Ops))
	}
	if !reflect.DeepEqual(pReplay.Next.known, pLive.Next.known) {
		t.Errorf("replay/live proposed known differ:\n replay=%v\n live  =%v",
			pReplay.Next.known, pLive.Next.known)
	}
}

// --- helpers ---

func opKindsEq(a, b []TreeOp) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Op() != b[i].Op() {
			return false
		}
	}
	return true
}
