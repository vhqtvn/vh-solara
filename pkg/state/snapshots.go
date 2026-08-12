// Package state: the snapshot concern — the read-projection surface of
// the store, mechanically extracted from store.go (reference model:
// subtree_indexes.go). The functions here are READ PROJECTIONS of the store,
// with ONE write-side caveat: the three detail-snapshot entrypoints (Snapshot /
// SnapshotWithTree / SnapshotWithTreePartial) acquire the WRITE lock so they
// can atomically flush buffered streaming deltas (flushAllBufferedDeltasLocked,
// the B-F1 suffix-offset coherence fix) BEFORE capturing — see the Snapshot doc
// comment. That flush is a WRITE (mutates me.parts, emits, advances
// deltaSentLen, bumps msgRev for any flushed session); a quiescent snapshot with
// nothing buffered performs no flush and is observationally a pure read. The
// capture itself (captureSnapshotLocked / capturePartialDetailLocked) only needs
// RLock and copies mutable state into private copies; materializeSnapshot
// assembles the public result lock-free (Discipline A). The remaining
// accessors (Head / RunningRoots / RootCount / Replay / SendableNow /
// Descendants / DescendantSummaries / SubtreeTodos / SessionIDs / HasSession /
// LoadedSessions / IsMessagesLoaded) are simple reads under RLock. The Store
// struct and its single s.mu RWMutex stay in store.go and are shared across
// this whole package (same-package file split; no protocol change).
// Behavior-preserving verbatim move; the no-aliasing invariant is
// documented on Snapshot.
package state

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
)

