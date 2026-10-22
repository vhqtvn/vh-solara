package server

// notify_dispatch.go — the central FCM dispatcher (notify controller-hub S4
// / v4 §3.4, brief §2 step 5): consumes the S3 ledger's committed events in
// central-id order and delivers each to every registered token that passes
// the v4 gating ladder, through the SHARED worker sender machinery
// (pkg/alerts.FCMTransport — the controller constructs its OWN instance
// with the controller's credentials; FCM credentials exist only on the
// controller, v4 (a)).
//
// ---------------------------------------------------------------------------
// THE GATING LADDER (v4 §3.4), per (event × token), in order:
//
//   1. Channel enabled — the central dispatcher is armed with a configured
//      transport (rung 0: the loop is not running at all when the channel
//      is unconfigured — nothing is dispatched).
//   2. Token eligibility (v4 §3.2 — the administrative surfaces an `always`
//      policy may NOT bypass): scope.enabled=false suppresses entirely;
//      explicit scope.conditions (the legacy nine-kind fleet vocabulary)
//      restrict to events whose §9.1 condition is an explicit member.
//      Legacy conditions with NO §9.1 counterpart (worker_missing,
//      project_missing, session_error, session_retry, session_done) stay
//      DORMANT and visible: they restrict (match nothing centrally), never
//      broaden to "all".
//   3. Type filter — the event's RECORDED profile eligibility
//      (ProfileEligible, snapshotted at detection on the origin worker;
//      the controller trusts the snapshot, v4 §3.4 rung 2).
//   4. Attendance — the event's DETECTION-TIME attendance snapshot on the
//      ORIGIN worker (per-worker isolation, v4 (h)): an attended snapshot
//      suppresses when_unattended tokens; `always` tokens bypass
//      attendance ONLY (not rungs 2/5/6).
//   5. Freshness — events older than the stale threshold (default 24h,
//      operator-tunable, v4 §9.8) are history-only: never pushed, however
//      much TTL remains.
//   6. Central cooldown — a second push of the same
//      (source_id, type, token_hash) within cooldown_sec (default 300s,
//      the shared knob, operator-tunable) is suppressed; decisions are
//      PERSISTED across controller restarts and replay deterministically
//      (delayed replay cannot starve one worker for another, v4 (i)).
//
// PLUS the open-vocabulary bar (the S3-flagged obligation): an event whose
// Kind is outside the §9.1 condition enumeration is NON-DISPATCH-ABLE —
// logged ONCE per unknown kind (no panic, no silent infinite retry), never
// sent, and the cursor still advances past it.
//
// ---------------------------------------------------------------------------
// EXACTLY-ONCE ATTEMPT SEMANTICS (v4 §3.5/§9.6, brief §3):
//
//   - CLAIM-BEFORE-SEND: the dispatch attempt claim — the (event id, token
//     hash) pair plus the cooldown timestamp — is PERSISTED BEFORE the FCM
//     call. A crash between claim and call is an ACCEPTED best-effort
//     omission: on restart the surviving claim makes the loop SKIP the
//     pair (no blind resend, no duplicate).
//   - The claim outlives the call: it is retained until the dispatch
//     CURSOR passes its event id, so a crash after a completed send but
//     before the cursor persist can never produce a second attempt either.
//   - The cursor is the dispatch loop's own durable state
//     (<notify-store>.dispatch.json) — independent of the ledger journal,
//     which never records delivery state (its events ARE the intents;
//     attempts are this file's concern).
//
// ---------------------------------------------------------------------------
// PRUNING (v4 §3.5/§9.5): evidence-gated on the shared transport's
// canonical UNREGISTERED classification (400/404 with a details[].errorCode
// or top-level error.status — a generic 404/project error RETAINS the
// token), PLUS GENERATION BINDING: the prune closure captures the entry's
// (id, token, per-registration generation) at send-claim time, and the
// generation check AND conditional deletion run ATOMICALLY under the
// store lock (deleteIfRegistrationCurrent). A stale in-flight result must
// not delete a registration that was REFRESHED after the send was claimed
// (a re-POST of the same token MERGES in place — same id+token, refreshed
// label/policy — so id+token alone cannot fence it; the refresh re-mints
// the generation, t1a-F1) or re-registered after a delete (a NEW entry
// with a fresh random id).
//
// ---------------------------------------------------------------------------
// FAILURE OBSERVABILITY mirrors the worker posture (v3 §3.8): one log line
// per failed attempt (token identified label-or-hash — never the value),
// window counters + the periodic channel-health line, and the probe's
// last_attempt/last_error (latest-COMPLETED-attempt pair) — all carried by
// the shared FCMTransport. Registry telemetry (last_used_at/last_error)
// rides the store's existing ASYNC drain.
//
// ---------------------------------------------------------------------------
// ROLLOUT POSTURE (S4): dispatch is DISABLED BY DEFAULT and starts only
// when the operator passes --notify-dispatch (plus --notify-store and
// --notify-fcm-credentials). The old fleet-condition watcher
// (notify_watcher.go) keeps running until S5 retires it — the
// double-delivery risk during the S4 window is bounded by exactly this
// opt-in. DOCUMENTED ENABLE ORDER:
//   1. deploy the S4 controller with dispatch OFF (the watcher keeps
//      serving the legacy program; registration + probe + migration are
//      live);
//   2. verify the token migration (admin masked list / probe counts) and
//      let Pulse re-register (its full-state POSTs set the desired
//      policies without touching administrative disable/scopes);
//   3. only then enable --notify-dispatch — and accept that until S5
//      retires the watcher, fleet-condition pushes (legacy) and per-event
//      pushes (central) may both fire; the S5 cutover (route relocation +
//      watcher retirement) closes the overlap.
//
// ---------------------------------------------------------------------------
// SECRECY: the ledger's events, the store's tokens, and the transport's
// credentials never meet a log line. The dispatch state file keys cooldowns
// and attempts on the TRUNCATED token hash (hex(sha256(token)[:16])), never
// the token itself.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/alerts"
)

