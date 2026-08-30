//go:build linux

package cmd

// P1-API-003 behavioral crux: after a foreign-listener fresh-port restart of
// the detached OpenCode, the STILL-RUNNING daemon must immediately serve
// through the NEW port. The assertion is outcome-level — a request through
// the live web server returns the marker body ONLY the new upstream serves
// (the fake `opencode serve`), never the marker the foreign squatter on the
// old port serves. Field-only assertions (rt.opencodePort flipped, a
// Snapshot().OpenCodeURL changed) would not prove the running proxy/aggregator
// actually re-routed.

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/oclife"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// withDaemonOpenCodeDetached toggles the client-daemon --opencode-detached
// flag global for a test (the detached restart arm reads it; tests restore
// it). Mirrors withDaemonOpenCodeBin.
func withDaemonOpenCodeDetached(t *testing.T, v bool) {
	t.Helper()
	old := daemonOpenCodeDetached
	daemonOpenCodeDetached = v
	t.Cleanup(func() { daemonOpenCodeDetached = old })
}

// TestRestartRetargetsRunningServerToFreshPort — the daemon's web server is
// already serving against port P when a UI-requested restart finds P squatted
// by a FOREIGN listener: the serialized restart lands on a fresh port, and
// BEFORE flipping readiness the daemon re-targets the ocLife status URL and
// the running web server (proxy + aggregators). Proven here end-to-end
// through rt.restartOpencode — the exact method the production restart hook
// calls — with a real web.NewServer behind an httptest listener.
func TestRestartRetargetsRunningServerToFreshPort(t *testing.T) {
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, sc.bin)
	withDaemonOpenCodeDetached(t, true)

	// The old target: a foreign HTTP listener squatting a LOW port (below
	// the ephemeral range — freePort() can never collide with it), serving
	// a marker body nothing else in the scenario serves.
	port := pickLowPort(t)
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("foreign listener on port %d: %v", port, err)
	}
	go func() {
		_ = http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "foreign-squatter-marker") }))
	}()
	t.Cleanup(func() { ln.Close() })

	// Stale recorded state naming a live FOREIGN pid on the squatted port:
	// the restart's kill phase must skip it (cmdline mismatch).
	sacrifice := exec.Command("sleep", "300")
	if err := sacrifice.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = sacrifice.Process.Kill()
		_ = sacrifice.Wait()
	})
	writeOCState(ocState{PID: sacrifice.Process.Pid, Port: port})

	// The RUNNING daemon: topology state wired as the boot path would have
	// (port P + its URL), a real lifecycle, and a real web server whose
	// proxy/aggregators captured the old target at construction.
	oldURL := fmt.Sprintf("http://127.0.0.1:%d", port)
	rt := &clientDaemonRuntime{cwd: sc.dir}
	rt.ocLife = oclife.New(oclife.TopologyDetached)
	rt.opencodePort = port
	rt.opencodeURL = oldURL
	rt.ocLife.SetOpenCodeURL(oldURL)
	agg := aggregator.New(oldURL, vhEventRingCapacity)
	srv, err := web.NewServer(agg, oldURL, vhEventRingCapacity)
	if err != nil {
		t.Fatalf("web.NewServer: %v", err)
	}
	rt.vhSrv = srv
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)

	// Pre-check: the running server currently serves the FOREIGN squatter
	// through /oc/* — this is the "old port" the restart must move off.
	if code, body := ocGet(t, ts, "/oc/session"); code != 200 || body != "foreign-squatter-marker" {
		t.Fatalf("pre-restart /oc/session = %d/%q, want the foreign squatter's marker", code, body)
	}

	// The production restart entry (the srv.SetRestartOpenCode hook calls
	// exactly this, under exactly this lock).
	rt.opencodeMu.Lock()
	err = rt.restartOpencode()
	rt.opencodeMu.Unlock()
	if err != nil {
		t.Fatalf("restartOpencode beside a foreign listener: %v", err)
	}

	fresh := rt.opencodePort
	if fresh == port || fresh <= 0 {
		t.Fatalf("rt.opencodePort=%d after restart, want a fresh port != the squatted %d", fresh, port)
	}
	wantURL := "http://127.0.0.1:" + strconv.Itoa(fresh)
	if rt.opencodeURL != wantURL {
		t.Fatalf("rt.opencodeURL=%q, want %q", rt.opencodeURL, wantURL)
	}
	snap := rt.ocLife.Snapshot()
	if snap.State != oclife.StateReady {
		t.Fatalf("lifecycle state=%s, want ready", snap.State)
	}
	if snap.OpenCodeURL != wantURL {
		t.Fatalf("lifecycle OpenCodeURL=%q, want %q (the status URL must follow the fresh port)", snap.OpenCodeURL, wantURL)
	}
	st, ok := readOCState()
	if !ok || st.Port != fresh {
		t.Fatalf("published state=%+v ok=%v, want the fresh port %d", st, ok, fresh)
	}

	// THE CRUX (outcome-level): the STILL-RUNNING server now serves through
	// the NEW port. The fresh fake `opencode serve` answers every request
	// with body "ok"; the only other possible source — the foreign squatter
	// still on the old port — serves a different marker. A body of "ok"
	// proves the request traversed the running server's proxy to the NEW
	// upstream, not a field flip.
	if code, body := ocGet(t, ts, "/oc/session"); code != 200 || body != "ok" {
		t.Fatalf("post-restart /oc/session through the RUNNING server = %d/%q, want 200/ok from the fresh upstream — the daemon kept serving through the old port", code, body)
	}
	if !ocProcessAlive(sacrifice.Process.Pid) {
		t.Fatal("the foreign recorded pid must stay untouched")
	}
	sc.waitAliveCount(".fake", 1, 5*time.Second)
}

