package server

// status_config_test.go — lane-1 co-located tests for the fleet-status
// configuration core (slice C1 of the config redesign; see
// status_config.go). Covers: the strict decode/validate matrix shared by the
// file load and the PUT body; startup load failures (path named, state
// untouched); the GET/PUT manage API shape and refusals (403 CSRF / 400
// invalid / 409 unwritable / 401 unauthenticated / 405 wrong method); and
// the crux — a PUT through the REAL handler chain that persists the file
// atomically and ACTUALLY changes the live rollup scope (the published
// generation is invalidated by the config-generation bump, not by TTL).

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/auth"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

// applyFleetRosters installs rosters through the same validated path a
// config file / PUT body takes (labels omitted), leaving the holder
// unwritable (no persistence path) — rollup-semantics tests don't exercise
// persistence. Fails the test if the rosters would not pass config
// validation, so a future validation tightening that would silently change
// rollup semantics is caught here.
func applyFleetRosters(t *testing.T, d *Daemon, workers, projects []string) {
	t.Helper()
	cfg := &fleetStatusConfig{}
	for _, id := range workers {
		cfg.Workers = append(cfg.Workers, fleetConfigWorker{ID: id})
	}
	for _, dir := range projects {
		cfg.Projects = append(cfg.Projects, fleetConfigProject{Dir: dir})
	}
	if err := validateStatusConfig(cfg); err != nil {
		t.Fatalf("test roster must be a valid config: %v", err)
	}
	d.statusCfg.applyValidated(cfg)
}

func withCSRF() func(*http.Request) {
	return func(r *http.Request) { r.Header.Set(csrfHeader, "1") }
}

// withHost pins the request's Host header — the hostInterceptor's routing
// input (a per-worker subdomain that matches the daemon's HostPattern).
func withHost(host string) func(*http.Request) {
	return func(r *http.Request) { r.Host = host }
}

