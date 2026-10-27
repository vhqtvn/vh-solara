package web

// Queue idle-gate tests (task queue-idle-gate-send-now slice S2 — the
// 2026-10-26 incident fix): daemon-mode queue dispatch must honor
// wait-until-subtree-idle. A queued item must NOT be POSTed upstream while
// the target session's subtree is observably busy (root busy|retry OR any
// descendant busy|retry), restoring — in daemon dispatch mode — the
// guarantee the legacy browser drainer had.
//
// Corner rule (binding, Candidate A "visible-idle-only recheck with
// absent=allow"): corners 2/6/7 BLOCK (the gate runs BEFORE resume-marker
// consumption); corners 1/3/4 ALLOW on a fresh per-tick canonical read (no
// debounce, no memory); corner 5 takes NO gate action (the certified
// recovery ladder owns in-flight items).
//
// Style: real loop via newDrainTestServer + fakeOCForDrain (see
// queue_drain_loop_test.go); canonical state is driven deterministically
// through the aggregator's own reducer path (Store().Apply — no test-only
// backdoors); holds assert f.arrivals()==0 + item stays QueuePending across
// many ticks (tick overridden to 30ms), releases assert via waitForDrain.

import (
	"runtime"
	"testing"
	"time"
)

// TestQueueIdleGateSubtreeBusyHoldsUntilIdle — THE mandatory incident
// regression (2026-10-26: an item enqueued on an idle ROOT while a descendant
// subagent ran was POSTed 15ms later and folded into the running turn). The
// item must stay pending across many drain ticks with ZERO upstream POSTs
// while the subtree is observably busy, then dispatch exactly once once the
// whole tree is idle.
func TestQueueIdleGateSubtreeBusyHoldsUntilIdle(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, root := newDrainTestServer(t, f)
	store := srv.aggForExisting("").Store()

	// Canonical tree: root R with child C; C busy — the incident posture
	// (root itself idle, subtree busy).
	store.Apply(ev("session.created", `{"info":{"id":"ses_R"}}`))
	store.Apply(ev("session.created", `{"info":{"id":"ses_C","parentID":"ses_R"}}`))
	store.Apply(ev("session.status", `{"sessionID":"ses_C","status":{"type":"busy"}}`))
	if g := store.GateFacts()["ses_R"]; !g.SubtreeBusy {
		t.Fatalf("setup: GateFacts[ses_R].SubtreeBusy=false, want true (child busy)")
	}

	st := srv.queues.store(root, "ses_R")
	if _, err := st.Enqueue("must wait for the subtree", nil, QueueSendConfig{Agent: "build"}, ""); err != nil {
		t.Fatal(err)
	}

	// ≥1s of ticks (tick=30ms ⇒ ~33 ticks) with ZERO upstream POSTs and the
	// item still pending. This is the red-first assertion: the ungated loop
	// dispatched within ~2 ticks.
	time.Sleep(1 * time.Second)
	if n := f.arrivals(); n != 0 {
		t.Fatalf("upstream POSTs while subtree busy = %d, want 0 (the incident class)", n)
	}
	items, err := st.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].State != QueuePending {
		t.Fatalf("item = %+v, want still QueuePending while the subtree is observably busy", items)
	}

	// The subtree goes idle → dispatches EXACTLY once.
	store.Apply(ev("session.status", `{"sessionID":"ses_C","status":{"type":"idle"}}`))
	waitForDrain(t, 5*time.Second, "the gated dispatch after subtree idle", func() bool { return f.arrivals() == 1 })
	items, err = st.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].State != QueueDispatching {
		t.Fatalf("item = %+v, want QueueDispatching after idle release", items)
	}
	// Exactly once: further ticks must not re-POST (in-flight items are
	// never re-selected, but pin it — the fix must not overcorrect into a
	// re-POST loop).
	time.Sleep(300 * time.Millisecond)
	if n := f.arrivals(); n != 1 {
		t.Fatalf("upstream POSTs after release = %d, want exactly 1", n)
	}
}

