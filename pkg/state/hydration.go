// Package state: the hydration concern — the (re)connect bulk-load + lazy-load
// surface of the store, mechanically extracted from store.go (reference model:
// subtree_indexes.go / snapshots.go / message_window.go). This file owns:
//   - Hydrate — the daemon (re)connect bulk-load entry point, which direct-
//     assigns s.sessions (bypassing the reducer's upsertSessionLocked) and so
//     must maintain all 6 subtree indexes itself;
//   - reconcileMessagesLocked — the per-session authoritative history reconcile
//     shared by Hydrate (bulk) and SetSessionMessages (lazy), returning the
//     cold-load signal that drives the wholesale batch path;
//   - SetSessionMessages — the lazy per-session hydration entry (first open);
//   - MarkColdFetchStart / ClearColdFetchActive — the C-F2 cold-fetch window
//     markers that let the reconcile preserve newer live bodies;
//   - SetLastAgents / ColdSeedNeeded / MarkColdSeeded — the cold-seed surface
//     that lets the tree render per-agent chips before any session's full
//     message history is hydrated.
//
// The Store struct and its single s.mu RWMutex stay in store.go and are shared
// across this whole package (same-package file split; no protocol change). The
// sessions / messages / msgLoaded / coldFetchActive / seeded / curEmitSource
// STRUCT FIELDS stay on the Store struct (same-package cross-file access from
// this concern); only the functions that read/write them move here.
//
// Behavior-preserving verbatim move. The cross-file call surface this concern
// depends on (all unchanged): cancelAllGraceLocked + isRecentlyArchivedLocked
// (store.go), the 6 maintainSubtree*/maintain*OnSessionUpsertLocked index
// maintainers + deleteSessionLocked + recomputeLastAssistantLocked + emit
// (reducers / store.go), bumpMsgRev + publishColdBatch + capPartJSON +
// ColdBatchWarmReconcile (message_window.go), rawObj (store.go). The Discipline
// B double-lock capture-validate pattern on the cold-batch path is exercised
// via publishColdBatch outside s.mu after the reconcile under lock; the
// GAP-S3 hydrate_test.go cohort is the net.
package state

import (
	"bytes"
	"encoding/json"
	"log"
	"time"

	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
)

