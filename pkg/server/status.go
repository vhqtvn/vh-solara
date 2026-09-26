package server

// status.go — GET /vh/fleet/status: the compact fleet-status rollup API.
//
// STANDING CAVEAT (task card task-2026-09-25-…-compact-readonly-fleet-status-
// rollup-api-controller; contract in tmp/agent-runs/watch-status-20260922/
// api-brief.md): every observation in this rollup is RECENTLY-OBSERVED
// WORKER-STORE STATE, not guaranteed live OpenCode freshness. The worker's
// aggregator store lags upstream OpenCode by its reconciliation interval, and
// a successful HTTP acquisition of a snapshot does not establish live upstream
// truth (pkg/aggregator/reconciliation.go: failure retains prior state). The
// API is honest about *observation* coverage (overall=unknown when coverage is
// incomplete), not about upstream liveness.
//
// Design summary (see the brief for the full field-by-field rationale):
//
//   - Single JSON object, schema:1, additive evolution only.
//   - `overall` vs `known_overall`: severity and coverage are separate axes.
//     Incomplete observation coverage forces overall=unknown — never a silent
//     nominal. Confirmed severity stays visible in known_overall.
//   - `conditions[]`: server-owned display-priority order
//     permission_pending > question_pending > worker_down | worker_missing >
//     session_error | session_retry; each {kind,count,since,label,link}.
//     `since` is the first CONTINUOUSLY observed controller time for the
//     current contributors (continuity tracked across published generations;
//     reset on loss of evidence). `link` is a trusted worker-origin
//     /app?dir=…&session=… URL built from the configured HostPattern (null
//     when no mapping exists) — never from the request Host.
//   - `summary`: server-authored English, ≤30 Unicode code points.
//   - `gauge`: {value 0-1, label, available} — available=false distinguishes
//     "unknown" from a real zero.
//   - Cache: daemon-owned IMMUTABLE generations. Requests within TTL (and
//     with an unchanged Registry.Generation) are served the exact published
//     bytes; the ETag is a strong hash of those bytes, stable within the
//     generation. Refresh is lazy + single-flight (concurrent callers wait on
//     one service-owned refresh), bounded by a total refresh budget, and
//     invalidated INSTANTLY by registry membership/liveness changes — the
//     tunnel-WS close path calls MarkWorkerOffline which bumps the registry
//     generation, so a stale generation is never served (and never 304s).
//   - Acquisition per worker: /vh/projects discovery, then ONE tree-only
//     /vh/snapshot per discovered project (one snapshot = ONE project — the
//     rollup fans out across projects and aggregates). Every fetch goes
//     through Proxy.FetchWorkerJSONBounded (bounded open/handshake/head/body,
//     cap-plus-one excess detection) with the worker transport snapshotted
//     via Registry.WorkerTransport — NEVER the unlocked Worker.Transport read
//     (pre-existing race, follow-up card task-2026-09-26t02-55-05).
//   - Tunnel-closed/offline workers are reported `offline` with NO fan-out
//     attempt. Per-worker in-flight fetches are capped at exactly ONE by
//     construction: refreshes are single-flight and each worker's
//     discovery+snapshots run sequentially inside its own goroutine, so a
//     saturated worker can park at most one opener+janitor pair per refresh
//     (review D2).
//
// Auth: registered on userMux, inside Auth.Middleware + csrfGuard — the same
// session-cookie family as GET /api/workers. GET-only, so no X-VH-CSRF
// requirement (csrfGuard gates unsafe /api/ methods only, and this /vh/ path
// is outside /api/ entirely). Under /vh/*, auth's isAPIRequest classifies the
// request as an API call, so an unauthenticated GET gets a clean 401 — never
// the 303→/auth/login browser redirect (an improvement for non-browser
// consumers: no Accept header needed). The mutation-capable coordination
// bearer does NOT reach this endpoint (coordFront routes only /api/coord/*).
// hostInterceptor carves this path out (exactly like /vh/diag/latency), so
// the controller serves it even on worker subdomains instead of proxying
// down to a worker that has no /vh/fleet/* route.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/state"
)

// ---------------------------------------------------------------------------
// Wire types (schema 1)
// ---------------------------------------------------------------------------

type fleetGauge struct {
	Value     float64 `json:"value"`     // busy-or-retry sessions / total sessions, clamped 0-1
	Available bool    `json:"available"` // false = value is a placeholder (coverage incomplete)
	Label     string  `json:"label"`
}

type fleetCoverage struct {
	Mode            string `json:"mode"`            // expected|discovered
	InventoryKnown  bool   `json:"inventory_known"` // true iff an explicit roster is configured
	Complete        bool   `json:"complete"`        // every in-scope acquisition succeeded
	ProjectScope    string `json:"project_scope"`   // "instantiated" in v1 (see /vh/projects)
	RequiredWorkers int    `json:"required_workers"`
	ObservedWorkers int    `json:"observed_workers"`
	UnknownWorkers  int    `json:"unknown_workers"`
}

