// Package aggregator maintains a persistent connection to a local OpenCode
// server, feeding its events into a state.Store so clients can resume from the
// daemon instead of re-deriving everything themselves.
package aggregator

import (
	"context"
	"encoding/json"
	"log"
	"sync"
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

	// seedMu guards seedDone (and runCtx). seedDone is non-nil (and open) while
	// a background cold-seed goroutine is in flight, nil when none is running.
	// The cold-seed runs OFF the hydrate hot path (it no longer blocks
	// reconnect/snapshot), so at most one is allowed at a time: a hydrate that
	// finds one in flight skips starting another — the running seed already
	// covers un-seeded sessions, and the next hydrate's seed picks up anything
	// that became un-seeded meanwhile (e.g. a just-added session). Self-healing,
	// no leak: the goroutine exits when its fetches finish or its ctx is
	// cancelled.
	seedMu   sync.Mutex
	seedDone chan struct{}

	// msgMu guards msgInflight. msgInflight[sid] is non-nil (open) while an
	// EnsureMessagesAsync fetch is in flight for that session; absent means none.
	// This collapses concurrent opens of the same session (rapid switching, a
	// reopen before the first completed, or several Stream-2 consumers) to ONE
	// upstream GET /session/:id/message — the losers are already subscribed and
	// simply receive the eventual messages.loaded / messages.error event. An
	// entry is cleared on completion (success OR failure) so a later selection
	// retries after a failure (the session is not left loaded on error).
	msgMu       sync.Mutex
	msgInflight map[string]chan struct{}
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

// EnsureMessages lazily loads a session's message history on first open. It is
// a no-op once the session is loaded; subsequent live events keep it current.
func (a *Aggregator) EnsureMessages(ctx context.Context, sessionID string) error {
	if sessionID == "" || a.store.IsMessagesLoaded(sessionID) {
		return nil
	}
	items, err := a.client.Messages(ctx, sessionID)
	if err != nil {
		return err
	}
	a.store.SetSessionMessages(sessionID, decodeMessages(items))
	return nil
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
	if sessionID == "" || a.store.IsMessagesLoaded(sessionID) {
		return
	}
	a.msgMu.Lock()
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
		a.store.SetSessionMessages(sessionID, decodeMessages(items))
		reconcileMs := time.Since(tR).Milliseconds()
		// ALWAYS emit completion — even when the fetch returned zero or unchanged
		// messages (SetSessionMessages emitted no message.* delta in those
		// cases). Without this a client would wedge on the loading state forever
		// waiting for a delta that never arrives.
		a.store.EmitMessagesLoaded(sessionID, fetchMs, reconcileMs)
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
	// seedMu, before the first hydrate so startColdSeed observes it.
	a.seedMu.Lock()
	a.runCtx = ctx
	a.seedMu.Unlock()

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
