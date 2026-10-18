package web

// Fleet-summary HTTP endpoints, moved verbatim from server.go (slice 3 of the
// server.go split): GET /vh/projects (per-directory project discovery:
// projectInfo + handleProjects), GET /vh/gates (the lean fleet-rollup gate
// acquisition endpoint: maxFleetGatesRequestDirs + fleetGatesProject +
// handleFleetGates), and GET /vh/running-sessions (the cross-workspace
// running aggregate: runningWorkspaceInfo + runningSessionsResp +
// handleRunningSessions). Routes are registered in server.go (Handler); the
// aggregator map under aggMu and the snapshot compression helpers
// (maybeCompressSnapshot) stay in server.go — this file only calls them.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/state"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// projectInfo describes one bridged project instance (a per-directory aggregator)
// for the discovery endpoint.
type projectInfo struct {
	Dir     string `json:"dir"`     // project directory ("" = the worker's default project)
	Epoch   string `json:"epoch"`   // store lifetime id (changes on daemon restart)
	Seq     uint64 `json:"seq"`     // current head seq for this project's store
	Roots   int    `json:"roots"`   // live ROOT session count (children/archived excluded)
	Running int    `json:"running"` // running ROOT count (roots whose subtree has ≥1 busy/retry session)
	// RunningRoots is the alias of Running (Posture B alias-during-transition).
	// Same value — the count of running ROOTS specifically (a cardinality +
	// topology correction: `running` alone is ambiguous with a session/process
	// count). Dual-emitted alongside running so the SPA migrates to the exact
	// name while a stale/un-reloaded tab keeps reading the old one. Removal of
	// `running` is gated on an operator-approved cutoff; see
	// docs/ai/wire-field-deprecation.md (audit L-10 / remediation M13).
	RunningRoots int `json:"runningRoots"`
	// UnreadRoots is the count of live ROOTS currently finished-unread (an
	// operator hasn't acknowledged them yet). unread ⊆ idle by invariant, so
	// this is a subset of (roots − running) — the switcher renders it as
	// "N idle (M unread)". Server-authoritative and already synced between
	// clients via unread.set/unread.clear events + the snapshot's GLOBAL Unread
	// field; this endpoint merely surfaces the per-project cardinality.
	UnreadRoots int `json:"unreadRoots"`
}