type fleetCondition struct {
	Kind  string  `json:"kind"`
	Count int     `json:"count"`
	Since *string `json:"since"` // first continuously observed controller time (RFC3339 UTC)
	Label string  `json:"label"`
	Link  *string `json:"link"` // trusted worker-origin /app deep link, or null
}

type fleetWorkerEntry struct {
	ID         string  `json:"id"`
	Status     string  `json:"status"` // ok|offline|missing|timeout|error|limited
	ObservedAt *string `json:"observed_at"`
}

type fleetStatusResponse struct {
	Schema         int                `json:"schema"`
	Overall        string             `json:"overall"`       // degraded|attention|nominal|unknown
	KnownOverall   string             `json:"known_overall"` // degraded|attention|nominal
	Summary        string             `json:"summary"`       // server English, ≤30 code points
	Gauge          fleetGauge         `json:"gauge"`
	Coverage       fleetCoverage      `json:"coverage"`
	Conditions     []fleetCondition   `json:"conditions"`
	Workers        []fleetWorkerEntry `json:"workers"`
	GeneratedAt    string             `json:"generated_at"`
	MaxStalenessMS int64              `json:"max_staleness_ms"`
}

// Condition kinds in the server-owned display-priority order. Exactly this
// order in conditions[]; at most one aggregate per kind; nonzero counts only.
const (
	fleetCondPermissionPending = "permission_pending"
	fleetCondQuestionPending   = "question_pending"
	fleetCondWorkerDown        = "worker_down"
	fleetCondWorkerMissing     = "worker_missing"
	fleetCondSessionError      = "session_error"
	fleetCondSessionRetry      = "session_retry"
)

var fleetConditionOrder = []string{
	fleetCondPermissionPending,
	fleetCondQuestionPending,
	fleetCondWorkerDown,
	fleetCondWorkerMissing,
	fleetCondSessionError,
	fleetCondSessionRetry,
}

// Worker status enum (workers[].status).
const (
	fleetWorkerOK      = "ok"
	fleetWorkerOffline = "offline"
	fleetWorkerMissing = "missing"
	fleetWorkerTimeout = "timeout"
	fleetWorkerError   = "error"
	fleetWorkerLimited = "limited"
)

// Overall enum values.
const (
	fleetOverallDegraded  = "degraded"
	fleetOverallAttention = "attention"
	fleetOverallNominal   = "nominal"
	fleetOverallUnknown   = "unknown"
)

// ---------------------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------------------

// fleetBudgets are the safety budgets from the contract. Unmeasured initial
// values — not throughput claims; tune after S2 with real fleet numbers
// (task-card open question). All fields are overridable in tests.
type fleetBudgets struct {
	TTL                      time.Duration // serve-generation validity window
	RefreshBudget            time.Duration // total ctx bound for one refresh
	WorkerBudget             time.Duration // per-worker end-to-end bound, INCLUDING semaphore queue wait
	WorkerConcurrency        int           // max workers fetched concurrently per refresh
	MaxWorkersPerRefresh     int           // worker cap; in-scope workers beyond it are `limited`
	MaxProjectsPerWorker     int           // project cap; more projects ⇒ worker `limited`
	MaxResponseBodyBytes     int64         // per-response body cap (cap-plus-one detection)
	MaxWorkerCumulativeBytes int64         // cumulative body budget per worker per refresh
	MaxStalenessMS           int64         // client display-age ceiling surfaced in the response
}

func defaultFleetBudgets() fleetBudgets {
	return fleetBudgets{
		TTL:                      5 * time.Second,
		RefreshBudget:            3 * time.Second,
		WorkerBudget:             2 * time.Second,
		WorkerConcurrency:        8,
		MaxWorkersPerRefresh:     128,
		MaxProjectsPerWorker:     64,
		MaxResponseBodyBytes:     1 << 20, // 1 MiB per response
		MaxWorkerCumulativeBytes: 8 << 20, // 8 MiB cumulative per worker
		MaxStalenessMS:           15000,
	}
}

// ---------------------------------------------------------------------------
// Service: immutable-generation cache + single-flight bounded refresh
// ---------------------------------------------------------------------------

// fleetJSONFetcher acquires one worker-local JSON path. Extracted as a seam so
// lane-1 tests can inject scripted responses without a real yamux session
// (mirrors the fetchWorkerDiag seam used by the diag aggregator). The
// production implementation adapts Proxy.FetchWorkerJSONBounded.
type fleetJSONFetcher func(ctx context.Context, workerID, path string, timeout time.Duration, maxBodyBytes int64) ([]byte, error)

// fleetGeneration is one immutable published rollup. body is the EXACT JSON
// served to every request in this generation; etag is the strong hash of those
// bytes; regGen is the Registry.Generation the rollup was built under (a
// mismatch with the live generation means the body is stale and must never be
// served — nor 304'd).
type fleetGeneration struct {
	body        []byte
	etag        string
	publishedAt time.Time
	regGen      uint64
}

