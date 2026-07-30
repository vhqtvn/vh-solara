package web

// tree_delivery_test.go — L-14/M5 checked delivery boundary tests for
// deliverTreeOps (the pkg/web side of the Prepare/Commit protocol).
//
// These exercise deliverTreeOps in isolation with controllable io.Writers:
//   - success: all tree.op frames for one event are buffered into ONE Write
//     and Commit is reached (the committed cache advances);
//   - write error / short write: the error is returned and Commit is NOT
//     reached (committed cache unchanged);
//   - empty ops: no Write, no error.
//
// The marshal-failure branch is exercised BOTH at the op level (pkg/state/
// tree_emitter_prepare_test.go: TestPrepare_MarshalFailureIsRejectable, which
// pins the precondition that a TreeOp CAN fail to marshal) AND at the
// deliverTreeOps boundary below (TestDeliver_MarshalFailure_NoWriteNoCommit).
// A new faulty op type cannot be defined in package web — TreeOp's unexported
// methods (assignSeq/setDir/setSessionHint) forbid it — but the EXPORTED op
// types are real TreeOps (via embedded baseOp), and NodeUpsert's Node.Verb.State
// (json.RawMessage) is the one field that fails to marshal when fed invalid
// bytes. That reaches the boundary branch from outside package state.
//
// The committed-cache invariant is proven BEHAVIORALLY here (no new test
// accessors): a subsequent delete produces node.remove for C IFF C was
// committed-known — i.e. IFF the prior create's delivery reached Commit. The
// state package proves all four committed fields rigorously.

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// --- test writers ---

// errWriter fails every Write with zero bytes accepted.
type errWriter struct{}

func (errWriter) Write(p []byte) (int, error) { return 0, errors.New("synthetic write failure") }

// shortWriter accepts exactly one byte per Write then reports success (n=1,
// err=nil), so a multi-byte buffer is a "short write."
type shortWriter struct{}

func (shortWriter) Write(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	return 1, nil
}

// countingWriter captures every Write's bytes and counts the number of Write
// calls (to prove deliverTreeOps buffers all frames into a single Write).
type countingWriter struct {
	buf    bytes.Buffer
	writes int
}

func (cw *countingWriter) Write(p []byte) (int, error) {
	cw.writes++
	return cw.buf.Write(p)
}

// --- fixtures ---

// mkDeliveryEmitter builds an emitter whose frontier has R on the active path
// (R ∈ E_c, R known) so a new child C under R ships a REAL child upsert plus a
// parent count facet (2 ops) — useful for the multi-op / buffering assertions.
func mkDeliveryEmitter(t *testing.T) (*state.TreeEmitter, *state.Store) {
	t.Helper()
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	applyCreate(store, "R", "")
	applyCreate(store, "A", "R")
	// Make A busy so the active path R→A is materialized by SnapshotFrontier
	// (R ∈ E_c, R/A known).
	store.SetActivityFromStatuses(map[string]json.RawMessage{
		"A": json.RawMessage(`{"type":"busy"}`),
	})
	e := state.NewTreeEmitter(store, "/proj")
	_ = e.SnapshotFrontier("cold")
	// srv is only needed to construct the aggregator; keep the reference so
	// go vet does not flag it and the intent (real Server wiring) is clear.
	_ = srv
	return e, store
}

// applyDelete removes id from the store (emits KindSessionDelete). The store's
// "session.deleted" reducer reads the id from a nested `info` object.
func applyDelete(store *state.Store, id string) {
	store.Apply(opencode.Event{
		Type:       "session.deleted",
		Properties: json.RawMessage(`{"info":{"id":"` + id + `"}}`),
	})
}

// lastStoreEvent returns the most recent ClientEvent of kind from the store ring.
func lastStoreEvent(t *testing.T, store *state.Store, kind string) state.ClientEvent {
	t.Helper()
	evs, _, _ := store.Replay(0)
	for i := len(evs) - 1; i >= 0; i-- {
		if evs[i].Kind == kind {
			return evs[i]
		}
	}
	t.Fatalf("no store event of kind %q in ring", kind)
	return state.ClientEvent{}
}

