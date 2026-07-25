package web

// Lifecycle cleanup tests for Phase 4 of server-managed pinned sessions.
//
// Covers all three cleanup layers (archive.go doc block has the full model):
//   - L1 direct archive hook: a successful /vh/archive unpins the affected
//     subtree; a failed archive (non-404/410) preserves the pin.
//   - L2 session.delete subscriber: a store-emitted KindSessionDelete removes
//     the pin (best-effort, async via the subscriber channel).
//   - L3 post-hydrate backstop: reconcilePinsForProject removes a project's
//     pins absent from the authoritative active set, scoped strictly by
//     projectBySessionId (never an unopened project's pins); the driver
//     reconcilePinsForAgg is fail-closed until HydratedOnce().
//
// Lane: Go co-located unit (pkg/web/). L1 exercises the real HTTP stack via
// queueLifecycleServer (fakeOC + /vh/archive). L2/L3 use newPinsTestServer
// (isolated VH_STATE_DIR) and drive the store / call the reconcile methods
// directly — deterministic, no async hydrate timing, mirroring the GC-2/GC-3
// queue test strategy (core logic directly + driver fail-closed gate).
//
// The cleanup→broadcast rule is exercised through removePinsAndBroadcast (the
// shared primitive all three layers call). Broadcast is asserted end-to-end via
// /vh/stream SSE in one L1 and one L2 test; the other tests assert state via
// GET /vh/pins (revision bump + membership), since the broadcast primitive
// itself was covered by Phase 3's pins_stream_test.go.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// pinsGet fetches the current public pin doc.
func pinsGet(t *testing.T, url string) pinsPublicResp {
	t.Helper()
	resp, err := http.Get(url + "/vh/pins")
	if err != nil {
		t.Fatalf("GET /vh/pins: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("GET /vh/pins: status %d, body %s", resp.StatusCode, b)
	}
	return decodePinsResp(t, resp.Body)
}

// pinsHasID reports whether id is in the ordered session list.
func pinsHasID(r pinsPublicResp, id string) bool {
	for _, x := range r.OrderedSessionIDs {
		if x == id {
			return true
		}
	}
	return false
}

// waitForPinGone polls GET /vh/pins until id is absent (subscriber/reconcile
// delivery is async). Mirrors waitForQueueGone.
func waitForPinGone(t *testing.T, web *httptest.Server, id, msg string) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if !pinsHasID(pinsGet(t, web.URL), id) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("%s: pin %q still present after 2s", msg, id)
}

// assertPinsRevision asserts the current pin doc revision.
func assertPinsRevision(t *testing.T, web *httptest.Server, want int64, msg string) {
	t.Helper()
	if r := pinsGet(t, web.URL); r.Revision != want {
		t.Fatalf("%s: revision = %d, want %d", msg, r.Revision, want)
	}
}

// ============================================================================
// Layer 1 — direct archive hook (pkg/web/archive.go handleArchive)
// ============================================================================

// TestPinsL1_ArchiveRemovesPin: a successfully-archived pinned session is
// removed from the PinStore and the revision bumps. Uses the real /vh/archive
// handler chain against a fakeOC (SetArchived returns 200).
func TestPinsL1_ArchiveRemovesPin(t *testing.T) {
	t.Setenv("VH_STATE_DIR", t.TempDir()) // isolate the PinStore
	f := &fakeOC{}
	web, agg, _, _ := queueLifecycleServer(t, f)

	seedPinSession(t, agg, "sess-a")
	// Establish the pin doc at revision 1 [sess-a].
	r := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"sess-a"},
	})
	r.Body.Close()

	// Archive sess-a via the real handler. fakeOC accepts the PATCH (200).
	resp, affected := postArchive(t, web.URL, "sess-a")
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive: status %d, want 200", resp.StatusCode)
	}
	if len(affected) != 1 || affected[0] != "sess-a" {
		t.Fatalf("affected = %v, want [sess-a]", affected)
	}

	// The pin must be gone and the revision must have bumped (cleanup ran).
	if pinsHasID(pinsGet(t, web.URL), "sess-a") {
		t.Fatalf("L1 archive: pin sess-a survived a successful archive")
	}
	assertPinsRevision(t, web, 2, "L1 archive should bump revision")
}

