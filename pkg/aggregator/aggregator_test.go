package aggregator

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
)

// A daemon restart rebuilds the store from a fresh hydrate. Pending questions
// only ever arrive as live events, so hydrate must re-fetch them from
// GET /question — otherwise a question the user still needs to answer vanishes.
func TestHydrateRecoversPendingQuestion(t *testing.T) {
	oc := httptest.NewServer(fixtures.New().Handler())
	defer oc.Close()

	// Raise a pending question on the demo session ([[ask]] pauses the turn).
	resp, err := http.Post(oc.URL+"/session/demo/message", "application/json",
		strings.NewReader(`{"parts":[{"type":"text","text":"[[ask]]"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	// The turn runs async; wait until the question is actually pending.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		r, err := http.Get(oc.URL + "/question")
		if err == nil {
			var qs []json.RawMessage
			_ = json.NewDecoder(r.Body).Decode(&qs)
			r.Body.Close()
			if len(qs) > 0 {
				break
			}
		}
		time.Sleep(20 * time.Millisecond)
	}

	// A FRESH aggregator (as after a daemon restart) must recover it via hydrate.
	agg := New(oc.URL, 100)
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	if got := agg.Store().Snapshot(nil).Questions; len(got) == 0 {
		t.Fatal("expected hydrate to recover the pending question, got none")
	}
}

// A cold tree (fresh daemon, no session opened) must still render per-agent
// chips. hydrate fetches a lightweight message tail per un-opened session and
// seeds lastAgent — the tree snapshot carries no messages, so without this the
// chip would stay empty until a session is opened. The demo fixture seeds
// assistant turns m2=build, m4=plan, m6=build (newest); sub seeds sm1=general.
func TestHydrateSeedsColdLastAgents(t *testing.T) {
	oc := httptest.NewServer(fixtures.New().Handler())
	defer oc.Close()

	agg := New(oc.URL, 100)
	if err := agg.Rehydrate(context.Background()); err != nil {
		t.Fatalf("rehydrate: %v", err)
	}
	snap := agg.Store().Snapshot(nil)
	// On a fresh aggregator, demo is NOT in LoadedSessions() — the cold path
	// (tail fetch) must seed its lastAgent from the newest assistant message.
	if got := snap.LastAgents["demo"]; got != "build" {
		t.Fatalf("cold demo lastAgent: want 'build' (newest assistant m6), got %q", got)
	}
	if got := snap.LastAgents["sub"]; got != "general" {
		t.Fatalf("cold sub lastAgent: want 'general' (sm1), got %q", got)
	}
}
