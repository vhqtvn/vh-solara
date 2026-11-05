package state

// never_started_test.go — pins the P1 never-started classification
// (never_started.go): an opencode row written by finalizeInterruptedAssistant
// (assistant + MessageAbortedError + ≤100 ms + zero parts + zero tokens — the
// validated incident signature, observed at 27 ms and 7 ms) is refined into
// NeverStartedErrorName at ALL THREE adoption surfaces (live
// upsertMessageLocked; history reconcileMessagesLocked; older-page
// MergeOlderMessages — D9), while every real
// operator/limit abort — the 145 s control from the same incident session,
// duration outliers, and any abort that produced parts — keeps today's
// positive-terminal MessageAbortedError meaning. Cases are built from the
// exact incident row shapes (tmp/handoff-instant-abort-round2.md).

import (
	"bytes"
	"encoding/json"
	"testing"
)

// incidentInfo is the exact incident row shape (27 ms instance): completed
// assistant, error.name=MessageAbortedError with data.message="Aborted"
// (opencode's DOMException("Aborted") mapping), all-zero tokens, no parts
// (not even step-start). created/completed are unix ms like upstream.
const incidentInfo = `{"id":"msg_incident","sessionID":"sess_ns","role":"assistant",` +
	`"time":{"created":1790000000000,"completed":1790000000027},` +
	`"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}},` +
	`"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}`

// control145sInfo is the REAL operator abort from the same session: 145 s of
// runtime before the stop — duration ≫ the 100 ms ceiling alone disqualifies
// the never-started signature.
const control145sInfo = `{"id":"msg_ctrl","sessionID":"sess_ns","role":"assistant",` +
	`"time":{"created":1790000000000,"completed":1790000145000},` +
	`"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}},` +
	`"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}`

func nsState(t *testing.T, s *Store, sid, mid string) (completed bool, terminalError string, info []byte, parts int) {
	t.Helper()
	s.mu.RLock()
	defer s.mu.RUnlock()
	sm := s.messages[sid]
	if sm == nil {
		t.Fatalf("no sessionMessages for %s", sid)
	}
	me := sm.byID[mid]
	if me == nil {
		t.Fatalf("no messageEntry for %s", mid)
	}
	return me.completed, me.terminalError, append([]byte(nil), me.info...), len(me.parts)
}

func applyInfo(t *testing.T, s *Store, raw string) {
	t.Helper()
	s.Apply(ev("message.updated", `{"info":`+raw+`}`))
}

// TestNeverStarted_LiveIncidentShapeRefined: the live path (message.updated →
// upsertMessageLocked) re-classifies the incident-shaped newest assistant as
// NeverStartedErrorName — cached classification AND info bytes (what the
// snapshot/emit carries to the FE) both carry the refinement, with the
// upstream name preserved as error.data.cause and provenance fields (times,
// tokens) surviving verbatim.
func TestNeverStarted_LiveIncidentShapeRefined(t *testing.T) {
	s := New(100)
	applyInfo(t, s, incidentInfo)

	completed, te, info, _ := nsState(t, s, "sess_ns", "msg_incident")
	if !completed {
		t.Fatalf("incident row: completed=false, want true (upstream completed survives refinement)")
	}
	if te != NeverStartedErrorName {
		t.Fatalf("incident row: terminalError=%q, want %q (NOT plain MessageAbortedError)", te, NeverStartedErrorName)
	}
	var m map[string]any
	if err := json.Unmarshal(info, &m); err != nil {
		t.Fatalf("refined info not valid JSON: %v", err)
	}
	errObj, _ := m["error"].(map[string]any)
	if errObj == nil || errObj["name"] != NeverStartedErrorName {
		t.Fatalf("refined info.error.name = %v, want %q", errObj["name"], NeverStartedErrorName)
	}
	data, _ := errObj["data"].(map[string]any)
	if data == nil || data["message"] != neverStartedUserMessage {
		t.Fatalf("refined info.error.data.message = %v, want the never-started user vocabulary", data["message"])
	}
	if data["cause"] != "MessageAbortedError" {
		t.Fatalf("refined info.error.data.cause = %v, want upstream name preserved", data["cause"])
	}
	if _, still := m["tokens"]; !still {
		t.Fatalf("refined info lost the tokens block (only error may be rewritten)")
	}
}

