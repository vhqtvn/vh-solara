// warm_resync_omission_test.go — Option A contract pin (warm-resync absence
// must NOT delete).
//
// BUG this pins: on the daemon Run-loop event-stream reconnect, the daemon
// re-GETs /session/<id>/message; if that GET lags OpenCode's event stream and
// omits a LIVE message/part, reconcileMessagesLocked's warm absence-deletion
// loop used to emit KindMessageDelete / KindPartDelete for it → the client
// dropped the MessageView → a task-tool Part riding on it died. Reload restored
// the transcript because the store re-acquired the omitted message after the
// lag window (self-healing).
//
// FIX (Option A): absence from a fetched snapshot NEVER deletes a stored
// message or part. Deletions come ONLY from explicit message.removed /
// message.part.removed / session.deleted events. These tests pin that contract
// at the public store seam (SetSessionMessages is the warm-resync entry point:
// the first call is a cold load that flips msgLoaded=true, the second call is
// the warm reconcile that a reconnect triggers).
//
// Deterministic by construction: state/events and controlled snapshots are
// injected directly. No sleeps, timers, or eventual assertions.
package integration

import (
	"encoding/json"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// warmEv builds an opencode.Event for the given type + raw JSON properties.
func warmEv(typ, props string) opencode.Event {
	return opencode.Event{Type: typ, Properties: json.RawMessage(props)}
}

// warmMsg builds a MessageWithParts (the GET /session/:id/message item shape)
// carrying the given text parts (each rendered as a text part JSON blob).
func warmMsg(mid, sid, role string, parts ...string) state.MessageWithParts {
	out := make([]json.RawMessage, 0, len(parts))
	for _, pid := range parts {
		out = append(out, json.RawMessage(`{"id":"`+pid+`","sessionID":"`+sid+`","messageID":"`+mid+`","type":"text","text":"part-`+pid+`"}`))
	}
	return state.MessageWithParts{
		Info:  json.RawMessage(`{"id":"` + mid + `","sessionID":"` + sid + `","role":"` + role + `"}`),
		Parts: out,
	}
}

// messageIDs returns the set of message IDs currently stored for sid.
func messageIDs(snap state.Snapshot, sid string) map[string]bool {
	out := map[string]bool{}
	for _, mwp := range snap.Messages[sid] {
		var info struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(mwp.Info, &info)
		if info.ID != "" {
			out[info.ID] = true
		}
	}
	return out
}

// partIDs returns the set of part IDs currently stored under (sid, mid).
func partIDs(snap state.Snapshot, sid, mid string) map[string]bool {
	out := map[string]bool{}
	for _, mwp := range snap.Messages[sid] {
		var info struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(mwp.Info, &info)
		if info.ID != mid {
			continue
		}
		for _, part := range mwp.Parts {
			var pe struct {
				ID string `json:"id"`
			}
			_ = json.Unmarshal(part, &pe)
			if pe.ID != "" {
				out[pe.ID] = true
			}
		}
	}
	return out
}

// hasKind reports whether any event in evs has the given Kind.
func hasKind(evs []state.ClientEvent, kind string) bool {
	for _, e := range evs {
		if e.Kind == kind {
			return true
		}
	}
	return false
}

// kindList returns the Kind list of events for diagnostic messages.
func kindList(evs []state.ClientEvent) []string {
	out := make([]string, 0, len(evs))
	for _, e := range evs {
		out = append(out, e.Kind)
	}
	return out
}

// warmDrain collects all buffered subscriber events without blocking.
func warmDrain(ch <-chan state.ClientEvent) []state.ClientEvent {
	var out []state.ClientEvent
	for {
		select {
		case e := <-ch:
			out = append(out, e)
		default:
			return out
		}
	}
}

// TestWarmReconcile_OmittingMessage_RetainsMessage (Option A; RED before fix,
// GREEN after): a LIVE message M must survive a warm reconcile whose fetched
// snapshot omits M (the lagged/omissive GET on reconnect). Before the fix the
// warm absence-deletion loop deleted M and emitted KindMessageDelete; after the
// fix M is retained and no inferred delete is emitted.
func TestWarmReconcile_OmittingMessage_RetainsMessage(t *testing.T) {
	const sid = "sess-omsg"
	s := state.New(100)
	s.Apply(warmEv("session.created", `{"info":{"id":"`+sid+`"}}`))

	// (1) Cold load carrying M → msgLoaded[sid]=true. M is now live in the store.
	s.SetSessionMessages(sid, []state.MessageWithParts{
		warmMsg("M", sid, "user", "pM"),
	})
	if !s.IsMessagesLoaded(sid) {
		t.Fatal("cold load should have marked session loaded (warm-reconcile precondition)")
	}
	if ids := messageIDs(s.Snapshot(map[string]bool{sid: true}), sid); !ids["M"] {
		t.Fatalf("cold load seed: M should be present, got %v", ids)
	}

	// Subscribe AFTER the cold load so the channel observes ONLY warm-reconcile
	// emissions (cold-load events were emitted before subscribe and never reach
	// this channel).
	ch, unsub := s.Subscribe(256)
	defer unsub()

	// (2) Warm reconcile (msgLoaded already true) whose fetched snapshot OMITS M
	// entirely — the exact reconnect-lag shape. Pre-fix: deletes M + emits
	// KindMessageDelete. Post-fix (Option A): M retained, no delete emitted.
	s.SetSessionMessages(sid, []state.MessageWithParts{})

	got := warmDrain(ch)
	if hasKind(got, state.KindMessageDelete) {
		t.Errorf("warm reconcile omitted M but emitted KindMessageDelete — absence must NOT infer deletion (events=%v)", kindList(got))
	}
	if ids := messageIDs(s.Snapshot(map[string]bool{sid: true}), sid); !ids["M"] {
		t.Errorf("warm reconcile omitted M and M vanished from store — absence must NOT delete (ids=%v)", ids)
	}
}

// TestWarmReconcile_OmittingPart_RetainsPart (Option A; RED before fix, GREEN
// after): a LIVE part Q on message M must survive a warm reconcile whose
// fetched snapshot contains M but omits Q. This is asserted INDEPENDENTLY of
// the message-retention test because the VISIBLE symptom is the PART vanishing
// (a task-tool Part riding on A_assistant) — without this test, the
// whole-message test passing would mask a part-only regression. Before the fix
// the warm absence-deletion loop deleted Q and emitted KindPartDelete; after
// the fix M and both parts P+Q remain.
func TestWarmReconcile_OmittingPart_RetainsPart(t *testing.T) {
	const sid = "sess-opart"
	s := state.New(100)
	s.Apply(warmEv("session.created", `{"info":{"id":"`+sid+`"}}`))

	// (1) Cold load M carrying parts P AND Q. Both live in the store.
	s.SetSessionMessages(sid, []state.MessageWithParts{
		warmMsg("M", sid, "assistant", "P", "Q"),
	})
	if !s.IsMessagesLoaded(sid) {
		t.Fatal("cold load should have marked session loaded")
	}
	{
		pids := partIDs(s.Snapshot(map[string]bool{sid: true}), sid, "M")
		if !pids["P"] || !pids["Q"] {
			t.Fatalf("cold load seed: P and Q should be present, got %v", pids)
		}
	}

	ch, unsub := s.Subscribe(256)
	defer unsub()

	// (2) Warm reconcile: M is present in the fetched snapshot but Q is OMITTED
	// (the part-level lag shape). Pre-fix: deletes Q + emits KindPartDelete.
	// Post-fix: Q retained, no part delete emitted.
	s.SetSessionMessages(sid, []state.MessageWithParts{
		warmMsg("M", sid, "assistant", "P"),
	})

	got := warmDrain(ch)
	if hasKind(got, state.KindPartDelete) {
		t.Errorf("warm reconcile omitted Q but emitted KindPartDelete — absence must NOT infer part deletion (events=%v)", kindList(got))
	}
	ids := messageIDs(s.Snapshot(map[string]bool{sid: true}), sid)
	if !ids["M"] {
		t.Errorf("warm reconcile dropped M entirely — absence must NOT delete (ids=%v)", ids)
	}
	pids := partIDs(s.Snapshot(map[string]bool{sid: true}), sid, "M")
	if !pids["P"] {
		t.Errorf("warm reconcile dropped P (present in fetch) — present part should remain (pids=%v)", pids)
	}
	if !pids["Q"] {
		t.Errorf("warm reconcile omitted Q and Q vanished — absence must NOT delete a part (pids=%v)", pids)
	}
}

// TestExplicitMessageRemoved_StillDeletes (regression guard; GREEN before and
// after the fix): Option A removes ABSENCE-inferred deletion ONLY. The explicit
// message.removed handler (deleteMessageLocked) is unchanged and MUST still
// delete the message with a KindMessageDelete notification. Pins that Option A
// did not silence the authoritative removal path.
func TestExplicitMessageRemoved_StillDeletes(t *testing.T) {
	const sid = "sess-mr"
	s := state.New(100)
	s.Apply(warmEv("session.created", `{"info":{"id":"`+sid+`"}}`))
	s.SetSessionMessages(sid, []state.MessageWithParts{
		warmMsg("M", sid, "user", "pM"),
	})
	if !s.IsMessagesLoaded(sid) {
		t.Fatal("cold load should have marked session loaded")
	}

	ch, unsub := s.Subscribe(256)
	defer unsub()

	// Explicit removal event — the authoritative path Option A keeps.
	s.Apply(warmEv("message.removed", `{"sessionID":"`+sid+`","messageID":"M"}`))

	got := warmDrain(ch)
	if !hasKind(got, state.KindMessageDelete) {
		t.Errorf("explicit message.removed must emit KindMessageDelete (events=%v)", kindList(got))
	}
	if ids := messageIDs(s.Snapshot(map[string]bool{sid: true}), sid); ids["M"] {
		t.Errorf("explicit message.removed must remove M from the store (ids=%v)", ids)
	}
}

// TestExplicitMessagePartRemoved_DeletesOnlyIntendedPart (regression guard;
// GREEN before and after the fix): Option A keeps the explicit
// message.part.removed handler (deletePartLocked). Injecting
// message.part.removed for part Q must remove Q ONLY — message M and the
// unrelated parts P and R remain. Pins that the explicit per-part removal path
// is unchanged and scoped.
func TestExplicitMessagePartRemoved_DeletesOnlyIntendedPart(t *testing.T) {
	const sid = "sess-pr"
	s := state.New(100)
	s.Apply(warmEv("session.created", `{"info":{"id":"`+sid+`"}}`))
	s.SetSessionMessages(sid, []state.MessageWithParts{
		warmMsg("M", sid, "assistant", "P", "Q", "R"),
	})
	if !s.IsMessagesLoaded(sid) {
		t.Fatal("cold load should have marked session loaded")
	}

	ch, unsub := s.Subscribe(256)
	defer unsub()

	// Explicit removal of Q only.
	s.Apply(warmEv("message.part.removed", `{"sessionID":"`+sid+`","messageID":"M","partID":"Q"}`))

	got := warmDrain(ch)
	if !hasKind(got, state.KindPartDelete) {
		t.Errorf("explicit message.part.removed must emit KindPartDelete (events=%v)", kindList(got))
	}
	ids := messageIDs(s.Snapshot(map[string]bool{sid: true}), sid)
	if !ids["M"] {
		t.Errorf("explicit part removal must NOT drop the parent message M (ids=%v)", ids)
	}
	pids := partIDs(s.Snapshot(map[string]bool{sid: true}), sid, "M")
	if pids["Q"] {
		t.Errorf("explicit message.part.removed must remove Q (pids=%v)", pids)
	}
	if !pids["P"] || !pids["R"] {
		t.Errorf("explicit message.part.removed for Q must NOT remove unrelated P/R (pids=%v)", pids)
	}
}
