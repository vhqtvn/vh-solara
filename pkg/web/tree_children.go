package web

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/vhqtvn/vh-solara/pkg/state"
)

// treeChildrenResponse is the node.children payload returned by the expand
// endpoint (§8). Mirrors the node.children delta-op data shape (§4) but as a
// standalone HTTP JSON response, NOT an SSE event.
type treeChildrenResponse struct {
	ParentID    string       `json:"parentId"`
	Nodes       []state.Node `json:"nodes"`
	HasMore     bool         `json:"hasMore"`
	Cursor      string       `json:"cursor,omitempty"`
	StaleCursor bool         `json:"staleCursor,omitempty"`
}

// handleTreeChildren implements GET /vh/tree/children (§8 expand protocol).
// It is the tree=2 counterpart of handleBranch (the proj=1 expand endpoint):
// stateless GET that reads the direct children of ?id=<parentId> from the
// project's store, honors ?cursor pagination, and returns a node.children JSON
// payload. On a terminal batch (hasMore:false) it adds parentId to the
// connection's E_c (§5.4) — the emitter tracks this internally. A stale cursor
// (child was reparented/deleted) returns an empty terminal batch with
// staleCursor:true so the client restarts from page 0 (§8.3). GET → no CSRF
// (mirrors handleBranch).
func (s *Server) handleTreeChildren(w http.ResponseWriter, r *http.Request) {
	id := r.URL.Query().Get("id")
	if id == "" {
		http.Error(w, "missing id", http.StatusBadRequest)
		return
	}
	agg := s.aggFor(reqDir(r))
	if agg == nil {
		http.Error(w, "project not found", http.StatusNotFound)
		return
	}
	cursor := r.URL.Query().Get("cursor")
	limitStr := r.URL.Query().Get("limit")
	limit := 0 // 0 → defaultTreeExpandLimit
	if limitStr != "" {
		if n, err := strconv.Atoi(limitStr); err == nil && n > 0 {
			limit = n
		}
	}
	// Phase 2a: the emitter is transient per-request (stateless, like
	// handleBranch calls SnapshotBranch). The per-connection E_c that survives
	// across requests lives in the handleStream per-conn state (Group 7 wiring).
	// For the contract, ExpandChildren on a transient emitter still computes the
	// correct page and MarkLoads on the terminal batch.
	emitter := state.NewTreeEmitter(agg.Store(), reqDir(r))
	nodes, hasMore, nextCursor, stale := emitter.ExpandChildren(id, cursor, limit)
	resp := treeChildrenResponse{
		ParentID:    id,
		Nodes:       nodes, // nil slice → JSON "null"; normalize to [] below
		HasMore:     hasMore,
		StaleCursor: stale,
	}
	if nextCursor != "" {
		resp.Cursor = nextCursor
	}
	b, err := json.Marshal(resp)
	if err != nil {
		http.Error(w, "tree children marshal failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	if nextCursor != "" {
		w.Header().Set("X-VH-Branch-Cursor", nextCursor)
	}
	w.Write(maybeCompressSnapshot(b, wantsCompress(r)))
}
