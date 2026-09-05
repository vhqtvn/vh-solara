package state

import (
	"encoding/json"
	"testing"
)

// seedOrphan seeds session sid with a user message + an UNCOMPLETED newest
// assistant (the P1-API-007 defect shape: created, no completed, no error) by
// driving the store through Apply — the same live-event path real hydration
// uses. Returns the orphan's message id.
func seedOrphan(t *testing.T, s *Store, sid string) string {
	t.Helper()
	s.Apply(ev("session.created", `{"info":{"id":"`+sid+`","title":"Orphan"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"ou1","sessionID":"`+sid+`","role":"user","time":{"created":10,"completed":11}}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"oup1","sessionID":"`+sid+`","messageID":"ou1","type":"text","text":"go","time":{"start":10,"end":11}}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"oa1","sessionID":"`+sid+`","role":"assistant","time":{"created":20}}}`))
	s.Apply(ev("message.part.updated", `{"part":{"id":"oap1","sessionID":"`+sid+`","messageID":"oa1","type":"reasoning","text":"half","time":{"start":20,"end":20}}}`))
	return "oa1"
}

// orphanState reads the cached terminal fields of the orphan entry.
func orphanState(t *testing.T, s *Store, sid, mid string) (completed bool, terminalError string, synthesized bool) {
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
	return me.completed, me.terminalError, me.synthesizedTerminal
}

func gateActivity(s *Store, sid string) string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.activity[sid]
}

// observeNotBusy applies ONE successful not-busy statuses observation through
// the store seam every successful fetch drives (SetActivityFromStatuses with
// the session absent). The d-F1 stability gate requires TWO consecutive
// observations before the sweep fires, so a test expecting a mark either calls
// this twice or uses sweepClear below. Call ORDER between this and Apply is
// also the fetch→apply sequencing seam the TOCTOU tests rely on — no sleeps.
func observeNotBusy(s *Store) {
	s.SetActivityFromStatuses(map[string]json.RawMessage{})
}

// sweepClear drives the two consecutive not-busy observations the d-F1
// stability gate requires: the first primes the notBusyOnce latch, the second
// fires the sweep. This pins the coherent post-d-F1 heal latency — hydrate
// (or /vh/reload) counts as one observation and the next reconcile tick, or a
// second reload, confirms.
func sweepClear(s *Store) {
	observeNotBusy(s)
	observeNotBusy(s)
}

func orphanInfo(t *testing.T, s *Store, sid, mid string) []byte {
	t.Helper()
	s.mu.RLock()
	defer s.mu.RUnlock()
	return append([]byte(nil), s.messages[sid].byID[mid].info...)
}

// TestSweepMarksIdleOrphanOnClear is the core heal: an authoritative not-busy
// statuses report (session absent from a SUCCESSFUL response) with an
// uncompleted newest assistant → the sweep synthesizes the terminal marker,
// the session goes idle, and the emitted message info carries completed +
// InterruptedTurnErrorName (what the FE renders through the existing
// .msg-error/settled affordances).
func TestSweepMarksIdleOrphanOnClear(t *testing.T) {
	s := New(100)
	sid := "sess_sweep_clear"
	mid := seedOrphan(t, s, sid)

	// Sanity: seeded as the defect shape.
	if c, te, _ := orphanState(t, s, sid, mid); c || te != "" {
		t.Fatalf("seed: expected uncompleted orphan, got completed=%v err=%q", c, te)
	}

	ch, stop := s.Subscribe(256)
	defer stop()

	// Successful statuses response that does NOT mention sid → clear path.
	// d-F1 stability gate: the FIRST consecutive not-busy observation only
	// primes the latch — no mark yet (one snapshot cannot distinguish a dead
	// run from the fetch→apply race).
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		"other": json.RawMessage(`{"type":"idle"}`),
	})
	if c, te, _ := orphanState(t, s, sid, mid); c || te != "" {
		t.Fatalf("first not-busy observation must not mark (stability gate): completed=%v err=%q", c, te)
	}

	// SECOND consecutive not-busy observation → the sweep fires.
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		"other": json.RawMessage(`{"type":"idle"}`),
	})

	c, te, syn := orphanState(t, s, sid, mid)
	if !c || te != InterruptedTurnErrorName || !syn {
		t.Fatalf("sweep: expected marker (completed + %q + synthesized), got completed=%v err=%q syn=%v",
			InterruptedTurnErrorName, c, te, syn)
	}
	if a := gateActivity(s, sid); a != ActivityIdle {
		t.Fatalf("sweep: activity = %q, want idle", a)
	}
	sawEmit := false
	for {
		select {
		case e := <-ch:
			if e.Kind != KindMessageUpsert {
				continue
			}
			var info map[string]any
			if err := json.Unmarshal(e.Payload, &info); err != nil {
				t.Fatalf("emit payload not JSON: %v", err)
			}
			if info["id"] != mid {
				continue
			}
			sawEmit = true
			errObj, ok := info["error"].(map[string]any)
			if !ok || errObj["name"] != InterruptedTurnErrorName {
				t.Fatalf("emit: error.name missing/wrong on marked message: %s", e.Payload)
			}
			timeObj, _ := info["time"].(map[string]any)
			if timeObj == nil || timeObj["completed"] == nil {
				t.Fatalf("emit: no time.completed on marked message: %s", e.Payload)
			}
		default:
			goto drained
		}
	}
