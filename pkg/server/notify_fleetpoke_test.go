package server

// notify_fleetpoke_test.go — lane-1 co-located tests for the v4.1
// fleet_changed status poke (notify_fleetpoke.go; contract:
// docs/architecture/notify-fcm.md §3.3 v4.1). Pins, deterministically:
//
//   - the rollup fingerprint (fleetRollupFingerprint): state / composition /
//     worker-status / pending-count changes diff; no-change refreshes are
//     identical; map order never leaks into the value;
//   - the debounce state machine (observe): leading fire, refractory
//     absorption, trailing catch-up, quiet — on a mutable clock;
//   - the FCM message shape (golden-style pin): minimal all-strings data,
//     NORMAL priority, collapse_key fleet_changed, short TTL;
//   - the collapsed gating ladder over the REAL shared transport + fake
//     FCM: fan to ALL enabled tokens of both policies, attendance n/a
//     (no input exists), disabled tokens skipped, explicit condition
//     scopes NOT applied, no central-cooldown suppression;
//   - the no-history rule: pokes never touch the central ledger (head,
//     events, dispatch-state claims all untouched);
//   - the wiring: buildRollup → generation.fingerprint → the daemon's
//     production fingerprint source over the faked acquisition seam.
//
// Lane 3 (tests/e2e/notify_fleetpoke_test.go) proves the full spine over
// the real tunnel: worker session transition → rollup diff → debounced
// poke at the fake FCM, plus the session_started masking fix end to end.

import (
	"context"
	"encoding/json"
	"os"
	"strconv"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/state"
)

// ---------------------------------------------------------------------------
// Fingerprint diffing
// ---------------------------------------------------------------------------

// fpWorker builds one acquisition result the way buildRollup produces it
// (status ok, one project, the given gate map).
func fpWorker(id, dir string, gate map[string]state.GateFacts) fleetWorkerResult {
	return fleetWorkerResult{
		id:         id,
		status:     fleetWorkerOK,
		observedAt: time.Now(),
		projects:   []fleetObservedProject{{dir: dir, gate: gate}},
	}
}

func TestFleetRollupFingerprint_NoChangeIsIdentical(t *testing.T) {
	gate := map[string]state.GateFacts{"ses_a": fleetGF("busy", false, false), "ses_b": fleetGF("idle", false, false)}
	a := fleetRollupFingerprint([]fleetWorkerResult{fpWorker("w1", "/p", gate), fpWorker("w2", "/q", nil)})
	// A second refresh of the SAME fleet — different observedAt times,
	// different acquisition order, same content — must produce the SAME
	// fingerprint (the debounce keys on it; volatile fields must not leak).
	b := fleetRollupFingerprint([]fleetWorkerResult{fpWorker("w2", "/q", nil), fpWorker("w1", "/p", gate)})
	if a == "" {
		t.Fatal("fingerprint must be a value, not empty")
	}
	if a != b {
		t.Fatalf("an unchanged fleet must fingerprint identically: %q vs %q", a, b)
	}
}

func TestFleetRollupFingerprint_StateChangeDiffs(t *testing.T) {
	idle := map[string]state.GateFacts{"ses_a": fleetGF("idle", false, false)}
	busy := map[string]state.GateFacts{"ses_a": fleetGF("busy", false, false)}
	if fleetRollupFingerprint([]fleetWorkerResult{fpWorker("w1", "/p", idle)}) ==
		fleetRollupFingerprint([]fleetWorkerResult{fpWorker("w1", "/p", busy)}) {
		t.Fatal("a session idle→running transition must change the fingerprint")
	}
	// The waiting axis: a pending-permission transition diffs too.
	wait := map[string]state.GateFacts{"ses_a": fleetGF("idle", true, false)}
	if fleetRollupFingerprint([]fleetWorkerResult{fpWorker("w1", "/p", idle)}) ==
		fleetRollupFingerprint([]fleetWorkerResult{fpWorker("w1", "/p", wait)}) {
		t.Fatal("a pending-permission transition must change the fingerprint")
	}
}

