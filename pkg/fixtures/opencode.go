// Package fixtures provides a production-shaped fake OpenCode server for the
// frontend harness: deterministic sessions/messages/diffs plus a /event stream
// that simulates a live streaming assistant response when a prompt is posted.
// It lets the real aggregator + web server + render pipeline run end-to-end
// without a real `opencode` binary (mirrors trueai-dev's gated fixture mode).
package fixtures

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// FakeOpenCode implements the subset of OpenCode's HTTP API the daemon uses.
type FakeOpenCode struct {
	mu       sync.Mutex
	sessions []map[string]any
	messages map[string][]messageWithParts // sessionID -> ordered messages
	subs     map[int]chan string
	nextSub  int
	counter  int
	pendingQ map[string]string         // questionID -> sessionID
	pendingQReq map[string]map[string]any // questionID -> full question request
	pendingP map[string]map[string]any  // permissionID -> full permission request
	archived map[string]bool           // sessionID -> archived (native time.archived)
	busy     map[string]string         // sessionID -> status type (busy/retry); mirrors /session/status
}

type messageWithParts struct {
	Info  map[string]any   `json:"info"`
	Parts []map[string]any `json:"parts"`
}

// New returns a FakeOpenCode seeded with a small, deterministic dataset: two
// root sessions, one subsession, and a session with a rendered-markdown text
// part plus a completed tool part.
func New() *FakeOpenCode {
	f := &FakeOpenCode{
		messages: map[string][]messageWithParts{},
		subs:     map[int]chan string{},
		pendingQ:    map[string]string{},
		pendingQReq: map[string]map[string]any{},
		pendingP:    map[string]map[string]any{},
		archived:    map[string]bool{},
		busy:        map[string]string{},
	}
	now := float64(time.Now().UnixMilli())
	f.sessions = []map[string]any{
		{"id": "demo", "projectID": "proj", "title": "Demo session", "directory": "/work/demo",
			// Real OpenCode names the session model `id` (not `modelID`).
			"model": map[string]any{"providerID": "fake", "id": "dummy", "variant": "default"},
			"time":  map[string]any{"created": now - 5000, "updated": now}},
		{"id": "sub", "projectID": "proj", "parentID": "demo", "title": "Subagent: search", "directory": "/work/demo", "time": map[string]any{"created": now - 3000, "updated": now - 2000}},
		{"id": "other", "projectID": "proj", "title": "Another root", "directory": "/work/other", "time": map[string]any{"created": now - 9000, "updated": now - 9000}},
	}
	f.messages["demo"] = []messageWithParts{
		{
			Info:  map[string]any{"id": "m1", "sessionID": "demo", "role": "user", "time": map[string]any{"created": now - 4800, "completed": now - 4800}},
			Parts: []map[string]any{textPart("m1", "demo", "p1", "Refactor the parser and explain the change.", now-4800)},
		},
		{
			Info: map[string]any{"id": "m2", "sessionID": "demo", "role": "assistant", "time": map[string]any{"created": now - 4600, "completed": now - 4000},
				"model": map[string]any{"providerID": "fake", "modelID": "dummy-think", "variant": "high"}},
			Parts: []map[string]any{
				textPart("m2", "demo", "p2", "Here's the plan:\n\n1. Extract the tokenizer\n2. Add tests\n\n```go\nfunc Parse(s string) (*AST, error) {\n\treturn parse(s)\n}\n```\n\nComplexity is $O(n \\log n)$; over the input:\n\n$$\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}$$\n\nEdited src/parser.go:2 accordingly.", now-4600),
				// Reasoning + a few tools so the Activity timeline (grouping, the
				// Thinking row, and the "+N more" collapse) is exercisable.
				{"id": "p2r", "sessionID": "demo", "messageID": "m2", "type": "reasoning",
					"text": "Let me read the tokenizer and the parser entrypoint before editing, then run the existing tests.",
					"time": map[string]any{"start": now - 4580, "end": now - 4560}},
				{"id": "p2a", "sessionID": "demo", "messageID": "m2", "type": "tool", "callID": "c0a", "tool": "grep",
					"state": map[string]any{"status": "completed", "title": "search the codebase",
						"input": map[string]any{"pattern": "func parse"}, "output": "src/parser.go:2\nsrc/tokenizer.go:14",
						"time": map[string]any{"start": now - 4555, "end": now - 4540}}},
				{"id": "p2b", "sessionID": "demo", "messageID": "m2", "type": "tool", "callID": "c0b", "tool": "read",
					"state": map[string]any{"status": "completed", "title": "read parser.go",
						"input": map[string]any{"filePath": "src/parser.go"}, "output": "package main\n\nfunc parse(s string) {}",
						"time": map[string]any{"start": now - 4535, "end": now - 4520}}},
				{"id": "p2c", "sessionID": "demo", "messageID": "m2", "type": "tool", "callID": "c0c", "tool": "read",
					"state": map[string]any{"status": "completed", "title": "read tokenizer.go",
						"input": map[string]any{"filePath": "src/tokenizer.go"}, "output": "package main\n// tokenizer",
						"time": map[string]any{"start": now - 4515, "end": now - 4505}}},
				{
					"id": "p3", "sessionID": "demo", "messageID": "m2", "type": "tool", "callID": "c1", "tool": "edit",
					"state": map[string]any{"status": "completed", "title": "edit parser.go",
						"input":  map[string]any{"filePath": "parser.go"},
						"output": "Applied 1 edit to parser.go",
						// LSP diagnostics OpenCode attaches after an edit (keyed by file).
						"metadata": map[string]any{"diagnostics": map[string]any{
							"parser.go": []map[string]any{
								{"severity": 1, "message": "undefined: parse", "range": map[string]any{"start": map[string]any{"line": 1, "character": 8}}},
							},
						}},
						"time": map[string]any{"start": now - 4500, "end": now - 4400}},
				},
				{
					"id": "p4", "sessionID": "demo", "messageID": "m2", "type": "tool", "callID": "c2", "tool": "task",
					"state": map[string]any{"status": "completed", "title": "search the codebase",
						"metadata": map[string]any{"sessionId": "sub", "parentSessionId": "demo"},
						"input":    map[string]any{"description": "search the codebase", "subagent_type": "general"},
						"output":   "found 3 matches", "time": map[string]any{"start": now - 4300, "end": now - 2100}},
				},
			},
		},
	}
	f.messages["sub"] = []messageWithParts{
		{
			Info:  map[string]any{"id": "sm1", "sessionID": "sub", "role": "assistant", "time": map[string]any{"created": now - 2900, "completed": now - 2100}},
			Parts: []map[string]any{textPart("sm1", "sub", "sp1", "Searched 12 files, found 3 matches.", now-2900)},
		},
	}
	// Opt-in heavy session for benchmarking: VH_BENCH_MESSAGES=N seeds a "bench"
	// session with N complex messages (markdown + code + tool calls + diffs).
	if n, _ := strconv.Atoi(os.Getenv("VH_BENCH_MESSAGES")); n > 0 {
		f.sessions = append(f.sessions, map[string]any{
			"id": "bench", "title": "Benchmark (" + strconv.Itoa(n) + " msgs)",
			"directory": "/work/bench", "time": map[string]any{"created": now - 8000, "updated": now},
		})
		f.messages["bench"] = buildBenchMessages(n, now)
	}
	return f
}

