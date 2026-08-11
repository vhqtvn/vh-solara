package web

import "time"

// archive_backstop.go — Slice 2 of the archive-failure visibility feature:
// the race-free out-of-band (OOB) reconcile backstop.
//
// Slice 1 (134d894) closed the visibility gap for a permanently-stuck archive
// ROOT: record the failure, surface it via SSE, clear it at the cascade success
// funnel. The ONE gap Slice 1 left: if a root is recorded permanently-stuck,
// then archived/deleted OUT-OF-BAND (another tool, a direct OpenCode call),
// Slice 1's clear-on-success never fires for it — THIS daemon's cascade didn't
// run for the OOB resolution — so the warning would persist until daemon
// restart. This file closes that gap with a server-side sweep that periodically
// walks the failure registry and evicts entries whose root is confirmed
// resolved, guarded against racing a still-running cascade by the active-jobs
// registry.
//
// The two load-bearing pieces live here:
//
//   - reconcileArchiveFailures — the synchronous, test-callable sweep. Walks the
//     registry, and for each candidate (dir, root): skips if an active cascade
//     owns it (the cascade's own clear-on-success / re-record-on-failure owns
//     the lifecycle), else clears if the store confirms the root resolved OOB.
//   - runArchiveBackstop — the production ticker that calls
//     reconcileArchiveFailures every archiveBackstopInterval (default 5s,
//     matching the aggregator's tree-reconcile tick that refreshes the snapshot
//     the backstop reads). Bound to bgCtx (Shutdown cancels) and tracked by
//     bgWG (Shutdown awaits). Tests call reconcileArchiveFailures() directly for
//     determinism and never depend on this ticker.
//
// LOCK ORDER (NEW, load-bearing for deadlock-freedom):
//
//	bgMu → store.s.mu   (briefly, inside Store.IsArchiveRootResolved)
//	bgMu → archiveFailuresMu
//
// bgMu is ALWAYS acquired outermost when any of the three is held, and is held
// for the WHOLE per-root decision (active-jobs check → resolved check → clear).
// store.s.mu and archiveFailuresMu are NEVER held simultaneously by the backstop
// (IsArchiveRootResolved releases store.s.mu before archiveFailuresMu is taken).
// The researcher confirmed (Slice-2 premise-recheck) no existing path nests
// these locks in any direction, so establishing bgMu-outermost is deadlock-free:
//
//   - handleArchive acquires bgMu at the launch site (archive.go) and releases
//     it before the cascade goroutine runs; the goroutine never holds bgMu while
//     touching the store or the registry. No bgMu→store.s.mu or bgMu→
//     archiveFailuresMu nesting exists outside this file + the register/deregister
//     sites (which are bgMu-only, single map op, no nesting).
//   - recordArchiveFailure / clearArchiveFailure / ArchiveFailures acquire ONLY
//     archiveFailuresMu, never bgMu or store.s.mu. No inversion.
//   - deregisterArchiveJob acquires ONLY bgMu (one map delete). No nesting.
//
// FETCH DISCIPLINE (non-negotiable): this file performs NO OpenCode HTTP I/O.
// It reads the snapshot the reconcile tick (runTreeReconcile) already refreshed
// — up to ~5s stale. A stale read is safe for a self-healing backstop: a not-
// yet-resolved root is skipped (re-checked next tick); a resolved root is
// cleared (the warning was already stale). This mirrors RefreshArchivedSnapshot
// + sweepOrphansLocked (pkg/state store.go): the fetch happens outside the lock
// in the aggregator; the backstop only reads the in-memory result under s.mu.

// reconcileArchiveFailures is the Slice-2 OOB-reconcile backstop sweep. It walks
// the archive-failure registry and clears records whose stuck root has been
// resolved out-of-band (archived or deleted by another tool / a direct OpenCode
// call), guarded by the active-jobs registry so it never races a running cascade.
//
// The sweep is idempotent and safe to call at any time (including concurrently
// with itself — bgMu serializes the per-root decisions). It is the production
// ticker's body (runArchiveBackstop) AND the synchronous test entry point (tests
// call this directly for determinism, never waiting on the ticker).
//
// Per-project fan-out: each dir that had at least one clear emits exactly ONE
// archive-failures.updated frame (the full per-project doc — the client replaces
// its local set idempotently). A dir with no clears emits nothing (the steady-
// state happy path: a project with no stale failures sees zero needless frames).
// The fan-out happens AFTER bgMu is released (no lock held across the emit —
// matching recordArchiveFailure / clearArchiveFailure discipline; the fan-out is
// in-process via EmitTransient, no OpenCode HTTP I/O).
func (s *Server) reconcileArchiveFailures() {
	// Snapshot the candidate keys under archiveFailuresMu (briefly — just copy
	// the keys). We cannot hold archiveFailuresMu across the per-root work: the
	// lock order requires bgMu outermost, and the candidates change as cascades
	// record/clear. Copying the keys under the lock then re-checking under bgMu
	// per-root is safe: a candidate that disappears mid-sweep is a harmless
	// no-op (reconcileOneArchiveFailure re-checks existence under both locks).
	s.archiveFailuresMu.Lock()
	candidates := make([]archiveFailureKey, 0, len(s.archiveFailures))
	for k := range s.archiveFailures {
		candidates = append(candidates, k)
	}
	s.archiveFailuresMu.Unlock()

	touchedDirs := make(map[string]bool)
	for _, key := range candidates {
		if s.reconcileOneArchiveFailure(key) {
			touchedDirs[key.Dir] = true
		}
	}
	// Fan out ONE updated frame per dir that had a clear (per-project isolation
	// — a failure in project A must not reach project B's stream, mirroring
	// fanOutArchiveFailuresUpdate). archiveFailuresDocForDir re-locks
	// archiveFailuresMu and builds the current per-project set, so the frame
	// reflects the post-clear state (including any concurrent cascade record/
	// clear that landed after this sweep's per-root pass — the client applies
	// the doc idempotently).
	for dir := range touchedDirs {
		s.fanOutArchiveFailuresUpdate(dir, s.archiveFailuresDocForDir(dir))
	}
}

