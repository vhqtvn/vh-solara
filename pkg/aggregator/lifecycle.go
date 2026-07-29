package aggregator

import (
	"context"
	"log"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// lifecycle.go — the aggregator's production lifetime: arming, the Run loop,
// and teardown.
//
// These functions own the seedMu-guarded lifecycle group (runCtx, armed,
// cancel, onHydrate) plus the atomic anyHydrateCompleted flag. seedMu is SHARED
// across lifecycle / hydration / cold-seed (Option 1 of the refactor brief):
// it stays a single lock declared once on the Aggregator struct in
// aggregator.go and acquired by code in all three concern files. There is NO
// lock split and NO new lock.
//
// The "never block under seedMu" discipline is load-bearing here:
//   - Stop reads cancel under seedMu, releases the lock, THEN calls cancel()
//     and store.Close() (holding seedMu across cancel() could deadlock a
//     downstream goroutine waiting on the ctx).
//   - Run writes runCtx/armed under seedMu once at the top, then releases
//     before any I/O, channel wait, or goroutine spawn.
// See the aggregator concurrency map §3 for the full acquisition-order
// analysis any change here must preserve.

// ShouldServeSession reports whether sid is a member of this aggregator's
// project scope, for the purpose of HTTP-boundary project-isolation guards
// (handleSessionsCloseout's inline guard). It encapsulates the same armed-gate
// + HasSession check used by the defense-in-depth backstop in EnsureMessages /
// EnsureMessagesAsync, so the HTTP layer does not need to know about the armed
// flag's existence.
//
// Returns true unconditionally when the aggregator has NOT been armed (created
// via New() / NewForDirectory() without aggFor, NewServer, or Run): this
// preserves the bare-test contract documented at aggregator_test.go:350-351
// ("issues the fetch regardless of tree presence") — tests that exercise
// Client().Messages directly on an unseeded aggregator (e.g.
// newSessionsTestServer in sessions_test.go) must not have their ids silently
// dropped. Once armed (Arm() called synchronously by aggFor for per-dir
// aggregators AND by web.NewServer for the default aggregator — see the armed
// field doc), returns HasSession(sid) so a foreign id is silent-dropped.
func (a *Aggregator) ShouldServeSession(sid string) bool {
	a.seedMu.Lock()
	armed := a.armed
	a.seedMu.Unlock()
	if !armed {
		return true
	}
	return a.store.HasSession(sid)
}

// Arm marks this aggregator as having entered the production lifecycle, so
// the project-isolation backstop in EnsureMessages / EnsureMessagesAsync and
// the HTTP-boundary guard in handleSessionsCloseout (via ShouldServeSession)
// activate. It is called SYNCHRONOUSLY in TWO production sites, BOTH before
// the aggregator can observe any HTTP request:
//
//   - web.NewServer arms the DEFAULT aggregator before returning the server
//     to the daemon (cmd/local-server.go / cmd/client-daemon.go), closing
//     the first-request TOCTOU where the HTTP listener would otherwise win
//     the race against `go agg.Run(...)` and observe armed=false (fail-open).
//
//   - web.Server.aggFor arms each freshly-built PER-DIRECTORY aggregator
//     before storing it in s.aggs / returning it, closing the same TOCTOU
//     against RunManaged's goroutine scheduling.
//
// Idempotent: a subsequent a.armed = true inside Run() (the default
// aggregator's path, or a redundant re-set for per-dir aggregators) writes
// the same value under the same lock. Safe to call on an aggregator that
// will later be passed to Run / RunManaged, and safe to call more than once.
//
// NOT called by aggregator.New / NewForDirectory: bare-test aggregators
// (the contract documented at aggregator_test.go:350-351) stay unarmed so
// direct EnsureMessages calls on unseeded sessions still fetch as before.
// Tests that want armed behavior call Arm() explicitly OR go through Run.
func (a *Aggregator) Arm() {
	a.seedMu.Lock()
	a.armed = true
	a.seedMu.Unlock()
}

// Stop tears down this aggregator: cancels its Run context (stopping the event
// tail, hydrate, cold-seed, and async message fetches) and closes its store's
// subscribers (forcing downstream SSE streams to exit so browsers reconnect
// against a fresh aggregator). It is the teardown half of a project reload
// (POST /vh/reload-project).
//
// cancel is read under seedMu (the lock RunManaged writes it under) so a
// concurrent RunManaged goroutine scheduling the write races no longer. The
// cancel() call itself happens OUTSIDE the lock to avoid holding seedMu across
// a context cancellation that downstream goroutines may be waiting on. The
// default aggregator's cancel is nil (started outside aggFor as
// process-lifetime); the nil-check still closes the store, but the default
// aggregator is never dropped from the map — see handleReloadProject. Safe to
// call more than once: a second close of an already-closed channel is avoided
// because Store.Close clears its subscriber map under the store lock
// (idempotent), and a nil cancel is a no-op.
func (a *Aggregator) Stop() {
	a.seedMu.Lock()
	cancel := a.cancel
	a.seedMu.Unlock()
	if cancel != nil {
		cancel()
	}
	if a.store != nil {
		a.store.Close()
	}
}

// RunManaged arms a.cancel with a cancellable child of ctx, then blocks on Run.
// It lets the web layer start a per-project aggregator whose lifetime it can
// later end via Stop() (POST /vh/reload-project) without the web package having
// to touch the unexported cancel field. The default aggregator is started by the
// daemon with plain Run (no cancel) — it is process-lifetime and never dropped.
//
// a.cancel is written under seedMu so a concurrent Stop() (which reads it under
// the same lock) sees a consistent value. Released before Run is called so the
// subsequent seedMu acquisition inside Run does not re-enter the lock.
func (a *Aggregator) RunManaged(ctx context.Context) {
	managed, cancel := context.WithCancel(ctx)
	a.seedMu.Lock()
	a.cancel = cancel
	a.seedMu.Unlock()
	a.Run(managed)
}

// SetOnHydrate installs a callback fired at the end of every successful hydrate
// (see the onHydrate field doc for the exact timing and constraints). Production
// code installs ONE callback per aggregator, inside the queueGCOn-guarded block
// of installQueueGCCleanup (pkg/web/server.go), so it shares that guard's
// lifecycle: installed once per (dir, aggregator) and reset on project reload
// (handleReloadProject drops the aggregator and aggFor builds a fresh one).
// Guarded by seedMu to match the read side in hydrate; safe to install before
// or after the first hydrate (the immediate-run branch in installQueueGCCleanup
// covers the "installed after first hydrate" case for the default aggregator).
func (a *Aggregator) SetOnHydrate(fn func()) {
	a.seedMu.Lock()
	a.onHydrate = fn
	a.seedMu.Unlock()
}

// AnyHydrateCompleted reports whether this aggregator has completed at least one
// successful hydrate. Used by the web layer's reconcileQueuesForAgg as the
// fail-closed gate: if false, the authoritative active-session set is not yet
// populated and reconciliation MUST delete nothing. Lock-free atomic read —
// safe to call on the request path (aggFor) without taking seedMu.
func (a *Aggregator) AnyHydrateCompleted() bool { return a.anyHydrateCompleted.Load() }

// Run keeps a live tail on OpenCode's event stream, re-hydrating the full view
// on every (re)connect because the stream has no replay. It blocks until ctx is
// cancelled.
func (a *Aggregator) Run(ctx context.Context) {
	// Capture the aggregator's lifetime ctx so background work (the cold-seed)
	// can derive from it instead of a short-lived request ctx. Done once, under
	// seedMu, before the first hydrate so startColdSeed observes it. armed is
	// set here too as a REDUNDANT no-op for production aggregators: the default
	// aggregator is armed synchronously by web.NewServer before Run's goroutine
	// schedules, and per-directory aggregators are armed synchronously by
	// aggFor. This write keeps bare-test aggregators that go through Run
	// (without NewServer / aggFor) armed for the duration of the test; for
	// production aggregators it writes the same value under the same lock —
	// harmless. See the armed field doc.
	a.seedMu.Lock()
	a.runCtx = ctx
	a.armed = true
	a.seedMu.Unlock()

	// Periodic /session/status reconcile self-heals a stale "busy" flag left
	// behind by a missed session.idle (dropped tunnel / reconnect gap / a turn
	// that ended without OpenCode emitting idle). See a.statusReconcileInterval.
	// Bound to Run's ctx so it stops on aggregator shutdown.
	go a.runStatusReconcile(ctx)

	// Periodic tree reconcile (Phase 2 §6.2): diffs the store against
	// OpenCode's authoritative /session list to catch ghosts (missed deletes)
	// and clobber-reverted archives. Folds in the existing archive re-assert
	// (reassertArchive) and the resurrection tombstone so Phase 2 merges rather
	// than duplicates them. Bound to Run's ctx so it stops on aggregator
	// shutdown. See a.treeReconcileInterval.
	go a.runTreeReconcile(ctx)

	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		start := time.Now()

		// Open the live tail first so events occurring during hydration are not
		// lost; the store is idempotent, so any overlap with the snapshot is safe.
		subCtx, cancel := context.WithCancel(ctx)
		errc := make(chan error, 1)
		go func() {
			errc <- a.client.SubscribeEvents(subCtx, func(ev opencode.Event) error {
				// Per-event trace (VH_DEBUG): the single most useful signal when an
				// event isn't producing the expected store change (e.g. the
				// permission.asked / message.part.delta drift bugs).
				if vhlog.Enabled() {
					vhlog.Debug("oc event", "type", ev.Type, "bytes", len(ev.Properties))
				}
				a.store.Apply(ev)
				return nil
			})
		}()

		if err := a.hydrate(ctx); err != nil {
			log.Printf("[aggregator] hydrate failed: %v", err)
		} else {
			log.Printf("[aggregator] hydrated; tailing events")
		}

		err := <-errc
		cancel()
		if ctx.Err() != nil {
			return
		}

		// A connection that survived a while is "healthy"; reset backoff.
		if time.Since(start) > 30*time.Second {
			backoff = time.Second
		}
		log.Printf("[aggregator] event stream ended (%v); reconnecting in %v", err, backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}
