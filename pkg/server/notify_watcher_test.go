package server

// notify_watcher_test.go — lane-1 co-located tests for the fleet-condition
// watcher + async sender (slice S2; see notify_watcher.go). The rollup
// seam is driven with the SAME fleet fakes as status_test.go
// (fetchWorkerJSON scripted bodies); the transport is either a scripted
// in-memory notifier (policy tests) or the REAL FCMNotifier against the
// fake OAuth+FCM pair (the crux). Covers:
//
//   - the transition matrix (appear / change-increase push /
//     change-decrease history-only / clear push + state reset);
//   - cooldown suppression and the count-increase bypass, incl. the
//     partial-recovery flap case (3→2→3 with lastPushed 3);
//   - clear suppression under incomplete coverage (held state, nothing
//     recorded) and the complete-coverage clear;
//   - scope filtering (disabled token, conditions-subset token);
//   - retirement on UNREGISTERED vs NO retirement on a bare 404;
//   - the no-start posture (store/transport gating);
//   - THE NOBODY-POLLS OBSERVATION: a transition is detected and pushed
//     with ZERO requests to GET /vh/fleet/status;
//   - THE CRUX (behavioral closure): rollup seam → watcher → sender →
//     fake FCM receives the full data vocabulary, and the history
//     round-trip (GET /vh/notify/history) records the delivery.

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/auth"
	"github.com/vhqtvn/vh-solara/pkg/state"
)

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

// scriptedSend is one recorded Send call.
type scriptedSend struct {
	Token string
	Msg   NotifyMessage
}

// scriptedNotifier is an in-memory Notifier with a scriptable outcome.
type scriptedNotifier struct {
	mu      sync.Mutex
	sends   []scriptedSend
	respond func(token string, msg NotifyMessage) error
}

func (s *scriptedNotifier) Name() string { return "scripted" }

func (s *scriptedNotifier) Send(_ context.Context, token string, msg NotifyMessage) error {
	s.mu.Lock()
	s.sends = append(s.sends, scriptedSend{Token: token, Msg: msg})
	respond := s.respond
	s.mu.Unlock()
	if respond == nil {
		return nil
	}
	return respond(token, msg)
}

func (s *scriptedNotifier) count() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return len(s.sends)
}

func (s *scriptedNotifier) send(i int) scriptedSend {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sends[i]
}

// newWatcherDaemon builds a daemon whose fleet acquisition is scripted
// (the status_test.go fleet fakes), with a loaded notify store (history
// path installed) and a scripted transport.
func newWatcherDaemon(t *testing.T, sn *scriptedNotifier) (*Daemon, *fleetFake) {
	t.Helper()
	d := NewDaemon(":0", ":0", "")
	fake := newFleetFake()
	d.fetchWorkerJSON = fake.fetch
	loadNotifyStore(t, d)
	if sn != nil {
		d.SetNotifyTransport(sn)
	}
	return d, fake
}

// expireFleetCache rewinds the current generation's publishedAt so the
// NEXT serve() considers the cache past-TTL and refreshes (the TTL
// cannot simply be zeroed: serve()'s bounded loop resolves by finding
// the cache FRESH right after a refresh, so an always-elapsed TTL makes
// every serve() spin out). Deterministic, no sleeps — manual ticks use
// this to see fixture flips back-to-back.
func expireFleetCache(d *Daemon) {
	d.fleetStatus.mu.Lock()
	if d.fleetStatus.cur != nil {
		d.fleetStatus.cur.publishedAt = time.Now().Add(-time.Hour)
	}
	d.fleetStatus.mu.Unlock()
}

// tickExpire expires the cached generation and ticks the watcher once —
// the standard manual step in these tests (every tick must observe the
// CURRENT fixture, not a still-warm cache).
func tickExpire(d *Daemon, w *notifyWatcher) {
	expireFleetCache(d)
	w.tick(context.Background())
}

// enrollNotifyToken registers one enabled all-conditions token (the
// default recipient of these tests).
func enrollNotifyToken(t *testing.T, d *Daemon, token string) {
	t.Helper()
	if _, _, err := d.notifyStore.submit(token, "phone"); err != nil {
		t.Fatal(err)
	}
}

