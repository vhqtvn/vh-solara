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
	// 1.17.x ignores the archived param and returns ALL sessions (archived +
	// non-archived). The non-archived entries are filtered out server-side in
	// pkg/web/archive.go's archivedLevel (which inspects time.archived). Fetch
	// the lot adaptively so the filter has everything to work with.
	return c.listSessionsAdaptive(ctx, "/session?archived=true&limit=%d")
}

// SetArchived sets a session's archived timestamp via OpenCode's native archive
// (PATCH /session/:id time.archived). This is the real archive — it persists in
// OpenCode and is visible to every client. The timestamp is always a finite
// value (the set path): OpenCode 1.17.x has no HTTP mechanism to clear
// (restore) an archive — a PATCH with a JSON null for time.archived is rejected
// with 400 — so unarchive goes through the direct-SQLite path instead
// (pkg/opencode/db.go). See docs/architecture/opencode-sqlite-unarchive.md.
func (c *Client) SetArchived(ctx context.Context, id string, ts int64) error {
	body, _ := json.Marshal(map[string]any{"time": map[string]any{"archived": ts}})
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

// Error is a non-2xx response from a write verb. It carries the upstream status
// so a handler can propagate a meaningful client error (e.g. a stale request-id)
// instead of masking everything as a 502.
type Error struct {
	Status int
	Op     string
	Body   string
}

func (e *Error) Error() string {
	return fmt.Sprintf("%s: status %d: %s", e.Op, e.Status, e.Body)
}

func statusErr(op string, st int, b []byte) *Error {
	return &Error{Status: st, Op: op, Body: strings.TrimSpace(string(b))}
}

// postRaw POSTs a JSON body to path and returns the status code + response body.
// Schema-light: the body and response are raw JSON, so write verbs stay resilient
// to OpenCode schema drift (the same philosophy as the read client). A nil body
// sends an empty POST.
func (c *Client) postRaw(ctx context.Context, path string, body json.RawMessage) (int, []byte, error) {
	var r io.Reader
	if len(body) > 0 {
		r = bytes.NewReader(body)
	}
	req, err := c.newRequest(ctx, http.MethodPost, path, r)
	if err != nil {
		return 0, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.HTTP.Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return resp.StatusCode, b, nil
}

// CreateSession creates a new session (POST /session). The body is forwarded raw
// (e.g. {"parentID":...,"title":...} or {}); the response is OpenCode's Session
// JSON, from which the caller reads the new id.
func (c *Client) CreateSession(ctx context.Context, body json.RawMessage) (json.RawMessage, error) {
	if len(body) == 0 {
		body = json.RawMessage(`{}`)
	}
	st, b, err := c.postRaw(ctx, "/session", body)
	if err != nil {
		return nil, err
	}
	if st < 200 || st >= 300 {
		return nil, statusErr("POST /session", st, b)
	}
	return b, nil
}

// Prompt sends a message to a session via POST /session/:id/prompt_async, which
// forks the turn and returns at once (204) — so a coordinator's send never blocks
// on the turn. The body is forwarded raw ({parts, agent?, model?, variant?}).
func (c *Client) Prompt(ctx context.Context, sessionID string, body json.RawMessage) (json.RawMessage, error) {
	st, b, err := c.postRaw(ctx, "/session/"+sessionID+"/prompt_async", body)
	if err != nil {
		return nil, err
	}
	if st < 200 || st >= 300 {
		return nil, statusErr("POST /session/"+sessionID+"/prompt_async", st, b)
	}
	return b, nil
}

// Abort cancels a session's in-flight turn (POST /session/:id/abort). The
// resulting idle arrives asynchronously on the event stream, not from this call.
func (c *Client) Abort(ctx context.Context, sessionID string) error {
	st, b, err := c.postRaw(ctx, "/session/"+sessionID+"/abort", nil)
	if err != nil {
		return err
	}
	if st < 200 || st >= 300 {
		return statusErr("POST /session/"+sessionID+"/abort", st, b)
	}
	return nil
}

// AnswerQuestion replies to a pending question (POST /question/:id/reply). The
// body is forwarded raw ({"answers": [[...]]}).
func (c *Client) AnswerQuestion(ctx context.Context, questionID string, body json.RawMessage) error {
	st, b, err := c.postRaw(ctx, "/question/"+questionID+"/reply", body)
	if err != nil {
		return err
	}
	if st < 200 || st >= 300 {
		return statusErr("POST /question/"+questionID+"/reply", st, b)
	}
	return nil
}

// ReplyPermission replies to a pending permission (POST /permission/:id/reply
// with {"reply": "once"|"always"|"reject"}). It falls back to OpenCode's legacy
// session-scoped route ({"response": ...}) ONLY when the canonical route looks
// absent (transport error, or 404/405) and a sessionID is given — a meaningful
// 4xx from the canonical route (e.g. 400 bad reply, 404-as-already-cleared at the
// resource) is returned as-is, not swallowed by a retry.
func (c *Client) ReplyPermission(ctx context.Context, permissionID, sessionID, reply string) error {
	body, _ := json.Marshal(map[string]string{"reply": reply})
	st, b, err := c.postRaw(ctx, "/permission/"+permissionID+"/reply", body)
	if err == nil && st >= 200 && st < 300 {
		return nil
	}
	routeMissing := err != nil || st == 404 || st == 405
	if sessionID == "" || !routeMissing {
		if err != nil {
			return err
		}
		return statusErr("POST /permission/"+permissionID+"/reply", st, b)
	}
	// Legacy fallback (older server without the canonical route).
	legacy, _ := json.Marshal(map[string]string{"response": reply})
	st2, b2, err2 := c.postRaw(ctx, "/session/"+sessionID+"/permissions/"+permissionID, legacy)
	if err2 != nil {
		return err2
	}
	if st2 < 200 || st2 >= 300 {
		return statusErr("POST /session/"+sessionID+"/permissions/"+permissionID, st2, b2)
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

// MessagesTail returns the most recent `limit` messages of a session as raw JSON
// objects. It uses OpenCode's `?limit=N` query (sst/opencode MessageV2.page:
// orders by desc(time_created) then reverses → the N NEWEST messages, in
// chronological order within the page). A limit <= 0 requests the full list.
// Used by the aggregator during cold hydrate to seed the tree's per-agent chips
// (the agent lives on assistant messages as info.agent) without fetching every
// session's full history.
func (c *Client) MessagesTail(ctx context.Context, sessionID string, limit int) ([]json.RawMessage, error) {
	path := "/session/" + sessionID + "/message"
	if limit > 0 {
		path += "?limit=" + fmt.Sprintf("%d", limit)
	}
	var out []json.RawMessage
	if err := c.getJSON(ctx, path, &out); err != nil {
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

// idleTimeout is how long SubscribeEvents tolerates receiving NO data before
// declaring the OpenCode event stream dead-but-open (half-open TCP / stalled
// peer). OpenCode emits a `server.heartbeat` SSE data frame roughly every
// 10s (measured against a live `opencode serve`: server.connected followed
// by server.heartbeat every ~10.0s), so 45s comfortably spans ~4 missed
// heartbeats — long enough that a live-but-idle stream is never falsely
// dropped, short enough that a wedged connection is returned to the
// aggregator's reconnect loop in well under a minute.
//
// It is a package var purely so tests can shrink it for fast coverage; tests
// in this package do not run in parallel. TCP keepalive is already active via
// Go's default http transport (net.Dialer.KeepAlive 30s) as additional
// defense-in-depth for true peer death.
var idleTimeout = 45 * time.Second

// SubscribeEvents opens GET /event and invokes handler for each event until
// the context is cancelled, the stream ends, handler returns an error, or the
// stream goes idle for longer than idleTimeout. It does not reconnect — the
// caller (aggregator) owns the reconnect/re-hydrate loop, since OpenCode's
// stream has no replay.
//
// The blocking bufio read is run in a per-line goroutine and the main loop
// selects over {next line, ctx.Done, idle timer}. This makes a half-open
// connection — where ReadString would otherwise block forever and the old
// `select { case <-ctx.Done()... default: }` (which sat OUTSIDE the blocking
// read) never ran — interruptible, so a dead stream returns to the caller for
// reconnect instead of silently freezing live UI updates.
func (c *Client) SubscribeEvents(ctx context.Context, handler func(Event) error) error {
	req, err := c.newRequest(ctx, http.MethodGet, "/event", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "text/event-stream")

	// No client-level timeout for the streaming connection; a timeout here
	// would kill a healthy long-lived stream. Liveness is enforced by the
	// idle timer in the read loop below, not by the HTTP client.
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

	// A single line read result delivered from the reader goroutine.
	type readResult struct {
		line string
		err  error
	}

	for {
		// Run the blocking ReadString in a short-lived goroutine so the
		// select below can also react to ctx cancellation and the idle
		// timer. The goroutine performs exactly ONE read and sends the
		// result once into a buffered (cap 1) channel. When the main loop
		// returns (ctx cancel / idle / handler error) it closes resp.Body,
		// which unblocks the goroutine's in-flight ReadString (it returns
		// an error); the goroutine then sends into the cap-1 buffer and
		// exits. Because it sends at most once and the channel is buffered,
		// it can never block after the caller has stopped reading — no
		// goroutine leak.
		readc := make(chan readResult, 1)
		go func() {
			line, err := reader.ReadString('\n')
			readc <- readResult{line, err}
		}()

		// A fresh idle timer each iteration: it only fires if NO line
		// arrives within idleTimeout. Any received byte/frame — including
		// OpenCode's heartbeat data frames, or a `:` comment line — starts
		// a new iteration and thus a fresh timer, so a live-but-idle stream
		// is never falsely dropped.
		idleTimer := time.NewTimer(idleTimeout)

		var line string
		var readErr error
		select {
		case <-ctx.Done():
			idleTimer.Stop()
			// Closing the body unblocks the goroutine blocked in ReadString.
			_ = resp.Body.Close()
			return ctx.Err()
		case <-idleTimer.C:
			// No data for idleTimeout → the stream is dead-but-open. Close
			// the body (unblocks the reader goroutine) and surface a stall
			// error so the aggregator's reconnect+re-hydrate loop fires.
			_ = resp.Body.Close()
			return fmt.Errorf("subscribe /event: idle timeout (no data in %v)", idleTimeout)
		case r := <-readc:
			idleTimer.Stop()
			line, readErr = r.line, r.err
		}

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
		if readErr != nil {
			if readErr == io.EOF {
				_ = dispatch()
				return io.EOF
			}
			return readErr
		}
	}
}
