package e2e

// fleet_status_e2e_test.go — lane-3 proof for GET /vh/fleet/status (S2 of
// task-2026-09-25-…-compact-readonly-fleet-status-rollup-api-controller).
//
// This drives the endpoint through the SHARED cluster's REAL stack end to
// end: HTTP request → controller user edge (userMux + auth chain) → daemon
// fleet-status service → Proxy.FetchWorkerJSONBounded → real yamux tunnel →
// agent raw-proxy → the worker's REAL pkg/web server (/vh/projects discovery
// + per-project tree-only /vh/snapshot) → aggregation back into the rollup.
//
// The lane-1 suite (pkg/server/status_test.go) pins the rollup semantics with
// the acquisition seam faked; this test pins that the REAL acquisition path
// feeds it: the worker must come back `ok` (both /vh/projects and
// /vh/snapshot answered through the tunnel inside the budgets), coverage must
// be complete within the discovered scope, and overall must equal
// known_overall. It also exercises ETag/304 over real HTTP.

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestE2E_FleetStatusRollupThroughRealTunnel(t *testing.T) {
	// 1. First GET: full rollup through the real tunnel.
	resp, body, err := cluster.Do(http.MethodGet, "/vh/fleet/status", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("GET /vh/fleet/status -> %d: %s", resp.StatusCode, body)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("fleet status: want 200, got %d: %s", resp.StatusCode, body)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("fleet status: want application/json, got %q", ct)
	}
	etag := resp.Header.Get("ETag")
	if etag == "" {
		t.Fatalf("fleet status: missing ETag")
	}

	var status struct {
		Schema       int    `json:"schema"`
		Overall      string `json:"overall"`
		KnownOverall string `json:"known_overall"`
		Summary      string `json:"summary"`
		Coverage     struct {
			Mode            string `json:"mode"`
			InventoryKnown  bool   `json:"inventory_known"`
			Complete        bool   `json:"complete"`
			ProjectScope    string `json:"project_scope"`
			RequiredWorkers int    `json:"required_workers"`
			ObservedWorkers int    `json:"observed_workers"`
			UnknownWorkers  int    `json:"unknown_workers"`
		} `json:"coverage"`
		Conditions []struct {
			Kind  string  `json:"kind"`
			Count int     `json:"count"`
			Since *string `json:"since"`
			Label string  `json:"label"`
			Link  *string `json:"link"`
		} `json:"conditions"`
		Workers []struct {
			ID         string  `json:"id"`
			Status     string  `json:"status"`
			ObservedAt *string `json:"observed_at"`
		} `json:"workers"`
		GeneratedAt    string `json:"generated_at"`
		MaxStalenessMS int64  `json:"max_staleness_ms"`
	}
	if err := json.Unmarshal(body, &status); err != nil {
		t.Fatalf("fleet status: body not JSON: %v (%s)", err, body)
	}

	if status.Schema != 1 {
		t.Fatalf("schema: want 1, got %d", status.Schema)
	}
	// The real acquisition must succeed: discovery + snapshot through the
	// tunnel within budgets ⇒ worker `ok` and COMPLETE discovered coverage.
	if len(status.Workers) != 1 || status.Workers[0].ID != cluster.WorkerID {
		t.Fatalf("workers: want exactly [%s], got %+v", cluster.WorkerID, status.Workers)
	}
	if w := status.Workers[0]; w.Status != "ok" || w.ObservedAt == nil {
		t.Fatalf("worker %s: want ok with observed_at through the real tunnel, got %+v", cluster.WorkerID, w)
	}
	if status.Coverage.Mode != "discovered" || status.Coverage.InventoryKnown {
		t.Fatalf("coverage mode: want discovered, got %+v", status.Coverage)
	}
	if status.Coverage.ProjectScope != "instantiated" {
		t.Fatalf("project_scope: want instantiated, got %q", status.Coverage.ProjectScope)
	}
	if !status.Coverage.Complete {
		t.Fatalf("real-stack coverage must be complete (1/1 observed): %+v overall=%s", status.Coverage, status.Overall)
	}
	if status.Coverage.RequiredWorkers != 1 || status.Coverage.ObservedWorkers != 1 || status.Coverage.UnknownWorkers != 0 {
		t.Fatalf("coverage counts: %+v", status.Coverage)
	}
	// Complete coverage ⇒ overall IS the known severity (never silent
	// nominal — it must equal whatever the confirmed data says).
	if status.Overall != status.KnownOverall {
		t.Fatalf("complete coverage: overall (%s) must equal known_overall (%s)", status.Overall, status.KnownOverall)
	}
	// Conditions (fixture state may or may not have pending gates): any
	// present must be in the display-priority order and carry a since.
	order := map[string]int{"permission_pending": 0, "question_pending": 1, "worker_down": 2, "worker_missing": 3, "session_error": 4, "session_retry": 5}
	last := -1
	for _, c := range status.Conditions {
		rank, ok := order[c.Kind]
		if !ok {
			t.Fatalf("unknown condition kind %q", c.Kind)
		}
		if rank <= last {
			t.Fatalf("conditions out of display-priority order: %+v", status.Conditions)
		}
		last = rank
		if c.Count < 1 || c.Label == "" {
			t.Fatalf("condition %q: bad count/label: %+v", c.Kind, c)
		}
	}
	if n := len([]rune(status.Summary)); n > 30 {
		t.Fatalf("summary exceeds 30 code points (%d): %q", n, status.Summary)
	}
	if status.MaxStalenessMS <= 0 || status.GeneratedAt == "" {
		t.Fatalf("freshness metadata missing: generated_at=%q max_staleness_ms=%d", status.GeneratedAt, status.MaxStalenessMS)
	}

	// 2. Same generation: If-None-Match must 304 with the same validator.
	resp2, _, err := cluster.Do(http.MethodGet, "/vh/fleet/status", "", "", map[string]string{"If-None-Match": etag})
	if err != nil {
		t.Fatal(err)
	}
	if resp2.StatusCode != http.StatusNotModified {
		t.Fatalf("If-None-Match within generation: want 304, got %d", resp2.StatusCode)
	}
	if got := resp2.Header.Get("ETag"); got != etag {
		t.Fatalf("304 ETag mismatch: want %q, got %q", etag, got)
	}

	// 3. Plain re-GET within the TTL returns the identical bytes.
	resp3, body3, err := cluster.Do(http.MethodGet, "/vh/fleet/status", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp3.StatusCode != http.StatusOK || string(body3) != string(body) {
		t.Fatalf("same-generation re-GET must be byte-identical (status %d)", resp3.StatusCode)
	}
	if resp3.Header.Get("ETag") != etag {
		t.Fatalf("same-generation ETag must be stable")
	}
}