// setWorkerPerm scripts worker/dir to carry exactly n permission-pending
// sessions (the lean-gates acquisition path; both required bodies set).
func setWorkerPerm(fake *fleetFake, worker, dir string, n int) {
	fake.setBody(worker, "/vh/projects", fleetProjectsBody(dir))
	gate := map[string]state.GateFacts{}
	for i := 0; i < n; i++ {
		gate[fmt.Sprintf("sess%d", i)] = fleetGF("busy", true, false)
	}
	fake.setBody(worker, fleetGatesPath(dir), fleetGatesBody(map[string]map[string]state.GateFacts{dir: gate}))
}

// tickOnce advances the watcher by exactly one observation.
func tickOnce(t *testing.T, d *Daemon, cooldown time.Duration) *notifyWatcher {
	t.Helper()
	w := newNotifyWatcher(d, time.Hour, cooldown)
	tickExpire(d, w)
	return w
}

// ---------------------------------------------------------------------------
// Transition matrix
// ---------------------------------------------------------------------------

// TestNotifyWatcher_TransitionMatrix drives appear → increase →
// decrease → clear and pins what pushes, what history records, and the
// message bodies/data vocabulary at each step.
func TestNotifyWatcher_TransitionMatrix(t *testing.T) {
	sn := &scriptedNotifier{}
	d, fake := newWatcherDaemon(t, sn)
	fleetAddOnline(t, d.Registry, "alpha")
	setWorkerPerm(fake, "alpha", "/repo", 0)

	if _, _, err := d.notifyStore.submit("watcher-token-all-conditions", "phone"); err != nil {
		t.Fatal(err)
	}

	w := newNotifyWatcher(d, time.Hour, 0)
	tickExpire(d, w) // baseline over an empty condition set

	// appear: 2 pending.
	setWorkerPerm(fake, "alpha", "/repo", 2)
	tickExpire(d, w)
	if got := sn.count(); got != 1 {
		t.Fatalf("appearance: want 1 send, got %d", got)
	}
	s := sn.send(0)
	if s.Msg.Title != "vh-solara" || s.Msg.Body != "2 permissions pending" {
		t.Errorf("appearance message: title=%q body=%q", s.Msg.Title, s.Msg.Body)
	}
	wantData := map[string]string{
		"vh_kind": "fleet", "vh_event": "appeared", "vh_condition": "permission_pending", "vh_count": "2",
	}
	for k, v := range wantData {
		if s.Msg.Data[k] != v {
			t.Errorf("appearance data[%s]=%q, want %q (full: %v)", k, s.Msg.Data[k], v, s.Msg.Data)
		}
	}
	if ts := s.Msg.Data["vh_ts"]; ts == "" {
		t.Error("appearance data must carry vh_ts")
	} else if _, err := time.Parse(time.RFC3339, ts); err != nil {
		t.Errorf("vh_ts not RFC3339: %q (%v)", ts, err)
	}
	if s.Token != "watcher-token-all-conditions" {
		t.Errorf("send target = %q", s.Token)
	}

	// increase: pushed.
	setWorkerPerm(fake, "alpha", "/repo", 3)
	tickExpire(d, w)
	if got := sn.count(); got != 2 {
		t.Fatalf("increase: want a second send, got %d", got)
	}
	if s := sn.send(1); s.Msg.Data["vh_event"] != "changed" || s.Msg.Data["vh_count"] != "3" || s.Msg.Body != "3 permissions pending" {
		t.Errorf("increase message: %+v", s.Msg)
	}

	// decrease: recorded in history, NOT pushed.
	setWorkerPerm(fake, "alpha", "/repo", 1)
	tickExpire(d, w)
	if got := sn.count(); got != 2 {
		t.Fatalf("decrease must not push, sends=%d", got)
	}

	// clear (complete coverage — the only worker is ok): pushed, count 0.
	setWorkerPerm(fake, "alpha", "/repo", 0)
	tickExpire(d, w)
	if got := sn.count(); got != 3 {
		t.Fatalf("clear: want a third send, got %d", got)
	}
	if cs := sn.send(2); cs.Msg.Data["vh_event"] != "cleared" || cs.Msg.Data["vh_count"] != "0" {
		t.Errorf("clear message data: %+v", cs.Msg.Data)
	} else if cs.Msg.Body != "1 permission pending (cleared)" {
		t.Errorf("clear body = %q, want the last-count phrase + (cleared)", cs.Msg.Body)
	}

	// History recorded all four transitions, ascending, with the push
	// outcomes on the delivery rows.
	entries := d.notifyHistory.queryAllForTest()
	if len(entries) != 4 {
		t.Fatalf("history: want 4 entries, got %d (%+v)", len(entries), entries)
	}
	wantActions := []string{"appeared", "changed", "changed", "cleared"}
	wantDeliveries := []int{1, 1, 0, 1}
	for i, e := range entries {
		if e.Action != wantActions[i] {
			t.Errorf("entry %d action = %q, want %q", i, e.Action, wantActions[i])
		}
		if len(e.Deliveries) != wantDeliveries[i] {
			t.Errorf("entry %d deliveries = %d, want %d", i, len(e.Deliveries), wantDeliveries[i])
		}
	}
	if entries[2].Count != 1 || len(entries[2].Deliveries) != 0 {
		t.Errorf("decrease entry: %+v", entries[2])
	}
}