// descendantsLocked returns id plus every session transitively parented by it.
//
// ORDER CONTRACT (load-bearing, pinned by TestDescendantsOrderIsParentFirst):
// the result is PARENT-FIRST — a DFS pre-order walk where id itself is appended
// to `out` BEFORE any of its descendants are pushed to the stack, and within the
// walk every parent appears before its own descendants. This ordering is NOT
// incidental. It is relied on by pkg/web/archive.go's runArchiveCascade, which
// freezes the archive scope via Store.Descendants (the exported wrapper below)
// and iterates it IN ORDER, adding each successfully-archived id to succeededSet
// as it goes. classifyArchiveFailure → descendantOfSucceeded then walks a
// captured parentOf chain UPWARD from a failed id and returns true if ANY
// ancestor is in succeededSet — which is sound ONLY because Descendants yields
// every ancestor before the descendant, so by the time a failed id is
// classified, all of its already-processed ancestors are in succeededSet. If
// this traversal were ever changed to child-first (or any order where a
// descendant precedes an ancestor), a just-orphaned child would be
// misclassified as a root failure instead of a descendant-of-succeeded. Any
// refactor of this walk MUST preserve ancestor-before-descendant, or
// descendantOfSucceeded must be updated in lockstep. Sibling order is NOT
// guaranteed (the children map is built by iterating s.sessions, whose order is
// nondeterministic); only the ancestor-before-descendant property is contracted.
func (s *Store) descendantsLocked(id string) []string {
	children := map[string][]string{}
	for _, se := range s.sessions {
		if se.parentID != "" {
			children[se.parentID] = append(children[se.parentID], se.id)
		}
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

// Descendants returns id plus every live session transitively parented by it
// (used to cascade an archive across a session's subsessions).
//
// The result is PARENT-FIRST (DFS pre-order); see descendantsLocked's ORDER
// CONTRACT — that ordering is load-bearing for pkg/web/archive.go's
// descendantOfSucceeded archive classification (a child is classified against a
// succeededSet that is populated in iteration order, so the parent must appear
// before the child). Returns nil when id is unknown to the live store.
func (s *Store) Descendants(id string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if s.sessions[id] == nil {
		return nil
	}
	return s.descendantsLocked(id)
}

// SessionSummary is the per-session projection of the point endpoints that
// return a server-authoritative affected/descendant set (P4 descendants, P5
// subtree-todos): id + title + parentID, without the full session info blob.
type SessionSummary struct {
	ID       string `json:"id"`
	Title    string `json:"title"`
	ParentID string `json:"parentID"`
}

// FingerprintIDs returns a stable, collision-resistant fingerprint of a
// descendant id-set: hex(sha256("\n".join(sorted(ids)))). Pure; no store
// access, no mutation of the input slice. Used by the archive-preview drift
// fence (C5): DescendantSummaries computes it under-lock from the ids slice
// descendantsLocked already built (preview side), and pkg/web.handleArchive
// recomputes it from the live affected set (commit side) and 409-rejects on
// mismatch.
//
// Idempotent for a given set; changes iff the set's MEMBERSHIP changes:
// order-independent (sorted before hashing), and title / parentID-within-set
// changes do NOT change it. An internal reparent (an id stays inside the
// subtree) therefore does NOT reject — only spawn / delete / reparent across
// the subtree boundary do (membership changes). Full 64-char hex (no
// truncation — simplest, no collision analysis needed).
func FingerprintIDs(ids []string) string {
	sorted := make([]string, len(ids))
	copy(sorted, ids) // do not mutate the caller's slice
	sort.Strings(sorted)
	h := sha256.Sum256([]byte(strings.Join(sorted, "\n")))
	return hex.EncodeToString(h[:])
}

// DescendantSummaries returns id plus every live session transitively parented
// by it (as SessionSummary), captured together with the Store's epoch and head
// seq UNDER THE SAME RLock — so the {epoch, revision} envelope the P4 endpoint
// emits is a coherent bound on the returned data (no TOCTOU between the walk
// and the revision read). Returns nil descs when id is unknown to the live
// store; the handler coerces nil → [] for the wire.
//
// Per Q3, revision is advisory (for stale-response suppression / cache
// validation / diagnostics) and is NOT required to equal the latest live tree
// revision by the time the client reads it; capturing it under the same lock as
// the walk simply avoids returning a revision that predates the data.
//
// C5: the returned fingerprint is the stateless subtree-id-set fingerprint
// (FingerprintIDs) of the walked ids, computed under the same RLock so it is
// coherent with the returned descs (no TOCTOU between the data and the fence
// token). The archive commit handler recomputes it from the live affected set
// and 409-rejects on mismatch. For an unknown id, the fingerprint is computed
// over the seed set {id} — this matches the archive commit's empty-set
// fallback (archive.go: len(affected)==0 → [body.SessionID]), keeping
// preview↔commit coherent on the orphan/ghost path (a fingerprint of the empty
// set would always mismatch the fallback and stuck-loop the dialog).
func (s *Store) DescendantSummaries(id string) (descs []SessionSummary, fingerprint, epoch string, seq uint64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	epoch = s.epoch
	seq = s.seq
	if s.sessions[id] == nil {
		return nil, FingerprintIDs([]string{id}), epoch, seq
	}
	ids := s.descendantsLocked(id)
	fingerprint = FingerprintIDs(ids)
	descs = make([]SessionSummary, 0, len(ids))
	for _, sid := range ids {
		se := s.sessions[sid]
		if se == nil {
			continue // defensive: descendantsLocked only yields live ids
		}
		var t struct {
			Title string `json:"title"`
		}
		_ = json.Unmarshal(se.info, &t) // title is best-effort; missing → ""
		descs = append(descs, SessionSummary{
			ID:       se.id,
			Title:    t.Title,
			ParentID: se.parentID,
		})
	}
	return descs, fingerprint, epoch, seq
}

// TodoTotals is the subtree-todo summary for the "Tasks N active · M left"
// indicator: active = in_progress, left = items whose status is neither
// completed nor cancelled (covers pending, in_progress, and any unknown
// status — matches the deleted FE sessionTodoCounts exactly), total = all.
type TodoTotals struct {
	Active int `json:"active"`
	Left   int `json:"left"`
	Total  int `json:"total"`
}

// SubtreeTodos returns the agent todos (OpenCode TodoWrite) for a session and
// every transitively-parented descendant, rolled up in subtree order, plus the
// active/left/total summary — captured together with the Store's epoch and head
// seq UNDER THE SAME RLock (no TOCTOU between the rollup and the revision read).
//
// Each item is returned as raw JSON (json.RawMessage) so the client receives the
// exact OpenCode todo payload (content/status/priority/…) untouched — the server
// is a passthrough, not a projection. Totals are computed server-side by reading
// each item's `status` field, mirroring the FE sessionTodoCounts the P5 endpoint
// replaces.
//
// s.todos[id] holds the RAW todo.updated event properties — either the daemon's
// `{"sessionID","todos":[…]}` envelope (the form OpenCode always emits and the
// aggregator always stores) or, defensively, a bare `[…]` array.
// extractTodoItems normalizes both forms (mirrors the FE normalizeTodos).
//
// Returns nil items when id is unknown to the live store; the handler coerces
// nil → [] for the wire. A known id with no todos returns nil items too (the
// handler coerces); totals are zero.
func (s *Store) SubtreeTodos(id string) (items []json.RawMessage, totals TodoTotals, epoch string, seq uint64) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	epoch = s.epoch
	seq = s.seq
	if s.sessions[id] == nil {
		return nil, totals, epoch, seq
	}
	for _, sid := range s.descendantsLocked(id) {
		raw, ok := s.todos[sid]
		if !ok || len(raw) == 0 {
			continue
		}
		for _, item := range extractTodoItems(raw) {
			items = append(items, item)
			var t struct {
				Status string `json:"status"`
			}
			_ = json.Unmarshal(item, &t) // missing status → "" (counts as left, not active)
			totals.Total++
			if t.Status == "in_progress" {
				totals.Active++
			}
			if t.Status != "completed" && t.Status != "cancelled" {
				totals.Left++
			}
		}
	}
	return items, totals, epoch, seq
}

// extractTodoItems pulls the todo-item array out of the raw stored payload. The
// aggregator stores s.todos[id] = ev.Properties verbatim, where Properties is
// the `{"sessionID":"…","todos":[…]}` envelope OpenCode emits on todo.updated.
// A bare `[…]` array is also accepted defensively (mirrors the FE
// normalizeTodos) so a future producer that drops the envelope still works.
func extractTodoItems(raw json.RawMessage) []json.RawMessage {
	// Envelope form: {"todos": [...]}.
	var env struct {
		Todos []json.RawMessage `json:"todos"`
	}
	if json.Unmarshal(raw, &env) == nil && env.Todos != nil {
		return env.Todos
	}
	// Bare-array form: [...].
	var arr []json.RawMessage
	if json.Unmarshal(raw, &arr) == nil {
		return arr
	}
	return nil
}

// --- Snapshot capture types ---
//
// These are PRIVATE copies of the mutable store fields read during Snapshot's
// materialization. They are populated under s.mu.RLock (the CAPTURE phase) so
// the MATERIALIZATION phase can run after s.mu.RUnlock without aliasing any
// store-owned memory. See the ownership audit in the Snapshot doc comment:
// every store map (sessions/messages/todos/perms/questions/statuses/activity/
// unread) is mutated in place by writers; sessionEntry scalars are mutated in
// place by recomputeLastAssistantLocked / setCurrentVerbLocked; messageEntry
// fields (parts map, partOrder slice, deltaBuf strings.Builders) are mutated in
// place. NOTHING read after RUnlock may alias store memory, so each field here
// that came from a byte slice or map is a fresh copy taken under the lock.

// snapSessionCap holds the per-session scalar facts the Gate / LastAgents /
// CurrentVerbs / Sessions projection reads. Every json.RawMessage field is a
// private byte copy captured under the lock.
type snapSessionCap struct {
	info              json.RawMessage // copy of se.info
	hasAssistant      bool
	lastAsstCompleted bool
	lastAsstEmpty     bool
	lastFinish        string
	lastTokens        json.RawMessage // copy of se.lastTokens
	lastAgent         string
	currentVerbTool   string
	currentVerbState  json.RawMessage // copy of se.currentVerb.State
	// Existence facts read from store-level maps.
	msgLoaded   bool // s.msgLoaded[sid]
	hasMessages bool // s.messages[sid] != nil
	// msgResident is the source-derived counterpart of msgLoaded: the result of
	// latestAssistantResidentLocked(sid) (true unless the newest COMPLETED
	// assistant has zero resident parts). The gate's MessagesLoaded is
	// msgLoaded && msgResident, so it can never report loaded with zero parts on
	// a completed message. See IsMessagesLoaded / latestAssistantResidentLocked.
	msgResident  bool   // s.latestAssistantResidentLocked(sid)
	hasQuestions bool   // len(s.questions[sid]) > 0
	hasPerms     bool   // len(s.perms[sid]) > 0
	permBlocked  bool   // s.permBlocked[sid]
	activity     string // s.activity[sid] ("" if absent)
}

// snapPartCap holds one captured part: a private byte copy of its base plus the
// per-field buffered delta text (if any) for this partID. deltas is nil when the
// part has no buffered deltaBuf entries (the common case), in which case
// projectPartCaptured returns base unchanged.
type snapPartCap struct {
	id     string
	base   json.RawMessage   // copy of me.parts[partID]
	deltas map[string]string // field -> cloned builder text for matching partID; nil if none
}

// snapMessageCap holds one captured message: a private byte copy of its info and
// its parts in partOrder, each pre-projected into a snapPartCap.
type snapMessageCap struct {
	info  json.RawMessage // copy of me.info
	parts []snapPartCap   // in me.partOrder
}

// captureDeltaText returns an OWNERSHIP-INDEPENDENT copy of buf's current
// accumulated text for the Snapshot capture phase. strings.Clone is REQUIRED
// here: in Go 1.25, (*strings.Builder).String() is implemented as
// unsafe.String(unsafe.SliceData(b.buf), len(b.buf)) — it does NOT copy, so a
// bare buf.String() would alias the builder's mutable backing array and survive
// past RUnlock as a live reference into store-owned memory (violating the
// Snapshot capture invariant that nothing read after RUnlock may alias store
// memory). strings.Clone allocates a fresh backing array the builder can never
// reach. Extracted as a named helper so the ownership property is testable
// directly (the full Snapshot path re-marshals the delta into fresh JSON bytes,
// which would mask the aliasing). Pinned by
// TestSnapshotDeltaCaptureIsOwnershipIndependent.
func captureDeltaText(buf *strings.Builder) string {
	return strings.Clone(buf.String())
}

// projectPartCaptured replicates the former projectPartLocked overlay logic but
// operates on a captured part (snapPartCap) so it can run OUTSIDE s.mu. The
// input bytes (base) and the delta strings are already private copies taken
// under the lock, so the returned slice never aliases store memory and is safe
// to retain past RUnlock. Called only by Snapshot's materialize phase.
//
// Mirrors the prior method byte-for-byte: no deltas -> return base as-is;
// overlay path decodes base into a fresh map, applies each buffered field,
// re-marshals, and falls back to base on a marshal error. The id is carried on
// the capture only to seed the defensive empty-base placeholder, matching the
// prior behavior exactly.
func projectPartCaptured(pc snapPartCap) json.RawMessage {
	if len(pc.deltas) == 0 {
		return pc.base
	}
	var part map[string]any
	if len(pc.base) > 0 {
		_ = json.Unmarshal(pc.base, &part)
	}
	if part == nil {
		part = map[string]any{"id": pc.id, "type": "text"}
	}
	for field, txt := range pc.deltas {
		part[field] = txt
	}
	if updated, err := json.Marshal(part); err == nil {
		return updated
	}
	return pc.base
}

// Snapshot returns the current view and the head seq. The filter has THREE
// shapes, all load-bearing for the web session-load latency contract:
//   - messagesFor == nil          → firehose: every session's messages AND every
//     per-session structural row (Sessions/Gate/Questions/Activity/LastAgents/
//     CurrentVerbs/Permissions/Todos/Statuses/Unread). Used by ?sessions=all.
//   - messagesFor != nil && empty → Stream-1 tree owner: the FULL structural
//     tree for ALL sessions (the session-list view) but NO messages. The full
//     tree here is sacred — it is the session-list view.
//   - messagesFor != nil && > 0   → Stream-2 "open one session": SCOPE. Only the
//     SELECTED sessions' structural rows AND messages ship; every other session
//     is omitted entirely from the per-session-keyed maps. The Stream-2 consumer
//     (applySessionSnapshot / fetchSessionMessages) reads only
//     snap.messages[id] + snap.gate[id].messagesLoaded, so omitting unselected
//     sessions' structural rows is safe and avoids shipping the whole tree on
//     every "open one session" request.
//
// scopeSelected gates ONLY the len > 0 case; nil and empty-{} are UNCHANGED.
//
// Snapshot runs in two phases. The first (FLUSH+CAPTURE) holds the WRITE lock:
// it flushes buffered streaming deltas so the snapshot baseline coheres with
// the part.append suffix offset contract (B-F1 fix), then captures. The flush
// is a WRITE (it mutates me.parts, emits events, advances deltaSentLen), which
// is why the lock is Lock (not RLock). The second phase (MATERIALIZE) is a pure
// lock-free assembly from private copies:
//
//  0. FLUSH+CAPTURE under s.mu.Lock: first flushAllBufferedDeltasLocked flushes
//     every accumulator with unflushed bytes (emit + advance deltaSentLen +
//     bump deltaLastEmit + bumpMsgRev) so me.parts becomes authoritative and
//     deltaSentLen == len(field text) == the projected snapshot field length;
//     then captureSnapshotLocked copies every mutable field the materialization
//     will read into locals (snapSessionCap / snapPartCap / snapMessageCap plus
//     the per-session byte-slice maps). All json.RawMessage bytes are COPIED so
//     the locals never alias store-owned backing arrays. The flush and capture
//     share ONE lock span so no new delta can buffer between them — this is the
//     invariant that makes the baseline cohere. Without the flush, a cursorless
//     snapshot taken while deltas sit behind the throttle would project the full
//     accumulated text (via captureDeltaText) but leave deltaSentLen stale, so
//     the next suffix would start behind the client's baseline (byte-offset
//     contract violation + re-send of snapshot bytes). The subtreeBusy
//     projection is built in the capture by reading the maintained
//     subtreeBusyCount index per node; its self-contained result map is kept
//     whole.
//
//  1. MATERIALIZE after s.mu.Unlock: build the Snapshot struct purely from the
//     captured locals, calling projectPartCaptured per part. The expensive JSON
//     unmarshal+marshal for parts with buffered deltas happens HERE, outside the
//     lock. No field of s.* / se.* / me.* is read after Unlock.
//
// The lock window is flush+capture (both bounded: the flush touches only parts
// with unflushed bytes via hasUnflushedDeltasLocked; the capture copies bytes
// without heavy JSON work). The expensive JSON unmarshal+marshal for
// delta-overlaid parts runs in the lock-free materialize phase, so a concurrent
// Apply is NOT blocked behind it. Apply IS blocked behind the flush+capture
// span — that is expected and is the B-F1 correctness mechanism (the snapshot
// baseline must cohere with the suffix offset). The monotonic msgRev machinery
// (bumpMsgRev) is bumped by the flush for any session whose parts were flushed
// (so a concurrently-packaging cold batch discards its stale projection and
// retries with the post-flush text — correct, bounded by publishColdBatch's
// retry loop).
//
// All json.RawMessage bytes that escape the lock are conservatively COPIED so
// they never alias store-owned backing arrays (a later writer under the write
// lock would otherwise be free to replace those slices — copying keeps the
// snapshot safe under the race detector and against any future in-place
// mutation).
//
// OWNERSHIP AUDIT (why each capture copies what it does):
//   - Store maps (sessions/messages/todos/perms/questions/statuses/activity/
//     unread/permBlocked/msgLoaded) are all mutated IN PLACE by writers (delete
//     keys, set keys) → captured by value, scoped under the lock.
//   - sessionEntry pointers are replaced wholesale by upsertSessionLocked, AND
//     their scalar fields are mutated in place by recomputeLastAssistantLocked
//     and setCurrentVerbLocked → all scalar facts + the info/lastTokens/
//     currentVerb.State bytes are copied into snapSessionCap; no *sessionEntry
//     is retained past the lock release.
//   - messageEntry fields are mutated in place: upsertMessageLocked replaces
//     info/role/etc; upsertPartLocked does me.parts[id]=... and reassigns
//     me.partOrder; appendPartDeltaLocked mutates a strings.Builder VALUE in
//     place (the dangerous one) and reassigns me.deltaBuf[key] → info, the
//     partOrder slice, the parts bytes, and each matching deltaBuf entry's
//     builder text are all copied into snapMessageCap / snapPartCap; the
//     deltaBuf builders are snapshotted via captureDeltaText (strings.Clone of
//     the builder text at capture time), so the captured strings never alias
//     the builder's mutable backing array — a bare .String() would NOT suffice
//     in Go 1.25 (it returns unsafe.String over the builder's buffer, no copy).
func (s *Store) Snapshot(messagesFor map[string]bool) Snapshot {
	// B-F1 fix: flush buffered streaming deltas BEFORE capture so the snapshot
	// baseline agrees with the part.append suffix offset for opted-in
	// (part_delta=1) connections. The flush mutates me.parts + emits +
	// advances deltaSentLen, so it needs the WRITE lock; the flush and capture
	// MUST share one lock span so no new delta can buffer between them (the
	// invariant that makes the baseline cohere). Materialization stays
	// lock-free (the capture's private copies never alias store memory after
	// Unlock). See flushAllBufferedDeltasLocked.
	s.mu.Lock()
	s.flushAllBufferedDeltasLocked()
	c := s.captureSnapshotLocked(messagesFor)
	s.mu.Unlock()
	if snapshotMaterializeHook != nil {
		snapshotMaterializeHook()
	}
	return s.materializeSnapshot(c)
}

// snapshotCapture holds the private copies of every mutable store field the
// detail Snapshot materialization reads, captured under s.mu (the no-aliasing
// invariant: nothing read after the lock release aliases store memory).
// Extracted from store.go so SnapshotWithTree can run the detail capture inside
// the SAME lock as the tree computation (Q5 capture consolidation).
type snapshotCapture struct {
	epoch       string
	seq         uint64
	subtreeBusy map[string]bool
	sessions    map[string]snapSessionCap
	questions   map[string][][]byte
	activity    map[string]string
	unread      []string
	todos       map[string][]byte
	perms       map[string][][]byte
	statuses    map[string][]byte
	messages    map[string][]snapMessageCap
}

// captureSnapshotLocked is the CAPTURE PHASE of Snapshot. Caller MUST hold s.mu
// (at least RLock; the Snapshot entrypoints hold the WRITE Lock so the B-F1
// flush can run atomically before this — see Snapshot / flushAllBufferedDeltas
// Locked). It copies every mutable field into a snapshotCapture (private copies;
// nothing aliases store memory after return). Extracted verbatim from the
// former Snapshot capture phase so the no-aliasing invariant is preserved (Q5
// acceptance gate: no behavioral change to the capture).
func (s *Store) captureSnapshotLocked(messagesFor map[string]bool) snapshotCapture {
	scopeSelected := messagesFor != nil && len(messagesFor) > 0
	// inScope reports whether a session's per-session structural rows should
	// ship. When scopeSelected, only the selected sessions ship; nil/{} ship
	// every session (firehose / full tree).
	inScope := func(sid string) bool {
		if !scopeSelected {
			return true
		}
		return messagesFor[sid]
	}

	// --- CAPTURE PHASE (under s.mu, held by the caller) ---
	// Copy every mutable field the materialization will read into locals. After
	// the lock release NOTHING may alias store-owned memory — see the ownership
	// audit in the doc comment. Scoping (inScope / messagesFor) is applied HERE
	// so the materialize phase is a straight assembly.

	epoch := s.epoch
	seq := s.seq
	// subtreeBusy is the per-node projection of the maintained subtreeBusyCount
	// index — the SINGLE production source of the subtree-busy fact (L-05
	// collapse: count > 0 → busy). Built here by reading the index per node
	// (O(1) lookup each) instead of an independent O(n) tree recompute; the
	// index already aggregates each node's whole subtree, so a selected
	// session's subtree_busy correctly reflects its (possibly unselected)
	// descendants. Safe to keep whole and read post-RUnlock: it is a fresh
	// map[string]bool of value copies, aliasing nothing in the store.
	subtreeBusy := make(map[string]bool, len(s.sessions))
	for id := range s.sessions {
		subtreeBusy[id] = s.subtreeBusyCount[id] > 0
	}

	// Per-session scalar facts (Gate / LastAgents / CurrentVerbs / Sessions).
	sessions := make(map[string]snapSessionCap, len(s.sessions))
	for sid, se := range s.sessions {
		if !inScope(sid) {
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
			msgResident:       s.latestAssistantResidentLocked(sid),
			hasMessages:       s.messages[sid] != nil,
			hasQuestions:      len(s.questions[sid]) > 0,
			hasPerms:          len(s.perms[sid]) > 0,
			permBlocked:       s.permBlocked[sid],
			activity:          s.activity[sid],
		}
	}

	// Questions: per in-scope session, bytes copied. s.questions is a nested
	// map (sessionID -> questionID -> bytes); iteration order is nondeterministic
	// here exactly as in the prior append loop, so parity is set-equality.
	questions := map[string][][]byte{}
	for sid, m := range s.questions {
		if !inScope(sid) {
			continue
		}
		var qs [][]byte
		for _, q := range m {
			qs = append(qs, append([]byte(nil), q...))
		}
		questions[sid] = qs
	}
	// Activity: per in-scope session.
	activity := map[string]string{}
	for sid, st := range s.activity {
		if !inScope(sid) {
			continue
		}
		activity[sid] = st
	}
	// Unread: in-scope ids.
	unread := make([]string, 0, len(s.unread))
	for id := range s.unread {
		if inScope(id) {
			unread = append(unread, id)
		}
	}
	// Todos: per in-scope session, bytes copied.
	todos := map[string][]byte{}
	for sid, t := range s.todos {
		if !inScope(sid) {
			continue
		}
		todos[sid] = append([]byte(nil), t...)
	}
	// Permissions: per in-scope session, bytes copied. s.perms is a nested
	// map (sessionID -> permID -> bytes); iteration order is nondeterministic
	// here exactly as in the prior append loop.
	perms := map[string][][]byte{}
	for sid, m := range s.perms {
		if !inScope(sid) {
			continue
		}
		var ps [][]byte
		for _, perm := range m {
			ps = append(ps, append([]byte(nil), perm...))
		}
		perms[sid] = ps
	}
	// Statuses: per in-scope session, bytes copied.
	statuses := map[string][]byte{}
	for sid, st := range s.statuses {
		if !inScope(sid) {
			continue
		}
		statuses[sid] = append([]byte(nil), st...)
	}
	// Messages: ordered per session, with per-part capture (base bytes + the
	// matching deltaBuf entries snapshotted as field→text). Gated by messagesFor
	// (nil=all ship; empty=none ship; non-empty=only listed) — a SEPARATE gate
	// from inScope, identical to the prior code.
	messages := map[string][]snapMessageCap{}
	for sid, sm := range s.messages {
		if messagesFor != nil && !messagesFor[sid] {
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
				// Snapshot any buffered deltaBuf entries targeting this partID
				// as field→accumulated-text. Mirrors the former
				// projectPartLocked key scan; captureDeltaText returns an
				// OWNERSHIP-INDEPENDENT copy of the builder's current text. A
				// bare buf.String() is NOT enough here: in Go 1.25 it is
				// unsafe.String over the builder's mutable backing array (no
				// copy), so it would alias store-owned memory and survive past
				// RUnlock — violating the capture invariant that nothing read
				// after RUnlock aliases store memory. Proven by
				// TestSnapshotDeltaCaptureIsOwnershipIndependent.
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

	return snapshotCapture{
		epoch:       epoch,
		seq:         seq,
		subtreeBusy: subtreeBusy,
		sessions:    sessions,
		questions:   questions,
		activity:    activity,
		unread:      unread,
		todos:       todos,
		perms:       perms,
		statuses:    statuses,
		messages:    messages,
	}
}

// materializeSnapshot is the MATERIALIZATION PHASE of Snapshot. It runs WITHOUT
// holding s.mu, assembling the Snapshot purely from the captured locals (the
// no-aliasing invariant lets it read them lock-free). The test seam
// (snapshotMaterializeHook) fires in the thin Snapshot wrapper between RUnlock
// and the call to this method.
func (s *Store) materializeSnapshot(c snapshotCapture) Snapshot {
	epoch := c.epoch
	seq := c.seq
	subtreeBusy := c.subtreeBusy
	sessions := c.sessions
	questions := c.questions
	activity := c.activity
	unread := c.unread
	todos := c.todos
	perms := c.perms
	statuses := c.statuses
	messages := c.messages

	// --- MATERIALIZATION PHASE (NO LOCK) ---
	// Build the Snapshot purely from the captured locals. The captured byte
	// slices are already private copies, so they are assigned directly to the
	// output (no double-copy); the no-aliasing invariant holds because every
	// output slice is a fresh capture-time copy of store bytes. The JSON
	// unmarshal+marshal for parts with buffered deltas happens here.
	snap := Snapshot{
		Epoch:          epoch,
		Seq:            seq,
		Messages:       map[string][]MessageWithParts{},
		MessageWindows: map[string]WindowMeta{},
		Todos:          map[string]json.RawMessage{},
		Permissions:    map[string][]json.RawMessage{},
		Questions:      map[string][]json.RawMessage{},
		Statuses:       map[string]json.RawMessage{},
		Activity:       map[string]string{},
		Gate:           map[string]GateFacts{},
		LastAgents:     map[string]string{},
		CurrentVerbs:   map[string]VerbFacet{},
	}

	// Per-session gate facts + facets. Iterating the captured `sessions` map
	// (not s.sessions) — order is nondeterministic here exactly as it was in the
	// prior map iteration; parity is set-equality of elements.
	for sid, sc := range sessions {
		act := sc.activity
		if act == "" {
			act = ActivityIdle // a never-touched session renders idle
		}
		// hasMsg is the "some message state exists" predicate (live tail OR a
		// history hydrate). It feeds BOTH wire aliases during the
		// alias-during-transition (L-03): `hydrated` (retained) and `hasMessages`
		// (the exact name the SPA migrates to). Computed once and assigned to
		// both so the two wire fields provably carry the same value.
		hasMsg := sc.msgLoaded || sc.hasMessages
		snap.Gate[sid] = GateFacts{
			Activity: act,
			// We have message state (live events OR a history hydrate) iff
			// msgLoaded or a messages entry exists. When false, the message-
			// derived fields below are "not yet known", which a cold/un-opened
			// session after a restart can't be distinguished from in-flight
			// without this.
			Hydrated: hasMsg,
			// HasMessages is the alias of Hydrated — same value, exact name.
			HasMessages: hasMsg,
			// MessagesLoaded is the STRICT "full history fetched AND resident"
			// gate, derived from BOTH the msgLoaded fetch memo AND the actual
			// resident parts (msgResident). It is false when the newest
			// completed assistant has zero resident parts — UNLESS that exact
			// empty newest was confirmed as source-truth by a second reconcile
			// (confirmedEmptyNewest), in which case it is admitted. An
			// unconfirmed zero-parts newest triggers an open-path re-fetch
			// instead of lying "loaded". Mirrors the busyCount retirement
			// (c4c4ef1): derive from source, not the latch alone. See
			// IsMessagesLoaded / latestAssistantResidentLocked.
			MessagesLoaded:         sc.msgLoaded && sc.msgResident,
			LastAssistantCompleted: sc.hasAssistant && sc.lastAsstCompleted,
			LastAssistantEmpty:     sc.lastAsstEmpty,
			FinishReason:           sc.lastFinish,
			SubtreeBusy:            subtreeBusy[sid],
			PendingQuestion:        sc.hasQuestions,
			PendingPermission:      sc.hasPerms,
			PermissionBlocked:      sc.permBlocked,
			// PermissionWasBlocked is the alias of PermissionBlocked — same value,
			// exact name (L-09).
			PermissionWasBlocked: sc.permBlocked,
			// Tokens is the private byte copy captured above — assigned directly
			// (no aliasing; see the doc comment's copy invariant).
			Tokens: sc.lastTokens,
		}
		if sc.lastAgent != "" {
			snap.LastAgents[sid] = sc.lastAgent
		}
		// Surface the live current-activity facet (only sessions with a running
		// tool carry one) so a client renders the rich verb for an UNOPENED
		// subagent straight from the tree-only snapshot. State is the private
		// byte copy captured above.
		if sc.currentVerbTool != "" {
			snap.CurrentVerbs[sid] = VerbFacet{
				Tool:  sc.currentVerbTool,
				State: sc.currentVerbState,
			}
		}
		// Sessions slice: append each captured info bytes (already a copy).
		snap.Sessions = append(snap.Sessions, sc.info)
	}
	for sid, qs := range questions {
		// Preserve the original's omit-empty semantics: a session whose inner
		// map is empty must NOT appear in snap.Questions at all (the lazy-append
		// in the prior code never set the key when the inner loop body never
		// ran). Skipping an empty captured slice reproduces that exactly.
		if len(qs) == 0 {
			continue
		}
		out := make([]json.RawMessage, len(qs))
		for i, q := range qs {
			out[i] = q // captured copy
		}
		snap.Questions[sid] = out
	}
	for sid, st := range activity {
		snap.Activity[sid] = st
	}
	snap.Unread = unread
	for sid, t := range todos {
		snap.Todos[sid] = t // captured copy
	}
	for sid, ps := range perms {
		// Preserve the original's omit-empty semantics: a session whose inner
		// map is empty must NOT appear in snap.Permissions (TestPendingPermissions-
		// OmitsEmptyInnerMap). See the Questions loop above.
		if len(ps) == 0 {
			continue
		}
		out := make([]json.RawMessage, len(ps))
		for i, p := range ps {
			out[i] = p // captured copy
		}
		// Collapse byte-identical duplicates (the permission-array bloat fix).
		// LOSSLESS and order-preserving; see dedupRawMessages. Applied here at
		// the materialization phase so the wire payload is the authoritative
		// deduped set without touching s.perms (the store's source of truth
		// keeps every entry keyed by its permID — a future permission.delete
		// for any one id still clears correctly through PendingPermissions /
		// the live emit path).
		out = dedupRawMessages(out)
		snap.Permissions[sid] = out
	}
	for sid, st := range statuses {
		snap.Statuses[sid] = st // captured copy
	}
	for sid, list := range messages {
		out := make([]MessageWithParts, 0, len(list))
		for _, mc := range list {
			parts := make([]json.RawMessage, 0, len(mc.parts))
			for _, pc := range mc.parts {
				// Pure projection on the captured part: overlay the captured
				// buffered deltas onto the captured base without touching the
				// store. This is the lock-free part of the old work.
				parts = append(parts, projectPartCaptured(pc))
			}
			out = append(out, MessageWithParts{
				Info:  mc.info, // captured copy
				Parts: parts,
			})
		}
		// Bound the per-session message list to the recent-window tail. Pure:
		// operates on the already-materialized `out` (a private copy), no store
		// access. Deterministic: same captured state → same bounded list + same
		// WindowMeta, which is what preserves the pure-projection invariant
		// (Snapshot never bumps msgRev, and the window adds no nondeterminism).
		// The full list is materialized first (this is the status quo — the
		// capture loop walks sm.order in full); the window bound is a WIRE/
		// browser-memory fix, not a store-memory optimization.
		bounded, meta := projectMessageWindow(out, s.windowMaxCount, s.windowMaxBytes)
		snap.Messages[sid] = bounded
		snap.MessageWindows[sid] = meta
	}
	return snap
}

// SnapshotWithTree captures BOTH the detail Snapshot AND the tree TreeSnapshot
// under a SINGLE s.mu.Lock (the WRITE lock), stamping both with the SAME
// {epoch, seq}. The WRITE lock (not RLock) is required because the B-F1 flush
// (flushAllBufferedDeltasLocked) runs atomically before the capture so the
// snapshot baseline coheres with the part.append suffix offset; the flush is a
// WRITE (mutates me.parts, emits, advances deltaSentLen, bumps msgRev for any
// flushed session), and a quiescent snapshot with nothing buffered performs no
// flush (observationally pure). This is the Q5 capture-consolidation:
// previously handleStream acquired the lock twice
// (SnapshotFrontier then store.Snapshot), so a writer on the Apply path could
// interleave between the two locks and bump s.seq — making any after-the-fact
// {epoch, seq} label FALSE CONFIDENCE. The single capture here is the hard
// prerequisite for the truthfulness of the completion signal shipped in the
// next step.
//
// The tree computation runs the emitter's snapshotFrontierLocked inside this
// lock, so its exactly-once side-effects (E_c seeding via e.ec, parentCache /
// known recording via emitSnapshotNode) are applied VERBATIM — identical to a
// standalone SnapshotFrontier call. The detail capture (captureSnapshotLocked)
// is the same no-aliasing private copy the thin Snapshot uses.
//
// The test seam (snapshotMaterializeHook) fires between Unlock and the detail
// materialization, exactly as in Snapshot. baseline == tree.Seq (== detail.Seq)
// for the live-tail guard, so the caller can drop its third store.Head() lock.
func (s *Store) SnapshotWithTree(e *TreeEmitter, messagesFor map[string]bool, cause string) (Snapshot, *TreeSnapshot) {
	// B-F1 fix: flush buffered deltas before capture (see Snapshot /
	// flushAllBufferedDeltasLocked). WRITE lock for the flush+capture so they
	// are atomic; the tree frontier capture shares the same lock span, so both
	// projections stamp the SAME post-flush {epoch, seq}.
	s.mu.Lock()
	s.flushAllBufferedDeltasLocked()
	c := s.captureSnapshotLocked(messagesFor)
	treeSnap := e.snapshotFrontierLocked(cause)
	s.mu.Unlock()
	if snapshotMaterializeHook != nil {
		snapshotMaterializeHook()
	}
	detail := s.materializeSnapshot(c)
	return detail, treeSnap
}

// capturePartialDetailLocked is the D4 two-scope tree-Stream-1-only capture.
// Caller MUST hold s.mu (at least RLock). It is the partial counterpart of
// captureSnapshotLocked: instead of applying ONE inScope predicate to every
// map, it splits the authority:
//   - GLOBAL (authoritative-complete): questions, permissions, unread. A client
//     REPLACES its whole map for these (NotificationCenter iterates ALL
//     permissions/questions; tree rows show unread for all sessions).
//   - FRONTIER-scoped (merge): sessions, activity (and the gate/lastAgents/
//     currentVerbs derived from the per-session capture). Only the frontier IDs
//     the tree projection shipped are included; a client MERGES and must NOT
//     delete buried detail for ids outside the frontier.
//   - OMITTED: todos, statuses, messages (no tree-Stream-1 SPA consumer reads
//     todos/statuses from the snapshot — verified: only the notes-doc feature
//     references todos; statuses has no SPA consumer). A client MUST NOT touch
//     its existing map for these.
//
// subtreeBusy is captured for ALL sessions (it is a fresh map[string]bool of
// value copies aliasing nothing, and the gate's SubtreeBusy for a frontier
// session must reflect its full possibly-buried subtree). This keeps the
// no-aliasing invariant identical to captureSnapshotLocked.
func (s *Store) capturePartialDetailLocked(frontier map[string]bool) snapshotCapture {
	epoch := s.epoch
	seq := s.seq

	// subtreeBusy: ALL sessions (full subtree aggregation for frontier gates).
	subtreeBusy := make(map[string]bool, len(s.sessions))
	for id := range s.sessions {
		subtreeBusy[id] = s.subtreeBusyCount[id] > 0
	}

	// Per-session scalar facts — FRONTIER-scoped only.
	sessions := make(map[string]snapSessionCap, len(frontier))
	for sid := range frontier {
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
			msgResident:       s.latestAssistantResidentLocked(sid),
			hasMessages:       s.messages[sid] != nil,
			hasQuestions:      len(s.questions[sid]) > 0,
			hasPerms:          len(s.perms[sid]) > 0,
			permBlocked:       s.permBlocked[sid],
			activity:          s.activity[sid],
		}
	}

	// Questions: GLOBAL (authoritative-complete).
	questions := map[string][][]byte{}
	for sid, m := range s.questions {
		var qs [][]byte
		for _, q := range m {
			qs = append(qs, append([]byte(nil), q...))
		}
		questions[sid] = qs
	}
	// Activity: FRONTIER-scoped (merge).
	activity := map[string]string{}
	for sid := range frontier {
		if st, ok := s.activity[sid]; ok {
			activity[sid] = st
		}
	}
	// Unread: GLOBAL (authoritative-complete).
	unread := make([]string, 0, len(s.unread))
	for id := range s.unread {
		unread = append(unread, id)
	}
	// Permissions: GLOBAL (authoritative-complete).
	perms := map[string][][]byte{}
	for sid, m := range s.perms {
		var ps [][]byte
		for _, perm := range m {
			ps = append(ps, append([]byte(nil), perm...))
		}
		perms[sid] = ps
	}
	// Todos, statuses, messages: OMITTED (nil) — a client must not touch its
	// existing maps for these. materializeSnapshot leaves them as empty maps on
	// the wire (omitempty drops them), which the partial installer treats as
	// "omitted", not "authoritative-empty".
	return snapshotCapture{
		epoch:       epoch,
		seq:         seq,
		subtreeBusy: subtreeBusy,
		sessions:    sessions,
		questions:   questions,
		activity:    activity,
		unread:      unread,
		perms:       perms,
		// todos, statuses, messages intentionally nil (omitted).
	}
}

// SnapshotWithTreePartial is the D4 tree-Stream-1-only partial capture. It
// derives BOTH the tree frontier AND a PARTIAL detail snapshot under a SINGLE
// s.mu.Lock (the WRITE lock), stamping both with the SAME {epoch, seq} (Q5
// capture consolidation — identical rationale to SnapshotWithTree: a writer on
// the Apply path cannot interleave and bump s.seq between the two captures).
// The WRITE lock (not RLock) is required because the B-F1 flush
// (flushAllBufferedDeltasLocked) runs atomically before the capture so suffix
// offsets cohere; the flush is a WRITE (mutates me.parts, emits, advances
// deltaSentLen, bumps msgRev for any flushed session), and a quiescent snapshot
// with nothing buffered performs no flush (observationally pure). The
// detail snapshot carries frontier-scoped sessions/activity/gate/lastAgents/
// currentVerbs + GLOBAL questions/permissions/unread, with Snapshot.Partial set
// so the client picks the scoped installer (D3) instead of wholesale apply.
//
// The frontier scope is treeSnap.FrontierIDs — the EXACT emitted-node set
// computed once inside snapshotFrontierLocked, reused here without recompute.
// Non-tree callers MUST use SnapshotWithTree (full) or Snapshot (full): this
// method is reached only from handleStream's tree=2 cold/reconnect/ring-gap
// paths when no active session is selected (D7).
func (s *Store) SnapshotWithTreePartial(e *TreeEmitter, cause string) (Snapshot, *TreeSnapshot) {
	// B-F1 fix: flush buffered deltas before capture (see Snapshot /
	// flushAllBufferedDeltasLocked). The partial detail capture OMITS messages
	// (tree-Stream-1-only), but the flush still runs so any opted-in Stream-2
	// subscriber on the same store receives coherent suffix offsets.
	s.mu.Lock()
	s.flushAllBufferedDeltasLocked()
	treeSnap := e.snapshotFrontierLocked(cause)
	frontier := make(map[string]bool, len(treeSnap.FrontierIDs))
	for _, id := range treeSnap.FrontierIDs {
		frontier[id] = true
	}
	c := s.capturePartialDetailLocked(frontier)
	s.mu.Unlock()
	if snapshotMaterializeHook != nil {
		snapshotMaterializeHook()
	}
	detail := s.materializeSnapshot(c)
	detail.Partial = &PartialMeta{
		Mode:  "tree-stream-1-frontier",
		Scope: treeSnap.FrontierIDs,
		Authority: map[string]string{
			"sessions":     "frontier",
			"activity":     "frontier",
			"gate":         "frontier",
			"lastAgents":   "frontier",
			"currentVerbs": "frontier",
			"questions":    "global",
			"permissions":  "global",
			"unread":       "global",
			"todos":        "omitted",
			"statuses":     "omitted",
			"messages":     "omitted",
		},
	}
	return detail, treeSnap
}

// before it materializes the result from captured locals. A test sets it to
// block (e.g. on a channel) so it can drive a concurrent Apply (which needs the
// write lock) to completion while a Snapshot is parked in its lock-free
// materialization phase — proving the reader window was narrowed to the capture.
// Nil in production. See coldBatchAfterCaptureHook for the same pattern on the
// cold-batch path.
var snapshotMaterializeHook func()

// computeSubtreeBusyLocked returns, for every session, whether any session in its
// subtree (including itself) is busy or retry — the gate's "no busy descendant"
// fact, so a coordinator needn't walk the tree itself. O(n) via memoized
// post-order over the parent links. Caller holds s.mu.
//
// TEST / REFERENCE ONLY (L-05 collapse). Production no longer calls this: the
// snapshot/gate projection (captureSnapshotLocked) and SendableNow read the
// maintained subtreeBusyCount index (count > 0 → busy), the single source of
// the subtree-busy fact. This recompute survives as the differential reference
// for the standing/property checks — TestSnapshotGateReadsSubtreeIndex
// cross-checks the gate value against it. Its {Busy,Retry} classification and
// s.sessions iteration must stay in lockstep with the index's
// subtreeBusySelfLocked (both exclude ActivityError — the error-activity
// carve-out). Do NOT reintroduce a production caller: that would resurrect the
// redundant-derived dual authority (two sources of one fact, agreeing only by
// convention) that L-05 collapses.
func (s *Store) computeSubtreeBusyLocked() map[string]bool {
	children := map[string][]string{}
	for id, se := range s.sessions {
		if se.parentID != "" && s.sessions[se.parentID] != nil {
			children[se.parentID] = append(children[se.parentID], id)
		}
	}
	busy := func(id string) bool {
		a := s.activity[id]
		return a == ActivityBusy || a == ActivityRetry
	}
	memo := map[string]bool{}
	var visit func(id string) bool
	visit = func(id string) bool {
		if v, ok := memo[id]; ok {
			return v
		}
		// Seed before recursion so a malformed cyclic parent link can't recurse
		// forever (session trees are acyclic, but never trust external data).
		memo[id] = busy(id)
		res := memo[id]
		for _, c := range children[id] {
			if visit(c) {
				res = true
			}
		}
		memo[id] = res
		return res
	}
	for id := range s.sessions {
		visit(id)
	}
	return memo
}

// SendableNow reports whether a plain message is safe to send to a session right
// now — the §1.1 gate as a single fact — plus the seq at which the session's
// activity last changed (for If-Idle-Seq CAS). sendable means: activity idle, no
// busy descendant, the latest assistant turn completed (or none yet), and no
// pending question or permission (those need a typed reply, not a message).
// exists is false for an unknown session. This is a raw mechanism check; the
// decision to *use* it (i.e. whether to gate a send) belongs to the caller.
//
// It delegates to SendCASState (the atomic single-observation form) and drops
// the abort-gate leg — callers that need sendability AND the gate together (the
// /vh/send CAS consumer) MUST call SendCASState directly so an abort settling in
// the gap between a sendability read and a gate read cannot leave them with a
// stale sendable + a fresh gate-open (the B1 TOCTOU).
func (s *Store) SendableNow(sid string) (sendable bool, activitySeq uint64, exists bool) {
	sendable, activitySeq, exists, _ = s.SendCASState(sid)
	return sendable, activitySeq, exists
}

// SendCASState is the atomic single-observation form of the /vh/send CAS gate:
// it returns sendability, the activity seq (for If-Idle-Seq CAS), session
// existence, AND the abort-settlement gate (AbortSettling) under ONE RLock. The
// /vh/send consumer MUST observe all four together: under the two-read form, an
// abort settling between a SendableNow read (sendable=false, stale) and an
// AbortSettling read (gate=open, fresh) left the handler skipping BOTH the await
// and the mandatory fresh CAS rerun, stale-409ing a send whose fresh CAS would
// have forwarded — a residual instance of the exact race this slice closes (B1).
// Observing under a single lock makes the snapshot consistent: the settle is
// either fully before (sendable reflects the idle post-settle) or fully after
// (gate still closed), never the inconsistent split. SendableNow delegates here.
func (s *Store) SendCASState(sid string) (sendable bool, activitySeq uint64, exists bool, abortSettling bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	se := s.sessions[sid]
	if se == nil {
		return false, 0, false, false
	}
	act := s.activity[sid]
	if act == "" {
		act = ActivityIdle
	}
	// subtreeBusy reads the maintained index (single production source of the
	// subtree-busy fact, L-05 collapse) instead of recomputing the whole tree
	// to answer one node.
	subtreeBusy := s.subtreeBusyCount[sid] > 0
	inflight := se.hasAssistant && !se.lastAsstCompleted
	// P7 turn-boundary: a session mid-stop (TurnStopping) is not sendable even
	// if its activity has not yet cleared — the canceled run is still in flight
	// until its terminal. (The fail-closed abort gate AbortSettling is
	// invariant with TurnStopping — Stop sets both, settle clears both — so
	// checking TurnStopping here is sufficient; the gate itself is reported
	// separately and consumed by the /vh/send CAS path via WaitAbortSettling,
	// which awaits it for a CAS-bearing send rejected solely by an active abort
	// settlement before rerunning this full SendableNow + seq CAS.)
	stopping := s.turnState[sid] == TurnStopping
	sendable = act == ActivityIdle &&
		!stopping &&
		!subtreeBusy &&
		!inflight &&
		len(s.questions[sid]) == 0 &&
		len(s.perms[sid]) == 0
	return sendable, s.activitySeq[sid], true, s.abortSettling[sid]
}

// Head returns the current head seq without building a full snapshot — for
// cheaply stamping X-VH-Seq response headers.
func (s *Store) Head() uint64 {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.seq
}

// RunningRoots returns the number of session roots whose subtree has at least
// one busy/retry session: a root counts if any turn is in flight anywhere in its
// subtree. Used by /vh/projects (P2) for the per-project "running" badge and
// aggregated across workspaces by /vh/running-sessions for the "restart will
// interrupt N running sessions" warning — both without building full snapshots.
// roots >= running always holds (see RootCount); idle = roots − running.
//
// SINGLE SOURCE OF TRUTH: this derives from the incremental subtreeBusyCount
// index (proven equivalent to an independent O(n) recompute by
// TestSubtreeBusyCountProperty), iterating the SAME orphan-inclusive live-root
// population as RootCount. The legacy root-keyed busyCount was RETIRED — it had
// asymmetric maintenance (a reparent gap and a phantom-status gap) that let this
// count diverge from per-session activity and report a phantom "1 running" while
// every session was idle. Deriving from subtreeBusyCount makes that divergence
// structurally impossible: the count can only reflect busy/retry sessions that
// are actually in the live tree under a live root.
func (s *Store) RunningRoots() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for id, e := range s.sessions {
		if e.parentID == "" || s.sessions[e.parentID] == nil {
			if s.subtreeBusyCount[id] > 0 {
				n++
			}
		}
	}
	return n
}

// RootCount returns the number of LIVE session roots — roots among the
// non-archived sessions in the live tree. It uses the SAME orphan-inclusive root
// definition as rootOfLocked / subtreeBusyCount / RunningRoots: a session is a root when
// it has no parentID OR its parentID is not present in the live store, so a child
// never counts even if its parent has been archived (an orphaned child becomes its
// own root). Archived sessions are already removed from s.sessions (archive via
// time.archived funnels through deleteSessionLocked), so they're excluded
// naturally and don't inflate the count. RootCount draws from the same population
// RunningRoots() does, so roots >= running always holds; pair the two for an idle
// count (idle = roots − running). Used by /vh/projects for the project switcher's
// per-workspace "X running, Y idle" badge (children were never meant to count).
func (s *Store) RootCount() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for _, e := range s.sessions {
		if e.parentID == "" || s.sessions[e.parentID] == nil {
			n++
		}
	}
	return n
}

