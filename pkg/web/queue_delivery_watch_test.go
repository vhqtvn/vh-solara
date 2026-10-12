package web

// Tests for the early delivery-resolution watcher (queue_delivery_watch.go):
// a user message persisted under a dispatching item's EXACT correlation id
// resolves the item to sent immediately (the 2026-10-12 "Sending… for ~30s
// after delivery" bug), while every non-matching shape — legacy-era claims,
// pending items, assistant messages, other sessions, absent ids — keeps its
// existing disposition (the 30s stale-recovery path owns genuinely ambiguous
// dispatches, unchanged).

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/opencode"
)

// seedDeliveryWatchStore installs a fixture queue for "ses1" under root with:
//
//	d1  dispatching, CUSTODY-era claim (ClaimGeneration 1), msg id "msg_d1"
//	d2  dispatching, LEGACY claim (ClaimGeneration 0),      msg id "msg_d2"
//	rq  dispatching, custody-era + RequeuePending,          msg id "msg_rq"
//	p1  pending
//
// DispatchStartedAt is FRESH (now): nothing here is stale, so the 30s
// stale-recovery pass would not touch any of these items during the test —
// any resolution observed must have come from the watcher.
func seedDeliveryWatchStore(t *testing.T, srv *Server, root string) *sessionQueueStore {
	t.Helper()
	s := srv.queues.store(root, "ses1")
	s.mu.Lock()
	s.load()
	s.order = 4
	now := time.Now().UnixMilli()
	s.items = []QueueItem{
		{ID: "d1", Order: 1, State: QueueDispatching, OpencodeMsgID: "msg_d1", ClaimGeneration: 1, DispatchStartedAt: now, Attempts: []QueueAttempt{{Generation: 1, StartedAt: now, TransportClass: QueueAttemptAccepted2xx}}},
		{ID: "d2", Order: 2, State: QueueDispatching, OpencodeMsgID: "msg_d2", ClaimGeneration: 0, DispatchStartedAt: now},
		{ID: "rq", Order: 3, State: QueueDispatching, OpencodeMsgID: "msg_rq", ClaimGeneration: 1, DispatchStartedAt: now, RequeuePending: true},
		{ID: "p1", Order: 4, State: QueuePending},
	}
	s.save()
	s.loaded = true
	s.mu.Unlock()
	return s
}

// itemByIDRaw reads the raw durable state (no List-time recovery passes).
func itemByIDRaw(t *testing.T, s *sessionQueueStore, id string) QueueItem {
	t.Helper()
	for _, it := range readQueueItemsRaw(t, s.path) {
		if it.ID == id {
			return it
		}
	}
	t.Fatalf("item %s not found in queue.json", id)
	return QueueItem{}
}

