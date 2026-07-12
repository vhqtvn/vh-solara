// Package integration contains cross-package integration tests for vh-solara
// that do NOT fit the shared e2e Cluster (which is coupled to a TestMain and a
// REACHABLE fake OpenCode). Tests here are self-contained: each brings up its
// own minimal controller + tunnel + worker and asserts a specific behavior.
package integration

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/agent"
	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/oclife"
	"github.com/vhqtvn/vh-solara/pkg/server"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// TestWorkerSurvivesOpenCodeFailure is validation #3 for p1-oc-001 Slice 1:
// a worker pointed at a nonexistent/dead OpenCode must STILL register with the
// controller and serve /vh/* (health + opencode/status) so the operator can
// reach it through the tunnel and diagnose + restart OpenCode remotely.
//
// Before this slice, three fatal readiness gates (log.Fatalf) killed the worker
// BEFORE the web server + tunnel started, so a dead OpenCode took the whole
// reporting worker with it. This test proves the decoupling end-to-end: the
// worker process stays up, registers, and reports the OpenCode failure via
// /vh/opencode/status.
//
// Validation #4 (controller raw-proxy reaches /vh/opencode/status while OC
// refuses) is covered by reasoning: the worker-online handshake already proves
// the yamux tunnel is up, and the host-based raw proxy (pkg/server/proxy.go
// handleRawProxy) hijacks + raw-byte-pipes ANY path through that same stream —
// so /vh/opencode/status traverses it identically to /vh/healthz (which the
// coordination API health checks exercise). The worker's own loopback URL here
// serves the exact same http.Handler the raw proxy would expose. The gap: the
// coordination API has no generic /vh passthrough for opencode/status yet
// (only hand-coded /vh/snapshot etc. mappings), so a programmatic caller must
// use the host-based raw proxy, not /api/workers/{id}/opencode/status.
func TestWorkerSurvivesOpenCodeFailure(t *testing.T) {
	log.SetOutput(io.Discard) // keep test output clean
	const (
		workerID  = "worker-dead-oc"
		apiToken  = "test-token"
		ringCap   = 1000
		deadOCURL = "http://127.0.0.1:1" // port 1: refused — stands in for a crashed OpenCode
	)

	// 1. Worker web server pointed at a DEAD OpenCode. NewServer does NOT dial
	//    OpenCode at construction (aggregator + reverse proxy are lazy), so this
	//    neither crashes nor hangs — that's the construction-time half of the
	//    decoupling. The aggregator's Run goroutine will fail to connect and
	//    retry; that does not block serving.
	agg := aggregator.New(deadOCURL, ringCap)
	go agg.Run(context.Background())
	wsrv, err := web.NewServer(agg, deadOCURL, ringCap)
	if err != nil {
		t.Fatalf("NewServer with dead OC URL: %v", err)
	}
	// Wire a failed lifecycle, exactly as client-daemon.go's owned arm would
	// after a startup-gate failure (the binary didn't exist / port didn't
	// listen). This is what /vh/opencode/status will serve.
	life := oclife.New(oclife.TopologyOwned)
	life.SetOpenCodeURL(deadOCURL)
	life.SetFailed("opencode serve failed to listen: port not ready", nil)
	wsrv.SetOpenCodeLifecycle(life)

	webSrv := httptest.NewServer(wsrv.Handler())
	t.Cleanup(webSrv.Close)

	webPort, err := portOf(webSrv.URL)
	if err != nil {
		t.Fatal(err)
	}

	// 2. Controller daemon on free loopback ports.
	userAddr, err := freeAddr()
	if err != nil {
		t.Fatal(err)
	}
	daemonAddr, err := freeAddr()
	if err != nil {
		t.Fatal(err)
	}
	d := server.NewDaemon(userAddr, daemonAddr, "")
	d.APIToken = apiToken
	go func() { _ = d.Start() }()
	controllerURL := "http://" + userAddr

	if err := waitHTTP(controllerURL+"/api/coord/workers", apiToken, 200, 10*time.Second); err != nil {
		t.Fatalf("controller did not come up: %v", err)
	}

	// 3. Worker agent: dial the controller's tunnel endpoint, proxy to the
	//    worker's web port. This is the same agent.NewDaemon the real worker
	//    uses — if the worker's HealthCheck returned false (the old coupled
	//    behavior), the agent would cancel + kill this connection.
	proxy := agent.NewProxy(webPort)
	ag := agent.NewDaemon("ws://"+daemonAddr+"/vh-solara/ws", workerID, "worker", "test", nil, proxy)
	go ag.Start()

	// 4. Wait until the worker registers + shows online. This is the crux of
	//    validation #3: the worker is UP and tunneled despite OpenCode being
	//    dead. With the old fatal-gate behavior this never happened — the worker
	//    process died at startup before the tunnel connected.
	if err := waitWorkerOnline(controllerURL, apiToken, workerID, 15*time.Second); err != nil {
		t.Fatalf("worker did not register online with dead OpenCode: %v", err)
	}

	// 5. The worker's own /vh/healthz must answer 200 — the worker is healthy
	//    even though OpenCode is not. (Reached via the worker's loopback URL,
	//    which is the same http.Handler the tunnel exposes.)
	if err := waitHTTP(webSrv.URL+"/vh/healthz", "", 200, 5*time.Second); err != nil {
		t.Errorf("/vh/healthz on worker: %v", err)
	}

	// 6. /vh/opencode/status must serve the FAILED lifecycle directly (no OpenCode
	//    dial). This is what an operator reaching the worker through the tunnel
	//    would see: a clear "OpenCode is failed" instead of a dead worker.
	res, err := http.Get(webSrv.URL + "/vh/opencode/status")
	if err != nil {
		t.Fatalf("GET /vh/opencode/status: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		t.Fatalf("/vh/opencode/status status = %d, want 200", res.StatusCode)
	}
	body, _ := io.ReadAll(res.Body)
	var snap oclife.Snapshot
	if err := json.Unmarshal(body, &snap); err != nil {
		t.Fatalf("decode status snapshot: %v\nbody: %s", err, body)
	}
	if snap.State != oclife.StateFailed {
		t.Errorf("opencode state = %q, want %q", snap.State, oclife.StateFailed)
	}
	if snap.FailureSummary == "" {
		t.Error("failure_summary is empty; want the startup failure detail")
	}

	t.Logf("worker %s registered online + serving /vh with OpenCode failed (state=%s, summary=%q)",
		workerID, snap.State, snap.FailureSummary)
}

// --- tiny local helpers (the e2e package's are unexported + coupled to a
// shared TestMain; this test stays self-contained) ---

func freeAddr() (string, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	defer l.Close()
	return l.Addr().String(), nil
}

func portOf(rawURL string) (int, error) {
	_, port, err := net.SplitHostPort(strings.TrimPrefix(rawURL, "http://"))
	if err != nil {
		return 0, err
	}
	var p int
	_, err = fmt.Sscanf(port, "%d", &p)
	return p, err
}

func waitHTTP(url, bearer string, wantStatus int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	var last error
	for time.Now().Before(deadline) {
		req, _ := http.NewRequest(http.MethodGet, url, nil)
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			resp.Body.Close()
			if resp.StatusCode == wantStatus {
				return nil
			}
			last = fmt.Errorf("status %d", resp.StatusCode)
		} else {
			last = err
		}
		time.Sleep(50 * time.Millisecond)
	}
	return fmt.Errorf("timeout waiting for %s: %v", url, last)
}

func waitWorkerOnline(controllerURL, apiToken, workerID string, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		req, _ := http.NewRequest(http.MethodGet, controllerURL+"/api/coord/workers", nil)
		req.Header.Set("Authorization", "Bearer "+apiToken)
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			body, _ := io.ReadAll(resp.Body)
			resp.Body.Close()
			if resp.StatusCode == 200 &&
				strings.Contains(string(body), `"`+workerID+`"`) &&
				strings.Contains(string(body), `"online"`) {
				return nil
			}
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("worker %s did not come online within %s", workerID, timeout)
}
