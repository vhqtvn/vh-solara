package web

// HTTP handler tests for Phase 2 of server-managed pinned sessions.
//
// Covers: GET public shape (no projectBySessionId leak); PUT happy path; PUT
// 409 on CAS mismatch (returns full current doc); PUT 400 for
// malformed/duplicate/oversized/unknown-new-ID/missing-baseRevision; CSRF
// enforcement; initializeOnly once-then-409; retained pins from an unopened
// project survive; revision increments; unknown advisory fields accepted
// (lenient decode) while MigrationID is absent from the DTO (L-11/M14).
//
// Lane: Go co-located unit (pkg/web/). These exercise the real HTTP stack via
// httptest.NewServer(srv.Handler()), matching the established pattern in
// queue_test.go / running_sessions_test.go. The csrfGuard middleware is live,
// so unsafe methods without X-VH-CSRF get 403 (same as production).

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// newPinsTestServer builds a web Server with the PinStore isolated under a
// fresh VH_STATE_DIR temp dir (so each test gets a clean pin doc and never
// touches the operator's real state). The default aggregator is live but
// backed by a dead OpenCode URL (construction never dials it). Sessions are
// seeded directly into the store via Apply (see seedPinSession).
func newPinsTestServer(t *testing.T) (*Server, *httptest.Server) {
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

// seedPinSession applies a session.created event to agg's store so id appears
// in SessionIDs() (the authoritative active-session set used by
// activeSessionProjects). Mirrors the busyEvents helper in
// running_sessions_test.go.
func seedPinSession(t *testing.T, agg *aggregator.Aggregator, id string) {
	t.Helper()
	agg.Store().Apply(opencode.Event{
		Type:       "session.created",
		Properties: json.RawMessage(`{"info":{"id":"` + id + `"}}`),
	})
}

// pinsPut issues a CSRF-bearing PUT /vh/pins and returns the raw response.
// The caller defers resp.Body.Close().
func pinsPut(t *testing.T, url string, body any) *http.Response {
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

// pinsPutRaw issues a PUT /vh/pins with the given raw body bytes and an
// optional CSRF header. Used for malformed-JSON and missing-CSRF tests.
func pinsPutRaw(t *testing.T, url string, body []byte, withCSRF bool) *http.Response {
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

// decodePinsResp decodes a pinsPublicResp from a response body.
func decodePinsResp(t *testing.T, body io.Reader) pinsPublicResp {
	t.Helper()
	var r pinsPublicResp
	if err := json.NewDecoder(body).Decode(&r); err != nil {
		t.Fatalf("decode pinsPublicResp: %v", err)
	}
	return r
}

// pinsUnknownSessionBody mirrors the structured 400 contract the server emits
// when a PUT adds IDs that are not active on this worker. The client parses
// unknownIds to self-heal (drop them and retry once).
type pinsUnknownSessionBody struct {
	Error      string   `json:"error"`
	Message    string   `json:"message"`
	UnknownIDs []string `json:"unknownIds"`
}

// decodePinsUnknownSession decodes the structured 400 body. Fatals on a body
// that is not valid JSON so a text/plain regression is caught loudly.
func decodePinsUnknownSession(t *testing.T, body io.Reader) pinsUnknownSessionBody {
	t.Helper()
	var r pinsUnknownSessionBody
	if err := json.NewDecoder(body).Decode(&r); err != nil {
		t.Fatalf("decode pinsUnknownSessionBody: %v", err)
	}
	return r
}

// --- GET /vh/pins -----------------------------------------------------------

// TestPinsHTTPGetShape verifies the GET response is the public shape: has
// revision + initialized + orderedSessionIds, and does NOT leak
// projectBySessionId. On a fresh store, initialized=false and the order is
// empty (non-nil).
func TestPinsHTTPGetShape(t *testing.T) {
	_, web := newPinsTestServer(t)

	resp, err := http.Get(web.URL + "/vh/pins")
	if err != nil {
		t.Fatalf("GET /vh/pins: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	raw, _ := io.ReadAll(resp.Body)

	// projectBySessionId must NOT appear in the wire response (internal
	// cleanup metadata, not a public field).
	if bytes.Contains(raw, []byte(`"projectBySessionId"`)) {
		t.Fatalf("GET response leaks projectBySessionId: %s", raw)
	}
	// schemaVersion must NOT appear either (it is a Phase 1 internal detail).
	if bytes.Contains(raw, []byte(`"schemaVersion"`)) {
		t.Fatalf("GET response leaks schemaVersion: %s", raw)
	}

	r := decodePinsResp(t, bytes.NewReader(raw))
	if r.Initialized {
		t.Fatalf("fresh store: Initialized = true, want false")
	}
	if r.Revision != 0 {
		t.Fatalf("fresh store: Revision = %d, want 0", r.Revision)
	}
	if r.OrderedSessionIDs == nil {
		t.Fatalf("orderedSessionIds = nil, want non-nil empty slice")
	}
	if len(r.OrderedSessionIDs) != 0 {
		t.Fatalf("fresh store: orderedSessionIds = %v, want empty", r.OrderedSessionIDs)
	}
}

// --- PUT happy path ---------------------------------------------------------

// TestPinsHTTPPutHappyPath verifies a PUT with a valid active session ID
// succeeds (200), returns the committed public doc, and bumps the revision.
// The stored projectBySessionId is populated from the active-session map but
// is NOT leaked in the response.
func TestPinsHTTPPutHappyPath(t *testing.T) {
	srv, web := newPinsTestServer(t)
	seedPinSession(t, srv.agg, "sess-a")

	resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"sess-a"},
	})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("PUT happy path: status %d, want 200. body: %s", resp.StatusCode, b)
	}
	r := decodePinsResp(t, resp.Body)
	if !r.Initialized {
		t.Fatalf("after PUT: Initialized = false, want true")
	}
	if r.Revision != 1 {
		t.Fatalf("after PUT: Revision = %d, want 1", r.Revision)
	}
	if len(r.OrderedSessionIDs) != 1 || r.OrderedSessionIDs[0] != "sess-a" {
		t.Fatalf("after PUT: order = %v, want [sess-a]", r.OrderedSessionIDs)
	}
	// projectBySessionId must not leak even after a successful write that
	// populated it internally.
	raw, _ := json.Marshal(r)
	if bytes.Contains(raw, []byte(`"projectBySessionId"`)) {
		t.Fatalf("PUT response leaks projectBySessionId: %s", raw)
	}

	// A second PUT bumps revision to 2 (add another active session).
	seedPinSession(t, srv.agg, "sess-b")
	resp2 := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      1,
		"orderedSessionIds": []string{"sess-a", "sess-b"},
	})
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		t.Fatalf("second PUT: status %d, want 200", resp2.StatusCode)
	}
	r2 := decodePinsResp(t, resp2.Body)
	if r2.Revision != 2 {
		t.Fatalf("after second PUT: Revision = %d, want 2", r2.Revision)
	}
	if len(r2.OrderedSessionIDs) != 2 {
		t.Fatalf("after second PUT: order len = %d, want 2", len(r2.OrderedSessionIDs))
	}
}

