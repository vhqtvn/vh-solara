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

	// Mark via the clear path.
	s.SetActivityFromStatuses(map[string]json.RawMessage{})
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
	s.SetActivityFromStatuses(map[string]json.RawMessage{})
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
	s.SetActivityFromStatuses(map[string]json.RawMessage{})

	// (a) real completion via the live path.
	s.Apply(ev("message.updated", `{"info":{"id":"`+mid+`","sessionID":"`+sid+`","role":"assistant","time":{"created":20,"completed":99}}}`))
	if c, te, syn := orphanState(t, s, sid, mid); !c || te != "" || syn {
		t.Fatalf("real completion must clear marker: completed=%v err=%q syn=%v", c, te, syn)
	}

	// (b) upstream error via the warm path: re-plant a marker, then a fetched
	// body carrying MessageAbortedError.
	sid2 := "sess_sweep_real2"
	mid2 := seedOrphan(t, s, sid2)
	s.SetActivityFromStatuses(map[string]json.RawMessage{})
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
	s.SetActivityFromStatuses(map[string]json.RawMessage{})
	infoBefore := orphanInfo(t, s, sid, mid)

	ch, stop := s.Subscribe(256)
	defer stop()
	for i := 0; i < 3; i++ {
		s.SetActivityFromStatuses(map[string]json.RawMessage{})
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

	// Authoritative clear: settles the stop (abort-settling gate opens) and
	// marks the orphan in the same closure.
	s.SetActivityFromStatuses(map[string]json.RawMessage{})
	c, te, _ := orphanState(t, s, sid, mid)
	if !c || te != InterruptedTurnErrorName {
		t.Fatalf("abort-settle clear: marker missing (completed=%v err=%q)", c, te)
	}
	s.mu.RLock()
	ts := s.turnState[sid]
	settled := !s.abortSettling[sid]
	s.mu.RUnlock()
	if ts != TurnIdle || !settled {
		t.Fatalf("abort-settle clear: turnState=%v abortSettling-open=%v, want TurnIdle/settled", ts, settled)
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
	// Authoritative clear with the stale TurnRunning still set.
	s.SetActivityFromStatuses(map[string]json.RawMessage{})
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
}