drained:
	if !sawEmit {
		t.Fatalf("sweep: no KindMessageUpsert emitted for marked orphan")
	}
}

// TestSweepDoesNotMarkBusyOrUnsettled pins the two non-authoritative shapes:
// a session the statuses report says is BUSY must not be marked, and a session
// mid abort-settle (TurnStopping) must not be marked by the sweep body (the
// clear path settles it first; the defensive guard keeps future callers
// honest).
func TestSweepDoesNotMarkBusyOrUnsettled(t *testing.T) {
	s := New(100)
	sid := "sess_sweep_busy"
	mid := seedOrphan(t, s, sid)

	// Busy statuses report → clear path never runs for sid.
	s.SetActivityFromStatuses(map[string]json.RawMessage{
		sid: json.RawMessage(`{"type":"busy"}`),
	})
	if c, _, _ := orphanState(t, s, sid, mid); c {
		t.Fatalf("busy: sweep must not mark a busy session's inflight assistant")
	}
	if a := gateActivity(s, sid); a != ActivityBusy {
		t.Fatalf("busy: activity = %q, want busy", a)
	}

	// TurnStopping: seed an abort settle in flight, then call the sweep body
	// directly (defensive-guard pin — production clears settle first).
	sid2 := "sess_sweep_stopping"
	mid2 := seedOrphan(t, s, sid2)
	s.Apply(ev("session.status", evStatus(sid2, "busy")))
	s.Stop(sid2, "oa1") // → TurnStopping (settle timer armed)
	s.mu.RLock()
	ts := s.turnState[sid2]
	s.mu.RUnlock()
	if ts != TurnStopping {
		t.Fatalf("seed: expected TurnStopping, got %v", ts)
	}
	s.mu.Lock()
	s.sweepInterruptedTurnsLocked(sid2)
	stopping := s.turnState[sid2] == TurnStopping
	s.mu.Unlock()
	if !stopping {
		t.Fatalf("sweep must not settle a TurnStopping session from the defensive guard")
	}
	if c, _, _ := orphanState(t, s, sid2, mid2); c {
		t.Fatalf("stopping: sweep must not mark mid-drain")
	}
}

// TestSweepAggregatorAuthoritativeOnlyFailedStatusFetch pins the hard edge at
// the store seam: SetActivityFromStatuses is the ONLY sweep trigger, and its
// callers reach it solely on SUCCESSFUL fetches — so the failed-fetch shape
// (dead opencode / network blip) can never mark a still-running turn. The
// store-layer mirror: no call → no mark. (The full fetch-failure → no-mark
// chain, including the 500→heal flip, is pinned at the aggregator layer in
// pkg/aggregator — TestSweepAuthoritativeOnlyAggregator.)
func TestSweepAggregatorAuthoritativeOnlyFailedStatusFetch(t *testing.T) {
	s := New(100)
	sid := "sess_sweep_failedfetch"
	mid := seedOrphan(t, s, sid)
	// The failed fetch does not reach SetActivityFromStatuses; the orphan
	// stays untouched (mirrors runStatusReconcile's error early-return).
	if c, te, _ := orphanState(t, s, sid, mid); c || te != "" {
		t.Fatalf("failed fetch shape: orphan must stay unmarked")
	}
}

