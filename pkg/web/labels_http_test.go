package web

// HTTP handler tests for Slice 2 of server-managed root-session labels.
//
// Mirrors pkg/web/pins_http_test.go structurally and semantically: GET public
// shape (no schemaVersion/projectByRootSessionId leak); PUT happy path; PUT
// 409 on CAS mismatch (returns full current doc); PUT 400 for malformed /
// missing-baseRevision / unknown-root / nested-session (not a root) /
// exclusive-group / dangling-tag-ref; CSRF enforcement; authoritative adoption
// from both 400 and 409 (the client adopts the returned authority in one
// round-trip); multi-project activeRootProjects builder; and the
// anti-resurrection mirror (a retained root whose project is closed survives).
//
// Lane: Go co-located unit (pkg/web/). These exercise the real HTTP stack via
// httptest.NewServer(srv.Handler()), matching pins_http_test.go /
// queue_test.go. The csrfGuard middleware is live, so unsafe methods without
// X-VH-CSRF get 403 (same as production).

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// newLabelsTestServer builds a web Server with the LabelStore isolated under a
// fresh VH_STATE_DIR temp dir (so each test gets a clean labels doc and never
// touches the operator's real state). Structurally identical to
// newPinsTestServer: the default aggregator is live but backed by a dead
// OpenCode URL (construction never dials it). Roots are seeded directly into
// the store via Apply (see seedLabelSession).
func newLabelsTestServer(t *testing.T) (*Server, *httptest.Server) {
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

// seedLabelSession applies a session.created event so id appears in the store's
// RootInventory. If parentID == "" the session is a ROOT (IsRoot=true); if
// parentID != "" it is a child (IsRoot=false) — used to prove the labels
// roots-only filter rejects nested sessions. Mirrors seedPinSession.
func seedLabelSession(t *testing.T, agg *aggregator.Aggregator, id, parentID string) {
	t.Helper()
	props := `{"info":{"id":"` + id + `"}}`
	if parentID != "" {
		props = `{"info":{"id":"` + id + `","parentID":"` + parentID + `"}}`
	}
	agg.Store().Apply(opencode.Event{
		Type:       "session.created",
		Properties: json.RawMessage(props),
	})
}

// labelsPut issues a CSRF-bearing PUT /vh/labels and returns the raw response.
// The caller defers resp.Body.Close().
func labelsPut(t *testing.T, url string, body any) *http.Response {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequest(http.MethodPut, url, bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(csrfHeader, "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// labelsPutRaw issues a PUT /vh/labels with the given raw body bytes and an
// optional CSRF header. Used for malformed-JSON and missing-CSRF tests.
func labelsPutRaw(t *testing.T, url string, body []byte, withCSRF bool) *http.Response {
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

// decodeLabelsResp decodes a LabelsDoc from a response body.
func decodeLabelsResp(t *testing.T, body io.Reader) LabelsDoc {
	t.Helper()
	var r LabelsDoc
	if err := json.NewDecoder(body).Decode(&r); err != nil {
		t.Fatalf("decode LabelsDoc: %v", err)
	}
	return r
}

// labelsRejectionBody mirrors the structured 400 contract the server emits when
// a PUT fails store validation. The embedded LabelsDoc lets a test compare the
// returned authority against a subsequent GET.
type labelsRejectionBody struct {
	Error     string `json:"error"`
	Message   string `json:"message"`
	IDs       []string
	LabelsDoc // embedded for direct DeepEqual against GET
}

// decodeLabelsRejection decodes the structured 400 body. Fatals on a body that
// is not valid JSON so a text/plain regression is caught loudly.
func decodeLabelsRejection(t *testing.T, body io.Reader) labelsRejectionBody {
	t.Helper()
	var r labelsRejectionBody
	if err := json.NewDecoder(body).Decode(&r); err != nil {
		t.Fatalf("decode labelsRejectionBody: %v", err)
	}
	return r
}

// --- GET /vh/labels ---------------------------------------------------------

// TestLabelsHTTPGetShape verifies the GET response is the public shape: has
// revision + groups + tags + tagIdsByRootSessionId, and does NOT leak
// schemaVersion or projectByRootSessionId (the private labelsFile fields). On a
// fresh store the revision is 0 and every collection is empty (non-nil).
func TestLabelsHTTPGetShape(t *testing.T) {
	_, web := newLabelsTestServer(t)

	resp, err := http.Get(web.URL + "/vh/labels")
	if err != nil {
		t.Fatalf("GET /vh/labels: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	raw, _ := io.ReadAll(resp.Body)

	// projectByRootSessionId must NOT appear in the wire response (internal
	// cleanup metadata, lives only in the private labelsFile).
	if bytes.Contains(raw, []byte(`"projectByRootSessionId"`)) {
		t.Fatalf("GET response leaks projectByRootSessionId: %s", raw)
	}
	// schemaVersion must NOT appear either (a labelsFile-only internal detail).
	if bytes.Contains(raw, []byte(`"schemaVersion"`)) {
		t.Fatalf("GET response leaks schemaVersion: %s", raw)
	}

	r := decodeLabelsResp(t, bytes.NewReader(raw))
	if r.Revision != 0 {
		t.Fatalf("fresh store: Revision = %d, want 0", r.Revision)
	}
	if r.Groups == nil {
		t.Fatalf("Groups = nil, want non-nil empty slice")
	}
	if len(r.Groups) != 0 {
		t.Fatalf("fresh store: Groups = %v, want empty", r.Groups)
	}
	if r.Tags == nil || len(r.Tags) != 0 {
		t.Fatalf("fresh store: Tags = %v, want non-nil empty slice", r.Tags)
	}
	if r.TagIDsByRootSessionID == nil || len(r.TagIDsByRootSessionID) != 0 {
		t.Fatalf("fresh store: TagIDsByRootSessionID = %v, want non-nil empty map", r.TagIDsByRootSessionID)
	}
}

// --- PUT happy path ---------------------------------------------------------

// TestLabelsHTTPPutHappyPath verifies a PUT with a valid active root in a group
// succeeds (200), returns the committed public doc, and bumps the revision. The
// stored projectByRootSessionId is populated from the active-root map but is NOT
// leaked in the response.
func TestLabelsHTTPPutHappyPath(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	seedLabelSession(t, srv.agg, "root-a", "")

	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "Backend", "color": "blue", "orderedRootSessionIds": []string{"root-a"}},
		},
		"tags":                  []map[string]any{{"id": "t1", "name": "urgent", "color": "red"}},
		"tagIdsByRootSessionId": map[string][]string{"root-a": {"t1"}},
	})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("PUT happy path: status %d, want 200. body: %s", resp.StatusCode, b)
	}
	r := decodeLabelsResp(t, resp.Body)
	if r.Revision != 1 {
		t.Fatalf("after PUT: Revision = %d, want 1", r.Revision)
	}
	if len(r.Groups) != 1 || r.Groups[0].ID != "g1" || len(r.Groups[0].OrderedRootSessionIDs) != 1 || r.Groups[0].OrderedRootSessionIDs[0] != "root-a" {
		t.Fatalf("after PUT: groups = %+v, want g1 with [root-a]", r.Groups)
	}
	if len(r.Tags) != 1 || r.Tags[0].ID != "t1" {
		t.Fatalf("after PUT: tags = %+v, want t1", r.Tags)
	}
	if got := r.TagIDsByRootSessionID["root-a"]; len(got) != 1 || got[0] != "t1" {
		t.Fatalf("after PUT: tag assign root-a = %v, want [t1]", got)
	}
	// projectByRootSessionId must not leak even after a successful write that
	// populated it internally.
	raw, _ := json.Marshal(r)
	if bytes.Contains(raw, []byte(`"projectByRootSessionId"`)) {
		t.Fatalf("PUT response leaks projectByRootSessionId: %s", raw)
	}

	// A second PUT bumps revision to 2 (add another root + a second tag).
	seedLabelSession(t, srv.agg, "root-b", "")
	resp2 := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 1,
		"groups": []map[string]any{
			{"id": "g1", "name": "Backend", "color": "blue", "orderedRootSessionIds": []string{"root-a", "root-b"}},
		},
		"tags": []map[string]any{
			{"id": "t1", "name": "urgent", "color": "red"},
			{"id": "t2", "name": "bug", "color": "orange"},
		},
		"tagIdsByRootSessionId": map[string][]string{"root-a": {"t1"}, "root-b": {"t1", "t2"}},
	})
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		t.Fatalf("second PUT: status %d, want 200", resp2.StatusCode)
	}
	r2 := decodeLabelsResp(t, resp2.Body)
	if r2.Revision != 2 {
		t.Fatalf("after second PUT: Revision = %d, want 2", r2.Revision)
	}
	if len(r2.Tags) != 2 {
		t.Fatalf("after second PUT: tags len = %d, want 2", len(r2.Tags))
	}
}

