//go:build linux

package cmd

// P1-API-005 / Slice 2 — local-server owned-restart behavioral closure
// through the REAL accepted restart trigger.
//
// P1-API-006 / Slice A2 — owned BOOT parity: the boot arm now routes through
// the shared child-attributed core (startLocalOwnedOpenCode — the exact
// function the Run arm calls), so the boot cruxes mirror A1's client-daemon
// trio: squatter on the initial candidate is never credited, ONE fresh-port
// retry on a pre-readiness child exit, exhaustion fails closed while the
// server keeps serving (the P2-API-005 keep-serving crux, through the REAL
// localServerCmd.Run), and a post-readiness boot-child crash flips ocLife
// ready → failed (P1-API-005 DEFER 3, through the REAL Run).
//
// Slice 1 landed the shared child-aware core (restartOwnedOpenCode) and
// client-daemon's behavioral crux trio; its review flagged the local-server
// arm as "retarget verified structurally, not behaviorally". These tests
// close that gap: they run the ACTUAL localServerCmd.Run in-process — real
// cobra command, real boot arm (owned spawn + readiness), real web server,
// real aggregator, real restart hook — and drive the accepted restart path
// end-to-end:
//
//	POST /vh/restart-opencode  →  handleRestartOpenCode  →  restartOC
//	  →  restartOpencodeLocked (under opencodeMu)  →  restartOwnedOpenCode
//
// The assertions are OUTCOME-level through the still-running server: the
// routed /oc/* content (marker bodies, never fields) and the lifecycle
// status endpoint. Linux-gated like Slice 1's crux trio because the fake
// `opencode serve` scenario machinery (pidfiles, /proc-scoped helpers) is
// linux-anchored; the shared core's portable semantics stay covered by
// opencode_owned_restart_test.go.

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/oclife"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// lsClient carries the generous timeout a real restart needs (the trigger is
// synchronous: it returns only after readiness or bounded exhaustion).
var lsClient = &http.Client{Timeout: 60 * time.Second}

// --- P1-API-005 DEFER 4: cobra-test containment contract (P1-API-006 A2) ---
//
// These scenarios mutate process-global state: the cobra-bound package flag
// vars (complete snapshot/restore in withLocalServerFlags), the process cwd
// (t.Chdir via newOCLockScenario), ambient env (t.Setenv, restored per
// test), and the process-lifetime HTTP listeners each `go
// localServerCmd.Run` leaves behind (the keep-serving posture under test —
// the unique per-test ports from bootLocalServerForTest keep them from
// colliding). lsSerial mechanically serializes every local-server fixture
// test against the others, so a future t.Parallel anywhere in this fixture
// family cannot interleave two scenarios mid-mutation. No local-server test
// calls t.Parallel.
//
// Subprocess isolation is deliberately NOT used: no leakage that in-process
// containment cannot absorb has been demonstrated. The residual
// process-lifetime state is the spawned servers themselves — which is the
// behavior under test — plus their captured per-scenario state dirs, which
// die with the per-test t.TempDir (writeDaemonState lands inside the
// scenario-scoped VH_STATE_DIR).
var lsFixtureMu sync.Mutex

// lsSerial acquires the package-level local-server fixture guard for the
// test's duration (released by t.Cleanup). Called ONCE per test, from the
// fixture entry points (withLocalServerFlags / startLocalBootSeam) — the
// guard is not reentrant.
func lsSerial(t *testing.T) {
	t.Helper()
	lsFixtureMu.Lock()
	t.Cleanup(lsFixtureMu.Unlock)
}

// withLocalServerFlags points the local-server command at a test scenario
// (fake bin, loopback addr, no auth) and restores every flag global after —
// the same save/restore discipline as withDaemonOpenCodeBin. The snapshot is
// COMPLETE over the command's cobra-bound package vars (the var block in
// local-server.go), including the ones these tests never set
// (localOpenCodeUpdate), so a future test that does set them inherits the
// containment instead of re-deriving it.
func withLocalServerFlags(t *testing.T, sc *ocLockScenario, addr string) {
	t.Helper()
	lsSerial(t)
	oldAddr, oldBin := localAddr, localOpenCodeBin
	oldURL, oldDetached, oldRestart := localOpenCodeURL, localOpenCodeDetached, localOpenCodeRestart
	oldUpdate := localOpenCodeUpdate
	oldSock, oldExt := localVHSock, localExternalManaged
	oldCORS, oldFrame := localCORSOrigins, localFrameAncestors
	oldAuth := localAuth
	t.Cleanup(func() {
		localAddr, localOpenCodeBin = oldAddr, oldBin
		localOpenCodeURL, localOpenCodeDetached, localOpenCodeRestart = oldURL, oldDetached, oldRestart
		localOpenCodeUpdate = oldUpdate
		localVHSock, localExternalManaged = oldSock, oldExt
		localCORSOrigins, localFrameAncestors = oldCORS, oldFrame
		localAuth = oldAuth
	})
	localAddr = addr
	localOpenCodeBin = sc.bin
	localOpenCodeURL = ""         // owned topology: local-server spawns `opencode serve`
	localOpenCodeDetached = false // not the detached arm
	localOpenCodeRestart = ""
	localVHSock = ""
	localExternalManaged = false
	localCORSOrigins = nil
	localFrameAncestors = nil
	localAuth = authFlags{mode: "none"} // allowed on the loopback bind below
}

