package e2e

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"testing"

	"github.com/vhqtvn/vh-solara/pkg/mcp"
)

// cluster is shared across the package: one real controller + tunneled worker +
// fake opencode, brought up once.
var cluster *Cluster

func TestMain(m *testing.M) {
	c, err := StartCluster()
	if err != nil {
		fmt.Fprintln(os.Stderr, "e2e setup failed:", err)
		os.Exit(1)
	}
	cluster = c
	code := m.Run()
	c.Close()
	os.Exit(code)
}

func wpath(suffix string) string { return "/api/workers/" + cluster.WorkerID + suffix }

// V1 + V3: a snapshot over the tunnel carries gate facts and the epoch header.
func TestE2E_SnapshotGateAndEpochOverTunnel(t *testing.T) {
	resp, body, err := cluster.Do(http.MethodGet, wpath("/sessions"), "", cluster.APIToken, nil)
	if err != nil {
		t.Fatal(err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("snapshot want 200, got %d: %s", resp.StatusCode, body)
	}
	if resp.Header.Get("X-Vh-Epoch") == "" {
		t.Fatal("X-VH-Epoch header must pass through the tunnel")
	}
	var snap struct {
		Epoch string                    `json:"epoch"`
		Gate  map[string]map[string]any `json:"gate"`
	}
	if err := json.Unmarshal(body, &snap); err != nil {
		t.Fatalf("snapshot decode: %v", err)
	}
	if snap.Epoch == "" {
		t.Fatal("snapshot must carry epoch")
	}
	// The fixture seeds a "demo" root session; its gate must be present.
	if _, ok := snap.Gate["demo"]; !ok {
		t.Fatalf("gate facts missing for fixture session 'demo' (gate keys: %v)", keys(snap.Gate))
	}
	g := snap.Gate["demo"]
	if _, ok := g["activity"]; !ok {
		t.Fatalf("gate.demo missing activity: %v", g)
	}
}

// V3: the coordination API is bearer-gated and resolves workers.
func TestE2E_AuthAndWorkerResolution(t *testing.T) {
	if resp, _, err := cluster.Do(http.MethodGet, wpath("/sessions"), "", "", nil); err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("no bearer want 401, got %v (err %v)", statusOf(resp), err)
	}
	if resp, _, err := cluster.Do(http.MethodGet, wpath("/sessions"), "", "wrong", nil); err != nil || resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("wrong bearer want 401, got %v (err %v)", statusOf(resp), err)
	}
	if resp, _, err := cluster.Do(http.MethodGet, "/api/workers/nope/sessions", "", cluster.APIToken, nil); err != nil || resp.StatusCode != http.StatusNotFound {
		t.Fatalf("unknown worker want 404, got %v (err %v)", statusOf(resp), err)
	}
}

// V2: spawn / send / abort drive the worker's opencode through the tunnel.
func TestE2E_SpawnSendAbortOverTunnel(t *testing.T) {
	resp, body, err := cluster.Do(http.MethodPost, wpath("/sessions"), `{"title":"e2e"}`, cluster.APIToken, nil)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("spawn want 200, got %v: %s", statusOf(resp), body)
	}
	var sp struct {
		OK        bool   `json:"ok"`
		SessionID string `json:"sessionID"`
	}
	_ = json.Unmarshal(body, &sp)
	if !sp.OK || !strings.HasPrefix(sp.SessionID, "ses_") {
		t.Fatalf("spawn result unexpected: %s", body)
	}

	// send to the spawned session.
	resp, body, err = cluster.Do(http.MethodPost, wpath("/sessions/"+sp.SessionID+"/message"), `{"text":"continue"}`, cluster.APIToken, nil)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("send want 200, got %v: %s", statusOf(resp), body)
	}

	// abort (DELETE) the fixture's demo session.
	resp, body, err = cluster.Do(http.MethodDelete, wpath("/sessions/demo"), "", cluster.APIToken, nil)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("abort want 200, got %v: %s", statusOf(resp), body)
	}
}