// buildBenchMessages creates n alternating user/assistant messages; assistants
// carry markdown + a fenced code block, a completed tool call, and a unified
// diff — the realistic mix that stresses server-render + the message list.
func buildBenchMessages(n int, now float64) []messageWithParts {
	out := make([]messageWithParts, 0, n)
	for i := 0; i < n; i++ {
		t := now - float64((n-i)*1000)
		if i%2 == 0 {
			id := fmt.Sprintf("bu%d", i)
			out = append(out, messageWithParts{
				Info:  map[string]any{"id": id, "sessionID": "bench", "role": "user", "time": map[string]any{"created": t, "completed": t}},
				Parts: []map[string]any{textPart(id, "bench", "bup"+strconv.Itoa(i), fmt.Sprintf("Message %d: optimize the tokenizer and add a test for `Parse`.", i), t)},
			})
			continue
		}
		id := fmt.Sprintf("ba%d", i)
		code := fmt.Sprintf("```go\nfunc tokenize%d(s string) []Token {\n\tvar out []Token\n\tfor _, r := range s {\n\t\tout = append(out, Token{R: r})\n\t}\n\treturn out // pass %d\n}\n```", i, i)
		out = append(out, messageWithParts{
			Info: map[string]any{"id": id, "sessionID": "bench", "role": "assistant",
				"time": map[string]any{"created": t, "completed": t + 400}, "cost": 0.0021,
				"tokens": map[string]any{"input": 1800 + i, "output": 240, "cache": map[string]any{"read": 900, "write": 0}}},
			Parts: []map[string]any{
				textPart(id, "bench", "bap"+strconv.Itoa(i), fmt.Sprintf("Step %d — here's the change:\n\n- extract `tokenize`\n- cover edge cases\n\n%s\n\nEdited src/parser.go:%d accordingly.", i, code, i), t),
				{
					"id": "bt" + strconv.Itoa(i), "sessionID": "bench", "messageID": id, "type": "tool", "callID": "bc" + strconv.Itoa(i), "tool": "edit",
					"state": map[string]any{"status": "completed", "title": fmt.Sprintf("edit parser.go (#%d)", i),
						"input":  map[string]any{"file": "parser.go"},
						"output": fmt.Sprintf("@@ -%d,3 +%d,4 @@\n func Parse(s string) (*AST, error) {\n-\treturn parse(s)\n+\ttok := tokenize%d(s)\n+\treturn parse(tok)\n }", i, i, i),
						"time":   map[string]any{"start": t + 100, "end": t + 200}},
				},
				{
					"id": "bsh" + strconv.Itoa(i), "sessionID": "bench", "messageID": id, "type": "tool", "callID": "bsc" + strconv.Itoa(i), "tool": "bash",
					"state": map[string]any{"status": "completed", "title": "go test ./...",
						"input":  map[string]any{"command": "go test ./..."},
						"output": "ok  \tparser\t0.01" + strconv.Itoa(i%9) + "s", "time": map[string]any{"start": t + 250, "end": t + 350}},
				},
			},
		})
	}
	return out
}

