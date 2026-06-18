package state

import (
	"encoding/json"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

func ev(t, props string) opencode.Event {
	return opencode.Event{Type: t, Properties: json.RawMessage(props)}
}

func TestReducerBuildsTreeAndMessages(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a","title":"root"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"b","parentID":"a","title":"child"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"user"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"hi"}}`))

	snap := s.Snapshot(nil)
	if len(snap.Sessions) != 2 {
		t.Fatalf("want 2 sessions, got %d", len(snap.Sessions))
	}
	msgs := snap.Messages["a"]
	if len(msgs) != 1 {
		t.Fatalf("want 1 message in session a, got %d", len(msgs))
	}
	if len(msgs[0].Parts) != 1 {
		t.Fatalf("want 1 part, got %d", len(msgs[0].Parts))
	}

	// Child parent linkage is preserved in the raw session payload.
	var foundChild bool
	for _, raw := range snap.Sessions {
		var e sessionEnvelope
		_ = json.Unmarshal(raw, &e)
		if e.ID == "b" && e.ParentID == "a" {
			foundChild = true
		}
	}
	if !foundChild {
		t.Fatal("child session b with parentID a not found")
	}
}

func TestReducerDeleteSession(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a","title":"root"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a"}}`))
	s.Apply(ev("session.deleted", `{"info":{"id":"a"}}`))

	snap := s.Snapshot(nil)
	if len(snap.Sessions) != 0 {
		t.Fatalf("want 0 sessions after delete, got %d", len(snap.Sessions))
	}
	if _, ok := snap.Messages["a"]; ok {
		t.Fatal("messages for deleted session should be cleared")
	}
}

func TestSnapshotMessageScoping(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"b"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"ma","sessionID":"a"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"mb","sessionID":"b"}}`))

	// Tree-only (empty, non-nil filter): no messages.
	if got := s.Snapshot(map[string]bool{}); len(got.Messages) != 0 {
		t.Fatalf("tree-only snapshot should have no messages, got %d", len(got.Messages))
	}
	// Scoped to "a": only a's messages.
	scoped := s.Snapshot(map[string]bool{"a": true})
	if _, ok := scoped.Messages["a"]; !ok {
		t.Fatal("scoped snapshot missing session a messages")
	}
	if _, ok := scoped.Messages["b"]; ok {
		t.Fatal("scoped snapshot should not include session b messages")
	}
}

func TestPartStreamingUpsertInPlace(t *testing.T) {
	s := New(100)
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"a","messageID":"m1","text":"he"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"a","messageID":"m1","text":"hello"}}`))

	snap := s.Snapshot(nil)
	parts := snap.Messages["a"][0].Parts
	if len(parts) != 1 {
		t.Fatalf("streaming should update part in place, got %d parts", len(parts))
	}
	var p struct{ Text string }
	_ = json.Unmarshal(parts[0], &p)
	if p.Text != "hello" {
		t.Fatalf("want latest text 'hello', got %q", p.Text)
	}
}

func TestActivityDerivation(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	s.Apply(ev("session.status", `{"sessionID":"a","status":{"type":"busy"}}`))
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityBusy {
		t.Fatalf("want busy, got %q", got)
	}
	s.Apply(ev("session.idle", `{"sessionID":"a"}`))
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityIdle {
		t.Fatalf("want idle, got %q", got)
	}
	s.Apply(ev("session.error", `{"sessionID":"a"}`))
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityError {
		t.Fatalf("want error, got %q", got)
	}
}

func TestActivityReconcileClearsTerminatedSession(t *testing.T) {
	s := New(100)
	// A session mid-generation: an incomplete assistant turn, marked busy.
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","time":{"created":1}}}`))
	s.Apply(ev("session.status", `{"sessionID":"a","status":{"type":"busy"}}`))
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityBusy {
		t.Fatalf("precondition: want busy, got %q", got)
	}
	// On re-hydrate, /session/status no longer reports it busy (the turn was
	// terminated while generating). The reconcile must clear it to idle so the
	// UI stops spinning — even though its last message is still incomplete.
	s.SetActivityFromStatuses(map[string]json.RawMessage{})
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityIdle {
		t.Fatalf("want idle after reconcile, got %q", got)
	}
}

func TestActivityFromMessageStream(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a"}}`))
	// No session.status event at all — busy is derived from the live message
	// stream (OpenCode's status can lag a streaming turn). An incomplete
	// assistant message means the turn is generating.
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","time":{"created":1}}}`))
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityBusy {
		t.Fatalf("incomplete assistant should be busy, got %q", got)
	}
	// Streaming deltas keep it busy.
	s.Apply(ev("message.part.delta", `{"sessionID":"a","messageID":"m1","partID":"p1","field":"text","delta":"hi"}`))
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityBusy {
		t.Fatalf("streaming delta should stay busy, got %q", got)
	}
	// Completing a single assistant message does NOT idle the session: a
	// multi-step turn (text → tool → text) completes one assistant message
	// before the next step starts, and inferring idle from that gap fired a
	// spurious "finished" notification per step. Idle is owned by session.idle.
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant","time":{"created":1,"completed":2}}}`))
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityBusy {
		t.Fatalf("completed assistant alone should stay busy (idle owned by session.idle), got %q", got)
	}
	// The authoritative session.idle settles it.
	s.Apply(ev("session.idle", `{"sessionID":"a"}`))
	if got := s.Snapshot(nil).Activity["a"]; got != ActivityIdle {
		t.Fatalf("session.idle should settle to idle, got %q", got)
	}
}

