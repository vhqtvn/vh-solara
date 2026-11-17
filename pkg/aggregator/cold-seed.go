package aggregator

import (
	"context"
	"encoding/json"
	"log"
	"sync"
)

// cold-seed.go — the background lastAgent seeding for un-opened sessions.
//
// The tree snapshot carries no messages, so without this the per-agent chips on
// cold/un-opened sessions would stay empty until a session is opened.
// startColdSeed launches seedColdLastAgents OFF the hydrate hot path (hydrate
// must return promptly so the event stream and snapshots are not delayed by
// these upstream tail fetches), bound to the aggregator's LIFETIME ctx
// (a.runCtx) — NOT the hydrate ctx, which under POST /vh/reload is the request
// ctx and dies on handler return. The lifetime ctx still cancels the seed on
// aggregator shutdown, so it never outlives the aggregator.
//
// At-most-one invariant: a.seedDone (guarded by the SHARED seedMu — Option 1,
// no lock split) is non-nil while a cold-seed goroutine is in flight; a hydrate
// that finds one running skips. The goroutine clears seedDone and closes done
// in its defer, BOTH under the constraint that close(done) happens OUTSIDE
// seedMu (no blocking work under the lock). seedColdLastAgents fans out the
// per-session MessagesTail GETs 8-wide under a semaphore and a WaitGroup; each
// goroutine marks its session seeded through the incarnation-fenced memo and
// accumulates the agent together with the incarnation its GET started under,
// then the post-Wait writes go through the incarnation + loaded fenced
// SetLastAgentAtIncarnation (W8). Each cold session is seeded at most once
// for the aggregator's lifetime (memoized in the store via the fenced mark);
// a failed fetch is NOT marked seeded so it retries next reconnect. The
// single-id reseed path (below) additionally skips memoization on a
// SUCCESSFUL-but-empty tail; this batch path marks on any successful fetch.
// See the aggregator concurrency map §4 (seedDone) + §5 (seedCtx ctx tree).

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
// through the incarnation-fenced memo (store.MarkColdSeededAtIncarnation —
// only when the session still exists at the incarnation the fetch captured),
// so later reconnects skip the re-fetch entirely.
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

	// coldSeedResult carries one batch fan-out result together with the
	// session incarnation its tail GET started under, so the post-Wait write
	// can be fenced per id (W8): a session deleted (or deleted+recreated)
	// while the fan-out was in flight is skipped rather than seeded with the
	// dead incarnation's agent.
	type coldSeedResult struct {
		agent       string
		incarnation uint64
	}

	var (
		mu     sync.Mutex
		wg     sync.WaitGroup
		agents = map[string]coldSeedResult{}
		sem    = make(chan struct{}, 8) // bound concurrency; limit=10 keeps each fetch cheap
	)
	for _, id := range need {
		wg.Add(1)
		sem <- struct{}{}
		go func(id string) {
			defer wg.Done()
			defer func() { <-sem }()
			// Bind this fetch to the session incarnation that started it
			// (W8): the fenced mark + accumulated write below are dropped if
			// the session is deleted (or deleted+recreated under a new
			// incarnation) while the GET is in flight.
			incarnation := a.store.SessionIncarnation(id)
			// The tail GET's X-Next-Cursor is irrelevant here (cold-seed only
			// scans the newest assistant's agent) — discarded deliberately.
			items, _, err := a.client.MessagesTail(ctx, id, coldTailLimit)
			if err != nil {
				log.Printf("[aggregator] lastAgent tail fetch failed for %s: %v", id, err)
				return
			}
			// Mark seeded only on a successful fetch so a transient failure
			// retries next reconnect (pre-memo behavior), and only when the
			// incarnation still matches — a delete/recreate racing the fetch
			// must not consume the fresh incarnation's memo (W8; the W7
			// cell-3 hazard, batch variant). Empty tails still mark here
			// (batch semantics; the single-id reseed deliberately does not).
			if !a.store.MarkColdSeededAtIncarnation(id, incarnation) {
				return
			}
			if agent := lastAssistantAgent(items); agent != "" {
				mu.Lock()
				agents[id] = coldSeedResult{agent: agent, incarnation: incarnation}
				mu.Unlock()
			}
		}(id)
	}
	wg.Wait()
	// Incarnation + loaded fenced writes (W8, with the W6 loaded fence
	// preserved inside): each accumulated seed lands only if its session is
	// still on the incarnation that fetched it and was not loaded meanwhile
	// — a session whose history was loaded authoritatively mid-fan-out keeps
	// its recompute-derived lastAgent. Per-id event granularity is unchanged
	// (SetLastAgents already emitted one event per changed id).
	for id, res := range agents {
		a.store.SetLastAgentAtIncarnation(id, res.agent, res.incarnation)
	}
}