// fleetStatusService is the daemon-owned rollup cache. Where the cache lives:
// one instance per Daemon (lazily created, see Daemon.fleetStatusService),
// holding the current generation plus the condition-continuity tracker.
type fleetStatusService struct {
	d       *Daemon
	budgets fleetBudgets

	mu        sync.Mutex
	cur       *fleetGeneration
	refreshCh chan struct{} // non-nil while a refresh is in flight
	refreshes int           // completed refresh count (test observability; guarded by mu)

	// since is the condition-continuity tracker: contributor key → first
	// continuously observed time. Only mutated inside the single in-flight
	// refresh goroutine (refreshes are single-flight), so it needs no lock of
	// its own.
	since map[string]time.Time
}

func newFleetStatusService(d *Daemon) *fleetStatusService {
	return &fleetStatusService{
		d:       d,
		budgets: defaultFleetBudgets(),
		since:   map[string]time.Time{},
	}
}

// refreshCount reports how many refreshes have completed (test observability).
func (s *fleetStatusService) refreshCount() int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.refreshes
}

// serve returns the current valid generation, refreshing if the cache is
// empty, past TTL, or invalidated by a registry generation change. Concurrent
// callers coalesce onto one service-owned refresh (the refresh context is
// owned by the service, not the first caller). rctx bounds how long the
// caller is willing to wait.
func (s *fleetStatusService) serve(rctx context.Context) (*fleetGeneration, error) {
	// Bounded loop: each iteration either returns a valid generation or waits
	// for exactly one refresh. A registry generation that churns across
	// refreshes (worker flapping) exhausts the loop and yields 503 instead of
	// spinning forever.
	for i := 0; i < 3; i++ {
		s.mu.Lock()
		regGen := s.d.Registry.Generation()
		if s.cur != nil && s.cur.regGen == regGen && time.Since(s.cur.publishedAt) < s.budgets.TTL {
			gen := s.cur
			s.mu.Unlock()
			return gen, nil
		}
		ch := s.refreshCh
		if ch == nil {
			ch = make(chan struct{})
			s.refreshCh = ch
			go s.refresh(ch, regGen)
		}
		s.mu.Unlock()

		// The refresh itself is bounded by RefreshBudget (its ctx) plus small
		// marshal slack; the waiter cap is belt-and-braces so a pathological
		// refresh can never hang a request.
		wait := s.budgets.RefreshBudget*2 + time.Second
		select {
		case <-ch:
		case <-rctx.Done():
			return nil, rctx.Err()
		case <-time.After(wait):
			return nil, fmt.Errorf("fleet status refresh did not settle within %v", wait)
		}
	}
	return nil, fmt.Errorf("fleet status could not produce a current generation (registry liveness kept changing)")
}

// refresh builds and publishes exactly one generation, then wakes all
// waiters. It ALWAYS terminates (its acquisition ctx is bounded) and ALWAYS
// closes done — even on panic, via the deferred recover path that publishes a
// fallback all-unknown generation.
func (s *fleetStatusService) refresh(done chan struct{}, regGen uint64) {
	defer func() {
		if r := recover(); r != nil {
			// A panic mid-build must not strand waiters: publish an honest
			// all-unknown generation (empty coverage, no observations) and
			// let the deferred close wake everyone.
			s.publishFallback(regGen)
		}
		s.mu.Lock()
		s.refreshCh = nil
		s.refreshes++
		s.mu.Unlock()
		close(done)
	}()

	resp := s.buildRollup(time.Now().UTC())
	body, err := json.Marshal(resp)
	if err != nil {
		// Cannot happen (plain structs), but fail honest rather than serve nil.
		s.publishFallback(regGen)
		return
	}
	s.mu.Lock()
	s.cur = &fleetGeneration{
		body:        body,
		etag:        fleetETag(body),
		publishedAt: time.Now().UTC(),
		regGen:      regGen,
	}
	s.mu.Unlock()
}

// publishFallback publishes a minimal honest generation: schema 1, unknown
// overall, empty discovered coverage. Used when a refresh fails so hard there
// are no observations at all.
func (s *fleetStatusService) publishFallback(regGen uint64) {
	resp := fleetStatusResponse{
		Schema:         1,
		Overall:        fleetOverallUnknown,
		KnownOverall:   fleetOverallNominal,
		Summary:        "Unknown coverage",
		Gauge:          fleetGauge{Value: 0, Available: false, Label: "Coverage incomplete"},
		Coverage:       fleetCoverage{Mode: "discovered", InventoryKnown: false, Complete: false, ProjectScope: "instantiated"},
		Conditions:     []fleetCondition{},
		Workers:        []fleetWorkerEntry{},
		GeneratedAt:    time.Now().UTC().Format(time.RFC3339),
		MaxStalenessMS: s.budgets.MaxStalenessMS,
	}
	body, err := json.Marshal(resp)
	if err != nil {
		body = []byte(`{"schema":1,"overall":"unknown"}`)
	}
	s.mu.Lock()
	s.cur = &fleetGeneration{
		body:        body,
		etag:        fleetETag(body),
		publishedAt: time.Now().UTC(),
		regGen:      regGen,
	}
	s.mu.Unlock()
}

