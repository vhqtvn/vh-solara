// Package mcp is a thin MCP (Model Context Protocol) facade over vh-solara's
// cross-worker coordination API (A4). It exposes the read + write verbs as MCP
// tools so an opencode agent — which is MCP-native — can drive sessions across
// machines directly, without shelling out. It is a stdio JSON-RPC server and an
// HTTP client of the controller's /api/workers/* API; it carries NO policy (it
// surfaces the same raw facts/verbs as the HTTP surface).
//
// Events stay on the SSE stream (/api/workers/{id}/events); MCP is
// request/response, so the reflex loop owns the stream — the agent uses these
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

// Server is a stdio MCP server backed by the coordination API.
type Server struct {
	BaseURL       string // controller base, e.g. http://127.0.0.1:8080
	Token         string // bearer for /api/...; empty if the API is open
	DefaultWorker string // used when a tool call omits "worker"
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
	worker := str(args, "worker")
	if worker == "" {
		worker = s.DefaultWorker
	}
	if worker == "" && p.Name != "list_workers" {
		return nil, fmt.Errorf("no worker specified and no default worker configured")
	}
	dir := str(args, "dir")

	switch p.Name {
	case "list_workers":
		return s.callAPI(http.MethodGet, "/api/coord/workers", nil, nil)
	case "list_sessions":
		return s.callAPI(http.MethodGet, workerPath(worker, "/sessions"), dirVals(dir, nil), nil)
	case "get_session":
		sid := str(args, "session_id")
		return s.callAPI(http.MethodGet, workerPath(worker, "/sessions/"+url.PathEscape(sid)), dirVals(dir, nil), nil)
	case "send_message":
		body := map[string]any{"text": str(args, "text")}
		if k := str(args, "idempotency_key"); k != "" {
			body["idempotency_key"] = k
		}
		hdr := map[string]string{}
		if seq := str(args, "if_idle_seq"); seq != "" {
			hdr["If-Idle-Seq"] = seq
		}
		return s.callAPIH(http.MethodPost, workerPath(worker, "/sessions/"+url.PathEscape(str(args, "session_id"))+"/message"), dirVals(dir, nil), body, hdr)
	case "spawn_session":
		body := map[string]any{}
		for _, k := range []string{"prompt", "title", "agent"} {
			if v := str(args, k); v != "" {
				body[k] = v
			}
		}
		if v := str(args, "parent_id"); v != "" {
			body["parentID"] = v
		}
		addIdem(body, args)
		return s.callAPI(http.MethodPost, workerPath(worker, "/sessions"), dirVals(dir, nil), body)
	case "abort_session":
		// abort is a DELETE (no body); idempotency_key rides the query (matches the
		// controller's coordAbort).
		q := dirVals(dir, nil)
		if k := str(args, "idempotency_key"); k != "" {
			if q == nil {
				q = url.Values{}
			}
			q.Set("idempotency_key", k)
		}
		return s.callAPI(http.MethodDelete, workerPath(worker, "/sessions/"+url.PathEscape(str(args, "session_id"))), q, nil)
	case "answer_question":
		body := map[string]any{"answers": args["answers"]}
		addIdem(body, args)
		return s.callAPI(http.MethodPost, workerPath(worker, "/sessions/"+url.PathEscape(str(args, "session_id"))+"/questions/"+url.PathEscape(str(args, "question_id"))), dirVals(dir, nil), body)
	case "reply_permission":
		body := map[string]any{"reply": str(args, "reply")}
		addIdem(body, args)
		return s.callAPI(http.MethodPost, workerPath(worker, "/sessions/"+url.PathEscape(str(args, "session_id"))+"/permissions/"+url.PathEscape(str(args, "permission_id"))), dirVals(dir, nil), body)
	case "archive_session":
		return s.callAPI(http.MethodPost, workerPath(worker, "/sessions/"+url.PathEscape(str(args, "session_id"))+"/archive"), dirVals(dir, nil), nil)
	default:
		return nil, fmt.Errorf("unknown tool: %s", p.Name)
	}
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
	if s.Token != "" {
		req.Header.Set("Authorization", "Bearer "+s.Token)
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