// startCreatedSessionReseed launches the single-id re-seed for a session that
// was just (re-)created by a live session.created event. It exists because
// startColdSeed runs ONLY from hydrate: a daemon whose event stream stays
// connected (the normal production shape, and the serial web-e2e lane shape)
// never rehydrates, so an entry deleted+recreated mid-stream — e.g. by the
// fixture reset's session.deleted/session.created dance, or in production any
// remove/recreate of the same id — used to keep lastAgent empty forever, even
// though deleteSessionLocked invalidates the seeded memo precisely so a fresh
// tail fetch can re-seed it. This completes that documented intent.
//
// Guards (mirroring seedColdLastAgents' semantics for one id):
//   - unknown or already-seeded sessions do nothing (ColdSeedNeeded), so this
//     is safe for genuinely-new sessions: an empty tail writes no lastAgent
//     and no memo, so a LATER trigger (a session.created for this id, or a
//     reconnect hydrate) can re-fetch once a turn exists;
//   - LOADED sessions are skipped — the message-recompute path owns their
//     lastAgent authoritatively;
//   - the fetch is bound to the session incarnation that started it (W8): a
//     delete/recreate of the same id while the GET is in flight fences BOTH
//     the memo and the write, so the late stale response lands nothing and
//     the fresh incarnation re-seeds from its own tail;
//   - a failed fetch is NOT marked seeded, so the next hydrate retries
//     (same grace as seedColdLastAgents). An empty tail is also left
//     unmarked — reseed-specific: the batch hydrate path still marks empty
//     tails, which would consume that retry eligibility.
//
// Lifetime binding mirrors startColdSeed: runCtx read under seedMu; the
// fallback context.Background() only fires when Run has not run yet, which
// cannot happen for the lifecycle.go trigger (it fires from Run's own
// subscription callback). No seedDone arbitration: that at-most-one gate
// exists to bound the hydrate fan-out, not single cheap goroutines.
func (a *Aggregator) startCreatedSessionReseed(id string) {
	a.seedMu.Lock()
	ctx := a.runCtx
	a.seedMu.Unlock()
	if ctx == nil {
		ctx = context.Background()
	}
	go a.reseedCreatedSessionAgent(ctx, id)
}

// reseedCreatedSessionAgent is the body of the single-id re-seed. See
// startCreatedSessionReseed for the guard rationale.
func (a *Aggregator) reseedCreatedSessionAgent(ctx context.Context, id string) {
	for _, loaded := range a.store.LoadedSessions() {
		if loaded == id {
			return // messages already reconciled authoritatively
		}
	}
	if len(a.store.ColdSeedNeeded([]string{id})) == 0 {
		return // unknown session, or memo already seeded
	}
	// Bind this fetch to the session incarnation that started it (W8): the
	// fenced mark/write below land only if the incarnation is unchanged, so a
	// delete/recreate of the same id while the GET is in flight can neither
	// write the dead incarnation's agent into the fresh one nor consume its
	// cold-seed memo (the W7 cell-3 defect: stale seed + starved re-seed).
	incarnation := a.store.SessionIncarnation(id)
	items, _, err := a.client.MessagesTail(ctx, id, coldTailLimit)
	if err != nil {
		log.Printf("[aggregator] lastAgent re-seed tail fetch failed for %s: %v", id, err)
		return // unmarked: the next hydrate retries, mirroring cold-seed grace
	}
	if agent := lastAssistantAgent(items); agent != "" {
		// Incarnation-fenced memo (W8): a declined mark means the session was
		// deleted (no-op either way) or deleted+recreated under a NEW
		// incarnation in the fetch race window — the response is stale, so
		// write nothing and leave the fresh incarnation eligible to re-seed
		// from its own tail. A session whose history was LOADED while this
		// GET was in flight is still marked here (the W6 loaded fence governs
		// the write, not the memo — pre-W8 semantics preserved).
		if !a.store.MarkColdSeededAtIncarnation(id, incarnation) {
			return
		}
		// Incarnation + loaded fenced write: dropped when the incarnation
		// moved (delete/recreate) or the session got LOADED mid-fetch, so the
		// recompute path's authoritative value survives (the W5/W6
		// late-overwrite repair, preserved).
		a.store.SetLastAgentAtIncarnation(id, agent, incarnation)
	}
	// An empty tail (no assistant turn yet) is deliberately NOT marked seeded:
	// memoizing it would pin lastAgent empty for the aggregator's lifetime even
	// after a later turn produces one, and a connected daemon never rehydrates.
	// This does NOT schedule a retry by itself — it only leaves the session
	// eligible: a later session.created trigger (remove/recreate) or hydrate
	// re-fetches. (The batch hydrate path still marks empty tails, which would
	// consume that eligibility.)
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
