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

// TestMessagesLoadedConfirmsSameEmptyNewestOnSecondReconcile is the CRUX fix for
// ses_05ff9273dffe7N4dh1HliZhIXq: a session whose newest COMPLETED assistant
// GENUINELY has zero source parts (confirmed in opencode's own DB) must report
// IsMessagesLoaded=true after the emptiness is confirmed by a SECOND
// authoritative reconcile — instead of looping "not loaded → re-fetch" forever.
//
// The distinguishing signal: a single fetch returning zero parts is ambiguous
// (schema-drift cold load OR source-truth empty); only a SECOND reconcile
// observing the SAME empty newest confirms source-truth. The schema-drift shape
// (TestMessagesLoadedDerivedFromResidentParts) instead resolves via the
// len(parts)>0 branch once the re-fetch serves the real parts.
//
// Maps to TDD cases 2 (confirmed → TRUE) and 3 (one reconcile → FALSE).
func TestMessagesLoadedConfirmsSameEmptyNewestOnSecondReconcile(t *testing.T) {
	s := New(100)
	defer s.Close()
	const sid = "sess"
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))

	empty := func() []MessageWithParts {
		return []MessageWithParts{{
			Info: json.RawMessage(`{"id":"m_fb30","sessionID":"sess","role":"assistant","time":{"created":1,"completed":2},"finish":"stop"}`),
			// no Parts — the genuine source-truth shape (opencode DB has 0 parts)
		}}
	}

	// FIRST authoritative reconcile of the empty newest: pending only, NOT
	// confirmed → IsMessagesLoaded must stay FALSE (the re-fetch guard — this
	// is indistinguishable from a schema-drift cold load on a single fetch).
	s.SetSessionMessages(sid, empty())
	if s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must be FALSE after the FIRST empty reconcile (pending, not confirmed) — a single 0-parts fetch is ambiguous and must re-fetch")
	}
	if g := s.Snapshot(nil).Gate[sid]; g.MessagesLoaded {
		t.Fatalf("gate.messagesLoaded must be FALSE after the first empty reconcile")
	}

	// SECOND authoritative reconcile returns the SAME empty newest: source truth
	// confirmed → IsMessagesLoaded must become TRUE (the fix). This is the exact
	// ses_05ff path: the aggregator re-fetches once, the server still has 0
	// parts, and the turn is admitted as genuinely empty.
	s.SetSessionMessages(sid, empty())
	if !s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must be TRUE once the same empty newest is confirmed by a second reconcile (source truth)")
	}
	if g := s.Snapshot(nil).Gate[sid]; !g.MessagesLoaded {
		t.Fatalf("gate.messagesLoaded must be TRUE after the second confirming reconcile")
	}

	// A third reconcile (e.g. a later re-open) stays confirmed → still loaded.
	s.SetSessionMessages(sid, empty())
	if !s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must remain TRUE on a third reconcile of the same confirmed-empty newest")
	}
}

// TestMessagesLoadedEmptyConfirmationResetsWhenNewestChanges pins that the
// confirmation is keyed on the EXACT newest-completed-assistant id: when the
// newest changes (a newer completed turn appears), the confirmation resets and
// the NEW empty newest must re-confirm from scratch. This is what keeps a
// schema-drift or live-race gap on a NEWER turn from being pre-admitted by an
// older turn's confirmation.
func TestMessagesLoadedEmptyConfirmationResetsWhenNewestChanges(t *testing.T) {
	s := New(100)
	defer s.Close()
	const sid = "sess"
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))

	mk := func(id string) []MessageWithParts {
		return []MessageWithParts{{
			Info: json.RawMessage(`{"id":"` + id + `","sessionID":"sess","role":"assistant","time":{"created":1,"completed":2},"finish":"stop"}`),
		}}
	}

	// Confirm the first empty newest "A" across two reconciles.
	s.SetSessionMessages(sid, mk("A"))
	s.SetSessionMessages(sid, mk("A"))
	if !s.IsMessagesLoaded(sid) {
		t.Fatalf("A must be confirmed empty (loaded) after two reconciles")
	}

	// A newer completed assistant "B" with 0 parts appears in the fetched set.
	// "B" is NOT the confirmed id → must re-fetch (pending only, not loaded),
	// even though "A" was previously confirmed empty.
	s.SetSessionMessages(sid, mk("B"))
	if s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must be FALSE for a NEWER empty newest 'B' (confirmed id is still 'A') — it must re-confirm")
	}

	// A second reconcile of "B" confirms it → loaded again.
	s.SetSessionMessages(sid, mk("B"))
	if !s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must be TRUE once the newer empty newest 'B' is confirmed by a second reconcile")
	}
}