// hasRemoveOp reports whether ops contain a node.remove.
func hasRemoveOp(ops []state.TreeOp) bool {
	for _, op := range ops {
		if op.Op() == "node.remove" {
			return true
		}
	}
	return false
}

// marshalFailTreeOp constructs an EXPORTED TreeOp whose MarshalJSON fails. It is
// the only way to reach deliverTreeOps's marshal-failure branch from package
// web: TreeOp's unexported methods (assignSeq/setDir/setSessionHint) forbid
// defining a new faulty op type here, but the exported NodeUpsert is a real
// TreeOp (via its embedded baseOp). Its Node.Verb.State is a json.RawMessage,
// the one field that fails to marshal when fed invalid bytes — json.Marshal
// rejects the raw message at the compact step. (Verified: the op both satisfies
// state.TreeOp at compile time and returns a marshal error at run time.)
func marshalFailTreeOp(t *testing.T) state.TreeOp {
	t.Helper()
	op := state.NodeUpsertOp(state.Node{
		ID:   "marshal-fail",
		Verb: &state.VerbFacet{State: json.RawMessage("<<not-valid-json>>")},
	})
	// Compile-time: exported op satisfies TreeOp despite the unexported methods.
	var _ state.TreeOp = op
	// Runtime guard: the fixture must actually fail to marshal, or this test
	// silently stops covering the marshal branch.
	if _, err := json.Marshal(op); err == nil {
		t.Fatalf("marshalFailTreeOp: op must fail to marshal (marshal branch is dead otherwise)")
	}
	return op
}

// ---------------------------------------------------------------------------
// success path
// ---------------------------------------------------------------------------

// TestDeliver_Success_BuffersAndCommits asserts a successful delivery:
//   - all tree.op frames for the event are buffered into a SINGLE Write;
//   - the frames carry the store seq as the SSE id and the op kind on the wire;
//   - Commit is reached (a later delete of C emits node.remove, proving C became
//     committed-known).
func TestDeliver_Success_BuffersAndCommits(t *testing.T) {
	e, store := mkDeliveryEmitter(t)
	applyCreate(store, "C", "R")
	createEv := lastStoreEvent(t, store, state.KindSessionUpsert)

	prepared, err := e.Prepare(createEv)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if len(prepared.Ops) < 2 {
		t.Fatalf("fixture: want >=2 ops (C upsert + R count facet), got %d", len(prepared.Ops))
	}

	var cw countingWriter
	if err := deliverTreeOps(&cw, e, prepared); err != nil {
		t.Fatalf("deliverTreeOps success: %v", err)
	}
	// Buffering: exactly one Write for the whole event.
	if cw.writes != 1 {
		t.Errorf("want exactly 1 Write (buffered), got %d", cw.writes)
	}
	// Wire shape: each op is a tree.op frame carrying the store seq as the id.
	out := cw.buf.String()
	if got := strings.Count(out, "event: tree.op"); got != len(prepared.Ops) {
		t.Errorf("want %d tree.op frames on the wire, got %d", len(prepared.Ops), got)
	}
	wantID := strings.TrimSpace(ulongToStr(prepared.EventSeq))
	if !strings.Contains(out, "id: "+wantID+"\n") {
		t.Errorf("wire missing id line for store seq %s; frame head=%.80s", wantID, out)
	}
	// Commit reached: deleting C now emits node.remove (C is committed-known).
	applyDelete(store, "C")
	delEv := lastStoreEvent(t, store, state.KindSessionDelete)
	delPrepared, _ := e.Prepare(delEv)
	if !hasRemoveOp(delPrepared.Ops) {
		t.Errorf("after successful delivery, delete of C should emit node.remove; got %v", opKindsWeb(delPrepared.Ops))
	}
}

