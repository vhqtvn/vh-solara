package web

// Regression test for the teardown-join race in the six post-hydrate reconcile
// spawns (follow-up slice F7 to the b5d209b list-spawn fix — same defect
// class): installQueueGCCleanup dispatched
// `go s.reconcileQueuesForAgg/Pins/Labels(dir, a)` fire-and-forget from BOTH
// of its trigger arms — the onHydrate callback (fired at the tail of every
// successful hydrate) and the immediate-run branch (install time with
// AnyHydrateCompleted already true — the default aggregator's boot shape).
// The passes were tracked on NEITHER bgWG NOR lifecycleWG, so Server.Shutdown
// — which awaits exactly those two groups — could return while a pass was
// still in flight. reconcileQueuesForAgg performs durable writes (orphan
// queue.json deletion via queueRegistry.deleteStore, under qr.mu), and the
// pins/labels backstops persist doc removals via PinStore.RemoveIDs /
// LabelStore.RemoveRootIDs — so an in-flight pass races the caller's teardown
// exactly like the 2026-10-11 TempDir RemoveAll ENOTEMPTY incident.
//
// Rendezvous design (deterministic, no timing race — same discipline as
// queue_msg_reconcile_shutdown_test.go): the reconcilers make no HTTP calls,
// so the b5d209b fake-endpoint-block trick does not transfer. Instead the test
// holds the queue REGISTRY mutex (srv.queues.mu) — the lock deleteStore
// acquires across its os.Remove(queue.json) critical section — and observes
// the pass's entry via the atomic CleanupCallCount counter (incremented in
// CleanupSession immediately BEFORE deleteStore parks on the lock). With the
// lock held, a spawned queue pass is deterministically parked INSIDE its
// durable-delete critical section; Shutdown must then not return until the
// lock is released (bgWG join), and the deletion must have landed by the time
// Shutdown returns.
//
// Both trigger arms are exercised:
//   - TestShutdownJoinsOnHydrateSpawnedQueueReconcile: the onHydrate callback
//     arm (callback installed before the aggregator's first hydrate, then
//     agg.Run fires it from the hydrate tail);
//   - TestShutdownJoinsImmediateRunQueueReconcile: the immediate-run arm
//     (hydrate first — callback still nil at the tail, so no spawn — then
//     aggFor, whose AnyHydrateCompleted branch spawns synchronously).
// In those queue fixtures the pins/labels passes are no-ops (empty pin doc /
// empty label store) and contribute only already-drained bgWG entries, which
// is why the window assertion there is specific to the parked queue pass.
//
// Per-pass extensions (review follow-up to 61b4830 — close the behavioral-
// closure gap left when the pins/labels joins were covered only structurally
// via the shared spawnPostHydrateReconciles helper):
//   - TestShutdownJoinsParkedPinsReconcile / TestShutdownJoinsParkedLabelsReconcile
//     park EACH pass deterministically and prove the same join + durable-order
//     contract per pass. Structural difference from the queue arm: the pins
//     pass acquires the PinStore mutex TWICE (s.pins.Snapshot() first, then
//     RemoveIDs across persistLocked), and the labels pass likewise (st.mu at
//     labelsReconcileSnapshot(), then RemoveRootIDs across persistLocked), so
//     holding the store mutex parks the pass at the SNAPSHOT acquisition —
//     before the removal decision — with the durable write (under the SAME
//     mutex) still pending and unable to start. Pass entry is observed via the
//     pinsReconcileEntries / labelsReconcileEntries counters (the
//     cleanupCalls seam pattern), incremented immediately BEFORE the snapshot's
//     lock acquisition: counter ≥ 1 + mutex held ⇒ deterministically parked.
//     After release, the seeded orphan's durable removal must have landed on
//     disk before Shutdown returned. Both tests use the immediate-run arm —
//     the arm is a property of the shared spawn helper already covered by the
//     queue pair; what these tests pin is the per-pass bgWG membership.
//
// Fixture hygiene (review advisory, applied to ALL fixtures in this file):
// every fixture sets VH_STATE_DIR to a dedicated temp dir BEFORE NewServer, so
// the worker-wide PinStore (<stateBaseDir>/pins.json), the one-time labels
// migration, and the per-project label stores never read or write the
// operator's real user-config state.