func doFleetConfigGet(h http.Handler, opts ...func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/vh/fleet/config", nil)
	for _, o := range opts {
		o(req)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func doFleetConfigPut(h http.Handler, body string, opts ...func(*http.Request)) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodPut, "/vh/fleet/config", strings.NewReader(body))
	for _, o := range opts {
		o(req)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func decodeFleetConfig(t *testing.T, rec *httptest.ResponseRecorder) fleetConfigResponse {
	t.Helper()
	var resp fleetConfigResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode /vh/fleet/config body: %v (body=%q)", err, rec.Body.String())
	}
	return resp
}

// newFleetConfigAuthDaemon builds a passphrase-auth daemon around the fake
// acquisition seam and returns the root handler + session cookie.
func newFleetConfigAuthDaemon(t *testing.T, hostPattern string) (*Daemon, http.Handler, *http.Cookie) {
	t.Helper()
	d, _ := newFleetTestDaemon(t, hostPattern)
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a
	h := d.buildRootHandler()
	return d, h, loginPassphrase(t, h, "secret")
}

// ---------------------------------------------------------------------------
// Strict decode / validate matrix (shared by file load and PUT body)
// ---------------------------------------------------------------------------

// TestFleetConfig_DecodeValidationMatrix pins the strict document contract:
// JSONC comments and trailing commas accepted on read, string literals
// preserved, unknown keys rejected at every level, exactly one document,
// duplicate ids/dirs rejected, worker ids must be safe host labels, project
// dirs verbatim (blank rejected, whitespace preserved), labels ≤64 code
// points, and the decoded result canonicalized (sorted).
func TestFleetConfig_DecodeValidationMatrix(t *testing.T) {
	valid := []struct {
		name string
		in   string
		want *fleetStatusConfig
	}{
		{"empty object", `{}`, &fleetStatusConfig{}},
		{"comments and trailing commas", "{\n  // line comment\n  /* block\n     comment */\n  \"workers\": [{ \"id\": \"a\", },],\n  \"projects\": [ { \"dir\": \"/x\", }, ],\n}\n",
			&fleetStatusConfig{Workers: []fleetConfigWorker{{ID: "a"}}, Projects: []fleetConfigProject{{Dir: "/x"}}}},
		{"comment-like text inside a string is preserved", `{"workers":[{"id":"a","label":"see // not a comment"}],"projects":[]}`,
			&fleetStatusConfig{Workers: []fleetConfigWorker{{ID: "a", Label: "see // not a comment"}}, Projects: []fleetConfigProject{}}},
		{"unsorted input canonicalized", `{"workers":[{"id":"beta"},{"id":"alpha"}],"projects":[{"dir":"/b"},{"dir":"/a"}]}`,
			&fleetStatusConfig{Workers: []fleetConfigWorker{{ID: "alpha"}, {ID: "beta"}}, Projects: []fleetConfigProject{{Dir: "/a"}, {Dir: "/b"}}}},
		{"dirs verbatim including surrounding whitespace", `{"workers":[],"projects":[{"dir":"  /repo "},{"dir":" /repo"},{"dir":"/repo"}]}`,
			&fleetStatusConfig{Workers: []fleetConfigWorker{}, Projects: []fleetConfigProject{{Dir: "  /repo "}, {Dir: " /repo"}, {Dir: "/repo"}}}},
		{"label exactly 64 code points", `{"workers":[{"id":"a","label":"` + strings.Repeat("x", 64) + `"}],"projects":[]}`,
			&fleetStatusConfig{Workers: []fleetConfigWorker{{ID: "a", Label: strings.Repeat("x", 64)}}, Projects: []fleetConfigProject{}}},
		{"label exactly 64 CJK code points", `{"workers":[{"id":"a","label":"` + strings.Repeat("世", 64) + `"}],"projects":[]}`,
			&fleetStatusConfig{Workers: []fleetConfigWorker{{ID: "a", Label: strings.Repeat("世", 64)}}, Projects: []fleetConfigProject{}}},
		{"host-label punctuation ids", `{"workers":[{"id":"build-box.dev_1"}],"projects":[]}`,
			&fleetStatusConfig{Workers: []fleetConfigWorker{{ID: "build-box.dev_1"}}, Projects: []fleetConfigProject{}}},
	}
	for _, tc := range valid {
		got, err := decodeStatusConfig([]byte(tc.in))
		if err != nil {
			t.Errorf("%s: decodeStatusConfig: unexpected error: %v", tc.name, err)
			continue
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%s: decoded config = %+v, want %+v", tc.name, got, tc.want)
		}
	}

	invalid := []struct {
		name   string
		in     string
		marker string
	}{
		{"null document", `null`, "JSON object, not null"},
		{"empty document", `   `, "empty document"},
		{"top-level array", `[]`, "invalid JSON"},
		{"trailing second document", `{"workers":[]} {"workers":[]}`, "exactly one JSON document"},
		{"unknown top-level key", `{"workers":[],"projects":[],"extra":1}`, `unknown field "extra"`},
		{"unknown nested key", `{"workers":[{"id":"a","bogus":1}]}`, `unknown field "bogus"`},
		{"workers wrong type (number)", `{"workers":5}`, "invalid JSON"},
		{"workers wrong type (string array)", `{"workers":["alpha"]}`, "invalid JSON"},
		{"worker id null", `{"workers":[{"id":null}]}`, "invalid worker id"},
		{"worker id empty", `{"workers":[{"id":""}]}`, "invalid worker id"},
		{"worker id with space", `{"workers":[{"id":"a b"}]}`, "invalid worker id"},
		{"worker id with slash", `{"workers":[{"id":"a/b"}]}`, "invalid worker id"},
		{"worker id with hash", `{"workers":[{"id":"a#b"}]}`, "invalid worker id"},
		{"worker id with colon", `{"workers":[{"id":"a:b"}]}`, "invalid worker id"},
		{"worker id with control byte", `{"workers":[{"id":"a\u0000b"}]}`, "invalid worker id"},
		{"duplicate worker id", `{"workers":[{"id":"a"},{"id":"a"}]}`, `duplicate worker id "a"`},
		{"duplicate project dir", `{"projects":[{"dir":"/x"},{"dir":"/x"}]}`, `duplicate project dir "/x"`},
		{"blank project dir empty", `{"projects":[{"dir":""}]}`, "blank project dir"},
		{"blank project dir whitespace", `{"projects":[{"dir":"   "}]}`, "blank project dir"},
		{"blank project dir tab-newline", `{"projects":[{"dir":"\t\n"}]}`, "blank project dir"},
		{"label 65 code points", `{"workers":[{"id":"a","label":"` + strings.Repeat("x", 65) + `"}]}`, "code points exceeds"},
		{"label 65 CJK code points", `{"workers":[{"id":"a","label":"` + strings.Repeat("世", 65) + `"}]}`, "code points exceeds"},
		{"project label too long", `{"projects":[{"dir":"/x","label":"` + strings.Repeat("y", 65) + `"}]}`, "code points exceeds"},
	}
	for _, tc := range invalid {
		_, err := decodeStatusConfig([]byte(tc.in))
		if err == nil {
			t.Errorf("%s: decodeStatusConfig accepted invalid document %q", tc.name, tc.in)
			continue
		}
		if !strings.Contains(err.Error(), tc.marker) {
			t.Errorf("%s: error %q does not contain marker %q", tc.name, err.Error(), tc.marker)
		}
	}
}

// TestFleetRosterNormalizeSemantics pins the landed normalize semantics the
// rollup still applies to holder rosters (trim/dedupe/drop-blank/sort for
// workers; verbatim + drop-blank/dedupe/sort for projects). The config
// boundary now guarantees validity, so these are defensive — but they ARE
// the semantics the rollup inherits, so they stay pinned here after the
// flag removal moved the blank/dedupe handling into validation.
func TestFleetRosterNormalizeSemantics(t *testing.T) {
	if got := normalizeFleetRoster([]string{"beta", "  alpha ", "", "beta"}); !reflect.DeepEqual(got, []string{"alpha", "beta"}) {
		t.Fatalf("normalizeFleetRoster: want [alpha beta], got %v", got)
	}
	if got := normalizeFleetRoster(nil); len(got) != 0 {
		t.Fatalf("normalizeFleetRoster(nil): want empty, got %v", got)
	}
	// "  /repo " and "/repo" are DISTINCT verbatim entries; blank dropped;
	// sorted by raw string (leading space sorts first).
	if got := normalizeProjectRoster([]string{"  /repo ", "", "/repo", "  /repo "}); !reflect.DeepEqual(got, []string{"  /repo ", "/repo"}) {
		t.Fatalf("normalizeProjectRoster: want [\"  /repo \", \"/repo\"], got %v", got)
	}
	if got := normalizeProjectRoster(nil); len(got) != 0 {
		t.Fatalf("normalizeProjectRoster(nil): want empty, got %v", got)
	}
}

// ---------------------------------------------------------------------------
// Startup file loading
// ---------------------------------------------------------------------------

// TestFleetConfig_LoadFileWithComments drives the real startup path
// (--status-config → Daemon.LoadStatusConfig) with a hand-written JSONC
// file: comments and trailing commas accepted, entries canonicalized,
// verbatim dirs preserved, holder left writable.
func TestFleetConfig_LoadFileWithComments(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "status.jsonc")
	seed := "{\n  // expected fleet for the rollup\n  \"workers\": [{ \"id\": \"zeta\", \"label\": \"Zeta box\" }, { \"id\": \"alpha\" },],\n  /* projects */\n  \"projects\": [ { \"dir\": \"  /keep ws  \" }, { \"dir\": \"/plain\" }, ],\n}\n"
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}

	d, _ := newFleetTestDaemon(t, "")
	if err := d.LoadStatusConfig(path); err != nil {
		t.Fatalf("LoadStatusConfig: %v", err)
	}
	snap := d.statusCfg.snapshot()
	if snap.path == "" {
		t.Fatalf("holder must record the persistence path after a file load (writable)")
	}
	wantW := []fleetConfigWorker{{ID: "alpha"}, {ID: "zeta", Label: "Zeta box"}}
	wantP := []fleetConfigProject{{Dir: "  /keep ws  "}, {Dir: "/plain"}}
	if !reflect.DeepEqual(snap.workers, wantW) {
		t.Fatalf("workers: want %+v, got %+v", wantW, snap.workers)
	}
	if !reflect.DeepEqual(snap.projects, wantP) {
		t.Fatalf("projects (verbatim, sorted): want %+v, got %+v", wantP, snap.projects)
	}
}