func TestFleetRollupFingerprint_CompositionChangesDiff(t *testing.T) {
	base := map[string]state.GateFacts{"ses_a": fleetGF("idle", false, false)}
	withB := map[string]state.GateFacts{"ses_a": fleetGF("idle", false, false), "ses_b": fleetGF("idle", false, false)}
	fpBase := fleetRollupFingerprint([]fleetWorkerResult{fpWorker("w1", "/p", base)})
	if fleetRollupFingerprint([]fleetWorkerResult{fpWorker("w1", "/p", withB)}) == fpBase {
		t.Fatal("a session joining the selected set must change the fingerprint")
	}
	if fleetRollupFingerprint([]fleetWorkerResult{fpWorker("w1", "/p", nil)}) == fpBase {
		t.Fatal("a session leaving the selected set must change the fingerprint")
	}
	// Worker UP/DOWN is naturally in the diff (composition): an offline
	// worker — even one hosting no selected sessions — changes the
	// fingerprint, and so does a worker joining the scope.
	down := fpWorker("w1", "/p", base)
	down.status = fleetWorkerOffline
	down.projects = nil
	if fleetRollupFingerprint([]fleetWorkerResult{down}) == fpBase {
		t.Fatal("a worker going offline must change the fingerprint")
	}
	joined := append([]fleetWorkerResult{fpWorker("w1", "/p", base)}, fpWorker("w2", "/q", nil))
	if fleetRollupFingerprint(joined) == fpBase {
		t.Fatal("a worker joining the fleet must change the fingerprint")
	}
}

func TestFleetRollupFingerprint_PendingCountsDiff(t *testing.T) {
	// The subtree counts are the queue-adjacent figures this rollup shape
	// exposes (there is no other queue concept in /vh/fleet/status): a
	// pending-count change must diff even when the boolean axes agree.
	one := map[string]state.GateFacts{"ses_a": fleetGF("idle", true, false)}
	two := fleetGF("idle", true, false)
	two.SubtreePendingPermission = 2 // two descendants waiting now
	g2 := map[string]state.GateFacts{"ses_a": two}
	if fleetRollupFingerprint([]fleetWorkerResult{fpWorker("w1", "/p", one)}) ==
		fleetRollupFingerprint([]fleetWorkerResult{fpWorker("w1", "/p", g2)}) {
		t.Fatal("a pending-count change must change the fingerprint")
	}
}

func TestFleetRollupFingerprint_ChildSessionsExcluded(t *testing.T) {
	// The fold population is SELECTED roots only; a child (fleet_selected
	// false) appearing or changing must not diff (it is not in the rollup's
	// population either).
	roots := map[string]state.GateFacts{"ses_root": fleetGF("idle", false, false)}
	fp := fleetRollupFingerprint([]fleetWorkerResult{fpWorker("w1", "/p", roots)})
	child := fleetGF("busy", false, false)
	sel := false
	child.FleetSelected = &sel
	withChild := map[string]state.GateFacts{"ses_root": fleetGF("idle", false, false), "ses_child": child}
	if fleetRollupFingerprint([]fleetWorkerResult{fpWorker("w1", "/p", withChild)}) != fp {
		t.Fatal("an unselected child must not enter the fingerprint")
	}
}

// ---------------------------------------------------------------------------
// Debounce state machine (deterministic clock, direct observe drives)
// ---------------------------------------------------------------------------

func TestFleetPokeDebounceStateMachine(t *testing.T) {
	clk := &mutableClock{t: time.Date(2026, 10, 27, 9, 0, 0, 0, time.UTC)}
	w := newFleetPokeWatcher(nil, nil, nil, fleetPokeConfig{Interval: time.Second, Debounce: 30 * time.Second})
	w.now = clk.Now

	// First observation: silent baseline — a restart re-pokes only on a
	// real diff.
	if w.observe("fp0", clk.Now()) {
		t.Fatal("the first observation must baseline, never poke")
	}

	// First transition: LEADING fire.
	if !w.observe("fp1", clk.Now()) {
		t.Fatal("the first transition after the baseline must fire the leading poke")
	}
	if got := w.fires; got != 1 {
		t.Fatalf("fires = %d, want 1", got)
	}

	// Transitions during the refractory ABSORB (no fire), repeatedly.
	clk.Advance(10 * time.Second)
	if w.observe("fp2", clk.Now()) {
		t.Fatal("a transition inside the refractory must be absorbed")
	}
	clk.Advance(9 * time.Second)
	if w.observe("fp3", clk.Now()) {
		t.Fatal("a second transition inside the same refractory must stay absorbed")
	}

	// Unchanged observations inside the window stay quiet — but the
	// absorbed obligation survives.
	clk.Advance(5 * time.Second) // t=24s since fire: still inside 30s
	if w.observe("fp3", clk.Now()) {
		t.Fatal("an unchanged fingerprint must not fire")
	}

	// Past the refractory with an absorbed obligation: exactly ONE
	// trailing catch-up — even though the CURRENT fingerprint equals the
	// last observed one (the absorbed change was never delivered).
	clk.Advance(7 * time.Second) // t=31s since fire
	if !w.observe("fp3", clk.Now()) {
		t.Fatal("an absorbed change past the refractory must fire the catch-up poke")
	}
	if got := w.fires; got != 2 {
		t.Fatalf("fires = %d, want 2 (leading + catch-up)", got)
	}

	// Quiet fleet after the catch-up: nothing more fires, ever, until a
	// real change.
	for i := 0; i < 5; i++ {
		clk.Advance(45 * time.Second)
		if w.observe("fp3", clk.Now()) {
			t.Fatal("an unchanged fleet must never poke again")
		}
	}
	if got := w.fires; got != 2 {
		t.Fatalf("fires = %d, want 2 after the quiet window", got)
	}

	// A change after a fully closed window is a NEW leading fire.
	clk.Advance(45 * time.Second)
	if !w.observe("fp4", clk.Now()) {
		t.Fatal("a change after the window closed must fire a new leading poke")
	}
	if got := w.fires; got != 3 {
		t.Fatalf("fires = %d, want 3", got)
	}
}

