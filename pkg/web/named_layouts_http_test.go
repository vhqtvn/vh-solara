package web

// HTTP handler tests for the worker-wide named tab-layout catalog
// (worker-scoped v1). Mirrors pins_http_test.go coverage adapted to the
// PER-ENTRY upsert contract: GET public shape (sorted entries, no
// schemaVersion leak); PUT happy path; per-entry semantics (a PUT of entry Y
// leaves unrelated entries byte-identical); 409 on CAS mismatch (full
// current doc in body); machine-readable 400s for each validation code;
// CSRF enforcement (csrfGuard is live via srv.Handler()); the 1 MiB request
// cap; catalog_full; method switch (405); lenient unknown-field decode.
//
// Lane: Go co-located unit (pkg/web/), real HTTP stack via
// httptest.NewServer(srv.Handler()) — same pattern as pins_http_test.go.

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// newLayoutsTestServer builds a web Server with the NamedLayoutStore isolated
// under a fresh VH_STATE_DIR temp dir (so each test gets a clean catalog and
// never touches the operator's real state). The default aggregator is live
// but backed by a dead OpenCode URL (construction never dials it).
func newLayoutsTestServer(t *testing.T) (*Server, *httptest.Server) {
	t.Helper()
	t.Setenv("VH_STATE_DIR", t.TempDir())
	const deadURL = "http://127.0.0.1:1"
	agg := aggregator.New(deadURL, 100)
	srv, err := NewServer(agg, deadURL, 100)
	if err != nil {
		t.Fatalf("NewServer: %v", err)
	}
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})
	return srv, web
}

// layoutsPut issues a CSRF-bearing PUT /vh/layouts and returns the raw
// response. The caller defers resp.Body.Close().
func layoutsPut(t *testing.T, url string, body any) *http.Response {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	return layoutsPutRaw(t, url, b, true)
}

