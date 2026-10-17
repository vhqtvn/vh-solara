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
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// TestSessionCreatedReseedsLastAgentAfterReset pins the serial-lane chip
// regression (web e2e tree2-symptoms (c)): a scoped /fixture/reset emits
// session.deleted + session.created for the SAME id; the delete wipes the
// whole store entry — including the cold-seeded lastAgent and the seeded memo
// (the documented re-seed intent at reducers.go deleteSessionLocked) — and the
// re-created entry got NO re-seed, because startColdSeed runs only from
// hydrate. A daemon that stays connected (the serial web-e2e lane shape: the
// aggregator hydrated once on the first page load and never reconnects) never
// rehydrates, so the per-agent chip on the reset session stayed empty for
// every later consumer. The fix: applying a live session.created triggers a
// single-id background re-seed.
//
// The red/green discriminator is EVENT-ORDERED, not value-based: the reseeded
// value ("build") equals the pre-reset value, so observing the snapshot
// converge back to "build" alone could pass on the stale pre-delete value.
// We subscribe BEFORE the reset, require the KindSessionDelete for demo to be
// observed FIRST, and only then require demo's lastAgent to return — via the
// live KindLastAgentSet event or the snapshot.
func TestSessionCreatedReseedsLastAgentAfterReset(t *testing.T) {
	oc := httptest.NewServer(fixtures.New().Handler())
	defer oc.Close()

	agg := New(oc.URL, 100)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go agg.Run(ctx) // live SSE; no rehydrate happens later in this test

	// Subscribe BEFORE the reset so the ordering probe cannot miss events.
	ch, unsub := agg.Store().Subscribe(128)
	defer unsub()

	demoLastAgent := func() string {
		return agg.Store().Snapshot(nil).LastAgents["demo"]
	}

	// 1. Initial cold seed: demo's newest assistant m6 is agent "build".
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) && demoLastAgent() != "build" {
		time.Sleep(25 * time.Millisecond)
	}
	if got := demoLastAgent(); got != "build" {
		t.Fatalf("initial cold seed: demo lastAgent want 'build', got %q", got)
	}
	// Drain anything the initial seed put on the channel so step 3 only sees
	// post-reset events.
	for {
		select {
		case <-ch:
			continue
		default:
		}
		break
	}

	// 2. The reset a prior-in-lane spec issues (scoped form, e.g.
	// scroll-follow's cleanup of `slow`; demo here stands in for it).
	resp, err := http.Post(oc.URL+"/fixture/reset?session=demo",
		"application/json", strings.NewReader(""))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("fixture reset: status %d", resp.StatusCode)
	}

	// 3. Observe the wipe land (session.delete for demo) — proves the event
	// path processed the reset; without this the final assertion could pass
	// on the stale pre-reset value.
	sawDelete := false
	deadline = time.Now().Add(5 * time.Second)
	for !sawDelete && time.Now().Before(deadline) {
		select {
		case e := <-ch:
			if e.Kind == state.KindSessionDelete {
				var p struct {
					ID string `json:"id"`
				}
				if json.Unmarshal(e.Payload, &p) == nil && p.ID == "demo" {
					sawDelete = true
				}
			}
		case <-time.After(25 * time.Millisecond):
		}
	}
	if !sawDelete {
		t.Fatal("session.delete for demo never arrived on the store stream")
	}

	// 4. THE CONTRACT: after the delete, the re-created demo entry must get
	// its lastAgent re-seeded (live lastAgent.set event; the snapshot is the
	// fallback confirmation). Pre-fix this times out — the chip stays empty.
	reseeded := false
	deadline = time.Now().Add(5 * time.Second)
	for !reseeded && time.Now().Before(deadline) {
		select {
		case e := <-ch:
			if e.Kind == state.KindLastAgentSet {
				var p struct {
					SessionID string `json:"sessionID"`
					Agent     string `json:"agent"`
				}
				if json.Unmarshal(e.Payload, &p) == nil && p.SessionID == "demo" && p.Agent == "build" {
					reseeded = true
				}
			}
		case <-time.After(25 * time.Millisecond):
			if demoLastAgent() == "build" {
				reseeded = true
			}
		}
	}
	if !reseeded {
		t.Fatal("session.created re-seed: demo lastAgent not restored after reset " +
			"(per-agent chip regression: connected daemons never re-hydrate, so the " +
			"reset session's chip stays empty for every later consumer)")
	}
}