// V2: idempotency_key dedups a spawn even across the tunnel.
func TestE2E_IdempotentSpawnOverTunnel(t *testing.T) {
	body := `{"title":"idem","idempotency_key":"e2e-idem-1"}`
	r1, b1, err := cluster.Do(http.MethodPost, wpath("/sessions"), body, cluster.APIToken, nil)
	if err != nil || r1.StatusCode != 200 {
		t.Fatalf("first spawn want 200, got %v: %s", statusOf(r1), b1)
	}
	r2, b2, err := cluster.Do(http.MethodPost, wpath("/sessions"), body, cluster.APIToken, nil)
	if err != nil || r2.StatusCode != 200 {
		t.Fatalf("second spawn want 200, got %v: %s", statusOf(r2), b2)
	}
	if r2.Header.Get("X-Vh-Idempotent-Replay") != "1" {
		t.Fatal("second identical-key spawn must be an idempotent replay (through the tunnel)")
	}
	var s1, s2 struct {
		SessionID string `json:"sessionID"`
	}
	_ = json.Unmarshal(b1, &s1)
	_ = json.Unmarshal(b2, &s2)
	if s1.SessionID != s2.SessionID {
		t.Fatalf("idempotent spawn should return the same id, got %q vs %q", s1.SessionID, s2.SessionID)
	}
}

// Regression: sequential requests on a keep-alive client must each route through
// the controller and return the correct response — never get smuggled straight
// down a pooled, still-hijacked tunnel connection (see the Connection: close fix
// in proxyToVH). Pre-fix this intermittently returned the worker SPA HTML.
func TestE2E_NoConnectionSmuggling(t *testing.T) {
	for i := 0; i < 8; i++ {
		resp, body, err := cluster.Do(http.MethodGet, wpath("/sessions"), "", cluster.APIToken, nil)
		if err != nil {
			t.Fatal(err)
		}
		if resp.StatusCode != 200 || !strings.HasPrefix(strings.TrimSpace(string(body)), "{") || !strings.Contains(string(body), `"epoch"`) {
			t.Fatalf("request %d smuggled/garbled: status=%d head=%.60s", i, resp.StatusCode, body)
		}
	}
}

// V4: the MCP facade drives the same stack (MCP → controller → tunnel → worker).
func TestE2E_MCPOverController(t *testing.T) {
	srv := mcp.New(cluster.ControllerURL, cluster.APIToken, cluster.WorkerID, "test")
	in := strings.Join([]string{
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}`,
		`{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_sessions","arguments":{}}}`,
		`{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"send_message","arguments":{"session_id":"demo","text":"hi"}}}`,
	}, "\n") + "\n"
	var out strings.Builder
	if err := srv.Serve(strings.NewReader(in), &out); err != nil {
		t.Fatal(err)
	}
	byID := map[float64]map[string]any{}
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var m map[string]any
		if json.Unmarshal([]byte(line), &m) == nil {
			if id, ok := m["id"].(float64); ok {
				byID[id] = m
			}
		}
	}
	// list_sessions (id 2): result content includes the fixture session.
	if txt := toolText(t, byID[2]); !strings.Contains(txt, "demo") {
		t.Fatalf("MCP list_sessions should surface fixture sessions through the tunnel, got: %s", txt)
	}
	// send_message (id 3): not an error result.
	res3, _ := byID[3]["result"].(map[string]any)
	if res3 == nil || res3["isError"] == true {
		t.Fatalf("MCP send_message over the tunnel should succeed, got: %v", byID[3])
	}
}

func toolText(t *testing.T, resp map[string]any) string {
	t.Helper()
	res, _ := resp["result"].(map[string]any)
	if res == nil {
		t.Fatalf("no result in %v", resp)
	}
	content, _ := res["content"].([]any)
	if len(content) == 0 {
		t.Fatalf("no content in %v", res)
	}
	first, _ := content[0].(map[string]any)
	s, _ := first["text"].(string)
	return s
}

func statusOf(resp *http.Response) int {
	if resp == nil {
		return 0
	}
	return resp.StatusCode
}

func keys(m map[string]map[string]any) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}
