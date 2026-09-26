package server

// status_test.go — lane-1 co-located tests for GET /vh/fleet/status (the
// S2 slice of task card task-2026-09-25-…-compact-readonly-fleet-status-
// rollup-api-controller). These tests drive the rollup through the REAL
// handler + generation cache with the acquisition seam faked (fetchWorkerJSON)
// — the real-tunnel acquisition path is covered by lane 3
// (tests/e2e/fleet_status_e2e_test.go) and by the S1 containment suite
// (tests/e2e/status_transport_s1_test.go).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/hashicorp/yamux"
	"github.com/vhqtvn/vh-solara/pkg/auth"
	"github.com/vhqtvn/vh-solara/pkg/state"
	"github.com/vhqtvn/vh-solara/pkg/tunnel"
)

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

// fleetFake is a scripted acquisition seam: per-worker bodies keyed by exact
// fetch path, optional per-worker errors, and a call counter (the no-fanout
// assertions read it).
type fleetFake struct {
	mu     sync.Mutex
	calls  map[string]int
	bodies map[string]map[string]string
	errs   map[string]error
}

func newFleetFake() *fleetFake {
	return &fleetFake{
		calls:  map[string]int{},
		bodies: map[string]map[string]string{},
		errs:   map[string]error{},
	}
}

func (f *fleetFake) setBody(workerID, path, body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.bodies[workerID] == nil {
		f.bodies[workerID] = map[string]string{}
	}
	f.bodies[workerID][path] = body
}

func (f *fleetFake) setErr(workerID string, err error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.errs[workerID] = err
}

func (f *fleetFake) count(workerID string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[workerID]
}

func (f *fleetFake) totalCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	n := 0
	for _, c := range f.calls {
		n += c
	}
	return n
}

func (f *fleetFake) fetch(_ context.Context, workerID, path string, _ time.Duration, _ int64) ([]byte, error) {
	f.mu.Lock()
	f.calls[workerID]++
	err := f.errs[workerID]
	body := ""
	if err == nil {
		var ok bool
		body, ok = f.bodies[workerID][path]
		if !ok {
			f.mu.Unlock()
			return nil, fmt.Errorf("fake: unexpected fetch %q from worker %q", path, workerID)
		}
	}
	f.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return []byte(body), nil
}

// fleetAddOnline registers a worker whose transport is a REAL yamux session
// pair over an in-memory pipe — Summaries inspects Transport.IsClosed(), so a
// nil-Session MuxTransport would panic. No streams are ever opened on it (the
// acquisition seam is faked); it only needs to exist and be unclosed.
func fleetAddOnline(t *testing.T, reg *Registry, id string) {
	t.Helper()
	c1, c2 := net.Pipe()
	cfg := yamux.DefaultConfig()
	cfg.LogOutput = io.Discard
	cfg.EnableKeepAlive = false
	cli, err := yamux.Client(c1, cfg)
	if err != nil {
		t.Fatalf("yamux client: %v", err)
	}
	srv, err := yamux.Server(c2, cfg)
	if err != nil {
		t.Fatalf("yamux server: %v", err)
	}
	t.Cleanup(func() { _ = cli.Close(); _ = srv.Close() })
	reg.AddWorker(&Worker{
		ID:        id,
		Status:    "online",
		Transport: &tunnel.MuxTransport{Session: srv},
		LastSeen:  time.Now(),
	})
}

func fleetGF(activity string, perm, quest bool) state.GateFacts {
	return state.GateFacts{Activity: activity, PendingPermission: perm, PendingQuestion: quest}
}

func fleetSnapBody(gate map[string]state.GateFacts) string {
	b, err := json.Marshal(map[string]any{"gate": gate})
	if err != nil {
		panic(err)
	}
	return string(b)
}

func fleetProjectsBody(dirs ...string) string {
	type pi struct {
		Dir string `json:"dir"`
	}
	out := make([]pi, 0, len(dirs))
	for _, d := range dirs {
		out = append(out, pi{Dir: d})
	}
	b, err := json.Marshal(out)
	if err != nil {
		panic(err)
	}
	return string(b)
}

// newFleetTestDaemon builds a daemon with the fake acquisition seam
// installed. hostPattern may be "" (links null).
func newFleetTestDaemon(t *testing.T, hostPattern string) (*Daemon, *fleetFake) {
	t.Helper()
	d := NewDaemon(":0", ":0", hostPattern)
	fake := newFleetFake()
	d.fetchWorkerJSON = fake.fetch
	return d, fake
}