// TestNeverStarted_LiveControl145sStaysOperatorAbort: the REAL operator abort
// (145 s, parts ran) keeps today's classification on the live path — bytes
// unchanged, terminalError stays the upstream name.
func TestNeverStarted_LiveControl145sStaysOperatorAbort(t *testing.T) {
	s := New(100)
	applyInfo(t, s, control145sInfo)

	_, te, info, _ := nsState(t, s, "sess_ns", "msg_ctrl")
	if te != "MessageAbortedError" {
		t.Fatalf("145 s control: terminalError=%q, want MessageAbortedError (real operator abort)", te)
	}
	if !bytes.Equal(info, []byte(control145sInfo)) {
		t.Fatalf("145 s control: info bytes were rewritten:\n got %s\nwant %s", info, control145sInfo)
	}
}

// TestNeverStarted_LiveBoundaryTable: conjunct-level boundary cases on the
// live path. Every case that misses one conjunct of the signature keeps the
// operator-abort classification (raw bytes, upstream name).
func TestNeverStarted_LiveBoundaryTable(t *testing.T) {
	cases := []struct {
		name string
		info string
		part bool // seed a step-start part before the terminal info lands
	}{
		{
			name: "500ms_with_parts",
			info: `{"id":"m","sessionID":"sess_ns","role":"assistant","time":{"created":1000,"completed":1500},` +
				`"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}},"tokens":{"input":0,"output":0}}`,
			part: true,
		},
		{
			name: "500ms_zero_parts",
			info: `{"id":"m","sessionID":"sess_ns","role":"assistant","time":{"created":1000,"completed":1500},` +
				`"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}},"tokens":{"input":0,"output":0}}`,
		},
		{
			name: "instant_but_step_start_part_present",
			info: `{"id":"m","sessionID":"sess_ns","role":"assistant","time":{"created":1000,"completed":1007},` +
				`"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}},"tokens":{"input":0,"output":0}}`,
			part: true,
		},
		{
			name: "instant_but_tokens_positive",
			info: `{"id":"m","sessionID":"sess_ns","role":"assistant","time":{"created":1000,"completed":1007},` +
				`"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}},"tokens":{"input":0,"output":3}}`,
		},
		{
			name: "instant_but_non_aborted_error",
			info: `{"id":"m","sessionID":"sess_ns","role":"assistant","time":{"created":1000,"completed":1007},` +
				`"error":{"name":"ProviderError","data":{"message":"boom"}},"tokens":{"input":0,"output":0}}`,
		},
		{
			name: "instant_shape_but_user_role",
			info: `{"id":"m","sessionID":"sess_ns","role":"user","time":{"created":1000,"completed":1007},` +
				`"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}},"tokens":{"input":0,"output":0}}`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := New(100)
			if tc.part {
				s.Apply(ev("message.part.updated", `{"part":{"id":"p1","sessionID":"sess_ns","messageID":"m","type":"step-start"}}`))
			}
			applyInfo(t, s, tc.info)
			_, te, info, _ := nsState(t, s, "sess_ns", "m")
			if te != "MessageAbortedError" && tc.name == "instant_but_non_aborted_error" {
				if te != "ProviderError" {
					t.Fatalf("terminalError=%q, want the raw upstream name", te)
				}
			} else if te != "MessageAbortedError" {
				t.Fatalf("terminalError=%q, want MessageAbortedError (signature must NOT match)", te)
			}
			if !bytes.Equal(info, []byte(tc.info)) {
				t.Fatalf("info bytes were rewritten for a non-matching shape:\n got %s\nwant %s", info, tc.info)
			}
		})
	}
}

// TestNeverStarted_TurnStoppingGuardSuppressesRefinement: while the session is
// TurnStopping (a /vh/abort or pre-restart abort is settling — the one window
// where "we just aborted this session" is observable), an instant
// MessageAbortedError terminal may be OUR abort landing. The refinement is
// suppressed (suppress-only: falls back to today's classification, never a
// wrong "not your abort" claim).
func TestNeverStarted_TurnStoppingGuardSuppressesRefinement(t *testing.T) {
	s := New(100)
	s.Stop("sess_ns", "msg_incident") // → TurnStopping (settle timer armed)
	applyInfo(t, s, incidentInfo)

	_, te, info, _ := nsState(t, s, "sess_ns", "msg_incident")
	if te != "MessageAbortedError" {
		t.Fatalf("during TurnStopping: terminalError=%q, want MessageAbortedError (guard must suppress refinement)", te)
	}
	if !bytes.Equal(info, []byte(incidentInfo)) {
		t.Fatalf("during TurnStopping: info bytes rewritten despite guard:\n got %s", info)
	}
}