// TestQueueIdleGateRootSelfBusyHolds pins the SELF-INCLUSIVE subtree count:
// the root itself busy (no descendants) holds the lane too.
func TestQueueIdleGateRootSelfBusyHolds(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, root := newDrainTestServer(t, f)
	store := srv.aggForExisting("").Store()

	store.Apply(ev("session.created", `{"info":{"id":"ses_R2"}}`))
	store.Apply(ev("session.status", `{"sessionID":"ses_R2","status":{"type":"busy"}}`))
	if g := store.GateFacts()["ses_R2"]; !g.SubtreeBusy {
		t.Fatalf("setup: GateFacts[ses_R2].SubtreeBusy=false, want true (self busy)")
	}

	st := srv.queues.store(root, "ses_R2")
	if _, err := st.Enqueue("root itself busy", nil, QueueSendConfig{Agent: "build"}, ""); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	if n := f.arrivals(); n != 0 {
		t.Fatalf("upstream POSTs while root self-busy = %d, want 0", n)
	}
	items, err := st.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || items[0].State != QueuePending {
		t.Fatalf("item = %+v, want still QueuePending while the root is self-busy", items)
	}

	store.Apply(ev("session.status", `{"sessionID":"ses_R2","status":{"type":"idle"}}`))
	waitForDrain(t, 5*time.Second, "dispatch after the root goes idle", func() bool { return f.arrivals() == 1 })
}

// TestQueueIdleGateRetryClassHolds pins retry ∈ busy-class (the same index
// the operator contract uses: root busy|retry OR descendant busy|retry).
func TestQueueIdleGateRetryClassHolds(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, root := newDrainTestServer(t, f)
	store := srv.aggForExisting("").Store()

	store.Apply(ev("session.created", `{"info":{"id":"ses_R3"}}`))
	store.Apply(ev("session.created", `{"info":{"id":"ses_C3","parentID":"ses_R3"}}`))
	store.Apply(ev("session.status", `{"sessionID":"ses_C3","status":{"type":"retry"}}`))
	if g := store.GateFacts()["ses_R3"]; !g.SubtreeBusy {
		t.Fatalf("setup: GateFacts[ses_R3].SubtreeBusy=false, want true (child retry)")
	}

	st := srv.queues.store(root, "ses_R3")
	if _, err := st.Enqueue("child retrying", nil, QueueSendConfig{Agent: "build"}, ""); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	if n := f.arrivals(); n != 0 {
		t.Fatalf("upstream POSTs while child in retry = %d, want 0", n)
	}

	store.Apply(ev("session.status", `{"sessionID":"ses_C3","status":{"type":"idle"}}`))
	waitForDrain(t, 5*time.Second, "dispatch after retry clears", func() bool { return f.arrivals() == 1 })
}

// TestQueueIdleGateErrorAllows pins the ActivityError carve-out as
// DELIBERATE contract behavior for the gate (error ≠ running): a descendant
// in terminal error does NOT hold dispatch.
func TestQueueIdleGateErrorAllows(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, root := newDrainTestServer(t, f)
	store := srv.aggForExisting("").Store()

	store.Apply(ev("session.created", `{"info":{"id":"ses_R4"}}`))
	store.Apply(ev("session.created", `{"info":{"id":"ses_C4","parentID":"ses_R4"}}`))
	store.Apply(ev("session.error", `{"sessionID":"ses_C4","error":{"name":"Unknown","message":"boom"}}`))
	if g := store.GateFacts()["ses_R4"]; g.SubtreeBusy {
		t.Fatalf("setup: GateFacts[ses_R4].SubtreeBusy=true, want false (error carve-out)")
	}

	st := srv.queues.store(root, "ses_R4")
	if _, err := st.Enqueue("child errored, tree is idle for the gate", nil, QueueSendConfig{Agent: "build"}, ""); err != nil {
		t.Fatal(err)
	}
	waitForDrain(t, 5*time.Second, "dispatch past an errored descendant", func() bool { return f.arrivals() == 1 })
}

