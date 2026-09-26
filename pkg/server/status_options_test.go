package server

// status_options_test.go — lane-1 co-located tests for GET
// /vh/fleet/config/options, the add-row picker feed of the fleet-status
// config pane. Mirrors the family's established patterns: the acquisition
// seam is faked (fetchWorkerJSON — see status_test.go scaffolding), the
// handler chain is the REAL one (auth + csrfGuard + hostInterceptor +
// userMux), and the carve-out gets its own precedence test sibling to
// TestHostInterceptorFleetConfigRoutePrecedence / …FleetStatusRoutePrecedence.
//
// Pinned contract:
//   - shape from a scripted generation (schema 1, workers with rollup
//     statuses, projects = worker-REPORTED dirs with hosting worker ids);
//   - ONE generation for both endpoints: an options GET after a status GET
//     adds ZERO refreshes and ZERO acquisition calls (the feed is a second
//     view of the same refresh, not a new fan-out);
//   - expected-mode union: roster workers pass their rollup status through
//     (missing included), registry workers OUTSIDE the roster surface as
//     "online" (connected, never acquired — the prime add candidate), and
//     dirs the expected-PROJECT roster excluded from acquisition still
//     appear (discovery-level suggestion knowledge);
//   - auth: unauthenticated GET gets the clean /vh/* 401;
//   - hostInterceptor carve-out: a worker-subdomain host reaches the
//     CONTROLLER's handler, not the proxy.

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/auth"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

func doFleetOptions(h http.Handler, opts ...func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/vh/fleet/config/options", nil)
	for _, o := range opts {
		o(req)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeFleetOptions(t *testing.T, rec *httptest.ResponseRecorder) fleetOptionsResponse {
	t.Helper()
	var resp fleetOptionsResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode /vh/fleet/config/options body: %v (body=%q)", err, rec.Body.String())
	}
	return resp
}

// TestFleetOptions_ShapeDiscoveredMode drives a two-worker fleet through the
// real handler and pins the discovered-mode feed: every worker with its
// rollup status, project dirs as the union of per-worker discovery with
// SORTED hosting worker lists, and — the load-bearing property — an options
// GET served from the SAME generation as a preceding status GET (no new
// refresh, no new acquisition).
func TestFleetOptions_ShapeDiscoveredMode(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	fleetAddOnline(t, d.Registry, "alpha")
	fleetAddOnline(t, d.Registry, "beta")
	fake.setBody("alpha", "/vh/projects", fleetProjectsBody("", "/repo"))
	fake.setBody("alpha", "/vh/snapshot", fleetSnapBody(map[string]state.GateFacts{}))
	fake.setBody("alpha", "/vh/snapshot?dir=%2Frepo", fleetSnapBody(map[string]state.GateFacts{}))
	fake.setBody("beta", "/vh/projects", fleetProjectsBody("/repo"))
	fake.setBody("beta", "/vh/snapshot?dir=%2Frepo", fleetSnapBody(map[string]state.GateFacts{}))

	h := d.buildRootHandler()

	// Prime the generation with a status GET, then snapshot the work done.
	recStatus := doFleet(h)
	if recStatus.Code != http.StatusOK {
		t.Fatalf("GET /vh/fleet/status: want 200, got %d", recStatus.Code)
	}
	svc := d.fleetStatusService()
	refreshes := svc.refreshCount()
	calls := fake.totalCalls()

	rec := doFleetOptions(h)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /vh/fleet/config/options: want 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type: want application/json, got %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "private, no-cache" {
		t.Fatalf("Cache-Control: want \"private, no-cache\", got %q", cc)
	}
	resp := decodeFleetOptions(t, rec)
	t.Logf("GET /vh/fleet/config/options -> %d: %s", rec.Code, rec.Body.String())
	if resp.Schema != 1 {
		t.Fatalf("schema: want 1, got %d", resp.Schema)
	}
	if _, err := time.Parse(time.RFC3339, resp.GeneratedAt); err != nil {
		t.Fatalf("generated_at not RFC3339: %v", err)
	}
	wantW := []fleetOptionsWorker{{ID: "alpha", Status: fleetWorkerOK}, {ID: "beta", Status: fleetWorkerOK}}
	if !reflect.DeepEqual(resp.Workers, wantW) {
		t.Fatalf("workers: want %+v, got %+v", wantW, resp.Workers)
	}
	wantP := []fleetOptionsProject{
		{Dir: "", Workers: []string{"alpha"}},
		{Dir: "/repo", Workers: []string{"alpha", "beta"}},
	}
	if !reflect.DeepEqual(resp.Projects, wantP) {
		t.Fatalf("projects: want %+v, got %+v", wantP, resp.Projects)
	}

	// THE no-extra-acquisition property: the options GET added no refresh
	// and no acquisition — it is a second view of the cached generation.
	if n := svc.refreshCount(); n != refreshes {
		t.Fatalf("options GET must not trigger a refresh (refreshes %d → %d)", refreshes, n)
	}
	if n := fake.totalCalls(); n != calls {
		t.Fatalf("options GET must not acquire anything (fetch calls %d → %d)", calls, n)
	}

	// Empty workers/projects render as [], never null (family convention).
	d2, _ := newFleetTestDaemon(t, "")
	h2 := d2.buildRootHandler()
	rec2 := doFleetOptions(h2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("empty fleet options: want 200, got %d", rec2.Code)
	}
	if body := rec2.Body.String(); !strings.Contains(body, `"workers":[]`) || !strings.Contains(body, `"projects":[]`) {
		t.Fatalf("empty feed must render [] arrays: %s", body)
	}
}

// TestFleetOptions_ExpectedModeUnion pins the expected-mode derivation the
// picker exists for: roster workers keep their rollup status (ghost, never
// seen by the registry, surfaces as missing), a CONNECTED worker outside the
// roster surfaces as "online" (never acquired — not "ok"), and a dir the
// expected-PROJECT roster excluded from acquisition still appears in the
// feed with its hosting worker (discovery-level knowledge).
func TestFleetOptions_ExpectedModeUnion(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	applyFleetRosters(t, d, []string{"alpha", "ghost"}, []string{"/repo"})
	fleetAddOnline(t, d.Registry, "alpha")
	fleetAddOnline(t, d.Registry, "beta") // connected, NOT in the roster
	// alpha reports BOTH the rostered dir and an unrostered one; only
	// /repo is acquired (the fake errors on any unexpected snapshot fetch,
	// so alpha staying ok also proves /other was never fetched).
	fake.setBody("alpha", "/vh/projects", fleetProjectsBody("/other", "/repo"))
	fake.setBody("alpha", "/vh/snapshot?dir=%2Frepo", fleetSnapBody(map[string]state.GateFacts{}))

	h := d.buildRootHandler()
	rec := doFleetOptions(h)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /vh/fleet/config/options: want 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	resp := decodeFleetOptions(t, rec)

	wantW := []fleetOptionsWorker{
		{ID: "alpha", Status: fleetWorkerOK},
		{ID: "beta", Status: fleetWorkerOnline},
		{ID: "ghost", Status: fleetWorkerMissing},
	}
	if !reflect.DeepEqual(resp.Workers, wantW) {
		t.Fatalf("workers: want %+v, got %+v", wantW, resp.Workers)
	}
	// /other appears DESPITE the roster filter excluding it from
	// acquisition — the pane's add-project suggestion for exactly this dir.
	wantP := []fleetOptionsProject{
		{Dir: "/other", Workers: []string{"alpha"}},
		{Dir: "/repo", Workers: []string{"alpha"}},
	}
	if !reflect.DeepEqual(resp.Projects, wantP) {
		t.Fatalf("projects: want %+v, got %+v", wantP, resp.Projects)
	}
	// beta (out of roster scope) was never acquired.
	if n := fake.count("beta"); n != 0 {
		t.Fatalf("unrostered worker beta must never be acquired, got %d fetch calls", n)
	}
}

// TestFleetOptions_AuthRequired: the feed rides the session-cookie family —
// an unauthenticated GET gets the clean /vh/* API 401, never the browser
// 303→/auth/login redirect.
func TestFleetOptions_AuthRequired(t *testing.T) {
	_, h, _ := newFleetConfigAuthDaemon(t, "")
	rec := doFleetOptions(h)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET options: want 401, got %d (body=%q)", rec.Code, rec.Body.String())
	}
}