// useVersionFakeBin swaps the scenario's fake `opencode` wrapper for one
// that also answers `--version`: the real local-server boot path runs
// `<bin> --version` (opencodeCurrentVersion), and the shared scenario fake
// only models `serve` — without this the boot probe would hang forever.
// The serve path is byte-identical to the scenario's own script (including
// the VH_OC_LOCK_HELPER=fake dispatch gate the helper requires).
func useVersionFakeBin(t *testing.T, sc *ocLockScenario) {
	t.Helper()
	script := "#!/bin/sh\n" +
		"export VH_OC_LOCK_HELPER=fake\n" +
		"if [ \"$1\" = \"--version\" ]; then echo \"1.2.3-fake\"; exit 0; fi\n" +
		"exec \"$VH_OC_TESTBIN\" -test.run='^TestOCLockHelperProcess$' -- opencode \"$@\"\n"
	if err := os.WriteFile(sc.bin, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
}

// localServerHandle addresses a real in-process local-server.
type localServerHandle struct {
	base string // http://127.0.0.1:<port>
}

func (h *localServerHandle) statusURL() string  { return h.base + "/vh/opencode/status" }
func (h *localServerHandle) restartURL() string { return h.base + "/vh/restart-opencode" }

// lsStatus fetches /vh/opencode/status through the running server.
func lsStatus(t *testing.T, h *localServerHandle) oclife.Snapshot {
	t.Helper()
	res, err := lsClient.Get(h.statusURL())
	if err != nil {
		t.Fatalf("GET /vh/opencode/status through the running server: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		t.Fatalf("/vh/opencode/status = %d, want 200 (local-server keeps serving)", res.StatusCode)
	}
	var snap oclife.Snapshot
	if err := json.NewDecoder(res.Body).Decode(&snap); err != nil {
		t.Fatalf("decode status: %v", err)
	}
	return snap
}

// lsOcGet fetches path through the running server's /oc reverse proxy and
// returns status + body (marker-level assertions).
func lsOcGet(t *testing.T, h *localServerHandle, path string) (int, string) {
	t.Helper()
	res, err := lsClient.Get(h.base + path)
	if err != nil {
		t.Fatalf("GET %s through the running server: %v", path, err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

// lsRestartTrigger drives the REAL accepted restart path: the production
// HTTP handler (handleRestartOpenCode → restartOC → restartOpencodeLocked
// under opencodeMu → the shared child-aware core). X-VH-CSRF: 1 is the same
// header the SPA's installCsrf() sends on state-changing /vh/* requests.
func lsRestartTrigger(t *testing.T, h *localServerHandle) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, h.restartURL(), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-VH-CSRF", "1")
	res, err := lsClient.Do(req)
	if err != nil {
		t.Fatalf("POST /vh/restart-opencode through the running server: %v", err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

// lsPortFromURL extracts the port from an opencode_url snapshot field.
func lsPortFromURL(t *testing.T, u string) int {
	t.Helper()
	pu, err := url.Parse(u)
	if err != nil {
		t.Fatalf("parse opencode_url %q: %v", u, err)
	}
	p, err := strconv.Atoi(pu.Port())
	if err != nil || p <= 0 {
		t.Fatalf("opencode_url %q has no usable port", u)
	}
	return p
}

// waitLSBootState polls the running server's lifecycle status until it
// reaches the wanted state; returns the satisfying snapshot. Every poll
// that gets an HTTP response must see 200 — machine-asserted here (the
// lsStatus discipline), not comment-carried: keep-serving means the
// status endpoint answers 200 through the running server WHATEVER the
// lifecycle state is, so a non-200 is a defect, not a poll miss.
// Transport errors (the server not listening yet) still poll until the
// deadline.
func waitLSBootState(t *testing.T, h *localServerHandle, want oclife.State) oclife.Snapshot {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var last string
	for {
		res, err := lsClient.Get(h.statusURL())
		if err == nil {
			if res.StatusCode != 200 {
				res.Body.Close()
				t.Fatalf("/vh/opencode/status = %d, want 200 (local-server keeps serving)", res.StatusCode)
			}
			var snap oclife.Snapshot
			_ = json.NewDecoder(res.Body).Decode(&snap)
			res.Body.Close()
			last = fmt.Sprintf("state=%s url=%s", snap.State, snap.OpenCodeURL)
			if snap.State == want {
				return snap
			}
		} else {
			last = err.Error()
		}
		if time.Now().After(deadline) {
			t.Fatalf("local-server boot never reached %s (last: %s)", want, last)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// waitLSBootReady polls the running server until the real owned boot arm has
// spawned the fake child and flipped the lifecycle ready; returns the boot
// port the runtime recorded (the stable port the restart will target).
func waitLSBootReady(t *testing.T, h *localServerHandle) int {
	t.Helper()
	snap := waitLSBootState(t, h, oclife.StateReady)
	if snap.OpenCodeURL == "" {
		t.Fatalf("ready snapshot carries no opencode_url: %+v", snap)
	}
	return lsPortFromURL(t, snap.OpenCodeURL)
}

// waitPortClosed polls until nothing accepts on the port (the listener died
// with its process; the process itself may still be an unreaped zombie —
// the restart path's Wait owns the reap).
func waitPortClosed(t *testing.T, port int, d time.Duration) {
	t.Helper()
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	deadline := time.Now().Add(d)
	for {
		conn, err := net.DialTimeout("tcp", addr, 250*time.Millisecond)
		if err != nil {
			return // refused: the listener is gone
		}
		conn.Close()
		if time.Now().After(deadline) {
			t.Fatalf("port %d still accepting after %v", port, d)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// bootLocalServerForTest runs the REAL localServerCmd.Run in a goroutine
// (it blocks in ListenAndServe for the rest of the test process — the
// keep-serving posture under test) and returns immediately; the caller waits
// for the boot outcome it expects (waitLSBootReady / waitLSBootState). The
// server's own port is picked up front per test (bind :0, read, release —
// the repo's standard freePort pattern; Run re-binds it moments later), so
// every scenario's process-lifetime listener is unique. The scenario sweep +
// flag restore handle cleanup.
func bootLocalServerForTest(t *testing.T) (*localServerHandle, *ocLockScenario) {
	t.Helper()
	sc := newOCLockScenario(t)
	useVersionFakeBin(t, sc)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	withLocalServerFlags(t, sc, fmt.Sprintf("127.0.0.1:%d", port))

	go localServerCmd.Run(nil, nil)

	return &localServerHandle{base: fmt.Sprintf("http://127.0.0.1:%d", port)}, sc
}

// startLocalServerForTest runs bootLocalServerForTest and waits out the real
// owned boot's readiness (the historical trio's entry).
func startLocalServerForTest(t *testing.T) (*localServerHandle, *ocLockScenario, int) {
	t.Helper()
	h, sc := bootLocalServerForTest(t)
	return h, sc, waitLSBootReady(t, h)
}

// TestLocalServerOwnedRestartNeverServesForeignMarker — THE crux, through
// the real trigger: the owned child died, a foreign marker service squatted
// its port, and the operator hits restart from the UI. The restart must
// land on a fresh port whose child is the REAL replacement (attribution via
// the child's exit oracle, never the dial), retarget the running server
// BEFORE readiness, and never serve the foreign marker as restarted
// OpenCode content.
func TestLocalServerOwnedRestartNeverServesForeignMarker(t *testing.T) {
	h, sc, port := startLocalServerForTest(t)
	const marker = "local-foreign-squatter-marker"

	// The pre-restart reality: the owned child dies (as a crash would)…
	pids := sc.waitAliveCount(".fake", 1, 5*time.Second)
	if p, err := os.FindProcess(pids[0]); err == nil {
		_ = p.Signal(syscall.SIGTERM)
	}
	waitPortClosed(t, port, 5*time.Second)
	// …and a FOREIGN marker service squats the freed port.
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		t.Fatalf("foreign listener on port %d: %v", port, err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		_ = http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = io.WriteString(w, marker)
		}))
	}()

	// Pre-check: the still-running server now serves the FOREIGN squatter
	// through /oc/* — the poisoned state the restart must never bless.
	if code, body := lsOcGet(t, h, "/oc/session"); code != 200 || body != marker {
		t.Fatalf("pre-restart /oc/session = %d/%q, want the foreign squatter's marker", code, body)
	}

	// THE REAL TRIGGER.
	code, body := lsRestartTrigger(t, h)
	if code != 200 || !strings.Contains(body, `"ok":true`) {
		t.Fatalf("POST /vh/restart-opencode = %d/%q, want 200/{\"ok\":true}", code, body)
	}

	snap := lsStatus(t, h)
	if snap.State != oclife.StateReady {
		t.Fatalf("lifecycle state=%s, want ready", snap.State)
	}
	fresh := lsPortFromURL(t, snap.OpenCodeURL)
	if fresh == port || fresh <= 0 {
		t.Fatalf("opencode_url=%q after restart, want a fresh port != the squatted %d", snap.OpenCodeURL, port)
	}

	// THE CRUX (outcome-level): the STILL-RUNNING server serves through the
	// FRESH replacement child — body "ok" is served only by the fake
	// `opencode serve`; the squatter serves the foreign marker. "ok" proves
	// the proxy re-routed AND readiness was never credited to the squatter.
	if code, body := lsOcGet(t, h, "/oc/session"); code != 200 || body != "ok" {
		t.Fatalf("post-restart /oc/session through the RUNNING server = %d/%q, want 200/ok from the fresh child — the foreign marker was served as restarted OpenCode content", code, body)
	}
	// The old fake died; exactly one fresh replacement is alive.
	sc.waitAliveCount(".fake", 1, 5*time.Second)
}

// TestLocalServerOwnedRestartRetriesFreshPortWhenChildLosesBindRace — the
// R2 TOCTOU fold through the real trigger: the stable port is FREE at the
// guard (the restart's own stop path released it), but the replacement child
// on it dies before readiness (the lost check-to-bind race signature — the
// core never parses child output to tell). Exactly ONE fresh-port attempt
// follows and carries the restart.
func TestLocalServerOwnedRestartRetriesFreshPortWhenChildLosesBindRace(t *testing.T) {
	h, sc, port := startLocalServerForTest(t)
	// Env is read at spawn time, so setting this AFTER boot kills only the
	// restart's stable-port child; the boot child (already exec'd) lives on.
	t.Setenv("VH_FAKE_OC_DIE_ON_PORT", strconv.Itoa(port))

	code, body := lsRestartTrigger(t, h)
	if code != 200 || !strings.Contains(body, `"ok":true`) {
		t.Fatalf("POST /vh/restart-opencode = %d/%q, want 200/{\"ok\":true}", code, body)
	}

	snap := lsStatus(t, h)
	if snap.State != oclife.StateReady {
		t.Fatalf("lifecycle state=%s, want ready (the stable-port child's failure must be overwritten ONLY by the retry's success)", snap.State)
	}
	fresh := lsPortFromURL(t, snap.OpenCodeURL)
	if fresh == port || fresh <= 0 {
		t.Fatalf("opencode_url=%q after restart, want the fresh-port retry's port != %d", snap.OpenCodeURL, port)
	}
	if code, body := lsOcGet(t, h, "/oc/session"); code != 200 || body != "ok" {
		t.Fatalf("post-restart /oc/session through the RUNNING server = %d/%q, want 200/ok from the retry's fresh child", code, body)
	}
	// The dead stable-port attempt left no live fake; the fresh one lives.
	sc.waitAliveCount(".fake", 1, 5*time.Second)
}

// TestLocalServerOwnedRestartExhaustedKeepsServing — the fail-closed crux
// through the real trigger: BOTH attempts' children die before readiness.
// The trigger answers with the truthful 502 carrying the exhaustion error,
// the lifecycle records failed (visible through the still-running server),
// and local-server keeps serving — the p1-oc-001 invariant.
func TestLocalServerOwnedRestartExhaustedKeepsServing(t *testing.T) {
	h, sc, _ := startLocalServerForTest(t)
	// Every replacement dies pre-readiness (set after boot: the boot child
	// was already exec'd and lives on until the restart stops it).
	t.Setenv("VH_FAKE_OC_DIE_FAST", "1")

	code, body := lsRestartTrigger(t, h)
	if code != http.StatusBadGateway {
		t.Fatalf("POST /vh/restart-opencode = %d/%q, want the truthful 502", code, body)
	}
	// The one-bounded-retry policy is visible in the real error surface.
	if !strings.Contains(body, "exhausted") {
		t.Fatalf("502 body %q must name the exhaustion (stable + one fresh attempt)", body)
	}

	// The lifecycle records the failure, visible through the STILL-RUNNING
	// server (keep-serving)…
	snap := lsStatus(t, h)
	if snap.State != oclife.StateFailed {
		t.Fatalf("lifecycle state=%s, want failed", snap.State)
	}
	if snap.FailureSummary == "" {
		t.Fatal("exhaustion must record a failure summary")
	}
	// …and the /oc proxy, still targeting the truthful dead old URL (the
	// boot child the restart stopped), answers 502 rather than foreign
	// content.
	if code, body := lsOcGet(t, h, "/oc/session"); code != http.StatusBadGateway {
		t.Fatalf("/oc/session = %d/%q, want 502 from the dead old target (keep-serving, no foreign content)", code, body)
	}
	// Both replacement children died; nothing lingers.
	sc.waitAliveCount(".fake", 0, 5*time.Second)
}

// --- P1-API-006 A2: owned INITIAL boot truthfulness (local-server parity) ---
//
// The boot arm (startLocalOwnedOpenCode — the exact function the Run arm
// calls) must never false-ready on a foreign port: the old arm spawned on an
// internally selected port and credited whatever answered the dial
// (waitForPort) — a squatter on that port yielded a false SetReady with the
// server's /oc/* proxy serving foreign content. Two cruxes run through the
// REAL localServerCmd.Run surface (exhaustion keep-serving, post-ready
// crash); the squatter and bind-race cruxes need a pre-set candidate port,
// which the real Run selects internally — so they run the boot seam directly
// (mirroring A1's client-daemon boot tests) with the post-boot consumer
// surface built exactly as Run builds it.

// localBootSeam is one run of local-server's owned boot seam with the
// deterministic pre-set candidate port the cruxes need.
type localBootSeam struct {
	sc        *ocLockScenario
	life      *oclife.Lifecycle
	candidate int // pre-set initial candidate port (below the ephemeral range)
	cmd       *exec.Cmd
	done      <-chan struct{} // the boot child's exit oracle
	port      int             // effective port (success) / last attempted (failure)
	url       string          // finalized URL on the effective port
}

// startLocalBootSeam runs the boot seam exactly as the Run arm calls it,
// except the initial candidate is the caller's deterministic low port
// (pickLowPort — below the ephemeral range so the core's fresh freePort()
// retry cannot collide with it).
func startLocalBootSeam(t *testing.T, candidate int) *localBootSeam {
	t.Helper()
	lsSerial(t)
	sc := newOCLockScenario(t)
	life := oclife.New(oclife.TopologyOwned)
	cmd, done, port, url := startLocalOwnedOpenCode(sc.bin, sc.dir, life, candidate)
	return &localBootSeam{sc: sc, life: life, candidate: candidate, cmd: cmd, done: done, port: port, url: url}
}

// newLocalBootConsumerSurface builds the post-boot consumer surface exactly
// as the Run arm does once the boot seam has returned and finalized the URL
// (lifecycle URL → aggregator → web server → lifecycle route — the same
// construction order Run uses). Asserting routed content through this
// surface proves the boot never wires consumers to a foreign listener.
func newLocalBootConsumerSurface(t *testing.T, s *localBootSeam) *httptest.Server {
	t.Helper()
	s.life.SetOpenCodeURL(s.url)
	agg := aggregator.New(s.url, vhEventRingCapacity)
	srv, err := web.NewServer(agg, s.url, vhEventRingCapacity)
	if err != nil {
		t.Fatalf("web.NewServer: %v", err)
	}
	srv.SetOpenCodeLifecycle(s.life)
	ts := httptest.NewServer(srv.Handler())
	t.Cleanup(ts.Close)
	return ts
}

// TestLocalServerOwnedBootNeverServesForeignMarker — THE boot crux: a
// foreign marker service squats the initial candidate port BEFORE
// local-server boots. The old dial-only arm would have credited the squatter
// and proxied its content as ready OpenCode. The child-attributed boot must
// instead move to a fresh port whose child is the REAL one, finalize the URL
// there, and the post-boot consumer surface must serve the replacement
// child's content — never the squatter's marker.
func TestLocalServerOwnedBootNeverServesForeignMarker(t *testing.T) {
	const marker = "local-boot-squatter-marker"
	candidate := pickLowPort(t) // below the ephemeral range: freePort() cannot collide

	// The squatter occupies the initial candidate port.
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", candidate))
	if err != nil {
		t.Fatalf("foreign listener on port %d: %v", candidate, err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		_ = http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, marker) }))
	}()

	s := startLocalBootSeam(t, candidate)

	if s.port == s.candidate || s.port <= 0 {
		t.Fatalf("effective port=%d after boot, want a fresh port != the squatted candidate %d", s.port, s.candidate)
	}
	wantURL := "http://127.0.0.1:" + strconv.Itoa(s.port)
	if s.url != wantURL {
		t.Fatalf("finalized url=%q, want %q", s.url, wantURL)
	}
	snap := s.life.Snapshot()
	if snap.State != oclife.StateReady {
		t.Fatalf("lifecycle state=%s, want ready (attributed to the replacement child)", snap.State)
	}
	if snap.OpenCodeURL != wantURL {
		t.Fatalf("lifecycle OpenCodeURL=%q, want %q", snap.OpenCodeURL, wantURL)
	}

	// THE CRUX (outcome-level): the post-boot consumer surface — built on
	// the finalized URL exactly as Run builds it — serves the replacement
	// child's "ok", never the squatter's marker.
	if code, body := ocGet(t, newLocalBootConsumerSurface(t, s), "/oc/session"); code != 200 || body != "ok" {
		t.Fatalf("post-boot /oc/session through the consumer surface = %d/%q, want 200/ok from the replacement child — the squatter's marker was served as ready OpenCode content", code, body)
	}
	// Exactly one child was spawned (the squatted candidate was never handed
	// a doomed spawn — the occupied-port guard skips straight to the fresh
	// attempt), and it is alive.
	if n := fakeSpawnCount(t, s.sc); n != 1 {
		t.Fatalf("spawned %d fake children, want exactly 1 (the squatted candidate must not be handed a child)", n)
	}
	s.sc.waitAliveCount(".fake", 1, 5*time.Second)
}

// TestLocalServerOwnedBootRetriesFreshPortWhenChildLosesBindRace — the boot
// bind-race crux: the initial candidate port is FREE, but the child spawned
// on it dies before readiness (lost check-to-bind race or crash — the core
// never tells them apart and never parses output). Exactly ONE fresh-port
// attempt follows and must carry the boot; readiness refers only to that
// replacement child.
func TestLocalServerOwnedBootRetriesFreshPortWhenChildLosesBindRace(t *testing.T) {
	candidate := pickLowPort(t)
	// The initial-candidate child dies pre-readiness; the fresh-port child
	// (an ephemeral freePort) lives and listens.
	t.Setenv("VH_FAKE_OC_DIE_ON_PORT", strconv.Itoa(candidate))

	s := startLocalBootSeam(t, candidate)

	if s.port == s.candidate || s.port <= 0 {
		t.Fatalf("effective port=%d after boot, want the fresh-port retry's port != %d", s.port, s.candidate)
	}
	wantURL := "http://127.0.0.1:" + strconv.Itoa(s.port)
	if s.url != wantURL {
		t.Fatalf("finalized url=%q, want %q", s.url, wantURL)
	}
	snap := s.life.Snapshot()
	if snap.State != oclife.StateReady {
		t.Fatalf("lifecycle state=%s, want ready (readiness must be attributed only to the replacement child)", snap.State)
	}
	if snap.OpenCodeURL != wantURL {
		t.Fatalf("lifecycle OpenCodeURL=%q, want %q", snap.OpenCodeURL, wantURL)
	}
	if code, body := ocGet(t, newLocalBootConsumerSurface(t, s), "/oc/session"); code != 200 || body != "ok" {
		t.Fatalf("post-boot /oc/session = %d/%q, want 200/ok from the retry's fresh child", code, body)
	}
	// AT MOST ONE fresh retry: exactly two spawns total (candidate + retry),
	// exactly one alive (the dead candidate left no live fake).
	if n := fakeSpawnCount(t, s.sc); n != 2 {
		t.Fatalf("spawned %d fake children, want exactly 2 (initial candidate + ONE fresh retry — recovery is bounded)", n)
	}
	s.sc.waitAliveCount(".fake", 1, 5*time.Second)
}

// TestLocalServerOwnedBootExhaustedKeepsServing — the boot fail-closed crux
// through the REAL localServerCmd.Run surface (the P2-API-005 keep-serving
// crux): BOTH the initial-candidate child and the one fresh retry die before
// readiness. The server still comes up and keeps serving, /vh/opencode/status
// truthfully reports failed with a summary, the finalized URL stays a
// parseable dead loopback whose /oc proxy answers 502 — never foreign
// content — and exactly two spawns bound the recovery.
func TestLocalServerOwnedBootExhaustedKeepsServing(t *testing.T) {
	// Every boot child dies pre-readiness. Env is ambient for the boot
	// spawn (startOpenCodeServe reads os.Environ() at exec time), so this
	// must be set before the server starts.
	t.Setenv("VH_FAKE_OC_DIE_FAST", "1")
	h, sc := bootLocalServerForTest(t)

	// The failed-but-serving outcome through the REAL server: the status
	// endpoint answers 200 (keep-serving — machine-asserted by
	// waitLSBootState, which now rejects non-200 like lsStatus) with
	// state=failed + a summary.
	snap := waitLSBootState(t, h, oclife.StateFailed)
	if snap.FailureSummary == "" {
		t.Fatal("boot exhaustion must record a failure summary")
	}
	// The URL finalized on a parseable port — the truthful dead target.
	port := lsPortFromURL(t, snap.OpenCodeURL)
	if port <= 0 {
		t.Fatalf("opencode_url=%q carries no usable port", snap.OpenCodeURL)
	}
	// The /oc proxy, targeting the finalized dead loopback, answers 502
	// rather than foreign content.
	if code, body := lsOcGet(t, h, "/oc/session"); code != http.StatusBadGateway {
		t.Fatalf("/oc/session = %d/%q, want 502 from the dead boot target (keep-serving, no foreign content)", code, body)
	}
	// Bounded recovery: the candidate + ONE fresh retry, then exhaustion.
	if n := fakeSpawnCount(t, sc); n != 2 {
		t.Fatalf("spawned %d fake children, want exactly 2 (candidate + one retry, then exhaustion)", n)
	}
	sc.waitAliveCount(".fake", 0, 5*time.Second)
}

// TestLocalServerOwnedBootPostReadyCrashFlipsFailed — the boot observer
// crux (P1-API-005 DEFER 3) through the REAL localServerCmd.Run surface:
// after a GENUINE child-attributed boot readiness, the boot child's death
// must flip ocLife ready → failed — never leave it stuck at ready.
func TestLocalServerOwnedBootPostReadyCrashFlipsFailed(t *testing.T) {
	h, sc, _ := startLocalServerForTest(t) // real boot, real readiness

	// The post-readiness crash: kill the boot child (the one alive fake).
	pids := sc.waitAliveCount(".fake", 1, 5*time.Second)
	if p, err := os.FindProcess(pids[0]); err == nil {
		_ = p.Signal(syscall.SIGKILL)
	}

	snap := waitLSBootState(t, h, oclife.StateFailed)
	if snap.FailureSummary == "" {
		t.Fatal("the recorded boot-child crash must carry a failure summary")
	}
	sc.waitAliveCount(".fake", 0, 5*time.Second)
}

// --- owned-lifecycle residual closure (R5 / R11 / R2) ---

// lsLogsTail fetches /vh/opencode/logs through the running server and
// returns status + body.
func lsLogsTail(t *testing.T, h *localServerHandle) (int, string) {
	t.Helper()
	res, err := lsClient.Get(h.base + "/vh/opencode/logs")
	if err != nil {
		t.Fatalf("GET /vh/opencode/logs through the running server: %v", err)
	}
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(b)
}

// TestLocalServerOwnedBootFansChildOutputIntoLogs — R5 ring-fan-in parity:
// the owned boot spawns through the lifecycle ring (startOpenCodeServe with
// ocLife.Ring().Writer()), so the fake child's startup banner lands in the
// ring and /vh/opencode/logs answers NON-EMPTY through the real running
// server — the advertised HasLogTail capability is actually honored for
// local-server, not just for client-daemon.
func TestLocalServerOwnedBootFansChildOutputIntoLogs(t *testing.T) {
	h, _, _ := startLocalServerForTest(t)

	// The banner is written by the CHILD into the inherited pipe, so it
	// lands in the ring shortly after readiness — poll for it rather than
	// asserting instant visibility.
	deadline := time.Now().Add(10 * time.Second)
	for {
		code, body := lsLogsTail(t, h)
		if code == 200 && strings.Contains(body, "fake opencode serve") {
			return // the crux: non-empty ring tail through the real surface
		}
		if time.Now().After(deadline) {
			t.Fatalf("/vh/opencode/logs = %d/%q, want the fake child's banner — the owned boot did not fan child output into the lifecycle ring", code, body)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// TestLocalServerOwnedRestartKillsWedgedOldChild — THE R11 behavioral crux,
// through the REAL accepted restart trigger: the old owned child IGNORES
// SIGTERM (VH_FAKE_OC_IGNORE_SIGTERM, ambient from boot so the BOOT child is
// the wedged one), so the stop path must not wait forever on the reap
// oracle: the SIGTERM grace expires, the escalation SIGKILLs the old child,
// and the restart COMPLETES within the bound — new child ready, its "ok"
// served through the real server, the wedged old child provably dead.
// (The unbounded predecessor hung the restart handler — and every later
// opencodeMu holder — on exactly this fixture.)
func TestLocalServerOwnedRestartKillsWedgedOldChild(t *testing.T) {
	withOwnedStopBounds(t, 750*time.Millisecond, 2*time.Second)
	// Env is read at spawn time; set BEFORE boot so the boot child (the old
	// child the restart must stop) installs the ignore.
	t.Setenv("VH_FAKE_OC_IGNORE_SIGTERM", "1")
	h, sc, _ := startLocalServerForTest(t)

	oldPids := sc.waitAliveCount(".fake", 1, 5*time.Second)
	oldPid := oldPids[0]

	start := time.Now()
	code, body := lsRestartTrigger(t, h)
	elapsed := time.Since(start)
	if code != 200 || !strings.Contains(body, `"ok":true`) {
		t.Fatalf("POST /vh/restart-opencode = %d/%q, want 200/{\"ok\":true} — the restart must complete despite the SIGTERM-immune old child", code, body)
	}
	// Bounded, not merely eventual: grace + kill window + readiness must be
	// far under the historical forever-wait (generous CI ceiling).
	if elapsed > 15*time.Second {
		t.Fatalf("restart took %v — the bounded stop did not bound it", elapsed)
	}
	snap := lsStatus(t, h)
	if snap.State != oclife.StateReady {
		t.Fatalf("lifecycle state=%s after the wedged-child restart, want ready", snap.State)
	}
	if code, body := lsOcGet(t, h, "/oc/session"); code != 200 || body != "ok" {
		t.Fatalf("post-restart /oc/session through the RUNNING server = %d/%q, want 200/ok from the fresh child", code, body)
	}
	// The wedged old child is DEAD — the SIGKILL escalation fired and the
	// reaper recorded its exit (a zombie reads alive to signal-0 until
	// reaped; the production observer reaps promptly).
	if !waitPidDead(oldPid, 5*time.Second) {
		t.Fatalf("wedged old child pid %d survived the restart — the SIGKILL escalation did not fire", oldPid)
	}
	// Exactly the fresh replacement lives.
	sc.waitAliveCount(".fake", 1, 5*time.Second)
}

// TestLocalServerOwnedRestartRecoversAfterExhaustedBoot — the R2
// recovery-promise crux, end-to-end through the REAL server: a boot whose
// every child dies pre-readiness (VH_FAKE_OC_DIE_FAST) leaves local-server
// serving with a failed lifecycle; clearing the knob and hitting the REAL
// restart trigger recovers to ready with a fresh child serving "ok" through
// /oc/session — with a BOUNDED spawn count (2 exhausted boot attempts +
// exactly 1 recovery spawn). This pins the p1-oc-001 promise that a failed
// boot is recoverable without restarting the worker.
func TestLocalServerOwnedRestartRecoversAfterExhaustedBoot(t *testing.T) {
	// Every boot child dies pre-readiness; ambient before boot (env is read
	// at spawn time).
	t.Setenv("VH_FAKE_OC_DIE_FAST", "1")
	h, sc := bootLocalServerForTest(t)
	waitLSBootState(t, h, oclife.StateFailed)

	// Clear the knob. VERIFIED against the fake helper: it gates on
	// os.Getenv("VH_FAKE_OC_DIE_FAST") == "1", so the EMPTY STRING is OFF —
	// children spawned after this line live and listen.
	t.Setenv("VH_FAKE_OC_DIE_FAST", "")

	code, body := lsRestartTrigger(t, h)
	if code != 200 || !strings.Contains(body, `"ok":true`) {
		t.Fatalf("POST /vh/restart-opencode = %d/%q, want 200/{\"ok\":true} — the recovery promise after an exhausted boot", code, body)
	}
	snap := lsStatus(t, h)
	if snap.State != oclife.StateReady {
		t.Fatalf("lifecycle state=%s after the recovery restart, want ready", snap.State)
	}
	if code, body := lsOcGet(t, h, "/oc/session"); code != 200 || body != "ok" {
		t.Fatalf("post-recovery /oc/session through the RUNNING server = %d/%q, want 200/ok from the fresh child", code, body)
	}
	// Bounded: the 2 dead boot attempts + exactly 1 restart spawn (the
	// stable port — the boot's last-attempted port — is free, so the
	// restart's single attempt carries it; no retry is spent).
	if n := fakeSpawnCount(t, sc); n != 3 {
		t.Fatalf("spawned %d fake children, want exactly 3 (2 exhausted boot attempts + 1 recovery spawn)", n)
	}
	sc.waitAliveCount(".fake", 1, 5*time.Second)
}

// --- F3: detached-restart ring fan-in parity ---

// bootLocalServerDetachedForTest boots the REAL localServerCmd.Run in the
// DETACHED topology — the same choreography as bootLocalServerForTest with
// localOpenCodeDetached flipped on BEFORE Run reads it (the flag restore
// stays owned by withLocalServerFlags' cleanup snapshot).
func bootLocalServerDetachedForTest(t *testing.T) (*localServerHandle, *ocLockScenario) {
	t.Helper()
	sc := newOCLockScenario(t)
	useVersionFakeBin(t, sc)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	withLocalServerFlags(t, sc, fmt.Sprintf("127.0.0.1:%d", port))
	localOpenCodeDetached = true

	go localServerCmd.Run(nil, nil)

	return &localServerHandle{base: fmt.Sprintf("http://127.0.0.1:%d", port)}, sc
}

// TestLocalServerDetachedRestartFansChildOutputIntoLogs — F3 parity: the
// detached boot fans the child's output into the lifecycle ring
// (EnsureDetachedOpenCode extraW), and an ACCEPTED detached restart must not
// lose that feed when it replaces the child — the replacement's own startup
// banner must appear in /vh/opencode/logs through the real running server,
// not just the boot child's (the ring would otherwise serve a stale tail
// despite HasLogTail: true). Asserted by banner COUNT: the boot child's
// banner (1) plus the replacement's banner (2) — distinct pids, same line
// shape, so two occurrences prove the REPLACEMENT's output landed.
func TestLocalServerDetachedRestartFansChildOutputIntoLogs(t *testing.T) {
	h, sc := bootLocalServerDetachedForTest(t)
	waitLSBootReady(t, h)
	bootPids := sc.waitAliveCount(".fake", 1, 5*time.Second)
	bootPid := bootPids[0]

	// Pre: the boot child's banner is already ring-fed.
	code, body := lsLogsTail(t, h)
	if code != 200 || !strings.Contains(body, "fake opencode serve") {
		t.Fatalf("/vh/opencode/logs = %d/%q after detached boot, want the boot child's banner (the boot wiring's own precondition)", code, body)
	}

	// THE accepted detached restart, through the real trigger.
	code, body = lsRestartTrigger(t, h)
	if code != 200 || !strings.Contains(body, `"ok":true`) {
		t.Fatalf("POST /vh/restart-opencode = %d/%q, want 200/{\"ok\":true} (an accepted detached restart)", code, body)
	}
	if snap := lsStatus(t, h); snap.State != oclife.StateReady {
		t.Fatalf("lifecycle state=%s after the detached restart, want ready", snap.State)
	}

	// THE CRUX: the REPLACEMENT child's banner lands in the ring (written
	// by the child into the inherited pipe — poll rather than assert
	// instant visibility).
	deadline := time.Now().Add(10 * time.Second)
	for {
		code, body = lsLogsTail(t, h)
		if code == 200 && strings.Count(body, "fake opencode serve up") >= 2 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("/vh/opencode/logs = %d/%q after the detached restart, want BOTH children's banners — the replacement's output did not reach the ring (stale tail despite HasLogTail)", code, body)
		}
		time.Sleep(50 * time.Millisecond)
	}
	// Outcome-level serving check: the running server's /oc proxy reaches
	// the REPLACEMENT child on the same port.
	if code, body := lsOcGet(t, h, "/oc/session"); code != 200 || body != "ok" {
		t.Fatalf("post-restart /oc/session through the RUNNING server = %d/%q, want 200/ok from the replacement child", code, body)
	}
	// The boot child was stopped by the serialized restart. In the detached
	// topology it stays an un-reaped ZOMBIE by design (the daemon never
	// Waits it — pid-recycling safety; see restartDetachedOpenCode), and a
	// zombie still answers signal-0, so reap it before the liveness count —
	// the same discipline as TestRestartDetachedOpenCodeSerial.
	if p, err := os.FindProcess(bootPid); err == nil {
		go func() { _, _ = p.Wait() }()
	}
	if !waitPidDead(bootPid, 5*time.Second) {
		t.Fatalf("boot child pid %d still alive after the detached restart", bootPid)
	}
	sc.waitAliveCount(".fake", 1, 5*time.Second)
}