// reconcileOneArchiveFailure clears ONE stale failure record for (dir, root) if
// (a) no active cascade owns the root AND (b) the store confirms the root was
// resolved out-of-band. Returns true if a record was cleared (so the caller fans
// out the per-project updated frame). The load-bearing race-freedom lives here.
//
// LOCK ORDER: bgMu held throughout (defer). aggForExisting (aggMu) is called
// BEFORE bgMu so aggMu never nests under bgMu. Store.IsArchiveRootResolved
// takes store.s.mu internally (bgMu held → bgMu→store.s.mu nesting, the legal
// direction). archiveFailuresMu is acquired with bgMu held but AFTER
// IsArchiveRootResolved has released store.s.mu (so store.s.mu and
// archiveFailuresMu are never simultaneous). See the file-level lock-order note.
//
// RACE-FREEDOM (the crux): bgMu is held across the active-jobs check, the
// resolved-check, and the clear. handleArchive's launch site also acquires bgMu,
// so NO new cascade can start for this root mid-sweep (it waits on bgMu). The
// active-jobs check then skips any root with an ALREADY-RUNNING cascade — that
// cascade's recordArchiveFailure / clearArchiveFailure own the lifecycle. A root
// NOT in the active registry has no running cascade, so no concurrent
// recordArchiveFailure can re-add it mid-clear (recordArchiveFailure is only
// ever called from inside a registered cascade, and deregistration happens
// before bgWG.Done under bgMu — so while bgMu is held here, the registry is a
// faithful snapshot of which roots have a live cascade).
//
// Ownership-scope precision: the active-jobs registry is keyed by (dir, ROOT) —
// the id passed to handleArchive (body.SessionID). The failure registry, by
// contrast, is keyed by (dir, id) where id is the id that reached terminal
// failure in classifyArchiveFailure. For a ROOT failure these keys MATCH, so the
// guard above is the exact race-freedom mechanism (a running cascade for that
// root blocks the clear). For a NON-ROOT failure (a descendant whose chain is
// unresolvable — not a descendant-of-archived, which is left for the orphan
// sweep and never recorded) the guard is a no-op: the backstop CAN clear it
// mid-cascade. This is SAFE, not a defect: runArchiveCascade is one-shot-per-id
// (the frozen `affected` loop processes each id once and never revisits), so a
// cleared non-root failure is not re-recorded by the SAME cascade; and the clear
// only fires when IsArchiveRootResolved confirms the id was OOB-resolved (the
// warning SHOULD clear). The crux test BT2 proves the root-keyed guard; the
// non-root path is correct-by-construction (one-shot-per-id + self-healing).
func (s *Server) reconcileOneArchiveFailure(key archiveFailureKey) bool {
	// Resolve the aggregator BEFORE bgMu so aggMu (taken by aggForExisting for
	// non-default dirs) never nests under bgMu — keeps the lock-order graph
	// minimal. A nil agg (project dropped via reload-project, or never opened in
	// this daemon) means there is no store to check; the record stays and is
	// re-evaluated on a future tick if the project reopens.
	agg := s.aggForExisting(key.Dir)
	if agg == nil {
		return false
	}
	store := agg.Store()

	s.bgMu.Lock()
	defer s.bgMu.Unlock()

	// (a) Active-cascade guard: a root with a running cascade is owned by that
	// cascade. Its clear-on-success (success funnel) or re-record-on-failure
	// will set the correct state; the backstop must not race it.
	if s.archiveJobsActiveRoots[key] {
		return false
	}

	// (b) Resolved check: store.s.mu taken internally (bgMu held → legal
	// bgMu→store.s.mu nesting). No I/O under any lock — reads the snapshot the
	// reconcile tick already refreshed.
	if !store.IsArchiveRootResolved(key.ID) {
		return false // root still live + unarchived → not an OOB resolution
	}

	// Root is resolved AND no active cascade → clear the stale record.
	// archiveFailuresMu acquired with bgMu held (bgMu→archiveFailuresMu nesting,
	// legal); store.s.mu is NOT held (IsArchiveRootResolved released it).
	s.archiveFailuresMu.Lock()
	_, had := s.archiveFailures[key]
	if had {
		delete(s.archiveFailures, key)
	}
	s.archiveFailuresMu.Unlock()
	return had
}

// runArchiveBackstop is the production ticker for the OOB-reconcile backstop.
// Bound to bgCtx (Shutdown cancels via bgCancel) and tracked by bgWG (Shutdown
// awaits via bgWG.Wait) — same lifecycle as the archive cascade jobs. It calls
// reconcileArchiveFailures every archiveBackstopInterval (default 5s). Tests do
// NOT depend on this ticker: they call reconcileArchiveFailures() directly for
// determinism. The first tick fires after one interval (time.NewTicker does not
// fire immediately), so a fast test never observes a ticker-driven sweep.
func (s *Server) runArchiveBackstop() {
	defer s.bgWG.Done()
	interval := s.archiveBackstopInterval
	if interval <= 0 {
		interval = defaultArchiveBackstopInterval
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-s.bgCtx.Done():
			return
		case <-ticker.C:
			s.reconcileArchiveFailures()
		}
	}
}