// TestFleetConfig_LoadFailures pins the startup failure contract: a
// set-but-bad --status-config file produces an error NAMING the path plus a
// precise reason, and a failed load leaves the daemon's config state
// completely untouched (never a silent fallback to discovered scope, and
// never a clobber of an already-loaded config).
func TestFleetConfig_LoadFailures(t *testing.T) {
	dir := t.TempDir()

	// Start from a loaded, valid config so "state untouched" is meaningful.
	goodPath := filepath.Join(dir, "good.jsonc")
	if err := os.WriteFile(goodPath, []byte(`{"workers":[{"id":"alpha"}],"projects":[]}`), 0o600); err != nil {
		t.Fatal(err)
	}
	d, _ := newFleetTestDaemon(t, "")
	if err := d.LoadStatusConfig(goodPath); err != nil {
		t.Fatalf("load good config: %v", err)
	}
	before := d.statusCfg.snapshot()

	sub := filepath.Join(dir, "as-directory")
	if err := os.Mkdir(sub, 0o700); err != nil {
		t.Fatal(err)
	}
	badContent := filepath.Join(dir, "bad.jsonc")
	if err := os.WriteFile(badContent, []byte("{\n  \"workers\": [{ \"id\": \"a b\" }],\n}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	unknownKey := filepath.Join(dir, "unknown-key.jsonc")
	if err := os.WriteFile(unknownKey, []byte(`{"workers":[],"bogus":1}`), 0o600); err != nil {
		t.Fatal(err)
	}

	for _, tc := range []struct {
		name, path, marker string
	}{
		{"missing file", filepath.Join(dir, "nope.jsonc"), "no such file"},
		{"path is a directory", sub, "is a directory"},
		{"invalid content", badContent, "invalid worker id"},
		{"unknown key", unknownKey, "unknown field"},
	} {
		err := d.LoadStatusConfig(tc.path)
		if err == nil {
			t.Fatalf("%s: LoadStatusConfig unexpectedly succeeded", tc.name)
		}
		if !strings.Contains(err.Error(), tc.path) {
			t.Errorf("%s: error must name the path, got %q", tc.name, err.Error())
		}
		if !strings.Contains(err.Error(), tc.marker) {
			t.Errorf("%s: error must state the reason (marker %q), got %q", tc.name, tc.marker, err.Error())
		}
	}

	after := d.statusCfg.snapshot()
	if !reflect.DeepEqual(after.workers, before.workers) || !reflect.DeepEqual(after.projects, before.projects) {
		t.Fatalf("failed loads must not touch the rosters: before %+v/%+v after %+v/%+v", before.workers, before.projects, after.workers, after.projects)
	}
	if after.gen != before.gen {
		t.Fatalf("failed loads must not bump the config generation: before %d after %d", before.gen, after.gen)
	}
	if after.path != before.path {
		t.Fatalf("failed loads must not change the persistence path: %q → %q", before.path, after.path)
	}
}

// ---------------------------------------------------------------------------
// GET /vh/fleet/config
// ---------------------------------------------------------------------------

// TestFleetConfig_GetShape pins the GET envelope in both modes: an
// unconfigured daemon (writable=false, EMPTY arrays rendered as [] not
// null) and a file-loaded daemon (writable=true, entries echoed sorted with
// labels). GET needs no CSRF header; unauthenticated GET gets the clean
// /vh/* 401.
func TestFleetConfig_GetShape(t *testing.T) {
	// writable=false (no --status-config).
	_, h1, session := newFleetConfigAuthDaemon(t, "")
	rec := doFleetConfigGet(h1, withCookie(session))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET config: want 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type: want application/json, got %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "private, no-cache" {
		t.Fatalf("Cache-Control: want \"private, no-cache\", got %q", cc)
	}
	resp := decodeFleetConfig(t, rec)
	if resp.Schema != 1 || resp.Writable {
		t.Fatalf("unconfigured daemon: want schema 1 writable=false, got %+v", resp)
	}
	if len(resp.Workers) != 0 || len(resp.Projects) != 0 {
		t.Fatalf("unconfigured daemon: want empty rosters, got %+v", resp)
	}
	// Empty arrays must be [], never null.
	if !strings.Contains(rec.Body.String(), `"workers":[]`) || !strings.Contains(rec.Body.String(), `"projects":[]`) {
		t.Fatalf("empty rosters must render as []: %s", rec.Body.String())
	}
	// Unauthenticated GET → 401 (session-cookie family; /vh/* is the API class).
	if rec := doFleetConfigGet(h1); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET config: want 401, got %d", rec.Code)
	}

	// writable=true with labels echoed.
	dir := t.TempDir()
	path := filepath.Join(dir, "status.jsonc")
	seed := `{"workers":[{"id":"zeta","label":"Zeta box"},{"id":"alpha"}],"projects":[{"dir":"/p","label":"P"}]}`
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}
	d2, h2, session2 := newFleetConfigAuthDaemon(t, "")
	if err := d2.LoadStatusConfig(path); err != nil {
		t.Fatalf("LoadStatusConfig: %v", err)
	}
	rec2 := doFleetConfigGet(h2, withCookie(session2))
	if rec2.Code != http.StatusOK {
		t.Fatalf("GET config (loaded): want 200, got %d", rec2.Code)
	}
	resp2 := decodeFleetConfig(t, rec2)
	if !resp2.Writable {
		t.Fatalf("loaded daemon: want writable=true, got %+v", resp2)
	}
	wantW := []fleetConfigWorker{{ID: "alpha"}, {ID: "zeta", Label: "Zeta box"}}
	wantP := []fleetConfigProject{{Dir: "/p", Label: "P"}}
	if !reflect.DeepEqual(resp2.Workers, wantW) || !reflect.DeepEqual(resp2.Projects, wantP) {
		t.Fatalf("loaded echo: want workers %+v projects %+v, got %+v / %+v", wantW, wantP, resp2.Workers, resp2.Projects)
	}
}

