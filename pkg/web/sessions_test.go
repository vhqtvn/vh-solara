package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// newSessionsTestServer wires a Server whose aggregator points at a fake
// opencode (reusing newFake from integration_test.go) and PRE-REGISTERS a
// SEPARATE bare-test aggregator under "/proj" in srv.aggs. Pre-registering
// means aggFor("/proj") returns it without lazy-creating a new aggregator or
// starting its background Run loop — the verbs under test only use agg.Client()
// directly (never the store), so this keeps the tests hermetic and leak-free
// while still exercising the real opencode client against the fake.
//
// The /proj aggregator is a DISTINCT, UNARMED instance from the default
// (s.agg): NewServer arms the default synchronously (the production arming
// site), so reusing it for /proj would arm /proj too, and ShouldServeSession
// would gate on HasSession — silent-dropping every unseeded id and breaking
// the closeout content-shape tests below (which rely on the bare-test contract:
// ShouldServeSession returns true for any id so the handler fetches content
// for shape verification). A separate unarmed aggregator preserves that
// contract under /proj.
func newSessionsTestServer(t *testing.T, fake *fakeOpenCode) (*httptest.Server, *fakeOpenCode) {
	t.Helper()
	ocSrv := httptest.NewServer(fake.handler())
	t.Cleanup(ocSrv.Close)
	agg := aggregator.New(ocSrv.URL, 1000)
	srv, err := NewServer(agg, ocSrv.URL, 1000)
	if err != nil {
		t.Fatal(err)
	}
	// Distinct unarmed aggregator so /proj keeps the bare-test contract even
	// though NewServer armed the default (s.agg).
	projAgg := aggregator.New(ocSrv.URL, 1000)
	srv.aggs["/proj"] = projAgg // pre-register → aggFor("/proj") returns it, no Run loop
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)
	return web, fake
}

// getSessions decodes a GET /vh/sessions response.
func getSessions(t *testing.T, url string) (int, sessionInventoryResp) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out sessionInventoryResp
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

// --- GET /vh/sessions ---

func TestSessionsDirRequired(t *testing.T) {
	web, _ := newSessionsTestServer(t, newFake())
	// No ?dir and no header → 400.
	resp, err := http.Get(web.URL + "/vh/sessions")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing dir want 400, got %d", resp.StatusCode)
	}
	// Header alone satisfies dir.
	req, _ := http.NewRequest(http.MethodGet, web.URL+"/vh/sessions", nil)
	req.Header.Set("x-opencode-directory", "/proj")
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("dir via header want 200, got %d", resp2.StatusCode)
	}
}

func TestSessionsEmptyFleet(t *testing.T) {
	// No sessions seeded → 200 with sessions:[] (empty/absent is never an error).
	web, _ := newSessionsTestServer(t, newFake())
	st, out := getSessions(t, web.URL+"/vh/sessions?dir=/proj")
	if st != 200 {
		t.Fatalf("want 200, got %d", st)
	}
	if out.Dir != "/proj" {
		t.Fatalf("dir echoed want /proj, got %q", out.Dir)
	}
	if out.Sessions == nil || len(out.Sessions) != 0 {
		t.Fatalf("want non-nil empty sessions, got %v", out.Sessions)
	}
}