// NotifyDispatch defaults (v4 §3.4/§9.8 — the 24h freshness bar is the
// frozen S0 default, operator-tunable; the 300s cooldown is the shared
// detect.cooldown_sec default, likewise a flag here because the controller
// does not read worker alerts configs). The poll interval is an unmeasured
// default like the ingest loop's.
const (
	notifyDispatchDefaultPoll     = 3 * time.Second
	notifyDispatchDefaultBatch    = 200
	notifyDispatchDefaultStale    = 24 * time.Hour
	notifyDispatchDefaultCooldown = 300 * time.Second
	notifyDispatchDefaultTTL      = 86400
	notifyDispatchSchema          = 1
)

// notifyDispatchKinds is the §9.1 condition enumeration — the complete
// dispatch-eligibility vocabulary (mirrors pkg/server/notify_v4_fixture_test
// v4Kinds and notify-fcm.md §9.1, the resolution authority). An event Kind
// outside this set is non-dispatchable (open vocabulary: logged once per
// unknown kind, never sent).
var notifyDispatchKinds = map[string]bool{
	"permission_pending": true,
	"question_pending":   true,
	"session_unread":     true,
	"degraded_thinking":  true,
	"degraded_runaway":   true,
	"degraded_stalled":   true,
	"worker_down":        true,
	"session_started":    true,
}

// NotifyDispatchConfig tunes the central dispatcher. The zero value is the
// documented default posture (normalized fills every field).
type NotifyDispatchConfig struct {
	// PollInterval is the dispatch loop's cadence (unmeasured default 3s).
	PollInterval time.Duration
	// BatchLimit bounds the events processed per pass (default 200).
	BatchLimit int
	// StaleAfter is the freshness threshold: events older than this are
	// history-only (v4 §9.8 default 24h, operator-tunable).
	StaleAfter time.Duration
	// Cooldown is the central per-(source, type, token_hash) push cooldown
	// (the shared cooldown_sec knob; default 300s).
	Cooldown time.Duration
	// TTLSec is the configured FCM TTL bound by each event's remaining
	// freshness (default 86400).
	TTLSec int
}