// UnreadRoots returns the number of LIVE ROOT sessions currently marked
// finished-unread. Unread is root-scoped (keyed by rootOf) and unread ⊆ idle is
// an enforced invariant (set on ordinary busy→idle via markUnreadLocked, cleared
// unconditionally on idle→busy via clearUnreadLocked — see
// unread_transition_test.go), so this is the per-project "unread idle" count.
// Defensively intersected with the SAME live-root population RootCount uses
// (parentID=="" || sessions[parentID]==nil) so an entry stranded in s.unread
// after an archive/delete path can never inflate the count. deleteSessionLocked
// already does delete(s.unread, id), so the intersection is harmless redundancy
// (a belt-and-suspenders guard), not a correctness crutch.
func (s *Store) UnreadRoots() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	n := 0
	for id := range s.unread {
		e, ok := s.sessions[id]
		if !ok {
			continue
		}
		if e.parentID == "" || s.sessions[e.parentID] == nil {
			n++
		}
	}
	return n
}

// ProjectCounts returns (roots, running, unread) under a SINGLE RLock so the
// triple is a coherent snapshot — a busy↔idle writer cannot interleave
// between the reads and produce a response where unread > (roots − running)
// (which would violate the unread ⊆ idle wire invariant surfaced on
// /vh/projects). Equivalent to calling RootCount()/RunningRoots()/UnreadRoots()
// separately on a quiescent store, but atomic with respect to writers.
// handleProjects MUST use this instead of the three individual accessors so
// the per-project badge never renders "(N unread)" with N > idle.
//
// Atomicity is STRUCTURAL (the single RLock makes the triple coherent); the
// value-equivalence with the individual accessors is pinned by
// TestProjectCountsEquivalentToIndividualAccessors, and the read path is
// verified under concurrency by `go test -race` on that seed + the
// TestProjectCountsConcurrentInvariant hammer.
func (s *Store) ProjectCounts() (roots, running, unread int) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for id, e := range s.sessions {
		if e.parentID == "" || s.sessions[e.parentID] == nil {
			roots++
			if s.subtreeBusyCount[id] > 0 {
				running++
			}
		}
	}
	for id := range s.unread {
		e, ok := s.sessions[id]
		if !ok {
			continue
		}
		if e.parentID == "" || s.sessions[e.parentID] == nil {
			unread++
		}
	}
	return roots, running, unread
}

