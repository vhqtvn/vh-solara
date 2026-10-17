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
// per-session MessagesTail GETs 8-wide under a semaphore and a WaitGroup, then
// SetLastAgents the accumulated map. Each cold session is seeded at most once
// for the aggregator's lifetime (memoized in the store via MarkColdSeeded); a
// failed fetch is NOT marked seeded so it retries next reconnect. See the
// aggregator concurrency map §4 (seedDone) + §5 (seedCtx ctx tree).

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
			// The tail GET's X-Next-Cursor is irrelevant here (cold-seed only
			// scans the newest assistant's agent) — discarded deliberately.
			items, _, err := a.client.MessagesTail(ctx, id, coldTailLimit)
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
//     is idempotent and safe for genuinely-new sessions (their tail is empty
//     → no agent → no SetLastAgents — identical to today's post-hydrate state);
//   - LOADED sessions are skipped — the message-recompute path owns their
//     lastAgent authoritatively;
//   - a failed fetch is NOT marked seeded, so the next hydrate retries
//     (same grace as seedColdLastAgents).
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
	items, _, err := a.client.MessagesTail(ctx, id, coldTailLimit)
	if err != nil {
		log.Printf("[aggregator] lastAgent re-seed tail fetch failed for %s: %v", id, err)
		return // unmarked: the next hydrate retries, mirroring cold-seed grace
	}
	// No-op if the session was deleted again in the fetch race window — the
	// memo stays correct across remove/recreate, same as seedColdLastAgents.
	a.store.MarkColdSeeded(id)
	if agent := lastAssistantAgent(items); agent != "" {
		a.store.SetLastAgents(map[string]string{id: agent})
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
