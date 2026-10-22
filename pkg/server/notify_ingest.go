package server

// notify_ingest.go — the controller pull loop (notify controller-hub S3 /
// brief §2 steps 3-5, v4 §2/§9.3): per-source loops over the S2 enrollment
// registry that pull private feed pages through the real tunnel and commit
// them into the central transactional ledger (notify_ledger.go) with
// exactly-once ingestion, then ACK the worker's durable watermark.
//
// ---------------------------------------------------------------------------
// THE LOOP'S INVARIANTS (each is pinned by a lane-1 test)
// ---------------------------------------------------------------------------
//
//   - One active fetch per source: an in-flight map skips a source whose
//     previous pull has not returned; a source is never fetched concurrently
//     with itself (its cursor state is single-threaded by construction).
//   - Bounded fleet concurrency: a semaphore caps simultaneous fetches
//     (MaxConcurrent, default 4) regardless of enrolled-source count.
//   - Cursor resume from the COMMITTED ledger, never memory-only: the
//     fetch's since_seq is read from the ledger's per-source state AFTER the
//     previous commit (post-crash, post-restart — same value).
//   - Stop JOINS the sweep (b-F2): StopNotifyIngest returns only after every
//     pull goroutine has returned (Run closes m.done after tickOnce drains),
//     and each pull re-checks ctx between a successful fetch and its commit —
//     a cancelled pull never commits/ACKs, so an old pull can never land
//     against a ledger the stopper replaced (the LoadNotifyStore re-arm).
//   - Commit-then-ACK (brief §2 step 5): PostNotifyAck is driven only after
//     the page's events+cursor+dedupe+gap are durably committed, and the
//     ledger's RecordAck structurally refuses an ACK beyond the committed
//     cursor (also enforced at journal replay). A failed ACK is retried on
//     later polls — the worker's trim is lazy, so a lagging ACK costs
//     nothing but a re-POST (idempotent, monotone).
//   - Partial page ⇒ commit-or-nothing: the ledger's one-line commit is
//     all-or-nothing; a failed commit leaves the cursor where it was, the
//     page is re-fetched from that cursor, and the dedupe absorbs the replay.
//   - Identity before mutation (b-F2): every fetched response is validated
//     at decode time (source_id == the enrolled source, non-empty epoch)
//     BEFORE any durable write — a wrong-source page mutates NOTHING (no
//     epoch reset, no commit, no ack) and only costs a failure/backoff
//     cycle. The epoch-change reset fires only for a correctly identified
//     source whose epoch differs.
//
// ---------------------------------------------------------------------------
// EPOCH RECONCILIATION (S2-review F6) — source replacement
// ---------------------------------------------------------------------------
//
// The feed's meta.epoch is the identity the cursor was built on. When it
// differs from the ledger's committed epoch, the source was REPLACED (a
// genuine worker-side rotation, v4 §9.2): the old epoch's sequence space is
// a different namespace than the new one's, so the cursor MUST NOT be
// interpreted across the boundary. The loop:
//
//   1. ResetSourceEpoch(sourceID, newEpoch) — records an open-end gap under
//      the DEPARTED epoch from oldCursor+1 (the worker cannot name the old
//      epoch's final seq) and resets cursor/dedupe/ack under the new epoch;
//   2. re-fetches from since_seq=0 (the new epoch from its head) — the page
//      fetched under the OLD epoch is never committed;
//   3. a source that rotates again mid-reconciliation (epoch churn beyond a
//      small bound) surfaces as a failure and backs off — never a silent
//      mixed-epoch commit (the ledger would reject it as corruption anyway).
//
// ---------------------------------------------------------------------------
// REGISTRY FRESHNESS (S2-review F7) — dead entries and fresh credentials
// ---------------------------------------------------------------------------
//
// A feed fetch that fails (404/auth/transport/timeout) does NOT immediately
// retry: the loop re-checks the enrollment registry —
//
//   - if the entry's token or epoch CHANGED since the fetch (the worker
//     re-enrolled — a restarted worker mints a fresh token), the failure
//     says nothing about the NEW credentials: backoff is reset and the next
//     tick pulls with the fresh registry entry (never a stale-token replay
//     after a rejected re-enrollment);
//   - otherwise the failure counts against the source: exponential backoff
//     from the poll interval up to MaxBackoff (default 5m), so a dead entry
//     is not hammered. Backoff resets on the next success or credential
//     change.
//
// Ineligible/legacy sources are never fetched (no token by construction);
// offline workers are skipped without backoff (transient by nature — the
// registry marks them online again on reconnect).
//
// ---------------------------------------------------------------------------
// SECRECY
// ---------------------------------------------------------------------------
//
// The feed token exists in the registry entry, the fetch header, and an
// in-process credential fingerprint used ONLY for equality (never logged,
// never persisted; the ledger carries none of it). Logs name ids, epochs
// (short), seqs, and errors — Proxy errors never echo the token.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/alerts"
	"github.com/vhqtvn/vh-solara/pkg/tunnel"
)

