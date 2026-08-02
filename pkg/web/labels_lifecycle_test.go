package web

// Lifecycle cleanup tests for Slice 3 of server-managed root-session labels.
//
// Mirrors pkg/web/pins_lifecycle_test.go section-for-section, adapting for the
// labels-specific differences:
//   - ROOT-ONLY: the active set is RootInventory() filtered to IsRoot, NOT
//     SessionIDs(). A label target must be a true root.
//   - DEFINITIONS SURVIVE: RemoveRootIDs strips root REFERENCES from group
//     OrderedRootSessionIDs + TagIDsByRootSessionID (+ the sidecar), but KEEPS
//     the group/tag definitions. Every cleanup test additionally asserts the
//     authored group/tag definitions survive the root-reference strip.
//   - SIDECAR ACCESSOR: the private projectByRootSessionId sidecar (cleanup
//     metadata, never on the wire) is accessed via labelsReconcileSnapshot (an
//     atomic doc+sidecar snapshot defined in server.go, same package) rather
//     than through the public Snapshot (which deliberately hides it).
//
// THREE cleanup layers (archive.go doc block has the full model), with ONE
// justified deviation from the pins test structure:
//   - L1 direct archive hook: pins have removePinsAndBroadcast called directly
//     from handleArchive (archive.go). Labels have NO direct L1 hook — archive.go
//     is out of scope this slice. Archive cleanup for labels happens SOLELY via
//     the L2 subscriber (archive's RemoveSessions emits KindSessionDelete → L2
//     catches it). The L2 tests below drive RemoveSessions directly — the exact
//     same normalized delete chokepoint archive.go uses — so the archive→cleanup
//     behavior is fully covered. The L3 post-hydrate backstop is the
//     authoritative correctness guarantee regardless.
//   - L2 session.delete subscriber: a store-emitted KindSessionDelete strips the
//     deleted root's references (best-effort, async via the subscriber channel).
//   - L3 post-hydrate backstop: reconcileLabelsForProject removes a project's
//     root references absent from the authoritative active-ROOT set, scoped
//     strictly by projectByRootSessionId (never an unopened project's roots); the
//     driver reconcileLabelsForAgg is fail-closed until AnyHydrateCompleted().
//
// Lane: Go co-located unit (pkg/web/). L2/L3 use newLabelsTestServer (isolated
// VH_STATE_DIR) and drive the store / call the reconcile methods directly —
// deterministic, no async hydrate timing, mirroring the GC-2/GC-3 queue test
// strategy (core logic directly + driver fail-closed gate).
//
// The cleanup→broadcast rule is exercised through removeLabelsAndBroadcast (the
// shared primitive L2 and L3 call). Broadcast is asserted end-to-end via
// /vh/stream SSE in one L2 and one L3 test; the other tests assert state via GET
// /vh/labels (revision bump + membership + definition survival), since the
// broadcast primitive itself was covered by labels_stream_test.go.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// labelsGet fetches the current public labels doc. Mirrors pinsGet.
func labelsGet(t *testing.T, url string) LabelsDoc {
	t.Helper()
	resp, err := http.Get(url + "/vh/labels")
	if err != nil {
		t.Fatalf("GET /vh/labels: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("GET /vh/labels: status %d, want 200", resp.StatusCode)
	}
	return decodeLabelsResp(t, resp.Body)
}

// labelsGetDir fetches the public labels doc for a SPECIFIC project dir (per-
// project cutover). dir is passed via ?dir= so the server resolves the project's
// own store.
func labelsGetDir(t *testing.T, webURL, dir string) LabelsDoc {
	t.Helper()
	resp, err := http.Get(webURL + "/vh/labels?dir=" + url.QueryEscape(dir))
	if err != nil {
		t.Fatalf("GET /vh/labels?dir=%s: %v", dir, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("GET /vh/labels?dir=%s: status %d, want 200", dir, resp.StatusCode)
	}
	return decodeLabelsResp(t, resp.Body)
}

// labelsHasRootRef reports whether root id is referenced anywhere in the doc
// (any group's OrderedRootSessionIDs OR a TagIDsByRootSessionID key). Mirrors
// pinsHasID but over the labels root-reference surface.
func labelsHasRootRef(r LabelsDoc, id string) bool {
	return labelsRootIDs(r)[id]
}

// labelsHasGroupDef reports whether a group DEFINITION (by id) survives in the
// doc. Labels-specific: cleanup strips root references but keeps definitions.
func labelsHasGroupDef(r LabelsDoc, id string) bool {
	for _, g := range r.Groups {
		if g.ID == id {
			return true
		}
	}
	return false
}

// labelsHasTagDef reports whether a tag DEFINITION (by id) survives in the doc.
// Labels-specific: cleanup strips root references but keeps definitions.
func labelsHasTagDef(r LabelsDoc, id string) bool {
	for _, tg := range r.Tags {
		if tg.ID == id {
			return true
		}
	}
	return false
}

// waitForLabelRootGone polls GET /vh/labels until id is absent from all root
// references (subscriber/reconcile delivery is async). Mirrors waitForPinGone.
func waitForLabelRootGone(t *testing.T, web *httptest.Server, id, msg string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !labelsHasRootRef(labelsGet(t, web.URL), id) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("%s: root %q still referenced after 2s", msg, id)
}

// waitForLabelRootGoneDir is the per-project variant: polls GET /vh/labels?dir=
// for a specific project's store until id is absent from its doc.
func waitForLabelRootGoneDir(t *testing.T, web *httptest.Server, dir, id, msg string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !labelsHasRootRef(labelsGetDir(t, web.URL, dir), id) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("%s: root %q still referenced after 2s", msg, id)
}

// assertLabelsRevision asserts the current labels doc revision. Mirrors
// assertPinsRevision.
func assertLabelsRevision(t *testing.T, web *httptest.Server, want int64, msg string) {
	t.Helper()
	if r := labelsGet(t, web.URL); r.Revision != want {
		t.Fatalf("%s: revision = %d, want %d", msg, r.Revision, want)
	}
}

// labelDefaultRoots seeds the given root ids in the DEFAULT project's aggregator
// and labels them (in one group) in the default project's labels doc, leaving it
// at rev 1. Returns the default project's stable key. Used by the L3 reconcile
// tests, which now operate per-project (the cutover moved each project onto its
// own store, so a single doc can no longer hold two projects' roots).
func labelDefaultRoots(t *testing.T, srv *Server, web *httptest.Server, ids ...string) (defaultKey string) {
	t.Helper()
	if len(ids) == 0 {
		t.Fatal("labelDefaultRoots: need at least one root id")
	}
	for _, id := range ids {
		seedLabelSession(t, srv.agg, id, "")
	}
	ordered := make([]string, 0, len(ids))
	ordered = append(ordered, ids...)
	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": ordered},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("labelDefaultRoots PUT: status %d, want 200. body: %s", resp.StatusCode, b)
	}
	resp.Body.Close()
	return projectKey(mustProjectRoot(t, ""))
}

// ============================================================================
// Layer 2 — session.delete subscriber (server.go installLabelsLifecycle)
// ============================================================================

// TestLabelsL2_SessionDeleteRemovesRootRefs: a store-emitted KindSessionDelete
// (via RemoveSessions, the archive-equivalent delete chokepoint) reaches the L2
// subscriber and strips the deleted root's references from group orders AND tag
// assignments, while the group/tag DEFINITIONS survive. Delivery is async, so we
// poll.
func TestLabelsL2_SessionDeleteRemovesRootRefs(t *testing.T) {
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
	resp.Body.Close()

	// Install the L2 subscriber (lazy on first aggFor("")).
	_ = srv.aggFor("")

	// Fire KindSessionDelete via the normalized delete chokepoint.
	srv.agg.Store().RemoveSessions([]string{"root-a"})
	waitForLabelRootGone(t, web, "root-a", "L2 RemoveSessions")
	assertLabelsRevision(t, web, 2, "L2 delete should bump revision")

	// Labels-specific: definitions survive the root-reference strip.
	g := labelsGet(t, web.URL)
	if !labelsHasGroupDef(g, "g1") {
		t.Fatalf("L2 delete: group definition g1 was removed — definitions must survive root-reference cleanup")
	}
	if !labelsHasTagDef(g, "t1") {
		t.Fatalf("L2 delete: tag definition t1 was removed — definitions must survive root-reference cleanup")
	}
	// The tag assignment for root-a must be gone.
	if _, ok := g.TagIDsByRootSessionID["root-a"]; ok {
		t.Fatalf("L2 delete: tag assignment for root-a survived (should be stripped)")
	}
}

// TestLabelsL2_RawSessionDeletedRemovesRootRef: the raw session.deleted event path
// (also funnels through deleteSessionLocked → KindSessionDelete) is caught too.
func TestLabelsL2_RawSessionDeletedRemovesRootRef(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	seedLabelSession(t, srv.agg, "root-a", "")
	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"root-a"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	resp.Body.Close()
	_ = srv.aggFor("")

	srv.agg.Store().Apply(ev("session.deleted", `{"info":{"id":"root-a"}}`))
	waitForLabelRootGone(t, web, "root-a", "L2 raw session.deleted")
}

// TestLabelsL2_DeleteUnlabeledRootIsNoOp: deleting a root that is NOT referenced
// by any label must NOT bump the revision or broadcast (RemoveRootIDs is a no-op
// when the id is absent; changed==false → nothing). This is the idempotent/
// no-spurious-broadcast contract.
func TestLabelsL2_DeleteUnlabeledRootIsNoOp(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	seedLabelSession(t, srv.agg, "labeled", "")
	seedLabelSession(t, srv.agg, "unlabeled", "")
	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"labeled"}}, // only "labeled"
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	resp.Body.Close()
	_ = srv.aggFor("")

	// Delete the UNLABELED root. Revision must stay at 1 (no broadcast).
	srv.agg.Store().RemoveSessions([]string{"unlabeled"})

	// Poll the negative condition: revision must not advance.
	deadline := time.Now().Add(250 * time.Millisecond)
	for time.Now().Before(deadline) {
		if r := labelsGet(t, web.URL); r.Revision != 1 {
			t.Fatalf("L2 no-op: deleting unlabeled root bumped revision to %d", r.Revision)
		}
		time.Sleep(10 * time.Millisecond)
	}
	// The labeled root must survive.
	if !labelsHasRootRef(labelsGet(t, web.URL), "labeled") {
		t.Fatalf("L2 no-op: labeled root was removed by an unrelated delete")
	}
}