// TestSweepMarkerSurvivesWarmReserve pins stickiness against the exact
// upstream behavior that makes the defect permanent: OpenCode re-serves the
// uncompleted row on every fetch forever. A warm SetSessionMessages whose
// diff still lacks completed must NOT resurrect the turn — the marker stays
// (merged, byte-stable) in both the cached fields and the info bytes.
func TestSweepMarkerSurvivesWarmReserve(t *testing.T) {
	s := New(100)
	sid := "sess_sweep_warm"
	mid := seedOrphan(t, s, sid)

	// Mark via the clear path (two consecutive not-busy observations).
	sweepClear(s)
	c, te, _ := orphanState(t, s, sid, mid)
	if !c || te != InterruptedTurnErrorName {
		t.Fatalf("pre-serve: marker not set")
	}
	infoBefore := orphanInfo(t, s, sid, mid)

	// Warm re-serve: the fetched body STILL lacks time.completed and error
	// (this is what OpenCode re-serves forever). Same id — only a tokens
	// field changes so the body differs from the merged marker info.
	stale := `{"id":"` + mid + `","sessionID":"` + sid + `","role":"assistant","time":{"created":20},"tokens":{"input":5}}`
	s.SetSessionMessages(sid, []MessageWithParts{{Info: json.RawMessage(stale)}})

	c, te, syn := orphanState(t, s, sid, mid)
	if !c || te != InterruptedTurnErrorName || !syn {
		t.Fatalf("warm re-serve resurrected the turn: completed=%v err=%q syn=%v", c, te, syn)
	}
	// The fetched body's NEW non-terminal fields are adopted (tokens), while
	// the marker fields survive with the SAME synthesized ms (no flicker).
	var before, after map[string]any
	if err := json.Unmarshal(infoBefore, &before); err != nil {
		t.Fatalf("before not JSON: %v", err)
	}
	if err := json.Unmarshal(orphanInfo(t, s, sid, mid), &after); err != nil {
		t.Fatalf("after not JSON: %v", err)
	}
	if after["error"].(map[string]any)["name"] != InterruptedTurnErrorName {
		t.Fatalf("warm re-serve dropped marker error: %v", after["error"])
	}
	if after["time"].(map[string]any)["completed"] != before["time"].(map[string]any)["completed"] {
		t.Fatalf("warm re-serve changed synthesized completed ms")
	}
	if after["tokens"].(map[string]any)["input"] != float64(5) {
		t.Fatalf("warm re-serve did not adopt fetched tokens: %v", after["tokens"])
	}
	// Turn must not re-open: activity stays idle.
	if a := gateActivity(s, sid); a != ActivityIdle {
		t.Fatalf("warm re-serve: activity = %q, want idle", a)
	}

	// An IDENTICAL re-serve is a pure no-op: merged bytes equal the resident
	// bytes → no diff, no emit (the no-churn property that keeps forever-
	// re-served orphans quiet within a daemon lifetime).
	ch, stop := s.Subscribe(64)
	defer stop()
	s.SetSessionMessages(sid, []MessageWithParts{{Info: json.RawMessage(stale)}})
	select {
	case e := <-ch:
		t.Fatalf("identical re-serve emitted %s", e.Kind)
	default:
	}
}

// TestSweepLateLiveUpdateNoResurrect pins the #2696-class extension on the
// LIVE path: a late message.updated (uncompleted body) arriving after the
// marker must not un-mark the entry or re-escalate the session to busy.
func TestSweepLateLiveUpdateNoResurrect(t *testing.T) {
	s := New(100)
	sid := "sess_sweep_late"
	mid := seedOrphan(t, s, sid)
	sweepClear(s)
	if c, _, _ := orphanState(t, s, sid, mid); !c {
		t.Fatalf("seed marker missing")
	}

	// Late live update with the stale uncompleted body (+ a tokens drift so
	// the body differs from the merged marker info).
	s.Apply(ev("message.updated", `{"info":{"id":"`+mid+`","sessionID":"`+sid+`","role":"assistant","time":{"created":20},"tokens":{"input":9}}}`))
	c, te, syn := orphanState(t, s, sid, mid)
	if !c || te != InterruptedTurnErrorName || !syn {
		t.Fatalf("late update resurrected: completed=%v err=%q syn=%v", c, te, syn)
	}
	if a := gateActivity(s, sid); a != ActivityIdle {
		t.Fatalf("late update: activity = %q, want idle (no busy escalation)", a)
	}
}