// TestNotifyWatcher_FirstTickIsSilentBaseline pins the restart posture:
// standing conditions at watcher start are adopted WITHOUT pushes or
// history (a controller restart is not news).
func TestNotifyWatcher_FirstTickIsSilentBaseline(t *testing.T) {
	sn := &scriptedNotifier{}
	d, fake := newWatcherDaemon(t, sn)
	fleetAddOnline(t, d.Registry, "alpha")
	setWorkerPerm(fake, "alpha", "/repo", 4)

	enrollNotifyToken(t, d, "watcher-token-baseline")
	w := newNotifyWatcher(d, time.Hour, 0)
	tickExpire(d, w)
	if got := sn.count(); got != 0 {
		t.Errorf("baseline tick pushed %d sends — must be silent", got)
	}
	if entries := d.notifyHistory.queryAllForTest(); len(entries) != 0 {
		t.Errorf("baseline tick recorded %d history entries — must be silent", len(entries))
	}
	// A subsequent CHANGE is still detected against that baseline.
	setWorkerPerm(fake, "alpha", "/repo", 5)
	tickExpire(d, w)
	if got := sn.count(); got != 1 {
		t.Errorf("increase after baseline: sends=%d, want 1", got)
	}
}

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

// TestNotifyWatcher_CooldownSuppressionAndIncreaseBypass pins the flap
// rule with a long cooldown: a partial recovery that does not EXCEED the
// last-pushed count is suppressed; a count past it bypasses the cooldown.
func TestNotifyWatcher_CooldownSuppressionAndIncreaseBypass(t *testing.T) {
	sn := &scriptedNotifier{}
	d, fake := newWatcherDaemon(t, sn)
	fleetAddOnline(t, d.Registry, "alpha")
	setWorkerPerm(fake, "alpha", "/repo", 0)
	enrollNotifyToken(t, d, "watcher-token-cooldown")
	w := newNotifyWatcher(d, time.Hour, time.Hour) // cooldown 1h
	tickExpire(d, w)                               // baseline

	setWorkerPerm(fake, "alpha", "/repo", 3)
	tickExpire(d, w)
	if got := sn.count(); got != 1 {
		t.Fatalf("appearance: sends=%d, want 1", got)
	}

	// Decrease: never pushed, only history.
	setWorkerPerm(fake, "alpha", "/repo", 2)
	tickExpire(d, w)
	if got := sn.count(); got != 1 {
		t.Fatalf("decrease pushed: sends=%d", got)
	}

	// Partial rise back to the last-pushed count (2→3, lastPushed 3):
	// NOT an increase past what the operator knows → suppressed by the
	// active cooldown, history-only.
	setWorkerPerm(fake, "alpha", "/repo", 3)
	tickExpire(d, w)
	if got := sn.count(); got != 1 {
		t.Fatalf("partial rise must be cooldown-suppressed, sends=%d", got)
	}
	// The suppressed rise is STILL history-recorded (all three
	// transitions so far: appeared push, decrease, suppressed rise) with
	// an empty delivery set.
	entries := d.notifyHistory.queryAllForTest()
	if len(entries) != 3 {
		t.Fatalf("history after the suppressed rise: %+v", entries)
	}
	if sup := entries[2]; sup.Action != "changed" || sup.Count != 3 || len(sup.Deliveries) != 0 {
		t.Fatalf("suppressed rise must be history-recorded without deliveries: %+v", sup)
	}

	// Past the last-pushed count (3→4): bypasses the cooldown.
	setWorkerPerm(fake, "alpha", "/repo", 4)
	tickExpire(d, w)
	if got := sn.count(); got != 2 {
		t.Fatalf("count-increase must bypass cooldown, sends=%d", got)
	}

	// With a ZERO cooldown the same partial rise DOES push (window
	// elapsed) — proving the cooldown, not the rise direction, gated it.
	sn2 := &scriptedNotifier{}
	d2, fake2 := newWatcherDaemon(t, sn2)
	enrollNotifyToken(t, d2, "watcher-token-cooldown-b")
	fleetAddOnline(t, d2.Registry, "alpha")
	setWorkerPerm(fake2, "alpha", "/repo", 0)
	w2 := newNotifyWatcher(d2, time.Hour, 0)
	tickExpire(d2, w2)
	setWorkerPerm(fake2, "alpha", "/repo", 3)
	tickExpire(d2, w2)
	setWorkerPerm(fake2, "alpha", "/repo", 2)
	tickExpire(d2, w2)
	setWorkerPerm(fake2, "alpha", "/repo", 3)
	tickExpire(d2, w2)
	if got := sn2.count(); got != 2 {
		t.Fatalf("zero-cooldown partial rise must push, sends=%d", got)
	}
}

