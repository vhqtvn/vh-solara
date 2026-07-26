package web

// HTTP handler tests for GET /vh/session/{sessionId}/subtree-todos (P5): the
// server-authoritative subtree todo rollup.
//
// These pin the wire contract (Q3 revisioned envelope {epoch, revision, data}),
// the rollup semantics (subtree order, all four status branches in totals,
// sibling-root exclusion), and the unknown-id → empty-items behavior.
//
// The harness mirrors session_descendants_test.go / integration_test.go: a
// fakeOpenCode upstream seeds sessions AND pushes live todo.updated events into
// the aggregator's SSE stream, an Aggregator reconciles them into the store,
// and the test waits for the rollup to reflect the events before issuing the
// detailed assertions. The handler is a pure point-in-time read — it touches
// only the Store, makes no upstream call, and emits no SSE events.

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// setupSubtreeTodosTest wires fakeOpenCode + aggregator + web server with the
// seeded session subtree and returns the web server base URL + the fake (so the
// test can push live todo.updated events into the aggregator's SSE stream) + a
// Store-head accessor for envelope-revision bounds.
func setupSubtreeTodosTest(t *testing.T) (webURL string, fake *fakeOpenCode, head func() uint64) {
	t.Helper()
	f := newFake()
	// Subtree: root → child → grand, plus an unrelated root "other".
	f.sessions = []string{
		`{"id":"root","title":"Root","parentID":""}`,
		`{"id":"child","title":"Child","parentID":"root"}`,
		`{"id":"grand","title":"Grand","parentID":"child"}`,
		`{"id":"other","title":"Other","parentID":""}`,
	}
	ocSrv := httptest.NewServer(f.handler())
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
	return web.URL, f, func() uint64 { return agg.Store().Head() }
}

// getSubtreeTodos issues GET /vh/session/<sid>/subtree-todos and returns the
// HTTP status, the raw X-VH-Epoch / X-VH-Seq headers, and the decoded envelope.
// Fatals only on non-200 or decode failure — empty items (valid while events
// are still in flight) are returned for the caller to poll on.
func getSubtreeTodos(t *testing.T, webURL, sid string) (status int, epochHdr, seqHdr string, env struct {
	Epoch    string `json:"epoch"`
	Revision uint64 `json:"revision"`
	Data     struct {
		SessionID string            `json:"sessionId"`
		Items     []json.RawMessage `json:"items"`
		Totals    struct {
			Active int `json:"active"`
			Left   int `json:"left"`
			Total  int `json:"total"`
		} `json:"totals"`
	} `json:"data"`
}) {
	t.Helper()
	res, err := http.Get(webURL + "/vh/session/" + sid + "/subtree-todos")
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
		t.Fatalf("GET subtree-todos %s: status %d, body %s", sid, res.StatusCode, body)
	}
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("decode subtree-todos envelope: %v, body %s", err, body)
	}
	return status, epochHdr, seqHdr, env
}

// todoField reads a single string field from a raw todo item (passthrough JSON).
func todoField(t *testing.T, item json.RawMessage, field string) string {
	t.Helper()
	var s map[string]any
	if err := json.Unmarshal(item, &s); err != nil {
		t.Fatalf("decode todo item: %v, raw %s", err, item)
	}
	v, _ := s[field].(string)
	return v
}

