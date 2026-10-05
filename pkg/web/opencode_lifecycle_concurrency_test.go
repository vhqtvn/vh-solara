package web

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/oclife"
)

// This file is the F3 / P2-TEST-006 regression: the server's OpenCode
// lifecycle pointer (Server.ocLifecycle) is swapped via SetOpenCodeLifecycle
// while the server may be serving (the fixture server does exactly that from
// its own /vh/fixture/oclife handler). The pointer is an atomic.Pointer and
// every handler Loads it exactly once per request, so:
//
//   - no data race between a swap and any reader (proven by -race here);
//   - every response is a COHERENT snapshot: it describes exactly one of the
//     published states (nil / owned / external), never a torn mix;
//   - a request that starts under lifecycle A completes against A even if B
//     is published mid-request (the controlled in-flight test below).
//
// Atomicity is per publication: these tests do NOT claim transactional
// multi-call fixture transitions (the Lifecycle's own internal locking covers
// the state mutations the fixture driver performs on one object).

// newSwapFixtureLifecycles builds the two distinct lifecycles used by the
// swap tests. Identity is observable through the response itself: topology
// (owned vs external, fixed per object at construction) and the owned ring's
// marker line (only the owned topology has a ring / HasLogTail).
func newSwapFixtureLifecycles() (owned, external *oclife.Lifecycle) {
	owned = oclife.New(oclife.TopologyOwned)
	owned.SetReady()
	owned.Ring().Append("life-owned marker\n")
	external = oclife.New(oclife.TopologyExternal)
	external.SetUnknown()
	return owned, external
}

// --- sequential semantics across swaps (self-contained baseline) ---

// TestOpenCodeLifecycleSwapSemantics pins the exact per-endpoint contract for
// each publishable state, before the concurrent tests relax timing: nil → 503
// on all three endpoints; owned → 200 snapshot / 200 marker tail / 200
// post-restart snapshot; external → 200 snapshot / 501 logs / 405 restart.
// Swapping back to nil restores the 503 posture (the fixture server's
// `?mode=off` hygiene).
func TestOpenCodeLifecycleSwapSemantics(t *testing.T) {
	srv := newTestServer(t)
	owned, external := newSwapFixtureLifecycles()
	srv.SetRestartOpenCode(func(context.Context) error { return nil })

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	get := func(path string) *http.Response {
		t.Helper()
		res, err := http.Get(web.URL + path)
		if err != nil {
			t.Fatalf("GET %s: %v", path, err)
		}
		t.Cleanup(func() { _ = res.Body.Close() })
		return res
	}
	restart := func() *http.Response {
		t.Helper()
		req, _ := http.NewRequest(http.MethodPost, web.URL+"/vh/opencode/restart", nil)
		req.Header.Set("X-VH-CSRF", "1")
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatalf("POST /vh/opencode/restart: %v", err)
		}
		t.Cleanup(func() { _ = res.Body.Close() })
		return res
	}
	decodeSnapshot := func(res *http.Response) oclife.Snapshot {
		t.Helper()
		var snap oclife.Snapshot
		if err := json.NewDecoder(res.Body).Decode(&snap); err != nil {
			t.Fatalf("decode snapshot: %v", err)
		}
		return snap
	}

	// nil → 503 everywhere (fixture/local-mode posture).
	for _, res := range []*http.Response{get("/vh/opencode/status"), get("/vh/opencode/logs"), restart()} {
		if res.StatusCode != http.StatusServiceUnavailable {
			t.Errorf("nil lifecycle: status = %d, want 503", res.StatusCode)
		}
	}

	// owned → 200 / 200+marker / 200 owned snapshot.
	srv.SetOpenCodeLifecycle(owned)
	if res := get("/vh/opencode/status"); res.StatusCode != http.StatusOK {
		t.Errorf("owned status: = %d, want 200", res.StatusCode)
	} else if snap := decodeSnapshot(res); snap.Topology != oclife.TopologyOwned {
		t.Errorf("owned status topology = %q, want %q", snap.Topology, oclife.TopologyOwned)
	}
	if res := get("/vh/opencode/logs"); res.StatusCode != http.StatusOK {
		t.Errorf("owned logs: = %d, want 200", res.StatusCode)
	} else {
		body, _ := io.ReadAll(res.Body)
		if !strings.Contains(string(body), "life-owned marker") {
			t.Errorf("owned logs body = %q, want the owned ring marker", string(body))
		}
	}
	if res := restart(); res.StatusCode != http.StatusOK {
		t.Errorf("owned restart: = %d, want 200", res.StatusCode)
	} else if snap := decodeSnapshot(res); snap.Topology != oclife.TopologyOwned {
		t.Errorf("owned restart snapshot topology = %q, want %q", snap.Topology, oclife.TopologyOwned)
	}

	// external → 200 snapshot / 501 logs / 405 restart (capability guards).
	srv.SetOpenCodeLifecycle(external)
	if res := get("/vh/opencode/status"); res.StatusCode != http.StatusOK {
		t.Errorf("external status: = %d, want 200", res.StatusCode)
	} else if snap := decodeSnapshot(res); snap.Topology != oclife.TopologyExternal {
		t.Errorf("external status topology = %q, want %q", snap.Topology, oclife.TopologyExternal)
	}
	if res := get("/vh/opencode/logs"); res.StatusCode != http.StatusNotImplemented {
		t.Errorf("external logs: = %d, want 501", res.StatusCode)
	}
	if res := restart(); res.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("external restart: = %d, want 405", res.StatusCode)
	}

	// back to nil → 503 everywhere again.
	srv.SetOpenCodeLifecycle(nil)
	for _, res := range []*http.Response{get("/vh/opencode/status"), get("/vh/opencode/logs"), restart()} {
		if res.StatusCode != http.StatusServiceUnavailable {
			t.Errorf("re-nil lifecycle: status = %d, want 503", res.StatusCode)
		}
	}
}

