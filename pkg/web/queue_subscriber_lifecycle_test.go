package web

// Shared-subscriber LIFECYCLE tests for the queue subscriber family installed
// from aggFor: the delivery watcher (queue_delivery_watch.go) and its
// session-error signal sibling (queue_recovery_classify.go). The per-event
// MATCHING contracts are pinned by their own test files
// (queue_delivery_watch_test.go / queue_recovery_classify_test.go) against a
// DIRECT installer call; this file proves the LIFECYCLE surface those tests
// deliberately leave open (brief O4):
//
//   - real aggFor callers install both siblings for the DEFAULT project and
//     every lazily-created per-dir aggregator;
//   - each sibling's FUNCTIONAL effect through the real event path (delivery
//     → sent with the watcher detail; session.error → detail-only stamp);
//   - per-project isolation: an event on one project's store never resolves
//     another project's item;
//   - a REAL HTTP reload-project of a nondefault dir retires the old store's
//     subscribers, resets the install guard, and the next aggFor REINSTALLS a
//     fresh watcher on the replacement aggregator (functional proof, not a
//     guard-read alone);
//   - the DEFAULT project's installation survives a nondefault reload
//     (process-owned) and Shutdown retires nondefault installations while
//     preserving the default guard.
//
// No production code is extracted or changed here — this is a test-only
// package exercising the production install sites. Per the brief: no
// exact subscriber-count claims are made from the idempotent guard (the
// functional effects are the evidence).