// --- CSRF enforcement -------------------------------------------------------

// TestLabelsHTTPCSRFEnforced verifies PUT without X-VH-CSRF is rejected by the
// csrfGuard middleware (403), and PUT with the header reaches the handler.
func TestLabelsHTTPCSRFEnforced(t *testing.T) {
	_, web := newLabelsTestServer(t)

	// Without CSRF → 403 (csrfGuard blocks before the handler runs).
	body, _ := json.Marshal(map[string]any{"baseRevision": 0, "groups": []any{}})
	resp := labelsPutRaw(t, web.URL+"/vh/labels", body, false)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("PUT without CSRF: status = %d, want 403", resp.StatusCode)
	}

	// With CSRF → reaches the handler (200 for an empty-doc PUT on rev 0).
	resp2 := labelsPutRaw(t, web.URL+"/vh/labels", body, true)
	defer resp2.Body.Close()
	if resp2.StatusCode == http.StatusForbidden {
		t.Fatalf("PUT with CSRF: got 403 (csrfGuard blocked a valid request)")
	}
}

// --- 400: malformed / missing-field ----------------------------------------

// TestLabelsHTTPPut400Structural covers the HTTP-layer structural 400 cases
// (plain text body, mirroring pins). These run BEFORE the store is called.
func TestLabelsHTTPPut400Structural(t *testing.T) {
	t.Run("malformed_json", func(t *testing.T) {
		_, web := newLabelsTestServer(t)
		resp := labelsPutRaw(t, web.URL+"/vh/labels", []byte(`{"baseRevision": 0, BROKEN`), true)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("malformed JSON: status = %d, want 400", resp.StatusCode)
		}
	})

	t.Run("missing_baseRevision", func(t *testing.T) {
		_, web := newLabelsTestServer(t)
		// baseRevision absent → *int64 is nil → 400. (Explicitly sending 0 is
		// valid and is NOT this case.)
		resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
			"groups": []any{},
		})
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("missing baseRevision: status = %d, want 400", resp.StatusCode)
		}
	})
}

