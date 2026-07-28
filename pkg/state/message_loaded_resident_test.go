package state

import (
	"encoding/json"
	"testing"
)

// TestMessagesLoadedDerivedFromResidentParts pins the S5 hydration contract:
// "messagesLoaded" must be DERIVED from actual resident parts, not the msgLoaded
// latch, so it can NEVER report loaded with zero resident parts on a completed
// assistant message.
//
// This is the daemon's systemic steady-state bug (M1): every finished session
// showed gate.messagesLoaded=true / hydrated=true / last_assistant_empty=false
// with ZERO resident parts while the opencode DB had them all. The IsMessagesLoaded
// latch (set by reconcileMessagesLocked) early-returned on the open path and
// blocked the parts re-fetch — so the daemon never served the parts at all (the
// "reload fixes it" symptom was a client localStorage-cache artifact, not daemon
// re-hydration). The fix derives loaded from the resident parts themselves, in
// the spirit of the busyCount retirement (c4c4ef1: derive RunningRoots from
// subtreeBusyCount, no cached flag): the gate no longer trusts msgLoaded alone.
func TestMessagesLoadedDerivedFromResidentParts(t *testing.T) {
	s := New(100)
	defer s.Close()
	const sid = "sess"
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))

	// Reproduce the runtime bug state: a history fetch that returned a COMPLETED
	// assistant message with NO inline parts (the schema-drift / envelope-only
	// shape that set the msgLoaded latch while leaving zero resident parts).
	s.SetSessionMessages(sid, []MessageWithParts{{
		Info: json.RawMessage(`{"id":"m1","sessionID":"sess","role":"assistant","time":{"created":1,"completed":2},"finish":"stop"}`),
		// no Parts — the lying state the contract must reject
	}})

	// CONTRACT (DONE-CRITERION): messagesLoaded is NEVER true with zero resident
	// parts on a completed assistant message. Both the open-path gate and the
	// snapshot gate field must reject the latch here so the open path re-fetches.
	if s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must be false when a completed assistant has 0 resident parts (got true) — the latch must not report loaded without parts")
	}
	g := s.Snapshot(nil).Gate[sid]
	if g.MessagesLoaded {
		t.Fatalf("gate.messagesLoaded must be false when a completed assistant has 0 resident parts (got true)")
	}

	// The open path re-fetches (IsMessagesLoaded is now false) and the opencode DB
	// actually has the parts — simulate that fetch populating them (warm reconcile:
	// msgLoaded already true, reconcileMessagesLocked writes the parts).
	s.SetSessionMessages(sid, []MessageWithParts{{
		Info:  json.RawMessage(`{"id":"m1","sessionID":"sess","role":"assistant","time":{"created":1,"completed":2},"finish":"stop"}`),
		Parts: []json.RawMessage{json.RawMessage(`{"id":"p1","type":"text","text":"real assistant answer"}`)},
	}})

	// Now resident parts cover the completed assistant → loaded is true.
	if !s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must be true once resident parts cover the completed assistant")
	}
	g = s.Snapshot(nil).Gate[sid]
	if !g.MessagesLoaded {
		t.Fatalf("gate.messagesLoaded must be true once parts are resident")
	}
	// last_assistant_empty must reflect the ACTUAL resident content (recompute ran
	// inside the reconcile that wrote the parts).
	if g.LastAssistantEmpty {
		t.Fatalf("gate.last_assistant_empty must be false when the latest assistant has non-whitespace text content, got true")
	}
}

// TestMessagesLoadedResidentGenuineEmpty guards the derivation against
// over-aggression: a session whose latest COMPLETED assistant carries parts but
// no text/tool content (a real "empty stop" turn — reasoning/step parts only) is
// still considered loaded. The derivation keys on resident PART COUNT, not on
// messageHasContent, so a turn that legitimately produced only envelope parts
// does not trip the "missing parts" re-fetch.
func TestMessagesLoadedResidentGenuineEmpty(t *testing.T) {
	s := New(100)
	defer s.Close()
	const sid = "sess"
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))
	s.SetSessionMessages(sid, []MessageWithParts{{
		Info:  json.RawMessage(`{"id":"m1","sessionID":"sess","role":"assistant","time":{"created":1,"completed":2},"finish":"stop"}`),
		Parts: []json.RawMessage{json.RawMessage(`{"id":"r1","type":"reasoning","text":"..."}`)},
	}})
	if !s.IsMessagesLoaded(sid) {
		t.Fatalf("a completed assistant with envelope parts (reasoning) is resident — must be loaded (no missing-parts re-fetch)")
	}
	g := s.Snapshot(nil).Gate[sid]
	if !g.MessagesLoaded {
		t.Fatalf("gate.messagesLoaded must be true for a turn with envelope parts")
	}
	if !g.LastAssistantEmpty {
		t.Fatalf("gate.last_assistant_empty must be true for a reasoning-only turn (no text/tool content), got false")
	}
}
