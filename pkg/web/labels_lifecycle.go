package web

// Labels lifecycle cleanup, moved verbatim from server.go (slice 7 of the
// server.go split): the L2 session.delete subscriber arming
// (installLabelsLifecycle, with the labelsGCSubscribeBuffer const), the L3
// post-hydrate backstop (reconcileLabelsForAgg → reconcileLabelsForProject),
// the shared cleanup→broadcast primitives (removeLabelsAndBroadcast →
// fanOutLabelsUpdate), and the LabelStore reconcile accessor
// labelsReconcileSnapshot (a *LabelStore method — the LabelStore type itself
// stays in labels.go). The Server fields these helpers use (labelsReg,
// labelsGCMu/labelsGCOn, labelsReconcileEntries, lifecycleWG) stay in
// server.go; the call sites (aggFor / Shutdown's lifecycleWG join) live in
// server_aggregators.go, and spawnPostHydrateReconciles (slice 10) in
// posthydrate_lifecycle.go.
//
// The direct structural mirror of the pins lifecycle helpers
// (pkg/web/pins_lifecycle.go). The ONE labels-specific difference from pins is
// documented per-helper: labels are ROOT-ONLY (the active set is
// RootInventory() filtered to IsRoot, not SessionIDs()), and the private
// projectByRootSessionId sidecar is accessed via labelsReconcileSnapshot
// (defined here, same package) rather than through the public Snapshot (which
// deliberately hides it).