// TestLabelsL2_SubscriberBroadcastsUpdate confirms the L2 path broadcasts: a
// /vh/stream subscriber receives labels.updated after a session.delete.
func TestLabelsL2_SubscriberBroadcastsUpdate(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	seedLabelSession(t, srv.agg, "root-a", "")
	resp := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"root-a"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	resp.Body.Close()

	sresp, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatalf("GET /vh/stream: %v", err)
	}
	defer sresp.Body.Close()
	ch := startSSEReader(t, sresp.Body)
	drainIdle(ch, 500*time.Millisecond)

	_ = srv.aggFor("")
	srv.agg.Store().RemoveSessions([]string{"root-a"})

	events := drainIdle(ch, 1*time.Second)
	data, ok := eventDataFor(events, "labels.updated", "revision")
	if !ok {
		t.Fatalf("L2 delete did not broadcast labels.updated; events: %v", eventNames(events))
	}
	upd := decodeLabelsSSEData(t, data)
	if upd.Revision != 2 {
		t.Fatalf("L2 labels.updated revision = %d, want 2", upd.Revision)
	}
}

// ============================================================================
// Layer 3 — post-hydrate backstop (server.go reconcileLabelsForAgg / Project)
// ============================================================================
//
// The driver reconcileLabelsForAgg gates fail-closed on AnyHydrateCompleted()
// and then delegates to reconcileLabelsForProject(key, activeRoots). Mirroring
// the GC-3 queue reconcile test strategy, the core reconcile logic is tested
// directly (reconcileLabelsForProject with hand-built active sets + the atomic
// labelsReconcileSnapshot accessor for the sidecar) and the driver's fail-closed
// gate is tested separately (AnyHydrateCompleted()==false → no-op). The
// driver's success-path delegation is covered compositionally by these two
// halves — exactly as the pins L3 tests do.

