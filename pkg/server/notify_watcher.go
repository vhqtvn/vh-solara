package server

// notify_watcher.go — the fleet-condition watcher + async sender
// (slice S2; see notify_transport.go for the program header). THE
// NOBODY-POLLS SAFETY: fleet generations are lazy — they exist only
// when something requests /vh/fleet/status. If sends were attached to
// requested refreshes only, detection would stop the moment no UI
// polls. This watcher therefore OBSERVES ON ITS OWN CADENCE: each tick
// forces a refresh through the EXISTING fleetStatusService (serve() is
// single-flight and TTL-cached; the default 5s TTL under a 15s tick
// means every tick refreshes, and concurrent UI requests coalesce onto
// the same in-flight refresh — zero duplicate acquisition). Acquisition
// is never re-implemented here.
//
// Consumption: each tick unmarshals the published generation body (the
// same bytes clients get) into fleetStatusResponse and diffs
// conditions[] against the last observed state, per kind:
//
//   - appeared (absent→present): POSITIVE evidence — acted on even
//     under incomplete coverage. Pushes (post-clear state resets make
//     it always push-eligible).
//   - changed (present→present, different count): history ALWAYS
//     records it; a push happens ONLY for an observed increase that is
//     also eligible vs the suppression state (see below). Decreases
//     never push — increase-only pushes, by decision.
//   - cleared (present→absent): only under COMPLETE coverage
//     (fleetCoverage.Complete = every in-scope worker acquisition was
//     ok). Incomplete coverage means absence is UNKNOWN: the clear is
//     suppressed, NOTHING is recorded, and the state is held for the
//     next complete generation — a missing worker must never masquerade
//     as recovered fleet health. Decreases get the same conservative
//     hold under incomplete coverage (a partial generation naturally
//     shows lower counts); the mission text mandates it for clears, and
//     the same no-false-recovery logic covers decreases.
//
// Suppression (persists across flaps): per-kind lastNotifiedAt +
// lastPushedCount. A push candidate fires when the count INCREASED past
// what the operator was last told (lastPushedCount) — which bypasses
// the cooldown — or when the cooldown (default 2 min, code-owned this
// slice) has elapsed since the last push. Partial recoveries (3→2→3
// with lastPushedCount 5) therefore flap-push at most once per cooldown
// window. A clear RESETS the state (lastPushedCount 0, zero
// lastNotifiedAt), so a genuine re-appearance always notifies — clears
// are rare and valuable. Pushes update the suppression state; history-
// only records do not.
//
// Dispatch: the human title/body reuse the rollup's own label ladder
// (conditionPhrase/pluralCount), sends fan out concurrently to every
// registry token whose scope matches (enabled AND conditions empty-or-
// contains the kind), and the completed delivery outcomes land in ONE
// atomic history entry (notify_history.go — push is best-effort,
// history is the reliable record). Sends run inside the tick (bounded
// by the transport's own 10s timeout; the 15s interval keeps ticks
// effectively non-overlapping) so history ids stay monotonic and
// ordered by observation. Registry telemetry (last_used_at/last_error)
// is handed to the store's ASYNC drain (recordSendResultAsync) — the
// send critical path never waits on a file write.
//
// Retirement: a *NotifyUnregisteredError outcome removes the token from
// the registry (holder delete: persist-before-swap + structural gen
// bump) and marks the delivery row retired. A BARE 404 (plain class
// since the S2 split) records a failed delivery ONLY — a misconfigured
// FCM project answering 404 must never mass-retire the registry.
//
// FCM data vocabulary for fleet events (the Android app contract; the
// test-send keeps vh_kind "test" unchanged):
//
//	vh_kind:      "fleet"
//	vh_event:     "appeared" | "changed" | "cleared"
//	vh_condition: "<kind>"    (one of the nine fleet condition kinds)
//	vh_count:     "<n>"       (decimal; cleared events carry "0")
//	vh_ts:        "<RFC3339>" (UTC emit time)
//
// notification.title is always "vh-solara"; notification.body is the
// human phrase ("2 permissions pending", "1 worker down (cleared)").
//
// Baseline: the watcher's FIRST observation is a SILENT state adoption
// (no pushes, no history) — a controller restart over standing
// conditions is not news. Lifetime: run() parks on its context; the
// daemon wiring starts it with context.Background() because this
// daemon HAS no shutdown path (Start → ListenAndServe forever; the
// DaemonAddr listener goroutine is equally immortal) — the context
// seam exists so a future graceful-shutdown path can cancel it.

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strconv"
	"sync"
	"time"
)