// TestPinsL1_ArchiveCascadesSubtree: archiving a parent unpins the whole
// affected subtree (parent + descendants), not just the requested id.
func TestPinsL1_ArchiveCascadesSubtree(t *testing.T) {
	t.Setenv("VH_STATE_DIR", t.TempDir())
	f := &fakeOC{}
	web, agg, _, _ := queueLifecycleServer(t, f)

	// Seed a parent + child in the live store so Descendants cascades.
	agg.Store().Apply(ev("session.created", `{"info":{"id":"parent"}}`))
	agg.Store().Apply(ev("session.created", `{"info":{"id":"child","parentID":"parent"}}`))

	// Pin both.
	r := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"parent", "child"},
	})
	r.Body.Close()

	resp, affected := postArchive(t, web.URL, "parent")
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive: status %d, want 200", resp.StatusCode)
	}
	if len(affected) != 2 {
		t.Fatalf("affected = %v, want [parent child]", affected)
	}

	g := pinsGet(t, web.URL)
	if pinsHasID(g, "parent") || pinsHasID(g, "child") {
		t.Fatalf("L1 cascade: pins survived archive; remaining: %v", g.OrderedSessionIDs)
	}
	// The revision advanced at least once (the cascade removed both pins).
	// The EXACT count is intentionally not pinned: RemoveSessions fires one
	// KindSessionDelete per id, so the L2 subscriber may remove parent and
	// child one-at-a-time (2 bumps) before L1's batched RemoveIDs runs (then a
	// no-op), OR L1 runs first (1 batched bump, L2 fully no-op). Both are valid
	// idempotent L1+L2 compositions; only the final state (both gone) is
	// deterministic. Revision must be >= 2 (started at 1, at least one removal).
	if g.Revision < 2 {
		t.Fatalf("L1 cascade: revision = %d, want >= 2 (at least one removal)", g.Revision)
	}
}

// TestPinsL1_FailedArchivePreservesPin: a non-404/410 SetArchived failure makes
// /vh/archive return 502 BEFORE the L1 hook runs, so a still-active session's
// pin MUST survive. This is the "failed archive must not unpin" contract.
func TestPinsL1_FailedArchivePreservesPin(t *testing.T) {
	t.Setenv("VH_STATE_DIR", t.TempDir())
	f := &fakeOC{archiveStatus: http.StatusConflict} // 409 → session still live
	web, agg, srv, _ := queueLifecycleServer(t, f)
	srv.SetReassertDelay(5 * time.Millisecond)

	seedPinSession(t, agg, "sess-a")
	r := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"sess-a"},
	})
	r.Body.Close()

	resp, _ := postArchive(t, web.URL, "sess-a")
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("/vh/archive with 409: status %d, want 502 (abort)", resp.StatusCode)
	}

	// Pin must survive — the handler returned 502 before the L1 hook.
	// Poll the negative condition across a short window (mirrors the queue
	// failed-archive test) so a delayed stray cleanup surfaces as a failure.
	deadline := time.Now().Add(200 * time.Millisecond)
	for time.Now().Before(deadline) {
		if !pinsHasID(pinsGet(t, web.URL), "sess-a") {
			t.Fatalf("L1 failed-archive: pin sess-a was removed by a failed archive")
		}
		time.Sleep(10 * time.Millisecond)
	}
	assertPinsRevision(t, web, 1, "L1 failed-archive must not bump revision")
}