// Hydrate replaces the view from a full fetch (sessions + messages per session),
// emitting upsert client events for new/changed messages+parts and reconciling
// session-level presence (a session absent from the fetch is deleted). Per Option
// A, message/part removal is NOT inferred from fetch absence — only the explicit
// message.removed / message.part.removed / session.deleted handlers delete
// messages/parts (see reconcileMessagesLocked). Used on the daemon's own
// (re)connect to OpenCode, whose event stream has no replay. Byte comparison
// decides "changed".
//
// The session reconcile + message reconcile run under s.mu, then the lock is
// released BEFORE the cold-batch packaging loop: marshal+gzip+base64 is too
// expensive to hold the global lock for (it blocks all Apply ingestion). Each
// cold batch is published via publishColdBatch, which re-validates the per-
// session revision before emitting so a stale batch can never overwrite newer
// live deltas.
func (s *Store) Hydrate(sessions []json.RawMessage, messages map[string][]MessageWithParts) {
	s.mu.Lock()

	// PROBE 2: attribute emits inside this Hydrate to the hydrate source
	// (reconstructed state — no upstream ingest t0 carried). Reset BEFORE
	// s.mu.Unlock() below (NOT via defer) so the write stays under the lock —
	// otherwise the deferred reset races with Apply's writes to the same field.
	s.curEmitSource = diag.SourceHydrate

	// Cancel any pending completion-grace timers: a reconnect/rehydrate rebuilds
	// activity from the snapshot (SetActivityFromStatuses below), so a timer
	// armed against the pre-reconnect live message stream is stale.
	s.cancelAllGraceLocked()

	// --- sessions ---
	seen := make(map[string]bool, len(sessions))
	for _, info := range sessions {
		var env sessionEnvelope
		if json.Unmarshal(info, &env) != nil || env.ID == "" {
			continue
		}
		if env.archivedAt() {
			continue // archived sessions are not part of the live tree
		}
		// Skip tombstoned ids. A hydrate cannot distinguish a GENUINE unarchive
		// (archived=null because the operator restored it) from a STALE CLOBBER
		// (archived=null because OpenCode rewrote the record from a pre-PATCH
		// snapshot while a busy descendant was still running) — both look
		// identical here. Re-inserting would defeat the tombstone precisely
		// during the re-assert window it protects. The tombstone is cleared
		// ONLY by the explicit unarchive flow (ClearArchiveTombstones, called
		// by handleArchive after the direct-SQLite unarchive succeeds); it also
		// expires via recentArchiveTTL. Hydrate assigns s.sessions directly
		// (bypassing upsertSessionLocked, whose own guard would otherwise fire),
		// so this skip must live HERE.
		if s.isRecentlyArchivedLocked(env.ID) {
			continue
		}
		seen[env.ID] = true
		if old := s.sessions[env.ID]; old == nil || !bytes.Equal(old.info, info) {
			s.sessions[env.ID] = &sessionEntry{id: env.ID, parentID: env.ParentID, info: info}
			// Incremental subtreeBusyCount maintenance (Gate C de-risk
			// prototype): Hydrate assigns s.sessions directly (bypassing
			// upsertSessionLocked), so it must maintain the index here too.
			// `old` is the prev entry (nil for a fresh create). Covers the same
			// create / same-parent / reparent cases as upsertSessionLocked.
			s.maintainSubtreeBusyOnSessionUpsertLocked(env.ID, old, env.ParentID)
			// Phase 1 (Gate C extension): same 5 maintainers as
			// upsertSessionLocked (Hydrate assigns s.sessions directly,
			// bypassing upsertSessionLocked, so it must maintain every index).
			// Order: topology → sums → newestActivity. See upsertSessionLocked.
			s.maintainChildrenOnSessionUpsertLocked(env.ID, old, env.ParentID)
			s.maintainSubtreeRetryOnSessionUpsertLocked(env.ID, old, env.ParentID)
			s.maintainSubtreePendingInputOnSessionUpsertLocked(env.ID, old, env.ParentID)
			s.maintainSubtreeDescendantOnSessionUpsertLocked(env.ID, old, env.ParentID)
			s.maintainNewestActivityOnSessionUpsertLocked(env.ID, old, env.ParentID)
			s.emit(KindSessionUpsert, info)
		}
	}
	for id := range s.sessions {
		if !seen[id] {
			s.deleteSessionLocked(id)
		}
	}

	// --- messages + parts (only for the sessions provided; lazy hydration
	// means this is empty on first connect and just the opened sessions on
	// reconnect, instead of every session). Reconcile under the lock; collect
	// the cold-load sessions so their (expensive) batch packaging runs OUTSIDE
	// s.mu via publishColdBatch (marshal+gzip+base64 must not hold the global
	// lock — it blocks all Apply ingestion during compression). ---
	var coldBatched []string
	for sid, list := range messages {
		cold, _ := s.reconcileMessagesLocked(sid, list)
		if cold {
			coldBatched = append(coldBatched, sid)
		}
	}
	s.curEmitSource = diag.SourceDaemonGenerated // PROBE 2: reset (under lock) before cold-batch
	s.mu.Unlock()

	// Package each cold batch outside the lock. Per-session revision validation
	// (inside publishColdBatch) guarantees each emitted batch is current for its
	// own session; inter-session order is not significant since each batch
	// carries its own sessionID. Hydrate does not emit messages.loaded — that is
	// the aggregator's per-session completion signal, not part of bulk hydrate
	// (reconnect replays via snapshots, not loaded events).
	for _, sid := range coldBatched {
		_ = s.publishColdBatch(sid)
	}
}