// TestLabelsL3_RemovesAbsentProjectRootScoped: reconcileLabelsForProject removes
// a project's root reference absent from the authoritative active set, while
// preserving a same-project root that IS active. (Per-project cutover: each
// project owns its own doc, so "another project's root" can no longer co-exist
// in this doc — the cross-project isolation is covered by
// TestLabelsL3_ReconcileOneProjectLeavesOtherUntouched instead.) Labels-specific:
// group/tag definitions survive the removal.
func TestLabelsL3_RemovesAbsentProjectRootScoped(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	defaultKey := labelDefaultRoots(t, srv, web, "def-keep")
	// Also label a second default-project root that will be "deleted" (absent
	// from the authoritative active set), plus a tag assignment on it.
	seedLabelSession(t, srv.agg, "def-gone", "")
	r := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": 1, // labelDefaultRoots left it at 1
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"def-keep", "def-gone"}},
		},
		"tags":                  []map[string]any{{"id": "t1", "name": "urgent", "color": "red"}},
		"tagIdsByRootSessionId": map[string][]string{"def-gone": {"t1"}},
	})
	r.Body.Close()

	// Authoritative active set for the DEFAULT project: def-keep present,
	// def-gone ABSENT (deleted while worker was down).
	doc, projects := srv.labelsForDir("").labelsReconcileSnapshot()
	srv.reconcileLabelsForProject("", doc, projects, defaultKey, map[string]bool{"def-keep": true})

	g := labelsGet(t, web.URL)
	if labelsHasRootRef(g, "def-gone") {
		t.Fatalf("L3: absent default-project root def-gone survived reconcile")
	}
	if !labelsHasRootRef(g, "def-keep") {
		t.Fatalf("L3: active default-project root def-keep was wrongly removed")
	}
	// labelDefaultRoots left the doc at rev 1; the second PUT bumped it to 2;
	// this reconcile removes def-gone → rev 3.
	assertLabelsRevision(t, web, 3, "L3 scoped remove should bump revision once")

	// Labels-specific: definitions survive the root-reference strip.
	if !labelsHasGroupDef(g, "g1") {
		t.Fatalf("L3: group definition g1 was removed — definitions must survive")
	}
	if !labelsHasTagDef(g, "t1") {
		t.Fatalf("L3: tag definition t1 was removed — definitions must survive")
	}

	// Reconcile must be idempotent: a second pass with the same set removes
	// nothing (def-gone already gone) and does not bump the revision.
	doc2, projects2 := srv.labelsForDir("").labelsReconcileSnapshot()
	srv.reconcileLabelsForProject("", doc2, projects2, defaultKey, map[string]bool{"def-keep": true})
	assertLabelsRevision(t, web, 3, "L3 idempotent re-reconcile must not bump revision")
}