// TestNeverStarted_TurnStoppingGuardSuppressesOlderPageRefinement: the
// TurnStopping suppression must also hold on the older-history adoption
// surface (MergeOlderMessages — D9). An incident-shaped older row landing
// while the session is TurnStopping may be our own abort's history settling,
// so the refinement is suppressed there too: plain MessageAbortedError
// terminal, info bytes verbatim, nothing retained for first-part revocation.
// Follows the immediate-assert pattern above: no waiting out the settle
// window — the guard is the transient turnState, not the timer.
func TestNeverStarted_TurnStoppingGuardSuppressesOlderPageRefinement(t *testing.T) {
	olderIncident := `{"id":"msg_old_incident","sessionID":"sess_ns","role":"assistant",` +
		`"time":{"created":1790000000000,"completed":1790000000027},` +
		`"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}},` +
		`"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}`
	resident := `{"id":"msg_resident","sessionID":"sess_ns","role":"user",` +
		`"time":{"created":1790000200000}}`

	s := New(1024)
	s.Apply(ev("session.created", `{"info":{"id":"sess_ns","title":"S"}}`))
	s.SetSessionMessages("sess_ns", []MessageWithParts{{Info: []byte(resident)}})
	s.Stop("sess_ns", "msg_resident") // → TurnStopping (settle timer armed)
	s.MergeOlderMessages("sess_ns", []MessageWithParts{
		{Info: []byte(olderIncident)}, // oldest-first, as the cursor returns
	}, false)

	_, te, info, _ := nsState(t, s, "sess_ns", "msg_old_incident")
	if te != "MessageAbortedError" {
		t.Fatalf("older page during TurnStopping: terminalError=%q, want MessageAbortedError (guard must suppress refinement)", te)
	}
	if !bytes.Equal(info, []byte(olderIncident)) {
		t.Fatalf("older page during TurnStopping: info bytes rewritten despite guard:\n got %s", info)
	}
	s.mu.RLock()
	rawLeft := s.messages["sess_ns"].byID["msg_old_incident"].neverStartedRaw
	s.mu.RUnlock()
	if len(rawLeft) != 0 {
		t.Fatalf("older page during TurnStopping: neverStartedRaw retained (%s) — suppression must arm nothing", rawLeft)
	}
}

// TestNeverStarted_TurnStoppingGuardSuppressesReconcileRefinement:
// belt-only twin of the hydration surface — the guard is ONE shared check
// (classifyNeverStartedLocked's TurnStopping branch), so this pins the
// reconcileMessagesLocked caller's wiring, not a separate behavior.
func TestNeverStarted_TurnStoppingGuardSuppressesReconcileRefinement(t *testing.T) {
	s := New(100)
	s.Stop("sess_ns", "msg_incident") // → TurnStopping (settle timer armed)
	s.SetSessionMessages("sess_ns", []MessageWithParts{{Info: json.RawMessage(incidentInfo)}})

	_, te, info, _ := nsState(t, s, "sess_ns", "msg_incident")
	if te != "MessageAbortedError" {
		t.Fatalf("reconcile during TurnStopping: terminalError=%q, want MessageAbortedError (guard must suppress refinement)", te)
	}
	if !bytes.Equal(info, []byte(incidentInfo)) {
		t.Fatalf("reconcile during TurnStopping: info bytes rewritten despite guard:\n got %s", info)
	}
	// Belt line mirroring the older-page primary's rawLeft check above: the
	// suppressed reconcile must leave nothing retained for revocation. This
	// pins the terminal↔retain else-arm coupling (hydration.go: neverStart
	// false ⇒ terminalError = the upstream name AND neverStartedRaw = nil in
	// the same else arm), not new behavior — inert-by-construction today
	// (nothing arms the retain on this path), refactor insurance.
	s.mu.RLock()
	rawLeft := s.messages["sess_ns"].byID["msg_incident"].neverStartedRaw
	s.mu.RUnlock()
	if len(rawLeft) != 0 {
		t.Fatalf("reconcile during TurnStopping: neverStartedRaw retained (%s) — suppression must arm nothing", rawLeft)
	}
}