// ---------------------------------------------------------------------------
// Rollup construction
// ---------------------------------------------------------------------------

// fleetObservedProject is one successfully acquired per-project observation.
// gate may be nil-bodied in theory; contributions come only from successful
// fetches THIS generation — a failed observation never lends its last-good
// waits as current.
type fleetObservedProject struct {
	dir  string
	gate map[string]state.GateFacts
}

type fleetWorkerResult struct {
	id         string
	status     string
	observedAt time.Time
	projects   []fleetObservedProject
}

// fleetContributor identifies one session-level condition contributor.
type fleetContributor struct {
	worker  string
	dir     string
	session string
}

// buildRollup snapshots the registry, acquires every in-scope online worker
// within the budgets, and folds the observations into the wire response.
// (The registry-generation stamp is applied by the caller in refresh().)
//
// Per-worker in-flight cap: this function runs ONLY inside the single-flight
// refresh goroutine, and per-worker acquisition is sequential (discovery,
// then each project snapshot one at a time), so at most ONE fetch is in
// flight per worker at any moment — by construction, not by semaphore.
func (s *fleetStatusService) buildRollup(now time.Time) fleetStatusResponse {
	b := s.budgets
	fetch := s.fetcher()

	summaries := s.d.Registry.Summaries()
	roster := normalizeFleetRoster(s.d.StatusWorkerRoster)
	byID := make(map[string]bool, len(summaries))
	online := make(map[string]bool, len(summaries))
	for _, ws := range summaries {
		byID[ws.ID] = true
		online[ws.ID] = ws.Online
	}

	// --- scope -----------------------------------------------------------
	var mode string
	var inventoryKnown bool
	var scopeIDs []string
	if len(roster) > 0 {
		mode, inventoryKnown = "expected", true
		scopeIDs = roster
	} else {
		mode, inventoryKnown = "discovered", false
		for _, ws := range summaries {
			scopeIDs = append(scopeIDs, ws.ID)
		}
	}

	results := make([]fleetWorkerResult, 0, len(scopeIDs))
	var toAcquire []string
	for _, id := range scopeIDs {
		switch {
		case !byID[id]:
			results = append(results, fleetWorkerResult{id: id, status: fleetWorkerMissing})
		case !online[id]:
			// Tunnel-closed/offline: NO fan-out attempt (the whole point is
			// not to open streams at a dead tunnel).
			results = append(results, fleetWorkerResult{id: id, status: fleetWorkerOffline})
		default:
			toAcquire = append(toAcquire, id)
		}
	}

	// Worker cap: in-scope-but-not-acquired workers are reported `limited`
	// and make coverage incomplete — never silently dropped.
	var cappedIDs []string
	if len(toAcquire) > b.MaxWorkersPerRefresh {
		cappedIDs = toAcquire[b.MaxWorkersPerRefresh:]
		toAcquire = toAcquire[:b.MaxWorkersPerRefresh]
	}

	// --- bounded acquisition ---------------------------------------------
	ctx, cancel := context.WithTimeout(context.Background(), b.RefreshBudget)
	defer cancel()
	refreshStart := time.Now()

	acquired := make([]fleetWorkerResult, len(toAcquire))
	sem := make(chan struct{}, b.WorkerConcurrency)
	var wg sync.WaitGroup
	for i, id := range toAcquire {
		wg.Add(1)
		go func(i int, id string) {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				acquired[i] = fleetWorkerResult{id: id, status: fleetWorkerTimeout}
				return
			}
			acquired[i] = s.acquireWorker(ctx, id, refreshStart, fetch)
		}(i, id)
	}
	wg.Wait()

	results = append(results, acquired...)
	for _, id := range cappedIDs {
		results = append(results, fleetWorkerResult{id: id, status: fleetWorkerLimited})
	}
	sort.Slice(results, func(i, j int) bool { return results[i].id < results[j].id })

	// --- fold observations ------------------------------------------------
	var totalSessions, busyOrRetry int
	permC, questC, errC, retryC := []fleetContributor{}, []fleetContributor{}, []fleetContributor{}, []fleetContributor{}
	downIDs, missingIDs := []string{}, []string{}
	observed := 0
	for _, r := range results {
		switch r.status {
		case fleetWorkerOK:
			observed++
		case fleetWorkerOffline:
			downIDs = append(downIDs, r.id)
		case fleetWorkerMissing:
			missingIDs = append(missingIDs, r.id)
		}
		for _, p := range r.projects {
			sids := make([]string, 0, len(p.gate))
			for sid := range p.gate {
				sids = append(sids, sid)
			}
			sort.Strings(sids)
			for _, sid := range sids {
				gf := p.gate[sid]
				totalSessions++
				switch gf.Activity {
				case "busy", "retry":
					busyOrRetry++
				}
				c := fleetContributor{worker: r.id, dir: p.dir, session: sid}
				if gf.PendingPermission {
					permC = append(permC, c)
				}
				if gf.PendingQuestion {
					questC = append(questC, c)
				}
				if gf.Activity == "error" {
					errC = append(errC, c)
				}
				if gf.Activity == "retry" {
					retryC = append(retryC, c)
				}
			}
		}
	}

	required := len(scopeIDs)
	// Discovered-empty is explicitly incomplete (an empty discovery is not
	// evidence of an empty fleet — the controller only sees workers that
	// connected since restart). Expected mode is complete only when every
	// configured ID was acquired ok (missing/offline/timeout/error/limited
	// all force incomplete).
	complete := required > 0 && observed == required

	known := fleetKnownOverall(len(downIDs) > 0, len(missingIDs) > 0,
		len(errC) > 0, len(permC) > 0, len(questC) > 0, len(retryC) > 0)
	overall := known
	if !complete {
		overall = fleetOverallUnknown
	}

	// --- conditions (display-priority order, continuity-tracked since) ----
	type condAgg struct {
		kind        string
		count       int
		keys        []string // tracker keys of CURRENT contributors
		sincePrefix string
		label       string
		linkFor     *fleetContributor
	}
	newAgg := func(kind string, count int, contribs []fleetContributor, prefix, label string, linkable bool) condAgg {
		a := condAgg{kind: kind, count: count, sincePrefix: prefix, label: label}
		for _, c := range contribs {
			a.keys = append(a.keys, fmt.Sprintf("%s:%s:%s:%s", prefix, c.worker, c.dir, c.session))
			if linkable {
				a.linkFor = appendContributor(a.linkFor, c)
			}
		}
		return a
	}

	workerAgg := func(kind string, ids []string, prefix, label string) condAgg {
		a := condAgg{kind: kind, count: len(ids), sincePrefix: prefix, label: label}
		for _, id := range ids {
			a.keys = append(a.keys, prefix+":"+id)
		}
		return a
	}

	aggs := []condAgg{
		newAgg(fleetCondPermissionPending, len(permC), permC, "perm", pluralCount(len(permC), "permission pending", "permissions pending"), true),
		newAgg(fleetCondQuestionPending, len(questC), questC, "quest", pluralCount(len(questC), "question pending", "questions pending"), true),
		workerAgg(fleetCondWorkerDown, downIDs, "down", pluralCount(len(downIDs), "worker down", "workers down")),
		workerAgg(fleetCondWorkerMissing, missingIDs, "missing", pluralCount(len(missingIDs), "worker missing", "workers missing")),
		newAgg(fleetCondSessionError, len(errC), errC, "err", pluralCount(len(errC), "session error", "session errors"), true),
		newAgg(fleetCondSessionRetry, len(retryC), retryC, "retry", pluralCount(len(retryC), "session retrying", "sessions retrying"), true),
	}

	conditions := make([]fleetCondition, 0, len(aggs))
	var topKind string
	var topCount int
	for _, a := range aggs { // aggs is already in display-priority order
		if a.count == 0 {
			s.reapSince(a.sincePrefix) // no current contributors ⇒ reset continuity
			continue
		}
		if topKind == "" {
			topKind, topCount = a.kind, a.count
		}
		since := s.trackSince(a.sincePrefix, a.keys, now)
		var link *string
		if a.linkFor != nil {
			link = s.workerAppLink(a.linkFor.worker, a.linkFor.dir, a.linkFor.session)
		}
		conditions = append(conditions, fleetCondition{
			Kind:  a.kind,
			Count: a.count,
			Since: since,
			Label: a.label,
			Link:  link,
		})
	}

	// --- summary / gauge ---------------------------------------------------
	summary := fleetSummary(complete, topKind, topCount)

	gauge := fleetGauge{Value: 0, Available: false, Label: "Coverage incomplete"}
	if complete {
		if totalSessions == 0 {
			gauge = fleetGauge{Value: 0, Available: true, Label: "No sessions"}
		} else {
			v := float64(busyOrRetry) / float64(totalSessions)
			if v < 0 {
				v = 0
			}
			if v > 1 {
				v = 1
			}
			gauge = fleetGauge{
				Value:     v,
				Available: true,
				Label:     fmt.Sprintf("%d/%d busy", busyOrRetry, totalSessions),
			}
		}
	}

	workers := make([]fleetWorkerEntry, 0, len(results))
	for _, r := range results {
		e := fleetWorkerEntry{ID: r.id, Status: r.status}
		if r.status == fleetWorkerOK {
			ts := r.observedAt.UTC().Format(time.RFC3339)
			e.ObservedAt = &ts
		}
		workers = append(workers, e)
	}

	return fleetStatusResponse{
		Schema:       1,
		Overall:      overall,
		KnownOverall: known,
		Summary:      summary,
		Gauge:        gauge,
		Coverage: fleetCoverage{
			Mode:            mode,
			InventoryKnown:  inventoryKnown,
			Complete:        complete,
			ProjectScope:    "instantiated",
			RequiredWorkers: required,
			ObservedWorkers: observed,
			UnknownWorkers:  required - observed,
		},
		Conditions:     conditions,
		Workers:        workers,
		GeneratedAt:    now.Format(time.RFC3339),
		MaxStalenessMS: b.MaxStalenessMS,
	}
}