// TestNotifyWatcher_ClearResetsSuppression pins the clear-reset rule:
// after a pushed clear, a re-appearance notifies even deep inside the
// cooldown window (clears are rare and valuable; flap-suppression does
// not survive them — mission decision).
func TestNotifyWatcher_ClearResetsSuppression(t *testing.T) {
	sn := &scriptedNotifier{}
	d, fake := newWatcherDaemon(t, sn)
	fleetAddOnline(t, d.Registry, "alpha")
	setWorkerPerm(fake, "alpha", "/repo", 0)
	enrollNotifyToken(t, d, "watcher-token-clearreset")
	w := newNotifyWatcher(d, time.Hour, time.Hour)
	tickExpire(d, w)

	setWorkerPerm(fake, "alpha", "/repo", 1)
	tickExpire(d, w)
	setWorkerPerm(fake, "alpha", "/repo", 0)
	tickExpire(d, w) // clear pushes + resets
	if got := sn.count(); got != 2 {
		t.Fatalf("appear+clear: sends=%d, want 2", got)
	}

	// Re-appearance within the cooldown: STILL notifies.
	setWorkerPerm(fake, "alpha", "/repo", 1)
	tickExpire(d, w)
	if got := sn.count(); got != 3 {
		t.Fatalf("re-appearance after clear must notify despite cooldown, sends=%d", got)
	}
}

// ---------------------------------------------------------------------------
// Coverage-honest clears
// ---------------------------------------------------------------------------

// TestNotifyWatcher_ClearSuppressedUnderIncompleteCoverage pins the
// no-false-recovery rule: with any in-scope worker not ok, a condition's
// disappearance is UNKNOWN — no clear, no history, state held — until a
// COMPLETE generation observes the absence.
func TestNotifyWatcher_ClearSuppressedUnderIncompleteCoverage(t *testing.T) {
	sn := &scriptedNotifier{}
	d, fake := newWatcherDaemon(t, sn)
	fleetAddOnline(t, d.Registry, "alpha")
	fleetAddOnline(t, d.Registry, "beta")
	setWorkerPerm(fake, "alpha", "/repo", 1)
	setWorkerPerm(fake, "beta", "/other", 0)
	fake.setErr("beta", fmt.Errorf("tunnel glitch"))

	enrollNotifyToken(t, d, "watcher-token-coverage")
	w := newNotifyWatcher(d, time.Hour, 0)
	tickExpire(d, w) // baseline: perm=1 on alpha, coverage INCOMPLETE

	// The condition disappears from alpha's observations, but beta is
	// still failing → coverage incomplete → the clear must be held.
	setWorkerPerm(fake, "alpha", "/repo", 0)
	tickExpire(d, w)
	if got := sn.count(); got != 0 {
		t.Fatalf("clear under incomplete coverage pushed %d sends", got)
	}
	if entries := d.notifyHistory.queryAllForTest(); len(entries) != 0 {
		t.Fatalf("clear under incomplete coverage recorded %+v — nothing may be recorded", entries)
	}

	// State was HELD: once coverage completes with the condition still
	// absent, the clear fires (against the held last-known count 1).
	fake.setErr("beta", nil)
	tickExpire(d, w)
	if got := sn.count(); got != 1 {
		t.Fatalf("complete-coverage clear: sends=%d, want 1", got)
	}
	if s := sn.send(0); s.Msg.Data["vh_event"] != "cleared" || s.Msg.Body != "1 permission pending (cleared)" {
		t.Errorf("held clear message: %+v %+v", s.Msg.Data, s.Msg.Body)
	}
}

