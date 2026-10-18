package web

// Aggregator ownership, moved verbatim from server.go (slice 14 — the FINAL
// slice — of the server.go split): the OpenCode retarget (RetargetOpenCode),
// the shutdown family (Shutdown, stopAllPermissionWatchers,
// stopAllQueueDrainLoops, stopServerOwnedAggregators), the per-directory
// aggregator lookups (aggFor, aggForExisting), and the aggregator hooks
// (SetAggHook, SetUpstreamDownProbe). Byte-for-byte move — the
// default-aggregator ownership asymmetries (Shutdown deliberately does NOT
// stop the default aggregator but DOES retire its permission watcher) and the
// shutdown lock-ordering are unchanged; only the declarations moved. The
// constructor and the archive configuration setters (SetReassertDelay,
// SetArchiveRetryConfig) remain in server.go per the approved split brief.

import (
	"context"
	"net/url"
	"strings"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// RetargetOpenCode re-targets the RUNNING server at a new OpenCode base URL
// (P1-API-003: after a fresh-port restart of the serve process — foreign
// listener on the old port, or a re-derived port — the daemon must keep
// serving through the new port immediately). Under aggMu it:
//
//  1. records s.opencodeURL, so per-directory aggregators created LAZILY
//     after the swap inherit the new target (aggFor reads it under the same
//     lock);
//  2. atomically swaps the /oc/* reverse proxy for one built against the new
//     target (whole-proxy swap: a director's parsed target is captured at
//     construction, so mutating it in place could never take effect);
//  3. re-targets every LIVE aggregator's client, the default "" included —
//     the aggregator keeps its store/subscribers and its reconnect loop
//     re-dials the new BaseURL per connection.
//
// NON-OBVIOUS INVARIANT — default-aggregator coverage (step 3): the default
// aggregator is ACCESSED outside the map (aggFor("")/aggForExisting("")
// return s.agg without consulting s.aggs), but its retarget coverage flows
// ONLY through the `s.aggs[""]` entry NewServer seeds alongside s.agg —
// the map walk below never looks at s.agg. Removing that seeded entry as
// "redundant" would silently drop default coverage (a retargeted server
// whose default aggregator keeps dialing the dead old port); conversely,
// "simplifying" the accessors to map-only lookups would still work only
// because the entry exists. The two designs are coupled on purpose; see
// reload_test.go's `s.aggs[""] == s.agg` assertions, which pin the entry.
//
// LOOPBACK ASSUMPTION: baseURL is a same-host loopback target by
// construction — both binaries spawn/attach `opencode serve --hostname
// 127.0.0.1` and retarget only to a port they just spawned on or
// re-derived from their own recorded state. RetargetOpenCode parses the URL
// but does NOT validate reachability or host shape; nothing here enforces
// loopback. A future remote-OpenCode feature that hands this a non-loopback
// URL is knowingly breaking that assumption (aggregator reconnects and the
// /oc proxy would dial off-host).
//
// Callers re-target BEFORE flipping any readiness signal (ocLife.SetReady):
// an observer that acts on readiness must never see ready state served
// through the old port. A same-URL call is a benign refresh. An unparseable
// URL keeps the current target (per-request 502s) rather than corrupting the
// running server; daemon-resolved URLs are parseable by construction.
func (s *Server) RetargetOpenCode(baseURL string) {
	u := strings.TrimRight(baseURL, "/")
	target, err := url.Parse(u)
	if err != nil {
		vhlog.Error("retarget refused an unparseable opencode URL; keeping the current target", "url", baseURL, "err", err)
		return
	}
	s.aggMu.Lock()
	defer s.aggMu.Unlock()
	s.opencodeURL = u
	s.proxy.Store(newOpenCodeProxy(target))
	for _, a := range s.aggs {
		a.Retarget(u)
	}
}

// Shutdown retires the Server's owned lifetimes and awaits them, bounded by ctx.
// It is idempotent and safe to call repeatedly (every cancellation it issues is
// idempotent; the WaitGroups are only ever waited, never re-Add'd after exit).
// It establishes an EXPLICIT per-directory ownership boundary — not a blanket
// context swap — by issuing each retirement signal AND awaiting the goroutines:
//
//  1. bgCancel() — cancels the background-task ctx (the post-archive re-assert
//     goroutine, and every non-default aggregator's RunManaged Run loop).
//  2. stopAllPermissionWatchers() — cancels + clears EVERY per-dir permission
//     watcher, including the default dir's. Watchers root their own ctx in
//     context.Background() (NOT bgCtx), so bgCancel alone cannot retire them;
//     cancelling the watcher ctx also aborts an in-flight auto-reject RPC (that
//     RPC's timeout is now derived from the watcher ctx — see reconcileFailFastPerms).
//  3. stopServerOwnedAggregators() — stops every NON-DEFAULT aggregator the
//     Server created lazily via aggFor. Aggregator.Stop() closes its store,
//     which closes every subscriber channel, retiring the queue/pin subscriber
//     range loops those aggregators own. The DEFAULT aggregator is daemon-owned
//     (started with plain Run(vhCtx), process-lifetime) and is deliberately NOT
//     stopped here — closing its store would sever daemon-owned SSE streams and
//     break callers that keep using the default aggregator across a Shutdown.
//
// After all retirement signals are issued, Shutdown awaits bgWG then lifecycleWG
// (the watchers + non-default subscribers), returning nil once both drain or
// ctx.Err() if the await is bounded by ctx. This proves server-owned per-dir
// watchers and subscriber-backed workers cannot remain live after Shutdown.
//
// Terminal-Shutdown contract: this is a terminal, single-caller teardown. In
// production both callers (cmd/client-daemon-vh, cmd/local-server) drain the HTTP
// server (vhHTTP.Shutdown) BEFORE srv.Shutdown, so no concurrent aggFor can
// install fresh lifecycle work during teardown; tests call Shutdown in cleanup.
// There is intentionally no admission barrier: the default aggFor path is
// lock-free for per-request performance, and the only race that could install
// post-signal work cannot occur at the actual call sites.
func (s *Server) Shutdown(ctx context.Context) error {
	s.bgCancel() // idempotent; never reassigned after NewServer
	s.stopAllPermissionWatchers()
	// Stop the per-dir drain loops (slice 2b phase 2) BEFORE the aggregator
	// teardown: bgCancel already signalled them AND stopAllQueueDrainLoops
	// fires each loop's retained per-loop cancel, then waits for the exit
	// (the loops' own aggregator lookups take aggMu, so waiting must happen
	// outside stopServerOwnedAggregators' aggMu hold — this is that outside
	// point). Non-default loops also retire their lifecycleWG entries, which
	// the wait below awaits.
	s.stopAllQueueDrainLoops()
	s.stopServerOwnedAggregators()
	waitDone := make(chan struct{})
	go func() {
		s.bgWG.Wait()
		s.lifecycleWG.Wait()
		close(waitDone)
	}()
	select {
	case <-waitDone:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// stopAllPermissionWatchers cancels and clears every per-dir permission
// reconcile watcher the Server armed (including the default dir's). Idempotent:
// a second call is a no-op over already-cleared entries. watcherMu is taken
// standalone (NOT nested under aggMu here) — Shutdown issues it as a separate
// phase before stopServerOwnedAggregators and never holds both at once, so it
// does not invert the established aggMu-outer nesting order. Cancelling the
// watcher ctx propagates to the in-flight auto-reject RPC inside
// reconcileFailFastPerms (its timeout derives from this ctx), letting a watcher
// blocked on a slow reject exit promptly instead of waiting out permRejectTimeout.
func (s *Server) stopAllPermissionWatchers() {
	s.watcherMu.Lock()
	for dir, cancel := range s.watcherCancel {
		cancel()
		delete(s.watcherCancel, dir)
		delete(s.watcherOn, dir)
	}
	s.watcherMu.Unlock()
}

// stopAllQueueDrainLoops signals every registered drain loop to stop — each
// loop's RETAINED per-loop cancel first, then the done wait — so the exit +
// custody release do not depend solely on bgCtx having been cancelled.
// Shutdown-only (reload uses the per-dir stopQueueDrainLoop). Safe on an
// empty registry.
func (s *Server) stopAllQueueDrainLoops() {
	s.drainLoopsMu.Lock()
	loops := make([]*queueDrainLoop, 0, len(s.drainLoops))
	for dir, l := range s.drainLoops {
		loops = append(loops, l)
		delete(s.drainLoops, dir)
	}
	s.drainLoopsMu.Unlock()
	for _, l := range loops {
		if l.cancel != nil {
			l.cancel()
		}
		<-l.done
	}
}

// stopServerOwnedAggregators stops every NON-DEFAULT aggregator the Server
// created lazily via aggFor, mirroring handleReloadProject's per-dir teardown
// (stop + delete + reset queueGCOn/pinsGCOn) applied to all server-owned
// non-default dirs at once. The read+stop+delete for each entry happens inside
// ONE aggMu critical section — no pre-snapshot — so it stays safe against a
// concurrent handleReloadProject identity recheck (shutdown-first → reload's
// cur==a recheck sees the entry gone and skips; reload-first → shutdown stops
// the replacement). Aggregator.Stop() closes the store (idempotent), closing
// every subscriber channel and retiring the queue/pin subscriber loops. The
// DEFAULT dir ("") is skipped: that aggregator is daemon-owned and
// process-lifetime (its Run loop is owned by vhCancel, not RunManaged), so
// stopping/closing it here would invalidate a resource owned by another
// lifecycle boundary. Nested lock order matches reload: aggMu outer,
// queueGCMu/pinsGCMu inner.
func (s *Server) stopServerOwnedAggregators() {
	s.aggMu.Lock()
	for dir, a := range s.aggs {
		if dir == "" {
			continue
		}
		a.Stop()
		delete(s.aggs, dir)
		s.queueGCMu.Lock()
		delete(s.queueGCOn, dir)
		s.queueGCMu.Unlock()
		s.sessionErrMu.Lock()
		delete(s.sessionErrOn, dir)
		s.sessionErrMu.Unlock()
		s.queueDeliverMu.Lock()
		delete(s.queueDeliverOn, dir)
		s.queueDeliverMu.Unlock()
		s.pinsGCMu.Lock()
		delete(s.pinsGCOn, dir)
		s.pinsGCMu.Unlock()
		s.labelsGCMu.Lock()
		delete(s.labelsGCOn, dir)
		s.labelsGCMu.Unlock()
	}
	s.aggMu.Unlock()
}

// aggFor returns the aggregator for a project directory, creating and starting
// one lazily for directories beyond the default. Concurrent-safe.
func (s *Server) aggFor(dir string) *aggregator.Aggregator {
	if dir == "" {
		// Managed-project hook for the DEFAULT project (daemon cwd). Fired on the
		// first request that touches it — i.e. an authenticated browser actually
		// opening the project — NOT at daemon boot, so a restart never silently
		// runs repo-declared commands with no operator present.
		if s.managed != nil {
			s.managedDefaultOnce.Do(func() { s.managed.OpenProject("") })
		}
		if s.aggHook != nil {
			s.aggHook("", s.agg)
		}
		s.ensurePermissionWatcher("", s.agg)
		s.installQueueGCCleanup("", s.agg)
		s.installQueueSessionErrorSignal("", s.agg)
		s.installQueueDeliveryWatcher("", s.agg)
		s.installPinsLifecycle("", s.agg)
		s.installLabelsLifecycle("", s.agg)
		s.maybeStartQueueDrainLoop("")
		return s.agg
	}
	s.aggMu.Lock()
	defer s.aggMu.Unlock()
	if a, ok := s.aggs[dir]; ok {
		return a
	}
	a := aggregator.NewForDirectory(s.opencodeURL, dir, s.ringCap)
	// Arm synchronously BEFORE storing / returning, so no HTTP request can
	// observe an unarmed production aggregator. Without this, a GET
	// /vh/sessions/closeout?dir=<fresh-project>&id=<foreign-id> that wins the
	// race against the RunManaged goroutine below would see
	// ShouldServeSession==true (fail-open) and leak the foreign project's
	// messages via the project-blind Client().Messages upstream. The DEFAULT
	// aggregator is armed analogously by NewServer; Run's later a.armed = true
	// is a redundant no-op for both paths. See the armed field doc in
	// pkg/aggregator/aggregator.go for the full model.
	a.Arm()
	// Upstream-down gating (oc-death-watch S2): propagate the daemon's
	// lifecycle-derived predicate so this per-dir Run loop also skips the
	// 1s retry ramp while OpenCode is known down. Read outside aggMu — the
	// daemon installs it once at boot, before any request can reach aggFor.
	if s.upstreamDownProbe != nil {
		a.SetUpstreamDownProbe(s.upstreamDownProbe)
	}
	s.aggs[dir] = a
	// Managed-project hook: discover .vh-solara/project.jsonc, gate on trust, and
	// (if trusted) start declared processes + register views. Non-blocking; nil
	// when the daemon hasn't enabled managed projects.
	if s.managed != nil {
		s.managed.OpenProject(dir)
	}
	if s.aggHook != nil {
		s.aggHook(dir, a)
	}
	s.ensurePermissionWatcher(dir, a)
	s.installQueueGCCleanup(dir, a)
	s.installQueueSessionErrorSignal(dir, a)
	s.installQueueDeliveryWatcher(dir, a)
	s.installPinsLifecycle(dir, a)
	s.installLabelsLifecycle(dir, a)
	s.maybeStartQueueDrainLoop(dir)
	// Run under the Server's background-task lifetime (bgCtx) so Shutdown cancels
	// this per-directory aggregator's RunManaged child. RunManaged derives a
	// cancellable CHILD of bgCtx and arms a.cancel internally, so cancelling that
	// child closes the aggregator's always-on /event SSE subscription — the
	// connection a backing httptest/fake server's /event handler waits on, so the
	// server can Close() without hanging. Per-project drop isolation is preserved:
	// handleReloadProject can still drop ONE project via a.Stop() (cancels only
	// that child) without disturbing the default or any other project. Scope note:
	// Shutdown now retires these per-dir lifetimes EXPLICITLY — it cancels every
	// permission watcher (stopAllPermissionWatchers) and stops this non-default
	// aggregator (stopServerOwnedAggregators → a.Stop() → store.Close(), retiring
	// the queue/pin subscriber range loops) and awaits all of them via lifecycleWG.
	// The default aggregator ("") is daemon-owned and is NOT stopped by Shutdown.
	go a.RunManaged(s.bgCtx)
	return a
}

// aggForExisting returns the aggregator for dir only if one already exists —
// WITHOUT creating it or firing the managed-project / open hooks. Request paths
// that must not have the side effect of opening a project (header stamping on an
// arbitrary ?dir=) use this, so a benign GET can't launch a project's managed
// processes or grow the aggregator map for an attacker-chosen directory. Returns
// the default aggregator for "" (already running, accessed via s.agg OUTSIDE
// the map — see the aggs field note and RetargetOpenCode's coverage invariant)
// and nil for an unopened dir.
func (s *Server) aggForExisting(dir string) *aggregator.Aggregator {
	if dir == "" {
		return s.agg
	}
	s.aggMu.Lock()
	defer s.aggMu.Unlock()
	return s.aggs[dir]
}

// SetAggHook installs a per-project callback fired as each aggregator is touched
// (default + lazily-created). The alerts engine uses it to subscribe. Optional.
func (s *Server) SetAggHook(fn func(dir string, a *aggregator.Aggregator)) { s.aggHook = fn }

// SetUpstreamDownProbe installs the daemon's "OpenCode is known down right now"
// predicate (oc-death-watch S2): applied to the default aggregator immediately
// and to every per-dir aggregator aggFor lazily creates, so all aggregator Run
// loops cap their reconnect/hydrate retry backoffs while the daemon knows the
// upstream is dead instead of ramping from 1s against the dead port (N+1
// per-project loops otherwise hammer it every second). The daemon calls this
// once at boot, before serving requests; not calling it (external
// --opencode-url mode) leaves every aggregator's behavior unchanged.
func (s *Server) SetUpstreamDownProbe(fn func() bool) {
	s.upstreamDownProbe = fn
	if s.agg != nil && fn != nil {
		s.agg.SetUpstreamDownProbe(fn)
	}
}
