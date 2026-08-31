//go:build linux

package cmd

// P1-API-005 / Slice 2 — local-server owned-restart behavioral closure
// through the REAL accepted restart trigger.
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
	"net/url"
	"os"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/oclife"
)

// lsClient carries the generous timeout a real restart needs (the trigger is
// synchronous: it returns only after readiness or bounded exhaustion).
var lsClient = &http.Client{Timeout: 60 * time.Second}

// withLocalServerFlags points the local-server command at a test scenario
// (fake bin, loopback addr, no auth) and restores every flag global after —
// the same save/restore discipline as withDaemonOpenCodeBin.
func withLocalServerFlags(t *testing.T, sc *ocLockScenario, addr string) {
	t.Helper()
	oldAddr, oldBin := localAddr, localOpenCodeBin
	oldURL, oldDetached, oldRestart := localOpenCodeURL, localOpenCodeDetached, localOpenCodeRestart
	oldSock, oldExt := localVHSock, localExternalManaged
	oldCORS, oldFrame := localCORSOrigins, localFrameAncestors
	oldAuth := localAuth
	t.Cleanup(func() {
		localAddr, localOpenCodeBin = oldAddr, oldBin
		localOpenCodeURL, localOpenCodeDetached, localOpenCodeRestart = oldURL, oldDetached, oldRestart
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

// waitLSBootReady polls the running server until the real owned boot arm has
// spawned the fake child and flipped the lifecycle ready; returns the boot
// port the runtime recorded (the stable port the restart will target).
func waitLSBootReady(t *testing.T, h *localServerHandle) int {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var last string
	for {
		res, err := lsClient.Get(h.statusURL())
		if err == nil {
			var snap oclife.Snapshot
			_ = json.NewDecoder(res.Body).Decode(&snap)
			res.Body.Close()
			last = fmt.Sprintf("state=%s url=%s", snap.State, snap.OpenCodeURL)
			if snap.State == oclife.StateReady && snap.OpenCodeURL != "" {
				return lsPortFromURL(t, snap.OpenCodeURL)
			}
		} else {
			last = err.Error()
		}
		if time.Now().After(deadline) {
			t.Fatalf("local-server boot never reached ready (last: %s)", last)
		}
		time.Sleep(50 * time.Millisecond)
	}
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

// startLocalServerForTest runs the REAL localServerCmd.Run in a goroutine
// (it blocks in ListenAndServe for the rest of the test process — the
// keep-serving posture under test) and waits out the real owned boot. The
// scenario sweep + flag restore handle cleanup; the HTTP listener is
// process-lifetime by design.
func startLocalServerForTest(t *testing.T) (*localServerHandle, *ocLockScenario, int) {
	t.Helper()
	sc := newOCLockScenario(t)
	useVersionFakeBin(t, sc)

	// Pick the server's own port up front (bind :0, read, release — the
	// repo's standard freePort pattern; Run re-binds it moments later).
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close()
	withLocalServerFlags(t, sc, fmt.Sprintf("127.0.0.1:%d", port))

	go localServerCmd.Run(nil, nil)

	h := &localServerHandle{base: fmt.Sprintf("http://127.0.0.1:%d", port)}
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