func doFleet(h http.Handler, opts ...func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/vh/fleet/status", nil)
	for _, o := range opts {
		o(req)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func withCookie(c *http.Cookie) func(*http.Request) {
	return func(r *http.Request) { r.AddCookie(c) }
}

func withINM(etag string) func(*http.Request) {
	return func(r *http.Request) { r.Header.Set("If-None-Match", etag) }
}

func decodeFleet(t *testing.T, rec *httptest.ResponseRecorder) fleetStatusResponse {
	t.Helper()
	var resp fleetStatusResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode /vh/fleet/status body: %v (body=%q)", err, rec.Body.String())
	}
	return resp
}

func condKinds(resp fleetStatusResponse) []string {
	kinds := make([]string, 0, len(resp.Conditions))
	for _, c := range resp.Conditions {
		kinds = append(kinds, c.Kind)
	}
	return kinds
}

func workerEntry(t *testing.T, resp fleetStatusResponse, id string) fleetWorkerEntry {
	t.Helper()
	for _, w := range resp.Workers {
		if w.ID == id {
			return w
		}
	}
	t.Fatalf("worker %q not in rollup workers %v", id, resp.Workers)
	return fleetWorkerEntry{}
}

// ---------------------------------------------------------------------------
// Rollup correctness, condition precedence, gauge, links
// ---------------------------------------------------------------------------

// TestFleetStatus_RollupPrecedenceAndGauge drives a complete two-worker,
// three-project fleet through the HTTP handler and pins the full contract:
// multi-project fan-out per worker, condition display-priority order, counts
// (a session may contribute to several kinds), gauge busy-or-retry math,
// deterministic deep links from the configured HostPattern, and the
// complete-coverage mapping overall==known_overall.
func TestFleetStatus_RollupPrecedenceAndGauge(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "$ID.example.test")
	fleetAddOnline(t, d.Registry, "alpha")
	fleetAddOnline(t, d.Registry, "beta")

	fake.setBody("alpha", "/vh/projects", fleetProjectsBody("", "/repo"))
	fake.setBody("alpha", "/vh/snapshot", fleetSnapBody(map[string]state.GateFacts{
		"s1": fleetGF("idle", true, false), // permission pending
	}))
	fake.setBody("alpha", "/vh/snapshot?dir=%2Frepo", fleetSnapBody(map[string]state.GateFacts{
		"s2": fleetGF("busy", false, false),
	}))
	fake.setBody("beta", "/vh/projects", fleetProjectsBody(""))
	fake.setBody("beta", "/vh/snapshot", fleetSnapBody(map[string]state.GateFacts{
		"s3": fleetGF("error", false, false),
		"s4": fleetGF("retry", false, true), // question pending + retry
	}))

	h := d.buildRootHandler()
	rec := doFleet(h)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /vh/fleet/status: want 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	resp := decodeFleet(t, rec)

	if resp.Schema != 1 {
		t.Fatalf("schema: want 1, got %d", resp.Schema)
	}
	// Multi-project reality: sessions from BOTH alpha projects and beta's
	// single project all counted (total 4).
	if resp.Coverage.Mode != "discovered" || resp.Coverage.InventoryKnown {
		t.Fatalf("coverage mode: want discovered/inventory_known=false, got %+v", resp.Coverage)
	}
	if !resp.Coverage.Complete || resp.Coverage.RequiredWorkers != 2 || resp.Coverage.ObservedWorkers != 2 || resp.Coverage.UnknownWorkers != 0 {
		t.Fatalf("coverage counts: %+v", resp.Coverage)
	}
	if resp.Overall != fleetOverallDegraded || resp.KnownOverall != fleetOverallDegraded {
		t.Fatalf("complete coverage: overall must equal known_overall=degraded (session error present), got overall=%s known=%s", resp.Overall, resp.KnownOverall)
	}

	// Display-priority order with the exact kinds present.
	wantKinds := []string{fleetCondPermissionPending, fleetCondQuestionPending, fleetCondSessionError, fleetCondSessionRetry}
	got := condKinds(resp)
	if len(got) != len(wantKinds) {
		t.Fatalf("conditions: want %v, got %v", wantKinds, got)
	}
	for i := range wantKinds {
		if got[i] != wantKinds[i] {
			t.Fatalf("conditions order: want %v, got %v", wantKinds, got)
		}
	}
	for _, c := range resp.Conditions {
		if c.Count != 1 {
			t.Fatalf("condition %s: want count 1, got %d", c.Kind, c.Count)
		}
		if c.Since == nil {
			t.Fatalf("condition %s: since must be present on first generation (continuity birth)", c.Kind)
		}
	}
	// Labels.
	wantLabels := map[string]string{
		fleetCondPermissionPending: "1 permission pending",
		fleetCondQuestionPending:   "1 question pending",
		fleetCondSessionError:      "1 session error",
		fleetCondSessionRetry:      "1 session retrying",
	}
	for _, c := range resp.Conditions {
		if c.Label != wantLabels[c.Kind] {
			t.Fatalf("condition %s label: want %q, got %q", c.Kind, wantLabels[c.Kind], c.Label)
		}
	}
	// Deep links: trusted worker-origin /app with encoded dir+session, built
	// from the CONFIGURED pattern, never the request Host.
	wantLinks := map[string]string{
		fleetCondPermissionPending: "https://alpha.example.test/app?dir=&session=s1",
		fleetCondQuestionPending:   "https://beta.example.test/app?dir=&session=s4",
		fleetCondSessionError:      "https://beta.example.test/app?dir=&session=s3",
		fleetCondSessionRetry:      "https://beta.example.test/app?dir=&session=s4",
	}
	for _, c := range resp.Conditions {
		if c.Link == nil || *c.Link != wantLinks[c.Kind] {
			t.Fatalf("condition %s link: want %q, got %v", c.Kind, wantLinks[c.Kind], c.Link)
		}
	}

	// Gauge: busy-or-retry = s2(busy) + s4(retry) = 2 of 4 total.
	if !resp.Gauge.Available || resp.Gauge.Value != 0.5 || resp.Gauge.Label != "2/4 busy" {
		t.Fatalf("gauge: want available 0.5 \"2/4 busy\", got %+v", resp.Gauge)
	}

	// Summary: complete + highest-priority condition (permission pending).
	if resp.Summary != "1 permission pending" {
		t.Fatalf("summary: want %q, got %q", "1 permission pending", resp.Summary)
	}

	// Workers sorted by ID; ok workers carry observed_at.
	if len(resp.Workers) != 2 || resp.Workers[0].ID != "alpha" || resp.Workers[1].ID != "beta" {
		t.Fatalf("workers: want sorted [alpha beta], got %+v", resp.Workers)
	}
	for _, w := range resp.Workers {
		if w.Status != fleetWorkerOK || w.ObservedAt == nil {
			t.Fatalf("worker %s: want ok + observed_at, got %+v", w.ID, w)
		}
		if _, err := time.Parse(time.RFC3339, *w.ObservedAt); err != nil {
			t.Fatalf("worker %s observed_at not RFC3339: %v", w.ID, err)
		}
	}
	if _, err := time.Parse(time.RFC3339, resp.GeneratedAt); err != nil {
		t.Fatalf("generated_at not RFC3339: %v", err)
	}
	if resp.MaxStalenessMS != 15000 {
		t.Fatalf("max_staleness_ms: want 15000, got %d", resp.MaxStalenessMS)
	}
	// ETag header present, strong (quoted).
	etag := rec.Header().Get("ETag")
	if etag == "" || !strings.HasPrefix(etag, `"`) {
		t.Fatalf("ETag: want quoted strong tag, got %q", etag)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "private, no-cache" {
		t.Fatalf("Cache-Control: want \"private, no-cache\", got %q", cc)
	}
	// Single refresh served this generation.
	if n := d.fleetStatusService().refreshCount(); n != 1 {
		t.Fatalf("refresh count: want 1, got %d", n)
	}
}

// TestFleetStatus_WorkerAppLinkHostileIDReject pins the F1 security fix
// (review ses_f23dad77bffe9q564YIGb5M7Fj): the worker ID substituted into the
// configured HostPattern must be a safe host label ([A-Za-z0-9._-] only).
// Worker IDs are client-controlled at registration (open registration when
// --worker-secret is unset), so an ID carrying URL delimiters that terminate
// the authority under WHATWG parsing (# / ? @ :) — or CR/LF/control bytes, the
// same class the A3 guard in status_transport.go rejects — must yield a NIL
// link, never a deep link whose authority the registrant chose. Both
// discovered-mode and roster-mode conditions funnel through workerAppLink, so
// this unit test covers every caller.
func TestFleetStatus_WorkerAppLinkHostileIDReject(t *testing.T) {
	d, _ := newFleetTestDaemon(t, "$ID.example.test")
	svc := d.fleetStatusService()

	// Control: a well-formed ID still yields the trusted-origin deep link.
	want := "https://alpha.example.test/app?dir=%2Frepo&session=s1"
	if got := svc.workerAppLink("alpha", "/repo", "s1"); got == nil || *got != want {
		t.Fatalf("valid ID: want link %q, got %v", want, got)
	}

	for _, id := range []string{
		"evil.example.com/alpha", // path escape
		"alpha#evil.example.com", // fragment escape
		"alpha?evil.example.com", // query escape
		"alpha@evil.example.com", // userinfo escape
		"alpha:8443",             // port escape
		"alpha\rexample.com",     // CR/LF (A3 guard class)
		"alpha\nexample.com",
		"alpha\x00",    // control bytes
		"alpha\x7f",    //
		"alpha%2Fevil", // percent-encoded smuggle (host parsing percent-decodes)
		"alpha evil",   // whitespace
		"",             // empty is never a safe host label (validFetchPath convention)
	} {
		if link := svc.workerAppLink(id, "", "s1"); link != nil {
			t.Fatalf("hostile worker ID %q: link must be nil, got %q", id, *link)
		}
	}
}

// TestFleetStatus_HostileWorkerIDNilLink exercises the F1 fix end-to-end
// through the REAL handler: a worker registered under a hostile ID (attacker-
// controllable via open registration) holding a linkable condition gets a
// NULL conditions[].link — never a tappable off-origin URL — while a
// well-formed ID still deep-links to its trusted worker origin.
func TestFleetStatus_HostileWorkerIDNilLink(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "$ID.example.test")
	fleetAddOnline(t, d.Registry, "alpha")
	fleetAddOnline(t, d.Registry, "evil.example.com/x")
	fleetAddOnline(t, d.Registry, "beta#evil.example.com")

	// One linkable condition per worker: permission pending (valid ID),
	// question pending (/ in ID), session error (# in ID).
	fake.setBody("alpha", "/vh/projects", fleetProjectsBody(""))
	fake.setBody("alpha", "/vh/snapshot", fleetSnapBody(map[string]state.GateFacts{
		"a": fleetGF("idle", true, false),
	}))
	fake.setBody("evil.example.com/x", "/vh/projects", fleetProjectsBody(""))
	fake.setBody("evil.example.com/x", "/vh/snapshot", fleetSnapBody(map[string]state.GateFacts{
		"q1": fleetGF("idle", false, true),
	}))
	fake.setBody("beta#evil.example.com", "/vh/projects", fleetProjectsBody(""))
	fake.setBody("beta#evil.example.com", "/vh/snapshot", fleetSnapBody(map[string]state.GateFacts{
		"e1": fleetGF("error", false, false),
	}))

	resp := decodeFleet(t, doFleet(d.buildRootHandler()))
	for _, c := range resp.Conditions {
		switch c.Kind {
		case fleetCondPermissionPending: // contributor: valid "alpha"
			want := "https://alpha.example.test/app?dir=&session=a"
			if c.Link == nil || *c.Link != want {
				t.Fatalf("valid ID condition %s: want link %q, got %v", c.Kind, want, c.Link)
			}
		case fleetCondQuestionPending, fleetCondSessionError: // hostile contributors
			if c.Link != nil {
				t.Fatalf("condition %s (hostile worker ID): link must be null, got %q", c.Kind, *c.Link)
			}
		}
	}
}