func TestSessionsFiltersAndOrder(t *testing.T) {
	fake := newFake()
	fake.sessions = []string{
		// root, active, updated=30
		`{"id":"r1","title":"Root1","time":{"created":10,"updated":30}}`,
		// child of r1, active, updated=50 (newest)
		`{"id":"c1","parentID":"r1","title":"Child1","time":{"created":40,"updated":50}}`,
		// root, archived, updated=20
		`{"id":"r2","title":"Root2","time":{"created":5,"updated":20,"archived":15}}`,
		// root, active, updated=5 (oldest)
		`{"id":"r3","title":"Root3","time":{"created":1,"updated":5}}`,
	}
	web, _ := newSessionsTestServer(t, fake)

	// Default: roots_only=1, include_archived=0 → r1, r3 (roots, active).
	_, out := getSessions(t, web.URL+"/vh/sessions?dir=/proj")
	ids := sessionIDs(out.Sessions)
	if len(ids) != 2 || ids[0] != "r1" || ids[1] != "r3" {
		t.Fatalf("default (roots, active) want [r1 r3] ordered by updated desc, got %v", ids)
	}
	// Verify shape of one active root item.
	r1 := out.Sessions[0]
	if r1.ID != "r1" || r1.Title != "Root1" || r1.Dir != "/proj" || !r1.Active {
		t.Fatalf("r1 shape wrong: %+v", r1)
	}
	if r1.Alias != "" {
		t.Fatalf("alias want empty (no slug field), got %q", r1.Alias)
	}
	if r1.ParentID != nil {
		t.Fatalf("root parentID want null, got %v", r1.ParentID)
	}
	if r1.Time.Updated == nil || *r1.Time.Updated != 30 || r1.Time.Created == nil || *r1.Time.Created != 10 {
		t.Fatalf("r1 time wrong: %+v", r1.Time)
	}
	if r1.Time.Archived != nil {
		t.Fatalf("active session archived want null, got %v", r1.Time.Archived)
	}

	// roots_only=0 → include children: r1, c1, r3 (3 active sessions).
	_, out = getSessions(t, web.URL+"/vh/sessions?dir=/proj&roots_only=0")
	ids = sessionIDs(out.Sessions)
	if len(ids) != 3 || ids[0] != "c1" || ids[1] != "r1" || ids[2] != "r3" {
		t.Fatalf("roots_only=0 want [c1 r1 r3] by updated desc, got %v", ids)
	}
	// Child parentID is a string pointer.
	c1 := out.Sessions[0]
	if c1.ParentID == nil || *c1.ParentID != "r1" {
		t.Fatalf("child parentID want r1, got %v", c1.ParentID)
	}

	// include_archived=1 (+ roots_only=0) → all 4, with r2 active=false & archived set.
	_, out = getSessions(t, web.URL+"/vh/sessions?dir=/proj&include_archived=1&roots_only=0")
	ids = sessionIDs(out.Sessions)
	if len(ids) != 4 {
		t.Fatalf("include_archived=1 want 4 sessions, got %v", ids)
	}
	var r2 sessionInventoryItem
	for _, it := range out.Sessions {
		if it.ID == "r2" {
			r2 = it
		}
	}
	if r2.Active || r2.Time.Archived == nil || *r2.Time.Archived != 15 {
		t.Fatalf("archived r2 want active=false archived=15, got %+v", r2)
	}

	// since=25 → drop sessions whose latest time < 25 (r3@5, r2@20). Remaining
	// active roots with latest>=25: r1 (updated 30). (roots_only default 1.)
	_, out = getSessions(t, web.URL+"/vh/sessions?dir=/proj&include_archived=1&since=25")
	ids = sessionIDs(out.Sessions)
	if len(ids) != 1 || ids[0] != "r1" {
		t.Fatalf("since=25 want [r1], got %v", ids)
	}
}

func sessionIDs(items []sessionInventoryItem) []string {
	out := make([]string, len(items))
	for i, it := range items {
		out[i] = it.ID
	}
	return out
}

// --- GET /vh/sessions/closeout ---

func getCloseout(t *testing.T, url string) (int, sessionsCloseoutResp) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out sessionsCloseoutResp
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return resp.StatusCode, out
}

func TestCloseoutDirRequired(t *testing.T) {
	web, _ := newSessionsTestServer(t, newFake())
	resp, err := http.Get(web.URL + "/vh/sessions/closeout?id=a")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("missing dir want 400, got %d", resp.StatusCode)
	}
}

