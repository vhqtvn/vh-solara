package web

import (
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
)

// This file holds the programmatic READ verbs that enumerate the full session
// fleet and read closeout (last assistant message) text on demand, so a
// consumer never needs to touch opencode's private SQLite. They reuse the
// opencode client data paths that already exist (ListSessions /
// ListArchivedSessions / Messages) and shape the raw JSON into a stable,
// vh-solara-owned schema — decoupling consumers from opencode's internal
// schema. Empty/absent is never an error: unknown dir or empty fleet returns
// 200 with an empty payload; only a genuine transport failure (opencode
// unreachable) is a 5xx, mirroring archive.go.
//
// NOTE on /vh/sessions vs /vh/archived: both read archived sessions, but they
// serve different consumers. /vh/sessions is a FLAT fleet INVENTORY for
// programmatic consumers (machine-readable shaped schema, server-side active/
// archived/recency/roots filtering). /vh/archived is a paginated archived-TREE
// BROWSER for the SPA (one level at a time, child counts, raw passthrough).
// Keep both.

// sessionInventoryTime is the nested time object on a session inventory item.
// Fields mirror opencode's emitted shape (updated/created/archived ms epochs).
// All three keys are always present; archived is null when the session is
// active (not archived).
type sessionInventoryTime struct {
	Updated  *float64 `json:"updated"`
	Created  *float64 `json:"created"`
	Archived *float64 `json:"archived"`
}

// sessionInventoryItem is one row of the flat fleet inventory. Shaped (not raw
// passthrough) so consumers are insulated from opencode's internal schema.
type sessionInventoryItem struct {
	ID       string               `json:"id"`
	Alias    string               `json:"alias"`    // opencode session slug/share if exposed, else "" (see TODO in shapeSessions)
	Title    string               `json:"title"`    // opencode session title, else ""
	Dir      string               `json:"dir"`      // the project directory this inventory was read for
	Active   bool                 `json:"active"`   // true iff time.archived is null/0
	ParentID *string              `json:"parentID"` // null for roots; string for children
	Time     sessionInventoryTime `json:"time"`
}

// sessionInventoryResp is the GET /vh/sessions body.
type sessionInventoryResp struct {
	Dir      string                 `json:"dir"`
	Sessions []sessionInventoryItem `json:"sessions"`
}

// sessionCloseout is one entry in the closeout map.
//
// Semantics (see handleSessionsCloseout):
//   - Present=true, Text points at the (possibly empty) full text → readable
//     assistant message; "" means it exists but has no text parts.
//   - Present=false, Text=nil (→ JSON null) → no readable assistant message,
//     unreadable, or unknown id.
//
// The text is NEVER truncated (HR1): the full last assistant message text is
// returned. If a future hard server-side limit is ever introduced, it must be
// surfaced here as an explicit `truncated` flag + documented max-length, never
// a silent cut.
type sessionCloseout struct {
	Present bool    `json:"present"`
	Text    *string `json:"text"` // null iff !Present
}

// sessionsCloseoutResp is the GET /vh/sessions/closeout body.
type sessionsCloseoutResp struct {
	Dir       string                     `json:"dir"`
	Closeouts map[string]sessionCloseout `json:"closeouts"`
}

// GET /vh/sessions — flat session-fleet inventory for programmatic consumers.
//
// Wraps agg.Client().ListSessions (and ListArchivedSessions when
// include_archived=1) and shapes the raw opencode JSON into a stable schema.
// Server-side filters: active/archived (include_archived), recency (since, ms
// epoch — drops sessions whose latest of updated/created is older), and roots
// (roots_only, default 1 — top-level sessions only).
//
// `dir` is required (?dir= or x-opencode-directory header); absent/empty is a
// 400 because ?dir is the project pin (consistent with the rest of /vh/*).
//
// Order: by time.updated DESC, falling back to time.created DESC, then id DESC.
//
// Empty fleet / unknown dir → 200 with sessions:[]. A transport failure
// reaching opencode → 502 (mirrors archive.go).
func (s *Server) handleSessions(w http.ResponseWriter, r *http.Request) {
	dir := reqDir(r)
	if dir == "" {
		http.Error(w, "dir required (?dir= or x-opencode-directory header)", http.StatusBadRequest)
		return
	}
	q := r.URL.Query()
	includeArchived := q.Get("include_archived") == "1"
	rootsOnly := q.Get("roots_only") != "0" // default 1: roots only
	var since float64
	sinceSet := false
	if raw := q.Get("since"); raw != "" {
		if v, err := strconv.ParseFloat(raw, 64); err == nil {
			since, sinceSet = v, true
		}
		// A malformed `since` is ignored (no recency bound) rather than 400 —
		// lenient, consistent with archive.go's offset/limit parsing.
	}

	agg := s.aggFor(dir)
	ctx := r.Context()

	raw, err := agg.Client().ListSessions(ctx)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if includeArchived {
		arch, err := agg.Client().ListArchivedSessions(ctx)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		raw = mergeSessionsDedup(raw, arch)
	}

	items := shapeSessions(raw, dir, includeArchived, rootsOnly, since, sinceSet)
	if items == nil {
		items = []sessionInventoryItem{}
	}
	writeJSONResp(w, sessionInventoryResp{Dir: dir, Sessions: items})
}

