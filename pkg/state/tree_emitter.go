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
//
// Q5 (capture correlation): Epoch mirrors the detail Snapshot.Epoch so BOTH
// projections carry the SAME store-lifetime {epoch, seq} identity pair. A
// client reading only the tree projection can now detect a daemon restart
// (epoch change) without cross-checking the detail snapshot. The {epoch, seq}
// stamped here is the value captured in SnapshotFrontier's single RLock.
type TreeSnapshot struct {
	Dir  string `json:"dir,omitempty"`
	Tree string `json:"tree"` // "2" — dual-negotiation marker (§10.1).
	// Epoch is this store's lifetime id (mirrors Snapshot.Epoch). Populated
	// from s.epoch under the SnapshotFrontier RLock.
	Epoch string `json:"epoch"`
	Seq   uint64 `json:"seq"` // head op seq (resume cursor, INV-A).
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

// titleFromInfo extracts the session title from a session info payload. Returns
// "" when absent/malformed. Used by the tree emitter to populate Node.Title.
func titleFromInfo(info json.RawMessage) string {
	var partial struct {
		Title string `json:"title"`
	}
	_ = json.Unmarshal(info, &partial)
	return partial.Title
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
			SubtreeBusy:       s.subtreeBusyCount[id] > 0,
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

// promoteActiveFrontierLocked mirrors SnapshotFrontier's activePath seeding
// LIVE: when a node becomes active (isActiveLocked) on a create/activity/
// permission/question event, it promotes the node's inclusive ancestor chain
// into the loaded-set E_c and ships the previously-unshipped chain nodes as
// loaded:true node.upserts, parent-before-child (INV-B).
//
// WHY this exists (the tree=2 live frontier gap): E_c was only ever grown by
// SnapshotFrontier (cold) and MarkLoaded (explicit expand). Once a connection
// drifted into the gap state — the client shows a parent EXPANDED but the
// emitter's e.ec[parent]=false after a non-destructive resync — every new
// active child was suppressed as a count-only facet (onSessionUpsertLocked's
// collapsed-parent gate) until a full reload (F5 / SnapshotFrontier recomputing
// the active path WITH the new child). This helper closes that gap by
// re-aligning the emitter's E_c model with the client the moment a node goes
// active, so the active child and its ancestor chain appear without a
// re-snapshot.
//
// Semantics (caller holds s.mu):
//  1. !isActiveLocked → nil (active gate; preserves lazy-frontier for idle nodes).
//  2. Collect the inclusive ancestor chain id→root; reverse to root→id (INV-B).
//  3. For each chain node: if it was collapsed (!e.ec) flip e.ec=true; if it was
//     unknown OR just-flipped, ship node.upsert(loaded:true) and record
//     parentCache/known. Already-known + already-expanded → skip (idempotent).
//
// Chain-only: a promoted ancestor's OTHER pre-existing idle children are NOT
// re-shipped as collapsed placeholders (SnapshotFrontier category-3 would).
// This is a deliberate, noted gap — the active child appears and the ancestor
// flips expanded, which resolves the reported symptom; lazy-frontier is
// preserved. (Re-shipping idle siblings would expand scope and risks shipping
// nodes the client never asked for.)
func (e *TreeEmitter) promoteActiveFrontierLocked(id string) []TreeOp {
	s := e.store
	if !isActiveLocked(s, id) {
		return nil
	}
	// Inclusive ancestor chain: id → ... → root. The loop condition bounds the
	// walk at a missing/gone session, so a stale-activity-after-delete id (where
	// isActiveLocked still reports true but s.sessions[id]==nil) yields an empty
	// chain and a nil return — safe.
	chain := make([]string, 0, 4)
	cur := id
	for cur != "" && s.sessions[cur] != nil {
		chain = append(chain, cur)
		cur = s.effectiveParentOfLocked(s.sessions[cur].parentID)
	}
	var ops []TreeOp
	// root→id (parent-before-child, INV-B).
	for i := len(chain) - 1; i >= 0; i-- {
		n := chain[i]
		wasCollapsed := !e.ec[n]
		if wasCollapsed {
			e.ec[n] = true
		}
		if e.known[n] && !wasCollapsed {
			continue // already promoted (loaded + expanded); idempotent no-op.
		}
		node, ok := e.buildNodeLocked(n, true)
		if !ok {
			continue
		}
		up := NodeUpsertOp(node)
		e.stamp(up, n)
		ops = append(ops, up)
		e.parentCache[n] = s.effectiveParentOfLocked(s.sessions[n].parentID)
		e.known[n] = true
	}
	return ops
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

	// out.Seq is the resume cursor the client sends back as Last-Event-ID on
	// reconnect. It MUST be the STORE head seq (s.seq), NOT the emitter's
	// per-connection seq counter — store.Replay(cursor) compares against the
	// store/ring seq space. Using the emitter seq (starts at 0) would make
	// store.Replay(0) replay every event on every reconnect (design §5.5).
	//
	// Q5: Epoch is captured in the SAME RLock as Seq (the single capture phase
	// above), so the tree projection's {epoch, seq} matches the store
	// generation this frontier was built from.
	out.Epoch = s.epoch
	out.Seq = s.seq
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
	case KindTreeOrphanCheck:
		ops = e.onOrphanCheckLocked(ev)
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
	// Defensive live-frontier promotion (tree=2 gap fix). If the upserted
	// session is ALREADY active at upsert time (a session.updated on a node that
	// went busy/perms/question earlier) AND would be suppressed (collapsed/
	// drifted parent), promote the chain so it ships loaded:true instead of a
	// count-only facet. Only short-circuits the SUPPRESSED branch: a normal
	// upsert for an active node whose parent IS in E_c still runs the shipChild
	// block below, so metadata/title updates for active nodes land. The
	// realistic appearance path is onActivityLocked (a created session is idle);
	// this mirrors isActiveLocked's full definition for the upsert-time-active
	// case. Promotion ships id + ancestors loaded:true with exact counts, so the
	// parent-count facet below is intentionally skipped.
	if !shipChild && isActiveLocked(s, id) {
		ops = append(ops, e.promoteActiveFrontierLocked(id)...)
		return ops
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
	s := e.store
	var ops []TreeOp
	// Re-root moves for every child we told the client was under id.
	for c, pc := range e.parentCache {
		if pc == id && c != id {
			mv := NodeMoveOp(c, "")
			e.stamp(mv, c)
			ops = append(ops, mv)
		}
	}
	// Capture the deleted node's parent BEFORE clearing parentCache[id] below, so
	// we can seed the ancestor walk. The store has already removed id from
	// s.sessions (deleteSessionLocked runs before emitting KindSessionDelete), so
	// s.sessions[id].parentID is unreadable — e.parentCache[id] holds the parent
	// this connection was told about. It is "" when id never shipped to this
	// connection, in which case effectiveParentOfLocked("")=="" and the walk is a
	// safe no-op.
	seedParent := e.parentCache[id]
	if e.known[id] {
		rm := NodeRemoveOp(id)
		e.stamp(rm, id)
		ops = append(ops, rm)
		delete(e.known, id)
		delete(e.parentCache, id)
		delete(e.ec, id)
	}
	// Bug d-F1 (CAUSE 2): a busy/needs-input descendant DELETED on completion
	// decrements subtreeBusyCount / subtreePendingInput on every ancestor in the
	// store (deleteSessionLocked → adjustAncestorChainFromLocked +
	// maintainIndexesOnDeleteLocked run BEFORE the emit). Before this fix no
	// facet was emitted on the delete path, so a collapsed-but-KNOWN ancestor
	// kept its stale busy/needs-input flag until a full reload (buildNodeLocked /
	// F5). Walk the chain now and emit the CURRENT (post-delete) aggregates for
	// each KNOWN ancestor, mirroring the onActivity/onQuestion facet shape. Skip
	// unknown intermediates but keep walking (same continue-not-break shape as
	// the activity/question walks).
	cur := s.effectiveParentOfLocked(seedParent)
	for cur != "" && s.sessions[cur] != nil {
		if e.known[cur] {
			busy := s.subtreeBusyCount[cur] > 0
			bop := NodeFacetOp(cur, FacetData{Flags: map[string]bool{"subtreeBusy": busy}})
			e.stamp(bop, id)
			ops = append(ops, bop)
			wantInput := s.subtreePendingInput[cur] > 0
			iop := NodeFacetOp(cur, FacetData{Flags: map[string]bool{"subtreeNeedsInput": wantInput}})
			e.stamp(iop, id)
			ops = append(ops, iop)
		}
		cur = s.effectiveParentOfLocked(s.sessions[cur].parentID)
	}
	return ops
}

// onActivityLocked emits node.facet{activity} (§6 activity row), and rolls
// SubtreeBusy up the ancestor chain: for each KNOWN ancestor it emits
// node.facet{flags:{subtreeBusy}} with the CURRENT value, so a busy↔idle
// transition live-updates collapsed ancestors' spinner. This mirrors
// onQuestionLocked's subtreeNeedsInput walk. busy↔retry is busy-neutral
// (subtreeBusyCount unchanged) so those ancestor facets are idempotent no-ops —
// that's fine and matches onQuestionLocked's "emit current value for every
// ancestor" pattern.
func (e *TreeEmitter) onActivityLocked(ev ClientEvent) []TreeOp {
	var p struct {
		SessionID string `json:"sessionID"`
		State     string `json:"state"`
	}
	if json.Unmarshal(ev.Payload, &p) != nil || p.SessionID == "" {
		return nil
	}
	st := p.State
	s := e.store

	// PRIMARY live-frontier promotion (tree=2 gap fix). A node this connection
	// does NOT yet hold is normally a no-op here. BUT if the activity made it
	// active, promote its inclusive ancestor chain into loaded/E_c so the node
	// (and any unshipped ancestors) ship NOW as real nodes — mirroring
	// SnapshotFrontier's activePath seeding live. This is the load-bearing fix
	// for "new active subsession doesn't appear until F5": a node that became
	// active while still unknown (suppressed on create under a collapsed/drifted
	// parent) ships here. The realistic appearance moment is here (NOT
	// onSessionUpsertLocked) because a created session is idle at create time —
	// activity is set only by a subsequent status/escalation. Gating on
	// !e.known keeps the known-node path below (self facet + ancestor walk)
	// byte-for-byte unchanged, so the 4751c71 ancestor walks are preserved.
	if !e.known[p.SessionID] {
		if isActiveLocked(s, p.SessionID) {
			return e.promoteActiveFrontierLocked(p.SessionID)
		}
		return nil
	}
	// Emit the node's OWN current subtreeBusy alongside the activity facet,
	// mirroring buildNodeLocked (SubtreeBusy: s.subtreeBusyCount[id] > 0).
	// subtreeBusyCount[id] INCLUDES the node's own busy contribution, so during a
	// busy turn a node.upsert ships the node with SubtreeBusy=true; when the node
	// later goes idle this self facet is the clearing moment — and for a ROOT
	// (no ancestors) it is the ONLY clearing path. Without it a stale client
	// flags.subtreeBusy=true survives the idle transition and the spinner
	// persists after /vh/abort (web/tests/e2e/ux.spec.ts:59 "Stop clears the
	// working indicator"). busy↔retry is busy-neutral (subtreeBusyCount
	// unchanged) so the emitted value is correct in both directions.
	op := NodeFacetOp(p.SessionID, FacetData{
		Activity: &st,
		Flags:    map[string]bool{"subtreeBusy": s.subtreeBusyCount[p.SessionID] > 0},
	})
	e.stamp(op, p.SessionID)
	ops := []TreeOp{op}
	// Walk ancestors; emit subtreeBusy facet for each known ancestor with the
	// CURRENT value (post-transition subtreeBusyCount). This is the busy analog
	// of onQuestionLocked's subtreeNeedsInput walk so a collapsed ancestor of a
	// busy descendant renders busy (spinner) on the live activity transition.
	// Nil-guard: e.known LAGS the store, so a session can already be deleted
	// (it has not yet processed the KindSessionDelete). The activity facet
	// above is harmless on the stale client node (a node.remove follows once the
	// delete is processed), but the ancestor walk MUST NOT dereference the gone
	// session — capture and bail before the walk. (Mirrors onQuestionLocked.)
	sess := s.sessions[p.SessionID]
	if sess == nil {
		return ops // node gone from store; no ancestors to walk.
	}
	cur := s.effectiveParentOfLocked(sess.parentID)
	for cur != "" && s.sessions[cur] != nil {
		// SKIP an intermediate ancestor this connection does not hold
		// (!e.known[cur]) but KEEP walking up — a KNOWN ancestor above an
		// unmaterialized intermediate must still receive the subtreeBusy facet
		// live. The advance runs OUTSIDE the gate so the walk cannot stall on
		// the skipped node (a bare break here truncated propagation, leaving a
		// collapsed known ancestor stale until a full reload / F5 — bug d-F1).
		if e.known[cur] {
			want := s.subtreeBusyCount[cur] > 0
			aop := NodeFacetOp(cur, FacetData{Flags: map[string]bool{"subtreeBusy": want}})
			e.stamp(aop, p.SessionID)
			ops = append(ops, aop)
		}
		cur = s.effectiveParentOfLocked(s.sessions[cur].parentID)
	}
	return ops
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
	s := e.store
	// Live-frontier promotion (tree=2 gap fix): a node this connection does not
	// yet hold, if a pending permission just made it active, ships now via
	// promoteActiveFrontierLocked (mirrors onActivityLocked). Only on set
	// (asked), not clear — a clear is never the "appearance" moment. The
	// known-node facet path below is unchanged.
	if !e.known[p.SessionID] {
		if set && isActiveLocked(s, p.SessionID) {
			return e.promoteActiveFrontierLocked(p.SessionID)
		}
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
	s := e.store
	// Live-frontier promotion (tree=2 gap fix): if this connection does NOT hold
	// the node AND a question was just asked (making it active via pendingInput),
	// ship it + its unshipped ancestor chain now (mirrors onActivityLocked) and
	// return — the shipped node.upserts carry the correct pendingInput /
	// subtreeNeedsInput flags, so the ancestor walk below is redundant for this
	// case. Gated on !e.known so the known-node facet + ancestor-walk path
	// (including the 4751c71 unmaterialized-intermediate semantics) is unchanged,
	// and an unknown-node clear still falls through to the original ancestor
	// walk (keeping known ancestors' subtreeNeedsInput fresh on clear).
	if !e.known[p.SessionID] && set && isActiveLocked(s, p.SessionID) {
		return e.promoteActiveFrontierLocked(p.SessionID)
	}
	var ops []TreeOp
	if e.known[p.SessionID] {
		op := NodeFacetOp(p.SessionID, FacetData{Flags: map[string]bool{"pendingInput": set}})
		e.stamp(op, p.SessionID)
		ops = append(ops, op)
	}
	// Walk ancestors; emit subtreeNeedsInput facet where the index flips.
	// Nil-guard: e.known LAGS the store, so a session can already be deleted
	// from s.sessions while a lagging connection still holds e.known[id]==true
	// (it has not yet processed the KindSessionDelete). The pendingInput facet
	// above is harmless on the stale client node (a node.remove follows once the
	// delete is processed), but the ancestor walk MUST NOT dereference the gone
	// session — capture and bail before the walk. (tree=2 is the default client
	// path, so this nil deref was live-hitting users.)
	sess := s.sessions[p.SessionID]
	if sess == nil {
		return ops // node gone from store; no ancestors to walk.
	}
	cur := s.effectiveParentOfLocked(sess.parentID)
	for cur != "" && s.sessions[cur] != nil {
		// SKIP an intermediate ancestor this connection does not hold
		// (!e.known[cur]) but KEEP walking up — a KNOWN ancestor above an
		// unmaterialized intermediate must still receive the subtreeNeedsInput
		// facet live. The advance runs OUTSIDE the gate so the walk cannot stall
		// on the skipped node (a bare break here truncated propagation, leaving a
		// collapsed known ancestor stale until a full reload / F5 — bug d-F1).
		if e.known[cur] {
			want := s.subtreePendingInput[cur] > 0
			op := NodeFacetOp(cur, FacetData{Flags: map[string]bool{"subtreeNeedsInput": want}})
			e.stamp(op, p.SessionID)
			ops = append(ops, op)
		}
		cur = s.effectiveParentOfLocked(s.sessions[cur].parentID)
	}
	return ops
}

// onOrphanCheckLocked emits node.facet{flags:{orphan}} for the node id with its
// recomputed orphan status (§9.2 + §9.3). Skipped if the node is not known to
// this connection (the client doesn't hold it → no facet needed) or is gone
// from the store.
func (e *TreeEmitter) onOrphanCheckLocked(ev ClientEvent) []TreeOp {
	var p struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(ev.Payload, &p) != nil || p.ID == "" {
		return nil
	}
	if !e.known[p.ID] {
		return nil
	}
	s := e.store
	if s.sessions[p.ID] == nil {
		return nil // gone from store
	}
	op := NodeFacetOp(p.ID, FacetData{Flags: map[string]bool{"orphan": isOrphanLocked(s, p.ID)}})
	e.stamp(op, p.ID)
	return []TreeOp{op}
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
