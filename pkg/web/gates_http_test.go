package web

// gates_http_test.go — lane-1 tests for GET /vh/gates, the lean fleet-rollup
// acquisition endpoint (pkg/web/server.go handleFleetGates). The controller's
// GET /vh/fleet/status consumes ONLY the gate map per project; this endpoint
// exists so that acquisition stops moving whole session trees over the WAN
// tunnel. Pins: the response contract (schema/shape/sorting), gate parity
// with /vh/snapshot for the same project, explicit-dir semantics (live only,
// unknown dirs omitted — never fabricated, never opened), the request-size
// bound, the GET-only guard, the auth family, and the z=1 gzip64 opt-in.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/auth"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// newGatesTestServer boots the real worker stack (fake OpenCode → aggregator
// → pkg/web Server) with n sessions hydrated in the DEFAULT project, plus a
// second live project opened at /extra via one snapshot touch (aggFor's lazy
// open — the same way real projects come to life).
func newGatesTestServer(t *testing.T, n int) (*Server, *httptest.Server) {
	t.Helper()
	fake := newFake()
	sessions := make([]string, 0, n)
	for i := 0; i < n; i++ {
		id := string(rune('a' + i))
		sessions = append(sessions, `{"id":"`+id+`","title":"S`+id+`","time":{"updated":1}}`)
	}
	fake.sessions = sessions

	ocSrv := httptest.NewServer(fake.handler())
	t.Cleanup(ocSrv.Close)

	agg := aggregator.New(ocSrv.URL, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go agg.Run(ctx)
	waitFor(t, func() bool { return len(agg.Store().SessionIDs()) == n }, "hydrate sessions")

	srv, err := NewServer(agg, ocSrv.URL, 1000)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)
	return srv, web
}

func getGates(t *testing.T, web *httptest.Server, query string) (int, []byte) {
	t.Helper()
	resp, err := http.Get(web.URL + "/vh/gates" + query)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	return resp.StatusCode, body
}

