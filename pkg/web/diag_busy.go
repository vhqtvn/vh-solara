package web

import (
	"net/http"
	"sort"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// handleDiagBusy is the read-only busy-indexes diagnostic
// (GET /vh/diag/busy). It dumps, per workspace, the derived running-root count
// (Store.RunningRoots, the /vh/running-sessions source), the live root count,
// the set of busy root ids, and every live session's activity + subtreeBusy
// contribution — so a phantom "running" count is one-query-diagnosable instead
// of needing a three-endpoint cross-check.
//
// Auth/CSRF discipline mirrors /vh/diag/latency: GET-only, auth-gated under the
// /vh/* mux (no per-handler CSRF check needed — CSRF defense applies to unsafe
// methods only). Emits ONLY ids, parent links, activity labels, and integer
// busy aggregates — no transcript/session-body/URL data.
//
// Single source of truth: RunningRoots now derives from subtreeBusyCount, so
// the running count and the per-root subtreeBusy aggregate cannot diverge.
// This snapshot surfaces both plus the per-session activity that backs them,
// so any future drift (or a stale activity strand the completion-grace window
// has not yet cleared) is visible as a mismatch in a single response.
type diagBusyWorkspace struct {
	Dir          string                `json:"dir"`
	RunningRoots int                   `json:"runningRoots"`
	RootCount    int                   `json:"rootCount"`
	BusyRootIDs  []string              `json:"busyRootIds"`
	Sessions     []busyDiagSessionJSON `json:"sessions"`
}

// busyDiagSessionJSON mirrors state.BusyDiagSession but lives in the web
// package so the handler does not import the state struct directly into its
// response shape (keeps the JSON contract explicit at the boundary).
type busyDiagSessionJSON struct {
	ID          string `json:"id"`
	ParentID    string `json:"parentID,omitempty"`
	IsRoot      bool   `json:"isRoot"`
	Activity    string `json:"activity"`
	SubtreeBusy int    `json:"subtreeBusy"`
}

type diagBusyResp struct {
	RunningRoots int                 `json:"runningRoots"` // fleet-wide sum across workspaces
	RootCount    int                 `json:"rootCount"`    // fleet-wide sum
	Workspaces   []diagBusyWorkspace `json:"workspaces"`
}

func (s *Server) handleDiagBusy(w http.ResponseWriter, r *http.Request) {
	// GET-only (defense in depth): the route is read-only; csrfGuard already
	// stops unsafe methods without X-VH-CSRF, and this guard stops them WITH it
	// (mirrors diag.Handler's own method guard). RFC 7231: a 405 response
	// SHOULD include an Allow header naming the supported methods.
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Snapshot the aggregator set under aggMu (mirrors handleProjects /
	// handleRunningSessions), then read each store outside the lock.
	s.aggMu.Lock()
	type entry struct {
		dir string
		agg *aggregator.Aggregator
	}
	live := make([]entry, 0, len(s.aggs))
	for dir, a := range s.aggs {
		live = append(live, entry{dir, a})
	}
	s.aggMu.Unlock()

	resp := diagBusyResp{Workspaces: []diagBusyWorkspace{}}
	for _, e := range live {
		snap := e.agg.Store().BusyDiag()
		sessions := make([]busyDiagSessionJSON, len(snap.Sessions))
		for i, ds := range snap.Sessions {
			sessions[i] = busyDiagSessionJSON{
				ID:          ds.ID,
				ParentID:    ds.ParentID,
				IsRoot:      ds.IsRoot,
				Activity:    ds.Activity,
				SubtreeBusy: ds.SubtreeBusy,
			}
		}
		resp.RunningRoots += snap.RunningRoots
		resp.RootCount += snap.RootCount
		resp.Workspaces = append(resp.Workspaces, diagBusyWorkspace{
			Dir:          e.dir,
			RunningRoots: snap.RunningRoots,
			RootCount:    snap.RootCount,
			BusyRootIDs:  snap.BusyRootIDs,
			Sessions:     sessions,
		})
	}
	sort.Slice(resp.Workspaces, func(i, j int) bool { return resp.Workspaces[i].Dir < resp.Workspaces[j].Dir })
	// State-like GET: computed fresh from live state on every call; a cached
	// response would defeat diagnosis of a transient phantom.
	w.Header().Set("Cache-Control", "no-store")
	writeJSONResp(w, resp)
}
