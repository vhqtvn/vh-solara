// Command fakellm is a deterministic, OpenAI-compatible LLM server for e2e
// tests. It lets the real `opencode` run real sessions without a real model or
// API key: configure opencode with an "@ai-sdk/openai-compatible" provider
// whose baseURL points here.
//
// Behaviour is driven by markers in the user's prompt so tests can exercise
// specific flows deterministically:
//
//   - "[[write]]" -> the assistant calls the `write` tool (overwrites
//     README.md), producing a tool part and a file diff; the follow-up turn
//     returns text.
//   - "[[task]]"  -> the assistant calls the `task` tool (general subagent),
//     producing a subsession; the follow-up turn returns text.
//   - "[[bash]]"  -> the assistant calls the `bash` tool (echo a marker). With
//     opencode configured to "ask" for bash, this raises a permission request;
//     the follow-up turn (after the reply) returns text.
//   - otherwise   -> a plain text reply that echoes the prompt.
//
// Tool calls are only emitted on agentic turns (requests that carry a `tools`
// array), so helper calls like title generation still get plain text.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"
)

type chatRequest struct {
	Model    string            `json:"model"`
	Stream   bool              `json:"stream"`
	Tools    []json.RawMessage `json:"tools"`
	Messages []struct {
		Role    string          `json:"role"`
		Content json.RawMessage `json:"content"`
	} `json:"messages"`
}

const (
	replyPrefix = "FAKE-LLM reply. You said: "
	doneText    = "FAKE-LLM finished the requested tool task."
)

func main() {
	addr := flag.String("addr", "127.0.0.1:11434", "listen address")
	flag.Parse()

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/models", handleModels)
	mux.HandleFunc("/v1/chat/completions", handleChat)
	mux.HandleFunc("/models", handleModels)
	mux.HandleFunc("/chat/completions", handleChat)

	log.Printf("fakellm listening on %s", *addr)
	if err := http.ListenAndServe(*addr, mux); err != nil {
		log.Fatal(err)
	}
}

func handleModels(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]any{
		"object": "list",
		"data":   []map[string]any{{"id": "dummy", "object": "model", "owned_by": "fakellm"}},
	})
}

func lastUserText(req chatRequest) string {
	for i := len(req.Messages) - 1; i >= 0; i-- {
		m := req.Messages[i]
		if m.Role != "user" {
			continue
		}
		var s string
		if json.Unmarshal(m.Content, &s) == nil && s != "" {
			return s
		}
		var parts []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(m.Content, &parts) == nil {
			var b strings.Builder
			for _, p := range parts {
				if p.Type == "text" {
					b.WriteString(p.Text)
				}
			}
			if b.Len() > 0 {
				return b.String()
			}
		}
	}
	return "(no user text)"
}

// lastMsgIsTool reports whether the final message is a tool result — i.e. the
// model is being asked to respond to a tool it just called, so this turn must
// terminate with text. (Checking *any* tool result in history would wrongly
// suppress tool calls on later human turns in the same session.)
func lastMsgIsTool(req chatRequest) bool {
	if len(req.Messages) == 0 {
		return false
	}
	return req.Messages[len(req.Messages)-1].Role == "tool"
}

func handleChat(w http.ResponseWriter, r *http.Request) {
	var req chatRequest
	_ = json.NewDecoder(r.Body).Decode(&req)
	created := time.Now().Unix()
	id := fmt.Sprintf("chatcmpl-%d", created)
	model := req.Model
	if model == "" {
		model = "dummy"
	}
	agentic := len(req.Tools) > 0
	lastUser := lastUserText(req)

	// Decide the action. Tool calls only on agentic turns, and never once a tool
	// result is already present (that turn terminates with text).
	var toolName, toolArgs string
	switch {
	case lastMsgIsTool(req):
		// terminate below with text
	case agentic && strings.Contains(lastUser, "[[write]]"):
		toolName = "write"
		toolArgs = `{"filePath":"README.md","content":"changed by fake llm\n"}`
	case agentic && strings.Contains(lastUser, "[[task]]"):
		toolName = "task"
		toolArgs = `{"description":"e2e subtask","prompt":"say hello","subagent_type":"general"}`
	case agentic && strings.Contains(lastUser, "[[bash]]"):
		toolName = "bash"
		toolArgs = `{"command":"echo permission-flow-ok","description":"e2e permission probe"}`
	}

	if !req.Stream {
		handleNonStream(w, id, created, model, toolName, toolArgs, lastUser)
		return
	}

	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "no stream", 500)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	send := func(choice map[string]any) {
		b, _ := json.Marshal(map[string]any{
			"id": id, "object": "chat.completion.chunk", "created": created, "model": model,
			"choices": []map[string]any{choice},
		})
		fmt.Fprintf(w, "data: %s\n\n", b)
		fl.Flush()
	}

	if toolName != "" {
		send(map[string]any{
			"index": 0,
			"delta": map[string]any{
				"role": "assistant",
				"tool_calls": []map[string]any{{
					"index": 0, "id": "call_" + toolName, "type": "function",
					"function": map[string]any{"name": toolName, "arguments": toolArgs},
				}},
			},
			"finish_reason": nil,
		})
		send(map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "tool_calls"})
		fmt.Fprint(w, "data: [DONE]\n\n")
		fl.Flush()
		return
	}

	reply := replyText(req, lastUser)
	send(map[string]any{"index": 0, "delta": map[string]any{"role": "assistant"}, "finish_reason": nil})
	for _, word := range strings.SplitAfter(reply, " ") {
		if word == "" {
			continue
		}
		send(map[string]any{"index": 0, "delta": map[string]any{"content": word}, "finish_reason": nil})
		time.Sleep(40 * time.Millisecond)
	}
	send(map[string]any{"index": 0, "delta": map[string]any{}, "finish_reason": "stop"})
	fmt.Fprint(w, "data: [DONE]\n\n")
	fl.Flush()
}

func replyText(req chatRequest, lastUser string) string {
	if lastMsgIsTool(req) {
		return doneText
	}
	return replyPrefix + lastUser
}

func handleNonStream(w http.ResponseWriter, id string, created int64, model, toolName, toolArgs, lastUser string) {
	if toolName != "" {
		writeJSON(w, map[string]any{
			"id": id, "object": "chat.completion", "created": created, "model": model,
			"choices": []map[string]any{{
				"index": 0, "finish_reason": "tool_calls",
				"message": map[string]any{"role": "assistant", "tool_calls": []map[string]any{{
					"id": "call_" + toolName, "type": "function",
					"function": map[string]any{"name": toolName, "arguments": toolArgs},
				}}},
			}},
		})
		return
	}
	writeJSON(w, map[string]any{
		"id": id, "object": "chat.completion", "created": created, "model": model,
		"choices": []map[string]any{{
			"index": 0, "finish_reason": "stop",
			"message": map[string]any{"role": "assistant", "content": replyPrefix + lastUser},
		}},
		"usage": map[string]any{"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
	})
}

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}
