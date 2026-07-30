// Package state: the reducers concern — the WRITE path of the store,
// mechanically extracted from store.go (reference model: snapshots.go,
// subscriptions.go, message_window.go, subtree_indexes.go). This file owns:
//   - Apply, the single ingress for live OpenCode SSE events, which switches on
//     ev.Type and routes to the *Locked mutators below (all under the held write
//     lock);
//   - the session/message/part *Locked mutators Apply routes to
//     (upsertSessionLocked / deleteSessionLocked / upsertMessageLocked /
//     deleteMessageLocked / upsertPartLocked / deletePartLocked /
//     appendPartDeltaLocked) and their denormalization helpers
//     (recomputeLastAssistantLocked / recomputeCurrentVerbLocked /
//     setCurrentVerbLocked / assistantInflightLocked / messageHasContent /
//     verbStatePayload);
//   - the activity setters (setActivityLocked / setActivityAtLocked — the
//     busy↔non-busy chokepoint touching 10+ maps) and their unread helpers
//     (markUnreadLocked / clearUnreadLocked);
//   - the public write mutators that share the reducer surface
//     (SetActivityFromStatuses / AckUnread / MarkIdle / MarkPermissionBlocked /
//     SetPendingQuestions / SetPendingPermissions);
//   - the streaming part-delta machinery (appendPartDeltaLocked /
//     flushPartDeltasLocked / discardPartDeltaLocked / partPlaceholderJSON);
//   - the pure helpers used only by this concern (normalizeActivity /
//     activityTimeFromSessionLocked / removeString).
//
// The Store struct and its single s.mu RWMutex stay in store.go and are shared
// across this whole package (same-package file split; no protocol change). The
// grace machinery (armGraceLocked / cancelGraceLocked / cancelAllGraceLocked /
// graceFire / clearOnCompletionLocked), the subtreeBusyCount prototype
// maintainers (subtreeBusySelfLocked / adjustAncestorChainFromLocked /
// adjustAncestorSubtreeBusyLocked / maintainSubtreeBusyOnSessionUpsertLocked),
// the shared topology helper (rootOfLocked), the archive-tombstone surface
// (isRecentlyArchivedLocked / RemoveSessions / ClearArchiveTombstones /
// IsRecentlyArchived), and the part-text cap helpers (applyCapToString /
// capPartJSON / capStringsInPlace / truncatedMarker) all stay in store.go and
// are called from here as same-package cross-file calls — the same pattern by
// which snapshots.go shares descendantsLocked, subscriptions.go shares emit,
// and message_window.go shares bumpMsgRev / publishColdBatch.
//
// Behavior-preserving verbatim move. setActivityAtLocked remains the
// highest-coupled function in the package (touches activity / activitySeq /
// busyCount / unread / subtreeBusyCount / the seven O1 subtree indexes via the
// maintain*Locked / touch*Locked helpers); the finish-cascade emit order in
// deleteSessionLocked (KindActivity idle BEFORE KindSessionDelete) and the
// Store-wide nextMsgRev ABA contract (every mutation site keeps its bumpMsgRev
// call) are load-bearing and preserved byte-for-byte.
package state

