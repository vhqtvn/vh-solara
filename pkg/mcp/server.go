// Package mcp is a thin MCP (Model Context Protocol) facade over vh-solara's
// cross-worker coordination API (A4). It exposes the read + write verbs as MCP
// tools so an opencode agent — which is MCP-native — can drive sessions across
// machines directly, without shelling out. It is a stdio JSON-RPC server and an
// HTTP client of the controller's /api/workers/* API; it carries NO policy (it
// surfaces the same raw facts/verbs as the HTTP surface).
//
// Events stay on the SSE stream (/api/workers/{id}/events); MCP is
// request/response, so the event-stream subscriber owns the stream — the agent uses these
// tools for on-demand reads and actions.
package mcp

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Server is a stdio MCP server backed by vh-solara's verbs. Two modes:
//   - Local (default for an agent on the worker machine): target a local
//     `--web vh` server's /vh/* directly (loopback, no controller, no bearer, no
//     tunnel — so the connection-smuggling path doesn't apply). This is the
//     common case: an agent driving its OWN sessions.
//   - Controller: target a controller's /api/workers/{id}/* to drive ANY
//     machine's worker (the cross-machine coordinator case; bearer-gated).
type Server struct {
	BaseURL       string // vh server (local) or controller base
	Token         string // bearer for controller mode; empty in local mode
	DefaultWorker string // controller mode: used when a tool call omits "worker"
	Local         bool   // true → drive a local /vh/* server directly
	Version       string
	HTTP          *http.Client
}

// New builds an MCP server targeting a controller base URL.
func New(baseURL, token, defaultWorker, version string) *Server {
	return &Server{
		BaseURL:       strings.TrimRight(baseURL, "/"),
		Token:         token,
		DefaultWorker: defaultWorker,
		Version:       version,
		HTTP:          &http.Client{Timeout: 30 * time.Second},
	}
}