// ---------------------------------------------------------------------------
// PUT /vh/fleet/config — refusals
// ---------------------------------------------------------------------------

// TestFleetConfig_PutRefusals pins every refusal path through the real
// handler chain: 403 without the CSRF header (the check lives IN the
// handler because csrfGuard only covers /api/), 400 with precise validation
// errors, 409 on an unwritable daemon (honest refusal — no persistence
// path), 405 for wrong methods, 401 unauthenticated — and that every
// refusal leaves both the file and the running rosters untouched.
func TestFleetConfig_PutRefusals(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "status.jsonc")
	seed := `{"workers":[{"id":"alpha"}],"projects":[]}` + "\n"
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}

	d, h, session := newFleetConfigAuthDaemon(t, "")
	if err := d.LoadStatusConfig(path); err != nil {
		t.Fatalf("LoadStatusConfig: %v", err)
	}
	validBody := `{"workers":[{"id":"alpha"},{"id":"beta"}],"projects":[]}`

	// 403: authenticated + valid body, but no X-VH-CSRF.
	rec := doFleetConfigPut(h, validBody, withCookie(session))
	if rec.Code != http.StatusForbidden {
		t.Fatalf("PUT without CSRF: want 403, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), csrfHeader) {
		t.Fatalf("403 body must name the missing header: %q", rec.Body.String())
	}

	// 401: unauthenticated PUT (before any handler logic).
	if rec := doFleetConfigPut(h, validBody, withCSRF()); rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated PUT: want 401, got %d", rec.Code)
	}

	// 400: precise validation errors (CSRF present, body invalid).
	for _, tc := range []struct {
		name, body, marker string
	}{
		{"dupe worker", `{"workers":[{"id":"a"},{"id":"a"}],"projects":[]}`, `duplicate worker id "a"`},
		{"unknown key", `{"workers":[],"projects":[],"nope":1}`, `unknown field "nope"`},
		{"invalid id", `{"workers":[{"id":"a b"}],"projects":[]}`, "invalid worker id"},
		{"blank dir", `{"workers":[],"projects":[{"dir":"  "}]}`, "blank project dir"},
		{"long label", `{"workers":[{"id":"a","label":"` + strings.Repeat("x", 65) + `"}],"projects":[]}`, "code points exceeds"},
		{"trailing document", validBody + " {}", "exactly one JSON document"},
		{"empty body", "", "empty document"},
		{"oversize body", strings.Repeat("a", maxFleetConfigBodyBytes+1), "byte cap"},
	} {
		rec := doFleetConfigPut(h, tc.body, withCookie(session), withCSRF())
		if rec.Code != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d (body=%q)", tc.name, rec.Code, rec.Body.String())
			continue
		}
		if !strings.Contains(rec.Body.String(), tc.marker) {
			t.Errorf("%s: 400 body must contain %q, got %q", tc.name, tc.marker, rec.Body.String())
		}
	}

	// 405: POST to the config route (only GET/PUT are registered).
	req := httptest.NewRequest(http.MethodPost, "/vh/fleet/config", strings.NewReader(validBody))
	req.AddCookie(session)
	rec405 := httptest.NewRecorder()
	h.ServeHTTP(rec405, req)
	if rec405.Code != http.StatusMethodNotAllowed {
		t.Fatalf("POST /vh/fleet/config: want 405, got %d", rec405.Code)
	}

	// Every refusal above left the file and the running rosters untouched.
	got, err := os.ReadFile(path)
	if err != nil || string(got) != seed {
		t.Fatalf("refused PUTs must not touch the file: got %q err=%v", got, err)
	}
	snap := d.statusCfg.snapshot()
	if len(snap.workers) != 1 || snap.workers[0].ID != "alpha" || len(snap.projects) != 0 {
		t.Fatalf("refused PUTs must not touch the running rosters: %+v", snap)
	}

	// 409: perfectly valid, CSRF-carrying, authenticated PUT against an
	// UNWRITABLE daemon (no --status-config) — honest refusal.
	d2, h2, session2 := newFleetConfigAuthDaemon(t, "")
	rec409 := doFleetConfigPut(h2, validBody, withCookie(session2), withCSRF())
	if rec409.Code != http.StatusConflict {
		t.Fatalf("PUT on unwritable daemon: want 409, got %d (body=%q)", rec409.Code, rec409.Body.String())
	}
	if !strings.Contains(rec409.Body.String(), "--status-config") {
		t.Fatalf("409 body must name the missing configuration: %q", rec409.Body.String())
	}
	if snap := d2.statusCfg.snapshot(); len(snap.workers) != 0 || snap.path != "" {
		t.Fatalf("409 must leave the unwritable daemon unconfigured: %+v", snap)
	}
}