const (
	// notifyWatchInterval is the watcher's own observation cadence.
	// Unexported default; deliberately NO flag this slice.
	notifyWatchInterval = 15 * time.Second
	// notifyCooldown suppresses repeat per-kind notifications unless
	// the count increased past the last PUSHED count. Code-owned
	// default this slice (a cooldown_s may ride the store file later).
	notifyCooldown = 2 * time.Minute
	// notifyTitle is the fixed visible-notification title.
	notifyTitle = "vh-solara"
	// notifyBodyMaxRunes bounds the human body (plenty for the label
	// ladder; guards pathological labels).
	notifyBodyMaxRunes = 120
	// notifyFleetKind is the data-vocabulary discriminator for real
	// fleet events (test-send uses "test").
	notifyFleetKind = "fleet"
)

// notifyCondState is the watcher's per-kind observation + suppression
// state. Owned by the single goroutine invoking tick (the run loop, or
// a test) — deliberately unguarded.
type notifyCondState struct {
	present bool
	count   int // last observed count (updated on every observation acted on)

	// Suppression state — updated ONLY by actual pushes:
	lastPushedCount int       // the count the operator was last told
	lastNotifiedAt  time.Time // zero = never pushed since the last clear/reset
}

// notifyWatcher observes the fleet rollup on its own cadence and
// dispatches condition-transition pushes.
type notifyWatcher struct {
	d        *Daemon
	interval time.Duration
	cooldown time.Duration

	// last maps each of the nine kinds to its state; nil until the
	// first tick adopts the baseline.
	last map[string]*notifyCondState
}

func newNotifyWatcher(d *Daemon, interval, cooldown time.Duration) *notifyWatcher {
	return &notifyWatcher{d: d, interval: interval, cooldown: cooldown}
}

// run observes immediately (silent baseline) and then every interval
// until ctx is cancelled.
func (w *notifyWatcher) run(ctx context.Context) {
	ticker := time.NewTicker(w.interval)
	defer ticker.Stop()
	w.tick(ctx)
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			w.tick(ctx)
		}
	}
}