// TestMessagesLoadedLiveNewerEmptyAssistantRemainsBlocked is the S5 live-race
// preservation guard (TDD case 4). A live message.upsert that completes a NEWER
// assistant turn AFTER the cold fetch — with parts not yet streamed (zero
// resident parts) — must force a re-fetch: the live turn was never processed by
// an authoritative reconcile, so its emptiness is NOT confirmed, and admitting
// it would hide a transient gap. The fix must not regress this.
func TestMessagesLoadedLiveNewerEmptyAssistantRemainsBlocked(t *testing.T) {
	s := New(100)
	defer s.Close()
	const sid = "sess"
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))

	// Cold fetch returns a completed assistant "m1" WITH parts → loaded
	// (resident; the empty-newest trackers are cleared since m1 has parts).
	s.SetSessionMessages(sid, []MessageWithParts{{
		Info:  json.RawMessage(`{"id":"m1","sessionID":"sess","role":"assistant","time":{"created":1,"completed":2},"finish":"stop"}`),
		Parts: []json.RawMessage{json.RawMessage(`{"id":"p1","type":"text","text":"answer"}`)},
	}})
	if !s.IsMessagesLoaded(sid) {
		t.Fatalf("baseline: a completed assistant with parts must be loaded")
	}

	// A LIVE message.upsert completes a NEWER assistant "m2" with zero parts
	// (its parts arrive later via separate part.append events — the live race).
	s.Apply(ev("message.updated", `{"info":{"id":"m2","sessionID":"sess","role":"assistant","time":{"created":3,"completed":4},"finish":"stop"}}`))

	// m2 is now the newest COMPLETED assistant with 0 parts, but it was never
	// processed by a reconcile → confirmedEmptyNewest[sid] ("" or "m1") != "m2"
	// → NOT loaded → forces a re-fetch. This is the S5 guard preserved.
	if s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must be FALSE when a LIVE newer completed assistant has 0 unconfirmed parts (live-race re-fetch guard)")
	}
	if g := s.Snapshot(nil).Gate[sid]; g.MessagesLoaded {
		t.Fatalf("gate.messagesLoaded must be FALSE for the live newer 0-parts assistant")
	}
}

// TestEmptyNewestConfirmationClearedOnSessionDelete ensures a recreated session
// id re-confirms source-emptiness from scratch: the pending/confirmed trackers
// are dropped on session delete, so a new session under the same id cannot be
// pre-admitted by the prior lifetime's confirmation.
func TestEmptyNewestConfirmationClearedOnSessionDelete(t *testing.T) {
	s := New(100)
	defer s.Close()
	const sid = "sess"
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))

	empty := []MessageWithParts{{
		Info: json.RawMessage(`{"id":"m1","sessionID":"sess","role":"assistant","time":{"created":1,"completed":2},"finish":"stop"}`),
	}}

	// Confirm emptiness in the first lifetime.
	s.SetSessionMessages(sid, empty)
	s.SetSessionMessages(sid, empty)
	if !s.IsMessagesLoaded(sid) {
		t.Fatalf("expected loaded after confirming emptiness")
	}

	// Delete + recreate under the same id.
	s.Apply(ev("session.deleted", `{"info":{"id":"sess"}}`))
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))

	// First empty reconcile in the NEW lifetime must be pending (not confirmed)
	// → NOT loaded. The prior confirmation must not carry over.
	s.SetSessionMessages(sid, empty)
	if s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must be FALSE on the first empty reconcile of a recreated session (confirmation was cleared on delete)")
	}
	// Second reconcile re-confirms → loaded.
	s.SetSessionMessages(sid, empty)
	if !s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must be TRUE after re-confirming emptiness in the new session lifetime")
	}
}

// abortedAssistantInfo is the live opencode payload for the offending newest
// completed assistant msg_fb30d2644001rKpffGJmphivax in ses_05ff9273dffe7N4dh1HliZhIXq
// (fetched from opencode pid 1923 @ http://127.0.0.1:43889). It is an ABORTED
// turn: info.error.name == "MessageAbortedError", tokens all zero, parts:[],
// no finish. Verbatim so the terminal-error parsing is exercised against the
// exact wire shape the daemon sees in production.
const abortedAssistantInfo = `{"id":"m_fb30","sessionID":"sess","role":"assistant","time":{"created":1785415411268,"completed":1785415414277},"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}},"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}},"variant":"default"}`

