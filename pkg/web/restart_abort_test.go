package web

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/oclife"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// P1-API-007 layer (a): BOTH restart entries must abort in-flight turns
// (the /vh/abort choreography) BEFORE killing the OpenCode process, so
// OpenCode itself writes each turn's real terminal. Layer (b) — the
// store-side interrupted-marker sweep — heals whatever the bounded abort
// could not close. These tests pin both halves against the two HTTP entries.

// seedRunningOrphan seeds session sid on agg's store as a running turn whose
// newest assistant message is uncompleted — the exact mid-turn residue a
// UI-triggered restart interrupts.
func seedRunningOrphan(t *testing.T, agg *aggregator.Aggregator, sid string) {
	t.Helper()
	s := agg.Store()
	for _, e := range busyEvents(sid) {
		s.Apply(e)
	}
	s.Apply(ev("message.updated", `{"info":{"id":"u1","sessionID":"`+sid+`","role":"user","time":{"created":100.0,"completed":101.0}}}`))
	s.Apply(ev("message.updated", `{"info":{"id":"a1","sessionID":"`+sid+`","role":"assistant","time":{"created":102.0}}}`))
	if got := s.InflightAssistantID(sid); got != "a1" {
		t.Fatalf("seed: InflightAssistantID=%q, want a1", got)
	}
	if ids := s.RunningSessionIDs(); len(ids) != 1 || ids[0] != sid {
		t.Fatalf("seed: RunningSessionIDs=%v, want [%s]", ids, sid)
	}
}

// orphanMarked reports whether the uncompleted assistant a1 carries the
// synthesized interrupted terminal (time.completed + our error.name) in the
// store snapshot — the public observation surface for layer (b).
func orphanMarked(t *testing.T, store *state.Store, sid string) bool {
	t.Helper()
	for _, mwp := range store.Snapshot(nil).Messages[sid] {
		var env struct {
			ID   string `json:"id"`
			Time struct {
				Completed *float64 `json:"completed"`
			} `json:"time"`
			Error *struct {
				Name string `json:"name"`
			} `json:"error"`
		}
		if err := json.Unmarshal(mwp.Info, &env); err != nil || env.ID != "a1" {
			continue
		}
		return env.Time.Completed != nil && env.Error != nil && env.Error.Name == state.InterruptedTurnErrorName
	}
	return false
}

// TestRestartAbortsInflightBeforeRestart drives BOTH restart routes against a
// server whose aggregator holds one running orphan turn and asserts the full
// layer-(a) contract: exactly one Abort per running session, issued BEFORE
// restartOC runs; on Abort success the verbs.go choreography continues
// (InflightAssistantID → Store.Stop), leaving the turn in the
// TurnStopping/abort-settling window rather than silently killed.
func TestRestartAbortsInflightBeforeRestart(t *testing.T) {
	for _, route := range []string{"/vh/opencode/restart", "/vh/restart-opencode"} {
		t.Run(route, func(t *testing.T) {
			f := &fakeOC{}
			web, agg, srv := newVerbServerSrv(t, f)

			life := oclife.New(oclife.TopologyOwned)
			life.SetReady()
			srv.SetOpenCodeLifecycle(life)

			hookCalled := false
			abortedBeforeHook := false
			srv.SetRestartOpenCode(func(ctx context.Context) error {
				hookCalled = true
				abortedBeforeHook = f.abortCount() >= 1
				life.SetStarting()
				life.SetReady()
				return nil
			})

			seedRunningOrphan(t, agg, "s1")

			st, _, _ := post(t, web.URL+route, "", nil)
			if st != 200 {
				t.Fatalf("POST %s: status %d, want 200", route, st)
			}
			if !hookCalled {
				t.Fatal("restart hook was not called")
			}
			if !abortedBeforeHook {
				t.Fatal("restart hook ran before the in-flight abort — abortInflightBeforeRestart ordering broken")
			}
			if got := f.abortCount(); got != 1 {
				t.Fatalf("abort attempts = %d, want exactly 1", got)
			}
			// Abort succeeded → the verb's settle path ran: the turn is
			// stopping (not silently killed), gate armed for the follow-up.
			store := agg.Store()
			if ts := store.TurnState("s1"); ts != state.TurnStopping {
				t.Fatalf("post-restart TurnState = %q, want %q (Store.Stop not threaded after Abort)", ts, state.TurnStopping)
			}
			if !store.AbortSettling("s1") {
				t.Fatal("post-restart AbortSettling = false, want true (fail-closed gate armed by Stop)")
			}
			// The message itself is still uncompleted here: the REAL terminal
			// is written upstream by OpenCode's abort handling (or, failing
			// that, by the layer-(b) sweep after the statuses clear).
			if got := store.InflightAssistantID("s1"); got != "a1" {
				t.Fatalf("post-restart InflightAssistantID = %q, want a1 (Stop must not synthesize a terminal)", got)
			}
		})
	}
}

