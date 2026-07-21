package state

import (
	"encoding/json"
	"strings"
	"time"
)

// CollapsedBranchStub is the wire representation of a collapsed idle subtree in
// a projected snapshot (Phase 4 Gate A/D). It carries ONLY the aggregate facts
// a client needs to render the collapsed row — the session's title, its subtree
// size, and the worst aggregate state across the whole subtree — NOT the full
// session payload (gate/permissions/todos/tokens/lastAgents/summary/model/
// agent/version/directory/projectID are all absent). A client renders the stub
// as a twisty row with a descendant-count badge; expanding it triggers a
// lazy-fetch to the branch endpoint, which materializes the children as full
// sessions.
type CollapsedBranchStub struct {
	// ID is the session ID of the collapsed subtree root.
	ID string `json:"id"`
	// ParentID is the effective parent (empty for roots or orphans).
	ParentID string `json:"parentID,omitempty"`
	// Title is the session title extracted from the session info JSON (single-
	// field parse; empty if the title is absent).
	Title string `json:"title,omitempty"`
	// Kind is always "collapsed-branch" so the client can distinguish a stub
	// from a full session without inspecting other fields.
	Kind string `json:"kind"`
	// HasChildren reports whether this stub has child sessions (and thus can be
	// expanded via the lazy-expand endpoint). A leaf session (no children) still
	// gets a stub so the client knows it exists, but HasChildren=false signals
	// that expansion is a no-op.
	HasChildren bool `json:"hasChildren"`
	// DescendantCount is the total number of live sessions in this subtree,
	// including the stub root itself. Read from the incremental
	// subtreeDescendantCount index — O(1).
	DescendantCount uint32 `json:"descendantCount"`
	// NewestActivityAt is the newest activity timestamp across the entire
	// subtree, as unix milliseconds. Zero/absent means the subtree has never
	// had an activity transition (e.g., freshly-created idle sessions). Read
	// from the incremental subtreeNewestActivity index — O(1).
	NewestActivityAt int64 `json:"newestActivityAt,omitempty"`
	// AggregateState is the worst state across the subtree, with precedence
	// busy > retry > needs-input > recent > idle. Derived from the incremental
	// subtreeBusyCount/subtreeRetryCount/subtreePendingInput/subtreeNewestActivity
	// indexes — O(1).
	AggregateState string `json:"aggregateState"`
	// StructuralRevision carries the Store-wide structural revision at capture
	// time, so the client can detect staleness on a lazy-expand response. This
	// mirrors the envelope-level StructuralRevision but is stamped per-stub for
	// diagnostic clarity (the envelope value is authoritative).
	StructuralRevision uint64 `json:"structuralRevision,omitempty"`
}

// defaultProjectionCutoff is the activity-recency threshold below which a
// session is considered "idle" for projection purposes. Sessions whose subtree
// newest activity is older than (now - cutoff) AND are not busy/retry/pending-
// input are collapsed into frontier stubs.
//
// Phase 6 (Gate E): this is the tunable cutoff value. The cutoffVersion package
// var identifies the policy generation — bump it when changing the cutoff so
// the client can detect a boundary change. Both are stamped in every projected
// snapshot via projectionCutoff().
//
// Anti-thrash: demotion happens ONLY at snapshot construction (NOT on a timer).
// The 15s ping ticker in handleStream stays ping-only — it does NOT trigger
// re-projection. This is the anti-thrash guarantee: a session active every
// 9:59 (just under 10min) never gets demoted between bursts because no snapshot
// is constructed between them.
var defaultProjectionCutoff = 10 * time.Minute

// projectionCutoffVersion is the monotonic version of the cutoff policy. Bump
// it whenever the cutoff duration changes (or the policy logic changes). The
// client uses this to detect a boundary change between snapshots.
var projectionCutoffVersion uint32 = 1

// projectionCutoff returns the current cutoff policy: (version, duration).
// Centralized here so SnapshotProjected and SnapshotBranch stamp the same
// values, and tests can change the package vars and see the change reflected.
func projectionCutoff() (uint32, time.Duration) {
	return projectionCutoffVersion, defaultProjectionCutoff
}