func textPart(msgID, sessionID, partID, text string, t float64) map[string]any {
	return map[string]any{
		"id": partID, "sessionID": sessionID, "messageID": msgID, "type": "text",
		"text": text, "time": map[string]any{"start": t, "end": t},
	}
}

// Handler returns the HTTP handler for the fake OpenCode API.
func (f *FakeOpenCode) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/session", f.handleSessionRoot)
	mux.HandleFunc("/session/status", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		out := map[string]any{}
		for sid, t := range f.busy {
			out[sid] = map[string]any{"type": t}
		}
		f.mu.Unlock()
		writeJSON(w, out)
	})
	mux.HandleFunc("/session/", f.handleSession)
	mux.HandleFunc("/event", f.handleEvent)
	mux.HandleFunc("/provider", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{
			"all": []map[string]any{{
				"id": "fake", "name": "Fake LLM", "source": "config", "env": []string{}, "options": map[string]any{},
				"models": map[string]any{
					"dummy": map[string]any{"id": "dummy", "name": "Dummy Model", "status": "active",
						"capabilities": map[string]any{"reasoning": false, "attachment": false},
						"cost":         map[string]any{"input": 0, "output": 0},
						"limit":        map[string]any{"context": 128000}},
					"dummy-think": map[string]any{"id": "dummy-think", "name": "Dummy Thinking", "status": "beta",
						"capabilities": map[string]any{"reasoning": true, "attachment": true},
						"cost":         map[string]any{"input": 3, "output": 15},
						"limit":        map[string]any{"context": 200000},
						"variants":     map[string]any{"low": map[string]any{}, "high": map[string]any{}}},
				},
			}},
			"default":   map[string]any{"fake": "dummy"},
			"connected": []string{"fake"},
		})
	})
	mux.HandleFunc("/agent", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, []map[string]any{
			{"name": "build", "mode": "primary", "description": "Default coding agent"},
			// `plan` carries a configured model+variant: selecting it should switch
			// the composer's model to match.
			{"name": "plan", "mode": "primary", "description": "Read-only planning agent",
				"model": map[string]any{"providerID": "fake", "modelID": "dummy-think"}, "variant": "high"},
			{"name": "general", "mode": "subagent", "description": "General subagent"},
			// hidden + subagent must never reach the composer picker.
			{"name": "summarize", "mode": "primary", "hidden": true, "description": "Internal"},
		})
	})
	// Slash-command catalog (composer autocomplete).
	mux.HandleFunc("/command", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, []map[string]any{
			{"name": "init", "description": "guided AGENTS.md setup", "source": "command"},
			{"name": "compact", "description": "summarize the conversation", "source": "command"},
		})
	})
	// File finder (composer @file autocomplete) — fuzzy path match.
	mux.HandleFunc("/find/file", func(w http.ResponseWriter, r *http.Request) {
		q := strings.ToLower(r.URL.Query().Get("query"))
		all := []string{"src/parser.go", "src/parser_test.go", "README.md", "cmd/main.go"}
		out := []string{}
		for _, p := range all {
			if q == "" || strings.Contains(strings.ToLower(p), q) {
				out = append(out, p)
			}
		}
		writeJSON(w, out)
	})
	mux.HandleFunc("/project", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, []map[string]any{
			{"id": "p1", "worktree": "/work/alpha", "name": "alpha", "time": map[string]any{"created": 1, "updated": 200}},
			{"id": "p2", "worktree": "/work/beta", "name": "beta", "time": map[string]any{"created": 1, "updated": 100}},
			// Same worktree as p1 under a different id (OpenCode does this on re-init);
			// the recents list must dedupe by directory so alpha shows once.
			{"id": "p1b", "worktree": "/work/alpha", "name": "alpha", "time": map[string]any{"created": 1, "updated": 50}},
		})
	})
	// On-demand session-name generation (the "Regenerate name" action). Mirrors
	// OpenCode's POST /experimental/project/:projectID/copy/generate-name, which
	// runs the small model and returns a short slug from the supplied context.
	mux.HandleFunc("/experimental/project/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/copy/generate-name") {
			body := map[string]any{}
			_ = json.NewDecoder(r.Body).Decode(&body)
			writeJSON(w, map[string]any{"name": "fixture-generated-name"})
			return
		}
		http.NotFound(w, r)
	})
	mux.HandleFunc("/lsp", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, []map[string]any{{"id": "gopls", "state": "running", "extensions": []string{".go"}}})
	})
	mux.HandleFunc("/mcp", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{
			"context7": map[string]any{"status": "connected", "type": "remote"},
			"local-fs": map[string]any{"status": "connected", "type": "local"},
		})
	})
	mux.HandleFunc("/config", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{
			"plugin":        []string{"opencode-notify", "github:acme/opencode-plugin-very-long-name@v1.2.3"},
			"mcp":           map[string]any{"context7": map[string]any{"type": "remote"}},
			"lsp":           map[string]any{"go": map[string]any{"command": []string{"gopls"}}},
			"default_agent": "plan",
		})
	})
	mux.HandleFunc("/file/content", func(w http.ResponseWriter, r *http.Request) {
		p := r.URL.Query().Get("path")
		writeJSON(w, map[string]any{
			"type":    "text",
			"content": "// " + p + " (fixture)\npackage demo\n\nfunc Parse(s string) (*AST, error) {\n\treturn parse(s)\n}\n",
		})
	})
	mux.HandleFunc("/vcs", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, map[string]any{"branch": "main", "default_branch": "main"})
	})
	mux.HandleFunc("/vcs/diff", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, []map[string]any{
			{"file": "parser.go", "status": "modified", "additions": 2, "deletions": 1,
				"patch": "@@ -1,3 +1,4 @@\n func Parse(s string) (*AST, error) {\n-\treturn parse(s)\n+\ttok := tokenize(s)\n+\treturn parse(tok)\n }"},
		})
	})
	mux.HandleFunc("/question/", f.handleQuestion)
	mux.HandleFunc("/question", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		out := make([]map[string]any, 0, len(f.pendingQReq))
		for _, req := range f.pendingQReq {
			out = append(out, req)
		}
		writeJSON(w, out)
	})
	mux.HandleFunc("/permission", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		out := make([]map[string]any, 0, len(f.pendingP))
		for _, req := range f.pendingP {
			out = append(out, req)
		}
		writeJSON(w, out)
	})
	// Canonical reply route: POST /permission/:requestID/reply {reply}.
	mux.HandleFunc("/permission/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/") // ["permission", id, "reply"]
		if len(parts) < 3 || parts[2] != "reply" || r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		id := parts[1]
		f.mu.Lock()
		req := f.pendingP[id]
		delete(f.pendingP, id)
		f.mu.Unlock()
		sid := ""
		if req != nil {
			sid, _ = req["sessionID"].(string)
		}
		f.emit("permission.replied", map[string]any{"sessionID": sid, "requestID": id})
		writeJSON(w, true)
	})
	return mux
}