// --- CSRF enforcement -------------------------------------------------------

// TestPinsHTTPCSRFEnforced verifies PUT without X-VH-CSRF is rejected by the
// csrfGuard middleware (403), and PUT with the header reaches the handler.
func TestPinsHTTPCSRFEnforced(t *testing.T) {
	_, web := newPinsTestServer(t)

	// Without CSRF → 403 (csrfGuard blocks before the handler runs).
	body, _ := json.Marshal(map[string]any{"baseRevision": 0, "orderedSessionIds": []string{}})
	resp := pinsPutRaw(t, web.URL+"/vh/pins", body, false)
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("PUT without CSRF: status = %d, want 403", resp.StatusCode)
	}

	// With CSRF → reaches the handler (200 for an empty-list PUT on rev 0).
	resp2 := pinsPutRaw(t, web.URL+"/vh/pins", body, true)
	defer resp2.Body.Close()
	if resp2.StatusCode == http.StatusForbidden {
		t.Fatalf("PUT with CSRF: got 403 (csrfGuard blocked a valid request)")
	}
}

// --- 400: malformed / missing-field / duplicate / oversized / unknown-ID ----

// TestPinsHTTPPut400 covers the strict-input 400 cases as subtests.
func TestPinsHTTPPut400(t *testing.T) {
	t.Run("malformed_json", func(t *testing.T) {
		_, web := newPinsTestServer(t)
		resp := pinsPutRaw(t, web.URL+"/vh/pins", []byte(`{"baseRevision": 0, BROKEN`), true)
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("malformed JSON: status = %d, want 400", resp.StatusCode)
		}
	})

	t.Run("missing_baseRevision", func(t *testing.T) {
		_, web := newPinsTestServer(t)
		// baseRevision absent → *int64 is nil → 400. (Explicitly sending 0 is
		// valid and is NOT this case.)
		resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
			"orderedSessionIds": []string{},
		})
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("missing baseRevision: status = %d, want 400", resp.StatusCode)
		}
	})

	t.Run("duplicate_ids", func(t *testing.T) {
		srv, web := newPinsTestServer(t)
		seedPinSession(t, srv.agg, "dup")
		resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
			"baseRevision":      0,
			"orderedSessionIds": []string{"dup", "dup"},
		})
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("duplicate ids: status = %d, want 400", resp.StatusCode)
		}
	})

	t.Run("oversized_id", func(t *testing.T) {
		srv, web := newPinsTestServer(t)
		seedPinSession(t, srv.agg, "x")
		long := strings.Repeat("x", maxPinIDLen+1)
		resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
			"baseRevision":      0,
			"orderedSessionIds": []string{long},
		})
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("oversized id: status = %d, want 400", resp.StatusCode)
		}
	})

	t.Run("empty_id", func(t *testing.T) {
		_, web := newPinsTestServer(t)
		resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
			"baseRevision":      0,
			"orderedSessionIds": []string{""},
		})
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("empty id: status = %d, want 400", resp.StatusCode)
		}
	})

	t.Run("over_cap", func(t *testing.T) {
		srv, web := newPinsTestServer(t)
		// Seed maxPinnedSessions+1 active sessions so the cap check (not the
		// anti-resurrection check) is what fires.
		tooMany := make([]string, 0, maxPinnedSessions+1)
		for i := 0; i < maxPinnedSessions+1; i++ {
			id := "cap-" + strconv.Itoa(i)
			seedPinSession(t, srv.agg, id)
			tooMany = append(tooMany, id)
		}
		resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
			"baseRevision":      0,
			"orderedSessionIds": tooMany,
		})
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("over-cap (%d ids): status = %d, want 400", maxPinnedSessions+1, resp.StatusCode)
		}
	})

	t.Run("unknown_new_id", func(t *testing.T) {
		_, web := newPinsTestServer(t)
		// "ghost" is NOT seeded into any aggregator's store → not in the
		// active-session set → anti-resurrection rejects it.
		resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
			"baseRevision":      0,
			"orderedSessionIds": []string{"ghost"},
		})
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("unknown new id: status = %d, want 400", resp.StatusCode)
		}
	})

	// unknown_new_id_structured: the 400 is machine-readable. Content-Type is
	// application/json and the body decodes to the confirmed contract:
	// {error:"unknown_session", message:"...", unknownIds:[<that id>]}.
	t.Run("unknown_new_id_structured", func(t *testing.T) {
		_, web := newPinsTestServer(t)
		resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
			"baseRevision":      0,
			"orderedSessionIds": []string{"ghost"},
		})
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("unknown new id: status = %d, want 400", resp.StatusCode)
		}
		if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
			t.Fatalf("Content-Type = %q, want application/json (machine-readable 400)", ct)
		}
		e := decodePinsUnknownSession(t, resp.Body)
		if e.Error != "unknown_session" {
			t.Fatalf("error = %q, want unknown_session", e.Error)
		}
		if len(e.UnknownIDs) != 1 || e.UnknownIDs[0] != "ghost" {
			t.Fatalf("unknownIds = %v, want [ghost]", e.UnknownIDs)
		}
		if !strings.Contains(e.Message, "ghost") {
			t.Fatalf("message = %q, want it to contain the offending id", e.Message)
		}
	})

	// unknown_multiple_ids_collect_all: the server collects ALL non-active
	// newly-added ids before rejecting (not just the first), so the client's
	// single bounded retry can drop them all. Order matches the request order.
	t.Run("unknown_multiple_ids_collect_all", func(t *testing.T) {
		_, web := newPinsTestServer(t)
		resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
			"baseRevision":      0,
			"orderedSessionIds": []string{"ghost1", "ghost2"},
		})
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400", resp.StatusCode)
		}
		if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
			t.Fatalf("Content-Type = %q, want application/json (machine-readable 400)", ct)
		}
		e := decodePinsUnknownSession(t, resp.Body)
		if e.Error != "unknown_session" {
			t.Fatalf("error = %q, want unknown_session", e.Error)
		}
		if len(e.UnknownIDs) != 2 {
			t.Fatalf("unknownIds len = %d, want 2 (collect-all, not first-only)", len(e.UnknownIDs))
		}
		if e.UnknownIDs[0] != "ghost1" || e.UnknownIDs[1] != "ghost2" {
			t.Fatalf("unknownIds = %v, want [ghost1 ghost2] (request order)", e.UnknownIDs)
		}
	})
}