// structuralKinds is the set of event kinds that affect the projection
// boundary (session topology, activity state, or pending input). When a proj=1
// stream handler receives one of these, it re-snapshots via SnapshotProjected
// (cause: "promotion") so the client's collapsed-frontier view stays in sync.
// This avoids emitting a separate KindStructuralChange event — the existing
// incremental events carry the signal.
var structuralKinds = map[string]bool{
	KindSessionUpsert:   true,
	KindSessionDelete:   true,
	KindActivity:        true,
	KindPermissionSet:   true,
	KindPermissionClear: true,
	KindQuestionSet:     true,
	KindQuestionClear:   true,
}

// IsStructuralKind reports whether an event kind affects the projection
// boundary. Used by the proj=1 stream handler to decide when to re-snapshot.
func IsStructuralKind(kind string) bool {
	return structuralKinds[kind]
}

// defaultBranchExpandLimit is the maximum number of children returned by a
// single lazy-expand (SnapshotBranch) call. The client paginates via the cursor
// for branches with more children.
const defaultBranchExpandLimit = 50

// aggregateStateLocked derives the aggregate state for a session's subtree
// using the incremental indexes. Precedence: busy > retry > needs-input >
// recent > idle. Caller must hold s.mu (at least RLock).
//
// Note: subtreeBusyCount counts BOTH busy AND retry sessions (the prototype
// design — both represent "actively working"). To distinguish pure-busy from
// pure-retry, we subtract subtreeRetryCount: if (busyCount - retryCount) > 0,
// at least one session is busy-but-not-retry → "busy"; otherwise if
// retryCount > 0, all active workers are retrying → "retry".
func (s *Store) aggregateStateLocked(id string, cutoff time.Time) string {
	busyNotRetry := s.subtreeBusyCount[id] - s.subtreeRetryCount[id]
	if busyNotRetry > 0 {
		return "busy"
	}
	if s.subtreeRetryCount[id] > 0 {
		return "retry"
	}
	if s.subtreePendingInput[id] > 0 {
		return "needs-input"
	}
	if t := s.subtreeNewestActivity[id]; !t.IsZero() && t.After(cutoff) {
		return "recent"
	}
	return "idle"
}

// subtreeHasActivityLocked reports whether a session's subtree has any activity
// that warrants inclusion in the active closure (busy/retry/pending-input or
// activity more recent than cutoff). Used to PRUNE idle subtrees early during
// the active-closure descent — O(1) per node via the incremental indexes.
// Caller holds s.mu.
func (s *Store) subtreeHasActivityLocked(id string, cutoff time.Time) bool {
	if s.subtreeBusyCount[id] > 0 {
		return true
	}
	if s.subtreeRetryCount[id] > 0 {
		return true
	}
	if s.subtreePendingInput[id] > 0 {
		return true
	}
	if t := s.subtreeNewestActivity[id]; !t.IsZero() && t.After(cutoff) {
		return true
	}
	return false
}

// selfActiveLocked reports whether a session ITSELF (not its subtree) is
// directly active: busy/retry, has pending input, or had a recent activity
// transition. Used to distinguish "include as full session because self is
// active" from "include only as an ancestor for tree connectivity."
// Caller holds s.mu.
func (s *Store) selfActiveLocked(id string, cutoff time.Time) bool {
	act := s.activity[id]
	if act == ActivityBusy || act == ActivityRetry {
		return true
	}
	if s.pendingInputSelf[id] > 0 {
		return true
	}
	if t := s.lastActivityAt[id]; !t.IsZero() && t.After(cutoff) {
		return true
	}
	return false
}

// computeActiveClosureLocked computes the set of session IDs that must be
// materialized as FULL sessions in the projected snapshot. This is the active
// closure: every session that is itself active (busy/retry/pending-input/
// recent) PLUS every ancestor needed to connect it to its root (so the tree
// structure is intact). Descends from roots using the children index —
// O(|roots| + |active_closure| × depth), NOT O(n). Idle subtrees are pruned
// at the first node whose subtreeHasActivityLocked returns false.
// Caller holds s.mu.
func (s *Store) computeActiveClosureLocked(cutoff time.Time) map[string]bool {
	active := map[string]bool{}
	for _, rootID := range s.rootIDs {
		s.descendActiveClosureLocked(rootID, cutoff, active)
	}
	return active
}

