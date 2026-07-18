package server

// Global latency-diagnostics aggregator (controller-side).
//
// The controller-edge GET /vh/diag/latency is the AGGREGATOR: it returns one
// merged snapshot combining the controller's OWN probes with every connected
// worker's probes, keyed by stable worker ID. The SPA's Performance dialog
// renders this global view, fully decoupled from project selection — the
// operator gets the same fleet-wide picture regardless of which project (and
// thus which worker subdomain) the browser is on. The dialog re-fetches only
// on open / manual Refresh / opt-in auto-refresh; switching projects does NOT
// trigger a re-fetch (the dialog is mounted at the app root, outside any
// per-project subtree — see web/src/App.tsx).
//
// Response schema:
//
//	{
//	  "controller": {<full diag snapshot>},
//	  "workers":    { "<workerID>": {<full diag snapshot>}, ... },
//	  "failures":   { "<workerID>": "<reason>", ... },
//	  "worker_info":{" "<workerID>": { "name": "...", "status": "...", "version": "..." }, ... }
//	}
//
// `controller` = diag.Default.Snapshot() on the controller process. `workers`
// maps each connected, online worker's stable ID to its full snapshot, fetched
// through the yamux tunnel by reusing the existing raw-proxy handshake. `fail`
// workers (timeout / stream error / non-200 worker response) land in `failures`
// keyed by worker ID with a short reason string — a single slow worker MUST NOT
// block the global response (per-worker context timeout). `worker_info` carries
// the registry's human-readable name + status + version per worker ID so the UI
// can label each section without a second round-trip.
//
// Overhead contract: strictly on-demand (request-time only). Bounded fan-out
// (semaphore) + per-worker timeout; the global response latency is bounded by
// the per-worker timeout, NOT by the slowest worker's natural response time.
// Probe collection stays lock-free and unchanged.

import (
	"context"
	"encoding/json"
	"net/http"
	"sync"
	"time"

	diag "github.com/vhqtvn/vh-solara/pkg/diagnostics"
)

// diagFanOutConcurrency caps the number of concurrent per-worker fetches during
// aggregation. 12 is well above the expected fleet size and well below any
// yamux-session stream budget; per-worker timeout is the real latency bound.
const diagFanOutConcurrency = 12

// diagWorkerTimeout is the per-worker fetch deadline. A worker that exceeds it
// is recorded in `failures` and the global response still returns. Slightly
// under diagGlobalTimeout so a worker that hits the per-worker deadline is
// always counted before the global deadline.
const diagWorkerTimeout = 4 * time.Second

// diagGlobalTimeout is the aggregator's overall bound. It is a belt-and-
// suspenders above the per-worker timeout; under normal operation the response
// returns as soon as every per-worker fetch settles.
const diagGlobalTimeout = 6 * time.Second

// aggregatedLatency is the wire shape of the controller's aggregated
// GET /vh/diag/latency response. Each entity's snapshot is embedded as a
// json.RawMessage so we never re-marshal the verbatim bytes a worker returned
// (preserves field order and avoids float-rounding through extra encode/decode
// passes).
type aggregatedLatency struct {
	Controller json.RawMessage            `json:"controller"`
	Workers    map[string]json.RawMessage `json:"workers"`
	Failures   map[string]string          `json:"failures"`
	WorkerInfo map[string]workerInfoJSON  `json:"worker_info"`
}

// workerInfoJSON carries the registry-side metadata the UI needs to label a
// worker section (name + status + version) without a second round-trip.
type workerInfoJSON struct {
	Name    string `json:"name"`
	Status  string `json:"status"`
	Version string `json:"version,omitempty"`
}

// workerDiagFetcher fetches one worker's full diag snapshot through the tunnel.
// Returns the worker's raw JSON bytes (the exact body of the worker's own
// /vh/diag/latency). The aggregator embeds them verbatim into the `workers`
// map. Extracted as a seam so tests can substitute a fake without standing up
// real yamux; the production implementation is Proxy.FetchWorkerSnapshot.
type workerDiagFetcher func(ctx context.Context, worker *Worker) ([]byte, error)

