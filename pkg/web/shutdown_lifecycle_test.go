package web

import (
	"context"
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