// TestMessagesLoadedAbortedNewestAdmittedOnFirstReconcile is the CRUX of the
// terminal-error fast-path (TDD case #1): a newest COMPLETED assistant carrying
// a recognized terminal error (MessageAbortedError) with zero parts is admitted
// as loaded on the FIRST reconcile — WITHOUT the second confirming reconcile the
// O5 backstop requires. The aborted signal is a POSITIVE terminal
// classification: opencode itself marked the turn as having produced no output
// (the live payload: error.name=MessageAbortedError, tokens all zero, parts:[],
// no finish), so zero resident parts is source truth, not a schema-drift gap.
//
// This is strictly better than O5 for aborted turns: ses_05ff now loads after a
// SINGLE fetch instead of two. The store-level proof that the aggregator will
// NOT re-fetch is BlockedByUnconfirmedEmptyNewest == false after this reconcile.
func TestMessagesLoadedAbortedNewestAdmittedOnFirstReconcile(t *testing.T) {
	s := New(100)
	defer s.Close()
	const sid = "sess"
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))

	// ONE authoritative reconcile of the aborted newest (verbatim live shape).
	res := s.SetSessionMessages(sid, []MessageWithParts{{
		Info: json.RawMessage(abortedAssistantInfo),
		// no Parts — the turn is aborted and produced no output
	}})

	// CRUX: loaded is TRUE after the SINGLE first reconcile (no re-fetch).
	if !s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must be TRUE on the FIRST reconcile for an aborted newest (terminal-error fast-path) — a single 0-parts fetch with a terminal error is positive source truth, not ambiguous")
	}
	if g := s.Snapshot(nil).Gate[sid]; !g.MessagesLoaded {
		t.Fatalf("gate.messagesLoaded must be TRUE on the first reconcile for an aborted newest")
	}
	// The aggregator reads this to decide whether to re-fetch: an aborted turn
	// is positively classified, so it must NOT signal a re-fetch (one fetch
	// suffices). This is the store-level "no re-fetch" proof.
	if res.BlockedByUnconfirmedEmptyNewest {
		t.Fatalf("BlockedByUnconfirmedEmptyNewest must be FALSE for an aborted newest — the aggregator must not re-fetch a positively-terminal turn")
	}
}

// TestMessagesLoadedAbortedNewestRecordsTransitionInConfirmedEmpty pins F4b: the
// abort branch of reconcileMessagesLocked now RECORDS the terminal admit in
// confirmedEmptyNewest (SET instead of delete, guarded so it only fires on the
// transition) — mirroring the O5 branch's transition guard. The behavioral proof
// is the recorded state (what the guard keys on): after one reconcile of a
// newest completed assistant that is an aborted turn,
// confirmedEmptyNewest[sid] == newestID holds. This is the new state-recording
// effect; the gate itself is unchanged (the fast-path in
// latestAssistantResidentLocked already admitted the aborted newest BEFORE this
// recorded value existed, and still does — the fast-path is checked before the
// confirmedEmptyNewest[sid]==me.id O5 backstop).
//
// Asserting the recorded state (not the log line) is deliberate: the log is the
// observable side the guard suppresses on re-reconcile, but log output is
// awkward to test directly — the recorded map entry is what the guard keys on.
// A second reconcile of the SAME aborted newest must NOT re-transition (the
// guard confirmedEmptyNewest[sid] != newestID is false), so the log is guarded
// from re-firing — proven here by the recorded value staying equal.
func TestMessagesLoadedAbortedNewestRecordsTransitionInConfirmedEmpty(t *testing.T) {
	s := New(100)
	defer s.Close()
	const sid = "sess"
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))

	// ONE authoritative reconcile of the aborted newest (verbatim live shape).
	const abortedNewestID = "m_fb30"
	res := s.SetSessionMessages(sid, []MessageWithParts{{
		Info: json.RawMessage(abortedAssistantInfo),
		// no Parts — the turn is aborted and produced no output
	}})

	// CRUX (F4b): the abort branch RECORDED the terminal admit —
	// confirmedEmptyNewest[sid] == the aborted newest's id (SET, not delete).
	if got := s.confirmedEmptyNewest[sid]; got != abortedNewestID {
		t.Fatalf("confirmedEmptyNewest[sid] must equal the aborted newest id %q after one reconcile (got %q) — F4b records the terminal admit", abortedNewestID, got)
	}
	// pendingEmptyNewest is still cleared (the abort branch deletes it).
	if _, ok := s.pendingEmptyNewest[sid]; ok {
		t.Fatalf("pendingEmptyNewest[sid] must be cleared on the abort branch")
	}
	// The gate is unchanged by this recording: loaded is TRUE (the fast-path
	// admitted the aborted newest BEFORE the O5 backstop, and the recorded value
	// does not alter that ordering).
	if !s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must be TRUE on the FIRST reconcile for an aborted newest (terminal-error fast-path)")
	}
	if g := s.Snapshot(nil).Gate[sid]; !g.MessagesLoaded {
		t.Fatalf("gate.messagesLoaded must be TRUE on the first reconcile for an aborted newest")
	}
	if res.BlockedByUnconfirmedEmptyNewest {
		t.Fatalf("BlockedByUnconfirmedEmptyNewest must be FALSE for an aborted newest — the aggregator must not re-fetch a positively-terminal turn")
	}

	// A SECOND reconcile of the SAME aborted newest must NOT re-transition
	// (the guard confirmedEmptyNewest[sid] != newestID is false) — the recorded
	// value stays equal to newestID, and the guarded log does not re-fire.
	s.SetSessionMessages(sid, []MessageWithParts{{
		Info: json.RawMessage(abortedAssistantInfo),
	}})
	if got := s.confirmedEmptyNewest[sid]; got != abortedNewestID {
		t.Fatalf("confirmedEmptyNewest[sid] must still equal the aborted newest id %q after the second reconcile (got %q) — the guard must not re-transition", abortedNewestID, got)
	}
	if !s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must remain TRUE on the second reconcile of the same aborted newest")
	}
}

