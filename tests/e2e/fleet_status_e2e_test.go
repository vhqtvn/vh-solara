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
//
// S2 (followups brief §3, 2026-09-27) adds the resident-child program on the
// same shared cluster: a DETERMINISTIC test-owned parent+child topology
// (fresh root spawned over the tunnel + forked children held resident for the
// whole test) instead of relying on the mutable shared seed. It hardens the
// parity test's child-exclusion escape into a hard failure (A-F4) and proves
// descendant pending/busy propagation end to end through the real chain —
// fixture /event → worker store subtree derivation → lean /vh/gates wire →
// yamux tunnel → controller rollup fold (B-F2). The S3 error/retry extension
// reuses the same seeding + polling helpers (see seedFleetParentChildren).

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
	fetch := func(path string) []byte {
		t.Helper()
		return fleetFetchWorker(cluster, t, path)
	}

	// 0. S2/A-F4 hardening: seed a TEST-OWNED resident child (fresh root
	// spawned over the tunnel + one forked child, held resident for this
	// whole test; teardown restores the shared topology). The shared seed's
	// demo→sub pair is mutable across the serial suite — owning the topology
	// makes the child-exclusion assertion below deterministic, so the
	// historical absent-child escape can become a hard failure (step 3).
	root, _ := seedFleetParentChildren(cluster, t, 1)

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
	// A-F4 hardening: this test OWNS a resident child (step 0, asserted
	// resident by seedFleetParentChildren before any assertion runs), so an
	// empty child population is a broken precondition — a hard failure, not
	// the historical log-and-pass escape.
	if children == 0 {
		t.Fatalf("default project holds no resident children — the test-owned resident-child precondition failed (owned root %s, seed/propagation broken)", root)
	}

	// 4. The controller's gauge denominator == the worker-selected
	// population summed over the SAME discovery (the fold and the worker
	// agree through the real tunnel). The rollup is a TTL-cached immutable
	// generation: polling until the label matches the CURRENT selected
	// population (fresh lean fetch above) proves the agreement on a
	// generation that observed the owned root, never on a stale one.
	want := fmt.Sprintf("/%d busy", selectedTotal)
	final := waitFleetRollup(cluster, t, 15*time.Second, "gauge denominator == selected population over discovery ("+want+")", func(v fleetRollupView) bool {
		return v.Coverage.Complete && v.Gauge.Available && strings.HasSuffix(v.Gauge.Label, want)
	})
	if !strings.HasSuffix(final.Gauge.Label, want) {
		t.Fatalf("gauge denominator must equal the selected population over discovery (%d), got label %q", selectedTotal, final.Gauge.Label)
	}
}

// ---------------------------------------------------------------------------
// S2 shared helpers: deterministic test-owned parent+child topology +
// outcome-polled rollup/lean observation (followups brief §3).
// ---------------------------------------------------------------------------

// fleetFetchWorker fetches a worker-local JSON path through the REAL tunnel
// (controller Proxy.FetchWorkerJSONBounded → yamux → agent raw-proxy → the
// worker's pkg/web server) — the exact acquisition transport the rollup uses.
// These fetches are NOT generation-cached (each is a live worker query), so
// they observe near-current store state.
func fleetFetchWorker(c *Cluster, t *testing.T, path string) []byte {
	t.Helper()
	w, ok := c.Daemon.Registry.GetWorker(c.WorkerID)
	if !ok {
		t.Fatalf("cluster worker %s not registered", c.WorkerID)
	}
	body, err := c.Daemon.Proxy.FetchWorkerJSONBounded(context.Background(), w, path, 5*time.Second, 4<<20)
	if err != nil {
		t.Fatalf("real-stack fetch %s: %v", path, err)
	}
	return body
}

// fleetSnapshot is the default project's COMPLETE snapshot slice the
// child-exclusion proofs cross-check against (children ARE present here,
// parentID-wired — unlike the selected-only lean map).
type fleetSnapshot struct {
	Sessions []struct {
		ID       string `json:"id"`
		ParentID string `json:"parentID"`
	} `json:"sessions"`
	Gate map[string]json.RawMessage `json:"gate"`
}