func TestFleetPokeDebounceBoundedUnderSustainedChurn(t *testing.T) {
	// Sustained churn (a change at EVERY observation) pokes at most once
	// per refractory window: the trailing edge is measured from the last
	// FIRE (fixed window), so the rate is bounded — never a per-change
	// poke, never starvation.
	clk := &mutableClock{t: time.Date(2026, 10, 27, 9, 0, 0, 0, time.UTC)}
	w := newFleetPokeWatcher(nil, nil, nil, fleetPokeConfig{Interval: time.Second, Debounce: 30 * time.Second})
	w.now = clk.Now
	w.observe("fp0", clk.Now()) // baseline

	// 10 minutes of continuous churn observed every 20s: 30 windows ⇒ at
	// most 31 fires (one leading + one catch-up per window boundary), vs
	// 30 changes that a naive per-change poke would deliver.
	fp := 0
	for tElapsed := 20 * time.Second; tElapsed <= 10*time.Minute; tElapsed += 20 * time.Second {
		clk.Advance(20 * time.Second)
		fp++
		w.observe("fingerprint-"+string(rune('a'+fp%26))+string(rune('0'+fp%10)), clk.Now())
	}
	if got := w.fires; got > 31 {
		t.Fatalf("sustained churn produced %d poke waves in 10 minutes — the refractory is not bounding the rate", got)
	}
	if got := w.fires; got < 10 {
		t.Fatalf("sustained churn produced only %d poke waves in 10 minutes — the catch-up is starving (trailing edge must be window-based, not last-transition-based)", got)
	}
}

// ---------------------------------------------------------------------------
// Message shape (golden-style pin)
// ---------------------------------------------------------------------------

func TestFleetPokeMessageShape(t *testing.T) {
	now := time.Date(2026, 10, 27, 9, 30, 5, 0, time.UTC)
	data, android := buildFleetPokeMessage(now)

	// The exact minimal data set: vh_kind occupies the reserved
	// future-kinds slot; vh_count stays "1" for shape consistency; NO
	// vh_condition (the §9.1 vocabulary is notice-specific); no worker/
	// session/history/url keys — figures never travel in the payload.
	want := map[string]string{
		"vh_kind":  "status",
		"vh_event": "fleet_changed",
		"vh_count": "1",
		"vh_ts":    strconv.FormatInt(now.UnixMilli(), 10), // unix millis, string (all-strings contract)
	}
	if len(data) != len(want) {
		t.Fatalf("data = %v, want exactly %v (minimal payload — nothing else)", data, want)
	}
	for k, v := range want {
		if data[k] != v {
			t.Fatalf("data[%s] = %q, want %q (full: %v)", k, data[k], v, data)
		}
	}
	// Android posture: NORMAL (a silent wake is not interrupt-worthy),
	// collapse-by-event, TTL bounded short (a stale poke must not buzz).
	if android == nil {
		t.Fatal("android config required")
	}
	if android.Priority != "NORMAL" {
		t.Fatalf("priority = %q, want NORMAL", android.Priority)
	}
	if android.CollapseKey != "fleet_changed" {
		t.Fatalf("collapse_key = %q, want fleet_changed", android.CollapseKey)
	}
	if android.TTLSeconds != notifyFleetPokeTTLSec {
		t.Fatalf("ttl = %ds, want the short poke bound %ds", android.TTLSeconds, notifyFleetPokeTTLSec)
	}
}

