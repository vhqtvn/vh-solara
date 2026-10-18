package web

// Permission policy (fail-closed), moved verbatim from server.go (slice 8 of
// the server.go split) — this cluster lived in TWO separate regions there:
//
//   - fail-fast registry + watcher setup: registerFailFast / isFailFast /
//     failFastCount, the permissionEnv wire type, and ensurePermissionWatcher
//     (the idempotent per-dir arming called from aggFor)
//   - reconcile engine: the permReconcileInterval / permRejectTimeout
//     constants, runPermissionReconcile (the periodic authoritative-snapshot
//     backstop sweep), stopPermissionWatcher (per-dir teardown for
//     handleReloadProject's non-default branch), and reconcileFailFastPerms
//     (the sweep body: reject every PENDING permission of a fail_fast
//     session, never "always").
//
// The Server fields these helpers use (failFastMu/failFast, watcherMu/
// watcherOn/watcherCancel, lifecycleWG, and the test rendezvous channels
// reconcileReadyCh/reconcileBlockCh) stay in server.go (Server struct); the
// call sites live in the post-split files — aggFor and Shutdown via
// stopAllPermissionWatchers in server_aggregators.go (with the shutdown
// choreography), handleReloadProject in archive.go.

import (
	"context"
	"encoding/json"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/state"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// registerFailFast records sessionID as a fail-closed-permission spawn. Called
// only on the fresh-execution path of a fail_fast spawn's idempotent handler,
// so a replay never double-registers. See the failFast field doc.
func (s *Server) registerFailFast(sessionID string) {
	s.failFastMu.Lock()
	defer s.failFastMu.Unlock()
	s.failFast[sessionID] = struct{}{}
}

// isFailFast reports whether sessionID was spawned with the fail-closed
// permission policy. Used by the permission watcher to decide auto-reject.
func (s *Server) isFailFast(sessionID string) bool {
	s.failFastMu.RLock()
	defer s.failFastMu.RUnlock()
	_, ok := s.failFast[sessionID]
	return ok
}

// failFastCount returns the number of registered fail-closed sessions. Test-only
// accessor (kept unexported, same-package); production reads isFailFast per id.
func (s *Server) failFastCount() int {
	s.failFastMu.RLock()
	defer s.failFastMu.RUnlock()
	return len(s.failFast)
}

// ensurePermissionWatcher arms the fail-closed permission reconcile sweep for a
// project's store, once per dir (idempotent, guarded by watcherOn). It is called
// from aggFor so it runs for the default project and every lazily-created dir,
// and — critically — BEFORE any fail_fast session can be minted: the spawn that
// creates such a session calls aggFor first, so the sweep is always running in
// time. The sweep keeps the POLICY in the web layer: for any pending permission
// whose session is registered fail_fast it auto-rejects (never "always") and
// records the observable fact on the store. The store stays policy-free.
//
// Why a reconcile sweep and not a live-tail subscriber: the store's emit() is
// lossy on overflow — a slow subscriber's channel is CLOSED and the subscriber
// is dropped, so a `for ev := range ch` watcher exits SILENTLY and never re-arms
// (watcherOn stays set), which defeated the fail-closed guarantee with no signal
// (F1). The guarantee must rest on a deterministic backstop, not on event
// delivery. So instead of subscribing to the lossy channel, this starts a
// goroutine that periodically reads the authoritative Snapshot and rejects
// pending fail_fast permissions. Bounded latency = permReconcileInterval.
type permissionEnv struct {
	ID        string `json:"id"`
	SessionID string `json:"sessionID"`
}

func (s *Server) ensurePermissionWatcher(dir string, a *aggregator.Aggregator) {
	s.watcherMu.Lock()
	if s.watcherOn[dir] {
		s.watcherMu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.watcherOn[dir] = true
	s.watcherCancel[dir] = cancel
	s.watcherMu.Unlock()

	// Track on lifecycleWG so Shutdown can AWAIT (not just signal) the watcher.
	// Add BEFORE launch; Done is deferred inside. ALL watchers are tracked,
	// including the default dir's — Shutdown cancels every watcher, so every
	// armed watcher must contribute to the await.
	s.lifecycleWG.Add(1)
	go func() {
		defer s.lifecycleWG.Done()
		s.runPermissionReconcile(ctx, a)
	}()
}

// permReconcileInterval is the period of the per-directory fail-closed
// permission reconcile sweep. It is the BOUNDED LATENCY of the fail-closed
// guarantee: a fail_fast session's pending permission is rejected within at most
// one interval of becoming pending, regardless of store event-tail loss (the
// sweep reads the authoritative Snapshot, not the lossy live-tail channel).
//
// 2s is a deliberate tradeoff: fast enough that an unattended spawn's prompt
// never hangs in practice, slow enough that an idle dir does negligible work
// (one Snapshot read per tick; a reject RPC fires only when a fail_fast perm is
// actually pending). Lower it if a deployment needs sub-second auto-reject.
const permReconcileInterval = 2 * time.Second

// permRejectTimeout bounds a single auto-reject RPC. Generous because the reject
// goes through the local opencode server, which may be briefly busy.
const permRejectTimeout = 10 * time.Second

// runPermissionReconcile is the per-directory fail-closed backstop. It does NOT
// depend on the store's lossy live-tail channel.
//
// Lifetime: the DEFAULT dir's sweep ("") is PROCESS-LIFETIME — the goroutine
// runs for as long as this daemon owns the default aggregator's store, and its
// ctx is never cancelled by Reload (handleReloadProject skips teardown for the
// default dir). A NON-DEFAULT dir's sweep is STOPPABLE: stopPermissionWatcher
// cancels its ctx when handleReloadProject drops that dir's aggregator, so the
// goroutine exits promptly instead of ticking forever on an orphaned store. On
// daemon exit the whole process (and the local opencode server it drives) goes
// away together, so any still-running sweep's ticker simply stops.
//
// There is no per-re-arm leak: ensurePermissionWatcher registers the sweep
// exactly once per dir (guarded by watcherOn), and after Reload clears
// watcherOn[dir] a subsequent aggFor(dir) re-arms a FRESH sweep.
func (s *Server) runPermissionReconcile(ctx context.Context, a *aggregator.Aggregator) {
	ticker := time.NewTicker(permReconcileInterval)
	defer ticker.Stop()
	store := a.Store()
	client := a.Client()
	// One sweep immediately on arming, so a permission already pending at
	// registration is rejected with ~0 latency instead of waiting a full tick.
	// ctx is threaded into reconcileFailFastPerms so a watcher cancellation
	// (Shutdown / Reload) aborts an in-flight auto-reject RPC instead of waiting
	// out permRejectTimeout.
	s.reconcileFailFastPerms(ctx, store, client)
	// Test seam (nil in production): signal that the watcher reached its
	// post-sweep point, then optionally hold on a pure (ctx-independent)
	// receive — the ONE spot watcher cancellation cannot reach — so a test can
	// prove the only way Shutdown returns is by awaiting lifecycleWG.
	if s.reconcileReadyCh != nil {
		select {
		case s.reconcileReadyCh <- struct{}{}:
		default:
		}
	}
	if s.reconcileBlockCh != nil {
		<-s.reconcileBlockCh
	}
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.reconcileFailFastPerms(ctx, store, client)
		}
	}
}

