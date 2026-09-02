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
	"os"
	"os/exec"
	"strconv"
	"strings"
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
	oldGate := newOwnedExitGate()
	rt.ocReapDone = oldGate.Done()
	go reapOwnedOpenCode(oldChild, oldGate, rt.ocLife)
	if err := waitForPort(port, 10*time.Second); err != nil {
		t.Fatalf("old owned child never listened on %d: %v", port, err)
	}
	rt.ocLife.SetReady()

	// The pre-restart reality: the old child DIES (crash), then a FOREIGN
	// marker service squats the freed port.
	if err := oldChild.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatalf("stop old child: %v", err)
	}
	<-oldGate.Done() // reaper has fully recorded the exit — the port is free
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

// --- P1-API-006 A1: owned INITIAL boot truthfulness (behavioral crux) ---
//
// The client-daemon's owned boot arm (startOwnedOpenCode — the exact method
// setupVHMode calls) must never false-ready on a foreign port: the old arm
// spawned on an internally selected port and credited whatever answered the
// dial (waitForPort) — a squatter on that port yielded a false SetReady with
// the daemon's /oc/* proxy serving foreign content. The boot now routes
// through the same shared child-attributed core as the restart, and the
// effective URL is finalized BEFORE any consumer is constructed. These tests
// mirror the restart cruxes above (fake `opencode serve`, foreign marker
// service, real web.NewServer + httptest) and build the post-boot consumer
// surface exactly as setupVHMode does once the arm has returned.

// newOwnedBootRuntime wires a client-daemon runtime for the owned boot arm
// exactly as setupVHMode enters it: topology fixed, lifecycle built, initial
// candidate port pre-set (below the ephemeral range so freePort() cannot
// collide — the deterministic squatter/bind-race fixture).
func newOwnedBootRuntime(sc *ocLockScenario, port int) *clientDaemonRuntime {
	rt := &clientDaemonRuntime{cwd: sc.dir}
	rt.ocLife = oclife.New(oclife.TopologyOwned)
	rt.opencodePort = port
	return rt
}

// newOwnedBootHarness constructs the post-boot consumer surface exactly as
// setupVHMode does once the owned boot arm has returned and finalized
// rt.opencodeURL: aggregator + web server + lifecycle route on the FINALIZED
// effective URL. Asserting routed content through this surface proves the
// boot never wired consumers to a foreign listener.
func newOwnedBootHarness(t *testing.T, rt *clientDaemonRuntime) *httptest.Server {
	t.Helper()
	rt.ocLife.SetOpenCodeURL(rt.opencodeURL)
	agg := aggregator.New(rt.opencodeURL, vhEventRingCapacity)
	srv, err := web.NewServer(agg, rt.opencodeURL, vhEventRingCapacity)
	if err != nil {
		t.Fatalf("web.NewServer: %v", err)
	}
	srv.SetOpenCodeLifecycle(rt.ocLife)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// fakeSpawnCount counts the fake-child pid marker files the scenario's spawns
// have written — the deterministic "how many children were spawned" signal.
func fakeSpawnCount(t *testing.T, sc *ocLockScenario) int {
	t.Helper()
	entries, err := os.ReadDir(sc.pidsDir)
	if err != nil {
		t.Fatalf("read pids dir: %v", err)
	}
	n := 0
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".fake") {
			n++
		}
	}
	return n
}