// handleQuestion answers a pending question: POST /question/:id/reply.
func (f *FakeOpenCode) handleQuestion(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/") // ["question", id, "reply"]
	if len(parts) < 3 || parts[2] != "reply" || r.Method != http.MethodPost {
		http.NotFound(w, r)
		return
	}
	id := parts[1]
	var body struct {
		Answers [][]string `json:"answers"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	f.mu.Lock()
	sid := f.pendingQ[id]
	delete(f.pendingQ, id)
	delete(f.pendingQReq, id)
	f.mu.Unlock()
	if sid != "" {
		f.emit("question.replied", map[string]any{
			"sessionID": sid, "requestID": id, "answers": body.Answers,
		})
		// Continue the turn: the assistant acts on the answer and streams a reply,
		// so the user sees a visible result after replying.
		chosen := "your choice"
		if len(body.Answers) > 0 && len(body.Answers[0]) > 0 {
			chosen = body.Answers[0][0]
		}
		f.mu.Lock()
		f.counter++
		n := f.counter
		f.mu.Unlock()
		go f.streamAssistant(sid, fmt.Sprintf("aq%d", n), fmt.Sprintf("apq%d", n),
			[]string{"Got it — going with **" + chosen + "**.", "\n\nProceeding now."})
	}
	writeJSON(w, map[string]any{"ok": true})
}

func (f *FakeOpenCode) handleSessionRoot(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodPost {
		// Create a new session (powers the sidebar "New session" button).
		f.mu.Lock()
		f.counter++
		now := float64(time.Now().UnixMilli())
		s := map[string]any{
			"id": fmt.Sprintf("ses_new%d", f.counter), "projectID": "proj", "title": "New session",
			"directory": "/work/new", "time": map[string]any{"created": now, "updated": now},
		}
		f.sessions = append(f.sessions, s)
		f.mu.Unlock()
		f.emit("session.created", map[string]any{"info": s})
		writeJSON(w, s)
		return
	}
	// Multi-project: scope by the x-opencode-directory header. A non-empty
	// directory returns a synthetic per-directory session so the project
	// switcher is demoable/testable.
	if dir := r.Header.Get("x-opencode-directory"); dir != "" {
		base := dir
		if i := strings.LastIndex(strings.TrimRight(dir, "/"), "/"); i >= 0 {
			base = strings.TrimRight(dir, "/")[i+1:]
		}
		now := float64(time.Now().UnixMilli())
		writeJSON(w, []map[string]any{
			{"id": "proj_" + base, "title": "Project: " + base, "directory": dir,
				"time": map[string]any{"created": now - 1000, "updated": now}},
		})
		return
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	wantArchived := r.URL.Query().Get("archived") == "true"
	out := make([]map[string]any, 0, len(f.sessions))
	for _, s := range f.sessions {
		id, _ := s["id"].(string)
		if f.archived[id] == wantArchived {
			out = append(out, f.withArchivedTime(s))
		}
	}
	writeJSON(w, out)
}

// withArchivedTime returns a copy of the session with time.archived set when the
// session is archived (mirrors OpenCode's native archive field).
func (f *FakeOpenCode) withArchivedTime(s map[string]any) map[string]any {
	id, _ := s["id"].(string)
	if !f.archived[id] {
		return s
	}
	cp := map[string]any{}
	for k, v := range s {
		cp[k] = v
	}
	t := map[string]any{}
	if orig, ok := s["time"].(map[string]any); ok {
		for k, v := range orig {
			t[k] = v
		}
	}
	t["archived"] = float64(time.Now().UnixMilli())
	cp["time"] = t
	return cp
}

func (f *FakeOpenCode) handleSession(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/") // ["session", id, action?, ...]
	id := ""
	action := ""
	if len(parts) >= 2 {
		id = parts[1]
	}
	if len(parts) >= 3 {
		action = parts[2]
	}

	switch {
	case action == "" && r.Method == http.MethodPatch:
		// Update a session: archive (time.archived) and/or title.
		var body struct {
			Title *string `json:"title"`
			Time  *struct {
				Archived *float64 `json:"archived"`
			} `json:"time"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		if body.Time != nil {
			f.archived[id] = body.Time.Archived != nil && *body.Time.Archived != 0
		}
		var updated map[string]any
		if body.Title != nil {
			for _, s := range f.sessions {
				if s["id"] == id {
					s["title"] = *body.Title
					updated = s
					break
				}
			}
		}
		f.mu.Unlock()
		if updated != nil {
			f.emit("session.updated", map[string]any{"info": updated})
		}
		writeJSON(w, map[string]any{"id": id})
		return
	case action == "permissions" && r.Method == http.MethodPost:
		permID := parts[len(parts)-1]
		f.mu.Lock()
		delete(f.pendingP, permID)
		f.mu.Unlock()
		f.emit("permission.replied", map[string]any{"sessionID": id, "requestID": permID})
		writeJSON(w, map[string]any{"ok": true})
		return
	case action == "shell" && r.Method == http.MethodPost:
		body := map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		cmd, _ := body["command"].(string)
		go f.simulateShell(id, cmd)
		writeJSON(w, map[string]any{"ok": true})
		return
	case action == "fork" && r.Method == http.MethodPost:
		f.mu.Lock()
		f.counter++
		now := float64(time.Now().UnixMilli())
		s := map[string]any{"id": fmt.Sprintf("ses_fork%d", f.counter), "parentID": id,
			"title": "Fork", "directory": "/work/demo", "time": map[string]any{"created": now, "updated": now}}
		f.sessions = append(f.sessions, s)
		f.mu.Unlock()
		f.emit("session.created", map[string]any{"info": s})
		writeJSON(w, s)
		return
	case (action == "revert" || action == "unrevert") && r.Method == http.MethodPost:
		writeJSON(w, map[string]any{"ok": true}) // fixture: acknowledge
		return
	case action == "abort" && r.Method == http.MethodPost:
		// Like real OpenCode, abort does NOT emit an idle event — the client must
		// clear its own working state optimistically.
		writeJSON(w, map[string]any{"ok": true})
		return
	case action == "message" && r.Method == http.MethodPost:
		body := map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		go f.simulatePrompt(id, promptText(body))
		writeJSON(w, map[string]any{"ok": true})
		return
	case action == "prompt_async" && r.Method == http.MethodPost:
		// Mirror real OpenCode: fork the turn and return 204 immediately; the
		// reply arrives over the event stream.
		body := map[string]any{}
		_ = json.NewDecoder(r.Body).Decode(&body)
		go f.simulatePrompt(id, promptText(body))
		w.WriteHeader(http.StatusNoContent)
		return
	}

	f.mu.Lock()
	defer f.mu.Unlock()
	writeJSON(w, f.messages[id])
}

