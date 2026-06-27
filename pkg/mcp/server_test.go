package mcp

import (
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

func TestLocalModeOverUnixSocket(t *testing.T) {
	f := &fakeController{}
	sock := filepath.Join(t.TempDir(), "vh.sock")
	ln, err := net.Listen("unix", sock)
	if err != nil {
		t.Fatal(err)
	}
	httpSrv := &http.Server{Handler: f.handler()}
	go func() { _ = httpSrv.Serve(ln) }()
	t.Cleanup(func() { _ = httpSrv.Close() })

	s := New("http://unix", "", "", "test")
	s.Local = true
	s.HTTP = UnixClient(sock) // dial the worker /vh/* over the socket

	res := callTool(t, s, `{"name":"list_sessions","arguments":{}}`)
	if res["isError"] == true {
		t.Fatalf("list_sessions over UDS errored: %v", res)
	}
	if txt := res["content"].([]map[string]any)[0]["text"].(string); !strings.Contains(txt, "demo") {
		t.Fatalf("UDS list_sessions should hit /vh/snapshot, got: %s", txt)
	}
	res = callTool(t, s, `{"name":"send_message","arguments":{"session_id":"demo","text":"hi"}}`)
	if res["isError"] == true {
		t.Fatalf("send_message over UDS errored: %v", res)
	}
	if f.vhSendCSRF != "1" {
		t.Fatal("UDS write must still carry X-VH-CSRF")
	}
}

// fakeController fakes the coordination API the MCP server calls.
type fakeController struct {
	mu       sync.Mutex
	sendBody string
	sendIdle string
	failNext bool
	// local-mode (/vh/*) capture
	vhSendBody string
	vhSendCSRF string
	vhSendAuth string
}

func (f *fakeController) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/coord/workers", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`[{"id":"w1","name":"alpha","status":"online"}]`))
	})
	mux.HandleFunc("GET /api/workers/{id}/sessions", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-VH-Epoch", "ep-test")
		w.Header().Set("X-VH-Seq", "42")
		w.Write([]byte(`{"epoch":"ep-test","seq":42,"sessions":[],"gate":{}}`))
	})
	mux.HandleFunc("POST /api/workers/{id}/sessions/{sid}/message", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.sendBody = string(b)
		f.sendIdle = r.Header.Get("If-Idle-Seq")
		fail := f.failNext
		f.mu.Unlock()
		if fail {
			w.WriteHeader(http.StatusConflict)
			w.Write([]byte("session not sendable"))
			return
		}
		w.Write([]byte(`{"ok":true}`))
	})
	// Local-mode endpoints: a worker's own /vh/* served directly.
	mux.HandleFunc("/vh/snapshot", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-VH-Epoch", "ep-local")
		w.Write([]byte(`{"epoch":"ep-local","sessions":[{"id":"demo"}],"gate":{}}`))
	})
	mux.HandleFunc("/vh/send", func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.vhSendBody = string(b)
		f.vhSendCSRF = r.Header.Get("X-VH-CSRF")
		f.vhSendAuth = r.Header.Get("Authorization")
		f.mu.Unlock()
		w.Header().Set("X-VH-Seq", "7")
		w.Write([]byte(`{"ok":true,"outcome":"prompt_retried_to_existing"}`))
	})
	mux.HandleFunc("/vh/spawn", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-VH-Seq", "9")
		w.Write([]byte(`{"ok":true,"sessionID":"ses_new","outcome":"created"}`))
	})
	return mux
}

func newTestServer(t *testing.T, f *fakeController, defaultWorker string) *Server {
	t.Helper()
	ctrl := httptest.NewServer(f.handler())
	t.Cleanup(ctrl.Close)
	return New(ctrl.URL, "", defaultWorker, "test")
}

func req(id, method, params string) *rpcRequest {
	r := &rpcRequest{JSONRPC: "2.0", Method: method}
	if id != "" {
		r.ID = json.RawMessage(id)
	}
	if params != "" {
		r.Params = json.RawMessage(params)
	}
	return r
}

