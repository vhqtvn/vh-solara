package web

// Point endpoints for server-authoritative derived session state (P4 + P5 of
// the FE-derived-state remediation). These replace FE resident-map walks that
// re-derived affected/descendant sets + subtree todo rollups from the resident
// tree map — which were incomplete whenever descendants weren't loaded into the
// SPA store (collapsed frontier, not-yet-expanded roots, pruned subtrees).
//
// The server is authoritative for session topology + todos (it holds the full
// live tree from the OpenCode aggregator). Per decisions.md Q3, lists / totals
// / history that don't belong on the live stream are exposed as revisioned
// POINT endpoints (GET on demand) rather than as live facets: a fetch is a
// deliberate user action (open the archive-confirm dialog, open the todo rollup
// view) and the cost of carrying the full set on every stream tick is not worth
// it for an occasionally-read aggregate.
//
// Envelope (Q3): every response is wrapped in revisionedEnvelope carrying the
// Store's epoch + revision captured atomically with the data. revision is
// advisory — for stale-response suppression, cache validation, and diagnostics.
// It is NOT required to equal the latest live tree revision by the time the
// client reads it; the client MAY suppress a response whose revision is older
// than a cursor it already holds, but MUST NOT reject one merely because a newer
// revision exists.
//
// stampMeta middleware (server.go) additionally stamps X-VH-Epoch + X-VH-Seq
// headers on every /vh/* response — the body envelope carries the same values
// for clients that consume the body alone.
//
// All routes are GET-only → csrfGuard exempts them (CSRF defense applies to
// unsafe methods). Project is resolved via ?dir= / x-opencode-directory
// (reqDir → aggFor), the same as every other /vh/* handler. The session id is
// sanitized with safeID before store use (same as messages + queue).

import (
	"encoding/json"
	"net/http"

	"github.com/vhqtvn/vh-solara/pkg/state"
)

// revisionedEnvelope is the Q3 point-endpoint response wrapper. epoch/revision
// come from the Store at query time (captured under the same lock as the data
// by the Store method that produced Data, so the pair is a coherent bound).
// Generic so each endpoint wires its own Data shape without a second wrapper.
type revisionedEnvelope[T any] struct {
	Epoch    string `json:"epoch"`
	Revision uint64 `json:"revision"`
	Data     T      `json:"data"`
}

// GET /vh/session/{sessionId}/descendants — server-authoritative descendant
// list for the archive-impact preview (P4). Replaces the FE resident-map walk
// (SessionContextMenu.relatedSessions), which walked the resident tree map +
// childrenIndex and omitted unloaded descendants of collapsed frontier nodes.
//
// The server walks the authoritative topology (Store.sessions →
// descendantsLocked) and returns id + title + parentID per descendant. The
// first element (if any) is always the requested id itself (the affected root);
// the FE confirm dialog uses index 0 as the "root" of the affected set.
//
// Unknown id → 200 with an empty descendants list (NOT a 404): the endpoint is
// a point read against live state, and a not-yet-hydrated or just-pruned id is
// a normal transient, not an error. The archive mutation handler already
// tolerates an empty affected set.
func (s *Server) handleSessionDescendants(w http.ResponseWriter, r *http.Request) {
	sid := safeID.ReplaceAllString(r.PathValue("sessionId"), "")
	if sid == "" {
		http.Error(w, "session required", http.StatusBadRequest)
		return
	}
	st := s.aggFor(reqDir(r)).Store()
	descs, epoch, seq := st.DescendantSummaries(sid)
	if descs == nil {
		descs = []state.SessionSummary{}
	}
	writeJSONResp(w, revisionedEnvelope[descendantsData]{
		Epoch:    epoch,
		Revision: seq,
		Data: descendantsData{
			SessionID:   sid,
			Descendants: descs,
		},
	})
}

// descendantsData is the `data` payload of GET /vh/session/:id/descendants.
type descendantsData struct {
	SessionID   string                 `json:"sessionId"`
	Descendants []state.SessionSummary `json:"descendants"`
}

// GET /vh/session/{sessionId}/subtree-todos — server-authoritative subtree todo
// rollup (P5). Replaces the FE resident-map walk (selectors.sessionTodos /
// sessionTodoCounts), which walked the resident tree map + childrenIndex and
// omitted unloaded descendants of collapsed frontier nodes.
//
// The server walks the authoritative topology (Store.descendantsLocked) and
// rolls up the per-session todos (s.todos) in subtree order, computing the
// active/left/total summary. Items are raw JSON passthrough (the exact OpenCode
// todo payload — content/status/priority/…); totals are computed by reading
// each item's status. Mirrors the FE rollup semantics exactly.
//
// Unknown id → 200 with empty items + zero totals (NOT a 404): same wire
// contract as the descendants endpoint (a not-yet-hydrated or just-pruned id is
// a normal transient, not an error). See handleSessionDescendants above for the
// full rationale.
func (s *Server) handleSubtreeTodos(w http.ResponseWriter, r *http.Request) {
	sid := safeID.ReplaceAllString(r.PathValue("sessionId"), "")
	if sid == "" {
		http.Error(w, "session required", http.StatusBadRequest)
		return
	}
	st := s.aggFor(reqDir(r)).Store()
	items, totals, epoch, seq := st.SubtreeTodos(sid)
	if items == nil {
		items = []json.RawMessage{}
	}
	writeJSONResp(w, revisionedEnvelope[subtreeTodosData]{
		Epoch:    epoch,
		Revision: seq,
		Data: subtreeTodosData{
			SessionID: sid,
			Items:     items,
			Totals:    totals,
		},
	})
}

// subtreeTodosData is the `data` payload of GET /vh/session/:id/subtree-todos.
// Items is always non-nil (at least []). Each item is the raw OpenCode todo
// payload (content/status/priority/…), untouched by the server. Totals is the
// server-computed active/left/total summary.
type subtreeTodosData struct {
	SessionID string            `json:"sessionId"`
	Items     []json.RawMessage `json:"items"`
	Totals    state.TodoTotals  `json:"totals"`
}
