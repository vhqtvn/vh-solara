package server

// notify_fleetpoke.go — the v4.1 `fleet_changed` STATUS POKE (notify-fcm.md
// §3.3, v4.1 additive extension; docs/architecture/notify-fcm.md is the
// contract authority). A SILENT reconciler poke: when the controller's
// fleet-status rollup observes that the per-session state map across
// workers CHANGED, every registered device gets one minimal data-only FCM
// message (vh_kind:"status", vh_event:"fleet_changed") whose only job is to
// wake the client — the client then fetches /vh/fleet/status; figures never
// come from the payload.
//
// ---------------------------------------------------------------------------
// THE DIFF SOURCE (the rollup, not a second aggregator): the watcher owns a
// dedicated ~20s ticker over the ORDINARY fleet-status service — each tick
// reads a generation through the same single-flight TTL-cached serve() the
// HTTP/SSE surfaces use (serve refreshes lazily when the 5s TTL expired, so
// a 20s tick observes a fresh rollup per tick; concurrent GETs, SSE demand
// ticks, and poke ticks all coalesce onto one in-flight refresh). The
// fingerprint itself is computed by buildRollup from the same acquisition
// results (fleetRollupFingerprint): per-worker status + per-selected-root
// state facts, volatile fields excluded. The first tick establishes the
// baseline WITHOUT poking (a controller restart re-pokes on the first REAL
// diff — best-effort and self-healing by design).
//
// ---------------------------------------------------------------------------
// DEBOUNCE (~30s refractory, leading fire + trailing catch-up):
//
//   - The FIRST transition after a quiet period pokes immediately (the
//     leading edge — a fleet change the operator's watch should see now).
//   - Transitions observed while the refractory window
//     [lastFire, lastFire+debounce) is open are ABSORBED (remembered, not
//     delivered).
//   - If any were absorbed, exactly ONE catch-up poke fires at the first
//     tick past lastFire+debounce — the trailing edge. The catch-up becomes
//     the new lastFire, so sustained churn pokes at most once per
//     debounce window (bounded rate; fleet target 20-50 sessions,
//     multi-worker).
//   - Debounce state is IN-MEMORY ONLY: a poke is best-effort, and the
//     ledger/registry persistence is deliberately untouched.
//
// ---------------------------------------------------------------------------
// GATEING (the v4 notice ladder, collapsed for this kind — the exemptions
// the client contract settled): attendance SKIPPED (a silent poke;
// web-tab-open is exactly when watch figures still matter), the profile
// type-filter SKIPPED (a poke is not a notice; there is no §9.1 condition),
// freshness N/A (no event timestamp to be stale), and the central cooldown
// NOT applied (the debounce above is the ONLY rate bound — "no cooldown
// beyond that"). What REMAINS: the channel must be enabled (the watcher is
// armed by StartNotifyDispatch, under --notify-dispatch), and the fan-out
// reaches ALL registered tokens of BOTH push policies. Per-token, only the
// administrative scope.enabled gate applies — an administratively disabled
// token is not a delivery target at all, and the legacy notice-condition
// scope (scope.conditions) does NOT filter pokes (that vocabulary is about
// notice kinds; fleet_changed is not one).
//
// ---------------------------------------------------------------------------
// NOT-A-NOTICE (the no-history rule): a status poke never enters the worker
// pipeline (no spool/feed/ledger/notice anywhere) and never touches central
// state — no history ring entry, no central ledger event, no central id
// (id contiguity preserved), never in /vh/notify/history. Structurally
// guaranteed: this file writes NOTHING to the ledger or history; its only
// side effects are FCM sends, registry send telemetry, and UNREGISTERED
// prunes (the same generation-bound discipline as notice sends).
//
// ---------------------------------------------------------------------------
// SECRECY: identical to the notice dispatcher — tokens appear only as the
// Send argument; log lines and telemetry carry label-or-hash only.

import (
	"context"
	"log"
	"strconv"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/alerts"
)

