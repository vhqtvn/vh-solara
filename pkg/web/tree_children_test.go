package web

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// treeTestServer builds a Server with a live default aggregator whose store is
// seeded directly via Apply (no fake-opencode hydration loop). The store has:
//
//	R (root)
//	├── C1, C2, C3  (direct children of R)
//	└── C4         (4th child, for pagination boundary)
func treeTestServer(t *testing.T) *Server {
	t.Helper()
	oc := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(oc.Close)
	agg := aggregator.New(oc.URL, 1000)
	srv, err := NewServer(agg, oc.URL, 1000)
	if err != nil {
		t.Fatal(err)
	}
	store := agg.Store()
	for _, id := range []string{"R", "C1", "C2", "C3", "C4"} {
		parent := "R"
		if id == "R" {
			parent = ""
		}
		store.Apply(opencode.Event{
			Type:       "session.created",
			Properties: json.RawMessage(`{"info":{"id":"` + id + `","parentID":"` + parent + `","title":"` + id + `","time":{"updated":1000}}}`),
		})
	}
	return srv
}

func decodeTreeChildren(t *testing.T, w *httptest.ResponseRecorder) treeChildrenResponse {
	t.Helper()
	var resp treeChildrenResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("unmarshal tree children: %v\nbody=%s", err, w.Body.String())
	}
	return resp
}

