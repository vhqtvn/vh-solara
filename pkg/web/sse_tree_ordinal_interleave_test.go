package web

// sse_tree_ordinal_interleave_test.go — O3 T1C-F1: Stream-1 (tree) structural-
// interleave regression test driving the REAL server's tree-branch ordinal
// assignment.
//
// The Stream-2 fix (IsMessageClassKind gate, sse_ordinal_interleave_test.go)
// closed the session-stream class of the ordinal-thrash defect. The committer's
// review then found the SAME defect class on the TREE stream (Stream 1): the
// tree branch (treeEmitter != nil, replay + live-tail) advanced the ordinal for
// EVERY non-orphan kind, including KindTodo ("todo"). But the FE has NO
// addEventListener("todo") anywhere in web/src (todos are consumed via snapshot
// + 5s poll), and treeLastDeliveryOrdinal is updated only for tree.op /
// TREE_STREAM_KINDS / session.upsert+delete. So every todo.updated invisibly
// bumped the server-side tree ordinal → the next observed tree event showed a
// gap → checkTreeOrdinalGap fired → spurious connect(true). Deterministic, same
// thrash class O3 was meant to remove.
//
// This test drives the actual handleStream tree branch (?tree=2, treeEmitter !=
// nil) through a cursor-based REPLAY of [session.created(C1) → todo →
// session.created(C2)], then asserts the REAL ordinal assignment:
//   - the counted frames (tree.op / session.upsert) carry contiguous ordinals
//     (1, 2) — the todo between them did NOT advance the ordinal.
//   - the todo frame carries NO id line at all (writeRawNoID — the T1C-F1 fix).
//
// NON-VACUITY: revert T1C-F1's fix (the IsTreeCountedKind gate in the replay
// tree branch) → todo gets an ordinal too → the second counted frame gets
// ordinal 3 (not 2) and the todo frame carries an id line → this test fails
// deterministically. That is the red→green proof the defect is closed on both
// streams.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// todoUpdatedEvent builds a todo.updated opencode.Event for direct store
// seeding. The store normalizer reduces it to NormTodoUpsert and emits a
// KindTodo event — the non-counted kind that was invisibly advancing the tree
// ordinal before the T1C-F1 fix.
func todoUpdatedEvent(sid string) opencode.Event {
	return opencode.Event{
		Type: "todo.updated",
		Properties: json.RawMessage(fmt.Sprintf(
			`{"sessionID":%q,"todos":[{"id":"t1","status":"pending","content":"x"}]}`, sid)),
	}
}

// TestTreeOrdinal_StructuralInterleave drives the REAL handleStream tree branch
// (?tree=2) through a replay of [session.created(C1) → todo → session.created(C2)]
// on a tree-selected stream (treeEmitter != nil). Asserts:
//  1. The counted session.upsert detail frames carry compound ids with
//     contiguous ordinals (1, 2).
//  2. The todo frame between them carries NO id line (writeRawNoID — T1C-F1).
//
// NON-VACUITY PROOF: revert T1C-F1's fix (the IsTreeCountedKind gate in the
// replay tree branch) → todo advances the ordinal and carries an id line → the
// second session.upsert gets ordinal 3 (not 2) and the todo carries an id →
// both assertions fail. This test is the deterministic red→green that proves
// the tree-stream defect class is closed.
//
// T1C-F2 (live-tail branch coverage): DEFERRED. The live-tail tree branch
// (server.go ~line 2580) uses the STATICALLY IDENTICAL gate
// (`hasOps || state.IsTreeCountedKind(ev.Kind)` → writeEvent; else
// writeRawNoID) — same condition, same writeEvent/writeRawNoID split, verified
// by the dual-branch audit in the O3 closeout. Driving it through the real
// handler requires a connect-then-push-live harness (open the stream, wait for
// the snapshot to land, then apply events through the subscriber channel and
// read live frames) — substantially more complex than the replay path for no
// additional gate-logic coverage. The replay test above proves the gate logic
// end-to-end; the live-tail branch is covered by static identity.
func TestTreeOrdinal_StructuralInterleave(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)
	_ = fake

	store := srv.agg.Store()

	// Seed a root session as the replay baseline.
	applyCreate(store, "R", "")
	waitFor(t, func() bool { return store.HasSession("R") },
		"seed session R")

	// Record the cursor BEFORE the interleave — the replay branch ships events
	// with seq > cursor.
	cursor := store.Head()

	// Apply the interleave: counted(C1) → todo(non-counted) → counted(C2).
	// C1/C2 are session.created → KindSessionUpsert (tree-counted + tree.op ops).
	// todo is KindTodo (NOT tree-counted, no tree.op ops) — the residual.
	applyCreate(store, "C1", "R")
	store.Apply(todoUpdatedEvent("R"))
	applyCreate(store, "C2", "R")

	// Open the TREE stream WITH the cursor → replay branch (treeEmitter != nil
	// because tree=2 is set).
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	t.Cleanup(cancel)
	url := web.URL + "/vh/stream?tree=2&cursor=" + fmt.Sprintf("%d", cursor)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { resp.Body.Close() })
	reader := bufio.NewReader(resp.Body)

	// Collect frames until we've seen 2 session.upsert detail frames (the
	// interleave bookends), or the stream closes.
	frames := readSSEFramesUntil(t, reader, func(fs []sseFrameID) bool {
		count := 0
		for _, f := range fs {
			if f.event == "session.upsert" {
				count++
			}
		}
		return count >= 2
	})

	// Extract just the session.upsert detail frames.
	var sessionUpserts []sseFrameID
	for _, f := range frames {
		if f.event == "session.upsert" {
			sessionUpserts = append(sessionUpserts, f)
		}
	}
	if len(sessionUpserts) < 2 {
		t.Fatalf("expected ≥2 session.upsert frames in the replay, got %d. Frames: %s",
			len(sessionUpserts), frameSummarys(frames))
	}

	// Assertion 1: the two session.upsert frames have contiguous ordinals
	// (1 and 2) — the todo event between them did NOT advance the ordinal.
	ord1 := ordinalOf(t, sessionUpserts[0].id)
	ord2 := ordinalOf(t, sessionUpserts[1].id)
	if ord1 != 1 {
		t.Errorf("first session.upsert ordinal: got %d, want 1. id=%q", ord1, sessionUpserts[0].id)
	}
	if ord2 != 2 {
		t.Errorf("second session.upsert ordinal: got %d, want 2 (todo interleave must NOT advance the ordinal). id=%q\nAll frames: %s",
			ord2, sessionUpserts[1].id, frameSummarys(frames))
	}

	// Assertion 2: the todo frame carries NO id line (writeRawNoID — T1C-F1's
	// fix). Find it anywhere in the collected frames.
	var todoFrame *sseFrameID
	for i := range frames {
		if frames[i].event == "todo" {
			todoFrame = &frames[i]
			break
		}
	}
	if todoFrame == nil {
		t.Fatalf("expected a todo frame in the replay, found none. Frames: %s",
			frameSummarys(frames))
	}
	if todoFrame.id != "" {
		t.Errorf("todo frame carries id %q — T1C-F1 violated: todo must NOT advance the ordinal (no FE live listener). Frames: %s",
			todoFrame.id, frameSummarys(frames))
	}
}