import (
	"bytes"
	"encoding/json"
	"strings"
	"time"

	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// normalizeActivity maps an OpenCode SessionStatus.type to a UI activity state.
func normalizeActivity(statusType string) string {
	switch statusType {
	case "busy":
		return ActivityBusy
	case "retry":
		return ActivityRetry
	default:
		return ActivityIdle
	}
}

// setActivityLocked records a session's activity and emits a client event only
// when it changes. Caller must hold s.mu.
// setActivityLocked records an activity transition using the REAL wall-clock
// now (the live Apply path). It is the original entry point; the at-parameterized
// variant below is the O1 fix path used by status-reconcile/hydrate. It carries
// markOnIdle=true: every ordinary completion path (MarkIdle/abort, Apply
// idle|error|status, message & part-delta escalation, graceFire) is a real
// finish and may mark the root finished-unread.
func (s *Store) setActivityLocked(sessionID, st string) {
	s.setActivityAtLocked(sessionID, st, time.Now(), true)
}

// setActivityAtLocked is setActivityLocked with an explicit activity timestamp
// `at` (O1 fix): the status-reconcile/hydrate path seeds `at` from the
// session's own time.updated so a reconcile does NOT stamp now and spuriously
// promote a long-idle session into the recent-activity window. `now` is still
// captured separately for the cutoff boundary (the "within the activity window"
// check must use real wall-clock now). Both touchActivityTimeLocked and
// touchRecentBucketLocked use the SAME stampTime so the two indexes never
// disagree: refRecentBucket derives bucket membership from lastActivityAt (set
// by touchActivityTimeLocked), so the bucket MUST use the same timestamp.
// stampTime is `at` when it carries upstream recency (non-zero), else real now
// (original behavior for the live Apply path, which passes time.Now(), and for
// sessions whose info lacks time.updated).
//
// markOnIdle is the EXPLICIT per-transition unread policy (M9/L-16). It carries,
// per transition, the decision the retired ambient Store.suppressUnread flag
// used to encode Store-wide: whether a busy→idle flip that fully idles a root's
// subtree may mark that root finished-unread. The ordinary completion paths
// (MarkIdle/abort, Apply idle|error|status, message & part-delta escalation,
// graceFire) pass true (a real turn finished → mark the root for ack). The
// status-reconcile path (SetActivityFromStatuses — the /session/status snapshot
// reconcile on (re)hydrate) passes false: clearing busy from a reconstructed
// snapshot is NOT a real completion and must not flag every idle root unread.
//
// Root-scoped reach is BY DESIGN (audit L-13, closed as such): the unread mark
// targets `root` (rootOfLocked), not `sessionID` — a finished subagent's whole
// root subtree is what the operator acknowledges. Count maintenance
// (subtreeBusyCount deltas, the running-again clearUnreadLocked) is UNCONDITIONAL
// and runs regardless of markOnIdle; only the finished mark is policy-gated.
func (s *Store) setActivityAtLocked(sessionID, st string, at time.Time, markOnIdle bool) {
	// Archive tombstone (Issue 4 B-i): a busy status for a recently-archived
	// id (the subagent is still running) must NOT record activity or emit for
	// it — otherwise the periodic status reconcile re-marks it busy →
	// re-promotes it back into the active closure. The tombstone suppresses
	// this; upsertSessionLocked already blocks the session from re-entering
	// s.sessions, so this guard additionally prevents a phantom activity
	// emit. Expires per recentArchiveTTL; Hydrate clears for genuinely active.
	if s.isRecentlyArchivedLocked(sessionID) {
		return
	}
	prev := s.activity[sessionID]
	if prev == st {
		return
	}
	// Phase 2 (finding B): compute whether this is a genuine promotion BEFORE
	// the emit, so the event's FrontierChanged flag is deterministic (the
	// earlier global-counter gate raced with the aggregator's concurrent
	// poll-loop re-applies). A genuine promotion (inactive stub → busy) changes
	// frontier membership; an activity flip of a session that was ALREADY
	// selfActive does NOT (it stays materialized regardless of busy↔retry /
	// busy→idle). Uses `prev` activity + the OLD lastActivityAt
	// (touchActivityTimeLocked below overwrites it to stampTime). `now` (real
	// wall-clock) drives only the cutoff boundary; stampTime drives the activity
	// time + bucket so a status-reconcile can seed recency from time.updated
	// without spuriously promoting a long-idle session (O1 fix).
	now := time.Now()
	// O1 fix: stampTime is the single timestamp both touchActivityTimeLocked and
	// touchRecentBucketLocked use — they MUST agree because refRecentBucket
	// derives bucket membership from lastActivityAt. stampTime is `at` (upstream
	// session.time.updated) when non-zero, else real now (live Apply path +
	// sessions lacking time.updated keep original behavior).
	stampTime := at
	if stampTime.IsZero() {
		stampTime = now
	}
	s.activity[sessionID] = st
	s.emit(KindActivity, rawObj(map[string]interface{}{"sessionID": sessionID, "state": st}))
	s.activitySeq[sessionID] = s.seq // the seq of the activity event just emitted

	// Clear the rich current-activity facet when the session stops working
	// (idle/error). The turn's last tool part may still read status:"running"
	// (a stale snapshot), so the authoritative activity signal — not the
	// message scan — owns the "definitely not doing anything anymore" clear.
	if st != ActivityBusy && st != ActivityRetry {
		s.setCurrentVerbLocked(sessionID, VerbFacet{})
	}

	// Phase 1 (Gate C extension): maintain the 7 remaining incremental subtree
	// indexes at every REAL activity transition. retry-count, activity-time,
	// and the recent bucket must update on busy-neutral transitions too
	// (busy↔retry, error→idle), so this block runs BEFORE the wasBusy==isBusy
	// early-return below. Each helper is phantom-guarded (no-op when sessionID
	// is not yet in the live tree — the contribution is seeded on create via
	// the upsert maintainers).
	s.maintainSubtreeRetryOnActivityLocked(sessionID, prev, st)
	s.touchActivityTimeLocked(sessionID, stampTime)
	s.touchRecentBucketLocked(sessionID, stampTime)

	// Track the root subtree's busy count to detect "finished" (busy -> idle).
	wasBusy := prev == ActivityBusy || prev == ActivityRetry
	isBusy := st == ActivityBusy || st == ActivityRetry
	if wasBusy == isBusy {
		return
	}

	// Incremental subtreeBusyCount maintenance — and the SINGLE source of truth
	// for the per-root busy aggregate + the finished-unread trigger. A real
	// busy↔non-busy flip changes id's own contribution by ±1 and every live
	// ancestor's aggregate by ±1. Guarded on live-tree membership: a phantom
	// status event for an unknown sessionID must NOT create an index entry
	// (computeSubtreeBusyLocked iterates s.sessions only), and must NOT arm a
	// running root — the own-contribution for a phantom-busy-then-created
	// session is seeded in upsertSessionLocked / Hydrate when it enters the
	// live tree. (The retired busyCount ran this block OUTSIDE the guard, which
	// is how a phantom status created a stray running root.)
	//
	// subtreeBusyCount[root] is the count of busy/retry sessions in root's
	// subtree (incl root). wasZero (captured BEFORE the delta) drives the
	// "running again — clear the stale finished mark" trigger; the post-delta
	// value drives the "now fully idle — mark finished-unread" trigger. Both
	// markUnreadLocked and clearUnreadLocked are themselves no-ops when the id
	// is absent from s.sessions, so guarding the whole block changes nothing
	// for phantoms and removes the stray-entry leak.
	if s.sessions[sessionID] != nil {
		root := s.rootOfLocked(sessionID)
		wasZero := s.subtreeBusyCount[root] == 0 // BEFORE the delta
		delta := 1
		if !isBusy {
			delta = -1
		}
		s.subtreeBusyCount[sessionID] += delta
		s.adjustAncestorSubtreeBusyLocked(sessionID, delta)
		if isBusy {
			if wasZero {
				s.clearUnreadLocked(root) // running again — no longer a stale "finished"
			}
		} else {
			// Finished-unread mark is gated by the explicit per-transition
			// markOnIdle policy (M9/L-16): an ordinary completion marks the
			// root; a status-reconcile (markOnIdle=false) does not. The mark
			// targets `root` (rootOfLocked), not sessionID — root-scoped reach
			// is by design (audit L-13, closed as by-design: a finished
			// subagent's whole root subtree is what the operator acknowledges).
			if s.subtreeBusyCount[root] == 0 && markOnIdle {
				s.markUnreadLocked(root) // a finished task awaiting acknowledgement
			}
		}
	}
}

func (s *Store) markUnreadLocked(id string) {
	if s.sessions[id] == nil || s.unread[id] {
		return
	}
	s.unread[id] = true
	s.emit(KindUnreadSet, rawObj(map[string]interface{}{"sessionID": id}))
}

func (s *Store) clearUnreadLocked(id string) {
	if !s.unread[id] {
		return
	}
	delete(s.unread, id)
	s.emit(KindUnreadClear, rawObj(map[string]interface{}{"sessionID": id}))
}

// AckUnread clears a root's finished-unread flag (the client scrolled it to the
// bottom). The id may be any session in the subtree; its ROOT is acked —
// finished-unread reach is root-scoped BY DESIGN (audit L-13, closed as such):
// a finished subagent's whole root subtree is what the operator acknowledges,
// and the matching finished mark (setActivityAtLocked) targets the same root.
func (s *Store) AckUnread(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.clearUnreadLocked(s.rootOfLocked(sessionID))
}

// MarkIdle authoritatively marks a session idle and emits the activity event.
// Used by the abort verb: OpenCode does not emit session.idle on abort, so
// without this the authoritative activity stays "busy" until a stale event (or
// a stream reconnect's snapshot) re-applies it and re-arms the working
// indicator on a turn the user already stopped. setActivityLocked is a no-op
// when already idle, so a later real session.idle reconciles harmlessly.
func (s *Store) MarkIdle(sessionID string) {
	s.mu.Lock()
	s.setActivityLocked(sessionID, ActivityIdle)
	s.mu.Unlock()
}

// SetActivityFromStatuses seeds activity from a GET /session/status snapshot
// (sessionID -> SessionStatus). Used by the aggregator on (re)hydrate.
// SetActivityFromStatuses makes /session/status the authoritative source of
// per-session activity for ALL live sessions (matches opencode web). Sessions
// reported busy/retry are marked so; every other known session is cleared to
// idle. Clearing matters after a restart: a turn terminated mid-generation
// leaves an incomplete last message, and without an explicit idle the UI's
// fallback heuristic would spin that session forever.
func (s *Store) SetActivityFromStatuses(statuses map[string]json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Reconciling activity on (re)hydrate must not spuriously flag sessions as
	// finished-unread: the busy/clear transitions below call setActivityAtLocked
	// with markOnIdle=false (M9/L-16), the explicit per-transition policy that
	// replaced the retired ambient Store.suppressUnread flag. subtreeBusyCount
	// still tracks correctly; only the finished-unread mark is suppressed.
	busy := map[string]bool{}
	for sid, raw := range statuses {
		var st struct {
			Type string `json:"type"`
		}
		_ = json.Unmarshal(raw, &st)
		a := normalizeActivity(st.Type)
		// Completion-authority guard (Lane A): a stale busy/retry from
		// /session/status must NOT re-escalate a session whose assistant turn
		// authoritatively completed (the completion-grace window fired, or
		// session.idle was observed — both set completionAuthoritative).
		// message.updated{completed} is the authoritative "turn is over"
		// signal; a stale status snapshot must not override it. Cleared when a
		// NEW assistant message goes inflight (a new turn started), so a
		// legitimate future busy is respected.
		if a != ActivityIdle && s.completionAuthoritative[sid] {
			a = ActivityIdle
		}
		// O1 fix: seed the activity timestamp from the session's OWN time.updated
		// (reconstructed state), NOT wall-clock now. A status reconcile/hydrate
		// stamps real activity recency so a long-idle session is not spuriously
		// promoted into the recent-activity window. Falls back to now when the
		// session or its time.updated is absent/zero.
		at := activityTimeFromSessionLocked(s, sid)
		// markOnIdle=false: a status-snapshot reconcile is NOT a real
		// completion, so it must not flag the root finished-unread (M9/L-16).
		s.setActivityAtLocked(sid, a, at, false)
		if a != ActivityIdle {
			busy[sid] = true
		}
	}
	// Clear everything else. Known sessions and loaded sessions are set idle;
	// never-busy sessions with no entry already render idle, so they're skipped
	// to avoid a churn of no-op events on large session lists.
	// clearActivity idles any session no longer reported busy. Named to avoid
	// shadowing the Go 1.21+ builtin clear (this repo is Go 1.25).
	clearActivity := func(sid string) {
		if !busy[sid] {
			// markOnIdle=false: clearing busy from a reconstructed status
			// snapshot is not a real completion (M9/L-16).
			s.setActivityAtLocked(sid, ActivityIdle, activityTimeFromSessionLocked(s, sid), false)
		}
	}
	for sid := range s.sessions {
		clearActivity(sid)
	}
	for sid := range s.messages {
		clearActivity(sid)
	}
}

// activityTimeFromSessionLocked extracts the session's time.updated (unix ms)
// as a time.Time for the O1 status-reconcile recency seed. Returns the zero
// time.Time (→ setActivityAtLocked falls back to the cutoff `now` boundary and
// touchActivityTimeLocked skips the monotonic-advance when zero) when the
// session or its time.updated is absent. Caller holds s.mu.
func activityTimeFromSessionLocked(s *Store, sid string) time.Time {
	se := s.sessions[sid]
	if se == nil {
		return time.Time{}
	}
	var partial struct {
		Time struct {
			Updated *float64 `json:"updated"`
		} `json:"time"`
	}
	if json.Unmarshal(se.info, &partial) != nil || partial.Time.Updated == nil {
		return time.Time{}
	}
	return time.UnixMilli(int64(*partial.Time.Updated))
}

// Apply reduces a single live OpenCode event into the view and emits the
// corresponding client event(s).
func (s *Store) Apply(ev opencode.Event) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// PROBE 2: attribute emits inside this Apply to the live upstream source
	// and carry the ingest t0 (Probe 1) so emit can measure ingest→emit age.
	// Reset on exit so the next emit-path caller (which re-acquires s.mu) sees
	// the daemon default unless it sets otherwise.
	s.curEmitIngest = ev.IngestNano
	s.curEmitSource = diag.SourceOpencodeLive
	defer func() { s.curEmitIngest = 0; s.curEmitSource = diag.SourceDaemonGenerated }()

	switch ev.Type {
	case "session.created", "session.updated", "session.compacted":
		s.upsertSessionLocked(ev.Properties) // properties.info is the Session
	case "session.deleted":
		var p struct {
			Info sessionEnvelope `json:"info"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && p.Info.ID != "" {
			s.deleteSessionLocked(p.Info.ID)
		}
	case "session.status", "session.idle", "session.error", "session.diff":
		var p struct {
			SessionID string `json:"sessionID"`
			Status    struct {
				Type string `json:"type"`
			} `json:"status"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && p.SessionID != "" {
			s.statuses[p.SessionID] = ev.Properties
			s.emit(KindStatus, ev.Properties)
			switch ev.Type {
			case "session.idle":
				// Authoritative turn-end: cancel any pending completion-grace
				// (redundant now) and arm the completion-authority guard so a
				// stale busy from /session/status does not re-strand.
				s.cancelGraceLocked(p.SessionID)
				s.setActivityLocked(p.SessionID, ActivityIdle)
				s.completionAuthoritative[p.SessionID] = true
			case "session.error":
				s.setActivityLocked(p.SessionID, ActivityError)
			case "session.status":
				s.setActivityLocked(p.SessionID, normalizeActivity(p.Status.Type))
			}
		}
	case "message.updated":
		var p struct {
			Info json.RawMessage `json:"info"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && len(p.Info) > 0 {
			s.upsertMessageLocked(p.Info)
		}
	case "message.removed":
		var p struct {
			SessionID string `json:"sessionID"`
			MessageID string `json:"messageID"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil {
			s.deleteMessageLocked(p.SessionID, p.MessageID)
		}
	case "message.part.updated":
		var p struct {
			Part json.RawMessage `json:"part"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && len(p.Part) > 0 {
			s.upsertPartLocked(p.Part)
		}
	case "message.part.delta":
		// Token-level streaming: OpenCode publishes deltas ({field,delta})
		// separately from the full message.part.updated snapshot. Accumulate them
		// so streaming text appears live instead of only at the next snapshot.
		var p struct {
			SessionID string `json:"sessionID"`
			MessageID string `json:"messageID"`
			PartID    string `json:"partID"`
			Field     string `json:"field"`
			Delta     string `json:"delta"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && p.SessionID != "" && p.PartID != "" && p.Delta != "" {
			s.appendPartDeltaLocked(p.SessionID, p.MessageID, p.PartID, p.Field, p.Delta)
		}
	case "message.part.removed":
		var p struct {
			SessionID string `json:"sessionID"`
			MessageID string `json:"messageID"`
			PartID    string `json:"partID"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil {
			s.deletePartLocked(p.SessionID, p.MessageID, p.PartID)
		}
	case "todo.updated":
		var p struct {
			SessionID string `json:"sessionID"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && p.SessionID != "" {
			s.todos[p.SessionID] = ev.Properties
			s.emit(KindTodo, ev.Properties)
		}
	case "permission.asked", "permission.updated":
		// OpenCode emits "permission.asked"; "permission.updated" is kept for
		// compatibility. Properties are the permission Request ({id, sessionID, …}).
		var p permissionEnvelope
		if json.Unmarshal(ev.Properties, &p) == nil && p.SessionID != "" && p.ID != "" {
			if s.perms[p.SessionID] == nil {
				s.perms[p.SessionID] = map[string]json.RawMessage{}
			}
			s.perms[p.SessionID][p.ID] = ev.Properties
			// Phase 1 (Gate C extension): pending-input chokepoint. Phantom-
			// guarded (no-op when SessionID is not yet live; the contribution
			// is seeded on create via maintainSubtreePendingInputOnSessionUpsertLocked).
			s.notePendingInputChangeLocked(p.SessionID)
			s.emit(KindPermissionSet, ev.Properties)
		}
	case "permission.replied":
		// OpenCode sends {sessionID, requestID, reply}; older/fixture payloads use
		// permissionID. Normalize so the client's delete (keyed by permissionID)
		// always clears the card.
		var p struct {
			SessionID    string `json:"sessionID"`
			RequestID    string `json:"requestID"`
			PermissionID string `json:"permissionID"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && p.SessionID != "" {
			id := p.RequestID
			if id == "" {
				id = p.PermissionID
			}
			if m := s.perms[p.SessionID]; m != nil {
				delete(m, id)
			}
			// Phase 1 (Gate C extension): pending-input chokepoint.
			s.notePendingInputChangeLocked(p.SessionID)
			s.emit(KindPermissionClear, rawObj(map[string]interface{}{
				"sessionID": p.SessionID, "permissionID": id,
			}))
		}
	case "question.asked":
		var p struct {
			ID        string `json:"id"`
			SessionID string `json:"sessionID"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && p.SessionID != "" && p.ID != "" {
			if s.questions[p.SessionID] == nil {
				s.questions[p.SessionID] = map[string]json.RawMessage{}
			}
			s.questions[p.SessionID][p.ID] = ev.Properties
			// Phase 1 (Gate C extension): pending-input chokepoint.
			s.notePendingInputChangeLocked(p.SessionID)
			s.emit(KindQuestionSet, ev.Properties)
		}
	case "question.replied", "question.rejected":
		var p struct {
			SessionID string `json:"sessionID"`
			RequestID string `json:"requestID"`
		}
		if json.Unmarshal(ev.Properties, &p) == nil && p.SessionID != "" {
			if m := s.questions[p.SessionID]; m != nil {
				delete(m, p.RequestID)
			}
			// Phase 1 (Gate C extension): pending-input chokepoint.
			s.notePendingInputChangeLocked(p.SessionID)
			s.emit(KindQuestionClear, rawObj(map[string]interface{}{
				"sessionID": p.SessionID, "questionID": p.RequestID,
			}))
		}
	default:
		// server.connected / heartbeat / instance.disposed / file.* — ignored for the view.
	}
}

func (s *Store) upsertSessionLocked(props json.RawMessage) {
	var p struct {
		Info json.RawMessage `json:"info"`
	}
	if json.Unmarshal(props, &p) != nil || len(p.Info) == 0 {
		return
	}
	var env sessionEnvelope
	if json.Unmarshal(p.Info, &env) != nil || env.ID == "" {
		return
	}
	// A session archived in OpenCode (time.archived set) leaves the live tree —
	// e.g. when archived from another client. Treat the update as a delete.
	if env.archivedAt() {
		if _, ok := s.sessions[env.ID]; ok {
			s.deleteSessionLocked(env.ID)
		}
		return
	}
	// Archive tombstone (Issue 4 B-i): a session.updated / session.compacted
	// arriving with archived=null for an id that was recently archived (via
	// RemoveSessions) is the transient clobber — OpenCode rewrote the record
	// from a pre-PATCH snapshot while a busy/compacting descendant was still
	// running. Suppress the resurrection; the live tree stays clean until the
	// tombstone expires or Hydrate confirms the session is genuinely active
	// (unarchive). Without this the session re-enters s.sessions and the next
	// busy status re-promotes it.
	if s.isRecentlyArchivedLocked(env.ID) {
		return
	}
	// Preserve the cold-seeded lastAgent (set by SetLastAgents during hydrate)
	// across a session.updated that replaces the entry. Without this, a
	// metadata/title update for an un-opened session would wipe its cold-seeded
	// agent chip. recomputeLastAssistantLocked below does NOT restore it for
	// un-hydrated sessions (it leaves lastAgent untouched when sm==nil), so we
	// carry it over explicitly here.
	prev := s.sessions[env.ID]
	s.sessions[env.ID] = &sessionEntry{id: env.ID, parentID: env.ParentID, info: p.Info}
	if prev != nil {
		s.sessions[env.ID].lastAgent = prev.lastAgent
		// Preserve the live-set current-activity facet across an entry-replacing
		// session.updated (mirrors lastAgent) so a metadata/title refresh can't
		// wipe "Reading parser.go" for a running subagent.
		s.sessions[env.ID].currentVerb = prev.currentVerb
	}
	// Incremental subtreeBusyCount maintenance (Gate C de-risk prototype):
	// create / reparent. Must run AFTER s.sessions[env.ID] is written (the
	// helper reads the live entry for the same-parent fast path) and BEFORE the
	// emit so a concurrent Snapshot reader (under RLock) never observes a
	// half-updated index. See maintainSubtreeBusyOnSessionUpsertLocked.
	s.maintainSubtreeBusyOnSessionUpsertLocked(env.ID, prev, env.ParentID)
	// Phase 1 (Gate C extension): maintain the 7 remaining indexes. ORDER
	// MATTERS: topology (children) first so the newest-activity local-max
	// recompute reads a consistent children[id]; sums (retry / pendingInput /
	// descendant) in any order (each scans s.sessions independently for the
	// fresh-create orphan reabsorption, matching the prototype); newestActivity
	// last (reads s.children[id]). All no-ops on the same-effective-parent
	// fast path; all under s.mu, before the emit so a concurrent Snapshot
	// reader never observes a half-updated index.
	s.maintainChildrenOnSessionUpsertLocked(env.ID, prev, env.ParentID)
	s.maintainSubtreeRetryOnSessionUpsertLocked(env.ID, prev, env.ParentID)
	s.maintainSubtreePendingInputOnSessionUpsertLocked(env.ID, prev, env.ParentID)
	s.maintainSubtreeDescendantOnSessionUpsertLocked(env.ID, prev, env.ParentID)
	s.maintainNewestActivityOnSessionUpsertLocked(env.ID, prev, env.ParentID)
	// A session.updated replaces the entry, so repopulate the denormalized
	// last-assistant summary from the (persisted) message view.
	s.recomputeLastAssistantLocked(env.ID)
	s.emit(KindSessionUpsert, p.Info)
}

func (s *Store) deleteSessionLocked(id string) {
	// Incremental subtreeBusyCount maintenance (Gate C de-risk prototype):
	// propagate id's whole-subtree contribution out of every live ancestor
	// BEFORE unlinking (we need the entry to read id's parentID and the index
	// entry to read the subtree count). Descendants become orphaned roots on
	// delete; their own subtreeBusyCount values are self-contained (X was their
	// parent, not child) and need no adjustment, matching computeSubtreeBusyLocked.
	if sub := s.subtreeBusyCount[id]; sub != 0 {
		if se := s.sessions[id]; se != nil {
			s.adjustAncestorChainFromLocked(se.parentID, -sub)
		}
	}
	// Phase 2 §9.2: capture the direct children BEFORE maintainIndexesOnDeleteLocked
	// re-roots them and deletes s.children[id]. We emit orphan-check for each
	// newly-rooted child's subtree AFTER the delete is fully applied (below) so
	// effectiveParentOfLocked returns "" for the reparented children.
	var reparentedChildren []string
	// Phase 1 (Gate C extension): maintain the 7 remaining indexes. Same shape
	// as the prototype busy-delete block above, but unified in one helper
	// (sum-class propagation, topology orphaning + unlink, max-class chain
	// recompute, bucket removal). Must run BEFORE the per-session delete(...)
	// calls — we read se.parentID + the index entries to resolve subtrees.
	if se := s.sessions[id]; se != nil {
		reparentedChildren = append(reparentedChildren, s.children[id]...)
		s.maintainIndexesOnDeleteLocked(id, se)
	}
	// Maintain the terminal KindActivity(idle) finish-cascade for a deleted
	// BUSY/RETRY session. deleteSessionLocked deletes s.activity[id] silently
	// below and emits only KindSessionDelete; a client that held
	// activity[id]="busy" (snapshot seed or last busy event) is never told the
	// id transitioned out of busy — node.remove prunes the TreeRow, but the
	// chat-side syncState.activity[id] (read by Part.tsx for the parent's task
	// tool status) retains the stale "busy" indefinitely. This emit (the
	// finish-side counterpart to the frontier-promotion gap fix) clears it in
	// the same transition.
	//
	// NOTE: the per-root busy COUNT needs no explicit maintenance here. It is
	// derived from subtreeBusyCount (the single source of truth), whose delete
	// maintenance ran ABOVE — maintainIndexesOnDeleteLocked + the prototype
	// block propagate id's whole-subtree contribution out of every live
	// ancestor, so subtreeBusyCount[root] already reflects the deletion. The
	// retired busyCount needed a bespoke non-root decrement here because it was
	// a separate root-keyed index; that asymmetry (and the reparent gap) is why
	// it was retired. The emit must precede the KindSessionDelete emit below so
	// a client processing events in seq order clears the chat activity map
	// BEFORE the structural prune lands. No setActivityLocked call: that would
	// re-run the subtree maintenance (already done above) and fire a spurious
	// markUnread on a session being removed.
	if a := s.activity[id]; a == ActivityBusy || a == ActivityRetry {
		s.emit(KindActivity, rawObj(map[string]interface{}{"sessionID": id, "state": ActivityIdle}))
	} else if a == ActivityError {
		// Finish-cascade (error mirror): emit a terminal KindActivity(idle)
		// for a session that was observably in the ERROR state so every
		// observer (chat + tree) drops the error signal in the same
		// transition. isActiveLocked (tree_emitter.go:201-213) treats
		// ActivityError as active (a client that held activity[id]="error"
		// has an observable active signal), so the symmetric finish-side
		// cascade must cover it too — otherwise deleting an errored
		// subsession leaves the chat-side syncState.activity[id]="error"
		// stale on a session that no longer exists (cosmetic: error is
		// terminal so isActivityWorking("error") is false → no spinner/heat,
		// but the red dot persists on the parent's task row).
		//
		// SUBTLETY (load-bearing): error MUST NOT contribute to the busy count.
		// subtreeBusySelfLocked flags only {Busy, Retry} (error never
		// incremented subtreeBusyCount on entry, so decrementing on exit would
		// corrupt the count and under-report RunningRoots). That is why this is
		// a SEPARATE else-if and NOT a widening of the outer `if` to
		// `|| a == ActivityError`. No setActivityLocked call either: that
		// would re-run maintenance already done above and fire a spurious
		// markUnread on a session being removed (same reasoning as the
		// busy/retry branch). The emit must precede the KindSessionDelete
		// below so a client applying events in seq order clears the chat
		// activity map before the structural prune lands.
		s.emit(KindActivity, rawObj(map[string]interface{}{"sessionID": id, "state": ActivityIdle}))
	}
	delete(s.sessions, id)
	delete(s.messages, id)
	delete(s.msgLoaded, id)
	delete(s.msgRev, id)
	delete(s.coldFetchActive, id)
	// Drop the cold-seed memo so a session recreated under the same id (live
	// session.deleted then session.created, an archive/un-archive, or a hydrate
	// prune-then-reappear) gets its lastAgent re-seeded from a fresh tail fetch.
	delete(s.seeded, id)
	delete(s.todos, id)
	delete(s.perms, id)
	delete(s.questions, id)
	delete(s.statuses, id)
	delete(s.activity, id)
	delete(s.activitySeq, id)
	delete(s.unread, id)
	delete(s.subtreeBusyCount, id) // per-root busy aggregate is derived from this index (single source of truth)
	// Phase 1 (Gate C extension): drop id's own entries from each new index.
	delete(s.children, id) // direct-child list (already emptied by orphaning)
	delete(s.subtreeRetryCount, id)
	delete(s.subtreePendingInput, id)
	delete(s.pendingInputSelf, id)
	delete(s.subtreeDescendantCount, id)
	delete(s.lastActivityAt, id)
	delete(s.subtreeNewestActivity, id)
	// Cancel any pending completion-grace timer and drop the completion-authority
	// guard: the session is gone, so neither a deferred idle clear nor a stale
	// busy guard applies to this id (and a recreated id starts fresh).
	s.cancelGraceLocked(id)
	delete(s.completionAuthoritative, id)
	// Clear the automated-spawn permission-blocked fact on termination. This is
	// the single session-removal chokepoint (live session.deleted, archive via
	// time.archived, and hydrate prune all funnel here), so one delete covers
	// every termination cause. Caller accounting keyed on permission_blocked
	// observes it while the session is alive; once gone, the gate is gone too.
	delete(s.permBlocked, id)
	s.emit(KindSessionDelete, rawObj(map[string]interface{}{"id": id}))
	// Phase 2 §9.2: after the topology change is fully applied (s.sessions[id]
	// deleted, KindSessionDelete emitted), emit orphan-check for each newly-
	// rooted child's subtree. The chain root changed from the deleted node to
	// the child itself (now a root) → orphan=false for the child and descendants.
	// Q5: ONLY newly-rooted children are checked — no sibling sweep.
	for _, cid := range reparentedChildren {
		for _, did := range s.descendantsLocked(cid) {
			s.emit(KindTreeOrphanCheck, rawObj(map[string]interface{}{"id": did}))
		}
	}
}

// SetPendingQuestions reconciles the pending-question set to exactly the given
// requests (the GET /question response). Used on (re-)hydrate so a question that
// arrived as a missed live event — e.g. across a daemon restart — is restored.
// Emits upserts for present requests and clears for ones no longer pending.
func (s *Store) SetPendingQuestions(requests []json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	seen := map[string]bool{}
	for _, raw := range requests {
		var e struct {
			ID        string `json:"id"`
			SessionID string `json:"sessionID"`
		}
		if json.Unmarshal(raw, &e) != nil || e.ID == "" || e.SessionID == "" {
			continue
		}
		seen[e.SessionID+"\x00"+e.ID] = true
		if s.questions[e.SessionID] == nil {
			s.questions[e.SessionID] = map[string]json.RawMessage{}
		}
		s.questions[e.SessionID][e.ID] = raw
		// Phase 1 (Gate C extension): pending-input chokepoint (per add).
		s.notePendingInputChangeLocked(e.SessionID)
		s.emit(KindQuestionSet, raw)
	}
	for sid, m := range s.questions {
		for id := range m {
			if !seen[sid+"\x00"+id] {
				delete(m, id)
				// Phase 1 (Gate C extension): pending-input chokepoint (per delete).
				s.notePendingInputChangeLocked(sid)
				s.emit(KindQuestionClear, rawObj(map[string]interface{}{"sessionID": sid, "questionID": id}))
			}
		}
	}
}

// SetPendingPermissions reconciles the pending-permission set to exactly the
// given requests (the GET /permission response) — the permission counterpart of
// SetPendingQuestions.
func (s *Store) SetPendingPermissions(requests []json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	seen := map[string]bool{}
	for _, raw := range requests {
		var e permissionEnvelope
		if json.Unmarshal(raw, &e) != nil || e.ID == "" || e.SessionID == "" {
			continue
		}
		seen[e.SessionID+"\x00"+e.ID] = true
		if s.perms[e.SessionID] == nil {
			s.perms[e.SessionID] = map[string]json.RawMessage{}
		}
		s.perms[e.SessionID][e.ID] = raw
		// Phase 1 (Gate C extension): pending-input chokepoint (per add).
		s.notePendingInputChangeLocked(e.SessionID)
		s.emit(KindPermissionSet, raw)
	}
	for sid, m := range s.perms {
		for id := range m {
			if !seen[sid+"\x00"+id] {
				delete(m, id)
				// Phase 1 (Gate C extension): pending-input chokepoint (per delete).
				s.notePendingInputChangeLocked(sid)
				s.emit(KindPermissionClear, rawObj(map[string]interface{}{"sessionID": sid, "permissionID": id}))
			}
		}
	}
}

func (s *Store) upsertMessageLocked(info json.RawMessage) {
	var env messageInfoEnvelope
	if json.Unmarshal(info, &env) != nil || env.ID == "" || env.SessionID == "" {
		return
	}
	sm := s.messages[env.SessionID]
	if sm == nil {
		sm = &sessionMessages{byID: map[string]*messageEntry{}}
		s.messages[env.SessionID] = sm
	}
	// wasCompleted captures the PRE-update completion state so the escalation
	// block below can detect a live inflight→completed transition (the only
	// event that arms the completion-grace window). A cold-load insert of an
	// already-completed message sets wasCompleted=false too, but it does not
	// route through this live Apply path's grace arming (gated on the
	// transition AND !assistantInflightLocked, and cold-load goes via Hydrate).
	var wasCompleted bool
	if me := sm.byID[env.ID]; me != nil {
		wasCompleted = me.completed
		me.info = info
		me.role = env.Role
		me.completed = env.Time.Completed != nil
		me.finish = env.Finish
		me.tokens = env.Tokens
		me.agent = env.Agent
		// Mark live-touched so a concurrent cold-load reconcile (background
		// full-history GET in flight) does NOT clobber this newer live body
		// with the stale fetched one (C-F2). Only tagged while a cold GET is
		// in flight (coldFetchActive); events outside that window are
		// authoritative snapshots the next reconcile can overwrite. Cleared
		// after the cold reconcile.
		if s.coldFetchActive[env.SessionID] {
			me.liveTouchedBody = true
		}
	} else {
		sm.byID[env.ID] = &messageEntry{
			id: env.ID, info: info, parts: map[string]json.RawMessage{},
			role: env.Role, completed: env.Time.Completed != nil,
			finish: env.Finish, tokens: env.Tokens, agent: env.Agent,
		}
		sm.order = append(sm.order, env.ID)
		// A live-created message is also live-touched (its body is at least as
		// new as what the in-flight cold GET will return) — but only while a
		// cold GET is in flight.
		if s.coldFetchActive[env.SessionID] {
			sm.byID[env.ID].liveTouchedBody = true
		}
	}
	// Any change to this session's message body/order changes its cold-batch
	// projection, so bump the per-session message revision token under the
	// lock. This is what lets publishColdBatch discard a stale prepared batch
	// when a live mutation lands during (unlocked) packaging.
	s.bumpMsgRev(env.SessionID)
	s.emit(KindMessageUpsert, info)
	if env.Role == "assistant" {
		s.recomputeLastAssistantLocked(env.SessionID)
		// An assistant message.updated marks a turn boundary (a completing turn's
		// running tools finalize, or a new multi-step turn begins): re-evaluate the
		// current-activity facet. When all tools completed it clears; when a new
		// turn's first tool is already running it sets.
		s.recomputeCurrentVerbLocked(env.SessionID)
	}

	// Escalate to busy from the live message stream: OpenCode's session.status/idle
	// events are not reliable for a streaming turn (a session can generate for
	// minutes while still reporting idle), which left the sidebar showing no
	// spinner for an actively-running session. An in-flight assistant message is
	// the authoritative "generating" signal.
	//
	// We only SET busy synchronously here, never idle. A multi-step turn
	// (text → tool → text) produces several assistant messages, and between two
	// steps there's a gap where no assistant message is in-flight yet —
	// inferring idle from that gap flipped the session idle→busy repeatedly
	// within a single logical run, and each transient idle dip fired a spurious
	// "finished" notification (one per tool call). Synchronous idle is owned by
	// the authoritative session.idle event (fires once when the turn truly ends)
	// and by the rehydrate snapshot.
	//
	// The MISSED-session.idle case (dropped tunnel / reconnect gap / a turn that
	// ended without OpenCode emitting idle) left subtreeBusyCount[root] stranded
	// at 1 until the ~60s /session/status reconcile cleared it — and if
	// /session/status itself was stale (reported busy) the strand was permanent.
	// The completion-grace window closes that gap: when an assistant message
	// transitions inflight→completed AND no assistant message remains
	// in-flight, arm a short timer (completionGrace, default 5s). If no new
	// activity arrives within the window the turn is authoritatively over, so
	// graceFire clears busy (subtreeBusyCount→0, RunningRoots correct) and arms
	// the completion-authority guard so a stale /session/status cannot
	// re-strand.
	// A new inflight message within the window cancels the timer (multi-step
	// turn — no spinner dip, no spurious "finished"). See armGraceLocked /
	// graceFire / SetActivityFromStatuses.
	if env.Role == "assistant" {
		switch {
		case s.assistantInflightLocked(env.SessionID):
			// An in-flight assistant message is generating right now: assert
			// busy (cheap no-op once set). A NEW inflight also cancels any
			// pending completion-grace (the turn is continuing, not ending) and
			// clears the completion-authority guard (a new turn started, so a
			// prior turn's authority no longer applies).
			s.cancelGraceLocked(env.SessionID)
			delete(s.completionAuthoritative, env.SessionID)
			s.setActivityLocked(env.SessionID, ActivityBusy)
		case !wasCompleted && env.Time.Completed != nil:
			// This assistant message just transitioned to completed AND no
			// assistant message is in-flight: the turn MAY have ended. We
			// cannot know synchronously whether this is the final completion
			// (turn over) or a multi-step gap (the next step's inflight message
			// has not arrived yet), so defer the idle clear past the typical
			// inter-step gap via the completion-grace window.
			s.armGraceLocked(env.SessionID)
		}
	}
}

// assistantInflightLocked reports whether a session has an assistant message
// that hasn't completed yet (i.e. a turn is still generating). Caller holds s.mu.
func (s *Store) assistantInflightLocked(sessionID string) bool {
	sm := s.messages[sessionID]
	if sm == nil {
		return false
	}
	for _, me := range sm.byID {
		if me.role == "assistant" && !me.completed {
			return true
		}
	}
	return false
}

// recomputeLastAssistantLocked refreshes a session's denormalized last-assistant
// summary (finish reason + token usage + completion of the most recent assistant
// message) from the in-memory message view, so the tree-only list snapshot can
// expose the gate facts without the full history being hydrated. A session that
// ran a turn during this daemon's lifetime has its messages in the store from the
// live event stream, so this is populated for exactly the sessions a coordinator
// can observe transitioning. Caller holds s.mu.
func (s *Store) recomputeLastAssistantLocked(sessionID string) {
	se := s.sessions[sessionID]
	if se == nil {
		return
	}
	sm := s.messages[sessionID]
	if sm == nil {
		// Messages not hydrated. Reset the gate-facts fields that are only
		// authoritative when hydrated (mirrors the pre-existing behavior), but
		// PRESERVE lastAgent — it may have been cold-seeded by SetLastAgents
		// during hydrate for a session whose full history we deliberately don't
		// fetch. Resetting it here would wipe every cold-seeded chip the moment a
		// session.updated (e.g. a title/metadata refresh) replaced the entry, since
		// upsertSessionLocked routes here after the replace. lastAgent becomes
		// authoritative again once the session is opened (messages loaded → this
		// branch is skipped and the scan below sets it from real data).
		se.hasAssistant = false
		se.lastFinish = ""
		se.lastTokens = nil
		se.lastAsstCompleted = false
		se.lastAsstEmpty = false
		return
	}
	se.hasAssistant = false
	se.lastFinish = ""
	se.lastTokens = nil
	se.lastAsstCompleted = false
	se.lastAsstEmpty = false
	// Compute the final lastAgent from the in-memory view WITHOUT writing it
	// directly. The two historical writers here — a reset to "" before the scan
	// and a set to the newest assistant's agent inside the scan — are routed
	// through the universal setLastAgentLocked chokepoint as a SINGLE diff so a
	// no-net-change recompute (was X, would have reset to "" then back to X)
	// advances neither the seq nor an event. The helper is a no-op on an
	// unchanged value (honors the observable-mutation no-op rule).
	finalAgent := ""
	for i := len(sm.order) - 1; i >= 0; i-- {
		me := sm.byID[sm.order[i]]
		if me == nil || me.role != "assistant" {
			continue
		}
		se.hasAssistant = true
		se.lastFinish = me.finish
		se.lastTokens = me.tokens
		se.lastAsstCompleted = me.completed
		se.lastAsstEmpty = !messageHasContent(me)
		finalAgent = me.agent
		break
	}
	s.setLastAgentLocked(sessionID, finalAgent)
}

// setLastAgentLocked is the UNIVERSAL chokepoint for every observable lastAgent
// mutation. It enforces the publication-integrity invariant: a real snapshot-
// visible change produces exactly one KindLastAgentSet event AND one sequence
// advance, while an unchanged value or an unknown session is a total no-op (no
// write, no event, no seq bump). The four direct writers route through it:
// SetLastAgents (cold seed), and recomputeLastAssistantLocked's computed final
// value (covers the former reset-to-"" and set-from-newest-assistant writers, as
// well as every indirect recompute callsite). upsertSessionLocked's entry-
// replace preserve is intentionally NOT routed here — it carries lastAgent over
// at entry construction (a preserve, not a mutation) and must not emit. Caller
// MUST hold s.mu.
func (s *Store) setLastAgentLocked(sid, agent string) {
	se := s.sessions[sid]
	if se == nil {
		return // unknown session: no event, no seq advance
	}
	if se.lastAgent == agent {
		return // unchanged: no event, no seq advance
	}
	se.lastAgent = agent
	s.emit(KindLastAgentSet, rawObj(map[string]interface{}{
		"sessionID": sid,
		"agent":     agent,
	}))
}

// recomputeCurrentVerbLocked refreshes a session's rich current-activity facet
// (tool name + salient state) from the in-memory message view, mirroring the
// client's activeVerbFromTurn scan: the newest assistant message is scanned
// newest-part-first for the first RUNNING tool, whose {tool, state} becomes the
// facet. When no running tool is found (turn boundary, all tools completed) the
// facet is cleared. It is the Tier-A source that lets a client render
// "Reading parser.go" for an UNOPENED subagent — Go emits the RAW primitive and
// the client formats it via its existing toolVerb/toolSubject (Path B2).
//
// Only the formatting-salient state fields (input + status + time.start) are
// stored, so a running tool whose output grows part-by-part does NOT re-emit:
// the verb/subject are stable across that growth. Idempotent — emits
// KindActivityVerb only when the facet actually changes. Caller holds s.mu.
//
// Hooked from upsertPartLocked (part snapshots → tool transitions) and
// upsertMessageLocked (assistant turn boundary); cleared authoritatively by
// setActivityLocked on idle/error. Mirrors recomputeLastAssistantLocked.
func (s *Store) recomputeCurrentVerbLocked(sessionID string) {
	se := s.sessions[sessionID]
	if se == nil {
		return
	}
	var next VerbFacet
	if sm := s.messages[sessionID]; sm != nil {
		for i := len(sm.order) - 1; i >= 0; i-- {
			me := sm.byID[sm.order[i]]
			if me == nil || me.role != "assistant" {
				continue
			}
			// Newest assistant message: scan its parts newest-first for the first
			// running tool (matches activeVerbFromTurn's pass-1 precedence).
			for j := len(me.partOrder) - 1; j >= 0; j-- {
				raw := me.parts[me.partOrder[j]]
				var p struct {
					Type  string          `json:"type"`
					Tool  string          `json:"tool"`
					State json.RawMessage `json:"state"`
				}
				if json.Unmarshal(raw, &p) != nil || p.Type != "tool" {
					continue
				}
				var st struct {
					Status string          `json:"status"`
					Input  json.RawMessage `json:"input"`
					Time   struct {
						Start *float64 `json:"start"`
					} `json:"time"`
				}
				_ = json.Unmarshal(p.State, &st)
				if st.Status != "running" {
					continue // not live — keep scanning older parts
				}
				next = VerbFacet{Tool: p.Tool, State: verbStatePayload(st.Status, st.Input, st.Time.Start)}
				break
			}
			break // only the newest assistant message bounds the in-flight turn
		}
	}
	s.setCurrentVerbLocked(sessionID, next)
}

// verbStatePayload marshals the formatting-salient slice of a tool part's state
// (input + status + time.start) into a stable object the client feeds verbatim
// to toolVerb/toolSubject. Trimming the mutable output/error/metadata keeps the
// facet byte-stable while a tool runs, so its growing output doesn't re-emit.
// json.Marshal sorts map keys, so the output is deterministic for byte compare.
func verbStatePayload(status string, input json.RawMessage, start *float64) json.RawMessage {
	m := map[string]any{}
	if status != "" {
		m["status"] = status
	}
	if len(input) > 0 && string(input) != "null" {
		m["input"] = input // already JSON; embed raw (json.Marshal copies bytes)
	}
	if start != nil {
		m["time"] = map[string]any{"start": *start}
	}
	b, _ := json.Marshal(m)
	return b
}

// setCurrentVerbLocked records a session's current-activity facet and emits a
// KindActivityVerb event ONLY when it changes (idempotent). An empty Tool clears
// the facet. Caller holds s.mu.
func (s *Store) setCurrentVerbLocked(sessionID string, facet VerbFacet) {
	se := s.sessions[sessionID]
	if se == nil {
		return
	}
	prev := se.currentVerb
	if facet.Tool == prev.Tool && bytes.Equal(facet.State, prev.State) {
		return
	}
	se.currentVerb = facet
	payload, _ := json.Marshal(map[string]any{
		"sessionID": sessionID,
		"tool":      facet.Tool,
		"state":     json.RawMessage(facet.State),
	})
	s.emit(KindActivityVerb, payload)
}

// messageHasContent reports whether an assistant message did anything: produced a
// non-whitespace TEXT reply, OR called a tool, OR emitted a file. A turn with any
// of those is NOT empty. Only "envelope" parts (reasoning, step markers, etc.)
// with no text/tool/file → empty (the GLM empty-stop case). A tool-only turn is
// the agent WORKING, so it counts as non-empty (don't auto-continue it).
func messageHasContent(me *messageEntry) bool {
	for _, raw := range me.parts {
		var p struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}
		if json.Unmarshal(raw, &p) != nil {
			continue
		}
		switch p.Type {
		case "tool", "file":
			return true
		case "text":
			if strings.TrimSpace(p.Text) != "" {
				return true
			}
		}
	}
	return false
}

func (s *Store) deleteMessageLocked(sessionID, messageID string) {
	sm := s.messages[sessionID]
	if sm != nil {
		if _, ok := sm.byID[messageID]; ok {
			delete(sm.byID, messageID)
			sm.order = removeString(sm.order, messageID)
		}
	}
	s.recomputeLastAssistantLocked(sessionID)
	// A message deletion changes this session's cold-batch projection; bump the
	// per-session message revision token so a concurrently-packaging cold batch
	// is discarded as stale.
	s.bumpMsgRev(sessionID)
	s.emit(KindMessageDelete, rawObj(map[string]interface{}{"sessionID": sessionID, "messageID": messageID}))
}

func (s *Store) upsertPartLocked(part json.RawMessage) {
	var env partEnvelope
	if json.Unmarshal(part, &env) != nil || env.ID == "" || env.MessageID == "" || env.SessionID == "" {
		return
	}
	sm := s.messages[env.SessionID]
	if sm == nil {
		sm = &sessionMessages{byID: map[string]*messageEntry{}}
		s.messages[env.SessionID] = sm
	}
	me := sm.byID[env.MessageID]
	if me == nil {
		// Part can arrive before its message.updated; create a placeholder.
		me = &messageEntry{id: env.MessageID, parts: map[string]json.RawMessage{}}
		sm.byID[env.MessageID] = me
		sm.order = append(sm.order, env.MessageID)
	}
	if _, ok := me.parts[env.ID]; !ok {
		me.partOrder = append(me.partOrder, env.ID)
	}
	// Apply the per-part text cap (P1-AGG-006) on the wholesale path: a single
	// part.upsert carrying a huge payload (or a history-fetch entry) is bounded
	// here. capPartJSON is a no-op for parts under the cap. discardPartDelta
	// below reseeds the accumulator from this capped authoritative text, so the
	// next streaming delta appends onto a cap-respecting base.
	part = capPartJSON(part, s.partTextCap)
	me.parts[env.ID] = part
	// Mark live-touched so a concurrent cold-load reconcile does NOT clobber
	// this newer live part body with the stale fetched one (C-F2). Only tagged
	// while a cold GET is in flight (coldFetchActive); events outside that
	// window are authoritative snapshots the next reconcile can overwrite.
	// Cleared after the cold reconcile.
	if s.coldFetchActive[env.SessionID] {
		if me.liveTouchedParts == nil {
			me.liveTouchedParts = map[string]bool{}
		}
		me.liveTouchedParts[env.ID] = true
	}
	// An authoritative part snapshot changes this session's cold-batch
	// projection; bump the per-session message revision token so a concurrently-
	// packaging cold batch is discarded as stale.
	s.bumpMsgRev(env.SessionID)
	s.emit(KindPartUpsert, part)
	// Authoritative snapshot: discard any unflushed streaming accumulator for
	// this part — the snapshot supersedes buffered deltas (never let stale
	// buffered text override truth). The next delta re-seeds the accumulator
	// from this snapshot's field value, so deltas append onto the correct base.
	discardPartDeltaLocked(me, env.ID)
	// A part can finalize the latest assistant turn's text content (and parts may
	// arrive after the completed message.updated), so refresh the empty/finish
	// summary. Streaming deltas don't need this — the turn isn't completed yet, and
	// a part.updated snapshot follows them.
	s.recomputeLastAssistantLocked(env.SessionID)
	// Tool transitions arrive as part.updated snapshots (status running→completed,
	// or a new tool starting): refresh the rich current-activity facet. The
	// per-token delta path (appendPartDeltaLocked) deliberately does NOT route here
	// — it must not drive verb emission.
	s.recomputeCurrentVerbLocked(env.SessionID)
}

// appendPartDeltaLocked applies a streaming text delta to a part using a NATIVE
// accumulator (strings.Builder) + a lazy time-throttled emit, instead of the
// old per-delta full JSON unmarshal+marshal + O(n²) full-text copy. The delta is
// always appended to the accumulator (cheap); the expensive rebuild+emit fires
// at most once per deltaFlushInterval. A later message.part.updated snapshot
// overwrites the part authoritatively and resets the accumulator (see
// upsertPartLocked). This is the WRITE-SIDE throttle flush into me.parts (the
// per-message emit path), distinct from the READ-SIDE projection: a Snapshot
// captures the unflushed accumulator (per partID) under RLock into a private
// copy, then overlays it onto a fresh part copy during lock-free
// materialization (projectPartCaptured) WITHOUT writing back into me.parts, so
// a point-in-time read reflects the live accumulated text while the
// accumulator stays intact for the writer.
func (s *Store) appendPartDeltaLocked(sessionID, messageID, partID, field, delta string) {
	if field == "" {
		field = "text"
	}
	sm := s.messages[sessionID]
	if sm == nil {
		sm = &sessionMessages{byID: map[string]*messageEntry{}}
		s.messages[sessionID] = sm
	}
	me := sm.byID[messageID]
	if me == nil {
		me = &messageEntry{id: messageID, parts: map[string]json.RawMessage{}}
		sm.byID[messageID] = me
		sm.order = append(sm.order, messageID)
	}
	// Ensure a part envelope exists (a delta can precede its part.updated) so
	// the part is ordered + the accumulator has a base to seed from. A later
	// message.part.updated overwrites it authoritatively.
	if _, had := me.parts[partID]; !had {
		me.parts[partID] = partPlaceholderJSON(partID, sessionID, messageID)
		me.partOrder = append(me.partOrder, partID)
	}
	// Mark live-touched so a concurrent cold-load reconcile does NOT clobber
	// this part's live-accumulated text (deltaBuf) with the stale fetched
	// body, nor wipe the unflushed accumulator (C-F2). Only tagged while a
	// cold GET is in flight (coldFetchActive). Cleared after the cold
	// reconcile.
	if s.coldFetchActive[sessionID] {
		if me.liveTouchedParts == nil {
			me.liveTouchedParts = map[string]bool{}
		}
		me.liveTouchedParts[partID] = true
	}

	// Native accumulator: append the delta to a strings.Builder keyed by
	// (partID, field). strings.Builder amortizes the growth, so N single-char
	// deltas cost O(N) total — NOT the old O(n²) full-text copy. The Builder
	// holds the authoritative accumulated field text; me.parts[partID] lags by
	// at most one throttle window.
	key := partID + "\x00" + field
	buf, ok := me.deltaBuf[key]
	if !ok {
		buf = &strings.Builder{}
		// Seed from the part's current authoritative field value (a prior
		// snapshot's text, or "" for the placeholder). This is the ONE unmarshal
		// per burst — not per char.
		var p map[string]any
		_ = json.Unmarshal(me.parts[partID], &p)
		if v, ok := p[field].(string); ok {
			buf.WriteString(v)
		}
		if me.deltaBuf == nil {
			me.deltaBuf = map[string]*strings.Builder{}
		}
		me.deltaBuf[key] = buf
	}
	// Per-part text cap (P1-AGG-006 guardrail): if this (partID, field) is
	// already sealed at the cap, drop the delta — the part's text is frozen
	// at the cap with the truncation marker. Otherwise append and re-check
	// the cap; if the accumulated text crossed it, truncate to (cap - marker)
	// and append a visible marker recording the omitted byte count, then seal
	// so further deltas are dropped. Bounds store memory regardless of upstream
	// output volume (a 100 MB bash stdout stays at the cap). The throttle flush
	// below persists the sealed text into me.parts naturally. Sealing is
	// deterministic: same input → same truncated text + marker → revision
	// validation is not falsely invalidated.
	if me.sealedFields == nil || !me.sealedFields[key] {
		buf.WriteString(delta)
		if buf.Len() > s.partTextCap {
			// strings.Builder has no truncate-in-place; rebuild.
			capped, _ := applyCapToString(buf.String(), s.partTextCap)
			buf.Reset()
			buf.WriteString(capped)
			if me.sealedFields == nil {
				me.sealedFields = map[string]bool{}
			}
			me.sealedFields[key] = true
		}
	}

	// Time-throttled flush (lazy, no goroutine): rebuild the part JSON from the
	// native accumulator + emit part.upsert at most ~1× per deltaFlushInterval.
	// The first delta of a burst always flushes (deltaLastEmit zero → elapsed
	// huge) so the first token appears instantly.
	now := time.Now()
	if now.Sub(me.deltaLastEmit) >= s.deltaFlushInterval {
		me.flushPartDeltasLocked(s, true)
		me.deltaLastEmit = now
	}

	// A streaming delta (and its throttled flush, which rewrites me.parts
	// directly without going through upsertPartLocked) changes this session's
	// cold-batch projection; bump the per-session message revision token so a
	// concurrently-packaging cold batch is discarded as stale.
	s.bumpMsgRev(sessionID)

	// Streaming deltas mean the turn is actively generating right now — assert
	// busy (cheap no-op once set) even when this delta was buffered. Cleared
	// when the assistant message completes (upsertMessageLocked arms the
	// completion-grace window) or on session.idle. This makes the running
	// indicator track real token flow even when OpenCode's session.status lags.
	//
	// The !me.completed guard closes the message.part.delta ordering race: a
	// trailing delta arriving AFTER the message's time.completed (an in-connection
	// reorder — SSE has no cross-reconnect replay) must NOT re-arm busy on an
	// already-completed message, which would re-strand busyCount past the
	// completion-grace clear.
	if me.role != "user" && !me.completed {
		s.setActivityLocked(sessionID, ActivityBusy)
	}
}

// flushPartDeltasLocked rebuilds me.parts from any unflushed deltaBuf entries
// and, when emit is true, emits a part.upsert for each changed part. Called at
// the throttle boundary in appendPartDeltaLocked (emit=true, under Apply's
// lock). The accumulators are KEPT across the flush (not deleted): subsequent
// deltas keep appending to the same Builder, and the next flush SETS the field
// from the full accumulated text (never appends), so there is no
// double-application. Reset happens only on authoritative overwrite
// (upsertPartLocked / reconcileMessagesLocked) or part deletion. Caller holds
// s.mu in WRITE mode (this method mutates me.parts and may emit).
//
// Snapshot does NOT call this method — it captures the buffered deltas onto
// fresh copies under RLock and overlays them during a lock-free materialization
// (projectPartCaptured) without writing back to me.parts, so Snapshot can run
// under RLock and its heavy projection can run after RUnlock.
func (me *messageEntry) flushPartDeltasLocked(s *Store, emit bool) {
	for key, buf := range me.deltaBuf {
		partID, field, ok := strings.Cut(key, "\x00")
		if !ok {
			continue
		}
		var part map[string]any
		_ = json.Unmarshal(me.parts[partID], &part)
		if part == nil {
			// Defensive: the placeholder is always created in appendPartDeltaLocked
			// before a buffer exists, so this only triggers under malformed state.
			part = map[string]any{"id": partID, "type": "text"}
		}
		part[field] = buf.String()
		if updated, err := json.Marshal(part); err == nil {
			me.parts[partID] = updated
			if emit {
				s.emit(KindPartUpsert, updated)
			}
		}
	}
}

// discardPartDeltaLocked drops every streaming accumulator entry whose partID
// matches — used when an authoritative snapshot (message.part.updated) or a
// history-fetch reconcile supersedes buffered deltas, and on part deletion.
// Also clears the matching sealed-fields entries: a fresh authoritative base
// re-evaluates the cap from scratch. Caller holds s.mu.
func discardPartDeltaLocked(me *messageEntry, partID string) {
	if me == nil {
		return
	}
	if me.deltaBuf != nil {
		for k := range me.deltaBuf {
			if pid, _, ok := strings.Cut(k, "\x00"); ok && pid == partID {
				delete(me.deltaBuf, k)
			}
		}
	}
	if me.sealedFields != nil {
		for k := range me.sealedFields {
			if pid, _, ok := strings.Cut(k, "\x00"); ok && pid == partID {
				delete(me.sealedFields, k)
			}
		}
	}
}

// partPlaceholderJSON returns a minimal text-part JSON for a delta that arrived
// before its message.part.updated (so the part is orderable + the accumulator
// has a base to seed from). The streaming field starts empty; deltas populate
// it via the native accumulator. A later message.part.updated overwrites it
// authoritatively.
func partPlaceholderJSON(partID, sessionID, messageID string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{
		"id": partID, "sessionID": sessionID, "messageID": messageID, "type": "text",
	})
	return b
}

func (s *Store) deletePartLocked(sessionID, messageID, partID string) {
	if sm := s.messages[sessionID]; sm != nil {
		if me := sm.byID[messageID]; me != nil {
			if _, ok := me.parts[partID]; ok {
				delete(me.parts, partID)
				me.partOrder = removeString(me.partOrder, partID)
			}
			// Drop any streaming accumulator for the deleted part.
			discardPartDeltaLocked(me, partID)
		}
	}
	// A part deletion changes this session's cold-batch projection; bump the
	// per-session message revision token so a concurrently-packaging cold batch
	// is discarded as stale.
	s.bumpMsgRev(sessionID)
	s.emit(KindPartDelete, rawObj(map[string]interface{}{
		"sessionID": sessionID, "messageID": messageID, "partID": partID,
	}))
	s.recomputeLastAssistantLocked(sessionID)
}

// MarkPermissionBlocked records that sessionID's automated-spawn permission
// policy auto-rejected a prompt. This sets an OBSERVABLE FACT (rendered on the
// gate as PermissionBlocked) — the policy decision lives in the web layer; the
// store only records the outcome so callers can observe it post-hoc. The flag
// is sticky past the permission clearing and is cleared on session termination
// (deleteSessionLocked). On the FIRST false→true transition it emits one
// KindPermissionBlocked event (advancing the seq); repeat calls on an already-
// blocked session are idempotent (no event, no seq advance). No-op if the
// session is no longer tracked.
func (s *Store) MarkPermissionBlocked(sessionID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.sessions[sessionID]; !ok {
		return
	}
	if s.permBlocked[sessionID] {
		return // idempotent: already blocked — no event, no seq advance
	}
	s.permBlocked[sessionID] = true
	s.emit(KindPermissionBlocked, rawObj(map[string]interface{}{
		"sessionID":            sessionID,
		"permissionWasBlocked": true,
	}))
}

func removeString(xs []string, x string) []string {
	for i, v := range xs {
		if v == x {
			return append(xs[:i], xs[i+1:]...)
		}
	}
	return xs
}
