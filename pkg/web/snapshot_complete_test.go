package web

// snapshot_complete_test.go — Q5 commit C1: the truthful completion boundary.
//
// After commit B (capture consolidation), SnapshotWithTree derives BOTH the
// tree frontier and the detail snapshot under ONE store RLock, so both
// projections carry the SAME {epoch, seq}. This makes a TRUTHFUL completion
// signal possible: an explicit event emitted ONLY after both projections of a
// single authoritative capture have been written on the wire, stamped with
// that capture's {epoch, seq}. The FE stages on {epoch, revision} and marks
// authoritativeReady on receipt — the verifiable convergence boundary that
// resyncTree/reconcile needed.
//
// These tests pin the ACCEPTANCE GATE for commit C1: the completion signal is
// truthful (same {epoch, seq} as both projections, emitted after both).

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
	"time"
)

// eventIndex returns the index of the first event with the exact kind, or -1.
func eventIndex(events []sseEvent, kind string) int {
	for i, e := range events {
		if e.event == kind {
			return i
		}
	}
	return -1
}

// decodeComplete unmarshals a snapshot.complete SSE data payload.
func decodeComplete(t *testing.T, ev sseEvent) struct {
	Epoch       string   `json:"epoch"`
	Revision    uint64   `json:"revision"`
	Projections []string `json:"projections"`
} {
	t.Helper()
	var p struct {
		Epoch       string   `json:"epoch"`
		Revision    uint64   `json:"revision"`
		Projections []string `json:"projections"`
	}
	if err := json.Unmarshal([]byte(ev.data), &p); err != nil {
		t.Fatalf("snapshot.complete: unmarshal failed: %v; data=%.200s", err, ev.data)
	}
	return p
}

// TestSnapshotComplete_FreshConnectTruthfulBoundary asserts a fresh tree=2
// connect emits snapshot.complete AFTER both tree.snapshot and snapshot
// (detail), stamped with the SAME {epoch, seq} as both projections.
func TestSnapshotComplete_FreshConnectTruthfulBoundary(t *testing.T) {
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	applyCreate(store, "R", "")
	applyCreate(store, "C1", "R")

	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	resp, err := http.Get(web.URL + "/vh/stream?tree=2")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	ch := startSSEReader(t, resp.Body)
	initial := drainIdle(ch, 600*time.Millisecond)

	treeIdx := eventIndex(initial, "tree.snapshot")
	if treeIdx < 0 {
		t.Fatalf("missing tree.snapshot; events=%v", eventNames(initial))
	}
	detailIdx := eventIndex(initial, "snapshot")
	if detailIdx < 0 {
		t.Fatalf("missing legacy detail snapshot; events=%v", eventNames(initial))
	}
	completeIdx := eventIndex(initial, "snapshot.complete")
	if completeIdx < 0 {
		t.Fatalf("missing snapshot.complete (completion boundary); events=%v", eventNames(initial))
	}

	// ACCEPTANCE GATE: completion arrives AFTER both projections.
	if completeIdx < treeIdx {
		t.Errorf("snapshot.complete (idx %d) must arrive AFTER tree.snapshot (idx %d); events=%v", completeIdx, treeIdx, eventNames(initial))
	}
	if completeIdx < detailIdx {
		t.Errorf("snapshot.complete (idx %d) must arrive AFTER detail snapshot (idx %d); events=%v", completeIdx, detailIdx, eventNames(initial))
	}

	complete := initial[completeIdx]
	treeEv := initial[treeIdx]

	// ACCEPTANCE GATE: same {epoch, seq} as both projections.
	p := decodeComplete(t, complete)
	if p.Epoch != store.Epoch() {
		t.Errorf("completion epoch: got %q, want store epoch %q", p.Epoch, store.Epoch())
	}
	if p.Revision != store.Head() {
		t.Errorf("completion revision: got %d, want store head %d", p.Revision, store.Head())
	}
	// The completion's SSE id (the capture seq) must match tree.snapshot's id.
	if complete.id != treeEv.id {
		t.Errorf("completion SSE id %q != tree.snapshot SSE id %q (same capture seq)", complete.id, treeEv.id)
	}
	// Projections must name both.
	if !slices.Contains(p.Projections, "tree") || !slices.Contains(p.Projections, "detail") {
		t.Errorf("completion projections must include tree+detail; got %v", p.Projections)
	}
}