// --- retained-skip regression in the collect-all world ----------------------

// TestPinsHTTPPut400RetainedNotCollected is the key anti-resurrection guarantee
// under the structured collect-all 400: a retained pin whose owning project is
// NO LONGER OPEN (absent from s.aggs and thus from the active-session set) is
// NOT reported in unknownIds. Only NEWLY-ADDED ids are validated; retained ids
// skip validation (the guard semantics are unchanged by the collect-all change).
//
// Setup: pin a session from /proj2, then drop /proj2 from s.aggs (its session
// is now absent from every active set). A subsequent PUT that RETAINS that pin
// AND ADDS an unknown "ghost" must 400 with unknownIds=[ghost] only — the
// retained /proj2 session must NOT appear.
func TestPinsHTTPPut400RetainedNotCollected(t *testing.T) {
	srv, web := newPinsTestServer(t)

	// Open a second project and seed a session under it.
	const deadURL = "http://127.0.0.1:1"
	proj2 := aggregator.New(deadURL, 100)
	srv.aggs["/proj2"] = proj2
	seedPinSession(t, proj2, "proj2-sess")

	// Initialize the pin doc with the /proj2 session.
	resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"proj2-sess"},
	})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("init PUT: status %d, want 200. body: %s", resp.StatusCode, b)
	}

	// Drop /proj2 from s.aggs — its session is now absent from every active set.
	delete(srv.aggs, "/proj2")

	// PUT that RETAINS "proj2-sess" (must skip validation — already in the doc)
	// AND ADDS "ghost" (new + not active → collected). The 400 must report ONLY
	// "ghost"; "proj2-sess" must NOT appear in unknownIds.
	resp2 := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      1,
		"orderedSessionIds": []string{"proj2-sess", "ghost"},
	})
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusBadRequest {
		t.Fatalf("PUT: status %d, want 400 (ghost is unknown)", resp2.StatusCode)
	}
	e := decodePinsUnknownSession(t, resp2.Body)
	if e.Error != "unknown_session" {
		t.Fatalf("error = %q, want unknown_session", e.Error)
	}
	if len(e.UnknownIDs) != 1 || e.UnknownIDs[0] != "ghost" {
		t.Fatalf("unknownIds = %v, want [ghost] only (retained proj2-sess must NOT be collected)", e.UnknownIDs)
	}
}