import (
	"context"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// exercisePostHydrateSpawnJoin builds the server fixture, seeds one orphan
// queue, parks the spawned queue pass inside deleteStore's critical section
// via the held registry lock, and asserts Shutdown's join contract. trigger
// fires the arm-specific spawn while the registry lock is held.
func exercisePostHydrateSpawnJoin(t *testing.T, arm string, trigger func(srv *Server, ocCtx context.Context)) {
	t.Helper()
	// Fixture hygiene (review advisory): isolate ALL stateBaseDir() persistence
	// — NewServer loads <stateBaseDir>/pins.json and runs the labels migration
	// — so this fixture never read the operator's real PinStore nor migrate
	// the real user-config dir. Non-behavioral for the asserted contract: the
	// pins/labels passes were already no-ops here (empty doc / empty store),
	// and project attribution is keyed to this test's TempDir cwd.
	t.Setenv("VH_STATE_DIR", t.TempDir())
	root := t.TempDir()

	fake := newFake()
	ocSrv := httptest.NewServer(fake.handler())
	t.Cleanup(ocSrv.Close)
	t.Cleanup(ocSrv.CloseClientConnections)

	agg := aggregator.New(ocSrv.URL, 20)
	srv, err := NewServer(agg, ocSrv.URL, 20)
	if err != nil {
		t.Fatal(err)
	}
	ocCtx, ocCancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx) // idempotent with the explicit Shutdown below
	})
	t.Cleanup(ocCancel)
	t.Chdir(root) // projectRoot("") → root (the default project)

	// Seed an orphan queue on disk: <root>/.vh-solara/sessions/orphan1/queue.json.
	// The fake's /session list is empty, so the post-hydrate active set is the
	// empty NON-NIL map — the authoritative-zero case — making orphan1 a
	// reconcile candidate (revalidate: store.HasSession("orphan1") == false).
	orphan := queuePath(root, "orphan1")
	if err := os.MkdirAll(filepath.Dir(orphan), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(orphan, []byte(`{"items":[]}`), 0o644); err != nil {
		t.Fatal(err)
	}

	// RENDEZVOUS: hold the registry lock — deleteStore takes qr.mu across its
	// os.Remove(queue.json) + empty-dir rmdir (see the BLK-1 contract on
	// deleteStore) — so once the pass increments CleanupCallCount it is
	// deterministically parked mid-durable-delete until release. sync.Once
	// guards the pairing between the explicit release below and this Goexit
	// safety net (t.Fatalf runs deferred calls).
	srv.queues.mu.Lock()
	var releaseOnce sync.Once
	releaseRegistry := func() {
		releaseOnce.Do(func() { srv.queues.mu.Unlock() })
	}
	defer releaseRegistry()

	// Fire the arm-specific trigger (under the held lock — aggFor and the
	// onHydrate tail never need qr.mu, so only the spawned queue pass parks).
	trigger(srv, ocCtx)

	// The queue pass has ENTERED its durable-delete critical section: the
	// cleanup counter is incremented BEFORE deleteStore parks on qr.mu.
	waitFor(t, func() bool { return srv.queues.CleanupCallCount() >= 1 },
		"post-hydrate queue reconcile pass entered CleanupSession ("+arm+" arm)")

	// The pass is NOW observably in flight (parked on qr.mu). Shutdown must
	// join it: no Shutdown phase before the Wait takes qr.mu (no drain loops
	// are registered, s.aggs is empty, the default aggregator is not stopped),
	// so the ONLY thing that can hold Shutdown here is the bgWG entry.
	shutdownDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		shutdownDone <- srv.Shutdown(ctx)
	}()
	select {
	case err := <-shutdownDone:
		t.Fatalf("Shutdown returned (err=%v) while the post-hydrate queue reconcile pass (%s arm) was parked in its durable-delete critical section — the spawn is untracked (not on bgWG), so deleteStore's os.Remove can race the caller's teardown", err, arm)
	case <-time.After(300 * time.Millisecond):
		// Still parked on the in-flight pass: the join is holding.
	}

	// Drain the pass; Shutdown must now complete…
	releaseRegistry()
	select {
	case <-shutdownDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Shutdown did not return after the in-flight post-hydrate reconcile pass drained")
	}

	// …and the durable delete landed BEFORE Shutdown returned (bgWG ordering):
	// the parked os.Remove could only have run after the release, yet before
	// the pass's deferred Done let the Wait through.
	if _, err := os.Stat(orphan); !os.IsNotExist(err) {
		t.Fatalf("orphan queue.json still present after Shutdown (stat err=%v) — the joined pass's durable delete must have landed before Shutdown returned", err)
	}
}