// acquireWorker performs one worker's sequential acquisition: /vh/projects
// discovery, then ONE tree-only /vh/snapshot per discovered project (one
// snapshot covers exactly ONE project — the multi-project fan-out the rollup
// must do per worker). Sequential by design: at most one in-flight fetch per
// worker (D2 cap).
func (s *fleetStatusService) acquireWorker(ctx context.Context, workerID string, refreshStart time.Time, fetch fleetJSONFetcher) fleetWorkerResult {
	b := s.budgets
	res := fleetWorkerResult{id: workerID}
	limited := false
	var cumulative int64

	fetchBounded := func(path string) ([]byte, error) {
		// The per-worker budget includes queue wait (it is measured from the
		// refresh start), so a worker that sat behind the semaphore spends its
		// budget there — honestly reported as timeout, not hidden.
		remaining := b.WorkerBudget - time.Since(refreshStart)
		if remaining <= 0 {
			return nil, &FetchTimeoutError{
				WorkerID: workerID,
				Stage:    "worker budget",
				Cause:    errors.New("per-worker end-to-end budget exhausted before fetch"),
			}
		}
		return fetch(ctx, workerID, path, remaining, b.MaxResponseBodyBytes)
	}

	// 1. Project discovery (instantiated aggregators only).
	body, err := fetchBounded("/vh/projects")
	if err != nil {
		res.status = classifyFetchErr(err)
		return res
	}
	var projects []struct {
		Dir string `json:"dir"`
	}
	if err := json.Unmarshal(body, &projects); err != nil {
		res.status = fleetWorkerError // malformed ⇒ error, not limited
		return res
	}
	cumulative += int64(len(body))
	sort.Slice(projects, func(i, j int) bool { return projects[i].Dir < projects[j].Dir })
	if len(projects) > b.MaxProjectsPerWorker {
		projects = projects[:b.MaxProjectsPerWorker]
		limited = true // deterministic cap exclusion, never silent truncation
	}

	// 2. One tree-only snapshot per project (no sessions param ⇒ no messages).
	for _, p := range projects {
		path := "/vh/snapshot"
		if p.Dir != "" {
			path += "?dir=" + url.QueryEscape(p.Dir)
		}
		body, err := fetchBounded(path)
		if err != nil {
			res.status = classifyFetchErr(err)
			return res
		}
		var snap struct {
			Gate map[string]state.GateFacts `json:"gate"`
		}
		if err := json.Unmarshal(body, &snap); err != nil {
			res.status = fleetWorkerError
			return res
		}
		cumulative += int64(len(body))
		res.projects = append(res.projects, fleetObservedProject{dir: p.Dir, gate: snap.Gate})
		if cumulative > b.MaxWorkerCumulativeBytes {
			// This project's observation is real and stays; further fetches stop.
			res.status = fleetWorkerLimited
			return res
		}
	}

	if limited {
		res.status = fleetWorkerLimited
		return res
	}
	res.status = fleetWorkerOK
	res.observedAt = time.Now()
	return res
}

