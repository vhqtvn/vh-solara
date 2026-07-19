package web

import (
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
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
		// Topology guard (runs BEFORE any DB open): direct-DB unarchive writes
		// to a PROCESS-LOCAL SQLite file. In the spawned/co-located topology
		// that file IS the running instance's DB (env inherited). In the
		// external topology (--opencode-url) the session ids come from a REMOTE
		// instance but the DB resolver targets a LOCAL file that may not match
		// — refuse fast unless the operator explicitly bound
		// VH_OPENCODE_DB_PATH. See docs/architecture/opencode-sqlite-unarchive.md.
		if err := opencode.UnarchiveGuard(s.externalOC); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		// Archived sessions aren't in the live store; compute the subtree from
		// OpenCode's archived list, then clear time_archived on each.
		//
		// Unarchive writes DIRECTLY to OpenCode's SQLite DB
		// (opencode.UnarchiveSessions) rather than going through the HTTP API:
		// OpenCode 1.17.x has no HTTP way to clear archived (PATCH with a JSON
		// null for time.archived is rejected with 400 — its request schema is
		// Schema.optional(Schema.Finite), which does not accept null). See
		// docs/architecture/opencode-sqlite-unarchive.md for the coupling
		// contract and the drift guard. Archiving (the else branch below) still
		// uses the working HTTP PATCH with a finite timestamp.
		ids, err := agg.Client().ListArchivedSessions(r.Context())
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		affected = archivedDescendants(ids, body.SessionID)
		if err := opencode.UnarchiveSessions(r.Context(), affected); err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		// Re-hydrate so the restored sessions re-enter the live tree. The direct
		// DB write emits no session.updated event, so the local store would
		// otherwise still consider these sessions archived until a refresh.
		_ = agg.Rehydrate(r.Context())
	} else {
		// The subtree is live, so cascade is computed from the store.
		affected = agg.Store().Descendants(body.SessionID)
		ts := time.Now().UnixMilli()
		for _, id := range affected {
			if err := agg.Client().SetArchived(r.Context(), id, ts); err != nil {
				http.Error(w, err.Error(), http.StatusBadGateway)
				return
			}
		}
		// Drop them from the live view immediately (clients prune via delete).
		agg.Store().RemoveSessions(affected)
		// Archive clears the queue: a successful archive deletes that session's
		// queue state (matches the prior FE-only behavior and the operator's
		// confirmed policy). Done AFTER the archive commits so a failed archive
		// never loses queued messages. Routed through the same CleanupSession
		// wrapper the session.delete subscriber uses (FIX-QUEUE-GC-2): archive
		// correctness must NOT depend on best-effort subscriber delivery, so the
		// direct call is retained here even though RemoveSessions above also
		// fires KindSessionDelete → subscriber → CleanupSession. The two calls
		// compose idempotently (the second is a no-op).
		root, err := projectRoot(dir)
		if err == nil {
			for _, id := range affected {
				s.queues.CleanupSession(root, safeID.ReplaceAllString(id, ""))
			}
		}
	}
	writeJSONResp(w, map[string]any{"ok": true, "affected": affected})
}

