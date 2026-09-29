package e2e

// Controller-proxy crux e2e for server-backed tab-only named layouts
// (worker-scoped v1, phases 1-2).
//
// THE CRUX this file proves: a BODY-BEARING MUTATION (PUT /vh/layouts) issued
// against the controller with a per-worker subdomain Host header traverses the
// raw tunnel proxy (controller → yamux → worker web server) with method, path,
// headers (incl. X-VH-CSRF and Content-Length), and body intact, and the
// caller receives the worker's TRUE response — 200 with the committed catalog
// for a valid upsert, 409 with the current doc for a stale baseRevision, and a
// machine-readable 400 for an invalid entry. A follow-up GET through the same
// subdomain path round-trips the persisted entry.
//
// Why this needs a real cluster: the proxy hand-serializes the request after
// hijack (pkg/server/proxy.go handleRawProxy), so nothing short of the real
// controller + tunnel + worker stack exercises Content-Length/body fidelity.
//
// The cluster boots with WithHostPattern("$ID.localhost") — the ONLY change to
// the harness; StartCluster() with no options keeps the historical behavior
// for every other test in this package.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"
)

// layoutsHost is the per-worker subdomain for WorkerID="worker-e2e" under the
// test HostPattern "$ID.localhost".
const layoutsHost = "worker-e2e.localhost"

// doViaSubdomain issues a request to the CONTROLLER URL with the per-worker
// subdomain Host header, so hostInterceptor routes it through the tunnel to
// the worker's web server. body may be nil.
func doViaSubdomain(t *testing.T, c *Cluster, method, path string, body []byte, withCSRF bool) (*http.Response, []byte) {
	t.Helper()
	var r io.Reader
	if body != nil {
		r = bytes.NewReader(body)
	}
	req, err := http.NewRequest(method, c.ControllerURL+path, r)
	if err != nil {
		t.Fatal(err)
	}
	// Go's client ignores a "Host" header set via req.Header; the sanctioned
	// way to control the wire Host is req.Host.
	req.Host = layoutsHost
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if withCSRF {
		req.Header.Set("X-VH-CSRF", "1")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s via subdomain: %v", method, path, err)
	}
	b, readErr := io.ReadAll(resp.Body)
	resp.Body.Close()
	if readErr != nil {
		t.Fatalf("%s %s: read body: %v", method, path, readErr)
	}
	return resp, b
}

// layoutsWire mirrors the public wire shapes (pkg/web/named_layouts_http.go)
// for decoding in this test.
type layoutsWire struct {
	Revision int64 `json:"revision"`
	Entries  []struct {
		Scope    string          `json:"scope"`
		Name     string          `json:"name"`
		TabTitle string          `json:"tabTitle"`
		Layout   json.RawMessage `json:"layout"`
		SavedAt  int64           `json:"savedAt"`
	} `json:"entries"`
}