// TestSubtreeTodosRollup pins the server-authoritative todo rollup over a real
// subtree hydrated with live todo.updated events: child's 4 todos (covering all
// four status branches) + grand's 1 in_progress todo roll up under root in
// subtree order, totals are computed from status (active=in_progress,
// left=pending+in_progress, completed/cancelled excluded), and the Q3 envelope
// is coherent (epoch non-empty, revision bounded by store head). "other" (a
// sibling root) is excluded and returns empty items.
func TestSubtreeTodosRollup(t *testing.T) {
	webURL, fake, head := setupSubtreeTodosTest(t)

	// Seed todos covering every status branch:
	//   child: in_progress (active+left), pending (left), completed (neither),
	//          cancelled (neither)
	//   grand: in_progress (active+left)
	fake.events <- `{"type":"todo.updated","properties":{"sessionID":"child","todos":[` +
		`{"content":"ship-feature","status":"in_progress"},` +
		`{"content":"write-tests","status":"pending"},` +
		`{"content":"research","status":"completed"},` +
		`{"content":"abandoned","status":"cancelled"}]}}`
	fake.events <- `{"type":"todo.updated","properties":{"sessionID":"grand","todos":[` +
		`{"content":"grand-task","status":"in_progress"}]}}`

	before := head()
	// Wait for the rollup to reflect all 5 items (aggregator applies events async).
	waitFor(t, func() bool {
		_, _, _, env := getSubtreeTodos(t, webURL, "root")
		return len(env.Data.Items) >= 5
	}, "subtree todos hydrated from events")

	_, _, _, env := getSubtreeTodos(t, webURL, "root")
	after := head()

	if got := len(env.Data.Items); got != 5 {
		t.Fatalf("want 5 items (child×4 + grand×1), got %d", got)
	}
	// Subtree order: descendantsLocked yields [root, child, grand]. root has no
	// todos; child's 4 come before grand's 1.
	if got := todoField(t, env.Data.Items[0], "content"); got != "ship-feature" {
		t.Errorf("items[0].content = %q, want ship-feature (child first in subtree order)", got)
	}
	if got := todoField(t, env.Data.Items[3], "content"); got != "abandoned" {
		t.Errorf("items[3].content = %q, want abandoned (last of child's 4)", got)
	}
	if got := todoField(t, env.Data.Items[4], "content"); got != "grand-task" {
		t.Errorf("items[4].content = %q, want grand-task (grand after child)", got)
	}
	// Totals: active=2 (ship-feature + grand-task), left=3 (ship-feature,
	// write-tests, grand-task; research=completed + abandoned=cancelled excluded),
	// total=5.
	if env.Data.Totals.Active != 2 {
		t.Errorf("totals.active = %d, want 2", env.Data.Totals.Active)
	}
	if env.Data.Totals.Left != 3 {
		t.Errorf("totals.left = %d, want 3", env.Data.Totals.Left)
	}
	if env.Data.Totals.Total != 5 {
		t.Errorf("totals.total = %d, want 5", env.Data.Totals.Total)
	}
	// Items are raw passthrough — the status field survives untouched (the
	// server reads it for totals but does not rewrite the item).
	if got := todoField(t, env.Data.Items[0], "status"); got != "in_progress" {
		t.Errorf("items[0].status = %q, want in_progress (raw passthrough)", got)
	}
	// sessionId echoes the request id.
	if env.Data.SessionID != "root" {
		t.Errorf("data.sessionId = %q, want root", env.Data.SessionID)
	}
	// Q3 envelope coherence.
	if env.Epoch == "" {
		t.Errorf("envelope.epoch is empty; want non-empty lifetime id")
	}
	if env.Revision < before || env.Revision > after {
		t.Errorf("envelope.revision %d outside [%d,%d] (store head before/after GET)", env.Revision, before, after)
	}

	// "other" is a sibling root with NO todos → empty items + zero totals.
	_, _, _, otherEnv := getSubtreeTodos(t, webURL, "other")
	if otherEnv.Data.Items == nil {
		t.Errorf("other.items = nil; want empty slice (wire contract: [] not null)")
	}
	if len(otherEnv.Data.Items) != 0 {
		t.Errorf("other.items = %d long; want 0 (sibling root excluded)", len(otherEnv.Data.Items))
	}
	if otherEnv.Data.Totals.Total != 0 {
		t.Errorf("other.totals.total = %d, want 0", otherEnv.Data.Totals.Total)
	}
}

// TestSubtreeTodosUnknownID pins the unknown-id contract: 200 with empty (NOT
// null) items + zero totals. A not-yet-hydrated or just-pruned id is a normal
// transient. Mirrors the descendants endpoint contract.
func TestSubtreeTodosUnknownID(t *testing.T) {
	webURL, _, _ := setupSubtreeTodosTest(t)

	_, _, _, env := getSubtreeTodos(t, webURL, "does-not-exist")

	if env.Data.SessionID != "does-not-exist" {
		t.Errorf("data.sessionId = %q, want echoed request id", env.Data.SessionID)
	}
	if env.Data.Items == nil {
		t.Errorf("items = nil; want empty slice (wire contract: [] not null)")
	}
	if len(env.Data.Items) != 0 {
		t.Errorf("items = %+v; want empty for unknown id", env.Data.Items)
	}
	if env.Data.Totals.Total != 0 || env.Data.Totals.Active != 0 || env.Data.Totals.Left != 0 {
		t.Errorf("totals = %+v; want all zero for unknown id", env.Data.Totals)
	}
	if env.Epoch == "" {
		t.Errorf("envelope.epoch is empty for unknown id; want non-empty lifetime id")
	}
}

// TestSubtreeTodosHeaders pins that stampMeta stamps X-VH-Epoch + X-VH-Seq on
// the response (the body envelope carries the same values for body-only
// consumers).
func TestSubtreeTodosHeaders(t *testing.T) {
	webURL, _, _ := setupSubtreeTodosTest(t)

	_, epochHdr, seqHdr, env := getSubtreeTodos(t, webURL, "root")

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