// TestLabelsL3_EmptyActiveSetRemovesAllProjectRoots: a project that hydrated with
// ZERO roots (authoritative empty set) removes ALL of that project's root
// references. This is the case that catches roots deleted while the worker was
// down.
func TestLabelsL3_EmptyActiveSetRemovesAllProjectRoots(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	defaultKey := labelDefaultRoots(t, srv, web, "def-a", "def-b")
	// doc at rev 1 with [def-a, def-b].

	// Empty NON-nil active set = "hydrate succeeded with zero roots." Both
	// default-project roots are genuinely absent → removed.
	doc, projects := srv.labelsForDir("").labelsReconcileSnapshot()
	srv.reconcileLabelsForProject("", doc, projects, defaultKey, map[string]bool{})

	g := labelsGet(t, web.URL)
	if labelsHasRootRef(g, "def-a") || labelsHasRootRef(g, "def-b") {
		t.Fatalf("L3 empty-set: default-project roots survived")
	}
}

// TestLabelsL3_ReconcileOneProjectLeavesOtherUntouched is the per-project scope
// fence (replaces the former cross-project-roots-in-one-doc test): reconciling
// project A's store with an empty active set removes A's own roots AND leaves
// project B's store ENTIRELY untouched. After the cutover the two projects live
// in independent stores, so a reconcile for A can never reach into B's doc — the
// strongest form of the "never drop another project's roots" guarantee.
func TestLabelsL3_ReconcileOneProjectLeavesOtherUntouched(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	// Default project: label def-a (rev 1).
	defaultKey := labelDefaultRoots(t, srv, web, "def-a")
	// Second project /proj2: open its aggregator, seed a root, label it via the
	// per-project (?dir=) endpoint so it lands in proj2's OWN store.
	const deadURL = "http://127.0.0.1:1"
	proj2 := aggregator.New(deadURL, 100)
	srv.aggs["/proj2"] = proj2
	seedLabelSession(t, proj2, "proj2-sess", "")
	resp := labelsPut(t, web.URL+"/vh/labels?dir="+url.QueryEscape("/proj2"), map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"proj2-sess"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("proj2 label PUT: status %d, want 200. body: %s", resp.StatusCode, b)
	}
	resp.Body.Close()

	// Reconcile the DEFAULT project with an EMPTY active set → removes def-a.
	doc, projects := srv.labelsForDir("").labelsReconcileSnapshot()
	srv.reconcileLabelsForProject("", doc, projects, defaultKey, map[string]bool{})

	// Default doc: def-a gone.
	if labelsHasRootRef(labelsGet(t, web.URL), "def-a") {
		t.Fatalf("L3: default root def-a survived empty-set reconcile (should be removed)")
	}
	// proj2 doc: proj2-sess MUST survive and its revision MUST be untouched —
	// reconciling the default project cannot reach a different project's store.
	proj2Doc := labelsGetDir(t, web.URL, "/proj2")
	if !labelsHasRootRef(proj2Doc, "proj2-sess") {
		t.Fatalf("L3: proj2 root proj2-sess was removed by the default project's reconcile — per-project isolation violation")
	}
	if proj2Doc.Revision != 1 {
		t.Fatalf("L3: proj2 doc revision = %d, want 1 (untouched by default's reconcile)", proj2Doc.Revision)
	}
}