// tick forces one observation through the fleet-status service and acts
// on the transitions since the last tick.
func (w *notifyWatcher) tick(ctx context.Context) {
	gen, err := w.d.fleetStatusService().serve(ctx)
	if err != nil {
		log.Printf("notify: watcher tick skipped (no fleet generation): %v", err)
		return
	}
	var resp fleetStatusResponse
	if err := json.Unmarshal(gen.body, &resp); err != nil {
		// Cannot happen (the body is this package's own marshal), but a
		// corrupt generation must never loop-crash the watcher.
		log.Printf("notify: watcher tick skipped (undecodable generation): %v", err)
		return
	}
	now := time.Now().UTC()
	current := make(map[string]fleetCondition, len(resp.Conditions))
	for _, c := range resp.Conditions {
		current[c.Kind] = c
	}

	// First observation: adopt the baseline silently. Standing
	// conditions predate this watcher; they are not transitions.
	if w.last == nil {
		w.last = make(map[string]*notifyCondState, len(fleetConditionOrder))
		for _, kind := range fleetConditionOrder {
			st := &notifyCondState{}
			if c, ok := current[kind]; ok {
				st.present, st.count = true, c.Count
			}
			w.last[kind] = st
		}
		return
	}

	for _, kind := range fleetConditionOrder {
		st := w.last[kind] // baseline populated all nine
		c, present := current[kind]
		newCount := 0
		if present {
			newCount = c.Count
		}
		switch {
		case st.present == present && (!present || st.count == newCount):
			// No transition.
		case !st.present && present:
			// APPEARED — positive evidence, acted on under any coverage.
			st.present, st.count = true, newCount
			if w.pushEligible(st, newCount, now) {
				w.dispatch(ctx, kind, notifyActionAppeared, newCount, conditionBody(c, kind, newCount), now)
				st.lastNotifiedAt, st.lastPushedCount = now, newCount
			}
		case st.present && present:
			// CHANGED (count differs).
			old := st.count
			if newCount < old && !resp.Coverage.Complete {
				// A decrease observed under incomplete coverage is
				// UNKNOWN, not evidence (a missing worker lowers counts
				// by itself): hold the state, record nothing.
				continue
			}
			st.count = newCount
			body := conditionBody(c, kind, newCount)
			if newCount > old && w.pushEligible(st, newCount, now) {
				w.dispatch(ctx, kind, notifyActionChanged, newCount, body, now)
				st.lastNotifiedAt, st.lastPushedCount = now, newCount
			} else {
				// Decrease, or a suppressed partial rise: history-only.
				w.recordHistoryOnly(kind, notifyActionChanged, newCount, body, now)
			}
		case st.present && !present:
			// CLEAR candidate — requires complete coverage.
			if !resp.Coverage.Complete {
				continue // unknown: hold state, record nothing
			}
			w.dispatch(ctx, kind, notifyActionCleared, 0, clearedBody(kind, st.count), now)
			*st = notifyCondState{} // reset suppression too — a genuine re-appearance always notifies
		}
	}
}

// pushEligible is the suppression rule: fire when the count increased
// past the last PUSHED count (cooldown bypass), or when the cooldown
// window since the last push has elapsed (a zero lastNotifiedAt — the
// post-clear reset — reads as elapsed).
func (w *notifyWatcher) pushEligible(st *notifyCondState, newCount int, now time.Time) bool {
	if newCount > st.lastPushedCount {
		return true
	}
	return now.Sub(st.lastNotifiedAt) >= w.cooldown
}

// conditionBody renders the human body for an appeared/changed
// transition: the rollup's own label when present, the pluralCount
// ladder otherwise, bounded to notifyBodyMaxRunes.
func conditionBody(c fleetCondition, kind string, count int) string {
	label := c.Label
	if label == "" {
		label = pluralCount(count, conditionPhrase(kind, true), conditionPhrase(kind, false))
	}
	return truncateRunes(label, notifyBodyMaxRunes)
}

// clearedBody renders the clear phrase from the last-known count: "1
// worker down (cleared)".
func clearedBody(kind string, lastCount int) string {
	return truncateRunes(pluralCount(lastCount, conditionPhrase(kind, true), conditionPhrase(kind, false))+" (cleared)", notifyBodyMaxRunes)
}

// recordHistoryOnly appends a transition that will not be pushed
// (decreases, suppressed partial rises): the reliable record still gets
// it, with an empty delivery set.
func (w *notifyWatcher) recordHistoryOnly(kind, action string, count int, body string, now time.Time) {
	w.d.notifyHistory.append(notifyHistoryEntry{
		TS: now, Kind: kind, Action: action, Count: count,
		Title: notifyTitle, Body: body, Deliveries: []notifyDeliveryRecord{},
	})
}

