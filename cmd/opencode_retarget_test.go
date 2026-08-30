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
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strconv"
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
