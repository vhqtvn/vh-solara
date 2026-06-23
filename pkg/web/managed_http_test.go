package web

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/procmgr"
)

// writeManagedProjectConfig writes a .vh-solara/project.jsonc declaring one
// process (a long sleep → ready via default settle) and one view bound to the
// given upstream, then returns the project root.
func writeManagedProjectConfig(t *testing.T, upstream string) string {
	t.Helper()
	root := t.TempDir()
	body := `{
  "processes": [
    { "id": "demo", "command": "/bin/sh -c \"sleep 120\"", "cwd": ".", "restart": "no" }
  ],
  "views": [
    { "id": "demo", "path_prefix": "/demo", "upstream": "` + upstream + `", "depends_on": "demo" }
  ]
}`
	if err := os.MkdirAll(filepath.Join(root, ".vh-solara"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, ".vh-solara", "project.jsonc"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

// newManagedServer builds a real aggregator + web Server with managed projects
// wired (isolated trust store), backed by a fake OpenCode.
func newManagedServer(t *testing.T) (*Server, *procmgr.Manager, context.CancelFunc) {
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
		t.Fatal(err)
	}
	procCtx, procCancel := context.WithCancel(context.Background())
	mgr := procmgr.NewManager(procCtx)
	trust := NewTrustStoreAt(t.TempDir())
	srv.InitManaged(mgr, trust, "", false)

	// Consolidated teardown (order matters): cancel the aggregator + managed
	// procs first, then SEVER the idle /event SSE connection (SubscribeEvents
	// blocks in a bufio read that ctx-cancel cannot interrupt on an idle
	// stream), then close the servers.
	t.Cleanup(func() {
		ocCancel()
		procCancel()
		mgr.StopAll()
		ocSrv.CloseClientConnections()
		ocSrv.Close()
	})
	return srv, mgr, procCancel
}

func doManaged(t *testing.T, webURL, method, path string, body string) *http.Response {
	t.Helper()
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, webURL+path, r)
	if err != nil {
		t.Fatal(err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set(csrfHeader, "1")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

// TestManagedHTTP_TrustGateThenProxy exercises the full worker-side flow through
// the real handler chain: untrusted config is blocked, grant starts the process,
// the declared view is registered and proxyable through dispatchView, and the
// process controls respond.
func TestManagedHTTP_TrustGateThenProxy(t *testing.T) {
	// A reachable upstream the declared view will proxy to.
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, "hello from upstream")
	}))
	t.Cleanup(func() { up.CloseClientConnections(); up.Close() })

	root := writeManagedProjectConfig(t, "tcp:"+strings.TrimPrefix(up.URL, "http://"))
	srv, mgr, _ := newManagedServer(t)

	web := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { web.CloseClientConnections(); web.Close() })

	// Trigger the project-open hook (same call aggFor makes on first ?dir=).
	srv.managed.OpenProject(root)

	// 1. Before trust: state is awaiting-trust and the review payload is present.
	resp := doManaged(t, web.URL, http.MethodGet, "/vh/managed?dir="+root, "")
	if resp.StatusCode != 200 {
		t.Fatalf("managed GET status %d", resp.StatusCode)
	}
	var proj ManagedProject
	json.NewDecoder(resp.Body).Decode(&proj)
	resp.Body.Close()
	if proj.State != StateAwaitTrust {
		t.Fatalf("want awaiting-trust before grant, got %q", proj.State)
	}
	if proj.Review == nil || len(proj.Review.Processes) != 1 {
		t.Fatalf("review payload missing process: %+v", proj.Review)
	}
	if proj.Review.Processes[0].ID != "demo" {
		t.Fatalf("review process id = %q", proj.Review.Processes[0].ID)
	}

	// 2. Grant trust → process starts.
	resp = doManaged(t, web.URL, http.MethodPost, "/vh/trust", `{"dir":"`+root+`"}`)
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		t.Fatalf("trust POST status %d: %s", resp.StatusCode, b)
	}
	resp.Body.Close()

	// 3. Process becomes ready (default-settle readiness).
	waitFor(t, func() bool {
		st, ok := mgr.Status(root, "demo")
		return ok && st.Status == procmgr.StatusReady
	}, "managed process ready after grant")

	// 4. The declared view is registered (origin=managed) and listed.
	vresp, err := http.Get(web.URL + "/vh/views")
	if err != nil {
		t.Fatal(err)
	}
	var views []viewReg
	json.NewDecoder(vresp.Body).Decode(&views)
	vresp.Body.Close()
	found := false
	for _, v := range views {
		if v.ID == "demo" && v.Origin == OriginManaged && v.Dir == root {
			found = true
		}
	}
	if !found {
		t.Fatalf("managed view not registered: %+v", views)
	}

	// 5. The view is proxyable through dispatchView (prefix stripped, upstream hit).
	presp, err := http.Get(web.URL + "/demo/")
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(presp.Body)
	presp.Body.Close()
	if presp.StatusCode != 200 || strings.TrimSpace(string(body)) != "hello from upstream" {
		t.Fatalf("view proxy want 200/hello, got %d/%q", presp.StatusCode, body)
	}

	// 6. Process controls: stop, then start again.
	resp = doManaged(t, web.URL, http.MethodPost, "/vh/managed?dir="+root+"&id=demo&action=stop", "")
	if resp.StatusCode != 200 {
		t.Fatalf("stop status %d", resp.StatusCode)
	}
	resp.Body.Close()
	waitFor(t, func() bool {
		st, ok := mgr.Status(root, "demo")
		return ok && st.Status == procmgr.StatusStopped
	}, "managed process stopped")

	resp = doManaged(t, web.URL, http.MethodPost, "/vh/managed?dir="+root+"&id=demo&action=start", "")
	if resp.StatusCode != 200 {
		t.Fatalf("start status %d", resp.StatusCode)
	}
	resp.Body.Close()
	waitFor(t, func() bool {
		st, ok := mgr.Status(root, "demo")
		return ok && st.Status.IsRunning()
	}, "managed process restarted")
}

// TestManagedHTTP_NoManagedDisabled asserts that when managed projects are not
// wired, the endpoints degrade gracefully (snapshot state=none).
func TestManagedHTTP_NoManagedDisabled(t *testing.T) {
	fake := newFake()
	ocSrv := httptest.NewServer(fake.handler())
	agg := aggregator.New(ocSrv.URL, 100)
	ctx, cancel := context.WithCancel(context.Background())
	go agg.Run(ctx)
	t.Cleanup(func() {
		cancel()
		ocSrv.CloseClientConnections()
		ocSrv.Close()
	})
	srv, err := NewServer(agg, ocSrv.URL, 1000)
	if err != nil {
		t.Fatal(err)
	}
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(func() { web.CloseClientConnections(); web.Close() })

	resp, err := http.Get(web.URL + "/vh/managed?dir=")
	if err != nil {
		t.Fatal(err)
	}
	var proj ManagedProject
	json.NewDecoder(resp.Body).Decode(&proj)
	resp.Body.Close()
	if proj.State != StateNone {
		t.Fatalf("want state none when disabled, got %q", proj.State)
	}
}