// TestFleetStatus_IncompleteCoverageUnknownNeverSilentNominal pins the
// never-silent-nominal rule: a timed-out worker makes coverage incomplete, so
// overall=unknown even though every CONFIRMED observation is healthy and
// known_overall=nominal. The timed-out worker gets a `timeout` entry with a
// null observed_at.
func TestFleetStatus_IncompleteCoverageUnknownNeverSilentNominal(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	fleetAddOnline(t, d.Registry, "w1")
	fleetAddOnline(t, d.Registry, "w2")
	fake.setBody("w1", "/vh/projects", fleetProjectsBody(""))
	fake.setBody("w1", "/vh/snapshot", fleetSnapBody(map[string]state.GateFacts{
		"a": fleetGF("idle", false, false), // healthy
	}))
	fake.setErr("w2", &FetchTimeoutError{WorkerID: "w2", Stage: "read body", Cause: errors.New("i/o deadline reached")})

	resp := decodeFleet(t, doFleet(d.buildRootHandler()))
	if resp.Coverage.Complete {
		t.Fatalf("coverage must be incomplete when a worker times out: %+v", resp.Coverage)
	}
	if resp.Coverage.RequiredWorkers != 2 || resp.Coverage.ObservedWorkers != 1 || resp.Coverage.UnknownWorkers != 1 {
		t.Fatalf("coverage counts: %+v", resp.Coverage)
	}
	if resp.Overall != fleetOverallUnknown {
		t.Fatalf("overall: want unknown on incomplete coverage, got %s", resp.Overall)
	}
	if resp.KnownOverall != fleetOverallNominal {
		t.Fatalf("known_overall: want nominal (no known conditions), got %s", resp.KnownOverall)
	}
	w2 := workerEntry(t, resp, "w2")
	if w2.Status != fleetWorkerTimeout || w2.ObservedAt != nil {
		t.Fatalf("timed-out worker entry: want timeout/null, got %+v", w2)
	}
	if resp.Gauge.Available {
		t.Fatalf("gauge availability must be false on incomplete coverage: %+v", resp.Gauge)
	}
	if resp.Gauge.Label != "Coverage incomplete" || resp.Gauge.Value != 0 {
		t.Fatalf("gauge placeholder: %+v", resp.Gauge)
	}
	if resp.Summary != "Unknown coverage" {
		t.Fatalf("summary: want %q, got %q", "Unknown coverage", resp.Summary)
	}
}

// TestFleetStatus_BoundedTotalResponse proves the TOTAL response is bounded
// even when the only worker's acquisition stalls until the budget kills it:
// the handler must answer within the refresh budget (plus slack), reporting
// the worker as timeout — never hang.
func TestFleetStatus_BoundedTotalResponse(t *testing.T) {
	d, _ := newFleetTestDaemon(t, "")
	fleetAddOnline(t, d.Registry, "stalled")
	d.fetchWorkerJSON = func(ctx context.Context, workerID, path string, timeout time.Duration, maxBody int64) ([]byte, error) {
		select {
		case <-ctx.Done():
			return nil, &FetchTimeoutError{WorkerID: workerID, Stage: "test stall", Cause: ctx.Err()}
		case <-time.After(10 * time.Second):
			return nil, errors.New("test stall: unexpected wake")
		}
	}
	svc := d.fleetStatusService()
	svc.budgets.RefreshBudget = 400 * time.Millisecond
	svc.budgets.WorkerBudget = 350 * time.Millisecond

	start := time.Now()
	rec := doFleet(d.buildRootHandler())
	elapsed := time.Since(start)
	if elapsed > 2*time.Second {
		t.Fatalf("handler took %v — total response NOT bounded", elapsed)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200 with an honest incomplete rollup, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	resp := decodeFleet(t, rec)
	if w := workerEntry(t, resp, "stalled"); w.Status != fleetWorkerTimeout {
		t.Fatalf("stalled worker: want timeout, got %+v", w)
	}
	if resp.Overall != fleetOverallUnknown {
		t.Fatalf("overall: want unknown, got %s", resp.Overall)
	}
}

// ---------------------------------------------------------------------------
// Offline (no fan-out) + roster / expected mode
// ---------------------------------------------------------------------------

// TestFleetStatus_OfflineNoFanout: a registry-offline worker (exactly what a
// tunnel-WS close produces) is reported offline with ZERO acquisition
// attempts, and contributes a worker_down condition (no link).
func TestFleetStatus_OfflineNoFanout(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "$ID.example.test")
	fleetAddOnline(t, d.Registry, "live")
	fleetAddOnline(t, d.Registry, "dead")
	d.Registry.MarkWorkerOffline("dead") // closes transport, Status=offline, bumps gen
	fake.setBody("live", "/vh/projects", fleetProjectsBody(""))
	fake.setBody("live", "/vh/snapshot", fleetSnapBody(map[string]state.GateFacts{}))

	resp := decodeFleet(t, doFleet(d.buildRootHandler()))
	if n := fake.count("dead"); n != 0 {
		t.Fatalf("offline worker MUST NOT be fanned out to, got %d fetch attempts", n)
	}
	if n := fake.count("live"); n == 0 {
		t.Fatalf("online worker should have been acquired")
	}
	w := workerEntry(t, resp, "dead")
	if w.Status != fleetWorkerOffline || w.ObservedAt != nil {
		t.Fatalf("offline worker entry: %+v", w)
	}
	if resp.Overall != fleetOverallUnknown || resp.KnownOverall != fleetOverallDegraded {
		t.Fatalf("overall/known: want unknown/degraded (worker down is confirmed), got %s/%s", resp.Overall, resp.KnownOverall)
	}
	if got := condKinds(resp); len(got) != 1 || got[0] != fleetCondWorkerDown {
		t.Fatalf("conditions: want [worker_down], got %v", got)
	}
	if resp.Conditions[0].Link != nil {
		t.Fatalf("worker_down link must be null (target offline), got %v", *resp.Conditions[0].Link)
	}
	if resp.Conditions[0].Label != "1 worker down" {
		t.Fatalf("worker_down label: %q", resp.Conditions[0].Label)
	}
}