// layoutsPutRaw issues a PUT /vh/layouts with the given raw body bytes and an
// optional CSRF header. Used for malformed-JSON, missing-CSRF, and
// oversized-body tests.
func layoutsPutRaw(t *testing.T, url string, body []byte, withCSRF bool) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if withCSRF {
		req.Header.Set(csrfHeader, "1")
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// decodeLayoutsResp decodes a layoutsPublicResp from a response body.
func decodeLayoutsResp(t *testing.T, body io.Reader) layoutsPublicResp {
	t.Helper()
	var r layoutsPublicResp
	if err := json.NewDecoder(body).Decode(&r); err != nil {
		t.Fatalf("decode layoutsPublicResp: %v", err)
	}
	return r
}

// layoutErrBody mirrors the machine-readable 400 contract.
type layoutErrBody struct {
	Error   string `json:"error"`
	Message string `json:"message"`
}

// decodeLayoutsErr decodes the structured error body. Fatals on a body that
// is not valid JSON so a text/plain regression is caught loudly.
func decodeLayoutsErr(t *testing.T, body io.Reader) layoutErrBody {
	t.Helper()
	var r layoutErrBody
	if err := json.NewDecoder(body).Decode(&r); err != nil {
		t.Fatalf("decode layoutErrBody: %v", err)
	}
	return r
}

// entryBody builds a request-body map for one entry.
func entryBody(baseRevision int64, entry map[string]any) map[string]any {
	return map[string]any{
		"baseRevision": baseRevision,
		"entry":        entry,
	}
}

// validEntry builds a valid entry body map.
func validEntry(name string) map[string]any {
	return map[string]any{
		"scope":    "tab",
		"name":     name,
		"tabTitle": "Title " + name,
		"layout":   map[string]any{"grid": map[string]any{"n": 1}, "panels": []any{}},
		"savedAt":  1726600000000,
	}
}

// --- GET /vh/layouts ---------------------------------------------------------

// TestLayoutsHTTPGetShape verifies the GET response is the public shape: has
// revision + entries, entries is non-nil and sorted by name, and schemaVersion
// is NOT leaked. On a fresh store: revision 0, empty entries.
func TestLayoutsHTTPGetShape(t *testing.T) {
	_, web := newLayoutsTestServer(t)

	resp, err := http.Get(web.URL + "/vh/layouts")
	if err != nil {
		t.Fatalf("GET /vh/layouts: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	raw, _ := io.ReadAll(resp.Body)

	// schemaVersion must NOT appear in the wire response (internal detail).
	if bytes.Contains(raw, []byte(`"schemaVersion"`)) {
		t.Fatalf("GET response leaks schemaVersion: %s", raw)
	}

	r := decodeLayoutsResp(t, bytes.NewReader(raw))
	if r.Revision != 0 {
		t.Fatalf("fresh store: Revision = %d, want 0", r.Revision)
	}
	if r.Entries == nil {
		t.Fatalf("entries = nil, want non-nil empty slice")
	}
	if len(r.Entries) != 0 {
		t.Fatalf("fresh store: entries = %v, want empty", r.Entries)
	}
}

// TestLayoutsHTTPGetSortedByName verifies entries are sorted by name on the
// wire (deterministic shape regardless of map iteration order).
func TestLayoutsHTTPGetSortedByName(t *testing.T) {
	_, web := newLayoutsTestServer(t)

	// Insert out of name order, tracking the advancing revision.
	var base int64
	for _, name := range []string{"zeta", "alpha", "mid"} {
		resp := layoutsPut(t, web.URL+"/vh/layouts", entryBody(base, validEntry(name)))
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			b, _ := io.ReadAll(resp.Body)
			t.Fatalf("PUT %s at base %d: status %d body %s", name, base, resp.StatusCode, b)
		}
		base++
	}

	get, err := http.Get(web.URL + "/vh/layouts")
	if err != nil {
		t.Fatal(err)
	}
	defer get.Body.Close()
	r := decodeLayoutsResp(t, get.Body)
	if len(r.Entries) != 3 {
		t.Fatalf("entries len = %d, want 3", len(r.Entries))
	}
	wantOrder := []string{"alpha", "mid", "zeta"}
	for i, w := range wantOrder {
		if r.Entries[i].Name != w {
			t.Fatalf("entries[%d].Name = %q, want %q (sorted by name): %+v", i, r.Entries[i].Name, w, r.Entries)
		}
	}
}

// --- PUT happy path + per-entry semantics (THE pinned contract) --------------

// TestLayoutsHTTPPutHappyPath verifies a valid per-entry PUT succeeds (200),
// returns the committed public doc, and bumps the revision by exactly 1.
func TestLayoutsHTTPPutHappyPath(t *testing.T) {
	_, web := newLayoutsTestServer(t)

	resp := layoutsPut(t, web.URL+"/vh/layouts", entryBody(0, validEntry("focus")))
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("PUT happy path: status %d, want 200. body: %s", resp.StatusCode, b)
	}
	r := decodeLayoutsResp(t, resp.Body)
	if r.Revision != 1 {
		t.Fatalf("after PUT: Revision = %d, want 1", r.Revision)
	}
	if len(r.Entries) != 1 || r.Entries[0].Name != "focus" {
		t.Fatalf("after PUT: entries = %+v, want [focus]", r.Entries)
	}
	e := r.Entries[0]
	if e.Scope != "tab" || e.TabTitle != "Title focus" || e.SavedAt != 1726600000000 {
		t.Fatalf("entry round-trip mismatch: %+v", e)
	}
	if !jsonEqual(e.Layout, json.RawMessage(`{"grid":{"n":1},"panels":[]}`)) {
		t.Fatalf("layout round-trip mismatch: %s", e.Layout)
	}
}

// jsonEqual compares two JSON values by marshal-normalizing them.
func jsonEqual(a, b json.RawMessage) bool {
	var va, vb any
	if err := json.Unmarshal(a, &va); err != nil {
		return false
	}
	if err := json.Unmarshal(b, &vb); err != nil {
		return false
	}
	na, _ := json.Marshal(va)
	nb, _ := json.Marshal(vb)
	return bytes.Equal(na, nb)
}

// TestLayoutsHTTPPutPerEntryIsolation is THE per-entry-semantics pin: with
// unrelated entries Z and W already saved, a PUT of entry Y must leave Z and W
// untouched — the catalog diff is exactly the one new entry Y, and revision
// advanced by exactly 1.
func TestLayoutsHTTPPutPerEntryIsolation(t *testing.T) {
	_, web := newLayoutsTestServer(t)

	// Seed two unrelated entries.
	seed := []string{"z-entry", "w-entry"}
	var base int64
	for _, name := range seed {
		resp := layoutsPut(t, web.URL+"/vh/layouts", entryBody(base, validEntry(name)))
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			b, _ := io.ReadAll(resp.Body)
			t.Fatalf("seed PUT %s: status %d body %s", name, resp.StatusCode, b)
		}
		base++
	}

	// Snapshot the catalog before the Y PUT.
	getBefore, err := http.Get(web.URL + "/vh/layouts")
	if err != nil {
		t.Fatal(err)
	}
	before := decodeLayoutsResp(t, getBefore.Body)
	getBefore.Body.Close()
	beforeByName := map[string]TabLayoutEntry{}
	for _, e := range before.Entries {
		beforeByName[e.Name] = e
	}

	// PUT entry Y (unrelated to Z/W).
	resp := layoutsPut(t, web.URL+"/vh/layouts", entryBody(base, validEntry("y-entry")))
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("PUT y-entry: status %d body %s", resp.StatusCode, b)
	}
	after := decodeLayoutsResp(t, resp.Body)

	// Revision advanced by exactly 1.
	if after.Revision != before.Revision+1 {
		t.Fatalf("revision advanced %d → %d, want +1", before.Revision, after.Revision)
	}

	// Catalog diff is EXACTLY the one new entry.
	afterByName := map[string]TabLayoutEntry{}
	for _, e := range after.Entries {
		afterByName[e.Name] = e
	}
	if len(afterByName) != len(beforeByName)+1 {
		t.Fatalf("catalog grew from %d to %d entries, want +1 exactly", len(beforeByName), len(afterByName))
	}
	for name, e := range beforeByName {
		got, ok := afterByName[name]
		if !ok {
			t.Fatalf("unrelated entry %q vanished on an unrelated PUT", name)
		}
		if got.TabTitle != e.TabTitle || got.SavedAt != e.SavedAt || got.Scope != e.Scope || !bytes.Equal(got.Layout, e.Layout) {
			t.Fatalf("unrelated entry %q mutated on an unrelated PUT:\nbefore: %+v layout=%s\nafter:  %+v layout=%s",
				name, e, e.Layout, got, got.Layout)
		}
	}
	if _, ok := afterByName["y-entry"]; !ok {
		t.Fatal("the PUT entry y-entry is absent from the committed catalog")
	}

	// Overwriting Y alone must likewise leave Z/W untouched.
	resp2 := layoutsPut(t, web.URL+"/vh/layouts", entryBody(after.Revision, validEntry("y-entry")))
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		b, _ := io.ReadAll(resp2.Body)
		t.Fatalf("overwrite PUT y-entry: status %d body %s", resp2.StatusCode, b)
	}
	after2 := decodeLayoutsResp(t, resp2.Body)
	if len(after2.Entries) != 3 {
		t.Fatalf("overwrite changed catalog size: %d entries, want 3", len(after2.Entries))
	}
	for _, e := range after2.Entries {
		if e.Name != "y-entry" {
			prev := beforeByName[e.Name]
			if e.TabTitle != prev.TabTitle || !bytes.Equal(e.Layout, prev.Layout) || e.SavedAt != prev.SavedAt {
				t.Fatalf("unrelated entry %q mutated on overwrite of y-entry", e.Name)
			}
		}
	}
}