// TestNeverStarted_PartOnlyRevocation (commit-review C-F1 regression): a part
// arriving AFTER the terminal message.updated — with NO further body adoption
// — must itself revoke the refinement. The raw pre-refinement body is
// retained on the entry (neverStartedRaw); upsertPartLocked restores it,
// re-classifies as the upstream name, and emits a message upsert so live
// clients drop the "turn never ran" presentation. Without this, a
// parts-bearing turn could display never-started vocabulary indefinitely.
func TestNeverStarted_PartOnlyRevocation(t *testing.T) {
	s := New(100)
	ch, stop := s.Subscribe(256)
	defer stop()

	applyInfo(t, s, incidentInfo)
	if _, te, _, _ := nsState(t, s, "sess_ns", "msg_incident"); te != NeverStartedErrorName {
		t.Fatalf("seed: expected refinement before part arrives, got %q", te)
	}

	// ONLY the part event — no message.updated re-application.
	s.Apply(ev("message.part.updated", `{"part":{"id":"late1","sessionID":"sess_ns","messageID":"msg_incident","type":"step-start"}}`))

	_, te, info, parts := nsState(t, s, "sess_ns", "msg_incident")
	if parts != 1 {
		t.Fatalf("part-only revocation: parts=%d, want 1", parts)
	}
	if te != "MessageAbortedError" {
		t.Fatalf("part-only revocation: terminalError=%q, want MessageAbortedError", te)
	}
	if !bytes.Equal(info, []byte(incidentInfo)) {
		t.Fatalf("part-only revocation: info must be the retained RAW upstream body:\n got %s", info)
	}
	// The restored body must be EMITTED (live clients learned the refined
	// body earlier; the revocation has to reach them).
	sawRestore := false
	for len(ch) > 0 {
		e := <-ch
		if e.Kind == KindMessageUpsert && bytes.Equal(e.Payload, []byte(incidentInfo)) {
			sawRestore = true
		}
	}
	if !sawRestore {
		t.Fatalf("part-only revocation: no KindMessageUpsert emitted carrying the restored raw body")
	}
}

// TestNeverStarted_DeltaOnlyRevocation (commit-review R2-F1 regression): the
// STREAMING path creates the first resident part directly (a delta can
// precede its part.updated — appendPartDeltaLocked inserts the placeholder
// without passing through upsertPartLocked). A refined entry receiving any
// delta demonstrably started its run (a genuine never-started turn emits no
// deltas — no provider call), so the delta path must revoke too, restoring
// the raw body and emitting it.
func TestNeverStarted_DeltaOnlyRevocation(t *testing.T) {
	s := New(100)
	ch, stop := s.Subscribe(256)
	defer stop()

	applyInfo(t, s, incidentInfo)
	if _, te, _, _ := nsState(t, s, "sess_ns", "msg_incident"); te != NeverStartedErrorName {
		t.Fatalf("seed: expected refinement before delta arrives, got %q", te)
	}

	// ONLY a streaming delta — no part.updated, no body re-application.
	s.Apply(ev("message.part.delta", `{"sessionID":"sess_ns","messageID":"msg_incident","partID":"d1","field":"text","delta":"tok"}`))

	_, te, info, parts := nsState(t, s, "sess_ns", "msg_incident")
	if parts != 1 {
		t.Fatalf("delta-only revocation: parts=%d, want 1 (the delta placeholder)", parts)
	}
	if te != "MessageAbortedError" {
		t.Fatalf("delta-only revocation: terminalError=%q, want MessageAbortedError", te)
	}
	if !bytes.Equal(info, []byte(incidentInfo)) {
		t.Fatalf("delta-only revocation: info must be the retained RAW upstream body:\n got %s", info)
	}
	sawRestore := false
	for len(ch) > 0 {
		e := <-ch
		if e.Kind == KindMessageUpsert && bytes.Equal(e.Payload, []byte(incidentInfo)) {
			sawRestore = true
		}
	}
	if !sawRestore {
		t.Fatalf("delta-only revocation: no KindMessageUpsert emitted carrying the restored raw body")
	}
}

// TestNeverStarted_DeltaThenPartUpdatedNoRefinement (R2-F1 second half):
// after a delta created the first part, a subsequent part.updated must ALSO
// leave no refinement — the pre-fix bug had firstResidentPart=false forever
// once the delta-path part existed.
func TestNeverStarted_DeltaThenPartUpdatedNoRefinement(t *testing.T) {
	s := New(100)
	applyInfo(t, s, incidentInfo)

	s.Apply(ev("message.part.delta", `{"sessionID":"sess_ns","messageID":"msg_incident","partID":"d1","field":"text","delta":"tok"}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"d1","sessionID":"sess_ns","messageID":"msg_incident","type":"text","text":"tok"}}`))

	_, te, info, parts := nsState(t, s, "sess_ns", "msg_incident")
	if parts != 1 {
		t.Fatalf("delta+part.updated: parts=%d, want 1", parts)
	}
	if te != "MessageAbortedError" {
		t.Fatalf("delta+part.updated: terminalError=%q, want MessageAbortedError (no retained refinement)", te)
	}
	if !bytes.Equal(info, []byte(incidentInfo)) {
		t.Fatalf("delta+part.updated: info must stay the raw upstream body:\n got %s", info)
	}
}

