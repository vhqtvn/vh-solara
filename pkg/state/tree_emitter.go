package state

import (
	"encoding/json"
)

// tree_emitter.go is the server-owned tree emitter (Phase 2a) — the frontier
// snapshot composer (§5) and the structural-delta translator (§6). It reads the
// EXISTING store + subtree indexes (it does NOT rebuild the tree or maintain a
// parallel structure) and produces the §3 Node + §4 delta-op wire contract.
//
// Per-connection state (§5.4 loaded-set E_c, the monotonic seq counter INV-A,
// and a parentId cache for move detection) lives on TreeEmitter. The web layer
// constructs one TreeEmitter per tree=2 stream connection.

// TreeSnapshot is the initial cold-load payload (§5): the frontier Node set
// plus the per-connection loaded-set seed (E_c) and the head seq the client
// resumes from.
type TreeSnapshot struct {
	Dir   string `json:"dir,omitempty"`
	Tree  string `json:"tree"` // "2" — dual-negotiation marker (§10.1).
	Seq   uint64 `json:"seq"`  // head op seq (resume cursor, INV-A).
	Nodes []Node `json:"nodes"`
	Cause string `json:"cause,omitempty"` // "cold" | "reconnect".
}

// TreeEmitter translates store state + ClientEvents into the tree=2 wire
// contract for one stream connection. It is NOT safe for concurrent use from
// multiple goroutines — one per connection, driven by the single stream loop.
type TreeEmitter struct {
	store *Store
	dir   string
	seq   uint64

	// ec is the per-connection loaded-set E_c (§5.4): the set of nodes whose
	// DIRECT children this connection holds. Seeded from the §5 snapshot's
	// loaded:true nodes; grown when a terminal node.children expand completes.
	ec map[string]bool

	// parentCache records the parentId the emitter has TOLD this connection
	// about per id. It is the emitter's own record (NOT a second tree): it
	// exists only to detect reparents and emit node.move (§6) and to enumerate
	// a deleted node's formerly-known children for re-root moves.
	parentCache map[string]string

	// known records every id the emitter has shipped to this connection (as a
	// real node, not just a count facet). Used so a facet/upsert for an id the
	// client doesn't hold is skipped (the client would ignore it anyway, but
	// skipping saves bandwidth and matches "structure authority flows one way").
	known map[string]bool
}

// NewTreeEmitter constructs an emitter bound to store. dir is the project
// directory scope (mirrors reqDir) stamped onto op envelopes.
func NewTreeEmitter(store *Store, dir string) *TreeEmitter {
	return &TreeEmitter{
		store:       store,
		dir:         dir,
		ec:          map[string]bool{},
		parentCache: map[string]string{},
		known:       map[string]bool{},
	}
}

// LoadedSet returns the per-connection loaded-set E_c (for inspection / tests).
func (e *TreeEmitter) LoadedSet() map[string]bool {
	out := make(map[string]bool, len(e.ec))
	for k, v := range e.ec {
		out[k] = v
	}
	return out
}

// MarkLoaded adds id to E_c (§5.4). Called by the expand endpoint when a
// connection completes a terminal node.children batch for parent id.
func (e *TreeEmitter) MarkLoaded(id string) {
	if id != "" {
		e.ec[id] = true
	}
}

// nextSeq advances and returns the monotonic per-stream op seq (INV-A).
func (e *TreeEmitter) nextSeq() uint64 {
	e.seq++
	return e.seq
}

// stamp assigns seq/dir/session-hint to an op and records its structural
// consequence (parentId, known-set) so later events can detect moves.
func (e *TreeEmitter) stamp(op TreeOp, sessionHint string) {
	op.assignSeq(e.nextSeq())
	op.setDir(e.dir)
	if sessionHint != "" {
		op.setSessionHint(sessionHint)
	}
}

// ----------------------------------------------------------------------------
// Node construction (reads store state; caller holds s.mu)
// ----------------------------------------------------------------------------

// updatedMsFromInfo extracts time.updated (unix ms) from a session info payload.
// Returns 0 when absent/malformed. This is the O1-recency source (§note A):
// the wire updatedMs reflects the session's REAL last-update, not daemon now.
func updatedMsFromInfo(info json.RawMessage) int64 {
	var partial struct {
		Time struct {
			Updated *float64 `json:"updated"`
		} `json:"time"`
	}
	_ = json.Unmarshal(info, &partial)
	if partial.Time.Updated == nil {
		return 0
	}
	return int64(*partial.Time.Updated)
}