// TestNotifyWatcher_AppearancePushesUnderIncompleteCoverage pins the
// positive-evidence rule: appearances (and increases) act even when
// coverage is incomplete — an observed wait is an observed wait.
func TestNotifyWatcher_AppearancePushesUnderIncompleteCoverage(t *testing.T) {
	sn := &scriptedNotifier{}
	d, fake := newWatcherDaemon(t, sn)
	fleetAddOnline(t, d.Registry, "alpha")
	fleetAddOnline(t, d.Registry, "beta")
	setWorkerPerm(fake, "alpha", "/repo", 0)
	setWorkerPerm(fake, "beta", "/other", 0)
	fake.setErr("beta", fmt.Errorf("tunnel glitch"))

	enrollNotifyToken(t, d, "watcher-token-positive")
	w := newNotifyWatcher(d, time.Hour, 0)
	tickExpire(d, w)

	setWorkerPerm(fake, "alpha", "/repo", 2)
	tickExpire(d, w)
	if got := sn.count(); got != 1 {
		t.Fatalf("appearance under incomplete coverage: sends=%d, want 1 (positive evidence)", got)
	}
}

// ---------------------------------------------------------------------------
// Scope filtering
// ---------------------------------------------------------------------------

// TestNotifyWatcher_ScopeFiltering pins the recipient rule: enabled AND
// (conditions empty = all nine OR explicit member). Disabled tokens and
// tokens whose subset excludes the kind receive nothing.
func TestNotifyWatcher_ScopeFiltering(t *testing.T) {
	sn := &scriptedNotifier{}
	d, fake := newWatcherDaemon(t, sn)
	fleetAddOnline(t, d.Registry, "alpha")
	setWorkerPerm(fake, "alpha", "/repo", 0)

	allTok, _, err := d.notifyStore.submit("watcher-token-scope-all", "all")
	if err != nil {
		t.Fatal(err)
	}
	subTok, _, err := d.notifyStore.submit("watcher-token-scope-sub", "sub")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := d.notifyStore.patch(subTok.ID, notifyPatch{Scope: &notifyScope{Enabled: true, Conditions: []string{fleetCondPermissionPending, fleetCondWorkerDown}}}); err != nil {
		t.Fatal(err)
	}
	offTok, _, err := d.notifyStore.submit("watcher-token-scope-off", "off")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := d.notifyStore.patch(offTok.ID, notifyPatch{Scope: &notifyScope{Enabled: false, Conditions: []string{}}}); err != nil {
		t.Fatal(err)
	}
	otherTok, _, err := d.notifyStore.submit("watcher-token-scope-other", "other")
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := d.notifyStore.patch(otherTok.ID, notifyPatch{Scope: &notifyScope{Enabled: true, Conditions: []string{fleetCondWorkerDown}}}); err != nil {
		t.Fatal(err)
	}

	w := newNotifyWatcher(d, time.Hour, 0)
	tickExpire(d, w)
	setWorkerPerm(fake, "alpha", "/repo", 1)
	tickExpire(d, w)

	if got := sn.count(); got != 2 {
		t.Fatalf("scope filtering: sends=%d, want 2 (all + permission-subset)", got)
	}
	sent := map[string]bool{}
	for i := 0; i < sn.count(); i++ {
		sent[sn.send(i).Token] = true
	}
	if !sent[allTok.Token] || !sent[subTok.Token] {
		t.Errorf("recipients = %v, want the all-conditions and permission-subset tokens", sent)
	}
	if sent[offTok.Token] || sent[otherTok.Token] {
		t.Errorf("disabled/other-subset tokens must NOT receive: %v", sent)
	}

	// The history entry carries delivery rows for exactly the two
	// recipients, and the registry telemetry for the recipients lands
	// asynchronously.
	entries := d.notifyHistory.queryAllForTest()
	if len(entries) != 1 || len(entries[0].Deliveries) != 2 {
		t.Fatalf("history deliveries: %+v", entries)
	}
	if !waitForNotify(2*time.Second, func() bool {
		e, ok := d.notifyStore.byID(allTok.ID)
		return ok && e.LastUsedAt != nil
	}) {
		t.Error("recipient telemetry (last_used_at) never landed via the async drain")
	}
	if e, _ := d.notifyStore.byID(offTok.ID); e.LastUsedAt != nil {
		t.Error("non-recipient must have no telemetry")
	}
}