// TestShutdownJoinsOnHydrateSpawnedQueueReconcile pins the join contract for
// the onHydrate-callback spawn arm: the callback is installed (aggFor) BEFORE
// the aggregator's first hydrate, then agg.Run's initial hydrate fires it at
// its tail — deterministically after installation (program order).
func TestShutdownJoinsOnHydrateSpawnedQueueReconcile(t *testing.T) {
	exercisePostHydrateSpawnJoin(t, "onHydrate-callback", func(srv *Server, ocCtx context.Context) {
		srv.aggFor("") // installs the onHydrate callback; AnyHydrateCompleted==false → immediate-run arm stays quiet
		go srv.agg.Run(ocCtx)
	})
}

// TestShutdownJoinsImmediateRunQueueReconcile pins the join contract for the
// immediate-run spawn arm: the aggregator hydrates FIRST (callback still nil
// at the hydrate tail, so no spawn there), then aggFor installs the callback
// and its AnyHydrateCompleted branch spawns synchronously — the production
// shape of the default aggregator, which the daemon hydrates before the first
// request reaches aggFor("").
func TestShutdownJoinsImmediateRunQueueReconcile(t *testing.T) {
	exercisePostHydrateSpawnJoin(t, "immediate-run", func(srv *Server, ocCtx context.Context) {
		go srv.agg.Run(ocCtx)
		waitFor(t, func() bool { return srv.agg.AnyHydrateCompleted() }, "initial hydrate before aggFor")
		srv.aggFor("") // AnyHydrateCompleted==true → immediate-run arm fires here
	})
}

// newPostHydrateFixture builds the shared scaffold for the per-pass rendezvous
// tests below: sandboxed state dir (VH_STATE_DIR → temp, set BEFORE NewServer
// so the PinStore load and the labels migration are isolated too), fake
// OpenCode upstream with an EMPTY /session list (post-hydrate active set is
// the authoritative-zero empty set), and a TempDir cwd so projectRoot("")
// resolves deterministically. Returns the server, the project root, and the
// aggregator's run ctx (cancelled via t.Cleanup — pass it to agg.Run).
func newPostHydrateFixture(t *testing.T) (*Server, string, context.Context) {
	t.Helper()
	t.Setenv("VH_STATE_DIR", t.TempDir()) // same hygiene as exercisePostHydrateSpawnJoin
	root := t.TempDir()

	fake := newFake()
	ocSrv := httptest.NewServer(fake.handler())
	t.Cleanup(ocSrv.Close)
	t.Cleanup(ocSrv.CloseClientConnections)

	agg := aggregator.New(ocSrv.URL, 20)
	srv, err := NewServer(agg, ocSrv.URL, 20)
	if err != nil {
		t.Fatal(err)
	}
	ocCtx, ocCancel := context.WithCancel(context.Background())
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx) // idempotent with the explicit Shutdown below
	})
	t.Cleanup(ocCancel)
	t.Chdir(root) // projectRoot("") → root (the default project)
	return srv, root, ocCtx
}