// classifyFetchErr maps an acquisition error to the worker status enum.
// Timeout-classified errors (FetchTimeoutError satisfies os.IsTimeout) are
// timeouts; a body over the cap is a `limited` cap exclusion; everything else
// (malformed, non-2xx, transport closed mid-fetch) is `error`.
func classifyFetchErr(err error) string {
	if errors.Is(err, ErrFetchResponseBodyTooLarge) {
		return fleetWorkerLimited
	}
	if os.IsTimeout(err) {
		return fleetWorkerTimeout
	}
	return fleetWorkerError
}

// fetcher returns the acquisition seam: the test override when set, else the
// production adapter over Proxy.FetchWorkerJSONBounded. The synthesized
// &Worker{ID} carries everything FetchWorkerJSONBounded needs (it snapshots
// the transport itself via Registry.WorkerTransport — the locked accessor).
func (s *fleetStatusService) fetcher() fleetJSONFetcher {
	if s.d.fetchWorkerJSON != nil {
		return s.d.fetchWorkerJSON
	}
	return func(ctx context.Context, workerID, path string, timeout time.Duration, maxBodyBytes int64) ([]byte, error) {
		return s.d.Proxy.FetchWorkerJSONBounded(ctx, &Worker{ID: workerID}, path, timeout, maxBodyBytes)
	}
}