// Production v4.1 constants (notify-fcm.md §3.3 v4.1). The interval is an
// unmeasured default like the dispatch poll; the debounce is the contract's
// ~30s refractory. Both are overridable per-watcher (tests and the e2e
// harness tighten them via NotifyDispatchConfig).
const (
	notifyFleetPokeDefaultInterval = 20 * time.Second
	notifyFleetPokeDefaultDebounce = 30 * time.Second
	// notifyFleetPokeKind/Event are the wire vocabulary: vh_kind "status"
	// occupies the reserved future-kinds slot (v4 §3.3 reserved
	// "vh_kind:'notice' (fixed in v2)" — v4.1 adds the second kind).
	notifyFleetPokeKind  = "status"
	notifyFleetPokeEvent = "fleet_changed"
	// notifyFleetPokeTTLSec bounds a poke's FCM TTL: a poke older than a
	// few minutes is worthless (the client reconciles on its next wake
	// anyway), so stale queued pokes must not buzz devices late.
	notifyFleetPokeTTLSec = 300
)

// fleetPokeConfig tunes the watcher; the zero value is the documented
// default posture (normalized fills every field).
type fleetPokeConfig struct {
	// Interval is the diff ticker's cadence over the fleet-status service
	// (default 20s).
	Interval time.Duration
	// Debounce is the refractory window: leading fire + trailing catch-up
	// (default 30s).
	Debounce time.Duration
}

func (c fleetPokeConfig) normalized() fleetPokeConfig {
	if c.Interval <= 0 {
		c.Interval = notifyFleetPokeDefaultInterval
	}
	if c.Debounce <= 0 {
		c.Debounce = notifyFleetPokeDefaultDebounce
	}
	return c
}

// buildFleetPokeMessage renders the v4.1 status-poke FCM data-only message:
// the MINIMAL payload (vh_kind/vh_event/vh_ts — figures never travel in the
// payload; the client fetches /vh/fleet/status on receipt) plus vh_count
// fixed "1" for shape consistency with every other vh_* message (counts are
// derived, never aggregated into payloads — the v1 §3 rule; the field is
// included so a future aggregation needs no wire change, exactly like the
// notice message). vh_condition is deliberately ABSENT: the §9.1 condition
// vocabulary is notice-specific and a poke carries none. Android posture:
// NORMAL priority (a silent reconciler wake is not interrupt-worthy),
// collapse_key "fleet_changed" (a catch-up supersedes an undelivered
// leading poke — at most one queued poke per device), TTL bounded short.
func buildFleetPokeMessage(now time.Time) (map[string]string, *alerts.AndroidConfig) {
	data := map[string]string{
		"vh_kind":  notifyFleetPokeKind,
		"vh_event": notifyFleetPokeEvent,
		"vh_count": "1",
		"vh_ts":    strconv.FormatInt(now.UnixMilli(), 10),
	}
	android := &alerts.AndroidConfig{
		Priority:    "NORMAL",
		CollapseKey: notifyFleetPokeEvent,
		TTLSeconds:  notifyFleetPokeTTLSec,
	}
	return data, android
}

// fleetPokeWatcher is the v4.1 status-poke state machine: the diff ticker
// over the fleet-status service, the in-memory debounce window, and the
// collapsed-ladder fan-out. One instance per armed dispatcher (StartNotifyDispatch
// arms it; StopNotifyDispatch cancels AND joins it — the same lifecycle as
// the notice dispatcher, so a LoadNotifyStore re-arm can never swap the
// registry under an in-flight poke's generation-bound prune).
type fleetPokeWatcher struct {
	store     *notifyStoreHolder
	transport *alerts.FCMTransport
	// fingerprint returns the CURRENT rollup generation's fingerprint (a
	// fresh observation — the production source rides serve(), whose TTL +
	// single-flight semantics keep concurrent readers on one refresh).
	fingerprint func(ctx context.Context) (string, error)
	cfg         fleetPokeConfig
	now         func() time.Time

	// mu guards the debounce state machine (observe is serialized by the
	// Run loop in production; the lock exists for direct test drives).
	mu       sync.Mutex
	base     string    // last observed fingerprint
	hasBase  bool      // first observation is the silent baseline
	lastFire time.Time // zero = never fired
	absorbed bool      // a change was absorbed during the open refractory
	fires    int       // total pokes fired (test observability)

	// done closes when Run returns; StopNotifyDispatch joins on it.
	done chan struct{}
}

// newFleetPokeWatcher assembles the watcher; Run drives it.
func newFleetPokeWatcher(store *notifyStoreHolder, transport *alerts.FCMTransport, fingerprint func(ctx context.Context) (string, error), cfg fleetPokeConfig) *fleetPokeWatcher {
	return &fleetPokeWatcher{
		store:       store,
		transport:   transport,
		fingerprint: fingerprint,
		cfg:         cfg.normalized(),
		now:         time.Now,
		done:        make(chan struct{}),
	}
}

