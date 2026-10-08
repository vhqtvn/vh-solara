package e2e

// Send-net-resilience slice 2b phase 2 e2e: the INCIDENT REPLAY CRUX
// (2026-10-07 shape) under DAEMON CUSTODY —
//
//	client connection dies post-admission (the browser never claims; the
//	legacy claim route is REFUSED while custody is live) → the daemon drain
//	loop owns the dispatch → an OpenCode restart mid-dispatch leaves the
//	async commit un-landed → the post-restart exact-ID GET 404 + the
//	restart-barrier certification (custodyBarrierCertified + OC generation
//	bump) authorize the SAME-msgid certified redelivery → the redispatch
//	commits → exact-ID reconcile resolves sent. EXACTLY ONE committed user
//	message (no duplicate parts/messages — the fixture counts rows and
//	wire messageIDs), ZERO operator action.
//
// The negative twin pins the A2 exclusion: with the topology UNCERTIFIED
// (external OpenCode), the same restart+404 shape must NEVER redeliver —
// the item terminalizes ambiguous with the slice-3 marker.

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/fixtures"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// custodyItemView is the queueItemView superset the custody assertions need.
type custodyItemView struct {
	ID                string `json:"id"`
	State             string `json:"state"`
	OpencodeMsgID     string `json:"opencodeMsgID"`
	Detail            string `json:"detail"`
	ReconcileTerminal bool   `json:"reconcileTerminal"`
	ReconcileAttempts int    `json:"reconcileAttempts"`
	AmbiguousDelivery bool   `json:"ambiguousDelivery"`
	RequeuePending    bool   `json:"requeuePending"`
}