// --- concurrent swap hammer (run under -race) ---

// TestOpenCodeLifecycleConcurrentSwap hammers the three read paths while
// swappers cycle the published pointer through nil → owned → external. Every
// response must correspond to SOME published state (coherent-snapshot
// semantics): 503 (nil was published), or a response identifying exactly one
// of the two lifecycle objects via its topology / ring marker.
// Iteration-bounded with controlled synchronization (no wall-clock sleeps);
// a deadlock would surface as the package test timeout, a race as a -race
// failure here.
func TestOpenCodeLifecycleConcurrentSwap(t *testing.T) {
	srv := newTestServer(t)
	owned, external := newSwapFixtureLifecycles()
	srv.SetRestartOpenCode(func(context.Context) error { return nil })

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	const requesterIters = 150

	var stop atomic.Bool
	swapper := func() {
		for i := 0; !stop.Load(); i++ {
			switch i % 3 {
			case 0:
				srv.SetOpenCodeLifecycle(nil)
			case 1:
				srv.SetOpenCodeLifecycle(owned)
			case 2:
				srv.SetOpenCodeLifecycle(external)
			}
		}
	}

	// checkSnapshotIdentity asserts a 200 snapshot names exactly one of the
	// two fixture lifecycles (never a torn/foreign identity).
	checkSnapshotIdentity := func(snap oclife.Snapshot) {
		if snap.Topology != oclife.TopologyOwned && snap.Topology != oclife.TopologyExternal {
			t.Errorf("snapshot topology = %q, want owned|external", snap.Topology)
		}
	}

	statusRequester := func() {
		for i := 0; i < requesterIters; i++ {
			res, err := http.Get(web.URL + "/vh/opencode/status")
			if err != nil {
				t.Errorf("GET status: %v", err)
				return
			}
			body, _ := io.ReadAll(res.Body)
			_ = res.Body.Close()
			switch res.StatusCode {
			case http.StatusServiceUnavailable: // nil published — OK
			case http.StatusOK:
				var snap oclife.Snapshot
				if err := json.Unmarshal(body, &snap); err != nil {
					t.Errorf("decode status snapshot: %v", err)
					return
				}
				checkSnapshotIdentity(snap)
			default:
				t.Errorf("GET status: code = %d, want 200|503", res.StatusCode)
				return
			}
		}
	}
	logsRequester := func() {
		for i := 0; i < requesterIters; i++ {
			res, err := http.Get(web.URL + "/vh/opencode/logs")
			if err != nil {
				t.Errorf("GET logs: %v", err)
				return
			}
			body, _ := io.ReadAll(res.Body)
			_ = res.Body.Close()
			switch res.StatusCode {
			case http.StatusServiceUnavailable, http.StatusNotImplemented: // nil / external — OK
			case http.StatusOK: // owned — must carry the owned ring's marker
				if !strings.Contains(string(body), "life-owned marker") {
					t.Errorf("GET logs 200 body = %q, want the owned ring marker", string(body))
					return
				}
			default:
				t.Errorf("GET logs: code = %d, want 200|501|503", res.StatusCode)
				return
			}
		}
	}
	restartRequester := func() {
		for i := 0; i < requesterIters; i++ {
			req, _ := http.NewRequest(http.MethodPost, web.URL+"/vh/opencode/restart", nil)
			req.Header.Set("X-VH-CSRF", "1")
			res, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Errorf("POST restart: %v", err)
				return
			}
			body, _ := io.ReadAll(res.Body)
			_ = res.Body.Close()
			switch res.StatusCode {
			case http.StatusServiceUnavailable, http.StatusMethodNotAllowed: // nil / external — OK
			case http.StatusOK: // owned — post-restart snapshot must be the owned object
				var snap oclife.Snapshot
				if err := json.Unmarshal(body, &snap); err != nil {
					t.Errorf("decode restart snapshot: %v", err)
					return
				}
				checkSnapshotIdentity(snap)
			default:
				t.Errorf("POST restart: code = %d, want 200|405|503", res.StatusCode)
				return
			}
		}
	}

	// Two swappers + two requesters per endpoint, all concurrent.
	var swapWG, reqWG sync.WaitGroup
	for i := 0; i < 2; i++ {
		swapWG.Add(1)
		go func() { defer swapWG.Done(); swapper() }()
	}
	for _, rq := range []func(){statusRequester, logsRequester, restartRequester} {
		for i := 0; i < 2; i++ {
			reqWG.Add(1)
			go func(f func()) { defer reqWG.Done(); f() }(rq)
		}
	}
	// Requesters are iteration-bounded; once they finish, stop the swappers.
	reqWG.Wait()
	stop.Store(true)
	swapWG.Wait()
}