// TestLayoutsProxyPerEntryUpsert is THE lane-3 crux: PUT /vh/layouts through
// the controller's per-worker subdomain proxy reaches the worker with body
// fidelity, commits the entry, and returns the worker's true responses
// (200 → 409 stale → 400 invalid), with a GET round-trip proving persistence.
func TestLayoutsProxyPerEntryUpsert(t *testing.T) {
	// Isolate the worker's state dir BEFORE the cluster boots (the worker's
	// web.NewServer runs in-process and grounds named-layouts.json under
	// VH_STATE_DIR at construction). No t.Parallel in this package, so the
	// process-wide env is safe for the life of this test.
	t.Setenv("VH_STATE_DIR", t.TempDir())

	c, err := StartClusterWithOptions(WithHostPattern("$ID.localhost"))
	if err != nil {
		t.Fatalf("StartClusterWithOptions: %v", err)
	}
	defer c.Close()

	if c.HostPattern != "$ID.localhost" {
		t.Fatalf("cluster HostPattern = %q, want $ID.localhost", c.HostPattern)
	}

	validEntry := map[string]any{
		"scope":    "tab",
		"name":     "focus",
		"tabTitle": "Focus",
		"layout":   map[string]any{"grid": map[string]any{"orientation": 0}, "panels": []any{}},
		"savedAt":  1726600000000,
	}
	putBody := func(base int64, entry map[string]any) []byte {
		b, err := json.Marshal(map[string]any{"baseRevision": base, "entry": entry})
		if err != nil {
			t.Fatal(err)
		}
		return b
	}

	// --- 1. Baseline GET through the subdomain proxy: empty catalog, rev 0.
	resp, body := doViaSubdomain(t, c, http.MethodGet, "/vh/layouts", nil, false)
	if resp.StatusCode != 200 {
		t.Fatalf("baseline GET via subdomain: status %d body %s", resp.StatusCode, body)
	}
	var base layoutsWire
	if err := json.Unmarshal(body, &base); err != nil {
		t.Fatalf("baseline GET: decode %q: %v", body, err)
	}
	if base.Revision != 0 || len(base.Entries) != 0 {
		t.Fatalf("baseline GET: revision=%d entries=%d, want 0/0", base.Revision, len(base.Entries))
	}

	// --- 2. THE CRUX: valid per-entry PUT with a JSON body through the
	// subdomain proxy. The proxy hand-serializes the request after hijack; if
	// Content-Length or body bytes were mishandled the worker would 400
	// (invalid body) or hang — a 200 with the committed entry proves
	// end-to-end body fidelity, and the worker's own CSRF guard passing means
	// X-VH-CSRF survived the header copy.
	resp, body = doViaSubdomain(t, c, http.MethodPut, "/vh/layouts", putBody(0, validEntry), true)
	if resp.StatusCode != 200 {
		t.Fatalf("crux PUT via subdomain: status %d (want the worker's true 200), body %s", resp.StatusCode, body)
	}
	var committed layoutsWire
	if err := json.Unmarshal(body, &committed); err != nil {
		t.Fatalf("crux PUT: decode %q: %v", body, err)
	}
	if committed.Revision != 1 {
		t.Fatalf("crux PUT: revision=%d, want 1", committed.Revision)
	}
	if len(committed.Entries) != 1 || committed.Entries[0].Name != "focus" {
		t.Fatalf("crux PUT: entries=%+v, want [focus]", committed.Entries)
	}
	got := committed.Entries[0]
	if got.Scope != "tab" || got.TabTitle != "Focus" || got.SavedAt != 1726600000000 {
		t.Fatalf("crux PUT: entry round-trip mismatch: %+v", got)
	}
	var layoutVal any
	if err := json.Unmarshal(got.Layout, &layoutVal); err != nil {
		t.Fatalf("crux PUT: layout is not valid JSON: %s", got.Layout)
	}

	// --- 3. Follow-up GET through the same subdomain path: the entry
	// persisted (worker-side durable state, read back through the tunnel).
	resp, body = doViaSubdomain(t, c, http.MethodGet, "/vh/layouts", nil, false)
	if resp.StatusCode != 200 {
		t.Fatalf("follow-up GET via subdomain: status %d body %s", resp.StatusCode, body)
	}
	var reread layoutsWire
	if err := json.Unmarshal(body, &reread); err != nil {
		t.Fatalf("follow-up GET: decode %q: %v", body, err)
	}
	if reread.Revision != 1 || len(reread.Entries) != 1 || reread.Entries[0].Name != "focus" {
		t.Fatalf("follow-up GET: revision=%d entries=%+v, want 1/[focus] (persistence)", reread.Revision, reread.Entries)
	}
	if reread.Entries[0].TabTitle != "Focus" || reread.Entries[0].SavedAt != 1726600000000 {
		t.Fatalf("follow-up GET: entry drifted: %+v", reread.Entries[0])
	}

	// --- 4. Stale baseRevision → the worker's TRUE 409 with the current doc
	// in the body (CAS semantics intact through the proxy).
	resp, body = doViaSubdomain(t, c, http.MethodPut, "/vh/layouts", putBody(0, validEntry), true)
	if resp.StatusCode != http.StatusConflict {
		t.Fatalf("stale PUT via subdomain: status %d (want the worker's true 409), body %s", resp.StatusCode, body)
	}
	var conflict layoutsWire
	if err := json.Unmarshal(body, &conflict); err != nil {
		t.Fatalf("stale PUT: decode 409 body %q: %v", body, err)
	}
	if conflict.Revision != 1 || len(conflict.Entries) != 1 || conflict.Entries[0].Name != "focus" {
		t.Fatalf("stale PUT: 409 body revision=%d entries=%+v, want 1/[focus] (current server doc)", conflict.Revision, conflict.Entries)
	}

	// --- 5. Invalid entries → the worker's TRUE machine-readable 400s
	// (strict validation runs worker-side and the error body survives the
	// raw copy). Two DISTINCT error codes prove the machine-readable body
	// survives the tunnel bit-for-bit, not just the status.
	putInvalid := func(entry map[string]any, wantCode string) {
		t.Helper()
		r, b := doViaSubdomain(t, c, http.MethodPut, "/vh/layouts", putBody(1, entry), true)
		if r.StatusCode != http.StatusBadRequest {
			t.Fatalf("invalid PUT via subdomain (want %s): status %d (want the worker's true 400), body %s", wantCode, r.StatusCode, b)
		}
		var errBody struct {
			Error   string `json:"error"`
			Message string `json:"message"`
		}
		if err := json.Unmarshal(b, &errBody); err != nil {
			t.Fatalf("invalid PUT (want %s): decode 400 body %q: %v", wantCode, b, err)
		}
		if errBody.Error != wantCode {
			t.Fatalf("invalid PUT (want %s): error code %q (body %s)", wantCode, errBody.Error, b)
		}
	}

	// 5a. scope "master" is a VALID scope, but a master entry must NOT carry
	// tabTitle (the session carries the workspaces) → invalid_tab_title.
	putInvalid(map[string]any{
		"scope":    "master",
		"name":     "bad",
		"tabTitle": "Bad",
		"layout":   map[string]any{"panels": []any{}},
		"savedAt":  1726600000000,
	}, "invalid_tab_title")

	// 5b. A genuinely bogus scope (otherwise-valid fields) → invalid_scope.
	putInvalid(map[string]any{
		"scope":    "bogus",
		"name":     "bad",
		"tabTitle": "Bad",
		"layout":   map[string]any{"panels": []any{}},
		"savedAt":  1726600000000,
	}, "invalid_scope")

	// --- 6. Missing CSRF → the worker's TRUE 403 (the worker-side csrfGuard
	// applies on the tunnel path too; X-VH-CSRF was withheld).
	resp, body = doViaSubdomain(t, c, http.MethodPut, "/vh/layouts", putBody(1, validEntry), false)
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("no-CSRF PUT via subdomain: status %d (want the worker's true 403), body %s", resp.StatusCode, body)
	}

	// --- 7. Cross-check worker-local view: the same committed catalog is
	// visible on the worker's own loopback server (worker-global state, and
	// the proxy path did not diverge from it).
	localResp, err := http.Get(c.WorkerVHURL + "/vh/layouts")
	if err != nil {
		t.Fatalf("worker-local GET: %v", err)
	}
	localBody, _ := io.ReadAll(localResp.Body)
	localResp.Body.Close()
	if localResp.StatusCode != 200 {
		t.Fatalf("worker-local GET: status %d body %s", localResp.StatusCode, localBody)
	}
	var local layoutsWire
	if err := json.Unmarshal(localBody, &local); err != nil {
		t.Fatalf("worker-local GET: decode %q: %v", localBody, err)
	}
	if local.Revision != 1 || len(local.Entries) != 1 || local.Entries[0].Name != "focus" {
		t.Fatalf("worker-local GET diverged from subdomain view: revision=%d entries=%+v", local.Revision, local.Entries)
	}
}