// ocGet fetches path through the running httptest server (the /oc reverse
// proxy route) and returns status + body.
func ocGet(t *testing.T, ts *httptest.Server, path string) (int, string) {
	t.Helper()
	res, err := http.Get(ts.URL + path)
	if err != nil {
		t.Fatalf("GET %s through the running server: %v", path, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

// --- P1-API-005: owned-topology restart truthfulness (behavioral crux) ---
//
// The owned restart must never false-ready on a foreign port: the old code
// respawned on the fixed stable port with no occupied guard, and its
// dial-only waitForPort credited a FOREIGN squatter's dial acceptance after
// the replacement child bind-failed — false SetReady with the running /oc/*
// proxy serving foreign content. These tests mirror the detached crux above:
// real web.NewServer + httptest, a foreign marker service, and the PRODUCTION
// restart path (rt.restartOpencode under rt.opencodeMu), asserting on routed
// response markers rather than fields.

// newOwnedRestartHarness wires a client-daemon runtime in the owned topology
// exactly as the boot path would have left it (port + URL + lifecycle URL), a
// real web server whose proxy/aggregators captured the old target, and the
// /vh/opencode/status lifecycle route.
func newOwnedRestartHarness(t *testing.T, sc *ocLockScenario, port int) (*clientDaemonRuntime, *httptest.Server) {
	t.Helper()
	rt := &clientDaemonRuntime{cwd: sc.dir}
	rt.ocLife = oclife.New(oclife.TopologyOwned)
	rt.opencodePort = port
	rt.opencodeURL = fmt.Sprintf("http://127.0.0.1:%d", port)
	rt.ocLife.SetOpenCodeURL(rt.opencodeURL)
	agg := aggregator.New(rt.opencodeURL, vhEventRingCapacity)
	srv, err := web.NewServer(agg, rt.opencodeURL, vhEventRingCapacity)
	if err != nil {
		t.Fatalf("web.NewServer: %v", err)
	}
	srv.SetOpenCodeLifecycle(rt.ocLife)
	rt.vhSrv = srv
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return rt, ts
}

// TestOwnedRestartNeverServesForeignMarker — THE crux: the owned child died,
// a foreign marker service squatted its port, and the operator hits restart.
// The restart must move to a fresh port whose child is the REAL replacement
// (attribution via the child's liveness, not the dial), retarget the running
// server BEFORE readiness, and never serve the foreign marker as restarted
// OpenCode content.
func TestOwnedRestartNeverServesForeignMarker(t *testing.T) {
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, sc.bin)
	withDaemonOpenCodeDetached(t, false)
	port := pickLowPort(t) // below the ephemeral range: freePort() cannot collide

	rt, ts := newOwnedRestartHarness(t, sc, port)

	// The OLD owned child, spawned exactly as the boot arm spawns it, with
	// the production sole-reaper wiring.
	oldChild, err := startOpenCodeServe(sc.bin, port, sc.dir, rt.ocLife.Ring().Writer())
	if err != nil {
		t.Fatalf("start old owned child: %v", err)
	}
	t.Cleanup(func() { _ = oldChild.Process.Kill() }) // no Wait: the reaper owns it
	rt.opencodeServeCmd = oldChild
	oldDone := make(chan struct{})
	rt.ocReapDone = oldDone
	go reapOwnedOpenCode(oldChild, oldDone, rt.ocLife)
	if err := waitForPort(port, 10*time.Second); err != nil {
		t.Fatalf("old owned child never listened on %d: %v", port, err)
	}
	rt.ocLife.SetReady()

	// The pre-restart reality: the old child DIES (crash), then a FOREIGN
	// marker service squats the freed port.
	if err := oldChild.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("stop old child: %v", err)
	}
	<-oldDone // reaper has fully recorded the exit — the port is free
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("foreign listener on port %d: %v", port, err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		_ = http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "foreign-squatter-marker") }))
	}()

	// Pre-check: the still-running server now serves the FOREIGN squatter
	// through /oc/* — the poisoned state the restart must never bless.
	if code, body := ocGet(t, ts, "/oc/session"); code != 200 || body != "foreign-squatter-marker" {
		t.Fatalf("pre-restart /oc/session = %d/%q, want the foreign squatter's marker", code, body)
	}

	// The production restart entry (the srv.SetRestartOpenCode hook calls
	// exactly this, under exactly this lock).
	rt.opencodeMu.Lock()
	err = rt.restartOpencode()
	rt.opencodeMu.Unlock()
	if err != nil {
		t.Fatalf("owned restart beside a foreign squatter: %v", err)
	}

	fresh := rt.opencodePort
	if fresh == port || fresh <= 0 {
		t.Fatalf("rt.opencodePort=%d after restart, want a fresh port != the squatted %d", fresh, port)
	}
	wantURL := "http://127.0.0.1:" + strconv.Itoa(fresh)
	if rt.opencodeURL != wantURL {
		t.Fatalf("rt.opencodeURL=%q, want %q", rt.opencodeURL, wantURL)
	}
	snap := rt.ocLife.Snapshot()
	if snap.State != oclife.StateReady {
		t.Fatalf("lifecycle state=%s, want ready", snap.State)
	}
	if snap.OpenCodeURL != wantURL {
		t.Fatalf("lifecycle OpenCodeURL=%q, want %q (the status URL must follow the fresh child)", snap.OpenCodeURL, wantURL)
	}

	// THE CRUX (outcome-level): the STILL-RUNNING server serves through the
	// FRESH replacement child — body "ok" is served only by the fresh fake
	// `opencode serve`; the foreign squatter on the old port serves a
	// different marker. A body of "ok" proves both that the proxy re-routed
	// and that readiness was never credited to the squatter.
	if code, body := ocGet(t, ts, "/oc/session"); code != 200 || body != "ok" {
		t.Fatalf("post-restart /oc/session through the RUNNING server = %d/%q, want 200/ok from the fresh child — the foreign marker was served as restarted OpenCode content", code, body)
	}
	// The old fake died; exactly one fresh replacement is alive.
	sc.waitAliveCount(".fake", 1, 5*time.Second)
}