// fleetPokeFingerprintSource is the production diff source: one generation
// through the ordinary single-flight serve() — the same generations the
// HTTP handler and SSE stream serve, so the poke never observes state the
// rest of the controller cannot.
func (d *Daemon) fleetPokeFingerprintSource() func(ctx context.Context) (string, error) {
	return func(ctx context.Context) (string, error) {
		gen, err := d.fleetStatusService().serve(ctx)
		if err != nil {
			return "", err
		}
		return gen.fingerprint, nil
	}
}

// Run ticks the diff loop until ctx is done. A tick whose refresh cannot
// settle (registry churn, acquisition timeout) is logged and retried on the
// next tick — no fingerprint means no observation to diff, never a poke on
// fabricated state.
func (w *fleetPokeWatcher) Run(ctx context.Context) {
	defer close(w.done)
	t := time.NewTicker(w.cfg.Interval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			fp, err := w.fingerprint(ctx)
			if err != nil {
				if ctx.Err() == nil {
					log.Printf("notify fleet poke: refresh did not settle: %v", err)
				}
				continue
			}
			if w.observe(fp, w.now()) {
				w.pokeAllTokens(w.now())
			}
		}
	}
}

// observe is the debounce state machine for one observed fingerprint. It
// returns whether a poke wave fires NOW:
//
//   - first observation ever: silent baseline (a restart re-pokes only on a
//     real diff), returns false;
//   - a change while no refractory is open (or never fired): LEADING fire;
//   - a change while the refractory is open: ABSORB (returns false; the
//     catch-up obligation is remembered);
//   - an absorbed obligation whose refractory has elapsed: TRAILING
//     catch-up fire (this fires even when the current fingerprint equals
//     the last — the absorbed change was never delivered);
//   - unchanged and nothing absorbed: quiet.
//
// The trailing edge is measured from the LAST FIRE (a fixed refractory
// window), not from the last transition: sustained churn therefore pokes at
// most once per window — a bounded rate — instead of a pure trailing
// debounce's potential indefinite starvation.
func (w *fleetPokeWatcher) observe(fp string, now time.Time) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	if !w.hasBase {
		w.base, w.hasBase = fp, true
		return false
	}
	changed := fp != w.base
	inRefractory := !w.lastFire.IsZero() && now.Sub(w.lastFire) < w.cfg.Debounce
	fire := false
	switch {
	case w.absorbed && !inRefractory:
		fire = true // trailing catch-up: the window closed on absorbed changes
	case changed && !inRefractory:
		fire = true // leading edge: first transition of a quiet period
	case changed:
		w.absorbed = true // refractory absorbs; the catch-up will cover it
	}
	if fire {
		w.lastFire = now
		w.absorbed = false
		w.fires++
	}
	w.base = fp
	return fire
}

// pokeAllTokens fans one status poke out to EVERY delivery-eligible token —
// the collapsed ladder (see the file header): both push policies, no
// attendance/type-filter/freshness/cooldown gating, only the administrative
// scope.enabled per token. Sends are concurrent (a slow transport must not
// serialize the fan-out) and ride the shared transport with the SAME
// generation-bound UNREGISTERED prune + async registry telemetry as notice
// sends. A wave with zero eligible tokens still counts as fired for the
// debounce state (best-effort: the obligation was discharged; devices that
// register later reconcile on their own first fetch).
func (w *fleetPokeWatcher) pokeAllTokens(now time.Time) {
	snap := w.store.snapshot()
	data, android := buildFleetPokeMessage(now)
	var wg sync.WaitGroup
	for i := range snap.entries {
		e := snap.entries[i]
		if !e.Scope.Enabled {
			continue // administratively disabled: not a delivery target at all
		}
		wg.Add(1)
		go func(e notifyStoreEntry) {
			defer wg.Done()
			f := w.transport.Deliver(e.Token, e.Label, data, android, notifyPruneClosure(w.store, e))
			var sendErr error
			if f != nil {
				sendErr = f
			}
			w.store.recordSendResultAsync(e.ID, sendErr)
		}(e)
	}
	wg.Wait()
}