// TestQueueDeliveryWatchPipeline — the END-TO-END pin. A real message.updated
// WIRE event fed through the state pipeline's normal ingestion path (Store.Apply
// → Translate → reducer → KindMessageUpsert emit → the subscriber
// installQueueDeliveryWatcher arms) must resolve the matching custody-era
// dispatching item to sent. Discriminator arms prove the negative space:
// an assistant-role message, a user message for ANOTHER session, and a user
// message with an unrelated id must each leave every item untouched (no
// event = the 30s stale path still owns the item; nothing here is stale, so
// "untouched" is observable as still-dispatching).
func TestQueueDeliveryWatchPipeline(t *testing.T) {
	const deadURL = "http://127.0.0.1:1"
	agg := aggregator.New(deadURL, 100)
	srv, err := NewServer(agg, deadURL, 100)
	if err != nil {
		t.Fatal(err)
	}
	// LIFO cleanup: agg.Stop FIRST (closes the store's subscribers → retires
	// the watcher goroutine → lifecycleWG drains), THEN Shutdown.
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})
	t.Cleanup(agg.Stop)

	root := t.TempDir()
	s := seedDeliveryWatchStore(t, srv, root)
	srv.installQueueDeliveryWatcher(root, agg)

	// Discriminator 1: assistant role with d1's exact id — no resolution.
	agg.Store().Apply(ev("message.updated", `{"info":{"id":"msg_d1","sessionID":"ses1","role":"assistant"}}`))
	// Discriminator 2: user role, OTHER session — no resolution.
	agg.Store().Apply(ev("message.updated", `{"info":{"id":"msg_d1","sessionID":"ses_other","role":"user"}}`))
	// Discriminator 3: user role, this session, UNRELATED id — no resolution.
	agg.Store().Apply(ev("message.updated", `{"info":{"id":"msg_unrelated","sessionID":"ses1","role":"user"}}`))
	time.Sleep(150 * time.Millisecond)
	for _, id := range []string{"d1", "d2", "rq"} {
		if it := itemByIDRaw(t, s, id); it.State != QueueDispatching {
			t.Fatalf("item %s resolved by a non-matching event: %+v", id, it)
		}
	}

	// Positive arm: the dispatched user message persists (the exact wire
	// shape opencode emits for the prompt_async persistence commit).
	agg.Store().Apply(ev("message.updated", `{"info":{"id":"msg_d1","sessionID":"ses1","role":"user"}}`))

	deadline := time.Now().Add(3 * time.Second)
	for {
		if it := itemByIDRaw(t, s, "d1"); it.State == QueueSent {
			if it.Detail != deliveredSentDetail {
				t.Fatalf("d1 resolved with unexpected detail: %q", it.Detail)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("user-message wire event never resolved the custody-era dispatching item (subscriber kind/payload mismatch?): %+v", itemByIDRaw(t, s, "d1"))
		}
		time.Sleep(10 * time.Millisecond)
	}

	// The non-matching shapes keep their existing dispositions: the legacy
	// claim (the browser path owns its resolution) and the fresh pending
	// item are untouched; the requeuePending item is ALSO untouched here
	// (no event for msg_rq fired in this arm).
	if it := itemByIDRaw(t, s, "d2"); it.State != QueueDispatching {
		t.Fatalf("legacy-era item d2 resolved by the watcher (must be browser-owned): %+v", it)
	}
	if it := itemByIDRaw(t, s, "p1"); it.State != QueuePending {
		t.Fatalf("pending item p1 mutated by the watcher: %+v", it)
	}
	if it := itemByIDRaw(t, s, "rq"); it.State != QueueDispatching || !it.RequeuePending {
		t.Fatalf("requeuePending item rq mutated without its own event: %+v", it)
	}

	// Idempotence: the SAME event again (message.updated refreshes are
	// normal) resolves to the identical (state, detail) — the resolve
	// matrix's successful no-op. It must not conflict or bump timestamps.
	agg.Store().Apply(ev("message.updated", `{"info":{"id":"msg_d1","sessionID":"ses1","role":"user"}}`))
	time.Sleep(100 * time.Millisecond)
	d1 := itemByIDRaw(t, s, "d1")
	if d1.State != QueueSent || d1.Detail != deliveredSentDetail {
		t.Fatalf("repeated delivery event rewrote the terminal resolution: %+v", d1)
	}
}

// TestQueueDeliveryWatchResolvesRequeuePending — the certified-redelivery
// composition: when the ORIGINAL POST's persistence is observed while a
// requeue awaits its resume (RequeuePending, same correlation id), the
// watcher resolves the item to sent; itemForResume then aborts the resume
// cleanly (its designed "state changed since classification" path) and the
// needless same-msgid redelivery never runs.
func TestQueueDeliveryWatchResolvesRequeuePending(t *testing.T) {
	const deadURL = "http://127.0.0.1:1"
	agg := aggregator.New(deadURL, 100)
	srv, err := NewServer(agg, deadURL, 100)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})
	t.Cleanup(agg.Stop)

	root := t.TempDir()
	s := seedDeliveryWatchStore(t, srv, root)
	srv.installQueueDeliveryWatcher(root, agg)

	agg.Store().Apply(ev("message.updated", `{"info":{"id":"msg_rq","sessionID":"ses1","role":"user"}}`))
	deadline := time.Now().Add(3 * time.Second)
	for {
		if it := itemByIDRaw(t, s, "rq"); it.State == QueueSent {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("persistence event for the original POST never resolved the requeued item: %+v", itemByIDRaw(t, s, "rq"))
		}
		time.Sleep(10 * time.Millisecond)
	}
	// The designed resume-abort: itemForResume finds the item no longer
	// (dispatching && RequeuePending) and returns ok=false — no re-POST.
	if _, ok, err := s.itemForResume("rq"); err != nil || ok {
		t.Fatalf("itemForResume after delivery resolution = (%v, %v), want (false, nil)", ok, err)
	}
}

