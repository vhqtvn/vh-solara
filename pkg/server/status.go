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
//     project_missing > session_error | session_retry > session_done; each
//     {kind,count,since,label,link}. Pending conditions count pending
//     SESSIONS summed over SELECTED roots (a root's subtree_pending_*
//     surfaces its descendants' waits); session_done is informational-only
//     ("N finished", never a severity input). `since` is the first
//     CONTINUOUSLY observed controller time for the current contributors
//     (continuity tracked across published generations; reset on loss of
//     evidence). `link` is a trusted worker-origin /app?dir=…&session=… URL
//     built from the configured HostPattern (null when no mapping exists)
//     — never from the request Host.
//   - FOLD POPULATION (gauge semantics): every fold — gauge, session-tier
//     conditions, projects[] — operates on SELECTED sessions only: effective
//     root+unarchived, identified by the worker-side gate fact
//     fleet_selected. The lean /vh/gates path is pre-filtered by the worker;
//     the snapshot fallback carries the complete map and the fold filters it
//     by the same field (identical populations on both paths). Both paths
//     VALIDATE the fleet-selection vocabulary before any observation folds
//     (the root_unarchived_v1 marker + tagged entries; see
//     fleetSelectionValid): a marker-less lean body routes to the fallback,
//     and a fallback envelope without the vocabulary classifies the worker
//     `error` (unsupported producer) — unsupported data never masquerades as
//     an observed empty fleet. The gauge is busy selected roots / selected
//     roots ("N/M busy"); `projects[]` is a bounded per-dir breakdown
//     (≤16 rows / 8 KiB, omission-accounted) with config-roster labels.
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
//   - Acquisition per worker: /vh/projects discovery, then ONE batched lean
//     /vh/gates?z=1 request covering every in-scope project (the rollup
//     consumes only the gate map per project — the worker returns exactly
//     that, gzipped, no session-tree marshaling). On ANY lean failure (404
//     from an old worker, non-2xx, malformed, timeout, cap trip — including
//     a missing or unknown fleet_selection marker) the acquisition falls
//     back to ONE tree-only /vh/snapshot per in-scope project (z=1) — the
//     pre-lean path, unchanged except that each snapshot envelope must now
//     also speak the fleet-selection vocabulary: a field-less fallback from
//     an unsupported producer is a worker `error`, never a healthy empty
//     fold. The optional project
//     roster from the status config file (--status-config; see
//     status_config.go) intersects discovery with the configured dirs
//     (unconfigured dirs are excluded everywhere) and turns a configured dir
//     instantiated on no online worker into a project_missing condition —
//     declared only when every in-scope online worker was completely
//     acquired; otherwise absence stays unknown, never missing. Every fetch
//     goes
//     through Proxy.FetchWorkerJSONBounded (bounded open/handshake/head/body,
//     cap-plus-one excess detection — on DECODED bytes for gzip64 envelopes)
//     with the worker transport snapshotted
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
	"github.com/vhqtvn/vh-solara/pkg/version"
)

// ---------------------------------------------------------------------------
// Wire types (schema 1)
// ---------------------------------------------------------------------------

type fleetGauge struct {
	Value     float64 `json:"value"`     // busy selected roots / selected roots, clamped 0-1
	Available bool    `json:"available"` // false = value is a placeholder (coverage incomplete)
	Label     string  `json:"label"`
}

type fleetCoverage struct {
	Mode            string `json:"mode"`            // expected|discovered (WORKER scope)
	InventoryKnown  bool   `json:"inventory_known"` // true iff an explicit worker roster is configured
	Complete        bool   `json:"complete"`        // every in-scope worker acquisition succeeded
	ProjectScope    string `json:"project_scope"`   // "expected" iff a project roster is configured, else "instantiated" (see /vh/projects)
	RequiredWorkers int    `json:"required_workers"`
	ObservedWorkers int    `json:"observed_workers"`
	UnknownWorkers  int    `json:"unknown_workers"`
	// Project counts mirror the worker triad but apply ONLY in expected
	// project mode (all zero in discovered/instantiated mode — no project
	// expectation is configured). Observed counts a configured dir ONCE no
	// matter how many workers host it (fleet-wide satisfaction); unknown
	// includes both confirmed-missing and not-yet-decidable dirs.
	RequiredProjects int `json:"required_projects"`
	ObservedProjects int `json:"observed_projects"`
	UnknownProjects  int `json:"unknown_projects"`
}

type fleetCondition struct {
	Kind  string  `json:"kind"`
	Count int     `json:"count"`
	Since *string `json:"since"` // first continuously observed controller time (RFC3339 UTC)
	Label string  `json:"label"`
	Link  *string `json:"link"` // trusted worker-origin /app deep link, or null
}

// fleetWorkerEntry is one workers[] row. Detail (schema-additive) is set ONLY
// for limited/error rows — it names WHAT tripped and WHERE (e.g. "response
// 5.2 MiB > 4 MiB cap (/vh/snapshot?dir=…)" or "project count 71 > 64 cap"),
// bounded to ~256 code points so the watch payload stays compact. Absent
// (omitempty) for ok/offline/missing/timeout — those statuses have nothing
// useful to name.
type fleetWorkerEntry struct {
	ID         string  `json:"id"`
	Status     string  `json:"status"` // ok|offline|missing|timeout|error|limited
	Detail     string  `json:"detail,omitempty"`
	ObservedAt *string `json:"observed_at"`
}

// fleetProjectRow is one projects[] row: the per-directory aggregate over
// every in-scope worker/project observation of that EXACT dir (the same dir
// hosted on two workers is ONE row; its roots stay distinct contributors to
// the fleet totals). Sessions counts SELECTED roots; Busy counts roots whose
// subtree is busy (own busy/retry included — counted once); Done counts
// session_done roots; Pending counts roots with union subtree pending > 0.
// Label comes from the status-config project roster (omitted for
// unlabelled/unconfigured dirs). Complete is false when the displayed counts
// are known-partial contributions (any in-scope worker's acquisition was
// incomplete or the worker is offline/missing — an unobserved worker could
// contribute to this dir); coverage/conditions describe the missing scope
// separately.
type fleetProjectRow struct {
	Dir      string `json:"dir"`
	Label    string `json:"label,omitempty"`
	Sessions int    `json:"sessions"`
	Busy     int    `json:"busy"`
	Done     int    `json:"done"`
	Pending  int    `json:"pending"`
	Complete bool   `json:"complete"`
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
	Projects       []fleetProjectRow  `json:"projects"`
	ProjectsTotal  int                `json:"projects_total"`   // candidate observed rows before presentation caps
	ProjectsOmit   int                `json:"projects_omitted"` // candidate rows not returned (cap-excluded)
	GeneratedAt    string             `json:"generated_at"`
	MaxStalenessMS int64              `json:"max_staleness_ms"`
}

// fleetOptionsResponse is the GET /vh/fleet/config/options picker feed —
// config-UI-ONLY (the /vh/fleet/status watch payload stays compact by
// design). Built INSIDE buildRollup from the same refresh's results, so it
// rides the same immutable generation: identical staleness semantics, zero
// extra acquisition (see buildFleetOptions).
type fleetOptionsResponse struct {
	Schema      int                   `json:"schema"`
	GeneratedAt string                `json:"generated_at"`
	Workers     []fleetOptionsWorker  `json:"workers"`
	Projects    []fleetOptionsProject `json:"projects"`
}

