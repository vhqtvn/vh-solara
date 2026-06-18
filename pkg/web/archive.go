package web

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"time"
)

// Archiving uses OpenCode's NATIVE archive (PATCH /session/:id time.archived):
// it persists in OpenCode and is visible to every client. Archiving cascades to
// a session's subsessions; the browser lists archived sessions on demand from
// OpenCode (GET /session?archived=true).

// POST /vh/archive {sessionID} — archive a session and all its subsessions.
// POST /vh/unarchive {sessionID} — restore them.
func (s *Server) handleArchive(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	var body struct {
		SessionID string `json:"sessionID"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 8<<10) // a session id is tiny
	if json.NewDecoder(r.Body).Decode(&body) != nil || body.SessionID == "" {
		http.Error(w, "sessionID required", http.StatusBadRequest)
		return
	}
	dir := reqDir(r)
	agg := s.aggFor(dir)
	unarchive := r.URL.Path == "/vh/unarchive"

	var affected []string
	if unarchive {
		// Archived sessions aren't in the live store; compute the subtree from
		// OpenCode's archived list, then clear time.archived on each.
		ids, err := agg.Client().ListArchivedSessions(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		affected = archivedDescendants(ids, body.SessionID)
		for _, id := range affected {
			if err := agg.Client().SetArchived(r.Context(), id, nil); err != nil {
				http.Error(w, err.Error(), http.StatusBadGateway)
				return
			}
		}
		// Re-hydrate so the restored sessions re-enter the live tree.
		_ = agg.Rehydrate(r.Context())
	} else {
		// The subtree is live, so cascade is computed from the store.
		affected = agg.Store().Descendants(body.SessionID)
		ts := time.Now().UnixMilli()
		for _, id := range affected {
			if err := agg.Client().SetArchived(r.Context(), id, &ts); err != nil {
				http.Error(w, err.Error(), http.StatusBadGateway)
				return
			}
		}
		// Drop them from the live view immediately (clients prune via delete).
		agg.Store().RemoveSessions(affected)
	}
	writeJSONResp(w, map[string]any{"ok": true, "affected": affected})
}

// archivedDescendants returns id plus every session in the archived set
// transitively parented by it.
func archivedDescendants(sessions []json.RawMessage, id string) []string {
	children := map[string][]string{}
	known := map[string]bool{}
	for _, raw := range sessions {
		var env struct {
			ID       string `json:"id"`
			ParentID string `json:"parentID"`
		}
		if json.Unmarshal(raw, &env) != nil || env.ID == "" {
			continue
		}
		known[env.ID] = true
		if env.ParentID != "" {
			children[env.ParentID] = append(children[env.ParentID], env.ID)
		}
	}
	if !known[id] {
		return []string{id} // not in the archived list, but try the single id
	}
	out := []string{}
	stack := []string{id}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		out = append(out, cur)
		stack = append(stack, children[cur]...)
	}
	return out
}

// POST /vh/reload — rebuild the server's view from OpenCode (the source of
// truth) without restarting the process or the running OpenCode. Clients
// converge via the reconciled upsert/delete events.
func (s *Server) handleReload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := s.aggFor(reqDir(r)).Rehydrate(r.Context()); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSONResp(w, map[string]any{"ok": true})
}

// POST /vh/restart-server — restart the vh daemon itself (re-exec, or exit for a
// supervisor to relaunch). Responds first, then triggers the restart; the client
// reconnects automatically. OpenCode survives only in detached/external mode.
func (s *Server) handleRestartServer(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.restartServer == nil {
		http.Error(w, "server restart is not available here", http.StatusNotImplemented)
		return
	}
	writeJSONResp(w, map[string]any{"ok": true})
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	// Restart after the response is on the wire.
	go func() {
		time.Sleep(250 * time.Millisecond)
		s.restartServer()
	}()
}

// POST /vh/restart-opencode — restart the managed OpenCode process (interrupts
// any in-flight turn; sessions persist in OpenCode's store). The aggregator
// reconnects and re-hydrates automatically once OpenCode is back up.
func (s *Server) handleRestartOpenCode(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if s.restartOC == nil {
		http.Error(w, "OpenCode is not managed by this server", http.StatusNotImplemented)
		return
	}
	if err := s.restartOC(r.Context()); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeJSONResp(w, map[string]any{"ok": true})
}

// GET /vh/archived?parent=&offset=&limit= — one level of the archived tree,
// sourced live from OpenCode (GET /session?archived=true). Returns the sessions
// at that level plus child counts so the client can show expand affordances and
// page through without loading everything.
func (s *Server) handleArchived(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	parent := q.Get("parent")
	offset, _ := strconv.Atoi(q.Get("offset"))
	limit, _ := strconv.Atoi(q.Get("limit"))
	if limit <= 0 {
		limit = 50
	}
	sessions, err := s.aggFor(reqDir(r)).Client().ListArchivedSessions(r.Context())
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	items, total, counts := archivedLevel(sessions, parent, offset, limit)
	writeJSONResp(w, map[string]any{
		"sessions":    items,
		"childCounts": counts,
		"total":       total,
		"offset":      offset,
		"limit":       limit,
	})
}

// archivedLevel slices one level of the archived tree from a flat archived list:
// the children of `parent` (or the archived roots — whose parent is not itself
// archived — when parent is ""), newest first, paginated, plus the archived
// child counts for the returned sessions.
func archivedLevel(sessions []json.RawMessage, parent string, offset, limit int) ([]json.RawMessage, int, map[string]int) {
	type meta struct {
		id, parentID string
		updated      float64
		info         json.RawMessage
	}
	all := make([]meta, 0, len(sessions))
	archivedID := map[string]bool{}
	for _, raw := range sessions {
		var env struct {
			ID       string `json:"id"`
			ParentID string `json:"parentID"`
			Time     struct {
				Updated float64 `json:"updated"`
				Created float64 `json:"created"`
			} `json:"time"`
		}
		if json.Unmarshal(raw, &env) != nil || env.ID == "" {
			continue
		}
		archivedID[env.ID] = true
		u := env.Time.Updated
		if u == 0 {
			u = env.Time.Created
		}
		all = append(all, meta{id: env.ID, parentID: env.ParentID, updated: u, info: raw})
	}

	// Child counts (within the archived set) for every node.
	counts := map[string]int{}
	for _, m := range all {
		if m.parentID != "" && archivedID[m.parentID] {
			counts[m.parentID]++
		}
	}

	var level []meta
	for _, m := range all {
		isRoot := m.parentID == "" || !archivedID[m.parentID]
		if (parent == "" && isRoot) || (parent != "" && m.parentID == parent) {
			level = append(level, m)
		}
	}
	sort.Slice(level, func(a, b int) bool { return level[a].updated > level[b].updated })

	total := len(level)
	if offset > total {
		offset = total
	}
	end := total
	if limit > 0 && offset+limit < end {
		end = offset + limit
	}
	items := make([]json.RawMessage, 0, end-offset)
	levelCounts := map[string]int{}
	for _, m := range level[offset:end] {
		items = append(items, m.info)
		if c := counts[m.id]; c > 0 {
			levelCounts[m.id] = c
		}
	}
	return items, total, levelCounts
}
