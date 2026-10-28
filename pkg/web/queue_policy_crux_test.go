package web

// RED-FIRST crux test for task `queue-policy-send-now` slice B1: a
// `dispatchPolicy: "now"` item admitted through durable admission MUST
// dispatch while the subtree is observably busy (bypassing ONLY the S2
// busy-eligibility check), while a queue-policy item in the same lane still
// waits — the 2026-10-29 amendment §3 dispatch-gating contract.
//
// RED REACHABILITY: this file deliberately uses ONLY pre-B1 APIs (HTTP
// admission + the existing drain-loop test helpers), so it compiles against
// the pre-policy tree. Against HEAD the `dispatchPolicy` body member is an
// unknown field (silently ignored by decodeBody): the item admits as a
// queue-policy item, the S2 idle gate holds the whole lane while the subtree
// is busy, arrivals stays 0, and the first waitForDrain times out — the red
// signal. Post-B1 the now item dispatches under busy and the test goes green.
//
// Driver is HTTP on purpose: it exercises the REAL admission route
// (validation + normalization + persistence) and the REAL drain loop.

import (
	"runtime"
	"testing"
	"time"
)

func TestQueuePolicyNowDispatchesWhileSubtreeBusy(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, root := newDrainTestServer(t, f)
	store := srv.aggForExisting("").Store()
	webURL := srvLocalURL(t, srv)

	// Canonical tree: root ses_P1 with a busy child — the incident posture
	// (root idle, subtree observably busy).
	store.Apply(ev("session.created", `{"info":{"id":"ses_P1"}}`))
	store.Apply(ev("session.created", `{"info":{"id":"ses_CP","parentID":"ses_P1"}}`))
	store.Apply(ev("session.status", `{"sessionID":"ses_CP","status":{"type":"busy"}}`))
	if g := store.GateFacts()["ses_P1"]; !g.SubtreeBusy {
		t.Fatalf("setup: GateFacts[ses_P1].SubtreeBusy=false, want true (child busy)")
	}

	st := srv.queues.store(root, "ses_P1")
	// The queue-policy item FIRST (older Order; absence = queue), then the
	// now item — cross-category ordering: an eligible now item must pass the
	// OLDER queue item the busy tree blocks.
	qResp := csrfPost(t, webURL+"/vh/session/ses_P1/queue", map[string]any{
		"text": "queue me", "sendConfig": map[string]any{"agent": "build"},
	})
	defer qResp.Body.Close()
	if qResp.StatusCode != 200 {
		t.Fatalf("queue-policy admission: %d", qResp.StatusCode)
	}
	nResp := csrfPost(t, webURL+"/vh/session/ses_P1/queue", map[string]any{
		"text": "send me now", "sendConfig": map[string]any{"agent": "build"},
		"dispatchPolicy": "now",
	})
	defer nResp.Body.Close()
	if nResp.StatusCode != 200 {
		t.Fatalf("now-policy admission: %d", nResp.StatusCode)
	}
	// (The dispatchPolicy echo on the admitted item is pinned in
	// queue_dispatch_policy_test.go — asserting it here would break the
	// HEAD-compilability this red-first file depends on.)

	// THE CRUX: while the subtree is observably busy, the now item
	// dispatches (exactly one upstream POST) …
	waitForDrain(t, 5*time.Second, "the now-policy dispatch while the subtree is observably busy", func() bool {
		return f.arrivals() == 1
	})
	// … and the queue-policy item still waits: stays pending across ticks
	// with no second POST while busy.
	items, err := st.List()
	if err != nil {
		t.Fatal(err)
	}
	if q := itemBy(items, "queue me"); q.State != QueuePending {
		t.Fatalf("queue-policy item = %s, want pending while the subtree is busy (S2 path unchanged)", q.State)
	}
	if n := itemBy(items, "send me now"); n.State != QueueDispatching {
		t.Fatalf("now-policy item = %s, want dispatching", n.State)
	}
	time.Sleep(300 * time.Millisecond)
	if n := f.arrivals(); n != 1 {
		t.Fatalf("upstream POSTs while busy = %d, want exactly 1 (the now item only; the queue item must not leak)", n)
	}

	// The subtree goes idle → the held queue item dispatches (arrivals=2).
	store.Apply(ev("session.status", `{"sessionID":"ses_CP","status":{"type":"idle"}}`))
	waitForDrain(t, 5*time.Second, "the queue-policy dispatch after the subtree goes idle", func() bool {
		return f.arrivals() == 2
	})
	items, err = st.List()
	if err != nil {
		t.Fatal(err)
	}
	if q := itemBy(items, "queue me"); q.State != QueueDispatching {
		t.Fatalf("queue-policy item = %s after idle, want dispatching", q.State)
	}
}