// NotifyIngest defaults. The poll interval (3s) is an UNMEASURED default —
// the controller-hub brief names it "unmeasured default, config-tunable";
// every knob here is a flag (cmd/server.go).
const (
	notifyIngestDefaultPoll        = 3 * time.Second
	notifyIngestDefaultConcurrency = 4
	notifyIngestDefaultPageLimit   = 200 // mirrors the feed's default; worker clamps at 500
	notifyIngestDefaultFetchTTL    = 10 * time.Second
	notifyIngestDefaultBodyCap     = int64(4 << 20) // 500 lean records have huge headroom
	notifyIngestDefaultMaxBackoff  = 5 * time.Minute
	notifyIngestMaxEpochRefetch    = 3 // epoch-churn bound during one reconciliation
)

// NotifyIngestConfig tunes the pull loop. The zero value is the documented
// default posture (normalizeNotifyIngestConfig fills every field).
type NotifyIngestConfig struct {
	// PollInterval is the per-source poll cadence (unmeasured default 3s).
	PollInterval time.Duration
	// MaxConcurrent bounds simultaneous in-flight feed fetches across the
	// fleet (default 4).
	MaxConcurrent int
	// PageLimit is the per-fetch record budget (default 200; the worker
	// clamps at 500).
	PageLimit int
	// FetchTimeout bounds one tunnel exchange (default 10s).
	FetchTimeout time.Duration
	// FetchBodyCap bounds one response body (default 4 MiB).
	FetchBodyCap int64
	// MaxBackoff caps the dead-source exponential backoff (default 5m).
	MaxBackoff time.Duration
}

func (c NotifyIngestConfig) normalized() NotifyIngestConfig {
	if c.PollInterval <= 0 {
		c.PollInterval = notifyIngestDefaultPoll
	}
	if c.MaxConcurrent <= 0 {
		c.MaxConcurrent = notifyIngestDefaultConcurrency
	}
	if c.PageLimit <= 0 {
		c.PageLimit = notifyIngestDefaultPageLimit
	}
	if c.FetchTimeout <= 0 {
		c.FetchTimeout = notifyIngestDefaultFetchTTL
	}
	if c.FetchBodyCap <= 0 {
		c.FetchBodyCap = notifyIngestDefaultBodyCap
	}
	if c.MaxBackoff <= 0 {
		c.MaxBackoff = notifyIngestDefaultMaxBackoff
	}
	if c.MaxBackoff < c.PollInterval {
		c.MaxBackoff = c.PollInterval
	}
	return c
}

// notifyFeedClient is the tunnel transport seam the loop drives (*Proxy in
// production; fakes in lane-1 tests).
type notifyFeedClient interface {
	FetchNotifyFeedPage(ctx context.Context, worker *Worker, token string, sinceSeq int64, limit int, timeout time.Duration, maxBodyBytes int64) ([]byte, error)
	PostNotifyAck(ctx context.Context, worker *Worker, token string, watermark int64, timeout time.Duration, maxBodyBytes int64) ([]byte, error)
}

// notifyFleetView is the worker-registry seam (liveness only; *Registry in
// production).
type notifyFleetView interface {
	GetWorker(workerID string) (*Worker, bool)
	WorkerTransport(workerID string) (*tunnel.MuxTransport, bool)
}

// notifyFeedMetaWire / notifyFeedPageWire decode the private feed response.
// The wire shape is defined by the worker side (pkg/web feedPageResp); these
// are the controller-side mirrors of that contract (deliberately local —
// wire DTOs are duplicated across a wire boundary, like tunnel types).
type notifyFeedMetaWire struct {
	SourceID  string `json:"source_id"`
	Epoch     string `json:"epoch"`
	FirstSeq  int64  `json:"firstSeq"`
	LastSeq   int64  `json:"lastSeq"`
	DurableSq int64  `json:"durableSeq"`
	Overflow  int64  `json:"overflow"`
}