// simulateShell emits a user message containing the command and an assistant
// message with canned shell output.
func (f *FakeOpenCode) simulateShell(sessionID, command string) {
	now := func() float64 { return float64(time.Now().UnixMilli()) }
	f.mu.Lock()
	f.counter++
	n := f.counter
	f.mu.Unlock()
	uid := fmt.Sprintf("sh-u%d", n)
	aid := fmt.Sprintf("sh-a%d", n)
	f.emit("session.status", map[string]any{"sessionID": sessionID, "status": map[string]any{"type": "busy"}})
	userInfo := map[string]any{"id": uid, "sessionID": sessionID, "role": "user", "time": map[string]any{"created": now(), "completed": now()}}
	f.emit("message.updated", map[string]any{"info": userInfo})
	f.emit("message.part.updated", map[string]any{"part": textPart(uid, sessionID, "shp"+strconv.Itoa(n), "$ "+command, now())})
	asst := map[string]any{"id": aid, "sessionID": sessionID, "role": "assistant", "time": map[string]any{"created": now(), "completed": now()}}
	f.emit("message.updated", map[string]any{"info": asst})
	f.emit("message.part.updated", map[string]any{"part": map[string]any{
		"id": "shtool" + strconv.Itoa(n), "sessionID": sessionID, "messageID": aid, "type": "tool", "tool": "bash",
		"state": map[string]any{"status": "completed", "title": command, "output": "fixture shell output for: " + command,
			"input": map[string]any{"command": command},
			"time":  map[string]any{"start": now(), "end": now()}}}})
	f.emit("session.idle", map[string]any{"sessionID": sessionID})
}