// TestOwnedRestartRetriesFreshPortWhenChildLosesBindRace — the R2 TOCTOU fold
// at the behavioral level: the stable port is FREE at the guard, but the
// replacement child on it dies before readiness (a lost check-to-bind race or
// a crash — the core deliberately cannot tell and never parses output).
// Exactly ONE fresh-port attempt follows and must carry the restart.
func TestOwnedRestartRetriesFreshPortWhenChildLosesBindRace(t *testing.T) {
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, sc.bin)
	withDaemonOpenCodeDetached(t, false)
	port := pickLowPort(t)
	// The stable-port child dies pre-readiness; the fresh-port child (an
	// ephemeral freePort) lives and listens.
	t.Setenv("VH_FAKE_OC_DIE_ON_PORT", strconv.Itoa(port))

	rt, ts := newOwnedRestartHarness(t, sc, port)

	rt.opencodeMu.Lock()
	err := rt.restartOpencode()
	rt.opencodeMu.Unlock()
	if err != nil {
		t.Fatalf("owned restart after a lost bind race: %v", err)
	}

	fresh := rt.opencodePort
	if fresh == port || fresh <= 0 {
		t.Fatalf("rt.opencodePort=%d after restart, want the fresh-port retry's port != %d", fresh, port)
	}
	wantURL := "http://127.0.0.1:" + strconv.Itoa(fresh)
	if rt.opencodeURL != wantURL {
		t.Fatalf("rt.opencodeURL=%q, want %q", rt.opencodeURL, wantURL)
	}
	snap := rt.ocLife.Snapshot()
	if snap.State != oclife.StateReady {
		t.Fatalf("lifecycle state=%s, want ready (the reaper's failure for the lost stable-port child must be overwritten ONLY by the retry's success)", snap.State)
	}
	if snap.OpenCodeURL != wantURL {
		t.Fatalf("lifecycle OpenCodeURL=%q, want %q", snap.OpenCodeURL, wantURL)
	}
	if code, body := ocGet(t, ts, "/oc/session"); code != 200 || body != "ok" {
		t.Fatalf("post-restart /oc/session through the RUNNING server = %d/%q, want 200/ok from the retry's fresh child", code, body)
	}
	// The dead stable-port attempt left no live fake; the fresh one lives.
	sc.waitAliveCount(".fake", 1, 5*time.Second)
}