// TestQueueResolveDeliveredByMsgIDUnit — the store-level contract, exercised
// directly (no pipeline): exact-id matches on custody-era dispatching items
// only; every other shape is a silent no-op that leaves the reconcile budget
// untouched (the 30s recovery machinery owns those items).
func TestQueueResolveDeliveredByMsgIDUnit(t *testing.T) {
	root := t.TempDir()
	s := seedDeliveryWatchStore(t, &Server{queues: newQueueRegistry()}, root)
	now := time.Now().UnixMilli()

	// Non-matching ids / shapes: no-ops.
	s.resolveDeliveredByMsgID("")
	s.resolveDeliveredByMsgID("msg_absent")
	if it := itemByIDRaw(t, s, "d1"); it.State != QueueDispatching {
		t.Fatalf("absent id resolved d1: %+v", it)
	}
	// Legacy-era item: the browser path owns its resolution — watcher skips.
	s.resolveDeliveredByMsgID("msg_d2")
	if it := itemByIDRaw(t, s, "d2"); it.State != QueueDispatching {
		t.Fatalf("legacy-era item resolved by exact-id watcher: %+v", it)
	}
	// Pending item has no OpencodeMsgID by construction — nothing to match.

	// Matching custody-era item resolves.
	s.resolveDeliveredByMsgID("msg_d1")
	d1 := itemByIDRaw(t, s, "d1")
	if d1.State != QueueSent || d1.Detail != deliveredSentDetail || d1.ResolvedAt == 0 {
		t.Fatalf("custody-era dispatching item not resolved: %+v", d1)
	}
	if d1.ResolvedAt < now {
		t.Fatalf("ResolvedAt not stamped: %+v", d1)
	}
	// The reconcile budget is UNTOUCHED — the watcher is positive-evidence
	// resolution, never a reconcile pass.
	if d1.ReconcileAttempts != 0 || d1.ReconcileTerminal {
		t.Fatalf("delivery resolution consumed the reconcile budget: %+v", d1)
	}
	// Idempotent re-call: the item is now terminal; no match, no conflict.
	s.resolveDeliveredByMsgID("msg_d1")
	if it := itemByIDRaw(t, s, "d1"); it.State != QueueSent || it.Detail != deliveredSentDetail || it.ResolvedAt != d1.ResolvedAt {
		t.Fatalf("repeated exact-id resolution rewrote the terminal state: %+v", it)
	}
}

// TestQueueDeliveryWatchDoesNotTouchAmbiguousWithoutEvent — the no-regression
// arm: an accepted_2xx dispatch with NO persistence event (the genuinely
// ambiguous class — e.g. the POST was written but the forked persist died)
// must stay dispatching until the 30s stale threshold, with its journal and
// reconcile budget intact. The watcher sees unrelated traffic and must not
// act. (The full 30s-ladder behavior is separately pinned by the
// certified-recovery tests; this asserts the watcher does not preempt it.)
func TestQueueDeliveryWatchDoesNotTouchAmbiguousWithoutEvent(t *testing.T) {
	const deadURL = "http://127.0.0.1:1"
	agg := aggregator.New(deadURL, 100)
	srv, err := NewServer(agg, deadURL, 100)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})
	t.Cleanup(agg.Stop)

	root := t.TempDir()
	s := seedDeliveryWatchStore(t, srv, root)
	srv.installQueueDeliveryWatcher(root, agg)

	// Heavy unrelated traffic on the same session: assistant streaming,
	// parts, another user message. NONE of it matches d1/d2's exact ids.
	agg.Store().Apply(ev("message.updated", `{"info":{"id":"msg_other_user","sessionID":"ses1","role":"user"}}`))
	agg.Store().Apply(ev("message.part.updated", `{"part":{"id":"prt_1","messageID":"msg_other_user","sessionID":"ses1","type":"text","text":"hi"}}`))
	agg.Store().Apply(ev("message.updated", `{"info":{"id":"msg_asst","sessionID":"ses1","role":"assistant"}}`))
	time.Sleep(150 * time.Millisecond)

	for _, id := range []string{"d1", "d2"} {
		it := itemByIDRaw(t, s, id)
		if it.State != QueueDispatching {
			t.Fatalf("ambiguous item %s resolved without its own persistence event: %+v", id, it)
		}
		if it.ReconcileAttempts != 0 || it.ReconcileTerminal || it.RequeuePending {
			t.Fatalf("ambiguous item %s had its recovery machinery touched: %+v", id, it)
		}
	}
	// d1's accepted_2xx journal receipt is intact for the certified ladder.
	if d1 := itemByIDRaw(t, s, "d1"); len(d1.Attempts) != 1 || d1.Attempts[0].TransportClass != QueueAttemptAccepted2xx {
		t.Fatalf("accepted_2xx journal receipt not preserved: %+v", d1.Attempts)
	}
}

// Compile-time guard: the watcher composes with the opencode wire event type
// used by the pipeline tests (guards against a silent import drift).
var _ = opencode.Event{Type: "", Properties: json.RawMessage("{}")}
