package server

// Unit tests for the controller's aggregated GET /vh/diag/latency handler
// (pkg/server/diag_aggregate.go).
//
// These tests pin the critical properties of the global aggregator:
//
//  1. MERGE SHAPE — the response envelope is `{controller, workers, failures,
//     worker_info}` with each entity's snapshot embedded verbatim and registry
//     metadata carried alongside.
//  2. OFFLINE / FETCH-ERROR / TIMEOUT → FAILURES — a worker that is offline,
//     errors, or blocks past the per-worker timeout lands in `failures` and
//     DOES NOT block the global response; the controller + healthy workers
//     are still returned.
//  3. BOUNDED FAN-OUT — concurrent fan-out never exceeds the concurrency cap.
//  4. ROUTE PRECEDENCE — the controller-owned aggregator wins on a per-worker
//     subdomain: hostInterceptor must NOT proxy /vh/diag/latency down to a
//     worker even when r.Host matches the worker pattern.
//
// All tests use a fake `workerDiagFetcher` so they exercise the merge/fan-out
// logic without standing up real yamux. The production fetcher
// (Proxy.FetchWorkerSnapshot) has its own transport guards; those are not
// re-tested here.

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/vhqtvn/vh-solara/pkg/auth"
)

// fakeWorkerSnapshot is a stand-in for a worker's diag JSON body. It mirrors
// the parts of pkg/diagnostics.snapshotJSON the merge cares about (verbatim
// bytes through the wire). Field names match the JSON tags so a test can
// round-trip marshal/unmarshal to validate the merge.
type fakeWorkerSnapshot struct {
	StartedAtNs int64 `json:"started_at_ns"`
	WorkerTag   int64 `json:"worker_tag"`
}

// makeFakeSnapshotBytes returns the JSON encoding of a fake worker snapshot
// tagged with `tag`. The aggregator embeds these bytes verbatim into
// `workers[id]`, so a test can unmarshal them back out and check the tag
// survived intact.
func makeFakeSnapshotBytes(tag int64) []byte {
	b, _ := json.Marshal(fakeWorkerSnapshot{StartedAtNs: 1, WorkerTag: tag})
	return b
}

// newRegistryWithWorkers builds a Registry populated with the given worker IDs
// (all marked "online" with a nil transport; the aggregator does not touch
// Transport when the fetcher is faked). Returns the registry for direct
// mutation by tests that want to flip a worker to "offline".
func newRegistryWithWorkers(ids ...string) *Registry {
	r := NewRegistry()
	for _, id := range ids {
		r.AddWorker(&Worker{ID: id, Name: "name-" + id, Status: "online", Version: "v-" + id})
	}
	return r
}

// decodeEnvelope unmarshals an aggregated response body into a loosely-typed
// map so tests can assert on shape without importing the unexported wire struct
// (the struct is unexported by design; the wire shape is the public contract).
func decodeEnvelope(t *testing.T, body []byte) map[string]any {
	t.Helper()
	var env map[string]any
	if err := json.Unmarshal(body, &env); err != nil {
		t.Fatalf("aggregated body is not valid JSON: %v (body=%q)", err, string(body))
	}
	return env
}

// errFake is a tiny error type so tests can return errors without fmt import
// noise; its string form is whatever it was constructed with.
type errFake string

func (e errFake) Error() string { return string(e) }