// --- JSON-RPC framing (newline-delimited, per the MCP stdio transport) ---

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"` // absent for notifications
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcResponse struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id,omitempty"`
	Result  any             `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// Serve runs the stdio loop until in is exhausted. Each line is one JSON-RPC
// message; responses are written one per line. Notifications (no id) get no
// response.
func (s *Server) Serve(in io.Reader, out io.Writer) error {
	r := bufio.NewReaderSize(in, 1<<20)
	enc := json.NewEncoder(out)
	for {
		line, err := r.ReadBytes('\n')
		if len(bytes.TrimSpace(line)) > 0 {
			var req rpcRequest
			if jerr := json.Unmarshal(line, &req); jerr != nil {
				// Can't parse → no id to reply to; skip.
				if err != nil {
					return ioEOF(err)
				}
				continue
			}
			resp, hasResp := s.dispatch(&req)
			if hasResp {
				if werr := enc.Encode(resp); werr != nil {
					return werr
				}
			}
		}
		if err != nil {
			return ioEOF(err)
		}
	}
}

func ioEOF(err error) error {
	if err == io.EOF {
		return nil
	}
	return err
}

func (s *Server) dispatch(req *rpcRequest) (rpcResponse, bool) {
	resp := rpcResponse{JSONRPC: "2.0", ID: req.ID}
	isNotification := len(req.ID) == 0
	switch req.Method {
	case "initialize":
		resp.Result = s.handleInitialize(req.Params)
	case "notifications/initialized", "notifications/cancelled":
		return resp, false // notifications: no reply
	case "ping":
		resp.Result = map[string]any{}
	case "tools/list":
		resp.Result = map[string]any{"tools": toolDefs()}
	case "tools/call":
		result, err := s.handleToolCall(req.Params)
		if err != nil {
			resp.Result = toolError(err.Error())
		} else {
			resp.Result = result
		}
	default:
		if isNotification {
			return resp, false
		}
		resp.Error = &rpcError{Code: -32601, Message: "method not found: " + req.Method}
	}
	if isNotification {
		return resp, false
	}
	return resp, true
}

func (s *Server) handleInitialize(params json.RawMessage) map[string]any {
	// Echo the client's protocol version for maximum compatibility.
	var p struct {
		ProtocolVersion string `json:"protocolVersion"`
	}
	_ = json.Unmarshal(params, &p)
	pv := p.ProtocolVersion
	if pv == "" {
		pv = "2025-06-18"
	}
	return map[string]any{
		"protocolVersion": pv,
		"capabilities":    map[string]any{"tools": map[string]any{}},
		"serverInfo":      map[string]any{"name": "vh-solara", "version": s.Version},
	}
}

// --- tool definitions ---

func strProp(desc string) map[string]any {
	return map[string]any{"type": "string", "description": desc}
}

func objSchema(props map[string]any, required ...string) map[string]any {
	return map[string]any{"type": "object", "properties": props, "required": required}
}

func toolDefs() []map[string]any {
	worker := strProp("worker id (omit to use the server's default worker)")
	dir := strProp("project directory on the worker (optional)")
	return []map[string]any{
		{"name": "list_workers", "description": "List connected workers (id, name, status).",
			"inputSchema": objSchema(map[string]any{})},
		{"name": "list_sessions", "description": "List a worker's sessions with per-session gate facts (activity, finish_reason, subtree_busy, pending_question/permission). Tree-only by default.",
			"inputSchema": objSchema(map[string]any{"worker": worker, "dir": dir})},
		{"name": "get_session", "description": "Get one session's detail incl. messages and gate facts.",
			"inputSchema": objSchema(map[string]any{"worker": worker, "session_id": strProp("session id"), "dir": dir}, "session_id")},
		{"name": "send_message", "description": "Send a message to a session. Optional if_idle_seq enables compare-and-swap (send only if still sendable since that snapshot seq).",
			"inputSchema": objSchema(map[string]any{
				"worker": worker, "session_id": strProp("session id"), "text": strProp("message text"),
				"idempotency_key": strProp("optional dedup key"), "if_idle_seq": strProp("optional CAS seq"), "dir": dir,
			}, "session_id", "text")},
		{"name": "spawn_session", "description": "Create a session and optionally send a first prompt. Returns the new session id.",
			"inputSchema": objSchema(map[string]any{
				"worker": worker, "prompt": strProp("optional first prompt"), "title": strProp("optional title"),
				"parent_id": strProp("optional parent session id"), "agent": strProp("optional agent"),
				"idempotency_key": strProp("optional dedup key"), "dir": dir,
			})},
		{"name": "abort_session", "description": "Abort a session's in-flight turn. The resulting idle is asynchronous — wait for it before sending again.",
			"inputSchema": objSchema(map[string]any{"worker": worker, "session_id": strProp("session id"), "idempotency_key": strProp("optional dedup key"), "dir": dir}, "session_id")},
		{"name": "answer_question", "description": "Reply to a pending question. answers is OpenCode's [[...]] shape.",
			"inputSchema": objSchema(map[string]any{
				"worker": worker, "session_id": strProp("session id"), "question_id": strProp("question id"),
				"answers":         map[string]any{"type": "array", "description": "answers per question, e.g. [[\"yes\"]]"},
				"idempotency_key": strProp("optional dedup key"), "dir": dir,
			}, "session_id", "question_id", "answers")},
		{"name": "reply_permission", "description": "Reply to a pending permission: once|always|reject.",
			"inputSchema": objSchema(map[string]any{
				"worker": worker, "session_id": strProp("session id"), "permission_id": strProp("permission id"),
				"reply": strProp("once|always|reject"), "idempotency_key": strProp("optional dedup key"), "dir": dir,
			}, "session_id", "permission_id", "reply")},
		{"name": "archive_session", "description": "Archive a session (and its subtree). Archive only a confirmed-done session — it leaves the live view.",
			"inputSchema": objSchema(map[string]any{"worker": worker, "session_id": strProp("session id"), "dir": dir}, "session_id")},
	}
}

// --- tool dispatch ---

func (s *Server) handleToolCall(params json.RawMessage) (map[string]any, error) {
	var p struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	if err := json.Unmarshal(params, &p); err != nil {
		return nil, fmt.Errorf("bad tools/call params: %w", err)
	}
	args := p.Arguments
	if args == nil {
		args = map[string]any{}
	}

	if p.Name == "list_workers" {
		if s.Local {
			// Local mode drives a single local worker; there is no fleet to list.
			return toolText(`[{"id":"local","name":"local (this machine)","status":"online"}]`, map[string]any{}), nil
		}
		return s.callAPI(http.MethodGet, "/api/coord/workers", nil, nil)
	}

	worker := str(args, "worker")
	if worker == "" {
		worker = s.DefaultWorker
	}
	if !s.Local && worker == "" {
		return nil, fmt.Errorf("no worker specified and no default worker configured (controller mode)")
	}

	method, path, q, body, hdr, err := s.buildCall(p.Name, worker, str(args, "dir"), args)
	if err != nil {
		return nil, err
	}
	return s.callAPIH(method, path, q, body, hdr)
}

// buildCall maps a tool to an HTTP request against the active backend. Local mode
// targets the worker's own /vh/* (body-addressed verbs, CSRF header, no bearer);
// controller mode targets /api/workers/{id}/* (path-addressed, bearer).
func (s *Server) buildCall(name, worker, dir string, args map[string]any) (method, path string, q url.Values, body any, hdr map[string]string, err error) {
	sid := str(args, "session_id")
	if s.Local {
		csrf := map[string]string{"X-VH-CSRF": "1"} // the worker /vh CSRF guard requires it on writes
		switch name {
		case "list_sessions":
			return http.MethodGet, "/vh/snapshot", dirVals(dir, nil), nil, nil, nil
		case "get_session":
			return http.MethodGet, "/vh/snapshot", dirVals(dir, url.Values{"sessions": {sid}}), nil, nil, nil
		case "send_message":
			b := map[string]any{"sessionID": sid, "text": str(args, "text")}
			addIdem(b, args)
			if seq := str(args, "if_idle_seq"); seq != "" {
				csrf["If-Idle-Seq"] = seq
			}
			return http.MethodPost, "/vh/send", dirVals(dir, nil), b, csrf, nil
		case "spawn_session":
			return http.MethodPost, "/vh/spawn", dirVals(dir, nil), spawnBody(args), csrf, nil
		case "abort_session":
			b := map[string]any{"sessionID": sid}
			addIdem(b, args)
			return http.MethodPost, "/vh/abort", dirVals(dir, nil), b, csrf, nil
		case "answer_question":
			b := map[string]any{"questionID": str(args, "question_id"), "answers": args["answers"]}
			addIdem(b, args)
			return http.MethodPost, "/vh/answer-question", dirVals(dir, nil), b, csrf, nil
		case "reply_permission":
			b := map[string]any{"permissionID": str(args, "permission_id"), "sessionID": sid, "reply": str(args, "reply")}
			addIdem(b, args)
			return http.MethodPost, "/vh/reply-permission", dirVals(dir, nil), b, csrf, nil
		case "archive_session":
			return http.MethodPost, "/vh/archive", dirVals(dir, nil), map[string]any{"sessionID": sid}, csrf, nil
		}
		return "", "", nil, nil, nil, fmt.Errorf("unknown tool: %s", name)
	}

	// Controller mode.
	hdr = map[string]string{}
	switch name {
	case "list_sessions":
		return http.MethodGet, workerPath(worker, "/sessions"), dirVals(dir, nil), nil, nil, nil
	case "get_session":
		return http.MethodGet, workerPath(worker, "/sessions/"+url.PathEscape(sid)), dirVals(dir, nil), nil, nil, nil
	case "send_message":
		b := map[string]any{"text": str(args, "text")}
		addIdem(b, args)
		if seq := str(args, "if_idle_seq"); seq != "" {
			hdr["If-Idle-Seq"] = seq
		}
		return http.MethodPost, workerPath(worker, "/sessions/"+url.PathEscape(sid)+"/message"), dirVals(dir, nil), b, hdr, nil
	case "spawn_session":
		return http.MethodPost, workerPath(worker, "/sessions"), dirVals(dir, nil), spawnBody(args), nil, nil
	case "abort_session":
		q := dirVals(dir, nil)
		if k := str(args, "idempotency_key"); k != "" {
			if q == nil {
				q = url.Values{}
			}
			q.Set("idempotency_key", k)
		}
		return http.MethodDelete, workerPath(worker, "/sessions/"+url.PathEscape(sid)), q, nil, nil, nil
	case "answer_question":
		b := map[string]any{"answers": args["answers"]}
		addIdem(b, args)
		return http.MethodPost, workerPath(worker, "/sessions/"+url.PathEscape(sid)+"/questions/"+url.PathEscape(str(args, "question_id"))), dirVals(dir, nil), b, nil, nil
	case "reply_permission":
		b := map[string]any{"reply": str(args, "reply")}
		addIdem(b, args)
		return http.MethodPost, workerPath(worker, "/sessions/"+url.PathEscape(sid)+"/permissions/"+url.PathEscape(str(args, "permission_id"))), dirVals(dir, nil), b, nil, nil
	case "archive_session":
		return http.MethodPost, workerPath(worker, "/sessions/"+url.PathEscape(sid)+"/archive"), dirVals(dir, nil), nil, nil, nil
	}
	return "", "", nil, nil, nil, fmt.Errorf("unknown tool: %s", name)
}

func spawnBody(args map[string]any) map[string]any {
	b := map[string]any{}
	for _, k := range []string{"prompt", "title", "agent"} {
		if v := str(args, k); v != "" {
			b[k] = v
		}
	}
	if v := str(args, "parent_id"); v != "" {
		b["parentID"] = v
	}
	addIdem(b, args)
	return b
}

func workerPath(worker, suffix string) string {
	return "/api/workers/" + url.PathEscape(worker) + suffix
}

func dirVals(dir string, v url.Values) url.Values {
	if dir == "" {
		return v
	}
	if v == nil {
		v = url.Values{}
	}
	v.Set("dir", dir)
	return v
}

// addIdem copies an idempotency_key argument into a verb body when present.
func addIdem(body, args map[string]any) {
	if k := str(args, "idempotency_key"); k != "" {
		body["idempotency_key"] = k
	}
}

func str(m map[string]any, k string) string {
	if s, ok := m[k].(string); ok {
		return s
	}
	return ""
}

func (s *Server) callAPI(method, path string, q url.Values, body any) (map[string]any, error) {
	return s.callAPIH(method, path, q, body, nil)
}

// callAPIH performs the HTTP request and wraps the response as MCP tool content.
// A non-2xx is returned as an error tool result (isError), not a transport error,
// so the agent sees the upstream message.
func (s *Server) callAPIH(method, path string, q url.Values, body any, hdr map[string]string) (map[string]any, error) {
	u := s.BaseURL + path
	if len(q) > 0 {
		u += "?" + q.Encode()
	}
	var rdr io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rdr = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(context.Background(), method, u, rdr)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if s.Token != "" && !s.Local {
		req.Header.Set("Authorization", "Bearer "+s.Token) // bearer is controller-mode only
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	resp, err := s.HTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
	text := string(respBody)
	meta := map[string]any{"epoch": resp.Header.Get("X-VH-Epoch"), "seq": resp.Header.Get("X-VH-Seq")}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return toolError(fmt.Sprintf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(text))), nil
	}
	return toolText(text, meta), nil
}

// toolText wraps a successful payload. The epoch/seq are appended as a structured
// hint so an agent can track the cursor.
func toolText(text string, meta map[string]any) map[string]any {
	out := map[string]any{"content": []map[string]any{{"type": "text", "text": text}}}
	if meta["epoch"] != "" || meta["seq"] != "" {
		out["_meta"] = meta
	}
	return out
}

func toolError(msg string) map[string]any {
	return map[string]any{
		"isError": true,
		"content": []map[string]any{{"type": "text", "text": msg}},
	}
}