// --- CSRF enforcement -------------------------------------------------------

// TestLayoutsHTTPCSRFEnforced verifies PUT without X-VH-CSRF is rejected by
// the csrfGuard middleware (403), and PUT with the header reaches the handler.
func TestLayoutsHTTPCSRFEnforced(t *testing.T) {
	_, web := newLayoutsTestServer(t)

	// Without CSRF → 403 (csrfGuard blocks before the handler runs).
	body, _ := json.Marshal(entryBody(0, validEntry("x")))
	resp := layoutsPutRaw(t, web.URL+"/vh/layouts", body, false)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("PUT without CSRF: status = %d, want 403", resp.StatusCode)
	}

	// With CSRF → reaches the handler (200 for a valid entry on rev 0).
	resp2 := layoutsPutRaw(t, web.URL+"/vh/layouts", body, true)
	defer resp2.Body.Close()
	if resp2.StatusCode == http.StatusForbidden {
		t.Fatalf("PUT with CSRF: got 403 (csrfGuard blocked a valid request)")
	}
	if resp2.StatusCode != 200 {
		b, _ := io.ReadAll(resp2.Body)
		t.Fatalf("PUT with CSRF: status %d, want 200. body %s", resp2.StatusCode, b)
	}
}

// --- 409: CAS mismatch ------------------------------------------------------