// --- 409: CAS / init mismatch -----------------------------------------------

// TestPinsHTTPPut409CASMismatch verifies a PUT with a stale baseRevision
// returns 409 with the full current public doc in the body (so the client can
// adopt server state), and does NOT mutate the doc.
func TestPinsHTTPPut409CASMismatch(t *testing.T) {
	srv, web := newPinsTestServer(t)
	seedPinSession(t, srv.agg, "a")

	// Establish the doc at revision 1.
	resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"a"},
	})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("setup PUT: status %d, want 200", resp.StatusCode)
	}

	// Stale PUT (baseRevision=0, but current is 1) → 409 with the current doc.
	seedPinSession(t, srv.agg, "b")
	stale := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0, // stale — server is at 1
		"orderedSessionIds": []string{"a", "b"},
	})
	defer stale.Body.Close()
	if stale.StatusCode != http.StatusConflict {
		t.Fatalf("stale PUT: status = %d, want 409", stale.StatusCode)
	}
	cur := decodePinsResp(t, stale.Body)
	if cur.Revision != 1 {
		t.Fatalf("409 body Revision = %d, want 1 (current server state)", cur.Revision)
	}
	if len(cur.OrderedSessionIDs) != 1 || cur.OrderedSessionIDs[0] != "a" {
		t.Fatalf("409 body order = %v, want [a] (current server state)", cur.OrderedSessionIDs)
	}

	// Confirm the doc was NOT mutated by the stale PUT (still revision 1).
	get, err := http.Get(web.URL + "/vh/pins")
	if err != nil {
		t.Fatal(err)
	}
	defer get.Body.Close()
	g := decodePinsResp(t, get.Body)
	if g.Revision != 1 || len(g.OrderedSessionIDs) != 1 {
		t.Fatalf("doc mutated by stale PUT: revision=%d order=%v", g.Revision, g.OrderedSessionIDs)
	}
}