type notifyFeedPageWire struct {
	Source    notifyFeedMetaWire    `json:"source"`
	Records   []alerts.SourceRecord `json:"records"`
	NextSince int64                 `json:"nextSince"`
}

// notifyIngestManager is the pull loop's state. Constructed via
// newNotifyIngestManager; Run drives ticks until ctx is done and closes
// the done channel on exit (StopNotifyIngest joins on it — no pull
// goroutine outlives the stop).
type notifyIngestManager struct {
	cfg     NotifyIngestConfig
	ledger  *notifyLedger
	sources *notifySourceRegistry
	fleet   notifyFleetView
	client  notifyFeedClient

	// sem bounds concurrent fetches across the fleet.
	sem chan struct{}

	// done closes when Run returns. tickOnce drains its pull goroutines
	// (wg.Wait) before Run can exit, so a closed done proves EVERY pull
	// has fully returned — the join StopNotifyIngest needs (b-F2).
	done chan struct{}

	mu sync.Mutex
	// inflight marks sources whose pull has not returned (one active fetch
	// per source).
	inflight map[string]bool
	// failN / eligibleAt implement the dead-source backoff; failedCred
	// remembers the credential fingerprint the failure was recorded under,
	// so a source that has since RE-ENROLLED (new token/epoch) is released
	// from the old credentials' backoff at SCHEDULING time (F7 — the
	// failure never described the new credentials).
	failN      map[string]int
	eligibleAt map[string]time.Time
	failedCred map[string]string
}

func newNotifyIngestManager(ledger *notifyLedger, sources *notifySourceRegistry, fleet notifyFleetView, client notifyFeedClient, cfg NotifyIngestConfig) *notifyIngestManager {
	cfg = cfg.normalized()
	return &notifyIngestManager{
		cfg:        cfg,
		ledger:     ledger,
		sources:    sources,
		fleet:      fleet,
		client:     client,
		sem:        make(chan struct{}, cfg.MaxConcurrent),
		done:       make(chan struct{}),
		inflight:   make(map[string]bool),
		failN:      make(map[string]int),
		eligibleAt: make(map[string]time.Time),
		failedCred: make(map[string]string),
	}
}

// entries returns FULL copies of every registry entry (tokens included) —
// the pull path only; every other read surface uses Describe (token-less).
func (r *notifySourceRegistry) entries() []NotifySourceEntry {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]NotifySourceEntry, 0, len(r.sources))
	for _, e := range r.sources {
		out = append(out, e)
	}
	return out
}

