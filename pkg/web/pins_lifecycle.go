package web

// Server-managed pinned sessions — Phase 4: authoritative lifecycle cleanup of
// pinned session IDs.
//
// Three layers, ALL following the uniform cleanup→broadcast rule:
//  1. call s.pins.RemoveIDs(ids),
//  2. if changed == true, call s.FanOutPinsUpdate(current) with the returned
//     post-removal snapshot,
//  3. if changed == false, do NOTHING (no broadcast, no revision bump).
//
// Layer 1 (direct archive hook) lives in archive.go: handleArchive calls
// removePinsAndBroadcast(affected) on the archive SUCCESS path, after the
// archive operation committed (SetArchived returned 200, or 404/410 for a
// session verifiably gone) and after RemoveSessions pruned the live tree. A
// FAILED archive returns 502 BEFORE this point, so a still-active session is
// never unpinned by a failed archive. This catches IDs already absent from the
// live store (RemoveIDs is a no-op when none are present).
//
// Layer 2 (session.delete subscriber) + Layer 3 (post-hydrate backstop) live
// here. They mirror the queue.go subsystem's GC-2 (event subscriber) and GC-3
// (post-hydrate reconcile) patterns respectively:
//   - L2 is a per-(dir, aggregator) SubscribeWith channel watching
//     KindSessionDelete → removePinsAndBroadcast([id]). Best-effort: the store's
//     emit() fan-out is nonblocking and a full subscriber buffer drops the event
//     (closing the channel, ending this goroutine). A dropped event is caught
//     by L1 (the operator-driven archive path) and L3 (the authoritative
//     post-hydrate backstop), so pin cleanup correctness never depends on L2
//     delivery alone.
//   - L3 is driven by the aggregator's onHydrate callback — the SAME single
//     post-hydrate callback field the queue GC-3 reconcile uses (the aggregator
//     exposes one onHydrate slot; installQueueGCCleanup composes BOTH reconciles
//     into it). It is gated FAIL-CLOSED by AnyHydrateCompleted() and scoped strictly by
//     projectBySessionId, so it catches sessions deleted WHILE THE WORKER WAS
//     DOWN (no subscriber saw them) without ever dropping a retained pin whose
//     owning project is unopened.
//
// Scope fence (architecture decision — held): lifecycle cleanup ONLY. No
// web/** changes (Phase 5 owns the web store facade + stream.ts listeners).
// Worker disconnect ≠ deletion: SSE disconnect, tab close, yamux closure,
// MarkWorkerOffline, and store epoch replacement on restart NEVER evict pins —
// pins persist while the worker is offline, and cleanup resumes only after the
// worker returns and an authoritative project inventory establishes a session
// was archived/deleted (L3). Anti-resurrection is already handled server-side
// by Phase 1/2 (cleanup bumps revision → stale client CAS writes fail; newly-
// added IDs are validated against the active set) and is NOT re-implemented here.