// TestPinsL1_ArchiveBroadcastsUpdate confirms the cleanup→broadcast rule fires
// on the L1 success path: a /vh/stream subscriber receives pins.updated with the
// bumped revision after a successful archive.
func TestPinsL1_ArchiveBroadcastsUpdate(t *testing.T) {
	t.Setenv("VH_STATE_DIR", t.TempDir())
	f := &fakeOC{}
	web, agg, _, _ := queueLifecycleServer(t, f)

	seedPinSession(t, agg, "sess-a")
	r := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"sess-a"},
	})
	r.Body.Close()

	// Open a subscriber and clear the bootstrap.
	sresp, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatalf("GET /vh/stream: %v", err)
	}
	defer sresp.Body.Close()
	ch := startSSEReader(t, sresp.Body)
	drainIdle(ch, 500*time.Millisecond)

	// Archive → L1 hook → removePinsAndBroadcast → FanOutPinsUpdate.
	resp, _ := postArchive(t, web.URL, "sess-a")
	if resp.StatusCode != 200 {
		t.Fatalf("/vh/archive: status %d, want 200", resp.StatusCode)
	}

	events := drainIdle(ch, 1*time.Second)
	data, ok := eventDataFor(events, "pins.updated", "revision")
	if !ok {
		t.Fatalf("L1 archive did not broadcast pins.updated; events: %v", eventNames(events))
	}
	upd := decodePinsSSEData(t, data)
	if upd.Revision != 2 {
		t.Fatalf("L1 pins.updated revision = %d, want 2", upd.Revision)
	}
	if pinsHasID(upd, "sess-a") {
		t.Fatalf("L1 pins.updated still lists sess-a: %v", upd.OrderedSessionIDs)
	}
}

// ============================================================================
// Layer 2 — session.delete subscriber (pkg/web/pins_lifecycle.go)
// ============================================================================

// TestPinsL2_SessionDeleteRemovesPin: a store-emitted KindSessionDelete (via
// RemoveSessions, the archive-equivalent delete chokepoint) reaches the L2
// subscriber and removes the pin. Delivery is async, so we poll.
func TestPinsL2_SessionDeleteRemovesPin(t *testing.T) {
	srv, web := newPinsTestServer(t)
	seedPinSession(t, srv.agg, "sess-a")
	r := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"sess-a"},
	})
	r.Body.Close()

	// Install the L2 subscriber (lazy on first aggFor("")).
	_ = srv.aggFor("")

	// Fire KindSessionDelete via the normalized delete chokepoint.
	srv.agg.Store().RemoveSessions([]string{"sess-a"})
	waitForPinGone(t, web, "sess-a", "L2 RemoveSessions")
	assertPinsRevision(t, web, 2, "L2 delete should bump revision")
}

// TestPinsL2_RawSessionDeletedRemovesPin: the raw session.deleted event path
// (also funnels through deleteSessionLocked → KindSessionDelete) is caught too.
func TestPinsL2_RawSessionDeletedRemovesPin(t *testing.T) {
	srv, web := newPinsTestServer(t)
	seedPinSession(t, srv.agg, "sess-a")
	r := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"sess-a"},
	})
	r.Body.Close()
	_ = srv.aggFor("")

	srv.agg.Store().Apply(ev("session.deleted", `{"info":{"id":"sess-a"}}`))
	waitForPinGone(t, web, "sess-a", "L2 raw session.deleted")
}

// TestPinsL2_DeleteUnpinnedSessionIsNoOp: deleting a session that is NOT pinned
// must NOT bump the revision or broadcast (RemoveIDs is a no-op when the id is
// absent; changed==false → nothing). This is the idempotent/no-spurious-broadcast
// contract.
func TestPinsL2_DeleteUnpinnedSessionIsNoOp(t *testing.T) {
	srv, web := newPinsTestServer(t)
	seedPinSession(t, srv.agg, "pinned")
	seedPinSession(t, srv.agg, "unpinned")
	r := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"pinned"}, // only "pinned" is pinned
	})
	r.Body.Close()
	_ = srv.aggFor("")

	// Delete the UNPINNED session. Revision must stay at 1 (no broadcast).
	srv.agg.Store().RemoveSessions([]string{"unpinned"})

	// Poll the negative condition: revision must not advance.
	deadline := time.Now().Add(250 * time.Millisecond)
	for time.Now().Before(deadline) {
		if r := pinsGet(t, web.URL); r.Revision != 1 {
			t.Fatalf("L2 no-op: deleting unpinned session bumped revision to %d", r.Revision)
		}
		time.Sleep(10 * time.Millisecond)
	}
	// The pinned session must survive.
	if !pinsHasID(pinsGet(t, web.URL), "pinned") {
		t.Fatalf("L2 no-op: pinned session was removed by an unrelated delete")
	}
}

