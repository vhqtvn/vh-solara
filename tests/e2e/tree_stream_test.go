package e2e

// In-process e2e coverage for the server-owned session tree (tree=2) — the
// Phase 2 server-side contract behind the `tree=2` flag. Exercises the REAL
// aggregator + store + tree emitter + web stream handler driven by the REAL
// fake OpenCode fixture, on the worker-local /vh/stream?tree=2 path.
//
// WHY THE WORKER-LOCAL STREAM (not the coordination tunnel): the coordination
// API's /vh/stream proxy rebuilds the upstream query via dirQuery, which
// carries ONLY dir+sessions+cursor — tree=2 is STRIPPED through the tunnel
// (same constraint as projection_demotion_test.go's proj=1). The
// worker-local path runs the identical tree=2 code.
//
// Behaviors verified:
//   (a) Cold load ships ONLY the lazy frontier — grandchildren are collapsed.
//   (b) Expanding a collapsed node round-trips via GET /vh/tree/children.
//   (c) A session deleted in the fixture disappears (no ghost).
//   (d) An archived busy session stays archived (no resurrection).
//   (e) Reconnect replays missed ops — does NOT re-ship the whole tree.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

const (
	e2eCsrfHeader = "X-VH-CSRF"
	e2eCsrfValue  = "1"
)

// treeStreamClient has no overall timeout — the SSE stream is long-lived. We
// rely on the test's own context/deadline for liveness, not the HTTP client.
var treeStreamClient = http.Client{}

// sseFrame is one parsed SSE event block.
type sseFrame struct {
	ID    string
	Event string
	Data  string
}

// readSSEFrames reads complete SSE event blocks (terminated by \n\n) from a
// bufio.Scanner over the response body. It blocks until at least n frames
// arrive or the deadline expires. Each block is parsed into id/event/data
// lines. Blocks without an "event:" line (comments, keepalives) are skipped.
func readSSEFrames(t *testing.T, body io.Reader, n int, deadline time.Time) []sseFrame {
	t.Helper()
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 64*1024), 8*1024*1024)
	var frames []sseFrame
	for sc.Scan() {
		if time.Now().After(deadline) {
			t.Fatalf("readSSEFrames: timed out after %d frames (wanted %d)", len(frames), n)
		}
		line := sc.Text()
		// A blank line terminates a block.
		if line == "" {
			continue
		}
		// Accumulate lines until the next blank line.
		var block sseFrame
		for line != "" {
			switch {
			case strings.HasPrefix(line, "id: "):
				block.ID = strings.TrimPrefix(line, "id: ")
			case strings.HasPrefix(line, "event: "):
				block.Event = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				block.Data = strings.TrimPrefix(line, "data: ")
			}
			if !sc.Scan() {
				break
			}
			line = sc.Text()
		}
		if block.Event != "" {
			frames = append(frames, block)
			if len(frames) >= n {
				return frames
			}
		}
	}
	t.Fatalf("readSSEFrames: stream closed after %d frames (wanted %d)", len(frames), n)
	return nil
}

// openTreeStream opens a tree=2 SSE stream to the worker. The caller must
// close the response body.
func openTreeStream(t *testing.T, lastEventID string) *http.Response {
	t.Helper()
	u := cluster.WorkerVHURL + "/vh/stream?tree=2"
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		t.Fatalf("openTreeStream: %v", err)
	}
	if lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	resp, err := treeStreamClient.Do(req)
	if err != nil {
		t.Fatalf("openTreeStream: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("openTreeStream: want 200, got %d", resp.StatusCode)
	}
	return resp
}

// forkSession POSTs /session/:id/fork through the worker passthrough and
// returns the new session's id.
func forkSession(t *testing.T, parentID string) string {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, cluster.WorkerVHURL+"/oc/session/"+parentID+"/fork", nil)
	req.Header.Set(e2eCsrfHeader, e2eCsrfValue)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("forkSession %s: %v", parentID, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("forkSession %s: want 200, got %d", parentID, resp.StatusCode)
	}
	var s struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&s); err != nil {
		t.Fatalf("forkSession %s: decode: %v", parentID, err)
	}
	if s.ID == "" {
		t.Fatalf("forkSession %s: empty id", parentID)
	}
	return s.ID
}

// deleteFixtureSession removes a session from the fake via /fixture/delete.
func deleteFixtureSession(t *testing.T, id string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, cluster.WorkerVHURL+"/oc/fixture/delete?session="+id, nil)
	req.Header.Set(e2eCsrfHeader, e2eCsrfValue)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("deleteFixtureSession %s: %v", id, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("deleteFixtureSession %s: want 200, got %d", id, resp.StatusCode)
	}
}