// isArchivedLocked reports whether id's session info carries time.archived.
func isArchivedLocked(s *Store, id string) bool {
	se := s.sessions[id]
	if se == nil {
		return false
	}
	var env sessionEnvelope
	_ = json.Unmarshal(se.info, &env)
	return env.archivedAt()
}

// buildNodeLocked constructs a full Node for id from the current store state.
// Caller holds s.mu. This is the single place tree-node fields are derived, so
// frontier + delta + expand all agree (R1: counts are always exact at emit).
func (e *TreeEmitter) buildNodeLocked(id string, loaded bool) (Node, bool) {
	s := e.store
	se := s.sessions[id]
	if se == nil {
		return Node{}, false
	}
	var env sessionEnvelope
	_ = json.Unmarshal(se.info, &env)
	n := Node{
		ID:         id,
		ParentID:   s.effectiveParentOfLocked(se.parentID),
		Title:      titleFromInfo(se.info),
		Agent:      se.lastAgent,
		Activity:   s.activity[id],
		ChildCount: len(s.children[id]),
		Loaded:     loaded,
		UpdatedMs:  updatedMsFromInfo(se.info),
		Flags: NodeFlags{
			PendingInput:      s.pendingInputSelf[id] > 0,
			SubtreeNeedsInput: s.subtreePendingInput[id] > 0,
			Permission:        len(s.perms[id]) > 0,
			Archived:          env.archivedAt(),
			Orphan:            isOrphanLocked(s, id),
		},
	}
	if se.currentVerb.Tool != "" {
		n.Verb = &se.currentVerb
	}
	return n, true
}

// isOrphanLocked implements the §9.1 orphan rule: N is a genuine orphan iff its
// effective parent is non-empty AND the root of its chain is archived AND N is
// still resident. A live-rooted session is NEVER an orphan.
func isOrphanLocked(s *Store, id string) bool {
	pid := s.effectiveParentOfLocked(s.sessions[id].parentID)
	if pid == "" {
		return false // N is itself a root → not an orphan.
	}
	// Walk to the chain root.
	cur := id
	for i := 0; i < 10000; i++ { // bound against cycles (defensive)
		p := s.effectiveParentOfLocked(s.sessions[cur].parentID)
		if p == "" {
			break
		}
		cur = p
	}
	return isArchivedLocked(s, cur)
}

// ----------------------------------------------------------------------------
// Frontier snapshot (§5) — true-lazy cold load
// ----------------------------------------------------------------------------

// isActiveLocked reports whether id seeds an active path (§5.1): activity is
// busy/retry/error, OR a permission is pending, OR a question is pending. An
// archived session NEVER seeds (Q1).
func isActiveLocked(s *Store, id string) bool {
	if isArchivedLocked(s, id) {
		return false
	}
	a := s.activity[id]
	if a == ActivityBusy || a == ActivityRetry || a == ActivityError {
		return true
	}
	if len(s.perms[id]) > 0 || s.pendingInputSelf[id] > 0 {
		return true
	}
	return false
}

// SnapshotFrontier computes the §5 cold-load snapshot: all roots + active paths
// (loaded:true) + direct children of loaded nodes (collapsed placeholders).
// Cold-load size is O(roots + active-path-nodes + direct-children-of-loaded),
// independent of total idle-session count (R1). It also seeds E_c from the
// loaded:true nodes (§5.4).
func (e *TreeEmitter) SnapshotFrontier(cause string) *TreeSnapshot {
	s := e.store
	s.mu.RLock()
	defer s.mu.RUnlock()

	// Category 2 first: the union of all active paths (loaded candidates).
	activePath := map[string]bool{}
	for id, se := range s.sessions {
		if se == nil || !isActiveLocked(s, id) {
			continue
		}
		cur := id
		for cur != "" && s.sessions[cur] != nil && !activePath[cur] {
			activePath[cur] = true
			cur = s.effectiveParentOfLocked(s.sessions[cur].parentID)
		}
	}

	// loaded (§5.2): every active-path node is loaded:true. For a node WITH
	// children, its direct children ship as category-3 placeholders. For an
	// active leaf (no children) loaded:true still holds — the active session is
	// fully realized (not a collapsed placeholder), and a future child create
	// ships as a real node (E_c membership).
	loaded := activePath

	// Seed E_c from the loaded set (§5.4).
	for id := range loaded {
		e.ec[id] = true
	}

	// Direct children of every loaded node (category 3) — collapsed placeholders.
	// Exclude ids already shipped as a loaded active-path node (category 2) or a
	// root (category 1) so a node never appears twice.
	parentSet := map[string]bool{}
	for _, r := range s.rootIDs {
		if s.sessions[r] != nil {
			parentSet[r] = true
		}
	}
	for id := range activePath {
		parentSet[id] = true
	}
	directChildren := map[string]bool{}
	for parent := range loaded {
		for _, c := range s.children[parent] {
			if s.sessions[c] != nil && !parentSet[c] {
				directChildren[c] = true
			}
		}
	}

	// Emit order (INV-B parent-before-child): roots/active-path first (parents),
	// then their direct children. Within the parent set, emit ancestors before
	// descendants by depth so a child never precedes its parent.
	out := &TreeSnapshot{Dir: e.dir, Tree: "2", Cause: cause}

	parents := sortedByDepthLocked(s, parentSet)
	for _, id := range parents {
		e.emitSnapshotNode(out, id, loaded[id])
	}
	// Direct children (category 3) — always collapsed placeholders.
	for _, id := range sortedByDepthLocked(s, directChildren) {
		e.emitSnapshotNode(out, id, false)
	}

	out.Seq = e.seq
	return out
}

