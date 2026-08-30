// Package aggregator maintains a persistent connection to a local OpenCode
// server, feeding its events into a state.Store so clients can resume from the
// daemon instead of re-deriving everything themselves.
package aggregator

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/state"
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

	// anyHydrateCompleted is a sticky flag set true at the end of the first successful
	// hydrate and never reset (Stop/close do not clear it — it records "this
	// aggregator has produced at least one authoritative session set"). The web
	// layer reads it via AnyHydrateCompleted() to distinguish "0 active sessions after
	// a successful hydrate" (all on-disk queues are orphans — safe to delete)
	// from "not yet hydrated at all" (no authoritative set yet — delete NOTHING,
	// fail-closed). atomic because hydrate writes it (OUTSIDE seedMu — the
	// callback dispatch must not hold the lock) while AnyHydrateCompleted() callers on
	// the request path (e.g. aggFor) read it lock-free.
	anyHydrateCompleted atomic.Bool

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

	// pageMu guards pageInflight. pageInflight[sid] is non-nil while a Part B
	// "past-resident older-page" fetch (EnsureOlderMessages, triggered by the
	// boundary-demand handler) is in flight for that session. INDEPENDENT of
	// msgInflight (the cold-load slot): an older-page fetch does NOT block or
	// dedupe against a live cold-load, and vice versa. Collapses concurrent
	// same-session "Load older" demands to ONE upstream
	// GET /session/:id/message?before=<cursor>. A collapsed waiter blocks on the
	// slot's done chan (broadcast-wake on winner completion) and PROPAGATES the
	// winner's result error — nil on success, the MessagesBefore failure on
	// failure — instead of unconditionally nil (P2-AGG-004: a collapsed waiter
	// must learn of winner failure so the boundary-demand caller does not treat
	// a failed older-page fetch as success). Cleared on completion (success OR
	// failure).
	pageMu       sync.Mutex
	pageInflight map[string]*olderPageInflight

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

	// pageGateHook (test-only, nil in production) is invoked once per
	// EnsureOlderMessages call immediately AFTER a collapsed waiter finds a
	// registered pageInflight slot and releases pageMu — i.e. at the instant it
	// has committed to the collapse and is about to park on <-slot.done. A test
	// blocks here to deterministically confirm the collapse (the waiter found
	// the winner's slot) before releasing the winner, eliminating the scheduling
	// race where the waiter might otherwise run its slot lookup only AFTER the
	// winner's defer reclaimed the slot (turning a collapse into a fresh-winner
	// re-fetch). Mirrors msgGateHook. NOT lock-guarded — install once before any
	// concurrent call.
	pageGateHook func(sessionID string)

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

	// hydrateRetryBase is the initial backoff between hydrate retries inside
	// Run's per-connection loop: when a connection's first hydrate attempt
	// fails while the event stream stays healthy, Run retries hydrate with
	// this base delay, doubling up to hydrateBackoffMax, until the first
	// success for that connection (see Run). It defaults to 1s, set at
	// construction in New / NewForDirectory. It is a PER-INSTANCE field —
	// NOT a package global — mirroring statusReconcileInterval /
	// treeReconcileInterval: the instance field lets a test shrink it (e.g.
	// agg.hydrateRetryBase = 2*time.Millisecond) without racing a lingering
	// goroutine from another aggregator / a prior -count iteration. It is
	// read only by Run on its own goroutine; set it before calling Run /
	// RunManaged so the goroutine launch establishes the happens-before edge
	// to the read.
	hydrateRetryBase time.Duration
}

// olderPageInflight is the single-flight slot for a Part-B older-page fetch
// (EnsureOlderMessages). It carries BOTH the completion signal (done, closed by
// the winner to broadcast-wake ALL collapsed waiters) AND the winner's
// MessagesBefore result error (err, read by a woken waiter after <-done). The
// err is published by the winner BEFORE close(done), so the happens-before edge
// from the close to a waiter's <-done return guarantees the waiter observes it.
//
// A bare chan error CANNOT broadcast a non-nil error to N collapsed waiters — a
// send delivers to exactly one receiver, and close yields the zero value (a nil
// error) — so a pure chan error would either deadlock the 2nd+ waiter
// (unbuffered send, no close) or hand it nil on winner-failure (buffered +
// close). The slot struct is the idiomatic "broadcast a value" carrier
// (P2-AGG-004).
type olderPageInflight struct {
	err  error
	done chan struct{}
}

// DESIGN NOTE: state.New panic-translates the unreachable validate() error because
// all production callers supply vhEventRingCapacity (4096). If aggregator construction
// ever accepts a non-constant state.Config or operator-controlled ring capacity,
// re-evaluate error-returning construction (NewWithConfig returns (*Store, error))
// rather than relying on the panic-translating wrapper.
//
// New builds an aggregator targeting an opencode server base URL.
func New(baseURL string, ringCapacity int) *Aggregator {
	return &Aggregator{
		client:                  opencode.New(baseURL),
		store:                   state.New(ringCapacity),
		msgInflight:             map[string]chan struct{}{},
		pageInflight:            map[string]*olderPageInflight{},
		statusReconcileInterval: 60 * time.Second,
		treeReconcileInterval:   5 * time.Second,
		hydrateRetryBase:        time.Second,
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
		pageInflight:            map[string]*olderPageInflight{},
		statusReconcileInterval: 60 * time.Second,
		treeReconcileInterval:   5 * time.Second,
		hydrateRetryBase:        time.Second,
	}
}

// Directory returns the project directory this aggregator is scoped to ("" =
// the OpenCode serve cwd / default).
func (a *Aggregator) Directory() string { return a.client.Directory }

// Store exposes the materialized view for the web layer.
func (a *Aggregator) Store() *state.Store { return a.store }

// Client exposes the underlying OpenCode client (used for write passthrough).
func (a *Aggregator) Client() *opencode.Client { return a.client }

// Retarget points the aggregator's OpenCode client at a new base URL
// (P1-API-003: after a fresh-port restart of the serve process, the RUNNING
// daemon keeps this aggregator and simply re-targets it — the reconnect loop
// re-dials per connection and picks up the new target on its own, so no
// reconnect-nudging is needed here). Safe for concurrent use; the store, its
// subscribers, and all cached state survive the swap.
func (a *Aggregator) Retarget(baseURL string) { a.client.SetBaseURL(baseURL) }
