package e2e

// liveness_probe_test.go — webperf slice 4 e2e: the end-to-end liveness
// sentinel probe traverses the REAL production path.
//
// PROOF SHAPE: the cluster boots with WithHostPattern("$ID.localhost"), so
// requests whose Host is <workerID>.localhost hit the controller's
// hostInterceptor → Proxy.HandleWorkerDirect — the SAME hijack +
// runBidirectionalCopy raw byte path the production browser's SSE and POST
// use (pkg/server/proxy.go:174 hijack, :254 copy, over a real yamux tunnel).
//
// The test then:
//  1. opens a raw SSE /vh/stream THROUGH the controller subdomain route;
//  2. POSTs /vh/stream/probe?nonce=… THROUGH the same controller route
//     (CSRF header set, as the SPA's installCsrf does);
//  3. asserts the SSE stream delivers `event: vh.liveness` carrying the
//     nonce and NO `id:` line.
//
// That single frame proves the full worker store → subscribe channel → SSE
// handler → yamux tunnel → controller hijack copy → HTTP client path — the
// exact traversal whose silence was the F7 defect (pings written by the
// handler ticker masked a dead upstream pipeline).
//
// Honest gap (capability skew): the harness runs the NEW worker binary, so
// the 404/old-worker fallback CANNOT be expressed in this lane; the SPA's
// 404 fallback is covered by web/tests/unit/sentinel.test.ts instead.

import (
	"bufio"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestE2E_LivenessProbeFullTraversal(t *testing.T) {
	c, err := StartClusterWithOptions(WithHostPattern("$ID.localhost"))
	if err != nil {
		t.Fatalf("StartCluster: %v", err)
	}
	defer c.Close()

	host := c.WorkerID + ".localhost" // routes via hostInterceptor → raw tunnel proxy

	// 1. Open the SSE stream through the controller.
	sseReq, _ := http.NewRequest(http.MethodGet, c.ControllerURL+"/vh/stream?sessions=", nil)
	sseReq.Host = host
	sseResp, err := treeStreamClient.Do(sseReq)
	if err != nil {
		t.Fatalf("GET /vh/stream via controller subdomain: %v", err)
	}
	defer sseResp.Body.Close()
	if sseResp.StatusCode != http.StatusOK {
		t.Fatalf("GET /vh/stream via controller: status %d", sseResp.StatusCode)
	}

	// 2. POST the probe through the same controller route. The nonce is the
	// correlation token the client generates; the worker echoes it in the
	// broadcast frame.
	const nonce = "e2e-probe-nonce-7f3a"
	probeReq, _ := http.NewRequest(http.MethodPost,
		c.ControllerURL+"/vh/stream/probe?nonce="+nonce, nil)
	probeReq.Host = host
	probeReq.Header.Set(e2eCsrfHeader, e2eCsrfValue)
	probeResp, err := http.DefaultClient.Do(probeReq)
	if err != nil {
		t.Fatalf("POST /vh/stream/probe via controller subdomain: %v", err)
	}
	probeResp.Body.Close()
	if probeResp.StatusCode != http.StatusOK {
		t.Fatalf("POST /vh/stream/probe via controller: status %d (want 200 — 404 would mean the route is missing on this worker)", probeResp.StatusCode)
	}

	// 3. Read SSE frames until vh.liveness arrives; assert nonce + NO id.
	deadline := time.Now().Add(5 * time.Second)
	sc := bufio.NewScanner(sseResp.Body)
	sc.Buffer(make([]byte, 64*1024), 8*1024*1024)
	var block sseFrame
	for sc.Scan() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for vh.liveness through the tunnel")
		}
		line := sc.Text()
		if line == "" {
			if block.Event == "vh.liveness" {
				if block.ID != "" {
					t.Fatalf("vh.liveness carries id %q — must have NO id line (cursor advance)", block.ID)
				}
				if !strings.Contains(block.Data, nonce) {
					t.Fatalf("vh.liveness data missing nonce %q: %s", nonce, block.Data)
				}
				t.Logf("PASS: vh.liveness (nonce=%s) traversed worker store → SSE handler → yamux tunnel → controller hijack copy → client, with no id line", nonce)
				return
			}
			block = sseFrame{}
			continue
		}
		switch {
		case strings.HasPrefix(line, "id: "):
			block.ID = strings.TrimPrefix(line, "id: ")
		case strings.HasPrefix(line, "event: "):
			block.Event = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "data: "):
			block.Data = strings.TrimPrefix(line, "data: ")
		}
	}
	t.Fatalf("stream closed before vh.liveness arrived through the tunnel")
}