// Replay returns buffered events with seq > cursor. ok is false when the cursor
// is older than the buffer's oldest retained event (caller must send a snapshot).
func (s *Store) Replay(cursor uint64) (events []ClientEvent, head uint64, ok bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.ring.since(cursor, s.seq)
}

// IsMessagesLoaded reports whether a session's history has been fetched AND the
// resident parts are consistent with a completed assistant turn. It DERIVES from
// the actual resident parts (latestAssistantResidentLocked), not the msgLoaded
// latch alone: a completed assistant message with zero resident parts is treated
// as NOT loaded so the open path re-fetches and the daemon actually serves the
// parts — UNLESS that exact empty newest was confirmed as source-truth by a
// second reconcile (confirmedEmptyNewest), in which case it is admitted (the
// server genuinely has no parts for that turn). This is the S5 contract fix —
// the latch alone could report loaded with zero parts (the systemic steady state
// for finished sessions), blocking the re-fetch forever. Mirrors the busyCount
// retirement (c4c4ef1): derive from source, do not trust a cached flag.
func (s *Store) IsMessagesLoaded(sid string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.msgLoaded[sid] && s.latestAssistantResidentLocked(sid)
}

// isTerminalError reports whether an opencode info.error.name marks a turn as
// terminal/outputless. A terminal error positively classifies the newest
// completed assistant as having produced no output, so it is admitted as
// messages-loaded on the first reconcile (no disambiguating re-fetch). The
// aborted signal is strictly stronger evidence than the O5 "same empty across
// two reconciles" heuristic — opencode itself marked the turn terminal.
//
// Membership is an intentionally small, documented, extensible set: add a case
// only when opencode positively marks a turn as terminal-and-outputless.
//
//   - "MessageAbortedError" — the confirmed trigger (ses_05ff9273dffe7N4dh1HliZhIXq):
//     an aborted turn. The live opencode payload (pid 1923) carried
//     info.error.name="MessageAbortedError", tokens all zero, parts:[], no
//     finish. This set may grow as further terminal shapes are confirmed.
//
// Empty (no error) and unrecognized names return false — those turns fall
// through to the O5 two-empty confirmation backstop for non-aborted zero-parts
// cases.
func isTerminalError(name string) bool {
	switch name {
	case "MessageAbortedError": // confirmed: aborted turn (operator/limit abort)
		return true
	}
	return false
}