// stopPermissionWatcher stops and clears the per-dir fail-closed permission
// reconcile sweep for dir. It is a safe no-op if dir has no armed sweep. Called
// from handleReloadProject's non-default teardown branch so the sweep goroutine
// exits instead of ticking forever on the dropped aggregator's orphaned store.
// The DEFAULT dir ("") is never passed here — its sweep is process-lifetime.
func (s *Server) stopPermissionWatcher(dir string) {
	s.watcherMu.Lock()
	defer s.watcherMu.Unlock()
	if cancel, ok := s.watcherCancel[dir]; ok {
		cancel()
		delete(s.watcherCancel, dir)
	}
	delete(s.watcherOn, dir)
}

// reconcileFailFastPerms reads the authoritative store permission set and, for
// every PENDING permission whose session is registered fail_fast, rejects it
// (never "always") and records the observable permission_blocked fact. This
// makes fail-closed a bounded-latency guarantee even if every live-tail event is
// lost: the store's permission set is the source of truth, not the event stream.
//
// It uses PendingPermissions (read-locked, perms-only) rather than Snapshot:
// Snapshot materializes the entire view under the WRITE lock, which is wasted
// cost here since only permissions are read — and that write lock blocks
// incoming events and client-connect Snapshots for the duration of every sweep.
//
// Idempotent: a permission that was already replied/cleared between the perms
// read and the reject returns an error from ReplyPermission, which is swallowed
// (logged) — a stale reject is harmless and expected, since the sweep races the
// permission's normal clear path (store.Apply permission.replied deletes the perm
// before the next read, so a cleared perm is not re-rejected beyond the one
// in-flight race window). The client is the per-dir aggregator's Client() (same
// dir→client resolution the aggregator uses for every other write verb).
//
// ctx threads the watcher's lifetime into the per-RPC timeout: the reject RPC
// uses context.WithTimeout(ctx, permRejectTimeout) so a watcher cancellation
// (Shutdown via stopAllPermissionWatchers, or Reload via stopPermissionWatcher)
// aborts an in-flight reject instead of running out the full permRejectTimeout.
// Callers that are not bound to a watcher lifetime pass context.Background().
func (s *Server) reconcileFailFastPerms(ctx context.Context, store *state.Store, client *opencode.Client) {
	perms := store.PendingPermissions()
	for sessionID, plist := range perms {
		if !s.isFailFast(sessionID) {
			continue
		}
		for _, raw := range plist {
			var env permissionEnv
			if err := json.Unmarshal(raw, &env); err != nil || env.ID == "" || env.SessionID == "" {
				continue
			}
			// NEVER "always": no persistent grant, so a prompt can't widen what
			// the unattended worker is allowed to do. rpcCtx derives from the
			// watcher ctx so cancellation aborts the RPC promptly.
			rpcCtx, cancel := context.WithTimeout(ctx, permRejectTimeout)
			err := client.ReplyPermission(rpcCtx, env.ID, sessionID, "reject")
			cancel()
			if err != nil {
				// Swallow: a stale/already-cleared permission errors here, the
				// expected outcome of an idempotent sweep racing the perm's clear.
				// Log so a genuine failure is observable, but never propagate —
				// the guarantee must not break on a benign reject race.
				vhlog.Error("permission reconcile: auto-reject failed",
					"sessionID", sessionID, "permissionID", env.ID, "err", err)
				continue
			}
			store.MarkPermissionBlocked(sessionID)
			vhlog.Info("permission reconcile: auto-rejected fail_fast permission",
				"sessionID", sessionID, "permissionID", env.ID)
		}
	}
}
