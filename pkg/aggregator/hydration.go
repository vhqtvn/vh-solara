package aggregator

import (
	"context"
	"log"
	"sync"

	"github.com/vhqtvn/vh-solara/pkg/state"
)

// hydration.go — the full-state re-fetch from OpenCode and store reconciliation.
//
// hydrate is the integration seam: called from Run's reconnect loop (on every
// (re)connect, since the event stream has no replay) AND from Rehydrate
// (POST /vh/reload). It fetches the flat session list + loaded sessions'
// messages, reconciles them into the store via id-level diff, kicks off the
// background cold-seed (cold-seed.go), fans out the three enrichment GETs
// (statuses / questions / permissions) concurrently under a WaitGroup, then —
// only on full success — records anyHydrateCompleted and fires the onHydrate callback.
//
// seedMu is SHARED with lifecycle.go / cold-seed.go (Option 1: one lock, no
// split). The two seedMu acquisitions here are both brief and non-blocking:
//   - the onHydrate read at the success tail snapshots the callback under the
//     lock and invokes it OUTSIDE the lock (production callbacks dispatch to a
//     fresh goroutine, so they never block hydrate's goroutine or risk a
//     lock-order inversion against store/registry mutexes);
//   - startColdSeed's own seedMu acquisition (in cold-seed.go) manages the
//     at-most-one seedDone slot and derives seedCtx from runCtx, all without
//     blocking.
// No I/O, channel wait, or callback invocation happens under seedMu. See the
// aggregator concurrency map §3 + §5 for the cancellation/ctx tree any change
// here must preserve (notably: seedCtx binds to a.runCtx, NOT the hydrate ctx,
// because under POST /vh/reload the hydrate ctx dies on handler return).

// Rehydrate re-fetches the full state from OpenCode and reconciles the store.
// Safe to call at any time: Hydrate diffs by id and emits only the changes, so
// connected clients converge without a full resync. This is the "reload server
// state" primitive — it rebuilds the view from the source of truth (OpenCode)
// without restarting the process or touching the running OpenCode.
func (a *Aggregator) Rehydrate(ctx context.Context) error { return a.hydrate(ctx) }

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
	// session set. Record stickiness (AnyHydrateCompleted) and fire the onHydrate
	// callback (FIX-QUEUE-GC-3 orphan-queue reconciliation) so the web layer can
	// delete on-disk queue.json files whose session IDs are NOT in this set.
	// The callback is read under seedMu and invoked OUTSIDE the lock; production
	// callbacks dispatch to a fresh goroutine so they never block hydrate's
	// goroutine or risk a lock-order inversion against store/registry mutexes.
	// This fire-site is reached ONLY on hydrate success — every error path above
	// returns early before this point, so a failed/partial hydrate leaves
	// anyHydrateCompleted=false and fires nothing (fail-closed for reconciliation).
	a.anyHydrateCompleted.Store(true)
	a.seedMu.Lock()
	cb := a.onHydrate
	a.seedMu.Unlock()
	if cb != nil {
		cb()
	}
	return nil
}