// fleetOptionsWorker is one known worker for the pane's add-worker picker.
type fleetOptionsWorker struct {
	ID     string `json:"id"`
	Status string `json:"status"` // rollup status (ok|offline|missing|timeout|error|limited) or "online"
}

// fleetOptionsProject is one worker-REPORTED project dir for the add-project
// picker. Workers lists the hosting worker ids (sorted; [] never null).
type fleetOptionsProject struct {
	Dir     string   `json:"dir"`
	Workers []string `json:"workers"`
}

// Condition kinds in the server-owned display-priority order. Exactly this
// order in conditions[]; at most one aggregate per kind; nonzero counts only.
// session_done is INFORMATIONAL and strictly LAST: below session_retry, never
// independently attention/degraded, and never the known_overall severity
// input — it surfaces finished sessions for the watch face, it does not page.
const (
	fleetCondPermissionPending = "permission_pending"
	fleetCondQuestionPending   = "question_pending"
	fleetCondWorkerDown        = "worker_down"
	fleetCondWorkerMissing     = "worker_missing"
	fleetCondProjectMissing    = "project_missing"
	fleetCondSessionError      = "session_error"
	fleetCondSessionRetry      = "session_retry"
	fleetCondSessionDone       = "session_done"
)

var fleetConditionOrder = []string{
	fleetCondPermissionPending,
	fleetCondQuestionPending,
	fleetCondWorkerDown,
	fleetCondWorkerMissing,
	fleetCondProjectMissing,
	fleetCondSessionError,
	fleetCondSessionRetry,
	fleetCondSessionDone,
}

// Presentation caps for projects[]: at most 16 rows and at most 8 KiB of
// encoded projects array (brackets, commas, and JSON escaping included).
// Truncation stops at the first row that would exceed either bound and
// preserves the sorted prefix; fleet totals/conditions are computed BEFORE
// truncation, so presentation omissions never change the gauge or coverage.
// Directory identities and labels are never themselves truncated into
// misleading identities — whole rows are omitted, accounted for by
// projects_omitted.
const (
	fleetProjectsMaxRows         = 16
	fleetProjectsMaxEncodedBytes = 8 << 10
)

// Worker status enum (workers[].status).
const (
	fleetWorkerOK      = "ok"
	fleetWorkerOffline = "offline"
	fleetWorkerMissing = "missing"
	fleetWorkerTimeout = "timeout"
	fleetWorkerError   = "error"
	fleetWorkerLimited = "limited"
)

// fleetWorkerOnline is an OPTIONS-FEED-ONLY status (never in the rollup's
// workers[]): a registry worker connected while the rollup runs in expected
// (roster) scope — the tunnel is up, but the worker is outside the configured
// roster and was therefore never acquired. The config picker surfaces it so
// the operator can add exactly this worker.
const fleetWorkerOnline = "online"

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

// fleetBudgets are the safety budgets from the contract. The four
// byte/count fields (MaxResponseBodyBytes, MaxWorkerCumulativeBytes,
// MaxWorkersPerRefresh, MaxProjectsPerWorker) AND the two time fields
// (RefreshBudget, WorkerBudget, in ms) are CONFIG-OVERRIDABLE via the
// status config file's optional "budgets" block (see status_config.go) and
// are sourced per-refresh from the config snapshot (effectiveBudgets); the
// remaining fields (TTL and the concurrency/staleness knobs) are
// daemon-owned only. Defaults are sized for real fleets on WAN tunnels
// (operator fleet: 1 worker, 7 real dev projects, ~83 ms RTT link — the
// original 3 s/2 s budgets timed the acquisition out at ~3/7 projects when
// each snapshot crossed the tunnel uncompressed). All fields remain
// overridable in tests via svc.budgets (config overrides win when set).
type fleetBudgets struct {
	TTL                      time.Duration // serve-generation validity window
	RefreshBudget            time.Duration // total ctx bound for one refresh
	WorkerBudget             time.Duration // per-worker end-to-end bound, INCLUDING semaphore queue wait
	WorkerConcurrency        int           // max workers fetched concurrently per refresh
	MaxWorkersPerRefresh     int           // worker cap; in-scope workers beyond it are `limited`
	MaxProjectsPerWorker     int           // project cap; more projects ⇒ worker `limited`
	MaxResponseBodyBytes     int64         // per-response body cap (cap-plus-one detection; DECODED bytes for gzip64)
	MaxWorkerCumulativeBytes int64         // cumulative body budget per worker per refresh (decoded bytes)
	MaxStalenessMS           int64         // client display-age ceiling surfaced in the response
}

func defaultFleetBudgets() fleetBudgets {
	return fleetBudgets{
		TTL:                      5 * time.Second,
		RefreshBudget:            15 * time.Second,
		WorkerBudget:             10 * time.Second,
		WorkerConcurrency:        8,
		MaxWorkersPerRefresh:     128,
		MaxProjectsPerWorker:     64,
		MaxResponseBodyBytes:     4 << 20,  // 4 MiB per response (real session trees; was 1 MiB)
		MaxWorkerCumulativeBytes: 32 << 20, // 32 MiB cumulative per worker (was 8 MiB)
		MaxStalenessMS:           15000,
	}
}

// applyFleetBudgetOverrides overlays the config file's optional budgets block
// onto b: each field is replaced only when configured, so unset fields fall
// back to the defaults b already carries. nil cfg = all defaults (block
// absent). This is the single merge point shared by the rollup
// (effectiveBudgets) and the GET /vh/fleet/config effective echo.
func applyFleetBudgetOverrides(b fleetBudgets, cfg *fleetBudgetsConfig) fleetBudgets {
	if cfg == nil {
		return b
	}
	if cfg.MaxResponseBytes != nil {
		b.MaxResponseBodyBytes = *cfg.MaxResponseBytes
	}
	if cfg.MaxCumulativeBytes != nil {
		b.MaxWorkerCumulativeBytes = *cfg.MaxCumulativeBytes
	}
	if cfg.MaxWorkersPerRefresh != nil {
		b.MaxWorkersPerRefresh = *cfg.MaxWorkersPerRefresh
	}
	if cfg.MaxProjectsPerWorker != nil {
		b.MaxProjectsPerWorker = *cfg.MaxProjectsPerWorker
	}
	if cfg.RefreshBudgetMS != nil {
		b.RefreshBudget = time.Duration(*cfg.RefreshBudgetMS) * time.Millisecond
	}
	if cfg.WorkerBudgetMS != nil {
		b.WorkerBudget = time.Duration(*cfg.WorkerBudgetMS) * time.Millisecond
	}
	return b
}