// fireImmediateRunReconciles triggers the immediate-run spawn arm (the default
// aggregator's production boot shape) and returns once all three passes have
// been launched via spawnPostHydrateReconciles (bgWG.Add(3) happens
// synchronously inside aggFor before this returns).
func fireImmediateRunReconciles(t *testing.T, srv *Server, ocCtx context.Context) {
	t.Helper()
	go srv.agg.Run(ocCtx)
	waitFor(t, func() bool { return srv.agg.AnyHydrateCompleted() }, "initial hydrate before aggFor")
	srv.aggFor("") // AnyHydrateCompleted==true → immediate-run arm fires here
}

// assertShutdownJoinsParkedPass asserts the Shutdown-join contract for a pass
// that is deterministically parked (see the per-pass tests below for the park
// construction): Shutdown must NOT return during the 300ms one-sided negative
// window while the pass is parked; after release(), Shutdown must return
// promptly. The post-Shutdown durable assertions are the caller's (per-pass).
// Mirrors the queue-arm discipline exactly: the positive ordering assertions
// (release → Shutdown returns → durable effect present) are deterministic;
// the 300ms window is only the one-sided negative observation.
func assertShutdownJoinsParkedPass(t *testing.T, srv *Server, release func(), parkedWhy string) {
	t.Helper()
	shutdownDone := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		shutdownDone <- srv.Shutdown(ctx)
	}()
	select {
	case err := <-shutdownDone:
		t.Fatalf("Shutdown returned (err=%v) while the post-hydrate reconcile pass was parked (%s) — the spawn is untracked (not on bgWG), so its durable write can race the caller's teardown", err, parkedWhy)
	case <-time.After(300 * time.Millisecond):
		// Still parked on the in-flight pass: the join is holding.
	}

	// Drain the parked pass; Shutdown must now complete…
	release()
	select {
	case <-shutdownDone:
	case <-time.After(5 * time.Second):
		t.Fatal("Shutdown did not return after the in-flight post-hydrate reconcile pass drained")
	}
}

