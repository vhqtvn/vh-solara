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
}

// New builds an aggregator targeting an opencode server base URL.
func New(baseURL string, ringCapacity int) *Aggregator {
	return &Aggregator{
		client:      opencode.New(baseURL),
		store:       state.New(ringCapacity),
		msgInflight: map[string]chan struct{}{},
	}
}

// NewForDirectory builds an aggregator scoped to a project directory (sent to
// OpenCode via the x-opencode-directory header), for multi-project support.
func NewForDirectory(baseURL, directory string, ringCapacity int) *Aggregator {
	c := opencode.New(baseURL)
	c.Directory = directory
	return &Aggregator{client: c, store: state.New(ringCapacity), msgInflight: map[string]chan struct{}{}}
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

// SetMsgGateHook installs a TEST-ONLY rendezvous callback fired once per
// EnsureMessages / EnsureMessagesAsync call immediately after the unlocked
// IsMessagesLoaded fast-path gate returns false — i.e. at the start of the
// TOCTOU window between that unlocked read and msgMu acquisition. A test blocks
// in the callback to deterministically park a caller there while a prior winner
// completes its full cold-fetch lifecycle, then observes whether the under-lock
// IsMessagesLoaded re-check closes the race (no redundant GET / no warm-resync
// clobber). Nil (the default) is a no-op; production code never sets it. Not
// lock-guarded — install once before any concurrent call.
func (a *Aggregator) SetMsgGateHook(fn func(sessionID string)) { a.msgGateHook = fn }

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

func decodeMessages(items []json.RawMessage) []state.MessageWithParts {
	mwp := make([]state.MessageWithParts, 0, len(items))
	for _, it := range items {
		var m state.MessageWithParts
		if json.Unmarshal(it, &m) == nil {
			mwp = append(mwp, m)
		}
	}
	return mwp
}

// EnsureMessages lazily loads a session's message history on first open (the
// synchronous path used by GET /vh/snapshot). It is a no-op once the session is
// loaded; subsequent live events keep it current.
//
// SINGLE-FLIGHT (C-F2): this coordinates with EnsureMessagesAsync through the
// SHARED msgInflight[sessionID] slot, collapsing sync↔sync AND sync↔async
// duplicates of the same cold session to ONE upstream GET. After the
// IsMessagesLoaded gate it acquires msgMu: if a fetch is already in flight
// (async OR sync winner), the caller WAITS on the existing done chan (the
// waiter), then re-checks IsMessagesLoaded — on winner-success the data is now
// loaded (loop → no-op return); on winner-failure the slot was reclaimed and the
// session is still unloaded, so the loop retries as the next winner. A
// request-ctx cancel (client disconnect) aborts the wait via the select. A
// waiter never issues a GET of its own, so at most ONE upstream fetch serves all
// concurrent callers — this is what closes C-F2 (no second warm reconcile of the
// same cold load can clobber live-arrived content).
//
// COMPLETION SIGNAL: the shared slot is also used by EnsureMessagesAsync, whose
// deduped callers rely on receiving messages.loaded / messages.error from the
// winner. So the sync WINNER emits those events too — without this, an async
// caller that deduped against a sync winner would never receive the completion
// signal and its SSE client would wedge on the loading state. The sync endpoint
// itself ignores the events (it returns the snapshot directly).
//
// COLD-FETCH WINDOW: like EnsureMessagesAsync the winner marks cold-fetch-active
// for the duration of the (potentially blocking) GET so a live event arriving
// mid-fetch tags its entries and the subsequent SetSessionMessages reconcile
// preserves the newer live content instead of clobbering it with the stale
// fetched body (C-F2). MarkColdFetchStart is set AFTER the IsMessagesLoaded
// early-return (never for an already-warm session) and BEFORE the GET; the
// deferred ClearColdFetchActive covers the GET-FAILURE path (no reconcile runs
// to clear the marker) and is idempotent on the success path (the cold-load
// reconcile already cleared it inside reconcileMessagesLocked).
func (a *Aggregator) EnsureMessages(ctx context.Context, sessionID string) error {
	if sessionID == "" {
		return nil
	}
	// Defense-in-depth project-isolation backstop: never hydrate a session that
	// is not a member of THIS aggregator's project store. OpenCode's
	// /session/<id>/message endpoint is project-blind, so without this gate a
	// buggy caller passing a foreign sessionID would fetch and cache another
	// project's messages into this store. The HTTP-boundary guard
	// (projectScopedFilter) is the primary defense; this is the backstop that
	// turns any future buggy caller into a silent no-op rather than a leak. It
	// is intentionally NOT in SetSessionMessages: the cold-seed path can deliver
	// messages slightly before the session row lands.
	//
	// Gated on armed: in production every aggregator is armed BEFORE the HTTP
	// layer routes a request to it — per-directory aggregators via the
	// synchronous Arm() call inside aggFor (closing the first-request TOCTOU),
	// the default aggregator via the synchronous Arm() call inside
	// web.NewServer (closing the same TOCTOU at server-construction time, so
	// the HTTP listener cannot win the race against `go agg.Run(...)`). So the
	// backstop fires for every real caller. Bare aggregator unit tests that
	// call EnsureMessages directly without Run / aggFor (e.g.
	// TestEnsureMessagesAsyncSuccessEmitsCompletion) intentionally rely on the
	// documented "issues the fetch regardless of tree presence" behavior;
	// gating on armed (NOT runCtx!=nil) preserves that contract even for
	// TestEnsureMessagesAsyncShutdownCancels, which manually sets runCtx to
	// model shutdown without calling Run.
	a.seedMu.Lock()
	armed := a.armed
	a.seedMu.Unlock()
	if armed && !a.store.HasSession(sessionID) {
		return nil
	}
	for {
		if a.store.IsMessagesLoaded(sessionID) {
			return nil
		}
		// msgGateHook (test-only, nil in production): rendezvous right at the
		// start of the TOCTOU window — AFTER the unlocked IsMessagesLoaded
		// fast-path read and BEFORE msgMu acquisition — so a test can
		// deterministically park a caller here while a prior winner runs its
		// full cold-fetch lifecycle, then prove the under-lock re-check below
		// closes the race. See SetMsgGateHook + TestEnsureMessagesTOCTOURecheck.
		if a.msgGateHook != nil {
			a.msgGateHook(sessionID)
		}
		a.msgMu.Lock()
		// UNDER-LOCK RE-CHECK (TOCTOU close, commit-reviewer tier1_b:F1): the
		// unlocked IsMessagesLoaded gate above is a fast-path that races with a
		// concurrent winner's full lifecycle. Between that read and this Lock a
		// prior winner may have completed SetSessionMessages (msgLoaded[sid]=true,
		// set inside store.mu) AND reclaimed its slot (delete(msgInflight, sid),
		// set inside msgMu). The winner sets msgLoaded BEFORE its defer acquires
		// msgMu to delete the slot, and we now hold msgMu after that defer
		// released it — so observing msgLoaded here is happens-before-correct.
		// A re-check that finds the session loaded returns nil WITHOUT becoming a
		// fresh winner / issuing a redundant GET (whose warm-resync reconcile,
		// coldLoad==false, would authoritatively clobber live content — the C-F2
		// symptom via a different path). The outer unlocked gate stays as a
		// fast-path to avoid contending on msgMu for warm calls; this under-lock
		// re-check is the correctness gate.
		if a.store.IsMessagesLoaded(sessionID) {
			a.msgMu.Unlock()
			return nil
		}
		if done, ok := a.msgInflight[sessionID]; ok {
			// A fetch (async OR sync) is already in flight for this session.
			// Wait for it, then re-evaluate at the top of the loop. ctx aborts
			// the wait: the sync caller's request ctx can die (client
			// disconnect) while an async winner is bound to a.runCtx (which
			// outlives the request) — without the select the waiter would block
			// until that longer-lived winner finishes.
			a.msgMu.Unlock()
			select {
			case <-done:
			case <-ctx.Done():
				return ctx.Err()
			}
			continue
		}
		// No inflight entry: become the winner and run the fetch inline.
		done := make(chan struct{})
		a.msgInflight[sessionID] = done
		a.msgMu.Unlock()

		a.store.MarkColdFetchStart(sessionID)
		// Reclaim the slot + unblock waiters on BOTH success and failure: a
		// waiter observing a failed winner re-checks IsMessagesLoaded (still
		// false) and loops to retry as the next winner. Slot-clear +
		// ClearColdFetchActive + close(done) mirror EnsureMessagesAsync's defer
		// ordering so a woken waiter never sees a stale slot.
		defer func() {
			a.msgMu.Lock()
			if a.msgInflight[sessionID] == done {
				delete(a.msgInflight, sessionID)
			}
			a.msgMu.Unlock()
			a.store.ClearColdFetchActive(sessionID)
			close(done)
		}()
		t0 := time.Now()
		items, err := a.client.Messages(ctx, sessionID)
		if err != nil {
			// Signal failure to any async caller that deduped against this sync
			// winner (shared-slot completion contract). The session stays
			// unloaded; the defer above cleared the slot so a reselect retries.
			a.store.EmitMessagesError(sessionID, err.Error())
			return err
		}
		fetchMs := time.Since(t0).Milliseconds()
		tR := time.Now()
		status := a.store.SetSessionMessages(sessionID, decodeMessages(items))
		reconcileMs := time.Since(tR).Milliseconds()
		// Emit completion ONLY when a batch was published (cold) or it was a
		// genuine warm reconcile (no batch required). When the session
		// disappeared (deleted between reconcile and capture) or packaging
		// failed, SetSessionMessages published NO batch — emitting loaded here
		// would deliver messages.loaded with no preceding messages.batch,
		// breaking the one-batch-before-loaded ordering the client relies on,
		// and emitting an empty batch to satisfy ordering would reintroduce
		// state after session.delete (Finding 3). The session is gone; the
		// client tears it down on session.deleted.
		if status == state.ColdBatchEmitted || status == state.ColdBatchWarmReconcile {
			a.store.EmitMessagesLoaded(sessionID, fetchMs, reconcileMs)
		}
		return nil
	}
}

// EnsureMessagesAsync is the non-blocking lazy-hydration entrypoint used by the
// session-selection path (Stream 2 first open). It does NOT wait for the
// upstream fetch: it returns immediately so handleStream can send the snapshot
// (partial — no messages yet) at once, then forward message.*/part.* deltas +
// the messages.loaded completion over the SAME open connection as the
// background fetch reconciles the result. This is what makes selecting an
// unloaded session fast on first open (the old EnsureMessages blocked the
// snapshot behind a full GET /session/:id/message).
//
// Per-session single-flight: concurrent calls for the same session collapse to
// ONE upstream fetch (a loser that's already subscribed just receives the
// eventual completion event). No-op if the session is already loaded.
//
// The fetch goroutine is bound to the AGGREGATOR's LIFETIME ctx (a.runCtx), NOT
// the caller's ctx: handleStream's r.Context() dies the moment the SSE handler
// returns, but the fetch must survive to populate the store + emit completion
// for the NEXT client that opens the session. Mirrors startColdSeed's lifetime
// binding; falls back to a request-detached ctx (context.WithoutCancel) when Run
// hasn't been called yet (tests calling this directly).
//
// On success: SetSessionMessages (marks loaded, emits message.*/part.* deltas)
// THEN EmitMessagesLoaded (carrying fetch/reconcile split timing) —
// UNCONDITIONALLY, so a fetch that returned zero or byte-identical messages (no
// diff deltas) still signals completion and the client doesn't wedge on its
// loading state. On failure (and NOT a shutdown):
// log + EmitMessagesError, leave the session UNLOADED so a reselect / transport
// reconnect retries; on shutdown (ctx cancelled) just exit silently.
func (a *Aggregator) EnsureMessagesAsync(ctx context.Context, sessionID string) {
	if sessionID == "" {
		return
	}
	// Defense-in-depth project-isolation backstop — see EnsureMessages for the
	// full rationale. The async path is what handleStream's triggerMessageLoad
	// reaches; without this gate a foreign id would spawn a background fetch.
	// Gated on armed to preserve the bare-test contract documented at
	// aggregator_test.go:350-351 ("issues the fetch regardless of tree
	// presence") for tests that call EnsureMessagesAsync without Run / aggFor;
	// every production aggregator is armed (synchronously inside aggFor for
	// per-dir aggregators, inside web.NewServer for the default) before any
	// HTTP request reaches it, so the backstop fires for every real caller.
	// armed (NOT runCtx!=nil) is the gate because
	// TestEnsureMessagesAsyncShutdownCancels manually sets runCtx without
	// calling Run.
	a.seedMu.Lock()
	armed := a.armed
	a.seedMu.Unlock()
	if armed && !a.store.HasSession(sessionID) {
		return
	}
	if a.store.IsMessagesLoaded(sessionID) {
		return
	}
	if a.msgGateHook != nil {
		a.msgGateHook(sessionID)
	}
	a.msgMu.Lock()
	// UNDER-LOCK RE-CHECK (TOCTOU close, tier1_b:F1): same window + fix as
	// EnsureMessages — see the longer note there. Between the unlocked
	// IsMessagesLoaded read and this Lock a prior winner (async OR sync) may
	// have loaded the session (SetSessionMessages set msgLoaded) AND reclaimed
	// its slot (defer deleted msgInflight). Acquiring msgMu after that defer
	// guarantees we observe msgLoaded==true, so a caller that now finds NO slot
	// must NOT become a fresh winner (which would spawn a redundant GET whose
	// warm-resync reconcile clobbers live content); it returns instead. The
	// unlocked gate above stays as a fast-path; this is the correctness gate.
	if a.store.IsMessagesLoaded(sessionID) {
		a.msgMu.Unlock()
		return
	}
	if _, ok := a.msgInflight[sessionID]; ok {
		// A fetch is already in flight for this session; the caller is already
		// subscribed and will receive the eventual completion event — dedupe.
		a.msgMu.Unlock()
		return
	}
	done := make(chan struct{})
	a.msgInflight[sessionID] = done
	a.msgMu.Unlock()
	// Derive the fetch ctx from the AGGREGATOR's lifetime (a.runCtx), NOT the
	// caller's: handleStream's r.Context() is cancelled when the handler
	// returns, which would abort a fetch the store needs. Read under seedMu —
	// a.runCtx is the seedMu-guarded lifetime ctx Run captures (mirrors
	// startColdSeed). When Run hasn't run yet (a.runCtx == nil, e.g. tests),
	// detach from the caller so a short-lived ctx can't kill it mid-fetch.
	a.seedMu.Lock()
	fetchCtx := a.runCtx
	a.seedMu.Unlock()
	if fetchCtx == nil {
		fetchCtx = context.WithoutCancel(ctx)
	}

	go func() {
		defer func() {
			a.msgMu.Lock()
			if a.msgInflight[sessionID] == done {
				delete(a.msgInflight, sessionID)
			}
			a.msgMu.Unlock()
			// On GET failure (no reconcile ran to clear it) drop the
			// cold-fetch marker so gap events between failure and retry
			// are not wrongly preserved by the next successful reconcile.
			a.store.ClearColdFetchActive(sessionID)
			close(done)
		}()
		// Split the `hydrate` window the client already measures (first snapshot
		// → messages.loaded): fetchMs = the upstream OpenCode GET
		// /session/:id/message round-trip; reconcileMs = the daemon-side
		// SetSessionMessages (decode + id-level diff + emit). Carried on the
		// messages.loaded event so the Servers panel can attribute a
		// session-switch stall to upstream-fetch vs daemon-reconcile without a
		// second probe. `server` (snap) is blind to this window since Slice C
		// made the upstream fetch async/best-effort.
		//
		// Mark the cold-fetch window as in-flight BEFORE the GET so live
		// events that arrive during the (potentially blocking) GET tag their
		// entries — the subsequent SetSessionMessages reconcile then preserves
		// the newer live body instead of clobbering it with the stale fetched
		// one (C-F2). Cleared by reconcileMessagesLocked after the merge.
		a.store.MarkColdFetchStart(sessionID)
		t0 := time.Now()
		items, err := a.client.Messages(fetchCtx, sessionID)
		if err != nil {
			if fetchCtx.Err() != nil {
				// Aggregator shutting down (or caller ctx cancelled in a direct
				// test path): don't spam a completion event into a torn-down
				// store, and don't log a spurious failure. The session stays
				// unloaded; a later selection on a fresh aggregator retries.
				return
			}
			// Include fetchMs in the log: a background fetch the operator isn't
			// watching still took wall-clock time before failing, useful signal.
			log.Printf("[aggregator] EnsureMessagesAsync failed for %s (fetch=%dms): %v", sessionID, time.Since(t0).Milliseconds(), err)
			a.store.EmitMessagesError(sessionID, err.Error())
			return
		}
		fetchMs := time.Since(t0).Milliseconds()
		tR := time.Now()
		status := a.store.SetSessionMessages(sessionID, decodeMessages(items))
		reconcileMs := time.Since(tR).Milliseconds()
		// Emit completion ONLY when a batch was published (cold) or it was a
		// genuine warm reconcile (no batch required). A cold fetch for a session
		// that was deleted between reconcile and capture, or a packaging
		// failure, publishes NO batch — emitting loaded here would deliver
		// messages.loaded with no preceding messages.batch (one-batch-before-
		// loaded ordering), and emitting an empty batch to satisfy ordering
		// would reintroduce state after session.delete. When the session is
		// gone the client tears it down on session.deleted (Finding 3). On a
		// successful warm reconcile with zero changed deltas the loaded event is
		// still emitted so the client exits the loading state.
		if status == state.ColdBatchEmitted || status == state.ColdBatchWarmReconcile {
			a.store.EmitMessagesLoaded(sessionID, fetchMs, reconcileMs)
		}
	}()
}

// waitMessagesAsync blocks until any in-flight EnsureMessagesAsync fetch for the
// given session completes (success or failure). Production callers do NOT wait
// — the fetch is intentionally non-blocking. Exposed for tests that need to
// observe the hydrated end-state (or the cleared in-flight slot after a
// failure) synchronously. Mirrors waitColdSeed.
func (a *Aggregator) waitMessagesAsync(sessionID string) {
	a.msgMu.Lock()
	done := a.msgInflight[sessionID]
	a.msgMu.Unlock()
	if done != nil {
		<-done
	}
}

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
	// that ended without OpenCode emitting idle). See StatusReconcileInterval.
	// Bound to Run's ctx so it stops on aggregator shutdown.
	go a.runStatusReconcile(ctx)

	// Periodic tree reconcile (Phase 2 §6.2): diffs the store against
	// OpenCode's authoritative /session list to catch ghosts (missed deletes)
	// and clobber-reverted archives. Folds in the existing archive re-assert
	// (reassertArchive) and the resurrection tombstone so Phase 2 merges rather
	// than duplicates them. Bound to Run's ctx so it stops on aggregator
	// shutdown. See TreeReconcileInterval.
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

// runStatusReconcile periodically re-derives busy-state from OpenCode's
// /session/status and reconciles it into the store. It is the self-heal path
// for a stale "busy" flag: the event stream owns busy-state in the common
// case, but if a session.idle is ever missed the in-memory flag would stick
// forever. This ticker clears anything OpenCode no longer reports busy by
// routing through store.SetActivityFromStatuses -> setActivityLocked, which is
// the single chokepoint that also keeps busyCount, subtreeBusyCount, and the
// seven O1 subtree indexes consistent. It is best-effort: a fetch error is
// logged and retried on the next tick. It never clears busyCount directly.
// Blocks until ctx is cancelled.
func (a *Aggregator) runStatusReconcile(ctx context.Context) {
	ticker := time.NewTicker(StatusReconcileInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
		statuses, err := a.client.SessionStatuses(ctx)
		if err != nil {
			// Silent on shutdown; otherwise log and try again next tick.
			if ctx.Err() != nil {
				return
			}
			log.Printf("[aggregator] status reconcile fetch failed: %v", err)
			continue
		}
		a.store.SetActivityFromStatuses(statuses)
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

// StatusReconcileInterval is how often runStatusReconcile polls OpenCode's
// /session/status to self-heal a stale "busy" flag. The event stream drives
// busy-state in the common case (session.status busy / session.idle), but if
// the aggregator ever misses a session.idle — a dropped tunnel, a reconnect
// gap, or a turn that ended without OpenCode emitting idle — busyCount[root]
// stays > 0 forever and the finished session renders as RUNNING in the SPA.
// A stale-busy root also defeats the O1 collapsed-frontier projection: it
// stays in the active closure, so its whole subtree ships full instead of
// collapsing to a frontier stub.
//
// This ticker is the authoritative safety net: it periodically re-derives
// busy-state from /session/status and clears anything OpenCode no longer
// reports busy, routing through store.SetActivityFromStatuses -> setActivityLocked
// so busyCount, subtreeBusyCount, and all seven O1 subtree indexes stay
// consistent. It is a var (not const) so tests can shrink it; it mirrors the
// deltaFlushInterval / partTextCap tuning-var precedent.
var StatusReconcileInterval = 60 * time.Second

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