// TestFleetStatus_RosterExpectedMode pins the config-file worker-roster
// semantics: a non-empty roster turns expected mode on (inventory_known),
// the expected scope excludes unlisted workers (no fan-out to them),
// never-registered IDs are missing, and the rollup scope is SORTED
// regardless of file order. Blank/whitespace/duplicate ids are rejected at
// the config boundary itself (status_config_test.go), so the seam here
// feeds a validated roster. ghost missing ⇒ degraded known severity.
func TestFleetStatus_RosterExpectedMode(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	applyFleetRosters(t, d, []string{"beta", "alpha"}, nil) // unsorted input → scope [alpha beta]
	fleetAddOnline(t, d.Registry, "alpha")
	fleetAddOnline(t, d.Registry, "gamma") // registered but NOT in roster
	fake.setBody("alpha", "/vh/projects", fleetProjectsBody(""))
	fake.setBody("alpha", "/vh/snapshot", fleetSnapBody(map[string]state.GateFacts{}))

	resp := decodeFleet(t, doFleet(d.buildRootHandler()))
	if resp.Coverage.Mode != "expected" || !resp.Coverage.InventoryKnown {
		t.Fatalf("coverage: want expected/inventory_known=true, got %+v", resp.Coverage)
	}
	if resp.Coverage.RequiredWorkers != 2 || resp.Coverage.ObservedWorkers != 1 || resp.Coverage.UnknownWorkers != 1 {
		t.Fatalf("coverage counts: %+v", resp.Coverage)
	}
	if n := fake.count("gamma"); n != 0 {
		t.Fatalf("worker outside the roster MUST NOT be acquired, got %d calls", n)
	}
	if len(resp.Workers) != 2 || resp.Workers[0].ID != "alpha" || resp.Workers[1].ID != "beta" {
		t.Fatalf("workers: want exactly roster scope [alpha beta], got %+v", resp.Workers)
	}
	if w := workerEntry(t, resp, "beta"); w.Status != fleetWorkerMissing || w.ObservedAt != nil {
		t.Fatalf("unregistered roster ID: want missing/null, got %+v", w)
	}
	if resp.Overall != fleetOverallUnknown || resp.KnownOverall != fleetOverallDegraded {
		t.Fatalf("overall/known: want unknown/degraded (missing worker), got %s/%s", resp.Overall, resp.KnownOverall)
	}
	if got := condKinds(resp); len(got) != 1 || got[0] != fleetCondWorkerMissing {
		t.Fatalf("conditions: want [worker_missing], got %v", got)
	}
	if resp.Coverage.Complete {
		t.Fatalf("a missing worker forces incomplete coverage")
	}
}

// ---------------------------------------------------------------------------
// Project roster (status config): acquisition filter + project_missing
// ---------------------------------------------------------------------------

// TestFleetStatus_ProjectRosterScopesAcquisition pins the filter effect:
// with a configured project roster, per-worker discovery is INTERSECTED with
// it — a discovered-but-unconfigured dir is never fetched (the fake has no
// body for its snapshot, so an unfiltered rollup would error the whole
// worker), never counted, and the config boundary stores entries VERBATIM:
// "  /repo " and "/repo" are two DISTINCT configured dirs (no trim —
// commit-review F2; blank/duplicate entries are rejected at the config
// boundary itself, see status_config_test.go).
func TestFleetStatus_ProjectRosterScopesAcquisition(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	// Both dirs are valid non-blank entries, stored VERBATIM → ["  /repo ", "/repo"]
	applyFleetRosters(t, d, nil, []string{"  /repo ", "/repo"})
	fleetAddOnline(t, d.Registry, "alpha")
	// Discovery reports the unconfigured "" project AND "/repo"; only the
	// /repo snapshot is scripted (the bare /vh/snapshot would fail the fake).
	fake.setBody("alpha", "/vh/projects", fleetProjectsBody("", "/repo"))
	fake.setBody("alpha", "/vh/snapshot?dir=%2Frepo", fleetSnapBody(map[string]state.GateFacts{
		"r1": fleetGF("busy", false, false), // the ONLY session that may count
	}))

	resp := decodeFleet(t, doFleet(d.buildRootHandler()))
	if w := workerEntry(t, resp, "alpha"); w.Status != fleetWorkerOK {
		t.Fatalf("alpha: want ok (unconfigured dir must not be fetched), got %+v", w)
	}
	if n := fake.count("alpha"); n != 2 {
		t.Fatalf("acquisition must be discovery + exactly ONE in-scope snapshot, got %d calls", n)
	}
	if resp.Coverage.ProjectScope != "expected" || resp.Coverage.RequiredProjects != 2 || resp.Coverage.ObservedProjects != 1 || resp.Coverage.UnknownProjects != 1 {
		t.Fatalf("project coverage: want expected 2/1/1 (\"  /repo \" and \"/repo\" are distinct dirs; only \"/repo\" is instantiated), got %+v", resp.Coverage)
	}
	if !resp.Gauge.Available || resp.Gauge.Value != 1 || resp.Gauge.Label != "1/1 busy" {
		t.Fatalf("gauge: want available 1 \"1/1 busy\" (only the configured project counts), got %+v", resp.Gauge)
	}
	if got := condKinds(resp); len(got) != 1 || got[0] != fleetCondProjectMissing {
		t.Fatalf("conditions: want [project_missing] (\"  /repo \" configured but not instantiated anywhere), got %v", got)
	}
	if resp.Conditions[0].Count != 1 {
		t.Fatalf("project_missing count: want 1 (only \"  /repo \" is missing), got %d", resp.Conditions[0].Count)
	}
	if resp.Overall != fleetOverallDegraded || resp.KnownOverall != fleetOverallDegraded {
		t.Fatalf("overall/known: want degraded/degraded (complete worker coverage + one configured dir not running), got %s/%s", resp.Overall, resp.KnownOverall)
	}
}

// TestFleetStatus_ProjectRosterVerbatimMatch pins the F2 contract fix: a
// configured project dir matches the worker-reported dir by exact VERBATIM
// string equality — no trimming on either side. Case (i): a
// whitespace-bearing configured dir (" /repo") against a whitespace-free
// worker-reported dir ("/repo") is NO match — the dir is out of scope
// (never fetched), and the configured dir counts toward missing once the
// only online worker was completely acquired. Case (ii): the same
// whitespace on both sides (" /repo") matches verbatim — in scope, fetched,
// satisfied.
func TestFleetStatus_ProjectRosterVerbatimMatch(t *testing.T) {
	snapPath := "/vh/snapshot?dir=" + url.QueryEscape(" /repo")

	// (i) whitespace-bearing configured dir vs whitespace-free worker dir.
	d, fake := newFleetTestDaemon(t, "")
	applyFleetRosters(t, d, nil, []string{" /repo"})
	fleetAddOnline(t, d.Registry, "alpha")
	fake.setBody("alpha", "/vh/projects", fleetProjectsBody("/repo"))
	// No "/vh/snapshot?dir=%2Frepo" body is scripted: fetching it would be
	// the trim bug (the fake errors on unexpected fetches).

	resp := decodeFleet(t, doFleet(d.buildRootHandler()))
	if w := workerEntry(t, resp, "alpha"); w.Status != fleetWorkerOK {
		t.Fatalf("(i) alpha: want ok (whitespace-free dir must NOT be fetched), got %+v", w)
	}
	if n := fake.count("alpha"); n != 1 {
		t.Fatalf("(i) acquisition calls: want discovery only (no snapshot for the unmatched dir), got %d", n)
	}
	if resp.Coverage.RequiredProjects != 1 || resp.Coverage.ObservedProjects != 0 || resp.Coverage.UnknownProjects != 1 {
		t.Fatalf("(i) project coverage: want 1/0/1 (no verbatim match ⇒ unknown), got %+v", resp.Coverage)
	}
	if got := condKinds(resp); len(got) != 1 || got[0] != fleetCondProjectMissing {
		t.Fatalf("(i) conditions: want [project_missing] (the verbatim dir counts toward missing), got %v", got)
	}
	if resp.Conditions[0].Count != 1 || resp.KnownOverall != fleetOverallDegraded {
		t.Fatalf("(i) project_missing: want count=1 known=degraded, got count=%d known=%s", resp.Conditions[0].Count, resp.KnownOverall)
	}

	// (ii) the same whitespace on both sides: verbatim match.
	d2, fake2 := newFleetTestDaemon(t, "")
	applyFleetRosters(t, d2, nil, []string{" /repo"})
	fleetAddOnline(t, d2.Registry, "alpha")
	fake2.setBody("alpha", "/vh/projects", fleetProjectsBody(" /repo"))
	fake2.setBody("alpha", snapPath, fleetSnapBody(map[string]state.GateFacts{
		"s1": fleetGF("idle", false, false),
	}))

	resp2 := decodeFleet(t, doFleet(d2.buildRootHandler()))
	if w := workerEntry(t, resp2, "alpha"); w.Status != fleetWorkerOK {
		t.Fatalf("(ii) alpha: want ok, got %+v", w)
	}
	if n := fake2.count("alpha"); n != 2 {
		t.Fatalf("(ii) acquisition calls: want discovery + the one verbatim-matched snapshot, got %d", n)
	}
	if resp2.Coverage.RequiredProjects != 1 || resp2.Coverage.ObservedProjects != 1 || resp2.Coverage.UnknownProjects != 0 {
		t.Fatalf("(ii) project coverage: want 1/1/0 (verbatim match works both ways), got %+v", resp2.Coverage)
	}
	if got := condKinds(resp2); len(got) != 0 {
		t.Fatalf("(ii) conditions: want none (dir satisfied), got %v", got)
	}
	if resp2.Overall != fleetOverallNominal {
		t.Fatalf("(ii) overall: want nominal, got %s", resp2.Overall)
	}
}