// latestAssistantResidentLocked is the source-of-truth derivation the gate's
// MessagesLoaded field and the open-path IsMessagesLoaded read INSTEAD of the
// msgLoaded latch. It reports whether the session's resident parts are consistent
// with a completed assistant turn: false when the newest COMPLETED assistant
// message has zero resident parts — UNLESS that exact empty newest was confirmed
// as source-truth by a second authoritative reconcile (confirmedEmptyNewest), in
// which case it is admitted (the server genuinely has no parts for that turn). A
// real completed turn normally carries ≥1 part (reasoning / step / text / tool),
// so zero parts is the signature of unfetched/lost parts — exactly the state the
// latch papered over, and the schema-drift cold-load shape (3b3860e) the re-fetch
// guard exists to recover. But a single fetch returning zero parts cannot tell a
// lying cold load from a faithful one: only a SECOND reconcile observing the SAME
// empty newest confirms source-truth (the schema-drift shape instead resolves
// via the len(parts)>0 branch once the re-fetch serves the real parts). An
// in-progress newest assistant does not by itself decide residency: the walk
// continues PAST it to the newest COMPLETED assistant, because "completed" does
// not imply "has all parts" (the activity-idle path can stamp time.completed
// WITHOUT adding parts), so a newer in-progress turn must not mask an OLDER
// completed assistant's zero-parts gap. If there is no completed assistant at
// all — no assistant message, every assistant in-progress, or no message state
// — the walk returns true (vacuously resident: nothing completed is provably
// missing). Caller holds s.mu (RLock is sufficient; read-only).
func (s *Store) latestAssistantResidentLocked(sid string) bool {
	sm := s.messages[sid]
	if sm == nil {
		return true
	}
	for i := len(sm.order) - 1; i >= 0; i-- {
		me := sm.byID[sm.order[i]]
		if me == nil || me.role != "assistant" {
			continue
		}
		if !me.completed {
			// In-progress turn: its parts are still streaming, so it cannot
			// itself be a completed-0-parts gap. But it must NOT mask an OLDER
			// completed assistant's missing parts — "completed" does not imply
			// "has all parts" (the activity-idle path can stamp time.completed
			// without adding parts). Continue the newest->oldest walk to the
			// newest COMPLETED assistant, whose residency the contract keys on.
			// If every assistant is in-progress (no completed turn at all), the
			// walk falls through to the trailing `return true` (vacuously
			// resident — nothing completed is provably missing).
			continue
		}
		if len(me.parts) > 0 {
			return true
		}
		// Aborted/terminal-error fast-path (ses_05ff9273dffe7N4dh1HliZhIXq):
		// opencode positively classified this turn as terminal
		// (info.error.name is a recognized terminal error — confirmed shape:
		// MessageAbortedError). Such a turn produced NO output, so zero parts
		// is source truth — admit on the FIRST reconcile, BEFORE the O5
		// two-empty confirmation. This is strictly stronger evidence than the
		// O5 heuristic: opencode itself marked the turn terminal. The
		// schema-drift case (a NON-aborted turn whose parts were omitted by
		// the fetch) carries NO terminal error → it does NOT hit this branch →
		// it falls through to the O5 confirmation below, preserving the
		// 3b3860e re-fetch guard. reconcileMessagesLocked mirrors this admit
		// on the write side (keeps BlockedByUnconfirmedEmptyNewest false so the
		// aggregator does exactly ONE fetch) and emits the confirm-log.
		if isTerminalError(me.terminalError) {
			return true
		}
		// Newest COMPLETED assistant has zero resident parts. This is either
		// source truth (the server genuinely has no parts for this turn) or a
		// transient gap (a schema-drift cold load that returned envelope-only,
		// or a live race where a newer assistant turn completed via message.
		// upsert but its parts have not streamed yet). Admit ONLY when this
		// exact empty newest was confirmed by a second authoritative reconcile
		// (confirmedEmptyNewest[sid] == me.id): two reconciles returning the
		// same empty newest is the signature of source truth, while the
		// schema-drift shape resolves via the len(parts)>0 branch above once
		// the re-fetch serves the real parts. Anything else — including a
		// brand-new live-completed assistant newer than the last reconcile, or
		// a newest seen empty only once — returns false and forces the
		// re-fetch, preserving the S5 guard (3b3860e).
		return s.confirmedEmptyNewest[sid] == me.id
	}
	return true // no COMPLETED assistant message (none at all, or every assistant in-progress)
}

