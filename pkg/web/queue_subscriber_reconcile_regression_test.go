package web

// Regression pin for CI run 41192532920 (scheduled, 2026-10-31 10:24Z):
// TestQueueSubscriberLifecycle_AggForInstallsSiblings failed with
//
//	queue_subscriber_lifecycle_test.go:164: open <cwd>/.vh-solara/sessions/ses1/queue.json: no such file or directory
//
// Root cause: the default aggregator (started by the reload harness BEFORE
// the test seeds the fake's session list) could complete its first hydrate
// against the EMPTY list, freezing an authoritative empty session set; the
// post-hydrate orphan-queue reconcile pass (reconcileQueuesForAgg — spawned
// by aggFor's immediate-run arm) then reaped the just-seeded queue.json for a
// session the store never sourced. The pre-fix mechanism was reproduced
// deterministically by forcing that interleaving synchronously (hydrate with
// the empty list → seed → run the pass → file gone).
//
// The harness fix (fakeOpenCode.sessionListGate, opened by seedFakeSessions)
// orders every hydrate AFTER the seed. This test pins the resulting
// invariant END-TO-END through the real production pass: once the store has
// sourced the session, the very reconcile function the async arm runs must
// SPARE the seeded queue.json.

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestQueueSubscriberLifecycleSeededQueueSurvivesOrphanReconcile(t *testing.T) {
	srv, fake, _, _ := newSubscriberServer(t)

	// Seed the backend session list — this opens the sessionListGate, so the
	// default aggregator's (first) hydrate is guaranteed to source ses1.
	seedFakeSessions(fake, "ses1")

	def := srv.aggFor("") // the production default-project install site

	// Deterministic post-gate: wait until the store has actually sourced the
	// seeded session (hydrate completes once the gate opens; in-process
	// httptest server, so bounded and fast).
	rootDefault, err := projectRoot("")
	if err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for !def.Store().HasSession("ses1") {
		if time.Now().After(deadline) {
			t.Fatal("default aggregator never sourced the seeded session (gate ordering broken?)")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// Seed the on-disk queue for the backend-live session, exactly like the
	// subscriber-lifecycle tests do.
	seedLifecycleStore(t, srv, rootDefault, "ses1", map[string]time.Duration{"d1": 0})

	qpath := filepath.Join(rootDefault, ".vh-solara", "sessions", "ses1", "queue.json")
	if _, err := os.Stat(qpath); err != nil {
		t.Fatalf("seed sanity: queue.json must exist before the reconcile pass: %v", err)
	}

	// Run the EXACT function the post-hydrate arm spawns — synchronously, so
	// the pass's disk scan is guaranteed to observe the seeded queue.json.
	srv.reconcileQueuesForAgg("", def)

	// A queue.json for a backend-sourced session must survive the pass.
	if _, err := os.Stat(qpath); err != nil {
		t.Fatalf("seeded queue.json reaped by the orphan-queue reconcile despite its session being sourced (CI 41192532920 regression): %v", err)
	}
}