// ---------------------------------------------------------------------------
// PUT /vh/fleet/config — happy path: persist + live apply (THE CRUX)
// ---------------------------------------------------------------------------

// TestFleetConfig_PutLiveApplyRollupScope is the C1 crux: a PUT through the
// REAL handler chain (auth + mux + handler) that (i) persists the config
// atomically as canonical JSON which reloads to the identical state, and
// (ii) ACTUALLY changes the live rollup scope — adding expected worker
// "ghost" via PUT makes the NEXT GET /vh/fleet/status report ghost missing.
// The rollup TTL is raised to a minute, so the only thing that can serve
// the new rollup (new ETag, refresh count +1) is the config-generation
// invalidation, not a timer.
func TestFleetConfig_PutLiveApplyRollupScope(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "status.jsonc")
	seed := "{\n  // expected fleet\n  \"workers\": [{ \"id\": \"alpha\" },],\n  \"projects\": [],\n}\n"
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}

	d, fake := newFleetTestDaemon(t, "$ID.example.test")
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a
	if err := d.LoadStatusConfig(path); err != nil {
		t.Fatalf("LoadStatusConfig: %v", err)
	}
	fleetAddOnline(t, d.Registry, "alpha")
	fake.setBody("alpha", "/vh/projects", fleetProjectsBody(""))
	fake.setBody("alpha", "/vh/snapshot", fleetSnapBody(map[string]state.GateFacts{}))

	svc := d.fleetStatusService()
	svc.budgets.TTL = time.Minute // only the config-generation bump may invalidate

	h := d.buildRootHandler()
	session := loginPassphrase(t, h, "secret")

	// 1. Baseline rollup: expected scope [alpha], complete, nominal.
	rec1 := doFleet(h, withCookie(session))
	if rec1.Code != http.StatusOK {
		t.Fatalf("baseline status: want 200, got %d (body=%q)", rec1.Code, rec1.Body.String())
	}
	resp1 := decodeFleet(t, rec1)
	if resp1.Coverage.Mode != "expected" || !resp1.Coverage.Complete || resp1.Overall != fleetOverallNominal {
		t.Fatalf("baseline rollup: want expected/complete/nominal, got %+v", resp1.Coverage)
	}
	etag1 := rec1.Header().Get("ETag")
	refreshes := svc.refreshCount()

	// 2. PUT adds expected worker "ghost" through the REAL handler chain.
	putBody := `{"workers":[{"id":"alpha"},{"id":"ghost","label":"Ghost"}],"projects":[]}`
	rec2 := doFleetConfigPut(h, putBody, withCookie(session), withCSRF())
	t.Logf("PUT /vh/fleet/config (X-VH-CSRF: 1) body=%s -> %d: %s", putBody, rec2.Code, rec2.Body.String())
	if rec2.Code != http.StatusOK {
		t.Fatalf("PUT config: want 200, got %d (body=%q)", rec2.Code, rec2.Body.String())
	}
	cfg2 := decodeFleetConfig(t, rec2)
	if !cfg2.Writable {
		t.Fatalf("PUT response: want writable=true, got %+v", cfg2)
	}
	wantW := []fleetConfigWorker{{ID: "alpha"}, {ID: "ghost", Label: "Ghost"}}
	if !reflect.DeepEqual(cfg2.Workers, wantW) || len(cfg2.Projects) != 0 {
		t.Fatalf("PUT response: want workers %+v, got %+v", wantW, cfg2.Workers)
	}

	// 3. (i) The file was persisted — canonical JSON (comments from the seed
	// are GONE; 2-space indent; sorted) — and reloading it yields exactly
	// the applied state.
	wantBytes, err := json.MarshalIndent(&fleetStatusConfig{Workers: wantW, Projects: []fleetConfigProject{}}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	wantBytes = append(wantBytes, '\n')
	gotBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read persisted config: %v", err)
	}
	if string(gotBytes) != string(wantBytes) {
		t.Fatalf("persisted file is not the canonical form:\n got: %q\nwant: %q", gotBytes, wantBytes)
	}
	if strings.Contains(string(gotBytes), "//") {
		t.Fatalf("persisted canonical file must not contain comments: %q", gotBytes)
	}
	rl, err := loadStatusConfigFile(path)
	if err != nil {
		t.Fatalf("reload persisted config: %v", err)
	}
	if !reflect.DeepEqual(rl.Workers, wantW) || len(rl.Projects) != 0 {
		t.Fatalf("reloaded config differs from applied state: %+v", rl)
	}
	snap := d.statusCfg.snapshot()
	if !reflect.DeepEqual(snap.workers, rl.Workers) {
		t.Fatalf("running rosters differ from persisted file: running=%+v file=%+v", snap.workers, rl.Workers)
	}

	// 4. (ii) The NEXT /vh/fleet/status — still deep inside the 1-minute
	// TTL — serves a REFRESHED rollup with the NEW scope: ghost missing,
	// coverage incomplete, worker_missing condition, new ETag. This is the
	// live-apply proof through the real handler chain.
	rec3 := doFleet(h, withCookie(session))
	t.Logf("GET /vh/fleet/status after PUT -> %d: %s", rec3.Code, rec3.Body.String())
	if rec3.Code != http.StatusOK {
		t.Fatalf("post-PUT status: want 200, got %d (body=%q)", rec3.Code, rec3.Body.String())
	}
	resp3 := decodeFleet(t, rec3)
	if resp3.Coverage.Mode != "expected" || resp3.Coverage.Complete {
		t.Fatalf("post-PUT coverage: want expected/incomplete (ghost missing), got %+v", resp3.Coverage)
	}
	if w := workerEntry(t, resp3, "ghost"); w.Status != fleetWorkerMissing || w.ObservedAt != nil {
		t.Fatalf("ghost must be missing in the live rollup, got %+v", w)
	}
	if w := workerEntry(t, resp3, "alpha"); w.Status != fleetWorkerOK {
		t.Fatalf("alpha must stay ok, got %+v", w)
	}
	if got := condKinds(resp3); len(got) != 1 || got[0] != fleetCondWorkerMissing {
		t.Fatalf("post-PUT conditions: want [worker_missing], got %v", got)
	}
	if resp3.Overall != fleetOverallUnknown || resp3.KnownOverall != fleetOverallDegraded {
		t.Fatalf("post-PUT overall/known: want unknown/degraded, got %s/%s", resp3.Overall, resp3.KnownOverall)
	}
	if etag3 := rec3.Header().Get("ETag"); etag3 == etag1 {
		t.Fatalf("post-PUT ETag must differ from the pre-PUT generation (%q)", etag3)
	}
	if n := svc.refreshCount(); n != refreshes+1 {
		t.Fatalf("config apply must invalidate the rollup generation (refresh count %d → %d)", refreshes, n)
	}
}