// TestFleetStatus_ProjectMissingCondition pins the headline semantics: a
// configured dir instantiated on no online worker is a project_missing
// condition (count = missing dirs, null link — no valid mapping to a
// nonexistent project) and — with worker coverage complete — contributes
// degraded to BOTH known_overall and overall.
func TestFleetStatus_ProjectMissingCondition(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "$ID.example.test")
	applyFleetRosters(t, d, nil, []string{"/missing", "/hosted"}) // sorted → [/hosted /missing]
	fleetAddOnline(t, d.Registry, "alpha")
	fake.setBody("alpha", "/vh/projects", fleetProjectsBody("/hosted"))
	fake.setBody("alpha", "/vh/snapshot?dir=%2Fhosted", fleetSnapBody(map[string]state.GateFacts{
		"s1": fleetGF("idle", false, false), // healthy: no session-tier conditions
	}))

	rec := doFleet(d.buildRootHandler())
	resp := decodeFleet(t, rec)
	t.Logf("rollup JSON: %s", rec.Body.String())

	if !resp.Coverage.Complete {
		t.Fatalf("the only in-scope worker was acquired ok — coverage must be complete: %+v", resp.Coverage)
	}
	if resp.Coverage.ProjectScope != "expected" || resp.Coverage.RequiredProjects != 2 || resp.Coverage.ObservedProjects != 1 || resp.Coverage.UnknownProjects != 1 {
		t.Fatalf("project coverage: want expected 2/1/1, got %+v", resp.Coverage)
	}
	if got := condKinds(resp); len(got) != 1 || got[0] != fleetCondProjectMissing {
		t.Fatalf("conditions: want exactly [project_missing], got %v", got)
	}
	c := resp.Conditions[0]
	if c.Count != 1 || c.Label != "1 project not running" || c.Link != nil {
		t.Fatalf("project_missing condition: want count=1 label=%q link=nil, got %+v", "1 project not running", c)
	}
	if c.Since == nil {
		t.Fatalf("project_missing must carry since on first generation (mirrors worker_missing continuity)")
	}
	if resp.KnownOverall != fleetOverallDegraded || resp.Overall != fleetOverallDegraded {
		t.Fatalf("overall/known: want degraded/degraded (complete coverage + confirmed missing project), got %s/%s", resp.Overall, resp.KnownOverall)
	}
	if resp.Summary != "1 project not running" {
		t.Fatalf("summary: want %q, got %q", "1 project not running", resp.Summary)
	}
}

// TestFleetStatus_ProjectFleetWideSatisfaction: a configured dir hosted by
// TWO workers counts ONCE (fleet-wide satisfaction, not per-worker) —
// observed_projects is the distinct configured-dir count.
func TestFleetStatus_ProjectFleetWideSatisfaction(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	applyFleetRosters(t, d, nil, []string{"/only-beta", "/shared"}) // → [/shared /only-beta]
	fleetAddOnline(t, d.Registry, "alpha")
	fleetAddOnline(t, d.Registry, "beta")
	fake.setBody("alpha", "/vh/projects", fleetProjectsBody("/shared"))
	fake.setBody("alpha", "/vh/snapshot?dir=%2Fshared", fleetSnapBody(map[string]state.GateFacts{}))
	fake.setBody("beta", "/vh/projects", fleetProjectsBody("/shared", "/only-beta"))
	fake.setBody("beta", "/vh/snapshot?dir=%2Fshared", fleetSnapBody(map[string]state.GateFacts{}))
	fake.setBody("beta", "/vh/snapshot?dir=%2Fonly-beta", fleetSnapBody(map[string]state.GateFacts{}))

	resp := decodeFleet(t, doFleet(d.buildRootHandler()))
	if resp.Coverage.ObservedProjects != 2 || resp.Coverage.RequiredProjects != 2 || resp.Coverage.UnknownProjects != 0 {
		t.Fatalf("project coverage: /shared on both workers counts once — want 2/2/0, got %+v", resp.Coverage)
	}
	if got := condKinds(resp); len(got) != 0 {
		t.Fatalf("conditions: fleet-wide satisfaction ⇒ no project_missing, got %v", got)
	}
	if resp.Overall != fleetOverallNominal || resp.KnownOverall != fleetOverallNominal {
		t.Fatalf("overall/known: want nominal/nominal, got %s/%s", resp.Overall, resp.KnownOverall)
	}
}

// TestFleetStatus_ProjectMissingSuppressedOnTimeout pins the honesty rule: a
// configured project on a worker whose acquisition timed out (or errored, or
// was capped) must NOT be declared missing — absence is unknown while any
// online worker's view is incomplete. Coverage incomplete ⇒ overall unknown.
func TestFleetStatus_ProjectMissingSuppressedOnTimeout(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	applyFleetRosters(t, d, nil, []string{"/gone"})
	fleetAddOnline(t, d.Registry, "w1")
	fake.setErr("w1", &FetchTimeoutError{WorkerID: "w1", Stage: "read body", Cause: errors.New("i/o deadline reached")})

	resp := decodeFleet(t, doFleet(d.buildRootHandler()))
	if got := condKinds(resp); len(got) != 0 {
		t.Fatalf("timed-out worker: absence is UNKNOWN — no conditions allowed, got %v", got)
	}
	if resp.Coverage.Complete {
		t.Fatalf("coverage must be incomplete when the online worker timed out: %+v", resp.Coverage)
	}
	if resp.Coverage.RequiredProjects != 1 || resp.Coverage.ObservedProjects != 0 || resp.Coverage.UnknownProjects != 1 {
		t.Fatalf("project coverage: want 1/0/1, got %+v", resp.Coverage)
	}
	if resp.Overall != fleetOverallUnknown || resp.KnownOverall != fleetOverallNominal {
		t.Fatalf("overall/known: want unknown/nominal, got %s/%s", resp.Overall, resp.KnownOverall)
	}
}

// TestFleetStatus_ProjectMissingAllOfflineUnknown pins the second honesty
// rule: with ALL in-scope workers offline/down there is zero evidence, so
// projects are unknown, never missing — worker_down still fires, but
// project_missing must not.
func TestFleetStatus_ProjectMissingAllOfflineUnknown(t *testing.T) {
	d, _ := newFleetTestDaemon(t, "")
	applyFleetRosters(t, d, nil, []string{"/gone"})
	fleetAddOnline(t, d.Registry, "dead")
	d.Registry.MarkWorkerOffline("dead")

	resp := decodeFleet(t, doFleet(d.buildRootHandler()))
	if got := condKinds(resp); len(got) != 1 || got[0] != fleetCondWorkerDown {
		t.Fatalf("conditions: want exactly [worker_down], got %v", got)
	}
	if resp.Overall != fleetOverallUnknown || resp.KnownOverall != fleetOverallDegraded {
		t.Fatalf("overall/known: want unknown/degraded (worker down, projects unknown), got %s/%s", resp.Overall, resp.KnownOverall)
	}
	if resp.Coverage.ObservedProjects != 0 || resp.Coverage.UnknownProjects != 1 {
		t.Fatalf("project coverage: want observed=0 unknown=1, got %+v", resp.Coverage)
	}
}

