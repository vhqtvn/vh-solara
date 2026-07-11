package web

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// newReloadServer builds a web Server backed by a fake OpenCode that records
// POST /instance/dispose calls, with the default aggregator already running. It
// is the harness for the reload-project integration tests.
func newReloadServer(t *testing.T) (*Server, *fakeOpenCode, *httptest.Server, *httptest.Server) {
	t.Helper()
	fake := newFake()
	ocSrv := httptest.NewServer(fake.handler())

	agg := aggregator.New(ocSrv.URL, 100)
	ocCtx, ocCancel := context.WithCancel(context.Background())
	go agg.Run(ocCtx)

	srv, err := NewServer(agg, ocSrv.URL, 1000)
	if err != nil {
		ocCancel()
		ocSrv.Close()
		t.Fatalf("NewServer: %v", err)
	}

	web := httptest.NewServer(srv.Handler())

	// Consolidated teardown: stop every per-project aggregator the test spun up
	// (Stop cancels their RunManaged ctx), cancel the default's plain Run, then
	// sever the idle SSE tails and close both servers.
	t.Cleanup(func() {
		srv.aggMu.Lock()
		for _, a := range srv.aggs {
			a.Stop()
		}
		srv.aggMu.Unlock()
		ocCancel()
		ocSrv.CloseClientConnections()
		ocSrv.Close()
		web.CloseClientConnections()
		web.Close()
	})
	return srv, fake, ocSrv, web
}

// doReloadProject POSTs /vh/reload-project?dir=<dir> with the required CSRF
// header and returns the response.
func doReloadProject(t *testing.T, webURL, dir string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, webURL+"/vh/reload-project?dir="+dir, nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(csrfHeader, "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// TestReloadProject_NonDefault drops ONE per-project aggregator: it disposes the
// OpenCode instance for that dir, removes the aggregator from the map, leaves
// every OTHER project untouched, and the next access rebuilds a FRESH aggregator.
func TestReloadProject_NonDefault(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)

	dirA := "/tmp/proj-A-reload"
	dirB := "/tmp/proj-B-reload"

	// Materialize two per-project aggregators (this is what a browser opening
	// each project does via aggFor on first touch).
	aA1 := srv.aggFor(dirA)
	aB := srv.aggFor(dirB)
	epochA1 := aA1.Store().Epoch()
	epochB := aB.Store().Epoch()

	// Reload dirA only.
	resp := doReloadProject(t, web.URL, dirA)
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: want 200, got %d", resp.StatusCode)
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if body["ok"] != true {
		t.Fatalf("body: want {ok:true}, got %v", body)
	}

	// Exactly ONE dispose, scoped to dirA's directory header.
	waitFor(t, func() bool { return len(fake.disposedDirs()) >= 1 },
		"fake never received POST /instance/dispose")
	if got := fake.disposedDirs(); len(got) != 1 || got[0] != dirA {
		t.Fatalf("disposed dirs: want exactly [%s], got %v", dirA, got)
	}

	// dirA's aggregator was dropped from the map; dirB's is STILL the SAME
	// instance (untouched — the whole point of per-project reload).
	srv.aggMu.Lock()
	gotA := srv.aggs[dirA]
	gotB := srv.aggs[dirB]
	srv.aggMu.Unlock()
	if gotA != nil {
		t.Fatalf("dirA aggregator must be dropped, still got %p", gotA)
	}
	if gotB != aB {
		t.Fatalf("dirB aggregator must be untouched, want %p got %p", aB, gotB)
	}
	if gotB.Store().Epoch() != epochB {
		t.Fatal("dirB store epoch changed — other project was disturbed")
	}

	// The next access rebuilds a FRESH aggregator for dirA (new store epoch, not
	// the disposed one).
	aA2 := srv.aggFor(dirA)
	if aA2 == aA1 {
		t.Fatal("aggFor(dirA) returned the SAME aggregator after reload — not rebuilt")
	}
	if aA2.Store().Epoch() == epochA1 {
		t.Fatal("rebuilt dirA aggregator reuses the old store epoch — not fresh")
	}
}

// TestReloadProject_Default verifies the default-project (dir == "") path: the
// OpenCode instance IS disposed (config edits apply on the next request), but
// the default aggregator is process-lifetime and is NOT torn down or dropped —
// it stays in the map and keeps serving. This is the documented limitation: a
// full aggregator rebuild for the default requires the fleet-wide restart.
func TestReloadProject_Default(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)

	// The default aggregator is stored under both s.agg and s.aggs[""].
	srv.aggMu.Lock()
	defaultAgg := srv.aggs[""]
	srv.aggMu.Unlock()
	if defaultAgg == nil || defaultAgg != srv.agg {
		t.Fatal("precondition: s.aggs[\"\"] must equal s.agg (the default)")
	}

	// Reload the default project (no ?dir= → reqDir returns "").
	resp := doReloadProject(t, web.URL, "")
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status: want 200, got %d", resp.StatusCode)
	}

	// The dispose fired for the default (empty directory header → OpenCode
	// falls back to its process cwd).
	waitFor(t, func() bool { return len(fake.disposedDirs()) >= 1 },
		"fake never received POST /instance/dispose for default")
	if got := fake.disposedDirs(); len(got) != 1 || got[0] != "" {
		t.Fatalf("disposed dirs for default: want exactly [\"\"], got %v", got)
	}

	// The default aggregator is STILL the same instance — NOT dropped (it is
	// process-lifetime; handleReloadProject skips teardown for dir == "").
	srv.aggMu.Lock()
	gotDefault := srv.aggs[""]
	srv.aggMu.Unlock()
	if gotDefault == nil {
		t.Fatal("default aggregator was dropped from s.aggs — must stay (process-lifetime)")
	}
	if gotDefault != srv.agg {
		t.Fatal("s.aggs[\"\"] != s.agg after default reload — default must not be swapped")
	}
	if gotDefault != defaultAgg {
		t.Fatal("default aggregator instance changed — must be the SAME process-lifetime instance")
	}
}