func TestCloseoutShapes(t *testing.T) {
	fake := newFake()
	fake.messages["s_with_text"] = `[{"info":{"id":"m1","sessionID":"s_with_text","role":"assistant","time":{"created":10}},"parts":[{"type":"text","text":"hello "},{"type":"reasoning","text":"(skip)"},{"type":"text","text":"world"}]}]`
	fake.messages["s_empty"] = `[{"info":{"id":"m1","sessionID":"s_empty","role":"assistant","time":{"created":5}},"parts":[{"type":"tool","name":"bash"}]}]`
	fake.messages["s_user_only"] = `[{"info":{"id":"m1","sessionID":"s_user_only","role":"user"},"parts":[{"type":"text","text":"hi"}]}]`
	fake.messages["s_multi"] = `[` +
		`{"info":{"id":"old","sessionID":"s_multi","role":"assistant","time":{"created":1}},"parts":[{"type":"text","text":"OLD"}]},` +
		`{"info":{"id":"new","sessionID":"s_multi","role":"assistant","time":{"created":20}},"parts":[{"type":"text","text":"NEW"}]}` +
		`]`
	web, _ := newSessionsTestServer(t, fake)

	// Mixed repeatable + comma-list: ?id=s_with_text,s_empty&id=s_multi&id=s_multi (dedup).
	st, out := getCloseout(t, web.URL+"/vh/sessions/closeout?dir=/proj&id=s_with_text,s_empty&id=s_multi&id=s_multi&id=s_user_only&id=s_unknown")
	if st != 200 {
		t.Fatalf("want 200, got %d", st)
	}
	if out.Dir != "/proj" {
		t.Fatalf("dir echoed want /proj, got %q", out.Dir)
	}
	wantKeys := []string{"s_with_text", "s_empty", "s_multi", "s_user_only", "s_unknown"}
	if len(out.Closeouts) != len(wantKeys) {
		t.Fatalf("want %d keys (deduped, every id present), got %d: %v", len(wantKeys), len(out.Closeouts), out.Closeouts)
	}
	for _, k := range wantKeys {
		if _, ok := out.Closeouts[k]; !ok {
			t.Fatalf("missing key %q (every requested id must appear)", k)
		}
	}
	// s_with_text → present:true, "hello world" (parts concatenated, non-text skipped).
	c := out.Closeouts["s_with_text"]
	if !c.Present || c.Text == nil || *c.Text != "hello world" {
		t.Fatalf("s_with_text want present true text %q, got %+v", "hello world", c)
	}
	// s_empty → present:true, "" (assistant exists, no text parts).
	c = out.Closeouts["s_empty"]
	if !c.Present || c.Text == nil || *c.Text != "" {
		t.Fatalf("s_empty want present true text empty-string, got %+v", c)
	}
	// s_multi → present:true, "NEW" (latest assistant by time.created).
	c = out.Closeouts["s_multi"]
	if !c.Present || c.Text == nil || *c.Text != "NEW" {
		t.Fatalf("s_multi want present true text %q (latest assistant), got %+v", "NEW", c)
	}
	// s_user_only → present:false (no assistant), text null.
	c = out.Closeouts["s_user_only"]
	if c.Present || c.Text != nil {
		t.Fatalf("s_user_only want present:false text:null, got %+v", c)
	}
	// s_unknown → present:false, text null.
	c = out.Closeouts["s_unknown"]
	if c.Present || c.Text != nil {
		t.Fatalf("s_unknown want present:false text:null, got %+v", c)
	}
}

// TestCloseoutHR1NoTruncation verifies the full last assistant text survives
// intact (HR1: never truncate). A large payload must come back byte-identical.
func TestCloseoutHR1NoTruncation(t *testing.T) {
	fake := newFake()
	// 64KB of distinct marker text — well beyond any plausible inline limit.
	const marker = "HR1-NO-TRUNCATE-"
	chunk := strings.Repeat(marker, 4000) // ~72KB
	fake.messages["big"] = `[{"info":{"id":"m1","sessionID":"big","role":"assistant","time":{"created":1}},"parts":[{"type":"text","text":"` + chunk + `"}]}]`
	web, _ := newSessionsTestServer(t, fake)

	st, out := getCloseout(t, web.URL+"/vh/sessions/closeout?dir=/proj&id=big")
	if st != 200 {
		t.Fatalf("want 200, got %d", st)
	}
	c := out.Closeouts["big"]
	if !c.Present || c.Text == nil {
		t.Fatalf("big want present:true, got %+v", c)
	}
	if *c.Text != chunk {
		t.Fatalf("HR1: text truncated/changed — want len %d, got len %d", len(chunk), len(*c.Text))
	}
	if !strings.HasPrefix(*c.Text, marker) || !strings.HasSuffix(*c.Text, marker) {
		t.Fatalf("HR1: text start/end corrupted")
	}
}

// TestCloseoutEmptyIDs verifies an empty/absent id list is not an error.
func TestCloseoutEmptyIDs(t *testing.T) {
	web, _ := newSessionsTestServer(t, newFake())
	st, out := getCloseout(t, web.URL+"/vh/sessions/closeout?dir=/proj")
	if st != 200 {
		t.Fatalf("want 200, got %d", st)
	}
	if len(out.Closeouts) != 0 {
		t.Fatalf("want empty closeouts map, got %v", out.Closeouts)
	}
}
