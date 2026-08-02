package web

// Per-project labels cutover — integration-style coverage for the new
// per-project store registry (task items 1, 2, 4): two projects load/mutate
// independent documents + revisions under distinct project-key dirs; a PUT for
// project A does not alter project B; and a stream's bootstrap/reconnect
// snapshot contains ONLY the selected project's document.
//
// These complement labels_lifecycle_test.go (item 5: reconcile scoped to its
// project) and labels_stream_test.go (item 3: A's update absent from B's SSE).
// Migration coverage (items 6-9) lives in labels_migration_test.go.
//
// Lane: Go co-located unit (pkg/web/). Exercises the real HTTP stack via
// httptest.NewServer(srv.Handler()) with VH_STATE_DIR isolated per test.

import (
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// seedProjectAgg injects a fresh dead-URL aggregator for dir into srv.aggs (so
// activeRootProjectsForDir(dir) / aggForExisting(dir) find it without aggFor
// starting RunManaged against the dead URL), seeds the given root sessions, and
// returns the project's stable key.
func seedProjectAgg(t *testing.T, srv *Server, dir string, roots ...string) string {
	t.Helper()
	const deadURL = "http://127.0.0.1:1"
	a := aggregator.New(deadURL, 100)
	srv.aggs[dir] = a
	for _, r := range roots {
		seedLabelSession(t, a, r, "")
	}
	return projectKey(dir)
}

// labelsProjectFile is the on-disk path the registry uses for a project's store.
func labelsProjectFile(key string) string {
	return filepath.Join(stateBaseDir(), "projects", key, "labels.json")
}

// putLabelsDir issues a CSRF-bearing PUT /vh/labels?dir=<dir> with one group
// carrying roots and returns the decoded response doc. Fatals on non-200.
func putLabelsDir(t *testing.T, webURL, dir string, baseRevision int64, groupID string, roots []string) LabelsDoc {
	t.Helper()
	resp := labelsPut(t, webURL+"/vh/labels?dir="+url.QueryEscape(dir), map[string]any{
		"baseRevision": baseRevision,
		"groups": []map[string]any{
			{"id": groupID, "name": "G", "color": "blue", "orderedRootSessionIds": roots},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("PUT /vh/labels?dir=%s baseRev=%d: status %d, want 200. body: %s", dir, baseRevision, resp.StatusCode, b)
	}
	return decodeLabelsResp(t, resp.Body)
}

// TestLabelsPerProject_TwoProjectsIndependent proves the registry keeps two
// projects on fully independent stores: distinct docs, distinct revisions, and
// distinct on-disk files under their own project-key dirs. A PUT that advances
// project A's revision leaves project B's doc and revision untouched (item 2).
func TestLabelsPerProject_TwoProjectsIndependent(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	dirA := t.TempDir()
	dirB := t.TempDir()
	keyA := seedProjectAgg(t, srv, dirA, "a-root")
	keyB := seedProjectAgg(t, srv, dirB, "b-root")
	if keyA == keyB {
		t.Fatalf("project keys collided — distinct dirs resolved to the same key")
	}

	// PUT to A → rev 1 with [a-root].
	docA1 := putLabelsDir(t, web.URL, dirA, 0, "gA", []string{"a-root"})
	if docA1.Revision != 1 || !labelsHasRootRef(docA1, "a-root") {
		t.Fatalf("project A PUT#1 = %+v, want rev 1 with a-root", docA1)
	}
	// PUT to B → rev 1 with [b-root] (independent CAS domain).
	docB1 := putLabelsDir(t, web.URL, dirB, 0, "gB", []string{"b-root"})
	if docB1.Revision != 1 || !labelsHasRootRef(docB1, "b-root") {
		t.Fatalf("project B PUT#1 = %+v, want rev 1 with b-root", docB1)
	}

	// The two docs must be isolated: A must not carry b-root and vice versa.
	if labelsHasRootRef(docA1, "b-root") {
		t.Fatalf("project A doc leaked project B's root b-root")
	}
	if labelsHasRootRef(docB1, "a-root") {
		t.Fatalf("project B doc leaked project A's root a-root")
	}

	// A second PUT to A advances A to rev 2 but must NOT alter B. Seed the new
	// root BEFORE the PUT (the store validates newly-referenced roots).
	seedLabelSession(t, srv.aggs[dirA], "a-root-2", "")
	docA2 := putLabelsDir(t, web.URL, dirA, 1, "gA", []string{"a-root", "a-root-2"})
	if docA2.Revision != 2 {
		t.Fatalf("project A PUT#2 rev = %d, want 2", docA2.Revision)
	}
	docBAfter := labelsGetDir(t, web.URL, dirB)
	if docBAfter.Revision != 1 {
		t.Fatalf("project B revision changed to %d after a PUT to A (must stay 1)", docBAfter.Revision)
	}
	if !labelsHasRootRef(docBAfter, "b-root") || labelsHasRootRef(docBAfter, "a-root") {
		t.Fatalf("project B doc changed after a PUT to A: %+v", docBAfter)
	}

	// On-disk: each project's doc is persisted under its OWN project-key dir,
	// and the two paths are distinct.
	fileA := labelsProjectFile(keyA)
	fileB := labelsProjectFile(keyB)
	if fileA == fileB {
		t.Fatalf("project file paths are identical: %s", fileA)
	}
	if _, err := os.Stat(fileA); err != nil {
		t.Fatalf("project A file not persisted at %s: %v", fileA, err)
	}
	if _, err := os.Stat(fileB); err != nil {
		t.Fatalf("project B file not persisted at %s: %v", fileB, err)
	}
}

// TestLabelsPerProject_ReconnectSnapshotScoped proves a stream's bootstrap
// snapshot carries ONLY the selected project's document: a subscriber on project
// A receives A's labeled roots in labels.snapshot and NEVER project B's roots,
// even after B is mutated (item 4).
func TestLabelsPerProject_ReconnectSnapshotScoped(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	dirA := t.TempDir()
	dirB := t.TempDir()
	seedProjectAgg(t, srv, dirA, "a-root")
	seedProjectAgg(t, srv, dirB, "b-root")

	// Establish labels in BOTH projects (rev 1 each, independent).
	putLabelsDir(t, web.URL, dirA, 0, "gA", []string{"a-root"})
	putLabelsDir(t, web.URL, dirB, 0, "gB", []string{"b-root"})

	// Subscribe to project A's stream.
	sa, err := http.Get(web.URL + "/vh/stream?dir=" + url.QueryEscape(dirA))
	if err != nil {
		t.Fatalf("GET /vh/stream?dir=A: %v", err)
	}
	defer sa.Body.Close()
	cha := startSSEReader(t, sa.Body)
	initA := drainIdle(cha, 500*time.Millisecond)

	data, ok := eventDataFor(initA, "labels.snapshot", "revision")
	if !ok {
		t.Fatalf("project A stream missing labels.snapshot; events: %v", eventNames(initA))
	}
	snapA := decodeLabelsSSEData(t, data)
	if !labelsHasRootRef(snapA, "a-root") {
		t.Fatalf("project A snapshot missing a-root: %+v", snapA)
	}
	if labelsHasRootRef(snapA, "b-root") {
		t.Fatalf("project A snapshot LEAKED project B's root b-root — snapshot must be scoped to the stream's project: %+v", snapA)
	}

	// Mutate project B; project A's stream must NOT see it as a snapshot or an
	// update (B's labels.updated fans out to B's aggregator only). Seed the new
	// root BEFORE the PUT.
	seedLabelSession(t, srv.aggs[dirB], "b-root-2", "")
	putLabelsDir(t, web.URL, dirB, 1, "gB", []string{"b-root", "b-root-2"})
	evA := drainIdle(cha, 1*time.Second)
	if hasEvent(evA, "labels.updated") {
		t.Fatalf("project A stream received project B's labels.updated — per-project stream isolation broken; events: %v", eventNames(evA))
	}

	// Reconnect project A: the fresh snapshot must STILL carry only A's doc.
	rb, _ := http.NewRequest(http.MethodGet, web.URL+"/vh/stream?dir="+url.QueryEscape(dirA), nil)
	srb, err := http.DefaultClient.Do(rb)
	if err != nil {
		t.Fatalf("reconnect GET /vh/stream?dir=A: %v", err)
	}
	defer srb.Body.Close()
	chrb := startSSEReader(t, srb.Body)
	reconn := drainIdle(chrb, 500*time.Millisecond)
	rdata, rok := eventDataFor(reconn, "labels.snapshot", "revision")
	if !rok {
		t.Fatalf("reconnect missing labels.snapshot; events: %v", eventNames(reconn))
	}
	rSnap := decodeLabelsSSEData(t, rdata)
	if labelsHasRootRef(rSnap, "b-root") || labelsHasRootRef(rSnap, "b-root-2") {
		t.Fatalf("reconnect snapshot leaked project B roots into project A's stream: %+v", rSnap)
	}
	if !labelsHasRootRef(rSnap, "a-root") {
		t.Fatalf("reconnect snapshot lost project A's own root a-root: %+v", rSnap)
	}
}
