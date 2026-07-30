package state

import (
	"encoding/json"
	"fmt"
	"testing"
)

// countKind reads every buffered event off ch and counts those whose Kind
// matches. Used by the writer-path tests to assert emission counts without
// caring about unrelated co-emitted events (e.g. KindMessageUpsert riding
// alongside a recompute-driven KindLastAgentSet). (A slice-returning drainKind
// already exists in store_test.go; this int-returning variant avoids re-reading
// the whole slice when only the count matters.)
func countKind(ch <-chan ClientEvent, kind string) int {
	var n int
	for {
		select {
		case e := <-ch:
			if e.Kind == kind {
				n++
			}
		default:
			return n
		}
	}
}

// TestObservableWriteEmits is the M8/L-04 standing-check for the observable-
// mutation publication invariant: every real snapshot-visible mutation advances
// the observable sequence AND produces a replayable event, while an unchanged
// value or an unknown session is a total no-op (no event, no seq advance).
//
// Each row drives a single emit-only operation (SetLastAgents for the lastAgent
// chokepoint, MarkPermissionBlocked for the permBlocked hybrid) so the sequence
// delta is attributable solely to the mutation under test. For every real-change
// case it asserts BOTH event delivery AND sequence advancement.
func TestObservableWriteEmits(t *testing.T) {
	type row struct {
		name        string
		setup       func(s *Store) // runs before subscribe; its emits never reach the channel
		op          func(s *Store)
		wantKind    string // expected event kind; "" means no event
		wantSeq     int    // expected sequence delta from op
		wantPayload map[string]string
	}

	rows := []row{
		{
			name:        "lastAgent changes to non-empty",
			op:          func(s *Store) { s.SetLastAgents(map[string]string{"a": "build"}) },
			wantKind:    KindLastAgentSet,
			wantSeq:     1,
			wantPayload: map[string]string{"sessionID": "a", "agent": "build"},
		},
		{
			name:        "lastAgent changes to empty",
			setup:       func(s *Store) { s.SetLastAgents(map[string]string{"a": "build"}) },
			op:          func(s *Store) { s.SetLastAgents(map[string]string{"a": ""}) },
			wantKind:    KindLastAgentSet,
			wantSeq:     1,
			wantPayload: map[string]string{"sessionID": "a", "agent": ""},
		},
		{
			name:     "lastAgent unchanged",
			setup:    func(s *Store) { s.SetLastAgents(map[string]string{"a": "build"}) },
			op:       func(s *Store) { s.SetLastAgents(map[string]string{"a": "build"}) },
			wantKind: "",
			wantSeq:  0,
		},
		{
			name:     "lastAgent target unknown",
			op:       func(s *Store) { s.SetLastAgents(map[string]string{"ghost": "build"}) },
			wantKind: "",
			wantSeq:  0,
		},
		{
			name:        "permBlocked false to true",
			op:          func(s *Store) { s.MarkPermissionBlocked("a") },
			wantKind:    KindPermissionBlocked,
			wantSeq:     1,
			wantPayload: map[string]string{"sessionID": "a", "permissionWasBlocked": "true"},
		},
		{
			name:     "permBlocked true to true",
			setup:    func(s *Store) { s.MarkPermissionBlocked("a") },
			op:       func(s *Store) { s.MarkPermissionBlocked("a") },
			wantKind: "",
			wantSeq:  0,
		},
		{
			name:     "permBlocked target unknown",
			op:       func(s *Store) { s.MarkPermissionBlocked("ghost") },
			wantKind: "",
			wantSeq:  0,
		},
	}

	for _, r := range rows {
		t.Run(r.name, func(t *testing.T) {
			s := New(100)
			defer s.Close()
			s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
			if r.setup != nil {
				r.setup(s)
			}
			ch, unsub := s.Subscribe(64)
			defer unsub()
			before := s.Snapshot(nil).Seq

			r.op(s)

			after := s.Snapshot(nil).Seq
			if d := int(after - before); d != r.wantSeq {
				t.Fatalf("seq delta = %d, want %d (before=%d after=%d)", d, r.wantSeq, before, after)
			}

			var got []ClientEvent
			for {
				select {
				case e := <-ch:
					got = append(got, e)
				default:
					goto drained
				}
			}
		drained:
			if r.wantKind == "" {
				if len(got) != 0 {
					t.Fatalf("want no event, got %d: %+v", len(got), got)
				}
				return
			}
			if len(got) != 1 {
				t.Fatalf("want 1 %s event, got %d events: %+v", r.wantKind, len(got), got)
			}
			if got[0].Kind != r.wantKind {
				t.Fatalf("event kind = %q, want %q", got[0].Kind, r.wantKind)
			}
			var m map[string]any
			if err := json.Unmarshal(got[0].Payload, &m); err != nil {
				t.Fatalf("unmarshal payload: %v", err)
			}
			for k, want := range r.wantPayload {
				if g, ok := m[k]; !ok || fmt.Sprintf("%v", g) != want {
					t.Fatalf("payload %q = %v, want %q (full=%+v)", k, g, want, m)
				}
			}
		})
	}
}