import (
	"encoding/json"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/state"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// pinsGCSubscribeBuffer is the channel buffer for the L2 session.delete
// subscriber. Mirrors queueGCSubscribeBuffer: sized to absorb a burst of
// deletes without dropping under normal load, but pin cleanup via this path is
// best-effort — the store's emit() fan-out is nonblocking and a full buffer
// closes the channel (ending the goroutine). A dropped event is caught by L1
// (direct archive hook) and L3 (post-hydrate backstop).
const pinsGCSubscribeBuffer = 128

// removePinsAndBroadcast is the shared cleanup→broadcast primitive for all
// three layers. It applies the uniform rule: RemoveIDs; if changed, fan out the
// post-removal snapshot via FanOutPinsUpdate; if not, do nothing. Idempotent —
// PinStore.RemoveIDs is a no-op (no write, no revision bump) when none of the
// ids are present, so the L1 direct path and the L2 subscriber path compose
// without harm (the second call observes changed==false and stays silent).
//
// Safe for concurrent callers: PinStore.RemoveIDs is mutex-guarded, and
// FanOutPinsUpdate snapshots s.aggs under aggMu (it does not mutate the doc it
// receives). An error from RemoveIDs (persist failure — the store stays
// consistent with disk) is logged and the broadcast is skipped: the doc did not
// advance, so emitting a stale snapshot would mislead live subscribers.
func (s *Server) removePinsAndBroadcast(ids []string) {
	changed, current, err := s.pins.RemoveIDs(ids)
	if err != nil {
		vhlog.Error("pins: lifecycle cleanup RemoveIDs failed", "ids", ids, "err", err)
		return
	}
	if !changed {
		return
	}
	s.FanOutPinsUpdate(current)
}

// reconcilePinsForProject is the project-scoped core of Layer 3. Given a pin-doc
// SNAPSHOT (the caller MUST snapshot it before deriving the active set — see
// reconcilePinsForAgg for the ordering invariant), a project's stable key
// (projectKey(projectRoot(dir)) — the SAME sha1-of-abs-cwd key the PinStore
// stores in projectBySessionId; see pins_http.go activeSessionProjects and
// notes.go projectKey), and that project's authoritative active-session ID set,
// it selects pinned IDs whose projectBySessionId == key AND that are absent
// from the active set, and removes them via the cleanup→broadcast rule (a single
// RemoveIDs call with the combined set, so at most one revision bump + one
// broadcast per pass).
//
// SCOPE FENCE — the rule that makes the backstop safe to run per-project: ONLY
// pins whose owning project is `key` are candidates. A pin whose
// projectBySessionId is a DIFFERENT (unopened) project is NEVER touched here —
// its session may well be live in its own project, and absence from THIS
// project's active set is not proof of deletion. "Never drop retained pins
// whose owning project is unopened" is enforced structurally by the
// projectBySessionId == key filter.
//
// activeSet MAY be empty (a project that hydrated with zero sessions): every
// pin scoped to that project is then genuinely absent and is removed. This is
// the OPPOSITE of the not-yet-hydrated case, which the driver
// (reconcilePinsForAgg) gates on AnyHydrateCompleted BEFORE calling this — so an empty
// activeSet reaching here is always "authoritative zero", never "no inventory
// yet".
//
// Taking the snapshot as a parameter (rather than re-snapshotting internally)
// makes the F1 ordering invariant explicit and testable: the caller controls
// when the snapshot is taken relative to the active-set derivation, so a test
// can pass a stale snapshot and prove a pin added AFTER it is not removed.
func (s *Server) reconcilePinsForProject(doc PinsDoc, key string, activeSet map[string]bool) {
	var remove []string
	for _, id := range doc.OrderedSessionIDs {
		if doc.ProjectBySessionID[id] != key {
			continue // not this project's pin — never drop an unopened project's pin
		}
		if activeSet[id] {
			continue // still active in its project
		}
		remove = append(remove, id)
	}
	if len(remove) == 0 {
		return
	}
	s.removePinsAndBroadcast(remove)
}

// reconcilePinsForAgg is the per-aggregator Layer 3 driver — the direct
// analogue of reconcileQueuesForAgg (FIX-QUEUE-GC-3). It is dispatched to a
// fresh goroutine from the aggregator's onHydrate callback at the end of every
// SUCCESSFUL hydrate, and from the immediate-run branch in installQueueGCCleanup
// when the default aggregator already hydrated at boot.
//
// FAIL-CLOSED gate (the single most important rule, identical to GC-3's): if
// a.AnyHydrateCompleted() is false, the aggregator has not yet produced an
// authoritative active-session set, so this returns WITHOUT removing anything.
// Absence from an unopened/failed/incomplete hydrate is NOT proof of deletion.
// The empty active-set case (hydrate succeeded with zero sessions) is the
// OPPOSITE: AnyHydrateCompleted is true and every project-scoped pin is correctly
// removed — this is what catches sessions deleted WHILE THE WORKER WAS DOWN.
//
// Active-set source: a.Store().SessionIDs() — the SAME authoritative set
// store.Hydrate just installed (hydrate calls store.Hydrate BEFORE firing
// onHydrate; SessionIDs reads the map Hydrate writes, under RLock). Calling it
// AFTER the AnyHydrateCompleted gate guarantees we read a set produced by a completed
// hydrate, not a stale/pre-hydrate map.
//
// Project identity: projectKey(projectRoot(dir)) — the SAME key the PinStore
// stores in projectBySessionId, so the reconcile's notion of "this project's
// pins" matches the pin doc's own attribution. A root-resolution failure
// (effectively never — os.Getwd/filepath.Abs) logs and returns without removing.
func (s *Server) reconcilePinsForAgg(dir string, a *aggregator.Aggregator) {
	if !a.AnyHydrateCompleted() {
		return // FAIL-CLOSED: no authoritative set yet → remove nothing
	}
	root, err := projectRoot(dir)
	if err != nil {
		vhlog.Error("pins reconcile: projectRoot failed", "dir", dir, "err", err)
		return
	}
	key := projectKey(root)
	// ORDERING INVARIANT (F1 fix): snapshot the pin doc BEFORE reading the
	// authoritative active-session set. A pin added AFTER this snapshot is not
	// in `doc` and therefore cannot be a removal candidate this pass — so a
	// valid pin whose session was created between the inventory snapshot and
	// the removal cannot be lost.
	//
	// The INVERSE order (active set first at T1, then pin doc at T2 > T1) was a
	// TOCTOU: a pin added in the (T1, T2) window by a concurrent PUT is present
	// in the fresher pin-doc snapshot yet absent from the stale active set, and
	// would be wrongly removed — permanently losing a valid server-managed pin.
	// Snapshotting the pin doc first makes the active set a post-snapshot view:
	// the only removal candidates are pins that existed before the inventory was
	// taken, and for those the active set is at least as current as the snapshot
	// (a session active at snapshot time that is gone from the active set was
	// genuinely deleted in between — the correct removal case).
	doc := s.pins.Snapshot()
	ids := a.Store().SessionIDs()
	active := make(map[string]bool, len(ids))
	for _, id := range ids {
		active[id] = true
	}
	s.reconcilePinsForProject(doc, key, active)
}

// installPinsLifecycle arms the L2 session.delete subscriber on a's store, once
// per (dir, aggregator) pair (idempotent, guarded by pinsGCOn). It is the
// direct structural mirror of installQueueGCCleanup's GC-2 subscriber and is
// called from aggFor for the default project AND every lazily-created per-dir
// aggregator, right after installQueueGCCleanup. L3 (the post-hydrate backstop)
// is NOT installed here: it piggybacks on the single onHydrate callback
// installQueueGCCleanup already owns (the aggregator exposes one onHydrate
// slot), which composes reconcilePinsForAgg alongside reconcileQueuesForAgg.
//
// Why a SEPARATE subscriber channel (rather than reusing the queue GC's): L2
// and the queue GC are independent best-effort consumers. The store's emit()
// closes a subscriber's channel on buffer overflow (dropping that subscriber
// until process/reload restart). If L2 shared the queue GC's channel, a pins
// broadcast could not fire after the queue GC's channel dropped — and vice
// versa. Separate channels keep the two cleanup paths independent, so one
// dropping never silences the other. The cost is one extra goroutine + channel
// per (dir, aggregator), which is negligible (a handful per worker).
//
// Lifecycle (mirrors installQueueGCCleanup exactly): the goroutine ranges over
// the channel until the store closes it. store.Close() (called from
// aggregator.Stop() during handleReloadProject and at process exit) closes
// every subscriber channel and clears the subs map, so this goroutine exits
// cleanly with no leak. The returned unsubscribe func is intentionally
// discarded — store.Close already removes the subs entry. pinsGCOn[dir] stays
// true across a Reload-project cycle: the dir's aggregator is deleted from
// s.aggs so the NEXT aggFor(dir) builds a FRESH aggregator (new store, new subs
// map), and installPinsLifecycle sees pinsGCOn[dir]==true and skips — which is
// WRONG (the new aggregator's store is never subscribed). So handleReloadProject
// resets pinsGCOn[dir] alongside queueGCOn after tearing down the old
// aggregator. See the call site there.
func (s *Server) installPinsLifecycle(dir string, a *aggregator.Aggregator) {
	s.pinsGCMu.Lock()
	if s.pinsGCOn[dir] {
		s.pinsGCMu.Unlock()
		return
	}
	s.pinsGCOn[dir] = true
	s.pinsGCMu.Unlock()

	store := a.Store()
	// Drop ALL message-class events at fanout — we only care about the structural
	// session.delete event. An empty (non-nil) MessageSessions map means "deliver
	// message-class events only for sessions in the set", and an empty set drops
	// them all (see state.Interest.wants). Identical to installQueueGCCleanup's
	// filter.
	ch, _ := store.SubscribeWith(pinsGCSubscribeBuffer, state.Interest{MessageSessions: map[string]bool{}})
	// Track on lifecycleWG for NON-DEFAULT dirs only (mirrors
	// installQueueGCCleanup): the default dir's subscriber is daemon-owned
	// (process-lifetime), so awaiting it would hang; non-default subscribers
	// exit when Shutdown stops their aggregator. Add BEFORE launch.
	if dir != "" {
		s.lifecycleWG.Add(1)
	}
	go func() {
		if dir != "" {
			defer s.lifecycleWG.Done()
		}
		for ev := range ch {
			if ev.Kind != state.KindSessionDelete {
				continue
			}
			// KindSessionDelete payload is {"id":<sid>} (pkg/state/store.go
			// emits rawObj(...{"id": id})). An unparseable/empty payload is
			// skipped — never block cleanup of OTHER ids on one bad event.
			var p struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(ev.Payload, &p) != nil || p.ID == "" {
				continue
			}
			s.removePinsAndBroadcast([]string{p.ID})
		}
	}()
}