// TestPinsL2_SubscriberBroadcastsUpdate confirms the L2 path broadcasts: a
// /vh/stream subscriber receives pins.updated after a session.delete.
func TestPinsL2_SubscriberBroadcastsUpdate(t *testing.T) {
	srv, web := newPinsTestServer(t)
	seedPinSession(t, srv.agg, "sess-a")
	r := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{"sess-a"},
	})
	r.Body.Close()

	sresp, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatalf("GET /vh/stream: %v", err)
	}
	defer sresp.Body.Close()
	ch := startSSEReader(t, sresp.Body)
	drainIdle(ch, 500*time.Millisecond)

	_ = srv.aggFor("")
	srv.agg.Store().RemoveSessions([]string{"sess-a"})

	events := drainIdle(ch, 1*time.Second)
	data, ok := eventDataFor(events, "pins.updated", "revision")
	if !ok {
		t.Fatalf("L2 delete did not broadcast pins.updated; events: %v", eventNames(events))
	}
	upd := decodePinsSSEData(t, data)
	if upd.Revision != 2 {
		t.Fatalf("L2 pins.updated revision = %d, want 2", upd.Revision)
	}
}

// ============================================================================
// Layer 3 — post-hydrate backstop (pkg/web/pins_lifecycle.go)
// ============================================================================
//
// The driver reconcilePinsForAgg gates fail-closed on HydratedOnce() and then
// delegates to reconcilePinsForProject(key, activeSet). Mirroring the GC-3
// queue reconcile test strategy, the core reconcile logic is tested directly
// (reconcilePinsForProject with hand-built active sets) and the driver's
// fail-closed gate is tested separately (HydratedOnce()==false → no-op). The
// aggregator's hydratedOnce field is not settable from pkg/web without a real
// hydrate, so the driver's success-path delegation is covered compositionally
// by these two halves — exactly as FIX-QUEUE-GC-3's tests do.

// pinTwoProjects seeds a default-project session and a /proj2 session, pins
// both, and returns the two project keys + the established revision. Used by
// the L3 scope-fence tests.
func pinTwoProjects(t *testing.T, srv *Server, web *httptest.Server, defID, proj2ID string) (defaultKey, proj2Key string) {
	t.Helper()
	seedPinSession(t, srv.agg, defID)
	const deadURL = "http://127.0.0.1:1"
	proj2 := aggregator.New(deadURL, 100)
	srv.aggs["/proj2"] = proj2
	seedPinSession(t, proj2, proj2ID)

	r := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      0,
		"orderedSessionIds": []string{defID, proj2ID},
	})
	r.Body.Close()
	return projectKey(mustProjectRoot(t, "")), projectKey(mustProjectRoot(t, "/proj2"))
}