func TestInitializeEchoesProtocol(t *testing.T) {
	s := newTestServer(t, &fakeController{}, "")
	resp, has := s.dispatch(req("1", "initialize", `{"protocolVersion":"2025-06-18"}`))
	if !has {
		t.Fatal("initialize must respond")
	}
	m := resp.Result.(map[string]any)
	if m["protocolVersion"] != "2025-06-18" {
		t.Fatalf("want echoed protocol version, got %v", m["protocolVersion"])
	}
	if si := m["serverInfo"].(map[string]any); si["name"] != "vh-solara" {
		t.Fatalf("want serverInfo name vh-solara, got %v", si)
	}
}

func TestToolsListHasVerbs(t *testing.T) {
	s := newTestServer(t, &fakeController{}, "")
	resp, _ := s.dispatch(req("1", "tools/list", ""))
	tools := resp.Result.(map[string]any)["tools"].([]map[string]any)
	names := map[string]bool{}
	for _, tl := range tools {
		names[tl["name"].(string)] = true
	}
	for _, want := range []string{"list_workers", "list_sessions", "send_message", "spawn_session", "abort_session", "answer_question", "reply_permission", "archive_session"} {
		if !names[want] {
			t.Fatalf("tools/list missing %q (got %v)", want, names)
		}
	}
}

func callTool(t *testing.T, s *Server, args string) map[string]any {
	t.Helper()
	resp, has := s.dispatch(req("1", "tools/call", args))
	if !has {
		t.Fatal("tools/call must respond")
	}
	return resp.Result.(map[string]any)
}

func TestToolCallListWorkers(t *testing.T) {
	s := newTestServer(t, &fakeController{}, "")
	res := callTool(t, s, `{"name":"list_workers","arguments":{}}`)
	if res["isError"] == true {
		t.Fatalf("list_workers errored: %v", res)
	}
	text := res["content"].([]map[string]any)[0]["text"].(string)
	if !strings.Contains(text, `"w1"`) {
		t.Fatalf("list_workers should include w1, got %s", text)
	}
}

func TestToolCallSendForwardsTextAndCAS(t *testing.T) {
	f := &fakeController{}
	s := newTestServer(t, f, "")
	res := callTool(t, s, `{"name":"send_message","arguments":{"worker":"w1","session_id":"s1","text":"continue","if_idle_seq":"42"}}`)
	if res["isError"] == true {
		t.Fatalf("send errored: %v", res)
	}
	// sessionID is injected by the controller (path param), not the MCP body; the
	// MCP body carries the text. Assert the text made it through.
	if !strings.Contains(f.sendBody, `"continue"`) {
		t.Fatalf("send body missing text: %s", f.sendBody)
	}
	if f.sendIdle != "42" {
		t.Fatalf("If-Idle-Seq not forwarded, got %q", f.sendIdle)
	}
}

func TestToolCallDefaultWorkerAndError(t *testing.T) {
	f := &fakeController{}
	s := newTestServer(t, f, "w1") // default worker
	// No worker arg → uses default; controller fails → tool error surfaced.
	f.failNext = true
	res := callTool(t, s, `{"name":"send_message","arguments":{"session_id":"s1","text":"x"}}`)
	if res["isError"] != true {
		t.Fatalf("a 409 from the controller should surface as a tool error, got %v", res)
	}
	text := res["content"].([]map[string]any)[0]["text"].(string)
	if !strings.Contains(text, "409") {
		t.Fatalf("error should mention HTTP 409, got %s", text)
	}
}

