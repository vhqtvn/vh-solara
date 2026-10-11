package web

// Regression test for the teardown-join race in the list-spawned passive
// reconciler (observed 2026-10-11: TestDrainLoopLeavesLegacyItemsTo-
// GetOnlyReconcile passed all assertions but t.TempDir's RemoveAll failed with
// "unlinkat .../.vh-solara/sessions/mixed: directory not empty").
//
// handleQueueList spawns `go s.reconcileSessionQueue(...)` when a listed item
// is a reconcile candidate. That pass only GETs and Resolve()s — but the
// Resolve/bump mutations persist via st.save(), which MkdirAlls + writes
// <root>/.vh-solara/sessions/<sid>/queue.json. The spawn was fire-and-forget:
// tracked on NEITHER bgWG NOR lifecycleWG, so Server.Shutdown — which awaits
// exactly those two groups — could return while a pass was still in flight,
// and the pass's save() then raced the caller's teardown (a test's TempDir
// RemoveAll between readdir and rmdir → ENOTEMPTY).
//
// This test pins the JOIN contract deterministically (no timing race): a fake
// OpenCode whose exact-message GET BLOCKS holds the spawned pass observably
// in flight (rendezvous channel), then Shutdown must not return until the
// pass drains. Same seam discipline as archive_reassert_test.go's
// reassertBlockCh proof of Shutdown's bgWG await.

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// TestShutdownJoinsListSpawnedReconcile: the reconcile pass spawned by GET
// /vh/session/{sid}/queue is server-owned background work (the Server's
// documented ownership model: bgWG so "Shutdown awaits it"); Shutdown must
// therefore not return while the pass is in flight, and the pass's durable
// write must have landed by the time Shutdown returns.
func TestShutdownJoinsListSpawnedReconcile(t *testing.T) {
	// Fixture hygiene (same as posthydrate_reconcile_shutdown_test.go): isolate
	// ALL stateBaseDir() persistence — NewServer loads <stateBaseDir>/pins.json
	// and runs the labels migration, which MkdirAlls + writes its completion
	// marker even when the legacy file is missing — so this test never reads
	// the operator's real pins.json nor writes into the real user-config dir.
	// Must land BEFORE NewServer: stateBaseDir() reads VH_STATE_DIR live.
	t.Setenv("VH_STATE_DIR", t.TempDir())
	root := t.TempDir()

	// The rendezvous: the fake OC's exact-message handler signals entry, then
	// blocks until released — holding the spawned reconcile pass observably
	// mid-lookup. Buffered + non-blocking send so a (contract-violating)
	// second lookup cannot panic on double-close.
	lookupEntered := make(chan struct{}, 1)
	enterLookup := func() {
		select {
		case lookupEntered <- struct{}{}:
		default:
		}
	}
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseLookup := func() { releaseOnce.Do(func() { close(release) }) }

	mux := http.NewServeMux()
	mux.HandleFunc("/session/{id}/message/{mid}", func(w http.ResponseWriter, r *http.Request) {
		enterLookup()
		<-release
		http.Error(w, "not found", http.StatusNotFound)
	})
	oc := httptest.NewServer(mux)
	t.Cleanup(oc.Close)

	agg := aggregator.New(oc.URL, 20)
	srv, err := NewServer(agg, oc.URL, 20)
	if err != nil {
		t.Fatal(err)
	}
	// Shutdown fallback, then the release — IN that registration order, so
	// LIFO runs releaseLookup FIRST: a failing path drains the parked pass
	// before the fallback Shutdown instead of burning its full 5s ctx on the
	// join. Invariant preserved either way: releaseLookup still runs before
	// oc.Close (registered above), so the blocked handler can never deadlock
	// oc.Close.
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx) // idempotent with the explicit Shutdown below
	})
	t.Cleanup(releaseLookup)
	t.Chdir(root) // projectRoot("") → root (the default project)
	web := httptest.NewServer(srv.Handler())
	t.Cleanup(web.Close)
	_ = srv.aggFor("") // install the default aggregator so aggForExisting finds it

	// Seed a reconcile candidate directly into the store (the delivered-but-
	// stuck shape): unknown + correlation id + not terminal → List traffic
	// spawns the passive reconciler.
	st := srv.queues.store(root, "s1")
	st.mu.Lock()
	if err := st.load(); err != nil {
		t.Fatal(err)
	}
	st.items = append(st.items, QueueItem{
		ID:            "rc-1",
		Order:         1,
		State:         QueueUnknown,
		Text:          "stuck",
		OpencodeMsgID: "msg_stuck",
	})
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
	st.loaded = true
	st.mu.Unlock()

	// Drive the REAL spawn path: a queue List through HTTP. The handler
	// returns immediately; the spawned pass blocks inside its exact-id GET.
	resp, err := http.Get(web.URL + "/vh/session/s1/queue")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	select {
	case <-lookupEntered:
	case <-time.After(5 * time.Second):
		t.Fatal("the list-spawned reconciler never issued its exact-id lookup")
	}

	// The pass is NOW observably in flight. Shutdown must join it.
	shutdownDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		shutdownDone <- srv.Shutdown(ctx)
	}()
	select {
	case err := <-shutdownDone:
		t.Fatalf("Shutdown returned (err=%v) while the list-spawned reconcile pass was still in flight — the spawn is untracked (not on bgWG), so its st.save() can race the caller's teardown", err)
	case <-time.After(300 * time.Millisecond):
		// Still blocked on the in-flight pass: the join is holding.
	}

	// Drain the pass; Shutdown must now complete…
	releaseLookup()
	select {
	case <-shutdownDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Shutdown did not return after the in-flight reconcile pass drained")
	}

	// …and the pass's durable write landed BEFORE Shutdown returned (bgWG
	// ordering): the 404 bumped the item's reconcile attempt count.
	items, err := st.List()
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range items {
		if it.ID == "rc-1" {
			if it.ReconcileAttempts != 1 {
				t.Fatalf("reconcile attempts = %d, want 1 — the joined pass's durable write must have landed before Shutdown returned", it.ReconcileAttempts)
			}
			return
		}
	}
	t.Fatalf("item rc-1 not found after Shutdown: %+v", items)
}