// archiveSession POSTs /vh/archive to archive a session.
func archiveSession(t *testing.T, id string) {
	t.Helper()
	body := fmt.Sprintf(`{"sessionID":%q}`, id)
	req, _ := http.NewRequest(http.MethodPost, cluster.WorkerVHURL+"/vh/archive", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(e2eCsrfHeader, e2eCsrfValue)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("archiveSession %s: %v", id, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("archiveSession %s: want 200, got %d", id, resp.StatusCode)
	}
}

// makeBusyFixture emits session.status busy for a session.
func makeBusyFixture(t *testing.T, id string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, cluster.WorkerVHURL+"/oc/fixture/busy?session="+id, nil)
	req.Header.Set(e2eCsrfHeader, e2eCsrfValue)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("makeBusyFixture %s: %v", id, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("makeBusyFixture %s: want 200, got %d", id, resp.StatusCode)
	}
}

// resetFixture clears busy + messages for a session (restores baseline).
func resetFixture(t *testing.T, id string) {
	t.Helper()
	req, _ := http.NewRequest(http.MethodPost, cluster.WorkerVHURL+"/oc/fixture/reset?session="+id, nil)
	req.Header.Set(e2eCsrfHeader, e2eCsrfValue)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("resetFixture %s: %v", id, err)
	}
	defer resp.Body.Close()
}

// treeSnapshot decodes a tree.snapshot data payload.
type treeSnapshot struct {
	Tree  string `json:"tree"`
	Seq   uint64 `json:"seq"`
	Cause string `json:"cause"`
	Nodes []struct {
		ID              string  `json:"id"`
		ParentID        *string `json:"parentId"`
		ChildCount      int     `json:"childCount"`
		DescendantCount *int    `json:"descendantCount,omitempty"`
		Loaded          bool    `json:"loaded"`
	} `json:"nodes"`
}

func nodeIDs(snap treeSnapshot) map[string]bool {
	m := make(map[string]bool, len(snap.Nodes))
	for _, n := range snap.Nodes {
		m[n.ID] = true
	}
	return m
}

// ---------------------------------------------------------------------------
// (a) Cold load ships ONLY the lazy frontier — grandchildren are collapsed.
// ---------------------------------------------------------------------------

func TestE2E_Tree_ColdLoadLazyFrontier(t *testing.T) {
	// Create a grandchild (fork sub) and great-grandchild (fork grandchild).
	// The fixture seed: demo (root) → sub (child) → [grandchild, ...].
	grandchild := forkSession(t, "sub")
	greatgrand := forkSession(t, grandchild)
	t.Cleanup(func() {
		deleteFixtureSession(t, grandchild)
		deleteFixtureSession(t, greatgrand)
		resetFixture(t, "sub")
	})
	time.Sleep(300 * time.Millisecond) // let aggregator ingest session.created events

	resp := openTreeStream(t, "")
	defer resp.Body.Close()

	frames := readSSEFrames(t, resp.Body, 1, time.Now().Add(5*time.Second))
	if frames[0].Event != "tree.snapshot" {
		t.Fatalf("first event: want tree.snapshot, got %s", frames[0].Event)
	}
	var snap treeSnapshot
	if err := json.Unmarshal([]byte(frames[0].Data), &snap); err != nil {
		t.Fatalf("decode snapshot: %v (data=%.200s)", err, frames[0].Data)
	}

	ids := nodeIDs(snap)
	// Roots (demo, other, slow) must ship. With no session busy, direct
	// children of idle roots are COLLAPSED — so sub must NOT ship either
	// (it's a child of idle demo, shipped only when demo is loaded/active).
	for _, must := range []string{"demo", "other", "slow"} {
		if !ids[must] {
			t.Errorf("frontier missing root %s (have: %v)", must, ids)
		}
	}
	// sub, grandchild, great-grandchild must ALL be collapsed (not shipped).
	for _, mustNot := range []string{"sub", grandchild, greatgrand} {
		if ids[mustNot] {
			t.Errorf("%s must NOT be in the cold frontier (collapsed under idle root)", mustNot)
		}
	}

	// demo must report descendantCount >= 2 (sub + grandchild + great-grand).
	demoNode := findNode(snap, "demo")
	if demoNode == nil {
		t.Fatalf("demo node missing from snapshot")
	}
	if demoNode.DescendantCount == nil || *demoNode.DescendantCount < 2 {
		t.Errorf("demo descendantCount: want >=2, got %v", demoNode.DescendantCount)
	}
	if demoNode.Loaded {
		t.Errorf("demo should be collapsed (loaded=false) — idle, children not shipped")
	}

	t.Logf("PASS: cold frontier ships %d root nodes only; sub+grandchildren collapsed. demo descendantCount=%d",
		len(snap.Nodes), descendantCountOf(demoNode))
}