// --- initializeOnly: once, then 409 -----------------------------------------

// TestPinsHTTPInitializeOnlyOnceThen409 verifies initializeOnly succeeds on an
// uninitialized doc and then a second initializeOnly returns 409 (the
// init-guard form of a CAS mismatch), without mutating.
func TestPinsHTTPInitializeOnlyOnceThen409(t *testing.T) {
	srv, web := newPinsTestServer(t)
	seedPinSession(t, srv.agg, "init-sess")

	// First init → 200.
	resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"init-sess"},
		"initializeOnly":    true,
	})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("first init: status %d, want 200", resp.StatusCode)
	}
	r := decodePinsResp(t, resp.Body)
	if !r.Initialized || r.Revision != 1 {
		t.Fatalf("first init: Initialized=%v Revision=%d, want true/1", r.Initialized, r.Revision)
	}

	// Second init → 409 (already initialized). baseRevision=0 is correct for
	// the original doc but the init guard fails regardless.
	seedPinSession(t, srv.agg, "init-sess-2")
	resp2 := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"init-sess", "init-sess-2"},
		"initializeOnly":    true,
	})
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusConflict {
		t.Fatalf("second init: status %d, want 409", resp2.StatusCode)
	}
	r2 := decodePinsResp(t, resp2.Body)
	if r2.Revision != 1 || len(r2.OrderedSessionIDs) != 1 {
		t.Fatalf("second init mutated doc: revision=%d order=%v", r2.Revision, r2.OrderedSessionIDs)
	}
}

// --- retained pins survive (anti-resurrection does not re-validate) ---------