// TestNeverStarted_HydrationThenPartRevokes: the retention is armed by the
// HYDRATION surface too — a refined history row revoked by a later first
// LIVE part takes the same restore path.
func TestNeverStarted_HydrationThenPartRevokes(t *testing.T) {
	s := New(100)
	res := s.SetSessionMessages("sess_ns", []MessageWithParts{{Info: json.RawMessage(incidentInfo)}})
	if res.BlockedByUnconfirmedEmptyNewest {
		t.Fatalf("unexpected empty-newest block")
	}
	if _, te, _, _ := nsState(t, s, "sess_ns", "msg_incident"); te != NeverStartedErrorName {
		t.Fatalf("hydration seed: expected refinement, got %q", te)
	}

	s.Apply(ev("message.part.updated", `{"part":{"id":"late1","sessionID":"sess_ns","messageID":"msg_incident","type":"step-start"}}`))

	_, te, info, parts := nsState(t, s, "sess_ns", "msg_incident")
	if parts != 1 || te != "MessageAbortedError" {
		t.Fatalf("hydration+part: parts=%d terminalError=%q, want 1 + MessageAbortedError", parts, te)
	}
	if !bytes.Equal(info, []byte(incidentInfo)) {
		t.Fatalf("hydration+part: info must return to the raw upstream body:\n got %s", info)
	}
}

// TestNeverStarted_ColdLoadLiveTouchedFetchedPartRevokes (commit-review R3
// B-F1/C-F1 regression): during a cold-fetch window, a live incident-shaped
// message.updated refines the entry AND sets liveTouchedBody; the cold
// reconcile then returns the message WITH a part. coldLoad && liveTouchedBody
// skips body adoption (C-F2) — and with it the classification clearing — so
// the fetched-parts merge loop inserts the FIRST resident part into a
// still-refined entry. The merge loop must revoke: raw body restored, upstream
// classification, retention cleared, no per-message upsert on the cold path
// (the wholesale cold batch carries the restored body).
func TestNeverStarted_ColdLoadLiveTouchedFetchedPartRevokes(t *testing.T) {
	s := New(100)
	s.MarkColdFetchStart("sess_ns")
	applyInfo(t, s, incidentInfo) // live during the cold window: refined + liveTouchedBody
	if _, te, _, _ := nsState(t, s, "sess_ns", "msg_incident"); te != NeverStartedErrorName {
		t.Fatalf("seed: expected refinement during cold window, got %q", te)
	}

	res := s.SetSessionMessages("sess_ns", []MessageWithParts{{
		Info:  json.RawMessage(incidentInfo),
		Parts: []json.RawMessage{[]byte(`{"id":"fp1","sessionID":"sess_ns","messageID":"msg_incident","type":"step-start"}`)},
	}})
	if res.BlockedByUnconfirmedEmptyNewest {
		t.Fatalf("unexpected empty-newest block")
	}

	_, te, info, parts := nsState(t, s, "sess_ns", "msg_incident")
	if parts != 1 {
		t.Fatalf("cold-load fetched part: parts=%d, want 1", parts)
	}
	if te != "MessageAbortedError" {
		t.Fatalf("cold-load fetched part: terminalError=%q, want MessageAbortedError (revocation required)", te)
	}
	if !bytes.Equal(info, []byte(incidentInfo)) {
		t.Fatalf("cold-load fetched part: info must be the restored RAW upstream body:\n got %s", info)
	}
	s.mu.RLock()
	rawLeft := s.messages["sess_ns"].byID["msg_incident"].neverStartedRaw
	s.mu.RUnlock()
	if len(rawLeft) != 0 {
		t.Fatalf("cold-load fetched part: neverStartedRaw retention not cleared")
	}
}

// TestNeverStarted_ReversibleOnBodyReadoption: a body adoption that arrives
// after a part also re-derives the raw upstream shape (partCount now breaks
// the signature at classification time).
func TestNeverStarted_ReversibleOnBodyReadoption(t *testing.T) {
	s := New(100)
	applyInfo(t, s, incidentInfo)
	if _, te, _, _ := nsState(t, s, "sess_ns", "msg_incident"); te != NeverStartedErrorName {
		t.Fatalf("seed: expected refinement before part arrives, got %q", te)
	}

	s.Apply(ev("message.part.updated", `{"part":{"id":"late1","sessionID":"sess_ns","messageID":"msg_incident","type":"step-start"}}`))
	applyInfo(t, s, incidentInfo) // warm re-adoption now sees partCount=1

	_, te, info, parts := nsState(t, s, "sess_ns", "msg_incident")
	if parts != 1 {
		t.Fatalf("re-adoption: parts=%d, want 1 (the live part must survive)", parts)
	}
	if te != "MessageAbortedError" {
		t.Fatalf("re-adoption with a part: terminalError=%q, want MessageAbortedError (refinement must revert)", te)
	}
	if !bytes.Equal(info, []byte(incidentInfo)) {
		t.Fatalf("re-adoption with a part: info bytes must return to the raw upstream shape:\n got %s", info)
	}
}