func listCustodyQueue(t *testing.T, sid, dir string) []custodyItemView {
	t.Helper()
	resp, err := http.DefaultClient.Get(queuePath(sid, "", dir))
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	defer resp.Body.Close()
	var out struct {
		Items []custodyItemView `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("list decode: %v", err)
	}
	return out.Items
}

// armCustodyForE2E enables daemon dispatch + wires the worker's
// OpenCode-generation provider to the fixture's restart counter (the
// daemon-side barrier input), for the duration of one test.
func armCustodyForE2E(t *testing.T) {
	t.Helper()
	web.SetStaleDispatchThresholdForTest(200 * time.Millisecond)
	t.Cleanup(func() { web.SetStaleDispatchThresholdForTest(0) })
	web.SetQueueDrainTickForTest(40 * time.Millisecond)
	t.Cleanup(func() { web.SetQueueDrainTickForTest(0) })
	web.SetDaemonDispatchEnabled(true)
	t.Cleanup(func() { web.SetDaemonDispatchEnabled(false) })
	cluster.webSrv.SetOpenCodeGenerationFn(func() uint64 { return cluster.Fake.RestartGeneration() })
	t.Cleanup(func() { cluster.webSrv.SetOpenCodeGenerationFn(nil) })
}

// TestQueueCustodyIncidentReplayCertifiedRedelivery is the PHASE-2 CRUX.
func TestQueueCustodyIncidentReplayCertifiedRedelivery(t *testing.T) {
	armCustodyForE2E(t)

	dir := filepath.Join(t.TempDir(), "cust-incident")
	openProjectForDir(t, dir) // aggFor(dir) → the drain loop starts (flag on)
	sid := fakeSessionForDir(dir)

	// Faithful async persistence: 204 immediately, commit after 400ms —
	// wide enough to interleave a restart between POST #1 and its commit.
	cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncDelayedPersist)
	cluster.Fake.SetPromptAsyncPersistDelay(400 * time.Millisecond)
	t.Cleanup(func() {
		cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncNormal)
		cluster.Fake.SetPromptAsyncPersistDelay(0)
	})

	baseUserMsgs := cluster.Fake.UserMessageCount(sid)
	baseArrivals := cluster.Fake.PromptArrivals(sid)
	baseIDCount := len(cluster.Fake.PromptArrivalMessageIDs(sid)) // -count>1 accumulator baseline

	// THE INCIDENT (2026-10-07 shape): the browser completes ADMISSION (the
	// durable enqueue gesture) and then its connection dies — modeled by
	// never performing the browser-side claim/dispatch/resolve at all. The
	// capture carries an agent (the FE evidence gate's guarantee).
	resp, body := postJSON(t, queuePath(sid, "", dir), map[string]any{
		"text":       "incident replay probe",
		"intentId":   "intent-crux-1",
		"sendConfig": map[string]any{"agent": "build"},
	})
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("enqueue: want 200, got resp=%v body=%s", resp, body)
	}

	// The legacy browser claim is REFUSED while custody is live — the
	// browser is structurally OUT of the dispatch path (D-F2 arbitration),
	// so the dead client cannot strand the item even in principle.
	resp, body = postJSON(t, queuePath(sid, "/claim", dir), nil)
	if resp == nil || resp.StatusCode != http.StatusConflict {
		t.Fatalf("browser claim under live custody: want 409, got resp=%v body=%s", resp, body)
	}
	if resp != nil && !containsCode(body, "queue_custody_active") {
		t.Fatalf("claim refusal body lacks the machine-readable custody code: %s", body)
	}

	// The daemon loop dispatches: POST #1 arrives (204; commit pending in
	// the async window).
	deadline := time.Now().Add(10 * time.Second)
	for cluster.Fake.PromptArrivals(sid)-baseArrivals < 1 {
		if time.Now().After(deadline) {
			t.Fatalf("drain loop never dispatched: arrivals delta=%d", cluster.Fake.PromptArrivals(sid)-baseArrivals)
		}
		time.Sleep(20 * time.Millisecond)
	}

	// OpenCode restarts MID-DISPATCH (inside the async-persist window): the
	// pending commit vanishes with the un-flushed write-ahead — the exact
	// post-restart-404 topology the barrier certifies. The generation bump
	// is what the daemon-side classifier observes.
	cluster.Fake.SimulateRestart()

	// CERTIFIED REDELIVERY + CONVERGENCE, zero operator action: the loop
	// classifies (post-restart GET 404 + restart-since-attempt + certified
	// barrier) → requeues SAME msgid → resumes → POST #2 commits → the
	// exact-ID reconcile resolves sent.
	var final []custodyItemView
	deadline = time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		final = listCustodyQueue(t, sid, dir)
		if len(final) == 1 && final[0].State == "sent" {
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	if len(final) != 1 || final[0].State != "sent" {
		for _, it := range final {
			t.Logf("item %s state=%s terminal=%v ambiguous=%v detail=%q", it.ID, it.State, it.ReconcileTerminal, it.AmbiguousDelivery, it.Detail)
		}
		t.Fatalf("item never reached sent via certified redelivery (last=%+v)", final)
	}

	// EXACTLY ONE committed user message — no duplicate parts/messages.
	if got := cluster.Fake.UserMessageCount(sid) - baseUserMsgs; got != 1 {
		t.Fatalf("UserMessageCount delta=%d, want exactly 1 (no duplicate commits)", got)
	}
	// Exactly TWO wire arrivals — the original + EXACTLY ONE certified
	// redispatch, both carrying the SAME claim-minted correlation id (the
	// mint-at-claim same-msgid contract, wire-witnessed).
	if got := cluster.Fake.PromptArrivals(sid) - baseArrivals; got != 2 {
		t.Fatalf("PromptArrivals delta=%d, want exactly 2 (original + one certified redispatch)", got)
	}
	ids := cluster.Fake.PromptArrivalMessageIDs(sid)
	if len(ids)-baseIDCount != 2 {
		t.Fatalf("arrival messageID tail = %v (base %d), want exactly 2 this run", ids, baseIDCount)
	}
	ids = ids[baseIDCount:]
	if ids[0] == "" || ids[0] != ids[1] {
		t.Fatalf("arrival messageIDs=%v, want two identical non-empty ids (same-msgid redelivery)", ids)
	}
	if final[0].OpencodeMsgID != ids[0] {
		t.Fatalf("item correlation id %q != wire id %q — the journal lost the correlation", final[0].OpencodeMsgID, ids[0])
	}

	t.Logf("slice 2b incident replay verified: item %s sent via post-restart-barrier certified redelivery "+
		"(2 arrivals same msgid %s, 1 committed message, 0 operator actions)", final[0].ID, ids[0])
}

// TestQueueCustodyRestartBarrierExternalNotCertified: the A2 exclusion —
// with OpenCode attached EXTERNALLY, the same restart+404 shape must NEVER
// redeliver (an externally-managed instance can be restarted out-of-band
// and driven by clients this daemon cannot observe). The item terminalizes
// ambiguous with the durable slice-3 marker instead.
func TestQueueCustodyRestartBarrierExternalNotCertified(t *testing.T) {
	armCustodyForE2E(t)
	// The uncertifiable topology: --opencode-url's wiring effect.
	cluster.webSrv.SetExternalOpenCode(true)
	t.Cleanup(func() { cluster.webSrv.SetExternalOpenCode(false) })

	dir := filepath.Join(t.TempDir(), "cust-external")
	openProjectForDir(t, dir)
	sid := fakeSessionForDir(dir)

	cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncDelayedPersist)
	cluster.Fake.SetPromptAsyncPersistDelay(400 * time.Millisecond)
	t.Cleanup(func() {
		cluster.Fake.SetPromptAsyncMode(fixtures.PromptAsyncNormal)
		cluster.Fake.SetPromptAsyncPersistDelay(0)
	})

	baseUserMsgs := cluster.Fake.UserMessageCount(sid)
	baseArrivals := cluster.Fake.PromptArrivals(sid)

	resp, body := postJSON(t, queuePath(sid, "", dir), map[string]any{
		"text":       "external barrier probe",
		"intentId":   "intent-ext-1",
		"sendConfig": map[string]any{"agent": "build"},
	})
	if resp == nil || resp.StatusCode != http.StatusOK {
		t.Fatalf("enqueue: want 200, got resp=%v body=%s", resp, body)
	}

	// Wait for the daemon's POST, then restart inside the async window.
	deadline := time.Now().Add(10 * time.Second)
	for cluster.Fake.PromptArrivals(sid)-baseArrivals < 1 {
		if time.Now().After(deadline) {
			t.Fatalf("drain loop never dispatched: arrivals delta=%d", cluster.Fake.PromptArrivals(sid)-baseArrivals)
		}
		time.Sleep(20 * time.Millisecond)
	}
	cluster.Fake.SimulateRestart()

	// NEVER redispatch: exactly one arrival forever; the bounded ambiguous
	// budget terminalizes the item with the durable marker.
	var final []custodyItemView
	deadline = time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		final = listCustodyQueue(t, sid, dir)
		if len(final) == 1 && final[0].ReconcileTerminal {
			break
		}
		time.Sleep(40 * time.Millisecond)
	}
	if len(final) != 1 || !final[0].ReconcileTerminal {
		t.Fatalf("item never terminalized (last=%+v)", final)
	}
	it := final[0]
	if it.State != "unknown" || !it.AmbiguousDelivery {
		t.Fatalf("terminal item = state=%s ambiguous=%v, want unknown + the ambiguous-delivery marker (the live-uncertain disposition)", it.State, it.AmbiguousDelivery)
	}
	if it.RequeuePending {
		t.Fatalf("external-topology item was requeued — the barrier must NOT certify outside the matrix: %+v", it)
	}
	if got := cluster.Fake.PromptArrivals(sid) - baseArrivals; got != 1 {
		t.Fatalf("PromptArrivals delta=%d, want exactly 1 (NEVER auto-redeliver an uncertifiable class)", got)
	}
	if got := cluster.Fake.UserMessageCount(sid) - baseUserMsgs; got != 0 {
		t.Fatalf("UserMessageCount delta=%d, want 0 (the restarted-out commit vanished; nothing re-landed)", got)
	}

	t.Logf("slice 2b A2 exclusion verified: external-topology restart+404 terminalized ambiguous (1 arrival, 0 commits, marker set)")
}

// containsCode checks a JSON error body for the machine-readable code field.
func containsCode(body []byte, code string) bool {
	var e struct {
		Code string `json:"code"`
	}
	if err := json.Unmarshal(body, &e); err != nil {
		return false
	}
	return e.Code == code
}