// TestReloadProject_NotAllowed guards the method (only POST is permitted; the
// CSRF guard still requires the header on a permitted POST).
func TestReloadProject_MethodGuard(t *testing.T) {
	_, _, _, web := newReloadServer(t)
	req, err := http.NewRequest(http.MethodGet, web.URL+"/vh/reload-project", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(csrfHeader, "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("GET /vh/reload-project: want 405, got %d", resp.StatusCode)
	}
}

// TestReloadProject_CSRF guards that a POST WITHOUT the X-VH-CSRF header is
// rejected by the cross-cutting CSRF guard (shared with every state-changing
// /vh/* route).
func TestReloadProject_CSRF(t *testing.T) {
	_, _, _, web := newReloadServer(t)
	resp, err := http.Post(web.URL+"/vh/reload-project", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 400 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST /vh/reload-project without CSRF: want 4xx, got %d (body=%s)", resp.StatusCode, body)
	}
}

// TestReloadProject_StopsPermissionWatcher verifies the fix for the
// permission-reconcile goroutine leak: after Reload of a non-default dir, that
// dir's sweep is stopped (watcherOn[dir]==false, watcherCancel[dir] absent),
// the default dir's sweep stays armed, and a subsequent aggFor(dir) RE-ARMS a
// fresh sweep (the idempotent guard lets it through because stopPermissionWatcher
// cleared watcherOn[dir]).
func TestReloadProject_StopsPermissionWatcher(t *testing.T) {
	srv, _, _, web := newReloadServer(t)

	dirA := "/tmp/proj-watch-A"
	dirB := "/tmp/proj-watch-B"

	// Arm the default sweep too (aggFor("") is what the first browser-open of
	// the default project does), so we can assert it survives a non-default
	// Reload. The default sweep is process-lifetime and must never be stopped.
	srv.aggFor("")
	// Touching the non-default dirs arms their sweeps via aggFor → ensurePermissionWatcher.
	srv.aggFor(dirA)
	srv.aggFor(dirB)
	if !srv.watcherOn[dirA] || srv.watcherCancel[dirA] == nil {
		t.Fatalf("precondition: dirA watcher must be armed, watcherOn=%v cancel=%v", srv.watcherOn[dirA], srv.watcherCancel[dirA])
	}
	if !srv.watcherOn[dirB] || srv.watcherCancel[dirB] == nil {
		t.Fatalf("precondition: dirB watcher must be armed, watcherOn=%v cancel=%v", srv.watcherOn[dirB], srv.watcherCancel[dirB])
	}

	// Reload dirA → its sweep must be stopped.
	resp := doReloadProject(t, web.URL, dirA)
	if sc := resp.StatusCode; sc != 200 {
		t.Fatalf("status: want 200, got %d", sc)
	}
	resp.Body.Close()

	// dirA's sweep is cleared; dirB's is untouched.
	srv.watcherMu.Lock()
	onA, onB := srv.watcherOn[dirA], srv.watcherOn[dirB]
	cancelA, cancelB := srv.watcherCancel[dirA], srv.watcherCancel[dirB]
	srv.watcherMu.Unlock()
	if onA {
		t.Fatal("dirA watcherOn must be false after Reload — sweep was not stopped")
	}
	if cancelA != nil {
		t.Fatal("dirA watcherCancel must be absent after Reload — sweep was not stopped")
	}
	if !onB {
		t.Fatal("dirB watcherOn must stay true — other project's sweep disturbed")
	}
	if cancelB == nil {
		t.Fatal("dirB watcherCancel must stay armed — other project's sweep disturbed")
	}

	// Default dir's sweep stays armed (it is process-lifetime, never stopped).
	srv.watcherMu.Lock()
	defaultOn := srv.watcherOn[""]
	defaultCancel := srv.watcherCancel[""]
	srv.watcherMu.Unlock()
	if !defaultOn || defaultCancel == nil {
		t.Fatal("default dir watcher must stay armed (process-lifetime)")
	}

	// Re-arm: a subsequent aggFor(dirA) builds a fresh aggregator and arms a
	// FRESH sweep (watcherOn[dirA] was cleared, so the idempotent guard lets it
	// through). The cancel func is a new, non-nil one.
	srv.aggFor(dirA)
	srv.watcherMu.Lock()
	onA2, cancelA2 := srv.watcherOn[dirA], srv.watcherCancel[dirA]
	srv.watcherMu.Unlock()
	if !onA2 {
		t.Fatal("dirA watcherOn must be re-armed after aggFor(dirA) post-Reload")
	}
	if cancelA2 == nil {
		t.Fatal("dirA watcherCancel must be re-armed (fresh non-nil cancel) after aggFor(dirA) post-Reload")
	}
}

// TestReloadProject_DefaultKeepsWatcher verifies the default-dir invariant:
// Reload of the default project (dir == "") disposes the OpenCode instance but
// must NOT stop the default permission sweep (it is process-lifetime).
func TestReloadProject_DefaultKeepsWatcher(t *testing.T) {
	srv, _, _, web := newReloadServer(t)

	// Arm the default sweep via aggFor("").
	srv.aggFor("")
	srv.watcherMu.Lock()
	if srv.watcherCancel[""] == nil {
		srv.watcherMu.Unlock()
		t.Fatal("precondition: default watcher must be armed")
	}
	srv.watcherMu.Unlock()

	// Reload the default project.
	resp := doReloadProject(t, web.URL, "")
	if sc := resp.StatusCode; sc != 200 {
		t.Fatalf("status: want 200, got %d", sc)
	}
	resp.Body.Close()

	// Default sweep stays armed (Reload skips teardown for ""). Go func values
	// can only be compared to nil, so identity-equality is not assertable; the
	// observable invariant is that the sweep is still registered + armed with a
	// live cancel (i.e. it was never stopped).
	srv.watcherMu.Lock()
	onAfter := srv.watcherOn[""]
	cancelAfter := srv.watcherCancel[""]
	srv.watcherMu.Unlock()
	if !onAfter {
		t.Fatal("default watcherOn must stay true after default Reload")
	}
	if cancelAfter == nil {
		t.Fatal("default watcherCancel must stay non-nil after default Reload — sweep was stopped")
	}
}

// TestReloadProject_ConcurrentReloadKeepsReplacementWatcher pins the
// concurrency fix (AGG-F1) for the identity guard around stopPermissionWatcher.
//
// The race the fix closes: two concurrent Reloads of the same dir both snapshot
// the OLD aggregator `a`. T1 completes teardown (stops watcher1, deletes a1).
// A subsequent aggFor(dir) rebuilds a fresh aggregator a2 and arms a NEW watcher
// for dir. The stale T2 then reaches its teardown; its `s.aggs[dir]==a` recheck
// correctly skips deleting a2, BUT — before the fix — it had ALREADY called
// stopPermissionWatcher(dir) unconditionally and outside the lock, disarming a2's
// freshly-armed sweep. Net: a2 is live in the map with NO fail-closed permission
// sweep. After the fix, stopPermissionWatcher is inside the `cur==a` guard, so
// the stale request never touches a2's watcher.
//
// Deterministic mechanism: the fake's /instance/dispose handler is the injection
// point. The handler (in archive.go) snapshots `a` at entry, then sends the
// dispose RPC; the fake invokes our onDispose hook SYNCHRONOUSLY during that RPC
// (the handler blocks on the response), and the hook performs the FULLY-COMPLETED
// rebuild (stop watcher1 + Stop a1 + delete a1 + build a2 + swap in + arm
// watcher2 + RunManaged a2). When the handler resumes into its teardown, the
// recheck sees a2 (not a1), so the guard skips — and with the fix, never
// disarms watcher2. No sleeps, no real-goroutine races.
func TestReloadProject_ConcurrentReloadKeepsReplacementWatcher(t *testing.T) {
	srv, fake, _, web := newReloadServer(t)

	dir := "/tmp/proj-concurrent-watch"

	// (1) Initial state: a1 is the live aggregator for dir, watcher1 armed.
	a1 := srv.aggFor(dir)
	srv.watcherMu.Lock()
	w1On := srv.watcherOn[dir]
	w1Cancel := srv.watcherCancel[dir]
	srv.watcherMu.Unlock()
	if !w1On || w1Cancel == nil {
		t.Fatalf("precondition: dir watcher1 must be armed, on=%v cancel=%v", w1On, w1Cancel)
	}

	// (2) Install the injection hook: DURING the handler's dispose RPC, simulate
	// the fully-completed concurrent rebuild (T1 done + fresh aggFor). This runs
	// BEFORE the handler's teardown recheck because the handler blocks on the RPC.
	fake.onDispose = func(d string) {
		// T1's completed teardown: stop watcher1, Stop a1, drop from map.
		srv.stopPermissionWatcher(d)
		a1.Stop()
		srv.aggMu.Lock()
		delete(srv.aggs, d)
		srv.aggMu.Unlock()
		// Fresh aggFor(d) rebuild: build a2, swap in, arm watcher2, RunManaged.
		a2 := aggregator.NewForDirectory(srv.opencodeURL, d, srv.ringCap)
		srv.aggMu.Lock()
		srv.aggs[d] = a2
		srv.aggMu.Unlock()
		srv.ensurePermissionWatcher(d, a2)
		go a2.RunManaged(context.Background())
	}

	// (3) Fire the (stale) Reload. The handler snapshot a1 at entry, then the
	// hook swaps in a2 during the dispose RPC, then the teardown recheck sees
	// a2 != a1 and (with the fix) skips both the watcher-stop and the delete.
	resp := doReloadProject(t, web.URL, dir)
	if sc := resp.StatusCode; sc != 200 {
		t.Fatalf("status: want 200, got %d", sc)
	}
	resp.Body.Close()

	// (4) The dispose RPC DID fire for dir (the stale request progressed).
	if got := fake.disposedDirs(); len(got) != 1 || got[0] != dir {
		t.Fatalf("disposed dirs: want exactly [%s], got %v", dir, got)
	}

	// (5) CONTRACT: the replacement a2 is STILL in the map (the stale request's
	// identity recheck correctly refused to delete it).
	srv.aggMu.Lock()
	gotAgg := srv.aggs[dir]
	srv.aggMu.Unlock()
	if gotAgg == nil {
		t.Fatal("replacement aggregator a2 was deleted by the stale Reload — identity recheck failed")
	}
	if gotAgg == a1 {
		t.Fatal("aggregator in map is still a1 — the rebuild hook did not run")
	}

	// (6) CONTRACT (the bug this test pins): a2's watcher is STILL armed. Before
	// the fix the stale request called stopPermissionWatcher(dir) outside the
	// guard, disarming a2's freshly-armed sweep; after the fix the guard skips
	// it entirely.
	srv.watcherMu.Lock()
	w2On := srv.watcherOn[dir]
	w2Cancel := srv.watcherCancel[dir]
	srv.watcherMu.Unlock()
	if !w2On {
		t.Fatal("replacement watcher2 was disarmed by the stale Reload — AGG-F1 regression (stopPermissionWatcher not identity-guarded)")
	}
	if w2Cancel == nil {
		t.Fatal("replacement watcherCancel is nil after stale Reload — AGG-F1 regression")
	}

	// (7) CONTRACT: a2 was NOT stopped (its RunManaged ctx is still live). We
	// observe this via the cancel field — package web can't read unexported
	// aggregator.cancel directly, but a still-running a2 means its store is
	// still open (Close is only called by Stop). Snapshot a non-nil store.
	if gotAgg.Store() == nil {
		t.Fatal("replacement a2 store is nil — a2 was stopped by the stale Reload")
	}
}