// TestNeverStarted_HydrationRefines: the history-fetch path
// (SetSessionMessages → reconcileMessagesLocked) refines the same incident
// shape — and, because NeverStartedErrorName is an isTerminalError member,
// the newest-assistant admission is NOT blocked by the unconfirmed-empty-newest
// gate (mirrors the upstream-name behavior: first-reconcile admission).
func TestNeverStarted_HydrationRefines(t *testing.T) {
	s := New(100)
	res := s.SetSessionMessages("sess_ns", []MessageWithParts{{Info: json.RawMessage(incidentInfo)}})
	if res.BlockedByUnconfirmedEmptyNewest {
		t.Fatalf("incident-shaped newest must admit on first reconcile (isTerminalError member), got blocked")
	}

	_, te, info, _ := nsState(t, s, "sess_ns", "msg_incident")
	if te != NeverStartedErrorName {
		t.Fatalf("hydration: terminalError=%q, want %q (reconcile refines the same incident shape as the live surface)", te, NeverStartedErrorName)
	}
	if !bytes.Contains(info, []byte(`"`+NeverStartedErrorName+`"`)) {
		t.Fatalf("hydration: refined info bytes missing %q:\n%s", NeverStartedErrorName, info)
	}
}

// TestNeverStarted_HydrationControl145s: the 145 s control keeps the
// operator-abort classification through hydration too.
func TestNeverStarted_HydrationControl145s(t *testing.T) {
	s := New(100)
	res := s.SetSessionMessages("sess_ns", []MessageWithParts{{Info: json.RawMessage(control145sInfo)}})
	if res.BlockedByUnconfirmedEmptyNewest {
		t.Fatalf("145 s control must stay admitted (upstream MessageAbortedError is terminal), got blocked")
	}
	_, te, info, _ := nsState(t, s, "sess_ns", "msg_ctrl")
	if te != "MessageAbortedError" {
		t.Fatalf("hydration 145 s control: terminalError=%q, want MessageAbortedError", te)
	}
	if !bytes.Equal(info, []byte(control145sInfo)) {
		t.Fatalf("hydration 145 s control: info bytes rewritten:\n got %s", info)
	}
}

// TestNeverStarted_HydrationPreservesResidentLivePart: Option-A part
// preservation — a fetch that omits a part the live path already holds cannot
// fake "zero parts": partCount is fetched ∪ resident, so the refinement stays
// suppressed while the resident part exists.
func TestNeverStarted_HydrationPreservesResidentLivePart(t *testing.T) {
	s := New(100)
	s.Apply(ev("message.part.updated", `{"part":{"id":"rp1","sessionID":"sess_ns","messageID":"msg_incident","type":"step-start"}}`))
	res := s.SetSessionMessages("sess_ns", []MessageWithParts{{Info: json.RawMessage(incidentInfo)}})
	if res.BlockedByUnconfirmedEmptyNewest {
		t.Fatalf("resident-part case: unexpected empty-newest block")
	}
	_, te, info, parts := nsState(t, s, "sess_ns", "msg_incident")
	if parts != 1 {
		t.Fatalf("resident part lost by reconcile: parts=%d, want 1", parts)
	}
	if te != "MessageAbortedError" {
		t.Fatalf("resident-part case: terminalError=%q, want MessageAbortedError (union part count must break the signature)", te)
	}
	if !bytes.Equal(info, []byte(incidentInfo)) {
		t.Fatalf("resident-part case: info bytes rewritten:\n got %s", info)
	}
}

// TestNeverStarted_MergeByteStable: the merge is byte-stable for a fixed base
// (warm re-fetch of the same raw row re-merges to identical bytes — no
// spurious diff-emits on repeated reconciles) and preserves every non-error
// field plus the upstream name as data.cause.
func TestNeverStarted_MergeByteStable(t *testing.T) {
	base := []byte(incidentInfo)
	one := mergeNeverStartedInfo(base)
	two := mergeNeverStartedInfo(base)
	if one == nil || two == nil {
		t.Fatalf("merge returned nil for a valid base")
	}
	if !bytes.Equal(one, two) {
		t.Fatalf("merge not byte-stable:\n one %s\ntwo %s", one, two)
	}
	if bytes.Equal(one, base) {
		t.Fatalf("merge must rewrite the error block")
	}
	// Unparseable base → nil (caller keeps original bytes).
	if got := mergeNeverStartedInfo([]byte(`{nope`)); got != nil {
		t.Fatalf("merge of unparseable base must return nil, got %s", got)
	}
}