// effectiveBudgets derives the budgets ONE refresh runs under: the service's
// budgets (defaults, test-overridable) overlaid with the config snapshot's
// overrides. Called from buildRollup with the SAME coherent snapshot that
// fed the rosters, so a hot-applied budget change takes effect on the next
// generation and a stale in-flight refresh can never publish over a newer
// budget change (the cfgGen stamp covers budgets exactly like rosters).
func (s *fleetStatusService) effectiveBudgets(snap statusConfigSnapshot) fleetBudgets {
	return applyFleetBudgetOverrides(s.budgets, snap.budgets)
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
// served — nor 304'd); cfgGen is the status-config holder generation it was
// built under (a mismatch means the expected rosters changed underneath —
// PUT /vh/fleet/config — and the generation is equally stale; it also stops
// an in-flight refresh started BEFORE a config swap from publishing over
// the newer config: its stamp can never match the live generation again).
// options is the GET /vh/fleet/config/options picker feed marshaled from the
// SAME refresh — a second view of one generation, not a second acquisition.
type fleetGeneration struct {
	body        []byte
	etag        string
	options     []byte
	publishedAt time.Time
	regGen      uint64
	cfgGen      uint64
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
// empty, past TTL, or invalidated by a registry generation change OR a
// status-config generation change (a live config apply via PUT
// /vh/fleet/config). Concurrent callers coalesce onto one service-owned
// refresh (the refresh context is owned by the service, not the first
// caller). rctx bounds how long the caller is willing to wait.
func (s *fleetStatusService) serve(rctx context.Context) (*fleetGeneration, error) {
	// Bounded loop: each iteration either returns a valid generation or waits
	// for exactly one refresh. A registry generation that churns across
	// refreshes (worker flapping) exhausts the loop and yields 503 instead of
	// spinning forever.
	for i := 0; i < 3; i++ {
		s.mu.Lock()
		regGen := s.d.Registry.Generation()
		cfgGen := s.d.statusCfg.generation()
		if s.cur != nil && s.cur.regGen == regGen && s.cur.cfgGen == cfgGen && time.Since(s.cur.publishedAt) < s.budgets.TTL {
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
			// let the deferred close wake everyone. Stamping the CURRENT
			// config generation is deliberate: if a config swap raced the
			// panic, the fallback mismatches the live generation and the
			// next request re-refreshes (never serves over newer config).
			s.publishFallback(regGen, s.d.statusCfg.generation())
		}
		s.mu.Lock()
		s.refreshCh = nil
		s.refreshes++
		s.mu.Unlock()
		close(done)
	}()

	// ONE coherent config snapshot for the whole build: rosters and cfgGen
	// captured together, so the published generation is stamped with exactly
	// the config it was built from (no read-then-stamp race).
	snap := s.d.statusCfg.snapshot()
	resp, opts := s.buildRollup(time.Now().UTC(), snap)
	body, err := json.Marshal(resp)
	if err != nil {
		// Cannot happen (plain structs), but fail honest rather than serve nil.
		s.publishFallback(regGen, snap.gen)
		return
	}
	optBody, err := json.Marshal(opts)
	if err != nil {
		s.publishFallback(regGen, snap.gen)
		return
	}
	s.mu.Lock()
	s.cur = &fleetGeneration{
		body:        body,
		etag:        fleetETag(body),
		options:     optBody,
		publishedAt: time.Now().UTC(),
		regGen:      regGen,
		cfgGen:      snap.gen,
	}
	s.mu.Unlock()
}

// publishFallback publishes a minimal honest generation: schema 1, unknown
// overall, empty discovered coverage. Used when a refresh fails so hard there
// are no observations at all.
func (s *fleetStatusService) publishFallback(regGen, cfgGen uint64) {
	resp := fleetStatusResponse{
		Schema:         1,
		Overall:        fleetOverallUnknown,
		KnownOverall:   fleetOverallNominal,
		Summary:        "Unknown coverage",
		Gauge:          fleetGauge{Value: 0, Available: false, Label: "Coverage incomplete"},
		Coverage:       fleetCoverage{Mode: "discovered", InventoryKnown: false, Complete: false, ProjectScope: "instantiated"},
		Conditions:     []fleetCondition{},
		Workers:        []fleetWorkerEntry{},
		Projects:       []fleetProjectRow{},
		GeneratedAt:    time.Now().UTC().Format(time.RFC3339),
		MaxStalenessMS: s.budgets.MaxStalenessMS,
	}
	body, err := json.Marshal(resp)
	if err != nil {
		body = []byte(`{"schema":1,"overall":"unknown"}`)
	}
	optResp := fleetOptionsResponse{
		Schema:      1,
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
		Workers:     []fleetOptionsWorker{},
		Projects:    []fleetOptionsProject{},
	}
	optBody, err := json.Marshal(optResp)
	if err != nil {
		optBody = []byte(`{"schema":1,"workers":[],"projects":[]}`)
	}
	s.mu.Lock()
	s.cur = &fleetGeneration{
		body:        body,
		etag:        fleetETag(body),
		options:     optBody,
		publishedAt: time.Now().UTC(),
		regGen:      regGen,
		cfgGen:      cfgGen,
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
	detail     string // limited/error WHY+WHERE (fleetWorkerEntry.Detail); "" otherwise
	observedAt time.Time
	projects   []fleetObservedProject
	// discovered is the FULL /vh/projects discovery (every worker-reported
	// dir, captured BEFORE the expected-roster filter and every cap) — the
	// suggestion knowledge behind fleetOptionsResponse. A dir being here
	// means the worker reports it instantiated; it is NOT an acquisition
	// claim (that is what projects/ carries).
	discovered []string
}

// fleetContributor identifies one session-level condition contributor.
type fleetContributor struct {
	worker  string
	dir     string
	session string
}

// buildRollup snapshots the registry, acquires every in-scope online worker
// within the budgets, and folds the observations into the wire response —
// plus, from the SAME results, the /vh/fleet/config/options picker feed
// (see buildFleetOptions). (The registry-generation stamp is applied by the
// caller in refresh().) The expected rosters come from the ONE config
// snapshot the caller captured — snap — so a concurrent PUT /vh/fleet/config
// can never half-apply (worker roster from one config, project roster from
// another).
//
// Per-worker in-flight cap: this function runs ONLY inside the single-flight
// refresh goroutine, and per-worker acquisition is sequential (discovery,
// then each project snapshot one at a time), so at most ONE fetch is in
// flight per worker at any moment — by construction, not by semaphore.
func (s *fleetStatusService) buildRollup(now time.Time, snap statusConfigSnapshot) (fleetStatusResponse, fleetOptionsResponse) {
	b := s.effectiveBudgets(snap)
	fetch := s.fetcher()

	summaries := s.d.Registry.Summaries()
	roster := normalizeFleetRoster(snap.workerIDs())
	// Project roster (status config file, --status-config): a non-empty
	// normalized set switches the PROJECT scope to "expected" — per-worker
	// discovery is intersected with exactly these dirs (VERBATIM exact match:
	// entries keep their configured spelling, whitespace included — no
	// trimming), and a configured dir instantiated on no online worker is a
	// project_missing condition. Empty = discovered/instantiated project
	// scope (current behavior, unchanged).
	projectRoster := normalizeProjectRoster(snap.projectDirs())
	expectedProjects := len(projectRoster) > 0
	var projectSet map[string]bool
	if expectedProjects {
		projectSet = make(map[string]bool, len(projectRoster))
		for _, dir := range projectRoster {
			projectSet[dir] = true
		}
	}
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
	// and make coverage incomplete — never silently dropped. The detail
	// names the cap so the operator knows which budget to raise.
	var cappedIDs []string
	var cappedDetail string
	if len(toAcquire) > b.MaxWorkersPerRefresh {
		wantAcquire := len(toAcquire)
		cappedIDs = toAcquire[b.MaxWorkersPerRefresh:]
		toAcquire = toAcquire[:b.MaxWorkersPerRefresh]
		cappedDetail = fmt.Sprintf("worker count %d > %d cap", wantAcquire, b.MaxWorkersPerRefresh)
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
			acquired[i] = s.acquireWorker(ctx, id, refreshStart, fetch, projectSet, b)
		}(i, id)
	}
	wg.Wait()

	results = append(results, acquired...)
	for _, id := range cappedIDs {
		results = append(results, fleetWorkerResult{id: id, status: fleetWorkerLimited, detail: cappedDetail})
	}
	sort.Slice(results, func(i, j int) bool { return results[i].id < results[j].id })

	// --- fold observations ------------------------------------------------
	// The fold operates on the SELECTED population only: effective
	// root+unarchived sessions, identified by the worker-side gate fact
	// fleet_selected. Both acquisition paths VALIDATE the selection
	// vocabulary before any observation reaches this fold (see
	// fleetSelectionValid and the fallback check in acquireWorker), so a
	// nil fleet_selected from a field-less producer can no longer get here
	// — the nil clause in the per-entry filter below is a defensive belt,
	// not a supported producer class. The lean path is pre-filtered by
	// the worker; the snapshot fallback carries the complete map and is
	// filtered HERE by the same field, so both acquisition paths fold an
	// identical population. A selected root's SUBTREE pending counts surface
	// its descendants' waits (a child's pending permission contributes to its
	// root's permission_pending — subagent signals must not vanish), while
	// session_error/session_retry stay the root's OWN activity facts.
	var selectedRoots, busyRoots int
	var permCount, questCount int // summed per-kind pending SESSION counts
	permC, questC, errC, retryC, doneC := []fleetContributor{}, []fleetContributor{}, []fleetContributor{}, []fleetContributor{}, []fleetContributor{}
	downIDs, missingIDs := []string{}, []string{}
	observedProjectDirs := map[string]bool{} // dirs CONFIRMED instantiated this generation (successful snapshots only)
	observed := 0

	// Per-dir project rows (aggregated across workers; labels from the SAME
	// config snapshot that fed the rosters — a hot label edit rides the next
	// generation via the cfgGen stamp, exactly like the rosters).
	projectLabels := make(map[string]string, len(snap.projects))
	for _, p := range snap.projects {
		if p.Label != "" {
			projectLabels[p.Dir] = p.Label
		}
	}
	projRows := map[string]*fleetProjFold{}
	projOrder := []string{} // first-observation order; sorted before presentation
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
			observedProjectDirs[p.dir] = true
			row := projRows[p.dir]
			if row == nil {
				row = &fleetProjFold{dir: p.dir}
				projRows[p.dir] = row
				projOrder = append(projOrder, p.dir)
			}
			sids := make([]string, 0, len(p.gate))
			for sid := range p.gate {
				sids = append(sids, sid)
			}
			sort.Strings(sids)
			for _, sid := range sids {
				gf := p.gate[sid]
				if gf.FleetSelected == nil || !*gf.FleetSelected {
					// child, archived, or (defensively — see the fold note
					// above) an untagged pre-selection entry: not in the fold
					// population
					continue
				}
				selectedRoots++
				// Busy = the root's subtree is busy (inclusive of own
				// busy/retry — the worker's subtree_busy is self-inclusive).
				// The own-activity disjuncts are a belt for observations whose
				// producer sets activity without subtree_busy; a real worker
				// always has subtree_busy ⊇ own busy/retry, so the OR is
				// redundant there and costs nothing here.
				busy := gf.SubtreeBusy || gf.Activity == "busy" || gf.Activity == "retry"
				if busy {
					busyRoots++
				}
				row.sessions++
				if busy {
					row.busy++
				}
				if gf.SubtreePendingPermission > 0 {
					row.hasPerm = true
				}
				if gf.SubtreePendingQuestion > 0 {
					row.hasQuest = true
				}
				if gf.SubtreePendingInput > 0 {
					row.pending++
				}
				c := fleetContributor{worker: r.id, dir: p.dir, session: sid}
				if gf.SubtreePendingPermission > 0 {
					permC = append(permC, c)
					permCount += gf.SubtreePendingPermission
				}
				if gf.SubtreePendingQuestion > 0 {
					questC = append(questC, c)
					questCount += gf.SubtreePendingQuestion
				}
				if gf.Activity == "error" {
					errC = append(errC, c)
					row.hasErr = true
				}
				if gf.Activity == "retry" {
					retryC = append(retryC, c)
					row.hasRetry = true
				}
				if fleetSessionDone(gf) {
					doneC = append(doneC, c)
					row.done++
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

	// --- project roster fold (expected project mode only) ------------------
	// A configured dir counts observed ONCE fleet-wide (any worker hosting
	// it satisfies it — dirs are collected across workers into one set).
	observedProjects := 0
	for _, dir := range projectRoster {
		if observedProjectDirs[dir] {
			observedProjects++
		}
	}
	// Honesty gate for absence: a configured dir may be declared missing only
	// when EVERY in-scope ONLINE worker was completely acquired (status ok)
	// and at least one online worker exists. An incomplete acquisition
	// (timeout/error/limited) or an all-offline/all-missing fleet leaves
	// absence UNKNOWN, never missing — mirroring how worker `missing` never
	// claims from stale evidence. Offline/missing workers do not block the
	// declaration: a dir instantiated on no ONLINE worker is not running
	// anywhere reachable, and their own down/missing conditions already
	// surface why.
	onlineAcquired, onlineOK := 0, 0
	for _, r := range results {
		switch r.status {
		case fleetWorkerOK:
			onlineAcquired++
			onlineOK++
		case fleetWorkerTimeout, fleetWorkerError, fleetWorkerLimited:
			onlineAcquired++ // was online when the refresh ran; acquisition incomplete
		}
	}
	var missingProjectDirs []string
	if expectedProjects && onlineAcquired > 0 && onlineAcquired == onlineOK {
		for _, dir := range projectRoster { // roster sorted ⇒ deterministic order
			if !observedProjectDirs[dir] {
				missingProjectDirs = append(missingProjectDirs, dir)
			}
		}
	}

	known := fleetKnownOverall(len(downIDs) > 0, len(missingIDs) > 0, len(missingProjectDirs) > 0,
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
		newAgg(fleetCondPermissionPending, permCount, permC, "perm", pluralCount(permCount, "permission pending", "permissions pending"), true),
		newAgg(fleetCondQuestionPending, questCount, questC, "quest", pluralCount(questCount, "question pending", "questions pending"), true),
		workerAgg(fleetCondWorkerDown, downIDs, "down", pluralCount(len(downIDs), "worker down", "workers down")),
		workerAgg(fleetCondWorkerMissing, missingIDs, "missing", pluralCount(len(missingIDs), "worker missing", "workers missing")),
		// project_missing rides the worker (infrastructure) tier, after
		// worker_missing; link stays null — there is no valid /app mapping
		// for a project that is not running anywhere.
		workerAgg(fleetCondProjectMissing, missingProjectDirs, "pmissing", pluralCount(len(missingProjectDirs), "project not running", "projects not running")),
		newAgg(fleetCondSessionError, len(errC), errC, "err", pluralCount(len(errC), "session error", "session errors"), true),
		newAgg(fleetCondSessionRetry, len(retryC), retryC, "retry", pluralCount(len(retryC), "session retrying", "sessions retrying"), true),
		// session_done: informational LAST-priority condition ("N finished").
		// Since-continuity rides the existing tracker keyed worker+dir+root:
		// an observed resume (busy/retry, pending, unfinished/latest-message
		// change, ineligibility) removes the done contributor and RESETS its
		// continuity; a later positive observation starts a fresh since. A
		// busy→done→busy cycle BETWEEN polls is unobservable at this polling
		// cadence (no completion-instance identity) — the honesty limit the
		// gauge brief records.
		newAgg(fleetCondSessionDone, len(doneC), doneC, "done", pluralCount(len(doneC), "finished", "finished"), true),
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

	// Gauge denominator = SELECTED root+unarchived sessions (M); numerator =
	// busy selected roots, child activity included via the worker's
	// self-inclusive subtree_busy (N). available semantics unchanged: only a
	// COMPLETE supported acquisition yields a real value.
	gauge := fleetGauge{Value: 0, Available: false, Label: "Coverage incomplete"}
	if complete {
		if selectedRoots == 0 {
			gauge = fleetGauge{Value: 0, Available: true, Label: "No sessions"}
		} else {
			v := float64(busyRoots) / float64(selectedRoots)
			if v < 0 {
				v = 0
			}
			if v > 1 {
				v = 1
			}
			gauge = fleetGauge{
				Value:     v,
				Available: true,
				Label:     fmt.Sprintf("%d/%d busy", busyRoots, selectedRoots),
			}
		}
	}

	workers := make([]fleetWorkerEntry, 0, len(results))
	for _, r := range results {
		e := fleetWorkerEntry{ID: r.id, Status: r.status, Detail: r.detail}
		if r.status == fleetWorkerOK {
			ts := r.observedAt.UTC().Format(time.RFC3339)
			e.ObservedAt = &ts
		}
		workers = append(workers, e)
	}

	// Project coverage fields: expected mode turns the scope "expected" and
	// exposes the required/observed/unknown triad (mirroring the worker
	// shape); discovered mode keeps "instantiated" with zero counts (no
	// project expectation is configured).
	projectScope := "instantiated"
	requiredProjects := 0
	if expectedProjects {
		projectScope = "expected"
		requiredProjects = len(projectRoster)
	}

	projects, projectsTotal, projectsOmitted := buildFleetProjects(projOrder, projRows, projectLabels, complete)

	return fleetStatusResponse{
		Schema:       1,
		Overall:      overall,
		KnownOverall: known,
		Summary:      summary,
		Gauge:        gauge,
		Coverage: fleetCoverage{
			Mode:             mode,
			InventoryKnown:   inventoryKnown,
			Complete:         complete,
			ProjectScope:     projectScope,
			RequiredWorkers:  required,
			ObservedWorkers:  observed,
			UnknownWorkers:   required - observed,
			RequiredProjects: requiredProjects,
			ObservedProjects: observedProjects,
			UnknownProjects:  requiredProjects - observedProjects,
		},
		Conditions:     conditions,
		Workers:        workers,
		Projects:       projects,
		ProjectsTotal:  projectsTotal,
		ProjectsOmit:   projectsOmitted,
		GeneratedAt:    now.Format(time.RFC3339),
		MaxStalenessMS: b.MaxStalenessMS,
	}, buildFleetOptions(now, results, summaries)
}

// fleetProjFold is the per-dir fold accumulator behind one projects[] row:
// counts over the dir's SELECTED roots across every contributing worker
// observation. hasPerm/hasQuest/hasErr/hasRetry feed the row's
// problem-severity sort rank only (the row shape itself exposes
// sessions/busy/done/pending).
type fleetProjFold struct {
	dir      string
	sessions int
	busy     int
	done     int
	pending  int
	hasPerm  bool
	hasQuest bool
	hasErr   bool
	hasRetry bool
}

// buildFleetProjects renders the projects[] presentation: sort the candidate
// rows (highest problem-condition severity first — permission > question >
// error > retry; done deliberately does NOT outrank a problem or busy row —
// then busy descending, then exact dir ascending), then apply the two
// presentation caps (fleetProjectsMaxRows / fleetProjectsMaxEncodedBytes,
// the latter on the encoded array including brackets and escaping).
// Truncation stops at the first row that would exceed either bound and
// preserves the sorted prefix; candidates are counted BEFORE truncation so
// projects_total/projects_omitted account for every observed row. Fleet
// totals/conditions/gauge were folded before this runs — presentation
// omissions never change them. Rows for genuinely empty acquired projects
// are included; wholly unobserved dirs are absent (coverage describes them).
//
// complete is the REFRESH-level acquisition completeness: a row is marked
// complete=false whenever any in-scope worker was not fully acquired
// (offline/missing/timeout/error/limited) — an unobserved worker could
// contribute to any dir, so the row's counts are known-partial contributions.
func buildFleetProjects(order []string, rows map[string]*fleetProjFold, labels map[string]string, complete bool) ([]fleetProjectRow, int, int) {
	// Sort the FOLDS (they carry the severity flags), then render.
	folds := make([]*fleetProjFold, 0, len(order))
	for _, dir := range order {
		if f := rows[dir]; f != nil {
			folds = append(folds, f)
		}
	}
	// Severity rank: 0 perm … 3 retry, 4 none. Done is informational and
	// never raises a row's rank.
	rank := func(f *fleetProjFold) int {
		switch {
		case f.hasPerm:
			return 0
		case f.hasQuest:
			return 1
		case f.hasErr:
			return 2
		case f.hasRetry:
			return 3
		default:
			return 4
		}
	}
	sort.SliceStable(folds, func(i, j int) bool {
		ri, rj := rank(folds[i]), rank(folds[j])
		if ri != rj {
			return ri < rj
		}
		if folds[i].busy != folds[j].busy {
			return folds[i].busy > folds[j].busy
		}
		return folds[i].dir < folds[j].dir
	})

	out := make([]fleetProjectRow, 0, len(folds))
	encoded := 2 // the array's [ and ]
	for _, f := range folds {
		if len(out) >= fleetProjectsMaxRows {
			break
		}
		r := fleetProjectRow{
			Dir:      f.dir,
			Label:    labels[f.dir],
			Sessions: f.sessions,
			Busy:     f.busy,
			Done:     f.done,
			Pending:  f.pending,
			Complete: complete,
		}
		b, err := json.Marshal(r)
		if err != nil {
			// Plain struct with string/int/bool fields: unreachable; treat
			// the row as oversized rather than fail the rollup.
			continue
		}
		add := len(b)
		if len(out) > 0 {
			add++ // separating comma
		}
		if encoded+add > fleetProjectsMaxEncodedBytes {
			break
		}
		encoded += add
		out = append(out, r)
	}
	if out == nil {
		out = []fleetProjectRow{} // always serialize as [], never null
	}
	return out, len(folds), len(folds) - len(out)
}

// fleetSessionDone is the finished-session predicate over a SELECTED root's
// gate facts (the caller has already checked fleet_selected): idle, hydrated
// (some message state — NOT the stricter messagesLoaded), latest assistant
// turn completed with finish_reason "stop" (the conservative product
// definition — tool-call/length termination is not a normally-finished
// session), and a quiescent subtree (no busy/retry anywhere below, no
// pending input anywhere below). Informational only: never a severity input.
func fleetSessionDone(gf state.GateFacts) bool {
	return gf.Activity == "idle" && gf.Hydrated && gf.LastAssistantCompleted &&
		gf.FinishReason == "stop" && !gf.SubtreeBusy && gf.SubtreePendingInput == 0
}

// buildFleetOptions folds the SAME refresh's worker results + registry
// summaries into the config-picker feed (GET /vh/fleet/config/options).
// Called only from buildRollup — one acquisition, two payloads, one
// generation: options and rollup can never disagree about what was observed.
//
// Deliberate deviations from the naive "pass through the rollup" derivation,
// both in service of the picker's purpose (suggesting things worth ADDING to
// the rosters):
//   - workers = rollup results ∪ REGISTRY SUMMARIES. In expected (roster)
//     mode a connected-but-unrostered worker never enters rollup scope —
//     exactly the worker the operator most wants to pin. Such a worker gets
//     status "online" (fleetWorkerOnline: tunnel up, never acquired — NOT
//     "ok", which would claim an acquisition that did not happen). Rollup
//     statuses pass through verbatim otherwise, including "missing" (a
//     roster worker the registry has never seen).
//   - projects derive from per-worker DISCOVERY (every worker-reported dir,
//     including dirs the expected-project roster excluded from acquisition
//     and dirs past budget caps), not from acquired snapshots — in expected
//     project mode the dirs most worth suggesting are precisely the ones the
//     roster filter excludes. Hosting worker ids are trivially available
//     (the reporting worker is known), so the feed carries them rather than
//     a bare count.
//
// Offline/missing/timeout/error workers contribute no dirs (no discovery ran
// for them) — honest: nothing was reported.
func buildFleetOptions(now time.Time, results []fleetWorkerResult, summaries []WorkerSummary) fleetOptionsResponse {
	statusByID := make(map[string]string, len(results)+len(summaries))
	for _, r := range results {
		statusByID[r.id] = r.status
	}
	for _, ws := range summaries {
		if _, ok := statusByID[ws.ID]; !ok {
			if ws.Online {
				statusByID[ws.ID] = fleetWorkerOnline
			} else {
				statusByID[ws.ID] = fleetWorkerOffline
			}
		}
	}
	workers := make([]fleetOptionsWorker, 0, len(statusByID))
	for id, st := range statusByID {
		workers = append(workers, fleetOptionsWorker{ID: id, Status: st})
	}
	sort.Slice(workers, func(i, j int) bool { return workers[i].ID < workers[j].ID })

	hostsByDir := map[string]map[string]bool{}
	for _, r := range results {
		for _, dir := range r.discovered {
			if hostsByDir[dir] == nil {
				hostsByDir[dir] = map[string]bool{}
			}
			hostsByDir[dir][r.id] = true
		}
	}
	dirs := make([]string, 0, len(hostsByDir))
	for dir := range hostsByDir {
		dirs = append(dirs, dir)
	}
	sort.Strings(dirs)
	projects := make([]fleetOptionsProject, 0, len(dirs))
	for _, dir := range dirs {
		hosts := make([]string, 0, len(hostsByDir[dir]))
		for id := range hostsByDir[dir] {
			hosts = append(hosts, id)
		}
		sort.Strings(hosts)
		projects = append(projects, fleetOptionsProject{Dir: dir, Workers: hosts})
	}
	return fleetOptionsResponse{
		Schema:      1,
		GeneratedAt: now.Format(time.RFC3339),
		Workers:     workers,
		Projects:    projects,
	}
}

// acquireWorker performs one worker's sequential acquisition: /vh/projects
// discovery, then (new-worker fast path) ONE batched /vh/gates request
// covering every in-scope project — falling back, on ANY lean failure, to
// ONE tree-only /vh/snapshot per in-scope project (the pre-lean acquisition
// path, unchanged including its partial-observation semantics). Sequential
// by design: at most one in-flight fetch per worker (D2 cap), so the tunnel
// keeps its bandwidth for live UI streams. projectSet (non-nil in expected
// project mode) INTERSECTS discovery with the configured roster:
// discovered-but-unconfigured dirs are excluded from acquisition, session
// counts, and every other rollup fold — the operator asked for exactly
// these projects. The filter runs BEFORE the per-worker project cap so
// out-of-scope dirs never consume it.
//
// b is the refresh's effective budgets (defaults + config overrides, captured
// by the caller from the same config snapshot that fed the rosters). Every
// limited/error exit sets res.detail naming WHAT tripped and WHERE (bounded
// by fleetClampDetail); timeout exits carry no detail by contract.
func (s *fleetStatusService) acquireWorker(ctx context.Context, workerID string, refreshStart time.Time, fetch fleetJSONFetcher, projectSet map[string]bool, b fleetBudgets) fleetWorkerResult {
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

	// fetchFail classifies a failed fetch and records the limited/error
	// detail (timeout stays detail-free by contract).
	fetchFail := func(path string, err error) {
		res.status = classifyFetchErr(err)
		switch res.status {
		case fleetWorkerLimited: // body over the per-response cap
			res.detail = fleetResponseCapDetail(err, path, b.MaxResponseBodyBytes)
		case fleetWorkerError:
			res.detail = fleetClampDetail(fmt.Sprintf("fetch failed (%s): %v", fleetTruncRunes(path, fleetDetailPathMaxRunes), err))
		}
	}

	// 1. Project discovery (instantiated aggregators only).
	body, err := fetchBounded("/vh/projects")
	if err != nil {
		fetchFail("/vh/projects", err)
		return res
	}
	var projects []fleetDiscoveredProject
	if err := json.Unmarshal(body, &projects); err != nil {
		res.status = fleetWorkerError // malformed ⇒ error, not limited
		res.detail = fleetMalformedDetail("/vh/projects")
		return res
	}
	cumulative += int64(len(body))
	sort.Slice(projects, func(i, j int) bool { return projects[i].Dir < projects[j].Dir })
	// Record the FULL discovery (pre-roster-filter, pre-cap) for the config
	// picker feed: every dir the worker itself reports as instantiated.
	// Suggestion knowledge only — acquisition claims live in res.projects.
	for _, p := range projects {
		res.discovered = append(res.discovered, p.Dir)
	}
	if projectSet != nil {
		inScope := make([]fleetDiscoveredProject, 0, len(projects))
		for _, p := range projects {
			if projectSet[p.Dir] {
				inScope = append(inScope, p)
			}
		}
		projects = inScope
	}
	if len(projects) > b.MaxProjectsPerWorker {
		res.detail = fleetClampDetail(fmt.Sprintf("project count %d > %d cap", len(projects), b.MaxProjectsPerWorker))
		projects = projects[:b.MaxProjectsPerWorker]
		limited = true // deterministic cap exclusion, never silent truncation
	}

	// 2. Lean batched gate fetch (new-worker fast path): ONE /vh/gates?z=1
	// request covering the whole (capped, roster-filtered) project list —
	// the rollup consumes ONLY the gate map per project, so the worker
	// returns exactly that (no session/message marshaling). On a WAN tunnel
	// (~83 ms RTT observed) the fallback's s+1 sequential full snapshots
	// (~5.9 MB raw for the operator's 7-project roster) cannot fit any sane
	// per-worker budget; ONE lean response (even gzipped, ~10:1 smaller)
	// does. ANY lean failure — 404 from an old worker, non-2xx, malformed
	// body, timeout, cap trip — falls back to today's per-project snapshot
	// path below UNCHANGED: deterministic version-skew tolerance (a NEW
	// controller against an OLD worker costs one extra round trip per
	// refresh), and no partial lean state ever leaks into the rollup.
	if len(projects) > 0 {
		if gates, bodyLen, ok := fetchLeanGates(fetchBounded, projects); ok {
			for _, p := range projects {
				// A requested dir the worker omitted (project closed between
				// discovery and gates, or a worker bug) observes as an EMPTY
				// gate — the same value the fallback's /vh/snapshot would
				// have returned for a vanished dir, keeping observed_projects
				// semantics identical on both paths.
				res.projects = append(res.projects, fleetObservedProject{dir: p.Dir, gate: gates[p.Dir]})
			}
			cumulative += bodyLen
			if cumulative > b.MaxWorkerCumulativeBytes {
				// The batch's observations are real and stay; further fetches stop.
				res.status = fleetWorkerLimited
				res.detail = fleetClampDetail(fmt.Sprintf("cumulative %s > %s budget after %s",
					fleetHumanBytes(cumulative), fleetHumanBytes(b.MaxWorkerCumulativeBytes),
					fleetTruncRunes(projects[len(projects)-1].Dir, fleetDetailDirMaxRunes)))
				return res
			}
			if limited {
				res.status = fleetWorkerLimited
				return res
			}
			res.status = fleetWorkerOK
			res.observedAt = time.Now()
			return res
		}
	}

	// 3. Fallback (old workers / lean failure): one tree-only snapshot per
	// project (no sessions param ⇒ no messages), z=1 to gzip64 the big tree
	// payloads — honored by every current worker; an even older worker that
	// ignores z=1 serves raw JSON, which the transport passes through
	// unchanged (envelope decode is opt-in), so the request stays safe
	// against any worker version. Since S1 the snapshot envelope must SPEAK
	// THE FLEET-SELECTION VOCABULARY (the same contract the lean path
	// validates): a field-less fallback (pre-selection producer) or an
	// unknown marker version is an unsupported producer — a worker `error`
	// with an explicit detail, NEVER folded as a healthy observed empty
	// ("No sessions"). Previously validated projects keep their
	// observations (partial-observation semantics, like every other
	// mid-acquisition failure).
	for _, p := range projects {
		path := "/vh/snapshot?z=1"
		if p.Dir != "" {
			path += "&dir=" + url.QueryEscape(p.Dir)
		}
		body, err := fetchBounded(path)
		if err != nil {
			fetchFail(path, err)
			return res
		}
		var snap struct {
			FleetSelection string                     `json:"fleet_selection"`
			Gate           map[string]state.GateFacts `json:"gate"`
		}
		if err := json.Unmarshal(body, &snap); err != nil {
			res.status = fleetWorkerError
			res.detail = fleetMalformedDetail(path)
			return res
		}
		if !fleetSelectionValid(snap.FleetSelection, snap.Gate) {
			res.status = fleetWorkerError
			res.detail = fleetUnsupportedSelectionDetail(path)
			return res
		}
		cumulative += int64(len(body))
		res.projects = append(res.projects, fleetObservedProject{dir: p.Dir, gate: snap.Gate})
		if cumulative > b.MaxWorkerCumulativeBytes {
			// This project's observation is real and stays; further fetches stop.
			res.status = fleetWorkerLimited
			res.detail = fleetClampDetail(fmt.Sprintf("cumulative %s > %s budget after %s",
				fleetHumanBytes(cumulative), fleetHumanBytes(b.MaxWorkerCumulativeBytes),
				fleetTruncRunes(p.Dir, fleetDetailDirMaxRunes)))
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

// fleetDiscoveredProject is one /vh/projects discovery entry (the rollup
// reads only the dir).
type fleetDiscoveredProject struct {
	Dir string `json:"dir"`
}

// fetchLeanGates tries the worker's lean batched gate endpoint
// (GET /vh/gates?z=1&dir=…, pkg/web server.go handleFleetGates) for exactly
// the (already capped, roster-filtered) project list and returns the
// per-dir gate maps plus the decoded response length (for the cumulative
// byte budget). ok=false means "lean unavailable or broken — use the
// fallback": a fetch error of ANY class (404/non-2xx, timeout, cap trip)
// or a malformed/unexpected-schema body routes back to the per-project
// snapshot path; the lean attempt itself never fails the worker.
//
// Fleet-selection validation (capability guard): the lean contract
// REQUIRES the root_unarchived_v1 marker — an envelope without it (a
// field-less pre-selection producer) or with an unknown vocabulary version
// cannot be interpreted and routes to the fallback like any other
// unexpected shape; a marked envelope must tag every nonempty gate entry
// with the fleet_selected tri-state (an advertised-but-untagged entry is a
// producer bug, not supported-zero) AND every entry must be SELECTED —
// this endpoint's producer contract is selected-only, so an explicitly
// false-tagged entry is a misbuild, not a population statement. This SUPERSEDES the slice-2 operator
// amendment that accepted marker-less lean bodies (the deviation the
// fleet-status follow-ups brief closed): acceptance let a field-less
// producer fold as a healthy "No sessions". Whether the fallback can serve
// the worker is decided by the fallback's own vocabulary check in
// acquireWorker — never by silently folding unvalidated entries.
func fetchLeanGates(fetch func(path string) ([]byte, error), projects []fleetDiscoveredProject) (map[string]map[string]state.GateFacts, int64, bool) {
	var sb strings.Builder
	sb.WriteString("/vh/gates?z=1")
	for _, p := range projects {
		sb.WriteString("&dir=" + url.QueryEscape(p.Dir))
	}
	body, err := fetch(sb.String())
	if err != nil {
		return nil, 0, false
	}
	var lean struct {
		Schema         int    `json:"schema"`
		FleetSelection string `json:"fleet_selection"`
		Projects       []struct {
			Dir  string                     `json:"dir"`
			Gate map[string]state.GateFacts `json:"gate"`
		} `json:"projects"`
	}
	// projects absent (null) or a schema we do not speak ⇒ malformed ⇒
	// fallback; entries for dirs we did not request are ignored by
	// construction (the caller looks its own dirs up in the map).
	if err := json.Unmarshal(body, &lean); err != nil || lean.Schema != 1 || lean.Projects == nil {
		return nil, 0, false
	}
	gateMaps := make([]map[string]state.GateFacts, 0, len(lean.Projects))
	for _, p := range lean.Projects {
		gateMaps = append(gateMaps, p.Gate)
	}
	if !fleetSelectionValid(lean.FleetSelection, gateMaps...) {
		return nil, 0, false
	}
	// The lean endpoint's producer contract is SELECTED-ONLY (pkg/web
	// GateFactsFleetSelected filters children/archived server-side): an
	// explicitly false-tagged entry on this path is a misbuild whose
	// all-false gate map would fold as a healthy "No sessions" — route it
	// to the fallback like any other contract violation. (The fallback's
	// complete map legitimately carries false entries; it only requires
	// the tri-state to be EXPLICIT — see fleetSelectionValid.)
	for _, p := range lean.Projects {
		for _, gf := range p.Gate {
			if gf.FleetSelected == nil || !*gf.FleetSelected {
				return nil, 0, false
			}
		}
	}
	gates := make(map[string]map[string]state.GateFacts, len(lean.Projects))
	for _, p := range lean.Projects {
		gates[p.Dir] = p.Gate
	}
	return gates, int64(len(body)), true
}

// fleetSelectionValid reports whether an acquisition envelope (lean or
// snapshot fallback) speaks the fleet-selection vocabulary this controller
// folds: the KNOWN capability marker must be present (absent = a field-less
// pre-selection producer; any other value = a vocabulary version we cannot
// interpret), and every entry of every nonempty gate map must carry the
// fleet_selected tri-state explicitly (an advertised-but-untagged entry is
// a producer bug). A marked empty or omitted gate map IS valid — a
// supported, genuinely-empty population, never conflated with an
// unsupported producer. An envelope that fails this check must never be
// folded: its all-excluded entries would masquerade unsupported data as an
// observed empty fleet ("No sessions" with available:true).
func fleetSelectionValid(marker string, gates ...map[string]state.GateFacts) bool {
	if marker != state.FleetSelectionRootUnarchivedV1 {
		return false
	}
	for _, g := range gates {
		for _, gf := range g {
			if gf.FleetSelected == nil {
				return false
			}
		}
	}
	return true
}

// ---------------------------------------------------------------------------
// Limited/error detail helpers (workers[].detail)
// ---------------------------------------------------------------------------

// Detail budgets: the watch payload stays compact, so an embedded path/dir
// is truncated to ~200 code points and the WHOLE detail to ~256 (producers
// build short strings; the clamps are hard guarantees, "~" slack included).
const (
	fleetDetailPathMaxRunes = 200
	fleetDetailDirMaxRunes  = 200
	fleetDetailMaxRunes     = 256
)

// fleetTruncRunes truncates s to at most max Unicode code points, appending
// an ellipsis when truncation occurred (dirs/paths can be arbitrary-length
// operator or worker-controlled strings).
func fleetTruncRunes(s string, max int) string {
	if max <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max]) + "…"
}

// fleetClampDetail bounds a whole detail string to the total ceiling.
func fleetClampDetail(s string) string {
	r := []rune(s)
	if len(r) <= fleetDetailMaxRunes {
		return s
	}
	return string(r[:fleetDetailMaxRunes-1]) + "…"
}

// fleetMalformedDetail names a JSON decode failure: what came back was not
// the expected document shape.
func fleetMalformedDetail(path string) string {
	return fleetClampDetail("malformed response (" + fleetTruncRunes(path, fleetDetailPathMaxRunes) + ")")
}

// fleetResponseCapDetail names a per-response body-cap trip:
// "response 5.2 MiB > 4 MiB cap (/vh/snapshot?dir=…)". The actual byte pair
// is read STRUCTURED from the transport's FetchResponseTooLargeError via
// errors.As (the a-F2/d-F3 text scan on "(N > M bytes)" is retired). Got
// quotes the bytes the cap governs — DECODED size for a gzip64 envelope
// response (status_transport.go says which), raw size otherwise. A seam
// error without the structured pair degrades to naming the configured cap
// alone — still honest, still names the trip, never a fabricated size.
func fleetResponseCapDetail(err error, path string, cap int64) string {
	tp := fleetTruncRunes(path, fleetDetailPathMaxRunes)
	var ovs *FetchResponseTooLargeError
	if errors.As(err, &ovs) {
		return fleetClampDetail(fmt.Sprintf("response %s > %s cap (%s)", fleetHumanBytes(ovs.Got), fleetHumanBytes(cap), tp))
	}
	return fleetClampDetail(fmt.Sprintf("response over %s cap (%s)", fleetHumanBytes(cap), tp))
}

// fleetUnsupportedSelectionDetail names an unsupported fleet-selection
// producer: the envelope does not speak the root_unarchived_v1 vocabulary
// this controller folds (no marker, an unknown marker version, or untagged
// gate entries) — a vh-solara worker built before fleet selection, i.e.
// older than the tunnel version floor or a pre-selection dev build the
// boundary admits fail-open. The upgrade ask sources pkg/version's floor
// so it can never drift from the boundary. Bounded by the detail ceiling
// like every limited/error detail.
func fleetUnsupportedSelectionDetail(path string) string {
	return fleetClampDetail(fmt.Sprintf(
		"unsupported fleet selection vocabulary (%s): upgrade the vh-solara worker to >= %s",
		fleetTruncRunes(path, fleetDetailPathMaxRunes), version.MinWorkerVersion))
}

// fleetHumanBytes renders a byte count compactly for detail strings: whole
// units when evenly divisible, one decimal otherwise (5.2 MiB, 32 MiB, 512 B).
func fleetHumanBytes(n int64) string {
	switch {
	case n >= 1<<20:
		v := float64(n) / (1 << 20)
		if v == float64(int64(v)) {
			return fmt.Sprintf("%d MiB", int64(v))
		}
		return fmt.Sprintf("%.1f MiB", v)
	case n >= 1<<10:
		v := float64(n) / (1 << 10)
		if v == float64(int64(v)) {
			return fmt.Sprintf("%d KiB", int64(v))
		}
		return fmt.Sprintf("%.1f KiB", v)
	default:
		return fmt.Sprintf("%d B", n)
	}
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
// deliberately absent): down/missing/project-missing/error ⇒ degraded (a
// required thing is absent); pending permission/question or retry ⇒
// attention; else nominal (no known condition — not confirmed health).
func fleetKnownOverall(down, missing, projectMissing, sessionErr, perm, quest, retry bool) string {
	if down || missing || projectMissing || sessionErr {
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
	case fleetCondProjectMissing:
		return "projects not running"
	case fleetCondSessionError:
		return "errors"
	case fleetCondSessionRetry:
		return "retrying"
	case fleetCondSessionDone:
		return "finished"
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
	case fleetCondProjectMissing:
		return "project not running"
	case fleetCondSessionError:
		return "error"
	case fleetCondSessionRetry:
		return "retrying"
	case fleetCondSessionDone:
		return "finished"
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
		fleetCondProjectMissing:    {"project not running", "projects not running"},
		fleetCondSessionError:      {"session error", "session errors"},
		fleetCondSessionRetry:      {"session retrying", "sessions retrying"},
		fleetCondSessionDone:       {"finished", "finished"},
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

// normalizeFleetRoster trims, drops empties, dedupes and sorts a configured
// WORKER roster (status-config worker ids — already validated non-blank,
// host-label-safe, and unique at the config boundary, so this is a defensive
// no-op besides the sort). It is NOT used for project dirs: those go through
// normalizeProjectRoster's verbatim handling. A non-empty result switches the
// worker axis to expected mode.
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

// normalizeProjectRoster normalizes a configured PROJECT roster
// (status-config project dirs). Whitespace-only entries would be dropped as
// blank (config validation already rejects them at the boundary), but every
// non-blank entry is stored VERBATIM — a roster entry matches a
// worker-reported dir by exact string equality, so surrounding whitespace is
// significant on BOTH sides (no TrimSpace, no path canonicalization;
// commit-review F2). Dedupes on the verbatim string and sorts. A non-empty
// result switches the project axis to expected mode.
func normalizeProjectRoster(raw []string) []string {
	seen := make(map[string]bool, len(raw))
	out := make([]string, 0, len(raw))
	for _, dir := range raw {
		if strings.TrimSpace(dir) == "" || seen[dir] {
			continue
		}
		seen[dir] = true
		out = append(out, dir)
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
