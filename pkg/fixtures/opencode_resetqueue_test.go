package fixtures_test

// API-level coverage for the extended /fixture/reset queue-custody semantics
// (the serial web-e2e de-flaker slice): a reset must return the reset scope's
// daemon-side queue/delivery-custody state to clean — no surviving queue
// items, no armed ambiguousDelivery — deterministically.
//
// WHY AN EXTERNAL TEST PACKAGE: the crux is the reset's effect on the REAL
// daemon (pkg/web sessionQueueStore + queueRegistry) driven through the REAL
// HTTP paths (enqueue → claim → resolve → list → /oc/fixture/reset), so this
// file boots the same topology as tools/fixtureserver: fake OpenCode
// (pkg/fixtures) on a private httptest port + real aggregator + real
// web.Server proxying /oc/* to the fake. package fixtures_test may import
// pkg/web (pkg/web does not import pkg/fixtures — no cycle).
//
// Contamination model reproduced here (the ux.spec.ts hung-prompt posture):
// enqueue → claim (mints the OpenCode correlation id, legacy ClaimGeneration
// 0) → resolve "unknown" (the drainer's bounded-timeout abort). The item then
// sits as `unknown` + opencodeMsgID + !reconcileTerminal in the daemon's live
// queue; every queue List spawns a reconcile exact-ID GET; the fake 404s (the
// message was never persisted — the POST never reached it); after
// reconcileMaxAttempts the item terminalizes WITH the AmbiguousDelivery
// marker — the chip that contaminated later serial-lane specs ~60–120s in.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/aggregator"
	"github.com/vhqtvn/vh-solara/pkg/fixtures"
	"github.com/vhqtvn/vh-solara/pkg/web"
)

// resetQHarness is one booted fixtureserver-shaped topology.
type resetQHarness struct {
	t       *testing.T
	demoDir string
	fake    *fixtures.FakeOpenCode
	fakeSrv *httptest.Server
	daemon  *httptest.Server
}

// bootResetQHarness wires fake OpenCode + aggregator + web.Server exactly like
// tools/fixtureserver (minus the SPA/managed-project wiring this coverage does
// not need) against a per-test throwaway demo dir. The daemon's persisted
// state (VH_STATE_DIR) is isolated the same way the fixtureserver isolates it.
func bootResetQHarness(t *testing.T) *resetQHarness {
	t.Helper()
	t.Setenv("VH_STATE_DIR", t.TempDir())
	demoDir := t.TempDir()
	fixtures.SetDemoDir(demoDir)

	fake := fixtures.New()
	fakeSrv := httptest.NewServer(fake.Handler())
	t.Cleanup(fakeSrv.Close)

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	agg := aggregator.New(fakeSrv.URL, 64)
	go agg.Run(ctx)

	srv, err := web.NewServer(agg, fakeSrv.URL, 64)
	if err != nil {
		t.Fatalf("build web server: %v", err)
	}
	daemon := httptest.NewServer(srv.Handler())
	t.Cleanup(daemon.Close)
	t.Cleanup(func() {
		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer shutdownCancel()
		_ = srv.Shutdown(shutdownCtx)
	})
	return &resetQHarness{t: t, demoDir: demoDir, fake: fake, fakeSrv: fakeSrv, daemon: daemon}
}

// queueItemJSON is the slice of a queue List/claim/resolve response this
// coverage asserts on.
type queueItemJSON struct {
	ID                string `json:"id"`
	State             string `json:"state"`
	OpencodeMsgID     string `json:"opencodeMsgID"`
	AmbiguousDelivery bool   `json:"ambiguousDelivery"`
	ReconcileTerminal bool   `json:"reconcileTerminal"`
	Detail            string `json:"detail"`
}

func (h *resetQHarness) do(method, path, body string) (int, []byte) {
	h.t.Helper()
	var rd *bytes.Reader
	if body == "" {
		rd = bytes.NewReader(nil)
	} else {
		rd = bytes.NewReader([]byte(body))
	}
	req, err := http.NewRequest(method, h.daemon.URL+path, rd)
	if err != nil {
		h.t.Fatalf("%s %s: build request: %v", method, path, err)
	}
	// Shared CSRF guard covers mutating /vh/* and /oc/* (GETs are exempt).
	req.Header.Set("X-VH-CSRF", "1")
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatalf("%s %s: %v", method, path, err)
	}
	defer res.Body.Close()
	var buf bytes.Buffer
	if _, err := buf.ReadFrom(res.Body); err != nil {
		h.t.Fatalf("%s %s: read body: %v", method, path, err)
	}
	return res.StatusCode, buf.Bytes()
}