// --- 400: store validation rejection (structured + self-heal authority) ----

// TestLabelsHTTPPut400UnknownRoot verifies a group that references a root id
// NOT in the authoritative active-root inventory is rejected with a structured
// 400 (error=unknown_root, ids carries the offender) AND the self-healed
// authority doc so the client can adopt server state in one round-trip.
func TestLabelsHTTPPut400UnknownRoot(t *testing.T) {
	_, web := newLabelsTestServer(t)
	// "ghost" is NOT seeded → not a root → store rejects unknown_root.
	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"ghost"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("unknown root: status = %d, want 400", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Fatalf("Content-Type = %q, want application/json (machine-readable 400)", ct)
	}
	e := decodeLabelsRejection(t, resp.Body)
	if e.Error != string(LabelRejectionUnknownRoot) {
		t.Fatalf("error = %q, want %s", e.Error, LabelRejectionUnknownRoot)
	}
	if len(e.IDs) != 1 || e.IDs[0] != "ghost" {
		t.Fatalf("ids = %v, want [ghost]", e.IDs)
	}
	// The 400 body carries the self-healed authority (fresh-store revision 0).
	if e.Revision != 0 || len(e.Groups) != 0 {
		t.Fatalf("400 authority body = %+v, want fresh empty doc (rev 0)", e.LabelsDoc)
	}
}