func promptText(body map[string]any) string {
	parts, _ := body["parts"].([]any)
	for _, p := range parts {
		if m, ok := p.(map[string]any); ok {
			if t, _ := m["text"].(string); t != "" {
				return t
			}
		}
	}
	return "(empty prompt)"
}

// --- event stream + streaming simulation ---

func (f *FakeOpenCode) handleEvent(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "no flush", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")

	ch, unsub := f.subscribe()
	defer unsub()

	fmt.Fprint(w, "data: {\"type\":\"server.connected\",\"properties\":{}}\n\n")
	fl.Flush()

	// Seed an agent todo list (OpenCode TodoWrite) for the demo session so the
	// "Tasks N active · M left" indicator is exercisable in the fixture lane.
	fmt.Fprint(w, `data: {"type":"todo.updated","properties":{"sessionID":"demo","todos":[`+
		`{"id":"t1","content":"Extract the tokenizer","status":"completed"},`+
		`{"id":"t2","content":"Add parser tests","status":"in_progress"},`+
		`{"id":"t3","content":"Wire error recovery","status":"pending"},`+
		`{"id":"t4","content":"Update docs","status":"pending"}]}}`+"\n\n")
	fl.Flush()

	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case payload := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", payload)
			fl.Flush()
		case <-ticker.C:
			fmt.Fprint(w, "data: {\"type\":\"server.heartbeat\",\"properties\":{}}\n\n")
			fl.Flush()
		}
	}
}

