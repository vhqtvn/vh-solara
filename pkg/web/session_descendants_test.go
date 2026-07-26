package web

// HTTP handler tests for GET /vh/session/{sessionId}/descendants (P4): the
// server-authoritative archive-impact descendant list.
//
// These pin the wire contract (Q3 revisioned envelope {epoch, revision, data}),
// the descendant-walk semantics (root-first, transitive, excludes unrelated
// sessions), and the unknown-id → empty-list behavior.
//
// The harness mirrors messages_http_test.go / integration_test.go: a
// fakeOpenCode upstream seeds sessions, an Aggregator reconciles them into the
// store, and the test waits for the subtree to hydrate before issuing the GET.
// The handler is a pure point-in-time read — it touches only the Store, makes
// no upstream call, and emits no SSE events.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// setupDescendantsTest wires fakeOpenCode + aggregator + web server with the
// seeded session subtree and returns the web server base URL. The aggregator is
// started; the test waits for the full subtree to hydrate before returning.
func setupDescendantsTest(t *testing.T) (webURL string, aggStoreSeq func() uint64) {
	t.Helper()
	fake := newFake()
	// Subtree: root → child → grand, plus an unrelated root "other".
	fake.sessions = []string{
		`{"id":"root","title":"Root","parentID":""}`,
		`{"id":"child","title":"Child","parentID":"root"}`,
		`{"id":"grand","title":"Grand","parentID":"child"}`,
		`{"id":"other","title":"Other","parentID":""}`,
	}
	ocSrv := httptest.NewServer(fake.handler())
	t.Cleanup(ocSrv.Close)
	agg := aggregator.New(ocSrv.URL, 1000)
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	go agg.Run(ctx)
	srv, err := NewServer(agg, ocSrv.URL, 1000)
	if err != nil {
		t.Fatal(err)
	}
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)
	waitFor(t, func() bool { return len(agg.Store().SessionIDs()) >= 4 }, "subtree hydrated into tree")
	return web.URL, func() uint64 { return agg.Store().Head() }
}

// getDescendants issues GET /vh/session/<sid>/descendants and returns the HTTP
// status, the raw X-VH-Epoch / X-VH-Seq headers, and the decoded envelope.
func getDescendants(t *testing.T, webURL, sid string) (status int, epochHdr, seqHdr string, env struct {
	Epoch    string `json:"epoch"`
	Revision uint64 `json:"revision"`
	Data     struct {
		SessionID   string `json:"sessionId"`
		Descendants []struct {
			ID       string `json:"id"`
			Title    string `json:"title"`
			ParentID string `json:"parentID"`
		} `json:"descendants"`
		Fingerprint string `json:"fingerprint"`
	} `json:"data"`
}) {
	t.Helper()
	res, err := http.Get(webURL + "/vh/session/" + sid + "/descendants")
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	status = res.StatusCode
	epochHdr = res.Header.Get("X-VH-Epoch")
	seqHdr = res.Header.Get("X-VH-Seq")
	body, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET descendants %s: status %d, body %s", sid, res.StatusCode, body)
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("decode descendants envelope: %v, body %s", err, body)
	}
	return status, epochHdr, seqHdr, env
}