// archivedDescendants returns id plus every genuinely archived session
// transitively parented by it, so that re-clicking Restore (unarchive) on id
// retries any member of its subtree that is still archived — including the
// case where id itself already unarchived (a partial-batch failure can leave a
// child archived after its parent succeeded).
//
// The input list is OpenCode's archived-set response, but 1.17.x ignores
// ?archived=true and returns ALL sessions (archived + active). The subtree
// traversal is therefore built from ALL of them — so the parent→child link to
// a still-archived child survives even after the root leaves the archived set
// — and only the still-archived members (plus the root itself, as an idempotent
// no-op re-write) are collected for unarchive. A non-archived descendant is
// traversed (so a deeper archived member stays reachable) but is never folded
// into the result (it is already active). See the "Batch semantics" section of
// docs/architecture/opencode-sqlite-unarchive.md.
func archivedDescendants(sessions []json.RawMessage, id string) []string {
	// Build the parent→children map from ALL sessions (active + archived) so
	// the subtree stays reachable for retry even after the root unarchives — a
	// partial-batch failure can leave a child archived while its parent is
	// already active, and that child must remain reachable through it. Track
	// which members are genuinely archived so the collected set stays minimal.
	children := map[string][]string{}
	archived := map[string]bool{}
	for _, raw := range sessions {
		var env struct {
			ID       string `json:"id"`
			ParentID string `json:"parentID"`
			Time     struct {
				Archived *float64 `json:"archived"`
			} `json:"time"`
		}
		if json.Unmarshal(raw, &env) != nil || env.ID == "" {
			continue
		}
		if env.ParentID != "" {
			children[env.ParentID] = append(children[env.ParentID], env.ID)
		}
		// OpenCode 1.17.x ignores the ?archived=true param and returns ALL
		// sessions (archived + non-archived). Track only genuinely archived
		// members (time.archived set to a non-zero value) so non-archived
		// descendants are traversed but never collected. Mirrors
		// sessionEnvelope.archivedAt() in pkg/state/store.go.
		if env.Time.Archived != nil && *env.Time.Archived != 0 {
			archived[env.ID] = true
		}
	}
	// Walk the full subtree rooted at id. Collect id itself (an idempotent
	// no-op re-write if it is already active) plus every still-archived member.
	// This is what makes a retry complete the batch: a child left archived by a
	// partial failure remains reachable through its now-active parent. seen
	// guards against a revisit loop on malformed parent links.
	out := []string{}
	seen := map[string]bool{}
	stack := []string{id}
	for len(stack) > 0 {
		cur := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if seen[cur] {
			continue
		}
		seen[cur] = true
		if cur == id || archived[cur] {
			out = append(out, cur)
		}
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

// POST /vh/reload-project — evict ONE project's cached OpenCode instance and
// drop this daemon's aggregator for it, so the NEXT access rebuilds both fresh
// from disk (picking up config edits) WITHOUT the fleet-wide `opencode serve`
// restart and WITHOUT disturbing other projects (including the default). The
// user-facing label is "Reload project"; the upstream route this drives is
// POST /instance/dispose (see pkg/opencode Client.Dispose).
//
// Sequence:
//  1. Dispose the OpenCode instance cache for dir (in-flight turns finish on
//     the old instance; the next request rebuilds Config.node fresh).
//  2. For a NON-default dir (dir != ""): stop the per-dir permission-reconcile
//     sweep (stopPermissionWatcher), tear this daemon's aggregator down
//     (a.Stop cancels its Run + closes its store's SSE subscribers) and drop it
//     from s.aggs so the next aggFor builds a fresh one. Guarded against a
//     double-dispose race by re-checking s.aggs[dir]==a under aggMu.
//  3. For the DEFAULT dir (dir == ""): dispose only — the default aggregator is
//     process-lifetime (held by s.agg and started outside aggFor, so a.cancel is
//     nil); tearing it down would leave s.agg dangling. The default permission
//     sweep is likewise process-lifetime (never stopped by Reload). The OpenCode
//     instance rebuild still applies config edits on the next request.
func (s *Server) handleReloadProject(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	dir := reqDir(r)

	// Resolve the per-project client so Dispose carries the right
	// x-opencode-directory header. For a dir we already have an aggregator for,
	// reuse its client; otherwise build a throwaway client scoped to dir (the
	// default — dir == "" — falls back to OpenCode's process cwd). The default
	// aggregator is stored under both s.agg and s.aggs[""], so dir == "" resolves
	// to it directly.
	s.aggMu.Lock()
	a, ok := s.aggs[dir]
	s.aggMu.Unlock()
	var client *opencode.Client
	if ok {
		client = a.Client()
	} else {
		client = opencode.New(s.opencodeURL)
		client.Directory = dir
	}
	if err := client.Dispose(r.Context()); err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	// Teardown is for NON-default projects only (see method doc). For dir == ""
	// the default aggregator is process-lifetime and must stay.
	if dir != "" && ok {
		s.aggMu.Lock()
		// Re-check under the lock: a concurrent reload for the same dir may have
		// already swapped the aggregator (T1 deleted `a`, a later aggFor built
		// `a2` and armed ITS watcher). Only stop the watcher + Stop+delete the
		// exact aggregator we disposed, so a stale request never disarms a2's
		// freshly-armed sweep. stopPermissionWatcher nests watcherMu INSIDE
		// aggMu — the same order aggFor already establishes via its
		// ensurePermissionWatcher call.
		if cur := s.aggs[dir]; cur == a {
			s.stopPermissionWatcher(dir)
			a.Stop()
			delete(s.aggs, dir)
			// Reset queueGCOn so the next aggFor(dir) rebuilds the queue-GC
			// subscriber on the new aggregator's store. Lock order matches
			// stopPermissionWatcher: queueGCMu nested inside aggMu.
			s.queueGCMu.Lock()
			delete(s.queueGCOn, dir)
			s.queueGCMu.Unlock()
		}
		s.aggMu.Unlock()
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
				Updated  float64  `json:"updated"`
				Created  float64  `json:"created"`
				Archived *float64 `json:"archived"`
			} `json:"time"`
		}
		if json.Unmarshal(raw, &env) != nil || env.ID == "" {
			continue
		}
		// OpenCode 1.17.x ignores the ?archived=true param and returns ALL
		// sessions (archived + non-archived). Filter server-side here: only a
		// genuinely archived session (time.archived set to a non-zero value)
		// belongs in the browser. Mirrors sessionEnvelope.archivedAt() in
		// pkg/state/store.go.
		if env.Time.Archived == nil || *env.Time.Archived == 0 {
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