// descendActiveClosureLocked recursively descends into the subtree rooted at
// id, adding to `active` every session that is itself active OR is an ancestor
// of an active descendant (to preserve tree connectivity). Prunes idle
// subtrees at the first node whose subtree has no activity. Caller holds s.mu.
func (s *Store) descendActiveClosureLocked(id string, cutoff time.Time, active map[string]bool) {
	if s.sessions[id] == nil {
		return
	}
	// Prune: if the entire subtree is idle, skip it.
	if !s.subtreeHasActivityLocked(id, cutoff) {
		return
	}
	// Descend into children first to discover which descendants are active.
	hasActiveDescendant := false
	for _, childID := range s.children[id] {
		before := len(active)
		s.descendActiveClosureLocked(childID, cutoff, active)
		if len(active) > before {
			hasActiveDescendant = true
		}
	}
	// Include this session if it is DIRECTLY active OR has active descendants.
	if s.selfActiveLocked(id, cutoff) || hasActiveDescendant {
		active[id] = true
	}
}

// titleFromInfo extracts the "title" field from a session info JSON payload via
// a single-field targeted parse. Returns empty if the field is absent or the
// JSON is malformed. This avoids deserializing the full session object.
func titleFromInfo(info json.RawMessage) string {
	var partial struct {
		Title string `json:"title"`
	}
	_ = json.Unmarshal(info, &partial)
	return partial.Title
}

// buildStubLocked constructs a CollapsedBranchStub for the given session ID,
// reading aggregate facts from the incremental indexes. Caller holds s.mu.
func (s *Store) buildStubLocked(id string, cutoff time.Time, rev uint64) CollapsedBranchStub {
	se := s.sessions[id]
	stub := CollapsedBranchStub{
		ID:                 id,
		Kind:               "collapsed-branch",
		DescendantCount:    uint32(s.subtreeDescendantCount[id]),
		AggregateState:     s.aggregateStateLocked(id, cutoff),
		StructuralRevision: rev,
	}
	if se != nil {
		stub.Title = titleFromInfo(se.info)
		stub.ParentID = s.effectiveParentOfLocked(se.parentID)
	}
	stub.HasChildren = len(s.children[id]) > 0
	if t := s.subtreeNewestActivity[id]; !t.IsZero() {
		stub.NewestActivityAt = t.UnixMilli()
	}
	return stub
}