func (f *FakeOpenCode) subscribe() (<-chan string, func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	id := f.nextSub
	f.nextSub++
	ch := make(chan string, 64)
	f.subs[id] = ch
	return ch, func() {
		f.mu.Lock()
		defer f.mu.Unlock()
		if c, ok := f.subs[id]; ok {
			close(c)
			delete(f.subs, id)
		}
	}
}

func (f *FakeOpenCode) emit(eventType string, props any) {
	payload, _ := json.Marshal(map[string]any{"type": eventType, "properties": props})
	f.mu.Lock()
	defer f.mu.Unlock()
	// Mirror live status into the busy map so GET /session/status is faithful
	// (a reconnect/reload re-reads it, like real OpenCode).
	if m, ok := props.(map[string]any); ok {
		sid, _ := m["sessionID"].(string)
		if sid != "" {
			switch eventType {
			case "session.status":
				t := ""
				if st, ok := m["status"].(map[string]any); ok {
					t, _ = st["type"].(string)
				}
				if t == "idle" || t == "" {
					delete(f.busy, sid)
				} else {
					f.busy[sid] = t
				}
			case "session.idle", "session.error":
				delete(f.busy, sid)
			}
		}
	}
	for id, ch := range f.subs {
		select {
		case ch <- string(payload):
		default:
			close(ch)
			delete(f.subs, id)
		}
	}
}