// TestLabelsHTTPPut400NestedSession verifies a group that references a LIVE but
// NON-ROOT session (parentID != "") is rejected. This proves the IsRoot filter
// in activeRootProjects is the STRICT definition, not orphan-inclusive: a child
// is live (in SessionIDs) but is NOT a root (IsRoot=false), so it is absent from
// activeRootProjects and the store rejects it as unknown_root.
func TestLabelsHTTPPut400NestedSession(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	// Seed a parent root and a child under it.
	seedLabelSession(t, srv.agg, "the-root", "")
	seedLabelSession(t, srv.agg, "the-child", "the-root")

	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"the-child"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("nested session: status = %d, want 400", resp.StatusCode)
	}
	e := decodeLabelsRejection(t, resp.Body)
	if e.Error != string(LabelRejectionUnknownRoot) {
		t.Fatalf("error = %q, want %s (a child is unknown AS A ROOT)", e.Error, LabelRejectionUnknownRoot)
	}
	if len(e.IDs) != 1 || e.IDs[0] != "the-child" {
		t.Fatalf("ids = %v, want [the-child]", e.IDs)
	}
}

// TestLabelsHTTPPut400ExclusiveGroup verifies a root placed in two groups is
// rejected (exclusive-group invariant) with a structured 400 + authority.
func TestLabelsHTTPPut400ExclusiveGroup(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	seedLabelSession(t, srv.agg, "r1", "")

	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "A", "color": "blue", "orderedRootSessionIds": []string{"r1"}},
			{"id": "g2", "name": "B", "color": "green", "orderedRootSessionIds": []string{"r1"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("exclusive group: status = %d, want 400", resp.StatusCode)
	}
	e := decodeLabelsRejection(t, resp.Body)
	if e.Error != string(LabelRejectionExclusiveGroup) {
		t.Fatalf("error = %q, want %s", e.Error, LabelRejectionExclusiveGroup)
	}
}

// TestLabelsHTTPPut400DanglingTagRef verifies a tag assignment that references a
// tag id not in Tags is rejected (dangling-tag-ref) with a structured 400.
func TestLabelsHTTPPut400DanglingTagRef(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	seedLabelSession(t, srv.agg, "r1", "")

	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"r1"}},
		},
		"tags":                  []map[string]any{{"id": "t1", "name": "T", "color": "red"}},
		"tagIdsByRootSessionId": map[string][]string{"r1": {"t1", "t-ghost"}},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("dangling tag ref: status = %d, want 400", resp.StatusCode)
	}
	e := decodeLabelsRejection(t, resp.Body)
	if e.Error != string(LabelRejectionDanglingTagRef) {
		t.Fatalf("error = %q, want %s", e.Error, LabelRejectionDanglingTagRef)
	}
}

// --- 409: CAS mismatch ------------------------------------------------------