// TestPinsL3_RemovesAbsentProjectPinScoped: reconcilePinsForProject removes a
// project's pin absent from the authoritative active set, while preserving
// (a) a same-project pin that IS active, and (b) a DIFFERENT project's pin
// (the scope fence — an unopened/other project's pin is never dropped).
func TestPinsL3_RemovesAbsentProjectPinScoped(t *testing.T) {
	srv, web := newPinsTestServer(t)
	defaultKey, proj2Key := pinTwoProjects(t, srv, web, "def-keep", "proj2-sess")
	// Also pin a second default-project session that will be "deleted" (absent
	// from the authoritative active set).
	seedPinSession(t, srv.agg, "def-gone")
	r := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      1, // pinTwoProjects left it at 1
		"orderedSessionIds": []string{"def-keep", "def-gone", "proj2-sess"},
	})
	r.Body.Close()

	// Authoritative active set for the DEFAULT project: def-keep present,
	// def-gone ABSENT (deleted while worker was down). proj2-sess belongs to a
	// different project and must be ignored entirely.
	srv.reconcilePinsForProject(srv.pins.Snapshot(), defaultKey, map[string]bool{"def-keep": true})

	g := pinsGet(t, web.URL)
	if pinsHasID(g, "def-gone") {
		t.Fatalf("L3: absent default-project pin def-gone survived reconcile; remaining: %v", g.OrderedSessionIDs)
	}
	if !pinsHasID(g, "def-keep") {
		t.Fatalf("L3: active default-project pin def-keep was wrongly removed")
	}
	if !pinsHasID(g, "proj2-sess") {
		t.Fatalf("L3: other-project pin proj2-sess was removed — scope fence violation; remaining: %v", g.OrderedSessionIDs)
	}
	// pinTwoProjects left the doc at rev 1; the second PUT (adding def-gone)
	// bumped it to 2; this reconcile removes def-gone → rev 3.
	assertPinsRevision(t, web, 3, "L3 scoped remove should bump revision once")

	// Reconcile must be idempotent: a second pass with the same set removes
	// nothing (def-gone already gone) and does not bump the revision.
	srv.reconcilePinsForProject(srv.pins.Snapshot(), defaultKey, map[string]bool{"def-keep": true})
	assertPinsRevision(t, web, 3, "L3 idempotent re-reconcile must not bump revision")

	// Sanity: the proj2 key is distinct from the default key (test isolation).
	if defaultKey == proj2Key {
		t.Fatalf("default and /proj2 project keys collided — test isolation broken")
	}
}

// TestPinsL3_EmptyActiveSetRemovesAllProjectPins: a project that hydrated with
// ZERO sessions (authoritative empty set) removes ALL of that project's pins.
// This is the case that catches sessions deleted while the worker was down.
func TestPinsL3_EmptyActiveSetRemovesAllProjectPins(t *testing.T) {
	srv, web := newPinsTestServer(t)
	defaultKey, _ := pinTwoProjects(t, srv, web, "def-a", "proj2-sess")
	seedPinSession(t, srv.agg, "def-b")
	r := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      1,
		"orderedSessionIds": []string{"def-a", "def-b", "proj2-sess"},
	})
	r.Body.Close()

	// Empty NON-nil active set = "hydrate succeeded with zero sessions." Both
	// default-project pins are genuinely absent → removed. proj2-sess survives.
	srv.reconcilePinsForProject(srv.pins.Snapshot(), defaultKey, map[string]bool{})

	g := pinsGet(t, web.URL)
	if pinsHasID(g, "def-a") || pinsHasID(g, "def-b") {
		t.Fatalf("L3 empty-set: default-project pins survived; remaining: %v", g.OrderedSessionIDs)
	}
	if !pinsHasID(g, "proj2-sess") {
		t.Fatalf("L3 empty-set: proj2-sess removed — scope fence violation; remaining: %v", g.OrderedSessionIDs)
	}
}

// TestPinsL3_PreservesUnopenedProjectPins: reconciling the DEFAULT project with
// an empty active set must NOT touch pins whose projectBySessionId is a
// different (unopened) project. This is the core scope-fence guarantee:
// absence from THIS project's active set is not proof of deletion for a pin
// owned by another project.
func TestPinsL3_PreservesUnopenedProjectPins(t *testing.T) {
	srv, web := newPinsTestServer(t)
	defaultKey, _ := pinTwoProjects(t, srv, web, "def-a", "proj2-sess")

	// Reconcile the default project with an EMPTY active set. The proj2 pin
	// must survive — it does not belong to the default project.
	srv.reconcilePinsForProject(srv.pins.Snapshot(), defaultKey, map[string]bool{})

	g := pinsGet(t, web.URL)
	if pinsHasID(g, "def-a") {
		t.Fatalf("L3: default pin def-a survived empty-set reconcile (should be removed)")
	}
	if !pinsHasID(g, "proj2-sess") {
		t.Fatalf("L3: unopened-project pin proj2-sess was removed by a different project's reconcile")
	}
}