// simulatePrompt mimics a live turn: append the user message, then stream an
// assistant text part in chunks, then mark it complete. Also persists to the
// message store so a reload reflects the turn.
func (f *FakeOpenCode) simulatePrompt(sessionID, text string) {
	now := func() float64 { return float64(time.Now().UnixMilli()) }
	f.mu.Lock()
	f.counter++
	n := f.counter
	f.mu.Unlock()

	userID := fmt.Sprintf("u%d", n)
	asstID := fmt.Sprintf("a%d", n)
	upID := fmt.Sprintf("up%d", n)
	apID := fmt.Sprintf("ap%d", n)

	// Mark the session busy for the duration of the turn (drives the sidebar dot).
	f.emit("session.status", map[string]any{"sessionID": sessionID, "status": map[string]any{"type": "busy"}})
	defer f.emit("session.idle", map[string]any{"sessionID": sessionID})

	userInfo := map[string]any{"id": userID, "sessionID": sessionID, "role": "user", "time": map[string]any{"created": now(), "completed": now()}}
	userPart := textPart(userID, sessionID, upID, text, now())
	f.appendMessage(sessionID, messageWithParts{Info: userInfo, Parts: []map[string]any{userPart}})
	f.emit("message.updated", map[string]any{"info": userInfo})
	f.emit("message.part.updated", map[string]any{"part": userPart})

	// A prompt containing [[perm]] raises a permission request and pauses there,
	// so the UI's permission card can be exercised.
	if strings.Contains(text, "[[perm]]") {
		pid := fmt.Sprintf("perm%d", n)
		// Mirror real OpenCode's Request shape: a permission category + patterns +
		// metadata (NO type/title), so the card renders detail from these.
		req := map[string]any{
			"id": pid, "sessionID": sessionID,
			"permission": "bash",
			"patterns":   []any{"rm -rf /tmp/scratch"},
			"metadata":   map[string]any{"command": "rm -rf /tmp/scratch"},
			"time":       map[string]any{"created": now()},
		}
		f.mu.Lock()
		f.pendingP[pid] = req
		f.mu.Unlock()
		f.emit("permission.asked", req) // real OpenCode event name
		return
	}
	if strings.Contains(text, "[[ask]]") {
		qid := fmt.Sprintf("que%d", n)
		req := map[string]any{
			"id": qid, "sessionID": sessionID,
			"questions": []map[string]any{{
				// custom omitted on purpose: opencode defaults free-text to enabled
				// (shown unless custom:false), so the card must still offer it.
				"header": "Direction", "question": "Which approach should I take?",
				"multiple": false,
				"options": []map[string]any{
					{"label": "Refactor", "description": "Restructure the existing parser"},
					{"label": "Rewrite", "description": "Start the parser fresh"},
				},
			}},
		}
		f.mu.Lock()
		f.pendingQ[qid] = sessionID
		f.pendingQReq[qid] = req
		f.mu.Unlock()
		f.emit("question.asked", req)
		return
	}

	// A prompt containing [[stall]] stays busy (no assistant message) for a few
	// seconds, so the UI's Stop/abort can be exercised against a hung turn.
	if strings.Contains(text, "[[stall]]") {
		time.Sleep(5 * time.Second)
		return
	}

	f.streamAssistant(sessionID, asstID, apID,
		[]string{"Working on it…", "\n\nDone. Updated ", "`parser.go` ", "and added a test."})
}

// streamAssistant emits an assistant message that streams in chunks, persists
// the final message, then marks the session idle. Shared by a fresh prompt and
// the continuation that follows a question reply.
func (f *FakeOpenCode) streamAssistant(sessionID, asstID, apID string, chunks []string) {
	now := func() float64 { return float64(time.Now().UnixMilli()) }
	asstInfo := map[string]any{"id": asstID, "sessionID": sessionID, "role": "assistant", "time": map[string]any{"created": now()}}
	f.emit("message.updated", map[string]any{"info": asstInfo})

	// Create the (empty) text part, then stream tokens via message.part.delta —
	// matching real OpenCode (the full message.part.updated only bookends).
	f.emit("message.part.updated", map[string]any{"part": map[string]any{
		"id": apID, "sessionID": sessionID, "messageID": asstID, "type": "text", "text": "",
		"time": map[string]any{"start": now()}}})
	acc := ""
	for _, c := range chunks {
		time.Sleep(180 * time.Millisecond)
		acc += c
		f.emit("message.part.delta", map[string]any{
			"sessionID": sessionID, "messageID": asstID, "partID": apID, "field": "text", "delta": c,
		})
	}

	finalPart := map[string]any{"id": apID, "sessionID": sessionID, "messageID": asstID, "type": "text", "text": acc, "time": map[string]any{"start": now(), "end": now()}}
	asstInfo["time"] = map[string]any{"created": asstInfo["time"].(map[string]any)["created"], "completed": now()}
	// A representative token/cost footprint so the inspector + context meter have data.
	asstInfo["cost"] = 0.0123
	asstInfo["tokens"] = map[string]any{"input": 4200, "output": 380, "cache": map[string]any{"read": 1800, "write": 0}}
	f.appendMessage(sessionID, messageWithParts{Info: asstInfo, Parts: []map[string]any{finalPart}})
	f.emit("message.part.updated", map[string]any{"part": finalPart})
	f.emit("message.updated", map[string]any{"info": asstInfo})
	f.emit("session.idle", map[string]any{"sessionID": sessionID})
}

func (f *FakeOpenCode) appendMessage(sessionID string, m messageWithParts) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.messages[sessionID] = append(f.messages[sessionID], m)
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