// emitSnapshotNode builds + appends a Node, populating descendantCount for
// collapsed placeholders, and records parentCache/known for move detection.
func (e *TreeEmitter) emitSnapshotNode(out *TreeSnapshot, id string, loaded bool) {
	n, ok := e.buildNodeLocked(id, loaded)
	if !ok {
		return
	}
	if !loaded {
		dc := e.store.subtreeDescendantCount[id]
		n.DescendantCount = &dc
	}
	out.Nodes = append(out.Nodes, n)
	e.parentCache[id] = n.ParentID
	e.known[id] = true
}

// sortedByDepthLocked returns ids ordered by chain depth ascending (roots
// first), so parent-before-child holds within a flush. Caller holds s.mu.
func sortedByDepthLocked(s *Store, ids map[string]bool) []string {
	type entry struct {
		id    string
		depth int
	}
	depthOf := func(id string) int {
		d := 0
		cur := id
		for i := 0; i < 10000; i++ {
			p := s.effectiveParentOfLocked(s.sessions[cur].parentID)
			if p == "" {
				break
			}
			d++
			cur = p
		}
		return d
	}
	es := make([]entry, 0, len(ids))
	for id := range ids {
		es = append(es, entry{id, depthOf(id)})
	}
	// Stable sort by depth (insertion-stable over map iteration order is not
	// required; depth is the only ordering constraint for INV-B).
	for i := 1; i < len(es); i++ {
		for j := i; j > 0 && es[j-1].depth > es[j].depth; j-- {
			es[j-1], es[j] = es[j], es[j-1]
		}
	}
	out := make([]string, len(es))
	for i, e := range es {
		out[i] = e.id
	}
	return out
}

// ----------------------------------------------------------------------------
// Structural-delta translation (§6)
// ----------------------------------------------------------------------------

// Translate maps one store ClientEvent into zero or more tree delta ops for
// THIS connection, applying the §5.4 loaded-set decision (real child op when
// the parent is in E_c, count-only facet otherwise) and enforcing INV-B
// (parent-before-child) within the returned slice. Caller must NOT hold s.mu.
func (e *TreeEmitter) Translate(ev ClientEvent) []TreeOp {
	s := e.store
	s.mu.RLock()
	defer s.mu.RUnlock()

	var ops []TreeOp
	switch ev.Kind {
	case KindSessionUpsert:
		ops = e.onSessionUpsertLocked(ev)
	case KindSessionDelete:
		ops = e.onSessionDeleteLocked(ev)
	case KindActivity:
		ops = e.onActivityLocked(ev)
	case KindActivityVerb:
		ops = e.onActivityVerbLocked(ev)
	case KindPermissionSet:
		ops = e.onPermissionLocked(ev, true)
	case KindPermissionClear:
		ops = e.onPermissionLocked(ev, false)
	case KindQuestionSet:
		ops = e.onQuestionLocked(ev, true)
	case KindQuestionClear:
		ops = e.onQuestionLocked(ev, false)
	}
	for _, op := range ops {
		op.assignSeq(e.nextSeq())
		op.setDir(e.dir)
	}
	return ops
}