// TestSnapshotComplete_ReconnectEmitsBoundary asserts the RECONNECT capture
// path (valid cursor, treeEmitter != nil) ALSO emits snapshot.complete after
// both projections — the second SnapshotWithTree call site in handleStream.
func TestSnapshotComplete_ReconnectEmitsBoundary(t *testing.T) {
	srv, agg := treeReplayServer(t)
	store := agg.Store()
	applyCreate(store, "R", "")
	applyCreate(store, "C1", "R")

	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	// 1. Fresh connect: drain initial pair + capture the cursor.
	resp1, err := http.Get(web.URL + "/vh/stream?tree=2")
	if err != nil {
		t.Fatal(err)
	}
	ch1 := startSSEReader(t, resp1.Body)
	initial := drainIdle(ch1, 600*time.Millisecond)
	if !hasEvent(initial, "tree.snapshot") {
		t.Fatalf("fresh connect: missing tree.snapshot; events=%v", eventNames(initial))
	}
	cursor := lastEventIDOf(initial, "tree.snapshot")
	if cursor == "" {
		t.Fatalf("fresh connect: tree.snapshot has no SSE id; events=%v", eventNames(initial))
	}
	resp1.Body.Close()

	// 2. Reconnect with the captured cursor (valid → replay-OK reconnect path).
	resp2, err := http.Get(web.URL + "/vh/stream?tree=2&cursor=" + cursor)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	ch2 := startSSEReader(t, resp2.Body)
	resumed := drainIdle(ch2, 600*time.Millisecond)

	// Reconnect path emits tree.snapshot (frontier re-seed) + detail snapshot +
	// snapshot.complete.
	treeIdx := eventIndex(resumed, "tree.snapshot")
	if treeIdx < 0 {
		t.Fatalf("reconnect: missing tree.snapshot; events=%v", eventNames(resumed))
	}
	detailIdx := eventIndex(resumed, "snapshot")
	if detailIdx < 0 {
		t.Fatalf("reconnect: missing detail snapshot; events=%v", eventNames(resumed))
	}
	completeIdx := eventIndex(resumed, "snapshot.complete")
	if completeIdx < 0 {
		t.Fatalf("reconnect: missing snapshot.complete; events=%v", eventNames(resumed))
	}
	// ACCEPTANCE GATE: completion arrives AFTER both projections.
	if completeIdx < treeIdx {
		t.Errorf("reconnect: snapshot.complete (idx %d) must arrive AFTER tree.snapshot (idx %d)", completeIdx, treeIdx)
	}
	if completeIdx < detailIdx {
		t.Errorf("reconnect: snapshot.complete (idx %d) must arrive AFTER detail snapshot (idx %d)", completeIdx, detailIdx)
	}

	// Truthful {epoch, seq}: completion matches the store at reconnect time.
	complete := resumed[completeIdx]
	treeEv := resumed[treeIdx]
	p := decodeComplete(t, complete)
	if p.Epoch != store.Epoch() {
		t.Errorf("reconnect completion epoch: got %q, want %q", p.Epoch, store.Epoch())
	}
	if p.Revision != store.Head() {
		t.Errorf("reconnect completion revision: got %d, want store head %d", p.Revision, store.Head())
	}
	// The completion's SSE id (capture seq) must match tree.snapshot's id.
	if complete.id != treeEv.id {
		t.Errorf("reconnect completion SSE id %q != tree.snapshot SSE id %q (same capture seq)", complete.id, treeEv.id)
	}
}