// ---------------------------------------------------------------------------
// Retirement
// ---------------------------------------------------------------------------

// TestNotifyWatcher_RetirementOnUnregisteredNotBare404 pins the
// retirement split end-to-end at the sender level: the UNREGISTERED
// class removes the token from the registry and marks the delivery row
// retired; a bare-404 plain failure records the failed delivery ONLY —
// the token survives.
func TestNotifyWatcher_RetirementOnUnregisteredNotBare404(t *testing.T) {
	sn := &scriptedNotifier{}
	d, fake := newWatcherDaemon(t, sn)
	fleetAddOnline(t, d.Registry, "alpha")
	setWorkerPerm(fake, "alpha", "/repo", 0)

	deadTok, _, err := d.notifyStore.submit("watcher-token-dead-unreg", "dead")
	if err != nil {
		t.Fatal(err)
	}
	bareTok, _, err := d.notifyStore.submit("watcher-token-bare-4040", "bare")
	if err != nil {
		t.Fatal(err)
	}
	sn.respond = func(token string, _ NotifyMessage) error {
		if token == deadTok.Token {
			return &NotifyUnregisteredError{Detail: `{"error":{"code":404,"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}`}
		}
		return fmt.Errorf("fcm: send failed: HTTP 404: {\"error\":{\"code\":404,\"status\":\"NOT_FOUND\"}}")
	}

	w := newNotifyWatcher(d, time.Hour, 0)
	tickExpire(d, w)
	setWorkerPerm(fake, "alpha", "/repo", 1)
	tickExpire(d, w)

	if got := sn.count(); got != 2 {
		t.Fatalf("both tokens attempted: sends=%d", got)
	}
	// The unregistered token is RETIRED from the registry.
	if _, still := d.notifyStore.byID(deadTok.ID); still {
		t.Error("UNREGISTERED token must be removed from the registry")
	}
	// The bare-404 token SURVIVES.
	if _, still := d.notifyStore.byID(bareTok.ID); !still {
		t.Error("bare-404 token must NOT be retired")
	}
	// History carries both outcomes with the retired flag split.
	entries := d.notifyHistory.queryAllForTest()
	if len(entries) != 1 || len(entries[0].Deliveries) != 2 {
		t.Fatalf("history: %+v", entries)
	}
	byID := map[string]notifyDeliveryRecord{}
	for _, dr := range entries[0].Deliveries {
		byID[dr.TokenID] = dr
	}
	if dr := byID[deadTok.ID]; dr.OK || !dr.Retired || dr.Error == "" {
		t.Errorf("unregistered delivery row: %+v (want ok=false retired=true error)", dr)
	}
	if dr := byID[bareTok.ID]; dr.OK || dr.Retired || !strings.Contains(dr.Error, "404") {
		t.Errorf("bare-404 delivery row: %+v (want ok=false retired=false error naming 404)", dr)
	}
}

// ---------------------------------------------------------------------------
// Start gating
// ---------------------------------------------------------------------------

// TestNotifyWatcher_StartGating pins that the watcher starts ONLY with
// both the registry and a real transport configured.
func TestNotifyWatcher_StartGating(t *testing.T) {
	// Neither.
	d1 := NewDaemon(":0", ":0", "")
	if d1.StartNotifyWatcher() {
		t.Error("no store + null transport: watcher must not start")
	}
	// Store only (the history-only posture — deliberately not built).
	sn := &scriptedNotifier{}
	d2 := NewDaemon(":0", ":0", "")
	loadNotifyStore(t, d2)
	if d2.StartNotifyWatcher() {
		t.Error("store + null transport: watcher must not start (history-only mode is not half-built)")
	}
	// Transport only.
	d3 := NewDaemon(":0", ":0", "")
	d3.SetNotifyTransport(sn)
	if d3.StartNotifyWatcher() {
		t.Error("no store + real transport: watcher must not start")
	}
	// Both → starts, and is idempotent.
	d4 := NewDaemon(":0", ":0", "")
	loadNotifyStore(t, d4)
	d4.SetNotifyTransport(sn)
	if !d4.StartNotifyWatcher() {
		t.Fatal("store + real transport: watcher must start")
	}
	if !d4.StartNotifyWatcher() {
		t.Error("second StartNotifyWatcher must report the running watcher")
	}
}

// ---------------------------------------------------------------------------
// Nobody-polls observation
// ---------------------------------------------------------------------------