// TestLabelsL3_NoRemovalWhenAllPresent: if every project-scoped root reference is
// in the authoritative active set, reconcile removes nothing and does not bump
// the revision (no spurious broadcast).
func TestLabelsL3_NoRemovalWhenAllPresent(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	defaultKey := labelDefaultRoots(t, srv, web, "def-a")

	before := labelsGet(t, web.URL)
	doc, projects := srv.labelsForDir("").labelsReconcileSnapshot()
	srv.reconcileLabelsForProject("", doc, projects, defaultKey, map[string]bool{"def-a": true})
	after := labelsGet(t, web.URL)

	if after.Revision != before.Revision {
		t.Fatalf("L3: revision bumped from %d to %d when no root was absent", before.Revision, after.Revision)
	}
}

// TestLabelsL3_DriverFailClosedWhenNotHydrated: reconcileLabelsForAgg must delete
// NOTHING when the aggregator has not yet completed a hydrate
// (AnyHydrateCompleted() is false). This is the fail-closed gate: absence from
// an unopened/failed/incomplete hydrate is NOT proof of deletion. Mirrors the
// GC-3 queue reconcile gate test.
func TestLabelsL3_DriverFailClosedWhenNotHydrated(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	labelDefaultRoots(t, srv, web, "def-a")

	// newLabelsTestServer does NOT start the aggregator's Run loop, so
	// AnyHydrateCompleted() is false — exactly the boot race this gate defends.
	if srv.agg.AnyHydrateCompleted() {
		t.Fatalf("precondition: aggregator already hydrated; test harness assumption violated")
	}

	before := labelsGet(t, web.URL)
	// The production trigger path would call exactly this. With
	// AnyHydrateCompleted()==false it must short-circuit, removing nothing — even
	// though def-a is "absent" from the store's root inventory.
	srv.reconcileLabelsForAgg("", srv.agg)
	after := labelsGet(t, web.URL)

	if after.Revision != before.Revision {
		t.Fatalf("L3 driver: revision bumped %d -> %d under not-yet-hydrated aggregator; FAIL-CLOSED violation",
			before.Revision, after.Revision)
	}
}