// TestPinsL3_NoRemovalWhenAllPresent: if every project-scoped pin is in the
// authoritative active set, reconcile removes nothing and does not bump the
// revision (no spurious broadcast).
func TestPinsL3_NoRemovalWhenAllPresent(t *testing.T) {
	srv, web := newPinsTestServer(t)
	defaultKey, _ := pinTwoProjects(t, srv, web, "def-a", "proj2-sess")

	before := pinsGet(t, web.URL)
	srv.reconcilePinsForProject(srv.pins.Snapshot(), defaultKey, map[string]bool{"def-a": true})
	after := pinsGet(t, web.URL)

	if after.Revision != before.Revision {
		t.Fatalf("L3: revision bumped from %d to %d when no pin was absent", before.Revision, after.Revision)
	}
	if len(after.OrderedSessionIDs) != len(before.OrderedSessionIDs) {
		t.Fatalf("L3: order changed when no pin was absent: %v -> %v", before.OrderedSessionIDs, after.OrderedSessionIDs)
	}
}

// TestPinsL3_DriverFailClosedWhenNotHydrated: reconcilePinsForAgg must delete
// NOTHING when the aggregator has not yet completed a hydrate (HydratedOnce()
// is false). This is the fail-closed gate: absence from an
// unopened/failed/incomplete hydrate is NOT proof of deletion. Mirrors the
// GC-3 queue reconcile gate test.
func TestPinsL3_DriverFailClosedWhenNotHydrated(t *testing.T) {
	srv, web := newPinsTestServer(t)
	defaultKey, _ := pinTwoProjects(t, srv, web, "def-a", "proj2-sess")
	_ = defaultKey

	// newPinsTestServer does NOT start the aggregator's Run loop, so
	// HydratedOnce() is false — exactly the boot race this gate defends.
	if srv.agg.HydratedOnce() {
		t.Fatalf("precondition: aggregator already hydrated; test harness assumption violated")
	}

	before := pinsGet(t, web.URL)
	// The production trigger path would call exactly this. With
	// HydratedOnce()==false it must short-circuit, removing nothing — even
	// though def-a is "absent" from the store's (empty) session map.
	srv.reconcilePinsForAgg("", srv.agg)
	after := pinsGet(t, web.URL)

	if after.Revision != before.Revision {
		t.Fatalf("L3 driver: revision bumped %d -> %d under not-yet-hydrated aggregator; FAIL-CLOSED violation",
			before.Revision, after.Revision)
	}
	if len(after.OrderedSessionIDs) != len(before.OrderedSessionIDs) {
		t.Fatalf("L3 driver: pins removed under not-yet-hydrated aggregator; FAIL-CLOSED violation: %v -> %v",
			before.OrderedSessionIDs, after.OrderedSessionIDs)
	}
}