// TestNotifyWatcher_NobodyPollsObservation pins THE reason the watcher
// exists: with ZERO HTTP requests to GET /vh/fleet/status (a counting
// middleware around the whole chain proves it), the watcher detects a
// transition and pushes — while the acquisition seam DID run (the
// watcher drove its own refreshes).
func TestNotifyWatcher_NobodyPollsObservation(t *testing.T) {
	sn := &scriptedNotifier{}
	d, fake := newWatcherDaemon(t, sn)
	fleetAddOnline(t, d.Registry, "alpha")
	setWorkerPerm(fake, "alpha", "/repo", 0)
	// A small-but-NONZERO TTL: the background run loop cannot use the
	// manual expire helper, and serve()'s bounded loop needs the cache
	// to read fresh right after a refresh (see expireFleetCache). 40ms
	// keeps every ~10ms tick mostly cached and re-refreshes fast enough
	// to observe the fixture flip well inside the deadline.
	d.fleetStatus.budgets.TTL = 40 * time.Millisecond
	enrollNotifyToken(t, d, "watcher-token-nobody-polls")

	// A counting middleware around the WHOLE chain proves the
	// zero-poll claim (and is control-checked at the end, so a broken
	// counter cannot pass vacuously).
	var statusHits int32
	inner := d.buildRootHandler()
	wrapped := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/vh/fleet/status" {
			atomic.AddInt32(&statusHits, 1)
		}
		inner.ServeHTTP(w, r)
	})

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	w := newNotifyWatcher(d, 10*time.Millisecond, 0)
	go w.run(ctx)

	// Let the baseline land, flip the fixture, and wait for the push —
	// all without issuing a single status request.
	if !waitForNotify(2*time.Second, func() bool { return d.fleetStatusService().refreshCount() >= 1 }) {
		t.Fatal("watcher never produced a generation")
	}
	setWorkerPerm(fake, "alpha", "/repo", 1)
	if !waitForNotify(3*time.Second, func() bool { return sn.count() >= 1 }) {
		t.Fatalf("watcher never pushed (refreshes=%d)", d.fleetStatusService().refreshCount())
	}
	// Join the in-flight history append BEFORE returning: waitForNotify
	// observes the SEND (mid-dispatch); letting the test end with the
	// append still running races t.TempDir's cleanup against the
	// persist's rename (a benign but noisy ENOENT).
	if !waitForNotify(2*time.Second, func() bool { return len(d.notifyHistory.queryAllForTest()) == 1 }) {
		t.Fatal("pushed transition never reached the history store")
	}
	if got := atomic.LoadInt32(&statusHits); got != 0 {
		t.Errorf("GET /vh/fleet/status was hit %d times — the watcher must observe without any poller", got)
	}
	if fake.totalCalls() == 0 {
		t.Error("acquisition never ran — the watcher is not actually refreshing")
	}
	// Control: the counter DOES increment when a status request flows.
	rec := httptest.NewRecorder()
	wrapped.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/vh/fleet/status", nil))
	if atomic.LoadInt32(&statusHits) != 1 {
		t.Error("control request failed to increment the counter — the zero-poll assertion above was vacuous")
	}
}

// ---------------------------------------------------------------------------
// THE CRUX — fake-FCM outcome observed end-to-end
// ---------------------------------------------------------------------------

