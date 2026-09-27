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
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"
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
	// The whitelist covers EVERY schema-1 kind incl. the gauge-semantics
	// additions (project_missing was historically absent from this map —
	// an unknown kind would have fatalf'd; session_done rides last).
	order := map[string]int{"permission_pending": 0, "question_pending": 1, "worker_down": 2, "worker_missing": 3, "project_missing": 4, "session_error": 5, "session_retry": 6, "session_done": 7}
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

// TestE2E_FleetStatusLeanGatesThroughRealTunnel proves the LEAN acquisition
// leg end to end against the SHARED cluster's real stack: the worker's REAL
// pkg/web /vh/gates handler (session-cookie family, default project ""),
// fetched through the production transport (Proxy.FetchWorkerJSONBounded →
// yamux tunnel → agent raw-proxy → worker web server) with the z=1 gzip64
// opt-in. The shared-cluster rollup above already ACQUIRES through this
// endpoint (the controller tries lean first); this test pins the endpoint's
// wire contract directly: schema 1, one entry for the default project, and
// a gate map (raw or envelope-decoded — the fixture's small fleet stays
// under the compress threshold) that is valid JSON.
func TestE2E_FleetStatusLeanGatesThroughRealTunnel(t *testing.T) {
	w, ok := cluster.Daemon.Registry.GetWorker(cluster.WorkerID)
	if !ok {
		t.Fatalf("shared-cluster worker %s not registered", cluster.WorkerID)
	}
	if tr, _ := cluster.Daemon.Registry.WorkerTransport(cluster.WorkerID); tr == nil || tr.IsClosed() {
		t.Fatalf("shared-cluster worker %s not online", cluster.WorkerID)
	}
	body, err := cluster.Daemon.Proxy.FetchWorkerJSONBounded(context.Background(), w, "/vh/gates?z=1&dir=", 5*time.Second, 4<<20)
	if err != nil {
		t.Fatalf("real-stack lean gates fetch: %v", err)
	}
	var lean struct {
		Schema   int `json:"schema"`
		Projects []struct {
			Dir  string          `json:"dir"`
			Gate json.RawMessage `json:"gate"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(body, &lean); err != nil {
		t.Fatalf("lean gates body is not JSON (envelope decode broken?): %v (%q)", err, body)
	}
	if lean.Schema != 1 {
		t.Fatalf("lean gates schema: want 1, got %d", lean.Schema)
	}
	if len(lean.Projects) != 1 || lean.Projects[0].Dir != "" {
		t.Fatalf("lean gates projects: want exactly the default project, got %+v", lean.Projects)
	}
	if lean.Projects[0].Gate == nil {
		t.Fatalf("default project entry must carry a gate object (may be empty), got nil")
	}
}

// TestE2E_FleetStatusSelectedPopulationParity is the gauge-semantics crux
// through the REAL stack: the worker's lean /vh/gates serves ONLY the
// selected population (effective root+unarchived, fleet_selected tagged,
// capability marker advertised), never a subagent child, and the
// controller's rollup gauge denominator equals exactly that population
// summed over discovery — the fold and the worker agree end to end.
func TestE2E_FleetStatusSelectedPopulationParity(t *testing.T) {
	w, ok := cluster.Daemon.Registry.GetWorker(cluster.WorkerID)
	if !ok {
		t.Fatalf("shared-cluster worker %s not registered", cluster.WorkerID)
	}
	fetch := func(path string) []byte {
		t.Helper()
		body, err := cluster.Daemon.Proxy.FetchWorkerJSONBounded(context.Background(), w, path, 5*time.Second, 4<<20)
		if err != nil {
			t.Fatalf("real-stack fetch %s: %v", path, err)
		}
		return body
	}

	// 1. Discovery (the rollup's own scope source).
	var dirs []struct {
		Dir string `json:"dir"`
	}
	if err := json.Unmarshal(fetch("/vh/projects"), &dirs); err != nil {
		t.Fatalf("discovery not JSON: %v", err)
	}

	// 2. Lean gates for exactly the discovered dirs (the rollup's request
	// shape) + the default project's snapshot for the child-exclusion proof.
	var sb strings.Builder
	sb.WriteString("/vh/gates?z=1")
	for _, d := range dirs {
		sb.WriteString("&dir=" + url.QueryEscape(d.Dir))
	}
	var lean struct {
		Schema         int    `json:"schema"`
		FleetSelection string `json:"fleet_selection"`
		Projects       []struct {
			Dir  string                     `json:"dir"`
			Gate map[string]json.RawMessage `json:"gate"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(fetch(sb.String()), &lean); err != nil {
		t.Fatalf("lean gates not JSON: %v", err)
	}
	if lean.FleetSelection != "root_unarchived_v1" {
		t.Fatalf("real lean fleet_selection marker: want root_unarchived_v1, got %q", lean.FleetSelection)
	}
	selectedTotal := 0
	for _, p := range lean.Projects {
		for sid, raw := range p.Gate {
			var gf struct {
				FleetSelected *bool `json:"fleet_selected"`
			}
			if err := json.Unmarshal(raw, &gf); err != nil {
				t.Fatalf("gate entry %s not JSON: %v", sid, err)
			}
			if gf.FleetSelected == nil || !*gf.FleetSelected {
				t.Fatalf("lean entry %s/%s must carry fleet_selected=true (the endpoint is selected-only)", p.Dir, sid)
			}
			selectedTotal++
		}
	}
	if selectedTotal == 0 {
		t.Fatal("fixture must hold at least one selected root for the parity proof")
	}

	// 3. Child exclusion: every NON-ROOT session of the default project's
	// complete snapshot (resident parent per its own info.parentID) is
	// absent from the default project's lean map.
	var snap struct {
		Sessions []struct {
			ID       string `json:"id"`
			ParentID string `json:"parentID"`
		}
		Gate map[string]json.RawMessage `json:"gate"`
	}
	if err := json.Unmarshal(fetch("/vh/snapshot?z=1"), &snap); err != nil {
		t.Fatalf("snapshot not JSON: %v", err)
	}
	liveIDs := map[string]bool{}
	for _, s := range snap.Sessions {
		liveIDs[s.ID] = true
	}
	var leanDefault map[string]json.RawMessage
	for _, p := range lean.Projects {
		if p.Dir == "" {
			leanDefault = p.Gate
		}
	}
	if leanDefault == nil {
		t.Fatal("lean response must carry the default project entry")
	}
	children := 0
	for _, s := range snap.Sessions {
		if s.ParentID != "" && liveIDs[s.ParentID] {
			children++
			if _, ok := leanDefault[s.ID]; ok {
				t.Fatalf("child %s (parent %s resident) must NEVER appear in the selected-only lean map", s.ID, s.ParentID)
			}
		}
	}
	if children == 0 {
		t.Log("note: default project holds no resident children right now (shared fixture state) — child exclusion unexercised this run")
	}

	// 4. The controller's gauge denominator == the worker-selected
	// population summed over the SAME discovery (the fold and the worker
	// agree through the real tunnel).
	resp, body, err := cluster.Do(http.MethodGet, "/vh/fleet/status", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("fleet status: want 200, got %d: %s", resp.StatusCode, body)
	}
	var status struct {
		Gauge struct {
			Label     string  `json:"label"`
			Available bool    `json:"available"`
			Value     float64 `json:"value"`
		} `json:"gauge"`
		Coverage struct {
			Complete bool `json:"complete"`
		} `json:"coverage"`
	}
	if err := json.Unmarshal(body, &status); err != nil {
		t.Fatalf("fleet status not JSON: %v", err)
	}
	if !status.Coverage.Complete || !status.Gauge.Available {
		t.Fatalf("shared cluster must be completely acquired (gauge available), got %+v", status)
	}
	want := fmt.Sprintf("/%d busy", selectedTotal)
	if !strings.HasSuffix(status.Gauge.Label, want) {
		t.Fatalf("gauge denominator must equal the selected population over discovery (%d), got label %q", selectedTotal, status.Gauge.Label)
	}
}