// SnapshotProjected builds a projected snapshot containing ONLY:
//   - Roots that are in the active closure (materialized as full sessions).
//   - The active closure (sessions that are busy/retry/pending-input/recent
//     plus all ancestors needed for tree connectivity).
//   - Frontier stubs: for each materialized session, every child NOT in the
//     active closure is emitted as a CollapsedBranchStub.
//   - Idle root stubs: roots whose entire subtree is idle are emitted as a
//     single stub each (the client renders a collapsed root row).
//
// The snapshot carries Projected=true and the given cause. Messages are
// included only for sessions in BOTH the active closure AND messagesFor (or
// all active sessions if messagesFor is nil). This preserves transcript
// orthogonality (Gate F): hidden/stubbed sessions never carry messages.
//
// Cost: O(|roots| + |active_closure| × depth + |frontier|), NOT O(n). The
// 8 incremental indexes (Phase 1) make every per-node read O(1).
func (s *Store) SnapshotProjected(messagesFor map[string]bool, cause string) Snapshot {
	s.mu.RLock()

	cutoffVersion, cutoffDuration := projectionCutoff()
	cutoff := time.Now().Add(-cutoffDuration)
	active := s.computeActiveClosureLocked(cutoff)

	// Determine which sessions get messages. messagesFor nil → all active.
	// messagesFor non-nil → only active sessions in messagesFor.
	msgScope := func(sid string) bool {
		if !active[sid] {
			return false
		}
		if messagesFor != nil && !messagesFor[sid] {
			return false
		}
		return true
	}
	// inScope: structural data ships for active sessions only.
	inScope := func(sid string) bool {
		return active[sid]
	}

	// --- CAPTURE PHASE (under s.mu.RLock) ---
	epoch := s.epoch
	seq := s.seq
	structuralRevision := s.structuralRevision

	// Per-session scalar facts for active sessions only.
	sessions := make(map[string]snapSessionCap, len(active))
	subtreeBusyActive := make(map[string]bool, len(active))
	for sid := range active {
		se := s.sessions[sid]
		if se == nil {
			continue
		}
		sessions[sid] = snapSessionCap{
			info:              append([]byte(nil), se.info...),
			hasAssistant:      se.hasAssistant,
			lastAsstCompleted: se.lastAsstCompleted,
			lastAsstEmpty:     se.lastAsstEmpty,
			lastFinish:        se.lastFinish,
			lastTokens:        append([]byte(nil), se.lastTokens...),
			lastAgent:         se.lastAgent,
			currentVerbTool:   se.currentVerb.Tool,
			currentVerbState:  append([]byte(nil), se.currentVerb.State...),
			msgLoaded:         s.msgLoaded[sid],
			hasMessages:       s.messages[sid] != nil,
			hasQuestions:      len(s.questions[sid]) > 0,
			hasPerms:          len(s.perms[sid]) > 0,
			permBlocked:       s.permBlocked[sid],
			activity:          s.activity[sid],
		}
		// Capture subtreeBusy under RLock — used in materialization phase
		// (after RUnlock) to avoid racing concurrent writers. Mirrors the
		// existing Snapshot()'s capture of computeSubtreeBusyLocked().
		subtreeBusyActive[sid] = s.subtreeBusyCount[sid] > 0
	}

	// Questions, activity, unread, todos, perms, statuses — active only.
	questions := map[string][][]byte{}
	for sid := range active {
		m := s.questions[sid]
		var qs [][]byte
		for _, q := range m {
			qs = append(qs, append([]byte(nil), q...))
		}
		questions[sid] = qs
	}
	activityMap := map[string]string{}
	for sid := range active {
		activityMap[sid] = s.activity[sid]
	}
	unread := make([]string, 0, len(s.unread))
	for id := range s.unread {
		if inScope(id) {
			unread = append(unread, id)
		}
	}
	todos := map[string][]byte{}
	for sid := range active {
		if t := s.todos[sid]; t != nil {
			todos[sid] = append([]byte(nil), t...)
		}
	}
	perms := map[string][][]byte{}
	for sid := range active {
		m := s.perms[sid]
		var ps [][]byte
		for _, perm := range m {
			ps = append(ps, append([]byte(nil), perm...))
		}
		perms[sid] = ps
	}
	statuses := map[string][]byte{}
	for sid := range active {
		if st := s.statuses[sid]; st != nil {
			statuses[sid] = append([]byte(nil), st...)
		}
	}

	// Messages: only for sessions in msgScope (active + messagesFor).
	messages := map[string][]snapMessageCap{}
	for sid := range active {
		if !msgScope(sid) {
			continue
		}
		sm := s.messages[sid]
		if sm == nil {
			continue
		}
		list := make([]snapMessageCap, 0, len(sm.order))
		for _, mid := range sm.order {
			me := sm.byID[mid]
			if me == nil {
				continue
			}
			mc := snapMessageCap{
				info: append([]byte(nil), me.info...),
			}
			mc.parts = make([]snapPartCap, 0, len(me.partOrder))
			for _, pid := range me.partOrder {
				pc := snapPartCap{
					id:   pid,
					base: append([]byte(nil), me.parts[pid]...),
				}
				if len(me.deltaBuf) > 0 {
					for k, buf := range me.deltaBuf {
						dpid, field, ok := strings.Cut(k, "\x00")
						if !ok || dpid != pid {
							continue
						}
						if pc.deltas == nil {
							pc.deltas = map[string]string{}
						}
						pc.deltas[field] = captureDeltaText(buf)
					}
				}
				mc.parts = append(mc.parts, pc)
			}
			list = append(list, mc)
		}
		messages[sid] = list
	}

	// Build stubs: for each active session, walk children and emit a stub for
	// each child NOT in active. Also emit stubs for idle roots (roots not in
	// active).
	stubs := make([]CollapsedBranchStub, 0)
	stubSeen := map[string]bool{} // deduplicate (a child could appear under multiple parents via reparent edge cases)
	emitStub := func(id string) {
		if s.sessions[id] == nil || stubSeen[id] {
			return
		}
		stubSeen[id] = true
		stubs = append(stubs, s.buildStubLocked(id, cutoff, structuralRevision))
	}
	// Idle roots: roots whose entire subtree is idle → single stub each.
	for _, rootID := range s.rootIDs {
		if !active[rootID] {
			emitStub(rootID)
		}
	}
	// Frontier: children of active sessions that are NOT active → stubs.
	for sid := range active {
		for _, childID := range s.children[sid] {
			if !active[childID] {
				emitStub(childID)
			}
		}
	}

	s.mu.RUnlock()

	// --- MATERIALIZATION PHASE (NO LOCK) ---
	if snapshotMaterializeHook != nil {
		snapshotMaterializeHook()
	}

	snap := Snapshot{
		Epoch:              epoch,
		Seq:                seq,
		StructuralRevision: structuralRevision,
		Projected:          true,
		Cause:              cause,
		Stubs:              stubs,
		CutoffVersion:      cutoffVersion,
		CutoffMs:           uint64(cutoffDuration.Milliseconds()),
		Messages:           map[string][]MessageWithParts{},
		MessageWindows:     map[string]WindowMeta{},
		Todos:              map[string]json.RawMessage{},
		Permissions:        map[string][]json.RawMessage{},
		Questions:          map[string][]json.RawMessage{},
		Statuses:           map[string]json.RawMessage{},
		Activity:           map[string]string{},
		Gate:               map[string]GateFacts{},
		LastAgents:         map[string]string{},
		CurrentVerbs:       map[string]VerbFacet{},
	}

	for sid, sc := range sessions {
		act := sc.activity
		if act == "" {
			act = ActivityIdle
		}
		snap.Gate[sid] = GateFacts{
			Activity:               act,
			Hydrated:               sc.msgLoaded || sc.hasMessages,
			MessagesLoaded:         sc.msgLoaded,
			LastAssistantCompleted: sc.hasAssistant && sc.lastAsstCompleted,
			LastAssistantEmpty:     sc.lastAsstEmpty,
			FinishReason:           sc.lastFinish,
			SubtreeBusy:            subtreeBusyActive[sid], // captured under RLock above
			PendingQuestion:        sc.hasQuestions,
			PendingPermission:      sc.hasPerms,
			PermissionBlocked:      sc.permBlocked,
			Tokens:                 sc.lastTokens,
		}
		if sc.lastAgent != "" {
			snap.LastAgents[sid] = sc.lastAgent
		}
		if sc.currentVerbTool != "" {
			snap.CurrentVerbs[sid] = VerbFacet{
				Tool:  sc.currentVerbTool,
				State: sc.currentVerbState,
			}
		}
		snap.Sessions = append(snap.Sessions, sc.info)
	}
	for sid, qs := range questions {
		if len(qs) == 0 {
			continue
		}
		out := make([]json.RawMessage, len(qs))
		for i, q := range qs {
			out[i] = q
		}
		snap.Questions[sid] = out
	}
	for sid, st := range activityMap {
		snap.Activity[sid] = st
	}
	snap.Unread = unread
	for sid, t := range todos {
		snap.Todos[sid] = t
	}
	for sid, ps := range perms {
		if len(ps) == 0 {
			continue
		}
		out := make([]json.RawMessage, len(ps))
		for i, p := range ps {
			out[i] = p
		}
		out = dedupRawMessages(out)
		snap.Permissions[sid] = out
	}
	for sid, st := range statuses {
		snap.Statuses[sid] = st
	}
	for sid, list := range messages {
		out := make([]MessageWithParts, 0, len(list))
		for _, mc := range list {
			parts := make([]json.RawMessage, 0, len(mc.parts))
			for _, pc := range mc.parts {
				parts = append(parts, projectPartCaptured(pc))
			}
			out = append(out, MessageWithParts{
				Info:  mc.info,
				Parts: parts,
			})
		}
		bounded, meta := projectMessageWindow(out, WindowMaxCount, WindowMaxBytes)
		snap.Messages[sid] = bounded
		snap.MessageWindows[sid] = meta
	}
	return snap
}