// ---------------------------------------------------------------------------
// Continuity tracker (condition `since`)
// ---------------------------------------------------------------------------

// trackSince records the current contributor set for one condition kind and
// returns the earliest first-continuously-observed time across contributors
// (nil never happens for a nonempty set). Contributors absent from keys are
// RESET (their continuity is lost — loss of evidence, disappearance,
// reconnect, or restart); a routine gap between valid refreshes is not a gap
// in continuity because only published observations update the tracker.
func (s *fleetStatusService) trackSince(prefix string, keys []string, now time.Time) *string {
	present := make(map[string]bool, len(keys))
	earliest := now
	for _, k := range keys {
		present[k] = true
		t, ok := s.since[k]
		if !ok {
			t = now
			s.since[k] = now
		}
		if t.Before(earliest) {
			earliest = t
		}
	}
	// Reset continuity for contributors no longer current.
	for k := range s.since {
		if strings.HasPrefix(k, prefix+":") && !present[k] {
			delete(s.since, k)
		}
	}
	ts := earliest.UTC().Format(time.RFC3339)
	return &ts
}

// reapSince drops all tracker state for a kind with no current contributors.
func (s *fleetStatusService) reapSince(prefix string) {
	for k := range s.since {
		if strings.HasPrefix(k, prefix+":") {
			delete(s.since, k)
		}
	}
}

// ---------------------------------------------------------------------------
// Pure helpers: labels, summary, links, roster, ETag
// ---------------------------------------------------------------------------

// fleetKnownOverall folds CONFIRMED facts into severity (the coverage axis is
// deliberately absent): down/missing/error ⇒ degraded; pending permission/
// question or retry ⇒ attention; else nominal (no known condition — not
// confirmed health).
func fleetKnownOverall(down, missing, sessionErr, perm, quest, retry bool) string {
	if down || missing || sessionErr {
		return fleetOverallDegraded
	}
	if perm || quest || retry {
		return fleetOverallAttention
	}
	return fleetOverallNominal
}

func pluralCount(n int, one, many string) string {
	if n == 1 {
		return fmt.Sprintf("1 %s", one)
	}
	return fmt.Sprintf("%d %s", n, many)
}

// fleetKindWord is the compact noun used when a fuller phrase would exceed
// the 30-code-point summary budget. fleetSingularWord is its n==1 form.
func fleetKindWord(kind string) string {
	switch kind {
	case fleetCondPermissionPending:
		return "permissions"
	case fleetCondQuestionPending:
		return "questions"
	case fleetCondWorkerDown:
		return "workers down"
	case fleetCondWorkerMissing:
		return "missing"
	case fleetCondSessionError:
		return "errors"
	case fleetCondSessionRetry:
		return "retrying"
	}
	return "issues"
}

func fleetSingularWord(kind string) string {
	switch kind {
	case fleetCondPermissionPending:
		return "permission"
	case fleetCondQuestionPending:
		return "question"
	case fleetCondWorkerDown:
		return "worker down"
	case fleetCondWorkerMissing:
		return "missing"
	case fleetCondSessionError:
		return "error"
	case fleetCondSessionRetry:
		return "retrying"
	}
	return "issue"
}

// fleetSummary composes the ≤30-code-point server-English summary. Incomplete
// coverage prefixes "Unknown; " with the highest-priority known condition (or
// "Unknown coverage" when nothing is known); complete + no conditions is
// "Nominal"; complete + conditions leads with the highest-priority condition.
// Composition degrades deterministically (phrase → count+word → word) so the
// 30-code-point ceiling is ALWAYS met.
func fleetSummary(complete bool, topKind string, topCount int) string {
	fit := func(s string) (string, bool) {
		if len([]rune(s)) <= 30 {
			return s, true
		}
		return s, false
	}
	if topKind == "" {
		if complete {
			return "Nominal"
		}
		return "Unknown coverage"
	}
	short := pluralCount(topCount, fleetSingularWord(topKind), fleetKindWord(topKind))
	if !complete {
		if s, ok := fit("Unknown; " + short); ok {
			return s
		}
		if s, ok := fit("Unknown; " + fleetKindWord(topKind)); ok {
			return s
		}
		return "Unknown coverage"
	}
	if s, ok := fit(pluralCount(topCount, conditionPhrase(topKind, true), conditionPhrase(topKind, false))); ok {
		return s
	}
	if s, ok := fit(short); ok {
		return s
	}
	return fleetKindWord(topKind)
}