func findNode(snap treeSnapshot, id string) *struct {
	ID              string  `json:"id"`
	ParentID        *string `json:"parentId"`
	ChildCount      int     `json:"childCount"`
	DescendantCount *int    `json:"descendantCount,omitempty"`
	Loaded          bool    `json:"loaded"`
} {
	for i := range snap.Nodes {
		if snap.Nodes[i].ID == id {
			return &snap.Nodes[i]
		}
	}
	return nil
}

func descendantCountOf(n *struct {
	ID              string  `json:"id"`
	ParentID        *string `json:"parentId"`
	ChildCount      int     `json:"childCount"`
	DescendantCount *int    `json:"descendantCount,omitempty"`
	Loaded          bool    `json:"loaded"`
}) int {
	if n == nil || n.DescendantCount == nil {
		return 0
	}
	return *n.DescendantCount
}

// ---------------------------------------------------------------------------
// (b) Expanding a collapsed node round-trips via GET /vh/tree/children.
// ---------------------------------------------------------------------------

func TestE2E_Tree_ExpandRoundTrip(t *testing.T) {
	grandchild := forkSession(t, "sub")
	t.Cleanup(func() {
		deleteFixtureSession(t, grandchild)
		resetFixture(t, "sub")
	})
	time.Sleep(300 * time.Millisecond)

	// GET /vh/tree/children?id=sub → should return the grandchild.
	resp, err := http.Get(cluster.WorkerVHURL + "/vh/tree/children?id=sub")
	if err != nil {
		t.Fatalf("tree/children: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("tree/children: want 200, got %d", resp.StatusCode)
	}
	var tc struct {
		ParentID string `json:"parentId"`
		Nodes    []struct {
			ID string `json:"id"`
		} `json:"nodes"`
		HasMore bool `json:"hasMore"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tc); err != nil {
		t.Fatalf("decode tree/children: %v", err)
	}
	if tc.ParentID != "sub" {
		t.Errorf("parentId: want sub, got %s", tc.ParentID)
	}
	found := false
	for _, n := range tc.Nodes {
		if n.ID == grandchild {
			found = true
		}
	}
	if !found {
		t.Errorf("tree/children(id=sub) must include grandchild %s (got %d nodes: %v)",
			grandchild, len(tc.Nodes), nodeIDList(tc.Nodes))
	}
	t.Logf("PASS: GET /vh/tree/children?id=sub returned %d nodes including grandchild %s, hasMore=%v",
		len(tc.Nodes), grandchild, tc.HasMore)
}

func nodeIDList(nodes []struct {
	ID string `json:"id"`
}) []string {
	out := make([]string, len(nodes))
	for i, n := range nodes {
		out[i] = n.ID
	}
	return out
}

// ---------------------------------------------------------------------------
// (c) A session deleted in the fixture disappears (no ghost).
// ---------------------------------------------------------------------------

func TestE2E_Tree_DeleteNoGhost(t *testing.T) {
	// Make demo busy so its direct children are in the frontier (loaded).
	makeBusyFixture(t, "demo")
	t.Cleanup(func() { resetFixture(t, "demo") })

	// Create a direct child of demo (so it's in the frontier via category3).
	child := forkSession(t, "demo")
	t.Cleanup(func() { deleteFixtureSession(t, child) })
	time.Sleep(300 * time.Millisecond)

	// Connect tree=2 and read the snapshot — child should be present.
	resp := openTreeStream(t, "")
	defer resp.Body.Close()
	frames := readSSEFrames(t, resp.Body, 1, time.Now().Add(5*time.Second))
	var snap treeSnapshot
	json.Unmarshal([]byte(frames[0].Data), &snap)
	if !nodeIDs(snap)[child] {
		t.Fatalf("child %s not in initial snapshot (nodes: %v)", child, nodeIDs(snap))
	}

	// Delete the child from the fixture. The fake emits session.deleted →
	// aggregator ingests → store emits KindSessionDelete → stream live-tails
	// a tree.op (node.remove).
	deleteFixtureSession(t, child)

	// Read subsequent frames until we see a node.remove for child.
	deadline := time.Now().Add(5 * time.Second)
	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64*1024), 8*1024*1024)
	var block sseFrame
	for sc.Scan() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for node.remove(%s)", child)
		}
		line := sc.Text()
		if line == "" {
			if block.Event == "tree.op" && strings.Contains(block.Data, child) &&
				strings.Contains(block.Data, `"node.remove"`) {
				t.Logf("PASS: session %s deleted → node.remove received within window", child)
				return
			}
			block = sseFrame{}
			continue
		}
		switch {
		case strings.HasPrefix(line, "id: "):
			block.ID = strings.TrimPrefix(line, "id: ")
		case strings.HasPrefix(line, "event: "):
			block.Event = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			block.Data = strings.TrimPrefix(line, "data: ")
		}
	}
	t.Fatalf("stream closed before node.remove(%s) arrived", child)
}

// ---------------------------------------------------------------------------
// (d) An archived busy session stays archived (no resurrection).
// ---------------------------------------------------------------------------

func TestE2E_Tree_ArchiveBusyNoResurrection(t *testing.T) {
	// Make "other" busy, then archive it.
	makeBusyFixture(t, "other")
	time.Sleep(200 * time.Millisecond)
	archiveSession(t, "other")
	t.Cleanup(func() {
		resetFixture(t, "other")
	})
	time.Sleep(500 * time.Millisecond) // let archive cascade + reassert settle

	// After archiving, "other" must NOT appear in a fresh tree=2 snapshot
	// (the archive cascade removes it from the store). Verify it's gone.
	resp := openTreeStream(t, "")
	frames := readSSEFrames(t, resp.Body, 1, time.Now().Add(5*time.Second))
	resp.Body.Close()
	var snap treeSnapshot
	json.Unmarshal([]byte(frames[0].Data), &snap)
	if nodeIDs(snap)["other"] {
		t.Errorf("archived busy 'other' must NOT appear in tree snapshot (resurrection!)")
	} else {
		t.Logf("PASS: archived busy 'other' does not reappear in snapshot (nodes: %v)", nodeIDs(snap))
	}

	// Wait past the reconcile interval (5s) and re-check — the reconcile tick
	// must not resurrect it either.
	time.Sleep(6 * time.Second)
	resp2 := openTreeStream(t, "")
	frames2 := readSSEFrames(t, resp2.Body, 1, time.Now().Add(5*time.Second))
	resp2.Body.Close()
	var snap2 treeSnapshot
	json.Unmarshal([]byte(frames2[0].Data), &snap2)
	if nodeIDs(snap2)["other"] {
		t.Errorf("archived busy 'other' resurrected after reconcile tick!")
	} else {
		t.Logf("PASS: 'other' stays archived across a reconcile tick (no resurrection)")
	}
}

// ---------------------------------------------------------------------------
// (e) Reconnect replays missed ops — does NOT re-ship the whole tree.
// ---------------------------------------------------------------------------

func TestE2E_Tree_ReconnectReplaysDelta(t *testing.T) {
	// Make demo busy so its direct children are in the frontier (loaded).
	makeBusyFixture(t, "demo")
	t.Cleanup(func() { resetFixture(t, "demo") })

	// Connect tree=2, read snapshot, capture SSE id (store head seq).
	resp := openTreeStream(t, "")
	frames := readSSEFrames(t, resp.Body, 1, time.Now().Add(5*time.Second))
	snapshotID := frames[0].ID
	if snapshotID == "" {
		t.Fatal("snapshot event has no id")
	}
	resp.Body.Close()

	// Apply a change: fork demo → new child (direct child of active root → ships).
	child := forkSession(t, "demo")
	t.Cleanup(func() { deleteFixtureSession(t, child) })
	time.Sleep(300 * time.Millisecond)

	// Reconnect with Last-Event-ID=snapshotID. Must replay the missed op
	// (node.upsert for child) WITHOUT re-shipping the whole tree (no
	// tree.snapshot with cause "reconnect" — that only happens on ring-gap).
	resp2 := openTreeStream(t, snapshotID)
	defer resp2.Body.Close()

	// Read the first event. It should be tree.op (delta replay), NOT
	// tree.snapshot (which would mean a ring-gap or full re-ship).
	frame := readSSEFrames(t, resp2.Body, 1, time.Now().Add(5*time.Second))[0]
	if frame.Event == "tree.snapshot" {
		t.Fatalf("reconnect with valid cursor re-shipped a tree.snapshot (expected tree.op delta replay). "+
			"snapshot cause=%q — this means the ring-gap path fired when it should not have", causeOf(frame.Data))
	}
	if frame.Event != "tree.op" {
		t.Fatalf("first event on reconnect: want tree.op, got %s (data=%.200s)", frame.Event, frame.Data)
	}
	// The replayed op should reference the new child.
	if !strings.Contains(frame.Data, child) {
		t.Errorf("replayed tree.op does not reference the new child %s (data=%.200s)", child, frame.Data)
	}
	t.Logf("PASS: reconnect with cursor=%s replayed delta op (event=%s) referencing child %s — no full re-ship",
		snapshotID, frame.Event, child)
}

func causeOf(data string) string {
	var m struct {
		Cause string `json:"cause"`
	}
	json.Unmarshal([]byte(data), &m)
	return m.Cause
}