// TestMessagesLoadedNonTerminalErrorFallsBackToO5Confirmation is TDD case #2:
// a newest COMPLETED assistant with zero parts whose error name is NOT a
// recognized terminal classification must still require the O5 two-empty
// confirmation (the backstop is preserved for unrecognized errors). The gate
// treats only the cases isTerminalError recognizes as positive; an unknown
// error name is not trusted to mean "outputless".
func TestMessagesLoadedNonTerminalErrorFallsBackToO5Confirmation(t *testing.T) {
	s := New(100)
	defer s.Close()
	const sid = "sess"
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))

	// A completed assistant with zero parts and an UNRECOGNIZED error name.
	nonTerminal := []MessageWithParts{{
		Info: json.RawMessage(`{"id":"m1","sessionID":"sess","role":"assistant","time":{"created":1,"completed":2},"error":{"name":"SomeUnrecognizedError","data":{}}}`),
	}}

	// FIRST reconcile: not confirmed → must stay FALSE (O5 backstop preserved).
	res := s.SetSessionMessages(sid, nonTerminal)
	if s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must be FALSE after the first reconcile of a NON-terminal error newest — the O5 backstop must still require confirmation")
	}
	if !res.BlockedByUnconfirmedEmptyNewest {
		t.Fatalf("BlockedByUnconfirmedEmptyNewest must be TRUE for a non-terminal error newest — the aggregator must re-fetch to disambiguate")
	}

	// SECOND reconcile of the same empty newest → O5 confirms source truth → TRUE.
	s.SetSessionMessages(sid, nonTerminal)
	if !s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must be TRUE once the same non-terminal-error empty newest is confirmed by a second reconcile (O5 backstop intact)")
	}
}

// TestMessagesLoadedAbortedFastPathDoesNotBreakO5Confirmation is TDD case #3
// (regression guard): the O5 two-empty confirmation path for a zero-parts
// newest with NO error at all must remain unchanged after the aborted fast-path
// is layered on top — a single empty reconcile stays FALSE, a second confirms
// TRUE. (Also covered by TestMessagesLoadedConfirmsSameEmptyNewestOnSecondReconcile;
// this is the focused assertion that the new branch did not regress the no-error
// shape.)
func TestMessagesLoadedAbortedFastPathDoesNotBreakO5Confirmation(t *testing.T) {
	s := New(100)
	defer s.Close()
	const sid = "sess"
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))

	empty := []MessageWithParts{{
		Info: json.RawMessage(`{"id":"m1","sessionID":"sess","role":"assistant","time":{"created":1,"completed":2},"finish":"stop"}`),
	}}

	// FIRST reconcile (no error): pending → FALSE.
	s.SetSessionMessages(sid, empty)
	if s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must be FALSE after the first no-error empty reconcile — O5 path unchanged")
	}
	// SECOND reconcile (no error): confirmed → TRUE.
	s.SetSessionMessages(sid, empty)
	if !s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must be TRUE after the second no-error empty reconcile — O5 path unchanged")
	}
}

// TestMessagesLoadedAbortedNewestWithPartsLoadsNormally is TDD case #4
// (baseline): an aborted newest that DID carry resident parts loads via the
// normal len(parts)>0 branch — the terminal-error fast-path is only the
// zero-parts admit; a parts-bearing turn is resident regardless of error.
func TestMessagesLoadedAbortedNewestWithPartsLoadsNormally(t *testing.T) {
	s := New(100)
	defer s.Close()
	const sid = "sess"
	s.Apply(ev("session.created", `{"info":{"id":"sess"}}`))

	// An aborted turn that nonetheless has a resident part (e.g. partial output
	// streamed before the abort). The len(parts)>0 branch admits it directly.
	s.SetSessionMessages(sid, []MessageWithParts{{
		Info:  json.RawMessage(abortedAssistantInfo),
		Parts: []json.RawMessage{json.RawMessage(`{"id":"p1","type":"text","text":"partial before abort"}`)},
	}})
	if !s.IsMessagesLoaded(sid) {
		t.Fatalf("IsMessagesLoaded must be TRUE for an aborted newest that carries resident parts (normal len(parts)>0 branch)")
	}
}