// dispatch fans one transition out to every scope-matching registry
// token and records the atomic history entry. Sends run concurrently
// (one goroutine per token — a slow transport must not serialize the
// fan-out); the entry is appended after all outcomes land, so its
// deliveries are complete. ctx bounds the sends (the transport adds
// its own per-request timeout).
func (w *notifyWatcher) dispatch(ctx context.Context, kind, action string, count int, body string, now time.Time) {
	msg := NotifyMessage{
		Title: notifyTitle,
		Body:  body,
		Data: map[string]string{
			"vh_kind":      notifyFleetKind,
			"vh_event":     action,
			"vh_condition": kind,
			"vh_count":     strconv.Itoa(count),
			"vh_ts":        now.Format(time.RFC3339),
		},
	}
	snap := w.d.notifyStore.snapshot()
	recipients := make([]notifyStoreEntry, 0, len(snap.entries))
	for i := range snap.entries {
		if notifyScopeMatches(snap.entries[i].Scope, kind) {
			recipients = append(recipients, snap.entries[i])
		}
	}
	sender := w.d.notifySender()

	deliveries := make([]notifyDeliveryRecord, len(recipients))
	var wg sync.WaitGroup
	for i := range recipients {
		e := recipients[i]
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			sendErr := sender.Send(ctx, e.Token, msg)
			rec := notifyDeliveryRecord{TokenID: e.ID, OK: sendErr == nil}
			if sendErr != nil {
				rec.Error = truncateRunes(sendErr.Error(), maxNotifyLastErrorBytes)
			}
			var unreg *NotifyUnregisteredError
			if errors.As(sendErr, &unreg) {
				// Confirmed dead registration: retire it. A persist
				// failure is logged (the token stays and will retry the
				// retirement on its next send); a bare 404 never reaches
				// here — that class does not retire.
				if gone, err := w.d.notifyStore.delete(e.ID); err != nil {
					log.Printf("notify: retiring unregistered token %s failed: %v", e.ID, err)
				} else if gone {
					rec.Retired = true
					log.Printf("notify: retired unregistered token %s (%s)", e.ID, e.Label)
				}
			}
			// Registry telemetry off the send critical path (async
			// drain): the outcome above is already captured for history.
			w.d.notifyStore.recordSendResultAsync(e.ID, sendErr)
			deliveries[i] = rec
		}(i)
	}
	wg.Wait()

	w.d.notifyHistory.append(notifyHistoryEntry{
		TS: now, Kind: kind, Action: action, Count: count,
		Title: notifyTitle, Body: body, Deliveries: deliveries,
	})
}

// notifyScopeMatches reports whether a device scope selects a condition
// kind: enabled AND (conditions empty = all nine kinds OR an explicit
// member). Unknown kinds match nothing but the empty list (defensive —
// the registry validates against the nine-kind vocabulary anyway).
func notifyScopeMatches(s notifyScope, kind string) bool {
	if !s.Enabled {
		return false
	}
	if len(s.Conditions) == 0 {
		return true
	}
	for _, c := range s.Conditions {
		if c == kind {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// Daemon wiring
// ---------------------------------------------------------------------------

// StartNotifyWatcher starts the fleet-condition watcher IFF both the
// token registry (--notify-store) and a real transport
// (--notify-fcm-credentials) are configured: no store → nobody to send
// to; no creds → nothing to send through. History-only mode (store set,
// creds unset) is deliberately NOT built half-way this slice — the
// watcher simply does not start, and POST /vh/notify/test's 409 already
// covers manual transport checks. Idempotent (once per Daemon); returns
// whether the watcher is running. cmd/server.go calls this after
// SetNotifyTransport; tests drive newNotifyWatcher/tick directly.
func (d *Daemon) StartNotifyWatcher() bool {
	d.notifyWatchOnce.Do(func() {
		if !d.notifyStore.configured() || notifyTransportDisabled(d.notifyTransport) {
			return
		}
		w := newNotifyWatcher(d, notifyWatchInterval, notifyCooldown)
		go w.run(context.Background())
		d.notifyWatcherRunning = true
		log.Printf("notify: fleet watcher started (interval %s, cooldown %s)", notifyWatchInterval, notifyCooldown)
	})
	return d.notifyWatcherRunning
}