// --- controlled in-flight swap ---

// TestOpenCodeRestartInFlightSwapCompletesOnLoadedLifecycle proves the
// per-request coherence crux: a restart request that Loaded the OWNED
// lifecycle, and is parked inside the restart hook when an EXTERNAL lifecycle
// is published, completes without panic AND answers with the snapshot of the
// object it started with (owned) — the capability check at entry and the
// final snapshot describe one coherent lifecycle. With a per-read field
// access, the final snapshot could describe the mid-flight swap instead.
// Synchronization is channel-based (hook-entered / release), no sleeps.
func TestOpenCodeRestartInFlightSwapCompletesOnLoadedLifecycle(t *testing.T) {
	srv := newTestServer(t)
	owned, _ := newSwapFixtureLifecycles()
	srv.SetOpenCodeLifecycle(owned)

	hookEntered := make(chan struct{})
	releaseHook := make(chan struct{})
	srv.SetRestartOpenCode(func(context.Context) error {
		close(hookEntered)
		<-releaseHook
		owned.SetStarting()
		owned.SetReady()
		return nil
	})

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)

	type result struct {
		res *http.Response
		err error
	}
	resCh := make(chan result, 1)
	go func() {
		req, _ := http.NewRequest(http.MethodPost, web.URL+"/vh/opencode/restart", nil)
		req.Header.Set("X-VH-CSRF", "1")
		res, err := http.DefaultClient.Do(req)
		resCh <- result{res, err}
	}()

	// Park the request inside the restart hook (under `owned`)…
	<-hookEntered
	// …publish a different lifecycle mid-request…
	srv.SetOpenCodeLifecycle(oclife.New(oclife.TopologyExternal))
	// …then let the request finish.
	close(releaseHook)

	r := <-resCh
	if r.err != nil {
		t.Fatalf("POST /vh/opencode/restart: %v", r.err)
	}
	defer r.res.Body.Close()
	if r.res.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200 (the request completed against its loaded lifecycle)", r.res.StatusCode)
	}
	var snap oclife.Snapshot
	if err := json.NewDecoder(r.res.Body).Decode(&snap); err != nil {
		t.Fatalf("decode snapshot: %v", err)
	}
	if snap.Topology != oclife.TopologyOwned {
		t.Errorf("post-restart snapshot topology = %q, want %q (the lifecycle loaded at request start)", snap.Topology, oclife.TopologyOwned)
	}
	if snap.State != oclife.StateReady {
		t.Errorf("post-restart snapshot state = %q, want %q", snap.State, oclife.StateReady)
	}
}
