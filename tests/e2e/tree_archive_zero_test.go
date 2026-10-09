package e2e

// tree_archive_zero_test.go — lane-3 SERVER-half pin for commit-review
// finding F1 / commit 514ff2c (the ghost-row fix): archiving a project's LAST
// live session must (1) emit a tree.op node.remove for it on an OPEN tree=2
// stream, and (2) make every subsequent reconnect snapshot of the now-EMPTY
// store serialize `"nodes":[]` — never `"nodes":null` — so the web decoder
// applies the authoritative empty frontier instead of stranding the stale
// pre-archive tree (the ghost row). The browser half (decodeTreeSnapshot null
// tolerance + eager prune) is pinned separately in web/tests/e2e (slice 2).
//
// Why a PRIVATE cluster (StartCluster/Close inside the test): the lane shares
// ONE cluster across the package (TestMain), and archive-to-zero is
// IRREVERSIBLE on the fixture — the fake's PATCH handler can only SET
// time.archived (mirroring OpenCode 1.17.x, which rejects null), and
// /vh/unarchive writes to a real OpenCode SQLite DB that does not exist
// against the fake. Archiving the shared cluster's seed sessions (demo, sub,
// other, slow) would starve every later test of its fixture. The isolated
// in-process cluster is this lane's established pattern (see
// coldload_boundary_demand_test.go, tunnel_gate_test.go).
//
// Server contract pinned (per 514ff2c):
//   - POST /vh/archive responds 200 IMMEDIATELY; the cascade
//     (SetArchived PATCH → Store().RemoveSessionIfPresent) runs async under
//     bgCtx (pkg/web/archive.go: runArchiveCascade launched before the 200 is
//     written). node.remove reaches open streams via KindSessionDelete →
//     TreeEmitter.onSessionDeleteLocked — which may fire through EITHER the
//     session.updated(archived) ingest funnel (pkg/state/reducers.go treats a
//     time.archived update as a delete) OR RemoveSessionIfPresent; both emit
//     the same client-visible tree.op node.remove.
//   - The empty store's TreeSnapshot is built ONLY at
//     snapshotFrontierLocked's single construction site (Nodes initialized to
//     []Node{}), covering fresh/reconnect/partial emit paths at once.
//
// Tombstone note (pkg/state/store.go:~1133): RemoveSessions-family removals
// set a 30s recentlyArchived tombstone that drops stale archived=null events
// so they cannot resurrect the empty store mid-window. This test runs on a
// fresh private cluster and completes well inside 30s, so tombstones stay
// active through both reconnects — they only ever HELP the no-resurrection
// assertions here; nothing depends on their expiry.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"testing"
	"time"
)

// streamReader parses SSE frames off ONE response body with a single Scanner
// for the body's whole lifetime. The shared readSSEFrames helper allocates a
// fresh Scanner per call, which can drop frames buffered-but-unconsumed by
// the previous Scanner; this test reads the same open stream across several
// phases (initial snapshot → node.remove scan), so it keeps one Scanner.
type streamReader struct {
	sc *bufio.Scanner
}

func newStreamReader(body io.Reader) *streamReader {
	sc := bufio.NewScanner(body)
	sc.Buffer(make([]byte, 64*1024), 8*1024*1024)
	return &streamReader{sc: sc}
}