// TestHostInterceptorFleetOptionsRoutePrecedence mirrors
// TestHostInterceptorFleetConfigRoutePrecedence (status_config_test.go) and
// TestHostInterceptorFleetStatusRoutePrecedence (status_test.go) for the
// picker feed: a browser loaded from a per-worker subdomain hitting GET
// /vh/fleet/config/options MUST be served by the CONTROLLER, NOT proxied
// down to that worker (which has no /vh/fleet/* route; its catch-all would
// serve the SPA shell the pane cannot parse — and with a nil transport the
// proxy 502s before leaving the controller).
//
// Setup: full controller chain with HostPattern set; "abc" registered
// online with NO transport (a broken carve-out reaches HandleWorkerDirect →
// handleRawProxy → 502); "live" genuinely online with scripted acquisition.
// The carve-out must answer 200 JSON from the options handler with the fake
// exercised.
func TestHostInterceptorFleetOptionsRoutePrecedence(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "$ID.controller.test")
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a
	d.Registry.AddWorker(&Worker{ID: "abc", Name: "abc-worker", Status: "online", Version: "v1"})
	fleetAddOnline(t, d.Registry, "live")
	fake.setBody("live", "/vh/projects", fleetProjectsBody("/x"))
	fake.setBody("live", "/vh/snapshot?dir=%2Fx", fleetSnapBody(map[string]state.GateFacts{}))

	h := d.buildRootHandler()
	session := loginPassphrase(t, h, "secret")

	rec := doFleetOptions(h, withCookie(session), withHost("abc.controller.test"))
	if rec.Code == http.StatusBadGateway {
		t.Fatalf("hostInterceptor proxied GET /vh/fleet/config/options to the worker (502) — carve-out missing or broken")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200 options on a worker subdomain, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type: want application/json (controller handler), got %q", ct)
	}
	resp := decodeFleetOptions(t, rec)
	if resp.Schema != 1 {
		t.Fatalf("response is not the options envelope (schema %d)", resp.Schema)
	}
	// abc: registry-online but nil transport ⇒ Summaries offline ⇒ offline
	// in the feed with NO fan-out (only "live" was acquired).
	wantW := []fleetOptionsWorker{
		{ID: "abc", Status: fleetWorkerOffline},
		{ID: "live", Status: fleetWorkerOK},
	}
	if !reflect.DeepEqual(resp.Workers, wantW) {
		t.Fatalf("workers: want %+v, got %+v", wantW, resp.Workers)
	}
	if len(resp.Projects) != 1 || resp.Projects[0].Dir != "/x" || !reflect.DeepEqual(resp.Projects[0].Workers, []string{"live"}) {
		t.Fatalf("projects: want [/x on live], got %+v", resp.Projects)
	}
	if n := fake.count("live"); n == 0 {
		t.Fatalf("rollup acquisition never ran — request did not reach the controller's options handler (carve-out broken?)")
	}
}