// onSessionUpsertLocked handles a session create/update. Emits node.upsert for
// the node; detects reparents (parentCache drift) and reabsorbed orphans via
// node.move; applies the §5.4 loaded-set decision to child pushes.
//
// Payload note: the store emits KindSessionUpsert with the RAW session info
// (store.go:1989 `s.emit(KindSessionUpsert, p.Info)`), NOT wrapped in
// {"info":...}. So we unmarshal the envelope directly off the payload.
func (e *TreeEmitter) onSessionUpsertLocked(ev ClientEvent) []TreeOp {
	s := e.store
	var env sessionEnvelope
	if json.Unmarshal(ev.Payload, &env) != nil || env.ID == "" {
		return nil
	}
	id := env.ID
	if s.sessions[id] == nil {
		return nil // phantom (tombstoned); nothing to show.
	}
	var ops []TreeOp

	// Reparent detection: if we previously told the client a different parent,
	// emit node.move so the client re-attaches. (§6 "Parent reparented".)
	newParent := s.effectiveParentOfLocked(s.sessions[id].parentID)
	if prev, had := e.parentCache[id]; had && prev != newParent {
		mv := NodeMoveOp(id, newParent)
		e.stamp(mv, id)
		ops = append(ops, mv)
	}

	// Reabsorbed-orphan detection (§6 create row → maintainChildrenOnSessionUpsertLocked):
	// any child now under id whose cached parent differs was just reabsorbed.
	for _, c := range s.children[id] {
		if !e.known[c] {
			continue
		}
		if pc := e.parentCache[c]; pc != id {
			mv := NodeMoveOp(c, id)
			e.stamp(mv, c)
			ops = append(ops, mv)
		}
	}

	// The upsert itself (full node). If the parent is collapsed on this
	// connection (P ∉ E_c), only the COUNT facet on the parent is emitted (§5.4),
	// NOT the child upsert — unless the parent isn't known at all (a root or a
	// brand-new top-level node always ships).
	shipChild := true
	if newParent != "" && e.known[newParent] && !e.ec[newParent] {
		// Parent is a collapsed placeholder on this connection → count-only facet.
		shipChild = false
	}
	if shipChild {
		n, ok := e.buildNodeLocked(id, false)
		if ok {
			up := NodeUpsertOp(n)
			e.stamp(up, id)
			ops = append(ops, up)
			e.parentCache[id] = newParent
			e.known[id] = true
		}
	}
	// Bump the parent's counts if it's known (the child changed its set).
	if newParent != "" && e.known[newParent] {
		ops = append(ops, e.parentCountFacetLocked(newParent, id)...)
	}
	return ops
}

// parentCountFacetLocked emits a node.upsert of the parent so its counts
// (childCount + descendantCount) are exact at emit time (§6.1 R1). Counts
// travel via node.upsert, not node.facet — §4.6 lists activity/verb/flags only
// as facet fields.
func (e *TreeEmitter) parentCountFacetLocked(parent string, hint string) []TreeOp {
	n, ok := e.buildNodeLocked(parent, e.ec[parent])
	if !ok {
		return nil
	}
	up := NodeUpsertOp(n)
	e.stamp(up, hint)
	return []TreeOp{up}
}

// onSessionDeleteLocked emits node.remove for the deleted id and node.move for
// every formerly-known child (the store re-roots them; §6 delete row).
//
// Payload note: the store emits KindSessionDelete with `{"id":id}`
// (store.go:2050 `s.emit(KindSessionDelete, rawObj(...{"id": id}))`).
func (e *TreeEmitter) onSessionDeleteLocked(ev ClientEvent) []TreeOp {
	var p struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(ev.Payload, &p) != nil || p.ID == "" {
		return nil
	}
	id := p.ID
	var ops []TreeOp
	// Re-root moves for every child we told the client was under id.
	for c, pc := range e.parentCache {
		if pc == id && c != id {
			mv := NodeMoveOp(c, "")
			e.stamp(mv, c)
			ops = append(ops, mv)
		}
	}
	if e.known[id] {
		rm := NodeRemoveOp(id)
		e.stamp(rm, id)
		ops = append(ops, rm)
		delete(e.known, id)
		delete(e.parentCache, id)
		delete(e.ec, id)
	}
	return ops
}

// onActivityLocked emits node.facet{activity} (§6 activity row).
func (e *TreeEmitter) onActivityLocked(ev ClientEvent) []TreeOp {
	var p struct {
		SessionID string `json:"sessionID"`
		State     string `json:"state"`
	}
	if json.Unmarshal(ev.Payload, &p) != nil || p.SessionID == "" {
		return nil
	}
	if !e.known[p.SessionID] {
		return nil
	}
	st := p.State
	op := NodeFacetOp(p.SessionID, FacetData{Activity: &st})
	e.stamp(op, p.SessionID)
	return []TreeOp{op}
}