// reconcileMessagesLocked diffs one session's full message list into the store,
// emitting upsert events for new/changed messages and parts, and marks the
// session's messages as loaded. Absence never deletes (Option A); messages/parts
// are removed only by the explicit message.removed / message.part.removed /
// session.deleted handlers. Caller must hold s.mu. It returns coldLoad=true when this was the
// session's first load (!s.msgLoaded[sid] at entry); in that case the caller is
// responsible for packaging the wholesale KindMessagesBatch OUTSIDE s.mu via
// publishColdBatch (marshal+gzip+base64 is too expensive to hold the global
// lock for — it blocks all event ingestion). On the warm/incremental path it
// returns false and no batch is produced (individual upserts are emitted here).
//
// Cold-load batching: when the session was NOT previously loaded
// (s.msgLoaded[sid] false at entry — the SetSessionMessages lazy-hydration path,
// or a Hydrate on a fresh daemon with no connected clients), the per-message
// message.upsert + per-part part.upsert emits are SUPPRESSED and a SINGLE
// KindMessagesBatch is emitted instead (by publishColdBatch, outside the lock),
// carrying the entire reconciled message+part list as one wholesale payload. This
// collapses the cold-load N-event fan-out (over the controller tunnel each event
// becomes a yamux frame + WebSocket message + flow-control round-trip — the root
// cause of the session-switch cold-load stall) into a single event the client
// ingests in one mutation. The warm/incremental path (msgLoaded already true — a
// daemon OpenCode-stream reconnect for an already-loaded session) keeps emitting
// individual upserts so a connected client reconciles only the diffs.
func (s *Store) reconcileMessagesLocked(sid string, list []MessageWithParts) (coldLoad bool, blockedByUnconfirmedEmpty bool) {
	coldLoad = !s.msgLoaded[sid] // detect BEFORE setting it true (msgLoaded lifecycle is unchanged)
	s.msgLoaded[sid] = true
	// The authoritative history reconcile rewrites this session's message/part
	// state (info, parts, order), so bump the per-session message revision
	// token under the lock. This is what lets publishColdBatch discard a stale
	// prepared batch whose capture point predates this reconcile. Covers BOTH
	// cold and warm reconciles: a warm re-fetch of an already-loaded session
	// while a prior cold batch is still mid-packaging must also invalidate that
	// batch. (Option A: absence from the fetched list no longer deletes — but a
	// warm reconcile still bumps the token because its present-message
	// upsert/merge can change the projection.)
	s.bumpMsgRev(sid)
	sm := s.messages[sid]
	if sm == nil {
		sm = &sessionMessages{byID: map[string]*messageEntry{}}
		s.messages[sid] = sm
	}
	for _, mwp := range list {
		var env messageInfoEnvelope
		if json.Unmarshal(mwp.Info, &env) != nil || env.ID == "" {
			continue
		}
		me := sm.byID[env.ID]
		if me == nil {
			me = &messageEntry{id: env.ID, info: mwp.Info, parts: map[string]json.RawMessage{}}
			sm.byID[env.ID] = me
			sm.order = append(sm.order, env.ID)
			if !coldLoad {
				s.emit(KindMessageUpsert, mwp.Info)
			}
		} else if !bytes.Equal(me.info, mwp.Info) && !(coldLoad && me.liveTouchedBody) {
			// C-F2: on a cold load, a live message.updated during the in-flight
			// GET means the store body is NEWER than the stale fetched body —
			// preserve the live body (skip the overwrite). The warm resync
			// path (coldLoad==false) treats the fetch as authoritative and
			// still overwrites unconditionally.
			me.info = mwp.Info
			if !coldLoad {
				s.emit(KindMessageUpsert, mwp.Info)
			}
		}
		// C-F2: when a live event touched the message body during the cold
		// fetch window, the live info + cached fields are newer than the stale
		// fetched envelope — preserve them wholesale (do NOT overwrite the
		// cached role/completed/finish/tokens/agent from the stale fetch).
		if !(coldLoad && me.liveTouchedBody) {
			me.role = env.Role
			me.completed = env.Time.Completed != nil
			me.finish = env.Finish
			me.tokens = env.Tokens
			me.agent = env.Agent
			me.terminalError = env.errorName()
		}
		// A history fetch is authoritative for this message's parts: discard
		// streaming accumulators (they were building on stale/live bases) —
		// UNLESS a live part event (snapshot or delta) touched this message
		// during the fetch window, in which case the accumulators hold newer
		// live text the stale fetch must not discard (C-F2). (A non-empty
		// deltaBuf implies at least one live-touched part, so this check also
		// covers unflushed streaming text.) sealedFields is cleared in the same
		// branch: a fresh authoritative base re-evaluates the cap from scratch.
		if !(coldLoad && len(me.liveTouchedParts) > 0) {
			me.deltaBuf = nil
			me.deltaLastEmit = time.Time{}
			me.sealedFields = nil
		}

		for _, part := range mwp.Parts {
			var pe partEnvelope
			if json.Unmarshal(part, &pe) != nil || pe.ID == "" {
				continue
			}
			// Apply the per-part text cap (P1-AGG-006) on the history-fetch
			// path: a fetched part carrying pathological text is bounded here
			// (the wholesale upsert path caps via upsertPartLocked; this path
			// writes me.parts directly so it must cap independently). capPartJSON
			// is a no-op for parts under the cap.
			part = capPartJSON(part, s.partTextCap)
			if old, ok := me.parts[pe.ID]; !ok {
				me.parts[pe.ID] = part
				me.partOrder = append(me.partOrder, pe.ID)
				if !coldLoad {
					s.emit(KindPartUpsert, part)
				}
			} else if !bytes.Equal(old, part) && !(coldLoad && me.liveTouchedParts[pe.ID]) {
				// C-F2: on a cold load, a live part event (snapshot or delta) during
				// the in-flight GET means the store part body is NEWER than the
				// stale fetched body — preserve the live body (skip the overwrite).
				// The warm resync path (coldLoad==false) treats the fetch as
				// authoritative and still overwrites.
				me.parts[pe.ID] = part
				if !coldLoad {
					s.emit(KindPartUpsert, part)
				}
			}
		}
		// Option A: absence from a fetched snapshot NEVER deletes a stored
		// part. The reconnect re-GET can lag OpenCode's event stream and omit a
		// LIVE part (notably a task-tool Part riding on an assistant message);
		// inferring deletion from that absence dropped live parts and was the
		// root cause of the "A_user + A_assistant vanish on reconnect" symptom.
		// Parts are removed ONLY by the explicit message.part.removed handler
		// (deletePartLocked) or session deletion.
	}
	// Option A (cont.): absence from a fetched snapshot NEVER deletes a stored
	// message either, for the same lag reason. Messages are removed ONLY by the
	// explicit message.removed handler (deleteMessageLocked) or session
	// deletion.
	s.recomputeLastAssistantLocked(sid)

	// Empty-newest confirmation tracking. A history reconcile is authoritative
	// for the resident parts, so it is the seam that decides whether a
	// zero-parts newest COMPLETED assistant is SOURCE TRUTH (the server
	// genuinely has no parts) versus a TRANSIENT GAP (schema-drift cold load,
	// or a live race). A single fetch returning zero parts is ambiguous; only a
	// SECOND reconcile observing the SAME empty newest confirms source truth
	// (the schema-drift shape instead resolves via newestCompletedAssistantEmpty
	// going false once the re-fetch serves the real parts). See
	// latestAssistantResidentLocked and the pendingEmptyNewest /
	// confirmedEmptyNewest struct comment.
	newestID, newestEmpty := s.newestCompletedAssistantEmptyLocked(sid)
	switch {
	case newestID != "" && newestEmpty:
		// Aborted/terminal-error fast-path (ses_05ff9273dffe7N4dh1HliZhIXq):
		// opencode positively classified this completed assistant turn as
		// terminal (info.error.name is a recognized terminal error — the
		// confirmed live shape: MessageAbortedError, tokens all zero,
		// parts:[], no finish). Such a turn produced NO output, so zero
		// resident parts is SOURCE TRUTH — not a schema-drift gap. Admit it
		// directly on the FIRST reconcile: skip the O5 two-empty confirmation,
		// drop any stale pending/confirmed trackers, and keep
		// blockedByUnconfirmedEmpty false so the aggregator does NOT re-fetch
		// (one fetch is enough — the error is positive evidence). The
		// schema-drift case (a NON-aborted turn whose parts were omitted by
		// the fetch) carries NO terminal error → it does NOT hit this branch →
		// it still falls through to the O5 confirmation + re-fetch below,
		// which recovers the parts (commit 3b3860e guard preserved).
		var termErr string
		if me := sm.byID[newestID]; me != nil {
			termErr = me.terminalError
		}
		if isTerminalError(termErr) {
			delete(s.pendingEmptyNewest, sid)
			delete(s.confirmedEmptyNewest, sid)
			log.Printf("[state] messages loaded: session=%s newest assistant=%s admitted (aborted: %s)", sid, newestID, termErr)
			break
		}
		if s.pendingEmptyNewest[sid] == newestID {
			// Second consecutive sighting of the same empty newest → confirm
			// source-truth. This is the gate's admit-source-empty transition:
			// the same completed assistant with zero parts, seen across two
			// authoritative reconciles, is genuinely empty (a schema-drift
			// cold load would have served its parts on the re-fetch and taken
			// the newestEmpty==false branch instead).
			if s.confirmedEmptyNewest[sid] != newestID {
				s.confirmedEmptyNewest[sid] = newestID
				log.Printf("[state] messages loaded: session=%s newest assistant=%s confirmed empty by fetch (0 source parts)", sid, newestID)
			}
		} else {
			// First sighting of THIS empty newest (or the newest changed since
			// the last reconcile): drop any stale confirmation so a different
			// empty newest must re-confirm from scratch.
			delete(s.confirmedEmptyNewest, sid)
		}
		s.pendingEmptyNewest[sid] = newestID
		// Blocked (disambiguation needed) iff not yet confirmed: this is the
		// signal the aggregator reads to perform ONE bounded re-fetch.
		blockedByUnconfirmedEmpty = s.confirmedEmptyNewest[sid] != newestID
	default:
		// The newest completed assistant has parts, the newest assistant is
		// still in progress, or there is no assistant — the empty-newest
		// tracking no longer applies. Reset both so a future empty newest must
		// re-confirm (a parts-bearing turn is resident and loaded directly).
		delete(s.pendingEmptyNewest, sid)
		delete(s.confirmedEmptyNewest, sid)
	}

	if coldLoad {
		// Clear the live-touch markers (C-F2): they are scoped to the cold-fetch
		// window and have served their purpose. Cold load happens once per
		// session lifetime (msgLoaded is cleared only by deleteSessionLocked),
		// but clearing here keeps the semantics explicit and the memory tidy.
		for _, me := range sm.byID {
			me.liveTouchedBody = false
			me.liveTouchedParts = nil
		}
		delete(s.coldFetchActive, sid)
		// NOTE: the wholesale KindMessagesBatch is NOT emitted here. It is
		// packaged OUTSIDE s.mu by publishColdBatch (the caller), because the
		// marshal+gzip+base64 pipeline is too expensive to hold the global
		// lock for (it blocks all Apply ingestion during compression). The
		// caller re-validates the per-session message revision before emitting
		// so a stale prepared batch can never overwrite newer live deltas.
	}
	return coldLoad, blockedByUnconfirmedEmpty
}

