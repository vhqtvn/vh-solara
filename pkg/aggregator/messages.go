package aggregator

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/opencode"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// messages.go — the lazy message-history hydration concern.
//
// Two entrypoints (EnsureMessages sync, EnsureMessagesAsync async) collapse
// concurrent cold opens of the same session to ONE upstream
// GET /session/:id/message through the SHARED msgInflight[sid] single-flight
// slot. The slot is registered by EITHER path and the winner — sync OR async —
// emits the messages.loaded / messages.error completion event so a deduped
// async caller never wedges on its loading state (the load-bearing
// sync↔async completion contract; see EnsureMessages's SINGLE-FLIGHT note and
// the GAP-1/GAP-2 characterization in messages_singleflight_test.go).
//
// Both paths gate on `armed` (read once under seedMu at entry) for the
// project-isolation backstop. The async fetch ctx is the AGGREGATOR's lifetime
// (a.runCtx, read under seedMu) — NOT a caller request ctx, which dies on
// handler return; EnsureMessagesAsync therefore takes NO caller ctx (audit
// L-12 / remediation M15), so a fetch survives handleStream's r.Context()
// cancellation to populate the store for the NEXT client.
//
// Cross-package lock nesting: the only edge is msgMu → s.mu (the Store's
// RWMutex), created by the under-lock IsMessagesLoaded re-check in BOTH
// entrypoints (the TOCTOU close). Never block under msgMu: the <-done wait
// in EnsureMessages happens after Unlock. See the aggregator concurrency map
// §3 for the full acquisition-order analysis any change here must preserve.

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