// TestFleetGatesHandlerContract pins the wire contract: explicit dirs return
// entries ONLY for live aggregators (a requested-but-uninstantiated dir is
// OMITTED — never an empty fabricated observation, and the handler never
// OPENS a project), the default project is addressed by dir= (empty string),
// entries are sorted by dir, and the response is uncachable state-like JSON.
func TestFleetGatesHandlerContract(t *testing.T) {
	_, web := newGatesTestServer(t, 3)

	// The default project is live (NewServer seeds aggs[""]); /extra is NOT.
	code, body := getGates(t, web, "?dir=&dir=/extra")
	if code != http.StatusOK {
		t.Fatalf("GET /vh/gates?dir=&dir=/extra: want 200, got %d (body=%q)", code, body)
	}
	var resp struct {
		Schema   int `json:"schema"`
		Projects []struct {
			Dir  string                     `json:"dir"`
			Gate map[string]state.GateFacts `json:"gate"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode gates body: %v (body=%q)", err, body)
	}
	if resp.Schema != 1 {
		t.Fatalf("schema: want 1, got %d", resp.Schema)
	}
	if len(resp.Projects) != 1 || resp.Projects[0].Dir != "" {
		t.Fatalf("projects: want exactly the live default project (\"/extra\" omitted), got %+v", resp.Projects)
	}
	if len(resp.Projects[0].Gate) != 3 {
		t.Fatalf("default project gate: want 3 sessions, got %d", len(resp.Projects[0].Gate))
	}

	// No dir params: every live project (here: just the default).
	code2, body2 := getGates(t, web, "")
	if code2 != http.StatusOK {
		t.Fatalf("GET /vh/gates (all): want 200, got %d", code2)
	}
	if !strings.Contains(string(body2), `"dir":""`) {
		t.Fatalf("no-dirs form must include the default project: %q", body2)
	}
}

// TestFleetGatesGateParityWithSnapshot pins the load-bearing property: the
// gate map /vh/gates serves for a project carries EXACTLY the values the
// same project's /vh/snapshot carries in its gate field — restricted to the
// fleet-watch SELECTED population. The rollup's fold must not depend on
// which acquisition path ran: the lean response IS the snapshot's gate map
// filtered to fleet_selected=true, entry-for-entry (full GateFacts equality,
// not just the legacy four fields).
func TestFleetGatesGateParityWithSnapshot(t *testing.T) {
	_, web := newGatesTestServer(t, 4)

	_, gatesBody := getGates(t, web, "?dir=")
	var gates struct {
		FleetSelection string `json:"fleet_selection"`
		Projects       []struct {
			Gate map[string]state.GateFacts `json:"gate"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(gatesBody, &gates); err != nil {
		t.Fatalf("decode gates: %v", err)
	}
	if len(gates.Projects) != 1 {
		t.Fatalf("want the default project entry, got %+v", gates.Projects)
	}
	if gates.FleetSelection != state.FleetSelectionRootUnarchivedV1 {
		t.Fatalf("lean fleet_selection marker: want %q, got %q", state.FleetSelectionRootUnarchivedV1, gates.FleetSelection)
	}

	snapResp, err := http.Get(web.URL + "/vh/snapshot")
	if err != nil {
		t.Fatal(err)
	}
	defer snapResp.Body.Close()
	snapBody, err := io.ReadAll(snapResp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var snap struct {
		FleetSelection string                     `json:"fleet_selection"`
		Gate           map[string]state.GateFacts `json:"gate"`
	}
	if err := json.Unmarshal(snapBody, &snap); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	if snap.FleetSelection != state.FleetSelectionRootUnarchivedV1 {
		t.Fatalf("snapshot fleet_selection marker: want %q, got %q", state.FleetSelectionRootUnarchivedV1, snap.FleetSelection)
	}

	// Project the snapshot's COMPLETE map to its selected subset — the exact
	// population the lean endpoint must serve.
	want := map[string]state.GateFacts{}
	for sid, gf := range snap.Gate {
		if gf.FleetSelected != nil && *gf.FleetSelected {
			want[sid] = gf
		}
	}
	if len(want) == 0 {
		t.Fatal("fixture must contain at least one selected root for the parity assertion")
	}
	if len(want) != len(gates.Projects[0].Gate) {
		t.Fatalf("selected cardinality mismatch: gates=%d snapshot-selected=%d (snapshot total=%d)", len(gates.Projects[0].Gate), len(want), len(snap.Gate))
	}
	for sid, gf := range want {
		other, ok := gates.Projects[0].Gate[sid]
		if !ok {
			t.Fatalf("selected session %q missing from /vh/gates gate", sid)
		}
		if !reflect.DeepEqual(gf, other) {
			t.Fatalf("session %q gate drift:\n snapshot=%+v\n gates=%+v", sid, gf, other)
		}
	}
}

// TestFleetGatesSelectedRootsOnly pins the selected-only population through
// the REAL worker stack (fake OpenCode → aggregator → /vh/gates + /vh/
// snapshot): subagent children and archived sessions never cross the lean
// wire, while the snapshot stays COMPLETE (children present with
// fleet_selected=false) — the ordinary SPA consumers are untouched by the
// fleet fold's narrowed population.
func TestFleetGatesSelectedRootsOnly(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{
		`{"id":"r1","title":"Root one","time":{"updated":1}}`,
		`{"id":"sub1","parentID":"r1","title":"Subagent","time":{"updated":1}}`,
		`{"id":"r2","title":"Root two","time":{"updated":1}}`,
		`{"id":"arch1","title":"Archived root","time":{"updated":1,"archived":2}}`,
	}
	ocSrv := httptest.NewServer(fake.handler())
	t.Cleanup(ocSrv.Close)
	agg := aggregator.New(ocSrv.URL, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go agg.Run(ctx)
	waitFor(t, func() bool { return len(agg.Store().SessionIDs()) >= 3 }, "hydrate sessions (archived root is deleted from the live store)")

	srv, err := NewServer(agg, ocSrv.URL, 1000)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	code, body := getGates(t, web, "?dir=")
	if code != http.StatusOK {
		t.Fatalf("GET /vh/gates: want 200, got %d (body=%q)", code, body)
	}
	var resp struct {
		FleetSelection string `json:"fleet_selection"`
		Projects       []struct {
			Gate map[string]state.GateFacts `json:"gate"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(body, &resp); err != nil {
		t.Fatalf("decode gates: %v (body=%q)", err, body)
	}
	if resp.FleetSelection != state.FleetSelectionRootUnarchivedV1 {
		t.Fatalf("fleet_selection marker: want %q, got %q", state.FleetSelectionRootUnarchivedV1, resp.FleetSelection)
	}
	if len(resp.Projects) != 1 {
		t.Fatalf("want the default project, got %+v", resp.Projects)
	}
	gate := resp.Projects[0].Gate
	if len(gate) != 2 || gate["r1"].Activity == "" || gate["r2"].Activity == "" {
		t.Fatalf("lean gate must carry EXACTLY the selected roots {r1,r2}, got %d entries", len(gate))
	}
	for sid, gf := range gate {
		if gf.FleetSelected == nil || !*gf.FleetSelected {
			t.Fatalf("lean entry %s must carry fleet_selected=true, got %+v", sid, gf)
		}
	}

	// The snapshot stays COMPLETE: the child is present (selected=false);
	// the archived root left the live store (deleted by the archive funnel —
	// absent, not merely unselected).
	snapResp, err := http.Get(web.URL + "/vh/snapshot")
	if err != nil {
		t.Fatal(err)
	}
	defer snapResp.Body.Close()
	snapBody, err := io.ReadAll(snapResp.Body)
	if err != nil {
		t.Fatal(err)
	}
	var snap struct {
		Gate map[string]state.GateFacts `json:"gate"`
	}
	if err := json.Unmarshal(snapBody, &snap); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	if len(snap.Gate) != 3 {
		t.Fatalf("snapshot gate must stay complete (r1,sub1,r2), got %d: %v", len(snap.Gate), keysOf(snap.Gate))
	}
	if gf := snap.Gate["sub1"]; gf.FleetSelected == nil || *gf.FleetSelected {
		t.Fatalf("snapshot child entry must carry fleet_selected=false, got %+v", gf)
	}
	if _, ok := snap.Gate["arch1"]; ok {
		t.Fatal("archived root must be deleted from the live store (absent from the snapshot), not merely unselected")
	}
}

// keysOf is a tiny debug helper for gate-map failure messages.
func keysOf(m map[string]state.GateFacts) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

// TestFleetGatesRequestBound pins the politeness bound: more than
// maxFleetGatesRequestDirs dir params is a clean 400 naming the cap — never
// an unbounded fan-out.
func TestFleetGatesRequestBound(t *testing.T) {
	_, web := newGatesTestServer(t, 1)
	q := url.Values{}
	for i := 0; i <= maxFleetGatesRequestDirs; i++ {
		q.Add("dir", "/p")
	}
	code, body := getGates(t, web, "?"+q.Encode())
	if code != http.StatusBadRequest {
		t.Fatalf("oversize dir list: want 400, got %d (body=%q)", code, body)
	}
	if !strings.Contains(string(body), "cap") {
		t.Fatalf("400 body must name the cap, got %q", body)
	}
}

// TestFleetGatesMethodGuard: read-only at BOTH layers — an unsafe POST is
// stopped by csrfGuard (403 without X-VH-CSRF), and a POST carrying the
// header still reaches the handler's own method guard (405). Mirrors the
// /vh/diag/latency defense-in-depth pattern.
func TestFleetGatesMethodGuard(t *testing.T) {
	_, web := newGatesTestServer(t, 1)

	resp, err := http.Post(web.URL+"/vh/gates", "", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("POST /vh/gates without CSRF: want 403 (csrfGuard), got %d", resp.StatusCode)
	}

	req, err := http.NewRequest(http.MethodPost, web.URL+"/vh/gates", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-VH-CSRF", "1")
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("POST /vh/gates with CSRF: want 405 (handler GET-only guard), got %d", resp2.StatusCode)
	}
}

// TestFleetGatesRouteAuthChain pins the security posture: /vh/gates rides
// the same chain as every worker /vh/* route (securityHeaders → auth → cors
// → csrfGuard → mux), so an unauthenticated GET is challenged (401 — /vh/*
// is an API request path), and an authenticated GET passes.
func TestFleetGatesRouteAuthChain(t *testing.T) {
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	srv, err := NewServer(aggregator.New(oc.URL, 100), oc.URL, 100)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	srv.SetAuth(a)
	h := srv.Handler()

	// Unauthenticated → 401 (API-path challenge, not a login redirect).
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/vh/gates", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated GET /vh/gates: want 401, got %d", rec.Code)
	}

	// Login (passphrase form) → authenticated GET returns the gates JSON.
	recLogin := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/auth/login", strings.NewReader("passphrase=secret"))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	h.ServeHTTP(recLogin, req)
	if recLogin.Code != http.StatusSeeOther {
		t.Fatalf("login: want 303, got %d", recLogin.Code)
	}
	var session *http.Cookie
	for _, c := range recLogin.Result().Cookies() {
		if c.Name == "vh_session" {
			session = c
		}
	}
	if session == nil {
		t.Fatal("login: no vh_session cookie")
	}
	rec2 := httptest.NewRecorder()
	req2 := httptest.NewRequest(http.MethodGet, "/vh/gates", nil)
	req2.AddCookie(session)
	h.ServeHTTP(rec2, req2)
	if rec2.Code != http.StatusOK {
		t.Fatalf("authenticated GET /vh/gates: want 200, got %d (body=%q)", rec2.Code, rec2.Body.String())
	}
	if !strings.Contains(rec2.Body.String(), `"schema":1`) {
		t.Fatalf("authenticated body must be the gates envelope: %q", rec2.Body.String())
	}
}

// TestFleetGatesGzip64OptIn pins the z=1 behavior: 20 sessions put the gate
// payload past snapshotCompressThreshold, so a z=1 request gets the SAME
// gzip64 envelope /vh/snapshot serves (decodable losslessly to the raw JSON),
// while a plain request keeps the legacy raw JSON shape.
func TestFleetGatesGzip64OptIn(t *testing.T) {
	// 20 sessions × ~100 B of gate JSON clears the 2 KiB threshold.
	_, web := newGatesTestServer(t, 20)

	_, raw := getGates(t, web, "?dir=")
	if isGzip64Envelope(raw) {
		t.Fatal("no-z request must stay raw JSON (legacy wire shape)")
	}

	_, enc := getGates(t, web, "?dir=&z=1")
	if !isGzip64Envelope(enc) {
		t.Fatalf("z=1 request over threshold must be a gzip64 envelope, got: %s", string(enc[:min(80, len(enc))]))
	}
	decoded := decodeGzip64(t, enc)
	var parsed struct {
		Schema int `json:"schema"`
	}
	if err := json.Unmarshal(decoded, &parsed); err != nil || parsed.Schema != 1 {
		t.Fatalf("decoded envelope must be the gates JSON (schema 1): %v (%q)", err, decoded)
	}
	if string(decoded) != string(raw) {
		t.Fatalf("decoded envelope must equal the raw body byte-for-byte:\n raw=%d B\n dec=%d B", len(raw), len(decoded))
	}
	if len(enc) >= len(raw) {
		t.Fatalf("envelope should be smaller than raw for repetitive gate JSON: raw=%d enc=%d", len(raw), len(enc))
	}
}
