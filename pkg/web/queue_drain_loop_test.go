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
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
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
	disposed   int
	srv        *httptest.Server
}

func newFakeOCForDrain(t *testing.T) *fakeOCForDrain {
	t.Helper()
	f := &fakeOCForDrain{known: map[string]bool{}}
	mux := http.NewServeMux()
	// /instance/dispose: reload-project's upstream eviction (a 204 lets the
	// handler proceed to the aggregator teardown — the drain-loop reload
	// test's precondition).
	mux.HandleFunc("/instance/dispose", func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.disposed++
		f.mu.Unlock()
		w.WriteHeader(http.StatusNoContent)
	})
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

// TestDrainLoopReloadProjectTeardownReleasesCustody (the armed BLOCK defer —
// slice 5): with daemon dispatch ON, reloading a NON-DEFAULT project must tear
// that dir's drain loop down PROMPTLY — the per-loop cancellation fires, the
// loop goroutine exits, custody (the flock) is RELEASED, and the replacement
// loop a fresh project open starts can acquire and dispatch. The pre-fix
// shape (why this was a BLOCK defer): the loop's ctx derived only from the
// server bgCtx, which reload does not cancel, so stopQueueDrainLoop's
// <-l.done wait never completed — /vh/reload-project hung and the custody
// flock stayed wedged until process exit.
func TestDrainLoopReloadProjectTeardownReleasesCustody(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, _ := newDrainTestServer(t, f)
	webURL := srvLocalURL(t, srv)

	// A NON-DEFAULT project dir — reload-project's teardown branch applies
	// only to dir != "" (the default's loop is daemon/process-lifetime).
	dir := t.TempDir()
	root, err := filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}

	// Open the project through real HTTP (aggFor(dir) on first touch →
	// maybeStartQueueDrainLoop registers this dir's loop).
	resp, err := http.Get(webURL + "/vh/snapshot?dir=" + url.QueryEscape(dir))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	// The loop acquires custody: wait for the flock to be HELD (the probe
	// the D-F2 arbitration uses — proof a live custody owner exists).
	lockPath := filepath.Join(root, ".vh-solara", custodyLockFileRel)
	waitForDrain(t, 5*time.Second, "the drain loop's custody acquisition", func() bool {
		return custodyLockHeld(lockPath)
	})

	// THE RELOAD, on a bounded client: the pre-fix handler never returned
	// (stopQueueDrainLoop waited on a done that only bgCtx could close) —
	// this request is the red signal.
	client := &http.Client{Timeout: 15 * time.Second}
	req, err := http.NewRequest(http.MethodPost, webURL+"/vh/reload-project?dir="+url.QueryEscape(dir), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(csrfHeader, "1")
	rresp, err := client.Do(req)
	if err != nil {
		t.Fatalf("/vh/reload-project did not return (drain-loop teardown hang): %v", err)
	}
	defer rresp.Body.Close()
	if rresp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(rresp.Body)
		t.Fatalf("reload-project status = %d, want 200: %s", rresp.StatusCode, b)
	}

	// Custody RELEASED: the flock probe reports free and the registry entry
	// is gone (a second owner may now take the project).
	waitForDrain(t, 5*time.Second, "custody release after teardown", func() bool {
		return !custodyLockHeld(lockPath)
	})
	srv.drainLoopsMu.Lock()
	_, still := srv.drainLoops[dir]
	srv.drainLoopsMu.Unlock()
	if still {
		t.Fatal("drain loop still registered after reload-project teardown")
	}

	// A pending item for the REPLACEMENT loop (enqueued after the teardown,
	// so the first loop never saw it).
	st := srv.queues.store(root, "reload-sid")
	if _, err := st.Enqueue("post-reload send", nil, QueueSendConfig{Agent: "build"}, ""); err != nil {
		t.Fatal(err)
	}

	// Re-open the project: aggFor builds a fresh aggregator and starts the
	// REPLACEMENT loop, which acquires custody (the released flock is
	// retakeable — the wedge is gone) and dispatches the item.
	resp2, err := http.Get(webURL + "/vh/snapshot?dir=" + url.QueryEscape(dir))
	if err != nil {
		t.Fatal(err)
	}
	resp2.Body.Close()
	waitForDrain(t, 5*time.Second, "the replacement loop's custody acquisition", func() bool {
		return custodyLockHeld(lockPath)
	})
	waitForDrain(t, 5*time.Second, "the replacement loop's dispatch", func() bool {
		return f.arrivals() >= 1
	})
	waitForDrain(t, 5*time.Second, "the enqueued item to leave pending", func() bool {
		items, err := st.List()
		return err == nil && len(items) == 1 && items[0].State == QueueDispatching
	})
}

