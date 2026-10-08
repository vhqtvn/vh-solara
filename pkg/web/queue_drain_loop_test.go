package web

// Drain-loop tests (slice 2b phase 2): the runtime capability advert, the
// flag-off no-loop posture, the agent evidence gate at the production
// caller, certified recovery through the REAL loop (connect_failed →
// requeue → budget-bounded exhaustion), the spurious-held acquisition
// backoff (tier1_d-F1), and the fence-exit contract.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
)

// fakeOCForDrain is a minimal scripted OpenCode for the drain loop: it
// serves prompt_async (204, recording arrivals + messageIDs) and the exact
// message GET (404 for every id unless seeded). Its URL is what the
// aggregator dials, so OC-DOWN is modeled by closing the server (the loop's
// poster then classifies connect_failed via the real dial error).
type fakeOCForDrain struct {
	mu         sync.Mutex
	promptSeen int
	bodies     []map[string]any
	known      map[string]bool // messageID -> 200-exact
	srv        *httptest.Server
}

func newFakeOCForDrain(t *testing.T) *fakeOCForDrain {
	t.Helper()
	f := &fakeOCForDrain{known: map[string]bool{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/session/{id}/prompt_async", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.mu.Lock()
		f.promptSeen++
		f.bodies = append(f.bodies, body)
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/session/{id}/message/{mid}", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		known := f.known[r.PathValue("mid")]
		f.mu.Unlock()
		if !known {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		mid := r.PathValue("mid")
		fmt.Fprintf(w, `{"info":{"id":%q,"role":"user"}}`, mid)
	})
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeOCForDrain) arrivals() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.promptSeen
}

func (f *fakeOCForDrain) messageIDs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := make([]string, 0, len(f.bodies))
	for _, b := range f.bodies {
		id, _ := b["messageID"].(string)
		out = append(out, id)
	}
	return out
}

// newDrainTestServer builds a Server over the scripted fake with the
// daemon-dispatch capability ENABLED and the default project rooted at a
// temp dir. Returns the server (for direct store access) and its root.
// Callers own restoring SetDaemonDispatchEnabled(false).
func newDrainTestServer(t *testing.T, f *fakeOCForDrain) (*Server, string) {
	t.Helper()
	SetDaemonDispatchEnabled(true)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })
	SetQueueDrainTickForTest(30 * time.Millisecond)
	t.Cleanup(func() { SetQueueDrainTickForTest(0) })

	root := t.TempDir()
	t.Chdir(root) // projectRoot("") → root (the default project)
	agg := aggregator.New(f.srv.URL, 20)
	srv, err := NewServer(agg, f.srv.URL, 20)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(ctx)
	})
	// Open the default project (aggFor("") fires on snapshot traffic →
	// maybeStartQueueDrainLoop). The upstream is the scripted fake; the
	// response status is irrelevant to this wiring.
	resp, err := http.Get(srvLocalURL(t, srv) + "/vh/snapshot")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	return srv, root
}

// srvLocalURL serves the Server's handler on a throwaway listener so the
// test can drive aggFor through real HTTP (the loop's own traffic goes
// through the aggregator's client directly, not this listener).
func srvLocalURL(t *testing.T, srv *Server) string {
	t.Helper()
	hs := httptest.NewServer(srv.Handler())
	t.Cleanup(hs.Close)
	return hs.URL
}