// TestDescendantsSubtree pins the descendant walk over a real subtree: the root
// is first, the set is exactly {root, child, grand}, the unrelated session is
// excluded, titles round-trip, and the Q3 envelope is coherent (epoch non-empty,
// revision matches the Store head captured at query time).
func TestDescendantsSubtree(t *testing.T) {
	webURL, head := setupDescendantsTest(t)

	before := head() // capture seq before the GET so the body revision is bounded
	_, _, _, env := getDescendants(t, webURL, "root")

	if got := len(env.Data.Descendants); got != 3 {
		t.Fatalf("want 3 descendants (root,child,grand), got %d: %+v", got, env.Data.Descendants)
	}
	// Root is always first (descendantsLocked pushes id first).
	if env.Data.Descendants[0].ID != "root" {
		t.Errorf("descendants[0].ID = %q, want root (affected root is first)", env.Data.Descendants[0].ID)
	}
	// Exact set {root, child, grand}; "other" excluded.
	got := map[string]bool{}
	for _, d := range env.Data.Descendants {
		got[d.ID] = true
	}
	want := map[string]bool{"root": true, "child": true, "grand": true}
	for id := range want {
		if !got[id] {
			t.Errorf("descendants missing %q: %+v", id, env.Data.Descendants)
		}
	}
	if got["other"] {
		t.Errorf("descendants wrongly includes unrelated session other: %+v", env.Data.Descendants)
	}
	// Titles round-trip from the session info blob.
	titles := map[string]string{}
	for _, d := range env.Data.Descendants {
		titles[d.ID] = d.Title
	}
	if titles["root"] != "Root" || titles["child"] != "Child" || titles["grand"] != "Grand" {
		t.Errorf("titles mismatch: %+v", titles)
	}
	// ParentID is denormalized from the session envelope.
	parents := map[string]string{}
	for _, d := range env.Data.Descendants {
		parents[d.ID] = d.ParentID
	}
	if parents["root"] != "" || parents["child"] != "root" || parents["grand"] != "child" {
		t.Errorf("parentID mismatch: %+v", parents)
	}
	// sessionId echoes the request id.
	if env.Data.SessionID != "root" {
		t.Errorf("data.sessionId = %q, want root", env.Data.SessionID)
	}
	// C5: data.fingerprint is the additive subtree-id-set fingerprint the FE
	// echoes back on POST /vh/archive. It is always present and must equal
	// state.FingerprintIDs of the returned descendant id-set (preview↔commit
	// use the identical pure function).
	if env.Data.Fingerprint == "" {
		t.Errorf("data.fingerprint missing; C5 requires it on every descendants response")
	}
	ids := []string{"root", "child", "grand"}
	if want := state.FingerprintIDs(ids); env.Data.Fingerprint != want {
		t.Errorf("data.fingerprint %q != state.FingerprintIDs(%v) %q", env.Data.Fingerprint, ids, want)
	}
	// Q3 envelope: epoch non-empty, revision coherent with the Store head.
	if env.Epoch == "" {
		t.Errorf("envelope.epoch is empty; want non-empty lifetime id")
	}
	// revision is captured atomically with the walk under the Store RLock, so it
	// must be >= the seq observed just before the GET and <= the head observed
	// just after. A regression that drops the atomic capture (e.g. reading Head
	// before the walk) would still pass the lower bound; the upper bound guards
	// against a future bug that stamps a post-walk seq from a different lock.
	after := head()
	if env.Revision < before || env.Revision > after {
		t.Errorf("envelope.revision %d outside [%d,%d] (store head before/after GET)", env.Revision, before, after)
	}
}

// TestDescendantsUnknownID pins the unknown-id contract: 200 with an empty (NOT
// null) descendants list. A not-yet-hydrated or just-pruned id is a normal
// transient; the archive mutation handler tolerates an empty affected set.
func TestDescendantsUnknownID(t *testing.T) {
	webURL, _ := setupDescendantsTest(t)

	_, _, _, env := getDescendants(t, webURL, "does-not-exist")

	if env.Data.SessionID != "does-not-exist" {
		t.Errorf("data.sessionId = %q, want echoed request id", env.Data.SessionID)
	}
	if env.Data.Descendants == nil {
		t.Errorf("descendants = nil; want empty slice (wire contract: [] not null)")
	}
	if len(env.Data.Descendants) != 0 {
		t.Errorf("descendants = %+v; want empty for unknown id", env.Data.Descendants)
	}
	// Envelope epoch is still present (Store is live even for an unknown id).
	if env.Epoch == "" {
		t.Errorf("envelope.epoch is empty for unknown id; want non-empty lifetime id")
	}
}

// TestDescendantsHeaders pins that stampMeta stamps X-VH-Epoch + X-VH-Seq on
// the response (the body envelope carries the same values for body-only
// consumers; the headers exist for clients that validate the connection cursor
// without parsing the body).
func TestDescendantsHeaders(t *testing.T) {
	webURL, _ := setupDescendantsTest(t)

	_, epochHdr, seqHdr, env := getDescendants(t, webURL, "root")

	if epochHdr == "" {
		t.Errorf("X-VH-Epoch header missing; stampMeta should stamp every /vh/* response")
	}
	if seqHdr == "" {
		t.Errorf("X-VH-Seq header missing; stampMeta should stamp every /vh/* response")
	}
	if epochHdr != env.Epoch {
		t.Errorf("X-VH-Epoch %q != body epoch %q (should cohere)", epochHdr, env.Epoch)
	}
}