// vhPath folds the demo project dir into a /vh/* path (?dir= — reqDir).
func (h *resetQHarness) vhPath(format string, args ...any) string {
	h.t.Helper()
	base := fmt.Sprintf(format, args...)
	sep := "?"
	if strings.Contains(base, "?") {
		sep = "&"
	}
	return base + sep + "dir=" + url.QueryEscape(h.demoDir)
}

// openProject arms the per-dir aggregator (aggFor → hydrate + queue-GC
// subscriber install) the way the SPA's first load does.
func (h *resetQHarness) openProject() {
	h.t.Helper()
	code, body := h.do(http.MethodGet, h.vhPath("/vh/snapshot"), "")
	if code != http.StatusOK {
		h.t.Fatalf("snapshot: status %d body %s", code, body)
	}
}

func (h *resetQHarness) enqueue(sid, text, intentID string) queueItemJSON {
	h.t.Helper()
	code, body := h.do(http.MethodPost, h.vhPath("/vh/session/%s/queue", sid),
		fmt.Sprintf(`{"text":%q,"intentId":%q}`, text, intentID))
	if code != http.StatusOK {
		h.t.Fatalf("enqueue(%s): status %d body %s", sid, code, body)
	}
	var out struct {
		Item queueItemJSON `json:"item"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		h.t.Fatalf("enqueue(%s): decode %q: %v", sid, body, err)
	}
	return out.Item
}

func (h *resetQHarness) claim(sid string) queueItemJSON {
	h.t.Helper()
	code, body := h.do(http.MethodPost, h.vhPath("/vh/session/%s/queue/claim", sid), "")
	if code != http.StatusOK {
		h.t.Fatalf("claim(%s): status %d body %s", sid, code, body)
	}
	var out struct {
		Item queueItemJSON `json:"item"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		h.t.Fatalf("claim(%s): decode %q: %v", sid, body, err)
	}
	return out.Item
}

func (h *resetQHarness) resolve(sid, itemID, state, detail string) queueItemJSON {
	h.t.Helper()
	code, body := h.do(http.MethodPost, h.vhPath("/vh/session/%s/queue/%s/resolve", sid, itemID),
		fmt.Sprintf(`{"state":%q,"detail":%q}`, state, detail))
	if code != http.StatusOK {
		h.t.Fatalf("resolve(%s/%s→%s): status %d body %s", sid, itemID, state, code, body)
	}
	var out struct {
		Item queueItemJSON `json:"item"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		h.t.Fatalf("resolve(%s/%s): decode %q: %v", sid, itemID, body, err)
	}
	return out.Item
}

func (h *resetQHarness) listQueue(sid string) []queueItemJSON {
	h.t.Helper()
	code, body := h.do(http.MethodGet, h.vhPath("/vh/session/%s/queue", sid), "")
	if code != http.StatusOK {
		h.t.Fatalf("listQueue(%s): status %d body %s", sid, code, body)
	}
	var out struct {
		Items []queueItemJSON `json:"items"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		h.t.Fatalf("listQueue(%s): decode %q: %v", sid, body, err)
	}
	return out.Items
}

// seedHungPromptResidue reproduces the ux.spec.ts hung-prompt posture on sid:
// a claimed (correlation-id-bearing, legacy-era) item resolved to `unknown`
// by the drainer's bounded dispatch timeout. It returns the residue item.
func (h *resetQHarness) seedHungPromptResidue(sid, marker string) queueItemJSON {
	h.t.Helper()
	item := h.enqueue(sid, marker, "intent-"+marker)
	if item.State != "pending" {
		h.t.Fatalf("seed(%s): expected pending after enqueue, got %q", sid, item.State)
	}
	claimed := h.claim(sid)
	if claimed.State != "dispatching" || claimed.OpencodeMsgID == "" {
		h.t.Fatalf("seed(%s): claim must mint the correlation id (got state=%q msg=%q)", sid, claimed.State, claimed.OpencodeMsgID)
	}
	final := h.resolve(sid, claimed.ID, "unknown", "drainer: dispatch timed out (ux.spec hung-prompt posture)")
	if final.State != "unknown" {
		h.t.Fatalf("seed(%s): expected unknown after resolve, got %q", sid, final.State)
	}
	return final
}

func (h *resetQHarness) queueFile(sid string) string {
	h.t.Helper()
	return filepath.Join(h.demoDir, ".vh-solara", "sessions", sid, "queue.json")
}

func (h *resetQHarness) reset(sid string) {
	h.t.Helper()
	path := "/oc/fixture/reset"
	if sid != "" {
		path += "?session=" + url.QueryEscape(sid)
	}
	code, body := h.do(http.MethodPost, path, "")
	if code != http.StatusOK {
		h.t.Fatalf("reset(%q): status %d body %s", sid, code, body)
	}
}