// conditionPhrase returns the singular/plural noun phrase used in condition
// labels ("permission pending" / "permissions pending").
func conditionPhrase(kind string, singular bool) string {
	pairs := map[string][2]string{
		fleetCondPermissionPending: {"permission pending", "permissions pending"},
		fleetCondQuestionPending:   {"question pending", "questions pending"},
		fleetCondWorkerDown:        {"worker down", "workers down"},
		fleetCondWorkerMissing:     {"worker missing", "workers missing"},
		fleetCondSessionError:      {"session error", "session errors"},
		fleetCondSessionRetry:      {"session retrying", "sessions retrying"},
	}
	p, ok := pairs[kind]
	if !ok {
		return "issues"
	}
	if singular {
		return p[0]
	}
	return p[1]
}

// appendContributor keeps the deterministic representative (minimum by
// worker, then directory, then session) for a condition's deep link.
func appendContributor(cur *fleetContributor, c fleetContributor) *fleetContributor {
	if cur == nil {
		return &c
	}
	if c.worker < cur.worker || (c.worker == cur.worker && (c.dir < cur.dir || (c.dir == cur.dir && c.session < cur.session))) {
		return &c
	}
	return cur
}

// validWorkerHostLabel reports whether id is safe to substitute into a URL
// host: ASCII host-label characters [A-Za-z0-9._-] only, non-empty. Worker
// IDs are client-controlled at registration (open registration when
// --worker-secret is unset); an ID carrying a URL delimiter (# / ? @ :)
// terminates or redirects the authority under WHATWG parsing, and CR/LF or
// control bytes poison it — the same untrusted-ID posture as the A3 guard in
// status_transport.go. Mirrors validFetchPath's reject-empty convention.
func validWorkerHostLabel(id string) bool {
	if id == "" {
		return false
	}
	for _, r := range id {
		if r < 0x20 || r == 0x7f { // control bytes, DEL
			return false
		}
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '.' || r == '_' || r == '-':
		default:
			return false
		}
	}
	return true
}

// workerAppLink builds the trusted worker-origin /app deep link from the
// CONFIGURED HostPattern — never from the request Host (an attacker-controlled
// input). No mapping configured (or the value has no $ID) ⇒ nil in v1. The
// substituted worker ID must pass validWorkerHostLabel first — both
// discovered-mode IDs (attacker-controllable via registration) and roster IDs
// (operator-supplied; defense-in-depth) — so a hostile ID yields a nil link
// instead of a deep link off the trusted origin.
func (s *fleetStatusService) workerAppLink(workerID, dir, session string) *string {
	if s.d.HostPattern == "" || !strings.Contains(s.d.HostPattern, "$ID") {
		return nil
	}
	if !validWorkerHostLabel(workerID) {
		return nil
	}
	host := strings.ReplaceAll(s.d.HostPattern, "$ID", workerID)
	u := "https://" + host + "/app?dir=" + url.QueryEscape(dir) + "&session=" + url.QueryEscape(session)
	return &u
}

// normalizeFleetRoster trims, drops empties, dedupes and sorts the configured
// --status-worker IDs. A non-empty result switches coverage to expected mode.
func normalizeFleetRoster(raw []string) []string {
	seen := make(map[string]bool, len(raw))
	out := make([]string, 0, len(raw))
	for _, id := range raw {
		id = strings.TrimSpace(id)
		if id == "" || seen[id] {
			continue
		}
		seen[id] = true
		out = append(out, id)
	}
	sort.Strings(out)
	return out
}

// fleetETag is the strong validator: a quoted hash of the EXACT published
// bytes (generation timestamp included), so it is stable within a generation
// and differs whenever the bytes do.
func fleetETag(body []byte) string {
	sum := sha256.Sum256(body)
	return `"` + hex.EncodeToString(sum[:16]) + `"`
}

// ifNoneMatchMatches evaluates If-None-Match per HTTP semantics against the
// current strong ETag (exact match, W/ weak form, or "*").
func ifNoneMatchMatches(header, etag string) bool {
	if header == "" {
		return false
	}
	for _, part := range strings.Split(header, ",") {
		part = strings.TrimSpace(part)
		if part == "*" || part == etag || part == "W/"+etag {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

// handleFleetStatus serves GET /vh/fleet/status from the daemon-owned
// generation cache. Response headers: ETag + Cache-Control: private, no-cache
// on BOTH 200 and 304. A 304 never advances observation time — it returns the
// current generation's validator only.
func (d *Daemon) handleFleetStatus(w http.ResponseWriter, r *http.Request) {
	svc := d.fleetStatusService()
	gen, err := svc.serve(r.Context())
	if err != nil {
		http.Error(w, "fleet status unavailable: "+err.Error(), http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("ETag", gen.etag)
	if r.Method == http.MethodHead {
		w.WriteHeader(http.StatusOK)
		return
	}
	if ifNoneMatchMatches(r.Header.Get("If-None-Match"), gen.etag) {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(gen.body)
}