// newestCompletedAssistantEmptyLocked reports the id of the session's NEWEST
// COMPLETED assistant message and whether it has zero resident parts. It mirrors
// the newest→oldest sm.order walk used by latestAssistantResidentLocked and
// recomputeLastAssistantLocked so all three agree on which message is "the
// newest assistant". Returns ("", false) when there is no completed assistant
// to evaluate — i.e. no assistant message at all, or the newest assistant is
// still in progress (parts streaming) — because neither is an empty-completed
// case (an in-progress assistant is vacuously resident). Caller holds s.mu.
func (s *Store) newestCompletedAssistantEmptyLocked(sid string) (id string, empty bool) {
	sm := s.messages[sid]
	if sm == nil {
		return "", false
	}
	for i := len(sm.order) - 1; i >= 0; i-- {
		me := sm.byID[sm.order[i]]
		if me == nil || me.role != "assistant" {
			continue
		}
		if !me.completed {
			return "", false // newest assistant is still generating — not an empty-completed case
		}
		return me.id, len(me.parts) == 0
	}
	return "", false // no assistant message
}

// MarkColdFetchStart records that a full-history GET is in flight for the given
// session. Live events that arrive while the flag is set tag their entries
// (liveTouchedBody / liveTouchedParts) so the subsequent cold-load reconcile
// (SetSessionMessages) preserves the newer live body instead of clobbering it
// with the stale fetched one (C-F2). Called by BOTH aggregator cold-load paths
// before the GET — EnsureMessagesAsync (the async first-open path, a853677) and
// EnsureMessages (the synchronous GET /vh/snapshot path, bf88e7e) — each setting
// it after the IsMessagesLoaded early-return and before client.Messages. It is
// cleared on success by reconcileMessagesLocked after the cold merge completes,
// and on failure by ClearColdFetchActive in the winner's defer (no reconcile
// runs to clear it).
func (s *Store) MarkColdFetchStart(sessionID string) {
	s.mu.Lock()
	s.coldFetchActive[sessionID] = true
	s.mu.Unlock()
}