// TestFleetStatus_EmptyProjectRosterDiscoveredScope: without a project
// roster the project axis stays discovered/instantiated with zero project
// counts — including when a WORKER roster is configured (worker-expected
// never implies project-expected; the axes are independent).
func TestFleetStatus_EmptyProjectRosterDiscoveredScope(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	applyFleetRosters(t, d, []string{"alpha"}, nil) // worker-expected mode…
	fleetAddOnline(t, d.Registry, "alpha")
	fake.setBody("alpha", "/vh/projects", fleetProjectsBody("/any"))
	fake.setBody("alpha", "/vh/snapshot?dir=%2Fany", fleetSnapBody(map[string]state.GateFacts{}))

	resp := decodeFleet(t, doFleet(d.buildRootHandler()))
	if resp.Coverage.Mode != "expected" || resp.Coverage.ProjectScope != "instantiated" {
		t.Fatalf("coverage: want worker-expected + project-instantiated, got %+v", resp.Coverage)
	}
	if resp.Coverage.RequiredProjects != 0 || resp.Coverage.ObservedProjects != 0 || resp.Coverage.UnknownProjects != 0 {
		t.Fatalf("no project roster ⇒ zero project counts, got %+v", resp.Coverage)
	}
	if got := condKinds(resp); len(got) != 0 {
		t.Fatalf("conditions: none expected (discovered project scope unchanged), got %v", got)
	}
	if resp.Overall != fleetOverallNominal {
		t.Fatalf("overall: want nominal, got %s", resp.Overall)
	}
}

// TestFleetStatus_ProjectMissingConditionOrder pins the full display-priority
// order with project_missing present, inserted in the worker tier after
// worker_missing: permission_pending > question_pending > worker_down >
// worker_missing > project_missing > session_error > session_retry. The
// offline `dead` and never-registered `ghost` do NOT suppress project_missing
// (only incomplete ONLINE acquisitions do — absence on reachable workers is
// confirmed), and coverage is incomplete ⇒ overall unknown / known degraded.
func TestFleetStatus_ProjectMissingConditionOrder(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	applyFleetRosters(t, d, []string{"alpha", "dead", "ghost"}, []string{"/gone", "/alpha-proj"}) // ghost never registered ⇒ worker_missing
	fleetAddOnline(t, d.Registry, "alpha")
	fleetAddOnline(t, d.Registry, "dead")
	d.Registry.MarkWorkerOffline("dead") // ⇒ worker_down
	fake.setBody("alpha", "/vh/projects", fleetProjectsBody("/alpha-proj"))
	fake.setBody("alpha", "/vh/snapshot?dir=%2Falpha-proj", fleetSnapBody(map[string]state.GateFacts{
		"s1": fleetGF("idle", true, false),   // permission_pending
		"s2": fleetGF("idle", false, true),   // question_pending
		"s3": fleetGF("error", false, false), // session_error
		"s4": fleetGF("retry", false, false), // session_retry
	}))

	resp := decodeFleet(t, doFleet(d.buildRootHandler()))
	want := []string{
		fleetCondPermissionPending, fleetCondQuestionPending,
		fleetCondWorkerDown, fleetCondWorkerMissing, fleetCondProjectMissing,
		fleetCondSessionError, fleetCondSessionRetry,
	}
	got := condKinds(resp)
	if len(got) != len(want) {
		t.Fatalf("conditions: want %v, got %v", want, got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("conditions order: want %v, got %v", want, got)
		}
	}
	for _, c := range resp.Conditions {
		if c.Kind == fleetCondProjectMissing {
			if c.Count != 1 || c.Link != nil || c.Since == nil || c.Label != "1 project not running" {
				t.Fatalf("project_missing condition: want count=1 since≠nil link=nil, got %+v", c)
			}
		}
	}
	if resp.Overall != fleetOverallUnknown || resp.KnownOverall != fleetOverallDegraded {
		t.Fatalf("overall/known: want unknown/degraded (offline+missing workers), got %s/%s", resp.Overall, resp.KnownOverall)
	}
}

// TestFleetStatus_EmptyDiscoveryUnknown: an empty discovered fleet (nobody
// ever connected) is explicitly INCOMPLETE — overall unknown, zero counts,
// never nominal.
func TestFleetStatus_EmptyDiscoveryUnknown(t *testing.T) {
	d, _ := newFleetTestDaemon(t, "")
	resp := decodeFleet(t, doFleet(d.buildRootHandler()))
	if resp.Overall != fleetOverallUnknown || resp.Coverage.Complete || resp.Coverage.RequiredWorkers != 0 {
		t.Fatalf("empty discovery: want unknown/incomplete/required=0, got overall=%s coverage=%+v", resp.Overall, resp.Coverage)
	}
	if resp.Summary != "Unknown coverage" {
		t.Fatalf("summary: %q", resp.Summary)
	}
	if len(resp.Conditions) != 0 || len(resp.Workers) != 0 {
		t.Fatalf("empty fleet: want no conditions/workers, got %+v", resp)
	}
}

// ---------------------------------------------------------------------------
// Error / limited classification + multi-worker aggregation
// ---------------------------------------------------------------------------

// TestFleetStatus_AcquisitionClassification: malformed discovery JSON ⇒
// `error`; a body over the cap ⇒ `limited`; successful observations from a
// partially-failing worker still contribute (its confirmed project counts,
// while coverage stays incomplete).
func TestFleetStatus_AcquisitionClassification(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	fleetAddOnline(t, d.Registry, "badjson")
	fleetAddOnline(t, d.Registry, "toobig")
	fake.setBody("badjson", "/vh/projects", `{not json`)
	fake.setErr("toobig", fmt.Errorf("worker toobig: %w (%d > %d bytes)", ErrFetchResponseBodyTooLarge, 999, 998))

	resp := decodeFleet(t, doFleet(d.buildRootHandler()))
	if w := workerEntry(t, resp, "badjson"); w.Status != fleetWorkerError {
		t.Fatalf("malformed discovery: want error, got %+v", w)
	}
	if w := workerEntry(t, resp, "toobig"); w.Status != fleetWorkerLimited {
		t.Fatalf("oversize body: want limited, got %+v", w)
	}
	if resp.Coverage.Complete || resp.Overall != fleetOverallUnknown {
		t.Fatalf("failed acquisitions must force unknown overall: %+v %s", resp.Coverage, resp.Overall)
	}
}

// ---------------------------------------------------------------------------
// ETag / generation semantics
// ---------------------------------------------------------------------------

// TestFleetStatus_ETagStableWithinGeneration: within one generation the exact
// bytes and strong ETag are stable; If-None-Match gets a 304 carrying the
// same validator; a plain re-GET returns byte-identical body. One refresh.
func TestFleetStatus_ETagStableWithinGeneration(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	fleetAddOnline(t, d.Registry, "w1")
	fake.setBody("w1", "/vh/projects", fleetProjectsBody(""))
	fake.setBody("w1", "/vh/snapshot", fleetSnapBody(map[string]state.GateFacts{}))
	h := d.buildRootHandler()

	rec1 := doFleet(h)
	etag := rec1.Header().Get("ETag")
	if etag == "" {
		t.Fatalf("missing ETag on 200")
	}
	rec2 := doFleet(h, withINM(etag))
	if rec2.Code != http.StatusNotModified {
		t.Fatalf("If-None-Match with current ETag: want 304, got %d", rec2.Code)
	}
	if got := rec2.Header().Get("ETag"); got != etag {
		t.Fatalf("304 ETag must match the generation's validator: want %q, got %q", etag, got)
	}
	if rec2.Body.Len() != 0 {
		t.Fatalf("304 must carry no body, got %q", rec2.Body.String())
	}
	rec3 := doFleet(h)
	if rec3.Header().Get("ETag") != etag {
		t.Fatalf("ETag changed within a generation")
	}
	if rec3.Body.String() != rec1.Body.String() {
		t.Fatalf("body bytes changed within a generation")
	}
	if n := d.fleetStatusService().refreshCount(); n != 1 {
		t.Fatalf("same-generation requests must not re-refresh: %d refreshes", n)
	}
	// A bogus If-None-Match is not a match.
	rec4 := doFleet(h, withINM(`"nope"`))
	if rec4.Code != http.StatusOK {
		t.Fatalf("non-matching If-None-Match: want 200, got %d", rec4.Code)
	}
}