// TestPinsL3_PinAddedAfterSnapshotSurvives is the F1 TOCTOU regression. The
// race it pins: in the driver, the active-session set must be derived AFTER the
// pin-doc snapshot — never before. If the pin doc were snapshotted AFTER the
// active set, a pin added in between (a concurrent PUT whose session was created
// after the active-set read) would be present in the fresher pin-doc snapshot
// yet absent from the stale active set, and would be wrongly removed —
// permanently losing a valid server-managed pin.
//
// This test exercises the fix at the core API: reconcilePinsForProject takes the
// pin-doc snapshot as a parameter, so we pass a snapshot taken BEFORE a new pin
// is added, alongside an active set that does NOT include the new pin's session
// (simulating the new session being created after the inventory). The new pin
// MUST survive because it is not in the snapshot the reconcile iterates.
//
// Before the fix (when reconcilePinsForProject re-snapshotted internally), this
// test would FAIL: the internal fresh snapshot would include the new pin, which
// is absent from the active set, and RemoveIDs would delete it.
func TestPinsL3_PinAddedAfterSnapshotSurvives(t *testing.T) {
	srv, web := newPinsTestServer(t)
	defaultKey, _ := pinTwoProjects(t, srv, web, "preexisting", "proj2-sess")

	// T0: snapshot the pin doc BEFORE the "new" pin exists. This is the
	// snapshot the driver would pass under the F1-fixed ordering.
	docAtT0 := srv.pins.Snapshot()
	if !pinsHasID(pinsPublicRespFromDoc(docAtT0), "preexisting") {
		t.Fatalf("precondition: preexisting pin missing from T0 snapshot")
	}

	// (T0, T1): a concurrent PUT adds a brand-new pin whose session was created
	// after the active-set snapshot. Seed + pin "fresh" now.
	seedPinSession(t, srv.agg, "fresh")
	r := pinsPut(t, web.URL+"/vh/pins", map[string]any{
		"baseRevision":      docAtT0.Revision, // current rev at the time of the PUT
		"orderedSessionIds": []string{"preexisting", "fresh", "proj2-sess"},
	})
	if r.StatusCode != 200 {
		b, _ := io.ReadAll(r.Body)
		r.Body.Close()
		t.Fatalf("concurrent PUT adding fresh pin: status %d, want 200. body: %s", r.StatusCode, b)
	}
	r.Body.Close()
	// "fresh" is now a valid pinned session in the live PinStore.

	// T1: the active set derived by the driver AFTER T0. Simulate the worst
	// case for the race — "fresh" is ABSENT from this set (its session was
	// created after the inventory was taken). "preexisting" is present.
	activeSetMissingFresh := map[string]bool{"preexisting": true}

	// Reconcile with the T0 (stale) pin-doc snapshot. Under the F1 fix, the
	// reconcile iterates only docAtT0.OrderedSessionIDs (no "fresh"), so "fresh"
	// is not a removal candidate and survives even though it is absent from the
	// active set.
	srv.reconcilePinsForProject(docAtT0, defaultKey, activeSetMissingFresh)

	g := pinsGet(t, web.URL)
	if !pinsHasID(g, "fresh") {
		t.Fatalf("F1 regression: pin added after the snapshot was removed — a valid pin must survive (TOCTOU reintroduced); remaining: %v", g.OrderedSessionIDs)
	}
	if !pinsHasID(g, "preexisting") {
		t.Fatalf("F1 regression: preexisting active pin was wrongly removed; remaining: %v", g.OrderedSessionIDs)
	}
	if !pinsHasID(g, "proj2-sess") {
		t.Fatalf("F1 regression: other-project pin was removed — scope fence violation; remaining: %v", g.OrderedSessionIDs)
	}
	// No pin in the T0 snapshot was absent from the active set, so no removal
	// happened and the revision must not have advanced beyond the PUT.
	assertPinsRevision(t, web, docAtT0.Revision+1, "F1: no removal should occur (revision = PUT only)")
}

// TestPinsL3_ReconcileBroadcastsUpdate confirms the L3 path broadcasts: after a
// reconcile that removes a pin, a /vh/stream subscriber receives pins.updated.
func TestPinsL3_ReconcileBroadcastsUpdate(t *testing.T) {
	srv, web := newPinsTestServer(t)
	defaultKey, _ := pinTwoProjects(t, srv, web, "def-gone", "proj2-sess")

	sresp, err := http.Get(web.URL + "/vh/stream")
	if err != nil {
		t.Fatalf("GET /vh/stream: %v", err)
	}
	defer sresp.Body.Close()
	ch := startSSEReader(t, sresp.Body)
	drainIdle(ch, 500*time.Millisecond)

	// Reconcile removes def-gone (absent from the active set).
	srv.reconcilePinsForProject(srv.pins.Snapshot(), defaultKey, map[string]bool{})

	events := drainIdle(ch, 1*time.Second)
	data, ok := eventDataFor(events, "pins.updated", "revision")
	if !ok {
		t.Fatalf("L3 reconcile did not broadcast pins.updated; events: %v", eventNames(events))
	}
	upd := decodePinsSSEData(t, data)
	if upd.Revision != 2 {
		t.Fatalf("L3 pins.updated revision = %d, want 2", upd.Revision)
	}
	if pinsHasID(upd, "def-gone") {
		t.Fatalf("L3 pins.updated still lists def-gone: %v", upd.OrderedSessionIDs)
	}
	// Broadcast JSON must not leak projectBySessionId (internal field).
	if leaked, _ := json.Marshal(upd); contains(string(leaked), "projectBySessionId") {
		t.Fatalf("L3 pins.updated leaks projectBySessionId: %s", leaked)
	}
}