// TestAggregateLatencyMergeShape pins the wire shape when every worker is
// reachable: `controller` is the verbatim controller snapshot; `workers` maps
// each worker ID to its verbatim fetcher output; `worker_info` carries the
// registry-side name/status/version; `failures` is present but empty.
func TestAggregateLatencyMergeShape(t *testing.T) {
	registry := newRegistryWithWorkers("w1", "w2")
	controllerBytes := makeFakeSnapshotBytes(0)

	// Each worker returns a distinct tagged snapshot so we can prove the merge
	// preserves per-worker identity (no collision, no overwrite).
	fetch := func(_ context.Context, w *Worker) ([]byte, error) {
		switch w.ID {
		case "w1":
			return makeFakeSnapshotBytes(11), nil
		case "w2":
			return makeFakeSnapshotBytes(22), nil
		}
		t.Fatalf("unexpected worker ID %q", w.ID)
		return nil, nil
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/diag/latency", nil)
	AggregateLatency(rec, req, registry, controllerBytes, fetch)

	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("want Content-Type application/json, got %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Fatalf("want Cache-Control no-store (on-demand diagnostic must not be cached), got %q", cc)
	}
	env := decodeEnvelope(t, rec.Body.Bytes())

	// Controller section: verbatim bytes the caller passed in.
	ctrl, ok := env["controller"].(map[string]any)
	if !ok {
		t.Fatalf("missing nested \"controller\" object: %v", env)
	}
	if got := ctrl["worker_tag"]; got != float64(0) {
		t.Fatalf("controller snapshot not embedded verbatim: want worker_tag=0, got %v", got)
	}

	// Workers section: each ID maps to its own tagged snapshot, preserved.
	workers, ok := env["workers"].(map[string]any)
	if !ok {
		t.Fatalf("missing nested \"workers\" object: %v", env)
	}
	if len(workers) != 2 {
		t.Fatalf("want 2 workers, got %d (%v)", len(workers), workers)
	}
	for id, wantTag := range map[string]int64{"w1": 11, "w2": 22} {
		wk, ok := workers[id].(map[string]any)
		if !ok {
			t.Fatalf("worker %q snapshot is not a JSON object: %v", id, workers[id])
		}
		if got := wk["worker_tag"]; got != float64(wantTag) {
			t.Fatalf("worker %q snapshot not embedded verbatim: want worker_tag=%d, got %v", id, wantTag, got)
		}
	}

	// WorkerInfo section: registry-side metadata for labeling the UI.
	info, ok := env["worker_info"].(map[string]any)
	if !ok {
		t.Fatalf("missing nested \"worker_info\" object: %v", env)
	}
	for _, id := range []string{"w1", "w2"} {
		wi, ok := info[id].(map[string]any)
		if !ok {
			t.Fatalf("worker_info[%q] missing or wrong type: %v", id, info[id])
		}
		if got := wi["name"]; got != "name-"+id {
			t.Fatalf("worker_info[%q].name = %v, want %q", id, got, "name-"+id)
		}
		if got := wi["status"]; got != "online" {
			t.Fatalf("worker_info[%q].status = %v, want \"online\"", id, got)
		}
		if got := wi["version"]; got != "v-"+id {
			t.Fatalf("worker_info[%q].version = %v, want %q", id, got, "v-"+id)
		}
	}

	// Failures section: present but empty (no fetcher errors).
	failures, ok := env["failures"].(map[string]any)
	if !ok {
		t.Fatalf("missing nested \"failures\" object: %v", env)
	}
	if len(failures) != 0 {
		t.Fatalf("want empty failures, got %v", failures)
	}
}

// TestAggregateLatencyOfflineWorkerRecorded pins that a registry-level offline
// worker is recorded in `failures` up front (without calling the fetcher) AND
// still appears in `worker_info` so the UI can label its section. The fetcher
// must NOT be called for the offline worker.
func TestAggregateLatencyOfflineWorkerRecorded(t *testing.T) {
	registry := newRegistryWithWorkers("online1", "offline1")
	// Flip one worker to offline via the registry API (sets Status and clears
	// transport — but the aggregator only reads Status, so this is realistic).
	registry.MarkWorkerOffline("offline1")

	controllerBytes := makeFakeSnapshotBytes(0)
	fetchCalls := map[string]int{}
	var fetchMu sync.Mutex
	fetch := func(_ context.Context, w *Worker) ([]byte, error) {
		fetchMu.Lock()
		fetchCalls[w.ID]++
		fetchMu.Unlock()
		return makeFakeSnapshotBytes(1), nil
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/diag/latency", nil)
	AggregateLatency(rec, req, registry, controllerBytes, fetch)

	env := decodeEnvelope(t, rec.Body.Bytes())
	failures, _ := env["failures"].(map[string]any)
	if got := failures["offline1"]; got != "worker offline" {
		t.Fatalf("offline worker not recorded as failure: want reason \"worker offline\", got %v", got)
	}
	if _, exists := failures["online1"]; exists {
		t.Fatalf("online worker should NOT appear in failures: %v", failures)
	}
	// The offline worker's metadata is STILL surfaced for UI labeling.
	info, _ := env["worker_info"].(map[string]any)
	if _, exists := info["offline1"]; !exists {
		t.Fatalf("offline worker should still appear in worker_info for UI labeling: %v", info)
	}
	// The fetcher was called for the online worker only.
	fetchMu.Lock()
	defer fetchMu.Unlock()
	if fetchCalls["offline1"] != 0 {
		t.Fatalf("fetcher must NOT be called for offline worker, called %d times", fetchCalls["offline1"])
	}
	if fetchCalls["online1"] != 1 {
		t.Fatalf("fetcher must be called once for online worker, called %d times", fetchCalls["online1"])
	}
}

// TestAggregateLatencyFetcherErrorRecordsFailure pins that a fetcher error for
// one worker lands in `failures` (with the error's reason) and DOES NOT block
// the controller or the other worker from appearing in the response.
func TestAggregateLatencyFetcherErrorRecordsFailure(t *testing.T) {
	registry := newRegistryWithWorkers("ok", "sad")
	controllerBytes := makeFakeSnapshotBytes(0)
	fetch := func(_ context.Context, w *Worker) ([]byte, error) {
		if w.ID == "sad" {
			return nil, errFake("worker sad: stream reset")
		}
		return makeFakeSnapshotBytes(7), nil
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/diag/latency", nil)
	AggregateLatency(rec, req, registry, controllerBytes, fetch)

	if rec.Code != http.StatusOK {
		t.Fatalf("a single worker failure must NOT fail the whole response: want 200, got %d", rec.Code)
	}
	env := decodeEnvelope(t, rec.Body.Bytes())

	workers, _ := env["workers"].(map[string]any)
	if _, exists := workers["ok"]; !exists {
		t.Fatalf("healthy worker missing from response despite sibling failure: %v", workers)
	}
	if _, exists := workers["sad"]; exists {
		t.Fatalf("failed worker must NOT appear in workers map: %v", workers)
	}
	failures, _ := env["failures"].(map[string]any)
	if got, ok := failures["sad"].(string); !ok || got == "" {
		t.Fatalf("failed worker must be in failures with a non-empty reason: got %v", failures["sad"])
	}
}

// TestAggregateLatencyPerWorkerTimeoutDoesNotBlockGlobal pins the most
// important property: a worker whose fetch blocks past the per-worker timeout
// is recorded in `failures`, and the global response returns shortly after
// that timeout — NOT after the blocked fetch's natural completion.
//
// Without the per-worker context, a worker blocking for 30s would hold the
// global response for 30s. With it, the response returns within ~diagWorkerTimeout
// and the slow worker is named in `failures`.
func TestAggregateLatencyPerWorkerTimeoutDoesNotBlockGlobal(t *testing.T) {
	registry := newRegistryWithWorkers("fast", "slow")
	controllerBytes := makeFakeSnapshotBytes(0)

	// The slow worker blocks until its context is cancelled (per-worker
	// timeout) or a one-minute safety valve fires (test would hang otherwise).
	fetch := func(ctx context.Context, w *Worker) ([]byte, error) {
		if w.ID == "slow" {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Minute):
				return nil, errFake("unreachable")
			}
		}
		return makeFakeSnapshotBytes(99), nil
	}

	start := time.Now()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/diag/latency", nil)
	AggregateLatency(rec, req, registry, controllerBytes, fetch)
	elapsed := time.Since(start)

	if rec.Code != http.StatusOK {
		t.Fatalf("slow worker must NOT fail the whole response: want 200, got %d", rec.Code)
	}
	// The response must return within a small multiple of diagWorkerTimeout,
	// NOT within the slow worker's natural block. Allow generous slack so the
	// test is not flaky on a busy CI box; the property under test is
	// "bounded by per-worker timeout, NOT by 1 minute".
	if elapsed >= 30*time.Second {
		t.Fatalf("global response blocked by slow worker: elapsed=%v (want bounded by diagWorkerTimeout=%v)", elapsed, diagWorkerTimeout)
	}
	env := decodeEnvelope(t, rec.Body.Bytes())
	workers, _ := env["workers"].(map[string]any)
	if _, exists := workers["fast"]; !exists {
		t.Fatalf("fast worker missing from response: %v", workers)
	}
	failures, _ := env["failures"].(map[string]any)
	if _, exists := failures["slow"]; !exists {
		t.Fatalf("slow worker must be recorded in failures: %v", failures)
	}
}

// TestAggregateLatencyBoundedFanOutConcurrency pins that fan-out is bounded by
// diagFanOutConcurrency. We construct a fleet larger than the cap and a fetcher
// that counts how many fetches are in-flight at once; the high-water mark must
// never exceed the cap.
//
// This is a race-sensitive test by design (it must observe concurrent
// goroutines); run under `go test -race` it also proves the mutex-guarded
// results map is race-free.
func TestAggregateLatencyBoundedFanOutConcurrency(t *testing.T) {
	// Build a fleet larger than diagFanOutConcurrency.
	ids := make([]string, 0, diagFanOutConcurrency*3)
	for i := 0; i < diagFanOutConcurrency*3; i++ {
		ids = append(ids, workerIDFromIndex(i))
	}
	registry := newRegistryWithWorkers(ids...)
	controllerBytes := makeFakeSnapshotBytes(0)

	var inFlight int32
	var highWater int32
	fetch := func(_ context.Context, w *Worker) ([]byte, error) {
		cur := atomic.AddInt32(&inFlight, 1)
		// Track max concurrently in flight; atomic CAS loop so we don't lose
		// the high-water mark to a racing read.
		for {
			old := atomic.LoadInt32(&highWater)
			if cur <= old || atomic.CompareAndSwapInt32(&highWater, old, cur) {
				break
			}
		}
		time.Sleep(10 * time.Millisecond) // ensure overlap across goroutines
		atomic.AddInt32(&inFlight, -1)
		return makeFakeSnapshotBytes(1), nil
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/diag/latency", nil)
	AggregateLatency(rec, req, registry, controllerBytes, fetch)

	if got := atomic.LoadInt32(&highWater); got > int32(diagFanOutConcurrency) {
		t.Fatalf("fan-out exceeded concurrency cap: high-water=%d, cap=%d", got, diagFanOutConcurrency)
	}
	// Sanity: the cap must actually have been a binding bound for a fleet this
	// large. If high-water < cap, the test is not exercising the bound — likely
	// because workers finished too fast. Sleep duration above is tuned so the
	// bound bites; if this asserts, re-tune the sleep rather than weakening the
	// property.
	if got := atomic.LoadInt32(&highWater); got < int32(diagFanOutConcurrency) {
		t.Fatalf("fan-out never reached concurrency cap: high-water=%d, cap=%d (test is not exercising the bound)", got, diagFanOutConcurrency)
	}

	// Every worker's snapshot landed in the response (no ID dropped).
	env := decodeEnvelope(t, rec.Body.Bytes())
	workers, _ := env["workers"].(map[string]any)
	if len(workers) != len(ids) {
		t.Fatalf("want %d workers in response, got %d", len(ids), len(workers))
	}
}

// workerIDFromIndex returns a deterministic worker ID like "w000".."w041" so
// the bounded-fan-out test has stable, collision-free IDs.
func workerIDFromIndex(i int) string {
	// Build digits least-significant-first, then reverse into "w" + digits.
	const width = 3
	digits := make([]byte, width)
	for pos := width - 1; pos >= 0; pos-- {
		digits[pos] = byte('0' + (i % 10))
		i /= 10
	}
	return "w" + string(digits)
}

// TestAggregateLatencyEmptyFleet pins the degenerate case: no workers connected
// → `workers`/`failures`/`worker_info` are present but empty, `controller` is
// still returned. This is the typical operator view when nothing has dialed in
// yet (or the controller is running standalone for testing).
func TestAggregateLatencyEmptyFleet(t *testing.T) {
	registry := NewRegistry() // no workers
	controllerBytes := makeFakeSnapshotBytes(0)
	fetch := func(context.Context, *Worker) ([]byte, error) {
		t.Fatalf("fetcher must not be called for an empty fleet")
		return nil, nil
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/diag/latency", nil)
	AggregateLatency(rec, req, registry, controllerBytes, fetch)

	if rec.Code != http.StatusOK {
		t.Fatalf("want 200 even with empty fleet, got %d", rec.Code)
	}
	env := decodeEnvelope(t, rec.Body.Bytes())
	if _, ok := env["controller"].(map[string]any); !ok {
		t.Fatalf("controller snapshot must still be present with empty fleet: %v", env)
	}
	for _, key := range []string{"workers", "failures", "worker_info"} {
		m, ok := env[key].(map[string]any)
		if !ok {
			t.Fatalf("%q must be a JSON object even when empty: %v", key, env[key])
		}
		if len(m) != 0 {
			t.Fatalf("%q must be empty with no workers: %v", key, m)
		}
	}
}

// TestHandleDiagAggregateMethodGate pins that the controller's diag handler is
// GET/HEAD only: any other method returns 405 with an Allow header. This is
// what allows the route to remain CSRF-exempt (csrfGuard only covers /api/*,
// and the route is registered GET-only via Go 1.22 method patterns). A
// regression that broadens to unsafe methods would silently re-introduce a CSRF
// surface.
func TestHandleDiagAggregateMethodGate(t *testing.T) {
	d := NewDaemon(":0", ":0", "")
	d.fetchWorkerDiag = func(context.Context, *Worker) ([]byte, error) { return nil, nil }
	h := d.handleDiagAggregate

	for _, method := range []string{http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch} {
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, "/vh/diag/latency", nil)
		h(rec, req)
		if rec.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s /vh/diag/latency: want 405, got %d", method, rec.Code)
		}
		if got := rec.Header().Get("Allow"); got == "" {
			t.Fatalf("%s /vh/diag/latency: 405 must carry an Allow header", method)
		}
	}

	// GET passes through to the aggregator.
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/diag/latency", nil)
	h(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("GET /vh/diag/latency: want 200, got %d (body=%q)", rec.Code, rec.Body.String())
	}
}

// TestHostInterceptorDiagLatencyRoutePrecedence pins the critical property: a
// browser loaded from a per-worker subdomain (e.g. "workerID.controller.host")
// hitting `/vh/diag/latency` MUST be served by the controller's aggregator,
// NOT proxied down to that worker through hostInterceptor. Without this carve-
// out, the SPA on a worker subdomain would see only that worker's snapshot and
// the operator would have to re-fetch per project — the exact UX regression
// the global aggregator exists to fix.
//
// We build the full controller chain (auth + csrfGuard + hostInterceptor +
// userMux) with passphrase auth, register an "online" worker with NO real
// transport (so the proxy path would 502), and assert the response is the
// aggregated envelope — proving the carve-out fired before hostInterceptor. If
// the carve-out fails the request reaches HandleWorkerDirect → handleRawProxy
// → 502 on the nil transport; we assert against that specifically.
func TestHostInterceptorDiagLatencyRoutePrecedence(t *testing.T) {
	d := NewDaemon(":0", ":0", "")
	a, err := auth.New(context.Background(), auth.Config{Mode: auth.ModePassphrase, Passphrase: "secret"})
	if err != nil {
		t.Fatalf("auth.New: %v", err)
	}
	d.Auth = a
	d.HostPattern = "$ID.controller.test"
	// Register an online worker WITHOUT a real transport. If the carve-out
	// fails, the request reaches HandleWorkerDirect → handleRawProxy, which
	// returns 502 on the nil transport. The carve-out means we never get
	// there, so we want a 200 aggregated envelope, not a 502.
	d.Registry.AddWorker(&Worker{ID: "abc", Name: "abc-worker", Status: "online", Version: "v1"})
	// Inject a fake fetcher so the aggregator (which DOES legitimately call
	// the fetcher) does not try to reach the nil yamux transport. The
	// injected fetcher is the proof that the AGGREGATOR handled the request
	// (not the proxy path, which would 502 before any fetcher call).
	fetcherCalled := false
	d.fetchWorkerDiag = func(_ context.Context, w *Worker) ([]byte, error) {
		fetcherCalled = true
		return makeFakeSnapshotBytes(42), nil
	}

	h := d.buildRootHandler()
	session := loginPassphrase(t, h, "secret")

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/diag/latency", nil)
	req.Host = "abc.controller.test"
	req.AddCookie(session)
	h.ServeHTTP(rec, req)

	if rec.Code == http.StatusBadGateway {
		t.Fatalf("hostInterceptor proxied /vh/diag/latency to the worker (502) — carve-out missing or broken")
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("want 200 aggregated envelope, got %d (body=%q)", rec.Code, rec.Body.String())
	}
	if !fetcherCalled {
		t.Fatalf("aggregator fetcher was not called — request did not reach the aggregator handler (carve-out broken?)")
	}
	env := decodeEnvelope(t, rec.Body.Bytes())
	if _, ok := env["controller"]; !ok {
		t.Fatalf("response is not the aggregated envelope (no \"controller\" key): %v", env)
	}
	workers, _ := env["workers"].(map[string]any)
	if _, ok := workers["abc"]; !ok {
		t.Fatalf("expected worker \"abc\" in aggregated response (from injected fetcher): %v", workers)
	}
}

// TestAggregateLatencyControllerSnapshotPreservesPrecision pins that large
// integer values in the controller snapshot (2^53+1 — the smallest integer
// NOT representable as float64) survive the merge without precision loss.
// This catches an accidental re-marshal through map[string]any / float64
// intermediaries; the production path embeds the snapshot as json.RawMessage
// to avoid exactly that.
func TestAggregateLatencyControllerSnapshotPreservesPrecision(t *testing.T) {
	registry := NewRegistry()
	controllerBytes := []byte(`{"started_at_ns":9007199254740993,"probes":{"ingest":{"count":3},"weird_order":true}}`)
	fetch := func(context.Context, *Worker) ([]byte, error) { return nil, nil }

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/diag/latency", nil)
	AggregateLatency(rec, req, registry, json.RawMessage(controllerBytes), fetch)

	// Decode the WIRE body with UseNumber so numbers stay string-backed and
	// never pass through float64 (which cannot represent 2^53+1 exactly). Any
	// re-marshal path through map[string]any in the production code would
	// surface here as a float64-rounded json.Number.
	var env map[string]any
	dec := json.NewDecoder(bytes.NewReader(rec.Body.Bytes()))
	dec.UseNumber()
	if err := dec.Decode(&env); err != nil {
		t.Fatalf("decoding aggregated response with UseNumber: %v", err)
	}
	ctrl, ok := env["controller"].(map[string]any)
	if !ok {
		t.Fatalf("missing nested \"controller\" object: %v", env)
	}
	started, ok := ctrl["started_at_ns"].(json.Number)
	if !ok {
		t.Fatalf("started_at_ns not a json.Number after decode: %T", ctrl["started_at_ns"])
	}
	if started.String() != "9007199254740993" {
		t.Fatalf("started_at_ns precision lost through merge: got %q, want \"9007199254740993\" (the wire bytes must be preserved verbatim)", started.String())
	}
}

// TestAggregateLatencyPreservesContextCancel pins that if the caller's request
// context is cancelled (client disconnect) mid-fan-out, the aggregator returns
// promptly and does not leak goroutines past the per-worker timeout. We don't
// assert goroutine counts (flaky); we assert elapsed time is bounded by the
// per-worker timeout, not by a fetcher that ignores context.
func TestAggregateLatencyPreservesContextCancel(t *testing.T) {
	registry := newRegistryWithWorkers("w1")
	controllerBytes := makeFakeSnapshotBytes(0)
	cancelFired := make(chan struct{})
	fetch := func(ctx context.Context, _ *Worker) ([]byte, error) {
		<-ctx.Done()
		close(cancelFired)
		return nil, ctx.Err()
	}

	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/vh/diag/latency", nil)
	// Cancel the request context after a short delay shorter than
	// diagWorkerTimeout; the fetcher must observe the cancellation and the
	// response must return promptly.
	ctx, cancel := context.WithTimeout(req.Context(), 100*time.Millisecond)
	defer cancel()
	req = req.WithContext(ctx)

	start := time.Now()
	AggregateLatency(rec, req, registry, controllerBytes, fetch)
	elapsed := time.Since(start)
	if elapsed >= diagWorkerTimeout {
		t.Fatalf("aggregator did not observe request cancellation promptly: elapsed=%v, diagWorkerTimeout=%v", elapsed, diagWorkerTimeout)
	}
	select {
	case <-cancelFired:
		// good: fetcher saw ctx.Done
	default:
		t.Fatalf("fetcher never observed cancellation")
	}
}