// TestOwnedBootNeverServesForeignMarker — THE boot crux: a foreign marker
// service squats the initial candidate port BEFORE the daemon boots. The old
// dial-only arm would have credited the squatter and proxied its content as
// ready OpenCode. The child-attributed boot must instead move to a fresh port
// whose child is the REAL one, finalize the URL there, and the post-boot
// consumer surface must serve the replacement child's content — never the
// squatter's marker.
func TestOwnedBootNeverServesForeignMarker(t *testing.T) {
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, sc.bin)
	withDaemonOpenCodeDetached(t, false)
	port := pickLowPort(t) // below the ephemeral range: freePort() cannot collide

	// The squatter occupies the initial candidate port.
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("foreign listener on port %d: %v", port, err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		_ = http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, "foreign-squatter-marker") }))
	}()

	rt := newOwnedBootRuntime(sc, port)
	rt.startOwnedOpenCode()

	fresh := rt.opencodePort
	if fresh == port || fresh <= 0 {
		t.Fatalf("rt.opencodePort=%d after boot, want a fresh port != the squatted candidate %d", fresh, port)
	}
	wantURL := "http://127.0.0.1:" + strconv.Itoa(fresh)
	if rt.opencodeURL != wantURL {
		t.Fatalf("rt.opencodeURL=%q, want %q (the URL must finalize on the effective port)", rt.opencodeURL, wantURL)
	}
	snap := rt.ocLife.Snapshot()
	if snap.State != oclife.StateReady {
		t.Fatalf("lifecycle state=%s, want ready (attributed to the replacement child)", snap.State)
	}
	if snap.OpenCodeURL != wantURL {
		t.Fatalf("lifecycle OpenCodeURL=%q, want %q", snap.OpenCodeURL, wantURL)
	}

	// THE CRUX (outcome-level): the post-boot consumer surface — built on the
	// finalized URL exactly as setupVHMode builds it — serves the replacement
	// child's "ok", never the squatter's marker.
	ts := newOwnedBootHarness(t, rt)
	if code, body := ocGet(t, ts, "/oc/session"); code != 200 || body != "ok" {
		t.Fatalf("post-boot /oc/session through the consumer surface = %d/%q, want 200/ok from the replacement child — the squatter's marker was served as ready OpenCode content", code, body)
	}
	// Exactly one child was spawned (the squatted candidate never received a
	// doomed spawn), and it is alive.
	if n := fakeSpawnCount(t, sc); n != 1 {
		t.Fatalf("spawned %d fake children, want exactly 1 (the squatted candidate must not be handed a child)", n)
	}
	sc.waitAliveCount(".fake", 1, 5*time.Second)
}

// TestOwnedBootRetriesFreshPortWhenChildLosesBindRace — the boot bind-race
// crux: the initial candidate port is FREE, but the child spawned on it dies
// before readiness (lost check-to-bind race or crash — the core never tells
// them apart and never parses output). Exactly ONE fresh-port attempt follows
// and must carry the boot; readiness refers only to that replacement child.
func TestOwnedBootRetriesFreshPortWhenChildLosesBindRace(t *testing.T) {
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, sc.bin)
	withDaemonOpenCodeDetached(t, false)
	port := pickLowPort(t)
	// The initial-candidate child dies pre-readiness; the fresh-port child
	// (an ephemeral freePort) lives and listens.
	t.Setenv("VH_FAKE_OC_DIE_ON_PORT", strconv.Itoa(port))

	rt := newOwnedBootRuntime(sc, port)
	rt.startOwnedOpenCode()

	fresh := rt.opencodePort
	if fresh == port || fresh <= 0 {
		t.Fatalf("rt.opencodePort=%d after boot, want the fresh-port retry's port != %d", fresh, port)
	}
	wantURL := "http://127.0.0.1:" + strconv.Itoa(fresh)
	if rt.opencodeURL != wantURL {
		t.Fatalf("rt.opencodeURL=%q, want %q", rt.opencodeURL, wantURL)
	}
	snap := rt.ocLife.Snapshot()
	if snap.State != oclife.StateReady {
		t.Fatalf("lifecycle state=%s, want ready (readiness must be attributed only to the replacement child)", snap.State)
	}
	if snap.OpenCodeURL != wantURL {
		t.Fatalf("lifecycle OpenCodeURL=%q, want %q", snap.OpenCodeURL, wantURL)
	}
	if code, body := ocGet(t, newOwnedBootHarness(t, rt), "/oc/session"); code != 200 || body != "ok" {
		t.Fatalf("post-boot /oc/session = %d/%q, want 200/ok from the retry's fresh child", code, body)
	}
	// AT MOST ONE fresh retry: exactly two spawns total (candidate + retry),
	// exactly one alive (the dead candidate left no live fake).
	if n := fakeSpawnCount(t, sc); n != 2 {
		t.Fatalf("spawned %d fake children, want exactly 2 (initial candidate + ONE fresh retry — recovery is bounded)", n)
	}
	sc.waitAliveCount(".fake", 1, 5*time.Second)
}