// TestLabelsHTTPPut409CASMismatch verifies a PUT with a stale baseRevision
// returns 409 with the full current public doc in the body (so the client can
// adopt server state), and does NOT mutate the doc.
func TestLabelsHTTPPut409CASMismatch(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	seedLabelSession(t, srv.agg, "a", "")

	// Establish the doc at revision 1.
	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"a"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("setup PUT: status %d, want 200", resp.StatusCode)
	}

	// Stale PUT (baseRevision=0, but current is 1) → 409 with the current doc.
	seedLabelSession(t, srv.agg, "b", "")
	stale := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0, // stale — server is at 1
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"a", "b"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	defer stale.Body.Close()
	if stale.StatusCode != http.StatusConflict {
		t.Fatalf("stale PUT: status = %d, want 409", stale.StatusCode)
	}
	cur := decodeLabelsResp(t, stale.Body)
	if cur.Revision != 1 {
		t.Fatalf("409 body Revision = %d, want 1 (current server state)", cur.Revision)
	}
	if len(cur.Groups) != 1 || cur.Groups[0].ID != "g1" || len(cur.Groups[0].OrderedRootSessionIDs) != 1 || cur.Groups[0].OrderedRootSessionIDs[0] != "a" {
		t.Fatalf("409 body groups = %+v, want g1 with [a] (current server state)", cur.Groups)
	}

	// Confirm the doc was NOT mutated by the stale PUT (still revision 1).
	get, err := http.Get(web.URL + "/vh/labels")
	if err != nil {
		t.Fatal(err)
	}
	defer get.Body.Close()
	g := decodeLabelsResp(t, get.Body)
	if g.Revision != 1 || len(g.Groups) != 1 {
		t.Fatalf("doc mutated by stale PUT: revision=%d groups=%+v", g.Revision, g.Groups)
	}
}

// --- authoritative adoption from 400 and 409 -------------------------------