// handleProjects lists the project instances this worker currently bridges — one
// per directory (default "" plus any ?dir= touched). Machine-readable so a client
// over the socket can discover which projects are live and their (epoch, seq)
// before pinning a watch loop. A logical session is owned by exactly one project:
// the dir it was created under. Pass that same ?dir= (or x-opencode-directory
// header) on EVERY verb so spawn → snapshot → stream → abort/archive route to it.
func (s *Server) handleProjects(w http.ResponseWriter, r *http.Request) {
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

	out := make([]projectInfo, 0, len(live))
	for _, e := range live {
		st := e.agg.Store()
		// roots/running/unread are the THREE contract-coupled counts behind the
		// unread ⊆ idle wire invariant (idle = roots − running must bound
		// unreadRoots on every response). They MUST come from a SINGLE locked
		// accessor (Store.ProjectCounts) so a busy↔idle writer cannot interleave
		// between the reads and surface unread > (roots − running). The two wire
		// aliases `running`/`runningRoots` (alias-during-transition, L-10) carry
		// the same value because both are assigned from this one triple.
		// Epoch()/Head() are metadata that do NOT participate in the invariant,
		// so they stay as separate reads — the lock is not broadened for them.
		roots, running, unread := st.ProjectCounts()
		out = append(out, projectInfo{
			Dir:          e.dir,
			Epoch:        st.Epoch(),
			Seq:          st.Head(),
			Roots:        roots,
			Running:      running,
			RunningRoots: running,
			UnreadRoots:  unread,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Dir < out[j].Dir })
	// State-like GET: the response is computed fresh on every call from live
	// aggregator state (root count, head seq, epoch) — a stale browser/intermediary
	// cache hit would defeat the entire point of the endpoint (cross-project
	// discovery + counts). Mark it uncachable so a dialog re-open never paints
	// pre-change counts. (Client fetches also pass cache:'no-store' as a belt-
	// and-suspenders guard against intermediaries that ignore Cache-Control.)
	w.Header().Set("Cache-Control", "no-store")
	writeJSONResp(w, out)
}

// maxFleetGatesRequestDirs bounds how many explicit ?dir= params one
// GET /vh/gates request may carry. It mirrors the fleet rollup's per-worker
// project cap (64) with generous headroom for a raised operator override;
// beyond it the request is rejected politely (400) and the controller falls
// back to its per-project snapshot path. The bound keeps a hostile client
// from making ONE request fan out gate materialization across an unbounded
// dir list.
const maxFleetGatesRequestDirs = 256

// fleetGatesProject is one entry of the GET /vh/gates response: exactly the
// dir + gate pair the controller's rollup folds (it reads nothing else from
// a snapshot).
type fleetGatesProject struct {
	Dir  string                     `json:"dir"`
	Gate map[string]state.GateFacts `json:"gate"`
}

// handleFleetGates serves GET /vh/gates — the LEAN fleet-rollup acquisition
// endpoint. The controller's GET /vh/fleet/status rollup consumes only the
// per-project `gate` map; fetching a full /vh/snapshot per project moves the
// whole session tree (sessions/messages/agent rows the rollup never reads —
// measured ~5.9 MB raw across 7 real projects) over the WAN tunnel, which
// blew the per-worker time budget (observed bason: timeout at 2/7 projects
// on an ~83 ms RTT link). This endpoint returns, for the REQUESTED dirs
// (repeated ?dir= query params; no params = every live project), exactly
// {schema:1, fleet_selection:"root_unarchived_v1", projects:[{dir, gate}]}
// marshaled from the store's lean GateFactsFleetSelected() accessor — no
// snapshot marshaling of sessions at all.
//
// SELECTED-ONLY population (gauge-semantics slice): the gate map carries
// ONLY the fleet watch's selected sessions — effective root+unarchived (see
// state.Store.GateFactsFleetSelected). Subagent children and archived
// sessions never cross the tunnel on this path; each selected root still
// carries its subtree-aggregated pending counts (subtree_pending_permission
// / question / input) so a descendant's wait surfaces on its root, the
// subtree activity counts (subtree_error/subtree_retry), and the
// root-scoped finished-unread flag (`unread`, a presence-aware pointer —
// the same signal POST /vh/ack clears). The
// fleet_selection marker asserts the entries speak that vocabulary. A full
// /vh/snapshot stays COMPLETE (children present, fleet_selected=false) — the
// controller filters snapshot-derived gates by fleet_selected identically.
//
// Contract:
//   - GET only (405 otherwise); auth-gated like every other /vh/* route
//     (Auth.Middleware wraps the whole mux — same session-cookie family as
//     /vh/projects and /vh/snapshot).
//   - Explicit dirs: an entry is returned ONLY for dirs with a LIVE
//     aggregator (aggForExisting semantics — this handler never OPENS a
//     project, fires managed hooks, or grows the aggregator map). A
//     requested dir absent from the response means "not instantiated"; the
//     controller treats discovery-just-saw-it omissions as an empty
//     observation (the same value /vh/snapshot would have returned by
//     instantiating an empty aggregator — parity, without the side effect).
//   - More than maxFleetGatesRequestDirs dirs → 400 naming the cap.
//   - `z=1` opts into the same gzip64 envelope as /vh/snapshot
//     (maybeCompressSnapshot + the 2 KiB threshold): the gate JSON of a
//     real fleet is highly repetitive and compresses ~10:1.
func (s *Server) handleFleetGates(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	dirs := r.URL.Query()["dir"]
	if len(dirs) > maxFleetGatesRequestDirs {
		http.Error(w, fmt.Sprintf("too many dir params: %d > %d cap", len(dirs), maxFleetGatesRequestDirs), http.StatusBadRequest)
		return
	}

	// Snapshot the live aggregator set under aggMu, then materialize gates
	// OUTSIDE the lock (each Store.GateFacts takes its own RLock — no nested
	// locking with aggMu). aggForExisting semantics: existing aggregators
	// only, never created.
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
	byDir := make(map[string]*aggregator.Aggregator, len(live))
	for _, e := range live {
		byDir[e.dir] = e.agg
	}

	var want []string
	if len(dirs) == 0 {
		// No dir params: every live project (the worker decides scope).
		want = make([]string, 0, len(live))
		for _, e := range live {
			want = append(want, e.dir)
		}
	} else {
		// Dedupe preserving first occurrence (discovery output is unique;
		// defensive only).
		seen := make(map[string]bool, len(dirs))
		want = make([]string, 0, len(dirs))
		for _, d := range dirs {
			if seen[d] {
				continue
			}
			seen[d] = true
			want = append(want, d)
		}
	}

	out := make([]fleetGatesProject, 0, len(want))
	for _, d := range want {
		a := byDir[d]
		if a == nil {
			continue // not instantiated: omitted, never fabricated
		}
		out = append(out, fleetGatesProject{Dir: d, Gate: a.Store().GateFactsFleetSelected()})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Dir < out[j].Dir })
	b, err := json.Marshal(struct {
		Schema         int                 `json:"schema"`
		FleetSelection string              `json:"fleet_selection"`
		Projects       []fleetGatesProject `json:"projects"`
	}{Schema: 1, FleetSelection: state.FleetSelectionRootUnarchivedV1, Projects: out})
	if err != nil {
		vhlog.Error("gates: marshal failed", "err", err)
		http.Error(w, "gates marshal failed", http.StatusInternalServerError)
		return
	}
	// State-like GET (fresh gate facts every call) + the shared z=1 gzip64
	// opt-in, identical to /vh/snapshot's tail.
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Content-Type", "application/json")
	w.Write(maybeCompressSnapshot(b, wantsCompress(r)))
}