// TestDeliver_EmptyOps_NoWriteNoError asserts a prepared translation with zero
// ops is a clean no-op: no Write, no error, no commit needed.
func TestDeliver_EmptyOps_NoWriteNoError(t *testing.T) {
	e, _ := mkDeliveryEmitter(t)
	prepared := &state.PreparedTranslation{Ops: nil, EventSeq: 7}
	var cw countingWriter
	if err := deliverTreeOps(&cw, e, prepared); err != nil {
		t.Errorf("empty ops: want nil error, got %v", err)
	}
	if cw.writes != 0 {
		t.Errorf("empty ops: want 0 Writes, got %d", cw.writes)
	}
}

// TestDeliver_NilPrepared_NoError asserts a nil prepared object is a no-op.
func TestDeliver_NilPrepared_NoError(t *testing.T) {
	e, _ := mkDeliveryEmitter(t)
	var cw countingWriter
	if err := deliverTreeOps(&cw, e, nil); err != nil {
		t.Errorf("nil prepared: want nil error, got %v", err)
	}
	if cw.writes != 0 {
		t.Errorf("nil prepared: want 0 Writes, got %d", cw.writes)
	}
}

// ---------------------------------------------------------------------------
// failure paths — committed cache must NOT advance
// ---------------------------------------------------------------------------

// TestDeliver_WriteError_LeavesUncommitted asserts a write failure returns an
// error and does NOT reach Commit: a later delete of C emits NO node.remove
// (C never became committed-known). This is the crux of the fix — a dropped
// frame cannot poison the cache.
func TestDeliver_WriteError_LeavesUncommitted(t *testing.T) {
	e, store := mkDeliveryEmitter(t)
	applyCreate(store, "C", "R")
	createEv := lastStoreEvent(t, store, state.KindSessionUpsert)
	prepared, _ := e.Prepare(createEv)

	if err := deliverTreeOps(errWriter{}, e, prepared); err == nil {
		t.Fatalf("write-error delivery: want non-nil error, got nil")
	}
	// Commit NOT reached: deleting C emits no node.remove (C is not known).
	applyDelete(store, "C")
	delEv := lastStoreEvent(t, store, state.KindSessionDelete)
	delPrepared, _ := e.Prepare(delEv)
	if hasRemoveOp(delPrepared.Ops) {
		t.Errorf("write-error delivery must NOT commit: delete of C unexpectedly emitted node.remove; got %v", opKindsWeb(delPrepared.Ops))
	}
}

// TestDeliver_ShortWrite_LeavesUncommitted asserts a short write (n < len) is
// treated as a failure: error returned, no Commit.
func TestDeliver_ShortWrite_LeavesUncommitted(t *testing.T) {
	e, store := mkDeliveryEmitter(t)
	applyCreate(store, "C", "R")
	createEv := lastStoreEvent(t, store, state.KindSessionUpsert)
	prepared, _ := e.Prepare(createEv)

	err := deliverTreeOps(shortWriter{}, e, prepared)
	if err == nil {
		t.Fatalf("short-write delivery: want non-nil error, got nil")
	}
	if !strings.Contains(err.Error(), "short write") {
		t.Errorf("short-write error should mention 'short write', got %q", err.Error())
	}
	// Commit NOT reached: deleting C emits no node.remove.
	applyDelete(store, "C")
	delEv := lastStoreEvent(t, store, state.KindSessionDelete)
	delPrepared, _ := e.Prepare(delEv)
	if hasRemoveOp(delPrepared.Ops) {
		t.Errorf("short-write delivery must NOT commit: delete of C unexpectedly emitted node.remove; got %v", opKindsWeb(delPrepared.Ops))
	}
}