// TestFleetConfig_PutCanonicalizesFile pins the documented comment-loss
// tradeoff: a hand-written file with comments is rewritten as canonical JSON
// by a successful PUT (even one whose body itself carries comments), and
// the comment-bearing PUT body is accepted on read.
func TestFleetConfig_PutCanonicalizesFile(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "status.jsonc")
	seed := "{\n  // operator notes — these die on save\n  \"workers\": [{ \"id\": \"alpha\", /* inline */ }],\n  \"projects\": [],\n}\n"
	if err := os.WriteFile(path, []byte(seed), 0o600); err != nil {
		t.Fatal(err)
	}
	d, h, session := newFleetConfigAuthDaemon(t, "")
	if err := d.LoadStatusConfig(path); err != nil {
		t.Fatalf("LoadStatusConfig: %v", err)
	}

	putBody := "{\n  \"workers\": [{ \"id\": \"alpha\" }, { \"id\": \"beta\" },], // JSONC accepted on read\n  \"projects\": [],\n}"
	rec := doFleetConfigPut(h, putBody, withCookie(session), withCSRF())
	if rec.Code != http.StatusOK {
		t.Fatalf("PUT with JSONC body: want 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}

	want, err := json.MarshalIndent(&fleetStatusConfig{
		Workers:  []fleetConfigWorker{{ID: "alpha"}, {ID: "beta"}},
		Projects: []fleetConfigProject{},
	}, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	want = append(want, '\n')
	got, err := os.ReadFile(path)
	if err != nil || string(got) != string(want) {
		t.Fatalf("file after canonicalizing PUT:\n got: %q (err %v)\nwant: %q", got, err, want)
	}
	// No leftover tmp file from the atomic write.
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || entries[0].Name() != "status.jsonc" {
		t.Fatalf("atomic persist must leave only the config file in the dir, got %d entries", len(entries))
	}
}

// ---------------------------------------------------------------------------
// hostInterceptor carve-out (worker-subdomain precedence)
// ---------------------------------------------------------------------------

// TestHostInterceptorFleetConfigRoutePrecedence pins the same property as
// TestHostInterceptorFleetStatusRoutePrecedence (status_test.go) for the
// config manage routes: a browser loaded from a per-worker subdomain (e.g.
// "workerID.controller.host") hitting GET/PUT /vh/fleet/config MUST be served
// by the CONTROLLER, NOT proxied down to that worker. The worker has no
// /vh/fleet/config route and its catch-all serves the SPA shell (200
// text/html) — the exact body the config pane cannot parse (the operator
// regression this test guards).
//
// Full controller chain (auth + csrfGuard + hostInterceptor + userMux) with
// HostPattern set and "abc" registered as an online worker with NO transport:
// if the carve-out fails, the request reaches HandleWorkerDirect →
// handleRawProxy → 502 on the nil transport; every assertion below is framed
// against that. The carve-out is path-based and method-agnostic, so BOTH the
// GET (200 config envelope) and the PUT (CSRF + auth → the real handler's
// 409 unwritable refusal on this daemon — routing is the point, not
// semantics) must come from the controller's handlers.
func TestHostInterceptorFleetConfigRoutePrecedence(t *testing.T) {
	d, h, session := newFleetConfigAuthDaemon(t, "$ID.controller.test")
	d.Registry.AddWorker(&Worker{ID: "abc", Name: "abc-worker", Status: "online", Version: "v1"})

	// GET on the subdomain host: the controller answers with the config
	// envelope (200 JSON) — not a 502 proxied rejection, and not the
	// worker's non-JSON 404/SPA-fallback body.
	rec := doFleetConfigGet(h, withCookie(session), withHost("abc.controller.test"))
	if rec.Code == http.StatusBadGateway {
		t.Fatalf("hostInterceptor proxied GET /vh/fleet/config to the worker (502) — carve-out missing or broken")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200 config on a worker subdomain, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type: want application/json (controller handler), got %q", ct)
	}
	resp := decodeFleetConfig(t, rec)
	if resp.Schema != 1 {
		t.Fatalf("response is not the fleet config envelope (schema %d)", resp.Schema)
	}

	// PUT (CSRF + auth) on the subdomain host: reaches the CONTROLLER's
	// handleFleetConfigPut. This daemon is unwritable (no --status-config),
	// so the honest refusal is 409 — produced only by the real handler's
	// writable check, well after the carve-out. A broken carve-out would
	// 502 on the nil transport before any handler logic runs.
	rec2 := doFleetConfigPut(h, `{"workers":[],"projects":[]}`, withCookie(session), withCSRF(), withHost("abc.controller.test"))
	if rec2.Code == http.StatusBadGateway {
		t.Fatalf("hostInterceptor proxied PUT /vh/fleet/config to the worker (502) — carve-out missing or broken")
	}
	if rec2.Code != http.StatusConflict {
		t.Fatalf("PUT on a worker subdomain: want 409 from the controller handler (unwritable daemon), got %d (body=%q)", rec2.Code, rec2.Body.String())
	}
}
