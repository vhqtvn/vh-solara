package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// busyEvents returns the event pair that flips a root session to busy
// (session.created then session.status type=busy). Used to seed a store's
// busyCount so RunningRoots() reports it as running.
func busyEvents(id string) []opencode.Event {
	return []opencode.Event{
		{Type: "session.created", Properties: json.RawMessage(`{"info":{"id":"` + id + `"}}`)},
		{Type: "session.status", Properties: json.RawMessage(`{"sessionID":"` + id + `","status":{"type":"busy"}}`)},
	}
}

// TestHandleRunningSessions covers the /vh/running-sessions handler: it sums
// per-aggregator RunningRoots() across every entry in s.aggs, emits one
// {Dir,Count} workspace per non-empty aggregator, and sorts workspaces by Dir.
// NewServer seeds s.aggs with the default workspace keyed "".
func TestHandleRunningSessions(t *testing.T) {
	const deadURL = "http://127.0.0.1:1"
	srv, err := NewServer(aggregator.New(deadURL, 100), deadURL, 100)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	// Register a SECOND workspace aggregator under /proj so the handler
	// exercises multi-aggregator aggregation AND Dir-sorting ("" < "/proj").
	projAgg := aggregator.New(deadURL, 100)
	srv.aggs["/proj"] = projAgg

	// Seed busy state directly through each aggregator's store:
	//   • default workspace (""): one busy root → RunningRoots()=1
	//   • /proj: two busy roots → RunningRoots()=2
	for _, e := range busyEvents("d1") {
		srv.agg.Store().Apply(e)
	}
	for _, id := range []string{"p1", "p2"} {
		for _, e := range busyEvents(id) {
			projAgg.Store().Apply(e)
		}
	}

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	resp, err := http.Get(web.URL + "/vh/running-sessions")
	if err != nil {
		t.Fatalf("GET /vh/running-sessions: %v", err)
	}
	defer resp.Body.Close()
	var out runningSessionsResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}

	// Total count = 1 (default) + 2 (/proj) = 3.
	if out.Count != 3 {
		t.Fatalf("count want 3, got %d", out.Count)
	}
	// Workspaces sorted by Dir asc: "" < "/proj".
	if len(out.Workspaces) != 2 {
		t.Fatalf("want 2 workspaces, got %d: %+v", len(out.Workspaces), out.Workspaces)
	}
	if out.Workspaces[0].Dir != "" || out.Workspaces[0].Count != 1 {
		t.Fatalf("workspace[0] want {\"\" 1}, got %+v", out.Workspaces[0])
	}
	if out.Workspaces[1].Dir != "/proj" || out.Workspaces[1].Count != 2 {
		t.Fatalf("workspace[1] want {/proj 2}, got %+v", out.Workspaces[1])
	}
}

// TestHandleRunningSessionsEmpty covers the idle fleet: no busy roots across
// any workspace → count 0 and an empty workspaces slice. This is the common
// case (the restart-confirm warning reads "0 running sessions").
func TestHandleRunningSessionsEmpty(t *testing.T) {
	srv := newTestServer(t)
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	resp, err := http.Get(web.URL + "/vh/running-sessions")
	if err != nil {
		t.Fatalf("GET /vh/running-sessions: %v", err)
	}
	defer resp.Body.Close()
	var out runningSessionsResp
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if out.Count != 0 {
		t.Fatalf("idle fleet count want 0, got %d", out.Count)
	}
	if len(out.Workspaces) != 0 {
		t.Fatalf("idle fleet want no workspaces, got %v", out.Workspaces)
	}
}