func TestLocalModeTargetsVHDirectly(t *testing.T) {
	f := &fakeController{}
	ctrl := httptest.NewServer(f.handler())
	t.Cleanup(ctrl.Close)
	s := New(ctrl.URL, "ignored-token", "", "test")
	s.Local = true // pure-local: hit /vh/* directly, no worker id, no bearer

	// list_sessions → GET /vh/snapshot (not /api/workers/...).
	res := callTool(t, s, `{"name":"list_sessions","arguments":{}}`)
	if res["isError"] == true {
		t.Fatalf("local list_sessions errored: %v", res)
	}
	if txt := res["content"].([]map[string]any)[0]["text"].(string); !strings.Contains(txt, "demo") {
		t.Fatalf("local list_sessions should hit /vh/snapshot, got: %s", txt)
	}

	// send_message → POST /vh/send with sessionID in the BODY, CSRF header set,
	// and NO Authorization (loopback, controller-mode token ignored).
	res = callTool(t, s, `{"name":"send_message","arguments":{"session_id":"demo","text":"hi"}}`)
	if res["isError"] == true {
		t.Fatalf("local send errored: %v", res)
	}
	if !strings.Contains(f.vhSendBody, `"demo"`) || !strings.Contains(f.vhSendBody, `"hi"`) {
		t.Fatalf("local send body should carry sessionID+text, got: %s", f.vhSendBody)
	}
	if f.vhSendCSRF != "1" {
		t.Fatal("local writes must set X-VH-CSRF")
	}
	if f.vhSendAuth != "" {
		t.Fatalf("local mode must not send Authorization, got %q", f.vhSendAuth)
	}
}

// TestLocalModeOutcomeInMeta verifies the body's "outcome" field is lifted into
// the MCP tool result _meta (alongside epoch/seq) so a structured client reads it
// without parsing the text blob.
func TestLocalModeOutcomeInMeta(t *testing.T) {
	f := &fakeController{}
	ctrl := httptest.NewServer(f.handler())
	t.Cleanup(ctrl.Close)
	s := New(ctrl.URL, "", "", "test")
	s.Local = true

	// send_message → outcome "prompt_retried_to_existing" in _meta.
	res := callTool(t, s, `{"name":"send_message","arguments":{"session_id":"demo","text":"hi"}}`)
	if res["isError"] == true {
		t.Fatalf("send errored: %v", res)
	}
	meta, _ := res["_meta"].(map[string]any)
	if meta == nil {
		t.Fatalf("send result missing _meta: %v", res)
	}
	if meta["outcome"] != "prompt_retried_to_existing" {
		t.Fatalf("send _meta.outcome want prompt_retried_to_existing, got %v", meta["outcome"])
	}
	if meta["seq"] != "7" {
		t.Fatalf("send _meta.seq want 7, got %v", meta["seq"])
	}

	// spawn_session → outcome "created" in _meta.
	res = callTool(t, s, `{"name":"spawn_session","arguments":{"prompt":"go"}}`)
	if res["isError"] == true {
		t.Fatalf("spawn errored: %v", res)
	}
	meta, _ = res["_meta"].(map[string]any)
	if meta == nil || meta["outcome"] != "created" {
		t.Fatalf("spawn _meta.outcome want created, got %v", meta)
	}
}

func TestServeLoopNewlineDelimited(t *testing.T) {
	s := newTestServer(t, &fakeController{}, "")
	in := strings.NewReader(
		`{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}}` + "\n" +
			`{"jsonrpc":"2.0","method":"notifications/initialized"}` + "\n" +
			`{"jsonrpc":"2.0","id":2,"method":"tools/list"}` + "\n")
	var out strings.Builder
	if err := s.Serve(in, &out); err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(strings.TrimSpace(out.String()), "\n")
	// Two responses (initialize, tools/list); the notification gets none.
	if len(lines) != 2 {
		t.Fatalf("want 2 responses, got %d: %q", len(lines), out.String())
	}
	var first map[string]any
	_ = json.Unmarshal([]byte(lines[0]), &first)
	if first["id"].(float64) != 1 {
		t.Fatalf("first response should be id 1, got %v", first["id"])
	}
}