// next returns the next event-bearing SSE block (blocks without an event:
// line — comments, keepalives — are skipped), failing the test on stream
// close or deadline expiry.
func (r *streamReader) next(t *testing.T, deadline time.Time) sseFrame {
	t.Helper()
	var block sseFrame
	for r.sc.Scan() {
		if time.Now().After(deadline) {
			t.Fatalf("streamReader: deadline exceeded waiting for next frame (last: event=%q data=%.200s)", block.Event, block.Data)
		}
		line := r.sc.Text()
		if line == "" {
			if block.Event != "" {
				return block
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
	t.Fatalf("streamReader: stream closed (last: event=%q data=%.200s)", block.Event, block.Data)
	return sseFrame{}
}

// until scans until a frame matches want, failing the test on close/deadline.
func (r *streamReader) until(t *testing.T, deadline time.Time, want func(sseFrame) bool) sseFrame {
	t.Helper()
	for {
		f := r.next(t, deadline)
		if want(f) {
			return f
		}
	}
}

// openTreeStreamAt is openTreeStream for an explicit worker base URL (the
// shared helper hardcodes the package-level cluster; this test drives a
// private one).
func openTreeStreamAt(t *testing.T, base, lastEventID string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, base+"/vh/stream?tree=2", nil)
	if err != nil {
		t.Fatalf("openTreeStreamAt: %v", err)
	}
	if lastEventID != "" {
		req.Header.Set("Last-Event-ID", lastEventID)
	}
	resp, err := treeStreamClient.Do(req)
	if err != nil {
		t.Fatalf("openTreeStreamAt: %v", err)
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("openTreeStreamAt: want 200, got %d", resp.StatusCode)
	}
	return resp
}

// archiveSessionAt is archiveSession for an explicit worker base URL.
func archiveSessionAt(t *testing.T, base, id string) {
	t.Helper()
	body := fmt.Sprintf(`{"sessionID":%q}`, id)
	req, _ := http.NewRequest(http.MethodPost, base+"/vh/archive", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set(e2eCsrfHeader, e2eCsrfValue)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("archiveSessionAt %s: %v", id, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("archiveSessionAt %s: want 200, got %d", id, resp.StatusCode)
	}
}

// fixtureSession is the slice of the fake's GET /session listing this test
// needs (served through the worker /oc passthrough — the same route the SPA
// uses).
type fixtureSession struct {
	ID       string `json:"id"`
	ParentID string `json:"parentID"`
}

// listLiveSessions enumerates the fixture's LIVE (non-archived) sessions.
func listLiveSessions(t *testing.T, base string) []fixtureSession {
	t.Helper()
	resp, err := http.Get(base + "/oc/session")
	if err != nil {
		t.Fatalf("listLiveSessions: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("listLiveSessions: want 200, got %d", resp.StatusCode)
	}
	var out []fixtureSession
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("listLiveSessions: decode: %v", err)
	}
	return out
}

// waitLiveListing polls the fixture listing until exactly `want` remains.
func waitLiveListing(t *testing.T, base string, want string, deadline time.Time) {
	t.Helper()
	for time.Now().Before(deadline) {
		live := listLiveSessions(t, base)
		if len(live) == 1 && live[0].ID == want {
			return
		}
		time.Sleep(100 * time.Millisecond)
	}
	t.Fatalf("fixture listing never settled to exactly [%s]", want)
}

// assertEmptyNodesRaw pins the RAW wire shape of an empty-store tree.snapshot:
// the frame data must contain "nodes":[] and must NOT contain "nodes":null.
// Same regression-catch power as the unit marshalled-JSON probe
// (TestTreeSnapshotEmptyStoreNodesIsArray) but at the SSE transport, where the
// web decoder lives. The stream is opened without ?z=1, so the snapshot ships
// as raw JSON (maybeCompressSnapshot only gzip64-wraps on the z=1 opt-in) and
// a substring assert is exact. Returns true when both checks are clean.
func assertEmptyNodesRaw(t *testing.T, label, data string) bool {
	t.Helper()
	ok := true
	if !strings.Contains(data, `"nodes":[]`) {
		t.Errorf("%s: empty-store tree.snapshot must serialize \"nodes\":[] (got data=%.200s) — ghost-row regression (514ff2c)", label, data)
		ok = false
	}
	if strings.Contains(data, `"nodes":null`) {
		t.Errorf("%s: empty-store tree.snapshot serialized \"nodes\":null — the client decoder rejects it and strands the stale tree (ghost-row regression, 514ff2c); data=%.200s", label, data)
		ok = false
	}
	return ok
}

func TestE2E_Tree_ArchiveLastSessionEmptySnapshotHeal(t *testing.T) {
	c, err := StartCluster()
	if err != nil {
		t.Fatalf("StartCluster: %v", err)
	}
	defer c.Close()
	base := c.WorkerVHURL

	// --- 1. Open THE stream (kept open across every archive below) and wait
	// for store hydration: the frontier must ship the three seeded roots. A
	// pre-hydration EMPTY frontier would false-positive the empty-store
	// assertions later, so each poll attempt reconnects for a fresh initial
	// snapshot until the roots are present.
	hydrateDeadline := time.Now().Add(15 * time.Second)
	var (
		pinned   *http.Response
		rd       *streamReader
		initial  treeSnapshot
		cursorID string
	)
	for {
		pinned = openTreeStreamAt(t, base, "")
		rd = newStreamReader(pinned.Body)
		f := rd.next(t, hydrateDeadline)
		if f.Event != "tree.snapshot" {
			pinned.Body.Close()
			t.Fatalf("first event on fresh tree stream: want tree.snapshot, got %s", f.Event)
		}
		if err := json.Unmarshal([]byte(f.Data), &initial); err != nil {
			pinned.Body.Close()
			t.Fatalf("decode initial snapshot: %v (data=%.200s)", err, f.Data)
		}
		ids := nodeIDs(initial)
		if ids["demo"] && ids["other"] && ids["slow"] {
			cursorID = f.ID
			break
		}
		pinned.Body.Close()
		if time.Now().After(hydrateDeadline) {
			t.Fatalf("store did not hydrate in time (frontier so far: %v)", ids)
		}
		time.Sleep(100 * time.Millisecond)
	}
	defer pinned.Body.Close()
	if cursorID == "" {
		t.Fatal("initial snapshot carried no id (resume cursor)")
	}
	t.Logf("setup: open stream hydrated, frontier=%v, cursor=%s", nodeIDs(initial), cursorID)

	// --- Enumerate the fixture's live sessions and pick the finale: a ROOT
	// (no parentID) that ships in the frontier, so the emitter KNOWS it and
	// its node.remove is guaranteed emittable. Deterministic: last sorted.
	live := listLiveSessions(t, base)
	if len(live) == 0 {
		t.Fatal("fixture listing has no live sessions to archive")
	}
	frontier := nodeIDs(initial)
	var roots []string
	for _, s := range live {
		if s.ParentID == "" && frontier[s.ID] {
			roots = append(roots, s.ID)
		}
	}
	if len(roots) == 0 {
		t.Fatalf("no live root in the initial frontier (live=%v frontier=%v)", live, frontier)
	}
	sort.Strings(roots)
	finale := roots[len(roots)-1]

	// --- 2. Archive everyone else first, waiting for the fixture listing to
	// settle to exactly [finale] after each cascade (the PATCH marks the fake
	// synchronously; polling beats a fixed sleep and proves the store reaches
	// exactly-one-live before the finale). Archiving a root cascades to its
	// live descendants, so already-archived children re-issued here are
	// idempotent no-ops (documented runArchiveCascade contract).
	for _, s := range live {
		if s.ID == finale {
			continue
		}
		archiveSessionAt(t, base, s.ID)
	}
	waitLiveListing(t, base, finale, time.Now().Add(10*time.Second))

	// --- 3. Archive the LAST live session. archiveSessionAt returns only
	// after the 200 response body is fully consumed; the cascade that emits
	// node.remove runs asynchronously from that point on (the handler spawns
	// runArchiveCascade BEFORE writing the 200 — archive.go — so a strict
	// server-side 200-before-remove ordering is NOT a hard invariant; what is
	// contractual, and what the frontend eager prune compensates for, is that
	// the caller holds the 200 while the remove is still delivered on the
	// open stream). postOK/removeRead record that client-side ordering.
	archiveSessionAt(t, base, finale)
	postOK := time.Now()

	// Zero live sessions in the fixture — the project is empty.
	if rem := listLiveSessions(t, base); len(rem) != 0 {
		t.Fatalf("fixture still lists %d live sessions after archiving all (want 0): %v", len(rem), rem)
	}

	// --- 4. The open stream must deliver tree.op node.remove for the finale.
	removeDeadline := time.Now().Add(10 * time.Second)
	rmFrame := rd.until(t, removeDeadline, func(f sseFrame) bool {
		return f.Event == "tree.op" &&
			strings.Contains(f.Data, `"node.remove"`) &&
			strings.Contains(f.Data, finale)
	})
	removeRead := time.Now()
	// Defensible ordering assert (cannot flake): the frame was READ strictly
	// after the 200 response had been consumed. The observed delta documents
	// the async-cascade delivery window; see the comment above step 3.
	if removeRead.Before(postOK) {
		t.Fatalf("node.remove(%s) read at %v, before the archive 200 was consumed at %v", finale, removeRead, postOK)
	}
	t.Logf("PASS: node.remove(%s) received on the OPEN stream %dms after the archive POST returned 200 (async cascade contract; frame id=%s data=%.120s)",
		finale, removeRead.Sub(postOK).Milliseconds(), rmFrame.ID, rmFrame.Data)

	// --- 5. Reconnect #1 with the pre-archive cursor. On a valid-cursor
	// tree=2 reconnect the server replays missed ring deltas and THEN always
	// emits an authoritative tree.snapshot (cause "reconnect") —
	// pkg/web/server.go's resume path — so the empty-frontier re-seed frame
	// deterministically arrives on every reconnect flavor (replay or
	// ring-gap); scan until it does.
	rec1 := openTreeStreamAt(t, base, cursorID)
	defer rec1.Body.Close()
	rd1 := newStreamReader(rec1.Body)
	snap1Deadline := time.Now().Add(10 * time.Second)
	skipped1 := 0
	snap1 := rd1.until(t, snap1Deadline, func(f sseFrame) bool {
		if f.Event == "tree.snapshot" {
			return true
		}
		skipped1++
		return false
	})
	rawOK1 := assertEmptyNodesRaw(t, "reconnect #1 snapshot", snap1.Data)
	var snap1Decoded treeSnapshot
	if err := json.Unmarshal([]byte(snap1.Data), &snap1Decoded); err != nil {
		t.Fatalf("reconnect #1: decode snapshot: %v (data=%.200s)", err, snap1.Data)
	}
	empty1 := len(snap1Decoded.Nodes) == 0
	if !empty1 {
		t.Errorf("reconnect #1: empty store shipped %d nodes (want 0): %v", len(snap1Decoded.Nodes), nodeIDs(snap1Decoded))
	}
	resurrected1 := false
	for _, s := range live {
		if nodeIDs(snap1Decoded)[s.ID] {
			t.Errorf("reconnect #1: archived session %s resurrected in snapshot", s.ID)
			resurrected1 = true
		}
	}
	if rawOK1 && empty1 && !resurrected1 {
		t.Logf("PASS: reconnect #1 (cursor=%s) tree.snapshot serializes \"nodes\":[] (cause=%q, %d replayed frames skipped, raw=%.160s)",
			cursorID, causeOf(snap1.Data), skipped1, snap1.Data)
	}

	// --- 6. Reconnect #2 from reconnect #1's cursor, past the aggregator's
	// 5s reconcile tick (mirrors TestE2E_Tree_ArchiveBusyNoResurrection's
	// post-reconcile re-check): the empty store must STAY empty — no
	// resurrection by the reconcile/hydrate path either.
	time.Sleep(6 * time.Second)
	rec2 := openTreeStreamAt(t, base, snap1.ID)
	defer rec2.Body.Close()
	rd2 := newStreamReader(rec2.Body)
	snap2Deadline := time.Now().Add(10 * time.Second)
	skipped2 := 0
	snap2 := rd2.until(t, snap2Deadline, func(f sseFrame) bool {
		if f.Event == "tree.snapshot" {
			return true
		}
		skipped2++
		return false
	})
	rawOK2 := assertEmptyNodesRaw(t, "reconnect #2 snapshot (post-reconcile)", snap2.Data)
	var snap2Decoded treeSnapshot
	if err := json.Unmarshal([]byte(snap2.Data), &snap2Decoded); err != nil {
		t.Fatalf("reconnect #2: decode snapshot: %v (data=%.200s)", err, snap2.Data)
	}
	empty2 := len(snap2Decoded.Nodes) == 0
	if !empty2 {
		t.Errorf("reconnect #2: empty store shipped %d nodes after a reconcile tick (want 0): %v", len(snap2Decoded.Nodes), nodeIDs(snap2Decoded))
	}
	resurrected2 := false
	for _, s := range live {
		if nodeIDs(snap2Decoded)[s.ID] {
			t.Errorf("reconnect #2: archived session %s resurrected after reconcile tick", s.ID)
			resurrected2 = true
		}
	}
	if rawOK2 && empty2 && !resurrected2 {
		t.Logf("PASS: reconnect #2 (cursor=%s, post-reconcile) tree.snapshot still serializes \"nodes\":[] with zero nodes (cause=%q, %d frames skipped, raw=%.160s)",
			snap1.ID, causeOf(snap2.Data), skipped2, snap2.Data)
	}
}