// TestSweepRealTerminalSupersedes: a REAL terminal arriving later (upstream
// completed, or an upstream error name like MessageAbortedError because our
// pre-restart abort landed) outranks our inference — it supersedes the marker
// and clears the synthesized flag.
func TestSweepRealTerminalSupersedes(t *testing.T) {
	s := New(100)
	sid := "sess_sweep_real"
	mid := seedOrphan(t, s, sid)
	sweepClear(s)

	// (a) real completion via the live path.
	s.Apply(ev("message.updated", `{"info":{"id":"`+mid+`","sessionID":"`+sid+`","role":"assistant","time":{"created":20,"completed":99}}}`))
	if c, te, syn := orphanState(t, s, sid, mid); !c || te != "" || syn {
		t.Fatalf("real completion must clear marker: completed=%v err=%q syn=%v", c, te, syn)
	}

	// (b) upstream error via the warm path: re-plant a marker, then a fetched
	// body carrying MessageAbortedError.
	sid2 := "sess_sweep_real2"
	mid2 := seedOrphan(t, s, sid2)
	sweepClear(s)
	if c, _, _ := orphanState(t, s, sid2, mid2); !c {
		t.Fatalf("seed2 marker missing")
	}
	aborted := `{"id":"` + mid2 + `","sessionID":"` + sid2 + `","role":"assistant","time":{"created":20},"error":{"name":"MessageAbortedError"}}`
	s.SetSessionMessages(sid2, []MessageWithParts{{Info: json.RawMessage(aborted)}})
	c, te, syn := orphanState(t, s, sid2, mid2)
	if !c || te != "MessageAbortedError" || syn {
		t.Fatalf("upstream error must supersede marker: completed=%v err=%q syn=%v", c, te, syn)
	}
}

// TestSweepIdempotentResweep: the sweep runs on EVERY clear-path reconcile
// and every hydrate. Re-deriving over an already-marked session must be a
// no-op — the predicate no longer selects the completed entry — and repeated
// merges on the same (body, ms) reproduce identical bytes (no emit churn).
func TestSweepIdempotentResweep(t *testing.T) {
	s := New(100)
	sid := "sess_sweep_idem"
	mid := seedOrphan(t, s, sid)
	sweepClear(s)
	infoBefore := orphanInfo(t, s, sid, mid)

	ch, stop := s.Subscribe(256)
	defer stop()
	// Each further observation re-runs the (now no-op) sweep: the predicate
	// no longer selects the completed entry.
	for i := 0; i < 3; i++ {
		observeNotBusy(s)
	}
	emits := 0
drain:
	for {
		select {
		case e := <-ch:
			if e.Kind == KindMessageUpsert {
				emits++
			}
		default:
			break drain
		}
	}
	if string(infoBefore) != string(orphanInfo(t, s, sid, mid)) {
		t.Fatalf("re-sweep mutated info bytes")
	}
	if emits != 0 {
		t.Fatalf("re-sweep emitted %d message events, want 0", emits)
	}
}

// TestSweepAbortSettleThenClearIsMarked is the abort-cannot-complete store
// shape: a busy turn with a stop in flight (our pre-restart abort ran but
// OpenCode never wrote the terminal), then the authoritative clear settles
// the stop AND marks the orphan in the same pass.
func TestSweepAbortSettleThenClearIsMarked(t *testing.T) {
	s := New(100)
	sid := "sess_sweep_abortsettle"
	mid := seedOrphan(t, s, sid)
	s.Apply(ev("session.status", evStatus(sid, "busy")))
	s.mu.RLock()
	if s.turnState[sid] != TurnRunning {
		t.Fatalf("seed: turnState = %v, want TurnRunning", s.turnState[sid])
	}
	s.mu.RUnlock()

	s.Stop(sid, mid) // verbs.go threads InflightAssistantID here
	s.mu.RLock()
	if s.turnState[sid] != TurnStopping {
		t.Fatalf("stop: turnState = %v, want TurnStopping", s.turnState[sid])
	}
	s.mu.RUnlock()

	// Authoritative clear, observation 1: settles the stop (abort-settling
	// gate opens) AND primes the stability latch — no mark yet (d-F1).
	s.SetActivityFromStatuses(map[string]json.RawMessage{})
	s.mu.RLock()
	ts := s.turnState[sid]
	settled := !s.abortSettling[sid]
	s.mu.RUnlock()
	if ts != TurnIdle || !settled {
		t.Fatalf("obs-1 clear: turnState=%v abortSettling-open=%v, want TurnIdle/settled (settle must not wait for obs 2)", ts, settled)
	}
	if c, _, _ := orphanState(t, s, sid, mid); c {
		t.Fatalf("obs-1 clear: stability gate must not mark yet")
	}

	// Observation 2: the sweep marks the drained abort's orphan.
	s.SetActivityFromStatuses(map[string]json.RawMessage{})
	c, te, _ := orphanState(t, s, sid, mid)
	if !c || te != InterruptedTurnErrorName {
		t.Fatalf("abort-settle clear: marker missing (completed=%v err=%q)", c, te)
	}
	if a := gateActivity(s, sid); a != ActivityIdle {
		t.Fatalf("abort-settle clear: activity = %q, want idle", a)
	}
}