import (
	"context"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// newSubscriberServer builds the reload harness with the DEFAULT project
// rooted at a throwaway dir: aggFor("") resolves projectRoot("") to the
// process cwd, and without the chdir the default-project seeds below would
// write .vh-solara into the package directory. newReloadServer creates the
// Server first and projectRoot("") is evaluated per call, so chdiring after
// construction (but before any aggFor("")) is sufficient.
func newSubscriberServer(t *testing.T) (*Server, *fakeOpenCode, *httptest.Server, *httptest.Server) {
	t.Helper()
	srv, fake, ocSrv, web := newReloadServer(t)
	t.Chdir(t.TempDir())
	return srv, fake, ocSrv, web
}

// seedLifecycleStore installs a queue for sessionID under root holding
// custody-era dispatching items, one per spec entry:
//
//	msgID -> staleFor (0 = fresh in-flight; >0 stamps DispatchStartedAt in the
//	         past so the item is delivery-uncertain for the session-error
//	         sibling's filter)
func seedLifecycleStore(t *testing.T, srv *Server, root, sessionID string, items map[string]time.Duration) *sessionQueueStore {
	t.Helper()
	s := srv.queues.store(root, sessionID)
	s.mu.Lock()
	s.load()
	now := time.Now().UnixMilli()
	order := uint64(0)
	ids := make([]string, 0, len(items))
	for id := range items {
		ids = append(ids, id)
	}
	// Deterministic order for stable seeding.
	for i := range ids {
		for j := i + 1; j < len(ids); j++ {
			if ids[j] < ids[i] {
				ids[i], ids[j] = ids[j], ids[i]
			}
		}
	}
	seeded := make([]QueueItem, 0, len(items))
	for _, id := range ids {
		staleFor := items[id]
		startedAt := now
		if staleFor > 0 {
			startedAt = now - staleFor.Milliseconds()
		}
		order++
		seeded = append(seeded, QueueItem{
			ID: id, Order: order, State: QueueDispatching,
			OpencodeMsgID: "msg_" + id, ClaimGeneration: 1, DispatchStartedAt: startedAt,
		})
	}
	s.items = seeded
	s.order = order
	s.save()
	s.loaded = true
	s.mu.Unlock()
	return s
}

// deliverWireEvent feeds the exact user-message persistence event through a
// real aggregator's store (the pipeline path the watcher subscribes to).
func deliverWireEvent(a *aggregator.Aggregator, msgID, sessionID string) {
	a.Store().Apply(ev("message.updated", `{"info":{"id":"`+msgID+`","sessionID":"`+sessionID+`","role":"user"}}`))
}

// seedFakeSessions installs the authoritative backend session list under the
// fake's mutex (the /session handler reads it under the same lock; the
// default aggregator is already tailing when tests run, so an unsynchronized
// assignment could race a reconnect hydrate).
func seedFakeSessions(fake *fakeOpenCode, ids ...string) {
	raw := make([]string, 0, len(ids))
	for _, id := range ids {
		raw = append(raw, `{"id":"`+id+`"}`)
	}
	fake.mu.Lock()
	fake.sessions = raw
	fake.mu.Unlock()
}

// TestQueueSubscriberLifecycle_AggForInstallsSiblings — REAL aggFor callers:
// default + nondefault installations are functionally live (delivery → sent
// with the watcher detail on BOTH), the session-error sibling stamps
// detail-only, and events are isolated per project root.
func TestQueueSubscriberLifecycle_AggForInstallsSiblings(t *testing.T) {
	srv, fake, _, _ := newSubscriberServer(t)
	// Seed the sessions AUTHORITATIVELY in the fake backend (labels-reload
	// pattern): aggFor's hydrate → orphan-queue reconcile deletes on-disk
	// queues whose session the backend never sourced, so the per-dir seeds
	// below must belong to a live backend session to survive the hydrate.
	seedFakeSessions(fake, "ses1")

	defaultAgg := srv.aggFor("") // the production default-project install site
	dirA := t.TempDir()
	aA := srv.aggFor(dirA) // the production nondefault install site

	// Mechanism sanity (single read; no count claims — the functional arms
	// below are the evidence).
	srv.queueDeliverMu.Lock()
	defOn, aOn := srv.queueDeliverOn[""], srv.queueDeliverOn[dirA]
	srv.queueDeliverMu.Unlock()
	if !defOn || !aOn {
		t.Fatalf("install guards: default=%v dirA=%v, want both true", defOn, aOn)
	}

	rootDefault, err := projectRoot("")
	if err != nil {
		t.Fatal(err)
	}

	// DEFAULT project: one fresh in-flight item + one spare for isolation.
	sd := seedLifecycleStore(t, srv, rootDefault, "ses1", map[string]time.Duration{
		"d1": 0,
		"d2": 0,
	})
	// dirA: one fresh in-flight item (delivery arm) + one STALE dispatching
	// item (delivery-uncertain — the session-error sibling's filter).
	sa := seedLifecycleStore(t, srv, dirA, "ses1", map[string]time.Duration{
		"a_del": 0,
		"a_err": 60 * time.Second,
	})

	// --- Delivery sibling, DEFAULT project (functional) -------------------
	deliverWireEvent(defaultAgg, "msg_d1", "ses1")
	waitFor(t, func() bool {
		it := itemByIDRaw(t, sd, "d1")
		return it.State == QueueSent && it.Detail == deliveredSentDetail
	}, "default-project user event resolves the custody item to sent")

	// --- Isolation: dirA's store event must not touch the default root ----
	deliverWireEvent(aA, "msg_d2", "ses1")
	time.Sleep(200 * time.Millisecond)
	if it := itemByIDRaw(t, sd, "d2"); it.State != QueueDispatching {
		t.Fatalf("dirA event leaked into the default project's item: %+v", it)
	}

	// --- Session-error sibling, dirA (functional, detail-only) ------------
	aA.Store().Apply(ev("session.error", `{"sessionID":"ses1","error":{"name":"Unknown","message":"upstream exploded"}}`))
	waitFor(t, func() bool {
		it := itemByIDRaw(t, sa, "a_err")
		return it.SessionError == "Unknown: upstream exploded" && it.SessionErrorAt != 0
	}, "session.error stamps the delivery-uncertain item's SessionError")
	if it := itemByIDRaw(t, sa, "a_err"); it.State != QueueDispatching {
		t.Fatalf("session-error signal changed item state (detail-only contract): %+v", it)
	}
	// The FRESH in-flight sibling was not stamped (only uncertain items).
	if it := itemByIDRaw(t, sa, "a_del"); it.SessionError != "" {
		t.Fatalf("in-flight item received the session-error signal: %+v", it)
	}

	// --- Delivery sibling, NONDEFAULT project (functional) ----------------
	deliverWireEvent(aA, "msg_a_del", "ses1")
	waitFor(t, func() bool {
		it := itemByIDRaw(t, sa, "a_del")
		return it.State == QueueSent && it.Detail == deliveredSentDetail
	}, "dirA user event resolves the dirA custody item to sent")
}

// TestQueueSubscriberLifecycle_ReloadReinstallsWatcher — a REAL HTTP
// reload-project of a nondefault dir: the old aggregator's store retirement
// (sentinel subscriber closes), the install-guard reset, the DEFAULT
// project's installation preserved, and the NEXT aggFor rebuilds a fresh
// aggregator whose watcher is FUNCTIONALLY reinstalled (a user event on the
// replacement store resolves a freshly seeded item).
func TestQueueSubscriberLifecycle_ReloadReinstallsWatcher(t *testing.T) {
	srv, fake, _, web := newSubscriberServer(t)
	// Authoritative sessions (orphan-queue reconcile spares only backend-
	// sourced sessions; sesB pre-reload, sesB2 on the replacement, sesD for
	// the default-project arm).
	seedFakeSessions(fake, "sesB", "sesB2", "sesD")

	srv.aggFor("") // default: process-owned, must survive the dirB reload
	dirB := t.TempDir()
	aB1 := srv.aggFor(dirB)

	// Pre-reload functional proof on aB1.
	sb1 := seedLifecycleStore(t, srv, dirB, "sesB", map[string]time.Duration{"b1": 0})
	deliverWireEvent(aB1, "msg_b1", "sesB")
	waitFor(t, func() bool {
		it := itemByIDRaw(t, sb1, "b1")
		return it.State == QueueSent && it.Detail == deliveredSentDetail
	}, "pre-reload watcher resolves b1")

	// Old-store retirement sentinel: closes ONLY when aB1's store closes
	// (Aggregator.Stop inside handleReloadProject → Store.Close).
	sentinelCh, _ := aB1.Store().SubscribeWith(8, state.Interest{MessageSessions: map[string]bool{}})
	sentinelDone := make(chan struct{})
	go func() {
		for range sentinelCh {
		}
		close(sentinelDone)
	}()

	// REAL HTTP reload of dirB.
	rr := doReloadProject(t, web.URL, dirB)
	if sc := rr.StatusCode; sc != 200 {
		t.Fatalf("reload-project: want 200, got %d", sc)
	}
	rr.Body.Close()

	// Guard reset: the next aggFor must not skip the reinstall.
	srv.queueDeliverMu.Lock()
	guardB, guardDef := srv.queueDeliverOn[dirB], srv.queueDeliverOn[""]
	srv.queueDeliverMu.Unlock()
	if guardB {
		t.Fatal("queueDeliverOn[dirB] still set after reload — reinstall would be skipped")
	}
	if !guardDef {
		t.Fatal("default-project install guard cleared by a NONDEFAULT reload — default is process-owned")
	}

	// Old store retired: the reload's a.Stop() closed the store, closing the
	// sentinel's channel (the watcher's own range loop retired the same way).
	select {
	case <-sentinelDone:
	case <-time.After(2 * time.Second):
		t.Fatal("old-store sentinel never closed — reload did not retire aB1's store subscribers")
	}

	// Fresh aggregator; the guard reset lets aggFor REINSTALL.
	aB2 := srv.aggFor(dirB)
	if aB2 == aB1 {
		t.Fatal("aggFor(dirB) returned the SAME aggregator after reload — not rebuilt")
	}

	// THE REINSTALL PROOF (functional, not a guard read): a user event on the
	// REPLACEMENT store resolves a freshly seeded dirB item.
	sb2 := seedLifecycleStore(t, srv, dirB, "sesB2", map[string]time.Duration{"b2": 0})
	deliverWireEvent(aB2, "msg_b2", "sesB2")
	waitFor(t, func() bool {
		it := itemByIDRaw(t, sb2, "b2")
		return it.State == QueueSent && it.Detail == deliveredSentDetail
	}, "post-reload watcher reinstalled on aB2 (resolves b2)")

	// Default installation still functionally live after the reload.
	rootDefault, err := projectRoot("")
	if err != nil {
		t.Fatal(err)
	}
	sd := seedLifecycleStore(t, srv, rootDefault, "sesD", map[string]time.Duration{"dd": 0})
	deliverWireEvent(srv.aggFor(""), "msg_dd", "sesD")
	waitFor(t, func() bool {
		it := itemByIDRaw(t, sd, "dd")
		return it.State == QueueSent && it.Detail == deliveredSentDetail
	}, "default-project watcher still live after nondefault reload")
}

// TestQueueSubscriberLifecycle_ShutdownRetiresAndPreservesDefault — Shutdown
// retires the server-owned nondefault installation (store closed → subscriber
// loops joined via lifecycleWG before Shutdown returns) and PRESERVES the
// default project's guard (the default aggregator is daemon-owned,
// process-lifetime; stopServerOwnedAggregators skips it).
func TestQueueSubscriberLifecycle_ShutdownRetiresAndPreservesDefault(t *testing.T) {
	srv, _, _, _ := newSubscriberServer(t)

	srv.aggFor("")
	dir := t.TempDir()
	a := srv.aggFor(dir)

	// Retirement sentinel on the dir's store — same shape as
	// TestShutdownRetiresServerOwnedPerDirLifetimes.
	sentinelCh, _ := a.Store().SubscribeWith(8, state.Interest{MessageSessions: map[string]bool{}})
	sentinelDone := make(chan struct{})
	go func() {
		for range sentinelCh {
		}
		close(sentinelDone)
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}

	// The nondefault store was closed (subscriber retired + joined).
	select {
	case <-sentinelDone:
	case <-time.After(2 * time.Second):
		t.Fatal("sentinel never closed — Shutdown did not retire the nondefault aggregator's store")
	}
	// The dir is gone from s.aggs (cannot be reused post-Shutdown).
	srv.aggMu.Lock()
	_, stillOpen := srv.aggs[dir]
	srv.aggMu.Unlock()
	if stillOpen {
		t.Fatal("nondefault aggregator still registered after Shutdown")
	}
	// The nondefault guard was cleared; the DEFAULT guard preserved.
	srv.queueDeliverMu.Lock()
	guardDir, guardDef := srv.queueDeliverOn[dir], srv.queueDeliverOn[""]
	srv.queueDeliverMu.Unlock()
	if guardDir {
		t.Fatal("queueDeliverOn[dir] still set after Shutdown")
	}
	if !guardDef {
		t.Fatal("queueDeliverOn[\"\"] cleared by Shutdown — default installation is process-owned and must be preserved")
	}
}