func (c NotifyDispatchConfig) normalized() NotifyDispatchConfig {
	if c.PollInterval <= 0 {
		c.PollInterval = notifyDispatchDefaultPoll
	}
	if c.BatchLimit <= 0 {
		c.BatchLimit = notifyDispatchDefaultBatch
	}
	if c.StaleAfter <= 0 {
		c.StaleAfter = notifyDispatchDefaultStale
	}
	if c.Cooldown <= 0 {
		c.Cooldown = notifyDispatchDefaultCooldown
	}
	if c.TTLSec <= 0 {
		c.TTLSec = notifyDispatchDefaultTTL
	}
	return c
}

// ---------------------------------------------------------------------------
// Dispatch state (cursor + attempt claims + cooldowns), one JSON file
// ---------------------------------------------------------------------------

// notifyDispatchFile is the persisted dispatch state at
// <notify-store>.dispatch.json. Attempts keys are "<eventID>|<tokenHash>"
// (the exactly-once fence — claims survive until the cursor passes their
// event); Cooldowns keys are "<source_id>|<type>|<tokenHash>" (the event's
// stored CooldownKey plus the token hash) with the last-send unix millis.
// Both maps are pruned (attempts at the cursor, cooldowns past their
// window) so the file stays bounded.
type notifyDispatchFile struct {
	Schema    int              `json:"schema"`
	Cursor    int64            `json:"cursor"`
	Attempts  map[string]int64 `json:"attempts"`
	Cooldowns map[string]int64 `json:"cooldowns"`
}

// loadNotifyDispatchFile reads the dispatch state; a MISSING file is the
// fresh start (cursor 0 — the retained ledger replays through the ladder,
// which suppresses stale events and replays cooldowns deterministically).
// A present-but-corrupt file is a load error: the dispatcher refuses to
// start rather than risk double-sending from a silently reset cursor (the
// set-but-bad discipline).
func loadNotifyDispatchFile(path string) (*notifyDispatchFile, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return &notifyDispatchFile{Schema: notifyDispatchSchema, Attempts: map[string]int64{}, Cooldowns: map[string]int64{}}, nil
		}
		return nil, fmt.Errorf("read dispatch state %s: %v", path, err)
	}
	var f notifyDispatchFile
	if err := json.Unmarshal(raw, &f); err != nil {
		return nil, fmt.Errorf("dispatch state %s: malformed: %v", path, err)
	}
	if f.Schema != notifyDispatchSchema {
		return nil, fmt.Errorf("dispatch state %s: schema %d != %d", path, f.Schema, notifyDispatchSchema)
	}
	if f.Attempts == nil {
		f.Attempts = map[string]int64{}
	}
	if f.Cooldowns == nil {
		f.Cooldowns = map[string]int64{}
	}
	return &f, nil
}

func persistNotifyDispatchFile(path string, f notifyDispatchFile) error {
	f.Schema = notifyDispatchSchema
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return persistAtomic0600(path, data)
}

// notifyTokenHash is the truncated token hash every dispatch-state key
// carries INSTEAD of the token (cooldown state must never retain more
// token material than needed — the same sha256[:16] prefix the worker's
// cooldown map and label-or-hash logging use).
func notifyTokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:16])
}

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

