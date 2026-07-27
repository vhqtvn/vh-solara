// Package aggregator maintains a persistent connection to a local OpenCode
// server, feeding its events into a state.Store so clients can resume from the
// daemon instead of re-deriving everything themselves.
package aggregator

import (
	"context"
	"encoding/json"
	"log"
	"sync"
	"sync/atomic"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/state"
	"github.com/vhqtvn/vh-solara/pkg/vhlog"
)

// Aggregator couples an OpenCode client with a materialized Store.
type Aggregator struct {
	client *opencode.Client
	store  *state.Store

	// runCtx is the aggregator's lifetime context, captured once at the top of
	// Run. The background cold-seed derives its ctx from this — NOT from the
	// per-call hydrate ctx, which (under POST /vh/reload) is the request's ctx
	// and dies the moment the handler returns. Tying the seed to runCtx keeps
	// it alive across requests while still aborting on aggregator shutdown.
	// Guarded by seedMu. nil until Run has been called.
	runCtx context.Context

	// armed distinguishes "this aggregator has been started via the production
	// lifecycle" from "a bare test set runCtx to model shutdown"
	// (TestEnsureMessagesAsyncShutdownCancels assigns runCtx directly without
	// calling Run). The project-isolation backstop in
	// EnsureMessages/EnsureMessagesAsync gates on armed so it fires for every
	// production caller while preserving the documented bare-test contract
	// ("issues the fetch regardless of tree presence" —
	// aggregator_test.go:350-351) for tests that exercise EnsureMessages
	// directly without Run.
	//
	// Arming happens via ONE of two production paths, BOTH under seedMu:
	//
	//   1. Synchronously via Arm(), called by the web layer's aggFor
	//      (pkg/web/server.go) BEFORE the freshly-built per-directory
	//      aggregator is stored in s.aggs / returned to the caller. This
	//      closes the first-request TOCTOU: without it, aggFor would return
	//      the aggregator before the RunManaged goroutine even schedules, so
	//      ShouldServeSession would return true (fail-open) for any foreign
	//      id on the very first request to a newly-opened project.
	//
	//   2. Inside Run(), as a REDUNDANT no-op for the DEFAULT aggregator. The
	//      default aggregator is armed synchronously by web.NewServer before
	//      the server can serve any HTTP request (closing the same
	//      first-request TOCTOU aggFor closes for per-dir aggregators). Run's
	//      a.armed = true writes the same value under the same lock — harmless
	//      for both the default (already armed by NewServer) and per-dir
	//      (already armed by aggFor) aggregators. It remains in Run so a
	//      bare-test aggregator that goes through Run (without NewServer or
	//      aggFor) still arms for the duration of that test.
	//
	// Bare-test aggregators built via New() / NewForDirectory() without
	// aggFor or Run stay unarmed. Guarded by seedMu.
	armed bool

	// cancel stops the aggregator's Run loop (and everything that derives from
	// runCtx: the event tail, hydrate, cold-seed, async message fetches). It is
	// the cancellation half of a project reload (POST /vh/reload-project):
	// RunManaged arms it and handleReloadProject invokes Stop() to drop a
	// per-project aggregator without disturbing the default or any other
	// project. nil for the default aggregator (process-lifetime, started outside
	// aggFor) and until RunManaged arms it — Stop() nil-checks it.
	//
	// Guarded by seedMu (same lock Run/hydrate already take). The web layer
	// launches RunManaged via `go a.RunManaged(ctx)` from aggFor; that goroutine
	// is the one that writes a.cancel, OUTSIDE the caller's aggMu. A concurrent
	// Stop() (called from handleReloadProject under the web layer's aggMu) reads
	// a.cancel — there is no happens-before edge between the two via aggMu
	// (aggMu only orders the goroutine launch, not its subsequent body), so the
	// field MUST be guarded by its own lock. seedMu is reused because cancel is
	// conceptually part of the same lifecycle group as runCtx/armed/onHydrate
	// (all set up around Run) and Stop's read is brief and non-blocking.
	cancel context.CancelFunc

	// seedMu guards the aggregator's lifecycle fields: runCtx, armed, cancel,
	// onHydrate, and seedDone. seedDone is non-nil (and open) while a background
	// cold-seed goroutine is in flight, nil when none is running. The cold-seed
	// runs OFF the hydrate hot path (it no longer blocks reconnect/snapshot), so
	// at most one is allowed at a time: a hydrate that finds one in flight skips
	// starting another — the running seed already covers un-seeded sessions, and
	// the next hydrate's seed picks up anything that became un-seeded meanwhile
	// (e.g. a just-added session). Self-healing, no leak: the goroutine exits
	// when its fetches finish or its ctx is cancelled.
	seedMu   sync.Mutex
	seedDone chan struct{}

	// onHydrate, when non-nil, is invoked at the end of every SUCCESSFUL hydrate
	// (after store.Hydrate + cold-seed + best-effort fan-out have completed). It
	// is guarded by seedMu (same lock Run/hydrate already take). The web layer
	// uses it (FIX-QUEUE-GC-3) to run authoritative orphan-queue reconciliation
	// against the freshly-installed active-session set. Fired from the same
	// goroutine that ran hydrate — recipients MUST NOT block on store/registry
	// locks held by hydrate; the production callback dispatches its work to a
	// fresh goroutine.
	onHydrate func()

	// hydratedOnce is a sticky flag set true at the end of the first successful
	// hydrate and never reset (Stop/close do not clear it — it records "this
	// aggregator has produced at least one authoritative session set"). The web
	// layer reads it via HydratedOnce() to distinguish "0 active sessions after
	// a successful hydrate" (all on-disk queues are orphans — safe to delete)
	// from "not yet hydrated at all" (no authoritative set yet — delete NOTHING,
	// fail-closed). atomic because hydrate writes it (OUTSIDE seedMu — the
	// callback dispatch must not hold the lock) while HydratedOnce() callers on
	// the request path (e.g. aggFor) read it lock-free.
	hydratedOnce atomic.Bool

	// msgMu guards msgInflight. msgInflight[sid] is non-nil (open) while a cold
	// message-history fetch is in flight for that session — registered by EITHER
	// EnsureMessagesAsync (the stream first-open path) OR EnsureMessages (the
	// synchronous GET /vh/snapshot path); absent means none. This collapses
	// concurrent opens of the same cold session (rapid switching, a reopen before
	// the first completed, several Stream-2 consumers, or a sync snapshot racing
	// an async stream) to ONE upstream GET /session/:id/message. An async loser
	// is already subscribed and simply receives the eventual messages.loaded /
	// messages.error event; a sync EnsureMessages loser WAITS on the done chan
	// and re-checks IsMessagesLoaded (no-op on winner-success, retry as the next
	// winner on winner-failure). The winner — async OR sync — emits the
	// completion event so a deduped async caller never wedges. An entry is
	// cleared on completion (success OR failure) so a later selection retries
	// after a failure (the session is not left loaded on error).
	msgMu       sync.Mutex
	msgInflight map[string]chan struct{}

	// msgGateHook (test-only, nil in production) is invoked once per
	// EnsureMessages / EnsureMessagesAsync call immediately AFTER the unlocked
	// IsMessagesLoaded fast-path gate returns false — i.e. at the START of the
	// TOCTOU window between that unlocked read and msgMu acquisition. A test
	// may block in the callback to deterministically park a caller there while
	// a prior winner completes its full cold-fetch lifecycle (GET +
	// SetSessionMessages sets msgLoaded, defer reclaims the slot), reproducing
	// the exact schedule the under-lock IsMessagesLoaded re-check must close.
	// NOT guarded by a lock — install it once before any concurrent call.
	msgGateHook func(sessionID string)

	// statusReconcileInterval is how often runStatusReconcile polls OpenCode's
	// /session/status to self-heal a stale "busy" flag (see the doc block on
	// runStatusReconcile for the full rationale). It defaults to 60s, set at
	// construction in New / NewForDirectory. It is a PER-INSTANCE field — NOT a
	// package global — so a test can shrink it on the instance under test
	// (e.g. agg.statusReconcileInterval = 5*time.Millisecond) without racing a
	// lingering runStatusReconcile goroutine from another aggregator / a prior
	// -count iteration. It is read once at the top of runStatusReconcile (the
	// only reader) before that goroutine's ticker loop; set it before calling
	// Run / RunManaged so the goroutine launch establishes the happens-before
	// edge to the read.
	statusReconcileInterval time.Duration

	// treeReconcileInterval is how often runTreeReconcile polls OpenCode's
	// /session list to detect ghosts and clobbered archives (see the doc block
	// on runTreeReconcile for the full rationale). It defaults to 5s, set at
	// construction in New / NewForDirectory. It is a PER-INSTANCE field — NOT a
	// package global — mirroring statusReconcileInterval: the old package-global
	// TreeReconcileInterval carried the same latent global-mutation race that
	// bit statusReconcileInterval before it was moved per-instance (a global
	// written by one test's goroutine would race a lingering runTreeReconcile
	// goroutine from another aggregator / a prior -count iteration). No test
	// mutates it today, but the instance field removes the race proactively. It
	// is read once at the top of runTreeReconcile (the only reader) before that
	// goroutine's ticker loop; set it before calling Run / RunManaged so the
	// goroutine launch establishes the happens-before edge to the read.
	treeReconcileInterval time.Duration
}