// TestOwnedRestartExhaustedKeepsServing — the fail-closed crux: BOTH attempts'
// children die before readiness. The restart fails, the lifecycle records
// failed (visible through the still-running server), and vh-solara keeps
// serving — the p1-oc-001 invariant.
func TestOwnedRestartExhaustedKeepsServing(t *testing.T) {
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, sc.bin)
	withDaemonOpenCodeDetached(t, false)
	port := pickLowPort(t)
	t.Setenv("VH_FAKE_OC_DIE_FAST", "1") // every replacement dies pre-readiness

	rt, ts := newOwnedRestartHarness(t, sc, port)

	rt.opencodeMu.Lock()
	err := rt.restartOpencode()
	rt.opencodeMu.Unlock()
	if err == nil {
		t.Fatal("exhausted owned restart must fail")
	}

	// Lifecycle failed with a recorded summary…
	snap := rt.ocLife.Snapshot()
	if snap.State != oclife.StateFailed {
		t.Fatalf("lifecycle state=%s, want failed", snap.State)
	}
	if snap.FailureSummary == "" {
		t.Fatal("exhaustion must record a failure summary")
	}

	// …and vh-solara KEEPS SERVING: the still-running server answers both
	// the lifecycle status (reporting the failure honestly)…
	res, err := http.Get(ts.URL + "/vh/opencode/status")
	if err != nil {
		t.Fatalf("GET /vh/opencode/status through the running server: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("/vh/opencode/status = %d, want 200 (keep-serving)", res.StatusCode)
	}
	var st struct {
		State   string `json:"state"`
		Summary string `json:"failure_summary"`
	}
	if err := json.NewDecoder(res.Body).Decode(&st); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	if st.State != string(oclife.StateFailed) || st.Summary == "" {
		t.Fatalf("status = %s/%q, want failed with a summary (the running server reports the honest failure)", st.State, st.Summary)
	}

	// …and the /oc proxy, still targeting the truthful dead old URL, answers
	// 502 rather than foreign content.
	if code, body := ocGet(t, ts, "/oc/session"); code != http.StatusBadGateway {
		t.Fatalf("/oc/session = %d/%q, want 502 from the dead old target (keep-serving, no foreign content)", code, body)
	}

	// Both replacement children died; nothing lingers.
	sc.waitAliveCount(".fake", 0, 5*time.Second)
}