// TestSweepMarksRunningTurnStateOnClear pins that a stale TurnRunning state
// does not block the mark: on the clear path the authoritative statuses
// snapshot outranks the turn-state machine (the run is over upstream even if
// the local state machine still says running).
func TestSweepMarksRunningTurnStateOnClear(t *testing.T) {
	s := New(100)
	sid := "sess_sweep_running"
	mid := seedOrphan(t, s, sid)
	s.Apply(ev("session.status", evStatus(sid, "busy")))
	// Authoritative clear with the stale TurnRunning still set: obs 1 clears
	// activity (busy→idle) and primes the latch; obs 2 sweeps (the statuses
	// snapshot outranks the stale turn-state machine on the CLEAR path).
	sweepClear(s)
	c, te, _ := orphanState(t, s, sid, mid)
	if !c || te != InterruptedTurnErrorName {
		t.Fatalf("running-clear: marker missing (completed=%v err=%q)", c, te)
	}
}

// TestMergeInterruptedMarkerInfoStability pins the byte-stability contract
// directly: same (base, ms) → identical bytes; unparseable base → nil.
func TestMergeInterruptedMarkerInfoStability(t *testing.T) {
	base := []byte(`{"id":"x","role":"assistant","time":{"created":20}}`)
	a := mergeInterruptedMarkerInfo(base, 123.0)
	b := mergeInterruptedMarkerInfo(base, 123.0)
	if string(a) != string(b) {
		t.Fatalf("merge not byte-stable:\n%s\n%s", a, b)
	}
	if got := mergeInterruptedMarkerInfo([]byte(`not-json`), 1); got != nil {
		t.Fatalf("unparseable base must return nil, got %s", got)
	}
	// time.completed survives an existing created; error block present.
	var m map[string]any
	if err := json.Unmarshal(a, &m); err != nil {
		t.Fatalf("merged not JSON: %v", err)
	}
	tm := m["time"].(map[string]any)
	if tm["created"] != float64(20) || tm["completed"] != float64(123) {
		t.Fatalf("merge lost time fields: %v", tm)
	}
	if m["error"].(map[string]any)["name"] != InterruptedTurnErrorName {
		t.Fatalf("merge lost error name")
	}

	// d-F2 error preservation: a base carrying a REAL upstream error block
	// KEEPS it — only time.completed is stamped. The synthetic marker is
	// never written over an existing error (the sweep's real-terminal guard
	// routes error-bearing rows to the settle arm, which relies on this).
	errBase := []byte(`{"id":"x","role":"assistant","time":{"created":20},"error":{"name":"MessageAbortedError","data":{"message":"aborted by operator"}}}`)
	ea := mergeInterruptedMarkerInfo(errBase, 123.0)
	eb := mergeInterruptedMarkerInfo(errBase, 123.0)
	if string(ea) != string(eb) {
		t.Fatalf("error-preserving merge not byte-stable:\n%s\n%s", ea, eb)
	}
	var em map[string]any
	if err := json.Unmarshal(ea, &em); err != nil {
		t.Fatalf("error-preserving merge not JSON: %v", err)
	}
	etm := em["time"].(map[string]any)
	if etm["completed"] != float64(123) {
		t.Fatalf("error-preserving merge lost time.completed: %v", etm)
	}
	eErr := em["error"].(map[string]any)
	if eErr["name"] != "MessageAbortedError" {
		t.Fatalf("error-preserving merge RELABELED the real error: %v", eErr)
	}
	eData, _ := eErr["data"].(map[string]any)
	if eData["message"] != "aborted by operator" {
		t.Fatalf("error-preserving merge lost the real error data: %v", eErr)
	}
	// An explicit error:null base is treated as error-less: the synthetic
	// marker IS written (null carries no upstream classification).
	nb := mergeInterruptedMarkerInfo([]byte(`{"id":"x","error":null}`), 5.0)
	var nm map[string]any
	if err := json.Unmarshal(nb, &nm); err != nil {
		t.Fatalf("null-error merge not JSON: %v", err)
	}
	if nm["error"].(map[string]any)["name"] != InterruptedTurnErrorName {
		t.Fatalf("null-error base must get the synthetic marker: %v", nm["error"])
	}
}