// TestLayoutsProxyWrongSubdomainRejected pins the routing negative: a subdomain
// Host that does NOT match a registered online worker is refused by the
// controller (502 from hostInterceptor) and never reaches the worker.
func TestLayoutsProxyWrongSubdomainRejected(t *testing.T) {
	t.Setenv("VH_STATE_DIR", t.TempDir())

	c, err := StartClusterWithOptions(WithHostPattern("$ID.localhost"))
	if err != nil {
		t.Fatalf("StartClusterWithOptions: %v", err)
	}
	defer c.Close()

	// "no-such-worker" does not exist in the registry → hostInterceptor 502.
	req, err := http.NewRequest(http.MethodGet, c.ControllerURL+"/vh/layouts", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Host = "no-such-worker.localhost"
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("unknown-subdomain GET: status %d, want 502, body %s", resp.StatusCode, body)
	}
}

// TestStartClusterDefaultNoHostPattern pins the harness compatibility contract
// inside the e2e package itself: bare StartCluster() must behave exactly as
// before — the controller runs with NO host pattern (HostPattern recorded as
// ""), and the controller edge still answers the coordination API.
func TestStartClusterDefaultNoHostPattern(t *testing.T) {
	t.Setenv("VH_STATE_DIR", t.TempDir())

	c, err := StartCluster()
	if err != nil {
		t.Fatalf("StartCluster: %v", err)
	}
	defer c.Close()

	if c.HostPattern != "" {
		t.Fatalf("default StartCluster HostPattern = %q, want \"\"", c.HostPattern)
	}
	resp, body, err := c.Do(http.MethodGet, "/api/coord/workers", "", c.APIToken, nil)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("coord API after default StartCluster: resp=%v err=%v body=%s", resp, err, body)
	}
	if !bytes.Contains(body, []byte(`"`+c.WorkerID+`"`)) {
		t.Fatalf("worker %s missing from coord list: %s", c.WorkerID, body)
	}
}