// SessionIDs returns the ids of the LIVE (active) sessions in this store's
// project scope. Archived sessions are excluded: archive via time.archived
// funnels through deleteSessionLocked and removes them from s.sessions, so
// only currently-active ids appear here. This live-only set is the
// authoritative input to queue orphan reconciliation (reconcileQueuesForAgg),
// which relies on archived ids being ABSENT to treat their leftover
// queue.json files as orphans that get cleaned up — returning archived ids
// here would silently retain those files forever. Distinct from HasSession's
// per-id O(1) check.
func (s *Store) SessionIDs() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(s.sessions))
	for id := range s.sessions {
		out = append(out, id)
	}
	return out
}

// HasSession reports whether sid is a member of this store's project scope.
// Cheap O(1) RLock + map lookup. Used for project-isolation guards at the HTTP
// boundary and as a defense-in-depth backstop in the aggregator. Distinct from
// SessionIDs (O(n) alloc + copy) because per-filter-ID checks need O(1).
func (s *Store) HasSession(sid string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.sessions[sid]
	return ok
}

// LoadedSessions returns the ids whose messages have been hydrated — the set to
// re-fetch on reconnect (instead of every session).
func (s *Store) LoadedSessions() []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(s.msgLoaded))
	for id := range s.msgLoaded {
		out = append(out, id)
	}
	return out
}