// ---------------------------------------------------------------------------
// Collapsed gating ladder + fan-out over the REAL transport (fake FCM)
// ---------------------------------------------------------------------------

// fleetPokeFixture wires the real store + shared transport against the
// fake OAuth/FCM pair, plus a synchronous watcher (tests drive observe +
// pokeAllTokens directly).
type fleetPokeFixture struct {
	d   *Daemon
	fcm *fakeFCM
	w   *fleetPokeWatcher
	clk *mutableClock
}

func newFleetPokeFixture(t *testing.T, cooldown time.Duration) *fleetPokeFixture {
	t.Helper()
	f := newDispatchFixture(t) // real file-backed store + ledger + transport fakes
	// A token of each posture the collapsed ladder must distinguish.
	mk := func(token, label, policy string, scope *notifyScope) {
		t.Helper()
		e, _, err := f.d.notifyStore.submit(token, label, policy)
		if err != nil {
			t.Fatalf("submit %s: %v", label, err)
		}
		if scope != nil {
			if _, _, err := f.d.notifyStore.patch(e.ID, notifyPatch{Scope: scope}); err != nil {
				t.Fatalf("patch %s: %v", label, err)
			}
		}
	}
	mk("poke-token-always-x", "always phone", "always", nil)
	mk("poke-token-wu-xxxxx", "wu phone", "when_unattended", nil)
	mk("poke-token-disabled-x", "disabled phone", "always", &notifyScope{Enabled: false, Conditions: []string{}})
	// Explicit legacy condition scope (e.g. waiting-only): pokes are NOT
	// notices — the condition scope must not filter them.
	mk("poke-token-scoped-xx", "scoped phone", "when_unattended", &notifyScope{Enabled: true, Conditions: []string{"permission_pending"}})

	w := newFleetPokeWatcher(&f.d.notifyStore, f.trans, func(context.Context) (string, error) { return "", nil },
		fleetPokeConfig{Interval: time.Hour, Debounce: 30 * time.Second})
	w.now = f.clk.Now
	return &fleetPokeFixture{d: f.d, fcm: f.fcm, w: w, clk: f.clk}
}

// pokeReceipts parses the fake FCM's captured request bodies.
func pokeReceipts(t *testing.T, f *fleetPokeFixture) []struct {
	Token string
	Data  map[string]string
} {
	t.Helper()
	out := make([]struct {
		Token string
		Data  map[string]string
	}, 0, f.fcm.count())
	for i := 0; i < f.fcm.count(); i++ {
		var env struct {
			Message struct {
				Token string            `json:"token"`
				Data  map[string]string `json:"data"`
			} `json:"message"`
		}
		if err := json.Unmarshal([]byte(f.fcm.request(i).Body), &env); err != nil {
			t.Fatalf("fake FCM body %d decode: %v", i, err)
		}
		out = append(out, struct {
			Token string
			Data  map[string]string
		}{Token: env.Message.Token, Data: env.Message.Data})
	}
	return out
}

func TestFleetPokeGatingExemptionsAndFanout(t *testing.T) {
	fpx := newFleetPokeFixture(t, time.Hour) // central cooldown 1h — the poke must IGNORE it

	now := fpx.clk.Now()
	// Baseline + first transition → leading fire.
	fpx.w.observe("base", now)
	if !fpx.w.observe("changed", now) {
		t.Fatal("first transition must fire")
	}
	fpx.w.pokeAllTokens(now)

	rs := pokeReceipts(t, fpx)
	if len(rs) != 3 {
		t.Fatalf("poke wave must reach exactly the 3 ENABLED tokens (both policies + the condition-scoped one), got %d: %+v", len(rs), rs)
	}
	got := map[string]bool{}
	for _, r := range rs {
		got[r.Token] = true
		if r.Data["vh_kind"] != "status" || r.Data["vh_event"] != "fleet_changed" {
			t.Fatalf("poke receipt data = %v", r.Data)
		}
	}
	for _, want := range []string{"poke-token-always-x", "poke-token-wu-xxxxx", "poke-token-scoped-xx"} {
		if !got[want] {
			t.Fatalf("token %s must receive the poke (fan to ALL registered tokens of both policies); got %v", want, got)
		}
	}
	if got["poke-token-disabled-x"] {
		t.Fatal("an administratively disabled token must never receive a poke")
	}

	// NO COOLDOWN beyond the debounce: a second wave after the refractory
	// reaches the same tokens even though the central cooldown (1h here)
	// would suppress a second NOTICE of any (source, type) key.
	fpx.clk.Advance(31 * time.Second)
	if !fpx.w.observe("changed-again", fpx.clk.Now()) {
		t.Fatal("a change after the refractory must fire again (no central-cooldown suppression for pokes)")
	}
	fpx.w.pokeAllTokens(fpx.clk.Now())
	if n := fpx.fcm.count(); n != 6 {
		t.Fatalf("second wave must reach the same 3 tokens (no cooldown beyond debounce), got %d total sends", n)
	}
}