func partText(snap Snapshot, sid, partID string) string {
	for _, mw := range snap.Messages[sid] {
		for _, raw := range mw.Parts {
			var p struct {
				ID, Text string
			}
			if json.Unmarshal(raw, &p) == nil && p.ID == partID {
				return p.Text
			}
		}
	}
	return ""
}

func TestPartDeltaAccumulatesStreaming(t *testing.T) {
	s := New(100)
	s.Apply(ev("message.updated", `{"info":{"id":"m1","sessionID":"a","role":"assistant"}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":""}}`))
	s.Apply(ev("message.part.delta", `{"sessionID":"a","messageID":"m1","partID":"p1","field":"text","delta":"Hel"}`))
	s.Apply(ev("message.part.delta", `{"sessionID":"a","messageID":"m1","partID":"p1","field":"text","delta":"lo"}`))
	if got := partText(s.Snapshot(map[string]bool{"a": true}), "a", "p1"); got != "Hello" {
		t.Fatalf("want accumulated 'Hello', got %q", got)
	}
	// A later full snapshot overwrites authoritatively.
	s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"a","messageID":"m1","type":"text","text":"Hello, world"}}`))
	if got := partText(s.Snapshot(map[string]bool{"a": true}), "a", "p1"); got != "Hello, world" {
		t.Fatalf("want 'Hello, world' after snapshot, got %q", got)
	}
}

func TestPartDeltaBeforePartCreatesIt(t *testing.T) {
	s := New(100)
	// Delta can arrive before the part.updated that creates the part.
	s.Apply(ev("message.part.delta", `{"sessionID":"a","messageID":"m1","partID":"p1","field":"text","delta":"hi"}`))
	if got := partText(s.Snapshot(map[string]bool{"a": true}), "a", "p1"); got != "hi" {
		t.Fatalf("want 'hi' from delta-created part, got %q", got)
	}
}

func TestPermissionAskedSurfacesAndRepliedClears(t *testing.T) {
	s := New(100)
	// OpenCode emits "permission.asked" (the Request) — not "permission.updated".
	s.Apply(ev("permission.asked", `{"id":"per_1","sessionID":"a","permission":"bash","title":"run x"}`))
	if got := s.Snapshot(nil).Permissions["a"]; len(got) != 1 {
		t.Fatalf("want 1 pending permission after permission.asked, got %d", len(got))
	}
	// And clears with {sessionID, requestID} (not permissionID).
	s.Apply(ev("permission.replied", `{"sessionID":"a","requestID":"per_1","reply":"once"}`))
	if got := s.Snapshot(nil).Permissions["a"]; len(got) != 0 {
		t.Fatalf("want permission cleared after reply, got %d", len(got))
	}
}

func TestSetActivityFromStatuses(t *testing.T) {
	s := New(100)
	ch, unsub := s.Subscribe(8)
	defer unsub()
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		"a": json.RawMessage(`{"type":"busy"}`),
		"b": json.RawMessage(`{"type":"idle"}`),
	})
	snap := s.Snapshot(nil)
	if snap.Activity["a"] != ActivityBusy || snap.Activity["b"] != ActivityIdle {
		t.Fatalf("seed failed: %+v", snap.Activity)
	}
	// at least one activity event emitted
	select {
	case e := <-ch:
		if e.Kind != KindActivity {
			t.Fatalf("want activity event, got %s", e.Kind)
		}
	default:
		t.Fatal("expected an activity event")
	}
}

func TestHydrateDiffEmitsOnlyChanges(t *testing.T) {
	s := New(100)
	s.Apply(ev("session.created", `{"info":{"id":"a","title":"v1"}}`))
	before := s.Snapshot(nil).Seq

	// Re-hydrate with a changed title for a, a new session b, and a gone (omitted).
	s.Hydrate(
		[]json.RawMessage{
			json.RawMessage(`{"id":"a","title":"v2"}`),
			json.RawMessage(`{"id":"b","title":"new"}`),
		},
		map[string][]MessageWithParts{},
	)
	after := s.Snapshot(nil).Seq
	// Expect exactly 2 emits: upsert(a changed) + upsert(b new). No delete.
	if after-before != 2 {
		t.Fatalf("want 2 client events from hydrate, got %d", after-before)
	}

	// Hydrating identical state emits nothing.
	stable := s.Snapshot(nil).Seq
	s.Hydrate(
		[]json.RawMessage{
			json.RawMessage(`{"id":"a","title":"v2"}`),
			json.RawMessage(`{"id":"b","title":"new"}`),
		},
		map[string][]MessageWithParts{},
	)
	if s.Snapshot(nil).Seq != stable {
		t.Fatalf("idempotent hydrate should emit nothing, seq moved from %d to %d", stable, s.Snapshot(nil).Seq)
	}
}