// TestRestartHungAbortStillRestartsAndSweepHeals pins the operator's
// "abort itself cannot complete" case: when OpenCode's Abort RPC HANGS, the
// pre-restart sweep must give up within its bounded budget (restart never
// blocks), must NOT run Store.Stop (the verbs.go Abort-error early-return
// semantics), and the turn must still be healed afterwards by the layer-(b)
// interrupted-marker sweep once the restarted instance authoritatively
// reports the session not-busy.
func TestRestartHungAbortStillRestartsAndSweepHeals(t *testing.T) {
	f := &fakeOC{
		abortHold:    make(chan struct{}),
		abortReached: make(chan struct{}, 1),
	}
	web, agg, srv := newVerbServerSrv(t, f)
	// Release the parked abort handler BEFORE the fake server's Close cleanup
	// (LIFO: registered after newVerbServerSrv → runs before it).
	t.Cleanup(func() { close(f.abortHold) })

	life := oclife.New(oclife.TopologyOwned)
	life.SetReady()
	srv.SetOpenCodeLifecycle(life)

	hookCalled := false
	srv.SetRestartOpenCode(func(ctx context.Context) error {
		hookCalled = true
		life.SetStarting()
		life.SetReady()
		return nil
	})

	// Shrink the sweep bounds so the test proves the MECHANISM (budget
	// expiry → proceed) without waiting the production 2s/5s.
	srv.restartAbortPerCall = 30 * time.Millisecond
	srv.restartAbortBudget = 120 * time.Millisecond

	seedRunningOrphan(t, agg, "s1")

	start := time.Now()
	st, _, _ := post(t, web.URL+"/vh/opencode/restart", "", nil)
	elapsed := time.Since(start)
	if st != 200 {
		t.Fatalf("POST /vh/opencode/restart: status %d, want 200", st)
	}
	if !hookCalled {
		t.Fatal("restart hook was not called — a hung abort blocked the restart")
	}
	// The restart completed within (well under) the shrunk budget plus
	// request overhead — i.e. the sweep expired instead of hanging forever.
	if budgetCap := srv.restartAbortBudget + 2*time.Second; elapsed > budgetCap {
		t.Fatalf("restart took %v, want < %v (hung abort must never block restart)", elapsed, budgetCap)
	}
	// The Abort WAS attempted (the fake parked inside the handler).
	select {
	case <-f.abortReached:
	default:
		t.Fatal("abort was never attempted")
	}
	// Hung Abort → Abort-error path → NO Store.Stop (verb early-return mirror):
	// the turn stays TurnRunning, not TurnStopping.
	store := agg.Store()
	if ts := store.TurnState("s1"); ts != state.TurnRunning {
		t.Fatalf("post-restart TurnState = %q, want %q (hung abort must not Stop)", ts, state.TurnRunning)
	}
	if store.AbortSettling("s1") {
		t.Fatal("post-restart AbortSettling = true, want false (no Stop on hung abort)")
	}

	// AFTERMATH — the restarted instance comes up and authoritatively
	// reports nothing busy (the real chain: reconcile/hydrate statuses fetch
	// → SetActivityFromStatuses clear path; here driven through the same
	// public store entry the successful fetch uses).
	store.SetActivityFromStatuses(map[string]json.RawMessage{})

	healDeadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(healDeadline) && !orphanMarked(t, store, "s1") {
		time.Sleep(2 * time.Millisecond)
	}
	if !orphanMarked(t, store, "s1") {
		t.Fatal("interrupted-marker sweep did not heal the turn the hung abort could not close")
	}
	if got := store.InflightAssistantID("s1"); got != "" {
		t.Fatalf("post-heal InflightAssistantID = %q, want empty (turn closed)", got)
	}
	// NOTE: turnState is deliberately NOT asserted idle here — the clear path
	// predates this slice and normalizes only TurnStopping; a stale TurnRunning
	// on an idle-activity session is the store's existing posture and drives
	// nothing. The load-bearing closure signals are the marker + the empty
	// in-flight id + the gate activity:
	if g, ok := store.Snapshot(nil).Gate["s1"]; !ok || g.Activity != "idle" {
		t.Fatalf("post-heal gate activity = %+v (ok=%v), want idle", g, ok)
	}
}