// TestLayoutsHTTPPut409CASMismatch verifies a PUT with a stale baseRevision
// returns 409 with the full current public doc in the body (so the client can
// adopt server state), and does NOT mutate the catalog.
func TestLayoutsHTTPPut409CASMismatch(t *testing.T) {
	_, web := newLayoutsTestServer(t)

	// Establish the catalog at revision 1.
	resp := layoutsPut(t, web.URL+"/vh/layouts", entryBody(0, validEntry("a")))
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("setup PUT: status %d", resp.StatusCode)
	}

	// Stale PUT (baseRevision=0, but current is 1) → 409 with current doc.
	stale := layoutsPut(t, web.URL+"/vh/layouts", entryBody(0, validEntry("b")))
	defer stale.Body.Close()
	if stale.StatusCode != http.StatusConflict {
		t.Fatalf("stale PUT: status = %d, want 409", stale.StatusCode)
	}
	if ct := stale.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("409 Content-Type = %q, want application/json", ct)
	}
	cur := decodeLayoutsResp(t, stale.Body)
	if cur.Revision != 1 {
		t.Fatalf("409 body Revision = %d, want 1 (current server state)", cur.Revision)
	}
	if len(cur.Entries) != 1 || cur.Entries[0].Name != "a" {
		t.Fatalf("409 body entries = %+v, want [a] (current server state)", cur.Entries)
	}

	// Confirm the catalog was NOT mutated by the stale PUT.
	get, err := http.Get(web.URL + "/vh/layouts")
	if err != nil {
		t.Fatal(err)
	}
	defer get.Body.Close()
	g := decodeLayoutsResp(t, get.Body)
	if g.Revision != 1 || len(g.Entries) != 1 || g.Entries[0].Name != "a" {
		t.Fatalf("doc mutated by stale PUT: revision=%d entries=%+v", g.Revision, g.Entries)
	}
}

// --- 400: validation rejections (machine-readable) ---------------------------

// TestLayoutsHTTPPut400 covers the strict-input 400 cases as subtests, each
// asserting BOTH the status and the machine-readable error code.
func TestLayoutsHTTPPut400(t *testing.T) {
	cases := []struct {
		name string
		body map[string]any
		code string
	}{
		{"missing_base_revision", map[string]any{"entry": validEntry("x")}, "missing_base_revision"},
		{"missing_entry", map[string]any{"baseRevision": 0}, "missing_entry"},
		{"null_entry", map[string]any{"baseRevision": 0, "entry": nil}, "missing_entry"},
		{"wrong_scope", entryBody(0, with(validEntry("x"), "scope", "master")), "invalid_scope"},
		{"absent_scope", entryBody(0, without(validEntry("x"), "scope")), "invalid_scope"},
		{"empty_name", entryBody(0, with(validEntry("x"), "name", "")), "invalid_name"},
		{"untrimmed_name", entryBody(0, with(validEntry("x"), "name", " padded ")), "invalid_name"},
		{"oversized_name", entryBody(0, with(validEntry("x"), "name", strings.Repeat("n", maxLayoutNameLen+1))), "invalid_name"},
		{"empty_tab_title", entryBody(0, with(validEntry("x"), "tabTitle", "")), "invalid_tab_title"},
		{"oversized_tab_title", entryBody(0, with(validEntry("x"), "tabTitle", strings.Repeat("t", maxLayoutTabTitleLen+1))), "invalid_tab_title"},
		{"negative_saved_at", entryBody(0, with(validEntry("x"), "savedAt", -1)), "invalid_saved_at"},
		{"layout_not_object", entryBody(0, with(validEntry("x"), "layout", []any{1, 2})), "invalid_layout"},
		{"layout_null", entryBody(0, with(validEntry("x"), "layout", nil)), "invalid_layout"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, web := newLayoutsTestServer(t)
			resp := layoutsPut(t, web.URL+"/vh/layouts", tc.body)
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusBadRequest {
				b, _ := io.ReadAll(resp.Body)
				t.Fatalf("status = %d, want 400. body: %s", resp.StatusCode, b)
			}
			if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
				t.Fatalf("Content-Type = %q, want application/json (machine-readable 400)", ct)
			}
			e := decodeLayoutsErr(t, resp.Body)
			if e.Error != tc.code {
				t.Fatalf("error code = %q, want %q (message: %q)", e.Error, tc.code, e.Message)
			}
			if e.Message == "" {
				t.Fatal("error message is empty, want a human-readable message")
			}
		})
	}

	// malformed JSON → invalid_body (raw body, not a map).
	t.Run("malformed_json", func(t *testing.T) {
		_, web := newLayoutsTestServer(t)
		resp := layoutsPutRaw(t, web.URL+"/vh/layouts", []byte(`{"baseRevision": 0, BROKEN`), true)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", resp.StatusCode)
		}
		e := decodeLayoutsErr(t, resp.Body)
		if e.Error != "invalid_body" {
			t.Fatalf("error code = %q, want invalid_body", e.Error)
		}
	})

	// oversized layout (raw bytes > 256 KiB) → layout_too_large.
	t.Run("layout_too_large", func(t *testing.T) {
		_, web := newLayoutsTestServer(t)
		big := make([]byte, maxLayoutJSONBytes+1)
		for i := range big {
			big[i] = 'a'
		}
		// Wrap the oversized payload as a JSON string value inside the layout
		// object so it is a valid JSON object exceeding the raw cap.
		layout := json.RawMessage(`{"pad":"` + string(big) + `"}`)
		body, _ := json.Marshal(putLayoutsReq{
			BaseRevision: ptrInt64(0),
			Entry: &TabLayoutEntry{
				Scope: "tab", Name: "big", TabTitle: "Big", Layout: layout, SavedAt: 1,
			},
		})
		resp := layoutsPutRaw(t, web.URL+"/vh/layouts", body, true)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", resp.StatusCode)
		}
		e := decodeLayoutsErr(t, resp.Body)
		if e.Error != "layout_too_large" {
			t.Fatalf("error code = %q, want layout_too_large", e.Error)
		}
	})
}

