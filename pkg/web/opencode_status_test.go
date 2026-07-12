package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/oclife"
)

// TestOpenCodeStatusFailedLifecycle is validation #2 for p1-oc-001 Slice 1:
// the worker's web server must construct + serve even when the OpenCode URL is
// unreachable (decoupling), and /vh/opencode/status must report the failed
// lifecycle state WITHOUT contacting OpenCode (the endpoint serves from the
// worker's own memory). The construction itself does not dial OpenCode (the
// aggregator + reverse proxy are lazy), so this neither crashes nor hangs.
func TestOpenCodeStatusFailedLifecycle(t *testing.T) {
	// Port 1 is privileged + almost certainly refused: stands in for a dead /
	// crashed OpenCode that the worker could NOT reach at startup. The point is
	// that the worker serves anyway.
	const deadURL = "http://127.0.0.1:1"

	srv, err := NewServer(aggregator.New(deadURL, 100), deadURL, 100)
	if err != nil {
		t.Fatalf("NewServer with dead OpenCode URL: %v", err)
	}
	life := oclife.New(oclife.TopologyOwned)
	life.SetOpenCodeURL(deadURL)
	exitCode := 127 // "command not found" style
	life.SetFailed("opencode binary not found: exec: \"opencode\": executable file not found in $PATH", &exitCode)
	srv.SetOpenCodeLifecycle(life)

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	// The worker's own health must be reachable even though OpenCode is dead —
	// this is the core decoupling assertion (the worker is NOT OpenCode).
	res, err := http.Get(web.URL + "/vh/healthz")
	if err != nil {
		t.Fatalf("GET /vh/healthz: %v", err)
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Errorf("/vh/healthz status = %d, want 200 (worker must be healthy even with OpenCode dead)", res.StatusCode)
	}

	// /vh/opencode/status must answer 200 with the failed lifecycle — served
	// DIRECTLY, no OpenCode dial. A 502 here would mean the endpoint fell
	// through to the reverse proxy (route-ordering bug); a hang would mean it
	// tried to dial the dead URL.
	res, err = http.Get(web.URL + "/vh/opencode/status")
	if err != nil {
		t.Fatalf("GET /vh/opencode/status: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("/vh/opencode/status status = %d, want 200", res.StatusCode)
	}

	var snap oclife.Snapshot
	if err := json.NewDecoder(res.Body).Decode(&snap); err != nil {
		t.Fatalf("decode status snapshot: %v", err)
	}
	if snap.State != oclife.StateFailed {
		t.Errorf("state = %q, want %q", snap.State, oclife.StateFailed)
	}
	if snap.Topology != oclife.TopologyOwned {
		t.Errorf("topology = %q, want %q", snap.Topology, oclife.TopologyOwned)
	}
	if snap.FailureSummary == "" {
		t.Error("failure_summary is empty; want the startup failure detail")
	}
	if snap.ExitCode == nil || *snap.ExitCode != exitCode {
		got := "<nil>"
		if snap.ExitCode != nil {
			got = strconv.Itoa(*snap.ExitCode)
		}
		t.Errorf("exit_code = %v, want %d", got, exitCode)
	}
	// Owned topology must advertise the full capability set so Slice 2's
	// /vh/opencode/logs + /restart can branch on shape.
	if !snap.Capabilities.CanRestart || !snap.Capabilities.HasProcessOutput ||
		!snap.Capabilities.HasLogTail || !snap.Capabilities.HasExitStatus {
		t.Errorf("owned capabilities = %+v, want all true", snap.Capabilities)
	}
	if snap.DiagnosticCompleteness != oclife.DiagComplete {
		t.Errorf("diagnostic_completeness = %q, want %q", snap.DiagnosticCompleteness, oclife.DiagComplete)
	}
}

// TestOpenCodeStatusNilLifecycle covers the fixture/local-mode posture: a
// server that does NOT manage an OpenCode lifecycle (e.g. the fixture server,
// or a worker started before the topology arm wired one) must return 503
// (Service Unavailable) rather than 200-with-empty or a nil-dereference panic.
// This is distinct from OpenCode being failed (which is 200 + state=failed).
func TestOpenCodeStatusNilLifecycle(t *testing.T) {
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatal(err)
	}
	// Deliberately do NOT call SetOpenCodeLifecycle → ocLifecycle stays nil.
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	res, err := http.Get(web.URL + "/vh/opencode/status")
	if err != nil {
		t.Fatalf("GET /vh/opencode/status: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusServiceUnavailable {
		t.Errorf("nil-lifecycle status = %d, want 503", res.StatusCode)
	}
}