// SnapshotBranch returns a projected snapshot for a lazy-expand request:
// materializes the children of parentID as full sessions, plus stubs for the
// grandchildren (children of materialized sessions that are idle). This is
// the response shape for GET /vh/sessions/branch?id=<frontier-id>&cursor=.
//
// Pagination is continuation-based: cursor is the last child ID from the
// previous page (empty for the first page). Returns at most `limit` children;
// if limit <= 0, defaults to defaultBranchExpandLimit. The second return value
// is the next cursor (empty if this is the last page) — the HTTP handler
// surfaces it as an X-VH-Branch-Cursor response header.
//
// Pure read under RLock. The snapshot carries Projected=true, Cause="lazy-expand".
// The client merges it via the projected merge path (upsert sessions + stubs).
func (s *Store) SnapshotBranch(parentID string, cursor string, limit int) (Snapshot, string) {
	// Clamp limit: an untrusted caller (handleBranch parses ?limit= from the
	// URL) could pass a huge value that overflows start+limit below. Clamp to
	// the default cap so the end-index arithmetic stays in range. This is the
	// single source of truth — the HTTP layer parses but does not clamp.
	if limit <= 0 || limit > defaultBranchExpandLimit {
		limit = defaultBranchExpandLimit
	}
	s.mu.RLock()

	cutoffVersion, cutoffDuration := projectionCutoff()
	cutoff := time.Now().Add(-cutoffDuration)
	allChildren := s.children[parentID]

	// Find the starting position from the cursor.
	start := 0
	if cursor != "" {
		for i, c := range allChildren {
			if c == cursor {
				start = i + 1
				break
			}
		}
	}
	end := start + limit
	if end > len(allChildren) {
		end = len(allChildren)
	}
	batch := allChildren[start:end]
	// nextCursor is the last child in the batch, or empty if this is the last page.
	nextCursor := ""
	if end < len(allChildren) {
		nextCursor = allChildren[end-1]
	}
	// Build the active set: the batch children are always materialized.
	// Additionally, descend into each child's subtree to find active descendants.
	active := map[string]bool{}
	for _, childID := range batch {
		active[childID] = true
		s.descendActiveClosureLocked(childID, cutoff, active)
	}

	epoch := s.epoch
	seq := s.seq
	structuralRevision := s.structuralRevision

	// Capture per-session state for the active set.
	sessions := make(map[string]snapSessionCap, len(active))
	subtreeBusyActive := make(map[string]bool, len(active))
	for sid := range active {
		se := s.sessions[sid]
		if se == nil {
			continue
		}
		sessions[sid] = snapSessionCap{
			info:              append([]byte(nil), se.info...),
			hasAssistant:      se.hasAssistant,
			lastAsstCompleted: se.lastAsstCompleted,
			lastAsstEmpty:     se.lastAsstEmpty,
			lastFinish:        se.lastFinish,
			lastTokens:        append([]byte(nil), se.lastTokens...),
			lastAgent:         se.lastAgent,
			currentVerbTool:   se.currentVerb.Tool,
			currentVerbState:  append([]byte(nil), se.currentVerb.State...),
			msgLoaded:         s.msgLoaded[sid],
			hasMessages:       s.messages[sid] != nil,
			hasQuestions:      len(s.questions[sid]) > 0,
			hasPerms:          len(s.perms[sid]) > 0,
			permBlocked:       s.permBlocked[sid],
			activity:          s.activity[sid],
		}
		// Capture subtreeBusy under RLock — used in materialization phase
		// (after RUnlock) to avoid racing concurrent writers.
		subtreeBusyActive[sid] = s.subtreeBusyCount[sid] > 0
	}

	// Capture questions/activity/unread/todos/perms/statuses for active sessions.
	questions := map[string][][]byte{}
	for sid := range active {
		m := s.questions[sid]
		var qs [][]byte
		for _, q := range m {
			qs = append(qs, append([]byte(nil), q...))
		}
		questions[sid] = qs
	}
	activityMap := map[string]string{}
	for sid := range active {
		activityMap[sid] = s.activity[sid]
	}
	unread := make([]string, 0)
	for id := range s.unread {
		if active[id] {
			unread = append(unread, id)
		}
	}
	todos := map[string][]byte{}
	for sid := range active {
		if t := s.todos[sid]; t != nil {
			todos[sid] = append([]byte(nil), t...)
		}
	}
	perms := map[string][][]byte{}
	for sid := range active {
		m := s.perms[sid]
		var ps [][]byte
		for _, perm := range m {
			ps = append(ps, append([]byte(nil), perm...))
		}
		perms[sid] = ps
	}
	statuses := map[string][]byte{}
	for sid := range active {
		if st := s.statuses[sid]; st != nil {
			statuses[sid] = append([]byte(nil), st...)
		}
	}

	// Build frontier stubs: children of active sessions that are NOT active.
	stubs := make([]CollapsedBranchStub, 0)
	stubSeen := map[string]bool{}
	emitStub := func(id string) {
		if s.sessions[id] == nil || stubSeen[id] {
			return
		}
		stubSeen[id] = true
		stubs = append(stubs, s.buildStubLocked(id, cutoff, structuralRevision))
	}
	for sid := range active {
		for _, childID := range s.children[sid] {
			if !active[childID] {
				emitStub(childID)
			}
		}
	}

	s.mu.RUnlock()

	// --- MATERIALIZATION PHASE (NO LOCK) ---
	if snapshotMaterializeHook != nil {
		snapshotMaterializeHook()
	}

	snap := Snapshot{
		Epoch:              epoch,
		Seq:                seq,
		StructuralRevision: structuralRevision,
		Projected:          true,
		Cause:              "lazy-expand",
		Stubs:              stubs,
		CutoffVersion:      cutoffVersion,
		CutoffMs:           uint64(cutoffDuration.Milliseconds()),
		Messages:           map[string][]MessageWithParts{},
		MessageWindows:     map[string]WindowMeta{},
		Todos:              map[string]json.RawMessage{},
		Permissions:        map[string][]json.RawMessage{},
		Questions:          map[string][]json.RawMessage{},
		Statuses:           map[string]json.RawMessage{},
		Activity:           map[string]string{},
		Gate:               map[string]GateFacts{},
		LastAgents:         map[string]string{},
		CurrentVerbs:       map[string]VerbFacet{},
	}

	for sid, sc := range sessions {
		act := sc.activity
		if act == "" {
			act = ActivityIdle
		}
		snap.Gate[sid] = GateFacts{
			Activity:               act,
			Hydrated:               sc.msgLoaded || sc.hasMessages,
			MessagesLoaded:         sc.msgLoaded,
			LastAssistantCompleted: sc.hasAssistant && sc.lastAsstCompleted,
			LastAssistantEmpty:     sc.lastAsstEmpty,
			FinishReason:           sc.lastFinish,
			SubtreeBusy:            subtreeBusyActive[sid],
			PendingQuestion:        sc.hasQuestions,
			PendingPermission:      sc.hasPerms,
			PermissionBlocked:      sc.permBlocked,
			Tokens:                 sc.lastTokens,
		}
		if sc.lastAgent != "" {
			snap.LastAgents[sid] = sc.lastAgent
		}
		if sc.currentVerbTool != "" {
			snap.CurrentVerbs[sid] = VerbFacet{
				Tool:  sc.currentVerbTool,
				State: sc.currentVerbState,
			}
		}
		snap.Sessions = append(snap.Sessions, sc.info)
	}
	for sid, qs := range questions {
		if len(qs) == 0 {
			continue
		}
		out := make([]json.RawMessage, len(qs))
		for i, q := range qs {
			out[i] = q
		}
		snap.Questions[sid] = out
	}
	for sid, st := range activityMap {
		snap.Activity[sid] = st
	}
	snap.Unread = unread
	for sid, t := range todos {
		snap.Todos[sid] = t
	}
	for sid, ps := range perms {
		if len(ps) == 0 {
			continue
		}
		out := make([]json.RawMessage, len(ps))
		for i, p := range ps {
			out[i] = p
		}
		out = dedupRawMessages(out)
		snap.Permissions[sid] = out
	}
	for sid, st := range statuses {
		snap.Statuses[sid] = st
	}
	return snap, nextCursor
}