// TestLabelsL3_RootAddedAfterSnapshotSurvives is the F1 TOCTOU regression. The
// race it pins: in the driver, the active-root set must be derived AFTER the
// labels-doc snapshot — never before. If the labels doc were snapshotted AFTER
// the active set, a root added in between (a concurrent PUT whose root was
// created after the active-set read) would be present in the fresher doc
// snapshot yet absent from the stale active set, and would be wrongly removed —
// permanently losing a valid server-managed root reference.
//
// This test exercises the fix at the core API: reconcileLabelsForProject takes
// the labels-doc snapshot + sidecar as parameters, so we pass a snapshot taken
// BEFORE a new root is added, alongside an active set that does NOT include the
// new root's session (simulating the new root being created after the
// inventory). The new root MUST survive because it is not in the snapshot the
// reconcile iterates.
func TestLabelsL3_RootAddedAfterSnapshotSurvives(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	defaultKey := labelDefaultRoots(t, srv, web, "preexisting")

	// T0: snapshot the labels doc + sidecar BEFORE the "new" root exists. This
	// is the snapshot the driver would pass under the F1-fixed ordering.
	docAtT0, projectsAtT0 := srv.labelsForDir("").labelsReconcileSnapshot()
	if !labelsHasRootRef(docAtT0, "preexisting") {
		t.Fatalf("precondition: preexisting root missing from T0 snapshot")
	}

	// (T0, T1): a concurrent PUT adds a brand-new root whose session was created
	// after the active-set snapshot. Seed + label "fresh" now.
	seedLabelSession(t, srv.agg, "fresh", "")
	r := labelsPut(t, web.URL+"/vh/labels", map[string]any{
		"baseRevision": docAtT0.Revision, // current rev at the time of the PUT
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"preexisting", "fresh"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	if r.StatusCode != 200 {
		b, _ := io.ReadAll(r.Body)
		r.Body.Close()
		t.Fatalf("concurrent PUT adding fresh root: status %d, want 200. body: %s", r.StatusCode, b)
	}
	r.Body.Close()
	// "fresh" is now a valid labeled root in the live default-project store.

	// T1: the active set derived by the driver AFTER T0. Simulate the worst
	// case for the race — "fresh" is ABSENT from this set (its session was
	// created after the inventory was taken). "preexisting" is present.
	activeSetMissingFresh := map[string]bool{"preexisting": true}

	// Reconcile with the T0 (stale) labels-doc snapshot. Under the F1 fix, the
	// reconcile iterates only docAtT0's referenced roots (no "fresh"), so "fresh"
	// is not a removal candidate and survives even though it is absent from the
	// active set.
	srv.reconcileLabelsForProject("", docAtT0, projectsAtT0, defaultKey, activeSetMissingFresh)

	g := labelsGet(t, web.URL)
	if !labelsHasRootRef(g, "fresh") {
		t.Fatalf("F1 regression: root added after the snapshot was removed — a valid root reference must survive (TOCTOU reintroduced)")
	}
	if !labelsHasRootRef(g, "preexisting") {
		t.Fatalf("F1 regression: preexisting active root was wrongly removed")
	}
	// No root in the T0 snapshot was absent from the active set, so no removal
	// happened and the revision must not have advanced beyond the PUT.
	assertLabelsRevision(t, web, docAtT0.Revision+1, "F1: no removal should occur (revision = PUT only)")
}

// TestLabelsL3_ReconcileBroadcastsUpdate confirms the L3 path broadcasts: after a
// reconcile that removes a root reference, a /vh/stream subscriber receives
// labels.updated.
func TestLabelsL3_ReconcileBroadcastsUpdate(t *testing.T) {
	srv, web := newLabelsTestServer(t)
	defaultKey := labelDefaultRoots(t, srv, web, "def-gone")

	sresp, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatalf("GET /vh/stream: %v", err)
	}
	defer sresp.Body.Close()
	ch := startSSEReader(t, sresp.Body)
	drainIdle(ch, 500*time.Millisecond)

	// Reconcile removes def-gone (absent from the active set).
	doc, projects := srv.labelsForDir("").labelsReconcileSnapshot()
	srv.reconcileLabelsForProject("", doc, projects, defaultKey, map[string]bool{})

	events := drainIdle(ch, 1*time.Second)
	data, ok := eventDataFor(events, "labels.updated", "revision")
	if !ok {
		t.Fatalf("L3 reconcile did not broadcast labels.updated; events: %v", eventNames(events))
	}
	upd := decodeLabelsSSEData(t, data)
	if upd.Revision != 2 {
		t.Fatalf("L3 labels.updated revision = %d, want 2", upd.Revision)
	}
	if labelsHasRootRef(upd, "def-gone") {
		t.Fatalf("L3 labels.updated still references def-gone")
	}
	// Broadcast JSON must not leak projectByRootSessionId (internal field).
	if leaked, _ := json.Marshal(upd); strings.Contains(string(leaked), "projectByRootSessionId") {
		t.Fatalf("L3 labels.updated leaks projectByRootSessionId: %s", leaked)
	}
}

// ============================================================================
// Reload-reinstall — handleReloadProject resets labelsGCOn (Slice 3 F1 fix)
// ============================================================================
//
// Mirrors TestQueueGC_ReloadProjectReinstallsSubscriber at
// queue_lifecycle_test.go:290. handleReloadProject resets queueGCOn[dir] and
// pinsGCOn[dir] inside its cur==a teardown block; Slice 3 added labelsGCOn[dir]
// (the idempotency guard for installLabelsLifecycle) and this test pins the F1
// fix that handleReloadProject resets it too. Without the reset, the rebuilt
// per-dir aggregator's installLabelsLifecycle sees stale labelsGCOn[dir]==true,
// skips re-subscribing, and that project's session.delete events stop reaching
// removeLabelsAndBroadcast (L2 cleanup) until the next hydrate backstop.
//
// Seeding deviation from the queue test (necessitated by labels): the queue
// reload test seeds cleanup targets as on-disk queue.json files (no store
// validation). Labels PUT /vh/labels validates every referenced root against
// activeRootProjectsForDir(dir) — the per-dir active-root inventory derived from
// THAT aggregator's Store.RootInventory() — and a RUNNING aggregator
// (newReloadServer starts RunManaged) ghost-reconciles its store against the fake
// OpenCode's authoritative /session list, evicting a root applied via Apply that
// the backend never sourced. So the roots are seeded authoritatively via
// fake.sessions (the same pattern the integration tests use) and the hydrate is
// awaited before the labels PUT.
//
// Per-project cutover: all labels PUT/GET target dirB (?dir=) so they resolve
// dirB's OWN project store — the default-project endpoint would reject dirB's
// roots as unknown_root.
//
// Harness: newReloadServer (needs fakeOpenCode's /instance/dispose handler).
// dirB is t.TempDir() so projectRoot(dirB) resolves cleanly and auto-cleans.
func TestLabelsL2_ReloadProjectReinstallsSubscriber(t *testing.T) {
	// Isolate the per-project labels state (stateBaseDir()/VH_STATE_DIR). The
	// other reload tests can share state because they never touch the labels
	// store; this one does, and a non-isolated dir would persist a stale labels
	// doc across runs and collide with the optimistic-CAS PUTs below.
	// Mirrors newLabelsTestServer's isolation.
	t.Setenv("VH_STATE_DIR", t.TempDir())

	srv, fake, _, web := newReloadServer(t)

	dirB := t.TempDir() // absolute; projectRoot(dirB) == dirB
	dirBQuery := web.URL + "/vh/labels?dir=" + url.QueryEscape(dirB)

	// Seed BOTH roots authoritatively in the fake backend so any aggregator
	// that hydrates dirB sees them as live roots (surviving ghost-reconcile).
	// No parentID → IsRoot=true (the strict root definition labels require).
	fake.sessions = []string{`{"id":"s1"}`, `{"id":"s2"}`}

	// (1) Materialize a per-dir aggregator. aggFor arms it, installs the
	//     labels L2 subscriber (installLabelsLifecycle, guarded by
	//     labelsGCOn[dirB]=true), and starts RunManaged (which hydrates s1/s2).
	aB1 := srv.aggFor(dirB)
	waitFor(t, func() bool {
		for _, inv := range aB1.Store().RootInventory() {
			if inv.SessionID == "s1" {
				return true
			}
		}
		return false
	}, "aB1 hydrate s1")

	// (2) Sanity: the L2 subscriber is live on aB1. Label root "s1" in a group,
	//     fire session.deleted via the normalized delete chokepoint, confirm
	//     the root reference is stripped (L2 cleanup works pre-reload).
	resp := labelsPut(t, dirBQuery, map[string]any{
		"baseRevision": 0,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"s1"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("seed s1 PUT: status %d, want 200. body: %s", resp.StatusCode, b)
	}
	resp.Body.Close()
	aB1.Store().RemoveSessions([]string{"s1"})
	waitForLabelRootGoneDir(t, web, dirB, "s1", "pre-reload L2 subscriber cleanup")

	// (3) Reload dirB: disposes the OpenCode instance, Stops aB1, drops it
	//     from s.aggs, and (the F1 fix) resets labelsGCOn[dirB] so the next
	//     aggFor re-installs a fresh subscriber instead of skipping.
	rr := doReloadProject(t, web.URL, dirB)
	if sc := rr.StatusCode; sc != 200 {
		t.Fatalf("reload-project status: want 200, got %d", sc)
	}
	rr.Body.Close()

	// (4) Re-materialize. Must be a FRESH aggregator (not aB1) that re-hydrates
	//     s2 (s1 was deleted above; the labels doc no longer references it).
	aB2 := srv.aggFor(dirB)
	if aB2 == aB1 {
		t.Fatal("aggFor(dirB) returned the SAME aggregator after reload — not rebuilt")
	}
	waitFor(t, func() bool {
		for _, inv := range aB2.Store().RootInventory() {
			if inv.SessionID == "s2" {
				return true
			}
		}
		return false
	}, "aB2 hydrate s2")

	// (5) THE CONTRACT: the L2 subscriber was re-installed on aB2. Label root
	//     "s2", fire session.deleted on aB2's store, confirm the root reference
	//     is stripped. baseRevision tracks the live doc (rev advanced to 2 when
	//     the L2 subscriber stripped "s1"). If the subscriber had NOT been
	//     re-installed (the Slice 3 F1 bug — stale labelsGCOn[dirB]==true),
	//     "s2" would persist and waitForLabelRootGoneDir would fatal.
	baseRev := labelsGetDir(t, web.URL, dirB).Revision
	resp2 := labelsPut(t, dirBQuery, map[string]any{
		"baseRevision": baseRev,
		"groups": []map[string]any{
			{"id": "g1", "name": "G", "color": "blue", "orderedRootSessionIds": []string{"s2"}},
		},
		"tags":                  []any{},
		"tagIdsByRootSessionId": map[string][]string{},
	})
	if resp2.StatusCode != 200 {
		b, _ := io.ReadAll(resp2.Body)
		resp2.Body.Close()
		t.Fatalf("seed s2 PUT: status %d, want 200. body: %s", resp2.StatusCode, b)
	}
	resp2.Body.Close()
	aB2.Store().RemoveSessions([]string{"s2"})
	waitForLabelRootGoneDir(t, web, dirB, "s2", "post-reload L2 subscriber cleanup on fresh aggregator")
}