// TestSweepTOCTOUTurnStartAfterFetchNotMarked is the d-F1 crux repro: statuses
// fetched at T (session not yet busy), the turn starting and its first
// assistant mutation applied BEFORE SetActivityFromStatuses acquires s.mu. The
// stale not-busy snapshot must NOT mark the LIVE streaming turn. The fix is the
// two-observation stability gate + the latch clear on busy-class activity
// writes: the turn's first assistant mutation escalates activity to busy
// (upsertMessageLocked → setActivityAtLocked), which CLEARS the notBusyOnce
// latch before the stale snapshot's clear path runs — so the snapshot only
// re-primes the latch instead of sweeping. Sequencing is controlled by call
// order at the store seam (no sleeps): SetActivityFromStatuses IS the
// fetch-result application, so a snapshot "fetched" before the Apply calls and
// "applied" after them is exactly the race window.
func TestSweepTOCTOUTurnStartAfterFetchNotMarked(t *testing.T) {
	s := New(100)
	sid := "sess_sweep_toctou"
	s.Apply(ev("session.created", `{"info":{"id":"`+sid+`","title":"TOCTOU"}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"tu1","sessionID":"`+sid+`","role":"user","time":{"created":10,"completed":11}}}`))

	ch, stop := s.Subscribe(256)
	defer stop()

	// Observation at T (the fetch): the session is genuinely idle — the turn
	// has not started yet. This primes the latch (and proves the TOCTOU fix
	// holds even when a PRIOR idle observation set the latch — the hard case
	// the two-observation rule alone does not close).
	s.SetActivityFromStatuses(map[string]json.RawMessage{})

	// The turn starts between fetch and apply: the assistant row lands and
	// escalates activity to busy — the LIVE busy signal the fetch missed.
	s.Apply(ev("message.updated", `{"info":{"id":"ta1","sessionID":"`+sid+`","role":"assistant","time":{"created":20}}}`))
	if a := gateActivity(s, sid); a != ActivityBusy {
		t.Fatalf("seed: activity = %q, want busy (the live escalation the fetch missed)", a)
	}

	// CRUX — the STALE snapshot (fetched at T) applies late: must NOT mark.
	s.SetActivityFromStatuses(map[string]json.RawMessage{})
	if c, te, syn := orphanState(t, s, sid, "ta1"); c || te != "" || syn {
		t.Fatalf("TOCTOU: stale not-busy snapshot marked a just-started LIVE turn: completed=%v err=%q syn=%v", c, te, syn)
	}

	// Statuses become truthful: the busy observation re-clears the latch and
	// re-adopts running (the turn is streaming).
	s.SetActivityFromStatuses(map[string]json.RawMessage{sid: json.RawMessage(`{"type":"busy"}`)})
	if a := gateActivity(s, sid); a != ActivityBusy {
		t.Fatalf("truthful busy observation: activity = %q, want busy", a)
	}

	// The turn completes NORMALLY: upstream writes the real terminal.
	s.Apply(ev("message.updated", `{"info":{"id":"ta1","sessionID":"`+sid+`","role":"assistant","time":{"created":20,"completed":99},"finish":"stop"}}`))

	// Post-completion observations: the first re-primes the latch; the second
	// WOULD sweep — but the predicate no longer selects the completed entry.
	// No synthetic marker may ever exist on this row.
	s.SetActivityFromStatuses(map[string]json.RawMessage{})
	s.SetActivityFromStatuses(map[string]json.RawMessage{})
	c, te, syn := orphanState(t, s, sid, "ta1")
	if !c || te != "" || syn {
		t.Fatalf("normal completion must stand alone (no synthetic marker): completed=%v err=%q syn=%v", c, te, syn)
	}
	// And nothing emitted this session ever carried the synthetic error name.
	for {
		select {
		case e := <-ch:
			if e.Kind != KindMessageUpsert {
				continue
			}
			var info map[string]any
			if json.Unmarshal(e.Payload, &info) != nil || info["id"] != "ta1" {
				continue
			}
			if errObj, ok := info["error"].(map[string]any); ok && errObj["name"] == InterruptedTurnErrorName {
				t.Fatalf("synthetic marker was EMITTED for a turn that completed normally")
			}
		default:
			return
		}
	}
}