// New builds an aggregator targeting an opencode server base URL.
func New(baseURL string, ringCapacity int) *Aggregator {
	return &Aggregator{
		client:                  opencode.New(baseURL),
		store:                   state.New(ringCapacity),
		msgInflight:             map[string]chan struct{}{},
		statusReconcileInterval: 60 * time.Second,
		treeReconcileInterval:   5 * time.Second,
	}
}

// NewForDirectory builds an aggregator scoped to a project directory (sent to
// OpenCode via the x-opencode-directory header), for multi-project support.
func NewForDirectory(baseURL, directory string, ringCapacity int) *Aggregator {
	c := opencode.New(baseURL)
	c.Directory = directory
	return &Aggregator{
		client:                  c,
		store:                   state.New(ringCapacity),
		msgInflight:             map[string]chan struct{}{},
		statusReconcileInterval: 60 * time.Second,
		treeReconcileInterval:   5 * time.Second,
	}
}

// Directory returns the project directory this aggregator is scoped to ("" =
// the OpenCode serve cwd / default).
func (a *Aggregator) Directory() string { return a.client.Directory }

// Store exposes the materialized view for the web layer.
func (a *Aggregator) Store() *state.Store { return a.store }

// Client exposes the underlying OpenCode client (used for write passthrough).
func (a *Aggregator) Client() *opencode.Client { return a.client }

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