// TestFleetStatus_LivenessInvalidationNoStale304 pins instant invalidation:
// MarkWorkerOffline (exactly what the tunnel-WS close path runs) bumps the
// registry generation, so the NEXT request must NOT serve (nor 304) the stale
// generation — it refreshes and publishes different bytes with a different
// ETag.
func TestFleetStatus_LivenessInvalidationNoStale304(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	fleetAddOnline(t, d.Registry, "w1")
	fleetAddOnline(t, d.Registry, "w2")
	for _, id := range []string{"w1", "w2"} {
		fake.setBody(id, "/vh/projects", fleetProjectsBody(""))
		fake.setBody(id, "/vh/snapshot", fleetSnapBody(map[string]state.GateFacts{}))
	}
	h := d.buildRootHandler()

	rec1 := doFleet(h)
	etag1 := rec1.Header().Get("ETag")
	resp1 := decodeFleet(t, rec1)
	if !resp1.Coverage.Complete || resp1.Overall != fleetOverallNominal {
		t.Fatalf("setup: two healthy workers should be complete/nominal, got %+v", resp1)
	}

	d.Registry.MarkWorkerOffline("w2")

	rec2 := doFleet(h, withINM(etag1))
	if rec2.Code == http.StatusNotModified {
		t.Fatalf("STALE generation answered 304 after liveness invalidation")
	}
	if rec2.Code != http.StatusOK {
		t.Fatalf("post-invalidation GET: want 200, got %d", rec2.Code)
	}
	if etag2 := rec2.Header().Get("ETag"); etag2 == etag1 {
		t.Fatalf("post-invalidation ETag must differ from the stale generation's")
	}
	resp2 := decodeFleet(t, rec2)
	if w := workerEntry(t, resp2, "w2"); w.Status != fleetWorkerOffline {
		t.Fatalf("post-invalidation rollup must show w2 offline, got %+v", w)
	}
	if resp2.Overall != fleetOverallUnknown {
		t.Fatalf("post-invalidation overall: want unknown, got %s", resp2.Overall)
	}
	if n := d.fleetStatusService().refreshCount(); n != 2 {
		t.Fatalf("liveness change must force a refresh: %d refreshes", n)
	}
}

// ---------------------------------------------------------------------------
// Single-flight coalescing
// ---------------------------------------------------------------------------