// TestNeverStarted_MergePreservesNonErrorFieldsVerbatim (commit-review
// B-F3/D-F3): the merge decodes the base as json.RawMessage and replaces ONLY
// the error key — unrelated fields pass through BYTE-EXACT, including values
// a float64 round-trip would perturb (>2^53 integers, high-precision
// decimals, nested objects).
func TestNeverStarted_MergePreservesNonErrorFieldsVerbatim(t *testing.T) {
	base := []byte(`{"id":"m1","time":{"created":1790000000000,"completed":1790000000027,"big":9007199254740993,"precise":0.1234567890123456789},` +
		`"meta":{"nested":{"keep":"me","arr":[1,2,3]}},"tokens":{"input":0,"output":0},` +
		`"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}}}`)
	out := mergeNeverStartedInfo(base)
	if out == nil {
		t.Fatalf("merge returned nil for a valid base")
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(out, &m); err != nil {
		t.Fatalf("merged info not valid JSON: %v", err)
	}
	// The >2^53 integer and the high-precision decimal survive with exact digits
	// (a float64 round-trip would render 9007199254740993 as ...992).
	for _, want := range []string{"9007199254740993", "0.1234567890123456789"} {
		if !bytes.Contains(m["time"], []byte(want)) {
			t.Fatalf("merge perturbed a non-error numeric value: time=%s (lost %s)", m["time"], want)
		}
	}
	if string(m["meta"]) != `{"nested":{"keep":"me","arr":[1,2,3]}}` {
		t.Fatalf("merge perturbed the nested meta block: %s", m["meta"])
	}
	var errObj struct {
		Name string `json:"name"`
		Data struct {
			Message string `json:"message"`
			Cause   string `json:"cause"`
		} `json:"data"`
	}
	if json.Unmarshal(m["error"], &errObj) != nil || errObj.Name != NeverStartedErrorName ||
		errObj.Data.Cause != "MessageAbortedError" || errObj.Data.Message != neverStartedUserMessage {
		t.Fatalf("merge error block wrong: %+v", errObj)
	}
}

// TestNeverStarted_TokensAllZero: token-zero walking — absent/empty/unparseable
// counts as zero (no positive count provable), any nested positive number
// disqualifies.
func TestNeverStarted_TokensAllZero(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want bool
	}{
		{"absent", ``, true},
		{"empty_object", `{}`, true},
		{"all_zero", `{"input":0,"output":0,"cache":{"read":0,"write":0}}`, true},
		{"output_positive", `{"input":0,"output":3}`, false},
		{"nested_cache_read_positive", `{"input":0,"output":0,"cache":{"read":5,"write":0}}`, false},
		{"unparseable", `{nope`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw := json.RawMessage(tc.raw)
			if tc.raw == "" {
				raw = nil
			}
			if got := tokensAllZero(raw); got != tc.want {
				t.Fatalf("tokensAllZero(%s) = %v, want %v", tc.raw, got, tc.want)
			}
		})
	}
}

// TestNeverStarted_IsTerminalErrorMember: NeverStartedErrorName must remain an
// isTerminalError member — it refines an upstream-POSITIVE terminal (completed
// + error), unlike the sweep's VHSolaraInterruptedError which fabricates one.
func TestNeverStarted_IsTerminalErrorMember(t *testing.T) {
	if !isTerminalError(NeverStartedErrorName) {
		t.Fatalf("isTerminalError(%q) = false, want true (refines an upstream-positive terminal)", NeverStartedErrorName)
	}
	if !isTerminalError("MessageAbortedError") {
		t.Fatalf("isTerminalError(MessageAbortedError) = false, want true (unchanged upstream membership)")
	}
	if isTerminalError(InterruptedTurnErrorName) {
		t.Fatalf("isTerminalError(%q) = true, want false (sweep inference must stay excluded)", InterruptedTurnErrorName)
	}
}