// TestQueueIdleGateAbsentSessionDispatches pins corner 3 (absent=allow): a
// session the canonical store has NEVER seen — the routine post-restart
// posture for a lane rediscovered from durable queue.json before the
// aggregator adopts it — is not observably busy, so dispatch proceeds.
//
// DELIBERATE W1 PIN (waiver-covered judgment call; do not "fix"): this is
// the exact disposition slice S3 INVERTS (unknown≠idle tightening) — when
// S3 lands, this test flips to asserting the hold.
func TestQueueIdleGateAbsentSessionDispatches(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, root := newDrainTestServer(t, f)

	// No session.created for "ghost" anywhere — the store has no entry.
	st := srv.queues.store(root, "ghost")
	if _, err := st.Enqueue("never seen by the store", nil, QueueSendConfig{Agent: "build"}, ""); err != nil {
		t.Fatal(err)
	}
	waitForDrain(t, 5*time.Second, "dispatch on a store-absent session (absent=allow, W1)", func() bool {
		return f.arrivals() == 1
	})
}

// TestQueueIdleGateWholeTreeFromChildLane pins ROOT-RESOLVED semantics: an
// item on child C1's lane holds while SIBLING C2 is busy — C1's own subtree
// is idle (GateFacts[C1].SubtreeBusy=false) but the effective root's
// aggregate is not. own-subtree-only gating would miss this.
func TestQueueIdleGateWholeTreeFromChildLane(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, root := newDrainTestServer(t, f)
	store := srv.aggForExisting("").Store()

	store.Apply(ev("session.created", `{"info":{"id":"ses_R6"}}`))
	store.Apply(ev("session.created", `{"info":{"id":"ses_C1","parentID":"ses_R6"}}`))
	store.Apply(ev("session.created", `{"info":{"id":"ses_C2","parentID":"ses_R6"}}`))
	store.Apply(ev("session.status", `{"sessionID":"ses_C2","status":{"type":"busy"}}`))
	// Setup pin: C1's OWN subtree is idle while its root-resolved tree is
	// not — the discriminator this test exists for.
	if g := store.GateFacts()["ses_C1"]; g.SubtreeBusy {
		t.Fatalf("setup: own-subtree busy=true, want false (sibling busy must not leak into C1's own subtree fact)")
	}
	if busy, exists := store.TreeBusyForDispatch("ses_C1"); !busy || !exists {
		t.Fatalf("setup: TreeBusyForDispatch(C1)=(%v,%v), want (true,true) — root-resolved read", busy, exists)
	}

	st := srv.queues.store(root, "ses_C1")
	if _, err := st.Enqueue("sibling is running", nil, QueueSendConfig{Agent: "build"}, ""); err != nil {
		t.Fatal(err)
	}
	time.Sleep(500 * time.Millisecond)
	if n := f.arrivals(); n != 0 {
		t.Fatalf("upstream POSTs while sibling busy = %d, want 0 (root-resolved gate)", n)
	}

	store.Apply(ev("session.status", `{"sessionID":"ses_C2","status":{"type":"idle"}}`))
	waitForDrain(t, 5*time.Second, "dispatch after the sibling goes idle", func() bool { return f.arrivals() == 1 })
}

// TestQueueIdleGateFlickerNoDebounce pins corner 1: busy observed, then a
// statuses-driven clear to idle → the NEXT tick dispatches despite the
// recent busy observation. No debounce timer, no cooldown, no remembered
// state — the observation is fresh per tick. (Structurally the gate keeps
// no cross-tick state; the prompt-release bound here pins that no cooldown
// was smuggled in.)
func TestQueueIdleGateFlickerNoDebounce(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, root := newDrainTestServer(t, f)
	store := srv.aggForExisting("").Store()

	store.Apply(ev("session.created", `{"info":{"id":"ses_R7"}}`))
	store.Apply(ev("session.status", `{"sessionID":"ses_R7","status":{"type":"busy"}}`))

	st := srv.queues.store(root, "ses_R7")
	if _, err := st.Enqueue("flicker", nil, QueueSendConfig{Agent: "build"}, ""); err != nil {
		t.Fatal(err)
	}
	time.Sleep(300 * time.Millisecond)
	if n := f.arrivals(); n != 0 {
		t.Fatalf("upstream POSTs while busy = %d, want 0", n)
	}

	// The flicker's idle gap: cleared by a statuses observation. A fresh
	// read at the next tick must release IMMEDIATELY — a cooldown (any
	// remembered-busy state) would delay past the bound below.
	cleared := time.Now()
	store.Apply(ev("session.status", `{"sessionID":"ses_R7","status":{"type":"idle"}}`))
	waitForDrain(t, 5*time.Second, "release on the fresh idle read", func() bool { return f.arrivals() == 1 })
	if elapsed := time.Since(cleared); elapsed > 1*time.Second {
		t.Fatalf("release took %v after the idle observation — a debounce/cooldown appears to have been smuggled in (tick=30ms)", elapsed)
	}
}