// TestSweepLatchResetsOnBusyObservation pins the reset half of the stability
// gate at the observation source: a busy/retry statuses report between two
// not-busy observations ends the consecutive run, so the next not-busy only
// re-primes (no mark) and only the one after that sweeps.
func TestSweepLatchResetsOnBusyObservation(t *testing.T) {
	s := New(100)
	sid := "sess_sweep_reset"
	mid := seedOrphan(t, s, sid)

	observeNotBusy(s) // observation 1: prime.
	if c, _, _ := orphanState(t, s, sid, mid); c {
		t.Fatalf("obs-1 must not mark")
	}

	// A busy observation (statuses flapped) resets the run.
	s.SetActivityFromStatuses(map[string]json.RawMessage{sid: json.RawMessage(`{"type":"busy"}`)})
	if c, _, _ := orphanState(t, s, sid, mid); c {
		t.Fatalf("busy observation must not mark")
	}

	// Next not-busy: re-prime only — the CRUX (a stale pre-busy observation
	// must not count toward a new run).
	observeNotBusy(s)
	if c, te, _ := orphanState(t, s, sid, mid); c || te != "" {
		t.Fatalf("post-busy not-busy must NOT mark (run was reset): completed=%v err=%q", c, te)
	}

	// Second consecutive not-busy after the reset: sweep fires.
	observeNotBusy(s)
	if c, te, _ := orphanState(t, s, sid, mid); !c || te != InterruptedTurnErrorName {
		t.Fatalf("second consecutive not-busy post-reset must mark: completed=%v err=%q", c, te)
	}
}

// TestSweepRealErrorNotRelabeledSettlesWithPreservedError is the d-F2 pin for
// the currently-missing reverse order: a REAL upstream terminal error row
// (error-without-time.completed body — cached terminalError set, completed
// false) exists BEFORE the sweep. The sweep must NEVER relabel it with
// VHSolaraInterruptedError: it settles the presentation (completed stamped
// alongside the PRESERVED real error — the canonical aborted shape) and
// records no synthesized provenance. The marker-first/error-second supersede
// order is pinned separately (TestSweepRealTerminalSupersedes).
func TestSweepRealErrorNotRelabeledSettlesWithPreservedError(t *testing.T) {
	s := New(100)
	sid := "sess_sweep_realerr"
	s.Apply(ev("session.created", `{"info":{"id":"`+sid+`","title":"RealErr"}}`))
	// The real-error orphan: upstream positively errored the turn but the
	// body lacks time.completed (errorName() set, completed stays false —
	// the upsertMessageLocked terminal-stickiness shape).
	s.Apply(ev("message.updated", `{"info":{"id":"re1","sessionID":"`+sid+`","role":"assistant","time":{"created":20},"error":{"name":"MessageAbortedError","data":{"message":"aborted by operator"}}}}`))
	c, te, syn := orphanState(t, s, sid, "re1")
	if c || te != "MessageAbortedError" || syn {
		t.Fatalf("seed: want (completed=false, err=MessageAbortedError, syn=false), got (%v,%q,%v)", c, te, syn)
	}

	ch, stop := s.Subscribe(256)
	defer stop()

	// The sweep (two consecutive not-busy observations) selects the
	// uncompleted row — and must take the settle arm, not the marker arm.
	sweepClear(s)
	c, te, syn = orphanState(t, s, sid, "re1")
	if !c || te != "MessageAbortedError" || syn {
		t.Fatalf("d-F2: real error relabeled/lost: completed=%v err=%q syn=%v (want completed=true, err=MessageAbortedError, syn=false)", c, te, syn)
	}
	// The merged info keeps the real error block and gains time.completed.
	var info map[string]any
	if err := json.Unmarshal(orphanInfo(t, s, sid, "re1"), &info); err != nil {
		t.Fatalf("info not JSON: %v", err)
	}
	if errObj, ok := info["error"].(map[string]any); !ok || errObj["name"] != "MessageAbortedError" {
		t.Fatalf("info.error must stay the real error: %v", info["error"])
	}
	if timeObj, _ := info["time"].(map[string]any); timeObj == nil || timeObj["completed"] == nil {
		t.Fatalf("settle must stamp time.completed: %v", info["time"])
	}
	// The emit carries the preserved error (what the FE renders).
	sawEmit := false
	for {
		select {
		case e := <-ch:
			if e.Kind != KindMessageUpsert {
				continue
			}
			var m map[string]any
			if json.Unmarshal(e.Payload, &m) != nil || m["id"] != "re1" {
				continue
			}
			sawEmit = true
			if errObj, _ := m["error"].(map[string]any); errObj == nil || errObj["name"] != "MessageAbortedError" {
				t.Fatalf("settle emit lost the real error: %s", e.Payload)
			}
		default:
			goto drained
		}
	}
drained:
	if !sawEmit {
		t.Fatalf("settle emitted no KindMessageUpsert for the settled row")
	}

	// Warm re-serve of the same error-without-completed body (what OpenCode
	// re-serves): the terminal-stickiness arm keeps the settle sticky —
	// completed stays true, the real error stays.
	aborted := `{"id":"re1","sessionID":"` + sid + `","role":"assistant","time":{"created":20},"error":{"name":"MessageAbortedError","data":{"message":"aborted by operator"}}}`
	res := s.SetSessionMessages(sid, []MessageWithParts{{Info: json.RawMessage(aborted)}})
	c, te, syn = orphanState(t, s, sid, "re1")
	if !c || te != "MessageAbortedError" || syn {
		t.Fatalf("warm re-serve un-settled the row: completed=%v err=%q syn=%v", c, te, syn)
	}
	// Convergence bonus: a settled real-error row with zero parts is admitted
	// messages-loaded on the FIRST reconcile (the isTerminalError fast path —
	// unlike the synthetic marker, see the F4 test).
	if res.BlockedByUnconfirmedEmptyNewest {
		t.Fatalf("real-error empty newest must take the terminal fast path (no O5 re-fetch)")
	}
	if !s.IsMessagesLoaded(sid) {
		t.Fatalf("real-error settled row must be admitted loaded on first reconcile")
	}
}