// with returns a copy of the entry map with key overridden.
func with(m map[string]any, key string, val any) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		out[k] = v
	}
	out[key] = val
	return out
}

// without returns a copy of the entry map with key removed.
func without(m map[string]any, key string) map[string]any {
	out := make(map[string]any, len(m))
	for k, v := range m {
		if k == key {
			continue
		}
		out[k] = v
	}
	return out
}

// ptrInt64 returns a pointer to v.
func ptrInt64(v int64) *int64 { return &v }

// --- catalog_full ------------------------------------------------------------

// TestLayoutsHTTPPutCatalogFull verifies the maxNamedLayouts cap surfaces as a
// machine-readable 400 catalog_full for a NEW name at a full catalog, while an
// overwrite of an existing name still succeeds.
func TestLayoutsHTTPPutCatalogFull(t *testing.T) {
	_, web := newLayoutsTestServer(t)

	var base int64
	for i := 0; i < maxNamedLayouts; i++ {
		e := validEntry("layout-" + strconv.Itoa(i))
		resp := layoutsPut(t, web.URL+"/vh/layouts", entryBody(base, e))
		resp.Body.Close()
		if resp.StatusCode != 200 {
			t.Fatalf("fill PUT %d: status %d", i, resp.StatusCode)
		}
		base++
	}

	// NEW name at a full catalog → 400 catalog_full.
	resp := layoutsPut(t, web.URL+"/vh/layouts", entryBody(base, validEntry("one-too-many")))
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("over-cap PUT: status %d, want 400", resp.StatusCode)
	}
	e := decodeLayoutsErr(t, resp.Body)
	if e.Error != "catalog_full" {
		t.Fatalf("error code = %q, want catalog_full", e.Error)
	}

	// Overwrite of an EXISTING name at a full catalog → 200.
	resp2 := layoutsPut(t, web.URL+"/vh/layouts", entryBody(base, validEntry("layout-0")))
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		b, _ := io.ReadAll(resp2.Body)
		t.Fatalf("overwrite-at-cap PUT: status %d, want 200. body %s", resp2.StatusCode, b)
	}
	r := decodeLayoutsResp(t, resp2.Body)
	if len(r.Entries) != maxNamedLayouts {
		t.Fatalf("overwrite-at-cap: entries = %d, want %d", len(r.Entries), maxNamedLayouts)
	}
}

// --- 1 MiB request cap -------------------------------------------------------

// TestLayoutsHTTPPutBodyCap verifies the 1 MiB request-body cap: a body just
// over 1 MiB is rejected (MaxBytesReader surfaces a decode error → 400), and
// no catalog mutation happened.
func TestLayoutsHTTPPutBodyCap(t *testing.T) {
	_, web := newLayoutsTestServer(t)

	// Build a valid-shaped body whose JSON is > 1 MiB: the layout object is
	// within the per-entry 256 KiB cap after parse... no — to exceed the
	// REQUEST cap the raw body must be >1 MiB. Use an oversized padding field
	// OUTSIDE the entry (unknown advisory fields are lenient), so the layout
	// itself stays small and the body crosses the request cap.
	pad := strings.Repeat("p", 1<<20)
	body := `{"baseRevision":0,"entry":` + string(mustJSON(validEntry("x"))) + `,"pad":"` + pad + `"}`
	resp := layoutsPutRaw(t, web.URL+"/vh/layouts", []byte(body), true)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("oversized body: status = %d, want 400", resp.StatusCode)
	}
	// MaxBytesReader yields a decode error → invalid_body code.
	e := decodeLayoutsErr(t, resp.Body)
	if e.Error != "invalid_body" {
		t.Fatalf("error code = %q, want invalid_body", e.Error)
	}

	// Nothing was committed.
	get, err := http.Get(web.URL + "/vh/layouts")
	if err != nil {
		t.Fatal(err)
	}
	defer get.Body.Close()
	g := decodeLayoutsResp(t, get.Body)
	if g.Revision != 0 || len(g.Entries) != 0 {
		t.Fatalf("oversized body mutated catalog: revision=%d entries=%d", g.Revision, len(g.Entries))
	}
}