// notifyDispatchManager is the central dispatcher's state: the ledger
// (committed events, in id order), the token registry, the shared
// transport, and the persisted dispatch cursor/attempts/cooldowns.
type notifyDispatchManager struct {
	cfg         NotifyDispatchConfig
	ledger      *notifyLedger
	store       *notifyStoreHolder
	transport   *alerts.FCMTransport
	hostPattern string
	now         func() time.Time

	// path is the dispatch-state file; "" never happens (Start refuses an
	// unconfigured store).
	path string

	mu    sync.Mutex
	state notifyDispatchFile

	// unknownKinds remembers unknown §9.1 kinds already logged (the
	// log-once-per-kind obligation). Guarded by mu.
	unknownKinds map[string]bool

	// fatal marks a FATAL stop (GF2/c-F1: a poisoned ledger). Guarded by mu.
	fatal bool

	// done closes when Run returns; StopNotifyDispatch joins on it.
	done chan struct{}

	// testAfterClaim is a TEST-ONLY seam (nil in production — zero
	// behavior change): invoked after the claim persist and BEFORE the FCM
	// call, so a crash between claim and call is deterministically
	// arrangeable (§9.6 receipt).
	testAfterClaim func()

	// persistFn is the cursor-state persist call — a TEST-ONLY override
	// (nil in production = persistNotifyDispatchFile) so the "send
	// completed but the cursor persist failed" crash window is
	// deterministically arrangeable.
	persistFn func(path string, f notifyDispatchFile) error
}

func newNotifyDispatchManager(ledger *notifyLedger, store *notifyStoreHolder, transport *alerts.FCMTransport, hostPattern, statePath string, cfg NotifyDispatchConfig, state *notifyDispatchFile) *notifyDispatchManager {
	cfg = cfg.normalized()
	return &notifyDispatchManager{
		cfg:          cfg,
		ledger:       ledger,
		store:        store,
		transport:    transport,
		hostPattern:  hostPattern,
		now:          time.Now,
		path:         statePath,
		state:        *state,
		unknownKinds: map[string]bool{},
		done:         make(chan struct{}),
	}
}