// TestFleetStatus_ConcurrentRequestsCoalesce: N concurrent requests during a
// slow refresh are all served by exactly ONE refresh (poll rate decoupled
// from acquisition cost).
func TestFleetStatus_ConcurrentRequestsCoalesce(t *testing.T) {
	d, _ := newFleetTestDaemon(t, "")
	fleetAddOnline(t, d.Registry, "slow")
	svc := d.fleetStatusService()
	svc.budgets.TTL = 2 * time.Second // no TTL-driven second refresh mid-test

	started := make(chan struct{}, 1)
	release := make(chan struct{})
	var once sync.Once
	d.fetchWorkerJSON = func(ctx context.Context, workerID, path string, timeout time.Duration, maxBody int64) ([]byte, error) {
		once.Do(func() { started <- struct{}{} })
		select {
		case <-release:
			return []byte(fleetProjectsBody("")), nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	h := d.buildRootHandler()

	const n = 8
	recs := make(chan *httptest.ResponseRecorder, n)
	for i := 0; i < n; i++ {
		go func() { recs <- doFleet(h) }()
	}
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		t.Fatalf("refresh never started")
	}
	// Give any would-be duplicate refreshes a chance to (wrongly) fire.
	time.Sleep(150 * time.Millisecond)
	close(release)

	etags := map[string]int{}
	for i := 0; i < n; i++ {
		rec := <-recs
		if rec.Code != http.StatusOK {
			t.Fatalf("coalesced request: want 200, got %d (body=%q)", rec.Code, rec.Body.String())
		}
		etags[rec.Header().Get("ETag")]++
	}
	if len(etags) != 1 {
		t.Fatalf("all coalesced responses must share one generation ETag, got %v", etags)
	}
	if got := svc.refreshCount(); got != 1 {
		t.Fatalf("concurrent requests must coalesce onto ONE refresh, got %d", got)
	}
}

// ---------------------------------------------------------------------------
// Auth (session-cookie family) + method semantics
// ---------------------------------------------------------------------------

// TestFleetStatus_AuthSessionFamily pins the endpoint's security posture:
// registered on userMux behind Auth.Middleware (same session-cookie family
// as GET /api/workers). Under /vh/*, auth's isAPIRequest classifies EVERY
// unauthenticated request as an API call — browser-shaped GETs included — so
// they get the middleware's clean 401 challenge, never the 303→/auth/login
// redirect the old /api/… browser-shaped path had (deliberate improvement
// for the watch/bridge's non-browser consumers: no Accept header needed).
// An authenticated session gets 200; POST is 405 (GET-only pattern) — and,
// unlike /api/ paths, csrfGuard does not intercept the unsafe method first
// (it gates /api/ only), so the 405 fires with or without X-VH-CSRF.
func TestFleetStatus_AuthSessionFamily(t *testing.T) {
	d, _ := newFleetTestDaemon(t, "")
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a
	h := d.buildRootHandler()
	session := loginPassphrase(t, h, "secret")

	// 1. Unauthenticated, API-shaped (Accept: application/json) → 401.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/fleet/status", nil)
	req.Header.Set("Accept", "application/json")
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated API GET: want 401, got %d", rec.Code)
	}

	// 2. Unauthenticated browser-shaped GET (no Accept header) → 401 too:
	// /vh/* is in isAPIRequest's API class, so the middleware challenges
	// instead of redirecting to /auth/login (the deliberate auth-behavior
	// change of moving off the /api/ browser path).
	rec2 := httptest.NewRecorder()
	h.ServeHTTP(rec2, httptest.NewRequest(http.MethodGet, "/vh/fleet/status", nil))
	if rec2.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated browser-shaped GET: want 401 (/vh/* is API class), got %d %q", rec2.Code, rec2.Header().Get("Location"))
	}
	if loc := rec2.Header().Get("Location"); loc != "" {
		t.Fatalf("unauthenticated browser-shaped GET: must NOT redirect, got Location %q", loc)
	}

	// 3. Authenticated GET → 200 (fresh rollup of an empty fleet).
	rec3 := doFleet(h, withCookie(session))
	if rec3.Code != http.StatusOK {
		t.Fatalf("authenticated GET: want 200, got %d (body=%q)", rec3.Code, rec3.Body.String())
	}

	// 4. GET needs no X-VH-CSRF (read-only): already proven by (3) — no CSRF
	// header was sent.

	// 5. Authenticated POST without X-VH-CSRF → 405 (GET-only route).
	// csrfGuard gates unsafe methods under /api/ only, so it does not fire
	// here; the userMux method pattern answers 405 directly.
	rec5 := httptest.NewRecorder()
	req5 := httptest.NewRequest(http.MethodPost, "/vh/fleet/status", nil)
	req5.AddCookie(session)
	h.ServeHTTP(rec5, req5)
	if rec5.Code != http.StatusMethodNotAllowed {
		t.Fatalf("authenticated POST without CSRF: want 405 (GET-only route, outside csrfGuard), got %d", rec5.Code)
	}

	// 6. Authenticated POST with X-VH-CSRF → still 405 from the GET-only
	// route (the header is irrelevant outside /api/).
	rec6 := httptest.NewRecorder()
	req6 := httptest.NewRequest(http.MethodPost, "/vh/fleet/status", nil)
	req6.AddCookie(session)
	req6.Header.Set("X-VH-CSRF", "1")
	h.ServeHTTP(rec6, req6)
	if rec6.Code != http.StatusMethodNotAllowed {
		t.Fatalf("authenticated POST with CSRF: want 405 (GET-only route), got %d", rec6.Code)
	}
}

// ---------------------------------------------------------------------------
// hostInterceptor carve-out (worker-subdomain precedence)
// ---------------------------------------------------------------------------

// TestHostInterceptorFleetStatusRoutePrecedence pins the critical property
// (mirroring the TestHostInterceptorDiagLatencyRoutePrecedence precedent): a
// browser loaded from a per-worker subdomain (e.g. "workerID.controller.host")
// hitting `/vh/fleet/status` MUST be served by the CONTROLLER's fleet rollup,
// NOT proxied down to that worker through hostInterceptor. The worker has no
// /vh/fleet/* route, so a proxied request would 404 at the worker (or 502
// before leaving the controller when the transport is dead) — the rollup is
// controller-owned and must answer from every host.
//
// We build the full controller chain (auth + csrfGuard + hostInterceptor +
// userMux) with passphrase auth, register "abc" as an online worker with NO
// real transport (so the proxy path would 502), plus a genuinely online
// "live" worker whose acquisition is served by the injected fake. A request
// with Host "abc.controller.test" must get the rollup body (200, schema 1)
// with the fake seam exercised — proving the carve-out fired BEFORE
// hostInterceptor's pattern match. If the carve-out fails the request reaches
// HandleWorkerDirect → handleRawProxy → 502 on the nil transport; we assert
// against that specifically.
func TestHostInterceptorFleetStatusRoutePrecedence(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "$ID.controller.test")
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a
	// Register an online worker WITHOUT a real transport. If the carve-out
	// fails, the request reaches HandleWorkerDirect → handleRawProxy, which
	// returns 502 on the nil transport. The carve-out means we never get
	// there, so we want a 200 rollup, not a 502.
	d.Registry.AddWorker(&Worker{ID: "abc", Name: "abc-worker", Status: "online", Version: "v1"})
	// A genuinely online worker (real yamux pair so Summaries reports it
	// online) whose acquisition runs through the injected fake — the fake
	// being called is the proof that the CONTROLLER's rollup handled the
	// request (the proxy path would 502 before any fetcher call).
	fleetAddOnline(t, d.Registry, "live")
	fake.setBody("live", "/vh/projects", fleetProjectsBody(""))
	fake.setBody("live", "/vh/snapshot", fleetSnapBody(map[string]state.GateFacts{}))

	h := d.buildRootHandler()
	session := loginPassphrase(t, h, "secret")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/fleet/status", nil)
	req.Host = "abc.controller.test"
	req.AddCookie(session)
	h.ServeHTTP(rec, req)

	if rec.Code == http.StatusBadGateway {
		t.Fatalf("hostInterceptor proxied /vh/fleet/status to the worker (502) — carve-out missing or broken")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200 fleet rollup, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if n := fake.count("live"); n == 0 {
		t.Fatalf("rollup acquisition never ran — request did not reach the controller's fleet-status handler (carve-out broken?)")
	}
	resp := decodeFleet(t, rec)
	if resp.Schema != 1 {
		t.Fatalf("response is not the fleet rollup (schema %d)", resp.Schema)
	}
	// abc: registry-online but nil transport ⇒ Summaries offline ⇒ reported
	// offline with NO fan-out (only "live" was acquired).
	if w := workerEntry(t, resp, "abc"); w.Status != fleetWorkerOffline {
		t.Fatalf("nil-transport worker abc: want offline in rollup, got %+v", w)
	}
	if w := workerEntry(t, resp, "live"); w.Status != fleetWorkerOK {
		t.Fatalf("online worker live: want ok in rollup, got %+v", w)
	}
}

// ---------------------------------------------------------------------------
// Since-continuity (unit-level, controlled clocks)
// ---------------------------------------------------------------------------

// TestFleetStatus_SinceContinuity drives buildRollup directly with explicit
// timestamps: `since` is the FIRST CONTINUOUSLY observed time — it survives
// consecutive generations, disappears with the condition, and RESETS when the
// contributor reappears (continuity was lost).
func TestFleetStatus_SinceContinuity(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	fleetAddOnline(t, d.Registry, "w1")
	fake.setBody("w1", "/vh/projects", fleetProjectsBody(""))
	pending := fleetSnapBody(map[string]state.GateFacts{"s1": fleetGF("idle", true, false)})
	cleared := fleetSnapBody(map[string]state.GateFacts{"s1": fleetGF("idle", false, false)})
	fake.setBody("w1", "/vh/snapshot", pending)

	svc := d.fleetStatusService()
	snap := d.statusCfg.snapshot()
	t0 := time.Date(2026, 9, 26, 10, 0, 0, 0, time.UTC)

	r1 := svc.buildRollup(t0, snap)
	if len(r1.Conditions) != 1 || r1.Conditions[0].Kind != fleetCondPermissionPending || r1.Conditions[0].Since == nil {
		t.Fatalf("gen1: want one permission_pending with since, got %+v", r1.Conditions)
	}
	if got := *r1.Conditions[0].Since; got != "2026-09-26T10:00:00Z" {
		t.Fatalf("gen1 since: want birth time, got %s", got)
	}

	r2 := svc.buildRollup(t0.Add(3*time.Second), snap)
	if got := *r2.Conditions[0].Since; got != "2026-09-26T10:00:00Z" {
		t.Fatalf("gen2 (continuous): since must persist, got %s", got)
	}

	fake.setBody("w1", "/vh/snapshot", cleared)
	r3 := svc.buildRollup(t0.Add(6*time.Second), snap)
	if len(r3.Conditions) != 0 {
		t.Fatalf("gen3 (condition gone): want no conditions, got %+v", r3.Conditions)
	}

	fake.setBody("w1", "/vh/snapshot", pending)
	r4 := svc.buildRollup(t0.Add(9*time.Second), snap)
	if got := *r4.Conditions[0].Since; got != "2026-09-26T10:00:09Z" {
		t.Fatalf("gen4 (reappeared): since must RESET to the new birth time, got %s", got)
	}
}

// ---------------------------------------------------------------------------
// Summary budget (pure function)
// ---------------------------------------------------------------------------

// TestFleetSummaryLengthCap: every composed summary fits the 30-code-point
// ceiling, degrading deterministically through the phrase/short/word ladder.
func TestFleetSummaryLengthCap(t *testing.T) {
	cases := []struct {
		complete bool
		kind     string
		count    int
		want     string
	}{
		{true, "", 0, "Nominal"},
		{false, "", 0, "Unknown coverage"},
		{false, fleetCondPermissionPending, 2, "Unknown; 2 permissions"},
		{false, fleetCondQuestionPending, 1, "Unknown; 1 question"},
		{true, fleetCondPermissionPending, 1, "1 permission pending"},
		{true, fleetCondSessionError, 3, "3 session errors"},
		// project_missing phrases: n==1 fits the full short form exactly;
		// n>1 overflows it and degrades to the bare kind word.
		{false, fleetCondProjectMissing, 1, "Unknown; 1 project not running"},
		{false, fleetCondProjectMissing, 2, "Unknown; projects not running"},
		{true, fleetCondProjectMissing, 2, "2 projects not running"},
		// Huge counts overflow the phrase forms → deterministic fallbacks.
		{false, fleetCondSessionError, 1000000000, "Unknown; 1000000000 errors"},
		{false, fleetCondWorkerDown, 1000000000, "Unknown; workers down"},
		{true, fleetCondWorkerDown, 1000000000, "1000000000 workers down"},
	}
	for _, c := range cases {
		got := fleetSummary(c.complete, c.kind, c.count)
		if got != c.want {
			t.Errorf("fleetSummary(%v,%q,%d) = %q, want %q", c.complete, c.kind, c.count, got, c.want)
		}
		if n := len([]rune(got)); n > 30 {
			t.Errorf("fleetSummary(%v,%q,%d) = %q exceeds 30 code points (%d)", c.complete, c.kind, c.count, got, n)
		}
	}
}