// TestSweepZeroPartOrphanMessagesLoadedAfterTwoReconciles is the a-F1 pin: a
// swept ZERO-PART orphan (completed + VHSolaraInterruptedError, no resident
// parts) takes the O5 confirmedEmptyNewest path — MessagesLoaded /
// IsMessagesLoaded becomes true only after TWO consecutive reconciles observe
// the same empty newest. VHSolaraInterruptedError is DELIBERATELY not in
// isTerminalError (it is our inference, not opencode-positive classification),
// so the terminal fast path does NOT apply and the two-reconcile confirmation
// is the coherent gate transition. The first reconcile reports
// BlockedByUnconfirmedEmptyNewest — the aggregator's ONE bounded re-fetch
// signal — and the second confirms.
func TestSweepZeroPartOrphanMessagesLoadedAfterTwoReconciles(t *testing.T) {
	s := New(100)
	sid := "sess_sweep_loaded"
	s.Apply(ev("session.created", `{"info":{"id":"`+sid+`","title":"Loaded"}}`))
	// Zero-part orphan: uncompleted assistant, NO parts ever streamed.
	s.Apply(ev("message.updated", `{"info":{"id":"zl1","sessionID":"`+sid+`","role":"assistant","time":{"created":20}}}`))

	// Sweep (two not-busy observations) → completed + synthetic marker.
	sweepClear(s)
	c, te, _ := orphanState(t, s, sid, "zl1")
	if !c || te != InterruptedTurnErrorName {
		t.Fatalf("seed: marker missing (completed=%v err=%q)", c, te)
	}
	if s.IsMessagesLoaded(sid) {
		t.Fatalf("session must not be messages-loaded before any reconcile")
	}

	// Upstream re-serves the uncompleted row forever (the orphan's signature).
	stale := MessageWithParts{Info: json.RawMessage(`{"id":"zl1","sessionID":"` + sid + `","role":"assistant","time":{"created":20}}`)}

	// Reconcile 1: pending sighting — NOT loaded, blocked (aggregator
	// re-fetch signal fires), marker sticky.
	r1 := s.SetSessionMessages(sid, []MessageWithParts{stale})
	if !r1.BlockedByUnconfirmedEmptyNewest {
		t.Fatalf("reconcile 1 must report BlockedByUnconfirmedEmptyNewest (the bounded re-fetch signal)")
	}
	if s.IsMessagesLoaded(sid) {
		t.Fatalf("reconcile 1 must NOT admit messages-loaded (unconfirmed empty newest)")
	}
	if c, te, _ := orphanState(t, s, sid, "zl1"); !c || te != InterruptedTurnErrorName {
		t.Fatalf("reconcile 1 dropped the marker: completed=%v err=%q", c, te)
	}

	// Reconcile 2: same empty newest seen again → confirmed source truth →
	// CRUX: the gate flips to loaded.
	r2 := s.SetSessionMessages(sid, []MessageWithParts{stale})
	if r2.BlockedByUnconfirmedEmptyNewest {
		t.Fatalf("reconcile 2 must confirm (no further re-fetch signal)")
	}
	if !s.IsMessagesLoaded(sid) {
		t.Fatalf("CRUX: IsMessagesLoaded must become true after the second reconcile post-sweep")
	}
	// Marker still sticky after both reconciles.
	if c, te, _ := orphanState(t, s, sid, "zl1"); !c || te != InterruptedTurnErrorName {
		t.Fatalf("reconcile 2 dropped the marker: completed=%v err=%q", c, te)
	}
}