// handleDiagAggregate is the controller's aggregated GET /vh/diag/latency
// handler. It is registered on userMux AND wins over the hostInterceptor's
// per-worker proxy (hostInterceptor special-cases this path to fall through to
// userMux). Auth-gated by Auth.Middleware (the whole userMux chain is wrapped
// in buildRootHandler). GET-only so NO X-VH-CSRF exception is needed.
func (d *Daemon) handleDiagAggregate(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	// Default fetcher = the production tunnel path. Tests override
	// d.fetchWorkerDiag to inject a fake (no real yamux session needed).
	fetch := d.fetchWorkerDiag
	if fetch == nil {
		fetch = d.Proxy.FetchWorkerSnapshot
	}
	controllerBytes, err := json.Marshal(diag.Snapshot())
	if err != nil {
		// Should be impossible — snapshotJSON is plain integer fields. Fail
		// closed rather than emit a malformed envelope.
		http.Error(w, "controller snapshot marshal failed", http.StatusInternalServerError)
		return
	}
	AggregateLatency(w, r, d.Registry, controllerBytes, fetch)
}

// AggregateLatency is the core aggregator, extracted to a free function so the
// merge shape, bounded fan-out, and per-worker timeout are unit-testable with a
// fake fetcher (no Daemon or yamux required). The caller provides the
// controller's already-marshalled snapshot bytes and a per-worker fetcher.
//
// Invariants:
//   - The global response is NEVER blocked by a single slow worker. Each fetch
//     runs under both a per-worker context (diagWorkerTimeout) and the
//     aggregator-global deadline; the slowest a worker can hold the response is
//     diagWorkerTimeout.
//   - Fan-out is bounded by diagFanOutConcurrency so a fleet of N workers does
//     not open N concurrent yamux streams at once.
//   - Failures are recorded with a short reason string and surfaced in
//     `failures`; they do not fail the whole response (the controller + healthy
//     workers are still returned).
//   - WorkerInfo is populated for EVERY online worker the registry knows about,
//     so the UI can label a section even when that worker's fetch failed.
func AggregateLatency(
	w http.ResponseWriter,
	r *http.Request,
	registry *Registry,
	controllerSnapshot json.RawMessage,
	fetchWorker workerDiagFetcher,
) {
	ctx, cancel := context.WithTimeout(r.Context(), diagGlobalTimeout)
	defer cancel()

	workers := registry.ListWorkers()
	out := aggregatedLatency{
		Controller: controllerSnapshot,
		Workers:    map[string]json.RawMessage{},
		Failures:   map[string]string{},
		WorkerInfo: map[string]workerInfoJSON{},
	}
	for _, wk := range workers {
		// Include every worker the registry tracks so the UI can label a
		// section even when its fetch later fails. Registry-level offline
		// workers are recorded as failures up front and skipped at fan-out (no
		// point opening a tunnel stream for a worker the registry itself
		// considers offline). Transport-level reachability (nil/closed mux) is
		// NOT checked here: that knowledge lives in the fetcher so the
		// aggregator stays unit-testable with a fake fetcher that ignores
		// Transport entirely. The production fetcher (Proxy.FetchWorkerSnapshot)
		// guards on Transport == nil || IsClosed() and returns an error, which
		// the aggregator records into `failures`.
		out.WorkerInfo[wk.ID] = workerInfoJSON{
			Name:    wk.Name,
			Status:  wk.Status,
			Version: wk.Version,
		}
		if wk.Status == "offline" {
			out.Failures[wk.ID] = "worker offline"
			continue
		}
	}

	// Bounded fan-out. A buffered channel of size diagFanOutConcurrency acts as
	// a semaphore: each goroutine acquires (sends) before fetching and releases
	// (receives) after, capping concurrent fetches at the cap.
	sem := make(chan struct{}, diagFanOutConcurrency)
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, wk := range workers {
		if _, skip := out.Failures[wk.ID]; skip {
			continue // already recorded as offline
		}
		wk := wk // pin loop var for the goroutine
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case sem <- struct{}{}:
				defer func() { <-sem }()
			case <-ctx.Done():
				// Global deadline elapsed before we got a semaphore slot — record
				// the reason and stop. This branch is rare (it requires the
				// fleet to queue past the global timeout) but keeps the global
				// bound firm.
				recordFailure(&mu, out.Failures, wk.ID, "global timeout")
				return
			}

			wctx, wcancel := context.WithTimeout(ctx, diagWorkerTimeout)
			defer wcancel()
			body, err := fetchWorker(wctx, wk)
			if err != nil {
				recordFailure(&mu, out.Failures, wk.ID, err.Error())
				return
			}
			mu.Lock()
			out.Workers[wk.ID] = json.RawMessage(body)
			mu.Unlock()
		}()
	}
	wg.Wait()

	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(out)
}

// recordFailure appends a worker failure under the mutex. Failures replace any
// prior reason for the same ID (a worker appears at most once).
func recordFailure(mu *sync.Mutex, failures map[string]string, id, reason string) {
	mu.Lock()
	failures[id] = reason
	mu.Unlock()
}