// TestPinsHTTPRetainedPinSurvivesUnopenedProject is the key anti-resurrection
// guarantee: a retained pin whose owning project is NO LONGER OPEN (absent
// from s.aggs and thus from the active-session set) MUST survive a PUT that
// keeps it in the list. Only NEWLY-ADDED IDs are validated.
//
// Setup: pin a session from /proj2, then drop /proj2 from s.aggs (simulating
// the project being closed). A subsequent PUT that retains that pin AND adds a
// new active-session ID from the default project must succeed — the retained
// pin is not re-validated despite being absent from every active set.
func TestPinsHTTPRetainedPinSurvivesUnopenedProject(t *testing.T) {
	srv, web := newPinsTestServer(t)

	// Open a second project and seed a session under it.
	const deadURL = "http://127.0.0.1:1"
	proj2 := aggregator.New(deadURL, 100)
	srv.aggs["/proj2"] = proj2
	seedPinSession(t, proj2, "proj2-sess")

	// Initialize the pin doc with the /proj2 session.
	resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"proj2-sess"},
	})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("init PUT: status %d, want 200. body: %s", resp.StatusCode, b)
	}
	r := decodePinsResp(t, resp.Body)
	if r.Revision != 1 {
		t.Fatalf("init PUT: revision %d, want 1", r.Revision)
	}

	// Drop /proj2 from s.aggs — its session is now absent from every active set.
	// (Simulates the project being closed/never-reopened this session.)
	delete(srv.aggs, "/proj2")

	// Seed a session under the default project for the newly-added ID.
	seedPinSession(t, srv.agg, "default-sess")

	// PUT that RETAINS "proj2-sess" (not re-validated despite its project
	// being gone) AND ADDS "default-sess" (validated — it IS active). Must
	// succeed: 200.
	resp2 := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      1,
		"orderedSessionIds": []string{"proj2-sess", "default-sess"},
	})
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		b, _ := io.ReadAll(resp2.Body)
		t.Fatalf("retained-pin PUT: status %d, want 200. body: %s", resp2.StatusCode, b)
	}
	r2 := decodePinsResp(t, resp2.Body)
	if r2.Revision != 2 {
		t.Fatalf("retained-pin PUT: revision %d, want 2", r2.Revision)
	}
	if len(r2.OrderedSessionIDs) != 2 || r2.OrderedSessionIDs[0] != "proj2-sess" || r2.OrderedSessionIDs[1] != "default-sess" {
		t.Fatalf("retained-pin PUT: order = %v, want [proj2-sess default-sess]", r2.OrderedSessionIDs)
	}

	// Contrast: a PUT that tries to RE-ADD "proj2-sess" as if it were new is
	// a no-op (it is retained), but a PUT that adds a genuinely-unknown ID
	// ("ghost") still gets 400.
	resp3 := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      2,
		"orderedSessionIds": []string{"proj2-sess", "default-sess", "ghost"},
	})
	defer resp3.Body.Close()
	if resp3.StatusCode != http.StatusBadRequest {
		t.Fatalf("ghost-add PUT: status %d, want 400 (anti-resurrection)", resp3.StatusCode)
	}
}

// --- revision monotonicity on accepted writes -------------------------------

// TestPinsHTTPRevisionIncrements verifies the revision advances by exactly 1
// per accepted PUT (never on a rejected one).
func TestPinsHTTPRevisionIncrements(t *testing.T) {
	srv, web := newPinsTestServer(t)
	seedPinSession(t, srv.agg, "s1")
	seedPinSession(t, srv.agg, "s2")
	seedPinSession(t, srv.agg, "s3")

	want := int64(0)
	for _, order := range [][]string{
		{"s1"},
		{"s1", "s2"},
		{"s3", "s2", "s1"}, // reorder + extend
		{"s2"},             // shrink
	} {
		resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
			"baseRevision":      want,
			"orderedSessionIds": order,
		})
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			b, _ := io.ReadAll(resp.Body)
			t.Fatalf("PUT order %v at rev %d: status %d, want 200. body: %s", order, want, resp.StatusCode, b)
		}
		want++
		r := decodePinsResp(t, resp.Body)
		if r.Revision != want {
			t.Fatalf("after PUT %v: revision = %d, want %d", order, r.Revision, want)
		}
	}
}

// --- DTO surface + lenient decode (L-11 / M14) -----------------------------

// TestNoMigrationIDInDTO is the standing check for audit L-11 / remediation
// M14: the obsolete advisory MigrationID field must NOT be a named operative
// member of the PUT /vh/pins request DTO. The compiled DTO must not advertise
// it as operative behavior; forward compatibility is preserved by lenient
// handling of genuinely unknown advisory fields (the paired
// TestPinsPUTAcceptsUnknownAdvisoryField), NOT by retaining obsolete named
// fields. Fails if MigrationID returns to the typed DTO.
func TestNoMigrationIDInDTO(t *testing.T) {
	typ := reflect.TypeOf(putPinsReq{})
	if f, ok := typ.FieldByName("MigrationID"); ok {
		t.Fatalf("putPinsReq must not declare MigrationID (obsolete advisory field, L-11/M14); found field %q at index %v", f.Name, f.Index)
	}
}