// Run ticks until ctx is done. The first tick is immediate (a freshly
// started controller catches up at once, not after one interval). Run
// closes m.done on exit — the join StopNotifyIngest waits on (b-F2).
func (m *notifyIngestManager) Run(ctx context.Context) {
	defer close(m.done)
	t := time.NewTicker(m.cfg.PollInterval)
	defer t.Stop()
	for {
		m.tickOnce(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}

// tickOnce sweeps every eligible source once: skips ineligible/legacy
// entries (no token by construction), sources under backoff, sources with an
// active fetch, and workers currently offline; pulls the rest with bounded
// concurrency and waits for the sweep to drain (deterministic for tests).
func (m *notifyIngestManager) tickOnce(ctx context.Context) {
	var wg sync.WaitGroup
	for _, e := range m.sources.entries() {
		if e.Ineligible || e.Token == "" {
			continue // never pulled: the explicit ineligible marker / legacy absence
		}
		if w, ok := m.fleet.GetWorker(e.WorkerID); !ok || w == nil {
			continue // worker not registered — transient, no backoff
		}
		if tr, ok := m.fleet.WorkerTransport(e.WorkerID); !ok || tr == nil {
			continue // offline — transient, no backoff
		}
		m.mu.Lock()
		if m.inflight[e.SourceID] {
			m.mu.Unlock()
			continue
		}
		// F7 at scheduling time: a backoff recorded under credentials that
		// have since been REPLACED (the worker re-enrolled with a new
		// token/epoch) does not gate the new credentials — release it.
		if cred := e.Epoch + "\x00" + e.Token; cred != m.failedCred[e.SourceID] && m.failN[e.SourceID] > 0 {
			delete(m.failN, e.SourceID)
			delete(m.eligibleAt, e.SourceID)
		}
		if time.Now().Before(m.eligibleAt[e.SourceID]) {
			m.mu.Unlock()
			continue
		}
		m.inflight[e.SourceID] = true
		m.mu.Unlock()
		wg.Add(1)
		go func(e NotifySourceEntry) {
			defer wg.Done()
			defer m.release(e.SourceID)
			m.pull(ctx, e)
		}(e)
	}
	wg.Wait()
}

func (m *notifyIngestManager) release(sourceID string) {
	m.mu.Lock()
	delete(m.inflight, sourceID)
	m.mu.Unlock()
}

// pull runs one source's fetch→reconcile→commit→ACK pass under a fleet
// concurrency slot, classifying the outcome for backoff.
func (m *notifyIngestManager) pull(ctx context.Context, entry NotifySourceEntry) {
	select {
	case m.sem <- struct{}{}:
		defer func() { <-m.sem }()
	case <-ctx.Done():
		return
	}
	if err := m.pullOnce(ctx, entry); err != nil {
		if errors.Is(err, context.Canceled) {
			return // shutdown is not a source failure
		}
		m.recordFailure(entry, err)
		return
	}
	m.recordSuccess(entry.SourceID)
}

// pullOnce is one pass for one source. The credential snapshot (entry as
// fetched) travels to recordFailure for the F7 freshness comparison.
func (m *notifyIngestManager) pullOnce(ctx context.Context, entry NotifySourceEntry) error {
	cursor, committedEpoch := int64(0), ""
	if st, ok := m.ledger.SourceState(entry.SourceID); ok {
		cursor, committedEpoch = st.HighSeq, st.Epoch
	}

	page, err := m.fetchPage(ctx, entry, cursor)
	if err != nil {
		return err
	}
	// b-F2: the sweep may have been cancelled (StopNotifyIngest) while
	// this fetch was in flight. A cancelled pull must not mutate the
	// ledger — not even the epoch reset below. Returning the ctx error
	// classifies as shutdown, not a source failure.
	if cerr := ctx.Err(); cerr != nil {
		return cerr
	}

	// Epoch reconciliation (F6): a page whose epoch differs from the
	// committed one belongs to a REPLACED source — never commit it under the
	// old cursor. Reset, then re-pull the new epoch from its head. The page
	// was already identity-validated inside fetchPage (b-F2), so the durable
	// reset below can only ever fire for the CORRECTLY identified source.
	wantEpoch := page.Source.Epoch
	if committedEpoch != "" && wantEpoch != committedEpoch {
		if rerr := m.ledger.ResetSourceEpoch(entry.SourceID, wantEpoch); rerr != nil {
			return fmt.Errorf("epoch reset %s -> %s: %w", shortEpoch(committedEpoch), shortEpoch(wantEpoch), rerr)
		}
		cursor = 0
		for refetch := 0; ; refetch++ {
			page, err = m.fetchPage(ctx, entry, 0)
			if err != nil {
				return err
			}
			if page.Source.Epoch == wantEpoch {
				break // the replacement epoch, from its head
			}
			if refetch >= notifyIngestMaxEpochRefetch {
				return fmt.Errorf("epoch churn: feed keeps rotating (%s != %s)", shortEpoch(page.Source.Epoch), shortEpoch(wantEpoch))
			}
			wantEpoch = page.Source.Epoch
			if rerr := m.ledger.ResetSourceEpoch(entry.SourceID, wantEpoch); rerr != nil {
				return fmt.Errorf("epoch reset (churn) -> %s: %w", shortEpoch(wantEpoch), rerr)
			}
		}
	}

	// Overflow gap (worker prefix loss under the SAME epoch): the feed's
	// oldest retained record jumped past our committed cursor+1 — records we
	// never ingested were evicted worker-side. Name the closed range.
	var gap *NotifySourceGap
	if page.Source.FirstSeq > cursor+1 {
		g := NotifySourceGap{
			Epoch:   page.Source.Epoch,
			FromSeq: cursor + 1,
			ToSeq:   page.Source.FirstSeq - 1,
			Reason:  "worker_prefix_lost",
		}
		gap = &g
	}

	records := make([]NotifyEvent, 0, len(page.Records))
	for _, r := range page.Records {
		ev := NotifyEvent{
			Type:      r.Type,
			SessionID: r.SessionID,
			Root:      r.Root,
			Project:   r.Project,
			Title:     r.Title,
			Detail:    r.Detail,
			Ts:        r.Ts,
			// The §9.1 notice-type→condition mapping — ONE authority
			// (alerts.ConditionOf, the same pure function the worker's own
			// push path uses). Total over the vocabulary: never "unknown".
			Kind: alerts.ConditionOf(alerts.Notice{
				Type:      r.Type,
				Kind:      r.Kind,
				SessionID: r.SessionID,
				Root:      r.Root,
				Title:     r.Title,
			}),
			Count:           1,
			Seq:             r.Seq,
			Attended:        r.Attended,
			IdleSec:         r.IdleSec,
			ProfileEligible: r.ProfileEligible,
			CooldownKey:     r.CooldownKey,
		}
		records = append(records, ev)
	}

	// b-F2: re-check between the (successful) fetch and the commit: a
	// cancelled pull never commits against a ledger the stopper may be
	// about to replace (LoadNotifyStore's re-arm). The next sweep
	// re-pulls the same page from the old cursor; dedupe absorbs it.
	if cerr := ctx.Err(); cerr != nil {
		return cerr
	}

	// Commit-or-nothing: events + cursor + dedupe + gap as ONE journal line.
	if _, cerr := m.ledger.CommitPage(notifyPageCommit{
		SourceID:   entry.SourceID,
		WorkerID:   entry.WorkerID,
		WorkerName: entry.WorkerName,
		Epoch:      page.Source.Epoch,
		Records:    records,
		AdvanceTo:  page.NextSince,
		Gap:        gap,
	}); cerr != nil {
		return fmt.Errorf("commit page (cursor=%d, %d records): %w", cursor, len(records), cerr)
	}

	// Commit-then-ACK: only now may the worker learn a durable watermark.
	// A failed ACK is retried on later polls (idempotent, monotone; the
	// worker trims lazily) — it is not a pull failure.
	if post, ok := m.ledger.SourceState(entry.SourceID); ok && post.HighSeq > post.AckedSeq {
		w, wok := m.fleet.GetWorker(entry.WorkerID)
		if !wok || w == nil {
			return nil // worker dropped between commit and ACK — next tick retries
		}
		if _, aerr := m.client.PostNotifyAck(ctx, w, entry.Token, post.HighSeq, m.cfg.FetchTimeout, m.cfg.FetchBodyCap); aerr != nil {
			log.Printf("notify ingest: source %s ACK %d deferred (%v) — retried on a later poll", entry.SourceID, post.HighSeq, aerr)
			return nil
		}
		if rerr := m.ledger.RecordAck(entry.SourceID, post.HighSeq); rerr != nil {
			log.Printf("notify ingest: source %s recording ACK %d failed: %v", entry.SourceID, post.HighSeq, rerr)
		}
	}
	return nil
}

// validateFeedResponse enforces the fetched page's IDENTITY and epoch
// coherence (b-F2): the response must name the enrolled source and carry a
// non-empty epoch. It runs on EVERY fetched response — the initial pull and
// every epoch-reconciliation refetch — at decode time, BEFORE any durable
// mutation can act on the page. A wrong-source response is rejected with
// ZERO durable writes (no ResetSourceEpoch — which would poison the
// enrolled source's dedupe floor — no commit, no ack); the returned error
// classifies as an ordinary source failure (log + backoff).
func validateFeedResponse(entry NotifySourceEntry, page notifyFeedPageWire) error {
	if page.Source.SourceID != entry.SourceID {
		return fmt.Errorf("feed identity mismatch: source_id %q != enrolled %q", page.Source.SourceID, entry.SourceID)
	}
	if page.Source.Epoch == "" {
		return fmt.Errorf("feed served an empty epoch")
	}
	return nil
}

// fetchPage pulls, decodes, and VALIDATES one feed page for a source at
// sinceSeq. Validation (b-F2) happens here — the earliest point after
// decode — so no fetched response can reach the reconcile/commit path (or
// trigger ANY durable mutation) unless it provably belongs to the enrolled
// source and carries a non-empty epoch.
func (m *notifyIngestManager) fetchPage(ctx context.Context, entry NotifySourceEntry, sinceSeq int64) (notifyFeedPageWire, error) {
	var out notifyFeedPageWire
	w, ok := m.fleet.GetWorker(entry.WorkerID)
	if !ok || w == nil {
		return out, fmt.Errorf("worker %s not registered", entry.WorkerID)
	}
	body, err := m.client.FetchNotifyFeedPage(ctx, w, entry.Token, sinceSeq, m.cfg.PageLimit, m.cfg.FetchTimeout, m.cfg.FetchBodyCap)
	if err != nil {
		return out, err
	}
	if err := json.Unmarshal(body, &out); err != nil {
		return out, fmt.Errorf("feed page JSON (since=%d): %w", sinceSeq, err)
	}
	if err := validateFeedResponse(entry, out); err != nil {
		return notifyFeedPageWire{}, fmt.Errorf("feed page (since=%d): %w", sinceSeq, err)
	}
	return out, nil
}

// recordFailure applies the F7 freshness rule then the backoff. The token is
// compared, never logged.
func (m *notifyIngestManager) recordFailure(entryAtFetch NotifySourceEntry, err error) {
	fresh, ok := m.sources.Get(entryAtFetch.SourceID)
	credAtFetch := entryAtFetch.Epoch + "\x00" + entryAtFetch.Token
	refreshed := !ok || fresh.Ineligible || fresh.Epoch+"\x00"+fresh.Token != credAtFetch

	m.mu.Lock()
	if refreshed {
		// The enrollment changed after the fetch: the failure describes the
		// OLD credentials. Retry immediately with the fresh entry — a
		// rejected re-enrollment must not be answered with stale-token
		// replays, and a live re-enrollment must not inherit the corpse's
		// backoff.
		delete(m.failN, entryAtFetch.SourceID)
		delete(m.eligibleAt, entryAtFetch.SourceID)
		delete(m.failedCred, entryAtFetch.SourceID)
		m.mu.Unlock()
		log.Printf("notify ingest: source %s fetch failed (%v) but enrollment has since refreshed — retrying with fresh credentials", entryAtFetch.SourceID, err)
		return
	}
	n := m.failN[entryAtFetch.SourceID] + 1
	m.failN[entryAtFetch.SourceID] = n
	m.failedCred[entryAtFetch.SourceID] = credAtFetch
	delay := m.cfg.PollInterval
	for i := 1; i < n && delay < m.cfg.MaxBackoff; i++ {
		delay *= 2
	}
	if delay > m.cfg.MaxBackoff {
		delay = m.cfg.MaxBackoff
	}
	m.eligibleAt[entryAtFetch.SourceID] = time.Now().Add(delay)
	m.mu.Unlock()
	log.Printf("notify ingest: source %s fetch failed (%v) — backing off %s (failure #%d)", entryAtFetch.SourceID, err, delay, n)
}

func (m *notifyIngestManager) recordSuccess(sourceID string) {
	m.mu.Lock()
	delete(m.failN, sourceID)
	delete(m.eligibleAt, sourceID)
	delete(m.failedCred, sourceID)
	m.mu.Unlock()
}

// ---------------------------------------------------------------------------
// Daemon wiring
// ---------------------------------------------------------------------------

// SetNotifyLedgerRetention overrides the central ledger's retention bound
// (retained central events before prefix compaction; default 50_000 — an
// S3-documented choice, v4 §9.8 freezes no central number). Must be called
// BEFORE LoadNotifyStore (the bound is baked in when the ledger journal is
// armed). n <= 0 restores the default.
func (d *Daemon) SetNotifyLedgerRetention(n int) {
	if n <= 0 {
		n = notifyLedgerFallback
	}
	d.notifyLedgerRetain = n
}

// armNotifyLedgerFor arms (or re-arms) the central ledger journal for an
// armed notify-store path. Called by LoadNotifyStore and by controller-
// restart tests; exported surfaces go through those.
func (d *Daemon) armNotifyLedgerFor(storePath string) error {
	led, err := armNotifyLedger(storePath+".ledger", storePath+".sources", d.notifyLedgerRetain)
	if err != nil {
		return err
	}
	if d.notifyLedger != nil {
		_ = d.notifyLedger.Close()
	}
	d.notifyLedger = led
	return nil
}

// StartNotifyIngest starts the controller pull loop. Refuses a memory-only
// ledger (ingestion without a durable journal would ACK watermarks the
// controller cannot honor across a restart — the exact hazard §9.3 exists
// to prevent). Idempotent. The loop runs until StopNotifyIngest or process
// exit; it naturally idles when no eligible sources are enrolled.
func (d *Daemon) StartNotifyIngest(cfg NotifyIngestConfig) error {
	d.notifyIngestMu.Lock()
	defer d.notifyIngestMu.Unlock()
	if d.notifyIngest != nil {
		return nil
	}
	if d.notifyLedger == nil || d.notifyLedger.path == "" {
		return fmt.Errorf("notify ingest: no durable ledger armed (--notify-store must load before the pull loop starts)")
	}
	if d.notifySources == nil {
		return fmt.Errorf("notify ingest: no source registry")
	}
	m := newNotifyIngestManager(d.notifyLedger, d.notifySources, d.Registry, d.Proxy, cfg)
	ctx, cancel := context.WithCancel(context.Background())
	d.notifyIngest = m
	d.notifyIngestCancel = cancel
	go m.Run(ctx)
	log.Printf("notify ingest: pull loop started (poll %s, concurrency %d, page %d)", m.cfg.PollInterval, m.cfg.MaxConcurrent, m.cfg.PageLimit)
	return nil
}

// StopNotifyIngest stops the pull loop AND JOINS IT (b-F2): cancel alone
// leaves a window where an old pull — already past its fetch — commits and
// ACKs against a ledger the caller replaces next (the LoadNotifyStore
// re-arm path): duplicate ids, phantom trims. Run returns only after
// tickOnce drains every pull goroutine, so when StopNotifyIngest returns
// no pull exists anywhere; an immediate StartNotifyIngest then runs
// exactly one manager (controller-restart posture: the ledger stays armed
// and committed; a later StartNotifyIngest resumes from the committed
// cursors). Idempotent.
func (d *Daemon) StopNotifyIngest() {
	d.notifyIngestMu.Lock()
	defer d.notifyIngestMu.Unlock()
	if d.notifyIngestCancel != nil {
		d.notifyIngestCancel()
		d.notifyIngestCancel = nil
	}
	if m := d.notifyIngest; m != nil {
		// Join the sweep: bounded by the fetch timeout — cancellation
		// propagates into every in-flight tunnel exchange, and tickOnce's
		// wg.Wait drains what remains before Run exits.
		<-m.done
		d.notifyIngest = nil
	}
}

// Internal ledger read surface for S4/S5 and tests (no public routes in S3;
// the public history DTO is S5's hostInterceptor work).

// NotifyLedgerHead is the committed global head — the v4 lastId semantics.
func (d *Daemon) NotifyLedgerHead() int64 {
	if d == nil || d.notifyLedger == nil {
		return 0
	}
	return d.notifyLedger.Head()
}

// NotifyLedgerFirstID is the oldest RETAINED central id (0 when empty) —
// prefix truncation makes [FirstID..Head] contiguous.
func (d *Daemon) NotifyLedgerFirstID() int64 {
	if d == nil || d.notifyLedger == nil {
		return 0
	}
	return d.notifyLedger.FirstID()
}

// NotifyEventsSince pages central events with the v4 public semantics:
// since > 0 → up to limit events with id > since ascending; since == 0 →
// the NEWEST limit events ascending; limit <= 0 → 50.
func (d *Daemon) NotifyEventsSince(since int64, limit int) []NotifyEvent {
	if d == nil || d.notifyLedger == nil {
		return nil
	}
	return d.notifyLedger.EventsSince(since, limit)
}

// NotifyCoverage returns the coverage snapshot (head, truncation marker,
// per-source cursor/ack/gaps) S5 will serve as the public coverage block.
func (d *Daemon) NotifyCoverage() NotifyCoverage {
	if d == nil || d.notifyLedger == nil {
		return NotifyCoverage{Sources: []NotifyCoverageSource{}}
	}
	return d.notifyLedger.Coverage()
}

// NotifySourceCursor reads one source's committed ingest state — the resume
// cursor and accepted watermark (tests, S4/S5, diagnostics).
func (d *Daemon) NotifySourceCursor(sourceID string) (epoch string, cursor, acked int64, ok bool) {
	if d == nil || d.notifyLedger == nil {
		return "", 0, 0, false
	}
	st, ok := d.notifyLedger.SourceState(sourceID)
	if !ok {
		return "", 0, 0, false
	}
	return st.Epoch, st.HighSeq, st.AckedSeq, true
}