// GET /vh/sessions/closeout — the full text of each requested session's LAST
// assistant message, batched over ids (one request instead of N client
// round-trips; per-id Messages calls are still issued internally).
//
// `dir` is required (same fail-closed as /vh/sessions). `id` is one or more
// session ids, accepting BOTH repeatable (?id=a&id=b) and comma-list
// (?id=a,b); forms may be mixed.
//
// For each id: fetch Messages, find the LAST assistant message (info.role ==
// "assistant"; latest by time.created, breaking ties by id DESC), and
// concatenate its text parts (type == "text", in part order) into one string.
// The text is NEVER truncated (HR1).
//
// Every requested id appears as a key:
//   - present:true,  text:"<...>" — readable assistant message with text.
//   - present:true,  text:""      — readable assistant message, no text parts.
//   - present:false, text:null    — no readable assistant message / unreadable
//     / unknown id.
//
// Per-id failures (unknown id, unreadable) map to present:false — a batch is
// never failed wholesale for one id's absence (never 5xx for absence). Unknown
// dir → all requested ids map to present:false.
func (s *Server) handleSessionsCloseout(w http.ResponseWriter, r *http.Request) {
	dir := reqDir(r)
	if dir == "" {
		http.Error(w, "dir required (?dir= or x-opencode-directory header)", http.StatusBadRequest)
		return
	}
	ids := parseSessionIDs(r.URL.Query())
	agg := s.aggFor(dir)
	ctx := r.Context()

	closeouts := make(map[string]sessionCloseout, len(ids))
	for _, id := range ids {
		// Project-isolation guard: a request from project B carrying a session
		// id that belongs to project A must NOT trigger an upstream Messages
		// fetch (OpenCode's /session/<id>/message endpoint is project-blind).
		// Silent-drop: foreign id → present:false (indistinguishable from an
		// unknown id), no 400, no upstream GET. Mirrors projectScopedFilter on
		// the snapshot/stream path. ShouldServeSession encapsulates the
		// armed-gate (production enforces HasSession; bare-test aggregators
		// permit any id — see its doc comment) so this guard stays compatible
		// with the hermetic closeout tests that exercise Client() directly on
		// an unseeded store.
		if !agg.ShouldServeSession(id) {
			closeouts[id] = sessionCloseout{Present: false, Text: nil}
			continue
		}
		present := false
		var text string
		if items, err := agg.Client().Messages(ctx, id); err == nil {
			present, text = lastAssistantText(items)
		}
		// present==false (no assistant message, unreadable, or a Messages
		// error) → Text stays nil → JSON null.
		var textPtr *string
		if present {
			textPtr = &text
		}
		closeouts[id] = sessionCloseout{Present: present, Text: textPtr}
	}
	writeJSONResp(w, sessionsCloseoutResp{Dir: dir, Closeouts: closeouts})
}

// parseSessionIDs parses the `id` query param into a deduped, order-preserving
// list of ids. Accepts BOTH repeatable values (?id=a&id=b) AND comma-lists
// (?id=a,b); forms may be mixed (?id=a,b&id=c). Empty/whitespace entries are
// dropped.
func parseSessionIDs(q url.Values) []string {
	seen := map[string]bool{}
	var out []string
	for _, field := range q["id"] {
		for _, id := range strings.Split(field, ",") {
			id = strings.TrimSpace(id)
			if id != "" && !seen[id] {
				seen[id] = true
				out = append(out, id)
			}
		}
	}
	return out
}

// mergeSessionsDedup merges two raw session lists, deduping by id and keeping
// the first occurrence (active list first, so an active copy wins a duplicate).
// Sessions without an id are dropped (unparseable / malformed).
func mergeSessionsDedup(a, b []json.RawMessage) []json.RawMessage {
	seen := map[string]bool{}
	out := make([]json.RawMessage, 0, len(a)+len(b))
	add := func(raw json.RawMessage) {
		var env struct {
			ID string `json:"id"`
		}
		if json.Unmarshal(raw, &env) != nil || env.ID == "" {
			return
		}
		if seen[env.ID] {
			return
		}
		seen[env.ID] = true
		out = append(out, raw)
	}
	for _, raw := range a {
		add(raw)
	}
	for _, raw := range b {
		add(raw)
	}
	return out
}