// TestNotifyWatcher_CruxFleetPushThroughFakeFCM is the slice's
// behavioral-closure crux: the REAL FCMNotifier (fake OAuth + fake FCM
// endpoints), a REAL registry+history on disk, the REAL watcher tick,
// and the REAL history API — one permission_pending appearance must
// arrive at the fake FCM with the full data vocabulary and round-trip
// through GET /vh/notify/history with the delivery outcome recorded.
func TestNotifyWatcher_CruxFleetPushThroughFakeFCM(t *testing.T) {
	key := testNotifyKey(t)
	oauth := newFakeOAuth(t)
	fcm := newFakeFCM(t)
	n := newTestFCMNotifier(t, key, oauth, fcm)

	// A daemon with auth (the history read goes through the real
	// chain), the scripted fleet seam, and a real on-disk store.
	d := NewDaemon(":0", ":0", "")
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a
	fake := newFleetFake()
	d.fetchWorkerJSON = fake.fetch
	d.SetNotifyTransport(n)
	loadNotifyStore(t, d)
	h := d.buildRootHandler()
	session := loginPassphrase(t, h, "secret")

	fleetAddOnline(t, d.Registry, "alpha")
	setWorkerPerm(fake, "alpha", "/repo", 0)
	const rawTok = "fcm-crux-device-token-0001"
	enrolled, _, err := d.notifyStore.submit(rawTok, "crux phone")
	if err != nil {
		t.Fatal(err)
	}

	// Baseline over the empty condition set, then the transition.
	w := newNotifyWatcher(d, time.Hour, 0)
	tickExpire(d, w)
	setWorkerPerm(fake, "alpha", "/repo", 1)
	tickExpire(d, w)

	// Outcome observed at the FAKE FCM: exactly one send, to the
	// enrolled token, carrying the documented vocabulary.
	if got := fcm.count(); got != 1 {
		t.Fatalf("fake FCM received %d sends, want exactly 1 (body of the last: %s)", got, lastFCMBody(fcm))
	}
	req := fcm.request(0)
	var env struct {
		Message struct {
			Token        string `json:"token"`
			Notification *struct {
				Title string `json:"title"`
				Body  string `json:"body"`
			} `json:"notification"`
			Data map[string]string `json:"data"`
		} `json:"message"`
	}
	if err := json.Unmarshal([]byte(req.Body), &env); err != nil {
		t.Fatalf("decode FCM envelope: %v (%s)", err, req.Body)
	}
	if env.Message.Token != rawTok {
		t.Errorf("FCM target = %q, want the enrolled token VERBATIM", env.Message.Token)
	}
	if env.Message.Notification == nil || env.Message.Notification.Title != "vh-solara" || env.Message.Notification.Body != "1 permission pending" {
		t.Errorf("FCM notification = %+v, want title vh-solara / body '1 permission pending'", env.Message.Notification)
	}
	want := map[string]string{
		"vh_kind":      "fleet",
		"vh_event":     "appeared",
		"vh_condition": "permission_pending",
		"vh_count":     "1",
	}
	for k, v := range want {
		if env.Message.Data[k] != v {
			t.Errorf("FCM data[%s] = %q, want %q (full: %v)", k, env.Message.Data[k], v, env.Message.Data)
		}
	}
	if ts := env.Message.Data["vh_ts"]; ts == "" {
		t.Error("FCM data must carry vh_ts")
	} else if _, err := time.Parse(time.RFC3339, ts); err != nil {
		t.Errorf("vh_ts not RFC3339: %q (%v)", ts, err)
	}

	// History round-trip through the REAL API: the transition and its
	// successful delivery are recorded.
	rec := doNotify(t, h, http.MethodGet, "/vh/notify/history", "", withCookie(session))
	if rec.Code != http.StatusOK {
		t.Fatalf("GET history: %d (%s)", rec.Code, rec.Body.String())
	}
	var view struct {
		Events []struct {
			ID         int64  `json:"id"`
			Kind       string `json:"kind"`
			Action     string `json:"action"`
			Count      int    `json:"count"`
			Body       string `json:"body"`
			Deliveries []struct {
				TokenID string `json:"token_id"`
				OK      bool   `json:"ok"`
				Retired bool   `json:"retired"`
			} `json:"deliveries"`
		} `json:"events"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &view); err != nil {
		t.Fatalf("decode history: %v (%s)", err, rec.Body.String())
	}
	if len(view.Events) != 1 {
		t.Fatalf("history events = %d, want 1 (%s)", len(view.Events), rec.Body.String())
	}
	ev := view.Events[0]
	if ev.Kind != "permission_pending" || ev.Action != "appeared" || ev.Count != 1 || ev.Body != "1 permission pending" {
		t.Errorf("history event = %+v", ev)
	}
	if len(ev.Deliveries) != 1 || ev.Deliveries[0].TokenID != enrolled.ID || !ev.Deliveries[0].OK || ev.Deliveries[0].Retired {
		t.Errorf("history delivery = %+v (want ok delivery to the enrolled id)", ev.Deliveries)
	}

	// Registry telemetry lands asynchronously (off the send path).
	if !waitForNotify(2*time.Second, func() bool {
		e, ok := d.notifyStore.byID(enrolled.ID)
		return ok && e.LastUsedAt != nil && e.LastError == ""
	}) {
		t.Error("send telemetry never landed via the async drain")
	}
}

// lastFCMBody renders the last recorded request body (diagnostics).
func lastFCMBody(f *fakeFCM) string {
	if f.count() == 0 {
		return "(none)"
	}
	return f.request(f.count() - 1).Body
}