// TestDeliver_MarshalFailure_NoWriteNoCommit asserts the marshal-failure branch
// of deliverTreeOps: a prepared op that fails to json.Marshal must
//   - return a non-nil error (the documented "caller MUST abort the stream" signal);
//   - write ZERO bytes to the wire — ALL frames are marshaled into one buffer
//     BEFORE any write, so a marshal failure puts nothing on the wire even when
//     earlier ops in the same event marshaled fine;
//   - leave the committed emitter cache unchanged (Commit is never reached): a
//     later delete of C emits no node.remove (C never became committed-known).
//
// This complements the write-error / short-write tests: those fail at the Write
// step; this fails one step earlier (marshal), proving the all-or-nothing
// buffering holds when SOME ops marshal fine before a later one fails. The
// op-level precondition (a TreeOp can fail to marshal) is pinned in
// pkg/state/tree_emitter_prepare_test.go (TestPrepare_MarshalFailureIsRejectable).
func TestDeliver_MarshalFailure_NoWriteNoCommit(t *testing.T) {
	e, store := mkDeliveryEmitter(t)
	applyCreate(store, "C", "R")
	createEv := lastStoreEvent(t, store, state.KindSessionUpsert)
	prepared, err := e.Prepare(createEv)
	if err != nil {
		t.Fatalf("Prepare: %v", err)
	}
	if len(prepared.Ops) == 0 {
		t.Fatalf("fixture: expected ops for child create under loaded R")
	}
	// Append a marshal-failing op AFTER the real ops so the buffer is partially
	// built before the failure — proving the partial buffer is discarded and
	// nothing reaches the wire.
	prepared.Ops = append(prepared.Ops, marshalFailTreeOp(t))

	var cw countingWriter
	err = deliverTreeOps(&cw, e, prepared)
	if err == nil {
		t.Fatalf("marshal-failure delivery: want non-nil error, got nil")
	}
	if !strings.Contains(err.Error(), "marshal") {
		t.Errorf("error should mention marshal, got %q", err.Error())
	}
	// Wire untouched: zero Write calls AND zero bytes (the single checked Write
	// is gated behind the full marshal loop, so a marshal failure never writes).
	if cw.writes != 0 {
		t.Errorf("marshal failure: want 0 Write calls, got %d", cw.writes)
	}
	if cw.buf.Len() != 0 {
		t.Errorf("marshal failure: want 0 bytes on wire, got %d", cw.buf.Len())
	}
	// Commit NOT reached: deleting C emits no node.remove (C is not committed-known).
	applyDelete(store, "C")
	delEv := lastStoreEvent(t, store, state.KindSessionDelete)
	delPrepared, _ := e.Prepare(delEv)
	if hasRemoveOp(delPrepared.Ops) {
		t.Errorf("marshal failure must NOT commit: delete of C unexpectedly emitted node.remove; got %v", opKindsWeb(delPrepared.Ops))
	}
}

// TestDeliver_FailureIsRetriable asserts that after a failed delivery the SAME
// prepared object can be delivered again successfully (the committed cache was
// untouched, so the prepared state is still valid and the event is re-deliverable
// — the operational meaning of "no poison").
func TestDeliver_FailureIsRetriable(t *testing.T) {
	e, store := mkDeliveryEmitter(t)
	applyCreate(store, "C", "R")
	createEv := lastStoreEvent(t, store, state.KindSessionUpsert)
	prepared, _ := e.Prepare(createEv)

	// First attempt fails.
	if err := deliverTreeOps(errWriter{}, e, prepared); err == nil {
		t.Fatalf("first delivery: want error, got nil")
	}
	// Retry the SAME prepared object on a good writer → succeeds and commits.
	var cw countingWriter
	if err := deliverTreeOps(&cw, e, prepared); err != nil {
		t.Fatalf("retry delivery: want nil error, got %v", err)
	}
	if cw.writes != 1 {
		t.Errorf("retry: want 1 Write, got %d", cw.writes)
	}
	// Committed now: delete of C emits node.remove.
	applyDelete(store, "C")
	delEv := lastStoreEvent(t, store, state.KindSessionDelete)
	delPrepared, _ := e.Prepare(delEv)
	if !hasRemoveOp(delPrepared.Ops) {
		t.Errorf("after retry commit, delete of C should emit node.remove; got %v", opKindsWeb(delPrepared.Ops))
	}
}

// --- helpers ---

func opKindsWeb(ops []state.TreeOp) []string {
	out := make([]string, 0, len(ops))
	for _, op := range ops {
		out = append(out, op.Op())
	}
	return out
}

// ulongToStr avoids pulling strconv into this test file just for one format.
func ulongToStr(n uint64) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	return string(buf[i:])
}