// waitFor polls cond until it holds or the budget expires.
func waitFor(t *testing.T, desc string, budget time.Duration, cond func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(budget)
	for time.Now().Before(deadline) {
		if cond() {
			return true
		}
		time.Sleep(25 * time.Millisecond)
	}
	return cond()
}

// TestFixtureResetCleansDaemonQueueState is the CRUX: after
// POST /oc/fixture/reset?session=demo, the daemon-side queue for the reset
// scope reads clean (no surviving items — including armed/ambiguous ones),
// the persisted queue.json is gone, subsequent queue reads drive NO reconcile
// exact-ID GETs (so ambiguousDelivery can never arm from pre-reset residue),
// and the session itself survives for the next consumer (the store's
// supported deleted-then-recreated shape).
func TestFixtureResetCleansDaemonQueueState(t *testing.T) {
	h := bootResetQHarness(t)
	h.openProject()

	residue := h.seedHungPromptResidue("demo", "hung-"+fmt.Sprint(time.Now().UnixMilli()))
	if residue.OpencodeMsgID == "" {
		t.Fatalf("residue must carry the minted correlation id")
	}
	if items := h.listQueue("demo"); len(items) != 1 || items[0].State != "unknown" {
		t.Fatalf("pre-reset residue not visible: %+v", items)
	}
	if _, err := os.Stat(h.queueFile("demo")); err != nil {
		t.Fatalf("pre-reset queue.json must exist: %v", err)
	}

	h.reset("demo")

	// The live-daemon clean is event-driven (the daemon's queue-GC reacts to
	// the reset's session.deleted on its subscriber goroutine), so bounded-wait
	// the convergence instead of expecting it inline.
	if !waitFor(t, "queue reads clean after reset", 5*time.Second, func() bool {
		return len(h.listQueue("demo")) == 0
	}) {
		items := h.listQueue("demo")
		t.Fatalf("reset must clear the demo queue (got %d items: %+v)", len(items), items)
	}
	if _, err := os.Stat(h.queueFile("demo")); !os.IsNotExist(err) {
		t.Fatalf("reset must remove the demo queue.json (stat err=%v)", err)
	}

	// No arming from pre-reset residue: with the items gone, queue reads must
	// drive ZERO reconcile exact-ID GETs. Drain any in-flight pass first, then
	// snapshot the fake's always-on exact-GET counter and poll.
	time.Sleep(300 * time.Millisecond)
	before := h.fake.ReconcileGetCount()
	for i := 0; i < 10; i++ {
		if items := h.listQueue("demo"); len(items) != 0 {
			t.Fatalf("queue regressed to non-empty on poll %d: %+v", i, items)
		}
		time.Sleep(50 * time.Millisecond)
	}
	if after := h.fake.ReconcileGetCount(); after != before {
		t.Fatalf("post-reset queue polls drove %d reconcile exact-ID GETs — residue can still arm ambiguousDelivery", after-before)
	}

	// The session must survive the reset (next-consumer contract): the store's
	// snapshot still lists demo.
	if !waitFor(t, "demo session survives reset", 5*time.Second, func() bool {
		code, body := h.do(http.MethodGet, h.vhPath("/vh/snapshot"), "")
		return code == http.StatusOK && strings.Contains(string(body), `"id":"demo"`)
	}) {
		t.Fatalf("demo session vanished from the store snapshot after reset")
	}
}

// TestQueueResidueArmsAmbiguousDeliveryWithoutReset is the CONTROL that keeps
// the crux non-vacuous: with NO reset, the same residue DOES arm the
// ambiguousDelivery marker via the reconciler's bounded 404 budget. It passes
// before AND after the reset-semantics change — it pins the contamination
// machinery this harness can observe.
func TestQueueResidueArmsAmbiguousDeliveryWithoutReset(t *testing.T) {
	h := bootResetQHarness(t)
	h.openProject()

	h.seedHungPromptResidue("demo", "arm-"+fmt.Sprint(time.Now().UnixMilli()))

	// Shrink the reconcile cadence so the 3-attempt budget exhausts in test
	// time instead of ~90s. TEST-ONLY override; restored for sibling tests.
	web.SetStaleDispatchThresholdForTest(50 * time.Millisecond)
	t.Cleanup(func() { web.SetStaleDispatchThresholdForTest(0) })

	if !waitFor(t, "residue arms ambiguousDelivery", 10*time.Second, func() bool {
		items := h.listQueue("demo")
		return len(items) == 1 && items[0].AmbiguousDelivery && items[0].ReconcileTerminal
	}) {
		items := h.listQueue("demo")
		t.Fatalf("control failed: residue did not arm ambiguousDelivery (items: %+v)", items)
	}
}

