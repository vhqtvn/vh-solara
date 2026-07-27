package state

import "sort"

// Busy diagnostic snapshot — a read-only, one-query view of the busy indexes
// so a phantom "running" count is instantly diagnosable instead of needing a
// three-endpoint cross-check (/vh/running-sessions vs /vh/sessions activity vs
// a tree snapshot's subtreeBusy). Exposed via GET /vh/diag/busy (pkg/web).
//
// Single source of truth: RunningRoots derives from subtreeBusyCount, so the
// running count and the per-root subtreeBusy aggregate can no longer diverge.
// This snapshot nonetheless surfaces BOTH (the derived running count AND the
// per-session activity that backs it) plus the independently-derived busy-root
// set, so any FUTURE drift — or a stale activity strand the grace window has
// not yet cleared — shows up as a mismatch in one response.

// BusyDiagSession is one live session's contribution to the busy diagnostic.
type BusyDiagSession struct {
	ID          string `json:"id"`
	ParentID    string `json:"parentID,omitempty"`
	IsRoot      bool   `json:"isRoot"`      // orphan-inclusive root (parentID=="" or parent absent)
	Activity    string `json:"activity"`    // s.activity[id] (idle|busy|retry|error|"" when absent)
	SubtreeBusy int    `json:"subtreeBusy"` // s.subtreeBusyCount[id] (0 when absent)
}

// BusyDiagSnapshot is a read-only diagnostic of the busy indexes for one store
// (one workspace). The web handler aggregates one per workspace.
type BusyDiagSnapshot struct {
	RunningRoots int               `json:"runningRoots"` // Store.RunningRoots() — the /vh/running-sessions source
	RootCount    int               `json:"rootCount"`    // Store.RootCount()
	BusyRootIDs  []string          `json:"busyRootIds"`  // live roots whose subtreeBusy > 0 (sorted)
	Sessions     []BusyDiagSession `json:"sessions"`     // every live session, sorted by id
}

// BusyDiag returns a read-only diagnostic snapshot of the busy indexes under
// s.mu.RLock. It is safe to call concurrently with Apply. Bounded by the live
// session count (O(n)); intended for low-frequency diagnostic GETs, not hot
// paths. Emits NO transcript/session-body/URL data — only ids, parent links,
// activity labels, and the integer busy aggregate.
func (s *Store) BusyDiag() BusyDiagSnapshot {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := BusyDiagSnapshot{
		RunningRoots: 0,
		RootCount:    0,
		BusyRootIDs:  []string{},
		Sessions:     make([]BusyDiagSession, 0, len(s.sessions)),
	}
	// Collect + sort live session ids for a stable response.
	ids := make([]string, 0, len(s.sessions))
	for id := range s.sessions {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		se := s.sessions[id]
		isRoot := se.parentID == "" || s.sessions[se.parentID] == nil
		ds := BusyDiagSession{
			ID:          id,
			ParentID:    se.parentID,
			IsRoot:      isRoot,
			Activity:    s.activity[id],
			SubtreeBusy: s.subtreeBusyCount[id],
		}
		out.Sessions = append(out.Sessions, ds)
		if isRoot {
			out.RootCount++
			if ds.SubtreeBusy > 0 {
				out.RunningRoots++
				out.BusyRootIDs = append(out.BusyRootIDs, id)
			}
		}
	}
	return out
}