// TestPinsPUTAcceptsUnknownAdvisoryField is the paired acceptance side of the
// L-11 / M14 contract: the PUT /vh/pins decoder is lenient on genuinely
// UNKNOWN advisory request fields, so a future client sending a new optional
// field does not get a 400. `migrationId` is now exactly such an unknown field
// (the obsolete MigrationID DTO member was removed), so this request pins that
// its presence does not break a well-formed PUT — preserving the desired
// forward-compatible behavior without retaining the obsolete named field.
func TestPinsPUTAcceptsUnknownAdvisoryField(t *testing.T) {
	srv, web := newPinsTestServer(t)
	seedPinSession(t, srv.agg, "m1")

	resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"m1"},
		"migrationId":       "client-migration-abc-123",
	})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("PUT with unknown advisory field migrationId: status %d, want 200. body: %s", resp.StatusCode, b)
	}
	r := decodePinsResp(t, resp.Body)
	if r.Revision != 1 || len(r.OrderedSessionIDs) != 1 {
		t.Fatalf("PUT with unknown advisory field: revision=%d order=%v", r.Revision, r.OrderedSessionIDs)
	}
}

// --- GET after PUT round-trips the committed state --------------------------

// TestPinsHTTPGetReflectsPut verifies a GET after a PUT returns the committed
// state (not a stale view) — the response is always derived from Snapshot().
func TestPinsHTTPGetReflectsPut(t *testing.T) {
	srv, web := newPinsTestServer(t)
	seedPinSession(t, srv.agg, "r1")
	seedPinSession(t, srv.agg, "r2")

	resp := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"r2", "r1"}, // deliberate order
	})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("PUT: status %d", resp.StatusCode)
	}

	get, err := http.Get(web.URL + "/vh/pins")
	if err != nil {
		t.Fatal(err)
	}
	defer get.Body.Close()
	g := decodePinsResp(t, get.Body)
	if g.Revision != 1 || !g.Initialized {
		t.Fatalf("GET after PUT: revision=%d initialized=%v, want 1/true", g.Revision, g.Initialized)
	}
	if len(g.OrderedSessionIDs) != 2 || g.OrderedSessionIDs[0] != "r2" || g.OrderedSessionIDs[1] != "r1" {
		t.Fatalf("GET after PUT: order = %v, want [r2 r1]", g.OrderedSessionIDs)
	}
}

// --- multi-project activeSessionProjects builder ----------------------------

// TestPinsActiveSessionProjectsMultiProject verifies the builder aggregates
// session IDs across ALL of s.aggs (default + extra projects) and maps each to
// the SAME stable project key that notes.go would compute for that project's
// resolved root.
func TestPinsActiveSessionProjectsMultiProject(t *testing.T) {
	srv, _ := newPinsTestServer(t)
	seedPinSession(t, srv.agg, "default-a")
	seedPinSession(t, srv.agg, "default-b")

	// Second project.
	const deadURL = "http://127.0.0.1:1"
	proj2 := aggregator.New(deadURL, 100)
	srv.aggs["/proj2"] = proj2
	seedPinSession(t, proj2, "proj2-x")

	got := srv.activeSessionProjects()
	if len(got) != 3 {
		t.Fatalf("activeSessionProjects len = %d, want 3: %v", len(got), got)
	}

	// Each ID maps to its project's stable key (projectKey(projectRoot(dir))).
	defaultKey := projectKey(mustProjectRoot(t, ""))
	proj2Key := projectKey(mustProjectRoot(t, "/proj2"))
	if got["default-a"] != defaultKey || got["default-b"] != defaultKey {
		t.Fatalf("default project keys mismatch: got[default-a]=%q want %q, got[default-b]=%q want %q",
			got["default-a"], defaultKey, got["default-b"], defaultKey)
	}
	if got["proj2-x"] != proj2Key {
		t.Fatalf("proj2 key mismatch: got[proj2-x]=%q want %q", got["proj2-x"], proj2Key)
	}
	if defaultKey == proj2Key {
		t.Fatalf("default and /proj2 resolved to the same project key — test isolation broken")
	}
}

// mustProjectRoot is a test helper that fatals on projectRoot failure.
func mustProjectRoot(t *testing.T, dir string) string {
	t.Helper()
	root, err := projectRoot(dir)
	if err != nil {
		t.Fatalf("projectRoot(%q): %v", dir, err)
	}
	return root
}