// HydratedOnce reports whether this aggregator has completed at least one
// successful hydrate. Used by the web layer's reconcileQueuesForAgg as the
// fail-closed gate: if false, the authoritative active-session set is not yet
// populated and reconciliation MUST delete nothing. Lock-free atomic read —
// safe to call on the request path (aggFor) without taking seedMu.
func (a *Aggregator) HydratedOnce() bool { return a.hydratedOnce.Load() }

// Rehydrate re-fetches the full state from OpenCode and reconciles the store.
// Safe to call at any time: Hydrate diffs by id and emits only the changes, so
// connected clients converge without a full resync. This is the "reload server
// state" primitive — it rebuilds the view from the source of truth (OpenCode)
// without restarting the process or touching the running OpenCode.
func (a *Aggregator) Rehydrate(ctx context.Context) error { return a.hydrate(ctx) }

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

// hydrate fetches the full session list (flat, with parentID) plus each
// session's messages, then reconciles them into the store via id-level diff.
func (a *Aggregator) hydrate(ctx context.Context) error {
	sessions, err := a.client.ListSessions(ctx)
	if err != nil {
		return err
	}
	// Messages are hydrated LAZILY: at startup we fetch none (the tree + live
	// stream are enough). On reconnect we re-fetch only the sessions a client
	// has actually opened, so a project with thousands of sessions doesn't pay
	// thousands of message fetches. Unopened sessions load on first open
	// (EnsureMessages).
	messages := make(map[string][]state.MessageWithParts)
	for _, id := range a.store.LoadedSessions() {
		items, err := a.client.Messages(ctx, id)
		if err != nil {
			log.Printf("[aggregator] messages fetch failed for %s: %v", id, err)
			continue
		}
		messages[id] = decodeMessages(items)
	}
	a.store.Hydrate(sessions, messages)

	// Seed lastAgent (the agent of a session's most recent assistant turn) for
	// sessions whose messages were NOT fetched above. The tree snapshot carries
	// no messages, so without this the per-agent chips on cold/un-opened sessions
	// would stay empty until a session is opened. We fetch only a lightweight tail
	// (newest N messages) per session and scan it for the most recent assistant
	// message's info.agent — bounded concurrency keeps thousands of sessions sane.
	// This runs in the BACKGROUND (off the reconnect-critical path): hydrate must
	// return promptly so the event stream and snapshots are not delayed by these
	// upstream tail fetches. Each cold session is seeded at most once for the
	// aggregator's lifetime (memoized in the store); only newly-seen sessions are
	// fetched on later reconnects. See startColdSeed.
	a.startColdSeed(ctx, sessions)

	// Seed per-session activity (busy/idle/error) and recover any pending
	// questions/permissions. These are three INDEPENDENT upstream GETs, so we
	// fan them out concurrently: on cold start / reconnect (epoch change) this
	// makes first-snapshot time pay ~1 round-trip (max latency) instead of the
	// sum of three. opencode.Client is safe for concurrent use — it carries no
	// per-call mutable state (only the shared, goroutine-safe http.Client) and
	// seedColdLastAgents already fans out 8-wide against it; the three store
	// mutators each take s.mu, so concurrent Set* calls are safe too.
	//
	// Best-effort semantics: these three calls enrich facets of the UI (activity
	// status, pending questions, pending permissions). A failure leaves only
	// those facets stale until the next poll — it must NOT fail hydrate. This
	// matches the prior serial code's `err == nil`-guard behavior (hydrate
	// always returned nil regardless of these calls), so POST /vh/reload error
	// propagation is unchanged. The concurrent fan-out is retained purely for
	// the perf win above; each failure is logged via log.Printf for
	// observability. These calls are synchronous w.r.t. hydrate (wg.Wait()
	// blocks), so they use the same ctx discipline as the rest of hydrate: a
	// cancelled ctx aborts all three promptly, and defer wg.Done() runs even on
	// a panic so wg.Wait() never deadlocks (no goroutine leak).
	var wg sync.WaitGroup
	run := func(name string, fn func() error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := fn(); err != nil {
				log.Printf("[aggregator] %s failed: %v", name, err)
			}
		}()
	}
	run("SessionStatuses", func() error {
		statuses, err := a.client.SessionStatuses(ctx)
		if err != nil {
			return err
		}
		a.store.SetActivityFromStatuses(statuses)
		return nil
	})
	run("ListQuestions", func() error {
		qs, err := a.client.ListQuestions(ctx)
		if err != nil {
			return err
		}
		a.store.SetPendingQuestions(qs)
		return nil
	})
	run("ListPermissions", func() error {
		ps, err := a.client.ListPermissions(ctx)
		if err != nil {
			return err
		}
		a.store.SetPendingPermissions(ps)
		return nil
	})
	wg.Wait()

	// Successful hydrate complete: the store now holds the authoritative active-
	// session set. Record stickiness (HydratedOnce) and fire the onHydrate
	// callback (FIX-QUEUE-GC-3 orphan-queue reconciliation) so the web layer can
	// delete on-disk queue.json files whose session IDs are NOT in this set.
	// The callback is read under seedMu and invoked OUTSIDE the lock; production
	// callbacks dispatch to a fresh goroutine so they never block hydrate's
	// goroutine or risk a lock-order inversion against store/registry mutexes.
	// This fire-site is reached ONLY on hydrate success — every error path above
	// returns early before this point, so a failed/partial hydrate leaves
	// hydratedOnce=false and fires nothing (fail-closed for reconciliation).
	a.hydratedOnce.Store(true)
	a.seedMu.Lock()
	cb := a.onHydrate
	a.seedMu.Unlock()
	if cb != nil {
		cb()
	}
	return nil
}