// TestFixtureResetQueueCleanIsSessionScoped pins the scoped form: resetting
// demo must not touch a sibling session's queue.
func TestFixtureResetQueueCleanIsSessionScoped(t *testing.T) {
	h := bootResetQHarness(t)
	h.openProject()

	h.seedHungPromptResidue("demo", "scoped-demo")
	h.seedHungPromptResidue("other", "scoped-other")

	h.reset("demo")

	if !waitFor(t, "demo queue clean", 5*time.Second, func() bool {
		return len(h.listQueue("demo")) == 0
	}) {
		t.Fatalf("scoped reset must clean demo's queue")
	}
	if items := h.listQueue("other"); len(items) != 1 || items[0].State != "unknown" {
		t.Fatalf("scoped reset must leave sibling `other` intact (got %+v)", items)
	}
	if _, err := os.Stat(h.queueFile("other")); err != nil {
		t.Fatalf("sibling queue.json must survive a demo-scoped reset: %v", err)
	}
}

// TestFixtureResetSweepsScopedPromptHoldLatch covers the fixture-side
// in-flight custody sweep: a prompt-hold-parked turn for the reset scope is
// cancelled and JOINED by the reset (never silently delivered later), and the
// latch itself is disarmed.
func TestFixtureResetSweepsScopedPromptHoldLatch(t *testing.T) {
	h := bootResetQHarness(t)
	h.openProject()

	code, body := h.do(http.MethodPost, "/oc/fixture/prompt-hold/arm?session=demo", "")
	if code != http.StatusOK {
		t.Fatalf("prompt-hold arm: status %d body %s", code, body)
	}

	// Fire the prompt_async turn (it parks before persistence/emission).
	const parkedID = "msg_holdpark_reset_1"
	code, _ = h.do(http.MethodPost, "/oc/session/demo/prompt_async",
		fmt.Sprintf(`{"text":"parked turn must not survive reset","messageID":%q}`, parkedID))
	if code != http.StatusNoContent {
		t.Fatalf("prompt_async: status %d (want 204)", code)
	}
	if !waitFor(t, "turn parks on the latch", 5*time.Second, func() bool {
		w := h.fake.PromptHoldWitness("demo")
		held, _ := w["held"].(bool)
		return held
	}) {
		t.Fatalf("turn never parked on the prompt-hold latch")
	}

	h.reset("demo")

	w := h.fake.PromptHoldWitness("demo")
	if armed, _ := w["armed"].(bool); armed {
		t.Fatalf("reset must disarm the scoped prompt-hold latch: %+v", w)
	}
	if held, _ := w["held"].(bool); held {
		t.Fatalf("reset must join the parked turn: %+v", w)
	}
	arrivals, _ := w["arrivals"].([]string)
	persisted, _ := w["persistedUserIDs"].([]string)
	found := false
	for _, id := range arrivals {
		if id == parkedID {
			found = true
		}
	}
	if !found {
		t.Fatalf("arrival witness lost the parked correlation id: %+v", w)
	}
	for _, id := range persisted {
		if id == parkedID {
			t.Fatalf("reset-cancelled turn must never persist: %+v", w)
		}
	}
}

// TestFixtureResetQueueFileSweepNoDaemon pins the deterministic FILE-level
// half of the semantics plus today's request shape: session is required (400),
// and a reset removes the scope's queue.json even when the daemon-side store
// was never materialized in this process (fresh-boot cleanliness).
func TestFixtureResetQueueFileSweepNoDaemon(t *testing.T) {
	h := bootResetQHarness(t)

	code, body := h.do(http.MethodPost, "/oc/fixture/reset", "")
	if code != http.StatusBadRequest {
		t.Fatalf("reset without session must 400 (got %d body %s)", code, body)
	}

	plant := func(sid string) {
		t.Helper()
		dir := filepath.Dir(h.queueFile(sid))
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatalf("plant(%s): mkdir: %v", sid, err)
		}
		if err := os.WriteFile(h.queueFile(sid), []byte(`{"version":1,"items":[]}`), 0o644); err != nil {
			t.Fatalf("plant(%s): write: %v", sid, err)
		}
	}
	plant("demo")
	plant("ghost") // a session id the fixture/store never knew

	h.reset("demo")
	h.reset("ghost")

	for _, sid := range []string{"demo", "ghost"} {
		if _, err := os.Stat(h.queueFile(sid)); !os.IsNotExist(err) {
			t.Fatalf("reset(%s) must remove its queue.json (stat err=%v)", sid, err)
		}
	}
}
