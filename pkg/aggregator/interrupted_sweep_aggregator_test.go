package aggregator

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// orphanMarker reads the terminal marker of the newest assistant message of
// sid straight out of a store snapshot: (completed?, error.name). The
// interrupted-turn sweep merges its synthesized terminal into the message
// info bytes (time.completed + error.name), so the snapshot info carries it.
func orphanMarker(t *testing.T, store *state.Store, sid, mid string) (bool, string) {
	t.Helper()
	snap := store.Snapshot(nil)
	list, ok := snap.Messages[sid]
	if !ok {
		return false, ""
	}
	for _, mwp := range list {
		var env struct {
			ID   string `json:"id"`
			Time struct {
				Completed *float64 `json:"completed"`
			} `json:"time"`
			Error *struct {
				Name string `json:"name"`
			} `json:"error"`
		}
		if err := json.Unmarshal(mwp.Info, &env); err != nil {
			continue
		}
		if env.ID == mid {
			name := ""
			if env.Error != nil {
				name = env.Error.Name
			}
			return env.Time.Completed != nil, name
		}
	}
	return false, ""
}

// TestSweepAuthoritativeOnlyAggregator pins the HARD EDGE of the
// interrupted-turn sweep (P1-API-007 layer b): a FAILED /session/status fetch
// (dead OpenCode, tunnel blip) must NOT synthesize the interrupted marker —
// only a live instance AUTHORITATIVELY reporting the session not-busy may.
//
// The authoritative-only property is structural: runStatusReconcile only
// routes SUCCESSFUL fetches into store.SetActivityFromStatuses, whose
// clear-activity path runs the sweep. This test exercises the REAL chain
// (reconcile ticker → fetch → store) against a mux fake whose
// /session/status flips from 500 to 200 {}, mirroring
// TestRunStatusReconcileHealsStaleBusy's isolation setup (held-open /event so
// no re-hydrate interferes; 5ms reconcile interval).
//
// Phase 1 (500s): the orphaned in-flight assistant (created, no completed,
// no error — exactly what a mid-turn process kill leaves) must stay UNMARKED
// across several failed ticks.
// Phase 2 (200 {}): the clear path must sweep and mark it interrupted.
func TestSweepAuthoritativeOnlyAggregator(t *testing.T) {
	var statusesFailing atomic.Bool
	var failedFetches atomic.Int64
	statusesFailing.Store(true)

	mux := http.NewServeMux()
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("[]"))
	})
	mux.HandleFunc("/session/status", func(w http.ResponseWriter, r *http.Request) {
		if statusesFailing.Load() {
			failedFetches.Add(1)
			http.Error(w, "simulated opencode down", http.StatusInternalServerError)
			return
		}
		// Authoritative: nothing is busy.
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte("{}"))
	})
	// Hold the event stream open so NO reconnect/re-hydrate fires within the
	// test window — the reconcile ticker is the only sweep trigger here.
	mux.HandleFunc("/event", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		if fl, ok := w.(http.Flusher); ok {
			fl.Flush()
		}
		<-r.Context().Done()
	})
	mux.Handle("/", fixtures.New().Handler())

	oc := httptest.NewServer(mux)
	defer oc.Close()

	agg := New(oc.URL, 100)
	agg.statusReconcileInterval = 5 * time.Millisecond
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.RunManaged(ctx)

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) && !agg.AnyHydrateCompleted() {
		time.Sleep(2 * time.Millisecond)
	}
	if !agg.AnyHydrateCompleted() {
		t.Fatal("aggregator never completed initial hydrate")
	}
	agg.waitColdSeed()

	// Seed the restart-kill residue AFTER hydrate: a session whose newest
	// assistant message has no completed and no error. (No busy status — the
	// clear path sweeps regardless of prior activity state.)
	store := agg.Store()
	applyEvent := func(typ, props string) {
		store.Apply(opencode.Event{Type: typ, Properties: json.RawMessage(props)})
	}
	applyEvent("session.created", `{"info":{"id":"ghost"}}`)
	applyEvent("message.updated", `{"info":{"id":"oa1","sessionID":"ghost","role":"user","time":{"created":100.0,"completed":101.0}}}`)
	applyEvent("message.updated", `{"info":{"id":"oa2","sessionID":"ghost","role":"assistant","time":{"created":102.0}}}`)

	// Phase 1: several FAILED ticks must leave the orphan unmarked.
	failDeadline := time.Now().Add(1 * time.Second)
	for time.Now().Before(failDeadline) && failedFetches.Load() < 5 {
		time.Sleep(2 * time.Millisecond)
	}
	if got := failedFetches.Load(); got < 5 {
		t.Fatalf("reconcile ticker did not attempt enough failed fetches: %d (want >=5)", got)
	}
	completed, errName := orphanMarker(t, store, "ghost", "oa2")
	if completed || errName == state.InterruptedTurnErrorName {
		t.Fatalf("FAILED statuses fetch must not mark the in-flight turn interrupted: completed=%v error.name=%q", completed, errName)
	}

	// Phase 2: flip the instance live + not-busy → the clear path sweeps.
	statusesFailing.Store(false)
	healDeadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(healDeadline) {
		completed, errName = orphanMarker(t, store, "ghost", "oa2")
		if completed && errName == state.InterruptedTurnErrorName {
			break
		}
		time.Sleep(2 * time.Millisecond)
	}
	if !completed || errName != state.InterruptedTurnErrorName {
		t.Fatalf("authoritative not-busy statuses did not mark the orphan: completed=%v error.name=%q (want %q)", completed, errName, state.InterruptedTurnErrorName)
	}
}