// Run ticks until ctx is done or a FATAL condition stops the loop (the
// poison path). The first pass is immediate — a freshly enabled
// dispatcher catches up at once. Run closes m.done on exit.
func (m *notifyDispatchManager) Run(ctx context.Context) {
	defer close(m.done)
	t := time.NewTicker(m.cfg.PollInterval)
	defer t.Stop()
	for {
		if m.isFatal() {
			return
		}
		m.dispatchPass(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

func (m *notifyDispatchManager) isFatal() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.fatal
}

// stopFatal marks the manager fatally stopped and logs loudly (GF2/c-F1):
// a poisoned ledger refuses every mutation until a successful reopen; the
// dispatcher must stop, never silently spin or retry.
func (m *notifyDispatchManager) stopFatal(err error) {
	m.mu.Lock()
	already := m.fatal
	m.fatal = true
	m.mu.Unlock()
	if !already {
		log.Printf("notify dispatch: FATAL — stopping the central dispatcher (restart required): %v", err)
	}
}

// dispatchPass drains committed events above the cursor through the ladder
// until a pass comes back short (or the context ends / a fatal lands).
func (m *notifyDispatchManager) dispatchPass(ctx context.Context) {
	for {
		if ctx.Err() != nil || m.isFatal() {
			return
		}
		// GF2/c-F1 (the dispatch-loop caller): a poisoned ledger is FATAL —
		// classify, stop the caller, log loudly; NEVER a retryable error
		// and never silent.
		if err := m.ledger.Health(); err != nil {
			if errors.Is(err, ErrNotifyLedgerPoisoned) {
				m.stopFatal(err)
				return
			}
			// Non-poison health errors are not currently produced; treat
			// defensively as fatal too (never spin).
			m.stopFatal(err)
			return
		}
		m.mu.Lock()
		since := m.state.Cursor
		m.mu.Unlock()
		// EventsAfter: the DISPATCH drain order (oldest-first from the
		// cursor; EventsSince's since==0 is the public newest-page shape
		// and would SKIP older events on a fresh dispatcher).
		events := m.ledger.EventsAfter(since, m.cfg.BatchLimit)
		if len(events) == 0 {
			return
		}
		for i := range events {
			if ctx.Err() != nil || m.isFatal() {
				return
			}
			m.processEvent(events[i])
		}
		if len(events) < m.cfg.BatchLimit {
			return
		}
	}
}

// processEvent walks one committed event through the ladder for every
// registered token, persists the attempt claims BEFORE any FCM call, then
// fans the deliveries out concurrently and advances the cursor once all
// outcomes landed. Pure gating (no FCM call) still advances the cursor —
// suppressed events are history-only by design.
func (m *notifyDispatchManager) processEvent(ev NotifyEvent) {
	now := m.now()

	// Open vocabulary: an unknown §9.1 condition is non-dispatchable. Log
	// ONCE per unknown kind, never panic, never retry-loop; the cursor
	// still advances (the event is history).
	if !notifyDispatchKinds[ev.Kind] {
		m.mu.Lock()
		if !m.unknownKinds[ev.Kind] {
			m.unknownKinds[ev.Kind] = true
			m.mu.Unlock()
			log.Printf("notify dispatch: event %d (type %q) carries condition %q outside the §9.1 dispatch vocabulary — non-dispatchable (history-only); future kinds get a mapping before release", ev.ID, ev.Type, ev.Kind)
		} else {
			m.mu.Unlock()
		}
		m.advanceCursor(ev.ID, now)
		return
	}

	// Rung 5 (evaluated before cooldown so a stale event never consumes or
	// records cooldown state): older than the freshness threshold ⇒
	// history-only.
	stale := now.Sub(time.UnixMilli(ev.Ts)) > m.cfg.StaleAfter

	snap := m.store.snapshot()
	type recipient struct {
		entry notifyStoreEntry
		hash  string
	}
	var recipients []recipient
	if !stale {
		for i := range snap.entries {
			e := snap.entries[i]
			// Rung 2 — administrative token eligibility (never bypassed by
			// `always`, v4 §3.2): enabled + explicit-condition membership.
			// Legacy conditions without a §9.1 counterpart match nothing
			// (dormant + visible, never broadened).
			if !notifyScopeMatches(e.Scope, ev.Kind) {
				continue
			}
			// Rung 3 — the detection-time type-filter snapshot (the origin
			// worker already evaluated wantsType; trust the snapshot).
			if !ev.ProfileEligible {
				continue
			}
			// Rung 4 — detection-time attendance on the ORIGIN worker;
			// `always` bypasses attendance ONLY.
			if ev.Attended && alerts.NormalizePushPolicy(e.PushPolicy) != alerts.PolicyAlways {
				continue
			}
			hash := notifyTokenHash(e.Token)
			m.mu.Lock()
			_, attempted := m.state.Attempts[strconv.FormatInt(ev.ID, 10)+"|"+hash]
			cooldownKey := ev.CooldownKey + "|" + hash
			lastSend, cooling := m.state.Cooldowns[cooldownKey]
			m.mu.Unlock()
			if attempted {
				continue // exactly-once fence: a claim exists (crash recovery)
			}
			// Rung 6 — central cooldown (persisted; deterministic replay).
			if cooling && now.Sub(time.UnixMilli(lastSend)) < m.cfg.Cooldown {
				continue
			}
			recipients = append(recipients, recipient{entry: e, hash: hash})
		}
	}

	if len(recipients) > 0 {
		// CLAIM-BEFORE-SEND (v4 §9.6): persist the attempt claims AND their
		// cooldown timestamps BEFORE any external call. A crash after this
		// persist is an accepted best-effort omission — the claims survive,
		// the restart skips the pairs, and no duplicate send can occur.
		m.mu.Lock()
		for _, rc := range recipients {
			m.state.Attempts[strconv.FormatInt(ev.ID, 10)+"|"+rc.hash] = now.UnixMilli()
			m.state.Cooldowns[ev.CooldownKey+"|"+rc.hash] = now.UnixMilli()
		}
		claimState := m.snapshotStateLocked()
		m.mu.Unlock()
		if err := persistNotifyDispatchFile(m.path, claimState); err != nil {
			// The claim is not durable: DO NOT send (an unpersisted claim
			// cannot fence a crash). Skip the sends, leave the cursor — the
			// next pass re-evaluates; the in-memory claims make this pass's
			// recipients already-attempted, so this is an omission, never a
			// duplicate.
			log.Printf("notify dispatch: event %d claim persist failed (%v) — sends omitted (no duplicate risk; retried pass)", ev.ID, err)
			m.advanceCursor(ev.ID, now)
			return
		}
		if m.testAfterClaim != nil {
			m.testAfterClaim()
		}

		// The FCM calls: concurrent (a slow transport must not serialize
		// the fan-out), each through the shared transport with the
		// generation-bound prune closure.
		var wg sync.WaitGroup
		for _, rc := range recipients {
			wg.Add(1)
			go func(rc recipient) {
				defer wg.Done()
				data, android := m.buildMessage(ev, now)
				f := m.transport.Deliver(rc.entry.Token, rc.entry.Label, data, android, m.pruneClosure(rc.entry))
				// Registry telemetry off the send critical path (the store's
				// async drain): success records last_used_at and CLEARS
				// last_error; failure records the sanitized summary.
				var sendErr error
				if f != nil {
					sendErr = f
				}
				m.store.recordSendResultAsync(rc.entry.ID, sendErr)
			}(rc)
		}
		wg.Wait()
	}

	m.advanceCursor(ev.ID, now)
}

// advanceCursor durably moves the dispatch cursor past eventID, pruning
// the attempt claims it covers (their exactly-once job is done — the
// cursor itself now fences the events) and cooldown entries past their
// window (bounded state).
func (m *notifyDispatchManager) advanceCursor(eventID int64, now time.Time) {
	m.mu.Lock()
	if eventID <= m.state.Cursor {
		m.mu.Unlock()
		return
	}
	m.state.Cursor = eventID
	for k := range m.state.Attempts {
		// Keys are "<eventID>|<hash>"; the cursor passed every event ≤
		// eventID, so claims whose event id parses ≤ eventID go.
		if idStr, _, ok := strings.Cut(k, "|"); ok {
			if id, err := strconv.ParseInt(idStr, 10, 64); err == nil && id <= eventID {
				delete(m.state.Attempts, k)
			}
		}
	}
	for k, ts := range m.state.Cooldowns {
		if now.Sub(time.UnixMilli(ts)) > m.cfg.Cooldown {
			delete(m.state.Cooldowns, k)
		}
	}
	claimState := m.snapshotStateLocked()
	m.mu.Unlock()
	persist := persistNotifyDispatchFile
	if m.persistFn != nil {
		persist = m.persistFn
	}
	if err := persist(m.path, claimState); err != nil {
		// The sends (if any) already happened under durable claims; an
		// unadvanced cursor only costs re-evaluation, and the surviving
		// claims prevent duplicates. Log and move on — never spin.
		log.Printf("notify dispatch: cursor persist failed after event %d (%v) — claims still fence; next pass re-evaluates", eventID, err)
	}
}

func (m *notifyDispatchManager) snapshotStateLocked() notifyDispatchFile {
	out := notifyDispatchFile{Schema: notifyDispatchSchema, Cursor: m.state.Cursor}
	out.Attempts = make(map[string]int64, len(m.state.Attempts))
	for k, v := range m.state.Attempts {
		out.Attempts[k] = v
	}
	out.Cooldowns = make(map[string]int64, len(m.state.Cooldowns))
	for k, v := range m.state.Cooldowns {
		out.Cooldowns[k] = v
	}
	return out
}

// pruneClosure builds the UNREGISTERED prune action for one in-flight
// send, GENERATION-BOUND (v4 §3.5/§9.5, t1a-F1): the closure captures the
// entry's (id, token, registration generation) at send-claim time, and
// the prune runs check-and-delete ATOMICALLY under the store lock
// (deleteIfRegistrationCurrent). A registration REFRESHED after the claim
// (same id+token re-POST — the submit merge path re-mints the
// generation) SURVIVES; a re-registration after a delete (a NEW entry
// with a fresh random id) and an admin-replaced or already-deleted entry
// are likewise left alone; a same-generation response still prunes.
func (m *notifyDispatchManager) pruneClosure(entry notifyStoreEntry) func() error {
	return func() error {
		deleted, err := m.store.deleteIfRegistrationCurrent(entry.ID, entry.Token, entry.RegGen)
		if err != nil {
			return err
		}
		if deleted {
			log.Printf("notify dispatch: retired unregistered token %s (%s)", entry.ID, labelOrEmpty(entry.Label))
		}
		return nil
	}
}

func labelOrEmpty(label string) string {
	if label == "" {
		return "unlabeled"
	}
	return label
}

// ---------------------------------------------------------------------------
// FCM message construction (the golden fcm_message_v4.json shape)
// ---------------------------------------------------------------------------

// dispatchWorkerURL derives the origin worker's https base URL from the
// CONTROLLER's configured host pattern — never from feed-supplied URLs
// (brief §2). "" when no usable host exists (no pattern or no worker id):
// the caller then omits the link rather than inventing a route.
func dispatchWorkerURL(hostPattern, workerID string) string {
	if hostPattern == "" || workerID == "" || !strings.Contains(hostPattern, "$ID") {
		return ""
	}
	return "https://" + strings.ReplaceAll(hostPattern, "$ID", workerID)
}

// dispatchUIURL builds the deep link to the origin worker's /app with the
// session/dir query params (daemon-level notices — empty sessionID — link
// the worker's /app root). "" (omit) when no usable worker host is
// configured.
func dispatchUIURL(hostPattern, workerID, sessionID, project string) string {
	base := dispatchWorkerURL(hostPattern, workerID)
	if base == "" {
		return ""
	}
	q := url.Values{}
	if sessionID != "" {
		q.Set("session", sessionID)
	}
	if project != "" {
		q.Set("dir", project)
	}
	if enc := q.Encode(); enc != "" {
		return base + "/app?" + enc
	}
	return base + "/app"
}

// buildMessage renders the v4 FCM data-only message for one event (golden
// fixture fcm_message_v4.json): the existing five vh_* keys plus the five
// additive v4 keys (vh_worker_id/name, vh_session_id, vh_history_id,
// vh_ui_url — the link OMITTED from the data map when none exists), and
// the android posture per §9.1: waiting → HIGH priority (Android Doze),
// everything else NORMAL; collapse-by-event; TTL = the configured TTL
// BOUNDED by the event's remaining freshness (an old replay never gets a
// fresh full TTL).
func (m *notifyDispatchManager) buildMessage(ev NotifyEvent, now time.Time) (map[string]string, *alerts.AndroidConfig) {
	workerName := ev.WorkerName
	if workerName == "" {
		workerName = ev.WorkerID
	}
	data := map[string]string{
		"vh_kind":        "notice",
		"vh_event":       ev.Type,
		"vh_condition":   ev.Kind,
		"vh_count":       "1", // fixed in v1 (no aggregation)
		"vh_ts":          strconv.FormatInt(ev.Ts, 10),
		"vh_worker_id":   ev.WorkerID,
		"vh_worker_name": workerName,
		"vh_session_id":  ev.SessionID, // empty string for daemon-level notices, by design
		"vh_history_id":  strconv.FormatInt(ev.ID, 10),
	}
	if ui := dispatchUIURL(m.hostPattern, ev.WorkerID, ev.SessionID, ev.Project); ui != "" {
		data["vh_ui_url"] = ui
	}
	priority := "NORMAL"
	if ev.Type == alerts.TypeWaiting {
		priority = "HIGH"
	}
	// TTL bounded by remaining freshness (>= 1s: the freshness rung already
	// excluded anything older than the threshold; the clamp covers the
	// sub-second boundary).
	ttl := m.cfg.TTLSec
	if remaining := int((m.cfg.StaleAfter - now.Sub(time.UnixMilli(ev.Ts))).Seconds()); remaining < ttl {
		ttl = remaining
	}
	if ttl < 1 {
		ttl = 1
	}
	return data, &alerts.AndroidConfig{Priority: priority, CollapseKey: ev.Type, TTLSeconds: ttl}
}

// ---------------------------------------------------------------------------
// Daemon wiring
// ---------------------------------------------------------------------------

// StartNotifyDispatch arms (idempotently) the central FCM dispatcher. It
// requires: a durable central ledger (armed by LoadNotifyStore — the same
// refusal as the ingest loop: dispatch without a durable ledger could not
// honor exactly-once across a restart), a configured token registry, and a
// configured transport (the controller's own alerts.FCMTransport built
// from --notify-fcm-credentials by cmd/server.go). The dispatch state
// (<notify-store>.dispatch.json) loads here — a corrupt file REFUSES the
// start (set-but-bad), a missing file is the fresh start.
func (d *Daemon) StartNotifyDispatch(cfg NotifyDispatchConfig, transport *alerts.FCMTransport) error {
	d.notifyDispatchMu.Lock()
	defer d.notifyDispatchMu.Unlock()
	if d.notifyDispatch != nil {
		return nil
	}
	led := d.ledger()
	if led == nil || led.path == "" {
		return fmt.Errorf("notify dispatch: no durable ledger armed (--notify-store must load before the dispatcher starts)")
	}
	if transport == nil {
		return fmt.Errorf("notify dispatch: no transport configured (--notify-fcm-credentials required)")
	}
	storePath := d.notifyStore.snapshot().path
	if storePath == "" {
		return fmt.Errorf("notify dispatch: no token registry configured (--notify-store required)")
	}
	state, err := loadNotifyDispatchFile(storePath + ".dispatch")
	if err != nil {
		return err
	}
	m := newNotifyDispatchManager(led, &d.notifyStore, transport, d.HostPattern, storePath+".dispatch", cfg, state)
	ctx, cancel := context.WithCancel(context.Background())
	d.notifyDispatch = m
	d.notifyDispatchCancel = cancel
	go m.Run(ctx)
	// The shared transport's periodic channel-health line, with the
	// controller's own enabled state + policy counts.
	transport.StartHealthLoop(ctx, 0, func() bool { return true }, func() map[string]int {
		snap := d.notifyStore.snapshot()
		return policyCounts(&snap)
	})
	log.Printf("notify dispatch: central dispatcher started (poll %s, stale-after %s, cooldown %s, ttl %ds)", m.cfg.PollInterval, m.cfg.StaleAfter, m.cfg.Cooldown, m.cfg.TTLSec)
	return nil
}

// StopNotifyDispatch stops the dispatcher AND JOINS IT (the same b-F2
// discipline as StopNotifyIngest): Run returns only after dispatchPass
// drains, so when this returns no dispatch goroutine exists anywhere —
// LoadNotifyStore's ledger re-arm can never swap the journal under an
// in-flight send/claim. Idempotent.
func (d *Daemon) StopNotifyDispatch() {
	d.notifyDispatchMu.Lock()
	defer d.notifyDispatchMu.Unlock()
	if d.notifyDispatchCancel != nil {
		d.notifyDispatchCancel()
		d.notifyDispatchCancel = nil
	}
	if m := d.notifyDispatch; m != nil {
		<-m.done
		d.notifyDispatch = nil
	}
}

// centralNotifyEnabled reports whether the central sender is configured
// and attached — the v4 probe's `enabled` (controller sender readiness,
// NOT worker coverage).
func (d *Daemon) centralNotifyEnabled() bool {
	d.notifyDispatchMu.Lock()
	defer d.notifyDispatchMu.Unlock()
	return d.notifyDispatch != nil
}

// centralNotifyHealth exposes the armed central sender's
// latest-completed-attempt pair for the v4 probe.
func (d *Daemon) centralNotifyHealth() (time.Time, string) {
	d.notifyDispatchMu.Lock()
	m := d.notifyDispatch
	d.notifyDispatchMu.Unlock()
	if m == nil {
		return time.Time{}, ""
	}
	return m.transport.Health()
}
