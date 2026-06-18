// Package opencode is a schema-light Go client for a local `opencode serve`
// HTTP API. It parses only the envelope fields the daemon needs for structure
// (ids, parentID, event type) and keeps the rest as raw JSON, so it stays
// resilient to OpenCode schema drift.
package opencode

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// Client talks to a local opencode server (from `opencode serve`).
type Client struct {
	BaseURL string // e.g. http://127.0.0.1:4096
	HTTP    *http.Client

	// Directory scopes requests to a workspace. When empty, the server falls
	// back to the serve process's cwd (the single-workspace v1 case).
	Directory string
}

// New builds a Client for the given base URL.
func New(baseURL string) *Client {
	return &Client{
		BaseURL: strings.TrimRight(baseURL, "/"),
		HTTP:    &http.Client{Timeout: 30 * time.Second},
	}
}

func (c *Client) newRequest(ctx context.Context, method, path string, body io.Reader) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, method, c.BaseURL+path, body)
	if err != nil {
		return nil, err
	}
	if c.Directory != "" {
		req.Header.Set("x-opencode-directory", c.Directory)
	}
	return req, nil
}

// getJSON performs a GET and decodes the body into out. A non-2xx status is an error.
func (c *Client) getJSON(ctx context.Context, path string, out interface{}) error {
	req, err := c.newRequest(ctx, http.MethodGet, path, nil)
	if err != nil {
		return err
	}
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("GET %s: status %d: %s", path, resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

const (
	// sessionPageSize is the starting fetch size; sessionListMax is a hard
	// backstop against a pathological count.
	sessionPageSize = 2000
	sessionListMax  = 1_000_000
)

// ListSessions returns the project's sessions (roots + subsessions) as raw JSON,
// newest-updated first. Archived ones are dropped by the store, so the live tree
// ends up with every unarchived session.
//
// OpenCode 1.17.x's list has no backward pagination (no offset / before-cursor;
// `start` is a >= filter), so we can't page in the usual sense — the only knob
// is `limit`. Instead of a fixed magic limit that could silently overflow, we
// use an adaptive limit: request a page, and while it comes back FULL (more may
// exist) double and refetch, stopping as soon as a page isn't full (we've got
// everything). Bounded by sessionListMax.
func (c *Client) ListSessions(ctx context.Context) ([]json.RawMessage, error) {
	return c.listSessionsAdaptive(ctx, "/session?limit=%d")
}

// listSessionsAdaptive fetches a session list with an adaptive limit. pathFmt is
// a format string with a single %d for the limit (e.g. "/session?limit=%d" or
// "/session?archived=true&limit=%d"). It grows the limit while pages come back
// full and stops once one isn't (everything fetched), bounded by sessionListMax.
func (c *Client) listSessionsAdaptive(ctx context.Context, pathFmt string) ([]json.RawMessage, error) {
	limit := sessionPageSize
	for {
		var out []json.RawMessage
		if err := c.getJSON(ctx, fmt.Sprintf(pathFmt, limit), &out); err != nil {
			return nil, err
		}
		if len(out) < limit || limit >= sessionListMax {
			if len(out) >= sessionListMax {
				log.Printf("[opencode] WARNING: session list hit the %d backstop; some sessions may be missing", sessionListMax)
			}
			return out, nil // page not full → fetched everything
		}
		limit *= 2
	}
}

// ListQuestions returns the questions currently pending an answer (GET
// /question). These survive while the OpenCode instance runs but only arrive
// via the event stream otherwise, so a reconnecting client must re-fetch them.
func (c *Client) ListQuestions(ctx context.Context) ([]json.RawMessage, error) {
	var out []json.RawMessage
	if err := c.getJSON(ctx, "/question", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListPermissions returns the permission requests currently pending a reply
// (GET /permission) — recovered the same way as pending questions.
func (c *Client) ListPermissions(ctx context.Context) ([]json.RawMessage, error) {
	var out []json.RawMessage
	if err := c.getJSON(ctx, "/permission", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// ListArchivedSessions returns the archived sessions for the resolved workspace
// (OpenCode excludes archived from the default /session list).
func (c *Client) ListArchivedSessions(ctx context.Context) ([]json.RawMessage, error) {
	// 1.17.x ignores the archived param and returns ALL sessions; the archived
	// browser filters to archived client-side. Fetch the lot adaptively.
	return c.listSessionsAdaptive(ctx, "/session?archived=true&limit=%d")
}

// SetArchived sets (ts != nil) or clears (ts == nil) a session's archived
// timestamp via OpenCode's native archive (PATCH /session/:id). This is the
// real archive — it persists in OpenCode and is visible to every client.
func (c *Client) SetArchived(ctx context.Context, id string, ts *int64) error {
	var archived any // null clears the archive
	if ts != nil {
		archived = *ts
	}
	body, _ := json.Marshal(map[string]any{"time": map[string]any{"archived": archived}})
	req, err := c.newRequest(ctx, http.MethodPatch, "/session/"+id, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("PATCH /session/%s: status %d: %s", id, resp.StatusCode, strings.TrimSpace(string(b)))
	}
	return nil
}

// SessionStatuses returns the current per-session status map (sessionID ->
// SessionStatus) from GET /session/status.
func (c *Client) SessionStatuses(ctx context.Context) (map[string]json.RawMessage, error) {
	out := map[string]json.RawMessage{}
	if err := c.getJSON(ctx, "/session/status", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Children returns the direct child (sub-)sessions of a session.
func (c *Client) Children(ctx context.Context, sessionID string) ([]json.RawMessage, error) {
	var out []json.RawMessage
	if err := c.getJSON(ctx, "/session/"+sessionID+"/children", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Messages returns the messages of a session as raw JSON objects. Each element
// is typically a { info, parts } pair as emitted by OpenCode.
func (c *Client) Messages(ctx context.Context, sessionID string) ([]json.RawMessage, error) {
	var out []json.RawMessage
	if err := c.getJSON(ctx, "/session/"+sessionID+"/message", &out); err != nil {
		return nil, err
	}
	return out, nil
}

// Event is one OpenCode SSE event: { id, type, properties }.
type Event struct {
	ID         string          `json:"id"`
	Type       string          `json:"type"`
	Properties json.RawMessage `json:"properties"`
}

// SubscribeEvents opens GET /event and invokes handler for each event until the
// context is cancelled, the stream ends, or handler returns an error. It does
// not reconnect — the caller (aggregator) owns the reconnect/re-hydrate loop,
// since OpenCode's stream has no replay.
func (c *Client) SubscribeEvents(ctx context.Context, handler func(Event) error) error {
	req, err := c.newRequest(ctx, http.MethodGet, "/event", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")

	// No client-level timeout for the streaming connection.
	httpClient := &http.Client{}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 2048))
		return fmt.Errorf("subscribe /event: status %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	// Minimal SSE parse: accumulate `data:` lines until a blank line, then dispatch.
	reader := bufio.NewReaderSize(resp.Body, 256*1024)
	var data strings.Builder
	dispatch := func() error {
		if data.Len() == 0 {
			return nil
		}
		raw := data.String()
		data.Reset()
		var ev Event
		if err := json.Unmarshal([]byte(raw), &ev); err != nil {
			return nil // skip malformed frame, keep streaming
		}
		return handler(ev)
	}

	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		default:
		}

		line, err := reader.ReadString('\n')
		if len(line) > 0 {
			line = strings.TrimRight(line, "\r\n")
			switch {
			case line == "":
				if derr := dispatch(); derr != nil {
					return derr
				}
			case strings.HasPrefix(line, "data:"):
				// SSE allows a single optional leading space after the colon.
				data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			default:
				// ignore `event:`, `id:`, comments (`:`), etc.
			}
		}
		if err != nil {
			if err == io.EOF {
				_ = dispatch()
				return io.EOF
			}
			return err
		}
	}
}