// mustJSON marshals v or fatals.
func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}

// --- method switch -----------------------------------------------------------

// TestLayoutsHTTPMethodNotAllowed verifies POST (and DELETE) are 405; only
// GET/PUT are served.
func TestLayoutsHTTPMethodNotAllowed(t *testing.T) {
	_, web := newLayoutsTestServer(t)
	for _, method := range []string{http.MethodPost, http.MethodDelete} {
		req, err := http.NewRequest(method, web.URL+"/vh/layouts", strings.NewReader(`{}`))
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set(csrfHeader, "1")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusMethodNotAllowed {
			t.Fatalf("%s: status = %d, want 405", method, resp.StatusCode)
		}
	}
}

// --- lenient decode ----------------------------------------------------------

// TestLayoutsHTTPPutAcceptsUnknownAdvisoryField verifies the decoder is
// lenient on unknown request fields (forward compatibility), same policy as
// pins.
func TestLayoutsHTTPPutAcceptsUnknownAdvisoryField(t *testing.T) {
	_, web := newLayoutsTestServer(t)
	body := map[string]any{
		"baseRevision": 0,
		"entry":        validEntry("x"),
		"advisory":     "future-field",
	}
	resp := layoutsPut(t, web.URL+"/vh/layouts", body)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("PUT with unknown advisory field: status %d, want 200. body %s", resp.StatusCode, b)
	}
	r := decodeLayoutsResp(t, resp.Body)
	if r.Revision != 1 || len(r.Entries) != 1 {
		t.Fatalf("advisory PUT: revision=%d entries=%d", r.Revision, len(r.Entries))
	}
}

// --- persistence across server restarts --------------------------------------

// TestLayoutsHTTPPersistenceAcrossRestart verifies the catalog persists to
// named-layouts.json under VH_STATE_DIR and a NEW Server over the same state
// dir sees the committed entries (durable across restarts).
func TestLayoutsHTTPPersistenceAcrossRestart(t *testing.T) {
	stateDir := t.TempDir()
	t.Setenv("VH_STATE_DIR", stateDir)

	buildServer := func() *httptest.Server {
		const deadURL = "http://127.0.0.1:1"
		agg := aggregator.New(deadURL, 100)
		srv, err := NewServer(agg, deadURL, 100)
		if err != nil {
			t.Fatalf("NewServer: %v", err)
		}
		web := httptest.NewServer(srv.Handler())
		t.Cleanup(web.Close)
		t.Cleanup(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_ = srv.Shutdown(ctx)
		})
		return web
	}

	web1 := buildServer()
	resp := layoutsPut(t, web1.URL+"/vh/layouts", entryBody(0, validEntry("durable")))
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("PUT: status %d body %s", resp.StatusCode, b)
	}

	// The file exists under the state dir with the schema version.
	data, err := os.ReadFile(filepath.Join(stateDir, "named-layouts.json"))
	if err != nil {
		t.Fatalf("named-layouts.json missing after PUT: %v", err)
	}
	if !bytes.Contains(data, []byte(`"schemaVersion"`)) {
		t.Fatalf("persisted file lacks schemaVersion: %s", data)
	}

	// A fresh server over the same state dir round-trips the entry.
	web2 := buildServer()
	get, err := http.Get(web2.URL + "/vh/layouts")
	if err != nil {
		t.Fatal(err)
	}
	defer get.Body.Close()
	r := decodeLayoutsResp(t, get.Body)
	if r.Revision != 1 || len(r.Entries) != 1 || r.Entries[0].Name != "durable" {
		t.Fatalf("restart did not round-trip the catalog: revision=%d entries=%+v", r.Revision, r.Entries)
	}
}