// TestShutdownJoinsParkedPinsReconcile pins the join contract for the PINS
// post-hydrate reconcile pass (reconcilePinsForAgg, immediate-run arm via the
// shared spawnPostHydrateReconciles). Structural difference from the queue
// arm: the pins pass acquires the PinStore mutex TWICE — first at
// s.pins.Snapshot() (the F1 ordering-invariant snapshot), then again inside
// PinStore.RemoveIDs across persistLocked — so holding s.pins.mu parks the
// pass at the SNAPSHOT acquisition, before the removal decision, with the
// durable RemoveIDs persist (under the SAME mutex) still pending and unable
// to start. Entry is observed via the pinsReconcileEntries counter
// (incremented immediately BEFORE the snapshot's lock acquisition — the
// cleanupCalls seam pattern), so counter ≥ 1 + held mutex ⇒ deterministically
// parked, and the seeded orphan pin guarantees the released pass actually
// performs the durable write (asserted on disk after Shutdown returns).
func TestShutdownJoinsParkedPinsReconcile(t *testing.T) {
	srv, root, ocCtx := newPostHydrateFixture(t)

	// Seed one ORPHAN project-scoped pin directly through the store
	// (white-box, same-package): pinned id "orphan-pin-1" attributed
	// (ProjectBySessionID) to THIS project's key, while the fake's empty
	// /session list makes the post-hydrate active set the authoritative-zero
	// empty map — so the pin IS a removal candidate and the released pass
	// reaches removePinsAndBroadcast → PinStore.RemoveIDs (revision bump +
	// pins.json rewrite). The seed Replace itself persists pins.json at rev 1.
	key := projectKey(root)
	if ok, _, err := srv.pins.Replace(0, []string{"orphan-pin-1"}, map[string]string{"orphan-pin-1": key}, false); err != nil || !ok {
		t.Fatalf("seed orphan pin: ok=%v err=%v", ok, err)
	}

	// RENDEZVOUS: hold the PinStore mutex — the one RemoveIDs holds across
	// persistLocked — so the spawned pins pass parks at the Snapshot
	// acquisition and its durable write cannot start. sync.Once pairs the
	// explicit release below with the Goexit safety net (t.Fatalf runs
	// deferred calls).
	srv.pins.mu.Lock()
	var releaseOnce sync.Once
	releasePins := func() {
		releaseOnce.Do(func() { srv.pins.mu.Unlock() })
	}
	defer releasePins()

	// Fire the immediate-run arm under the held lock (aggFor never needs
	// pins.mu, so only the spawned pins pass parks). The queue pass is a no-op
	// (no queue.json orphans seeded) and the labels pass finds an empty doc
	// (no labels store materialized), so both drain on their own and bgWG
	// isolates the parked pins pass.
	fireImmediateRunReconciles(t, srv, ocCtx)

	// The pins pass has ENTERED: the counter is incremented immediately
	// BEFORE s.pins.Snapshot() parks on the held mutex.
	waitFor(t, func() bool { return srv.pinsReconcileEntryCount() >= 1 },
		"post-hydrate pins reconcile pass reached the pin-doc snapshot")

	// No Shutdown phase before the Wait takes pins.mu (the watcher/drain maps
	// are empty; stopServerOwnedAggregators skips the default dir ""), so the
	// ONLY thing that can hold Shutdown here is the bgWG entry.
	assertShutdownJoinsParkedPass(t, srv, releasePins, "pins pass parked at s.pins.Snapshot() with its RemoveIDs persist pending")

	// …and the durable removal landed BEFORE Shutdown returned (bgWG
	// ordering): the parked RemoveIDs could only have run after the release,
	// yet before the pass's deferred Done let the Wait through. Proof is on
	// DISK — reload the doc the way the next process would.
	st, err := NewPinStore(filepath.Join(stateBaseDir(), "pins.json"))
	if err != nil {
		t.Fatal(err)
	}
	doc := st.Snapshot()
	for _, id := range doc.OrderedSessionIDs {
		if id == "orphan-pin-1" {
			t.Fatalf("orphan pin orphan-pin-1 still present on disk after Shutdown — the joined pass's durable removal must have landed before Shutdown returned")
		}
	}
	if doc.Revision < 2 {
		t.Fatalf("pins doc revision = %d, want ≥ 2 (seed Replace left rev 1; the pass's RemoveIDs must have bumped it again before Shutdown returned)", doc.Revision)
	}
}