// TestTreeChildren_Basic asserts the expand endpoint returns the right
// node.children payload shape (parentId, nodes, hasMore, cursor).
func TestTreeChildren_Basic(t *testing.T) {
	srv := treeTestServer(t)

	req := httptest.NewRequest("GET", "/vh/tree/children?id=R", nil)
	w := httptest.NewRecorder()
	srv.handleTreeChildren(w, req)

	if w.Code != 200 {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	resp := decodeTreeChildren(t, w)
	if resp.ParentID != "R" {
		t.Errorf("parentId: got %q, want R", resp.ParentID)
	}
	if len(resp.Nodes) != 4 {
		t.Fatalf("nodes: got %d, want 4 (C1-C4)", len(resp.Nodes))
	}
	if resp.HasMore {
		t.Errorf("hasMore: got true, want false (4 children, limit default=50)")
	}
	if resp.Cursor != "" {
		t.Errorf("cursor: got %q, want empty (terminal batch)", resp.Cursor)
	}
	if resp.StaleCursor {
		t.Errorf("staleCursor: got true, want false")
	}
	// Nodes should carry childCount and loaded=false (placeholders).
	for _, n := range resp.Nodes {
		if n.Loaded {
			t.Errorf("node %s: loaded should be false (placeholder)", n.ID)
		}
		if n.ParentID != "R" {
			t.Errorf("node %s: parentId got %q, want R", n.ID, n.ParentID)
		}
	}
}

// TestTreeChildren_Pagination asserts cursor-based paging via ?limit and ?cursor.
func TestTreeChildren_Pagination(t *testing.T) {
	srv := treeTestServer(t)

	// Page 1: limit=2 → 2 nodes, hasMore=true, cursor set.
	req := httptest.NewRequest("GET", "/vh/tree/children?id=R&limit=2", nil)
	w := httptest.NewRecorder()
	srv.handleTreeChildren(w, req)
	if w.Code != 200 {
		t.Fatalf("page 1: want 200, got %d: %s", w.Code, w.Body.String())
	}
	resp := decodeTreeChildren(t, w)
	if len(resp.Nodes) != 2 || !resp.HasMore {
		t.Fatalf("page 1: got %d nodes hasMore=%v, want 2/true", len(resp.Nodes), resp.HasMore)
	}
	if resp.Cursor == "" {
		t.Fatal("page 1: expected non-empty cursor")
	}
	if w.Header().Get("X-VH-Branch-Cursor") == "" {
		t.Error("page 1: expected X-VH-Branch-Cursor header")
	}

	// Page 2: cursor → remaining 2 nodes, hasMore=false.
	req2 := httptest.NewRequest("GET", "/vh/tree/children?id=R&limit=2&cursor="+resp.Cursor, nil)
	w2 := httptest.NewRecorder()
	srv.handleTreeChildren(w2, req2)
	if w2.Code != 200 {
		t.Fatalf("page 2: want 200, got %d: %s", w2.Code, w2.Body.String())
	}
	resp2 := decodeTreeChildren(t, w2)
	if len(resp2.Nodes) != 2 || resp2.HasMore {
		t.Fatalf("page 2: got %d nodes hasMore=%v, want 2/false", len(resp2.Nodes), resp2.HasMore)
	}
	if resp2.Cursor != "" {
		t.Errorf("page 2: cursor got %q, want empty (terminal)", resp2.Cursor)
	}
}

// TestTreeChildren_StaleCursor asserts a stale cursor returns an empty terminal
// batch with staleCursor:true (§8.3).
func TestTreeChildren_StaleCursor(t *testing.T) {
	srv := treeTestServer(t)

	req := httptest.NewRequest("GET", "/vh/tree/children?id=R&cursor=GONE", nil)
	w := httptest.NewRecorder()
	srv.handleTreeChildren(w, req)
	if w.Code != 200 {
		t.Fatalf("want 200, got %d: %s", w.Code, w.Body.String())
	}
	resp := decodeTreeChildren(t, w)
	if len(resp.Nodes) != 0 || resp.HasMore {
		t.Fatalf("stale cursor: got %d nodes hasMore=%v, want 0/false", len(resp.Nodes), resp.HasMore)
	}
	if !resp.StaleCursor {
		t.Errorf("stale cursor: expected staleCursor=true")
	}
}

// TestTreeChildren_MissingID asserts 400 when ?id is absent.
func TestTreeChildren_MissingID(t *testing.T) {
	srv := treeTestServer(t)
	req := httptest.NewRequest("GET", "/vh/tree/children", nil)
	w := httptest.NewRecorder()
	srv.handleTreeChildren(w, req)
	if w.Code != 400 {
		t.Fatalf("want 400 for missing id, got %d", w.Code)
	}
}

// TestTreeChildren_NoCSRF asserts a plain GET (no X-VH-CSRF header) succeeds —
// the expand endpoint is read-only and mirrors handleBranch (GET → no CSRF).
func TestTreeChildren_NoCSRF(t *testing.T) {
	srv := treeTestServer(t)
	req := httptest.NewRequest("GET", "/vh/tree/children?id=R", nil)
	// Deliberately do NOT set X-VH-CSRF.
	w := httptest.NewRecorder()
	srv.handleTreeChildren(w, req)
	if w.Code != 200 {
		t.Fatalf("GET without CSRF should succeed (read-only), got %d: %s", w.Code, w.Body.String())
	}
}

// ---------------------------------------------------------------------------
// Group 7 — tree=2 flag routing (wantsTree2 + handleStream SSE routing)
// ---------------------------------------------------------------------------

// TestWantsTree2 pins the tree=2 capability-detection helper (mirrors
// TestWantsProject). Only the literal "2" opts in.
func TestWantsTree2(t *testing.T) {
	cases := map[string]bool{
		"":     false,
		"0":    false,
		"1":    false,
		"2":    true,
		"true": false, // only the literal "2" opts in
	}
	for q, want := range cases {
		r := mustReq("GET", "/vh/stream?sessions=a&tree="+q, nil)
		if got := wantsTree2(r); got != want {
			t.Errorf("tree=%q: want %v, got %v", q, want, got)
		}
	}
	// No tree param at all → false (protects a stale/old client).
	r := mustReq("GET", "/vh/stream?sessions=a", nil)
	if wantsTree2(r) {
		t.Error("absent tree param must NOT opt into tree=2")
	}
	// tree=2 is independent of proj=1 — both can coexist on the same URL, but
	// tree=2 takes precedence in handleStream (checked first).
	r2 := mustReq("GET", "/vh/stream?sessions=a&tree=2&proj=1", nil)
	if !wantsTree2(r2) || !wantsProject(r2) {
		t.Error("tree=2 and proj=1 must be independently detectable")
	}
}

// TestTreeRoute_StreamEmitTreeSnapshot connects to /vh/stream?tree=2 and asserts
// the first SSE event is a tree.snapshot (frontier), NOT a legacy "snapshot"
// event. This verifies tree=2 routes to the new emitter in handleStream.
func TestTreeRoute_StreamEmitTreeSnapshot(t *testing.T) {
	srv := treeTestServer(t)
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	resp, err := http.Get(web.URL + "/vh/stream?tree=2")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	// Read SSE lines until we find an event: line.
	var eventType string
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 512)
	for {
		n, err := resp.Body.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			// Look for "event: " in the accumulated buffer.
			if idx := strings.Index(string(buf), "event: "); idx >= 0 {
				rest := string(buf)[idx+7:]
				if nl := strings.IndexByte(rest, '\n'); nl >= 0 {
					eventType = strings.TrimSpace(rest[:nl])
					break
				}
			}
		}
		if err != nil {
			break
		}
		if len(buf) > 8192 {
			break // safety valve
		}
	}
	if eventType != "tree.snapshot" {
		t.Fatalf("tree=2 stream first event: got %q, want tree.snapshot", eventType)
	}
}

// TestTreeRoute_LegacyUnchanged asserts that WITHOUT tree=2, the stream emits
// the legacy "snapshot" event (the proj=1 or default path is unchanged).
func TestTreeRoute_LegacyUnchanged(t *testing.T) {
	srv := treeTestServer(t)
	web := httptest.NewServer(srv.Handler())
	defer web.Close()

	resp, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	var eventType string
	buf := make([]byte, 0, 4096)
	tmp := make([]byte, 512)
	for {
		n, err := resp.Body.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			if idx := strings.Index(string(buf), "event: "); idx >= 0 {
				rest := string(buf)[idx+7:]
				if nl := strings.IndexByte(rest, '\n'); nl >= 0 {
					eventType = strings.TrimSpace(rest[:nl])
					break
				}
			}
		}
		if err != nil {
			break
		}
		if len(buf) > 8192 {
			break
		}
	}
	// Legacy path emits "snapshot" (the first non-comment event).
	if eventType != "snapshot" {
		t.Fatalf("legacy stream first event: got %q, want snapshot", eventType)
	}
}