// TestOwnedBootExhaustedKeepsServing — the boot fail-closed crux: BOTH the
// initial-candidate child and the one fresh retry die before readiness. The
// boot fails, the lifecycle records failed (visible through the consumer
// surface), and the daemon's serving shape is preserved (p1-oc-001): the
// finalized URL stays a parseable dead loopback — the proxy answers 502, not
// foreign content.
func TestOwnedBootExhaustedKeepsServing(t *testing.T) {
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, sc.bin)
	withDaemonOpenCodeDetached(t, false)
	port := pickLowPort(t)
	t.Setenv("VH_FAKE_OC_DIE_FAST", "1") // every boot child dies pre-readiness

	rt := newOwnedBootRuntime(sc, port)
	rt.startOwnedOpenCode()

	snap := rt.ocLife.Snapshot()
	if snap.State != oclife.StateFailed {
		t.Fatalf("lifecycle state=%s, want failed after boot exhaustion", snap.State)
	}
	if snap.FailureSummary == "" {
		t.Fatal("exhaustion must record a failure summary")
	}
	// The URL still finalized on the last attempted port — parseable, dead.
	if rt.opencodeURL != fmt.Sprintf("http://127.0.0.1:%d", rt.opencodePort) {
		t.Fatalf("rt.opencodeURL=%q, want the finalized dead loopback on port %d", rt.opencodeURL, rt.opencodePort)
	}
	// p1-oc-001 outcome through the consumer surface: the server the daemon
	// WOULD serve answers — status honestly failed…
	ts := newOwnedBootHarness(t, rt)
	res, err := http.Get(ts.URL + "/vh/opencode/status")
	if err != nil {
		t.Fatalf("GET /vh/opencode/status: %v", err)
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
		t.Fatalf("status = %s/%q, want failed with a summary", st.State, st.Summary)
	}
	// …and the /oc proxy answers 502 from the dead target — never foreign
	// content masquerading as ready OpenCode.
	if code, body := ocGet(t, ts, "/oc/session"); code != http.StatusBadGateway {
		t.Fatalf("/oc/session = %d/%q, want 502 from the dead boot target (keep-serving, no foreign content)", code, body)
	}
	if n := fakeSpawnCount(t, sc); n != 2 {
		t.Fatalf("spawned %d fake children, want exactly 2 (candidate + one retry, then exhaustion)", n)
	}
	sc.waitAliveCount(".fake", 0, 5*time.Second)
}

// TestOwnedBootPostReadyCrashFlipsFailed — the boot observer crux: after a
// GENUINE child-attributed readiness, the boot child's death must transition
// the lifecycle ready → failed (the sole-reaper gate installed by the boot's
// Spawn closure), never leave it stuck on ready.
func TestOwnedBootPostReadyCrashFlipsFailed(t *testing.T) {
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, sc.bin)
	withDaemonOpenCodeDetached(t, false)
	port := pickLowPort(t)

	rt := newOwnedBootRuntime(sc, port)
	rt.startOwnedOpenCode()

	if s := rt.ocLife.Snapshot(); s.State != oclife.StateReady {
		t.Fatalf("lifecycle state=%s after a healthy boot, want ready", s.State)
	}
	if rt.opencodeServeCmd == nil || rt.opencodeServeCmd.Process == nil {
		t.Fatal("the boot child handle must be retained for the crash")
	}

	// The post-readiness crash.
	if err := rt.opencodeServeCmd.Process.Kill(); err != nil {
		t.Fatalf("kill boot child: %v", err)
	}
	select {
	case <-rt.ocReapDone:
	case <-time.After(10 * time.Second):
		t.Fatal("the boot child's observer never recorded the exit")
	}
	if s := rt.ocLife.Snapshot(); s.State != oclife.StateFailed {
		t.Fatalf("lifecycle state=%s after a post-ready crash, want failed (the boot observer must flip ready → failed)", s.State)
	}
	sc.waitAliveCount(".fake", 0, 5*time.Second)
}