// TestShutdownJoinsParkedLabelsReconcile pins the join contract for the LABELS
// post-hydrate reconcile pass (reconcileLabelsForAgg, immediate-run arm via
// the shared spawnPostHydrateReconciles). Same structural difference as the
// pins pass: the labels pass acquires the per-project LabelStore mutex TWICE —
// first at labelsReconcileSnapshot(), then again inside RemoveRootIDs across
// persistLocked — so holding st.mu parks the pass at the SNAPSHOT acquisition,
// before the removal decision, with the durable RemoveRootIDs persist (under
// the SAME mutex) still pending and unable to start. Entry is observed via the
// labelsReconcileEntries counter; the seeded orphan root reference guarantees
// the released pass actually performs the durable write.
func TestShutdownJoinsParkedLabelsReconcile(t *testing.T) {
	srv, root, ocCtx := newPostHydrateFixture(t)

	// Materialize the default project's store (labelsForDir is lazy — the
	// pass must resolve the SAME cached *LabelStore the test locks below) and
	// seed one ORPHAN root reference through it (white-box): group g1
	// references "orphan-root-1", attributed by the ProjectByRootSessionID
	// sidecar to THIS project's key, while the fake's empty /session list
	// makes the active-root set the authoritative-zero empty set — so the root
	// IS a removal candidate and the released pass reaches
	// removeLabelsAndBroadcast → LabelStore.RemoveRootIDs (revision bump +
	// labels.json rewrite). The seed Replace itself persists labels.json at
	// rev 1. (The Replace activeRootProjects map satisfies the store's
	// unknown-root validation AND sets the sidecar attribution in one step.)
	st := srv.labelsForDir("")
	if st == nil {
		t.Fatal("labelsForDir(\"\") returned a nil store")
	}
	key := projectKey(root)
	if ok, _, err := st.Replace(0, LabelsDoc{
		Groups:                []LabelGroup{{ID: "g1", Name: "G", Color: "blue", OrderedRootSessionIDs: []string{"orphan-root-1"}}},
		Tags:                  []LabelTag{},
		TagIDsByRootSessionID: map[string][]string{},
	}, map[string]string{"orphan-root-1": key}); err != nil || !ok {
		t.Fatalf("seed orphan label root: ok=%v err=%v", ok, err)
	}

	// RENDEZVOUS: hold the store mutex — the one RemoveRootIDs holds across
	// persistLocked — so the spawned labels pass parks at the
	// labelsReconcileSnapshot acquisition and its durable write cannot start.
	st.mu.Lock()
	var releaseOnce sync.Once
	releaseLabels := func() {
		releaseOnce.Do(func() { st.mu.Unlock() })
	}
	defer releaseLabels()

	// Fire the immediate-run arm under the held lock (aggFor and the pass's
	// labelsForDir take the registry mutex, never st.mu, so only the spawned
	// labels pass parks). The queue pass is a no-op and the pins pass finds an
	// empty pin doc (no pins seeded), so bgWG isolates the parked labels pass.
	fireImmediateRunReconciles(t, srv, ocCtx)

	// The labels pass has ENTERED: the counter is incremented immediately
	// BEFORE st.labelsReconcileSnapshot() parks on the held mutex.
	waitFor(t, func() bool { return srv.labelsReconcileEntryCount() >= 1 },
		"post-hydrate labels reconcile pass reached the labels reconcile snapshot")

	// No Shutdown phase before the Wait takes st.mu or labelsReg.mu (the
	// watcher/drain maps are empty; stopServerOwnedAggregators skips the
	// default dir ""), so the ONLY thing that can hold Shutdown here is the
	// bgWG entry.
	assertShutdownJoinsParkedPass(t, srv, releaseLabels, "labels pass parked at labelsReconcileSnapshot() with its RemoveRootIDs persist pending")

	// …and the durable removal landed BEFORE Shutdown returned (bgWG
	// ordering), proven on DISK by reloading the project's store the way the
	// next process would. RemoveRootIDs strips root REFERENCES only: the g1
	// DEFINITION must survive while no group order (and no tag assignment)
	// references the orphan root anymore.
	diskSt, err := NewLabelStore(filepath.Join(stateBaseDir(), "projects", key, "labels.json"))
	if err != nil {
		t.Fatal(err)
	}
	g := diskSt.Snapshot()
	foundG1 := false
	for _, grp := range g.Groups {
		if grp.ID != "g1" {
			continue
		}
		foundG1 = true
		for _, rid := range grp.OrderedRootSessionIDs {
			if rid == "orphan-root-1" {
				t.Fatalf("orphan root orphan-root-1 still referenced by group g1 on disk after Shutdown — the joined pass's durable removal must have landed before Shutdown returned")
			}
		}
	}
	if !foundG1 {
		t.Fatalf("group definition g1 did not survive the root-reference removal — RemoveRootIDs must preserve definitions (invariant #7)")
	}
	if _, ok := g.TagIDsByRootSessionID["orphan-root-1"]; ok {
		t.Fatalf("orphan root orphan-root-1 still has a tag assignment on disk after Shutdown — the joined pass's durable removal must have landed before Shutdown returned")
	}
	if g.Revision < 2 {
		t.Fatalf("labels doc revision = %d, want ≥ 2 (seed Replace left rev 1; the pass's RemoveRootIDs must have bumped it again before Shutdown returned)", g.Revision)
	}
}