// RootInventoryEntry is one row of the authoritative live-session inventory
// (Store.RootInventory). It carries the session id and its parentage so a
// worker-wide store (labels) can validate that a target is a root WITHOUT
// trusting the client.
//
// pkg/state is per-project: a single Store holds the sessions of ONE project
// and has no notion of project identity. Project ownership (which project a
// root belongs to) is therefore NOT carried here — it is composed by the web
// layer, which iterates s.aggs (dir → aggregator → this Store) and maps each
// root id to its project key. This mirrors exactly how the pin system's
// activeSessionProjects composes project keys in pkg/web rather than pkg/state.
type RootInventoryEntry struct {
	SessionID string // live (non-archived) session id
	ParentID  string // "" = a true root (parentID == "")
	IsRoot    bool   // true iff ParentID == "" (the strict labels root definition)
}

// RootInventory returns the authoritative live-session inventory WITH PARENTAGE.
// Every live (non-archived) session is one entry; IsRoot is true iff the
// session's parentID == "". This is the parentage-carrying counterpart of
// SessionIDs: the pin system consumes SessionIDs (which lacks parentage); the
// labels system consumes this, derives the authoritative active-ROOT set by
// filtering IsRoot, and validates that every label target is a known root.
//
// ROOT DEFINITION (deliberately STRICT, distinct from RootCount/RunningRoots):
// labels target true roots only — parentID == "" — so an ORPHANED child (one
// whose parent was archived, leaving parentID != "" pointing at a now-absent
// session) is NOT a root here and is NOT a valid label target. RootCount and
// RunningRoots use the orphan-INCLUSIVE definition (parentID == "" OR parent
// absent) because they count population for badges; labels use the STRICT
// definition because they target the browser-tab-group unit, which is the true
// root session. See tree_node.go (ParentID == "" = root) and the labels design
// plan (invariant #1: a root is a session whose parentID is empty).
//
// Pure read projection under s.mu.RLock; iteration order is nondeterministic
// (set-equality parity, exactly like SessionIDs). The returned slice is a fresh
// copy; callers may mutate it freely.
func (s *Store) RootInventory() []RootInventoryEntry {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]RootInventoryEntry, 0, len(s.sessions))
	for id, se := range s.sessions {
		out = append(out, RootInventoryEntry{
			SessionID: id,
			ParentID:  se.parentID,
			IsRoot:    se.parentID == "",
		})
	}
	return out
}