// coldTailLimit is the number of newest messages fetched per un-opened session
// to derive its lastAgent for the tree chips. It only needs to be large enough
// to typically contain the most recent assistant turn.
const coldTailLimit = 10

// startColdSeed launches seedColdLastAgents on a background goroutine (off the
// hydrate hot path) unless one is already running. At most one cold-seed is in
// flight at a time: a hydrate that finds one running skips — the in-flight seed
// covers all currently-un-seeded sessions (it queries the store's memo each
// run), and the next hydrate picks up anything that became un-seeded meanwhile.
// The goroutine is bound by the aggregator's LIFETIME ctx (a.runCtx, captured in
// Run), NOT by the hydrate ctx: hydrate also runs under POST /vh/reload, whose
// ctx dies the moment the handler returns — tying the seed to that would abort
// in-flight MessagesTail fetches and skip MarkColdSeeded, leaving labels empty.
// The lifetime ctx still cancels the seed on aggregator shutdown, so it never
// outlives the aggregator. When Run has not run yet (a.runCtx == nil, e.g. tests
// calling Rehydrate directly), the seed detaches from the caller via
// context.WithoutCancel so a short-lived ctx can't kill it mid-fetch.
func (a *Aggregator) startColdSeed(ctx context.Context, sessions []json.RawMessage) {
	a.seedMu.Lock()
	if a.seedDone != nil {
		a.seedMu.Unlock()
		return
	}
	done := make(chan struct{})
	a.seedDone = done
	// Derive the seed's lifetime from the AGGREGATOR's lifetime (a.runCtx), read
	// here under seedMu (consistent with Run's write). NOT from the hydrate ctx:
	// under POST /vh/reload that ctx is the request's and is canceled when the
	// handler returns, which would kill in-flight fetches. When Run hasn't been
	// called yet, fall back to a request-detached copy of ctx so the seed still
	// outlives a short-lived caller.
	seedCtx := a.runCtx
	if seedCtx == nil {
		seedCtx = context.WithoutCancel(ctx)
	}
	a.seedMu.Unlock()
	go func() {
		defer func() {
			a.seedMu.Lock()
			if a.seedDone == done {
				a.seedDone = nil
			}
			a.seedMu.Unlock()
			close(done)
		}()
		a.seedColdLastAgents(seedCtx, sessions)
	}()
}

