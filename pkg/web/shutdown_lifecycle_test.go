package web

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/state"
)

// TestShutdownRetiresServerOwnedPerDirLifetimes proves Server.Shutdown owns and
// retires the server-created per-directory resources it previously leaked: the
// permission watcher (whose ctx is rooted in context.Background(), unreachable
// by bgCancel) and the queue/pin store subscribers (range loops that exit only
// when Store.Close closes their channel). It is the closeout test for the
// per-dir lifecycle-leak fix (defer-web-shutdown-per-dir-lifecycle-leak).
//
// The proof is OUTCOME-level, not mechanism-level, mirroring the
// TestArchiveReassert_ShutdownOwnsOutstandingWork seam pattern:
//
//   - A sentinel subscriber on the non default dir's store closes ONLY when the
//     store is closed (Store.Close from Aggregator.Stop inside Shutdown's
//     stopServerOwnedAggregators). Observing it close proves the subscribers were
//     retired by an explicit teardown, NOT by ctx cancellation.
//
//   - The dir's permission watcher is held at a pure (ctx-independent) channel
//     block (reconcileBlockCh) that watcher-ctx cancellation CANNOT reach. If
//     Shutdown returns while the watcher is still blocked, it did NOT await
//     lifecycleWG.
//
//   - Releasing the block lets the watcher exit (its ctx is already cancelled),
//     draining lifecycleWG; Shutdown then returns nil. The dir's aggregator is
//     gone from s.aggs, so it cannot be reused.
//
// newReloadServer starts the DEFAULT aggregator's plain Run loop but never calls
// aggFor(""), so the default dir's watcher/subscribers are NOT armed — only the
// non default dir opened below contributes to lifecycleWG.
func TestShutdownRetiresServerOwnedPerDirLifetimes(t *testing.T) {
	srv, _, _, _ := newReloadServer(t)

	// Hold the dir's permission watcher at a pure channel block (unreachable by
	// the watcher-ctx cancellation Shutdown will issue).
	ready := make(chan struct{}, 1)
	block := make(chan struct{})
	srv.reconcileReadyCh = ready
	srv.reconcileBlockCh = block

	// Open ONE non default dir: arms its watcher + queue/pin subscribers (all
	// tracked on lifecycleWG for dir != "") and starts RunManaged.
	dir := t.TempDir()
	a := srv.aggFor(dir)

	// Wait until the watcher has run its immediate sweep and reached its block.
	select {
	case <-ready:
	case <-time.After(3 * time.Second):
		t.Fatal("permission watcher never reached its post-sweep block point")
	}

	// Sentinel subscriber on the dir's store: its range loop exits ONLY when the
	// store closes (Store.Close closes every subscriber channel). This is the
	// direct outcome signal that Shutdown retired the subscriber-backed workers.
	sentinelCh, _ := a.Store().SubscribeWith(8, state.Interest{MessageSessions: map[string]bool{}})
	sentinelDone := make(chan struct{})
	go func() {
		for range sentinelCh {
		}
		close(sentinelDone)
	}()

	// Shutdown issues bgCancel, cancels every watcher, stops every non default
	// aggregator (closing its store), then awaits bgWG + lifecycleWG.
	shutdownDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		shutdownDone <- srv.Shutdown(ctx)
	}()

	// (1) The sentinel range loop MUST close: store.Close ran inside Shutdown's
	//     stopServerOwnedAggregators, retiring the subscriber-backed workers. This
	//     is independent of the watcher (still blocked). Poll generously —
	//     Shutdown runs stopServerOwnedAggregators early, before the await.
	select {
	case <-sentinelDone:
	case <-time.After(2 * time.Second):
		t.Fatal("sentinel subscriber never closed: Shutdown did not stop the dir aggregator / close its store (subscriber leak)")
	}

	// (2) Shutdown MUST still be pending: the watcher is held at a pure channel
	//     block that its ctx cancellation cannot reach, so lifecycleWG has not
	//     drained. If Shutdown returned here, it did NOT await the watcher.
	deadline := time.Now().Add(150 * time.Millisecond)
	for time.Now().Before(deadline) {
		select {
		case err := <-shutdownDone:
			t.Fatalf("Shutdown returned while the watcher was still blocked: %v "+
				"(Server must await lifecycleWG, not just cancel)", err)
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}

	// (3) Release the watcher: the pure block completes → the watcher proceeds
	//     to its select, sees its (already-cancelled) ctx done, returns →
	//     lifecycleWG.Done → Shutdown's await returns.
	close(block)
	select {
	case err := <-shutdownDone:
		if err != nil {
			t.Fatalf("Shutdown returned error after watcher release: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Shutdown never returned after the watcher was released (lifecycleWG not awaited)")
	}

	// (4) The dir's aggregator is gone from s.aggs — it cannot be reused after
	//     Shutdown (stopServerOwnedAggregators deleted it under aggMu).
	srv.aggMu.Lock()
	_, stillOpen := srv.aggs[dir]
	srv.aggMu.Unlock()
	if stillOpen {
		t.Fatal("non default aggregator still present in s.aggs after Shutdown " +
			"(must be retired + removed, not reusable)")
	}
}

// TestShutdownAbortsInFlightRejectRPC is the liveness sibling of
// TestShutdownRetiresServerOwnedPerDirLifetimes. That test holds the watcher at
// the PRE-RPC pure-channel block (reconcileBlockCh) which watcher-ctx
// cancellation cannot reach, proving Shutdown AWaits lifecycleWG. It does NOT
// exercise the in-flight RPC-abort path. THIS test does: a fail_fast session's
// auto-reject RPC is held GENUINELY in-flight inside reconcileFailFastPerms
// (blocked on the upstream), and Server.Shutdown's watcher-ctx cancellation
// must propagate into the RPC's derived timeout ctx
// (context.WithTimeout(ctx, permRejectTimeout) at server.go reconcileFailFastPerms)
// and ABORT the stalled RPC, so Shutdown returns WELL BEFORE the 10s
// permRejectTimeout — instead of blocking the full 10s on a stallable upstream.
//
// The watcher ctx is the PARENT of the reject RPC's rpcCtx; without the
// threading, cancelling the watcher would leave the in-flight ReplyPermission
// to run out its full 10s WithTimeout, and Shutdown (which awaits lifecycleWG,
// which the watcher is tracked on) would stall for that whole window.
//
// Harness: newVerbServerSrv (fakeOC) + ensurePermissionWatcher("", agg). The
// watcher is armed exactly as production arms it (aggFor →
// ensurePermissionWatcher), but the aggregator's Run/hydrate loop is NOT
// started — so the seeded pending permission is stable (a running hydrate would
// SetPendingPermissions from the empty fake and clobber the seed). The reject
// RPC fires from the WATCHER goroutine (whose ctx is the one Shutdown will
// cancel), not from a direct reconcileFailFastPerms call with
// context.Background(), which would not be connected to any watcher ctx and
// could not be aborted by Shutdown. That distinction is the whole point.
//
// The proof is OUTCOME-level: it asserts the elapsed wall time of Shutdown is
// unambiguously under permRejectTimeout, not merely that a context was plumbed.
func TestShutdownAbortsInFlightRejectRPC(t *testing.T) {
	f := &fakeOC{}
	_, agg, srv := newVerbServerSrv(t, f)

	// Hold the auto-reject RPC genuinely in-flight via the fake's /permission/
	// handler rendezvous: permEntered signals the handler was entered (RPC is
	// in-flight), permHold blocks it until released, permDone signals return so
	// the test can confirm a clean unwind (no leaked server-side goroutine).
	permHold := make(chan struct{})
	permEntered := make(chan struct{}, 1)
	permDone := make(chan struct{}, 1)
	f.permHold = permHold
	f.permEntered = permEntered
	f.permDone = permDone
	// Guarantee the server-side handler goroutine is never leaked past the test,
	// even on a failure path (t.Fatalf) that aborts before the explicit release
	// below. sync.Once makes a mid-test release + the cleanup both safe.
	var releaseOnce sync.Once
	releasePerm := func() {
		releaseOnce.Do(func() { close(permHold) })
	}
	t.Cleanup(releasePerm)

	// Seed FIRST, then arm: the watcher's immediate sweep (fired on arming) must
	// find the pending permission already in the store, so the reject RPC is
	// deterministic instead of waiting up to permReconcileInterval for the first
	// ticker tick. Register the fail_fast binding + seed the session + its
	// pending permission on the default store.
	store := agg.Store()
	srv.registerFailFast("ff_sess")
	store.Apply(ev("session.updated", `{"info":{"id":"ff_sess","title":"t"}}`))
	store.Apply(ev("permission.asked", `{"id":"p1","sessionID":"ff_sess","permission":"bash"}`))

	// Arm the DEFAULT dir's permission watcher (tracked on lifecycleWG) — the
	// same arming aggFor("") does in production. Its immediate sweep rejects the
	// seeded fail_fast permission, firing the in-flight reject RPC. The watcher
	// then ticks every permReconcileInterval.
	srv.ensurePermissionWatcher("", agg)

	// Rendezvous: wait until the auto-reject RPC is genuinely in-flight — the
	// fake's /permission/ handler was entered and is now blocked on permHold.
	// This proves the RPC is in-flight BEFORE Shutdown is called (the sweep may
	// be the immediate one or the next ticker tick, hence the generous bound).
	select {
	case <-permEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("auto-reject RPC never entered the fake's /permission/ handler " +
			"(watcher sweep did not fire / did not find the pending fail_fast perm)")
	}

	// Shutdown issues stopAllPermissionWatchers, cancelling every watcher ctx.
	// The watcher ctx is the PARENT of the RPC's rpcCtx
	// (WithTimeout(ctx, permRejectTimeout)), so cancelling it must abort the
	// in-flight ReplyPermission short of the 10s permRejectTimeout. Assert the
	// OUTCOME: Shutdown returns nil and its elapsed wall time is well under
	// permRejectTimeout. The Shutdown ctx itself (5s) is just a safety bound so
	// a regression (RPC not aborted → lifecycleWG never drains) fails fast
	// instead of hanging the suite.
	const abortBudget = 4 * time.Second // unambiguously < permRejectTimeout (10s)
	start := time.Now()
	shutdownDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		shutdownDone <- srv.Shutdown(ctx)
	}()
	select {
	case err := <-shutdownDone:
		if err != nil {
			t.Fatalf("Shutdown returned %v — the in-flight reject RPC was NOT aborted "+
				"by watcher-ctx cancellation (lifecycleWG did not drain within the ctx, "+
				"i.e. the watcher stayed blocked on the stallable upstream for the full "+
				"permRejectTimeout window)", err)
		}
		elapsed := time.Since(start)
		// CRUX (outcome): Shutdown returned WELL BEFORE the 10s permRejectTimeout.
		if elapsed >= abortBudget {
			t.Fatalf("Shutdown took %s (>= %s budget); the in-flight reject RPC was "+
				"not aborted promptly by watcher-ctx cancellation (would have stalled "+
				"toward the %s permRejectTimeout)", elapsed, abortBudget, permRejectTimeout)
		}
		t.Logf("Shutdown returned in %s with an in-flight reject RPC (well under "+
			"%s permRejectTimeout) — watcher-ctx cancellation aborted the RPC", elapsed, permRejectTimeout)
	case <-time.After(permRejectTimeout):
		t.Fatalf("Shutdown did not return within %s (permRejectTimeout) — the in-flight "+
			"reject RPC was not aborted by watcher-ctx cancellation", permRejectTimeout)
	}

	// Release the fake's block: the server-side /permission/ handler goroutine
	// (still blocked after the client aborted the round-trip) unblocks, writes
	// to the now-broken connection, and exits. Confirm it actually returns so no
	// goroutine leaks past the test.
	releasePerm()
	select {
	case <-permDone:
	case <-time.After(3 * time.Second):
		t.Fatal("the fake's /permission/ handler never returned after permHold was " +
			"released (server-side goroutine leak)")
	}
}