// shapeSessions parses raw opencode session JSON, applies the active/archived,
// recency, and roots filters, shapes each into a sessionInventoryItem, and
// orders the result by time.updated DESC (→ created DESC → id DESC).
func shapeSessions(raw []json.RawMessage, dir string, includeArchived, rootsOnly bool, since float64, sinceSet bool) []sessionInventoryItem {
	type row struct {
		item    sessionInventoryItem
		updated float64
		created float64
	}
	out := make([]row, 0, len(raw))
	for _, r := range raw {
		var env struct {
			ID       string `json:"id"`
			ParentID string `json:"parentID"`
			Title    string `json:"title"`
			Time     struct {
				Updated  *float64 `json:"updated"`
				Created  *float64 `json:"created"`
				Archived *float64 `json:"archived"`
			} `json:"time"`
		}
		if json.Unmarshal(r, &env) != nil || env.ID == "" {
			continue
		}
		archived := env.Time.Archived != nil && *env.Time.Archived != 0
		if !includeArchived && archived {
			continue // active-only filter
		}
		if rootsOnly && env.ParentID != "" {
			continue // roots-only filter
		}
		updated := 0.0
		if env.Time.Updated != nil {
			updated = *env.Time.Updated
		}
		created := 0.0
		if env.Time.Created != nil {
			created = *env.Time.Created
		}
		latest := updated
		if created > latest {
			latest = created
		}
		if sinceSet && latest < since {
			continue // recency filter
		}
		item := sessionInventoryItem{
			ID:     env.ID,
			Alias:  "", // TODO(alias): no opencode session slug/share field is reliably present in the pinned version's session JSON (checked: pkg/fixtures, pkg/state/store.go sessionEnvelope, pkg/web/archive.go). Default "" until one is confirmed; map it here when exposed.
			Title:  env.Title,
			Dir:    dir,
			Active: !archived,
			Time: sessionInventoryTime{
				Updated:  env.Time.Updated,
				Created:  env.Time.Created,
				Archived: env.Time.Archived,
			},
		}
		if env.ParentID != "" {
			p := env.ParentID
			item.ParentID = &p
		}
		out = append(out, row{item: item, updated: updated, created: created})
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].updated != out[j].updated {
			return out[i].updated > out[j].updated
		}
		if out[i].created != out[j].created {
			return out[i].created > out[j].created
		}
		return out[i].item.ID > out[j].item.ID
	})
	items := make([]sessionInventoryItem, len(out))
	for i, o := range out {
		items[i] = o.item
	}
	return items
}

// lastAssistantText finds the LAST assistant message in a raw Messages list and
// returns its concatenated text-part text.
//
// "Last" = the assistant message (info.role == "assistant") with the highest
// time.created, breaking ties by id DESC. Text parts (type == "text") are
// concatenated in part order. The full text is returned (never truncated —
// HR1).
//
// Returns (present, text):
//   - (false, "") — no assistant message, or the chosen one was unreadable.
//   - (true, "")  — an assistant message exists but has no text parts.
//   - (true, s)   — an assistant message exists with concatenated text s.
func lastAssistantText(items []json.RawMessage) (present bool, text string) {
	type info struct {
		ID   string `json:"id"`
		Role string `json:"role"`
		Time struct {
			Created *float64 `json:"created"`
		} `json:"time"`
	}
	bestIdx := -1
	var bestCreated float64
	var bestID string
	for i, it := range items {
		var m struct {
			Info info `json:"info"`
		}
		if json.Unmarshal(it, &m) != nil {
			continue
		}
		if m.Info.Role != "assistant" {
			continue
		}
		c := 0.0
		if m.Info.Time.Created != nil {
			c = *m.Info.Time.Created
		}
		if bestIdx < 0 || c > bestCreated || (c == bestCreated && m.Info.ID > bestID) {
			bestIdx, bestCreated, bestID = i, c, m.Info.ID
		}
	}
	if bestIdx < 0 {
		return false, ""
	}
	var chosen struct {
		Parts []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"parts"`
	}
	if json.Unmarshal(items[bestIdx], &chosen) != nil {
		return false, "" // unreadable
	}
	var sb strings.Builder
	for _, p := range chosen.Parts {
		if p.Type == "text" {
			sb.WriteString(p.Text)
		}
	}
	return true, sb.String()
}