// TestLabelsHTTPAuthoritativeAdoptionFrom400 verifies the 400 rejection body
// carries the self-healed authority that EQUALS a subsequent GET: the client
// adopts the 400 body's embedded doc and is in sync with the server. After a
// successful PUT (rev 1), a rejected PUT's 400 body must reflect rev 1 and the
// committed groups — NOT the rejected candidate.
func TestLabelsHTTPAuthoritativeAdoptionFrom400(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	seedLabelSession(t, srv.agg, "good", "")

	// Establish authority at rev 1 with one group.
	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "Kept", "color": "blue", "orderedRootSessionIds": []string{"good"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("setup PUT: status %d, want 200", resp.StatusCode)
	}

	// Rejected PUT (references an unknown root "bad") at the correct revision.
	bad := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 1,
		"groups": []map[string]any{
			{"id": "g1", "name": "Kept", "color": "blue", "orderedRootSessionIds": []string{"good"}},
			{"id": "g2", "name": "Bad", "color": "red", "orderedRootSessionIds": []string{"bad"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	defer bad.Body.Close()
	if bad.StatusCode != http.StatusBadRequest {
		t.Fatalf("rejected PUT: status %d, want 400", bad.StatusCode)
	}
	body400 := decodeLabelsRejection(t, bad.Body)
	if body400.Error != string(LabelRejectionUnknownRoot) {
		t.Fatalf("error = %q, want %s", body400.Error, LabelRejectionUnknownRoot)
	}

	// The 400 authority must equal a fresh GET.
	get, err := http.Get(web.URL + "/vh/labels")
	if err != nil {
		t.Fatal(err)
	}
	defer get.Body.Close()
	got := decodeLabelsResp(t, get.Body)
	if !reflect.DeepEqual(body400.LabelsDoc, got) {
		t.Fatalf("400 authority != GET:\n400:  %+v\nGET:  %+v", body400.LabelsDoc, got)
	}
	if got.Revision != 1 || len(got.Groups) != 1 || got.Groups[0].ID != "g1" {
		t.Fatalf("GET after 400 = %+v, want rev 1 / g1 only (rejected candidate must not have applied)", got)
	}
}

// TestLabelsHTTPAuthoritativeAdoptionFrom409 verifies the 409 body carries the
// authority that EQUALS a subsequent GET: the client adopts the 409 body's doc
// and is in sync with the server.
func TestLabelsHTTPAuthoritativeAdoptionFrom409(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	seedLabelSession(t, srv.agg, "a", "")
	seedLabelSession(t, srv.agg, "b", "")

	// Establish authority at rev 1.
	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"a"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("setup PUT: status %d, want 200", resp.StatusCode)
	}

	// Concurrent writer advances the doc to rev 2 before the stale PUT lands.
	advancer := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 1,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"a", "b"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	defer advancer.Body.Close()
	if advancer.StatusCode != 200 {
		t.Fatalf("advancer PUT: status %d, want 200", advancer.StatusCode)
	}

	// Stale PUT (baseRevision=1, but current is 2) → 409.
	stale := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 1, // stale
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"a"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	defer stale.Body.Close()
	if stale.StatusCode != http.StatusConflict {
		t.Fatalf("stale PUT: status %d, want 409", stale.StatusCode)
	}
	body409 := decodeLabelsResp(t, stale.Body)

	// The 409 authority must equal a fresh GET.
	get, err := http.Get(web.URL + "/vh/labels")
	if err != nil {
		t.Fatal(err)
	}
	defer get.Body.Close()
	got := decodeLabelsResp(t, get.Body)
	if !reflect.DeepEqual(body409, got) {
		t.Fatalf("409 authority != GET:\n409: %+v\nGET: %+v", body409, got)
	}
	if got.Revision != 2 || len(got.Groups[0].OrderedRootSessionIDs) != 2 {
		t.Fatalf("GET after 409 = %+v, want rev 2 / [a b]", got)
	}
}

// --- GET after PUT round-trips the committed state --------------------------

// TestLabelsHTTPGetReflectsPut verifies a GET after a PUT returns the committed
// state (not a stale view) — the response is always derived from Snapshot().
func TestLabelsHTTPGetReflectsPut(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	seedLabelSession(t, srv.agg, "r1", "")
	seedLabelSession(t, srv.agg, "r2", "")

	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"r2", "r1"}}, // deliberate order
		},
		"tags": []map[string]any{
			{"id": "t1", "name": "T", "color": "red"},
		},
		"tagIdsByRootSessionId": map[string][]string{"r1": {"t1"}},
	})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("PUT: status %d", resp.StatusCode)
	}

	get, err := http.Get(web.URL + "/vh/labels")
	if err != nil {
		t.Fatal(err)
	}
	defer get.Body.Close()
	g := decodeLabelsResp(t, get.Body)
	if g.Revision != 1 {
		t.Fatalf("GET after PUT: revision=%d, want 1", g.Revision)
	}
	if len(g.Groups) != 1 || len(g.Groups[0].OrderedRootSessionIDs) != 2 || g.Groups[0].OrderedRootSessionIDs[0] != "r2" || g.Groups[0].OrderedRootSessionIDs[1] != "r1" {
		t.Fatalf("GET after PUT: group root order = %v, want [r2 r1]", g.Groups[0].OrderedRootSessionIDs)
	}
	if got := g.TagIDsByRootSessionID["r1"]; len(got) != 1 || got[0] != "t1" {
		t.Fatalf("GET after PUT: tag assign r1 = %v, want [t1]", got)
	}
}

// --- multi-project activeRootProjects builder -------------------------------

// TestLabelsActiveRootProjectsMultiProject verifies the builder aggregates ROOT
// session ids across ALL of s.aggs (default + extra projects), maps each to its
// project's stable key, and EXCLUDES non-root (child) sessions — proving the
// IsRoot filter is the strict parentID=="" definition.
func TestLabelsActiveRootProjectsMultiProject(t *testing.T) {
	srv, _ := newLabelsTestServer(t)
	seedLabelSession(t, srv.agg, "default-root", "")
	seedLabelSession(t, srv.agg, "default-child", "default-root") // child, must be excluded

	// Second project with its own root + child.
	const deadURL = "http://127.0.0.1:1"
	proj2 := aggregator.New(deadURL, 100)
	srv.aggs["/proj2"] = proj2
	seedLabelSession(t, proj2, "proj2-root", "")
	seedLabelSession(t, proj2, "proj2-child", "proj2-root")

	got := srv.activeRootProjects()
	// Exactly the two roots; the two children are excluded.
	if len(got) != 2 {
		t.Fatalf("activeRootProjects len = %d, want 2 (roots only, children excluded): %v", len(got), got)
	}
	defaultKey := projectKey(mustProjectRoot(t, ""))
	proj2Key := projectKey(mustProjectRoot(t, "/proj2"))
	if got["default-root"] != defaultKey {
		t.Fatalf("default-root key = %q, want %q", got["default-root"], defaultKey)
	}
	if got["proj2-root"] != proj2Key {
		t.Fatalf("proj2-root key = %q, want %q", got["proj2-root"], proj2Key)
	}
	if _, ok := got["default-child"]; ok {
		t.Fatalf("default-child must NOT be in activeRootProjects (not a root): %v", got)
	}
	if _, ok := got["proj2-child"]; ok {
		t.Fatalf("proj2-child must NOT be in activeRootProjects (not a root): %v", got)
	}
	if defaultKey == proj2Key {
		t.Fatalf("default and /proj2 resolved to the same project key — test isolation broken")
	}
}