// waitColdSeed blocks until the in-flight background cold-seed (if any)
// completes. Production callers do NOT wait — the seed is intentionally
// non-blocking w.r.t. hydrate. Exposed for tests that need to observe the
// seeded end-state synchronously.
func (a *Aggregator) waitColdSeed() {
	a.seedMu.Lock()
	done := a.seedDone
	a.seedMu.Unlock()
	if done != nil {
		<-done
	}
}

// seedColdLastAgents fetches a lightweight message tail for each session NOT
// already loaded (messages reconciled authoritatively above) AND not yet
// cold-seeded, and seeds its lastAgent in the store. This is what makes
// per-agent chips render on a cold tree before any session is opened. Errors
// per session are logged and skipped (graceful — no worse than an empty chip);
// a failed fetch is NOT marked seeded, so it retries on the next reconnect,
// matching pre-memo behavior. A successful fetch marks the session seeded
// (store.MarkColdSeeded) so later reconnects skip the re-fetch entirely.
func (a *Aggregator) seedColdLastAgents(ctx context.Context, sessions []json.RawMessage) {
	loaded := make(map[string]bool)
	for _, id := range a.store.LoadedSessions() {
		loaded[id] = true
	}

	type sessEnv struct {
		ID string `json:"id"`
	}

	// Collect candidate ids: sessions present in the fresh tree, not loaded.
	candidates := make([]string, 0, len(sessions))
	for _, raw := range sessions {
		var se sessEnv
		if json.Unmarshal(raw, &se) != nil || se.ID == "" {
			continue
		}
		if loaded[se.ID] {
			continue // messages already reconciled authoritatively
		}
		candidates = append(candidates, se.ID)
	}

	// Keep only sessions not yet cold-seeded — the memo that kills the
	// reconnect fetch storm (each cold session is fetched once, not per
	// reconnect). Invalidated on session removal (store.deleteSessionLocked).
	need := a.store.ColdSeedNeeded(candidates)
	if len(need) == 0 {
		return
	}

	var (
		mu         sync.Mutex
		wg         sync.WaitGroup
		lastAgents = map[string]string{}
		sem        = make(chan struct{}, 8) // bound concurrency; limit=10 keeps each fetch cheap
	)
	for _, id := range need {
		wg.Add(1)
		sem <- struct{}{}
		go func(id string) {
			defer wg.Done()
			defer func() { <-sem }()
			items, err := a.client.MessagesTail(ctx, id, coldTailLimit)
			if err != nil {
				log.Printf("[aggregator] lastAgent tail fetch failed for %s: %v", id, err)
				return
			}
			// Mark seeded only on a successful fetch so a transient failure
			// retries next reconnect (pre-memo behavior). MarkColdSeeded is a
			// no-op if the session was deleted in the race window between the
			// fetch and here, keeping the memo correct across remove/recreate.
			a.store.MarkColdSeeded(id)
			if agent := lastAssistantAgent(items); agent != "" {
				mu.Lock()
				lastAgents[id] = agent
				mu.Unlock()
			}
		}(id)
	}
	wg.Wait()
	if len(lastAgents) > 0 {
		a.store.SetLastAgents(lastAgents)
	}
}

// lastAssistantAgent scans a list of raw {info,parts} messages from the END
// backward and returns the info.agent of the most recent assistant message, or "".
// The opencode message page is newest-window, oldest-first within the window, so
// the last array element is the newest message.
func lastAssistantAgent(items []json.RawMessage) string {
	for i := len(items) - 1; i >= 0; i-- {
		var m struct {
			Info struct {
				Role  string `json:"role"`
				Agent string `json:"agent"`
			} `json:"info"`
		}
		if json.Unmarshal(items[i], &m) == nil && m.Info.Role == "assistant" && m.Info.Agent != "" {
			return m.Info.Agent
		}
	}
	return ""
}