// TestUpsertPreservesLastAgentNoEmit guards L2 (upsertSessionLocked): an entry-
// replacing session.updated must PRESERVE the cold-seeded lastAgent and emit NO
// KindLastAgentSet. The preserve is a construction-time carry-over, not a
// mutation, so it is deliberately kept OUT of the setLastAgentLocked chokepoint
// (routing it through the helper would spuriously fire on the fresh zero-value
// entry). Confirms the observable-mutation no-op rule holds for the entry-replace
// path: preserve is silent.
func TestUpsertPreservesLastAgentNoEmit(t *testing.T) {
	s := New(100)
	defer s.Close()
	s.Apply(ev("session.created", `{"info":{"id":"a","title":"orig"}}`))
	s.SetLastAgents(map[string]string{"a": "build"}) // cold-seed before subscribe

	ch, unsub := s.Subscribe(64)
	defer unsub()
	// session.updated replaces the entry (upsertSessionLocked rebuilds
	// s.sessions["a"]); lastAgent must be carried over and emit nothing.
	s.Apply(ev("session.updated", `{"info":{"id":"a","title":"refreshed"}}`))

	if n := countKind(ch, KindLastAgentSet); n != 0 {
		t.Fatalf("entry-replace upsert must not emit KindLastAgentSet, got %d", n)
	}
	if got := s.Snapshot(nil).LastAgents["a"]; got != "build" {
		t.Fatalf("lastAgent not preserved across upsert: got %q, want build", got)
	}
}

// TestRecomputeLastAssistantRoutesThroughChokepoint guards L3+L4
// (recomputeLastAssistantLocked): the former reset-to-"" and set-from-newest-
// assistant writes are collapsed into a single computed finalAgent followed by
// one setLastAgentLocked call. The critical regression guard is the no-net-change
// case: a recompute whose result equals the current lastAgent must emit ZERO
// events. The naive routing of reset-then-set through an emit-on-change helper
// would have fired twice (reset to "" emits, set back to X emits) for a no-op
// recompute — a double-emit that violates the observable-mutation no-op rule.
func TestRecomputeLastAssistantRoutesThroughChokepoint(t *testing.T) {
	t.Run("real change emits one", func(t *testing.T) {
		s := New(100)
		defer s.Close()
		s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
		ch, unsub := s.Subscribe(64)
		defer unsub()
		// A new assistant message drives recompute: lastAgent "" -> "build".
		s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","agent":"build"}}`))
		if n := countKind(ch, KindLastAgentSet); n != 1 {
			t.Fatalf("recompute on real change: want 1 KindLastAgentSet, got %d", n)
		}
		if got := s.Snapshot(nil).LastAgents["a"]; got != "build" {
			t.Fatalf("lastAgent after recompute = %q, want build", got)
		}
	})

	t.Run("no net change emits none", func(t *testing.T) {
		s := New(100)
		defer s.Close()
		s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
		// Cold-seed lastAgent to the SAME value the recompute will derive, so the
		// net result is unchanged. Before the fix, recompute reset to "" (emit)
		// then set to "build" (emit) = two spurious events for a no-op recompute.
		s.SetLastAgents(map[string]string{"a": "build"})
		ch, unsub := s.Subscribe(64)
		defer unsub()
		s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","agent":"build"}}`))
		if n := countKind(ch, KindLastAgentSet); n != 0 {
			t.Fatalf("no-net-change recompute must emit 0 KindLastAgentSet, got %d (double-emit regression)", n)
		}
		if got := s.Snapshot(nil).LastAgents["a"]; got != "build" {
			t.Fatalf("lastAgent after no-op recompute = %q, want build", got)
		}
	})
}