// handleRunningSessions aggregates how many sessions are currently running ACROSS ALL
// workspaces the daemon manages — not just the one the SPA is viewing. Restarting
// OpenCode interrupts every workspace, so the restart-confirmation warning must reflect the
// whole fleet, and /vh/projects reports running PER project only (no fleet-wide
// sum), so the restart warning needs this dedicated cross-workspace aggregate.
// Each workspace aggregator shares the single opencodeURL (one OpenCode process
// we own), and a session belongs to exactly one dir, so summing RunningRoots()
// across aggregators can't double-count.
type runningWorkspaceInfo struct {
	Dir   string `json:"dir"`
	Count int    `json:"count"`
}

type runningSessionsResp struct {
	Count      int                    `json:"count"`
	Workspaces []runningWorkspaceInfo `json:"workspaces"`
}

func (s *Server) handleRunningSessions(w http.ResponseWriter, r *http.Request) {
	type entry struct {
		dir string
		agg *aggregator.Aggregator
	}
	s.aggMu.Lock()
	live := make([]entry, 0, len(s.aggs))
	for dir, a := range s.aggs {
		live = append(live, entry{dir, a})
	}
	s.aggMu.Unlock()

	resp := runningSessionsResp{}
	for _, e := range live {
		n := e.agg.Store().RunningRoots()
		resp.Count += n
		if n > 0 {
			resp.Workspaces = append(resp.Workspaces, runningWorkspaceInfo{Dir: e.dir, Count: n})
		}
	}
	sort.Slice(resp.Workspaces, func(i, j int) bool { return resp.Workspaces[i].Dir < resp.Workspaces[j].Dir })
	// State-like GET: same rationale as handleProjects — the count is recomputed
	// live on every call (sum of per-aggregator RunningRoots), and a cached
	// response would lie about how many sessions a restart would interrupt.
	w.Header().Set("Cache-Control", "no-store")
	writeJSONResp(w, resp)
}