func fleetSnapshotNow(c *Cluster, t *testing.T) fleetSnapshot {
	t.Helper()
	var s fleetSnapshot
	if err := json.Unmarshal(fleetFetchWorker(c, t, "/vh/snapshot?z=1"), &s); err != nil {
		t.Fatalf("snapshot not JSON: %v", err)
	}
	return s
}

// waitSnapshotResident polls the complete snapshot until sid is resident in
// the store with the wanted parent linkage (wantParent "" = root). Residency
// is a PRECONDITION (fatal on timeout), never an assumption: the fork's
// session.created reaches the store through the real /event stream within
// milliseconds, and polling turns that into a deterministic gate.
func waitSnapshotResident(c *Cluster, t *testing.T, sid, wantParent string) {
	t.Helper()
	deadline := time.Now().Add(6 * time.Second)
	for time.Now().Before(deadline) {
		snap := fleetSnapshotNow(c, t)
		live := map[string]bool{}
		for _, s := range snap.Sessions {
			live[s.ID] = true
		}
		for _, s := range snap.Sessions {
			if s.ID == sid && s.ParentID == wantParent && (wantParent == "" || live[wantParent]) {
				return
			}
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("session %s (parent %q) never became resident in the store within 6s", sid, wantParent)
}

// fleetWorkerPost POSTs a worker-local route (the /oc passthrough: fork,
// fixture controls) with the e2e CSRF header. Cluster-parameterized so the
// propagation proof can drive its OWN cluster rather than the shared one.
func fleetWorkerPost(c *Cluster, t *testing.T, path string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, c.WorkerVHURL+path, nil)
	req.Header.Set(e2eCsrfHeader, e2eCsrfValue)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("worker POST %s: %v", path, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("worker POST %s: want 200, got %d", path, resp.StatusCode)
	}
}

// spawnFleetRootOverTunnel creates a FRESH root session through the real
// coordination spawn (controller → tunnel → worker /vh/spawn → fake
// POST /session) and gates on store residency. Test-owned isolation: the
// shared seed's topology is mutable across the serial suite, so every fleet
// proof owns its parent+child subtree outright instead of depending on it.
func spawnFleetRootOverTunnel(c *Cluster, t *testing.T, title string) string {
	t.Helper()
	resp, body, err := c.Do(http.MethodPost, "/api/workers/"+c.WorkerID+"/sessions", fmt.Sprintf(`{"title":%q}`, title), c.APIToken, nil)
	if err != nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("spawn %q: want 200, got %d: %s (err %v)", title, statusOf(resp), body, err)
	}
	var sp struct {
		OK        bool   `json:"ok"`
		SessionID string `json:"sessionID"`
	}
	_ = json.Unmarshal(body, &sp)
	if !sp.OK || !strings.HasPrefix(sp.SessionID, "ses_") {
		t.Fatalf("spawn %q unexpected: %s", title, body)
	}
	waitSnapshotResident(c, t, sp.SessionID, "")
	return sp.SessionID
}

// seedFleetParentChildren seeds the deterministic test-owned topology in the
// cluster's default project: one fresh root spawned over the tunnel plus n
// forked children (parentID wired to the root, resident for the whole test
// via real session.created ingress — each residency gated fatally before the
// caller runs a single assertion). Teardown (t.Cleanup) resets each child
// (replies any armed pending blocker + clears sticky busy + strips scripted
// messages, all through the real reply/removal events) and then deletes the
// child+root rows (session.deleted ingress), so the serial suite observes no
// cross-test pollution from this topology.
//
// S3 EXTENSION POINT: the helper is state-agnostic — the error/retry
// tunnel-proof reuses it by driving a child into activity error/retry (e.g.
// Fake.EmitSessionTerminal(child, "session.error") or a retry-type
// session.status) and asserting the S3 rollup surface with the same
// waitFleetRollup/waitLeanEntry polls below.
func seedFleetParentChildren(c *Cluster, t *testing.T, n int) (root string, children []string) {
	t.Helper()
	root = spawnFleetRootOverTunnel(c, t, "fleet resident-child proof")
	for i := 0; i < n; i++ {
		req, _ := http.NewRequest(http.MethodPost, c.WorkerVHURL+"/oc/session/"+root+"/fork", nil)
		req.Header.Set(e2eCsrfHeader, e2eCsrfValue)
		resp, err := http.DefaultClient.Do(req)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("fork under %s: want 200, got %d (err %v)", root, statusOf(resp), err)
		}
		var fr struct {
			ID string `json:"id"`
		}
		_ = json.NewDecoder(resp.Body).Decode(&fr)
		resp.Body.Close()
		if fr.ID == "" {
			t.Fatalf("fork under %s: empty id", root)
		}
		waitSnapshotResident(c, t, fr.ID, root)
		children = append(children, fr.ID)
	}
	t.Cleanup(func() {
		for _, ch := range children {
			fleetWorkerPost(c, t, "/oc/fixture/reset?session="+ch)
			fleetWorkerPost(c, t, "/oc/fixture/delete?session="+ch)
		}
		fleetWorkerPost(c, t, "/oc/fixture/delete?session="+root)
	})
	return root, children
}