// ---------------------------------------------------------------------------
// The no-history rule
// ---------------------------------------------------------------------------

func TestFleetPokeNotInHistoryOrLedger(t *testing.T) {
	fpx := newFleetPokeFixture(t, 60*time.Second)

	// Two full poke waves.
	now := fpx.clk.Now()
	fpx.w.observe("base", now)
	fpx.w.observe("change-1", now)
	fpx.w.pokeAllTokens(now)
	fpx.clk.Advance(31 * time.Second)
	fpx.w.observe("change-2", fpx.clk.Now())
	fpx.w.pokeAllTokens(fpx.clk.Now())

	if n := fpx.fcm.count(); n == 0 {
		t.Fatal("test premise: poke waves must have sent")
	}

	// The central ledger — the PUBLIC history's source — is untouched: no
	// event, head still 0, central id contiguity preserved (the first real
	// notice still gets id 1).
	led := fpx.d.ledger()
	if got := led.Head(); got != 0 {
		t.Fatalf("central ledger head = %d, want 0 (pokes must never create ledger events)", got)
	}
	if evs := led.EventsSince(0, 10); len(evs) != 0 {
		t.Fatalf("central ledger events = %d, want 0: %+v", len(evs), evs)
	}
	// The dispatch-state file (attempt claims) was never created — the
	// poke path persists NOTHING (in-memory best-effort by contract).
	if _, err := os.Stat(fpx.d.notifyStore.snapshot().path + ".dispatch"); !os.IsNotExist(err) {
		t.Fatalf("poke waves must not create dispatch state: %v", err)
	}
}

// ---------------------------------------------------------------------------
// Wiring: buildRollup → generation.fingerprint → the production source
// ---------------------------------------------------------------------------

func TestFleetPokeFingerprintSourceOverFleetService(t *testing.T) {
	d, fake := newFleetTestDaemon(t, "")
	fleetAddOnline(t, d.Registry, "w1")
	gateIdle := map[string]state.GateFacts{"ses_a": fleetGF("idle", false, false)}
	gateBusy := map[string]state.GateFacts{"ses_a": fleetGF("busy", false, false)}
	fake.setBody("w1", "/vh/projects", fleetProjectsBody("/p"))
	fake.setBody("w1", fleetGatesPath("/p"), fleetGatesBody(map[string]map[string]state.GateFacts{"/p": gateIdle}))

	src := d.fleetPokeFingerprintSource()
	gen1, err := src(context.Background())
	if err != nil {
		t.Fatalf("fingerprint source: %v", err)
	}
	if gen1 == "" || gen1 == fleetFallbackFingerprint {
		t.Fatalf("fingerprint = %q, want a real fold hash", gen1)
	}

	// Same fleet re-refreshed (past TTL): identical fingerprint.
	expireFleetCache(d)
	gen2, err := src(context.Background())
	if err != nil {
		t.Fatalf("fingerprint source 2: %v", err)
	}
	if gen1 != gen2 {
		t.Fatalf("unchanged fleet: %q vs %q", gen1, gen2)
	}

	// A session transition through the (faked) acquisition seam: the
	// fingerprint changes — the diff the poke watcher keys on.
	fake.setBody("w1", fleetGatesPath("/p"), fleetGatesBody(map[string]map[string]state.GateFacts{"/p": gateBusy}))
	expireFleetCache(d)
	gen3, err := src(context.Background())
	if err != nil {
		t.Fatalf("fingerprint source 3: %v", err)
	}
	if gen3 == gen2 {
		t.Fatal("a session idle→busy transition must change the rollup fingerprint")
	}

	// And the debounce state machine over the real source fires exactly
	// the leading wave for that transition.
	clk := &mutableClock{t: time.Now()}
	w := newFleetPokeWatcher(&d.notifyStore, nil, src, fleetPokeConfig{Debounce: 30 * time.Second})
	w.now = clk.Now
	if w.observe(gen1, clk.Now()) {
		t.Fatal("first observation must baseline")
	}
	if !w.observe(gen3, clk.Now()) {
		t.Fatal("the observed transition must fire the leading poke")
	}
}