// ClearColdFetchActive removes the in-flight cold-fetch marker for a session.
// Called UNCONDITIONALLY in the winner's defer of BOTH cold-load paths
// (EnsureMessages and EnsureMessagesAsync): on GET failure it is the only clear
// (no reconcile runs to clear it), and on success it is idempotent — the
// cold-load reconcile (reconcileMessagesLocked) already cleared the marker
// inside SetSessionMessages. This keeps a transient gap event between a failed
// GET and its retry from being wrongly preserved by the next successful
// reconcile.
func (s *Store) ClearColdFetchActive(sessionID string) {
	s.mu.Lock()
	delete(s.coldFetchActive, sessionID)
	s.mu.Unlock()
}

// SetSessionMessages installs a freshly-fetched message list for one session
// (used by lazy hydration when a client first opens it). On the COLD path
// (session not previously loaded) it does NOT return until a revision-valid
// cold batch has been published.
//
// Returns a SessionMessagesResult the aggregator uses to gate EmitMessagesLoaded
// (Finding 3): Status.Emitted means a valid messages.batch was published (caller
// SHOULD emit loaded); Status.WarmReconcile means the session was already loaded
// and the incremental upsert/delete events were emitted inside reconcile (caller
// SHOULD emit loaded — the client needs the completion signal); Status.SessionGone
// / PackagingFailed mean NO batch was published and the caller MUST NOT emit
// loaded (the session is gone or the batch failed — emitting loaded without a
// preceding batch would break the one-batch-before-loaded ordering, and
// emitting an empty batch to satisfy ordering would reintroduce state after
// session.delete). BlockedByUnconfirmedEmptyNewest signals that this reconcile
// left the session not-loaded because the newest COMPLETED assistant has zero
// resident parts not yet confirmed as source-truth — the aggregator performs
// ONE bounded re-fetch in that case to disambiguate schema-drift from a
// genuinely-empty turn (see reconcileMessagesLocked / latestAssistantResidentLocked).
func (s *Store) SetSessionMessages(sid string, list []MessageWithParts) SessionMessagesResult {
	s.mu.Lock()
	cold, blocked := s.reconcileMessagesLocked(sid, list)
	s.mu.Unlock()
	var status ColdBatchStatus
	if cold {
		// marshal+gzip+base64 happens OUTSIDE s.mu; the per-session revision is
		// re-validated before emit so a stale batch is discarded + retried.
		status = s.publishColdBatch(sid)
	} else {
		// Warm path: reconcileMessagesLocked already emitted the incremental
		// upsert/delete deltas under the lock. No wholesale batch is needed; the
		// caller should still emit messages.loaded (the client exits the loading
		// state on the loaded event, not on a batch — a warm reconnect may emit
		// zero deltas if nothing changed).
		status = ColdBatchWarmReconcile
	}
	return SessionMessagesResult{Status: status, BlockedByUnconfirmedEmptyNewest: blocked}
}