// fleetLeanFacts is the subtree-aggregate slice of a lean gate entry the
// propagation proof attributes worker-side (the same fields the controller
// fold consumes).
type fleetLeanFacts struct {
	FleetSelected            *bool  `json:"fleet_selected"`
	Activity                 string `json:"activity"`
	SubtreeBusy              bool   `json:"subtree_busy"`
	SubtreePendingPermission int    `json:"subtree_pending_permission"`
	SubtreePendingQuestion   int    `json:"subtree_pending_question"`
	SubtreePendingInput      int    `json:"subtree_pending_input"`
}

// fleetLeanGate fetches the default project's selected-only lean gate map
// through the real tunnel (uncached live worker wire).
func fleetLeanGate(c *Cluster, t *testing.T) map[string]json.RawMessage {
	t.Helper()
	var lean struct {
		Schema   int `json:"schema"`
		Projects []struct {
			Dir  string                     `json:"dir"`
			Gate map[string]json.RawMessage `json:"gate"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(fleetFetchWorker(c, t, "/vh/gates?z=1&dir="), &lean); err != nil {
		t.Fatalf("lean gates not JSON: %v", err)
	}
	for _, p := range lean.Projects {
		if p.Dir == "" {
			return p.Gate
		}
	}
	t.Fatal("lean response must carry the default project entry")
	return nil
}

// fleetRollupView is the GET /vh/fleet/status slice the propagation proof
// asserts on. The per-project rows let the proof anchor differentials to the
// DEFAULT project's own fold population even when other projects are
// instantiated alongside it.
type fleetRollupView struct {
	Gauge struct {
		Label     string  `json:"label"`
		Value     float64 `json:"value"`
		Available bool    `json:"available"`
	} `json:"gauge"`
	Coverage struct {
		Complete bool `json:"complete"`
	} `json:"coverage"`
	Conditions []fleetCondView    `json:"conditions"`
	Projects   []fleetProjRowView `json:"projects"`
}

type fleetCondView struct {
	Kind  string  `json:"kind"`
	Count int     `json:"count"`
	Label string  `json:"label"`
	Link  *string `json:"link"`
}

type fleetProjRowView struct {
	Dir      string `json:"dir"`
	Sessions int    `json:"sessions"`
	Busy     int    `json:"busy"`
	Done     int    `json:"done"`
	Pending  int    `json:"pending"`
}

func fleetRollupNow(c *Cluster, t *testing.T) fleetRollupView {
	t.Helper()
	resp, body, err := c.Do(http.MethodGet, "/vh/fleet/status", "", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("fleet status: want 200, got %d: %s", resp.StatusCode, body)
	}
	var v fleetRollupView
	if err := json.Unmarshal(body, &v); err != nil {
		t.Fatalf("fleet status not JSON: %v", err)
	}
	return v
}

// fleetLeanPendingDiag summarizes which roots carry subtree pending counts
// right now (failure diagnostics only — never an assertion).
func fleetLeanPendingDiag(c *Cluster) string {
	gate, err := func() (map[string]json.RawMessage, error) {
		w, ok := c.Daemon.Registry.GetWorker(c.WorkerID)
		if !ok {
			return nil, fmt.Errorf("worker %s not registered", c.WorkerID)
		}
		body, err := c.Daemon.Proxy.FetchWorkerJSONBounded(context.Background(), w, "/vh/gates?z=1&dir=", 5*time.Second, 4<<20)
		if err != nil {
			return nil, err
		}
		var lean struct {
			Projects []struct {
				Dir  string                     `json:"dir"`
				Gate map[string]json.RawMessage `json:"gate"`
			} `json:"projects"`
		}
		if err := json.Unmarshal(body, &lean); err != nil {
			return nil, err
		}
		for _, p := range lean.Projects {
			if p.Dir == "" {
				return p.Gate, nil
			}
		}
		return nil, fmt.Errorf("no default project entry")
	}()
	if err != nil {
		return fmt.Sprintf("(lean diag fetch failed: %v)", err)
	}
	var sb strings.Builder
	for sid, raw := range gate {
		var f fleetLeanFacts
		if json.Unmarshal(raw, &f) != nil {
			continue
		}
		if f.SubtreePendingPermission > 0 || f.SubtreePendingQuestion > 0 || f.SubtreeBusy {
			fmt.Fprintf(&sb, " %s{perm=%d,quest=%d,busy=%v}", sid, f.SubtreePendingPermission, f.SubtreePendingQuestion, f.SubtreeBusy)
		}
	}
	if sb.Len() == 0 {
		return " (lean: no root carries subtree pending/busy)"
	}
	return " (default-project roots with subtree state:" + sb.String() + ")"
}

// waitFleetRollup polls GET /vh/fleet/status until pred holds on a served
// generation. The rollup is a daemon-owned immutable generation under a 5s
// TTL: a state change armed on the worker surfaces only in the NEXT
// generation, so outcome polling (never sleeps, never stale same-generation
// re-GETs) is the honest wait (brief §3: "wait for observed state and fresh
// rollups").
func waitFleetRollup(c *Cluster, t *testing.T, timeout time.Duration, desc string, pred func(fleetRollupView) bool) fleetRollupView {
	t.Helper()
	deadline := time.Now().Add(timeout)
	var last fleetRollupView
	for time.Now().Before(deadline) {
		last = fleetRollupNow(c, t)
		if pred(last) {
			return last
		}
		time.Sleep(250 * time.Millisecond)
	}
	t.Fatalf("fleet rollup never satisfied (%s) within %s; last label=%q conditions=%+v%s", desc, timeout, last.Gauge.Label, last.Conditions, fleetLeanPendingDiag(c))
	return last
}

// fleetCond returns the kind's condition, or nil when absent this generation.
func fleetCond(v fleetRollupView, kind string) *fleetCondView {
	for i := range v.Conditions {
		if v.Conditions[i].Kind == kind {
			return &v.Conditions[i]
		}
	}
	return nil
}

// fleetCondCount is the kind's session count (0 when the condition is
// absent).
func fleetCondCount(v fleetRollupView, kind string) int {
	if c := fleetCond(v, kind); c != nil {
		return c.Count
	}
	return 0
}

// fleetDefaultProjectRow returns the default project's rollup row (nil when
// absent this generation).
func fleetDefaultProjectRow(v fleetRollupView) *fleetProjRowView {
	for i := range v.Projects {
		if v.Projects[i].Dir == "" {
			return &v.Projects[i]
		}
	}
	return nil
}

// parseBusyLabel splits a "N/M busy" gauge label; ok=false when malformed.
func parseBusyLabel(label string) (busy, total int, ok bool) {
	if n, err := fmt.Sscanf(label, "%d/%d busy", &busy, &total); err != nil || n != 2 {
		return -1, -1, false
	}
	return busy, total, true
}

// TestE2E_FleetStatusResidentChildPropagation is the S2 B-F2 crux: a RESIDENT
// subagent child's pending/busy state surfaces on its ROOT through the entire
// real chain — fixture /event ingress → worker store subtree derivation →
// lean /vh/gates wire → yamux tunnel → controller rollup fold — while the
// child itself NEVER enters the selected fold population. Everything is real
// except the OpenCode process (pkg/fixtures fake).
//
// FRESH CLUSTER (the brief's preferred isolation): the SHARED cluster
// accumulates other instantiated projects across the serial suite, and the
// fake's /event stream is not directory-scoped — live events land in EVERY
// per-directory store, so a shared-cluster run would count this topology's
// pending/busy once per live project (observed: 2 descendants counted as 6
// pending sessions across 3 stores). A fresh cluster instantiates exactly the
// default project, making the global fold provably attributable to this
// topology. (The cross-project /event leakage itself is reported as an S2
// finding for separate disposition — fixture fidelity vs production
// multi-project semantics was not settled in this slice.)
//
// Shape: two children under one owned root. Each child blocks on a permission
// armed through the real send path, so the root's subtree holds TWO pending
// descendant sessions — proving the condition's count units are descendant
// SESSIONS (base+2 from ONE contributing root), not roots. A sticky busy on
// one child then moves the gauge numerator +1 through the root's subtree_busy
// (the child is excluded from the fold, so the +1 can only propagate).
// Clearing via the real reply path returns both surfaces to baseline.
func TestE2E_FleetStatusResidentChildPropagation(t *testing.T) {
	c, err := StartCluster()
	if err != nil {
		t.Fatalf("StartCluster: %v", err)
	}
	// t.Cleanup (NOT defer): LIFO ordering runs the topology teardown
	// registered by seedFleetParentChildren BELOW before the cluster closes,
	// so the reset/delete ingress still has a live worker to land on.
	t.Cleanup(c.Close)
	root, children := seedFleetParentChildren(c, t, 2)
	child1, child2 := children[0], children[1]

	// 1. Precondition (fatal, no escapes): root selected in the lean map,
	//    both children excluded, root subtree aggregates quiet.
	gate := fleetLeanGate(c, t)
	rawRoot, ok := gate[root]
	if !ok {
		t.Fatalf("owned root %s must be selected in the lean map (%d entries)", root, len(gate))
	}
	var quiet fleetLeanFacts
	if err := json.Unmarshal(rawRoot, &quiet); err != nil {
		t.Fatalf("root lean entry not JSON: %v", err)
	}
	for _, ch := range children {
		if _, ok := gate[ch]; ok {
			t.Fatalf("child %s must never appear in the selected-only lean map", ch)
		}
	}
	if quiet.FleetSelected == nil || !*quiet.FleetSelected || quiet.SubtreeBusy || quiet.SubtreePendingPermission != 0 || quiet.SubtreePendingInput != 0 {
		t.Fatalf("owned root must start selected+quiet, got %+v", quiet)
	}
	selectedTotal := len(gate)

	// 2. Baseline generation: one that already reflects the owned root —
	//    freshness anchored to the default project's own row (its `sessions`
	//    counts the same selected fold population the fresh lean fetch
	//    counted).
	base := waitFleetRollup(c, t, 15*time.Second, "baseline generation reflects the owned root (default-project row)", func(v fleetRollupView) bool {
		if !v.Coverage.Complete || !v.Gauge.Available {
			return false
		}
		row := fleetDefaultProjectRow(v)
		return row != nil && row.Sessions == selectedTotal
	})
	baseRow := fleetDefaultProjectRow(base)
	if baseRow == nil {
		t.Fatal("baseline rollup must carry the default project row")
	}
	baseBusy, baseTotal, ok := parseBusyLabel(base.Gauge.Label)
	if !ok {
		t.Fatalf("baseline gauge label not parseable: %q", base.Gauge.Label)
	}
	basePerm := fleetCondCount(base, "permission_pending")

	// 3. Descendant PENDING: each child blocks on a permission through the
	//    real send path (controller → tunnel → /vh/send → prompt_async →
	//    permission.asked on the fake's /event stream → store).
	for _, ch := range children {
		resp, body, err := c.Do(http.MethodPost, "/api/workers/"+c.WorkerID+"/sessions/"+ch+"/message", `{"text":"[[perm]]"}`, c.APIToken, nil)
		if err != nil || resp.StatusCode != http.StatusOK {
			t.Fatalf("send [[perm]] to %s: want 200, got %d: %s (err %v)", ch, statusOf(resp), body, err)
		}
	}

	// waitLeanEntry polls the uncached lean wire until the root's entry
	// satisfies pred — the worker-side attribution observation.
	waitLeanEntry := func(desc string, pred func(fleetLeanFacts) bool) {
		t.Helper()
		deadline := time.Now().Add(6 * time.Second)
		for time.Now().Before(deadline) {
			raw, ok := fleetLeanGate(c, t)[root]
			if ok {
				var f fleetLeanFacts
				if json.Unmarshal(raw, &f) == nil && pred(f) {
					return
				}
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("root %s lean entry never satisfied (%s) within 6s", root, desc)
	}

	// 3a. Worker wire: the ROOT's lean entry carries both descendants'
	//     pending permissions (2 pending sessions, union input 2) with the
	//     root itself still not subtree-busy (the [[perm]] turn's transient
	//     busy has settled; pending outlives it).
	waitLeanEntry("subtree_pending_permission==2 && !subtree_busy", func(f fleetLeanFacts) bool {
		return f.SubtreePendingPermission == 2 && f.SubtreePendingInput == 2 && !f.SubtreeBusy
	})

	// 3b. Controller fold through the tunnel: the rollup's
	//     permission_pending condition counts the two DESCENDANT sessions
	//     (base+2) surfaced on their single root, with the pinned plural
	//     label vocabulary; the default project row's pending-root count
	//     gains exactly the one contributing root.
	perm := waitFleetRollup(c, t, 15*time.Second, "permission_pending == base+2 from descendants", func(v fleetRollupView) bool {
		if fleetCondCount(v, "permission_pending") != basePerm+2 {
			return false
		}
		row := fleetDefaultProjectRow(v)
		return row != nil && row.Pending == baseRow.Pending+1
	})
	pc := fleetCond(perm, "permission_pending")
	if pc == nil {
		t.Fatal("permission_pending condition must be present")
	}
	wantPermLabel := fmt.Sprintf("%d permissions pending", basePerm+2)
	if basePerm+2 == 1 {
		wantPermLabel = "1 permission pending"
	}
	if pc.Label != wantPermLabel {
		t.Fatalf("permission_pending label: want %q, got %q", wantPermLabel, pc.Label)
	}

	// 4. Descendant BUSY moves the gauge: sticky busy on child1 via the
	//    fixture control (real session.status ingress; sticky until reset).
	//    The child stays outside the fold population, so the numerator +1
	//    can only arrive through the root's subtree_busy.
	fleetWorkerPost(c, t, "/oc/fixture/busy?session="+child1)
	waitLeanEntry("root subtree_busy from the busy child", func(f fleetLeanFacts) bool {
		return f.SubtreeBusy && f.SubtreePendingPermission == 2
	})
	wantGauge := fmt.Sprintf("%d/%d busy", baseBusy+1, baseTotal)
	busy := waitFleetRollup(c, t, 15*time.Second, "gauge label "+wantGauge+" (subtree busy moved the gauge)", func(v fleetRollupView) bool {
		if !v.Coverage.Complete || !v.Gauge.Available || v.Gauge.Label != wantGauge {
			return false
		}
		row := fleetDefaultProjectRow(v)
		return row != nil && row.Busy == baseRow.Busy+1
	})
	// Pending survives the busy arm (busy does not clear waits).
	if got := fleetCondCount(busy, "permission_pending"); got != basePerm+2 {
		t.Fatalf("permission_pending must survive the busy arm: want %d, got %d", basePerm+2, got)
	}

	// 5. CLEARING through the real path: /fixture/reset replies each child's
	//    armed permission (permission.replied ingress) and clears the sticky
	//    busy — both surfaces must return to the baseline.
	fleetWorkerPost(c, t, "/oc/fixture/reset?session="+child2)
	fleetWorkerPost(c, t, "/oc/fixture/reset?session="+child1)
	waitLeanEntry("cleared: root quiet again", func(f fleetLeanFacts) bool {
		return !f.SubtreeBusy && f.SubtreePendingPermission == 0 && f.SubtreePendingInput == 0
	})
	wantClear := fmt.Sprintf("%d/%d busy", baseBusy, baseTotal)
	wantClearPending := fmt.Sprint(basePerm)
	waitFleetRollup(c, t, 15*time.Second, "rollup back to baseline ("+wantClear+", permission_pending=="+wantClearPending+")", func(v fleetRollupView) bool {
		if !v.Coverage.Complete || !v.Gauge.Available || v.Gauge.Label != wantClear || fleetCondCount(v, "permission_pending") != basePerm {
			return false
		}
		row := fleetDefaultProjectRow(v)
		return row != nil && row.Busy == baseRow.Busy && row.Pending == baseRow.Pending
	})
}