// TestNeverStarted_OlderPageClassifies (D9): MergeOlderMessages — the
// older-history adoption surface — runs the never-started classifier exactly
// as the two primary surfaces (upsertMessageLocked live;
// reconcileMessagesLocked history fetch). An incident-shaped older row (27 ms,
// zero parts, zero tokens) is refined (cached terminalError, refined info
// bytes, raw body retained for first-part revocation), while a substantive
// older abort (the 145 s control shape) keeps the operator-abort
// classification and its bytes verbatim. Before D9 this surface skipped the
// classifier entirely (accepted gap: pre-P1 presentation only, never a wrong
// positive — see the former message_window.go note).
func TestNeverStarted_OlderPageClassifies(t *testing.T) {
	olderIncident := `{"id":"msg_old_incident","sessionID":"sess_ns","role":"assistant",` +
		`"time":{"created":1790000000000,"completed":1790000000027},` +
		`"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}},` +
		`"tokens":{"input":0,"output":0,"reasoning":0,"cache":{"read":0,"write":0}}}`
	olderControl := `{"id":"msg_old_ctrl","sessionID":"sess_ns","role":"assistant",` +
		`"time":{"created":1790000000000,"completed":1790000145000},` +
		`"error":{"name":"MessageAbortedError","data":{"message":"Aborted"}},` +
		`"tokens":{"input":1,"output":1,"reasoning":0,"cache":{"read":0,"write":0}}}`
	// Plain completed older assistant WITH a part and NO error: pins the
	// else-arm's no-error case — terminalError must stay empty (review F5;
	// the resident user row below exercises the dedup-skip path, not this).
	olderPlain := `{"id":"msg_old_plain","sessionID":"sess_ns","role":"assistant",` +
		`"time":{"created":1790000001000,"completed":1790000050000},` +
		`"tokens":{"input":2,"output":2,"reasoning":0,"cache":{"read":0,"write":0}}}`
	olderPlainPart := `{"id":"msg_old_plain_p1","type":"text","text":"older plain turn output"}`
	resident := `{"id":"msg_resident","sessionID":"sess_ns","role":"user",` +
		`"time":{"created":1790000200000}}`

	s := New(1024)
	s.Apply(ev("session.created", `{"info":{"id":"sess_ns","title":"S"}}`))
	s.SetSessionMessages("sess_ns", []MessageWithParts{{Info: []byte(resident)}})
	s.MergeOlderMessages("sess_ns", []MessageWithParts{
		{Info: []byte(olderIncident)}, // oldest-first, as the cursor returns
		{Info: []byte(olderControl)},
		{Info: []byte(olderPlain), Parts: []json.RawMessage{json.RawMessage(olderPlainPart)}},
	}, false)

	// Incident-shaped older row: refined.
	completed, te, info, parts := nsState(t, s, "sess_ns", "msg_old_incident")
	if !completed {
		t.Fatalf("older incident row: completed=false, want true (upstream completed survives refinement)")
	}
	if parts != 0 {
		t.Fatalf("older incident row: parts=%d, want 0", parts)
	}
	if te != NeverStartedErrorName {
		t.Fatalf("older incident row: terminalError=%q, want %q (older-page adoption must classify)", te, NeverStartedErrorName)
	}
	var m map[string]any
	if err := json.Unmarshal(info, &m); err != nil {
		t.Fatalf("refined older info not valid JSON: %v", err)
	}
	errObj, _ := m["error"].(map[string]any)
	if errObj == nil || errObj["name"] != NeverStartedErrorName {
		t.Fatalf("older incident info.error.name = %v, want %q", errObj["name"], NeverStartedErrorName)
	}
	data, _ := errObj["data"].(map[string]any)
	if data == nil || data["message"] != neverStartedUserMessage || data["cause"] != "MessageAbortedError" {
		t.Fatalf("older incident info.error.data = %v, want message vocabulary + upstream cause", data)
	}
	s.mu.RLock()
	rawLeft := s.messages["sess_ns"].byID["msg_old_incident"].neverStartedRaw
	s.mu.RUnlock()
	if len(rawLeft) == 0 || !bytes.Contains(rawLeft, []byte("MessageAbortedError")) {
		t.Fatalf("older incident row: neverStartedRaw retention missing (first-part revocation would be blind)")
	}

	// Substantive older abort (145 s, tokens>0): stays operator-abort, bytes verbatim.
	_, te, info, _ = nsState(t, s, "sess_ns", "msg_old_ctrl")
	if te != "MessageAbortedError" {
		t.Fatalf("older 145s control: terminalError=%q, want MessageAbortedError (real operator abort)", te)
	}
	if !bytes.Equal(info, []byte(olderControl)) {
		t.Fatalf("older 145s control: info bytes were rewritten:\n got %s\nwant %s", info, olderControl)
	}

	// Plain non-error older row: terminalError stays empty, part adopted.
	if _, te, _, parts = nsState(t, s, "sess_ns", "msg_old_plain"); te != "" || parts != 1 {
		t.Fatalf("older plain row: terminalError=%q parts=%d, want empty/1 (no-error else-arm must not stamp a terminal)", te, parts)
	}

	// Resident tail untouched.
	if _, te, _, _ = nsState(t, s, "sess_ns", "msg_resident"); te != "" {
		t.Fatalf("resident user row: terminalError=%q, want empty (untouched by older-page adoption)", te)
	}
}