// SetLastAgents cold-seeds the agent name of each session's most recent
// assistant turn, fetched as a lightweight message tail by the aggregator during
// hydrate. This is what lets the tree render per-agent chips on a COLD snapshot
// (before any session's full message history is hydrated) — the tree-only
// snapshot carries no messages, so lastAgent can't be derived client-side until
// the session is opened. Re-seeding is memoized (ColdSeedNeeded/MarkColdSeeded):
// each cold session is tail-fetched at most once per aggregator lifetime, so
// reconnects skip already-seeded sessions. Once a session is opened (messages
// loaded), recomputeLastAssistantLocked overrides the seed authoritatively from
// the full history.
func (s *Store) SetLastAgents(agents map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for sid, agent := range agents {
		// Route every cold seed through the universal lastAgent chokepoint so a
		// real change (incl. a seed to "", exercised when a recompute or an
		// explicit empty seed clears a previously-set chip) advances the seq and
		// emits a replayable KindLastAgentSet event, while an unchanged or
		// unknown-session seed is a total no-op. The aggregator only ever feeds
		// non-empty agents here in production, but the chokepoint keeps the
		// invariant uniform across all writers.
		s.setLastAgentLocked(sid, agent)
	}
}

// ColdSeedNeeded returns the subset of `ids` whose lastAgent has NOT yet been
// cold-seeded, limited to sessions currently tracked. The aggregator calls this
// on (re)connect to fetch a lightweight tail for only the un-seeded sessions
// instead of re-fetching every cold session every time. It is a read-only query
// (claim happens per-session in MarkColdSeeded after a successful fetch), so a
// fetch failure is not marked seeded and retries on the next reconnect — same
// graceful behavior as before this memo existed.
func (s *Store) ColdSeedNeeded(ids []string) []string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]string, 0, len(ids))
	for _, id := range ids {
		if s.sessions[id] != nil && !s.seeded[id] {
			out = append(out, id)
		}
	}
	return out
}

// MarkColdSeeded records that a session's lastAgent has been cold-seeded, so
// subsequent reconnects skip re-fetching its tail. Only marks sessions that
// still exist: a delete that raced between the tail fetch and this call leaves
// seeded clean, so a recreated session is re-seeded. Caller passes one id at a
// time as each tail fetch succeeds (8-wide in the aggregator).
func (s *Store) MarkColdSeeded(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions[id] != nil {
		s.seeded[id] = true
	}
}