// TestOwnedRestartStopPathKillsWedgedOldChild — THE R11 behavioral crux for
// the client-daemon arm, through its production restart entry
// (rt.restartOpencode under rt.opencodeMu — exactly what the
// SetRestartOpenCode hook calls): the old owned child IGNORES SIGTERM
// (VH_FAKE_OC_IGNORE_SIGTERM, ambient before the old child is spawned), so
// the bounded stop must escalate — SIGTERM grace expires, the old child is
// SIGKILLed, the restart COMPLETES within the bound, and the replacement
// serves through the running server. The unbounded predecessor hung this
// handler — and every later opencodeMu holder — on exactly this fixture.
func TestOwnedRestartStopPathKillsWedgedOldChild(t *testing.T) {
	withOwnedStopBounds(t, 750*time.Millisecond, 2*time.Second)
	sc := newOCLockScenario(t)
	withDaemonOpenCodeBin(t, sc.bin)
	withDaemonOpenCodeDetached(t, false)
	port := pickLowPort(t)
	// The OLD child (spawned below) is the wedged one: env is read at spawn
	// time, so this must be set before startOpenCodeServe.
	t.Setenv("VH_FAKE_OC_IGNORE_SIGTERM", "1")

	rt, ts := newOwnedRestartHarness(t, sc, port)

	// The OLD owned child, spawned exactly as the boot arm spawns it, with
	// the production sole-reaper wiring — and the wedged SIGTERM posture.
	oldChild, err := startOpenCodeServe(sc.bin, port, sc.dir, rt.ocLife.Ring().Writer())
	if err != nil {
		t.Fatalf("start old owned child: %v", err)
	}
	t.Cleanup(func() { _ = oldChild.Process.Kill() }) // no Wait: the reaper owns it
	rt.opencodeServeCmd = oldChild
	oldGate := newOwnedExitGate()
	rt.ocReapDone = oldGate.Done()
	go reapOwnedOpenCode(oldChild, oldGate, rt.ocLife)
	if err := waitForPort(port, 10*time.Second); err != nil {
		t.Fatalf("old owned child never listened on %d: %v", port, err)
	}
	rt.ocLife.SetReady()

	start := time.Now()
	rt.opencodeMu.Lock()
	err = rt.restartOpencode()
	rt.opencodeMu.Unlock()
	elapsed := time.Since(start)
	if err != nil {
		t.Fatalf("restartOpencode with a wedged old child: %v", err)
	}
	// Bounded, not merely eventual (generous CI ceiling; the unbounded
	// predecessor never returned at all).
	if elapsed > 15*time.Second {
		t.Fatalf("restart took %v — the bounded stop did not bound it", elapsed)
	}
	// The wedged old child is DEAD — the SIGKILL escalation fired.
	if !waitPidDead(oldChild.Process.Pid, 5*time.Second) {
		t.Fatalf("wedged old child pid %d survived the restart — the SIGKILL escalation did not fire", oldChild.Process.Pid)
	}
	snap := rt.ocLife.Snapshot()
	if snap.State != oclife.StateReady {
		t.Fatalf("lifecycle state=%s, want ready", snap.State)
	}
	if code, body := ocGet(t, ts, "/oc/session"); code != 200 || body != "ok" {
		t.Fatalf("post-restart /oc/session through the RUNNING server = %d/%q, want 200/ok from the replacement — the restart did not complete through the fresh child", code, body)
	}
	sc.waitAliveCount(".fake", 1, 5*time.Second)
}