// TestQueueIdleGateSecondItemAfterPersistenceBeforeBusy pins corner 4
// (persist-before-Busy): item 1 dispatches on an idle tree and is resolved
// `sent` by the delivery watcher (its correlation id persisted as a user
// message) while the tree STILL shows idle — busy for item 1's turn was
// never observed. Item 2 then dispatches on its OWN tick's fresh read: no
// cross-item memory exists (deliberate W1 allow — the fold-into-running-turn
// gap in this window is the waived evidence-loss class; S3's obligations are
// the flip target).
func TestQueueIdleGateSecondItemAfterPersistenceBeforeBusy(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, root := newDrainTestServer(t, f)
	store := srv.aggForExisting("").Store()

	store.Apply(ev("session.created", `{"info":{"id":"ses_R8"}}`))

	st := srv.queues.store(root, "ses_R8")
	if _, err := st.Enqueue("first", nil, QueueSendConfig{Agent: "build"}, ""); err != nil {
		t.Fatal(err)
	}
	waitForDrain(t, 5*time.Second, "item 1 dispatch on the idle tree", func() bool { return f.arrivals() == 1 })
	items, err := st.List()
	if err != nil {
		t.Fatal(err)
	}
	mid := items[0].OpencodeMsgID
	if mid == "" {
		t.Fatalf("item 1 has no claim-minted correlation id: %+v", items[0])
	}

	// The delivery watcher's sent resolution: OpenCode persists item 1's
	// user message under the exact correlation id. The tree still shows
	// idle (no busy was ever observed for this turn).
	store.Apply(ev("message.updated", `{"info":{"id":"`+mid+`","sessionID":"ses_R8","role":"user"}}`))
	waitForDrain(t, 5*time.Second, "item 1's watcher resolve to sent", func() bool {
		items, err := st.List()
		return err == nil && len(items) == 1 && items[0].State == QueueSent
	})

	// Item 2 must NOT be held by any memory of item 1's dispatch (corner 4:
	// the W1 allow is deliberate).
	if _, err := st.Enqueue("second", nil, QueueSendConfig{Agent: "build"}, ""); err != nil {
		t.Fatal(err)
	}
	waitForDrain(t, 5*time.Second, "item 2 dispatch (no cross-item memory)", func() bool { return f.arrivals() == 2 })
}