import (
	"encoding/json"
	"sync/atomic"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/state"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// labelsGCSubscribeBuffer is the channel buffer for the L2 session.delete
// subscriber, mirroring pinsGCSubscribeBuffer. Sized to absorb a burst of
// deletes; label cleanup via this path is best-effort — a full buffer closes
// the channel (ending the goroutine), and a dropped event is caught by L1
// (archive.go's RemoveSessions → KindSessionDelete is also emitted there) and
// L3 (the authoritative post-hydrate backstop below).
const labelsGCSubscribeBuffer = 128

// labelsReconcileSnapshot atomically snapshots the public LabelsDoc AND the
// private projectByRootSessionId sidecar under a single mutex acquisition. This
// is the labels analogue of PinStore.Snapshot() returning a PinsDoc that already
// includes ProjectBySessionID: because LabelStore.Snapshot() deliberately hides
// the sidecar (it is cleanup metadata, never on the wire), the reconcile path
// needs a combined accessor that exposes both projections atomically. Defined
// here (same package web) so it can read the private labelsFile
// fields without editing labels.go (out of scope this slice). Both the returned
// LabelsDoc and the projects map are deep copies the caller may mutate freely.
func (s *LabelStore) labelsReconcileSnapshot() (LabelsDoc, map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	doc := s.snapshotPublicLocked()
	projects := make(map[string]string, len(s.doc.ProjectByRootSessionID))
	for k, v := range s.doc.ProjectByRootSessionID {
		projects[k] = v
	}
	return doc, projects
}

// fanOutLabelsUpdate publishes a transient labels.updated full-state frame
// carrying the committed labels doc to the LIVE subscribers of the SINGLE
// project whose directory is dir ONLY. This replaces the former worker-wide
// FanOutLabelsUpdate: labels are now per-project (one store per project under
// <stateBaseDir>/projects/<key>/), so a mutation in project A must NOT reach
// project B's stream.
//
// Uses aggForExisting(dir) — it never opens a project. A mutation for a project
// that has no open aggregator has no live subscribers to reach, so it is
// silently dropped (the snapshot-on-reconnect bootstrap is the catch-up).
// EmitTransient is transient (not recorded to the replay ring, no seq advance),
// so a reconnecting client never replays it — labels.snapshot on connect is the
// catch-up.
func (s *Server) fanOutLabelsUpdate(dir string, doc LabelsDoc) {
	a := s.aggForExisting(dir)
	if a == nil {
		return
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		vhlog.Warn("labels.updated fan-out: marshal failed, skipping", "err", err)
		return
	}
	a.Store().EmitTransient(kindLabelsUpdated, raw)
}

// removeLabelsAndBroadcast is the shared cleanup→broadcast primitive for the
// label lifecycle layers, mirroring removePinsAndBroadcast: resolve the project
// store via labelsForDir(dir); RemoveRootIDs; if changed, fan out the
// post-removal snapshot via fanOutLabelsUpdate(dir, …); if not, do nothing.
// RemoveRootIDs strips root references from group OrderedRootSessionIDs and
// TagIDsByRootSessionID (and the sidecar) but KEEPS group/tag definitions —
// so cleanup removes the ROOT REFERENCES only, preserving the definitions the
// operator authored. Idempotent (RemoveRootIDs is a no-op when none are
// present), so the L2 subscriber path and the L3 backstop compose harmlessly.
// A nil store (unresolvable dir) is a silent no-op — there is nothing to clean.
func (s *Server) removeLabelsAndBroadcast(dir string, ids []string) {
	st := s.labelsForDir(dir)
	if st == nil {
		return
	}
	changed, current, err := st.RemoveRootIDs(ids)
	if err != nil {
		vhlog.Error("labels: lifecycle cleanup RemoveRootIDs failed", "dir", dir, "ids", ids, "err", err)
		return
	}
	if !changed {
		return
	}
	s.fanOutLabelsUpdate(dir, current)
}

// reconcileLabelsForProject is the project-scoped core of Layer 3, mirroring
// reconcilePinsForProject. Given a labels-doc snapshot + its
// projectByRootSessionId sidecar (the caller MUST snapshot BOTH atomically before
// deriving the active set — see reconcileLabelsForAgg for the F1 ordering
// invariant), a project's stable key, and that project's authoritative
// active-ROOT set, it selects referenced roots whose sidecar attribution == key
// AND that are absent from the active-root set, and removes them via the
// cleanup→broadcast rule (a single RemoveRootIDs call, so at most one revision
// bump + one broadcast per pass).
//
// SCOPE FENCE: ONLY roots whose owning project is `key` are candidates. A root
// whose sidecar attribution is a DIFFERENT (unopened) project is NEVER touched
// — absence from THIS project's active-root set is not proof of deletion for a
// root owned by another project. "Never drop retained roots whose owning
// project is unopened" is enforced structurally by the projects[id]==key filter.
//
// ROOT-ONLY difference from pins: the active set is ROOT ids (IsRoot==true from
// RootInventory), not all session ids. A root removed here is stripped from
// group orders + tag assignments, but the group/tag definitions survive
// (RemoveRootIDs keeps them).
//
// dir threads the project identity to removeLabelsAndBroadcast so cleanup +
// fan-out land on THIS project's store and stream only.
func (s *Server) reconcileLabelsForProject(dir string, doc LabelsDoc, projects map[string]string, key string, activeRoots map[string]bool) {
	referenced := referencedRootsInLabelsDoc(doc)
	var remove []string
	for rid := range referenced {
		if projects[rid] != key {
			continue // not this project's root — never drop an unopened project's root
		}
		if activeRoots[rid] {
			continue // still active in its project
		}
		remove = append(remove, rid)
	}
	if len(remove) == 0 {
		return
	}
	s.removeLabelsAndBroadcast(dir, remove)
}

// reconcileLabelsForAgg is the per-aggregator Layer 3 driver — the direct
// analogue of reconcilePinsForAgg. It is dispatched to a fresh goroutine from
// the aggregator's onHydrate callback (composed into installQueueGCCleanup's
// single onHydrate slot alongside the queue + pins reconciles) and from the
// immediate-run branch when the default aggregator already hydrated at boot —
// both arms spawn via spawnPostHydrateReconciles, which tracks the pass on
// bgWG so Shutdown joins an in-flight pass before returning (its removals
// persist via LabelStore.RemoveRootIDs).
//
// FAIL-CLOSED gate: if a.AnyHydrateCompleted() is false, remove nothing.
// Active-root source: a.Store().RootInventory() filtered to IsRoot — the STRICT
// root definition labels require (NOT SessionIDs(), because a label target must
// be a true root). ORDERING INVARIANT (F1 fix): the doc+sidecar snapshot is
// taken BEFORE the active-root set, so a root added AFTER the snapshot is not a
// removal candidate — the same TOCTOU guard pins use.
func (s *Server) reconcileLabelsForAgg(dir string, a *aggregator.Aggregator) {
	if !a.AnyHydrateCompleted() {
		return // FAIL-CLOSED: no authoritative set yet → remove nothing
	}
	root, err := projectRoot(dir)
	if err != nil {
		vhlog.Error("labels reconcile: projectRoot failed", "dir", dir, "err", err)
		return
	}
	key := projectKey(root)
	// Resolve THIS project's store. A nil store (unresolvable / not yet
	// materialized) means there is nothing to reconcile — return.
	st := s.labelsForDir(dir)
	if st == nil {
		return
	}
	// Test seam (queueRegistry.cleanupCalls pattern — see
	// labelsReconcileEntries): count pass entries immediately BEFORE the
	// snapshot's mutex acquisition, so the Shutdown-join rendezvous tests can
	// observe the pass is parked there while they hold the store mutex.
	atomic.AddInt64(&s.labelsReconcileEntries, 1)
	// ORDERING INVARIANT (F1 fix): snapshot the doc + sidecar BEFORE reading the
	// authoritative active-root set. A root added AFTER this snapshot is not in
	// `doc`/`referenced` and therefore cannot be a removal candidate this pass.
	doc, projects := st.labelsReconcileSnapshot()
	inventory := a.Store().RootInventory()
	activeRoots := make(map[string]bool, len(inventory))
	for _, inv := range inventory {
		if inv.IsRoot {
			activeRoots[inv.SessionID] = true
		}
	}
	s.reconcileLabelsForProject(dir, doc, projects, key, activeRoots)
}

// installLabelsLifecycle arms the L2 session.delete subscriber on a's store, the
// direct mirror of installPinsLifecycle. Called from aggFor for the default AND
// every lazily-created per-dir aggregator. On KindSessionDelete it calls
// removeLabelsAndBroadcast([id]). Idempotent (guarded by labelsGCOn); the
// goroutine exits when the store closes its subscriber channels. A separate
// channel from the pins/queue GC subscribers keeps the three cleanup paths
// independent (one dropping never silences the others). handleReloadProject /
// stopServerOwnedAggregators resets labelsGCOn[dir] so a fresh aggFor(dir) gets
// a fresh subscriber.
func (s *Server) installLabelsLifecycle(dir string, a *aggregator.Aggregator) {
	s.labelsGCMu.Lock()
	if s.labelsGCOn[dir] {
		s.labelsGCMu.Unlock()
		return
	}
	s.labelsGCOn[dir] = true
	s.labelsGCMu.Unlock()

	store := a.Store()
	// Drop ALL message-class events at fanout — we only care about the structural
	// session.delete event. Identical to installPinsLifecycle's filter.
	ch, _ := store.SubscribeWith(labelsGCSubscribeBuffer, state.Interest{MessageSessions: map[string]bool{}})
	// Track on lifecycleWG for NON-DEFAULT dirs only (mirrors
	// installPinsLifecycle): the default dir's subscriber is daemon-owned.
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
			var p struct {
				ID string `json:"id"`
			}
			if json.Unmarshal(ev.Payload, &p) != nil || p.ID == "" {
				continue
			}
			s.removeLabelsAndBroadcast(dir, []string{p.ID})
		}
	}()
}