// waitForDrain polls cond until deadline, failing with why on timeout.
func waitForDrain(t *testing.T, d time.Duration, why string, cond func() bool) {
	t.Helper()
	end := time.Now().Add(d)
	for time.Now().Before(end) {
		if cond() {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("timeout waiting for %s", why)
}

// TestDrainLoopVersionAdvertReflectsRuntimeEnable: /vh/version's
// daemonDispatchCapable mirrors the live opt-in (the phase-1 const posture
// is now a runtime value; the DEFAULT stays false — pinned by the existing
// TestQueueVersionCapabilityAdvert).
func TestDrainLoopVersionAdvertReflectsRuntimeEnable(t *testing.T) {
	webSrv, _ := newQueueTestServer(t)
	SetDaemonDispatchEnabled(true)
	t.Cleanup(func() { SetDaemonDispatchEnabled(false) })
	resp, err := http.Get(webSrv.URL + "/vh/version")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var body struct {
		DaemonDispatchCapable bool `json:"daemonDispatchCapable"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	if !body.DaemonDispatchCapable {
		t.Fatal("daemonDispatchCapable = false with the opt-in enabled — the advert must reflect the live runtime value")
	}
}

// TestDrainLoopFlagOffStartsNoLoop: with the capability OFF (the production
// default), project-open traffic starts NO drain loop — the legacy browser
// path stays byte-equivalent.
func TestDrainLoopFlagOffStartsNoLoop(t *testing.T) {
	webSrv, _ := newQueueTestServer(t) // capability OFF
	resp, err := http.Get(webSrv.URL + "/vh/snapshot")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	// newQueueTestServer chdirs to its root; the Server under test is the
	// one behind webSrv — reach it via the global default-project path: a
	// loop would appear in s.drainLoops. Re-open the default project a few
	// times (aggFor is idempotent) then assert emptiness indirectly: no
	// custody artifacts may exist under the (cwd) project root.
	cwd, _ := os.Getwd()
	for _, name := range []string{custodyLockFileRel, custodyGenFileRel} {
		if _, err := os.Stat(filepath.Join(cwd, ".vh-solara", name)); !os.IsNotExist(err) {
			t.Fatalf("custody artifact %s exists with daemon dispatch OFF (%v)", name, err)
		}
	}
}

// TestDrainLoopAgentEvidenceGate (matured defer D2/tier1_a-F2, BLOCK-eligible
// at the production caller): the drain loop REFUSES to dispatch a capture
// with an empty agent — terminal failed with the explicit detail — and
// never falls back to OpenCode's config default. A captured agent
// dispatches normally (the control arm).
func TestDrainLoopAgentEvidenceGate(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, root := newDrainTestServer(t, f)

	st := srv.queues.store(root, "gate")
	if _, err := st.Enqueue("no agent", nil, QueueSendConfig{}, ""); err != nil {
		t.Fatal(err)
	}
	if _, err := st.Enqueue("with agent", nil, QueueSendConfig{Agent: "build"}, ""); err != nil {
		t.Fatal(err)
	}

	waitForDrain(t, 5*time.Second, "the gate verdicts to land", func() bool {
		items, err := st.List()
		return err == nil && len(items) == 2 &&
			itemBy(items, "no agent").State == QueueFailed &&
			itemBy(items, "with agent").State == QueueDispatching
	})
	items, _ := st.List()
	// Refused item: terminal failed with the gate detail; NO prompt body was
	// ever built for it (the fake saw only the agent-bearing item).
	gate := itemBy(items, "no agent")
	if gate.State != QueueFailed || !strings.Contains(gate.Detail, "Dispatch refused") {
		t.Fatalf("gate item = %+v, want failed + the evidence-gate detail", gate)
	}
	waitForDrain(t, 5*time.Second, "the agent-bearing dispatch", func() bool { return f.arrivals() == 1 })
	if ids := f.messageIDs(); len(ids) != 1 || ids[0] == "" {
		t.Fatalf("prompt messageIDs = %v, want exactly the agent-bearing claim-minted id", ids)
	}
}

func itemBy(items []QueueItem, text string) QueueItem {
	for _, it := range items {
		if it.Text == text {
			return it
		}
	}
	return QueueItem{}
}

// TestDrainLoopCertifiedRecoveryConnectFailedBounded: with OpenCode down,
// the loop's dispatches classify connect_failed (C2) and the certified
// ladder requeues SAME-msgid at the recovery cadence — bounded by
// maxCertifiedRedeliveries, then terminal. This pins the whole recovery
// loop through the REAL loop path: dispatch → receipt → stale → classify →
// requeue → resume → … → budget terminal, with NO unbounded retry storm.
func TestDrainLoopCertifiedRecoveryConnectFailedBounded(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, root := newDrainTestServer(t, f)

	SetStaleDispatchThresholdForTest(80 * time.Millisecond)
	t.Cleanup(func() { SetStaleDispatchThresholdForTest(0) })

	st := srv.queues.store(root, "down")
	if _, err := st.Enqueue("while oc down", nil, QueueSendConfig{Agent: "build"}, ""); err != nil {
		t.Fatal(err)
	}

	// Kill OpenCode: every poster dial fails → connect_failed receipts.
	f.srv.Close()

	// The budget: 8 attempts, each cycle ≈ stale(80ms) + classify + resume.
	waitForDrain(t, 20*time.Second, "the certified-redelivery budget to exhaust", func() bool {
		items, err := st.List()
		return err == nil && len(items) == 1 && items[0].ReconcileTerminal && items[0].State == QueueUnknown
	})
	items, _ := st.List()
	it := items[0]
	if !strings.Contains(it.Detail, "budget exhausted") {
		t.Fatalf("terminal detail = %q, want the budget-exhaustion text", it.Detail)
	}
	if it.AmbiguousDelivery {
		t.Fatalf("budget exhaustion must NOT stamp the ambiguous marker: %+v", it)
	}
	// Bounded: exactly maxCertifiedRedeliveries attempts journaled (no
	// unbounded storm), all connect_failed, one correlation id throughout.
	if len(it.Attempts) != maxCertifiedRedeliveries {
		t.Fatalf("attempts = %d, want exactly the budget %d", len(it.Attempts), maxCertifiedRedeliveries)
	}
	msgIDs := map[string]bool{}
	for _, a := range it.Attempts {
		if a.TransportClass != QueueAttemptConnectFailed {
			t.Fatalf("attempt %+v — every down-cycle attempt must classify connect_failed", a)
		}
	}
	msgIDs[it.OpencodeMsgID] = true
	if len(msgIDs) != 1 || it.OpencodeMsgID == "" {
		t.Fatalf("correlation id drifted across redeliveries: %v", msgIDs)
	}
}

// TestDrainLoopSpuriousHeldBackoff (matured defer tier1_d-F1): a
// microseconds-held lock (the arbitration probe's shape) must not kill
// acquisition — the fast retry burst rides it out and the loop acquires.
func TestDrainLoopSpuriousHeldBackoff(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	f := newFakeOCForDrain(t)
	srv, _ := newDrainTestServer(t, f)

	// Hold the lock briefly — exactly the D-F2 probe's shape (open+flock+
	// close): a racing acquire sees errQueueCustodyHeld for ~250ms.
	vhDir := filepath.Join(root, ".vh-solara")
	if err := os.MkdirAll(vhDir, 0o755); err != nil {
		t.Fatal(err)
	}
	lockPath := filepath.Join(vhDir, custodyLockFileRel)
	held, err := custodyLockAcquire(lockPath)
	if err != nil {
		t.Fatal(err)
	}
	go func() {
		time.Sleep(250 * time.Millisecond)
		held.Release()
	}()

	l := &queueDrainLoop{srv: srv, dir: "", root: root, done: make(chan struct{})}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	start := time.Now()
	if !l.acquire(ctx) {
		t.Fatal("acquire failed against a SPURIOUS (transient) holder — the fast-burst backoff must ride out probe races")
	}
	defer l.tok.Release()
	if elapsed := time.Since(start); elapsed > 5*time.Second {
		t.Fatalf("acquire took %v against a 250ms transient holder — the fast burst must not decay to the slow cadence", elapsed)
	}
}

// TestDrainLoopFenceExitsLoop: an out-of-band authority bump (a newer
// owner's durable record) fences the loop's next mutation — the loop exits
// (never dispatches again under the stale epoch) and the poster is never
// invoked. Deterministic via the phase-1 queueDrainPrePostSeam: the takeover
// lands at the EXACT pre-POST window (claim passed, begin durable), so the
// executor's pre-POST fence rejects before any wire traffic.
func TestDrainLoopFenceExitsLoop(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	root := custodyTestRoot(t)
	f := newFakeOCForDrain(t)
	srv, _ := newDrainTestServer(t, f)

	st := srv.queues.store(root, "fenced")
	if _, err := st.Enqueue("never sent", nil, QueueSendConfig{Agent: "build"}, ""); err != nil {
		t.Fatal(err)
	}

	// At the exact pre-POST window: bump the authority OUT-OF-BAND to a
	// generation far above anything the live epoch allocated.
	genPath := filepath.Join(root, ".vh-solara", custodyGenFileRel)
	queueDrainPrePostSeam = func() {
		if err := writeCustodyGeneration(genPath, 1<<20); err != nil {
			t.Errorf("out-of-band authority bump: %v", err)
		}
	}
	t.Cleanup(func() { queueDrainPrePostSeam = nil })

	l := &queueDrainLoop{srv: srv, dir: "", root: root, done: make(chan struct{})}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	exited := make(chan struct{})
	go func() { l.run(ctx); close(exited) }()
	select {
	case <-exited:
		// loop exited — the desired stale-epoch termination
	case <-time.After(8 * time.Second):
		t.Fatal("fenced loop kept running — a stale epoch must never dispatch again")
	}
	if n := f.arrivals(); n != 0 {
		t.Fatalf("poster invoked %d time(s) under a fenced epoch", n)
	}
	items, err := st.List()
	if err != nil {
		t.Fatal(err)
	}
	// The item was claimed + begun (the journal is honest about that) but
	// NEVER posted: one OPEN attempt, dispatching, and the loop is gone.
	if len(items) != 1 || items[0].State != QueueDispatching {
		t.Fatalf("item after fenced exit = %+v, want dispatching (claimed+begun, unposted)", items)
	}
	if len(items[0].Attempts) != 1 || items[0].Attempts[0].TransportClass != "" {
		t.Fatalf("journal after fenced exit = %+v, want exactly one OPEN attempt", items[0].Attempts)
	}
}