// TestQueueIdleGateResumeWaitsForIdle pins corner 7: a certified-resume
// marker (dispatching + RequeuePending) on a busy tree produces ZERO
// upstream POSTs AND the marker is NOT consumed; once idle the resume fires
// with the SAME correlation id.
func TestQueueIdleGateResumeWaitsForIdle(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, root := newDrainTestServer(t, f)
	store := srv.aggForExisting("").Store()

	store.Apply(ev("session.created", `{"info":{"id":"ses_R9"}}`))
	store.Apply(ev("session.created", `{"info":{"id":"ses_C9","parentID":"ses_R9"}}`))
	store.Apply(ev("session.status", `{"sessionID":"ses_C9","status":{"type":"busy"}}`))

	// Seed a requeue-shaped item directly (the shape ONLY
	// RequeueForCertifiedRedelivery produces): dispatching + RequeuePending,
	// fresh DispatchStartedAt (NOT a certify candidate), custody-era.
	st := srv.queues.store(root, "ses_R9")
	st.mu.Lock()
	if err := st.load(); err != nil {
		t.Fatal(err)
	}
	st.items = append(st.items, QueueItem{
		ID:                "rq-1",
		Order:             1,
		State:             QueueDispatching,
		Text:              "requeued while busy",
		SendConfig:        QueueSendConfig{Agent: "build"},
		OpencodeMsgID:     "resume-mid-9",
		ClaimGeneration:   1,
		DispatchStartedAt: time.Now().UnixMilli(),
		RequeuePending:    true,
		Attempts:          []QueueAttempt{{Generation: 1, TransportClass: QueueAttemptConnectFailed, Detail: "dial tcp: refused"}},
	})
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
	st.loaded = true
	st.mu.Unlock()

	// Busy window: zero POSTs AND the marker survives unconsumed (corner 7:
	// the gate runs BEFORE itemForResume's marker consumption).
	time.Sleep(500 * time.Millisecond)
	if n := f.arrivals(); n != 0 {
		t.Fatalf("upstream POSTs while busy with a pending resume = %d, want 0", n)
	}
	items, err := st.List()
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 || !items[0].RequeuePending || items[0].State != QueueDispatching {
		t.Fatalf("resume item = %+v, want dispatching + marker still present (the gate must not burn the marker)", items)
	}

	// Idle → the resume fires with the SAME correlation id.
	store.Apply(ev("session.status", `{"sessionID":"ses_C9","status":{"type":"idle"}}`))
	waitForDrain(t, 5*time.Second, "the resume after idle", func() bool { return f.arrivals() == 1 })
	if ids := f.messageIDs(); len(ids) != 1 || ids[0] != "resume-mid-9" {
		t.Fatalf("resume messageIDs = %v, want exactly the SAME correlation id [resume-mid-9]", ids)
	}
}

// TestQueueIdleGateDoesNotBlockCertifiedPass pins the gate's placement: the
// certified recovery pass (classification) still advances while the lane is
// gate-held. A stale dispatching item with a connect_failed journal classifies
// and gets its requeue marker WHILE the tree is busy (zero POSTs); the marker
// then resumes only once idle — same correlation id.
func TestQueueIdleGateDoesNotBlockCertifiedPass(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, root := newDrainTestServer(t, f)
	store := srv.aggForExisting("").Store()

	store.Apply(ev("session.created", `{"info":{"id":"ses_R10"}}`))
	store.Apply(ev("session.created", `{"info":{"id":"ses_C10","parentID":"ses_R10"}}`))
	store.Apply(ev("session.status", `{"sessionID":"ses_C10","status":{"type":"busy"}}`))

	// A stale dispatching item whose journal proves connect_failed (C2).
	st := srv.queues.store(root, "ses_R10")
	st.mu.Lock()
	if err := st.load(); err != nil {
		t.Fatal(err)
	}
	st.items = append(st.items, QueueItem{
		ID:                "cert-1",
		Order:             1,
		State:             QueueDispatching,
		Text:              "stale while busy",
		SendConfig:        QueueSendConfig{Agent: "build"},
		OpencodeMsgID:     "cert-mid-10",
		ClaimGeneration:   1,
		DispatchStartedAt: time.Now().Add(-time.Hour).UnixMilli(),
		Attempts:          []QueueAttempt{{Generation: 1, TransportClass: QueueAttemptConnectFailed, Detail: "dial tcp: refused"}},
	})
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
	st.loaded = true
	st.mu.Unlock()

	// While the tree is busy: the certified pass classifies C2 and sets the
	// requeue marker (classification ≠ dispatch — the gate never wraps
	// certifiedRecoveryPass), but NO POST happens and the marker is not
	// consumed.
	waitForDrain(t, 5*time.Second, "the certified pass's requeue marker while gate-held", func() bool {
		items, err := st.List()
		return err == nil && len(items) == 1 && items[0].RequeuePending
	})
	if n := f.arrivals(); n != 0 {
		t.Fatalf("upstream POSTs while busy = %d, want 0 (the held marker must not resume)", n)
	}

	// Idle → the resume fires, same correlation id.
	store.Apply(ev("session.status", `{"sessionID":"ses_C10","status":{"type":"idle"}}`))
	waitForDrain(t, 5*time.Second, "the certified resume after idle", func() bool { return f.arrivals() == 1 })
	if ids := f.messageIDs(); len(ids) != 1 || ids[0] != "cert-mid-10" {
		t.Fatalf("resume messageIDs = %v, want exactly [cert-mid-10] (same correlation id)", ids)
	}
}