// TestDrainLoopStopDuringPublicationWindow (the slice-5 armed BLOCK defer —
// the l.cancel publication-window race): a stopQueueDrainLoop issued in the
// publication window — after the loop entry is visible in the registry but
// before the loop goroutine is launched — must return PROMPTLY. Pre-fix the
// derived context + its cancel were created AFTER the registry publication,
// so a stop racing into that window saw l.cancel == nil, skipped the cancel,
// and parked on <-l.done forever: only the server-wide bgCtx cancel (never
// fired by reload-project) or the parked loop's own eventual exit could close
// done — the stopper hung. Deterministic via the queueDrainPostPublishSeam
// interleave: the stop is issued inside the exact window, with the stopper
// COMMITTED past its registry read (observed via the teardown's map deletion)
// before the window is allowed to close.
func TestDrainLoopStopDuringPublicationWindow(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, _ := newDrainTestServer(t, f)

	// A NON-DEFAULT dir: stopQueueDrainLoop's teardown path (the default
	// dir's loop is daemon/process-lifetime owned).
	dir := t.TempDir()

	stopReturned := make(chan struct{})
	queueDrainPostPublishSeam = func() {
		go func() {
			srv.stopQueueDrainLoop(dir)
			close(stopReturned)
		}()
		// Commit the stopper past its registry read: the teardown deletes
		// the entry under drainLoopsMu, so poll for the deletion — then
		// give it a beat to execute its cancel check (pre-fix: the nil
		// read) and park on done before this seam returns and the window
		// closes.
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			srv.drainLoopsMu.Lock()
			_, still := srv.drainLoops[dir]
			srv.drainLoopsMu.Unlock()
			if !still {
				break
			}
			time.Sleep(5 * time.Millisecond)
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Cleanup(func() { queueDrainPostPublishSeam = nil })

	// The start, through real HTTP: aggFor(dir) on first touch runs
	// maybeStartQueueDrainLoop, which executes the seam inside the window.
	webURL := srvLocalURL(t, srv)
	resp, err := http.Get(webURL + "/vh/snapshot?dir=" + url.QueryEscape(dir))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	select {
	case <-stopReturned:
		// The concurrent stop returned: it observed the RETAINED
		// per-loop cancel, fired it, and the loop exited.
	case <-time.After(5 * time.Second):
		t.Fatal("stopQueueDrainLoop issued in the publication window never returned — it missed the per-loop cancel (the l.cancel publication race)")
	}
}

// TestDrainLoopLeavesLegacyItemsToGetOnlyReconcile (slice 5, legacy `unknown`
// migration pin): a PRE-custody-era item (legacy browser claim:
// ClaimGeneration==0, no attempt journal) sharing a queue with a custody-era
// item under a LIVE drain loop. The binding posture (design.md "Legacy
// unknown chips"): legacy items are UNCERTIFIABLE — the classifier never
// requeues them (classNone), the loop never claims/requeues them, and their
// ONLY convergence is the passive exact-ID reconcile on the List/load path,
// terminalizing GET-only (fail-closed, NEVER resent — zero auto re-POST) as
// the DISTINCT ambiguous_absent surface (durable AmbiguousDelivery marker —
// the slice-5 migration, review B-F1; journal-bearing stamping is pinned by
// TestAmbiguousTerminalStampsMarker); this test pins the MIXED-ERA runtime
// behavior under the real loop.
func TestDrainLoopLeavesLegacyItemsToGetOnlyReconcile(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("flock semantics — Linux only")
	}
	f := newFakeOCForDrain(t)
	srv, root := newDrainTestServer(t, f)
	webURL := srvLocalURL(t, srv)

	SetStaleDispatchThresholdForTest(80 * time.Millisecond)
	t.Cleanup(func() { SetStaleDispatchThresholdForTest(0) })

	st := srv.queues.store(root, "mixed")

	// Seed the LEGACY item directly into the store (the pre-custody-era
	// stuck shape the 2026-10-07 incident left behind): a browser claim
	// (ClaimGeneration=0, no attempt journal) whose dispatch went silent and
	// whose DispatchStartedAt is already deep-stale. The live loop must
	// NEVER touch it — not via oldestDispatchable (dispatching without a
	// RequeuePending marker is not loop work) and not via the certified pass
	// (ClaimGeneration==0 → uncertifiable).
	st.mu.Lock()
	if err := st.load(); err != nil {
		t.Fatal(err)
	}
	st.items = append(st.items, QueueItem{
		ID:                "legacy-1",
		Order:             1,
		State:             QueueDispatching,
		Text:              "legacy stuck",
		SendConfig:        QueueSendConfig{Agent: "build"},
		OpencodeMsgID:     "legacy-mid-404",
		DispatchStartedAt: time.Now().Add(-time.Hour).UnixMilli(),
	})
	if err := st.save(); err != nil {
		t.Fatal(err)
	}
	st.loaded = true
	st.mu.Unlock()

	// The CUSTODY-era item: the live loop claims + dispatches it.
	if _, err := st.Enqueue("custody era", nil, QueueSendConfig{Agent: "build"}, ""); err != nil {
		t.Fatal(err)
	}
	waitForDrain(t, 10*time.Second, "the loop's dispatch of the custody-era item", func() bool {
		return f.arrivals() == 1
	})

	// Drive the List/load path: the stale legacy dispatching item
	// stale-recovers to `unknown` (recoverStaleDispatchingLocked) and the
	// list-spawned passive reconciler GETs its exact id — 404 every pass —
	// until the bounded budget terminalizes it GET-only.
	waitForDrain(t, 10*time.Second, "the legacy item's GET-only reconcile terminal", func() bool {
		resp, err := http.Get(webURL + "/vh/session/mixed/queue")
		if err != nil {
			return false
		}
		resp.Body.Close()
		items, err := st.List()
		if err != nil {
			return false
		}
		for _, it := range items {
			if it.ID == "legacy-1" {
				return it.State == QueueUnknown && it.ReconcileTerminal
			}
		}
		return false
	})

	// NEVER resent — exactly ONE prompt arrival (the custody-era item), and
	// the legacy correlation id was never POSTed by any path.
	if n := f.arrivals(); n != 1 {
		t.Fatalf("prompt arrivals = %d, want exactly 1 (the custody item only — legacy items are never resent)", n)
	}
	ids := f.messageIDs()
	items, err := st.List()
	if err != nil {
		t.Fatal(err)
	}
	var legacy, custody QueueItem
	for _, it := range items {
		switch it.ID {
		case "legacy-1":
			legacy = it
		default:
			custody = it
		}
	}
	if len(ids) != 1 || ids[0] == "" || ids[0] != custody.OpencodeMsgID {
		t.Fatalf("prompt messageIDs = %v, want exactly the custody item's claim-minted id (%q); the legacy id %q must never be re-POSTed", ids, custody.OpencodeMsgID, legacy.OpencodeMsgID)
	}
	// The legacy item's terminal is the designed DISTINCT ambiguous_absent
	// surface (SLICE 5 migration, review B-F1: design.md "Legacy `unknown`
	// chips ... upgrade to `ambiguous_absent`, GET-only, never auto-resent"):
	// the durable AmbiguousDelivery marker is stamped by the passive
	// reconciler's budget terminalization — the FE's slice-3 ambiguous chip
	// (verbatim warning + Wait/Copy-text/Send-new-message) keys on the marker
	// alone — while the item stays GET-only, never re-sent, and the era
	// markers stay intact (never claimed/journaled by the custody loop).
	if !legacy.AmbiguousDelivery {
		t.Fatalf("legacy terminal lacks the ambiguous_absent marker: %+v — slice 5 migrates legacy unknown items onto the distinct ambiguous surface", legacy)
	}
	if !strings.Contains(legacy.Detail, "Reconcile terminal") {
		t.Fatalf("legacy terminal detail = %q, want the GET-only reconcile terminal text", legacy.Detail)
	}
	if !strings.Contains(legacy.Detail, "Pre-custody message") {
		t.Fatalf("legacy terminal detail = %q, want the pre-custody ambiguous framing (delivery could not be confirmed; never re-sent)", legacy.Detail)
	}
	if legacy.ClaimGeneration != 0 || len(legacy.Attempts) != 0 {
		t.Fatalf("legacy item was touched by the custody era: ClaimGeneration=%d Attempts=%d", legacy.ClaimGeneration, len(legacy.Attempts))
	}
}
