// Package e2e is a reusable in-process end-to-end harness for the vh-solara
// coordination stack: a real controller daemon + a real worker connected over an
// actual yamux tunnel + a fake OpenCode (pkg/fixtures). It exercises the full
// cross-machine path — controller /api/workers/{id}/* → tunnel → worker /vh/* →
// opencode — without docker, a real opencode binary, or an LLM.
//
// It is shared on purpose: other components (or future features) can import
// Cluster to drive the same real stack. Frontend/UI coverage stays in the
// Playwright lane (web/tests/e2e); this lane covers the backend coordination API.
package e2e

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/agent"
	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/fixtures"
	"github.com/vhqtvn/vh-solara/pkg/server"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// Cluster is a running controller + tunneled worker + fake opencode.
type Cluster struct {
	Fake          *fixtures.FakeOpenCode
	ControllerURL string // user edge, e.g. http://127.0.0.1:PORT
	WorkerVHURL   string // the worker's own --web vh server (loopback) — the pure-local path
	WorkerID      string
	APIToken      string

	fakeSrv   *httptest.Server
	workerSrv *httptest.Server
	cancel    context.CancelFunc
}

const ringCap = 1000

// StartCluster brings the whole stack up and waits until the worker is online.
func StartCluster() (*Cluster, error) {
	log.SetOutput(io.Discard) // the agent/controller log verbosely; keep test output clean

	ctx, cancel := context.WithCancel(context.Background())
	c := &Cluster{WorkerID: "worker-e2e", APIToken: "e2e-token", cancel: cancel}

	// 1. Fake opencode.
	c.Fake = fixtures.New()
	c.fakeSrv = httptest.NewServer(c.Fake.Handler())

	// 2. Worker: vh-solara's own web server (--web vh) over the fake, aggregator
	//    running so the store hydrates from the fixture sessions.
	agg := aggregator.New(c.fakeSrv.URL, ringCap)
	go agg.Run(ctx)
	wsrv, err := web.NewServer(agg, c.fakeSrv.URL, ringCap)
	if err != nil {
		return nil, err
	}
	c.workerSrv = httptest.NewServer(wsrv.Handler())
	c.WorkerVHURL = c.workerSrv.URL
	chamberPort, err := portOf(c.workerSrv.URL)
	if err != nil {
		return nil, err
	}

	// 3. Controller daemon on free loopback ports.
	userAddr, err := freeAddr()
	if err != nil {
		return nil, err
	}
	daemonAddr, err := freeAddr()
	if err != nil {
		return nil, err
	}
	d := server.NewDaemon(userAddr, daemonAddr, "")
	d.APIToken = c.APIToken
	go func() { _ = d.Start() }()
	c.ControllerURL = "http://" + userAddr
	if err := waitHTTP(c.ControllerURL+"/api/coord/workers", c.APIToken, 200, 10*time.Second); err != nil {
		return nil, fmt.Errorf("controller did not come up: %w", err)
	}

	// 4. Worker agent: dial the controller's tunnel endpoint, proxy to the worker
	//    vh server's port.
	proxy := agent.NewProxy(chamberPort)
	ag := agent.NewDaemon("ws://"+daemonAddr+"/vh-solara/ws", c.WorkerID, "worker", "test", nil, proxy)
	go ag.Start()

	// 5. Wait until the worker registers and shows online.
	if err := waitWorkerOnline(c, 15*time.Second); err != nil {
		return nil, err
	}
	return c, nil
}

// Close tears down the servers. The controller/agent goroutines are left to exit
// with the test process (neither exposes a stop hook); httptest servers and the
// aggregator context are closed here.
func (c *Cluster) Close() {
	if c.cancel != nil {
		c.cancel()
	}
	if c.workerSrv != nil {
		c.workerSrv.Close()
	}
	if c.fakeSrv != nil {
		c.fakeSrv.Close()
	}
}

// Do issues an authenticated request to the controller's coordination API.
// bearer="" omits the Authorization header (to test rejection).
func (c *Cluster) Do(method, path, body, bearer string, headers map[string]string) (*http.Response, []byte, error) {
	var r io.Reader
	if body != "" {
		r = bytes.NewBufferString(body)
	}
	req, err := http.NewRequest(method, c.ControllerURL+path, r)
	if err != nil {
		return nil, nil, err
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b, nil
}

// --- helpers ---

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

func waitWorkerOnline(c *Cluster, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, body, err := c.Do(http.MethodGet, "/api/coord/workers", "", c.APIToken, nil)
		if err == nil && resp.StatusCode == 200 &&
			strings.Contains(string(body), `"`+c.WorkerID+`"`) && strings.Contains(string(body), `"online"`) {
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("worker %s did not come online within %s", c.WorkerID, timeout)
}