// --- retained root survives (anti-resurrection does not re-validate) --------

// TestLabelsHTTPRetainedRootSurvivesUnopenedProject is the key anti-resurrection
// guarantee, mirrored from TestPinsHTTPRetainedPinSurvivesUnopenedProject: a
// retained root whose owning project is NO LONGER OPEN (absent from s.aggs and
// thus from the active-root set) MUST survive a PUT that keeps it in a group.
// Only NEWLY-REFERENCED roots are validated against activeRootProjects; retained
// roots skip re-validation (the slice-1 store's anti-resurrection mirror), so an
// archival race never makes a valid Replace spuriously fail.
func TestLabelsHTTPRetainedRootSurvivesUnopenedProject(t *testing.T) {
	srv, web := newLabelsTestServer(t)

	// Open a second project and seed a root under it.
	const deadURL = "http://127.0.0.1:1"
	proj2 := aggregator.New(deadURL, 100)
	srv.aggs["/proj2"] = proj2
	seedLabelSession(t, proj2, "proj2-root", "")

	// Initialize the labels doc with the /proj2 root in a group.
	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"proj2-root"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("init PUT: status %d, want 200. body: %s", resp.StatusCode, b)
	}
	r := decodeLabelsResp(t, resp.Body)
	if r.Revision != 1 {
		t.Fatalf("init PUT: revision %d, want 1", r.Revision)
	}

	// Drop /proj2 from s.aggs — its root is now absent from every active set.
	delete(srv.aggs, "/proj2")

	// Seed a root under the default project for the newly-referenced id.
	seedLabelSession(t, srv.agg, "default-root", "")

	// PUT that RETAINS "proj2-root" (not re-validated despite its project being
	// gone) AND ADDS "default-root" (validated — it IS an active root). Must
	// succeed: 200.
	resp2 := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 1,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"proj2-root", "default-root"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		b, _ := io.ReadAll(resp2.Body)
		t.Fatalf("retained-root PUT: status %d, want 200. body: %s", resp2.StatusCode, b)
	}
	r2 := decodeLabelsResp(t, resp2.Body)
	if r2.Revision != 2 {
		t.Fatalf("retained-root PUT: revision %d, want 2", r2.Revision)
	}
	if len(r2.Groups[0].OrderedRootSessionIDs) != 2 || r2.Groups[0].OrderedRootSessionIDs[0] != "proj2-root" || r2.Groups[0].OrderedRootSessionIDs[1] != "default-root" {
		t.Fatalf("retained-root PUT: group roots = %v, want [proj2-root default-root]", r2.Groups[0].OrderedRootSessionIDs)
	}

	// Contrast: a PUT that adds a genuinely-unknown root ("ghost") still gets 400.
	resp3 := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 2,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"proj2-root", "default-root", "ghost"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	defer resp3.Body.Close()
	if resp3.StatusCode != http.StatusBadRequest {
		t.Fatalf("ghost-add PUT: status %d, want 400 (anti-resurrection)", resp3.StatusCode)
	}
}