// SetPageGateHook installs a TEST-ONLY rendezvous callback fired once per
// EnsureOlderMessages call immediately after a collapsed waiter finds a
// registered pageInflight slot and releases pageMu — i.e. at the instant it has
// committed to the collapse and is about to park on <-slot.done. A test blocks
// in the callback to deterministically confirm the collapse before releasing
// the winner (mirrors SetMsgGateHook). Nil (the default) is a no-op; production
// code never sets it. Not lock-guarded — install once before any concurrent
// call.
func (a *Aggregator) SetPageGateHook(fn func(sessionID string)) { a.pageGateHook = fn }

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
		// BOUNDED DISAMBIGUATION LOOP. A fetch that leaves the session
		// not-loaded because the newest COMPLETED assistant has zero resident
		// parts is AMBIGUOUS: it may be a schema-drift cold load (the opencode
		// DB has parts the fetch did not inline — a re-fetch serves them) or
		// source truth (the DB genuinely has no parts — a re-fetch confirms
		// emptiness). The web client does not auto-retry a stuck-loaded
		// session, so without an in-open re-fetch a genuinely-empty turn
		// (ses_05ff9273dffe7N4dh1HliZhIXq) would loop "not loaded → re-fetch"
		// forever across operator restarts. When BlockedByUnconfirmedEmptyNewest
		// is set, perform exactly ONE more GET on the SAME single-flight slot
		// (the winner already holds it; the defer reclaims it on return) so the
		// server can serve the real parts (schema-drift → resident → loaded) or
		// confirm the emptiness (second reconcile observing the same empty
		// newest → confirmed → loaded). Never a third GET. The final
		// IsMessagesLoaded gate remains authoritative, so a redundant re-fetch
		// (e.g. a live update changed the newest between the two reconciles)
		// can never publish an incorrect messages.loaded.
		for attempt := 0; ; attempt++ {
			t0 := time.Now()
			// Part A/B: bound the initial cold-load to the render window
			// (state.WindowMaxCount newest). The gate (IsMessagesLoaded) keys on
			// the newest assistant (always within the tail). Older-than-resident
			// history is NOT lost: Part B's boundary-demand handler
			// (messages_http.go D trigger) pages it on demand via the backward
			// cursor + MergeOlderMessages, so the regression that sank the bare
			// bound (7648673) is recovered. The prior revert's regression guard
			// (TestSnapshotMessagesPage_FullResidentSupportsOlderHistory, now
			// extended for the boundary-demand path) stays green.
			items, err := a.client.MessagesTail(ctx, sessionID, state.WindowMaxCount)
			if err != nil {
				// Signal failure to any async caller that deduped against this
				// sync winner (shared-slot completion contract). The session
				// stays unloaded; the defer above cleared the slot so a
				// reselect retries.
				a.store.EmitMessagesError(sessionID, err.Error())
				return err
			}
			fetchMs := time.Since(t0).Milliseconds()
			tR := time.Now()
			res := a.store.SetSessionMessages(sessionID, decodeMessages(items))
			reconcileMs := time.Since(tR).Milliseconds()
			// Emit completion ONLY when a batch was published (cold) or it was
			// a genuine warm reconcile (no batch required) AND the resident-
			// parts gate IsMessagesLoaded now holds — the SAME signal the
			// snapshot's GateFacts.MessagesLoaded exposes, so the client's
			// messages.loaded (which flips its messagesDelivered=true) can
			// never disagree with the gate (b-F1). A cold fetch for a session
			// deleted between reconcile and capture, or a packaging failure,
			// publishes NO batch (SessionGone / PackagingFailed) — emitting
			// loaded then would deliver messages.loaded with no preceding
			// messages.batch (one-batch-before-loaded ordering), and emitting
			// an empty batch to satisfy ordering would reintroduce state after
			// session.delete (Finding 3).
			if (res.Status == state.ColdBatchEmitted || res.Status == state.ColdBatchWarmReconcile) && a.store.IsMessagesLoaded(sessionID) {
				a.store.EmitMessagesLoaded(sessionID, fetchMs, reconcileMs)
				return nil
			}
			// One disambiguating re-fetch when the block is specifically an
			// unconfirmed empty newest (not a gone session or a packaging
			// failure, both of which must neither retry nor emit loaded).
			if attempt == 0 &&
				(res.Status == state.ColdBatchEmitted || res.Status == state.ColdBatchWarmReconcile) &&
				res.BlockedByUnconfirmedEmptyNewest {
				continue
			}
			return nil
		}
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
// The fetch goroutine is bound to the AGGREGATOR's LIFETIME ctx (a.runCtx), not
// to any caller request ctx (audit L-12 / remediation M15): handleStream's
// r.Context() dies the moment the SSE handler returns, but the fetch must
// survive to populate the store + emit completion for the NEXT client that
// opens the session. The signature therefore takes no caller ctx — accepting
// one would falsely suggest the caller controls this operation's lifetime.
// Mirrors startColdSeed's lifetime binding; falls back to a detached
// context.Background() when Run hasn't been called yet (tests calling this
// directly).
//
// On success: SetSessionMessages (marks loaded, emits message.*/part.* deltas)
// THEN EmitMessagesLoaded (carrying fetch/reconcile split timing) —
// UNCONDITIONALLY, so a fetch that returned zero or byte-identical messages (no
// diff deltas) still signals completion and the client doesn't wedge on its
// loading state. On failure (and NOT a shutdown):
// log + EmitMessagesError, leave the session UNLOADED so a reselect / transport
// reconnect retries; on shutdown (ctx cancelled) just exit silently.
func (a *Aggregator) EnsureMessagesAsync(sessionID string) {
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
	// Derive the fetch ctx from the AGGREGATOR's lifetime (a.runCtx). The
	// caller no longer passes a ctx (audit L-12 / remediation M15): the
	// operation is bound to aggregator lifetime, NOT to the caller's request,
	// because handleStream's r.Context() dies the moment the SSE handler
	// returns, which would abort a fetch the store needs for the NEXT client.
	// Read under seedMu — a.runCtx is the seedMu-guarded lifetime ctx Run
	// captures (mirrors startColdSeed). When Run hasn't run yet (a.runCtx ==
	// nil, e.g. bare tests calling this directly), fall back to a detached
	// context.Background() so a fetch is never bound to a request that has
	// already ended.
	a.seedMu.Lock()
	fetchCtx := a.runCtx
	a.seedMu.Unlock()
	if fetchCtx == nil {
		fetchCtx = context.Background()
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
		// BOUNDED DISAMBIGUATION LOOP — see EnsureMessages for the full
		// rationale. When a fetch leaves the session not-loaded because the
		// newest COMPLETED assistant has zero resident parts
		// (BlockedByUnconfirmedEmptyNewest), perform exactly ONE more GET on
		// the same single-flight slot so the server can serve the real parts
		// (schema-drift) or confirm the emptiness (source truth). Never a third
		// GET; the final IsMessagesLoaded gate stays authoritative.
		for attempt := 0; ; attempt++ {
			t0 := time.Now()
			// Part A/B: bound the initial cold-load to the render window
			// (state.WindowMaxCount newest). See EnsureMessages for the full
			// rationale + Part B recovery.
			items, err := a.client.MessagesTail(fetchCtx, sessionID, state.WindowMaxCount)
			if err != nil {
				if fetchCtx.Err() != nil {
					// Aggregator shutting down (or caller ctx cancelled in a
					// direct test path): don't spam a completion event into a
					// torn-down store, and don't log a spurious failure. The
					// session stays unloaded; a later selection on a fresh
					// aggregator retries.
					return
				}
				// Include fetchMs in the log: a background fetch the operator
				// isn't watching still took wall-clock time before failing.
				log.Printf("[aggregator] EnsureMessagesAsync failed for %s (fetch=%dms): %v", sessionID, time.Since(t0).Milliseconds(), err)
				a.store.EmitMessagesError(sessionID, err.Error())
				return
			}
			fetchMs := time.Since(t0).Milliseconds()
			tR := time.Now()
			res := a.store.SetSessionMessages(sessionID, decodeMessages(items))
			reconcileMs := time.Since(tR).Milliseconds()
			// Emit completion ONLY when a batch was published (cold) or it was
			// a genuine warm reconcile (no batch required) AND the resident-
			// parts gate IsMessagesLoaded now holds — the SAME signal the
			// snapshot gate exposes, so the client's messages.loaded never
			// disagrees with the gate (b-F1: a fetch that left a completed
			// assistant with zero resident parts must NOT tell the client
			// "delivered"). SessionGone / PackagingFailed publish NO batch —
			// emitting loaded then would break the one-batch-before-loaded
			// ordering and reintroduce state after session.delete (Finding 3).
			if (res.Status == state.ColdBatchEmitted || res.Status == state.ColdBatchWarmReconcile) && a.store.IsMessagesLoaded(sessionID) {
				a.store.EmitMessagesLoaded(sessionID, fetchMs, reconcileMs)
				return
			}
			// One disambiguating re-fetch when the block is specifically an
			// unconfirmed empty newest (not a gone session or a packaging
			// failure, both of which must neither retry nor emit loaded).
			if attempt == 0 &&
				(res.Status == state.ColdBatchEmitted || res.Status == state.ColdBatchWarmReconcile) &&
				res.BlockedByUnconfirmedEmptyNewest {
				continue
			}
			return
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

// EnsureOlderMessages fetches ONE strictly-older message page from opencode (via
// the backward cursor) and merges it into the resident store. It is the Part B
// "past-resident older-page" path, triggered by the boundary-demand handler
// (pkg/web/messages_http.go D trigger) when a resident strictly-older walk
// exhausts at the resident floor without a count/byte limit (older history may
// exist in opencode beyond the bounded cold-load tail).
//
// Contract:
//   - (a) Single-flight: a DEDICATED pageInflight[sessionID] slot (INDEPENDENT of
//     the cold-load msgInflight) collapses concurrent same-session "Load older"
//     demands — concurrent callers wait for the winner's merge and PROPAGATE the
//     winner's result error (nil on winner success, the winner's fetch failure
//     on winner failure — P2-AGG-004). It does NOT block or dedupe against a
//     live cold-load.
//   - (b) Locking: the fetch is lock-free; Store.MergeOlderMessages takes s.mu
//     internally. No network I/O under any store lock.
//   - The fetch ctx is bound to the AGGREGATOR's lifetime (a.runCtx), NOT the
//     caller's request — so the merge lands for the NEXT client even if the
//     triggering HTTP request disconnects (mirrors EnsureMessagesAsync's L-12
//     rationale). On a nil runCtx (bare tests) it falls back to Background.
//
// anchorID/anchorTimeMs identify the OLDEST resident message (the cursor anchor);
// the cursor token is built via opencode.EncodeMessageCursor (the full (id,
// time_created) tuple; a raw id alone 400s). Returns nil on success. A collapsed
// waiter (a concurrent caller that found an in-flight demand) PROPAGATES the
// winner's result error instead of returning nil unconditionally (P2-AGG-004),
// so the boundary-demand caller (pkg/web/messages_http.go) does not treat a
// failed older-page fetch as success.
func (a *Aggregator) EnsureOlderMessages(sessionID, anchorID string, anchorTimeMs float64) error {
	a.pageMu.Lock()
	if slot, ok := a.pageInflight[sessionID]; ok {
		// Collapse: a concurrent older-page fetch is in flight. Wait for it to
		// complete (broadcast-wake via close(slot.done)), then PROPAGATE its
		// result error — nil on winner success, the winner's MessagesBefore
		// failure on winner failure — instead of returning nil unconditionally.
		// Before P2-AGG-004 this branch did `<-done; return nil`, so a winner
		// whose upstream GET ?before=<cursor> failed still woke its collapsed
		// waiter to a success-shaped nil; the HTTP boundary-demand handler
		// (pkg/web/messages_http.go) then re-projected as if the older page had
		// merged. slot.err is published by the winner BEFORE close(slot.done),
		// so reading it after <-slot.done is happens-before-correct.
		a.pageMu.Unlock()
		// pageGateHook (test-only, nil in production): rendezvous right after the
		// waiter committed to the collapse (released pageMu, about to park on
		// <-slot.done) so a test can deterministically confirm the collapse
		// before releasing the winner. Mirrors SetMsgGateHook.
		if a.pageGateHook != nil {
			a.pageGateHook(sessionID)
		}
		<-slot.done
		return slot.err
	}
	slot := &olderPageInflight{done: make(chan struct{})}
	a.pageInflight[sessionID] = slot
	a.pageMu.Unlock()
	defer func() {
		a.pageMu.Lock()
		if a.pageInflight[sessionID] == slot {
			delete(a.pageInflight, sessionID)
		}
		a.pageMu.Unlock()
		close(slot.done)
	}()

	// Bound the page to the cold-load window size (one older page == one tail).
	a.seedMu.Lock()
	fetchCtx := a.runCtx
	a.seedMu.Unlock()
	if fetchCtx == nil {
		fetchCtx = context.Background()
	}
	cursor := opencode.EncodeMessageCursor(anchorID, anchorTimeMs)
	items, nextCursor, err := a.client.MessagesBefore(fetchCtx, sessionID, cursor, state.WindowMaxCount)
	if err != nil {
		// Publish the failure to any collapsed waiter BEFORE the defer closes
		// slot.done (the defer runs on this return). The close wakes the waiter;
		// it reads slot.err and propagates the SAME failure instead of nil
		// (P2-AGG-004).
		slot.err = err
		return err
	}
	a.store.MergeOlderMessages(sessionID, decodeMessages(items), nextCursor == "")
	return nil
}