// onActivityVerbLocked emits node.facet{verb} (set or clear).
func (e *TreeEmitter) onActivityVerbLocked(ev ClientEvent) []TreeOp {
	var p struct {
		SessionID string `json:"sessionID"`
	}
	if json.Unmarshal(ev.Payload, &p) != nil || p.SessionID == "" {
		return nil
	}
	if !e.known[p.SessionID] {
		return nil
	}
	var data FacetData
	if cv := e.store.sessions[p.SessionID]; cv != nil && cv.currentVerb.Tool != "" {
		data.Verb = SetVerb(cv.currentVerb)
	} else {
		data.Verb = ClearVerb()
	}
	op := NodeFacetOp(p.SessionID, data)
	e.stamp(op, p.SessionID)
	return []TreeOp{op}
}

// onPermissionLocked emits node.facet{flags:{permission}} (§6).
func (e *TreeEmitter) onPermissionLocked(ev ClientEvent, set bool) []TreeOp {
	var p struct {
		SessionID string `json:"sessionID"`
	}
	if json.Unmarshal(ev.Payload, &p) != nil || p.SessionID == "" {
		return nil
	}
	if !e.known[p.SessionID] {
		return nil
	}
	op := NodeFacetOp(p.SessionID, FacetData{Flags: map[string]bool{"permission": set}})
	e.stamp(op, p.SessionID)
	return []TreeOp{op}
}

// onQuestionLocked emits node.facet{flags:{pendingInput}} plus, for each ancestor
// whose subtreeNeedsInput flips, a node.facet{flags:{subtreeNeedsInput}} (§6 +
// Q2: the ONE retained subtree-aggregate propagates up the chain).
func (e *TreeEmitter) onQuestionLocked(ev ClientEvent, set bool) []TreeOp {
	var p struct {
		SessionID string `json:"sessionID"`
	}
	if json.Unmarshal(ev.Payload, &p) != nil || p.SessionID == "" {
		return nil
	}
	var ops []TreeOp
	if e.known[p.SessionID] {
		op := NodeFacetOp(p.SessionID, FacetData{Flags: map[string]bool{"pendingInput": set}})
		e.stamp(op, p.SessionID)
		ops = append(ops, op)
	}
	// Walk ancestors; emit subtreeNeedsInput facet where the index flips.
	s := e.store
	cur := s.effectiveParentOfLocked(s.sessions[p.SessionID].parentID)
	for cur != "" && s.sessions[cur] != nil {
		if !e.known[cur] {
			break
		}
		want := s.subtreePendingInput[cur] > 0
		op := NodeFacetOp(cur, FacetData{Flags: map[string]bool{"subtreeNeedsInput": want}})
		e.stamp(op, p.SessionID)
		ops = append(ops, op)
		cur = s.effectiveParentOfLocked(s.sessions[cur].parentID)
	}
	return ops
}

// ----------------------------------------------------------------------------
// Expand (§8) — direct-children page for a parent id
// ----------------------------------------------------------------------------

// defaultBranchExpandLimit mirrors projection.go:356 (the old expand page size).
const defaultTreeExpandLimit = 50

// ExpandChildren returns a node.children page (§8): the direct children of
// parentID, starting after cursor (an opaque child id), up to limit. hasMore is
// true when more children remain; cursor is the next child id or "" when done.
// stale is true when the cursor was not found (reparented/deleted) — caller
// should signal a restart (§8.3). It also adds parentID to E_c on a terminal
// batch (§5.4).
func (e *TreeEmitter) ExpandChildren(parentID, cursor string, limit int) (nodes []Node, hasMore bool, nextCursor string, stale bool) {
	if limit <= 0 {
		limit = defaultTreeExpandLimit
	}
	s := e.store
	s.mu.RLock()
	defer s.mu.RUnlock()
	kids := s.children[parentID]
	start := 0
	if cursor != "" {
		// Find the cursor position; if it's gone (reparented/deleted), the page
		// is stale → return empty + hasMore=false (§8.3 stale-cursor restart).
		found := -1
		for i, c := range kids {
			if c == cursor {
				found = i
				break
			}
		}
		if found < 0 {
			return nil, false, "", true
		}
		start = found + 1
	}
	end := start + limit
	if end > len(kids) {
		end = len(kids)
	}
	for _, c := range kids[start:end] {
		n, ok := e.buildNodeLocked(c, false)
		if !ok {
			continue
		}
		dc := s.subtreeDescendantCount[c]
		n.DescendantCount = &dc
		nodes = append(nodes, n)
		e.parentCache[c] = parentID
		e.known[c] = true
	}
	hasMore = end < len(kids)
	if hasMore {
		nextCursor = kids[end-1]
	} else {
		// Terminal batch → parent is now loaded on this connection (§5.4).
		e.MarkLoaded(parentID)
	}
	return nodes, hasMore, nextCursor, false
}
